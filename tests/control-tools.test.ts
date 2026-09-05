import { describe, expect, test } from 'bun:test'
import { mkdtempSync, rmSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import type { ExtensionAPI } from '@earendil-works/pi-coding-agent'
import {
  armReloadWake,
  consumeReloadWake,
  registerControlTools,
} from '../src/extension/control-tools.js'

interface CapturedTool {
  name: string
  execute(
    toolCallId: string,
    input: { action: 'disconnect' | 'reload' | 'restart' },
  ): Promise<unknown>
}

describe('Disca runtime control', () => {
  test('wakes the replacement runtime exactly once', () => {
    const project = mkdtempSync(join(tmpdir(), 'disca-reload-'))
    try {
      expect(consumeReloadWake(project)).toBe(false)
      armReloadWake(project)
      expect(consumeReloadWake(project)).toBe(true)
      expect(consumeReloadWake(project)).toBe(false)
    } finally {
      rmSync(project, { force: true, recursive: true })
    }
  })

  test('waits until the agent settles before starting the reload', async () => {
    const sent: Array<{ content: string; options: unknown }> = []
    const registeredTools = new Map<string, CapturedTool>()
    const pi = {
      registerCommand() {},
      registerTool(tool: CapturedTool) {
        registeredTools.set(tool.name, tool)
      },
      sendUserMessage(content: string, options: unknown) {
        sent.push({ content, options })
      },
    } as unknown as ExtensionAPI
    const controls = registerControlTools(pi, () => undefined)
    const controlTool = registeredTools.get('disca_control')
    if (!controlTool) throw new Error('disca_control was not registered')

    await controlTool.execute('reload-call', { action: 'reload' })
    expect(sent).toEqual([])

    controls.afterAgentSettled()
    await Bun.sleep(10)
    expect(sent).toEqual([
      { content: '/reload-extensions', options: { expandPromptTemplates: true } },
    ])
  })

  test('keeps disconnect idempotent but fails an unavailable restart', async () => {
    const registeredTools = new Map<string, CapturedTool>()
    const pi = {
      registerCommand() {},
      registerTool(tool: CapturedTool) {
        registeredTools.set(tool.name, tool)
      },
    } as unknown as ExtensionAPI
    registerControlTools(pi, () => undefined)
    const controlTool = registeredTools.get('disca_control')
    if (!controlTool) throw new Error('disca_control was not registered')

    await expect(controlTool.execute('disconnect-call', { action: 'disconnect' })).resolves.toEqual(
      expect.objectContaining({
        details: { action: 'disconnect', state: 'disconnected' },
      }),
    )
    await expect(controlTool.execute('restart-call', { action: 'restart' })).rejects.toThrow(
      'Discord is not running in this Pi session.',
    )
  })
})
