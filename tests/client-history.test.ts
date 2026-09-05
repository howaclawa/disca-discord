import { expect, spyOn, test } from 'bun:test'
import { mkdtempSync, rmSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { type Client, Events, type Message } from 'discord.js'
import type { DiscaConfig } from '../src/config.js'
import { cacheDiscordAttachments } from '../src/discord/attachments.js'
import { type DiscordClientHooks, DiscordClientRuntime } from '../src/discord/client.js'
import { searchDiscordHistory } from '../src/discord/history.js'

test('edits preserve cached attachments and embeds, including partial update fetches', async () => {
  const project = mkdtempSync(join(tmpdir(), 'disca-client-'))
  const config = configuration(project)
  const fetch = spyOn(globalThis, 'fetch').mockResolvedValue(new Response('image'))
  const runtime = new DiscordClientRuntime(config, hooks())
  try {
    const attachment = {
      url: 'https://example.com/art.png',
      name: 'art.png',
      size: 5,
      contentType: 'image/png',
    }
    const createdAt = new Date('2026-08-27T10:00:00Z')
    const cached = await cacheDiscordAttachments(config, '1', createdAt, [attachment])
    fetch.mockRejectedValue(new Error('must reuse cached file'))
    const client = bind(runtime)
    const message = {
      id: '1',
      channelId: 'room',
      guild: null,
      partial: false,
      author: { id: 'igor', username: 'Igor', bot: false },
      content: 'edited caption',
      createdAt,
      url: 'https://discord.com/channels/@me/room/1',
      attachments: new Map([['attachment', attachment]]),
      embeds: [{ title: 'An embed', description: 'Still here', url: 'https://example.com' }],
    } as unknown as Message
    client.emit(Events.MessageUpdate, message as never, message as never)
    await Reflect.get(runtime, 'inboundWork')
    let content = searchDiscordHistory(project, {})[0]?.content
    expect(content).toContain('edited caption')
    expect(content).toContain('An embed')
    expect(content).toContain(cached.cached[0]?.localPath ?? 'missing attachment')
    expect(fetch).toHaveBeenCalledTimes(1)

    const rotated = await cacheDiscordAttachments(config, '1', createdAt, [
      { ...attachment, url: `${attachment.url}?signature=new` },
    ])
    expect(rotated.cached[0]?.localPath).toBe(cached.cached[0]?.localPath)
    expect(fetch).toHaveBeenCalledTimes(1)
    fetch.mockResolvedValue(new Response('replacement'))
    const replaced = await cacheDiscordAttachments(config, '1', createdAt, [
      { ...attachment, url: 'https://example.com/replacement.png' },
    ])
    expect(replaced.cached[0]?.localPath).not.toBe(cached.cached[0]?.localPath)
    expect(fetch).toHaveBeenCalledTimes(2)

    const empty = { ...message, content: '', embeds: [], attachments: new Map() }
    client.emit(
      Events.MessageUpdate,
      message as never,
      { partial: true, fetch: async () => empty } as never,
    )
    await Reflect.get(runtime, 'inboundWork')
    content = searchDiscordHistory(project, {})[0]?.content
    expect(content).toBe('[No text]')
  } finally {
    fetch.mockRestore()
    await runtime.stop()
    rmSync(project, { recursive: true, force: true })
  }
})

test('shutdown drains accepted updates and deletes without touching retired pending turns', async () => {
  const project = mkdtempSync(join(tmpdir(), 'disca-client-'))
  let pendingUpdates = 0
  const runtime = new DiscordClientRuntime(configuration(project), {
    ...hooks(),
    updatePending: () => {
      pendingUpdates++
      return true
    },
  })
  try {
    const client = bind(runtime)
    const gate = Promise.withResolvers<Message>()
    client.emit(
      Events.MessageUpdate,
      {} as never,
      { partial: true, fetch: () => gate.promise } as never,
    )
    client.emit(Events.MessageDelete, { id: '1' } as never)
    let stopped = false
    const stopping = runtime.stop().then(() => {
      stopped = true
    })
    await Promise.resolve()
    await Promise.resolve()
    expect(stopped).toBe(false)
    gate.resolve({
      id: '1',
      channelId: 'room',
      guild: null,
      partial: false,
      author: { id: 'igor', username: 'Igor', bot: false },
      content: 'accepted before shutdown',
      createdAt: new Date('2026-08-27T10:00:00Z'),
      url: '',
      attachments: new Map(),
      embeds: [],
    } as unknown as Message)
    await stopping
    expect(stopped).toBe(true)
    expect(pendingUpdates).toBe(0)
    expect(searchDiscordHistory(project, {})[0]?.content).toBe('[Deleted Discord message]')
  } finally {
    await runtime.stop()
    rmSync(project, { recursive: true, force: true })
  }
})

function bind(runtime: DiscordClientRuntime): Client {
  const client: Client = Reflect.get(runtime, 'client')
  Reflect.set(client, 'user', { id: 'bot' })
  Reflect.get(runtime, 'bindReadyEvents').call(runtime)
  return client
}

function hooks(): DiscordClientHooks {
  return {
    chatEnabled: () => true,
    observeActivity: () => {},
    updateActivity: () => {},
    deleteActivity: () => {},
    enqueue: () => true,
    enqueueAmbient: () => {},
    updatePending: () => false,
    removePending: () => false,
    describeStatus: () => '',
    report: () => {},
    archiveHealth: () => {},
    connected: () => {},
  }
}

function configuration(projectRoot: string): DiscaConfig {
  return {
    projectRoot,
    configPath: join(projectRoot, '.env'),
    dataDir: join(projectRoot, '.pi/disca'),
    assetsDir: join(projectRoot, '.pi/disca/assets'),
    channelsPath: join(projectRoot, 'channels.json'),
    token: '',
    defaultDmUserId: 'igor',
    allowedUserIds: new Set(),
    channelPolicy: 'all',
    allowedChannelIds: new Set(),
    excludedChannelIds: new Set(),
    triggerAliases: [],
    discordStatusText: 'the live room',
    discordStatusType: 'Watching',
    discordChatEnabled: true,
    ambientWakeMinMessages: 2,
    ambientWakeMaxMessages: 3,
    discordActivityLines: 5,
    recentContextMessages: 0,
    maxQueue: 10,
    maxAttachmentBytes: 100,
    maxTotalAttachmentBytes: 100,
    attachmentRetentionDays: 30,
  }
}
