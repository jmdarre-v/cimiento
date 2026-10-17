// Run logs, spec section 7: every command writes ~/.cimiento/runs/<UTC timestamp>-<command>.jsonl
// with events, lines shown, prompts and answers, every line with a UTC timestamp, and never a
// secret value. Tests point CIMIENTO_RUNS_DIR at a temporary folder.

import { readdirSync, readFileSync } from 'node:fs'
import { join } from 'node:path'
import { afterEach, beforeEach, describe, expect, it } from 'vitest'
import { run } from '../../src/cli/index'
import { t } from '../../src/cli/i18n'
import { MemoryLogger } from '../../src/core/logger'
import { clearToolUpdateCache } from '../../src/core/toolkit'
import { clearCloudflareToken } from '../../src/providers/turnstile/api'
import { FakeCloud } from './fake-cloud'
import { CaptureWriter, personDoesIt, removeDir, tempDir, useFakeTokens } from './helpers'

const KEYCHAIN_ANTHROPIC = 'fake-anthropic-api-key-not-a-real-credential'
const ROTATED = 'fake-rotated-key-for-the-run-log-not-a-real-credential'
const ISO = /^\d{4}-\d{2}-\d{2}T\d{2}:\d{2}:\d{2}\.\d{3}Z$/

let root: string
let configDir: string
let runs: string

beforeEach(() => {
  useFakeTokens()
  clearCloudflareToken()
  clearToolUpdateCache()
  root = tempDir('cimiento-runlog-')
  configDir = tempDir('cimiento-config-')
  runs = tempDir('cimiento-runs-')
  process.env.CIMIENTO_CONFIG_DIR = configDir
  process.env.CIMIENTO_RUNS_DIR = runs
})

afterEach(() => {
  removeDir(root)
  removeDir(configDir)
  removeDir(runs)
  delete process.env.CIMIENTO_CONFIG_DIR
})

function logs(command: string): { name: string; lines: Record<string, unknown>[]; text: string }[] {
  return readdirSync(runs)
    .filter((f) => f.endsWith(`-${command}.jsonl`))
    .sort()
    .map((name) => {
      const text = readFileSync(join(runs, name), 'utf8')
      return { name, text, lines: text.trim().split('\n').map((l) => JSON.parse(l) as Record<string, unknown>) }
    })
}

describe('run logs', () => {
  it('new writes one log named by its UTC start and the command, every line timestamped, with start, events and end', async () => {
    const cloud = new FakeCloud()
    await run(['new', 'my-app', '--preset', 'fullstack', '--json', '--yes', '--allow-billing', '--dir', join(root, 'my-app')], {
      io: cloud,
      cwd: root,
      writer: new CaptureWriter(),
      interactive: false,
      onManual: personDoesIt,
    })
    const [log] = logs('new')
    expect(log.name).toMatch(/^\d{4}-\d{2}-\d{2}T\d{2}-\d{2}-\d{2}-\d{3}Z-new\.jsonl$/)
    for (const line of log.lines) expect(line.ts, JSON.stringify(line).slice(0, 80)).toMatch(ISO)
    expect(log.lines[0]).toMatchObject({ type: 'start', command: 'new' })
    expect(log.lines[log.lines.length - 1]).toMatchObject({ type: 'end', exitCode: 0 })
    expect(log.lines.some((l) => l.type === 'json' && (l.payload as { event?: string }).event === 'ensured')).toBe(true)
  })

  it('never holds a secret value: keychain values, the Turnstile secret, the Inngest keys', async () => {
    const cloud = new FakeCloud()
    await run(['new', 'my-app', '--preset', 'fullstack', '--json', '--yes', '--allow-billing', '--dir', join(root, 'my-app')], {
      io: cloud,
      cwd: root,
      writer: new CaptureWriter(),
      interactive: false,
      onManual: personDoesIt,
    })
    const project = [...cloud.vercelProjects.values()][0]
    const values = (cloud.vercelEnv.get(project.id) ?? []).filter((e) => !e.key.startsWith('NEXT_PUBLIC_')).map((e) => e.value)
    const text = logs('new')[0].text
    for (const secret of [KEYCHAIN_ANTHROPIC, [...cloud.widgets.values()].flat()[0].secret, ...values]) {
      expect(text).not.toContain(secret)
    }
  })

  it('records a hidden prompt with the answer ****, never the value typed', async () => {
    const cloud = new FakeCloud()
    await run(['new', 'my-app', '--preset', 'fullstack', '--json', '--yes', '--allow-billing', '--dir', join(root, 'my-app')], {
      io: cloud,
      cwd: root,
      writer: new CaptureWriter(),
      interactive: false,
      onManual: personDoesIt,
    })
    await run(['secret', 'rotate', 'ANTHROPIC_API_KEY', '--json'], {
      io: cloud,
      cwd: join(root, 'my-app'),
      writer: new CaptureWriter(),
      interactive: true,
      promptHidden: async () => ROTATED,
    })
    const log = logs('secret-rotate')[0]
    expect(log.text).not.toContain(ROTATED)
    expect(log.lines).toContainEqual(expect.objectContaining({ type: 'prompt', kind: 'hidden' }))
    expect(log.lines).toContainEqual(expect.objectContaining({ type: 'answer', kind: 'hidden', answer: '****' }))
  })

  it('records every question shown and the answer given, in order', async () => {
    const cloud = new FakeCloud()
    await run(['new', '--guided', '--lang', 'es', '--preset', 'designer'], {
      io: cloud,
      cwd: root,
      writer: new CaptureWriter(),
      interactive: true,
      ask: async (q, d) => (q === t('es', 'askName') ? 'Mi Sitio' : q === t('es', 'askFolder') ? root : (d ?? 's')),
      choose: async (_q, options) => options[0].value,
    })
    const lines = logs('new')[0].lines
    const name = lines.findIndex((l) => l.type === 'prompt' && l.question === t('es', 'askName'))
    expect(name).toBeGreaterThan(0)
    expect(lines[name + 1]).toMatchObject({ type: 'answer', kind: 'ask', answer: 'Mi Sitio' })
    expect(lines.some((l) => l.type === 'output' && String(l.text).includes('Creado'))).toBe(true)
  })

  it('stamps every log event with a UTC timestamp', () => {
    const logger = new MemoryLogger()
    logger.log({ level: 'info', event: 'pinned', message: 'x' })
    expect(logger.events[0].ts).toMatch(ISO)
  })
})
