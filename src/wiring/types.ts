// A wiring rule is attached to a pair of providers, not to a provider. It contributes the
// bindings and manual steps that only make sense when both halves of the pair are selected.

import type { ProjectState } from '../core/state'
import type { ResourceSpec } from '../core/types'
import type { Manifest } from '../manifest/schema'

export interface WiringResult {
  /** Extra resources: bindings, manual steps and checks. */
  specs: ResourceSpec[]
  /** Extra graph edges, for when an existing resource has to wait on a wiring resource. */
  edges: { from: string; to: string }[]
}

export interface WiringRule {
  id: string
  pair: [string, string]
  applies(m: Manifest): boolean
  build(m: Manifest, state: ProjectState): WiringResult
  explain(key: string, lang: 'en' | 'es'): string | undefined
}

export const EMPTY: WiringResult = { specs: [], edges: [] }
