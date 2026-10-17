// Spec section 5: ensure is idempotent. The second call with the same inputs returns noop, and
// existing resources are matched by name and account and returned as adopted, never duplicated.

import { describe, expect, it } from 'vitest'
import { runUp } from '../../src/core/executor'
import { OutputResolver } from '../../src/core/resolve'
import { applyEnsureToState, emptyProjectState, type ProjectState } from '../../src/core/state'
import type { Ctx, EnsureResult, Provider, ResourceSpec } from '../../src/core/types'
import { topoSort } from '../../src/core/graph'
import { FakeCloud } from './fake-cloud'
import { manifestFor, testContext, personDoesIt } from './helpers'

/** Applies the whole graph once through ensure, the way the executor does. */
async function ensureAll(
  ctx: Ctx,
  providers: Provider[],
  specs: ResourceSpec[],
  startState: ProjectState,
): Promise<{ state: ProjectState; actions: Map<string, EnsureResult['action']> }> {
  const byProvider = new Map(providers.map((p) => [p.id, p]))
  const actions = new Map<string, EnsureResult['action']>()
  let state = startState
  const resolver = new OutputResolver(state)

  for (const original of topoSort(specs)) {
    const provider = byProvider.get(original.provider)!
    if (original.kind === 'manual') {
      // A person step, not an ensure: done once by the person, and not counted as an action.
      await personDoesIt(original, ctx)
      state = applyEnsureToState(state, original, { action: 'updated' })
      resolver.useState(state)
      continue
    }
    resolver.useState(state)
    const runCtx = { ...ctx, state }
    const { spec, unresolved } = await resolver.resolveWithHydration(original, specs, byProvider, runCtx)
    expect(unresolved, `${original.id} still waits on ${unresolved.join(', ')}`).toEqual([])
    const result = await provider.ensure(spec, runCtx)
    state = applyEnsureToState(state, spec, result)
    resolver.useState(state)
    resolver.record(spec.id, result.outputs, runCtx)
    actions.set(spec.id, result.action)
  }
  return { state, actions }
}

describe('ensure is idempotent', () => {
  it('returns noop for every resource on the second pass, with nothing duplicated', async () => {
    const manifest = manifestFor({}, 'fullstack')
    const cloud = new FakeCloud()
    const t = testContext(manifest, { cloud })

    const first = await ensureAll(t.ctx, t.providers, t.specs, emptyProjectState())
    expect([...first.actions.values()].some((a) => a === 'created')).toBe(true)

    const second = await ensureAll(t.ctx, t.providers, t.specs, first.state)
    const notNoop = [...second.actions.entries()].filter(([id, action]) => action !== 'noop' && id !== 'vercel.marketplace-terms')
    expect(notNoop.map(([id, action]) => `${id}:${action}`)).toEqual([])

    // Nothing was created twice in the fake accounts.
    expect(cloud.repos.size).toBe(1)
    expect(cloud.vercelProjects.size).toBe(1)
    expect(cloud.supabaseProjects.length).toBe(1)
  })

  it('holds for the direct supabase path too', async () => {
    const manifest = manifestFor({ accounts: { supabase: 'direct' } }, 'fullstack')
    const cloud = new FakeCloud()
    const t = testContext(manifest, { cloud })

    const first = await ensureAll(t.ctx, t.providers, t.specs, emptyProjectState())
    expect(first.actions.get('supabase.project')).toBe('created')

    const second = await ensureAll(t.ctx, t.providers, t.specs, first.state)
    expect(second.actions.get('supabase.project')).toBe('noop')
    expect(second.actions.get('vercel.env.NEXT_PUBLIC_SUPABASE_URL.production')).toBe('noop')
    expect(cloud.supabaseProjects.length).toBe(1)
  })

  it('holds for the designer preset, which has no database', async () => {
    const manifest = manifestFor({}, 'designer')
    const cloud = new FakeCloud()
    const t = testContext(manifest, { cloud })
    const first = await ensureAll(t.ctx, t.providers, t.specs, emptyProjectState())
    const second = await ensureAll(t.ctx, t.providers, t.specs, first.state)
    expect([...second.actions.values()].every((a) => a === 'noop')).toBe(true)
  })

  it('a second up produces no receipts that create anything', async () => {
    const manifest = manifestFor({}, 'fullstack')
    const cloud = new FakeCloud()
    const first = testContext(manifest, { cloud })
    const one = await runUp(first.ctx, first.providers, first.specs, { onManual: personDoesIt })
    expect(one.errors).toEqual([])

    const second = testContext(manifest, { cloud, state: one.state, cwd: first.ctx.cwd })
    const two = await runUp(second.ctx, second.providers, second.specs, { onManual: personDoesIt })
    expect(two.errors).toEqual([])
    expect(two.receipts.filter((r) => r.action === 'created' || r.action === 'adopted')).toEqual([])
  })
})

describe('adoption by name', () => {
  it('adopts a repository that already exists instead of creating a second one', async () => {
    const manifest = manifestFor({ accounts: { github: 'test-handle' } }, 'designer')
    const cloud = new FakeCloud()
    cloud.repos.set('test-handle/my-app', {
      id: 'R_existing',
      name: 'my-app',
      owner: 'test-handle',
      url: 'https://github.com/test-handle/my-app',
      visibility: 'private',
      defaultBranch: 'main',
    })
    const t = testContext(manifest, { cloud })
    const result = await ensureAll(t.ctx, t.providers, t.specs, emptyProjectState())

    expect(result.actions.get('github.repo')).toBe('adopted')
    expect(result.state.resources['github.repo'].externalId).toBe('R_existing')
    expect(cloud.repos.size).toBe(1)
    expect(cloud.execCalls.filter((c) => c.startsWith('gh repo create'))).toEqual([])
  })

  it('adopts a hosting project that already exists under the same name', async () => {
    const manifest = manifestFor({}, 'designer')
    const cloud = new FakeCloud()
    cloud.vercelProjects.set('prj_existing', {
      id: 'prj_existing',
      name: 'my-app',
      accountId: 'team_fake',
      framework: 'nextjs',
      link: null,
      productionAlias: null,
    })
    const t = testContext(manifest, { cloud })
    const result = await ensureAll(t.ctx, t.providers, t.specs, emptyProjectState())

    expect(result.actions.get('vercel.project')).toBe('adopted')
    expect(result.state.resources['vercel.project'].externalId).toBe('prj_existing')
    expect(cloud.vercelProjects.size).toBe(1)
  })

  it('adopts a supabase project that already exists on the direct path', async () => {
    const manifest = manifestFor({ accounts: { supabase: 'direct' } }, 'fullstack')
    const cloud = new FakeCloud()
    cloud.supabaseProjects.push({
      id: 'sbref_existing',
      name: 'my-app',
      organization_id: 'org_fake',
      region: 'us-east-1',
      status: 'ACTIVE_HEALTHY',
    })
    cloud.supabaseAuth.set('sbref_existing', { site_url: '', uri_allow_list: '' })
    const t = testContext(manifest, { cloud })
    const result = await ensureAll(t.ctx, t.providers, t.specs, emptyProjectState())

    expect(result.actions.get('supabase.project')).toBe('adopted')
    expect(cloud.supabaseProjects.length).toBe(1)
  })

  it('an adopted resource reports noop on the run after it', async () => {
    const manifest = manifestFor({ accounts: { github: 'test-handle' } }, 'designer')
    const cloud = new FakeCloud()
    cloud.repos.set('test-handle/my-app', {
      id: 'R_existing',
      name: 'my-app',
      owner: 'test-handle',
      url: 'https://github.com/test-handle/my-app',
      visibility: 'private',
      defaultBranch: 'main',
    })
    const t = testContext(manifest, { cloud })
    const first = await ensureAll(t.ctx, t.providers, t.specs, emptyProjectState())
    const second = await ensureAll(t.ctx, t.providers, t.specs, first.state)
    expect(second.actions.get('github.repo')).toBe('noop')
  })
})
