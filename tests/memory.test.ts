import { describe, expect, test } from 'bun:test'
import { mkdtempSync, rmSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { DatabaseSync } from 'node:sqlite'
import { rememberMemory, resolveMemoryDbPath } from '../src/memory.js'

describe('resident memory', () => {
  test('creates, edits, and deletes normalized memories in the project database', () => {
    const projectRoot = mkdtempSync(join(tmpdir(), 'disca-memory-'))
    try {
      const created = rememberMemory(projectRoot, {
        text: 'Igor likes systems that stay legible.',
        tags: ['Human', 'system taste', 'Human'],
      })
      expect(created.action).toBe('created')
      expect(created.path).toBe(resolveMemoryDbPath(projectRoot))
      expect(readMemories(created.path)).toEqual([
        {
          id: created.id,
          text: 'Igor likes systems that stay legible.',
          tags: '["human","system-taste"]',
        },
      ])

      expect(
        rememberMemory(projectRoot, {
          id: created.id,
          text: 'Igor likes systems that stay legible and alive.',
          tags: ['human', 'taste'],
        }).action,
      ).toBe('updated')
      expect(readMemories(created.path)[0]).toMatchObject({
        text: 'Igor likes systems that stay legible and alive.',
        tags: '["human","taste"]',
      })

      expect(rememberMemory(projectRoot, { id: created.id, text: '' }).action).toBe('deleted')
      expect(readMemories(created.path)).toEqual([])
    } finally {
      rmSync(projectRoot, { recursive: true, force: true })
    }
  })
})

function readMemories(path: string): Array<{ id: number; text: string; tags: string }> {
  const db = new DatabaseSync(path)
  try {
    return db.prepare('SELECT id, text, tags FROM memories ORDER BY id').all() as Array<{
      id: number
      text: string
      tags: string
    }>
  } finally {
    db.close()
  }
}
