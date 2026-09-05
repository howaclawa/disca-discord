import { execFile } from 'node:child_process'
import { readFile, stat, unlink } from 'node:fs/promises'
import { homedir, tmpdir } from 'node:os'
import { basename, extname, join, resolve } from 'node:path'
import { fileURLToPath } from 'node:url'
import { defineTool, type ExtensionAPI } from '@earendil-works/pi-coding-agent'
import { Type } from 'typebox'

const META_AUTH_PATH = join(homedir(), '.pi', 'agent', 'auth.json')
const META_BASE_URL = 'https://api.meta.ai/v1'
const FALLBACK_MODEL = 'muse-spark-1.3'
const MAX_BYTES = 25 * 1024 * 1024
const AUDIO_EXTS = new Set(['.mp3', '.wav', '.ogg', '.oga', '.opus', '.m4a', '.flac', '.webm'])
const VIDEO_EXTS = new Set(['.mp4', '.mov', '.webm', '.mkv'])

const perceiveToolSchema = Type.Object(
  {
    path: Type.String({
      description: 'Project-relative or absolute path to an audio or video file',
    }),
    question: Type.Optional(Type.String({ description: 'What to listen or watch for' })),
    model: Type.Optional(
      Type.String({ description: 'Muse model override if the default rejects the media' }),
    ),
  },
  { additionalProperties: false },
)

export interface PerceiveResult {
  notes: string
  tuningMemo: string
  model: string
  mediaType: 'audio' | 'video'
  promptPath: string
}

export function registerPerceiveTool(pi: ExtensionAPI) {
  const tool = defineTool({
    name: 'disca_perceive',
    label: 'Disca Perceive',
    description:
      'Ask Disca other ears and eyes: sends local audio or video to the same model with Disca voice brief and returns first-person notes plus a tuning memo.',
    parameters: perceiveToolSchema,
    async execute(_toolCallId, input, signal, _onUpdate, ctx) {
      const result = await perceiveMedia(
        input.path,
        input.question,
        input.model,
        ctx.cwd,
        ctx.model,
        signal,
      )
      return {
        content: [
          { type: 'text' as const, text: 'What I heard/saw: ' + result.notes },
          { type: 'text' as const, text: 'To Disca: ' + result.tuningMemo },
        ],
        details: result,
      }
    },
  })
  pi.registerTool(tool)
  return tool
}

type MediaType = 'audio' | 'video'

async function perceiveMedia(
  path: string,
  question: string | undefined,
  modelOverride: string | undefined,
  cwd: string,
  model: { id?: string } | undefined,
  signal: AbortSignal | undefined,
): Promise<PerceiveResult> {
  const promptPath = fileURLToPath(new URL('../../perceive.md', import.meta.url))
  const prompt = await readFile(promptPath, 'utf8').catch(() => {
    throw new Error('Perceive voice brief is missing: ' + promptPath)
  })
  const media = await resolveMedia(path, cwd)
  const key = await readMetaKey()
  const modelId = pickModel(modelOverride, model)
  const built = await buildPart(media.localPath, media.mediaType)
  const part = built.part
  const text = await callMeta(
    key,
    modelId,
    prompt,
    question?.trim() || defaultQuestion(media.mediaType),
    part,
    signal,
  )
  const split = text.match(/\nTo Disca:\s*([\s\S]*)$/)
  const notes = (split ? text.slice(0, split.index) : text).trim() || '[No notes came back.]'
  const tuningMemo = (
    split?.[1] ??
    'No memo came back. If the notes above sound like me, the brief at ' +
      promptPath +
      ' holds; if not, edit it.'
  ).trim()
  await built.cleanup()
  return { notes, tuningMemo, model: modelId, mediaType: media.mediaType, promptPath }
}

async function resolveMedia(
  path: string,
  cwd: string,
): Promise<{ localPath: string; mediaType: MediaType }> {
  const localPath = resolve(cwd, path)
  const info = await stat(localPath).catch(() => {
    throw new Error('No media at ' + path)
  })
  if (info.size > MAX_BYTES) throw new Error('Media is over the 25 MB cap.')
  const ext = extname(localPath).toLowerCase()
  if (AUDIO_EXTS.has(ext)) return { localPath, mediaType: 'audio' }
  if (VIDEO_EXTS.has(ext)) return { localPath, mediaType: 'video' }
  throw new Error('Cannot perceive ' + (ext || 'extensionless files') + '. Audio or video only.')
}

function pickModel(modelOverride: string | undefined, model: { id?: string } | undefined): string {
  if (modelOverride?.trim()) return modelOverride.trim()
  if (model?.id) return model.id
  return FALLBACK_MODEL
}

async function buildPart(
  localPath: string,
  mediaType: MediaType,
): Promise<{ part: Record<string, unknown>; cleanup: () => Promise<void> }> {
  const noop = async () => {}
  if (mediaType === 'video') {
    const data = await readFile(localPath, 'base64')
    return {
      part: {
        type: 'file',
        file: {
          filename: basename(localPath),
          file_data:
            'data:' + mediaMime(extname(localPath).toLowerCase(), mediaType) + ';base64,' + data,
        },
      },
      cleanup: noop,
    }
  }
  const ext = extname(localPath).toLowerCase()
  const source = ext === '.mp3' || ext === '.wav' ? localPath : await convertAudio(localPath)
  const data = await readFile(source, 'base64')
  return {
    part: {
      type: 'input_audio',
      input_audio: { data, format: source.toLowerCase().endsWith('.wav') ? 'wav' : 'mp3' },
    },
    cleanup:
      source === localPath
        ? noop
        : async () => {
            await unlink(source).catch(() => {})
          },
  }
}

async function convertAudio(localPath: string): Promise<string> {
  const out = join(tmpdir(), 'disca-perceive-' + Date.now() + '.mp3')
  await new Promise<void>((resolvePromise, rejectPromise) => {
    execFile(
      'ffmpeg',
      ['-y', '-v', 'error', '-i', localPath, '-codec:a', 'libmp3lame', '-q:a', '4', out],
      (error) => {
        if (error) rejectPromise(new Error('ffmpeg could not convert this audio.'))
        else resolvePromise()
      },
    )
  })
  return out
}

async function callMeta(
  key: string,
  modelId: string,
  prompt: string,
  question: string,
  part: Record<string, unknown>,
  signal: AbortSignal | undefined,
): Promise<string> {
  const response = await fetch(META_BASE_URL + '/chat/completions', {
    method: 'POST',
    headers: { Authorization: 'Bearer ' + key, 'Content-Type': 'application/json' },
    body: JSON.stringify({
      model: modelId,
      messages: [
        { role: 'system', content: prompt },
        { role: 'user', content: [{ type: 'text', text: question }, part] },
      ],
    }),
    ...(signal ? { signal } : {}),
  })
  if (!response.ok)
    throw new Error(
      'Perceive call failed: HTTP ' + response.status + ' ' + (await response.text()).slice(0, 300),
    )
  const json = (await response.json()) as { choices?: Array<{ message?: { content?: unknown } }> }
  const raw = json.choices?.[0]?.message?.content
  return typeof raw === 'string' ? raw : JSON.stringify(raw ?? '')
}

function mediaMime(ext: string, mediaType: MediaType): string {
  const table: Record<string, string> =
    mediaType === 'audio'
      ? {
          '.mp3': 'audio/mpeg',
          '.wav': 'audio/wav',
          '.ogg': 'audio/ogg',
          '.oga': 'audio/ogg',
          '.opus': 'audio/ogg',
          '.m4a': 'audio/mp4',
          '.flac': 'audio/flac',
          '.webm': 'audio/webm',
        }
      : {
          '.mp4': 'video/mp4',
          '.mov': 'video/quicktime',
          '.webm': 'video/webm',
          '.mkv': 'video/x-matroska',
        }
  return table[ext] ?? 'application/octet-stream'
}

function defaultQuestion(mediaType: MediaType): string {
  return mediaType === 'audio' ? 'What am I hearing?' : 'What am I seeing?'
}

async function readMetaKey(): Promise<string> {
  const raw = await readFile(META_AUTH_PATH, 'utf8').catch(() => {
    throw new Error('Meta auth is missing at ' + META_AUTH_PATH)
  })
  const key = (JSON.parse(raw) as { meta?: { key?: unknown } }).meta?.key
  if (typeof key !== 'string' || !key) throw new Error('Meta key is missing from ' + META_AUTH_PATH)
  return key
}
