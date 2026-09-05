import type { ExtensionAPI } from '@earendil-works/pi-coding-agent'
import {
  adaptToolForCodeMode,
  registerCodeModeExtensionTools,
} from '@howaboua/pi-codex-conversion/code-mode'
import type { registerRememberTool } from '../memory.js'
import type { registerRecallTool } from '../recall.js'
import type { registerControlTools } from './control-tools.js'
import type { registerPerceiveTool } from './perceive-tool.js'
import type { registerDiscordTool } from './tool.js'

interface DiscaCodeModeToolSet {
  control: ReturnType<typeof registerControlTools>['tool']
  discord: ReturnType<typeof registerDiscordTool>
  perceive: ReturnType<typeof registerPerceiveTool>
  recall: ReturnType<typeof registerRecallTool>
  remember: ReturnType<typeof registerRememberTool>
}

export function createDiscaCodeModeTools(tools: DiscaCodeModeToolSet) {
  return [
    adaptToolForCodeMode(tools.discord, {
      usage:
        'await tools.discord_send({ channel?: "dm" | "#name" | "current", replyTo?: "mN", message?: string, title?: string, card?: boolean, files?: { path: string, description?: string, spoiler?: boolean }[], buttons?: { label: string, prompt?: string, style?: "primary" | "secondary" | "success" | "danger", url?: string, modal?: { title: string, label: string, prompt?: string, placeholder?: string, required?: boolean } }[], select?: { placeholder: string, options: { label: string, prompt?: string, description?: string }[], minValues?: number, maxValues?: number }, poll?: { question: string, answers: string[], durationHours?: number, allowMultiselect?: boolean }, reaction?: { to: "mN", emoji: string } }) // rich delivery or DM; interaction prompt fields become Pi input; ordinary room replies use marked final text',
      promptMetadata: false,
      resultValue: (result) => result.details,
    }),
    adaptToolForCodeMode(tools.control, {
      usage: 'await tools.disca_control({ action: "reload" | "disconnect" | "restart" })',
      promptMetadata: false,
      resultValue: (result) => result.details,
    }),
    adaptToolForCodeMode(tools.recall, {
      usage:
        'await tools.recall({ query?: string, source?: "all" | "memory" | "discord", tags?: string[], speaker?: string, channel?: string, discordRole?: "user" | "assistant" | "reaction", around?: number, limit?: number }) // tags are memory-only; around expands a returned Discord #row',
      promptMetadata: false,
      resultValue: (result) => result.details,
    }),
    adaptToolForCodeMode(tools.remember, {
      usage:
        'await tools.remember({ text: string, id?: number, tags?: string[] }) // empty text deletes id',
      promptMetadata: false,
      resultValue: (result) => result.details,
    }),
    adaptToolForCodeMode(tools.perceive, {
      usage:
        'await tools.disca_perceive({ path: string, question?: string, model?: string }) // other ears and eyes for audio and video; returns first-person notes plus a tuning memo',
      promptMetadata: false,
      resultValue: (result) => result.details,
    }),
  ]
}

export function registerDiscaCodeModeTools(pi: ExtensionAPI, tools: DiscaCodeModeToolSet): void {
  const registration = registerCodeModeExtensionTools(pi, () => createDiscaCodeModeTools(tools))
  pi.on('session_shutdown', () => registration.unregister())
}
