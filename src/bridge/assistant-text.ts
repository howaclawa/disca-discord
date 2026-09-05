import type { AgentMessage } from '@earendil-works/pi-agent-core'

function isTextBlock(value: unknown): value is { type: 'text'; text: string } {
  return (
    typeof value === 'object' &&
    value !== null &&
    Reflect.get(value, 'type') === 'text' &&
    typeof Reflect.get(value, 'text') === 'string'
  )
}

export function extractAssistantText(message: AgentMessage): string {
  if (message.role !== 'assistant' || !Array.isArray(message.content)) return ''
  return message.content
    .filter(isTextBlock)
    .map((block) => block.text)
    .join('')
    .trim()
}

export function extractAssistantError(message: AgentMessage): string | undefined {
  if (message.role !== 'assistant') return undefined
  return message.errorMessage?.trim() || undefined
}
