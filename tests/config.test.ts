import { describe, expect, test } from 'bun:test'
import { mkdtempSync, rmSync, writeFileSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { loadConfig } from '../src/config.js'

const CONFIG = `DISCORD_BOT_TOKEN=live-token
CHANNEL_POLICY=channels
TRIGGER_ALIASES=howa,clawa
DISCORD_STATUS_TEXT=the live room
DISCORD_STATUS_TYPE=Listening
ALLOWED_CHANNEL_IDS=1,2
EXCLUDED_CHANNEL_IDS=3
ALLOWED_USER_IDS=4
DEFAULT_DM_USER_ID=5
DISCORD_CHAT_ENABLED=false
AMBIENT_WAKE_MIN_MESSAGES=5
AMBIENT_WAKE_MAX_MESSAGES=20
DISCORD_ACTIVITY_LINES=5
RECENT_CONTEXT_MESSAGES=6
MAX_QUEUE=30
MAX_ATTACHMENT_BYTES=8
MAX_TOTAL_ATTACHMENT_BYTES=9
ATTACHMENT_RETENTION_DAYS=10
`

describe('live environment config', () => {
  test('loads mutable bot behavior from the tracked env file', () => {
    withProject(CONFIG, (project) => {
      const config = loadConfig(project)
      expect(config.token).toBe('live-token')
      expect(config.channelPolicy).toBe('channels')
      expect(config.triggerAliases).toEqual(['howa', 'clawa'])
      expect(config.discordStatusText).toBe('the live room')
      expect(config.discordStatusType).toBe('Listening')
      expect([...config.allowedChannelIds]).toEqual(['1', '2'])
      expect(config.defaultDmUserId).toBe('5')
      expect(config.discordChatEnabled).toBe(false)
      expect(config.ambientWakeMinMessages).toBe(5)
      expect(config.ambientWakeMaxMessages).toBe(20)
      expect(config.discordActivityLines).toBe(5)
      expect(config.maxQueue).toBe(30)
    })
  })

  test('rejects a missing essential setting instead of falling back to code', () => {
    withProject(CONFIG.replace('MAX_QUEUE=30\n', ''), (project) => {
      expect(() => loadConfig(project)).toThrow('MAX_QUEUE is missing from .env')
    })
  })

  test('keeps the tracked env file authoritative over the shell environment', () => {
    const previous = process.env['MAX_QUEUE']
    process.env['MAX_QUEUE'] = '999'
    try {
      withProject(CONFIG, (project) => {
        expect(loadConfig(project).maxQueue).toBe(30)
      })
    } finally {
      if (previous === undefined) delete process.env['MAX_QUEUE']
      else process.env['MAX_QUEUE'] = previous
    }
  })

  test('keeps the ambient wake range ordered and within queue capacity', () => {
    withProject(
      CONFIG.replace('AMBIENT_WAKE_MIN_MESSAGES=5', 'AMBIENT_WAKE_MIN_MESSAGES=21'),
      (project) => {
        expect(() => loadConfig(project)).toThrow(
          'AMBIENT_WAKE_MAX_MESSAGES must be at least AMBIENT_WAKE_MIN_MESSAGES',
        )
      },
    )
    withProject(CONFIG.replace('MAX_QUEUE=30', 'MAX_QUEUE=19'), (project) => {
      expect(() => loadConfig(project)).toThrow('AMBIENT_WAKE_MAX_MESSAGES cannot exceed MAX_QUEUE')
    })
  })
})

function withProject(config: string, run: (project: string) => void): void {
  const project = mkdtempSync(join(tmpdir(), 'disca-config-'))
  try {
    writeFileSync(join(project, '.env'), config, 'utf8')
    run(project)
  } finally {
    rmSync(project, { force: true, recursive: true })
  }
}
