// Resources in state that stack.yaml no longer selects: a slot removed, or filled by another
// provider. State keeps the spec each one was made with, so plan can show it, up can ask what to
// do with it, and down can still destroy it (BUG-74).

import type { Manifest } from '../manifest/schema'
import type { ProjectState } from './state'
import type { ResourceSpec } from './types'

/** Where each provider's account is pinned in stack.yaml. */
const ACCOUNT_KEYS: Record<string, keyof Manifest['accounts']> = {
  github: 'github',
  vercel: 'vercel',
  netlify: 'netlify',
  neon: 'neon',
  turnstile: 'cloudflare',
}

export function accountFor(m: Manifest, provider: string): string | undefined {
  const key = ACCOUNT_KEYS[provider]
  const value = key ? m.accounts[key] : undefined
  return typeof value === 'string' && value !== 'via-hosting' && value !== 'direct' ? value : undefined
}

/** Every spec state recorded whose id the current specs do not have. */
export function orphanSpecs(state: ProjectState, specs: ResourceSpec[]): ResourceSpec[] {
  const current = new Set(specs.map((s) => s.id))
  const out: ResourceSpec[] = []
  for (const [id, entry] of Object.entries(state.resources)) {
    if (current.has(id) || !entry.spec) continue
    out.push({ id, kind: entry.spec.kind, provider: entry.spec.provider, dependsOn: [...entry.spec.dependsOn], inputs: { ...entry.spec.inputs } })
  }
  return out
}

/** The orphaned resources up has to ask about: everything not already kept on purpose. */
export function undecidedOrphans(state: ProjectState, specs: ResourceSpec[]): ResourceSpec[] {
  return orphanSpecs(state, specs).filter((s) => s.kind === 'resource' && !state.resources[s.id]?.retained)
}

/** The manifest a provider should act in for an orphan: the account it was made in. */
export function manifestForOrphan(m: Manifest, provider: string, account: string | undefined): Manifest {
  const key = ACCOUNT_KEYS[provider]
  if (!key || !account) return m
  return { ...m, accounts: { ...m.accounts, [key]: account } }
}

/** Takes ids out of every stored spec's dependencies, after those resources left the project. */
export function dropFromStoredSpecs(state: ProjectState, ids: string[]): ProjectState {
  const gone = new Set(ids)
  const resources = { ...state.resources }
  for (const [id, entry] of Object.entries(resources)) {
    if (!entry.spec || !entry.spec.dependsOn.some((d) => gone.has(d))) continue
    resources[id] = { ...entry, spec: { ...entry.spec, dependsOn: entry.spec.dependsOn.filter((d) => !gone.has(d)) } }
  }
  return { ...state, resources }
}

