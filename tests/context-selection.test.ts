import { describe, expect, test } from 'bun:test'
import { selectDiscordContext } from '../src/bridge/context-selection.js'
import type { DiscordContextLine, DiscordInboundTurn } from '../src/bridge/contracts.js'
import { buildDiscordRoutes, DiscordRouteRegistry } from '../src/bridge/routes.js'

describe('continuous Discord context', () => {
  test('injects ambient messages once while retaining explicit reply chains', () => {
    const channelId = '900000000000000001'
    const registry = new DiscordRouteRegistry()
    registry.getOrCreate({ channelId, messageId: '111111111111111111' })
    registry.getOrCreate({ channelId, messageId: '555555555555555555' })
    const first = turn('222222222222222222', channelId, [
      context('111111111111111111', 'seen ambient', 'recent'),
      context('555555555555555555', 'another seen ambient', 'recent'),
      context('333333333333333333', 'new ambient', 'recent'),
      context('111111111111111111', 'explicit parent', 'reply'),
      context('444444444444444444', 'next current message', 'recent'),
    ])
    const second = turn('444444444444444444', channelId, [
      context('333333333333333333', 'new ambient repeated', 'recent'),
    ])

    const selected = selectDiscordContext([first, second], registry)
    expect(selected.map((item) => item.context.map((line) => line.body))).toEqual([
      ['new ambient', 'explicit parent'],
      [],
    ])

    const routes = buildDiscordRoutes(selected, registry)
    expect(routes.messages.map((route) => route.messageId)).toEqual([
      '222222222222222222',
      '444444444444444444',
      '333333333333333333',
      '111111111111111111',
    ])
    expect(selectDiscordContext([first], registry)[0]?.context.map((line) => line.body)).toEqual([
      'explicit parent',
    ])
  })
})

function context(
  messageId: string,
  body: string,
  kind: DiscordContextLine['kind'],
): DiscordContextLine {
  return { messageId, senderName: 'User', body, kind }
}

function turn(
  messageId: string,
  channelId: string,
  contextLines: DiscordContextLine[],
): DiscordInboundTurn {
  const handles = Object.fromEntries(
    [messageId, ...contextLines.map((line) => line.messageId)].map((id) => [
      id,
      { channelId, messageId: id },
    ]),
  )
  return {
    id: messageId,
    cause: 'directed',
    channelId,
    channelLabel: '#room',
    senderName: 'User',
    sourceMessageId: messageId,
    replyToMessageId: messageId,
    body: 'current',
    receivedAt: '2026-01-01T00:00:00.000Z',
    context: contextLines,
    attachments: [],
    handles,
  }
}
