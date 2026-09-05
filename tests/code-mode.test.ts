import { describe, expect, test } from 'bun:test'
import { mkdtempSync, rmSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import type { ExtensionAPI, ExtensionContext } from '@earendil-works/pi-coding-agent'
import { createDiscaCodeModeTools } from '../src/extension/code-mode.js'
import { registerControlTools } from '../src/extension/control-tools.js'
import { registerPerceiveTool } from '../src/extension/perceive-tool.js'
import { registerDiscordTool } from '../src/extension/tool.js'
import { registerRememberTool } from '../src/memory.js'
import { registerRecallTool } from '../src/recall.js'

describe('Code Mode bridge', () => {
  test('surfaces structured details, not the wrapper, to notebook composition', async () => {
    const project = mkdtempSync(join(tmpdir(), 'disca-code-mode-'))
    const pi = {
      registerCommand() {},
      registerTool() {},
    } as unknown as ExtensionAPI
    const codeModeTools = createDiscaCodeModeTools({
      control: registerControlTools(pi, () => undefined).tool,
      discord: registerDiscordTool(pi, () => undefined),
      recall: registerRecallTool(pi),
      remember: registerRememberTool(pi),
      perceive: registerPerceiveTool(pi),
    })
    const remember = codeModeTools.find((tool) => tool.name === 'remember')
    if (!remember) throw new Error('remember was not projected')
    const context = {
      cwd: project,
      extensionContext: { cwd: project } as ExtensionContext,
    }
    try {
      const result = await remember.invoke(
        { text: 'Code Mode remembers this.' },
        context,
        new AbortController().signal,
      )
      expect(result).toMatchObject({ action: 'created', id: 1 })
    } finally {
      rmSync(project, { force: true, recursive: true })
    }
  })
})
