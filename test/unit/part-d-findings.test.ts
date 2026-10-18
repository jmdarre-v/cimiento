// Regression tests for the findings of the second attended Goal 1 run: the Supabase session and
// the pinned organization, a migration check that proved nothing, GitHub access for Vercel as one
// person step, and tool updates. Each test fails against commit 3ab1b7a.

import { existsSync, readFileSync, writeFileSync } from 'node:fs'
import { join } from 'node:path'
import { afterEach, beforeEach, describe, expect, it } from 'vitest'
import { run } from '../../src/cli/index'
import { ExitCode } from '../../src/core/errors'
import { runUp, runVerifyAll } from '../../src/core/executor'
import { buildPlan } from '../../src/core/planner'
import { clearToolUpdateCache } from '../../src/core/toolkit'
import type { Ctx, ResourceSpec } from '../../src/core/types'
import { renderManifest } from '../../src/manifest'
import { BASELINE_FILE, scaffoldFiles } from '../../src/scaffold'
import { FakeCloud } from './fake-cloud'
import { CaptureWriter, manifestFor, personDoesIt, removeDir, tempDir, testContext, useFakeTokens } from './helpers'

const TWO_ORGS = [
  { id: 'org_pro', name: 'Pro Org', plan: 'pro' },
  { id: 'org_free', name: 'Free Org', plan: 'free' },
]

describe('attended run findings', () => {
  let configDir: string
  const dirs: string[] = []

  beforeEach(() => {
    useFakeTokens()
    clearToolUpdateCache()
    configDir = tempDir('cimiento-config-')
    process.env.CIMIENTO_CONFIG_DIR = configDir
  })

  afterEach(() => {
    removeDir(configDir)
    for (const dir of dirs.splice(0)) removeDir(dir)
    delete process.env.CIMIENTO_CONFIG_DIR
  })

  describe('BUG-25: the Supabase session reported the first organization, not the pinned one', () => {
    it('reports the pinned organization even when another one comes first', async () => {
      const cloud = new FakeCloud({ supabaseOrganizations: TWO_ORGS })
      const t = testContext(manifestFor({ options: { supabase: { organization_id: 'org_free' } } }, 'fullstack'), { cloud })
      const supabase = t.providers.find((p) => p.id === 'supabase')!
      expect((await supabase.detect(t.ctx)).session?.account).toBe('org_free')
      const check = await supabase.verify(t.specs.find((s) => s.id === 'supabase.session')!, t.ctx)
      expect(check.ok).toBe(true)
      expect(check.evidence).toBe('supabase session in organization Free Org (org_free), free plan, the one stack.yaml pins')
    })

    it('fails verify when the pinned organization is not accessible to the session', async () => {
      const cloud = new FakeCloud({ supabaseOrganizations: TWO_ORGS })
      const t = testContext(manifestFor({ options: { supabase: { organization_id: 'org_gone' } } }, 'fullstack'), { cloud })
      const reports = await runVerifyAll(t.ctx, t.providers, t.specs)
      const session = reports.find((r) => r.id === 'supabase.session')!
      expect(session.ok).toBe(false)
      expect(session.error?.code).toBe('SESSION_ACCOUNT_MISMATCH')
      expect(session.error?.hint).toContain('cimiento accounts set supabase')
    })

    it('up stops at the session instead of creating anything in a guessed organization', async () => {
      const cloud = new FakeCloud({ supabaseOrganizations: TWO_ORGS })
      const t = testContext(
        manifestFor({ accounts: { supabase: 'direct' }, options: { supabase: { organization_id: 'org_gone' } } }, 'fullstack'),
        { cloud },
      )
      const result = await runUp(t.ctx, t.providers, t.specs, { onManual: personDoesIt })
      expect(result.errors.map((e) => e.code)).toContain('SESSION_ACCOUNT_MISMATCH')
      expect(cloud.supabaseProjects).toEqual([])
    })
  })

  describe('BUG-26: supabase.check.migrated passed with no migration files', () => {
    it('the nextjs-app scaffold ships a baseline migration that creates a table', () => {
      const files = scaffoldFiles(manifestFor({}, 'fullstack'))
      const baseline = files[`supabase/migrations/${BASELINE_FILE}`]
      expect(baseline).toContain('create table if not exists public.cimiento_baseline')
      expect(baseline).toContain('enable row level security')
      expect(files['supabase/migrations/.gitkeep']).toBeUndefined()
    })

    it('up applies the baseline through the API and the check queries its table', async () => {
      const cloud = new FakeCloud()
      const t = testContext(manifestFor({ accounts: { supabase: 'direct' } }, 'fullstack'), { cloud })
      const result = await runUp({ ...t.ctx, smoke: true }, t.providers, t.specs, { onManual: personDoesIt })
      expect(result.errors).toEqual([])
      const ref = result.state.resources['supabase.project'].externalId!
      expect(cloud.migrations.get(ref)?.map((m) => m.name)).toEqual(['cimiento_baseline'])
      const check = result.receipts.find((r) => r.id === 'supabase.check.migrated')!
      expect(check.evidence).toBe(`1 migrations applied in ${ref}; public.cimiento_baseline answers with 1 row`)
      // No CLI, and so no database password: the API records the migration itself.
      expect(cloud.execCalls.filter((c) => c.startsWith('supabase link') || c.startsWith('supabase db push'))).toEqual([])
    })

    it('writes the baseline into a project scaffolded before it existed', async () => {
      const cloud = new FakeCloud()
      const t = testContext(manifestFor({ accounts: { supabase: 'direct' } }, 'fullstack'), { cloud })
      expect(existsSync(join(t.ctx.cwd, 'supabase/migrations', BASELINE_FILE))).toBe(false)
      await runUp(t.ctx, t.providers, t.specs, { onManual: personDoesIt })
      expect(existsSync(join(t.ctx.cwd, 'supabase/migrations', BASELINE_FILE))).toBe(true)
    })

    it('fails with no migration files when there is no scaffold to supply the baseline', async () => {
      const cloud = new FakeCloud()
      const t = testContext(manifestFor({ accounts: { supabase: 'direct' }, scaffold: { template: 'none' } }, 'fullstack'), { cloud })
      const result = await runUp(t.ctx, t.providers, t.specs, { onManual: personDoesIt })
      const failure = result.errors.find((e) => e.resource === 'supabase.migrations' || e.resource === 'supabase.check.migrated')
      expect(failure?.code).toBe('SUPABASE_MIGRATION_FAILED')
      expect(failure?.message).toContain('No migration files')
    })

    it('fails when a migration file is not in the history, and up applies it', async () => {
      const cloud = new FakeCloud()
      const t = testContext(manifestFor({ accounts: { supabase: 'direct' } }, 'fullstack'), { cloud })
      const first = await runUp(t.ctx, t.providers, t.specs, { onManual: personDoesIt })
      writeFileSync(join(t.ctx.cwd, 'supabase/migrations/20260925000000_notes.sql'), 'create table public.notes (id int primary key);\n')
      const again = testContext(manifestFor({ accounts: { supabase: 'direct' } }, 'fullstack'), { cloud, state: first.state, cwd: t.ctx.cwd })
      const before = await runVerifyAll(again.ctx, again.providers, again.specs)
      expect(before.find((r) => r.id === 'supabase.check.migrated')!.error?.message).toContain('20260925000000_notes.sql')
      const second = await runUp(again.ctx, again.providers, again.specs, { onManual: personDoesIt })
      expect(second.errors).toEqual([])
      expect(cloud.migrations.get(first.state.resources['supabase.project'].externalId!)!.map((m) => m.name)).toEqual([
        'cimiento_baseline',
        'notes',
      ])
    })
  })

  describe('BUG-27: GitHub access for Vercel came as two failures, one link attempt at a time', () => {
    /** The person does what the page asks: connect GitHub and grant the app this repository. */
    function personGrantsAccess(cloud: FakeCloud, seen: ResourceSpec[]) {
      return async (spec: ResourceSpec, ctx: Ctx): Promise<boolean> => {
        seen.push(spec)
        cloud.vercelGithubConnected = true
        cloud.githubAppRepos = 'all'
        return personDoesIt(spec, ctx)
      }
    }

    it('with neither in place, asks for each page in turn in the same run, one URL per step (BUG-52), then continues', async () => {
      const cloud = new FakeCloud({ vercelGithubConnected: false, githubAppRepos: [] })
      const t = testContext(manifestFor({}, 'designer'), { cloud })
      const asked: ResourceSpec[] = []
      // The person does exactly what each page asks: first the connection, then the access.
      const result = await runUp(t.ctx, t.providers, t.specs, {
        onManual: async (spec) => {
          asked.push(spec)
          if (spec.manual?.step?.id === 'vercel.github-connection') cloud.vercelGithubConnected = true
          if (spec.manual?.step?.id === 'vercel.github-access') cloud.githubAppRepos = 'all'
          return true
        },
      })
      expect(result.errors).toEqual([])
      expect(result.exitCode).toBe(ExitCode.ok)
      const steps = asked.filter((s) => s.id === 'vercel.github-access').map((s) => s.manual!.step!)
      expect(steps.map((s) => s.id)).toEqual(['vercel.github-connection', 'vercel.github-access'])
      expect(steps.map((s) => s.url)).toEqual(['https://vercel.com/account/authentication', 'https://github.com/settings/installations/101'])
      for (const step of steps) {
        const urls = [step.url, ...step.path.map((p) => p.en)].join(' ').match(/https:\/\/\S+/g) ?? []
        expect(new Set(urls).size, step.id).toBe(1)
      }
      expect(asked.find((s) => s.manual?.step?.id === 'vercel.github-access')!.manual!.instructions).toContain('add my-app')
      // No failed link attempt came first.
      expect(cloud.httpCalls.filter((c) => c.includes('/link')).length).toBe(1)
    })

    it('with the connection in place but no access to this repository, links straight to the installation', async () => {
      const cloud = new FakeCloud({ githubAppRepos: ['some-other-repo'] })
      const t = testContext(manifestFor({}, 'designer'), { cloud })
      const asked: ResourceSpec[] = []
      await runUp(t.ctx, t.providers, t.specs, { onManual: personGrantsAccess(cloud, asked) })
      const step = asked.find((s) => s.id === 'vercel.github-access')!
      expect(step.manual!.instructions).toContain('Under Repository access, choose Only select repositories')
      expect(step.manual!.instructions).toContain('https://github.com/settings/installations/101')
      expect(step.manual!.instructions).not.toContain('Login Connections')
      expect(step.manual!.url).toBe('https://github.com/settings/installations/101')
    })

    it('pressing Enter without doing it waits on the person, it is not a failure', async () => {
      const cloud = new FakeCloud({ vercelGithubConnected: false })
      const t = testContext(manifestFor({}, 'designer'), { cloud })
      const result = await runUp(t.ctx, t.providers, t.specs, { onManual: async () => true })
      expect(result.errors).toEqual([])
      expect(result.pendingManual).toEqual(['vercel.github-access'])
      expect(result.exitCode).toBe(ExitCode.needsHuman)
      expect(cloud.httpCalls.filter((c) => c.includes('/link'))).toEqual([])
    })

    it('with both in place it is never asked, and plan shows the evidence', async () => {
      const cloud = new FakeCloud()
      const t = testContext(manifestFor({}, 'designer'), { cloud })
      let asked = 0
      const result = await runUp(t.ctx, t.providers, t.specs, {
        onManual: async () => {
          asked += 1
          return true
        },
      })
      expect(asked).toBe(0)
      expect(result.errors).toEqual([])
      const plan = await buildPlan({ ...t.ctx, state: result.state, dryRun: true }, t.providers, t.specs)
      expect(plan.items.find((i) => i.id === 'vercel.github-access')!.status).toBe('noop')
    })
  })

  describe('BUG-28: a newer tool version went unmentioned', () => {
    const notice = 'A new version of Supabase CLI is available: v2.118.0 (currently installed v2.95.4)'

    it('plan reports the newer version from the tool notice, without blocking', async () => {
      const cloud = new FakeCloud({ toolVersions: { supabase: '2.95.4' }, versionNotices: { supabase: notice } })
      const t = testContext(manifestFor({}, 'fullstack'), { cloud })
      const plan = await buildPlan({ ...t.ctx, dryRun: true }, t.providers, t.specs)
      const tool = plan.items.find((i) => i.id === 'supabase.tool.supabase')!
      expect(tool.status).toBe('noop')
      expect(tool.evidence).toBe('supabase 2.95.4, 2.118.0 available: cimiento up offers brew upgrade supabase/tap/supabase')
    })

    it('up in a terminal offers the upgrade, runs brew in the foreground on yes, and continues', async () => {
      const cloud = new FakeCloud({
        toolVersions: { supabase: '2.95.4' },
        versionNotices: { supabase: notice },
        latestVersions: { supabase: '2.118.0' },
      })
      const dir = tempDir('cimiento-partd-')
      dirs.push(dir)
      writeFileSync(join(dir, 'stack.yaml'), renderManifest(manifestFor({}, 'fullstack')))
      const questions: string[] = []
      const code = await run(['up', '--yes', '--allow-billing'], {
        io: cloud,
        cwd: dir,
        writer: new CaptureWriter(),
        interactive: true,
        onManual: personDoesIt,
        choose: async (question, options) => {
          questions.push(question)
          return question.startsWith('Newer versions are available') ? 'upgrade' : options[0].value
        },
      })
      expect(code).toBe(ExitCode.ok)
      // BUG-43: one question for every outdated tool, before the plan, never during apply.
      expect(questions.filter((q) => q.startsWith('Newer versions are available'))).toEqual([
        'Newer versions are available: Supabase CLI 2.95.4 to 2.118.0 (brew upgrade supabase/tap/supabase). Upgrade them now?',
      ])
      expect(cloud.interactiveCalls).toContain('brew upgrade supabase/tap/supabase')
      const state = JSON.parse(readFileSync(join(dir, '.cimiento/state.json'), 'utf8'))
      expect(state.resources['supabase.tool.supabase'].outputs.version).toBe('2.118.0')
    })

    it('declining keeps the installed version and does not block', async () => {
      const cloud = new FakeCloud({ toolVersions: { supabase: '2.95.4' }, versionNotices: { supabase: notice } })
      const t = testContext(manifestFor({}, 'fullstack'), { cloud })
      t.ctx.interactive = true
      t.ctx.choose = async (question, options) => (question.includes('is available') ? 'skip' : options[0].value)
      const result = await runUp(t.ctx, t.providers, t.specs, { onManual: personDoesIt })
      expect(result.errors).toEqual([])
      expect(result.exitCode).toBe(ExitCode.ok)
      expect(cloud.interactiveCalls.filter((c) => c.startsWith('brew upgrade'))).toEqual([])
    })

    it('with nobody at a terminal, never asks and never upgrades', async () => {
      const cloud = new FakeCloud({ toolVersions: { supabase: '2.95.4' }, versionNotices: { supabase: notice } })
      const t = testContext(manifestFor({}, 'fullstack'), { cloud })
      const result = await runUp(t.ctx, t.providers, t.specs, { onManual: personDoesIt })
      expect(result.exitCode).toBe(ExitCode.ok)
      expect(result.state.resources['supabase.tool.supabase'].outputs?.latest).toBe('2.118.0')
      expect(cloud.execCalls.concat(cloud.interactiveCalls).filter((c) => c.startsWith('brew upgrade'))).toEqual([])
    })

    it('a tool installed outside Homebrew is reported but never offered a brew upgrade', async () => {
      const cloud = new FakeCloud({ toolVersions: { git: 'git version 2.39.0 (Apple Git-154)' }, latestVersions: { git: '2.55.0' } })
      const t = testContext(manifestFor({}, 'designer'), { cloud })
      const plan = await buildPlan({ ...t.ctx, dryRun: true }, t.providers, t.specs)
      expect(plan.items.find((i) => i.id === 'github.tool.git')!.evidence).toBe('git 2.39.0')
      expect(cloud.execCalls.filter((c) => c.startsWith('brew info --json=v2 git'))).toEqual([])
    })
  })

  describe('BUG-29, found in step 6: down said nothing about a leftover organization while another step was pending', () => {
    it('lists the organization even when the repository waits on the delete_repo permission', async () => {
      const cloud = new FakeCloud({ supabaseOrganizations: [{ id: 'org_a', name: 'Alpha', plan: 'free' }], ghDeleteScope: false, inngestInstalled: true })
      const dir = tempDir('cimiento-partd-')
      dirs.push(dir)
      writeFileSync(join(dir, 'stack.yaml'), renderManifest(manifestFor({ name: 'cimiento-test-1', accounts: { supabase: 'direct' } }, 'fullstack')))
      await run(['accounts', 'set', 'supabase'], {
        io: cloud,
        cwd: dir,
        writer: new CaptureWriter(),
        interactive: true,
        choose: async (_q, options) => options[options.length - 1].value,
        ask: async (_q, d) => d ?? '',
      })
      expect(await run(['up', '--json', '--yes', '--allow-billing'], { io: cloud, cwd: dir, writer: new CaptureWriter(), interactive: false })).toBe(ExitCode.ok)
      const writer = new CaptureWriter()
      const code = await run(['down', '--yes', '--json'], { io: cloud, cwd: dir, writer, interactive: false })
      expect(code).toBe(ExitCode.needsHuman)
      const summary = writer.jsonObjects().filter((o) => (o as { command?: string }).command === 'down').pop() as {
        pending: string[]
        leftovers: { name: string; provider: string }[]
      }
      expect(summary.pending).toEqual(['github.repo'])
      expect(summary.leftovers.filter((l) => l.provider === 'supabase').map((l) => l.name)).toEqual(['cimiento-test-1'])
    })
  })
})

