import { describe, expect, test } from 'bun:test'
import type { DiscordInboundTurn } from '../src/bridge/contracts.js'
import { parseDiscordOutput, processDiscordOutput } from '../src/bridge/output.js'
import {
  buildDiscordBatchPrompt,
  buildDiscordSystemPrompt,
  buildDiscordTurnPrompt,
} from '../src/bridge/prompt.js'
import { buildDiscordRoutes, DiscordRouteRegistry } from '../src/bridge/routes.js'

describe('explicit Discord output routing', () => {
  test('parses reply and current-channel blocks in order', () => {
    expect(
      parseDiscordOutput(`private preface
[m1] first reply
with another line

[m2]: second reply
[c] standalone room note`),
    ).toEqual([
      { target: 'm1', content: 'first reply\nwith another line' },
      { target: 'm2', content: 'second reply' },
      { target: 'c', content: 'standalone room note' },
    ])
  })

  test('does not route unmarked text, raw ids, or obsolete hash handles', () => {
    expect(parseDiscordOutput('ordinary Pi response')).toEqual([])
    expect(parseDiscordOutput('[quiet]')).toEqual([])
    expect(parseDiscordOutput('[1493591668904165478] raw id')).toEqual([])
    expect(parseDiscordOutput('[mbqnsufrjsmji] obsolete handle')).toEqual([])
  })

  test('processes deliveries from first to last and does nothing without markers', async () => {
    const delivered: string[] = []
    await processDiscordOutput('[m1] one\n[c] two\n[m2] three', async (block) => {
      await Promise.resolve()
      delivered.push(`${block.target}:${block.content}`)
    })
    expect(delivered).toEqual(['m1:one', 'c:two', 'm2:three'])

    await processDiscordOutput('private Pi text', async () => {
      delivered.push('should not run')
    })
    expect(delivered).toEqual(['m1:one', 'c:two', 'm2:three'])
  })

  test('assigns short session handles and keeps them stable', () => {
    const channelId = '900000000000000001'
    const one = turn('111111111111111111', channelId, 'Alice')
    one.context.push({
      messageId: '333333333333333333',
      senderName: 'Carol',
      body: 'earlier context',
      kind: 'recent',
    })
    one.handles = {
      ...one.handles,
      '333333333333333333': {
        channelId: one.channelId,
        messageId: '333333333333333333',
      },
    }
    const two = turn('222222222222222222', channelId, 'Bob')
    const registry = new DiscordRouteRegistry()
    const routes = buildDiscordRoutes([one, two], registry)

    expect(routes.messages.map((route) => [route.handle, route.messageId])).toEqual([
      ['m1', one.replyToMessageId],
      ['m2', two.replyToMessageId],
      ['m3', '333333333333333333'],
    ])
    expect(routes.channel).toEqual({ channelId, channelLabel: '#room-1' })
    expect(buildDiscordRoutes([one], registry).messages[0]?.handle).toBe('m1')
    expect(
      buildDiscordRoutes([turn('444444444444444444', channelId, 'Dana')], registry).messages[0]
        ?.handle,
    ).toBe('m4')

    const prompt = buildDiscordTurnPrompt(one, routes)
    expect(prompt).toContain('Discord · #room-1')
    expect(prompt).toContain('[m1] Alice:')
    expect(prompt).toContain('[m3] Carol: earlier context')
    expect(prompt).not.toContain('[c')
    expect(prompt).not.toContain(one.replyToMessageId)
    expect(prompt).not.toContain(one.channelId)

    const systemPrompt = buildDiscordSystemPrompt([one, two], registry)
    expect(systemPrompt).toContain('Messages: m1, m2, m3')
    expect(systemPrompt).toContain('Current channel: #room-1')
    expect(systemPrompt).not.toContain(one.channelId)
    expect(systemPrompt).not.toContain(one.replyToMessageId)
  })

  test('combines a batch into one message with friendly senders and no raw ids', () => {
    const channelId = '900000000000000001'
    const one = turn('111111111111111111', channelId, 'Alice')
    const two = turn('222222222222222222', channelId, 'Bob')
    const registry = new DiscordRouteRegistry()
    const routes = buildDiscordRoutes([one, two], registry)
    const prompt = buildDiscordBatchPrompt([one, two], routes)
    expect(prompt).toContain('2 messages')
    expect(prompt).toContain('[m1] Alice:')
    expect(prompt).toContain('[m2] Bob:')
    expect(prompt).toContain('hello from Alice')
    expect(prompt).toContain('hello from Bob')
    expect(prompt).not.toContain('111111111111111111')
    expect(prompt).not.toContain('222222222222222222')
    expect(prompt).not.toContain(channelId)
  })
  test('restores session handles and continues their sequence', () => {
    const channelId = '900000000000000001'
    const created: string[] = []
    const registry = new DiscordRouteRegistry(
      [{ handle: 'm7', channelId, messageId: '111111111111111111' }],
      (route) => created.push(route.handle),
    )
    const routes = buildDiscordRoutes([turn('222222222222222222', channelId, 'Bob')], registry)
    buildDiscordRoutes([turn('222222222222222222', channelId, 'Bob')], registry)

    expect(routes.messages[0]?.handle).toBe('m8')
    expect(routes.messagesByHandle.get('m7')?.messageId).toBe('111111111111111111')
    expect(created).toEqual(['m8'])
  })

  test('rejects invalid ids and mixed-channel batches', () => {
    expect(() =>
      buildDiscordRoutes([turn('0111111111111111111', '900000000000000001', 'Alice')]),
    ).toThrow('Invalid internal Discord id')
    expect(() =>
      buildDiscordRoutes([
        turn('111111111111111111', '900000000000000001', 'Alice'),
        turn('222222222222222222', '900000000000000002', 'Bob'),
      ]),
    ).toThrow('cannot mix channels')
  })
})

function turn(messageId: string, channelId: string, senderName: string): DiscordInboundTurn {
  return {
    id: messageId,
    cause: 'directed',
    channelId,
    channelLabel: channelId.endsWith('1') ? '#room-1' : '#room-2',
    senderName,
    sourceMessageId: messageId,
    replyToMessageId: messageId,
    body: `hello from ${senderName}`,
    receivedAt: '2026-01-01T00:00:00.000Z',
    context: [],
    attachments: [],
    handles: { [messageId]: { channelId, messageId } },
  }
}
