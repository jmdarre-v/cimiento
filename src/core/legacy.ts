// State written by 0.1.0 and 0.2.0 has no spec on any entry. Without one, a resource stack.yaml no
// longer selects is invisible to plan and down (BUG-85). Each spec is rebuilt from stack.yaml, or
// from stack.yaml with the old provider put back in its slot; what cannot be rebuilt is reported as
// unresolved legacy, and down exits non zero until it is reconciled (BUG-86).

import { buildProviders, collectSpecs, knownProviderIds } from '../registry'
import type { Manifest } from '../manifest/schema'
import { accountFor } from './orphans'
import type { ProjectState } from './state'
import type { Provider, ResourceSpec } from './types'

export interface LegacyUnresolved {
  id: string
  reason: string
}

export interface LegacyOutcome {
  state: ProjectState
  rebuilt: string[]
  unresolved: LegacyUnresolved[]
}

/** The kinds state stores a spec for; the others describe the machine or are only checks. */
const STORED = new Set<ResourceSpec['kind']>(['resource', 'binding', 'manual'])

/** Ids that are never a resource, whatever wrote them: tools, sessions and checks. */
function machineOrCheck(id: string): boolean {
  return /\.tool\./.test(id) || id.endsWith('.session') || id.includes('.check.')
}

export function upgradeLegacy(manifest: Manifest, state: ProjectState, specs: ResourceSpec[], providers: Provider[]): LegacyOutcome {
  const missing = Object.entries(state.resources).filter(([id, entry]) => !entry.spec && !machineOrCheck(id))
  if (missing.length === 0) return { state, rebuilt: [], unresolved: [] }

  const known = new Map(specs.map((s) => [s.id, s]))
  const variants = new Map<string, Map<string, ResourceSpec>>()
  const resources = { ...state.resources }
  const rebuilt: string[] = []
  const unresolved: LegacyUnresolved[] = []

  for (const [id, entry] of missing) {
    const provider = id.split('.')[0]
    // A binding is named after its host but made by a wiring rule, so every other provider is tried.
    const candidates = [provider, ...knownProviderIds().filter((p) => p !== provider)]
    let spec = known.get(id)
    for (const candidate of candidates) {
      if (spec) break
      spec = variantSpecs(manifest, state, candidate, providers, variants).get(id)
    }
    if (!spec) {
      unresolved.push({ id, reason: `neither stack.yaml nor any provider this build ships, put in its slot, describes ${id}` })
      continue
    }
    // A check, tool or session found this way needs no spec; it is not legacy.
    if (!STORED.has(spec.kind)) continue
    const account = entry.account ?? accountFor(manifest, spec.provider)
    resources[id] = {
      ...entry,
      spec: { kind: spec.kind, provider: spec.provider, dependsOn: [...spec.dependsOn], inputs: { ...spec.inputs } },
      ...(account ? { account } : {}),
    }
    rebuilt.push(id)
  }
  return { state: { ...state, resources }, rebuilt, unresolved }
}

/** The specs a provider stack.yaml no longer selects would have, were it back in its slot. */
function variantSpecs(
  manifest: Manifest,
  state: ProjectState,
  providerId: string,
  selected: Provider[],
  cache: Map<string, Map<string, ResourceSpec>>,
): Map<string, ResourceSpec> {
  const hit = cache.get(providerId)
  if (hit) return hit
  const out = new Map<string, ResourceSpec>()
  cache.set(providerId, out)
  if (selected.some((p) => p.id === providerId)) return out
  const module = buildProviders(manifest, [providerId]).find((p) => p.id === providerId)
  for (const slot of module?.fills ?? []) {
    const variant = { ...manifest, slots: { ...manifest.slots, [slot]: providerId } } as Manifest
    try {
      for (const spec of collectSpecs(variant, state, buildProviders(variant))) if (!out.has(spec.id)) out.set(spec.id, spec)
    } catch {
      // A slot this provider cannot fill with the rest of stack.yaml as it is; try the next.
    }
  }
  return out
}
