// Dependency graph over ResourceSpec, built from dependsOn plus every deferred value reference.

import { CimientoError } from './errors'
import { splitRef } from './state'
import { isDeferred, type ResourceSpec } from './types'

/** Resource ids this spec waits on: explicit dependsOn plus the producers of its deferred inputs. */
export function dependenciesOf(spec: ResourceSpec): string[] {
  const deps = new Set(spec.dependsOn)
  for (const value of Object.values(spec.inputs)) {
    if (!isDeferred(value)) continue
    deps.add(splitRef(value.deferred)[0])
  }
  return [...deps]
}

/** The deferred references this spec still needs resolved. */
export function deferredRefs(spec: ResourceSpec): string[] {
  const refs: string[] = []
  for (const value of Object.values(spec.inputs)) {
    if (isDeferred(value)) refs.push(value.deferred)
  }
  return refs
}

/**
 * Deterministic topological order. Ties break on id so two runs over the same manifest
 * always produce the same plan.
 */
export function topoSort(specs: ResourceSpec[], options: { allowExternal?: boolean } = {}): ResourceSpec[] {
  const byId = new Map(specs.map((s) => [s.id, s]))
  for (const spec of specs) {
    for (const dep of dependenciesOf(spec)) {
      if (byId.has(dep)) continue
      // With --only or --skip, a kept step may wait on a provider that was filtered out. Its
      // values come from state, and it is simply not ordered against it.
      if (options.allowExternal) continue
      throw new CimientoError({
        code: 'PLAN_UNKNOWN_DEPENDENCY',
        provider: spec.provider,
        resource: spec.id,
        message: `${spec.id} depends on ${dep}, which no provider or wiring rule produces.`,
        hint: 'This is a bug in a provider or wiring rule. Run cimiento plan --json and open an issue with the output.',
        retryable: false,
        needsHuman: true,
      })
    }
  }

  const sorted: ResourceSpec[] = []
  const permanent = new Set<string>()
  const temporary = new Set<string>()
  const ordered = [...specs].sort((a, b) => a.id.localeCompare(b.id))

  const visit = (spec: ResourceSpec, trail: string[]): void => {
    if (permanent.has(spec.id)) return
    if (temporary.has(spec.id)) {
      const cycle = [...trail.slice(trail.indexOf(spec.id)), spec.id].join(' -> ')
      throw new CimientoError({
        code: 'PLAN_CYCLE',
        provider: spec.provider,
        resource: spec.id,
        message: `Dependency cycle: ${cycle}`,
        hint: 'This is a bug in a provider or wiring rule. Run cimiento plan --json and open an issue with the output.',
        retryable: false,
        needsHuman: true,
      })
    }
    temporary.add(spec.id)
    for (const dep of dependenciesOf(spec).sort()) {
      const next = byId.get(dep)
      if (next) visit(next, [...trail, spec.id])
    }
    temporary.delete(spec.id)
    permanent.add(spec.id)
    sorted.push(spec)
  }

  for (const spec of ordered) visit(spec, [])
  return sorted
}
