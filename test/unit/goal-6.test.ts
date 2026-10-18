// Goal 6: trustworthy state, teardown and health. Each BUG test here was run red on the code
// before its fix (docs/FIELD-TEST-6.md lists the commits).

import { createServer, type Server } from 'node:http'
import type { AddressInfo } from 'node:net'
import { afterEach, describe, expect, it } from 'vitest'
import { RealIo, setHttpPolicy } from '../../src/core/io'

let server: Server | undefined

afterEach(async () => {
  setHttpPolicy({})
  if (server) await new Promise((resolve) => server!.close(() => resolve(undefined)))
  server = undefined
})

async function serve(handler: (count: number, method: string) => { status: number; body?: string } | 'hang'): Promise<{ url: string; calls: () => number }> {
  let count = 0
  server = createServer((req, res) => {
    count += 1
    const answer = handler(count, req.method ?? 'GET')
    if (answer === 'hang') return
    res.writeHead(answer.status, { 'content-type': 'application/json' })
    res.end(answer.body ?? '{}')
  })
  await new Promise((resolve) => server!.listen(0, '127.0.0.1', () => resolve(undefined)))
  const { port } = server.address() as AddressInfo
  return { url: `http://127.0.0.1:${port}/x`, calls: () => count }
}

describe('BUG-71: every http request has a bounded timeout', () => {
  it('a provider that never answers fails with HTTP_TIMEOUT instead of hanging the command', async () => {
    setHttpPolicy({ timeoutMs: 200, backoffMs: 1 })
    const { url } = await serve(() => 'hang')
    const started = Date.now()
    await expect(new RealIo().http({ method: 'POST', url, body: {} })).rejects.toMatchObject({ code: 'HTTP_TIMEOUT', retryable: true })
    expect(Date.now() - started).toBeLessThan(2000)
  }, 5000)
})

describe('http retries only idempotent reads', () => {
  it('a GET answered 503 then 200 is retried and succeeds', async () => {
    setHttpPolicy({ timeoutMs: 1000, backoffMs: 1 })
    const { url, calls } = await serve((n) => (n === 1 ? { status: 503 } : { status: 200, body: '{"ok":true}' }))
    const res = await new RealIo().http({ method: 'GET', url })
    expect(res.status).toBe(200)
    expect(calls()).toBe(2)
  })

  it('a POST answered 503 is returned as is, never sent twice', async () => {
    setHttpPolicy({ timeoutMs: 1000, backoffMs: 1 })
    const { url, calls } = await serve(() => ({ status: 503 }))
    const res = await new RealIo().http({ method: 'POST', url, body: {} })
    expect(res.status).toBe(503)
    expect(calls()).toBe(1)
  })

  it('a GET that keeps failing gives up after the bounded number of retries', async () => {
    setHttpPolicy({ timeoutMs: 1000, backoffMs: 1, retries: 2 })
    const { url, calls } = await serve(() => ({ status: 503 }))
    const res = await new RealIo().http({ method: 'GET', url })
    expect(res.status).toBe(503)
    expect(calls()).toBe(3)
  })
})

// Commands on the fake cloud, in a temporary folder.
import { existsSync, readFileSync } from 'node:fs'
import { join } from 'node:path'
import { beforeEach } from 'vitest'
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
  root = tempDir('cimiento-goal6-')
  dir = join(root, 'my-app')
  configDir = tempDir('cimiento-config-')
  process.env.CIMIENTO_CONFIG_DIR = configDir
})

afterEach(() => {
  removeDir(root)
  removeDir(configDir)
  delete process.env.CIMIENTO_CONFIG_DIR
})

async function cli(cloud: FakeCloud, args: string[], cwd = dir, writer = new CaptureWriter()): Promise<{ code: number; writer: CaptureWriter }> {
  const code = await run(args, { io: cloud, cwd, writer, interactive: false, onManual: personDoesIt })
  return { code, writer }
}

/** A writer that dies when a given event goes by, as a run killed at that moment would. */
class DyingWriter extends CaptureWriter {
  constructor(private readonly when: (line: string) => boolean) {
    super()
  }
  override out(text: string): void {
    super.out(text)
    if (this.when(text)) throw new Error('simulated kill')
  }
}

function stateOf(folder = dir): { resources: Record<string, { origin?: string; externalId?: string }> } {
  return JSON.parse(readFileSync(join(folder, '.cimiento', 'state.json'), 'utf8'))
}

describe('BUG-72: state is checkpointed after every completed operation', () => {
  it('up killed right after the Vercel project is created still records it as created, so the next up resumes and down deletes it', async () => {
    const cloud = new FakeCloud({ ghDeleteScope: true })
    const dying = new DyingWriter((line) => line.includes('"event":"ensured"') && line.includes('"vercel.project"'))
    const killed = await run(['new', 'my-app', '--preset', 'designer', '--json', '--yes', '--dir', dir], { io: cloud, cwd: root, writer: dying, interactive: false, onManual: personDoesIt })
    expect(killed).not.toBe(ExitCode.ok)
    expect(cloud.vercelProjects.size).toBe(1)
    expect(existsSync(join(dir, '.cimiento', 'state.json'))).toBe(true)
    expect(stateOf().resources['vercel.project']?.origin).toBe('created')

    const resumed = await cli(cloud, ['up', '--json', '--yes'])
    expect(resumed.code, resumed.writer.outText).toBe(ExitCode.ok)
    expect(cloud.vercelProjects.size).toBe(1)
    const down = await cli(cloud, ['down', '--yes', '--json'])
    expect(down.code).toBe(ExitCode.ok)
    expect(cloud.vercelProjects.size).toBe(0)
  })
})

describe('BUG-72: one run per project at a time', () => {
  async function designer(cloud: FakeCloud): Promise<void> {
    const made = await cli(cloud, ['new', 'my-app', '--preset', 'designer', '--json', '--yes', '--dir', dir], root)
    expect(made.code).toBe(ExitCode.ok)
  }

  it('a second run while another live process holds the lock stops with PROJECT_LOCKED and changes nothing', async () => {
    const { lockPath } = await import('../../src/core/lock')
    const { writeFileSync, mkdirSync } = await import('node:fs')
    const { dirname } = await import('node:path')
    const cloud = new FakeCloud()
    await designer(cloud)
    const path = lockPath(dir)
    mkdirSync(dirname(path), { recursive: true })
    // The parent of this test process is alive, like another cimiento running in a second terminal.
    writeFileSync(path, JSON.stringify({ pid: process.ppid, host: (await import('node:os')).hostname(), command: 'up', startedAt: new Date().toISOString() }))
    const calls = cloud.httpCalls.length
    const second = await cli(cloud, ['up', '--json', '--yes'])
    expect(second.code).not.toBe(ExitCode.ok)
    expect(second.writer.outText).toContain('PROJECT_LOCKED')
    expect(cloud.httpCalls.length).toBe(calls)
  })

  it('a lock left by a process that no longer runs is reported as stale and taken over, then released', async () => {
    const { lockPath } = await import('../../src/core/lock')
    const { writeFileSync, mkdirSync } = await import('node:fs')
    const { dirname } = await import('node:path')
    const cloud = new FakeCloud()
    await designer(cloud)
    const path = lockPath(dir)
    mkdirSync(dirname(path), { recursive: true })
    writeFileSync(path, JSON.stringify({ pid: 2147483646, host: (await import('node:os')).hostname(), command: 'up', startedAt: '2026-10-18T00:00:00.000Z' }))
    const next = await cli(cloud, ['up', '--json', '--yes'])
    expect(next.code, next.writer.outText).toBe(ExitCode.ok)
    expect(next.writer.outText).toContain('"event":"stale-lock"')
    expect(existsSync(path)).toBe(false)
  })

  it('the lock and the temporary state file never land in a commit that publish makes', async () => {
    const cloud = new FakeCloud()
    await designer(cloud)
    cloud.gitDirty = true
    await cli(cloud, ['publish', '--message', 'change', '--json'])
    const { lockPath } = await import('../../src/core/lock')
    expect(lockPath(dir).startsWith(dir)).toBe(false)
    const { readdirSync } = await import('node:fs')
    const walk = (folder: string): string[] =>
      readdirSync(folder, { withFileTypes: true }).flatMap((e) => (e.name === '.git' || e.name === 'node_modules' ? [] : e.isDirectory() ? walk(join(folder, e.name)) : [join(folder, e.name)]))
    expect(walk(dir).filter((f) => f.endsWith('.tmp') || f.endsWith('.lock'))).toEqual([])
  })
})

describe('BUG-73: down forgets a resource only when the provider confirms it is gone', () => {
  async function designer(cloud: FakeCloud): Promise<void> {
    const made = await cli(cloud, ['new', 'my-app', '--preset', 'designer', '--json', '--yes', '--dir', dir], root)
    expect(made.code).toBe(ExitCode.ok)
  }

  it('an accepted delete followed by a 503 on the check keeps the record and exits non-zero; the next down confirms and forgets', async () => {
    const cloud = new FakeCloud({ ghDeleteScope: true })
    await designer(cloud)
    cloud.httpFaults.push({ method: 'GET', match: /api\.vercel\.com\/v9\/projects\//, status: 503 })
    const down = await cli(cloud, ['down', '--yes', '--json'])
    expect(down.code).not.toBe(ExitCode.ok)
    expect(stateOf().resources['vercel.project']).toBeDefined()
    cloud.httpFaults.length = 0
    const again = await cli(cloud, ['down', '--yes', '--json'])
    expect(again.code, again.writer.outText).toBe(ExitCode.ok)
    expect(stateOf().resources['vercel.project']).toBeUndefined()
  })

  it('an auth error or a timeout on the check also keeps the record', async () => {
    for (const status of [401, 0]) {
      removeDir(dir)
      const cloud = new FakeCloud({ ghDeleteScope: true })
      await designer(cloud)
      cloud.httpFaults.push({ method: 'GET', match: /api\.vercel\.com\/v9\/projects\//, status })
      const down = await cli(cloud, ['down', '--yes', '--json'])
      expect(down.code, `status ${status}`).not.toBe(ExitCode.ok)
      expect(stateOf().resources['vercel.project'], `status ${status}`).toBeDefined()
    }
  })
})

describe('BUG-74: plan, up and down cover every resource in state, even one stack.yaml no longer selects', () => {
  async function designerSwappedToNetlify(cloud: FakeCloud): Promise<void> {
    const made = await cli(cloud, ['new', 'my-app', '--preset', 'designer', '--json', '--yes', '--dir', dir], root)
    expect(made.code).toBe(ExitCode.ok)
    const { parseDocument } = await import('yaml')
    const { writeFileSync } = await import('node:fs')
    const file = join(dir, 'stack.yaml')
    const doc = parseDocument(readFileSync(file, 'utf8'))
    doc.setIn(['slots', 'hosting'], 'netlify')
    writeFileSync(file, doc.toString(), 'utf8')
  }

  it('after hosting changes from vercel to netlify, plan lists the old Vercel project as an orphan', async () => {
    const cloud = new FakeCloud({ ghDeleteScope: true })
    await designerSwappedToNetlify(cloud)
    const plan = await cli(cloud, ['plan', '--json'])
    const items = (plan.writer.jsonObjects().pop() as { items: { id: string; status: string }[] }).items
    expect(items.find((i) => i.id === 'vercel.project')?.status).toBe('orphan')
    expect(items.find((i) => i.id === 'vercel.deployment')?.status).toBe('orphan')
  })

  it('down deletes the old Vercel project too, and confirms it gone', async () => {
    const cloud = new FakeCloud({ ghDeleteScope: true })
    await designerSwappedToNetlify(cloud)
    const down = await cli(cloud, ['down', '--yes', '--json'])
    expect(down.code, down.writer.outText).toBe(ExitCode.ok)
    expect(cloud.vercelProjects.size).toBe(0)
    expect(stateOf().resources['vercel.project']).toBeUndefined()
  })

  it('up with nobody to ask and no --orphans stops before changing anything, as a step for a person', async () => {
    const cloud = new FakeCloud({ ghDeleteScope: true })
    await designerSwappedToNetlify(cloud)
    const up = await cli(cloud, ['up', '--json', '--yes'])
    expect(up.code).toBe(ExitCode.needsHuman)
    expect(up.writer.outText).toContain('ORPHANS_DECISION_NEEDED')
    expect(cloud.v2.netlifySites.size).toBe(0)
  })

  it('up --orphans destroy deletes the old project and builds the new hosting; release forgets it and leaves it; retain keeps tracking it', async () => {
    for (const choice of ['destroy', 'release', 'retain'] as const) {
      removeDir(dir)
      const cloud = new FakeCloud({ ghDeleteScope: true })
      await designerSwappedToNetlify(cloud)
      const up = await cli(cloud, ['up', '--json', '--yes', '--orphans', choice])
      expect(up.code, `${choice}: ${up.writer.outText.slice(-600)}`).toBe(ExitCode.ok)
      expect(cloud.v2.netlifySites.size, choice).toBe(1)
      expect(cloud.vercelProjects.size, choice).toBe(choice === 'destroy' ? 0 : 1)
      expect(Boolean(stateOf().resources['vercel.project']), choice).toBe(choice === 'retain')
    }
  })

  it('state holds the unresolved spec of each resource and never a secret value', async () => {
    const cloud = new FakeCloud({ marketplaceDone: true })
    const made = await cli(cloud, ['new', 'my-app', '--preset', 'fullstack', '--json', '--yes', '--allow-billing', '--dir', dir], root)
    expect(made.code).toBe(ExitCode.ok)
    const raw = readFileSync(join(dir, '.cimiento', 'state.json'), 'utf8')
    const state = JSON.parse(raw) as { version: number; resources: Record<string, { spec?: { provider: string; kind: string } }> }
    expect(state.version).toBe(2)
    expect(state.resources['vercel.project'].spec).toMatchObject({ provider: 'vercel', kind: 'resource' })
    for (const value of ['fake-anthropic-api-key-not-a-real-credential', 'signkey-', 'fake-supabase-service-role', 'eyJ']) expect(raw, value).not.toContain(value)
  })
})
