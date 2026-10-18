// The hosting slot, independent of which provider fills it. Wiring rules for "any hosting" in spec
// section 6 build their env bindings and dependencies through these names, so the same rule serves
// Vercel and Netlify. Each hosting provider keeps the same resource shape: <id>.session,
// <id>.project with output projectId, <id>.deployment with output productionUrl, and env bindings
// <id>.env.<NAME>.<environment>.

import type { ResourceSpec, Value } from './types'
import { hostingEnvId } from './sink-ids'
import type { Manifest } from '../manifest/schema'

export type HostingId = 'vercel' | 'netlify'

export const HOSTING_NAMES: Record<HostingId, string> = { vercel: 'Vercel', netlify: 'Netlify' }

export function hostingOf(m: Manifest): HostingId | undefined {
  const hosting = m.slots.hosting
  return hosting === 'vercel' || hosting === 'netlify' ? hosting : undefined
}

export function hostingProjectId(hosting: HostingId): string {
  return `${hosting}.project`
}

export function hostingDeploymentId(hosting: HostingId): string {
  return `${hosting}.deployment`
}

export function hostingProjectRef(hosting: HostingId): Value {
  return { deferred: `${hosting}.project:projectId` }
}

export function productionUrlRef(hosting: HostingId): Value {
  return { deferred: `${hosting}.deployment:productionUrl` }
}

/** The address a new project gets before any custom domain. */
export function defaultHost(hosting: HostingId, slug: string): string {
  return hosting === 'netlify' ? `${slug}.netlify.app` : `${slug}.vercel.app`
}

/** The redirect pattern that matches every preview address of a project. */
export function previewPattern(hosting: HostingId, slug: string): string {
  // Vercel previews are <slug>-<hash>-<team>.vercel.app; Netlify previews and branch deploys are
  // <prefix>--<site>.netlify.app.
  return hosting === 'netlify' ? `https://*--${slug}.netlify.app/**` : `https://${slug}-*.vercel.app/**`
}

/**
 * One env binding in the hosting env store. source literal takes value, source secret reads the
 * declared secret of the same name from the secret store.
 */
export function hostingEnvSpec(
  hosting: HostingId,
  key: string,
  environment: string,
  inputs: { source: 'literal' | 'secret'; value?: Value; public?: boolean },
  dependsOn: string[] = [],
): ResourceSpec {
  return {
    id: hostingEnvId(hosting, key, environment),
    kind: 'binding',
    provider: hosting,
    dependsOn: [hostingProjectId(hosting), ...dependsOn],
    inputs: {
      projectId: hostingProjectRef(hosting),
      key,
      environment,
      source: inputs.source,
      ...(inputs.value !== undefined ? { value: inputs.value } : {}),
      ...(inputs.public ? { public: 'true' } : {}),
    },
  }
}

/** The ids of the hosting env bindings that carry a declared secret, for checks that wait on them. */
export function declaredSecretEnvIds(m: Manifest, name: string): string[] {
  const hosting = hostingOf(m)
  const declared = m.secrets.find((s) => s.name === name)
  if (!hosting || !declared?.sinks.includes('hosting')) return []
  return declared.environments.map((environment) => hostingEnvId(hosting, name, environment))
}

/**
 * Whether previews get their own database: a hosting with a preview environment, unless stack.yaml
 * says environments.preview.database: shared (Goal 7).
 */
export function previewDatabaseIsolated(m: Manifest): boolean {
  return hostingOf(m) !== undefined && m.environments.includes('preview') && m.previewDatabase !== 'shared'
}

/** The environments a database's own env bindings cover: preview only when it is shared. */
export function sharedDatabaseEnvironments(m: Manifest): Manifest['environments'] {
  return previewDatabaseIsolated(m) ? m.environments.filter((e) => e !== 'preview') : m.environments
}

/** The Neon branch name for a git branch: preview/ and the branch in lowercase letters, digits and dashes. */
export function previewBranchName(gitBranch: string): string {
  const slug = gitBranch.toLowerCase().replace(/[^a-z0-9]+/g, '-').replace(/^-+|-+$/g, '')
  return `preview/${slug || 'branch'}`
}

/** The warning plan and up give when previews share the production database. */
export function sharedPreviewWarning(m: Manifest): string | undefined {
  if (!hostingOf(m) || !m.environments.includes('preview') || m.previewDatabase !== 'shared') return undefined
  if (m.slots.database === 'none') return undefined
  return 'environments.preview.database is shared: every preview deployment reads and writes the production database. Remove it from stack.yaml to give previews their own.'
}
