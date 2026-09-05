import { mkdirSync } from 'node:fs'
import { dirname, resolve } from 'node:path'
import { DatabaseSync } from 'node:sqlite'
import { defineTool, type ExtensionAPI } from '@earendil-works/pi-coding-agent'
import { Type } from 'typebox'

const MEMORY_DB_RELATIVE_PATH = '.pi/clawa-memory.sqlite'
const MAX_TAG_LENGTH = 48
const MAX_TAGS = 12
const TAG_UNSAFE = /[^a-z0-9:_-]+/gu
const EDGE_DASHES = /^-+|-+$/gu
const rememberToolSchema = Type.Object(
  {
    id: Type.Optional(Type.Integer({ minimum: 1, description: 'Update/delete target' })),
    text: Type.String({ description: 'Empty deletes id' }),
    tags: Type.Optional(
      Type.Array(Type.String({ maxLength: MAX_TAG_LENGTH }), { maxItems: MAX_TAGS }),
    ),
  },
  { additionalProperties: false },
)

export interface RememberMemoryInput {
  id?: number | undefined
  text: string
  tags?: string[] | undefined
}

export type RememberMemoryResult =
  | { action: 'created'; id: number; path: string }
  | { action: 'updated'; id: number; path: string }
  | { action: 'deleted'; id: number; path: string }

export function resolveMemoryDbPath(projectRoot: string): string {
  return resolve(projectRoot, MEMORY_DB_RELATIVE_PATH)
}

export function rememberMemory(
  projectRoot: string,
  input: RememberMemoryInput,
): RememberMemoryResult {
  const id = normalizeId(input.id)
  const text = input.text.trim()
  const tags = normalizeTags(input.tags)
  if (!(id || text)) throw new Error('Memory text is empty. Pass an id with empty text to delete.')

  const path = resolveMemoryDbPath(projectRoot)
  mkdirSync(dirname(path), { recursive: true })
  const db = openMemoryDb(path)
  try {
    if (id && !text) {
      requireChanged(db.prepare('DELETE FROM memories WHERE id = ?').run(id).changes, id)
      return { action: 'deleted', id, path }
    }

    const timestamp = Date.now()
    if (id) {
      const result = db
        .prepare('UPDATE memories SET ts = ?, text = ?, tags = ? WHERE id = ?')
        .run(timestamp, text, JSON.stringify(tags), id)
      requireChanged(result.changes, id)
      return { action: 'updated', id, path }
    }

    const result = db
      .prepare('INSERT INTO memories (ts, text, tags) VALUES (?, ?, ?)')
      .run(timestamp, text, JSON.stringify(tags))
    return { action: 'created', id: Number(result.lastInsertRowid), path }
  } finally {
    db.close()
  }
}

export function registerRememberTool(pi: ExtensionAPI) {
  const tool = defineTool<typeof rememberToolSchema, RememberMemoryResult>({
    name: 'remember',
    label: 'Remember',
    description: 'Create, update, or delete durable memory.',
    parameters: rememberToolSchema,
    async execute(_toolCallId, input, _signal, _onUpdate, context) {
      const result = rememberMemory(context.cwd, {
        id: typeof input.id === 'number' ? input.id : undefined,
        text: input.text,
        tags: Array.isArray(input.tags) ? input.tags : undefined,
      })
      return {
        content: [{ type: 'text' as const, text: formatRememberResult(result) }],
        details: result,
      }
    },
  })
  pi.registerTool(tool)
  return tool
}

function openMemoryDb(path: string): DatabaseSync {
  const db = new DatabaseSync(path)
  db.exec(`
    CREATE TABLE IF NOT EXISTS memories (
      id INTEGER PRIMARY KEY,
      ts INTEGER NOT NULL,
      text TEXT NOT NULL,
      tags TEXT NOT NULL DEFAULT '[]'
    );
    CREATE INDEX IF NOT EXISTS memories_ts_idx ON memories(ts);
  `)
  return db
}

function normalizeId(id: number | undefined): number | undefined {
  if (id === undefined) return undefined
  if (!Number.isSafeInteger(id) || id <= 0) throw new Error('Memory id must be a positive integer.')
  return id
}

function normalizeTags(tags: readonly string[] | undefined): string[] {
  if (!tags) return []
  return [...new Set(tags.map(normalizeTag).filter(Boolean))].slice(0, MAX_TAGS)
}

function normalizeTag(tag: string): string {
  return tag.trim().toLowerCase().replace(TAG_UNSAFE, '-').replace(EDGE_DASHES, '')
}

function requireChanged(changes: number | bigint, id: number): void {
  if (changes === 0 || changes === 0n) throw new Error(`No memory found with id ${id}.`)
}

function formatRememberResult(result: RememberMemoryResult): string {
  if (result.action === 'created') return `Remembered #${result.id}.`
  if (result.action === 'updated') return `Updated memory #${result.id}.`
  return `Deleted memory #${result.id}.`
}
