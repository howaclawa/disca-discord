import { describe, expect, test } from 'bun:test'
import { mkdtempSync, rmSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import {
  archiveDiscordHistoryMessage,
  markDiscordHistoryMessageDeleted,
  searchDiscordHistory,
  updateDiscordHistoryMessage,
} from '../src/discord/history.js'
import { rememberMemory } from '../src/memory.js'
import { searchRecall } from '../src/recall.js'

describe('durable Discord history', () => {
  test('import order and mixed timestamp formats do not change chronological neighbours', () => {
    const project = mkdtempSync(join(tmpdir(), 'disca-history-'))
    try {
      for (const [id, timestamp] of [
        ['later', '2026-08-27 10:02:00'],
        ['earlier', '2026-08-27T10:00:00.000Z'],
        ['anchor', '2026-08-27T11:01:00+01:00'],
        ['tie', '2026-08-27 10:01:00'],
      ]) {
        archiveDiscordHistoryMessage(project, {
          channelId: 'room',
          channelName: 'Room',
          role: 'user',
          senderId: 'igor',
          senderName: 'Igor',
          content: id ?? '',
          timestamp: timestamp ?? '',
          sourceMessageId: id,
        })
      }
      const anchor = searchDiscordHistory(project, { query: 'anchor' })[0]
      expect(
        searchDiscordHistory(project, { around: anchor?.rowId, limit: 3 }).map(
          (row) => row.content,
        ),
      ).toEqual(['earlier', 'anchor', 'tie'])
      expect(searchDiscordHistory(project, { limit: 1 })[0]?.content).toBe('later')
    } finally {
      rmSync(project, { recursive: true, force: true })
    }
  })

  test('archives, updates, searches, and expands conversation context', () => {
    const project = mkdtempSync(join(tmpdir(), 'disca-history-'))
    try {
      archive(project, '101', 'Igor', 'the curious alpaca')
      archive(project, '102', 'Ramtin', 'alpaca follow-up')
      archive(project, '103', 'Igor', 'the answer was forty two')
      archive(project, '103', 'Igor', 'the answer was forty-three')

      const matches = searchDiscordHistory(project, { query: 'alpaca', limit: 5 })
      expect(matches.map((result) => result.sourceMessageId)).toEqual(['102', '101'])
      expect(searchDiscordHistory(project, { query: 'forty', speaker: 'igor' })[0]?.content).toBe(
        'the answer was forty-three',
      )

      const around = searchDiscordHistory(project, { around: matches[0]?.rowId, limit: 3 })
      expect(around.map((result) => result.content)).toEqual([
        'the curious alpaca',
        'alpaca follow-up',
        'the answer was forty-three',
      ])

      updateDiscordHistoryMessage(project, '101', 'edited alpaca')
      expect(searchDiscordHistory(project, { query: 'edited' })[0]?.content).toBe('edited alpaca')
      markDiscordHistoryMessageDeleted(project, '101')
      expect(searchDiscordHistory(project, { query: 'deleted discord' })[0]?.content).toBe(
        '[Deleted Discord message]',
      )
    } finally {
      rmSync(project, { recursive: true, force: true })
    }
  })

  test('recall searches curated memory and Discord as one durable past', () => {
    const project = mkdtempSync(join(tmpdir(), 'disca-recall-'))
    try {
      rememberMemory(project, { text: 'The moon project used violet.', tags: ['project'] })
      archive(project, '201', 'Igor', 'the moon project shipped')

      expect(
        searchRecall(project, { query: 'moon project' }).map((result) => result.source),
      ).toEqual(['memory', 'discord'])
      expect(searchRecall(project, { tags: ['project'] }).map((result) => result.source)).toEqual([
        'memory',
      ])
      expect(() => searchRecall(project, { source: 'discord', tags: ['project'] })).toThrow(
        'cannot be combined',
      )
    } finally {
      rmSync(project, { recursive: true, force: true })
    }
  })
})

function archive(project: string, messageId: string, senderName: string, content: string): void {
  archiveDiscordHistoryMessage(project, {
    channelId: 'channel-1',
    channelName: 'Kindergarten #howaclawa',
    role: 'user',
    senderId: senderName.toLowerCase(),
    senderName,
    content,
    timestamp: `2026-08-27T10:${messageId.slice(-2)}:00.000Z`,
    sourceMessageId: messageId,
  })
}
