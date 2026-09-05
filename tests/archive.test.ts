import { expect, test } from 'bun:test'
import { mkdirSync, mkdtempSync, readFileSync, rmSync, writeFileSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { DiscordArchive } from '../src/discord/archive.js'
import { type DiscordHistoryEntry, searchDiscordHistory } from '../src/discord/history.js'

const entry: DiscordHistoryEntry = {
  channelId: 'room',
  channelName: 'Room',
  role: 'user',
  senderId: 'igor',
  senderName: 'Igor',
  content: 'original',
  timestamp: '2026-08-27T10:00:00Z',
  sourceMessageId: '1',
}

test('failed database writes survive a new archive instance and replay edits/deletes in order', () => {
  const project = mkdtempSync(join(tmpdir(), 'disca-archive-'))
  const health: Array<string | undefined> = []
  try {
    const database = join(project, '.pi/disca/gateway.db')
    mkdirSync(database, { recursive: true })
    const archive = new DiscordArchive(project, (failure) => health.push(failure))
    archive.archive(entry)
    archive.archive({ ...entry, content: 'edited' })
    archive.delete('1')
    expect(health.at(-1)).toContain('3 pending')
    expect(
      JSON.parse(readFileSync(join(project, '.pi/disca/archive-pending.json'), 'utf8')),
    ).toHaveLength(3)

    rmSync(database, { recursive: true })
    const recovered = new DiscordArchive(project, (failure) => health.push(failure))
    recovered.flush()
    expect(health.at(-1)).toBeUndefined()
    expect(searchDiscordHistory(project, {})).toHaveLength(1)
    expect(searchDiscordHistory(project, {})[0]?.content).toBe('[Deleted Discord message]')
    recovered.flush()
    expect(searchDiscordHistory(project, {})).toHaveLength(1)
  } finally {
    rmSync(project, { recursive: true, force: true })
  }
})

test('retention failure throws, remains unhealthy, and retries the in-memory write', () => {
  const project = mkdtempSync(join(tmpdir(), 'disca-archive-'))
  const health: Array<string | undefined> = []
  try {
    writeFileSync(join(project, '.pi'), 'blocked')
    const archive = new DiscordArchive(project, (failure) => health.push(failure))
    expect(() => archive.archive(entry)).toThrow()
    expect(health.at(-1)).toContain('Archive failed')
    rmSync(join(project, '.pi'))
    archive.flush()
    expect(health.at(-1)).toBeUndefined()
    expect(searchDiscordHistory(project, {})[0]?.content).toBe('original')
  } finally {
    rmSync(project, { recursive: true, force: true })
  }
})

test('a corrupt journal blocks startup rather than discarding retained history', () => {
  const project = mkdtempSync(join(tmpdir(), 'disca-archive-'))
  try {
    mkdirSync(join(project, '.pi/disca'), { recursive: true })
    writeFileSync(join(project, '.pi/disca/archive-pending.json'), '[{"entry":{}}]')
    expect(() => new DiscordArchive(project, () => {})).toThrow('Invalid Discord archive journal')
  } finally {
    rmSync(project, { recursive: true, force: true })
  }
})
