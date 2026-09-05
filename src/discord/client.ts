import { mkdirSync, readFileSync, writeFileSync } from 'node:fs'
import { dirname } from 'node:path'
import {
  ActivityType,
  ChannelType,
  Client,
  Events,
  GatewayIntentBits,
  type Message,
  type PartialMessage,
  Partials,
} from 'discord.js'
import type { DiscordInboundTurn } from '../bridge/contracts.js'
import type { DiscaConfig, DiscordStatusType } from '../config.js'
import type { DiscordActivityEvent } from './activity.js'
import { DiscordArchive } from './archive.js'
import { cleanupOldAttachments } from './attachments.js'
import { sendDiscordDelivery } from './delivery.js'
import type { DiscordDeliveryRequest, DiscordDeliveryResult } from './delivery-contract.js'
import {
  appendEmbedContext,
  archiveDiscordMessage,
  createDiscordMessageHandler,
  type DiscordInboundDependencies,
} from './inbound.js'
import { DiscordInteractionStore } from './interaction-store.js'
import { handleDiscordInteraction, registerDiscordCommands } from './interactions.js'
import { humanizeDiscordText } from './sanitize.js'

export interface DiscordClientHooks {
  chatEnabled(): boolean
  observeActivity(event: DiscordActivityEvent): void
  updateActivity(messageId: string, body: string): void
  deleteActivity(messageId: string): void
  enqueue(turn: DiscordInboundTurn): boolean
  enqueueAmbient(turn: DiscordInboundTurn): void
  updatePending(messageId: string, body: string): boolean
  removePending(messageId: string): boolean
  describeStatus(): string
  report(message: string, level: 'info' | 'warning' | 'error'): void
  archiveHealth(failure: string | undefined): void
  connected(tag: string): void
}

export class DiscordClientRuntime {
  private readonly client: Client
  private readonly hooks: DiscordClientHooks
  private readonly archive: DiscordArchive
  private archiveTimer: ReturnType<typeof setInterval> | undefined
  private readonly interactions = new DiscordInteractionStore()
  private readonly typingTimers = new Map<
    string,
    ReturnType<typeof setTimeout> | ReturnType<typeof setInterval>
  >()
  private inboundWork = Promise.resolve()
  private readyTag: string | undefined
  private startPromise: Promise<void> | undefined
  private stopped = false

  readonly config: DiscaConfig

  constructor(config: DiscaConfig, hooks: DiscordClientHooks) {
    this.config = config
    this.hooks = hooks
    this.archive = new DiscordArchive(config.projectRoot, hooks.archiveHealth)
    const intents = [
      GatewayIntentBits.Guilds,
      GatewayIntentBits.GuildMessages,
      GatewayIntentBits.DirectMessages,
      GatewayIntentBits.MessageContent,
    ]
    this.client = new Client({
      intents,
      partials: [Partials.Channel, Partials.Message],
      presence: {
        activities: [
          { name: config.discordStatusText, type: statusType(config.discordStatusType) },
        ],
      },
    })
  }

  get tag(): string | undefined {
    return this.readyTag
  }

  get connected(): boolean {
    return this.client.isReady()
  }

  async start(): Promise<void> {
    if (this.stopped) throw new Error('Discord runtime has been stopped.')
    if (this.startPromise) return await this.startPromise
    this.archive.flush()
    this.archiveTimer = setInterval(() => {
      try {
        this.archive.flush()
      } catch (error) {
        this.report(`Discord archive retention failed: ${String(error)}`, 'error')
      }
    }, 15_000)
    this.archiveTimer.unref?.()
    this.startPromise = this.startClient()
    return await this.startPromise
  }

  async stop(): Promise<void> {
    this.stopped = true
    if (this.archiveTimer) clearInterval(this.archiveTimer)
    for (const timer of this.typingTimers.values()) clearInterval(timer)
    this.typingTimers.clear()
    this.interactions.clear()
    this.client.removeAllListeners()
    try {
      await this.inboundWork
      this.archive.flush()
    } finally {
      await this.client.destroy()
      this.readyTag = undefined
    }
  }

  async send(request: DiscordDeliveryRequest, nonce?: string): Promise<DiscordDeliveryResult> {
    if (this.stopped || !this.client.isReady()) throw new Error('Discord is not connected.')
    const result = await sendDiscordDelivery(
      this.client,
      this.interactions,
      this.config,
      request,
      nonce,
    )
    this.archiveDelivery(request, result)
    return result
  }

  startTyping(channelId: string): () => void {
    if (this.stopped) return () => {}
    this.stopTyping(channelId)
    let ticks = 0
    const maxTicks = 4
    let stopped = false
    const tick = () => {
      if (stopped || this.stopped) return
      ticks += 1
      void this.sendTyping(channelId)
      if (ticks >= maxTicks) {
        this.typingTimers.delete(channelId)
        return
      }
      const next = setTimeout(tick, 8_000)
      next.unref?.()
      this.typingTimers.set(channelId, next)
    }
    const first = setTimeout(tick, 2_000)
    first.unref?.()
    this.typingTimers.set(channelId, first)
    return () => {
      stopped = true
      this.stopTyping(channelId)
    }
  }

  async resolveChannel(
    destination: string | undefined,
    currentChannelId?: string,
  ): Promise<string> {
    if (this.stopped) throw new Error('Discord is not connected.')
    const value = destination?.trim()
    if (!value || value === 'current') {
      if (!currentChannelId) throw new Error('No current Discord channel. Set channel explicitly.')
      return currentChannelId
    }
    if (value === 'dm') return await this.resolveDirectMessage(this.config.defaultDmUserId)
    if (/^\d+$/u.test(value)) return value
    if (value.startsWith('dm:')) {
      const userId = value.slice(3).trim()
      if (!/^\d+$/u.test(userId)) throw new Error('A DM destination must be dm:<user-id>.')
      return await this.resolveDirectMessage(userId)
    }
    if (value.startsWith('#')) return this.resolveNamedChannel(value)
    throw new Error(`Unknown Discord destination: ${value}`)
  }

  private async resolveDirectMessage(userId: string): Promise<string> {
    return (await (await this.client.users.fetch(userId)).createDM()).id
  }

  private resolveNamedChannel(value: string): string {
    const name = value.slice(1).toLowerCase()
    const matches = [...this.client.channels.cache.values()].filter(
      (channel) =>
        'name' in channel && channel.name?.toLowerCase() === name && channel.isSendable(),
    )
    if (matches.length === 1 && matches[0]) return matches[0].id
    if (matches.length > 1) throw new Error(`Discord channel ${value} is ambiguous. Use its id.`)
    throw new Error(`Unknown Discord destination: ${value}`)
  }

  private async startClient(): Promise<void> {
    const ready = new Promise<void>((resolve, reject) => {
      this.client.once(Events.ClientReady, async (client) => {
        try {
          if (this.stopped) {
            resolve()
            return
          }
          this.readyTag = client.user.tag
          this.bindReadyEvents()
          cleanupOldAttachments(this.config)
          writeChannelSnapshot(client, this.config.channelsPath)
          this.hooks.connected(client.user.tag)
          resolve()
          void registerDiscordCommands(client).catch((error: unknown) => {
            this.report(
              `Discord command registration failed: ${error instanceof Error ? error.message : String(error)}`,
              'warning',
            )
          })
        } catch (error) {
          reject(error)
        }
      })
      this.client.once(Events.Error, reject)
    })
    await this.client.login(this.config.token)
    await ready
  }

  private bindReadyEvents(): void {
    const botId = this.client.user?.id
    if (!botId) throw new Error('Discord connected without a bot user.')
    const dependencies = this.inboundDependencies(botId)
    const messageHandler = createDiscordMessageHandler(dependencies)
    this.client.on(Events.MessageCreate, (message) =>
      this.run('message', () => messageHandler(message)),
    )
    this.client.on(Events.MessageUpdate, (_old, message) => {
      this.run('message update', () => this.reconcileUpdate(message, dependencies))
    })
    this.client.on(Events.MessageDelete, (message) => {
      this.run('message delete', async () => {
        this.archive.delete(message.id)
        if (this.stopped) return
        this.hooks.deleteActivity(message.id)
        if (this.hooks.removePending(message.id)) {
          this.report('Removed a deleted pending Discord message.', 'info')
        }
      })
    })
    this.client.on(Events.InteractionCreate, (interaction) =>
      this.run('interaction', async () => {
        if (this.stopped) return
        await handleDiscordInteraction(interaction, {
          config: this.config,
          store: this.interactions,
          chatEnabled: dependencies.chatEnabled,
          observe: dependencies.observe,
          enqueue: dependencies.enqueue,
          describeStatus: this.hooks.describeStatus,
        })
      }),
    )
    this.client.on(Events.Error, (error) => this.report(error.message, 'error'))
  }

  private inboundDependencies(botId: string): DiscordInboundDependencies {
    return {
      config: this.config,
      botId,
      archive: (entry) => this.archive.archive(entry),
      chatEnabled: () => !this.stopped && this.hooks.chatEnabled(),
      observe: (event) => {
        if (!this.stopped) this.hooks.observeActivity(event)
      },
      enqueue: (turn) => !this.stopped && this.hooks.enqueue(turn),
      enqueueAmbient: (turn) => {
        if (!this.stopped) this.hooks.enqueueAmbient(turn)
      },
      report: (message, level) => this.report(message, level),
    }
  }

  private async reconcileUpdate(
    update: Message | PartialMessage,
    dependencies: DiscordInboundDependencies,
  ): Promise<void> {
    const message = update.partial ? await update.fetch() : update
    if (message.author.bot) return
    await archiveDiscordMessage(message, message.content, dependencies)
    if (this.stopped) return
    const body = appendEmbedContext(humanizeDiscordText(message, message.content), message).trim()
    this.hooks.updateActivity(message.id, body || '[no text]')
    if (this.hooks.updatePending(message.id, body || '[No text]')) {
      this.report('Updated a pending Discord message after its edit.', 'info')
    }
  }

  private async sendTyping(channelId: string): Promise<void> {
    try {
      const channel = await this.client.channels.fetch(channelId)
      if (channel?.isSendable()) await channel.sendTyping()
    } catch {
      this.stopTyping(channelId)
    }
  }

  private stopTyping(channelId: string): void {
    const timer = this.typingTimers.get(channelId)
    if (timer) {
      clearInterval(timer as unknown as ReturnType<typeof setInterval>)
      clearTimeout(timer as unknown as ReturnType<typeof setTimeout>)
    }
    this.typingTimers.delete(channelId)
  }

  private archiveDelivery(request: DiscordDeliveryRequest, result: DiscordDeliveryResult): void {
    if (!result.messageId) return
    try {
      const channel = this.client.channels.cache.get(request.channelId)
      let channelName = request.channelId
      if (channel && 'guild' in channel && 'name' in channel) {
        channelName = `${channel.guild.name} #${channel.name}`
      } else if (channel && 'recipient' in channel) {
        const recipient = channel.recipient
        channelName = `DM with ${recipient?.globalName || recipient?.username || 'unknown user'}`
      }
      const user = this.client.user
      this.archive.archive({
        channelId: request.channelId,
        channelName,
        role: 'assistant',
        senderId: user?.id ?? '',
        senderName: user?.globalName || user?.username || 'Disca',
        content: deliveryHistoryContent(request),
        timestamp: new Date().toISOString(),
        sourceMessageId: result.messageId,
      })
    } catch (error) {
      this.report(
        `Could not archive Discord delivery: ${error instanceof Error ? error.message : String(error)}`,
        'error',
      )
    }
  }

  private run(name: string, operation: () => Promise<void>): void {
    if (this.stopped) return
    this.inboundWork = this.inboundWork.then(operation).catch((error: unknown) => {
      this.report(
        `Discord ${name} failed: ${error instanceof Error ? error.message : String(error)}`,
        'error',
      )
    })
  }

  private report(message: string, level: 'info' | 'warning' | 'error'): void {
    if (!this.stopped || level === 'error') this.hooks.report(message, level)
  }
}

function deliveryHistoryContent(request: DiscordDeliveryRequest): string {
  const files = request.files.map((file) => `[sent file: ${file.path}]`)
  const buttons = request.buttons?.map((button) => `[button: ${button.label}]`) ?? []
  const select = request.select ? [`[select: ${request.select.placeholder}]`] : []
  const poll = request.poll ? [`[poll: ${request.poll.question}]`] : []
  return [
    request.title?.trim() ? `# ${request.title.trim()}` : '',
    request.message?.trim() ?? '',
    ...files,
    ...buttons,
    ...select,
    ...poll,
  ]
    .filter(Boolean)
    .join('\n')
}

function writeChannelSnapshot(client: Client<true>, path: string): void {
  const channels = [...client.channels.cache.values()]
    .filter(
      (channel) =>
        channel.type === ChannelType.GuildText || channel.type === ChannelType.GuildAnnouncement,
    )
    .map((channel) => ({
      id: channel.id,
      name: channel.name,
      guild: 'guild' in channel ? channel.guild.name : undefined,
    }))
    .sort((left, right) =>
      `${left.guild}/${left.name}`.localeCompare(`${right.guild}/${right.name}`),
    )
  if (channelSnapshotMatches(path, channels)) return
  mkdirSync(dirname(path), { recursive: true })
  writeFileSync(
    path,
    `${JSON.stringify({ updatedAt: new Date().toISOString(), channels }, null, 2)}\n`,
    'utf8',
  )
}

function channelSnapshotMatches(path: string, channels: unknown[]): boolean {
  try {
    const previous: unknown = JSON.parse(readFileSync(path, 'utf8'))
    if (typeof previous !== 'object' || previous === null) return false
    return JSON.stringify(Reflect.get(previous, 'channels')) === JSON.stringify(channels)
  } catch {
    return false
  }
}

function statusType(type: DiscordStatusType): ActivityType {
  if (type === 'Playing') return ActivityType.Playing
  if (type === 'Listening') return ActivityType.Listening
  if (type === 'Competing') return ActivityType.Competing
  return ActivityType.Watching
}
