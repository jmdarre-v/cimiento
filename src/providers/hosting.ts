// What the commands need from whichever provider fills the hosting slot: where the project lives in
// state, how to wait for the deploy of a pushed commit, and the env store for env pull.

import { existsSync, readFileSync, writeFileSync } from 'node:fs'
import { join } from 'node:path'
import { CimientoError } from '../core/errors'
import { HOSTING_NAMES, hostingOf, type HostingId } from '../core/hosting'
import type { Ctx, LiveCommit, ResourceSpec } from '../core/types'
import type { Manifest } from '../manifest/schema'
import { netlifyBranchEnvBranches, netlifyDevEnv, netlifyLiveCommit, removeNetlifyBranchEnv, removeNetlifyEnv, setNetlifyBranchEnv, waitForNetlifyCommit } from './netlify'
import { ensureLocalLink, removeEnv, removeVercelBranchEnv, setVercelBranchEnv, vercelBranchEnvBranches, vercelLiveCommit, waitForCommitDeployment } from './vercel'

export interface CommitDeploy {
  url: string
  productionUrl?: string
  state: string
}

export function hostingProjectExternalId(ctx: Ctx, hosting: HostingId): string | undefined {
  const entry = ctx.state.resources[`${hosting}.project`]
  return entry?.externalId ?? entry?.outputs?.projectId
}

/** The hosting provider and its project id, or the error publish and env pull stop with. */
export function requireHostingProject(ctx: Ctx, m: Manifest, command: string): { hosting: HostingId; projectId: string } {
  const hosting = hostingOf(m)
  const projectId = hosting ? hostingProjectExternalId(ctx, hosting) : undefined
  if (hosting && projectId) return { hosting, projectId }
  throw new CimientoError({
    code: !hosting ? 'SECRET_SINK_UNAVAILABLE' : hosting === 'netlify' ? 'NETLIFY_SITE_NOT_FOUND' : 'VERCEL_PROJECT_NOT_FOUND',
    provider: hosting ?? 'core',
    resource: command,
    message: hosting ? `This project has no ${HOSTING_NAMES[hosting]} project yet.` : 'slots.hosting is none in stack.yaml, so there is no hosting project.',
    hint: hosting ? 'Run cimiento up first.' : 'Set slots.hosting to vercel or netlify in stack.yaml, then run cimiento up.',
    retryable: false,
    needsHuman: true,
  })
}

export async function waitForHostingCommit(ctx: Ctx, hosting: HostingId, projectId: string, sha: string): Promise<CommitDeploy> {
  const spec: ResourceSpec = { id: 'publish', kind: 'resource', provider: hosting, dependsOn: [], inputs: {} }
  return hosting === 'netlify' ? waitForNetlifyCommit(ctx, spec, projectId, sha) : waitForCommitDeployment(ctx, spec, projectId, sha)
}

export function hostingProductionUrl(ctx: Ctx, hosting: HostingId): string | undefined {
  return ctx.state.resources[`${hosting}.deployment`]?.outputs?.productionUrl
}

/**
 * Writes .env.local from the hosting env store and returns the names written. Vercel has its own
 * env pull; for Netlify cimiento reads the dev context through the API and writes the file itself.
 */
export async function pullHostingEnv(ctx: Ctx, m: Manifest, target = '.env.local'): Promise<string[]> {
  const { hosting, projectId } = requireHostingProject(ctx, m, 'env pull')
  const path = join(ctx.cwd, target)
  if (hosting === 'netlify') {
    const values = await netlifyDevEnv(ctx, { id: 'env pull', kind: 'binding', provider: 'netlify', dependsOn: [], inputs: {} }, projectId)
    const lines = ['# Written by cimiento env pull from the Netlify dev context. Gitignored; never commit it.']
    for (const [name, value] of Object.entries(values).sort(([a], [b]) => a.localeCompare(b))) lines.push(`${name}=${JSON.stringify(value)}`)
    writeFileSync(path, `${lines.join('\n')}\n`, { encoding: 'utf8', mode: 0o600 })
    return Object.keys(values).sort()
  }
  await ensureLocalLink(ctx, { id: 'env pull', kind: 'binding', provider: 'vercel', dependsOn: [], inputs: {} }, m.slug)
  const args = ['env', 'pull', target, '--yes']
  if (m.accounts.vercel) args.push('--scope', m.accounts.vercel)
  const result = await ctx.io.exec('vercel', args, { cwd: ctx.cwd })
  if (result.code !== 0) {
    throw new CimientoError({
      code: 'VERCEL_ENV_WRITE_FAILED',
      provider: 'vercel',
      resource: 'env pull',
      message: `vercel env pull failed: ${(result.stderr || result.stdout).trim().slice(0, 400)}`,
      hint: 'cimiento linked this folder to the Vercel project first, so this is a Vercel side error. cimiento doctor shows whether the project and session are healthy.',
      retryable: true,
      needsHuman: false,
    })
  }
  return readEnvNames(path)
}

function readEnvNames(path: string): string[] {
  if (!existsSync(path)) return []
  const names: string[] = []
  for (const line of readFileSync(path, 'utf8').split('\n')) {
    const match = /^\s*([A-Za-z_][A-Za-z0-9_]*)\s*=/.exec(line)
    if (match) names.push(match[1])
  }
  return names.sort()
}

/** For cimiento secret remove: deletes one hosting env binding's values. */
export async function removeHostingEnv(spec: ResourceSpec, ctx: Ctx): Promise<boolean> {
  return spec.provider === 'netlify' ? removeNetlifyEnv(spec, ctx) : removeEnv(spec, ctx)
}

/**
 * The commit the live production site is built from, as the hosting says. A lookup that fails, by
 * status or by timeout, is unknown: what an earlier run recorded in state is no evidence (BUG-87).
 */
export async function liveCommit(ctx: Ctx, hosting: HostingId, projectId: string): Promise<LiveCommit> {
  const spec: ResourceSpec = { id: 'publish', kind: 'resource', provider: hosting, dependsOn: [], inputs: {} }
  try {
    return hosting === 'netlify' ? await netlifyLiveCommit(ctx, spec, projectId) : await vercelLiveCommit(ctx, spec, projectId)
  } catch (err) {
    return { known: false, reason: err instanceof Error ? err.message : String(err) }
  }
}

/**
 * The branches of the repository, or undefined when gh could not list them. Preview databases are
 * removed for branches that are gone, so a failed listing must never read as no branches.
 */
export async function remoteBranches(ctx: Ctx, repo: string): Promise<{ name: string; sha: string }[] | undefined> {
  const result = await ctx.io.exec('gh', ['api', `repos/${repo}/branches?per_page=100`, '--jq', '[.[] | {name: .name, sha: .commit.sha}]'])
  if (result.code !== 0) return undefined
  try {
    return JSON.parse(result.stdout || '[]') as { name: string; sha: string }[]
  } catch {
    return undefined
  }
}

/** Writes one env value for the previews of one git branch only. */
export async function setBranchEnv(ctx: Ctx, spec: ResourceSpec, hosting: HostingId, projectId: string, key: string, value: string, branch: string): Promise<void> {
  return hosting === 'netlify' ? setNetlifyBranchEnv(ctx, spec, projectId, key, value, branch) : setVercelBranchEnv(ctx, spec, projectId, key, value, branch)
}

/** Removes the env value one git branch's previews had; a value already gone is fine. */
export async function removeBranchEnv(ctx: Ctx, spec: ResourceSpec, hosting: HostingId, projectId: string, key: string, branch: string): Promise<void> {
  return hosting === 'netlify' ? removeNetlifyBranchEnv(ctx, spec, projectId, key, branch) : removeVercelBranchEnv(ctx, spec, projectId, key, branch)
}

/** The git branches that have their own value of key in the hosting env. */
export async function branchEnvBranches(ctx: Ctx, spec: ResourceSpec, hosting: HostingId, projectId: string, key: string): Promise<string[]> {
  return hosting === 'netlify' ? netlifyBranchEnvBranches(ctx, spec, projectId, key) : vercelBranchEnvBranches(ctx, spec, projectId, key)
}
