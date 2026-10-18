// Inngest provider. Fills the jobs slot. Inngest Cloud reaches the app through its Vercel
// integration, which a person approves once and which puts the event key and signing key into the
// Vercel env. cimiento then registers the app at its production endpoint and proves the whole loop
// with a real event: sent, run by the scaffolded function, and reported complete by the Inngest API.

import { createHmac, randomUUID } from 'node:crypto'
import { CimientoError } from '../../core/errors'
import type { ProjectState } from '../../core/state'
import type {
  CheckResult,
  Ctx,
  Detection,
  EnsureResult,
  Lang,
  Leftover,
  Output,
  Provider,
  ResourceSpec,
  Session,
  Slot,
  Value,
} from '../../core/types'
import type { Manifest } from '../../manifest/schema'
import { listEnvEntries, readEnvValue, vercelCall } from '../vercel/api'
import { vercelTeamPlan } from '../../wiring/vercel-supabase-runtime'
import { inngestIntegrationStep } from '../../core/person-steps'
import { renderPersonStep, type PersonStep } from '../../core/person'
import { INNGEST_EXPLAIN } from './explain'

const ID = 'inngest'
export const INNGEST_EVENT_API = 'https://inn.gs/e'
export const INNGEST_API = 'https://api.inngest.com'
export const INNGEST_INTEGRATION_URL = 'https://vercel.com/integrations/inngest'
export const INNGEST_APPS_URL = 'https://app.inngest.com/env/production/apps'
export const INNGEST_KEYS = ['INNGEST_EVENT_KEY', 'INNGEST_SIGNING_KEY'] as const
/** The event and function the nextjs-app template ships for this check. */
export const ROUNDTRIP_EVENT = 'cimiento/roundtrip'
export const ROUNDTRIP_FUNCTION = 'cimiento-roundtrip'
export const INNGEST_PATH = '/api/inngest'

const polling = { intervalMs: 3000, timeoutMs: 120_000 }

/** Tests shorten the wait between polls of the run status. */
export function setRoundtripPolling(next: Partial<typeof polling>): void {
  Object.assign(polling, next)
}

export function createInngestProvider(_m?: Manifest): Provider {
  return {
    id: ID,
    fills: ['jobs'] as Slot[],
    tools: [],
    needsSession: false,

    async detect(_ctx: Ctx): Promise<Detection> {
      return { installed: true }
    },

    async login(_ctx: Ctx): Promise<Session> {
      throw new CimientoError({
        code: 'MANUAL_STEP_PENDING',
        provider: ID,
        resource: 'inngest.vercel-integration',
        message: 'Inngest has no login in cimiento. It reaches the app through its Vercel integration.',
        hint: 'Run cimiento up in a terminal. It opens the Inngest integration page and waits while you approve it.',
        retryable: true,
        needsHuman: true,
      })
    },

    resources(manifest: Manifest, _state: ProjectState): ResourceSpec[] {
      if (manifest.slots.jobs !== ID) return []
      // The vercel + inngest wiring rule adds the production URL, the Vercel project and the
      // integration step these wait on.
      return [
        { id: 'inngest.app', kind: 'binding', provider: ID, dependsOn: [], inputs: { appId: manifest.slug } },
        { id: 'inngest.check.roundtrip', kind: 'check', provider: ID, dependsOn: ['inngest.app'], inputs: { appId: manifest.slug } },
      ]
    },

    async ensure(spec: ResourceSpec, ctx: Ctx): Promise<EnsureResult> {
      if (spec.id === 'inngest.app') return ensureApp(spec, ctx)
      return { action: 'noop' }
    },

    async verify(spec: ResourceSpec, ctx: Ctx): Promise<CheckResult> {
      if (spec.id === 'inngest.vercel-integration') return verifyIntegration(spec, ctx)
      if (spec.id === 'inngest.app') return verifyApp(spec, ctx)
      if (spec.id === 'inngest.check.roundtrip') return verifyRoundtrip(spec, ctx)
      return { ok: true }
    },

    smokeEffect(spec: ResourceSpec): string | undefined {
      return spec.id === 'inngest.check.roundtrip' ? 'sends one event cimiento/roundtrip to Inngest, which runs the cimiento-roundtrip function once' : undefined
    },

    async destroy(): Promise<void> {
      // The app lives in Inngest Cloud and goes away with the endpoint; down lists it as a
      // leftover to archive, because the Inngest API has no way to delete it.
    },

    async leftovers(ctx: Ctx, after: ProjectState): Promise<Leftover[]> {
      // Reported in the run that removed the endpoint, the only moment cimiento knows about it.
      return after.resources['inngest.app'] ? [] : inngestLeftovers(ctx)
    },

    async outputs(spec: ResourceSpec, _ctx: Ctx): Promise<Record<string, Output>> {
      if (spec.id !== 'inngest.app') return {}
      const url = str(spec.inputs.url)
      return url ? { endpoint: { value: `${url}${INNGEST_PATH}`, secret: false } } : {}
    },

    explain(key: string, lang: Lang): string {
      const entry = INNGEST_EXPLAIN[key]
      if (!entry) return `No explanation for ${key} yet.`
      return (lang === 'es' && entry.es) || entry.en
    },
  }
}

export const inngestProvider = createInngestProvider()

/** What down reports for Inngest: the app registered in Inngest Cloud, which only a person can archive. */
export function inngestLeftovers(ctx: Ctx): Leftover[] {
  const app = ctx.state.resources['inngest.app']
  if (!app) return []
  const name = ctx.manifest.slug
  return [
    {
      provider: ID,
      what: 'Inngest app',
      id: name,
      name,
      url: INNGEST_APPS_URL,
      hint: `The Inngest API cannot delete or archive apps. Archive ${name} at ${INNGEST_APPS_URL} when you no longer need its run history.`,
    },
  ]
}

function str(value: Value | undefined): string {
  return typeof value === 'string' ? value : ''
}

interface IntegrationConfiguration {
  id: string
  slug?: string
  integration?: { slug?: string }
}

async function integrationStep(ctx: Ctx, resource: string, project: string, installed: boolean): Promise<PersonStep> {
  const pinned = ctx.manifest.accounts.vercel
  const team = pinned ? ((await vercelTeamPlan(ctx, resource, pinned).catch(() => undefined))?.name ?? pinned) : undefined
  return inngestIntegrationStep({ ...(team ? { team } : {}), project, installed })
}

async function instructions(ctx: Ctx, resource: string, project: string, installed: boolean): Promise<string> {
  const text = renderPersonStep(await integrationStep(ctx, resource, project, installed), ctx.lang, { links: false })
  // Only an attended run opens the page. An unattended one says where the person continues.
  return ctx.interactive
    ? text
    : `This needs you at a browser once. Run cimiento up in a terminal in ${ctx.cwd}; it opens the Inngest integration on Vercel (${INNGEST_INTEGRATION_URL}) and walks you through it.\n${text}`
}

/** The person step from spec section 6, proved by the integration and both keys in the env. */
async function verifyIntegration(spec: ResourceSpec, ctx: Ctx): Promise<CheckResult> {
  const projectId = str(spec.inputs.projectId)
  const project = str(spec.inputs.project) || ctx.manifest.slug
  const configs = await vercelCall<IntegrationConfiguration[] | { configurations?: IntegrationConfiguration[] }>(
    ctx,
    spec.id,
    'GET',
    '/v1/integrations/configurations?view=account',
  )
  const list = Array.isArray(configs.body) ? configs.body : (configs.body?.configurations ?? [])
  const installed = configs.ok && list.some((c) => c.slug === ID || c.integration?.slug === ID)
  const envs = (await listEnvEntries(ctx, spec.id, projectId).catch(() => undefined)) ?? []
  const present = INNGEST_KEYS.filter((key) => envs.some((e) => e.key === key && e.target.includes('production')))
  if (installed && present.length === INNGEST_KEYS.length) {
    return { ok: true, evidence: `inngest integration installed on vercel, ${INNGEST_KEYS.map((k) => `${k}=****`).join(' and ')} in ${project} production` }
  }
  return {
    ok: false,
    error: new CimientoError({
      code: 'MANUAL_STEP_PENDING',
      provider: ID,
      resource: spec.id,
      message: installed
        ? `The Inngest integration is installed on the Vercel team, but ${project} does not have ${INNGEST_KEYS.filter((k) => !present.includes(k)).join(' and ')} yet.`
        : 'The Inngest integration is not installed on this Vercel team yet.',
      hint: await instructions(ctx, spec.id, project, installed),
      personStep: await integrationStep(ctx, spec.id, project, installed),
      docsUrl: INNGEST_INTEGRATION_URL,
      retryable: true,
      needsHuman: true,
    }),
  }
}

interface Introspection {
  mode?: string
  has_event_key?: boolean
  has_signing_key?: boolean
  function_count?: number
  hasEventKey?: boolean
  hasSigningKey?: boolean
  functionsFound?: number
}

function readIntrospection(json: unknown): { eventKey: boolean; signingKey: boolean; functions: number; mode: string } | undefined {
  if (!json || typeof json !== 'object') return undefined
  const body = json as Introspection
  const functions = body.function_count ?? body.functionsFound
  if (functions === undefined) return undefined
  return {
    eventKey: Boolean(body.has_event_key ?? body.hasEventKey),
    signingKey: Boolean(body.has_signing_key ?? body.hasSigningKey),
    functions,
    mode: body.mode ?? 'cloud',
  }
}

function unreachable(spec: ResourceSpec, endpoint: string, status: number, detail: string): CimientoError {
  const protectedByVercel = status === 401 || status === 403
  return new CimientoError({
    code: 'INNGEST_ENDPOINT_UNREACHABLE',
    provider: ID,
    resource: spec.id,
    message: protectedByVercel
      ? `${endpoint} answered ${status}: Vercel deployment protection is keeping Inngest out.`
      : `${endpoint} answered ${status}${detail ? `: ${detail}` : ''}.`,
    hint: protectedByVercel
      ? 'Set options.vercel.deployment_protection to standard in stack.yaml, which leaves production public, and run cimiento up.'
      : status === 404
        ? 'The app has no Inngest endpoint. The nextjs-app template ships app/api/inngest/route.ts; restore it, push, and run cimiento up.'
        : 'Usually the deployment was built before the Inngest keys reached the env. cimiento up redeploys once the keys are there.',
    retryable: true,
    needsHuman: protectedByVercel,
  })
}

/**
 * The x-inngest-signature header the Inngest SDK checks: HMAC SHA-256 over the body (empty for a
 * GET) followed by the unix timestamp, keyed with the signing key minus its signkey-env- prefix.
 */
export function inngestSignature(signingKey: string, body = '', now = Date.now()): string {
  const ts = Math.round(now / 1000).toString()
  const key = signingKey.replace(/^signkey-[\w]+-/, '')
  return `t=${ts}&s=${createHmac('sha256', key).update(body + ts).digest('hex')}`
}

/**
 * Introspection of the deployed endpoint. Inngest SDK 3.54 answers an unsigned GET with 401 in cloud
 * mode, so cimiento signs it with the signing key from the Vercel env (BUG-48). sdkHandled tells a
 * refusal by the SDK from one by Vercel deployment protection.
 */
async function introspect(
  ctx: Ctx,
  spec: ResourceSpec,
  endpoint: string,
): Promise<{ status: number; info?: ReturnType<typeof readIntrospection>; text: string; sdkHandled: boolean; signed: boolean }> {
  const signingKey = await readEnvValue(ctx, spec.id, str(spec.inputs.projectId), 'INNGEST_SIGNING_KEY').catch(() => undefined)
  const res = await ctx.io.http({
    method: 'GET',
    url: endpoint,
    ...(signingKey ? { headers: { 'x-inngest-signature': inngestSignature(signingKey) } } : {}),
  })
  return {
    status: res.status,
    info: res.ok ? readIntrospection(res.json) : undefined,
    text: res.text.slice(0, 200),
    sdkHandled: res.headers?.['x-inngest-sdk-handled'] === 'true',
    signed: Boolean(signingKey),
  }
}

async function verifyApp(spec: ResourceSpec, ctx: Ctx): Promise<CheckResult> {
  const endpoint = `${str(spec.inputs.url)}${INNGEST_PATH}`
  const probe = await introspect(ctx, spec, endpoint)
  if (!probe.info && probe.sdkHandled && (probe.status === 401 || probe.status === 403)) {
    // The Inngest SDK itself refused the request: the endpoint is reachable, and the deployed app
    // holds a signing key other than the one in the Vercel env, or none.
    return {
      ok: false,
      error: new CimientoError({
        code: 'INNGEST_KEYS_MISSING',
        provider: ID,
        resource: spec.id,
        message: probe.signed
          ? `${endpoint} is served by the Inngest SDK, which refused a request signed with the INNGEST_SIGNING_KEY in the Vercel env: the live deployment was built with another key, or none.`
          : `${endpoint} is served by the Inngest SDK, which wants signed requests, and the Vercel env has no INNGEST_SIGNING_KEY to sign with.`,
        hint: 'Run cimiento up. It checks the Inngest integration and deploys again when the env is newer than the live deployment.',
        retryable: true,
        needsHuman: false,
      }),
    }
  }
  if (!probe.info) return { ok: false, error: unreachable(spec, endpoint, probe.status, probe.text) }
  if (!probe.info.eventKey || !probe.info.signingKey || probe.info.functions < 1) {
    return {
      ok: false,
      error: new CimientoError({
        code: 'INNGEST_KEYS_MISSING',
        provider: ID,
        resource: spec.id,
        message: `${endpoint} is live but reports ${[
          probe.info.eventKey ? '' : 'no event key',
          probe.info.signingKey ? '' : 'no signing key',
          probe.info.functions < 1 ? 'no functions' : '',
        ]
          .filter(Boolean)
          .join(', ')}.`,
        hint: 'The deployment was built before the Inngest integration added its keys. Run cimiento up; it deploys again because the env is newer than the deployment.',
        retryable: true,
        needsHuman: false,
      }),
    }
  }
  return { ok: true, evidence: `${endpoint} serves ${probe.info.functions} function${probe.info.functions === 1 ? '' : 's'} in ${probe.info.mode} mode with both keys` }
}

/** Registers the app with Inngest Cloud. The serve handler does it on PUT, signed with its own key. */
async function ensureApp(spec: ResourceSpec, ctx: Ctx): Promise<EnsureResult> {
  const endpoint = `${str(spec.inputs.url)}${INNGEST_PATH}`
  const outputs = { endpoint: { value: endpoint, secret: false } }
  const known = ctx.state.resources[spec.id]
  const before = await verifyApp(spec, ctx)
  if (known && before.ok) return { action: 'noop', url: INNGEST_APPS_URL, outputs }
  if (ctx.dryRun) return { action: 'noop' }
  if (!before.ok) throw before.error
  const res = await ctx.io.http({ method: 'PUT', url: endpoint })
  if (!res.ok) {
    const detail = (res.json as { message?: string } | undefined)?.message ?? res.text.slice(0, 200)
    throw unreachable(spec, endpoint, res.status, detail)
  }
  return { action: known ? 'updated' : 'created', url: INNGEST_APPS_URL, outputs }
}

function sleep(ms: number): Promise<void> {
  return new Promise((resolve) => setTimeout(resolve, ms))
}

/**
 * jobs.roundtrip from spec section 12. One real event goes to Inngest with the app's own event
 * key, the scaffolded function runs it, and the Inngest API, asked with the signing key, reports
 * the run as completed. Both keys are read from the Vercel env, so this also proves the wiring.
 */
/** Without --smoke the roundtrip only reads: both keys are in the env and the app check proves sync. */
async function verifyRoundtrip(spec: ResourceSpec, ctx: Ctx): Promise<CheckResult> {
  if (ctx.smoke) return smokeRoundtrip(spec, ctx)
  const projectId = str(spec.inputs.projectId)
  const keys = await Promise.all(INNGEST_KEYS.map((key) => readEnvValue(ctx, spec.id, projectId, key).catch(() => undefined)))
  if (keys.every(Boolean)) return { ok: true, evidence: 'both Inngest keys are in the env and the app is registered; --smoke sends one event and waits for its run' }
  return smokeRoundtrip(spec, ctx)
}

async function smokeRoundtrip(spec: ResourceSpec, ctx: Ctx): Promise<CheckResult> {
  const projectId = str(spec.inputs.projectId)
  const [eventKey, signingKey] = await Promise.all(INNGEST_KEYS.map((key) => readEnvValue(ctx, spec.id, projectId, key).catch(() => undefined)))
  if (!eventKey || !signingKey) {
    return {
      ok: false,
      error: new CimientoError({
        code: 'INNGEST_KEYS_MISSING',
        provider: ID,
        resource: spec.id,
        message: `cimiento could not read ${INNGEST_KEYS.join(' and ')} from the production env of the Vercel project.`,
        hint: 'Run cimiento up in a terminal. It checks the Inngest integration and asks you to approve it if the keys are not there.',
        retryable: true,
        needsHuman: true,
      }),
    }
  }
  const nonce = randomUUID()
  const sent = await ctx.io.http({
    method: 'POST',
    url: `${INNGEST_EVENT_API}/${encodeURIComponent(eventKey)}`,
    body: { name: ROUNDTRIP_EVENT, data: { nonce, source: 'cimiento doctor' } },
  })
  const id = (sent.json as { ids?: string[] } | undefined)?.ids?.[0]
  if (!sent.ok || !id) {
    return { ok: false, error: roundtripError(spec, `Inngest did not accept the ${ROUNDTRIP_EVENT} event (status ${sent.status}).`) }
  }
  const deadline = Date.now() + polling.timeoutMs
  let last = 'no run yet'
  for (;;) {
    const runs = await ctx.io.http({
      method: 'GET',
      url: `${INNGEST_API}/v1/events/${encodeURIComponent(id)}/runs`,
      headers: { authorization: `Bearer ${signingKey}` },
    })
    const run = (runs.json as { data?: { run_id?: string; status?: string }[] } | undefined)?.data?.[0]
    if (runs.status === 401 || runs.status === 403) {
      return { ok: false, error: roundtripError(spec, `The Inngest API refused the signing key from the Vercel env (${runs.status}).`) }
    }
    if (run?.status) last = run.status
    if (run?.status === 'Completed') {
      return { ok: true, evidence: `event ${id} (${ROUNDTRIP_EVENT}) ran ${ROUNDTRIP_FUNCTION}, run ${run.run_id ?? 'unknown'} Completed` }
    }
    if (run?.status === 'Failed' || run?.status === 'Cancelled') {
      return { ok: false, error: roundtripError(spec, `The ${ROUNDTRIP_FUNCTION} run for event ${id} ended ${run.status}.`) }
    }
    if (Date.now() >= deadline) {
      return { ok: false, error: roundtripError(spec, `Event ${id} was accepted, but no run completed within ${Math.round(polling.timeoutMs / 1000)} s (last status: ${last}).`) }
    }
    await sleep(polling.intervalMs)
  }
}

function roundtripError(spec: ResourceSpec, message: string): CimientoError {
  return new CimientoError({
    code: 'INNGEST_ROUNDTRIP_FAILED',
    provider: ID,
    resource: spec.id,
    message,
    hint: `Open ${INNGEST_APPS_URL}: the app should be listed as synced with the ${ROUNDTRIP_FUNCTION} function. cimiento up registers it again, and cimiento doctor repeats this check.`,
    docsUrl: INNGEST_APPS_URL,
    retryable: true,
    needsHuman: false,
  })
}

export default inngestProvider
