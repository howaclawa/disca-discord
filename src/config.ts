import { existsSync, readFileSync, writeFileSync } from 'node:fs'
import { resolve } from 'node:path'

export type ChannelPolicy = 'mentions' | 'channels' | 'all'
export type DiscordStatusType = 'Playing' | 'Watching' | 'Listening' | 'Competing'

export interface DiscaConfig {
  projectRoot: string
  configPath: string
  dataDir: string
  assetsDir: string
  channelsPath: string
  token: string
  defaultDmUserId: string
  allowedUserIds: ReadonlySet<string>
  channelPolicy: ChannelPolicy
  allowedChannelIds: ReadonlySet<string>
  excludedChannelIds: ReadonlySet<string>
  triggerAliases: string[]
  discordStatusText: string
  discordStatusType: DiscordStatusType
  discordChatEnabled: boolean
  ambientWakeMinMessages: number
  ambientWakeMaxMessages: number
  discordActivityLines: number
  recentContextMessages: number
  maxQueue: number
  maxAttachmentBytes: number
  maxTotalAttachmentBytes: number
  attachmentRetentionDays: number
}

const CHANNEL_POLICIES = ['mentions', 'channels', 'all'] as const
const STATUS_TYPES = ['Playing', 'Watching', 'Listening', 'Competing'] as const
const LINE_BREAK = /\r?\n/u
const TRAILING_NEWLINES = /\n*$/u

export function loadConfig(projectRoot: string): DiscaConfig {
  const configPath = resolve(projectRoot, '.env')
  if (!existsSync(configPath)) throw new Error(`Disca config is missing: ${configPath}`)
  const source = readEnvFile(configPath)
  const dataDir = resolve(projectRoot, '.pi', 'disca')
  const maxQueue = readInteger(source, 'MAX_QUEUE', 1)
  const ambientWakeMinMessages = readInteger(source, 'AMBIENT_WAKE_MIN_MESSAGES', 1)
  const ambientWakeMaxMessages = readInteger(source, 'AMBIENT_WAKE_MAX_MESSAGES', 1)
  if (ambientWakeMaxMessages < ambientWakeMinMessages) {
    throw new Error('AMBIENT_WAKE_MAX_MESSAGES must be at least AMBIENT_WAKE_MIN_MESSAGES.')
  }
  if (ambientWakeMaxMessages > maxQueue) {
    throw new Error('AMBIENT_WAKE_MAX_MESSAGES cannot exceed MAX_QUEUE.')
  }

  return {
    projectRoot,
    configPath,
    dataDir,
    assetsDir: resolve(dataDir, 'assets'),
    channelsPath: resolve(dataDir, 'channels.json'),
    token: source['DISCORD_BOT_TOKEN']?.trim() ?? '',
    defaultDmUserId: readDiscordId(source, 'DEFAULT_DM_USER_ID'),
    allowedUserIds: readSet(source['ALLOWED_USER_IDS']),
    channelPolicy: readEnum(source, 'CHANNEL_POLICY', CHANNEL_POLICIES),
    allowedChannelIds: readSet(source['ALLOWED_CHANNEL_IDS']),
    excludedChannelIds: readSet(source['EXCLUDED_CHANNEL_IDS']),
    triggerAliases: readList(source['TRIGGER_ALIASES']),
    discordStatusText: readStatusText(source),
    discordStatusType: readEnum(source, 'DISCORD_STATUS_TYPE', STATUS_TYPES),
    discordChatEnabled: readBoolean(source, 'DISCORD_CHAT_ENABLED'),
    ambientWakeMinMessages,
    ambientWakeMaxMessages,
    discordActivityLines: readInteger(source, 'DISCORD_ACTIVITY_LINES', 1),
    recentContextMessages: readInteger(source, 'RECENT_CONTEXT_MESSAGES', 0),
    maxQueue,
    maxAttachmentBytes: readInteger(source, 'MAX_ATTACHMENT_BYTES', 0),
    maxTotalAttachmentBytes: readInteger(source, 'MAX_TOTAL_ATTACHMENT_BYTES', 0),
    attachmentRetentionDays: readInteger(source, 'ATTACHMENT_RETENTION_DAYS', 1),
  }
}

export function writeConfigValue(configPath: string, key: string, value: string): void {
  const existing = existsSync(configPath) ? readFileSync(configPath, 'utf8').split(LINE_BREAK) : []
  let found = false
  const lines = existing.map((line) => {
    if (line.trimStart().startsWith('#')) return line
    const equals = line.indexOf('=')
    if (equals === -1 || line.slice(0, equals).trim() !== key) return line
    found = true
    return `${key}=${value}`
  })
  if (!found) lines.push(`${key}=${value}`)

  writeFileSync(configPath, `${lines.join('\n').replace(TRAILING_NEWLINES, '')}\n`, 'utf8')
}

function readEnvFile(path: string): Record<string, string> {
  if (!existsSync(path)) return {}
  const values: Record<string, string> = {}
  for (const line of readFileSync(path, 'utf8').split(LINE_BREAK)) {
    const trimmed = line.trim()
    if (!trimmed || trimmed.startsWith('#')) continue
    const equals = trimmed.indexOf('=')
    if (equals <= 0) continue
    values[trimmed.slice(0, equals).trim()] = trimmed.slice(equals + 1).trim()
  }
  return values
}

function readStatusText(source: Record<string, string>): string {
  const value = source['DISCORD_STATUS_TEXT']?.trim()
  if (!value) throw new Error('DISCORD_STATUS_TEXT is missing from .env.')
  if (value.length > 128) throw new Error('DISCORD_STATUS_TEXT must be 128 characters or fewer.')
  return value
}

function readList(value: string | undefined): string[] {
  return (value ?? '')
    .split(',')
    .map((item) => item.trim())
    .filter(Boolean)
}

function readSet(value: string | undefined): ReadonlySet<string> {
  return new Set(readList(value))
}

function readBoolean(source: Record<string, string>, key: string): boolean {
  const value = source[key]?.trim().toLowerCase()
  if (value === 'true') return true
  if (value === 'false') return false
  throw new Error(`${key} must be true or false in .env.`)
}

function readInteger(source: Record<string, string>, key: string, minimum: number): number {
  const raw = source[key]?.trim()
  if (!raw) throw new Error(`${key} is missing from .env.`)
  const value = Number(raw)
  if (!Number.isSafeInteger(value) || value < minimum) {
    throw new Error(`${key} must be an integer greater than or equal to ${minimum}.`)
  }
  return value
}

function readDiscordId(source: Record<string, string>, key: string): string {
  const value = source[key]?.trim()
  if (!value) throw new Error(`${key} is missing from .env.`)
  if (!/^[1-9]\d*$/u.test(value)) throw new Error(`${key} must be a Discord id.`)
  return value
}

function readEnum<const T extends readonly string[]>(
  source: Record<string, string>,
  key: string,
  choices: T,
): T[number] {
  const value = source[key]?.trim()
  if (!value) throw new Error(`${key} is missing from .env.`)
  if ((choices as readonly string[]).includes(value)) return value as T[number]
  throw new Error(`${key} must be one of: ${choices.join(', ')}.`)
}
