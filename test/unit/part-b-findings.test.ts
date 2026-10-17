// Regression tests for the findings of the attended Goal 1 run, reported at the start of Part B,
// round two. Each describe names the finding; each test fails against commit f643c77.

import { readFileSync, writeFileSync } from 'node:fs'
import { join } from 'node:path'
import { afterEach, beforeEach, describe, expect, it } from 'vitest'
import { run } from '../../src/cli/index'
import { ExitCode } from '../../src/core/errors'
import { runUp, runVerifyAll } from '../../src/core/executor'
import { buildPlan } from '../../src/core/planner'
import type { Ctx, ResourceSpec } from '../../src/core/types'
import { renderManifest } from '../../src/manifest'
import { refFromUrl } from '../../src/wiring/vercel-supabase-runtime'
import { FakeCloud } from './fake-cloud'
import { CaptureWriter, manifestFor, removeDir, tempDir, testContext, useFakeTokens } from './helpers'

/** The person at the Marketplace page lets Vercel create a database, named after another project as in the real run. */
async function personInstallsWithDatabase(spec: ResourceSpec, ctx: Ctx): Promise<boolean> {
  if (spec.id === 'inngest.vercel-integration') (ctx.io as FakeCloud).installInngest()
  else (ctx.io as FakeCloud).acceptMarketplace({ createDatabase: 'older-project' })
  return true
}

function projectDir(overrides: Parameters<typeof manifestFor>[0] = {}): string {
  const dir = tempDir('cimiento-partb-')
  writeFileSync(join(dir, 'stack.yaml'), renderManifest(manifestFor({ name: 'cimiento-test-1', ...overrides }, 'fullstack')))
  return dir
}

describe('Part B findings', () => {
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

  describe('BUG-10: the Marketplace created a database cimiento could not find by name, and plan offered a second one', () => {
    it('adopts the database the hosting env points at, whatever its name, and never creates another', async () => {
      const cloud = new FakeCloud()
      const t = testContext(manifestFor({ name: 'cimiento-test-1' }, 'fullstack'), { cloud })
      const result = await runUp(t.ctx, t.providers, t.specs, { onManual: personInstallsWithDatabase })

      expect(result.errors).toEqual([])
      expect(cloud.supabaseProjects.map((p) => p.name)).toEqual(['older-project'])
      expect(cloud.httpCalls.filter((c) => c === 'POST https://api.supabase.com/v1/projects')).toEqual([])
      expect(cloud.execCalls.filter((c) => c.startsWith('vercel integration add'))).toEqual([])
      expect(result.state.resources['supabase.project'].externalId).toBe(cloud.supabaseProjects[0].id)
      expect(result.receipts.find((r) => r.id === 'supabase.project')?.action).toBe('adopted')
    })

    it('plans adopt for that database, not create', async () => {
      const cloud = new FakeCloud()
      const first = testContext(manifestFor({ name: 'cimiento-test-1' }, 'fullstack'), { cloud })
      // Stop right after the Marketplace step, the way the attended run left cimiento-test-1.
      await runUp(first.ctx, first.providers, first.specs, {
        onManual: personInstallsWithDatabase,
        only: ['github', 'vercel'],
      })
      const t = testContext(manifestFor({ name: 'cimiento-test-1' }, 'fullstack'), { cloud })
      const plan = await buildPlan({ ...t.ctx, dryRun: true }, t.providers, t.specs)
      const database = plan.items.find((i) => i.id === 'supabase.project')!
      expect(database.status).toBe('adopt')
      expect(database.evidence).toContain('the database the hosting env points at')
    })

    it('refuses to plan a second database while the hosting env points at one this login cannot see', async () => {
      const cloud = new FakeCloud()
      const setup = testContext(manifestFor({ name: 'cimiento-test-1' }, 'fullstack'), { cloud })
      await runUp(setup.ctx, setup.providers, setup.specs, { onManual: personInstallsWithDatabase, only: ['github', 'vercel'] })
      // The database lives in an organization this Supabase login has no access to.
      cloud.supabaseProjects.splice(0)

      const t = testContext(manifestFor({ name: 'cimiento-test-1' }, 'fullstack'), { cloud })
      const plan = await buildPlan({ ...t.ctx, dryRun: true }, t.providers, t.specs)
      const database = plan.items.find((i) => i.id === 'supabase.project')!
      expect(database.status).toBe('needs-human')
      expect(database.error?.code).toBe('SUPABASE_DUPLICATE_REFUSED')

      const result = await runUp(t.ctx, t.providers, t.specs, { onManual: personInstallsWithDatabase })
      expect(result.pendingManual).toContain('supabase.project')
      expect(result.errors).toEqual([])
      expect(result.exitCode).toBe(ExitCode.needsHuman)
      expect(cloud.httpCalls.filter((c) => c === 'POST https://api.supabase.com/v1/projects')).toEqual([])
    })

    it('holds on the direct path too: an existing Supabase env means adopt, not create', async () => {
      const cloud = new FakeCloud()
      const setup = testContext(manifestFor({ name: 'cimiento-test-1' }, 'fullstack'), { cloud })
      await runUp(setup.ctx, setup.providers, setup.specs, { onManual: personInstallsWithDatabase, only: ['github', 'vercel'] })

      const t = testContext(manifestFor({ name: 'cimiento-test-1', accounts: { supabase: 'direct' } }, 'fullstack'), { cloud })
      const result = await runUp(t.ctx, t.providers, t.specs, { onManual: async () => true })
      expect(result.errors).toEqual([])
      expect(cloud.supabaseProjects).toHaveLength(1)
      expect(cloud.httpCalls.filter((c) => c === 'POST https://api.supabase.com/v1/projects')).toEqual([])
    })

    it('reads the ref from a Supabase URL and ignores anything else', () => {
      expect(refFromUrl('https://abcdefghijklmnopqrst.supabase.co')).toBe('abcdefghijklmnopqrst')
      expect(refFromUrl('https://example.com')).toBeUndefined()
      expect(refFromUrl('not a url')).toBeUndefined()
      expect(refFromUrl(undefined)).toBeUndefined()
    })
  })

  describe('BUG-11: the organization prompt listed existing organizations only, with no plan and no way to create one', () => {
    const orgs = [
      { id: 'org_pro', name: 'Pro Org', plan: 'pro' },
      { id: 'org_free', name: 'Free Org', plan: 'free' },
    ]

    it('shows each plan, warns on a paid one, and offers a new organization', async () => {
      const cloud = new FakeCloud({ supabaseOrganizations: orgs })
      const dir = projectDir()
      dirs.push(dir)
      let offered: { value: string; label: string; warning?: string }[] = []
      await run(['up', '--yes', '--allow-billing'], {
        io: cloud,
        cwd: dir,
        writer: new CaptureWriter(),
        interactive: true,
        onManual: personInstallsWithDatabase,
        choose: async (question, options) => {
          if (question.includes('Supabase organization')) offered = options
          return question.includes('Supabase organization') ? 'org_free' : options[0].value
        },
      })
      expect(offered.map((o) => o.label)).toEqual([
        'Pro Org, pro plan',
        'Free Org, free plan',
        'Create a new organization (free plan), named cimiento-test-1 unless you type another name',
      ])
      expect(offered[0].warning).toContain('billed to it')
      expect(offered[1].warning).toBeUndefined()
      expect(readFileSync(join(dir, 'stack.yaml'), 'utf8')).toMatch(/organization_id: org_free/)
    })

    it('creates a new organization from the terminal, named after the project by default', async () => {
      const cloud = new FakeCloud({ supabaseOrganizations: orgs })
      const dir = projectDir()
      dirs.push(dir)
      const asked: string[] = []
      await run(['up', '--yes', '--allow-billing'], {
        io: cloud,
        cwd: dir,
        writer: new CaptureWriter(),
        interactive: true,
        onManual: personInstallsWithDatabase,
        choose: async (question, options) => options[options.length - 1].value,
        ask: async (question, defaultValue) => {
          asked.push(`${question} [${defaultValue}]`)
          return defaultValue ?? ''
        },
      })
      // Enter presses of the person step walk are not questions.
      expect(asked.filter((q) => !q.startsWith('Press Enter'))).toEqual(['Name for the new Supabase organization: [cimiento-test-1]'])
      const created = cloud.supabaseOrganizations.find((o) => o.name === 'cimiento-test-1')!
      expect(created).toBeDefined()
      expect(readFileSync(join(dir, 'stack.yaml'), 'utf8')).toContain(`organization_id: ${created.id}`)
    })

    it('asks even with a single organization when it is on a paid plan', async () => {
      const cloud = new FakeCloud({ supabaseOrganizations: [{ id: 'org_pro', name: 'Pro Org', plan: 'pro' }] })
      const dir = projectDir()
      dirs.push(dir)
      let asked = false
      await run(['up', '--yes', '--allow-billing'], {
        io: cloud,
        cwd: dir,
        writer: new CaptureWriter(),
        interactive: true,
        onManual: personInstallsWithDatabase,
        choose: async (question, options) => {
          if (question.includes('Supabase organization')) asked = true
          return options[0].value
        },
      })
      expect(asked).toBe(true)
    })

    it('with nobody at a terminal, names every plan and the option to create one', async () => {
      const cloud = new FakeCloud({ supabaseOrganizations: orgs })
      const dir = projectDir()
      dirs.push(dir)
      const writer = new CaptureWriter()
      const code = await run(['up', '--json', '--yes', '--allow-billing'], { io: cloud, cwd: dir, writer, interactive: false })
      expect(code).toBe(ExitCode.needsHuman)
      const manual = writer
        .jsonObjects()
        .find((o) => (o as { id?: string; event?: string }).event === 'manual' && (o as { id?: string }).id === 'supabase.session') as {
        error: { code: string; message: string }
      }
      expect(manual.error.code).toBe('ACCOUNT_CHOICE_NEEDED')
      expect(manual.error.message).toContain('Pro Org (pro plan, paid)')
      expect(manual.error.message).toContain('Free Org (free plan)')
      expect(manual.error.message).toContain('a new organization')
    })
  })

  describe('BUG-12: the Marketplace instructions left out the Create New or Link Existing choice', () => {
    it('says Link Existing and names the organization when a Supabase login and organization exist', async () => {
      const cloud = new FakeCloud()
      const t = testContext(manifestFor({ options: { supabase: { organization_id: 'org_fake' } } }, 'fullstack'), { cloud })
      const shown: string[] = []
      await runUp(t.ctx, t.providers, t.specs, {
        onManual: async () => false,
        onEvent: (e) => {
          if (e.event === 'manual' && e.id === 'vercel.marketplace-terms' && e.message) shown.push(e.message)
        },
      })
      expect(shown).toHaveLength(1)
      expect(shown[0]).toContain('Choose Link Existing Supabase Account, sign in to Supabase')
      expect(shown[0]).not.toContain('Choose Create New Supabase Account')
      expect(shown[0]).toContain('grant the organization Fake Org')
      expect(shown[0]).toContain('Fake Team')
    })

    it('says Create New when there is no Supabase organization to link', async () => {
      const cloud = new FakeCloud({ supabaseOrganizations: [] })
      const t = testContext(manifestFor({}, 'fullstack'), { cloud })
      const vercel = t.providers.find((p) => p.id === 'vercel')!
      const spec = t.specs.find((s) => s.id === 'vercel.marketplace-terms')!
      const check = await vercel.verify(spec, t.ctx)
      expect(check.ok).toBe(false)
      expect(check.error?.hint).toContain('Choose Create New Supabase Account')
      expect(check.error?.hint).not.toContain('Link Existing')
    })

    it('no longer tells the person to close the database dialog', () => {
      const t = testContext(manifestFor({}, 'fullstack'))
      const fallback = t.specs.find((s) => s.id === 'vercel.marketplace-terms')!.manual!.instructions
      expect(fallback).not.toContain('close that dialog')
      expect(fallback).toContain('Link Existing Supabase Account')
    })
  })

  describe('BUG-13: manual step instructions were printed twice', () => {
    it('prints the Marketplace instructions once across stdout and stderr', async () => {
      const cloud = new FakeCloud()
      const dir = projectDir()
      dirs.push(dir)
      const writer = new CaptureWriter()
      await run(['up', '--yes', '--allow-billing'], {
        io: cloud,
        cwd: dir,
        writer,
        interactive: true,
        onManual: async () => false,
      })
      const all = writer.outText + writer.errText
      // The title is also in the list of steps up front; the step itself is printed once.
      expect(all.split('Read and accept the Marketplace terms').length - 1).toBe(1)
      expect(all).toContain('Waiting on you: vercel.marketplace-terms.')
    })
  })

  describe('BUG-14: billing warnings were printed twice in two phrasings, without saying who pays', () => {
    it('prints one warning per billable item, naming the organization and its plan', async () => {
      const cloud = new FakeCloud()
      const t = testContext(manifestFor({ options: { supabase: { organization_id: 'org_fake' } } }, 'fullstack'), { cloud })
      const plan = await buildPlan({ ...t.ctx, dryRun: true }, t.providers, t.specs)
      expect(plan.warnings).toEqual([
        'supabase.project bills to Supabase organization Fake Org, free plan: no charge unless you go over the plan limits. Approve it with --allow-billing.',
      ])
    })

    it('says so plainly when the organization is on a paid plan', async () => {
      const cloud = new FakeCloud({ supabaseOrganizations: [{ id: 'org_pro', name: 'Pro Org', plan: 'pro' }] })
      const t = testContext(manifestFor({ options: { supabase: { organization_id: 'org_pro' } } }, 'fullstack'), { cloud })
      const plan = await buildPlan({ ...t.ctx, dryRun: true }, t.providers, t.specs)
      expect(plan.warnings).toHaveLength(1)
      expect(plan.warnings[0]).toContain('Supabase organization Pro Org, pro plan: a paid plan, so this is charged to it')
    })

    it('names the Vercel team and its plan for a paid Vercel project', async () => {
      const cloud = new FakeCloud({ vercelTeams: [{ id: 'team_fake', slug: 'fake-team', name: 'Fake Team', plan: 'pro' }] })
      const t = testContext(
        manifestFor({ accounts: { vercel: 'team_fake' }, options: { vercel: { plan: 'pro' } } }, 'designer'),
        { cloud },
      )
      const plan = await buildPlan({ ...t.ctx, dryRun: true }, t.providers, t.specs)
      const warning = plan.warnings.find((w) => w.startsWith('vercel.project '))!
      expect(warning).toContain('Vercel team Fake Team, pro plan: a paid plan')
    })

    it('the plan command adds no second phrasing, and the Marketplace install is not billed twice', async () => {
      const cloud = new FakeCloud()
      const dir = projectDir({ options: { supabase: { organization_id: 'org_fake' } } })
      dirs.push(dir)
      const writer = new CaptureWriter()
      await run(['plan', '--json'], { io: cloud, cwd: dir, writer, interactive: false })
      const plan = writer.jsonObjects()[0] as { warnings: string[]; items: { id: string; billable: boolean }[] }
      expect(plan.warnings.filter((w) => w.includes('billable on the account'))).toEqual([])
      expect(plan.warnings.filter((w) => w.startsWith('supabase.project '))).toHaveLength(1)
      expect(plan.items.find((i) => i.id === 'vercel.binding.supabase-install')!.billable).toBe(false)
    })

    it('up without --allow-billing names who pays, under its own code', async () => {
      const cloud = new FakeCloud()
      const dir = projectDir({ options: { supabase: { organization_id: 'org_fake' } } })
      dirs.push(dir)
      const writer = new CaptureWriter()
      const code = await run(['up', '--json', '--yes'], { io: cloud, cwd: dir, writer, interactive: false })
      expect(code).toBe(ExitCode.needsHuman)
      const error = (writer.jsonObjects().find((o) => (o as { error?: unknown }).error) as { error: { code: string; message: string } }).error
      expect(error.code).toBe('BILLING_APPROVAL_NEEDED')
      expect(error.message).toContain('bills to Supabase organization Fake Org, free plan')
    })
  })

  describe('BUG-17, found before running up: an older database reached through Link Existing was about to be adopted, re-pointed and deleted', () => {
    /** The Install dialog links a database made months before the project, as another project's database was. */
    async function linkOlderDatabase(cloud: FakeCloud): Promise<void> {
      const setup = testContext(manifestFor({ name: 'cimiento-test-1' }, 'fullstack'), { cloud })
      await runUp(setup.ctx, setup.providers, setup.specs, { onManual: personInstallsWithDatabase, only: ['github', 'vercel'] })
      cloud.supabaseProjects[0].created_at = '2026-01-25T18:32:19.806Z'
    }

    it('with nobody at a terminal, waits on a person and leaves the database untouched', async () => {
      const cloud = new FakeCloud()
      await linkOlderDatabase(cloud)
      const t = testContext(manifestFor({ name: 'cimiento-test-1' }, 'fullstack'), { cloud })
      const plan = await buildPlan({ ...t.ctx, dryRun: true }, t.providers, t.specs)
      expect(plan.items.find((i) => i.id === 'supabase.project')!.evidence).toContain('created 2026-01-25, before this project')

      const result = await runUp(t.ctx, t.providers, t.specs, { onManual: personInstallsWithDatabase })
      expect(result.pendingManual).toContain('supabase.project')
      expect(result.errors).toEqual([])
      expect(cloud.httpCalls.some((c) => c.startsWith('PATCH') && c.includes('/config/auth'))).toBe(false)
      expect(cloud.supabaseProjects).toHaveLength(1)
    })

    it('asks in a terminal, and adopts only on a yes, recording it as adopted', async () => {
      const cloud = new FakeCloud()
      await linkOlderDatabase(cloud)
      const t = testContext(manifestFor({ name: 'cimiento-test-1' }, 'fullstack'), { cloud })
      t.ctx.interactive = true
      const questions: string[] = []
      t.ctx.choose = async (question) => {
        questions.push(question)
        return 'adopt'
      }
      const result = await runUp(t.ctx, t.providers, t.specs, { onManual: personInstallsWithDatabase })
      expect(questions.some((q) => q.includes('created 2026-01-25, before this project'))).toBe(true)
      expect(result.errors).toEqual([])
      expect(result.state.resources['supabase.project'].origin).toBe('adopted')
    })

    it('a database the install step created for this project is recorded as created, not adopted', async () => {
      const cloud = new FakeCloud()
      const t = testContext(manifestFor({ name: 'cimiento-test-1' }, 'fullstack'), { cloud })
      const result = await runUp(t.ctx, t.providers, t.specs, { onManual: async (_s, ctx) => ((ctx.io as FakeCloud).acceptMarketplace(), true) })
      expect(result.errors).toEqual([])
      expect(result.state.resources['supabase.project'].origin).toBe('created')
    })

    it('down keeps an adopted database and releases it from state, and still deletes what cimiento created', async () => {
      const cloud = new FakeCloud({ ghDeleteScope: true })
      const dir = projectDir({ accounts: { github: 'test-handle' } })
      dirs.push(dir)
      // Everything but the database is created by cimiento in this folder, then the Install dialog
      // links an older database, as in the real run.
      await run(['up', '--json', '--yes', '--allow-billing', '--only', 'github,vercel'], {
        io: cloud,
        cwd: dir,
        writer: new CaptureWriter(),
        interactive: false,
        onManual: personInstallsWithDatabase,
      })
      cloud.supabaseProjects[0].created_at = '2026-01-25T18:32:19.806Z'
      const up = await run(['up', '--json', '--yes', '--allow-billing'], {
        io: cloud,
        cwd: dir,
        writer: new CaptureWriter(),
        interactive: true,
        onManual: personInstallsWithDatabase,
        choose: async (question, options) => (question.startsWith('The hosting env points at') ? 'adopt' : options[0].value),
      })
      expect(up).toBe(ExitCode.ok)

      const writer = new CaptureWriter()
      const code = await run(['down', '--yes', '--json'], { io: cloud, cwd: dir, writer, interactive: false })
      expect(code).toBe(ExitCode.ok)
      const summary = writer.jsonObjects().find((o) => (o as { command?: string }).command === 'down') as {
        destroyed: string[]
        released: string[]
      }
      expect(summary.released).toEqual(['supabase.project'])
      expect(summary.destroyed).toContain('vercel.project')
      expect(cloud.supabaseProjects.map((p) => p.name)).toEqual(['older-project'])
      const state = JSON.parse(readFileSync(join(dir, '.cimiento', 'state.json'), 'utf8'))
      expect(state.resources['supabase.project']).toBeUndefined()
    })
  })

  describe('BUG-16, found while testing BUG-10: --only and --skip crashed on a dependency across providers', () => {
    it('plans and applies with --only even when a kept step waits on a filtered provider', async () => {
      const cloud = new FakeCloud()
      const dir = projectDir({ options: { supabase: { organization_id: 'org_fake' } } })
      dirs.push(dir)
      const planWriter = new CaptureWriter()
      expect(await run(['plan', '--json', '--only', 'vercel'], { io: cloud, cwd: dir, writer: planWriter, interactive: false })).toBe(
        ExitCode.ok,
      )
      const plan = planWriter.jsonObjects()[0] as { items: { provider: string }[] }
      expect(plan.items.every((i) => i.provider === 'vercel')).toBe(true)

      const upWriter = new CaptureWriter()
      await run(['up', '--json', '--yes', '--allow-billing', '--skip', 'supabase'], {
        io: cloud,
        cwd: dir,
        writer: upWriter,
        interactive: false,
      })
      expect(JSON.stringify(upWriter.jsonObjects())).not.toContain('PLAN_UNKNOWN_DEPENDENCY')
    })
  })

  describe('BUG-15: doctor failed the Marketplace step that plan showed as done', () => {
    it('verifies a manual step live instead of trusting manualDone alone', async () => {
      const cloud = new FakeCloud({ marketplaceDone: true })
      const t = testContext(manifestFor({}, 'fullstack'), { cloud })
      const reports = await runVerifyAll(t.ctx, t.providers, t.specs)
      const step = reports.find((r) => r.id === 'vercel.marketplace-terms')!
      expect(t.ctx.state.manualDone).toEqual([])
      expect(step.ok).toBe(true)
      expect(step.evidence).toContain('supabase integration installed')
    })
  })
})

describe('BUG-18, found before running up: vercel deploy ran under the two minute exec timeout', () => {
  it('gives the deploy a timeout long enough for a first build', async () => {
    const { DEPLOY_TIMEOUT_MS } = await import('../../src/providers/vercel')
    expect(DEPLOY_TIMEOUT_MS).toBeGreaterThanOrEqual(10 * 60 * 1000)
    const source = readFileSync(join(__dirname, '../../src/providers/vercel/index.ts'), 'utf8')
    expect(source).toMatch(/exec\('vercel', args, \{ cwd: ctx\.cwd, timeoutMs: DEPLOY_TIMEOUT_MS \}\)/)
  })
})

describe('BUG-19 and BUG-20, found in step 4: two person steps reported as failures with the wrong hint', () => {
  it('the Supabase free project limit waits on a person, says the limit is per person, and creates nothing', async () => {
    useFakeTokens()
    const cloud = new FakeCloud({ supabaseFreeLimit: 2 })
    for (const name of ['old-one', 'old-two']) {
      cloud.supabaseProjects.push({ id: `${name.replace('-', '')}ref0000000000`.slice(0, 20), name, organization_id: 'org_fake', region: 'us-east-1', status: 'ACTIVE_HEALTHY' })
    }
    const t = testContext(manifestFor({ accounts: { supabase: 'direct' } }, 'fullstack'), { cloud })
    const result = await runUp(t.ctx, t.providers, t.specs, { onManual: async () => true })
    expect(result.errors).toEqual([])
    expect(result.pendingManual).toContain('supabase.project')
    expect(result.exitCode).toBe(ExitCode.needsHuman)
    expect(cloud.supabaseProjects.map((p) => p.name)).toEqual(['old-one', 'old-two'])
  })

  it('a missing GitHub Login Connection on Vercel waits on a person and names the right page', async () => {
    useFakeTokens()
    const cloud = new FakeCloud({ vercelGithubConnected: false })
    const t = testContext(manifestFor({}, 'designer'), { cloud })
    const events: { id?: string; message?: string; error?: { code: string; hint: string } }[] = []
    const result = await runUp(t.ctx, t.providers, t.specs, { onEvent: (e) => events.push(e) })
    expect(result.errors).toEqual([])
    // Since round four the missing connection is caught up front, by vercel.github-access, before
    // any link attempt. The link step's own error stays as a fallback.
    expect(result.pendingManual).toContain('vercel.github-access')
    const manual = events.find((e) => e.id === 'vercel.github-access' && e.message)!
    expect(manual.message).toContain('https://vercel.com/account/authentication')
  })
})
