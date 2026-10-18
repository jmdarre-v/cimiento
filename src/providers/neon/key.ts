// The key the preview database workflow and the previews themselves use (Goal 8, BUG-96): an
// organization API key scoped to this app's one Neon project, so it can make and remove branches
// but cannot delete the project or reach any other. Neon shows its value once; cimiento keeps it
// in the keychain as a generated secret, which the ci and hosting sinks then write like any other.
// A key whose value is gone is replaced: a new one is made, the old one revoked.

import { CimientoError } from '../../core/errors'
import { recordedId } from '../../core/identity'
import { presenceFromStatus, type CheckResult, type Ctx, type EnsureResult, type Output, type Presence, type ResourceSpec, type Value } from '../../core/types'
import { neonCall, neonError } from './api'

const ID = 'neon'

interface ApiKey {
  id: number | string
  name?: string
}

function str(value: Value | undefined): string {
  return typeof value === 'string' ? value : ''
}

async function projectOrg(ctx: Ctx, spec: ResourceSpec, projectId: string): Promise<string> {
  const result = await neonCall<{ project?: { org_id?: string } }>(ctx, spec.id, 'GET', `/projects/${encodeURIComponent(projectId)}`)
  const org = result.body?.project?.org_id
  if (!result.ok || !org) {
    throw neonError(spec.id, result, { code: 'NEON_API_ERROR', message: `Reading the organization of the Neon project ${projectId} failed`, hint: 'cimiento up retries this safely.' })
  }
  return org
}

async function listKeys(ctx: Ctx, spec: ResourceSpec, org: string): Promise<ApiKey[]> {
  const result = await neonCall<ApiKey[] | { api_keys?: ApiKey[] }>(ctx, spec.id, 'GET', `/organizations/${encodeURIComponent(org)}/api_keys`)
  if (!result.ok) {
    throw neonError(spec.id, result, { code: 'NEON_API_ERROR', message: 'Listing the API keys of the Neon organization failed', hint: 'cimiento up retries this safely.' })
  }
  const body = result.body
  return Array.isArray(body) ? body : (body?.api_keys ?? [])
}

async function revoke(ctx: Ctx, spec: ResourceSpec, org: string, keyId: string): Promise<void> {
  const result = await neonCall(ctx, spec.id, 'DELETE', `/organizations/${encodeURIComponent(org)}/api_keys/${encodeURIComponent(keyId)}`)
  if (!result.ok && result.status !== 404) {
    throw neonError(spec.id, result, { code: 'NEON_API_ERROR', message: `Revoking the Neon API key ${keyId} failed`, hint: 'cimiento up and down retry this safely.' })
  }
}

function outputs(org: string, keyId: string): Record<string, Output> {
  return { keyId: { value: keyId, secret: false }, orgId: { value: org, secret: false } }
}

export async function ensureApiKey(spec: ResourceSpec, ctx: Ctx): Promise<EnsureResult> {
  const projectId = str(spec.inputs.projectId)
  const secret = str(spec.inputs.secret)
  const org = await projectOrg(ctx, spec, projectId)
  const recorded = ctx.state.resources[spec.id]?.externalId
  const listed = recorded ? (await listKeys(ctx, spec, org)).find((k) => String(k.id) === recorded) : undefined
  const held = await ctx.secrets.get(secret).catch(() => undefined)
  if (listed && held) return { action: 'noop', externalId: recorded, outputs: outputs(org, recorded!) }
  if (ctx.dryRun) return { action: 'noop' }

  const created = await neonCall<{ id?: number | string; key?: string }>(ctx, spec.id, 'POST', `/organizations/${encodeURIComponent(org)}/api_keys`, {
    key_name: str(spec.inputs.name),
    project_id: projectId,
  })
  const key = created.body?.key
  const id = created.body?.id
  if (!created.ok || !key || id === undefined) {
    throw neonError(spec.id, created, {
      code: 'NEON_API_ERROR',
      message: 'Making the Neon API key for previews failed',
      hint: 'A project scoped key needs a member of the Neon organization. cimiento up retries this safely.',
    })
  }
  ctx.redactor.addValue(key)
  if (!ctx.secrets.keep) throw new Error('The secret store cannot keep a generated value.')
  await ctx.secrets.keep(secret, key)
  // The old key's value is gone, so nothing can use it any more: it goes.
  if (listed) await revoke(ctx, spec, org, String(listed.id))
  ctx.logger.log({ level: 'info', event: 'neon-key', resource: spec.id, message: `Made a Neon API key scoped to the project for the preview database workflow and the previews: ${secret}=****.` })
  return { action: recorded ? 'updated' : 'created', externalId: String(id), outputs: outputs(org, String(id)) }
}

export async function verifyApiKey(spec: ResourceSpec, ctx: Ctx): Promise<CheckResult> {
  const recorded = ctx.state.resources[spec.id]?.externalId
  const org = ctx.state.resources[spec.id]?.outputs?.orgId
  const secret = str(spec.inputs.secret)
  const listed = recorded && org ? (await listKeys(ctx, spec, org)).some((k) => String(k.id) === recorded) : false
  const held = await ctx.secrets.get(secret).catch(() => undefined)
  if (listed && held) return { ok: true, evidence: `Neon API key ${recorded}, scoped to the project, ${secret}=**** kept` }
  return {
    ok: false,
    error: new CimientoError({
      code: 'NEON_API_ERROR',
      provider: ID,
      resource: spec.id,
      message: listed ? `The Neon API key for previews exists, but this machine does not hold its value.` : `The Neon API key for previews is gone.`,
      hint: 'Run cimiento up. It makes a new key scoped to the project, revokes the old one and writes the new one to the workflow secret and the previews.',
      retryable: true,
      needsHuman: false,
    }),
  }
}

export async function destroyApiKey(spec: ResourceSpec, ctx: Ctx): Promise<void> {
  const keyId = recordedId(ctx, spec, 'the Neon API key for previews')
  const org = ctx.state.resources[spec.id]?.outputs?.orgId
  if (!org) return
  await revoke(ctx, spec, org, keyId)
}

export async function apiKeyPresence(spec: ResourceSpec, ctx: Ctx): Promise<Presence> {
  const keyId = ctx.state.resources[spec.id]?.externalId
  const org = ctx.state.resources[spec.id]?.outputs?.orgId
  if (!keyId || !org) return 'unknown'
  const result = await neonCall<ApiKey[] | { api_keys?: ApiKey[] }>(ctx, spec.id, 'GET', `/organizations/${encodeURIComponent(org)}/api_keys`)
  if (!result.ok) return presenceFromStatus(result.status) === 'absent' ? 'absent' : 'unknown'
  const body = result.body
  const keys = Array.isArray(body) ? body : (body?.api_keys ?? [])
  return keys.some((k) => String(k.id) === keyId) ? 'present' : 'absent'
}
