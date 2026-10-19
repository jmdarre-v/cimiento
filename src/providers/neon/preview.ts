// Preview data isolation on Neon (Goal 7, BUG-88; own passwords, BUG-114). cimiento is not running when the hosting builds
// a preview, so the branches are reconciled by up: every git branch besides production gets a Neon
// branch of the project, and its addresses are written for that git branch's previews only. A git
// branch that is gone takes its Neon branch and its env values with it. A branch pushed with plain
// git has no database until the next up, so its preview fails loudly instead of reaching
// production. A Neon branch keeps the role passwords of the branch it was made from, so each
// preview branch's role gets its own password before its address is written; otherwise that
// address would also open production.

import { CimientoError } from '../../core/errors'
import { previewBranchName, type HostingId } from '../../core/hosting'
import type { CheckResult, Ctx, EnsureResult, Output, Presence, ResourceSpec, Value } from '../../core/types'
import { presenceFromStatus } from '../../core/types'
import { branchEnvBranches, remoteBranches, removeBranchEnv, setBranchEnv } from '../hosting'
import { neonCall, neonError } from './api'

const ID = 'neon'
const KEYS = ['DATABASE_URL', 'DATABASE_URL_UNPOOLED'] as const

interface NeonBranch {
  id: string
  name: string
  default?: boolean
}

interface Inputs {
  projectId: string
  hosting: HostingId
  hostingProjectId: string
  repo: string
  production: string
}

function str(value: Value | undefined): string {
  return typeof value === 'string' ? value : ''
}

function inputs(spec: ResourceSpec): Inputs {
  return {
    projectId: str(spec.inputs.projectId),
    hosting: (str(spec.inputs.hosting) || 'vercel') as HostingId,
    hostingProjectId: str(spec.inputs.hostingProjectId),
    repo: str(spec.inputs.repo),
    production: str(spec.inputs.productionBranch) || 'main',
  }
}

/** The git branch to Neon branch id map state recorded. */
function recorded(ctx: Ctx, spec: ResourceSpec): Record<string, string> {
  try {
    return JSON.parse(ctx.state.resources[spec.id]?.outputs?.branches ?? '{}') as Record<string, string>
  } catch {
    return {}
  }
}

/** The Neon branch ids whose role cimiento saw with a password of its own. */
function recordedOwn(ctx: Ctx, spec: ResourceSpec): Set<string> {
  try {
    return new Set(JSON.parse(ctx.state.resources[spec.id]?.outputs?.ownPassword ?? '[]') as string[])
  } catch {
    return new Set()
  }
}

function outputs(map: Record<string, string>, own: Set<string>): Record<string, Output> {
  const sorted = Object.fromEntries(Object.entries(map).sort(([a], [b]) => a.localeCompare(b)))
  const ids = new Set(Object.values(sorted))
  return {
    branches: { value: JSON.stringify(sorted), secret: false },
    count: { value: String(Object.keys(sorted).length), secret: false },
    ownPassword: { value: JSON.stringify([...own].filter((id) => ids.has(id)).sort()), secret: false },
  }
}

async function gitBranches(ctx: Ctx, spec: ResourceSpec, input: Inputs): Promise<string[]> {
  const listed = await remoteBranches(ctx, input.repo)
  if (!listed) {
    throw new CimientoError({
      code: 'PREVIEW_DATABASE_FAILED',
      provider: ID,
      resource: spec.id,
      message: `cimiento could not list the branches of ${input.repo}, so it does not know which previews need a database. Nothing was created or removed.`,
      hint: 'Run cimiento doctor to check the GitHub login, then cimiento up again.',
      retryable: true,
      needsHuman: false,
    })
  }
  return listed.map((b) => b.name).filter((name) => name !== input.production)
}

async function neonBranches(ctx: Ctx, spec: ResourceSpec, projectId: string): Promise<NeonBranch[]> {
  const result = await neonCall<{ branches?: NeonBranch[] }>(ctx, spec.id, 'GET', `/projects/${encodeURIComponent(projectId)}/branches`)
  if (!result.ok) {
    throw neonError(spec.id, result, { code: 'NEON_API_ERROR', message: 'Listing the branches of the Neon project failed', hint: 'cimiento up retries this safely.' })
  }
  return result.body?.branches ?? []
}

interface Database {
  name: string
  owner_name: string
}

async function database(ctx: Ctx, spec: ResourceSpec, projectId: string, branchId: string): Promise<Database> {
  const db = await neonCall<{ databases?: Database[] }>(ctx, spec.id, 'GET', `/projects/${encodeURIComponent(projectId)}/branches/${encodeURIComponent(branchId)}/databases`)
  return db.body?.databases?.[0] ?? { name: 'neondb', owner_name: 'neondb_owner' }
}

async function branchUri(ctx: Ctx, spec: ResourceSpec, projectId: string, branchId: string, pooled: boolean, db?: Database): Promise<string> {
  const first = db ?? (await database(ctx, spec, projectId, branchId))
  const result = await neonCall<{ uri?: string }>(
    ctx,
    spec.id,
    'GET',
    `/projects/${encodeURIComponent(projectId)}/connection_uri?branch_id=${encodeURIComponent(branchId)}&database_name=${encodeURIComponent(first.name)}&role_name=${encodeURIComponent(first.owner_name)}&pooled=${pooled}`,
  )
  const uri = result.body?.uri
  if (!result.ok || !uri) {
    throw neonError(spec.id, result, { code: 'NEON_API_ERROR', message: `Reading the address of the Neon branch ${branchId} failed`, hint: 'cimiento up retries this safely.' })
  }
  ctx.redactor.addValue(uri)
  return uri
}

/** True when the preview branch's role still has the password of the production branch. */
async function sharesPassword(ctx: Ctx, spec: ResourceSpec, projectId: string, branchId: string, productionId: string): Promise<boolean> {
  const db = await database(ctx, spec, projectId, branchId)
  const mine = new URL(await branchUri(ctx, spec, projectId, branchId, false, db)).password
  const theirs = new URL(await branchUri(ctx, spec, projectId, productionId, false, db)).password
  return mine === theirs
}

function sleep(ms: number): Promise<void> {
  return new Promise((resolve) => setTimeout(resolve, ms))
}

/** Gives the role of a preview branch a password of its own, and waits until Neon applied it. */
async function resetPassword(ctx: Ctx, spec: ResourceSpec, projectId: string, branchId: string): Promise<void> {
  const db = await database(ctx, spec, projectId, branchId)
  const base = `/projects/${encodeURIComponent(projectId)}`
  const result = await neonCall<{ operations?: { id: string }[] }>(ctx, spec.id, 'POST', `${base}/branches/${encodeURIComponent(branchId)}/roles/${encodeURIComponent(db.owner_name)}/reset_password`)
  if (!result.ok) {
    throw neonError(spec.id, result, { code: 'NEON_API_ERROR', message: `Giving the Neon branch ${branchId} its own password failed`, hint: 'cimiento up retries this safely; until then the address of that preview is not written.' })
  }
  for (const op of result.body?.operations ?? []) {
    for (let i = 0; ; i++) {
      const read = await neonCall<{ operation?: { status?: string } }>(ctx, spec.id, 'GET', `${base}/operations/${encodeURIComponent(op.id)}`)
      const status = read.body?.operation?.status
      if (status === 'finished' || status === 'skipped') break
      if (status === 'failed' || status === 'error' || status === 'cancelled' || i >= 60) {
        throw new CimientoError({
          code: 'NEON_API_ERROR',
          provider: ID,
          resource: spec.id,
          message: `Neon did not finish giving the branch ${branchId} its own password (${status ?? 'no status'}).`,
          hint: 'cimiento up retries this safely; until then the address of that preview is not written.',
          retryable: true,
          needsHuman: false,
        })
      }
      await sleep(2000)
    }
  }
}

async function createBranch(ctx: Ctx, spec: ResourceSpec, projectId: string, name: string): Promise<NeonBranch> {
  const result = await neonCall<{ branch?: NeonBranch }>(ctx, spec.id, 'POST', `/projects/${encodeURIComponent(projectId)}/branches`, {
    branch: { name },
    endpoints: [{ type: 'read_write' }],
  })
  if (!result.ok || !result.body?.branch) {
    throw neonError(spec.id, result, {
      code: 'NEON_API_ERROR',
      message: `Creating the Neon branch ${name} for previews failed`,
      hint: 'A Neon plan limits branches per project; the message above says whether this is that. cimiento up retries safely.',
    })
  }
  return result.body.branch
}

async function deleteBranch(ctx: Ctx, spec: ResourceSpec, projectId: string, branchId: string): Promise<void> {
  const result = await neonCall(ctx, spec.id, 'DELETE', `/projects/${encodeURIComponent(projectId)}/branches/${encodeURIComponent(branchId)}`)
  if (!result.ok && result.status !== 404) {
    throw neonError(spec.id, result, { code: 'NEON_API_ERROR', message: `Deleting the Neon branch ${branchId} failed`, hint: 'cimiento up and down retry this safely.' })
  }
}

export async function ensurePreviewBranches(spec: ResourceSpec, ctx: Ctx): Promise<EnsureResult> {
  const input = inputs(spec)
  const wanted = await gitBranches(ctx, spec, input)
  const existing = await neonBranches(ctx, spec, input.projectId)
  const was = recorded(ctx, spec)
  const withEnv = new Set(await branchEnvBranches(ctx, spec, input.hosting, input.hostingProjectId, 'DATABASE_URL'))
  const production = existing.find((b) => b.default)
  const own = recordedOwn(ctx, spec)

  const map: Record<string, string> = {}
  const missing: string[] = []
  for (const git of wanted) {
    // Recorded by id first; a branch with the expected name in this project is ours too.
    const found = existing.find((b) => b.id === was[git]) ?? existing.find((b) => b.name === previewBranchName(git))
    if (found) map[git] = found.id
    if (!found || !withEnv.has(git)) missing.push(git)
    // Written by 0.4.0 to 0.4.2, or by a workflow without a hosting token: checked once (BUG-114).
    else if (!own.has(found.id) && production) {
      if (await sharesPassword(ctx, spec, input.projectId, found.id, production.id)) missing.push(git)
      else own.add(found.id)
    }
  }
  // Only branches state recorded are deleted, by id; env values for gone branches are removed too.
  const gone = Object.keys(was).filter((git) => !wanted.includes(git))
  const strayEnv = [...withEnv].filter((git) => !wanted.includes(git))
  if (missing.length === 0 && gone.length === 0 && strayEnv.length === 0) {
    return { action: 'noop', externalId: input.projectId, outputs: outputs(map, own) }
  }
  if (ctx.dryRun) return { action: 'noop' }

  for (const git of missing) {
    const id = map[git] ?? (await createBranch(ctx, spec, input.projectId, previewBranchName(git))).id
    map[git] = id
    if (production && (await sharesPassword(ctx, spec, input.projectId, id, production.id))) {
      await resetPassword(ctx, spec, input.projectId, id)
      ctx.logger.log({ level: 'info', event: 'preview-database', resource: spec.id, message: `Gave the Neon branch ${previewBranchName(git)} its own password, so its address cannot open production.` })
    }
    own.add(id)
    const pooled = await branchUri(ctx, spec, input.projectId, id, true)
    const direct = await branchUri(ctx, spec, input.projectId, id, false)
    await setBranchEnv(ctx, spec, input.hosting, input.hostingProjectId, 'DATABASE_URL', pooled, git)
    await setBranchEnv(ctx, spec, input.hosting, input.hostingProjectId, 'DATABASE_URL_UNPOOLED', direct, git)
    ctx.logger.log({ level: 'info', event: 'preview-database', resource: spec.id, message: `Previews of ${git} now read the Neon branch ${previewBranchName(git)}, not production.` })
  }
  for (const git of new Set([...gone, ...strayEnv])) {
    for (const key of KEYS) await removeBranchEnv(ctx, spec, input.hosting, input.hostingProjectId, key, git)
    if (was[git]) await deleteBranch(ctx, spec, input.projectId, was[git])
    ctx.logger.log({ level: 'info', event: 'preview-database', resource: spec.id, message: `Removed the preview database of ${git}, whose git branch is gone.` })
  }
  return { action: Object.keys(was).length === 0 && missing.length > 0 ? 'created' : 'updated', externalId: input.projectId, outputs: outputs(map, own) }
}

/** Read only: every branch besides production has its Neon branch and its env value. */
export async function verifyPreviewBranches(spec: ResourceSpec, ctx: Ctx): Promise<CheckResult> {
  const input = inputs(spec)
  const listed = await remoteBranches(ctx, input.repo)
  if (!listed) return { ok: false, unknown: true, evidence: `could not list the branches of ${input.repo}` }
  const wanted = listed.map((b) => b.name).filter((name) => name !== input.production)
  if (wanted.length === 0) return { ok: true, evidence: `no branch besides ${input.production}; the first one gets its own Neon branch at the next cimiento up` }
  const existing = await neonBranches(ctx, spec, input.projectId)
  // A preview reads only the address written for its branch, by the workflow or by cimiento up;
  // since 0.4.2 no preview looks its branch up with a Neon key (BUG-105).
  const withEnv = new Set(await branchEnvBranches(ctx, spec, input.hosting, input.hostingProjectId, 'DATABASE_URL'))
  const lacking = wanted.filter((git) => !existing.some((b) => b.name === previewBranchName(git)) || !withEnv.has(git))
  if (lacking.length === 0) {
    // A preview branch whose role still has production's password opens production too (BUG-114).
    const production = existing.find((b) => b.default)
    const own = recordedOwn(ctx, spec)
    const shared: string[] = []
    for (const git of wanted) {
      const branch = existing.find((b) => b.name === previewBranchName(git))!
      if (production && !own.has(branch.id) && (await sharesPassword(ctx, spec, input.projectId, branch.id, production.id))) shared.push(git)
    }
    if (shared.length === 0) return { ok: true, evidence: `previews of ${wanted.join(', ')} each read their own Neon branch, with a password of its own` }
    return {
      ok: false,
      error: new CimientoError({
        code: 'PREVIEW_PASSWORD_SHARED',
        provider: ID,
        resource: spec.id,
        message: `The Neon branches of ${shared.join(', ')} still have the production branch's password, so their preview address also opens the production database.`,
        hint: 'Run cimiento up: it gives each of those branches its own password and writes its address again. Push the branch again afterwards so the preview is built with it.',
        retryable: true,
        needsHuman: false,
      }),
    }
  }
  return {
    ok: false,
    error: new CimientoError({
      code: 'PREVIEW_DATABASE_FAILED',
      provider: ID,
      resource: spec.id,
      message: `No preview database yet for ${lacking.join(', ')}. Their previews have no DATABASE_URL, so they fail rather than reach production.`,
      hint: 'Run cimiento up: it makes a Neon branch for each and writes its address for that branch only. Push again afterwards so the preview is built with it.',
      retryable: true,
      needsHuman: false,
    }),
  }
}

export async function destroyPreviewBranches(spec: ResourceSpec, ctx: Ctx): Promise<void> {
  const input = inputs(spec)
  for (const [git, id] of Object.entries(recorded(ctx, spec))) {
    // The env values go with the hosting project too; removing them here keeps an adopted one clean.
    for (const key of KEYS) await removeBranchEnv(ctx, spec, input.hosting, input.hostingProjectId, key, git).catch(() => undefined)
    await deleteBranch(ctx, spec, input.projectId, id)
  }
}

/** Gone once every recorded branch answers not found, or the project itself is gone. */
export async function previewBranchesPresence(spec: ResourceSpec, ctx: Ctx): Promise<Presence> {
  const projectId = ctx.state.resources['neon.project']?.externalId
  const ids = Object.values(recorded(ctx, spec))
  if (!projectId) return 'unknown'
  let seen: Presence = 'absent'
  for (const id of ids) {
    const result = await neonCall(ctx, spec.id, 'GET', `/projects/${encodeURIComponent(projectId)}/branches/${encodeURIComponent(id)}`)
    const p = presenceFromStatus(result.status)
    if (p === 'present') return 'present'
    if (p === 'unknown') seen = 'unknown'
  }
  return seen
}
