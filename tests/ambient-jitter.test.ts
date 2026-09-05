import { describe, expect, test } from 'bun:test'
import { AmbientJitter } from '../src/bridge/ambient-jitter.js'
import type { DiscordInboundTurn } from '../src/bridge/contracts.js'

describe('ambient message jitter', () => {
  test('chooses a fresh inclusive threshold after every wake', () => {
    const batches: Array<readonly DiscordInboundTurn[]> = []
    const samples = [0, 0.999_999]
    const jitter = new AmbientJitter({
      minMessages: 5,
      maxMessages: 20,
      random: () => samples.shift() ?? 0,
      enqueue: (turns) => {
        batches.push(turns)
        return true
      },
    })

    for (let index = 1; index < 5; index += 1) {
      expect(jitter.offer(turn(index)).status).toBe('waiting')
    }
    expect(jitter.offer(turn(5)).status).toBe('queued')
    for (let index = 6; index < 25; index += 1) {
      expect(jitter.offer(turn(index)).status).toBe('waiting')
    }
    expect(jitter.offer(turn(25)).status).toBe('queued')

    expect(batches.map((batch) => batch.length)).toEqual([5, 20])
    expect(new Set(batches[0]?.map((item) => item.batchId)).size).toBe(1)
    expect(batches[0]?.[0]?.batchId).toBe(`ambient:${discordId(5)}`)
    expect(batches[1]?.[0]?.batchId).toBe(`ambient:${discordId(25)}`)
  })

  test('keeps channel counts independent and resets a room after a directed wake', () => {
    const batches: string[][] = []
    const jitter = new AmbientJitter({
      minMessages: 3,
      maxMessages: 3,
      enqueue: (turns) => {
        batches.push(turns.map((item) => item.id))
        return true
      },
    })

    jitter.offer(turn(1, '900000000000000001'))
    jitter.offer(turn(2, '900000000000000001'))
    jitter.offer(turn(3, '900000000000000002'))
    jitter.offer(turn(4, '900000000000000002'))
    jitter.reset('900000000000000001')
    jitter.offer(turn(5, '900000000000000001'))
    jitter.offer(turn(6, '900000000000000001'))
    expect(jitter.offer(turn(7, '900000000000000001')).status).toBe('queued')
    expect(jitter.offer(turn(8, '900000000000000002')).status).toBe('queued')

    expect(batches).toEqual([
      [discordId(5), discordId(6), discordId(7)],
      [discordId(3), discordId(4), discordId(8)],
    ])
  })
})

function discordId(index: number): string {
  return String(900_000_000_000_000_000n + BigInt(index))
}

function turn(index: number, channelId = '900000000000000001'): DiscordInboundTurn {
  const id = discordId(index)
  return {
    id,
    cause: 'ambient',
    channelId,
    channelLabel: '#room',
    senderName: 'Friend',
    sourceMessageId: id,
    replyToMessageId: id,
    body: `ambient ${index}`,
    receivedAt: '2026-01-01T00:00:00.000Z',
    context: [],
    attachments: [],
    handles: { [id]: { channelId, messageId: id } },
  }
}
