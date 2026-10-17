// One end to end cimiento new --preset fullstack --json run against fully mocked io, ending with
// every check passing and a receipts list.

import { existsSync, readFileSync } from 'node:fs'
import { join } from 'node:path'
import { afterEach, beforeEach, describe, expect, it } from 'vitest'
import { run } from '../../src/cli/index'
import { ExitCode } from '../../src/core/errors'
import { FakeCloud } from './fake-cloud'
import { CaptureWriter, removeDir, tempDir, useFakeTokens, personDoesIt } from './helpers'

describe('cimiento new --preset fullstack --json', () => {
  let root: string
  let configDir: string

  beforeEach(() => {
    useFakeTokens()
    root = tempDir()
    configDir = tempDir('cimiento-config-')
    process.env.CIMIENTO_CONFIG_DIR = configDir
  })

  afterEach(() => {
    removeDir(root)
    removeDir(configDir)
    delete process.env.CIMIENTO_CONFIG_DIR
  })

  it('scaffolds, applies, verifies every check and prints receipts', async () => {
    const cloud = new FakeCloud()
    const writer = new CaptureWriter()
    const dir = join(root, 'my-app')

    const code = await run(['new', 'My App', '--preset', 'fullstack', '--json', '--yes', '--allow-billing', '--dir', dir], {
      io: cloud,
      cwd: root,
      writer,
      interactive: false,
      // The Marketplace terms need a person. This is the person saying yes.
      onManual: personDoesIt,
    })

    expect(code).toBe(ExitCode.ok)

    const objects = writer.jsonObjects() as Record<string, unknown>[]
    const scaffold = objects.find((o) => o.stage === 'scaffold')!
    expect(scaffold.slug).toBe('my-app')
    expect(scaffold.files as string[]).toContain('stack.yaml')

    const summary = objects.find((o) => o.command === 'up')!
    expect(summary.ok).toBe(true)
    expect(summary.exitCode).toBe(ExitCode.ok)
    expect(summary.errors).toEqual([])
    expect(summary.pendingManual).toEqual([])
    expect(summary.blocked).toEqual([])

    const receipts = summary.receipts as { id: string; action: string; url?: string; evidence?: string }[]
    expect(receipts.length).toBeGreaterThan(10)

    // Every check in the plan is present in the receipts and carries evidence.
    const checks = receipts.filter((r) => r.id.includes('.check.'))
    expect(checks.map((r) => r.id).sort()).toEqual([
      'anthropic.check.key',
      'github.check.repo',
      'inngest.check.roundtrip',
      'supabase.check.auth-urls',
      'supabase.check.migrated',
      'turnstile.check.verify',
      'vercel.check.deployed',
      'vercel.check.repo-linked',
      'vercel.check.secrets-present',
    ])
    for (const check of checks) expect(check.evidence, `${check.id} has no evidence`).toBeTruthy()

    // The deployment receipt carries the URL a person would open.
    const deployment = receipts.find((r) => r.id === 'vercel.deployment')!
    expect(deployment.url).toMatch(/^https:\/\/my-app.*\.vercel\.app$/)
  })

  it('writes the scaffold files spec section 11 lists', async () => {
    const cloud = new FakeCloud()
    const writer = new CaptureWriter()
    const dir = join(root, 'my-app')

    await run(['new', 'my-app', '--preset', 'fullstack', '--json', '--yes', '--allow-billing', '--dir', dir], {
      io: cloud,
      cwd: root,
      writer,
      interactive: false,
      onManual: personDoesIt,
    })

    for (const file of [
      'stack.yaml',
      '.gitignore',
      '.env.example',
      '.claude/settings.json',
      'README.md',
      'CLAUDE.md',
      '.github/workflows/migrations.yml',
      'app/page.tsx',
      'package.json',
    ]) {
      expect(existsSync(join(dir, file)), `${file} is missing`).toBe(true)
    }

    const gitignore = readFileSync(join(dir, '.gitignore'), 'utf8')
    expect(gitignore).toContain('.env*')
    expect(gitignore).toContain('.cimiento/cache')
    expect(gitignore).toContain('design/exports/*.zip')

    const settings = JSON.parse(readFileSync(join(dir, '.claude/settings.json'), 'utf8'))
    expect(settings.permissions.deny).toContain('Read(./.env)')

    const envExample = readFileSync(join(dir, '.env.example'), 'utf8')
    expect(envExample).toContain('NEXT_PUBLIC_SUPABASE_URL=')
    // Names only. Nothing after the equals sign, ever.
    for (const line of envExample.split('\n')) {
      if (!line || line.startsWith('#')) continue
      expect(line).toMatch(/^[A-Z][A-Z0-9_]*=$/)
    }

    const claudeMd = readFileSync(join(dir, 'CLAUDE.md'), 'utf8')
    expect(claudeMd).toContain('cimiento secret set')
    expect(claudeMd).toContain('Never paste a key into chat')
  })

  it('fills the README Receipts section with one row per resource', async () => {
    const cloud = new FakeCloud()
    const writer = new CaptureWriter()
    const dir = join(root, 'my-app')

    await run(['new', 'my-app', '--preset', 'fullstack', '--json', '--yes', '--allow-billing', '--dir', dir], {
      io: cloud,
      cwd: root,
      writer,
      interactive: false,
      onManual: personDoesIt,
    })

    const readme = readFileSync(join(dir, 'README.md'), 'utf8')
    expect(readme).toContain('## Receipts')
    expect(readme).toContain('github.repo')
    expect(readme).toContain('https://github.com/test-handle/my-app')
    expect(readme).toContain('vercel.deployment')
  })

  it('records state with external ids and no secret values', async () => {
    const cloud = new FakeCloud()
    const writer = new CaptureWriter()
    const dir = join(root, 'my-app')

    await run(['new', 'my-app', '--preset', 'fullstack', '--json', '--yes', '--allow-billing', '--dir', dir], {
      io: cloud,
      cwd: root,
      writer,
      interactive: false,
      onManual: personDoesIt,
    })

    const raw = readFileSync(join(dir, '.cimiento/state.json'), 'utf8')
    const state = JSON.parse(raw)
    expect(state.version).toBe(1)
    expect(state.manifestHash).toMatch(/^[0-9a-f]{64}$/)
    expect(state.resources['github.repo'].externalId).toBeTruthy()
    expect(state.resources['vercel.project'].externalId).toMatch(/^prj_/)
    expect(state.manualDone).toContain('vercel.marketplace-terms')
    expect(raw).not.toContain('fake-anon-key')
    expect(raw).not.toContain('fake-service-role-key')
    expect(raw).not.toContain('fake-vercel-token')
  })

  it('a doctor run straight after new reports every item ok', async () => {
    const cloud = new FakeCloud()
    const dir = join(root, 'my-app')

    await run(['new', 'my-app', '--preset', 'fullstack', '--json', '--yes', '--allow-billing', '--dir', dir], {
      io: cloud,
      cwd: root,
      writer: new CaptureWriter(),
      interactive: false,
      onManual: personDoesIt,
    })

    const doctorWriter = new CaptureWriter()
    const code = await run(['doctor', '--json'], {
      io: cloud,
      cwd: dir,
      writer: doctorWriter,
      interactive: false,
    })

    expect(code).toBe(ExitCode.ok)
    const report = doctorWriter.jsonObjects()[0] as {
      ok: boolean
      items: { id: string; ok: boolean; error?: { message: string } }[]
      summary: { failed: number }
    }
    const failed = report.items.filter((i) => !i.ok)
    expect(failed.map((i) => `${i.id}: ${i.error?.message}`)).toEqual([])
    expect(report.ok).toBe(true)
    expect(report.summary.failed).toBe(0)
  })

  it('stops with exit code 2 when the Marketplace terms need a person and nobody answers', async () => {
    const cloud = new FakeCloud()
    const writer = new CaptureWriter()
    const dir = join(root, 'my-app')

    const code = await run(['new', 'my-app', '--preset', 'fullstack', '--json', '--yes', '--allow-billing', '--dir', dir], {
      io: cloud,
      cwd: root,
      writer,
      interactive: false,
    })

    expect(code).toBe(ExitCode.needsHuman)
    const summary = writer.jsonObjects().find((o) => (o as Record<string, unknown>).command === 'up') as Record<
      string,
      unknown
    >
    // Both person steps of the fullstack preset, each asked once: the Marketplace and the Inngest
    // integration on Vercel.
    expect((summary.pendingManual as string[]).sort()).toEqual(['inngest.vercel-integration', 'vercel.marketplace-terms'])
    expect(summary.errors).toEqual([])
  })

  it('refuses --yes when billable items exist and --allow-billing was not given', async () => {
    const cloud = new FakeCloud()
    const writer = new CaptureWriter()
    const dir = join(root, 'my-app')

    const code = await run(['new', 'my-app', '--preset', 'fullstack', '--json', '--yes', '--dir', dir], {
      io: cloud,
      cwd: root,
      writer,
      interactive: false,
      onManual: personDoesIt,
    })

    expect(code).toBe(ExitCode.needsHuman)
    expect(writer.outText).toContain('--allow-billing')
    expect(cloud.vercelProjects.size).toBe(0)
    expect(cloud.supabaseProjects.length).toBe(0)
  })
})
