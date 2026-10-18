// any hosting + supabase (direct), spec section 6: the project is created through the Supabase API
// and cimiento pushes the URL, the anon key and the service role key into the hosting env, per
// environment. On Vercel the project first looks for a database the hosting env already points at.

import { hostingDeploymentId, hostingEnvSpec, hostingOf, hostingProjectId, previewDatabaseIsolated } from '../core/hosting'
import type { ProjectState } from '../core/state'
import type { ResourceSpec } from '../core/types'
import type { Manifest } from '../manifest/schema'
import type { WiringResult, WiringRule } from './types'

/** The three values a Next.js application needs to reach Supabase. */
export const SUPABASE_DIRECT_KEYS: { key: string; ref: string; publicValue: boolean }[] = [
  { key: 'NEXT_PUBLIC_SUPABASE_URL', ref: 'supabase.project:projectUrl', publicValue: true },
  { key: 'NEXT_PUBLIC_SUPABASE_ANON_KEY', ref: 'supabase.project:anonKey', publicValue: false },
  { key: 'SUPABASE_SERVICE_ROLE_KEY', ref: 'supabase.project:serviceRoleKey', publicValue: false },
]

export const hostingSupabaseDirectRule: WiringRule = {
  id: 'hosting+supabase-direct',
  pair: ['hosting', 'supabase'],

  applies(m: Manifest): boolean {
    const usesSupabase = m.slots.database === 'supabase' || m.slots.auth === 'supabase'
    return usesSupabase && hostingOf(m) !== undefined && m.accounts.supabase === 'direct'
  },

  build(m: Manifest, _state: ProjectState): WiringResult {
    const hosting = hostingOf(m)!
    const database: ResourceSpec = {
      id: 'supabase.project',
      kind: 'resource',
      provider: 'supabase',
      dependsOn: [hostingProjectId(hosting)],
      inputs: hosting === 'vercel' ? { hostingProject: m.slug } : {},
    }
    const specs: ResourceSpec[] = [database]
    const envIds: string[] = []
    const isolated = previewDatabaseIsolated(m)
    for (const environment of m.environments) {
      // Previews read their own project unless stack.yaml says shared (Goal 7).
      const source = environment === 'preview' && isolated ? 'supabase.preview-project' : 'supabase.project'
      for (const entry of SUPABASE_DIRECT_KEYS) {
        const ref = entry.ref.replace(/^supabase\.project:/, `${source}:`)
        const spec = hostingEnvSpec(hosting, entry.key, environment, { source: 'literal', value: { deferred: ref } }, [source])
        envIds.push(spec.id)
        specs.push(spec)
      }
    }
    return { specs, edges: envIds.map((id) => ({ from: hostingDeploymentId(hosting), to: id })) }
  },

  explain(): string | undefined {
    return undefined
  },
}
