import { createHash } from 'node:crypto'
import { readFileSync } from 'node:fs'
import { resolve } from 'node:path'
import type { AgentMessage } from '@earendil-works/pi-agent-core'
import type { ExtensionAPI, ExtensionContext } from '@earendil-works/pi-coding-agent'
import { AmbientJitter } from './bridge/ambient-jitter.js'
import { extractAssistantError, extractAssistantText } from './bridge/assistant-text.js'
import { selectDiscordContext } from './bridge/context-selection.js'
import {
  type DiscordBridgeState,
  type DiscordInboundTurn,
  INBOUND_MESSAGE_TYPE,
} from './bridge/contracts.js'
import { type DiscordOutputBlock, processDiscordOutput } from './bridge/output.js'
import {
  buildDiscordBatchPrompt,
  buildDiscordSystemPrompt,
  buildDiscordTurnPrompt,
} from './bridge/prompt.js'
import {
  buildDiscordRoutes,
  type DiscordMessageRoute,
  DiscordRouteRegistry,
  type DiscordRoutes,
  MESSAGE_ROUTE_ENTRY_TYPE,
} from './bridge/routes.js'
import { DiscordTurnCoordinator } from './bridge/turn-coordinator.js'
import { type DiscaConfig, loadConfig, writeConfigValue } from './config.js'
import type { DiscordConnectionState } from './discord/activity.js'
import { DiscordClientRuntime } from './discord/client.js'
import type { DiscordDeliveryRequest, DiscordDeliveryResult } from './discord/delivery-contract.js'
import type { DiscordActivityMonitor } from './extension/activity-monitor.js'
import type { DiscaControlTarget } from './extension/control-tools.js'
import type { DiscordToolInput, DiscordToolTarget } from './extension/tool.js'

export class DiscaSession implements DiscaControlTarget, DiscordToolTarget {
  readonly config: DiscaConfig
  private readonly ambient: AmbientJitter
  private readonly bridge: DiscordTurnCoordinator
  private configSnapshot: string
  private readonly monitor: DiscordActivityMonitor
  private readonly pi: ExtensionAPI
  private readonly routeRegistry: DiscordRouteRegistry
  private runtime: DiscordClientRuntime | undefined
  private context: ExtensionContext
  private activePromptTurns: readonly DiscordInboundTurn[] | undefined
  private bridgeState: DiscordBridgeState = { active: [], queued: 0 }
  private connection: DiscordConnectionState = 'missing-token'
  private archiveFailure: string | undefined
  private uiBlocked = false

  constructor(pi: ExtensionAPI, context: ExtensionContext, monitor: DiscordActivityMonitor) {
    this.pi = pi
    this.context = context
    this.monitor = monitor
    this.config = loadConfig(context.cwd)
    this.configSnapshot = readFileSync(this.config.configPath, 'utf8')
    this.routeRegistry = new DiscordRouteRegistry(restoreDiscordRoutes(context), (route) => {
      this.pi.appendEntry(MESSAGE_ROUTE_ENTRY_TYPE, route)
    })
    this.monitor.configure({
      chatEnabled: this.config.discordChatEnabled,
      triggerAliases: this.config.triggerAliases,
      lineCount: this.config.discordActivityLines,
    })
    this.bridge = new DiscordTurnCoordinator(
      {
        isIdle: () => !this.uiBlocked && this.context.isIdle(),
        showTurns: (turns) => this.showTurns(turns),
        deliverOutput: async (turns, text) => await this.deliverOutput(turns, text),
        startTyping: (channelId) => this.runtime?.startTyping(channelId) ?? (() => {}),
        report: (message, level) => this.report(message, level),
        stateChanged: (state) => {
          this.bridgeState = state
          for (const turn of state.active) this.monitor.mark(turn.id, 'active')
          this.updateStatus()
        },
      },
      this.config.maxQueue,
    )
    this.ambient = new AmbientJitter({
      minMessages: this.config.ambientWakeMinMessages,
      maxMessages: this.config.ambientWakeMaxMessages,
      enqueue: (turns) => this.bridge.enqueueBatch(turns),
    })
  }

  async start(): Promise<void> {
    if (!this.pi.getSessionName()) this.pi.setSessionName('Disca')
    await this.connectDiscord()
  }

  async stop(): Promise<void> {
    this.activePromptTurns = undefined
    this.ambient.clear()
    this.bridge.stop()
    await this.disconnectDiscord()
    this.context.ui.setStatus('disca', undefined)
  }

  async disconnectDiscord(): Promise<void> {
    await this.runtime?.stop()
    this.runtime = undefined
    this.connection = 'stopped'
    this.monitor.setConnection(this.connection)
    this.updateStatus()
  }

  async restartDiscord(): Promise<void> {
    await this.disconnectDiscord()
    await this.connectDiscord()
  }

  private async connectDiscord(): Promise<void> {
    if (!this.config.token) {
      this.connection = 'missing-token'
      this.monitor.setConnection(this.connection)
      this.updateStatus()
      this.report('Disca needs a Discord bot token. Run /discord.', 'warning')
      return
    }

    this.connection = 'connecting'
    this.monitor.setConnection(this.connection)
    this.updateStatus()
    try {
      this.runtime = new DiscordClientRuntime(this.config, {
        chatEnabled: () => this.config.discordChatEnabled,
        observeActivity: (event) => this.monitor.record(event),
        updateActivity: (messageId, body) => this.monitor.updateMessage(messageId, body),
        deleteActivity: (messageId) => this.monitor.mark(messageId, 'deleted'),
        enqueue: (turn) => {
          const queued = this.bridge.enqueue(turn)
          if (queued) this.ambient.reset(turn.channelId)
          return queued
        },
        enqueueAmbient: (turn) => {
          const result = this.ambient.offer(turn)
          if (result.status === 'waiting') return
          const activeIds = new Set(this.bridge.activeTurns.map((active) => active.id))
          for (const offered of result.turns) {
            this.monitor.mark(
              offered.id,
              result.status === 'full' ? 'full' : activeIds.has(offered.id) ? 'active' : 'queued',
            )
          }
        },
        updatePending: (messageId, body) =>
          this.ambient.updatePending(messageId, body) || this.bridge.updatePending(messageId, body),
        removePending: (messageId) =>
          this.ambient.removePending(messageId) || this.bridge.removePending(messageId),
        describeStatus: () => this.describeStatus(),
        report: (message, level) => this.report(message, level),
        archiveHealth: (failure) => {
          if (failure === this.archiveFailure) return
          this.archiveFailure = failure
          this.updateStatus()
          this.report(failure ?? 'Discord archive recovered.', failure ? 'error' : 'info')
        },
        connected: (tag) => {
          this.connection = 'connected'
          this.monitor.setConnection(this.connection, tag)
          this.updateStatus()
          this.report(`Discord connected as ${tag}.`, 'info')
        },
      })
      await this.runtime.start()
    } catch (error) {
      await this.runtime?.stop()
      this.runtime = undefined
      this.connection = 'failed'
      this.monitor.setConnection(this.connection)
      this.updateStatus()
      this.report(
        `Discord connection failed: ${error instanceof Error ? error.message : String(error)}`,
        'error',
      )
    }
  }

  useContext(context: ExtensionContext): void {
    this.context = context
  }

  setUiBlocked(blocked: boolean, context: ExtensionContext): void {
    this.context = context
    this.uiBlocked = blocked
    if (!blocked) this.bridge.wake()
  }

  capture(message: AgentMessage): void {
    if (message.role !== 'assistant') return
    this.bridge.captureAssistant(extractAssistantText(message), extractAssistantError(message))
  }

  async settle(context: ExtensionContext): Promise<void> {
    this.context = context
    const completedPromptTurns = this.activePromptTurns
    await this.bridge.settle()
    if (this.activePromptTurns === completedPromptTurns) this.activePromptTurns = undefined
  }

  getDiscordSystemPrompt(context: ExtensionContext): string | undefined {
    this.context = context
    const turns = this.activePromptTurns ?? this.bridge.activeTurns
    return turns.length > 0 ? buildDiscordSystemPrompt(turns, this.routeRegistry) : undefined
  }

  hasConfigChanged(): boolean {
    return readFileSync(this.config.configPath, 'utf8') !== this.configSnapshot
  }

  get chatEnabled(): boolean {
    return this.config.discordChatEnabled
  }

  setChatEnabled(enabled: boolean): void {
    writeConfigValue(this.config.configPath, 'DISCORD_CHAT_ENABLED', String(enabled))
    this.configSnapshot = readFileSync(this.config.configPath, 'utf8')
    this.config.discordChatEnabled = enabled
    this.monitor.setChatEnabled(enabled)
    if (!enabled) this.ambient.clear()
    const dropped = enabled ? [] : this.bridge.drainPending()
    for (const turn of dropped) this.monitor.mark(turn.id, 'paused')
    if (enabled) this.bridge.wake()
    this.updateStatus()
    this.report(
      enabled
        ? 'Discord chat armed. Directed messages can enter Pi.'
        : `Discord chat paused. Monitoring continues${dropped.length > 0 ? ` and ${dropped.length} queued turn(s) were dropped` : ''}.`,
      'info',
    )
  }

  toggleChat(): boolean {
    this.setChatEnabled(!this.config.discordChatEnabled)
    return this.config.discordChatEnabled
  }

  describeStatus(): string {
    const model = this.context.model
      ? `${this.context.model.provider}/${this.context.model.id}`
      : 'no model selected'
    const active = describeActive(this.bridgeState.active)
    return [
      `Disca: ${this.connection}`,
      `Bot: ${this.runtime?.tag ?? 'not connected'}`,
      `History: ${this.archiveFailure ?? 'healthy'}`,
      `Chat: ${this.config.discordChatEnabled ? 'armed' : 'monitor only'}`,
      `Ambient wake: ${this.config.ambientWakeMinMessages}–${this.config.ambientWakeMaxMessages} messages`,
      `Pi: ${active}, ${this.bridgeState.queued} queued`,
      `Model: ${model}`,
      `Users: ${this.config.allowedUserIds.size > 0 ? this.config.allowedUserIds.size : 'all'}`,
      `Channels: ${this.config.channelPolicy}`,
    ].join('\n')
  }

  async sendFromTool(input: DiscordToolInput, cwd: string): Promise<DiscordDeliveryResult> {
    const runtime = this.requireRuntime()
    const routes = buildDiscordRoutes(this.bridge.activeTurns, this.routeRegistry)
    const replyRoute = resolveMessageHandle(input.replyTo, routes)
    const reactionRoute = resolveMessageHandle(input.reaction?.to, routes)
    const defaultChannelId =
      replyRoute?.channelId ?? reactionRoute?.channelId ?? routes.channel?.channelId
    const channelId = await runtime.resolveChannel(input.channel, defaultChannelId)
    if (replyRoute && replyRoute.channelId !== channelId) {
      throw new Error('discord_send channel and replyTo point to different Discord channels.')
    }
    const files = (input.files ?? []).map((file) => ({
      ...file,
      path: resolve(cwd, file.path),
    }))
    const request: DiscordDeliveryRequest = {
      channelId,
      message: input.message?.trim() || undefined,
      title: input.title?.trim() || undefined,
      card: input.card,
      replyToMessageId: replyRoute?.messageId,
      files,
      buttons: input.buttons,
      select: input.select,
      poll: input.poll,
      reaction:
        input.reaction && reactionRoute
          ? {
              channelId: reactionRoute.channelId,
              messageId: reactionRoute.messageId,
              emoji: input.reaction.emoji,
            }
          : undefined,
    }
    return await runtime.send(request)
  }

  private showTurns(turns: readonly DiscordInboundTurn[]): void {
    const promptTurns = selectDiscordContext(turns, this.routeRegistry)
    const routes = buildDiscordRoutes(promptTurns, this.routeRegistry)
    this.activePromptTurns = promptTurns
    try {
      if (promptTurns.length > 1) {
        this.pi.sendMessage(
          {
            customType: INBOUND_MESSAGE_TYPE,
            content: buildDiscordBatchPrompt(promptTurns, routes),
            display: true,
            details: {
              channelLabel: promptTurns[0]?.channelLabel ?? 'unknown-channel',
              senderName: `${promptTurns.length} messages`,
              body: promptTurns.map((turn) => `${turn.senderName}: ${turn.body}`).join('\n'),
              attachmentCount: promptTurns.reduce(
                (total, turn) => total + turn.attachments.length,
                0,
              ),
            },
          },
          { triggerTurn: true },
        )
        return
      }
      for (const [index, turn] of promptTurns.entries()) {
        this.pi.sendMessage(
          {
            customType: INBOUND_MESSAGE_TYPE,
            content: buildDiscordTurnPrompt(turn, routes),
            display: true,
            details: {
              channelLabel: turn.channelLabel,
              messageHandle: routes.messageHandlesById.get(turn.replyToMessageId),
              senderName: turn.senderName,
              body: turn.body,
              attachmentCount: turn.attachments.length,
            },
          },
          { triggerTurn: index === turns.length - 1 },
        )
      }
    } catch (error) {
      if (this.activePromptTurns === promptTurns) this.activePromptTurns = undefined
      throw error
    }
  }

  private async deliverOutput(turns: readonly DiscordInboundTurn[], text: string): Promise<void> {
    const routes = buildDiscordRoutes(turns, this.routeRegistry)
    const repliedTurns = new Set<string>()
    const batchId = turns.map((turn) => turn.id).join(':')

    await processDiscordOutput(text, async (block, index) => {
      const repliedMessageId = await this.deliverBlock(block, routes, batchId, index)
      if (repliedMessageId) {
        for (const turn of turns) {
          if (turn.replyToMessageId === repliedMessageId) repliedTurns.add(turn.id)
        }
      }
    })

    for (const turn of turns) {
      this.monitor.mark(turn.id, repliedTurns.has(turn.id) ? 'replied' : 'handled')
    }
  }

  private async deliverBlock(
    block: DiscordOutputBlock,
    routes: DiscordRoutes,
    batchId: string,
    index: number,
  ): Promise<string | undefined> {
    const messageRoute = routes.messagesByHandle.get(block.target)
    const channelId =
      messageRoute?.channelId ?? (block.target === 'c' ? routes.channel?.channelId : undefined)
    if (!channelId) {
      this.report(`Ignored unknown Discord route [${block.target}].`, 'warning')
      return
    }
    const request: DiscordDeliveryRequest = {
      channelId,
      message: block.content,
      replyToMessageId: messageRoute?.messageId,
      files: [],
    }
    const nonce = createHash('sha256')
      .update(`disca:${batchId}:${index}:${block.target}`)
      .digest('hex')
      .slice(0, 24)
    try {
      await this.sendWithRetry(request, nonce)
      return messageRoute?.messageId
    } catch (error) {
      this.report(
        `Discord route [${block.target}] failed: ${error instanceof Error ? error.message : String(error)}`,
        'error',
      )
    }
  }

  private async sendWithRetry(request: DiscordDeliveryRequest, nonce: string): Promise<void> {
    const runtime = this.requireRuntime()
    let lastError: unknown
    for (let attempt = 0; attempt < 3; attempt += 1) {
      try {
        await runtime.send(request, nonce)
        return
      } catch (error) {
        lastError = error
        if (attempt < 2) await delay(500 * 2 ** attempt)
      }
    }
    throw lastError instanceof Error ? lastError : new Error(String(lastError))
  }

  private requireRuntime(): DiscordClientRuntime {
    if (!this.runtime?.connected) throw new Error('Discord is not connected in this Pi window.')
    return this.runtime
  }

  private updateStatus(): void {
    if (!this.context.hasUI) return
    const activeDescription = describeActive(this.bridgeState.active)
    const active = activeDescription === 'idle' ? 'idle' : `replying ${activeDescription}`
    const queued = this.bridgeState.queued > 0 ? ` · ${this.bridgeState.queued} queued` : ''
    const chat = this.config.discordChatEnabled ? 'armed' : 'monitor'
    const archive = this.archiveFailure ? ' · ARCHIVE FAILED' : ''
    const color = this.archiveFailure
      ? 'error'
      : this.connection === 'connected'
        ? 'success'
        : this.connection === 'failed'
          ? 'error'
          : 'warning'
    this.context.ui.setStatus(
      'disca',
      this.context.ui.theme.fg(
        color,
        `Discord ${this.connection} · ${chat} · ${active}${queued}${archive}`,
      ),
    )
  }

  private report(message: string, level: 'info' | 'warning' | 'error'): void {
    if (this.context.hasUI) this.context.ui.notify(message, level)
  }
}

function describeActive(turns: readonly DiscordInboundTurn[]): string {
  if (turns.length === 0) return 'idle'
  if (turns.length === 1) return turns[0]?.channelLabel ?? '1 message'
  return `${turns.length} messages`
}

function routeHandle(route: { handle: string }): string {
  return route.handle
}

function resolveMessageHandle(
  handle: string | undefined,
  routes: DiscordRoutes,
): DiscordMessageRoute | undefined {
  if (!handle) return
  const route = routes.messagesByHandle.get(handle.toLowerCase())
  if (!route) throw unknownMessageHandle(routes.messages.map(routeHandle))
  return route
}

function unknownMessageHandle(handles: string[]): Error {
  return new Error(`Unknown message handle. Available: ${handles.join(', ') || 'none'}.`)
}

async function delay(milliseconds: number): Promise<void> {
  await new Promise<void>((resolvePromise) => setTimeout(resolvePromise, milliseconds))
}

function restoreDiscordRoutes(context: ExtensionContext): DiscordMessageRoute[] {
  const routes: DiscordMessageRoute[] = []
  for (const entry of context.sessionManager.getEntries()) {
    if (entry.type !== 'custom' || entry.customType !== MESSAGE_ROUTE_ENTRY_TYPE) continue
    if (isDiscordMessageRoute(entry.data)) routes.push(entry.data)
  }
  return routes
}

function isDiscordMessageRoute(value: unknown): value is DiscordMessageRoute {
  if (!value || typeof value !== 'object') return false
  const route = value as Record<string, unknown>
  return (
    typeof route['handle'] === 'string' &&
    typeof route['channelId'] === 'string' &&
    typeof route['messageId'] === 'string'
  )
}
