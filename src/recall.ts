import { existsSync } from 'node:fs'
import { DatabaseSync } from 'node:sqlite'
import { StringEnum } from '@earendil-works/pi-ai'
import { defineTool, type ExtensionAPI } from '@earendil-works/pi-coding-agent'
import { Type } from 'typebox'
import {
  type DiscordHistoryResult,
  type DiscordHistoryRole,
  MAX_HISTORY_LIMIT,
  normalizeHistoryLimit,
  searchDiscordHistory,
  tokenizeHistoryQuery,
} from './discord/history.js'
import { resolveMemoryDbPath } from './memory.js'

type RecallSource = 'all' | 'discord' | 'memory'

export interface RecallSearchInput {
  query?: string | undefined
  source?: RecallSource | undefined
  tags?: string[] | undefined
  speaker?: string | undefined
  channel?: string | undefined
  discordRole?: DiscordHistoryRole | undefined
  around?: number | undefined
  limit?: number | undefined
}

export type RecallResult =
  | {
      source: 'memory'
      score: number
      timestampMs: number
      id: number
      text: string
      tags: string[]
    }
  | ({ source: 'discord' } & DiscordHistoryResult)

interface MemoryRow {
  id: number
  ts: number
  text: string
  tags: string
}

const MAX_EXCERPT_CHARS = 500
const recallToolSchema = Type.Object(
  {
    query: Type.Optional(Type.String({ description: 'Omit for recent' })),
    source: Type.Optional(StringEnum(['all', 'memory', 'discord'] as const)),
    tags: Type.Optional(Type.Array(Type.String(), { maxItems: 12, description: 'Memory only' })),
    speaker: Type.Optional(Type.String()),
    channel: Type.Optional(Type.String()),
    discordRole: Type.Optional(StringEnum(['user', 'assistant', 'reaction'] as const)),
    around: Type.Optional(Type.Integer({ minimum: 1, description: 'Discord #row to expand' })),
    limit: Type.Optional(
      Type.Integer({ minimum: 1, maximum: MAX_HISTORY_LIMIT, description: 'Default 10' }),
    ),
  },
  { additionalProperties: false },
)

export function searchRecall(projectRoot: string, input: RecallSearchInput): RecallResult[] {
  validateRecallInput(input)
  const limit = normalizeHistoryLimit(input.limit)
  const source = effectiveSource(input)
  const results: RecallResult[] = []
  if (source !== 'discord') results.push(...searchMemories(projectRoot, input, limit))
  if (source !== 'memory') {
    results.push(
      ...searchDiscordHistory(projectRoot, {
        query: input.query,
        speaker: input.speaker,
        channel: input.channel,
        role: input.discordRole,
        around: input.around,
        limit,
      }).map((result): RecallResult => ({ source: 'discord', ...result })),
    )
  }
  if (input.around !== undefined) return results
  return results.sort(compareRecall).slice(0, limit)
}

function validateRecallInput(input: RecallSearchInput): void {
  const hasTags = Boolean(input.tags?.length)
  const hasDiscordFilter = Boolean(
    input.speaker || input.channel || input.discordRole || input.around !== undefined,
  )
  if (hasTags && (input.source === 'discord' || hasDiscordFilter)) {
    throw new Error('Memory tags cannot be combined with Discord-only recall filters.')
  }
  if (input.source === 'memory' && hasDiscordFilter) {
    throw new Error('Discord-only recall filters cannot be used with memory source.')
  }
}

export function registerRecallTool(pi: ExtensionAPI) {
  const tool = defineTool<typeof recallToolSchema, { count: number; results: RecallResult[] }>({
    name: 'recall',
    label: 'Recall',
    description: 'Search durable memory and Discord history.',
    parameters: recallToolSchema,
    async execute(_toolCallId, input, _signal, _onUpdate, context) {
      const results = searchRecall(context.cwd, input)
      return {
        content: [{ type: 'text' as const, text: formatRecallResults(results) }],
        details: { count: results.length, results },
      }
    },
  })
  pi.registerTool(tool)
  return tool
}

function searchMemories(
  projectRoot: string,
  input: RecallSearchInput,
  limit: number,
): RecallResult[] {
  const path = resolveMemoryDbPath(projectRoot)
  if (!existsSync(path)) return []
  const tokens = tokenizeHistoryQuery(input.query)
  const requiredTags = normalizeTags(input.tags)
  const db = new DatabaseSync(path, { readOnly: true })
  try {
    const rows = db
      .prepare('SELECT id, ts, text, tags FROM memories ORDER BY ts DESC')
      .all() as unknown as MemoryRow[]
    return rows
      .flatMap((row): RecallResult[] => {
        const tags = parseTags(row.tags)
        if (!requiredTags.every((tag) => tags.includes(tag))) return []
        const normalized = `${row.text}\n${tags.join(' ')}`.toLowerCase()
        if (!tokens.every((token) => normalized.includes(token))) return []
        const phrase = input.query?.trim().toLowerCase()
        const score = 3 + tokens.length * 2 + (phrase && normalized.includes(phrase) ? 3 : 0)
        return [
          {
            source: 'memory',
            score,
            timestampMs: row.ts,
            id: row.id,
            text: row.text,
            tags,
          },
        ]
      })
      .sort(compareRecall)
      .slice(0, limit)
  } finally {
    db.close()
  }
}

function effectiveSource(input: RecallSearchInput): RecallSource {
  if (input.source && input.source !== 'all') return input.source
  if (input.tags?.length) return 'memory'
  if (input.speaker || input.channel || input.discordRole || input.around !== undefined) {
    return 'discord'
  }
  return 'all'
}

function normalizeTags(tags: readonly string[] | undefined): string[] {
  return [...new Set((tags ?? []).map((tag) => tag.trim().toLowerCase()).filter(Boolean))]
}

function parseTags(raw: string): string[] {
  try {
    const value = JSON.parse(raw) as unknown
    return Array.isArray(value)
      ? value
          .filter((tag): tag is string => typeof tag === 'string')
          .map((tag) => tag.toLowerCase())
      : []
  } catch {
    return []
  }
}

function compareRecall(left: RecallResult, right: RecallResult): number {
  return right.score - left.score || right.timestampMs - left.timestampMs
}

function formatRecallResults(results: readonly RecallResult[]): string {
  if (results.length === 0) return 'No matching durable memories or Discord history found.'
  return results
    .map((result, index) => {
      if (result.source === 'memory') {
        const tags = result.tags.length > 0 ? ` [${result.tags.join(',')}]` : ''
        return `${index + 1}. [mem #${result.id}]${tags}\n${excerpt(result.text)}`
      }
      return [
        `${index + 1}. [discord #${result.rowId}] ${result.timestamp} · ${result.senderName} · ${result.channelName} · ${result.role}`,
        excerpt(result.content),
      ].join('\n')
    })
    .join('\n\n')
}

function excerpt(text: string): string {
  const compact = text.replace(/\r?\n/gu, ' ').replaceAll(/\s+/gu, ' ').trim()
  if (compact.length <= MAX_EXCERPT_CHARS) return compact
  return `${compact.slice(0, MAX_EXCERPT_CHARS).trimEnd()}…`
}
