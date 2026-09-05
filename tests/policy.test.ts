import { describe, expect, test } from 'bun:test'
import { buildAliasPattern, shouldAcceptDiscordMessage } from '../src/discord/policy.js'

describe('Discord channel policy', () => {
  const base = {
    isDm: false,
    channelId: 'room',
    allowedChannelIds: new Set<string>(),
    excludedChannelIds: new Set<string>(),
    mentioned: false,
    isReplyToBot: false,
    content: 'hello there',
    aliasPattern: buildAliasPattern(['disca']),
  }

  test('mention mode accepts aliases and replies but ignores ambient chatter', () => {
    expect(shouldAcceptDiscordMessage({ ...base, channelPolicy: 'mentions' })).toBe(false)
    expect(
      shouldAcceptDiscordMessage({
        ...base,
        channelPolicy: 'mentions',
        content: 'hey Disca, help',
      }),
    ).toBe(true)
    expect(
      shouldAcceptDiscordMessage({ ...base, channelPolicy: 'mentions', isReplyToBot: true }),
    ).toBe(true)
  })

  test('exclusions override all mode while DMs stay open', () => {
    expect(
      shouldAcceptDiscordMessage({
        ...base,
        channelPolicy: 'all',
        excludedChannelIds: new Set(['room']),
      }),
    ).toBe(false)
    expect(
      shouldAcceptDiscordMessage({
        ...base,
        isDm: true,
        channelPolicy: 'mentions',
        excludedChannelIds: new Set(['room']),
      }),
    ).toBe(true)
  })

  test('a configured channel allowlist constrains every guild policy', () => {
    expect(
      shouldAcceptDiscordMessage({
        ...base,
        channelPolicy: 'mentions',
        mentioned: true,
        allowedChannelIds: new Set(['another-room']),
      }),
    ).toBe(false)
    expect(
      shouldAcceptDiscordMessage({
        ...base,
        channelPolicy: 'all',
        allowedChannelIds: new Set(['room']),
      }),
    ).toBe(true)
  })
})
