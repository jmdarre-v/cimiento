import { describe, expect, it } from 'vitest'
import { CimientoError } from '../../src/core/errors'
import { runUp } from '../../src/core/executor'
import { dependenciesOf, topoSort } from '../../src/core/graph'
import { buildPlan } from '../../src/core/planner'
import { emptyProjectState } from '../../src/core/state'
import type { ResourceSpec } from '../../src/core/types'
import { FakeCloud } from './fake-cloud'
import { manifestFor, testContext, personDoesIt } from './helpers'

function spec(id: string, overrides: Partial<ResourceSpec> = {}): ResourceSpec {
  return { id, kind: 'resource', provider: 'github', dependsOn: [], inputs: {}, ...overrides }
}

describe('dependency graph', () => {
  it('derives an edge from a deferred value, not only from dependsOn', () => {
    const consumer = spec('b', { inputs: { url: { deferred: 'a:productionUrl' } } })
    expect(dependenciesOf(consumer)).toEqual(['a'])
  })

  it('merges explicit and deferred dependencies without duplicating', () => {
    const consumer = spec('b', { dependsOn: ['a'], inputs: { url: { deferred: 'a:productionUrl' } } })
    expect(dependenciesOf(consumer)).toEqual(['a'])
  })

  it('orders producers before consumers', () => {
    const sorted = topoSort([
      spec('c', { dependsOn: ['b'] }),
      spec('a'),
      spec('b', { inputs: { from: { deferred: 'a:value' } } }),
    ])
    expect(sorted.map((s) => s.id)).toEqual(['a', 'b', 'c'])
  })

  it('is deterministic across runs with independent items', () => {
    const items = [spec('z'), spec('m'), spec('a')]
    expect(topoSort(items).map((s) => s.id)).toEqual(topoSort([...items].reverse()).map((s) => s.id))
  })

  it('reports a cycle as PLAN_CYCLE rather than hanging', () => {
    try {
      topoSort([spec('a', { dependsOn: ['b'] }), spec('b', { dependsOn: ['a'] })])
      expect.unreachable('should have thrown')
    } catch (err) {
      expect((err as CimientoError).code).toBe('PLAN_CYCLE')
      expect((err as CimientoError).message).toContain('->')
    }
  })

  it('reports a dependency nothing produces as PLAN_UNKNOWN_DEPENDENCY', () => {
    try {
      topoSort([spec('a', { dependsOn: ['ghost'] })])
      expect.unreachable('should have thrown')
    } catch (err) {
      expect((err as CimientoError).code).toBe('PLAN_UNKNOWN_DEPENDENCY')
    }
  })
})

describe('plan statuses', () => {
  it('puts tools and sessions before the resources that need them', async () => {
    const manifest = manifestFor({}, 'fullstack')
    const t = testContext(manifest)
    const plan = await buildPlan({ ...t.ctx, dryRun: true }, t.providers, t.specs)
    const order = plan.items.map((i) => i.id)
    expect(order.indexOf('github.tool.gh')).toBeLessThan(order.indexOf('github.session'))
    expect(order.indexOf('github.session')).toBeLessThan(order.indexOf('github.repo'))
    expect(order.indexOf('vercel.project')).toBeLessThan(order.indexOf('vercel.deployment'))
    expect(order.indexOf('vercel.deployment')).toBeLessThan(order.indexOf('vercel.check.deployed'))
  })

  it('marks a resource that needs a deferred value as blocked, naming what it waits on', async () => {
    const manifest = manifestFor({}, 'fullstack')
    const t = testContext(manifest)
    const plan = await buildPlan({ ...t.ctx, dryRun: true }, t.providers, t.specs)
    const check = plan.items.find((i) => i.id === 'vercel.check.deployed')!
    expect(check.status).toBe('blocked')
    expect(check.blockedBy).toContain('vercel.deployment')

    const authUrls = plan.items.find((i) => i.id === 'supabase.binding.auth-urls')!
    expect(authUrls.status).toBe('blocked')
  })

  it('marks the Marketplace terms as needs-human on a fresh project', async () => {
    const manifest = manifestFor({}, 'fullstack')
    const t = testContext(manifest)
    const plan = await buildPlan({ ...t.ctx, dryRun: true }, t.providers, t.specs)
    const manual = plan.items.find((i) => i.id === 'vercel.marketplace-terms')!
    expect(manual.status).toBe('needs-human')
    expect(manual.manual?.url).toContain('vercel.com/marketplace/supabase')
  })

  it('BUG-75: a manual step recorded in manualDone is still probed live; history alone is not done', async () => {
    const manifest = manifestFor({}, 'fullstack')
    const state = { ...emptyProjectState(), manualDone: ['vercel.marketplace-terms'] }
    const t = testContext(manifest, { state })
    const plan = await buildPlan({ ...t.ctx, dryRun: true }, t.providers, t.specs)
    expect(plan.items.find((i) => i.id === 'vercel.marketplace-terms')!.status).toBe('needs-human')
  })

  it('warns about billable creates and counts them in the summary', async () => {
    const manifest = manifestFor({}, 'fullstack')
    const t = testContext(manifest)
    const plan = await buildPlan({ ...t.ctx, dryRun: true }, t.providers, t.specs)
    expect(plan.warnings.join(' ')).toContain('bills to')
    expect(plan.summary.create + plan.summary.blocked + plan.summary['needs-human']).toBeGreaterThan(0)
  })

  it('re-plans clean after an up, with every item noop', async () => {
    const manifest = manifestFor({}, 'fullstack')
    const cloud = new FakeCloud()
    const first = testContext(manifest, { cloud })
    const result = await runUp(first.ctx, first.providers, first.specs, { onManual: personDoesIt })
    expect(result.errors).toEqual([])

    // The same project folder: the first up wrote the baseline migration into it.
    const second = testContext(manifest, { cloud, state: result.state, cwd: first.ctx.cwd })
    const plan = await buildPlan({ ...second.ctx, dryRun: true }, second.providers, second.specs)
    const notNoop = plan.items.filter((i) => i.status !== 'noop')
    expect(notNoop.map((i) => `${i.id}:${i.status}`)).toEqual([])
  })
})

describe('multi pass execution', () => {
  it('resolves the production URL in a later pass and finishes every item', async () => {
    const manifest = manifestFor({}, 'fullstack')
    const t = testContext(manifest)
    const result = await runUp(t.ctx, t.providers, t.specs, { onManual: personDoesIt })
    expect(result.errors).toEqual([])
    expect(result.blocked).toEqual([])
    expect(result.pendingManual).toEqual([])
    const authUrls = result.state.resources['supabase.binding.auth-urls']
    expect(authUrls?.outputs?.siteUrl).toMatch(/^https:\/\//)
  })

  it('stops at a manual step when nobody is there to confirm it', async () => {
    const manifest = manifestFor({}, 'fullstack')
    const t = testContext(manifest)
    const result = await runUp(t.ctx, t.providers, t.specs, { onManual: async () => false })
    expect(result.pendingManual).toContain('vercel.marketplace-terms')
    expect(result.exitCode).toBe(2)
    expect(result.errors).toEqual([])
  })
})
