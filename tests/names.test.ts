import { expect, test } from 'bun:test'
import type { Message } from 'discord.js'
import { humanizeDiscordText } from '../src/discord/sanitize.js'

test('shows Discord mentions as human names instead of ids', () => {
  const message = {
    mentions: {
      members: new Map([['1', { displayName: 'Igor' }]]),
      users: new Map(),
      roles: new Map([['2', { name: 'builders' }]]),
      channels: new Map([['3', { name: 'howaclawa' }]]),
    },
    guild: { members: { cache: new Map() } },
    client: { users: { cache: new Map() } },
  } as unknown as Message

  expect(humanizeDiscordText(message, 'hey <@1> <@&2> <#3> <@4>')).toBe(
    'hey @Igor @builders #howaclawa @unknown-user',
  )
})
