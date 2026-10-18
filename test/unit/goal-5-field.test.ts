// Regression tests for the bugs field test 5 found (docs/FIELD-TEST-5.md), from BUG-60 on.

import { readFileSync, writeFileSync } from 'node:fs'
import { join } from 'node:path'
import { parseDocument } from 'yaml'
import { afterEach, beforeEach, describe, expect, it } from 'vitest'
import { run } from '../../src/cli/index'
import { ExitCode } from '../../src/core/errors'
import { clearToolUpdateCache } from '../../src/core/toolkit'
import { setNetlifyDeployWait } from '../../src/providers/netlify'
import { scaffoldFiles } from '../../src/scaffold'
import { FakeCloud } from './fake-cloud'
import { CaptureWriter, manifestFor, personDoesIt, removeDir, tempDir, useFakeTokens } from './helpers'

let root: string
let dir: string
let configDir: string

beforeEach(() => {
  useFakeTokens()
  clearToolUpdateCache()
  setNetlifyDeployWait({ intervalMs: 1, timeoutMs: 50 })
  root = tempDir('cimiento-goal5f-')
  dir = join(root, 'my-app')
  configDir = tempDir('cimiento-config-')
  process.env.CIMIENTO_CONFIG_DIR = configDir
})

afterEach(() => {
  removeDir(root)
  removeDir(configDir)
  delete process.env.CIMIENTO_CONFIG_DIR
})

async function cli(cloud: FakeCloud, args: string[], cwd = dir): Promise<{ code: number; writer: CaptureWriter }> {
  const writer = new CaptureWriter()
  const code = await run(args, { io: cloud, cwd, writer, interactive: false, onManual: personDoesIt })
  return { code, writer }
}

describe('BUG-60: files next dev writes stay out of the repository', () => {
  it('the scaffold .gitignore lists next-env.d.ts and *.tsbuildinfo, so cimiento publish never commits them', () => {
    for (const preset of ['designer', 'fullstack'] as const) {
      const gitignore = scaffoldFiles(manifestFor({}, preset))['.gitignore']
      expect(gitignore, preset).toContain('next-env.d.ts')
      expect(gitignore, preset).toContain('*.tsbuildinfo')
    }
  })
})

describe('BUG-61: a Next.js site on Netlify gets the Next.js runtime', () => {
  it('the link sets @netlify/plugin-nextjs, so the deployed page answers 200 instead of 404', async () => {
    const cloud = new FakeCloud()
    const { code, writer } = await cli(cloud, ['new', 'my-app', '--preset', 'designer', '--hosting', 'netlify', '--json', '--yes', '--dir', dir], root)
    expect(code, writer.outText).toBe(ExitCode.ok)
    const site = [...cloud.v2.netlifySites.values()][0]
    expect(site.plugins).toEqual([{ package: '@netlify/plugin-nextjs' }])
    expect(cloud.pages.get('https://my-app.netlify.app')?.status).toBe(200)
  })

  it('a site linked without it gets it on the next up, which builds again because the build settings changed', async () => {
    const cloud = new FakeCloud()
    await cli(cloud, ['new', 'my-app', '--preset', 'designer', '--hosting', 'netlify', '--json', '--yes', '--dir', dir], root)
    const site = [...cloud.v2.netlifySites.values()][0]
    cloud.v2.linkWithoutRuntime(site.id)
    cloud.pages.set(site.ssl_url, { status: 404, body: '<title>Page not found</title>' })
    const deploys = cloud.v2.netlifyDeploys.length
    const doctor = await cli(cloud, ['doctor', '--json'])
    expect(doctor.code).toBe(ExitCode.failed)
    const up = await cli(cloud, ['up', '--json', '--yes'])
    expect(up.code, up.writer.outText).toBe(ExitCode.ok)
    expect(site.plugins).toEqual([{ package: '@netlify/plugin-nextjs' }])
    expect(cloud.v2.netlifyDeploys.length).toBe(deploys + 1)
    expect(cloud.pages.get(site.ssl_url)?.status).toBe(200)
  })
})

describe('BUG-62: secret rotate names the hosting the project uses', () => {
  it('on Netlify the note says Netlify reads env when it builds, not Vercel', async () => {
    const cloud = new FakeCloud()
    await cli(cloud, ['new', 'my-app', '--preset', 'designer', '--hosting', 'netlify', '--json', '--yes', '--dir', dir], root)
    const file = join(dir, 'stack.yaml')
    const doc = parseDocument(readFileSync(file, 'utf8'))
    doc.set('secrets', doc.createNode([{ name: 'CIMIENTO_TEST_SECRET', sinks: ['hosting'], environments: ['preview', 'production'], source: 'env' }]))
    writeFileSync(file, doc.toString(), 'utf8')
    process.env.CIMIENTO_TEST_SECRET = 'fake-rotate-note-value-not-real'
    try {
      await cli(cloud, ['secret', 'set', 'CIMIENTO_TEST_SECRET', '--json'])
      const { writer } = await cli(cloud, ['secret', 'rotate', 'CIMIENTO_TEST_SECRET', '--json'])
      const summary = writer.jsonObjects().find((o) => (o as { command?: string }).command === 'secret rotate') as { note: string; redeployed: string | null }
      expect(summary.note).not.toContain('Vercel')
      // BUG-63: the rotate deploys again, and the note says where.
      expect(summary.redeployed).toBe('https://my-app.netlify.app')
      expect(summary.note).toContain('https://my-app.netlify.app')
    } finally {
      delete process.env.CIMIENTO_TEST_SECRET
    }
  })
})

describe('BUG-63: secret set and rotate deploy again, because hosting reads env only when it builds', () => {
  it('after rotate, a fresh join on a clone passes every check with nothing in between', async () => {
    const cloud = new FakeCloud()
    await cli(cloud, ['new', 'my-app', '--preset', 'designer', '--json', '--yes', '--dir', dir], root)
    const file = join(dir, 'stack.yaml')
    const doc = parseDocument(readFileSync(file, 'utf8'))
    doc.set('secrets', doc.createNode([{ name: 'CIMIENTO_TEST_SECRET', sinks: ['hosting'], environments: ['preview', 'production'], source: 'env' }]))
    writeFileSync(file, doc.toString(), 'utf8')
    try {
      process.env.CIMIENTO_TEST_SECRET = 'fake-bug63-value-one-not-real'
      const set = await cli(cloud, ['secret', 'set', 'CIMIENTO_TEST_SECRET', '--json'])
      expect((set.writer.jsonObjects().pop() as { redeployed: string | null }).redeployed).toBeTruthy()
      process.env.CIMIENTO_TEST_SECRET = 'fake-bug63-value-two-not-real'
      await cli(cloud, ['secret', 'rotate', 'CIMIENTO_TEST_SECRET', '--json'])
      const doctor = await cli(cloud, ['doctor', '--json'])
      expect(doctor.code, doctor.writer.outText).toBe(ExitCode.ok)
    } finally {
      delete process.env.CIMIENTO_TEST_SECRET
    }
  })
})

describe('BUG-64: the DNS step names the record Vercel asks for', () => {
  it('Vercel recommends a project specific CNAME first, and a TXT record when it needs proof of ownership', async () => {
    const cloud = new FakeCloud()
    await cli(cloud, ['new', 'my-app', '--preset', 'designer', '--json', '--yes', '--dir', dir], root)
    const first = await cli(cloud, ['domain', 'add', 'shop.example.test', '--json'])
    expect(first.code).toBe(ExitCode.needsHuman)
    expect(first.writer.outText).toContain('CNAME shop fakeproject.vercel-dns-016.com')
    cloud.v2.vercelTxtChallenge = 'vc-domain-verify=fake-not-real'
    const doctor = await cli(cloud, ['doctor', '--json'])
    const check = (doctor.writer.jsonObjects().pop() as { items: { id: string; error?: { message: string } }[] }).items.find((i) => i.id === 'vercel.check.domain')!
    expect(check.error?.message).toContain('TXT _vercel vc-domain-verify=fake-not-real')
  })
})

describe('BUG-66: the Supabase configuration question only comes up for a Supabase project on Vercel', () => {
  it('a Neon project with accounts.supabase via-hosting left in stack.yaml is never asked, and Vercel is never called for it', async () => {
    const { testContext } = await import('./helpers')
    const { settleSupabasePath } = await import('../../src/wiring/supabase-configurations')
    const cloud = new FakeCloud({ supabaseConfiguration: { id: 'icfg_shared', databases: [{ name: 'other-db', project: 'other-app' }] } })
    const m = manifestFor({ slots: { repo: 'github', hosting: 'netlify', database: 'neon' } as never, accounts: { supabase: 'via-hosting' } })
    const { ctx } = testContext(m, { cloud })
    const asked: string[] = []
    const result = await settleSupabasePath({ ...ctx, interactive: true, choose: async (q) => (asked.push(q), '1') }, 'up', { ask: true })
    expect(result).toBeUndefined()
    expect(asked).toEqual([])
    expect(cloud.httpCalls.some((c) => c.includes('api.vercel.com'))).toBe(false)
  })
})

describe('BUG-67: the Neon login is found where current neonctl keeps it', () => {
  it('reads ~/.config/neon/credentials.json, and still the older ~/.config/neonctl', async () => {
    const { mkdirSync } = await import('node:fs')
    const { resolveNeonToken } = await import('../../src/providers/neon/api')
    const { testContext } = await import('./helpers')
    const { ctx } = testContext(manifestFor({}, 'designer'))
    const saved = { key: process.env.NEON_API_KEY, xdg: process.env.XDG_CONFIG_HOME }
    const base = tempDir('cimiento-xdg-')
    try {
      delete process.env.NEON_API_KEY
      process.env.XDG_CONFIG_HOME = base
      for (const folder of ['neon', 'neonctl']) {
        removeDir(join(base, 'neon'))
        removeDir(join(base, 'neonctl'))
        mkdirSync(join(base, folder), { recursive: true })
        writeFileSync(join(base, folder, 'credentials.json'), JSON.stringify({ access_token: `fake-${folder}-token-not-real`, expires_at: Date.now() + 3_600_000 }))
        expect(await resolveNeonToken(ctx, 'neon.session')).toBe(`fake-${folder}-token-not-real`)
      }
    } finally {
      if (saved.key) process.env.NEON_API_KEY = saved.key
      if (saved.xdg) process.env.XDG_CONFIG_HOME = saved.xdg
      else delete process.env.XDG_CONFIG_HOME
      removeDir(base)
    }
  })
})
