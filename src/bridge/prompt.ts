import type { DiscordInboundTurn } from './contracts.js'
import { buildDiscordRoutes, type DiscordRouteRegistry, type DiscordRoutes } from './routes.js'

export function buildDiscordTurnPrompt(turn: DiscordInboundTurn, routes: DiscordRoutes): string {
  const replyHandle = routes.messageHandlesById.get(turn.replyToMessageId)
  const lines = [`Discord · ${turn.channelLabel}`, `From ${turn.senderName} at ${turn.receivedAt}`]

  if (turn.context.length > 0) {
    lines.push('', 'Recent context:')
    for (const item of turn.context) {
      const handle = routes.messageHandlesById.get(item.messageId)
      lines.push(`${handle ? `[${handle}] ` : ''}${item.senderName}: ${item.body}`)
    }
  }

  lines.push(
    '',
    `${replyHandle ? `[${replyHandle}] ` : ''}${turn.senderName}:`,
    turn.body || '[No text]',
  )
  if (turn.attachments.length > 0) {
    lines.push('', 'Attachments:')
    for (const [index, attachment] of turn.attachments.entries()) {
      lines.push(
        `[a${index + 1}] ${attachment.name} · ${attachment.contentType || 'file'} · ${formatBytes(attachment.size)}`,
        `path: ${attachment.localPath}`,
      )
    }
  }

  return lines.join('\n')
}

export function buildDiscordBatchPrompt(
  turns: readonly DiscordInboundTurn[],
  routes: DiscordRoutes,
): string {
  const first = turns[0]
  if (!first) throw new Error('Discord batch needs at least one turn.')
  const lines = ['Discord · ' + first.channelLabel + ' · ' + turns.length + ' messages']
  let attachmentIndex = 0
  for (const turn of turns) {
    const handle = routes.messageHandlesById.get(turn.replyToMessageId)
    lines.push(
      '',
      (handle ? '[' + handle + '] ' : '') + turn.senderName + ':',
      turn.body || '[No text]',
    )
    for (const attachment of turn.attachments) {
      attachmentIndex += 1
      lines.push(
        '[a' +
          attachmentIndex +
          '] ' +
          attachment.name +
          ' · ' +
          (attachment.contentType || 'file') +
          ' · ' +
          formatBytes(attachment.size),
        'path: ' + attachment.localPath,
      )
    }
  }
  return lines.join('\n')
}

export function buildDiscordSystemPrompt(
  turns: readonly DiscordInboundTurn[],
  registry?: DiscordRouteRegistry,
): string {
  const routes = buildDiscordRoutes(turns, registry)
  const hasAttachments = turns.some((turn) => turn.attachments.length > 0)
  const ambient = turns.every((turn) => turn.cause === 'ambient')
  return [
    ...(ambient
      ? [
          'You have looked in on ordinary room life.',
          'Follow what has energy: join in, reply to someone, investigate a curiosity, tend memory or the vault, or return to quiet.',
          'Staying quiet needs no explanation.',
        ]
      : ['This turn is already yours. Respond to the current message on its substance.']),
    'Discord delivery uses explicit ordered blocks.',
    'Use a shown numbered handle such as `[m1] content` to reply to that exact message.',
    'Use `[c] content` to post in the current channel without attaching to a message.',
    'You may emit several blocks. They are delivered from first to last.',
    'Marked blocks are delivered; all other assistant text stays in Pi.',
    `Messages: ${routes.messages.map((route) => route.handle).join(', ') || 'none'}`,
    `Current channel: ${routes.channel?.channelLabel ?? 'none'}`,
    ...(ambient ? [] : ['Use recent context to understand the current message.']),
    ...(hasAttachments
      ? [
          'Cached attachment paths are local files. Inspect them with normal Pi tools when their contents matter.',
        ]
      : []),
    'Use marked text for ordinary room replies and discord_send for files, reactions, cards, buttons, selects, polls, or other rich delivery.',
    'discord_send.replyTo and discord_send.reaction.to accept a shown numbered message handle.',
  ].join('\n')
}

function formatBytes(bytes: number): string {
  if (bytes < 1024) return `${bytes} B`
  if (bytes < 1024 * 1024) return `${Math.round(bytes / 1024)} KB`
  return `${(bytes / (1024 * 1024)).toFixed(1)} MB`
}
