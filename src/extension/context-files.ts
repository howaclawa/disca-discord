import { existsSync, realpathSync } from 'node:fs'
import { homedir } from 'node:os'
import { basename, dirname, isAbsolute, resolve } from 'node:path'
import type { BuildSystemPromptOptions } from '@earendil-works/pi-coding-agent'

type ContextFile = NonNullable<BuildSystemPromptOptions['contextFiles']>[number]
type ContextOptions = Pick<BuildSystemPromptOptions, 'contextFiles' | 'cwd'>

const GLOBAL_AGENT_DIR = resolve(homedir(), '.pi', 'agent')
const CLOSING_PROJECT_CONTEXT = '</project_context>'

export function excludeGlobalAgentContext(
  systemPrompt: string,
  options: ContextOptions,
  globalAgentDir = GLOBAL_AGENT_DIR,
): string {
  const originalFiles = options.contextFiles ?? []
  const localFiles = originalFiles.filter(
    (file) => !isGlobalAgentFile(file, options.cwd, globalAgentDir),
  )
  if (localFiles.length === originalFiles.length) return systemPrompt
  return replaceProjectContext(systemPrompt, originalFiles, localFiles)
}

function isGlobalAgentFile(file: ContextFile, cwd: string, globalAgentDir: string): boolean {
  if (basename(file.path).toLowerCase() !== 'agents.md') return false
  const lexicalDirectory = dirname(
    resolve(isAbsolute(file.path) ? file.path : resolve(cwd, file.path)),
  )
  const lexicalGlobalDirectory = resolve(globalAgentDir)
  if (lexicalDirectory === lexicalGlobalDirectory) return true

  const canonicalDirectory = realpathExisting(lexicalDirectory)
  const canonicalGlobalDirectory = realpathExisting(globalAgentDir)
  return Boolean(
    canonicalDirectory &&
      canonicalGlobalDirectory &&
      canonicalDirectory === canonicalGlobalDirectory,
  )
}

function replaceProjectContext(
  systemPrompt: string,
  originalFiles: ContextFile[],
  localFiles: ContextFile[],
): string {
  const positions = originalFiles
    .map((file) => systemPrompt.indexOf(`<project_instructions path="${file.path}">`))
    .filter((position) => position >= 0)
  const firstInstruction = positions.length > 0 ? Math.min(...positions) : -1
  const start =
    firstInstruction >= 0
      ? systemPrompt.lastIndexOf('<project_context>', firstInstruction)
      : systemPrompt.lastIndexOf('<project_context>')
  const end = systemPrompt.indexOf(CLOSING_PROJECT_CONTEXT, Math.max(0, start))

  if (start < 0 || end < start) {
    const leaked = originalFiles.find(
      (file) => !localFiles.includes(file) && systemPrompt.includes(file.content),
    )
    if (leaked) throw new Error(`Disca could not exclude global agent context: ${leaked.path}`)
    return systemPrompt
  }

  return `${systemPrompt.slice(0, start)}${buildProjectContext(localFiles)}${systemPrompt.slice(end + CLOSING_PROJECT_CONTEXT.length)}`
}

function buildProjectContext(files: ContextFile[]): string {
  if (files.length === 0) return ''
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

function realpathExisting(path: string): string | undefined {
  if (!existsSync(path)) return
  try {
    return realpathSync.native?.(path) ?? realpathSync(path)
  } catch {
    return
  }
}
