import type { ChannelPolicy } from '../config.js'

export function shouldAcceptDiscordMessage(options: {
  isDm: boolean
  channelId: string
  channelPolicy: ChannelPolicy
  allowedChannelIds: ReadonlySet<string>
  excludedChannelIds: ReadonlySet<string>
  mentioned: boolean
  isReplyToBot: boolean
  content: string
  aliasPattern: RegExp | null
}): boolean {
  if (!options.isDm && options.excludedChannelIds.has(options.channelId)) return false
  if (options.isDm) return true
  if (options.allowedChannelIds.size > 0 && !options.allowedChannelIds.has(options.channelId)) {
    return false
  }
  if (options.channelPolicy === 'all') return true
  if (options.channelPolicy === 'channels') {
    return options.allowedChannelIds.has(options.channelId)
  }
  return (
    options.mentioned ||
    options.isReplyToBot ||
    Boolean(options.aliasPattern?.test(options.content))
  )
}

export function buildAliasPattern(aliases: string[]): RegExp | null {
  const escaped = aliases.map((alias) => escapeRegExp(alias.trim())).filter(Boolean)
  if (escaped.length === 0) return null
  return new RegExp(`\\b(?:${escaped.join('|')})\\b`, 'iu')
}

function escapeRegExp(text: string): string {
  return text.replace(/[.*+?^${}()|[\]\\]/gu, '\\$&')
}
