import type { ExtensionAPI, ExtensionContext } from '@earendil-works/pi-coding-agent'
import { DiscordActivityMonitor } from './src/extension/activity-monitor.js'
import { registerDiscaCodeModeTools } from './src/extension/code-mode.js'
import { excludeGlobalAgentContext } from './src/extension/context-files.js'
import {
  consumeReloadWake,
  RELOAD_WAKE_MESSAGE,
  registerControlTools,
} from './src/extension/control-tools.js'
import { registerPerceiveTool } from './src/extension/perceive-tool.js'
import { registerDiscordMessageRenderer } from './src/extension/renderer.js'
import { runDiscordSetup } from './src/extension/setup.js'
import { registerDiscordTool } from './src/extension/tool.js'
import { registerRememberTool } from './src/memory.js'
import { registerRecallTool } from './src/recall.js'
import { DiscaSession } from './src/session.js'

export default function disca(pi: ExtensionAPI): void {
  const monitor = new DiscordActivityMonitor()
  let session: DiscaSession | undefined

  const startSession = async (context: ExtensionContext): Promise<void> => {
    const next = new DiscaSession(pi, context, monitor)
    await session?.stop()
    session = next
    await session.start()
  }

  registerDiscordMessageRenderer(pi)
  const discordTool = registerDiscordTool(pi, () => session)
  const perceiveTool = registerPerceiveTool(pi)
  const rememberTool = registerRememberTool(pi)
  const recallTool = registerRecallTool(pi)
  const controls = registerControlTools(pi, () => session)
  registerDiscaCodeModeTools(pi, {
    control: controls.tool,
    discord: discordTool,
    perceive: perceiveTool,
    recall: recallTool,
    remember: rememberTool,
  })

  pi.registerCommand('discord', {
    description: 'Open Disca connection setup',
    handler: async (_args, context) => {
      if (!session) await startSession(context)
      const current = session
      if (!current) return
      await runDiscordSetup(context, {
        config: current.config,
        chatEnabled: current.chatEnabled,
        describeStatus: () => session?.describeStatus() ?? 'Disca stopped',
        guide: () => {
          pi.sendUserMessage(
            'Guide me through creating and connecting the Discord bot for this live Disca environment. Walk me through the Discord Developer Portal one action at a time, including Message Content Intent, copying the bot token into /discord, and inviting the bot with View Channels, Send Messages, Read Message History, and Attach Files. Do not send me to a setup document.',
          )
        },
        setChatEnabled: (enabled) => current.setChatEnabled(enabled),
        restart: async () => await startSession(context),
        stop: async () => {
          await session?.stop()
          session = undefined
        },
      })
    },
  })

  pi.registerCommand('discord-chat', {
    description: 'Toggle Discord turns while activity monitoring stays on',
    handler: async (_args, context) => {
      if (!session) await startSession(context)
      session?.toggleChat()
    },
  })

  pi.on('session_start', async (_event, context) => {
    monitor.attach(context)
    await startSession(context)
    if (consumeReloadWake(context.cwd)) {
      pi.sendUserMessage(RELOAD_WAKE_MESSAGE, { deliverAs: 'followUp' })
    }
  })

  pi.on('before_agent_start', (event, context) => {
    const localSystemPrompt = excludeGlobalAgentContext(
      event.systemPrompt,
      event.systemPromptOptions,
    )
    const prompt = session?.getDiscordSystemPrompt(context)
    const systemPrompt = prompt ? `${localSystemPrompt}\n\n${prompt}` : localSystemPrompt
    return systemPrompt === event.systemPrompt ? undefined : { systemPrompt }
  })

  pi.on('message_end', (event, context) => {
    session?.useContext(context)
    session?.capture(event.message)
  })

  pi.on('agent_settled', async (_event, context) => {
    const current = session
    await current?.settle(context)
    if (current && session === current && current.hasConfigChanged()) await startSession(context)
    controls.afterAgentSettled()
  })

  pi.on('ui_prompt_start', (_event, context) => {
    session?.setUiBlocked(true, context)
  })

  pi.on('ui_prompt_end', (_event, context) => {
    session?.setUiBlocked(false, context)
  })

  pi.on('session_shutdown', async () => {
    await session?.stop()
    session = undefined
    monitor.dispose()
  })
}
