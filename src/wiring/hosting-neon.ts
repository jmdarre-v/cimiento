// any hosting + neon: the pooled connection string goes to the hosting env as DATABASE_URL, which is
// what serverless functions should use, and the direct one as DATABASE_URL_UNPOOLED, for migrations
// and tools that hold a session. Both are secrets: cimiento writes them and never prints them.

import { hostingDeploymentId, hostingEnvSpec, hostingOf, hostingProjectId, hostingProjectRef, previewDatabaseIsolated, sharedDatabaseEnvironments } from '../core/hosting'
import { ciSecretId, hostingEnvId } from '../core/sink-ids'
import type { ResourceSpec } from '../core/types'

/** The declared secret that carries the Neon key for previews (Goal 8). */
export const NEON_KEY_SECRET = 'NEON_API_KEY'
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
    // Previews never get the production address unless stack.yaml says shared (BUG-88).
    const envs = sharedDatabaseEnvironments(m).flatMap((environment) =>
      NEON_ENV_KEYS.map((entry) => hostingEnvSpec(hosting, entry.key, environment, { source: 'literal', value: { deferred: entry.ref } }, ['neon.project'])),
    )
    const specs: ResourceSpec[] = [...envs]
    if (previewDatabaseIsolated(m) && m.slots.repo === 'github') {
      // One Neon branch per git branch besides production, its addresses written for that branch's
      // previews only, and removed once the git branch is gone.
      specs.push({
        id: 'neon.preview-branches',
        kind: 'resource',
        provider: 'neon',
        dependsOn: ['neon.project', hostingProjectId(hosting), 'github.repo'],
        inputs: {
          projectId: { deferred: 'neon.project:projectId' },
          hosting,
          hostingProjectId: hostingProjectRef(hosting),
          repo: { deferred: 'github.repo:fullName' },
          productionBranch: m.options.github.defaultBranch,
        },
      })
    }
    const edges = envs.map((s) => ({ from: hostingDeploymentId(hosting), to: s.id }))
    // The key previews and the preview database workflow use, made before anything writes it (BUG-96).
    if (previewDatabaseIsolated(m) && m.secrets.some((s) => s.name === NEON_KEY_SECRET)) {
      specs.push({
        id: 'neon.api-key',
        kind: 'resource',
        provider: 'neon',
        dependsOn: ['neon.project'],
        inputs: { projectId: { deferred: 'neon.project:projectId' }, name: `cimiento-${m.slug}-preview`, secret: NEON_KEY_SECRET },
      })
      edges.push({ from: hostingEnvId(hosting, NEON_KEY_SECRET, 'preview'), to: 'neon.api-key' }, { from: ciSecretId(NEON_KEY_SECRET), to: 'neon.api-key' })
    }
    return { specs, edges }
  },

  explain(key: string, lang: 'en' | 'es'): string | undefined {
    if (key === 'neon.api-key') {
      return lang === 'es'
        ? 'Una llave de la API de Neon limitada al proyecto de esta app: puede crear y borrar ramas, pero no borrar el proyecto ni tocar otros. La usan el flujo de GitHub Actions que crea la base de datos de cada vista previa y las propias vistas previas para encontrarla. cimiento la guarda en el llavero y nunca la imprime; down la revoca.'
        : "A Neon API key scoped to this app's project: it can make and remove branches, but cannot delete the project or reach any other. The GitHub Actions workflow that makes each preview's database uses it, and so do the previews, to find theirs. cimiento keeps it in the keychain and never prints it; down revokes it."
    }
    if (key === 'neon.preview-branches') {
      return lang === 'es'
        ? 'Una rama de Neon por cada rama de git que no es produccion, con su direccion solo para las vistas previas de esa rama. Las vistas previas nunca leen la base de datos de produccion. cimiento up crea las que faltan y borra las de ramas que ya no existen.'
        : 'A Neon branch for every git branch besides production, its address written for that branch\'s previews only, so previews never read the production database. cimiento up makes the missing ones and removes those whose git branch is gone.'
    }
    const entry = NEON_ENV_KEYS.find((e) => key.includes(`.env.${e.key}.`))
    if (!entry) return undefined
    const pooled = entry.key === 'DATABASE_URL'
    return lang === 'es'
      ? `La direccion ${pooled ? 'con pool' : 'directa'} de la base de datos de Neon, con su contrasena, en el entorno del hosting. cimiento la escribe y nunca la imprime.`
      : `The ${pooled ? 'pooled' : 'direct'} address of the Neon database, password included, in the hosting env. cimiento writes it and never prints it.`
  },
}
