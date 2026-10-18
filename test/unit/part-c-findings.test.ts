// Regression tests for the third round of Goal 1 findings: changing a pinned account, the
// Supabase free project limit step, the billing wording under --allow-billing, and what down does
// with a Supabase organization cimiento created. Each test fails against commit 416abe4.

import { readFileSync, writeFileSync } from 'node:fs'
import { join } from 'node:path'
import { afterEach, beforeEach, describe, expect, it } from 'vitest'
import { run } from '../../src/cli/index'
import { ExitCode } from '../../src/core/errors'
import { runUp } from '../../src/core/executor'
import { emptyProjectState, readProjectState } from '../../src/core/state'
import { renderManifest } from '../../src/manifest'
import { reconcilePins } from '../../src/manifest/pin'
import { SUPABASE_CAN_DELETE_ORGANIZATIONS } from '../../src/providers/supabase'
import { FakeCloud } from './fake-cloud'
import { CaptureWriter, manifestForShared as manifestFor, removeDir, tempDir, testContext, useFakeTokens } from './helpers'

const ORGS = [
  { id: 'org_a', name: 'Alpha', plan: 'free' },
  { id: 'org_b', name: 'Beta', plan: 'free' },
  { id: 'org_paid', name: 'Paid', plan: 'pro' },
]

function projectDir(overrides: Parameters<typeof manifestFor>[0] = {}): string {
  const dir = tempDir('cimiento-partc-')
  const manifest = manifestFor(
    { name: 'cimiento-test-1', accounts: { supabase: 'direct' }, options: { supabase: { organization_id: 'org_a' } }, ...overrides },
    'fullstack',
  )
  writeFileSync(join(dir, 'stack.yaml'), renderManifest(manifest))
  return dir
}

function stack(dir: string): string {
  return readFileSync(join(dir, 'stack.yaml'), 'utf8')
}

function lastJson(writer: CaptureWriter, command: string): Record<string, unknown> {
  return writer.jsonObjects().filter((o) => (o as { command?: string }).command === command).pop() as Record<string, unknown>
}

/** Two active projects in free organizations: the person is at Supabase's limit. */
function atFreeLimit(cloud: FakeCloud): void {
  cloud.supabaseProjects.push(
    { id: 'oldonerefaaaaaaaaaaa', name: 'old-one', organization_id: 'org_a', region: 'us-east-1', status: 'ACTIVE_HEALTHY', lastRequest: '2026-09-24' },
    { id: 'oldtworefaaaaaaaaaaa', name: 'old-two', organization_id: 'org_b', region: 'us-east-1', status: 'ACTIVE_HEALTHY' },
  )
}

describe('Part B findings, round three', () => {
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

  describe('BUG-21: a pinned account could not be changed, and state kept its own copy', () => {
    it('accounts set supabase --to re-pins in stack.yaml and state, overwriting the old value', async () => {
      const cloud = new FakeCloud({ supabaseOrganizations: ORGS })
      const dir = projectDir()
      dirs.push(dir)
      await run(['up', '--json', '--yes', '--allow-billing', '--only', 'supabase'], { io: cloud, cwd: dir, writer: new CaptureWriter(), interactive: false })
      expect(readProjectState(dir).resources['supabase.session'].outputs?.organizationId).toBe('org_a')

      const writer = new CaptureWriter()
      const code = await run(['accounts', 'set', 'supabase', '--to', 'org_b', '--json'], { io: cloud, cwd: dir, writer, interactive: false })
      expect(code).toBe(ExitCode.ok)
      expect(lastJson(writer, 'accounts set')).toMatchObject({ provider: 'supabase', previous: 'org_a', value: 'org_b' })
      expect(stack(dir)).toMatch(/organization_id: org_b/)
      const session = readProjectState(dir).resources['supabase.session']
      expect(session.outputs?.organizationId).toBe('org_b')
      expect(session.externalId).toBe('org_b')
    })

    it('asks again in a terminal even with a single free organization, and offers creating one', async () => {
      const cloud = new FakeCloud({ supabaseOrganizations: [{ id: 'org_a', name: 'Alpha', plan: 'free' }] })
      const dir = projectDir()
      dirs.push(dir)
      let offered: string[] = []
      const code = await run(['accounts', 'set', 'supabase'], {
        io: cloud,
        cwd: dir,
        writer: new CaptureWriter(),
        interactive: true,
        choose: async (_question, options) => {
          offered = options.map((o) => o.label)
          return options[options.length - 1].value
        },
        ask: async (_question, defaultValue) => defaultValue ?? '',
      })
      expect(code).toBe(ExitCode.ok)
      expect(offered[0]).toBe('Alpha, free plan')
      expect(offered[1]).toContain('Create a new organization')
      const created = cloud.supabaseOrganizations.find((o) => o.name === 'cimiento-test-1')!
      expect(stack(dir)).toContain(`organization_id: ${created.id}`)
      expect(readProjectState(dir).resources['supabase.session']?.outputs?.createdOrganizationId).toBe(created.id)
    })

    it('without a terminal and without --to, waits on a person instead of guessing', async () => {
      const cloud = new FakeCloud({ supabaseOrganizations: ORGS })
      const dir = projectDir()
      dirs.push(dir)
      const writer = new CaptureWriter()
      const code = await run(['accounts', 'set', 'supabase', '--json'], { io: cloud, cwd: dir, writer, interactive: false })
      expect(code).toBe(ExitCode.needsHuman)
      expect((writer.jsonObjects()[0] as { error: { code: string } }).error.code).toBe('ACCOUNT_CHOICE_NEEDED')
      expect(stack(dir)).toMatch(/organization_id: org_a/)
    })

    it('refuses an organization this login cannot see', async () => {
      const cloud = new FakeCloud({ supabaseOrganizations: ORGS })
      const dir = projectDir()
      dirs.push(dir)
      const code = await run(['accounts', 'set', 'supabase', '--to', 'org_nope', '--json'], { io: cloud, cwd: dir, writer: new CaptureWriter(), interactive: false })
      expect(code).toBe(ExitCode.needsHuman)
      expect(stack(dir)).toMatch(/organization_id: org_a/)
    })

    it('accounts set vercel re-pins the team; accounts set github follows the logged-in account', async () => {
      const cloud = new FakeCloud({
        vercelTeams: [
          { id: 'team_fake', slug: 'fake-team', name: 'Fake Team' },
          { id: 'team_other', slug: 'other', name: 'Other' },
        ],
      })
      const dir = projectDir({ accounts: { supabase: 'direct', vercel: 'team_fake', github: 'someone-old' } })
      dirs.push(dir)
      expect(await run(['accounts', 'set', 'vercel', '--to', 'other', '--json'], { io: cloud, cwd: dir, writer: new CaptureWriter(), interactive: false })).toBe(ExitCode.ok)
      expect(stack(dir)).toMatch(/vercel: team_other/)
      expect(await run(['accounts', 'set', 'github', '--json'], { io: cloud, cwd: dir, writer: new CaptureWriter(), interactive: false })).toBe(ExitCode.ok)
      expect(stack(dir)).toMatch(/github: test-handle/)
      const mismatch = await run(['accounts', 'set', 'github', '--to', 'someone-else', '--json'], { io: cloud, cwd: dir, writer: new CaptureWriter(), interactive: false })
      expect(mismatch).toBe(ExitCode.needsHuman)
    })

    it('state follows stack.yaml: a pin removed by hand is removed from state, not silently reused', () => {
      const withPin = manifestFor({ options: { supabase: { organization_id: 'org_a' } } }, 'fullstack')
      const withoutPin = manifestFor({}, 'fullstack')
      const state = {
        ...emptyProjectState(),
        resources: { 'supabase.session': { externalId: 'org_a', outputs: { organizationId: 'org_a' } } },
      }
      expect(reconcilePins(withPin, state)).toEqual(state)
      const next = reconcilePins(withoutPin, state)
      expect(next.resources['supabase.session'].outputs?.organizationId).toBeUndefined()
      expect(next.resources['supabase.session'].externalId).toBeUndefined()
    })

    it('after removing the organization from stack.yaml, up asks again instead of using the old one', async () => {
      const cloud = new FakeCloud({ supabaseOrganizations: ORGS })
      const dir = projectDir()
      dirs.push(dir)
      await run(['up', '--json', '--yes', '--allow-billing', '--only', 'supabase'], { io: cloud, cwd: dir, writer: new CaptureWriter(), interactive: false })
      writeFileSync(join(dir, 'stack.yaml'), stack(dir).replace(/\n\s*organization_id: org_a/, ''))
      const writer = new CaptureWriter()
      const code = await run(['up', '--json', '--yes', '--allow-billing', '--only', 'supabase'], { io: cloud, cwd: dir, writer, interactive: false })
      expect(code).toBe(ExitCode.needsHuman)
      expect(lastJson(writer, 'up').pendingManual).toContain('supabase.session')
      expect(readProjectState(dir).resources['supabase.session'].outputs?.organizationId).toBeUndefined()
    })
  })

  describe('BUG-22: the free project limit step did not show which projects count or how to continue', () => {
    it('without a terminal, lists the projects with last activity and both ways forward, and touches none', async () => {
      const cloud = new FakeCloud({ supabaseOrganizations: ORGS, supabaseFreeLimit: 2 })
      atFreeLimit(cloud)
      const t = testContext(manifestFor({ accounts: { supabase: 'direct' }, options: { supabase: { organization_id: 'org_a' } } }, 'fullstack'), { cloud })
      const events: { id?: string; error?: { code: string; message: string; hint: string } }[] = []
      const result = await runUp(t.ctx, t.providers, t.specs, { onEvent: (e) => events.push(e) })
      expect(result.pendingManual).toContain('supabase.project')
      const step = events.find((e) => e.id === 'supabase.project' && e.error)!.error!
      expect(step.code).toBe('SUPABASE_FREE_PROJECT_LIMIT')
      expect(step.message).toContain('old-one (oldonerefaaaaaaaaaaa) in Alpha, last API request 2026-09-24')
      expect(step.message).toContain('old-two (oldtworefaaaaaaaaaaa) in Beta, no API requests in the last 7 days')
      expect(step.hint).toContain('cimiento never pauses or deletes a project it did not create')
      expect(step.hint).toContain('paid-plan or new organization')
      expect(step.hint).toContain('billed')
      expect(cloud.httpCalls.filter((c) => c.includes('/pause') || (c.startsWith('DELETE') && c.includes('/v1/projects/')))).toEqual([])
    })

    it('in a terminal, freeing a slot opens the dashboard, re-checks on Enter, and continues', async () => {
      const cloud = new FakeCloud({ supabaseOrganizations: ORGS, supabaseFreeLimit: 2 })
      atFreeLimit(cloud)
      const t = testContext(manifestFor({ accounts: { supabase: 'direct' }, options: { supabase: { organization_id: 'org_a' } } }, 'fullstack'), { cloud })
      t.ctx.interactive = true
      const opened: string[] = []
      const choices: string[] = []
      t.ctx.openUrl = async (url) => {
        opened.push(url)
      }
      t.ctx.choose = async (question, options) => {
        choices.push(options.map((o) => o.value).join(','))
        expect(question).toContain('old-one')
        return 'free'
      }
      t.ctx.ask = async () => {
        // The person pauses old-two in the dashboard, then presses Enter.
        cloud.supabaseProjects.find((p) => p.name === 'old-two')!.status = 'INACTIVE'
        return ''
      }
      const result = await runUp(t.ctx, t.providers, t.specs, { onManual: async () => true })
      expect(opened).toEqual(['https://supabase.com/dashboard/projects'])
      expect(choices).toEqual(['free,org,stop'])
      expect(result.errors).toEqual([])
      expect(result.state.resources['supabase.project'].origin).toBe('created')
    })

    it('in a terminal, picking a paid-plan organization re-pins it and creates the database there', async () => {
      const cloud = new FakeCloud({ supabaseOrganizations: ORGS, supabaseFreeLimit: 2 })
      atFreeLimit(cloud)
      const dir = projectDir()
      dirs.push(dir)
      const warnings: string[] = []
      const code = await run(['up', '--yes', '--allow-billing', '--only', 'supabase'], {
        io: cloud,
        cwd: dir,
        writer: new CaptureWriter(),
        interactive: true,
        choose: async (question, options) => {
          for (const o of options) if (o.warning) warnings.push(o.warning)
          if (question.includes('How do you want to continue')) return 'org'
          return 'org_paid'
        },
      })
      // --only supabase leaves the auth URLs blocked on the filtered deployment, so not exit 0.
      expect(code).not.toBe(ExitCode.failed)
      expect(stack(dir)).toMatch(/organization_id: org_paid/)
      expect(cloud.supabaseProjects.find((p) => p.name === 'cimiento-test-1')?.organization_id).toBe('org_paid')
      expect(warnings.some((w) => w.includes('billed to that organization'))).toBe(true)
    })
  })

  describe('BUG-23: the billing warning asked for --allow-billing on a run that already had it', () => {
    it('says approved when the flag is present, and asks when it is not', async () => {
      const cloud = new FakeCloud({ supabaseOrganizations: ORGS })
      const dir = projectDir()
      dirs.push(dir)
      const withFlag = new CaptureWriter()
      await run(['plan', '--json', '--allow-billing'], { io: cloud, cwd: dir, writer: withFlag, interactive: false })
      const approved = (withFlag.jsonObjects()[0] as { warnings: string[] }).warnings.filter((w) => w.includes(' bills to '))
      expect(approved).toEqual([
        'supabase.project bills to Supabase organization Alpha, free plan: no charge unless you go over the plan limits. Approved for this run with --allow-billing.',
      ])

      const without = new CaptureWriter()
      await run(['plan', '--json'], { io: cloud, cwd: dir, writer: without, interactive: false })
      expect((without.jsonObjects()[0] as { warnings: string[] }).warnings[0]).toMatch(/Approve it with --allow-billing\.$/)
    })

    it('up with the flag prints the approved wording in expert mode', async () => {
      const cloud = new FakeCloud({ supabaseOrganizations: ORGS })
      const dir = projectDir()
      dirs.push(dir)
      const writer = new CaptureWriter()
      await run(['up', '--allow-billing'], {
        io: cloud,
        cwd: dir,
        writer,
        interactive: true,
        onManual: async () => true,
        ask: async (question) => (question.includes('[y/N]') ? 'y' : ''),
      })
      expect(writer.outText).toContain('Approved for this run with --allow-billing.')
      expect(writer.outText).not.toContain('Approve it with --allow-billing')
    })
  })

  describe('BUG-24: down did not account for a Supabase organization cimiento created', () => {
    it('the Supabase API has no way to delete an organization, so the code does not try', () => {
      expect(SUPABASE_CAN_DELETE_ORGANIZATIONS).toBe(false)
    })

    it('lists the organization as a leftover with its dashboard link, until it is gone', async () => {
      const cloud = new FakeCloud({ supabaseOrganizations: [{ id: 'org_a', name: 'Alpha', plan: 'free' }], ghDeleteScope: true, inngestInstalled: true })
      const dir = projectDir({ options: {} })
      dirs.push(dir)
      await run(['accounts', 'set', 'supabase'], {
        io: cloud,
        cwd: dir,
        writer: new CaptureWriter(),
        interactive: true,
        choose: async (_q, options) => options[options.length - 1].value,
        ask: async (_q, d) => d ?? '',
      })
      const org = cloud.supabaseOrganizations.find((o) => o.name === 'cimiento-test-1')!
      expect(await run(['up', '--json', '--yes', '--allow-billing'], { io: cloud, cwd: dir, writer: new CaptureWriter(), interactive: false })).toBe(ExitCode.ok)

      const writer = new CaptureWriter()
      expect(await run(['down', '--yes', '--json'], { io: cloud, cwd: dir, writer, interactive: false })).toBe(ExitCode.ok)
      const summary = lastJson(writer, 'down') as { destroyed: string[]; leftovers: { id: string; url: string; code: string; provider: string }[] }
      expect(summary.destroyed).toContain('supabase.project')
      expect(summary.leftovers.filter((l) => l.provider === 'supabase')).toEqual([
        expect.objectContaining({ id: org.id, code: 'DOWN_LEFTOVER', url: `https://supabase.com/dashboard/org/${org.id}/general` }),
      ])
      expect(cloud.supabaseOrganizations.some((o) => o.id === org.id)).toBe(true)

      // Still reported by the next down, and forgotten once the person deletes it.
      const again = new CaptureWriter()
      await run(['down', '--yes', '--json'], { io: cloud, cwd: dir, writer: again, interactive: false })
      expect(JSON.stringify(again.jsonObjects())).toContain(org.id)
      cloud.deleteOrganization(org.id)
      const after = new CaptureWriter()
      await run(['down', '--yes', '--json'], { io: cloud, cwd: dir, writer: after, interactive: false })
      expect(JSON.stringify(after.jsonObjects())).not.toContain(org.id)
    })

    it('an organization cimiento did not create is never reported as a leftover', async () => {
      const cloud = new FakeCloud({ supabaseOrganizations: ORGS, ghDeleteScope: true })
      const dir = projectDir()
      dirs.push(dir)
      await run(['up', '--json', '--yes', '--allow-billing'], { io: cloud, cwd: dir, writer: new CaptureWriter(), interactive: false })
      const writer = new CaptureWriter()
      await run(['down', '--yes', '--json'], { io: cloud, cwd: dir, writer, interactive: false })
      expect((lastJson(writer, 'down') as { leftovers: unknown[] }).leftovers).toEqual([])
    })
  })
})
