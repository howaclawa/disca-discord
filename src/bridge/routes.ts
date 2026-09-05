import type { DiscordInboundTurn, DiscordMessageHandle } from './contracts.js'

export const MESSAGE_ROUTE_ENTRY_TYPE = 'disca-message-route'

export interface DiscordMessageRoute extends DiscordMessageHandle {
  handle: string
}

export interface DiscordRoutes {
  channel?: { channelId: string; channelLabel: string } | undefined
  messages: DiscordMessageRoute[]
  messagesByHandle: ReadonlyMap<string, DiscordMessageRoute>
  messageHandlesById: ReadonlyMap<string, string>
}

export class DiscordRouteRegistry {
  private readonly byHandle = new Map<string, DiscordMessageRoute>()
  private readonly handlesById = new Map<string, string>()
  private readonly onCreate: ((route: DiscordMessageRoute) => void) | undefined
  private nextHandle = 1

  constructor(
    restored: readonly DiscordMessageRoute[] = [],
    onCreate?: (route: DiscordMessageRoute) => void,
  ) {
    this.onCreate = onCreate
    for (const route of restored) this.restore(route)
  }

  get messagesByHandle(): ReadonlyMap<string, DiscordMessageRoute> {
    return this.byHandle
  }

  get messageHandlesById(): ReadonlyMap<string, string> {
    return this.handlesById
  }

  hasMessage(messageId: string): boolean {
    return this.handlesById.has(messageId)
  }

  getOrCreate(source: DiscordMessageHandle): DiscordMessageRoute {
    const existingHandle = this.handlesById.get(source.messageId)
    const existing = existingHandle ? this.byHandle.get(existingHandle) : undefined
    if (existing) return existing
    assertDiscordId(source.messageId)
    assertDiscordId(source.channelId)

    let handle = `m${this.nextHandle}`
    while (this.byHandle.has(handle)) {
      this.nextHandle += 1
      handle = `m${this.nextHandle}`
    }
    this.nextHandle += 1
    const route = { handle, channelId: source.channelId, messageId: source.messageId }
    this.byHandle.set(handle, route)
    this.handlesById.set(route.messageId, handle)
    this.onCreate?.(route)
    return route
  }

  private restore(route: DiscordMessageRoute): void {
    const match = route.handle.match(/^m([1-9]\d*)$/u)
    if (!match?.[1]) return
    if (!isDiscordId(route.messageId) || !isDiscordId(route.channelId)) return
    if (this.byHandle.has(route.handle) || this.handlesById.has(route.messageId)) return
    const number = Number(match[1])
    if (!Number.isSafeInteger(number)) return
    const restored = { ...route }
    this.byHandle.set(restored.handle, restored)
    this.handlesById.set(restored.messageId, restored.handle)
    this.nextHandle = Math.max(this.nextHandle, number + 1)
  }
}

export function buildDiscordRoutes(
  turns: readonly DiscordInboundTurn[],
  registry = new DiscordRouteRegistry(),
): DiscordRoutes {
  const messages: DiscordMessageRoute[] = []
  const activeHandles = new Set<string>()
  const addMessage = (messageId: string) => {
    const source = turns
      .map((turn) => turn.handles[messageId])
      .find((candidate) => candidate !== undefined)
    if (!source) return
    const route = registry.getOrCreate(source)
    if (activeHandles.has(route.handle)) return
    activeHandles.add(route.handle)
    messages.push(route)
  }

  for (const turn of turns) addMessage(turn.replyToMessageId)
  for (const turn of turns) {
    for (const item of turn.context) addMessage(item.messageId)
  }

  return {
    channel: currentChannel(turns),
    messages,
    messagesByHandle: registry.messagesByHandle,
    messageHandlesById: registry.messageHandlesById,
  }
}

function currentChannel(
  turns: readonly DiscordInboundTurn[],
): { channelId: string; channelLabel: string } | undefined {
  const first = turns[0]
  if (!first) return
  if (turns.some((turn) => turn.channelId !== first.channelId)) {
    throw new Error('A Discord batch cannot mix channels.')
  }
  return { channelId: first.channelId, channelLabel: first.channelLabel }
}

function assertDiscordId(id: string): void {
  if (!isDiscordId(id)) throw new Error(`Invalid internal Discord id: ${id}`)
}

function isDiscordId(id: string): boolean {
  return /^[1-9]\d*$/u.test(id)
}
