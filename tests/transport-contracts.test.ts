import { describe, expect, test } from 'bun:test'
import { createHash } from 'node:crypto'
import { mkdirSync, mkdtempSync, readFileSync, rmSync, writeFileSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import {
  findCachedDiscordAttachmentPath,
  selectAttachmentsWithinLimits,
} from '../src/discord/attachments.js'
import { validateDiscordDelivery } from '../src/discord/delivery-contract.js'
import { appendDiscordLinksIndex, buildDiscordLinkMetas } from '../src/discord/links.js'
import { DISCORD_TEXT_LIMIT, splitDiscordMessage } from '../src/discord/text.js'

describe('Discord transport boundaries', () => {
  test('selects attachments without crossing per-file or combined limits', () => {
    const result = selectAttachmentsWithinLimits(
      [
        { url: 'https://example/a', name: 'a', contentType: 'text/plain', size: 4 },
        { url: 'https://example/b', name: 'b', contentType: 'text/plain', size: 11 },
        { url: 'https://example/c', name: 'c', contentType: 'text/plain', size: 7 },
      ],
      { maxFileBytes: 10, maxTotalBytes: 10 },
    )
    expect(result.accepted.map((item) => item.name)).toEqual(['a'])
    expect(result.rejected.map((item) => item.name)).toEqual(['b', 'c'])
  })

  test('keeps a deduplicated monthly index of Discord links and embed context', () => {
    const assetsDir = mkdtempSync(join(tmpdir(), 'disca-assets-'))
    try {
      const links = buildDiscordLinkMetas(
        'look https://example.com/thing and https://example.com/thing',
        [
          {
            url: 'https://example.com/thing#preview',
            title: 'A [useful] thing',
            description: 'Why it matters',
          },
        ],
      )
      expect(links).toEqual([
        {
          url: 'https://example.com/thing',
          title: 'A [useful] thing',
          description: 'Why it matters',
        },
      ])

      const options = {
        assetsDir,
        messageId: '123456789012345678',
        messageUrl: 'https://discord.com/channels/1/2/123456789012345678',
        createdAt: new Date('2026-08-25T12:00:00.000Z'),
        senderName: 'Howaboua',
        channelLabel: 'Kindergarten #howaclawa',
        links,
      }
      const path = appendDiscordLinksIndex(options)
      appendDiscordLinksIndex(options)
      const index = readFileSync(path ?? '', 'utf8')
      expect(index.match(/disca-message:123456789012345678/gu)).toHaveLength(1)
      expect(index).toContain('[A useful thing](https://example.com/thing) — Why it matters')
      expect(index).toContain('[source](https://discord.com/channels/1/2/123456789012345678)')
    } finally {
      rmSync(assetsDir, { recursive: true, force: true })
    }
  })

  test('resolves archived images back to their local Pi path', () => {
    const assetsDir = mkdtempSync(join(tmpdir(), 'disca-media-'))
    const messageId = '123456789012345678'
    const createdAt = new Date('2026-08-25T12:00:00.000Z')
    const key = createHash('sha256')
      .update(`${messageId}:https://cdn.discordapp.com/image.png`)
      .digest('hex')
      .slice(0, 12)
    const expected = join(assetsDir, '2026', '08', 'images', `2026-08-25-${key}-a1.png`)
    try {
      mkdirSync(join(expected, '..'), { recursive: true })
      writeFileSync(expected, 'image')
      expect(
        findCachedDiscordAttachmentPath(assetsDir, messageId, createdAt, 0, {
          url: 'https://cdn.discordapp.com/image.png',
          name: 'image.png',
          contentType: 'image/png',
          size: 5,
        }),
      ).toBe(expected)
    } finally {
      rmSync(assetsDir, { recursive: true, force: true })
    }
  })

  test('splits plain replies into Discord-safe chunks', () => {
    const text = `${'a'.repeat(1_500)} ${'b'.repeat(1_500)}`
    const chunks = splitDiscordMessage(text)
    expect(chunks).toHaveLength(2)
    expect(chunks.every((chunk) => chunk.length <= DISCORD_TEXT_LIMIT)).toBe(true)
    expect(chunks.join(' ')).toBe(text)
  })

  test('rejects empty deliveries and invalid rich mode combinations', () => {
    expect(() =>
      validateDiscordDelivery(
        { channelId: 'room', files: [] },
        { maxFileBytes: 10, maxTotalBytes: 20 },
      ),
    ).toThrow('required')
    expect(() =>
      validateDiscordDelivery(
        {
          channelId: 'room',
          card: true,
          poll: { question: 'Pick', answers: ['a', 'b'] },
          files: [],
        },
        { maxFileBytes: 10, maxTotalBytes: 20 },
      ),
    ).toThrow('cannot contain a poll')
  })
})
