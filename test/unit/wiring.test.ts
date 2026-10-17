// Spec section 6: rules are attached to a pair of providers, and only apply when both halves of
// the pair are selected.

import { describe, expect, it } from 'vitest'
import { emptyProjectState, hashManifest, isStale, outputFromState, applyEnsureToState } from '../../src/core/state'
import { activeRules } from '../../src/wiring'
import { collectSpecs, buildProviders } from '../../src/registry'
import { manifestFor } from './helpers'

function specsFor(manifest: ReturnType<typeof manifestFor>) {
  return collectSpecs(manifest, emptyProjectState(), buildProviders(manifest))
}

describe('wiring rules', () => {
  it('applies nothing when only one half of a pair is selected', () => {
    const repoOnly = manifestFor({ slots: { repo: 'github' } })
    expect(activeRules(repoOnly)).toEqual([])
    expect(specsFor(repoOnly).map((s) => s.id)).not.toContain('vercel.binding.git-repo')
  })

  it('links the hosting project to the repository when both are selected', () => {
    const manifest = manifestFor({}, 'designer')
    const specs = specsFor(manifest)
    const link = specs.find((s) => s.id === 'vercel.binding.git-repo')!
    expect(link.provider).toBe('vercel')
    expect(link.inputs.repo).toEqual({ deferred: 'github.repo:fullName' })
    expect(link.inputs.productionBranch).toBe('main')
    expect(specs.map((s) => s.id)).toContain('vercel.check.repo-linked')
  })

  it('makes the first deployment wait for the repository link', () => {
    const specs = specsFor(manifestFor({}, 'designer'))
    const deployment = specs.find((s) => s.id === 'vercel.deployment')!
    expect(deployment.dependsOn).toContain('vercel.binding.git-repo')
  })

  it('adds the Marketplace terms and the install on the via-hosting path only', () => {
    const viaHosting = specsFor(manifestFor({}, 'fullstack')).map((s) => s.id)
    expect(viaHosting).toContain('vercel.marketplace-terms')
    expect(viaHosting).toContain('vercel.binding.supabase-install')
    expect(viaHosting).not.toContain('vercel.env.NEXT_PUBLIC_SUPABASE_URL.production')

    const direct = specsFor(manifestFor({ accounts: { supabase: 'direct' } }, 'fullstack')).map((s) => s.id)
    expect(direct).not.toContain('vercel.marketplace-terms')
    expect(direct).toContain('vercel.env.NEXT_PUBLIC_SUPABASE_URL.production')
    expect(direct).toContain('vercel.env.SUPABASE_SERVICE_ROLE_KEY.production')
  })

  it('pushes the supabase keys to every declared environment on the direct path', () => {
    const manifest = manifestFor({ accounts: { supabase: 'direct' }, environments: ['preview', 'production'] }, 'fullstack')
    const ids = specsFor(manifest)
      .map((s) => s.id)
      .filter((id) => id.startsWith('vercel.env.NEXT_PUBLIC_SUPABASE_ANON_KEY.'))
    expect(ids.sort()).toEqual([
      'vercel.env.NEXT_PUBLIC_SUPABASE_ANON_KEY.preview',
      'vercel.env.NEXT_PUBLIC_SUPABASE_ANON_KEY.production',
    ])
  })

  it('makes the auth URLs follow the production URL, deferred until the first deploy', () => {
    const authUrls = specsFor(manifestFor({}, 'fullstack')).find((s) => s.id === 'supabase.binding.auth-urls')!
    expect(authUrls.provider).toBe('supabase')
    expect(authUrls.inputs.siteUrl).toEqual({ deferred: 'vercel.deployment:productionUrl' })
    expect(authUrls.inputs.previewPattern).toBe('https://my-app-*.vercel.app/**')
  })

  it('uses the custom domain for the auth URLs when stack.yaml declares one', () => {
    const manifest = manifestFor({ domain: 'example.com' }, 'fullstack')
    const authUrls = specsFor(manifest).find((s) => s.id === 'supabase.binding.auth-urls')!
    expect(authUrls.inputs.siteUrl).toBe('https://example.com')
  })

  it('never emits the same resource id twice', () => {
    const ids = specsFor(manifestFor({}, 'fullstack')).map((s) => s.id)
    expect(ids.length).toBe(new Set(ids).size)
  })
})

describe('state', () => {
  it('reads a non secret output back by reference', () => {
    const state = applyEnsureToState(emptyProjectState(), { id: 'a', kind: 'resource', provider: 'p', dependsOn: [], inputs: {} }, {
      action: 'created',
      externalId: 'ext_1',
      url: 'https://example.com',
      outputs: { branch: { value: 'main', secret: false } },
    })
    expect(outputFromState(state, 'a:branch')).toBe('main')
    expect(outputFromState(state, 'a:url')).toBe('https://example.com')
    expect(outputFromState(state, 'a:externalId')).toBe('ext_1')
    expect(outputFromState(state, 'a:missing')).toBeUndefined()
    expect(outputFromState(state, 'ghost:branch')).toBeUndefined()
  })

  it('treats a resource never verified, or verified long ago, as stale', () => {
    expect(isStale(undefined)).toBe(true)
    expect(isStale({ verifiedAt: new Date().toISOString() })).toBe(false)
    const eightDaysAgo = new Date(Date.now() - 8 * 24 * 60 * 60 * 1000).toISOString()
    expect(isStale({ verifiedAt: eightDaysAgo })).toBe(true)
  })

  it('hashes a manifest deterministically so up can tell when it changed', () => {
    expect(hashManifest('a')).toBe(hashManifest('a'))
    expect(hashManifest('a')).not.toBe(hashManifest('b'))
    expect(hashManifest('a')).toMatch(/^[0-9a-f]{64}$/)
  })

  it('records a manual step in manualDone the first time and does not duplicate it', () => {
    const spec = { id: 'm', kind: 'manual' as const, provider: 'p', dependsOn: [], inputs: {} }
    const once = applyEnsureToState(emptyProjectState(), spec, { action: 'updated' })
    const twice = applyEnsureToState(once, spec, { action: 'updated' })
    expect(twice.manualDone).toEqual(['m'])
  })
})
