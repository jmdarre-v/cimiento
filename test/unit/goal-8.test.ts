// Goal 8: close the Goal 7 limits. Each BUG test here was run red on the code before its fix
// (docs/FIELD-TEST-8.md lists the commits).

import { readFileSync, writeFileSync } from 'node:fs'
import { join } from 'node:path'
import { afterEach, beforeEach, describe, expect, it } from 'vitest'
import { run } from '../../src/cli/index'
import { ExitCode } from '../../src/core/errors'
import { clearToolUpdateCache } from '../../src/core/toolkit'
import { FakeCloud } from './fake-cloud'
import { CaptureWriter, personDoesIt, removeDir, tempDir, useFakeTokens } from './helpers'

let root = ''
let dir = ''
let configDir = ''

beforeEach(() => {
  useFakeTokens()
  clearToolUpdateCache()
  root = tempDir('cimiento-goal8-')
  dir = join(root, 'my-app')
  configDir = tempDir('cimiento-config-')
  process.env.CIMIENTO_CONFIG_DIR = configDir
})

afterEach(() => {
  removeDir(root)
  removeDir(configDir)
  delete process.env.CIMIENTO_CONFIG_DIR
  delete process.env.CIMIENTO_DETECT_CACHE
})

async function cli(cloud: FakeCloud, args: string[], cwd = dir): Promise<{ code: number; writer: CaptureWriter }> {
  const writer = new CaptureWriter()
  const code = await run(args, { io: cloud, cwd, writer, interactive: false, onManual: personDoesIt })
  return { code, writer }
}

async function made(cloud: FakeCloud, args: string[]): Promise<void> {
  const result = await cli(cloud, ['new', 'my-app', ...args, '--json', '--yes', '--dir', dir], root)
  expect(result.code, result.writer.outText.slice(-800)).toBe(ExitCode.ok)
}

const VERCEL_NEON = ['--repo', 'github', '--hosting', 'vercel', '--database', 'neon', '--template', 'nextjs-app']

describe('BUG-93: a noop up asks each tool and each login once, not once per phase', () => {
  it('up --json runs every version command and every identity command once', async () => {
    const cloud = new FakeCloud({ ghDeleteScope: true })
    await made(cloud, VERCEL_NEON)
    const before = cloud.execCalls.length
    const up = await cli(cloud, ['up', '--json', '--yes'])
    expect(up.code, up.writer.outText.slice(-800)).toBe(ExitCode.ok)
    const calls = cloud.execCalls.slice(before)
    const count = (prefix: string) => calls.filter((c) => c.startsWith(prefix)).length
    for (const prefix of ['gh --version', 'git --version', 'vercel --version', 'neonctl --version', 'gh auth status', 'vercel whoami', 'neonctl me']) {
      expect(count(prefix), prefix).toBeLessThanOrEqual(1)
    }
  })

  it('a second up within the TTL reuses the machine cache, and an auth error clears it', async () => {
    process.env.CIMIENTO_DETECT_CACHE = 'on'
    const cloud = new FakeCloud({ ghDeleteScope: true })
    await made(cloud, VERCEL_NEON)
    await cli(cloud, ['up', '--json', '--yes'])
    const before = cloud.execCalls.length
    const again = await cli(cloud, ['up', '--json', '--yes'])
    expect(again.code).toBe(ExitCode.ok)
    const calls = cloud.execCalls.slice(before)
    expect(calls.filter((c) => c.startsWith('vercel whoami') || c.startsWith('vercel --version')).length).toBe(0)

    // A 401 from Vercel means the cached identity may be stale: the next run asks again.
    cloud.httpFaults.push({ method: 'GET', match: /api\.vercel\.com\/v9\/projects\//, status: 401 })
    await cli(cloud, ['up', '--json', '--yes'])
    cloud.httpFaults.length = 0
    const after = cloud.execCalls.length
    await cli(cloud, ['up', '--json', '--yes'])
    expect(cloud.execCalls.slice(after).some((c) => c.startsWith('vercel whoami'))).toBe(true)
  })
})
