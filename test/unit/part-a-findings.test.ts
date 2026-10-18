// Regression tests for every bug Goal 1 Part A exposed. Each describe names the finding, and each
// test fails against the code that shipped in Goal 0.

import { existsSync, readFileSync, writeFileSync } from 'node:fs'
import { join } from 'node:path'
import { afterEach, beforeEach, describe, expect, it } from 'vitest'
import { run } from '../../src/cli/index'
import { ExitCode } from '../../src/core/errors'
import { runUp } from '../../src/core/executor'
import { buildPlan } from '../../src/core/planner'
import { REDACTION_MASK } from '../../src/core/redact'
import { loadKb } from '../../src/kb'
import { renderManifest } from '../../src/manifest'
import { decodeKeyring } from '../../src/providers/supabase/api'
import { FakeCloud } from './fake-cloud'
import { CaptureWriter, manifestForShared as manifestFor, personDoesIt, removeDir, tempDir, testContext, useFakeTokens } from './helpers'

/** A project folder on disk with a stack.yaml, the way cimiento new leaves it. */
function projectDir(overrides: Parameters<typeof manifestFor>[0] = {}, preset: 'fullstack' | 'designer' = 'fullstack'): string {
  const dir = tempDir('cimiento-parta-')
  writeFileSync(join(dir, 'stack.yaml'), renderManifest(manifestFor({ name: 'cimiento-test-1', ...overrides }, preset)))
  return dir
}

function jsonUp(writer: CaptureWriter): Record<string, unknown> {
  return writer.jsonObjects().find((o) => (o as Record<string, unknown>).command === 'up') as Record<string, unknown>
}

describe('Part A findings', () => {
  let configDir: string
  const dirs: string[] = []

  beforeEach(() => {
    useFakeTokens()
    configDir = tempDir('cimiento-config-')
    process.env.CIMIENTO_CONFIG_DIR = configDir
  })

  afterEach(() => {
    removeDir(configDir)
    for (const dir of dirs.splice(0)) removeDir(dir)
    delete process.env.CIMIENTO_CONFIG_DIR
  })

  describe('BUG-1: vendor logins ran captured, with no terminal and a two minute timeout', () => {
    it('runs vercel login in the foreground when a person is at the terminal', async () => {
      const cloud = new FakeCloud({ vercelLoggedIn: false })
      const dir = projectDir({}, 'designer')
      dirs.push(dir)
      const code = await run(['up', '--yes', '--allow-billing'], {
        io: cloud,
        cwd: dir,
        writer: new CaptureWriter(),
        interactive: true,
        onManual: personDoesIt,
      })
      expect(code).toBe(ExitCode.ok)
      expect(cloud.interactiveCalls).toContain('vercel login')
      // Never through the captured channel, where the device code would be invisible.
      expect(cloud.execCalls.filter((c) => c === 'vercel login')).toHaveLength(cloud.interactiveCalls.filter((c) => c === 'vercel login').length)
    })

    it('runs supabase login and gh auth login in the foreground too', async () => {
      delete process.env.SUPABASE_ACCESS_TOKEN
      const cloud = new FakeCloud()
      const t = testContext(manifestFor({}, 'fullstack'), { cloud })
      delete process.env.SUPABASE_ACCESS_TOKEN
      t.ctx.interactive = true
      const supabase = t.providers.find((p) => p.id === 'supabase')!
      await supabase.login(t.ctx)
      expect(cloud.interactiveCalls).toContain('supabase login')

      const github = t.providers.find((p) => p.id === 'github')!
      await github.login(t.ctx)
      expect(cloud.interactiveCalls.some((c) => c.startsWith('gh auth login'))).toBe(true)
    })
  })

  describe('BUG-2: a missing session in a run with no terminal was a failure, exit code 1', () => {
    it('stops as a step waiting on a person, exit code 2, and never starts a login', async () => {
      const cloud = new FakeCloud({ vercelLoggedIn: false })
      const dir = projectDir()
      dirs.push(dir)
      const writer = new CaptureWriter()
      const code = await run(['up', '--json', '--yes', '--allow-billing'], { io: cloud, cwd: dir, writer, interactive: false })

      expect(code).toBe(ExitCode.needsHuman)
      const summary = jsonUp(writer)
      expect(summary.errors).toEqual([])
      expect(summary.pendingManual).toContain('vercel.session')
      expect(cloud.interactiveCalls).toEqual([])
      expect(cloud.execCalls).not.toContain('vercel login')
    })

    it('tells the agent the attended cimiento command, not a vendor command', async () => {
      const cloud = new FakeCloud({ vercelLoggedIn: false })
      const dir = projectDir()
      dirs.push(dir)
      const writer = new CaptureWriter()
      await run(['up', '--json', '--yes', '--allow-billing'], { io: cloud, cwd: dir, writer, interactive: false })
      const manual = writer
        .jsonObjects()
        .find((o) => (o as { event?: string; id?: string }).event === 'manual' && (o as { id?: string }).id === 'vercel.session') as {
        error: { code: string; hint: string }
      }
      expect(manual.error.code).toBe('SESSION_MISSING')
      expect(manual.error.hint).toContain('cimiento up')
      expect(manual.error.hint).toContain(dir)
      expect(manual.error.hint).not.toMatch(/vercel login/)
    })

    it('still creates everything that does not need the missing session', async () => {
      const cloud = new FakeCloud({ vercelLoggedIn: false })
      const dir = projectDir()
      dirs.push(dir)
      await run(['up', '--json', '--yes', '--allow-billing'], { io: cloud, cwd: dir, writer: new CaptureWriter(), interactive: false })
      expect(cloud.repos.has('test-handle/cimiento-test-1')).toBe(true)
      expect(cloud.vercelProjects.size).toBe(0)
    })
  })

  describe('BUG-3: hints told the person to run vendor commands by hand', () => {
    const vendorCommand = /\bRun (gh|vercel|supabase|brew|npm)\b|\bexport (VERCEL|SUPABASE)_/

    it('no knowledge base hint tells the person to run a vendor command', () => {
      const offenders = loadKb()
        .filter((e) => vendorCommand.test(e.hint))
        .map((e) => `${e.code}: ${e.hint}`)
      expect(offenders).toEqual([])
    })

    it('a missing tool says cimiento installs it', async () => {
      const cloud = new FakeCloud({ toolVersions: { vercel: '' } })
      const t = testContext(manifestFor({}, 'designer'), { cloud })
      const plan = await buildPlan({ ...t.ctx, dryRun: true }, t.providers, t.specs)
      const item = plan.items.find((i) => i.id === 'vercel.tool.vercel')!
      expect(item.status).toBe('create')
      expect(item.error?.hint).toContain('cimiento up installs')
      expect(item.error?.hint).not.toMatch(vendorCommand)
    })

    it('an old tool is upgraded, not reinstalled as a no op', async () => {
      const cloud = new FakeCloud({ toolVersions: { gh: 'gh version 2.10.0' } })
      const t = testContext(manifestFor({}, 'designer'), { cloud })
      t.ctx.interactive = true
      const github = t.providers.find((p) => p.id === 'github')!
      const spec = t.specs.find((s) => s.id === 'github.tool.gh')!
      await github.ensure(spec, t.ctx).catch(() => undefined)
      expect(cloud.execCalls).toContain('brew upgrade gh')
      expect(cloud.execCalls).not.toContain('brew install gh')
    })
  })

  describe('BUG-4: accounts were never pinned in stack.yaml, and the Vercel team was never asked for', () => {
    it('pins the GitHub handle, the only Vercel team and the only Supabase organization', async () => {
      const cloud = new FakeCloud()
      const dir = projectDir()
      dirs.push(dir)
      const code = await run(['up', '--json', '--yes', '--allow-billing'], {
        io: cloud,
        cwd: dir,
        writer: new CaptureWriter(),
        interactive: false,
        onManual: personDoesIt,
      })
      expect(code).toBe(ExitCode.ok)
      const yaml = readFileSync(join(dir, 'stack.yaml'), 'utf8')
      expect(yaml).toMatch(/github: test-handle/)
      expect(yaml).toMatch(/vercel: team_fake/)
      expect(yaml).toMatch(/organization_id: org_fake/)
      // The header comment survives the rewrite.
      expect(yaml).toContain('The only file you edit by hand.')
    })

    it('asks which team when there are several, and writes the answer', async () => {
      const cloud = new FakeCloud({
        vercelTeams: [
          { id: 'team_personal', slug: 'fullstack', name: 'Personal' },
          { id: 'team_work', slug: 'work', name: 'Work' },
        ],
      })
      const dir = projectDir({}, 'designer')
      dirs.push(dir)
      const asked: string[] = []
      const code = await run(['up', '--yes', '--allow-billing'], {
        io: cloud,
        cwd: dir,
        writer: new CaptureWriter(),
        interactive: true,
        onManual: personDoesIt,
        choose: async (question, options) => {
          asked.push(`${question} ${options.map((o) => o.value).join(',')}`)
          return 'team_work'
        },
      })
      expect(code).toBe(ExitCode.ok)
      expect(asked).toEqual(['Which Vercel team should this project use? team_personal,team_work'])
      expect(readFileSync(join(dir, 'stack.yaml'), 'utf8')).toMatch(/vercel: team_work/)
    })

    it('with several teams and nobody to ask, waits on a person instead of guessing', async () => {
      const cloud = new FakeCloud({
        vercelTeams: [
          { id: 'team_personal', slug: 'fullstack', name: 'Personal' },
          { id: 'team_work', slug: 'work', name: 'Work' },
        ],
      })
      const dir = projectDir({}, 'designer')
      dirs.push(dir)
      const writer = new CaptureWriter()
      const code = await run(['up', '--json', '--yes', '--allow-billing'], { io: cloud, cwd: dir, writer, interactive: false })
      expect(code).toBe(ExitCode.needsHuman)
      expect(jsonUp(writer).pendingManual).toContain('vercel.session')
      expect(cloud.vercelProjects.size).toBe(0)
      expect(readFileSync(join(dir, 'stack.yaml'), 'utf8')).not.toMatch(/vercel: team_/)
    })

    it('never overwrites an account the person already pinned', async () => {
      const cloud = new FakeCloud({ githubLogin: 'someone-else' })
      const dir = projectDir({ accounts: { github: 'the-pinned-one' } }, 'designer')
      dirs.push(dir)
      const writer = new CaptureWriter()
      const code = await run(['up', '--json', '--yes', '--allow-billing'], { io: cloud, cwd: dir, writer, interactive: false })
      expect(code).toBe(ExitCode.failed)
      expect(JSON.stringify(jsonUp(writer).errors)).toContain('SESSION_ACCOUNT_MISMATCH')
      expect(readFileSync(join(dir, 'stack.yaml'), 'utf8')).toMatch(/github: the-pinned-one/)
    })

    it('never writes stack.yaml during plan', async () => {
      const cloud = new FakeCloud()
      const dir = projectDir()
      dirs.push(dir)
      const before = readFileSync(join(dir, 'stack.yaml'), 'utf8')
      await run(['plan', '--json'], { io: cloud, cwd: dir, writer: new CaptureWriter(), interactive: false })
      expect(readFileSync(join(dir, 'stack.yaml'), 'utf8')).toBe(before)
    })
  })

  describe('BUG-5: the Marketplace step verified whenever Enter was pressed, and only showed a link', () => {
    it('pressing Enter without installing leaves the step pending, not done', async () => {
      const cloud = new FakeCloud()
      const t = testContext(manifestFor({}, 'fullstack'), { cloud })
      const result = await runUp(t.ctx, t.providers, t.specs, { onManual: async () => true })
      expect(result.pendingManual).toContain('vercel.marketplace-terms')
      expect(result.state.manualDone).not.toContain('vercel.marketplace-terms')
      expect(result.exitCode).toBe(ExitCode.needsHuman)
    })

    it('a team that already has Supabase installed is never asked', async () => {
      const cloud = new FakeCloud({ marketplaceDone: true, inngestInstalled: true })
      const t = testContext(manifestFor({}, 'fullstack'), { cloud })
      let asked = 0
      const result = await runUp(t.ctx, t.providers, t.specs, {
        onManual: async () => {
          asked += 1
          return true
        },
      })
      expect(asked).toBe(0)
      expect(result.errors).toEqual([])
      expect(result.exitCode).toBe(ExitCode.ok)
      const plan = await buildPlan({ ...testContext(manifestFor({}, 'fullstack'), { cloud }).ctx, dryRun: true }, t.providers, t.specs)
      expect(plan.items.find((i) => i.id === 'vercel.marketplace-terms')!.status).toBe('noop')
    })

    it('opens the page in the browser for the person', async () => {
      const cloud = new FakeCloud()
      const dir = projectDir()
      dirs.push(dir)
      const { openInBrowser } = await import('../../src/cli/commands/up')
      const { openSession } = await import('../../src/cli/context')
      const { parseArgs } = await import('../../src/cli/args')
      const session = openSession(parseArgs(['up']), { io: cloud, cwd: dir, writer: new CaptureWriter(), interactive: true })
      await openInBrowser(session, 'https://vercel.com/marketplace/supabase')
      const opener = process.platform === 'darwin' ? 'open' : 'xdg-open'
      expect(cloud.execCalls).toContain(`${opener} https://vercel.com/marketplace/supabase`)
    })

    it('gives plain instructions that say what to click and that cimiento checks the result', () => {
      const t = testContext(manifestFor({}, 'fullstack'))
      const manual = t.specs.find((s) => s.id === 'vercel.marketplace-terms')!.manual!
      expect(manual.instructions).toContain('Click Install')
      expect(manual.instructions).toContain('cimiento checks')
      expect(manual.url).toBe('https://vercel.com/marketplace/supabase')
    })
  })

  describe('BUG-6: the Marketplace install relied on defaults that name the database at random and write secrets to disk', () => {
    it('adds Supabase with the project slug as its name and without an env pull', async () => {
      const cloud = new FakeCloud()
      const t = testContext(manifestFor({ name: 'cimiento-test-1' }, 'fullstack'), { cloud })
      const result = await runUp(t.ctx, t.providers, t.specs, { onManual: personDoesIt })
      expect(result.errors).toEqual([])
      const install = cloud.execCalls.find((c) => c.startsWith('vercel integration add supabase'))!
      expect(install).toContain('--name cimiento-test-1')
      expect(install).toContain('--no-env-pull')
      expect(cloud.supabaseProjects.map((p) => p.name)).toEqual(['cimiento-test-1'])
    })

    it('links the folder to the project by name before integration add and deploy', async () => {
      const cloud = new FakeCloud()
      const t = testContext(manifestFor({ name: 'cimiento-test-1' }, 'fullstack'), { cloud })
      await runUp(t.ctx, t.providers, t.specs, { onManual: personDoesIt })
      const calls = cloud.execCalls
      const link = calls.findIndex((c) => c.startsWith('vercel link --yes --project cimiento-test-1'))
      expect(link).toBeGreaterThanOrEqual(0)
      expect(link).toBeLessThan(calls.findIndex((c) => c.startsWith('vercel integration add')))
      expect(link).toBeLessThan(calls.findIndex((c) => c.startsWith('vercel deploy')))
    })
  })

  describe('BUG-7: doctor recorded the version of gh as the version of git', () => {
    it('writes each tool with its own version into machine state', async () => {
      const cloud = new FakeCloud({ toolVersions: { git: 'git version 2.54.0', gh: 'gh version 2.97.0 (2026-01-01)' } })
      const dir = projectDir({ slots: { repo: 'github' } } as never, 'designer')
      dirs.push(dir)
      await run(['doctor', '--json'], { io: cloud, cwd: dir, writer: new CaptureWriter(), interactive: false })
      const machine = JSON.parse(readFileSync(join(configDir, 'machine.json'), 'utf8'))
      expect(machine.tools.git.version).toBe('2.54.0')
      expect(machine.tools.gh.version).toBe('2.97.0')
    })
  })

  describe('BUG-8: a Supabase login kept in the Keychain was invisible, so cimiento started a second login', () => {
    it('finds the session from the Keychain with no token file and no environment variable', async () => {
      const cloud = new FakeCloud({
        keychainSupabaseToken: 'go-keyring-base64:ZmFrZS1zdXBhYmFzZS10b2tlbi1ub3QtYS1yZWFsLWNyZWRlbnRpYWw=',
      })
      const t = testContext(manifestFor({}, 'fullstack'), { cloud })
      delete process.env.SUPABASE_ACCESS_TOKEN
      const supabase = t.providers.find((p) => p.id === 'supabase')!
      const detection = await supabase.detect(t.ctx)
      expect(detection.session?.account).toBe('org_fake')
      expect(cloud.interactiveCalls).toEqual([])
      // The token read from the Keychain is masked everywhere from then on.
      expect(t.redactor.redact('fake-supabase-token-not-a-real-credential')).toBe(REDACTION_MASK)
    })

    it('decodes the go-keyring base64 form and passes a plain token through', () => {
      expect(decodeKeyring('go-keyring-base64:ZmFrZS10b2tlbg==')).toBe('fake-token')
      expect(decodeKeyring('plain-fake-token')).toBe('plain-fake-token')
    })

    it('with no Keychain entry either, a terminal run logs in and then finds the Keychain token', async () => {
      const cloud = new FakeCloud()
      const t = testContext(manifestFor({}, 'fullstack'), { cloud })
      delete process.env.SUPABASE_ACCESS_TOKEN
      t.ctx.interactive = true
      const supabase = t.providers.find((p) => p.id === 'supabase')!
      const session = t.specs.find((s) => s.id === 'supabase.session')!
      const result = await supabase.ensure(session, t.ctx)
      expect(result.action).toBe('created')
      expect(cloud.interactiveCalls).toContain('supabase login')
    })
  })

  it('the Part A project folder shape still plans without writing anything', async () => {
    const cloud = new FakeCloud({ vercelLoggedIn: false })
    const dir = projectDir()
    dirs.push(dir)
    const writer = new CaptureWriter()
    await run(['plan', '--json'], { io: cloud, cwd: dir, writer, interactive: false })
    const plan = writer.jsonObjects()[0] as { items: { id: string; status: string }[] }
    expect(plan.items.find((i) => i.id === 'vercel.session')!.status).toBe('create')
    expect(existsSync(join(dir, '.cimiento', 'state.json'))).toBe(false)
  })
})

describe('BUG-9, found in Part B step 4: a step waiting on a person was attempted again in every pass', () => {
  it('asks once per run, not once per pass', async () => {
    useFakeTokens()
    const cloud = new FakeCloud()
    const t = testContext(manifestFor({}, 'fullstack'), { cloud })
    const asked = new Map<string, number>()
    const result = await runUp(t.ctx, t.providers, t.specs, {
      onManual: async (spec) => {
        asked.set(spec.id, (asked.get(spec.id) ?? 0) + 1)
        return false
      },
    })
    expect(result.passes).toBeGreaterThan(1)
    expect(asked.size).toBeGreaterThan(0)
    for (const [id, count] of asked) expect(count, id).toBe(1)
  })

  it('reports a pending session once, not once per pass', async () => {
    useFakeTokens()
    const cloud = new FakeCloud({ vercelLoggedIn: false })
    const t = testContext(manifestFor({}, 'fullstack'), { cloud })
    const events: string[] = []
    await runUp(t.ctx, t.providers, t.specs, {
      onEvent: (e) => {
        if (e.event === 'manual' && e.id) events.push(e.id)
      },
    })
    expect(events.filter((id) => id === 'vercel.session')).toHaveLength(1)
    expect(cloud.execCalls.filter((c) => c === 'vercel whoami').length).toBeLessThanOrEqual(2)
  })
})
