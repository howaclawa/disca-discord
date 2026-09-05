import { describe, expect, test } from 'bun:test'
import { mkdirSync, rmSync, writeFileSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { excludeGlobalAgentContext } from '../src/extension/context-files.js'

describe('resident instruction context', () => {
  test('removes global AGENTS.md while retaining the home instructions', () => {
    const parent = join(tmpdir(), `disca-context-${crypto.randomUUID()}`)
    const home = join(parent, 'home')
    const globalDir = join(parent, 'global')
    const globalFile = { path: join(globalDir, 'AGENTS.MD'), content: 'GLOBAL RULES' }
    const homeFile = { path: join(home, 'AGENTS.md'), content: 'HOME RULES' }
    mkdirSync(globalDir, { recursive: true })
    mkdirSync(home, { recursive: true })
    writeFileSync(globalFile.path, globalFile.content)
    writeFileSync(homeFile.path, homeFile.content)

    try {
      const prompt = `before\n${projectContext([globalFile, homeFile])}\nafter`
      const filtered = excludeGlobalAgentContext(
        prompt,
        { cwd: home, contextFiles: [globalFile, homeFile] },
        globalDir,
      )
      expect(filtered).toContain('HOME RULES')
      expect(filtered).not.toContain('GLOBAL RULES')
      expect(filtered).toStartWith('before\n<project_context>')
      expect(filtered).toEndWith('</project_context>\nafter')
    } finally {
      rmSync(parent, { recursive: true, force: true })
    }
  })

  test('fails closed when leaked global instructions cannot be isolated', () => {
    const globalFile = { path: '/tmp/global/AGENTS.md', content: 'GLOBAL RULES' }
    expect(() =>
      excludeGlobalAgentContext(
        `prompt with ${globalFile.content}`,
        { cwd: '/tmp/home', contextFiles: [globalFile] },
        '/tmp/global',
      ),
    ).toThrow('could not exclude global agent context')
  })
})

function projectContext(files: Array<{ path: string; content: string }>): string {
  return [
    '<project_context>',
    '',
    'Project-specific instructions and guidelines:',
    '',
    ...files.map(
      (file) =>
        `<project_instructions path="${file.path}">\n${file.content}\n</project_instructions>\n`,
    ),
    '</project_context>',
  ].join('\n')
}
