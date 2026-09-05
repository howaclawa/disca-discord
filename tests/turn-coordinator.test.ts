import { describe, expect, test } from 'bun:test'
import type { DiscordInboundTurn } from '../src/bridge/contracts.js'
import { type DiscordBridgeHost, DiscordTurnCoordinator } from '../src/bridge/turn-coordinator.js'

interface Harness {
  coordinator: DiscordTurnCoordinator
  setIdle(value: boolean): void
  shown: string[][]
  delivered: Array<{ ids: string[]; text: string }>
  typingStopped: string[]
  reports: string[]
}

describe('visible Pi turn coordination', () => {
  test('runs one Discord turn at a time and replies in source order', async () => {
    const harness = createHarness(2)
    expect(harness.coordinator.enqueue(turn('one'))).toBe(true)
    expect(harness.coordinator.enqueue(turn('two'))).toBe(true)
    expect(harness.shown).toEqual([['one']])

    harness.coordinator.captureAssistant('[m1] first answer')
    harness.setIdle(true)
    await harness.coordinator.settle()
    await Promise.resolve()
    expect(harness.delivered).toEqual([{ ids: ['one'], text: '[m1] first answer' }])
    expect(harness.shown).toEqual([['one'], ['two']])

    harness.coordinator.captureAssistant('[m1] second answer')
    harness.setIdle(true)
    await harness.coordinator.settle()
    expect(harness.delivered.at(-1)).toEqual({ ids: ['two'], text: '[m1] second answer' })
    expect(harness.typingStopped).toEqual([])
  })

  test('drains messages that waited behind Pi into one ordered batch', async () => {
    const harness = createHarness(3, false)
    harness.coordinator.enqueue(turn('one'))
    harness.coordinator.enqueue(turn('two'))
    harness.coordinator.enqueue(turn('three'))
    expect(harness.shown).toEqual([])
    harness.setIdle(true)
    await harness.coordinator.settle()
    expect(harness.shown).toEqual([['one', 'two', 'three']])
    expect(harness.coordinator.activeTurns.map((item) => item.id)).toEqual(['one', 'two', 'three'])
  })

  test('keeps batches channel-local without reordering the queue', async () => {
    const harness = createHarness(3, false)
    harness.coordinator.enqueue(turn('one', 'room'))
    harness.coordinator.enqueue(turn('two', 'dm'))
    harness.coordinator.enqueue(turn('three', 'room'))

    harness.setIdle(true)
    await harness.coordinator.settle()
    expect(harness.shown).toEqual([['one']])

    harness.setIdle(true)
    await harness.coordinator.settle()
    await Promise.resolve()
    expect(harness.shown).toEqual([['one'], ['two']])

    harness.setIdle(true)
    await harness.coordinator.settle()
    await Promise.resolve()
    expect(harness.shown).toEqual([['one'], ['two'], ['three']])
  })

  test('does not invent a Discord fallback when the model fails', async () => {
    const harness = createHarness(2)
    harness.coordinator.enqueue(turn('failed'))
    harness.coordinator.captureAssistant('', 'provider failed')
    harness.setIdle(true)
    await harness.coordinator.settle()
    expect(harness.delivered).toEqual([{ ids: ['failed'], text: '' }])
    expect(harness.reports).toEqual(['Pi turn failed: provider failed'])
  })

  test('deduplicates replayed events and rejects only actual overflow', () => {
    const harness = createHarness(1, false)
    expect(harness.coordinator.enqueue(turn('one'))).toBe(true)
    expect(harness.coordinator.enqueue(turn('one'))).toBe(true)
    expect(harness.coordinator.enqueue(turn('two'))).toBe(false)
    expect(
      harness.coordinator.enqueueBatch([
        turn('ambient-one', 'room', 'ambient', 'wake'),
        turn('ambient-two', 'room', 'ambient', 'wake'),
      ]),
    ).toBe(false)
    expect(harness.coordinator.state.queued).toBe(1)
  })

  test('drops waiting Discord turns without cancelling the active turn', () => {
    const harness = createHarness(2)
    harness.coordinator.enqueue(turn('active'))
    harness.coordinator.enqueue(turn('waiting'))

    expect(harness.coordinator.drainPending().map((item) => item.id)).toEqual(['waiting'])
    expect(harness.coordinator.activeTurns.map((item) => item.id)).toEqual(['active'])
    expect(harness.coordinator.state.queued).toBe(0)
  })

  test('keeps ambient wakes atomic and lets directed messages pass queued ambience', async () => {
    const harness = createHarness(8, false)
    expect(
      harness.coordinator.enqueueBatch([
        turn('ambient-one', 'room', 'ambient', 'wake-one'),
        turn('ambient-two', 'room', 'ambient', 'wake-one'),
      ]),
    ).toBe(true)
    expect(harness.coordinator.enqueue(turn('directed', 'room'))).toBe(true)
    expect(
      harness.coordinator.enqueueBatch([
        turn('ambient-three', 'room', 'ambient', 'wake-two'),
        turn('ambient-four', 'room', 'ambient', 'wake-two'),
      ]),
    ).toBe(true)

    harness.setIdle(true)
    await harness.coordinator.settle()
    expect(harness.shown).toEqual([['directed']])

    harness.setIdle(true)
    await harness.coordinator.settle()
    await Promise.resolve()
    expect(harness.shown.at(-1)).toEqual(['ambient-one', 'ambient-two'])

    harness.setIdle(true)
    await harness.coordinator.settle()
    await Promise.resolve()
    expect(harness.shown.at(-1)).toEqual(['ambient-three', 'ambient-four'])
    expect(harness.typingStopped).toEqual([])
  })
})

function createHarness(maxQueue: number, initiallyIdle = true): Harness {
  let idle = initiallyIdle
  const shown: string[][] = []
  const delivered: Array<{ ids: string[]; text: string }> = []
  const typingStopped: string[] = []
  const reports: string[] = []
  const host: DiscordBridgeHost = {
    isIdle: () => idle,
    showTurns: (values) => {
      shown.push(values.map((value) => value.id))
      idle = false
    },
    deliverOutput: async (values, text) => {
      delivered.push({ ids: values.map((value) => value.id), text })
    },
    startTyping: (channelId) => () => typingStopped.push(channelId),
    report: (message) => reports.push(message),
    stateChanged() {},
  }
  return {
    coordinator: new DiscordTurnCoordinator(host, maxQueue),
    setIdle: (value) => {
      idle = value
    },
    shown,
    delivered,
    typingStopped,
    reports,
  }
}

function turn(
  id: string,
  channelId = 'room',
  cause: DiscordInboundTurn['cause'] = 'directed',
  batchId?: string,
): DiscordInboundTurn {
  return {
    id,
    cause,
    ...(batchId ? { batchId } : {}),
    channelId,
    channelLabel: `#${channelId}`,
    senderName: 'User',
    sourceMessageId: id,
    replyToMessageId: id,
    body: id,
    receivedAt: '2026-01-01T00:00:00.000Z',
    context: [],
    attachments: [],
    handles: { [id]: { channelId, messageId: id } },
  }
}
