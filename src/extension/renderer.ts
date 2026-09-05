import type { ExtensionAPI } from '@earendil-works/pi-coding-agent'
import { Box, Text } from '@earendil-works/pi-tui'
import { type DiscordInboundDisplay, INBOUND_MESSAGE_TYPE } from '../bridge/contracts.js'

export function registerDiscordMessageRenderer(pi: ExtensionAPI): void {
  pi.registerMessageRenderer<DiscordInboundDisplay>(
    INBOUND_MESSAGE_TYPE,
    (message, { outputPad }, theme) => {
      const details = message.details
      const header = details
        ? theme.fg('accent', `Discord · ${details.channelLabel} · ${details.senderName}`)
        : theme.fg('accent', 'Discord')
      const body = details?.body || message.content
      const route = details
        ? theme.fg(
            'dim',
            details.messageHandle ? `[${details.messageHandle}] reply` : 'no reply target',
          )
        : ''
      const attachments = details?.attachmentCount
        ? theme.fg('dim', `\n${details.attachmentCount} attachment(s) cached locally`)
        : ''
      const box = new Box(outputPad, 1, (text) => theme.bg('customMessageBg', text))
      box.addChild(new Text(`${header}\n${route}\n${body}${attachments}`, 0, 0))
      return box
    },
  )
}
