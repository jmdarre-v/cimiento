// any hosting + neon: the pooled connection string goes to the hosting env as DATABASE_URL, which is
// what serverless functions should use, and the direct one as DATABASE_URL_UNPOOLED, for migrations
// and tools that hold a session. Both are secrets: cimiento writes them and never prints them.

import { hostingDeploymentId, hostingEnvSpec, hostingOf } from '../core/hosting'
import type { ProjectState } from '../core/state'
import type { Manifest } from '../manifest/schema'
import type { WiringResult, WiringRule } from './types'

export const NEON_ENV_KEYS: { key: string; ref: string }[] = [
  { key: 'DATABASE_URL', ref: 'neon.project:databaseUrl' },
  { key: 'DATABASE_URL_UNPOOLED', ref: 'neon.project:databaseUrlUnpooled' },
]

export const hostingNeonRule: WiringRule = {
  id: 'hosting+neon',
  pair: ['hosting', 'neon'],

  applies(m: Manifest): boolean {
    return m.slots.database === 'neon' && hostingOf(m) !== undefined
  },

  build(m: Manifest, _state: ProjectState): WiringResult {
    const hosting = hostingOf(m)!
    const specs = m.environments.flatMap((environment) =>
      NEON_ENV_KEYS.map((entry) => hostingEnvSpec(hosting, entry.key, environment, { source: 'literal', value: { deferred: entry.ref } }, ['neon.project'])),
    )
    return { specs, edges: specs.map((s) => ({ from: hostingDeploymentId(hosting), to: s.id })) }
  },

  explain(key: string, lang: 'en' | 'es'): string | undefined {
    const entry = NEON_ENV_KEYS.find((e) => key.includes(`.env.${e.key}.`))
    if (!entry) return undefined
    const pooled = entry.key === 'DATABASE_URL'
    return lang === 'es'
      ? `La direccion ${pooled ? 'con pool' : 'directa'} de la base de datos de Neon, con su contrasena, en el entorno del hosting. cimiento la escribe y nunca la imprime.`
      : `The ${pooled ? 'pooled' : 'direct'} address of the Neon database, password included, in the hosting env. cimiento writes it and never prints it.`
  },
}
