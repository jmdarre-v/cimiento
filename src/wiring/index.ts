// Collects every wiring rule that applies to a manifest and folds the extra specs and edges
// into the resource list the planner works on.

import type { ProjectState } from '../core/state'
import type { ResourceSpec } from '../core/types'
import type { Manifest } from '../manifest/schema'
import { githubNetlifyRule } from './github-netlify'
import { githubVercelRule } from './github-vercel'
import { hostingSupabaseRule } from './hosting-supabase'
import { hostingSupabaseDirectRule } from './hosting-supabase-direct'
import { hostingDomainRule } from './hosting-domain'
import { hostingNeonRule } from './hosting-neon'
import { hostingPosthogRule } from './hosting-posthog'
import { hostingTurnstileRule } from './hosting-turnstile'
import { vercelInngestRule } from './vercel-inngest'
import { vercelSupabaseRule } from './vercel-supabase'
import type { WiringRule } from './types'

export * from './types'

export const WIRING_RULES: WiringRule[] = [
  githubVercelRule,
  githubNetlifyRule,
  vercelSupabaseRule,
  hostingSupabaseDirectRule,
  hostingSupabaseRule,
  vercelInngestRule,
  hostingTurnstileRule,
  hostingPosthogRule,
  hostingNeonRule,
  hostingDomainRule,
]

export function activeRules(m: Manifest): WiringRule[] {
  return WIRING_RULES.filter((rule) => rule.applies(m))
}

/**
 * Merges provider specs with every applicable wiring rule. Rules can add resources and can add
 * dependency edges to resources a provider already declared.
 */
export function applyWiring(m: Manifest, state: ProjectState, providerSpecs: ResourceSpec[]): ResourceSpec[] {
  const byId = new Map(providerSpecs.map((s) => [s.id, { ...s, dependsOn: [...s.dependsOn] }]))
  for (const rule of activeRules(m)) {
    const result = rule.build(m, state)
    for (const spec of result.specs) {
      const existing = byId.get(spec.id)
      if (existing) {
        existing.dependsOn = unique([...existing.dependsOn, ...spec.dependsOn])
        existing.inputs = { ...existing.inputs, ...spec.inputs }
        if (spec.billable !== undefined) existing.billable = spec.billable
        if (spec.manual) existing.manual = spec.manual
        continue
      }
      byId.set(spec.id, { ...spec, dependsOn: [...spec.dependsOn] })
    }
    for (const edge of result.edges) {
      const target = byId.get(edge.from)
      if (!target) continue
      if (!byId.has(edge.to)) continue
      target.dependsOn = unique([...target.dependsOn, edge.to])
    }
  }
  return [...byId.values()]
}

/** Explanation text contributed by wiring rules, for resources no single provider owns. */
export function wiringExplain(key: string, lang: 'en' | 'es'): string | undefined {
  for (const rule of WIRING_RULES) {
    const text = rule.explain(key, lang)
    if (text) return text
  }
  return undefined
}

function unique(values: string[]): string[] {
  return [...new Set(values)]
}
