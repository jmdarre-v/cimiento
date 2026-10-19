// The token the preview database workflow writes branch addresses into the Vercel env with (Goal 9,
// BUG-105). It lives only in GitHub Actions secrets, never in a deployment. cimiento makes it with
// the Vercel login it already has, scoped to the team stack.yaml pins, keeps its value in the
// keychain as a generated secret, and revokes it on down. A token whose value is gone is replaced.

import { CimientoError } from '../../core/errors'
import { recordedId } from '../../core/identity'
import type { CheckResult, Ctx, EnsureResult, Output, Presence, ResourceSpec, Value } from '../../core/types'
import { vercelCall, vercelError } from './api'

const ID = 'vercel'

function str(value: Value | undefined): string {
  return typeof value === 'string' ? value : ''
}

async function listTokens(ctx: Ctx, spec: ResourceSpec): Promise<{ id: string; name?: string }[]> {
  const result = await vercelCall<{ tokens?: { id: string; name?: string }[] }>(ctx, spec.id, 'GET', '/v5/user/tokens', undefined, { unscoped: true })
  if (!result.ok) {
    throw vercelError(spec.id, result, { code: 'VERCEL_API_ERROR', message: 'Listing the Vercel access tokens failed.', hint: 'cimiento up retries this safely.' })
  }
  return result.body?.tokens ?? []
}

async function revoke(ctx: Ctx, spec: ResourceSpec, id: string): Promise<void> {
  const result = await vercelCall(ctx, spec.id, 'DELETE', `/v3/user/tokens/${encodeURIComponent(id)}`, undefined, { unscoped: true })
  if (!result.ok && result.status !== 404) {
    throw vercelError(spec.id, result, { code: 'VERCEL_API_ERROR', message: `Revoking the Vercel token ${id} failed.`, hint: 'cimiento up and down retry this safely.' })
  }
}

function outputs(id: string): Record<string, Output> {
  return { tokenId: { value: id, secret: false } }
}

export async function ensureApiToken(spec: ResourceSpec, ctx: Ctx): Promise<EnsureResult> {
  const secret = str(spec.inputs.secret)
  const recorded = ctx.state.resources[spec.id]?.externalId
  const listed = recorded ? (await listTokens(ctx, spec)).find((t) => t.id === recorded) : undefined
  const held = await ctx.secrets.get(secret).catch(() => undefined)
  if (listed && held) return { action: 'noop', externalId: recorded, outputs: outputs(recorded!) }
  if (ctx.dryRun) return { action: 'noop' }

  // Scoped to the team in stack.yaml: vercelCall adds the teamId.
  const created = await vercelCall<{ token?: { id?: string }; bearerToken?: string }>(ctx, spec.id, 'POST', '/v3/user/tokens', { name: str(spec.inputs.name) })
  const value = created.body?.bearerToken
  const id = created.body?.token?.id
  if (!created.ok || !value || !id) {
    throw vercelError(spec.id, created, {
      code: 'VERCEL_API_ERROR',
      message: 'Making the Vercel token for the preview database workflow failed.',
      hint: 'cimiento up retries this safely. The Vercel login must be able to make access tokens for the team stack.yaml pins.',
    })
  }
  ctx.redactor.addValue(value)
  if (!ctx.secrets.keep) throw new Error('The secret store cannot keep a generated value.')
  await ctx.secrets.keep(secret, value)
  if (listed) await revoke(ctx, spec, listed.id)
  ctx.logger.log({ level: 'info', event: 'vercel-token', resource: spec.id, message: `Made a Vercel token for the preview database workflow, kept only in GitHub Actions: ${secret}=****.` })
  return { action: recorded ? 'updated' : 'created', externalId: id, outputs: outputs(id) }
}

export async function verifyApiToken(spec: ResourceSpec, ctx: Ctx): Promise<CheckResult> {
  const recorded = ctx.state.resources[spec.id]?.externalId
  const secret = str(spec.inputs.secret)
  const listed = recorded ? (await listTokens(ctx, spec)).some((t) => t.id === recorded) : false
  const held = await ctx.secrets.get(secret).catch(() => undefined)
  if (listed && held) return { ok: true, evidence: `Vercel token ${recorded} for the preview database workflow, ${secret}=**** kept` }
  return {
    ok: false,
    error: new CimientoError({
      code: 'VERCEL_API_ERROR',
      provider: ID,
      resource: spec.id,
      message: listed ? 'The Vercel token for the preview database workflow exists, but this machine does not hold its value.' : 'The Vercel token for the preview database workflow is gone.',
      hint: 'Run cimiento up. It makes a new token, revokes the old one and writes the new one to the Actions secret.',
      retryable: true,
      needsHuman: false,
    }),
  }
}

export async function destroyApiToken(spec: ResourceSpec, ctx: Ctx): Promise<void> {
  await revoke(ctx, spec, recordedId(ctx, spec, 'the Vercel token for the preview database workflow'))
}

export async function apiTokenPresence(spec: ResourceSpec, ctx: Ctx): Promise<Presence> {
  const id = ctx.state.resources[spec.id]?.externalId
  if (!id) return 'unknown'
  const result = await vercelCall<{ tokens?: { id: string }[] }>(ctx, spec.id, 'GET', '/v5/user/tokens', undefined, { unscoped: true })
  if (!result.ok) return 'unknown'
  return (result.body?.tokens ?? []).some((t) => t.id === id) ? 'present' : 'absent'
}
