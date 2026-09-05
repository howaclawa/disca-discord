import { existsSync, mkdirSync, unlinkSync, writeFileSync } from 'node:fs'
import { dirname, resolve } from 'node:path'
import { StringEnum } from '@earendil-works/pi-ai'
import { defineTool, type ExtensionAPI } from '@earendil-works/pi-coding-agent'
import { Type } from 'typebox'

const RELOAD_COMMAND = 'reload-extensions'
const RELOAD_WAKE_FILE = 'reload-wake'
const discaControlSchema = Type.Object(
  {
    action: StringEnum(['reload', 'disconnect', 'restart'] as const),
  },
  { additionalProperties: false },
)

type DiscaControlAction = 'disconnect' | 'reload' | 'restart'

interface DiscaControlDetails {
  action: DiscaControlAction
  state: 'connected' | 'disconnected' | 'scheduled'
}

export const RELOAD_WAKE_MESSAGE = 'There you are.'

export interface DiscaControlTarget {
  disconnectDiscord(): Promise<void>
  restartDiscord(): Promise<void>
}

export function registerControlTools(
  pi: ExtensionAPI,
  getTarget: () => DiscaControlTarget | undefined,
) {
  let reloadPending = false

  pi.registerCommand(RELOAD_COMMAND, {
    description: 'Reload Pi extensions and project resources, then resume this session',
    handler: async (_args, context) => {
      armReloadWake(context.cwd)
      await context.reload()
      return
    },
  })

  const tool = defineTool<typeof discaControlSchema, DiscaControlDetails>({
    name: 'disca_control',
    label: 'Disca Control',
    description: 'Reload extensions or disconnect/restart Discord.',
    parameters: discaControlSchema,
    async execute(_toolCallId, input) {
      if (input.action === 'reload') {
        reloadPending = true
        return {
          content: [
            {
              type: 'text' as const,
              text: 'Extension reload scheduled for the end of this response.',
            },
          ],
          details: { action: input.action, state: 'scheduled' },
        }
      }

      const target = getTarget()
      if (!target) {
        if (input.action === 'restart')
          throw new Error('Discord is not running in this Pi session.')
        return {
          content: [{ type: 'text' as const, text: 'Discord is already disconnected.' }],
          details: { action: input.action, state: 'disconnected' },
        }
      }

      if (input.action === 'restart') {
        await target.restartDiscord()
        return {
          content: [{ type: 'text' as const, text: 'Discord gateway restarted.' }],
          details: { action: input.action, state: 'connected' },
        }
      }

      await target.disconnectDiscord()
      return {
        content: [{ type: 'text' as const, text: 'Discord gateway disconnected.' }],
        details: { action: input.action, state: 'disconnected' },
      }
    },
  })
  pi.registerTool(tool)

  return {
    tool,
    afterAgentSettled() {
      if (!reloadPending) return
      reloadPending = false
      setTimeout(() => {
        pi.sendUserMessage(`/${RELOAD_COMMAND}`, { expandPromptTemplates: true })
      }, 0)
    },
  }
}

export function armReloadWake(projectRoot: string): void {
  const path = reloadWakePath(projectRoot)
  mkdirSync(dirname(path), { recursive: true })
  writeFileSync(path, 'pending\n', 'utf8')
}

export function consumeReloadWake(projectRoot: string): boolean {
  const path = reloadWakePath(projectRoot)
  if (!existsSync(path)) return false
  unlinkSync(path)
  return true
}

function reloadWakePath(projectRoot: string): string {
  return resolve(projectRoot, '.pi', 'disca', RELOAD_WAKE_FILE)
}
