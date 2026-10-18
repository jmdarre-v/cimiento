// Anthropic provider. Fills the ai slot. There is nothing to create: the key belongs to the person,
// arrives through the secret store, and lands in the hosting env as a declared secret. What this
// module adds is proof that the key works, with one read only call that costs nothing.

import { CimientoError } from '../../core/errors'
import { declaredSecretEnvIds } from '../../core/hosting'
import type { ProjectState } from '../../core/state'
import type { CheckResult, Ctx, Detection, EnsureResult, Lang, Output, Provider, ResourceSpec, Session, Slot } from '../../core/types'
import type { Manifest } from '../../manifest/schema'
import { ANTHROPIC_EXPLAIN } from './explain'

const ID = 'anthropic'
export const ANTHROPIC_API = 'https://api.anthropic.com'
export const ANTHROPIC_KEY_NAME = 'ANTHROPIC_API_KEY'
const CONSOLE_KEYS_URL = 'https://console.anthropic.com/settings/keys'

export function createAnthropicProvider(_m?: Manifest): Provider {
  return {
    id: ID,
    fills: ['ai'] as Slot[],
    tools: [],
    needsSession: false,

    async detect(_ctx: Ctx): Promise<Detection> {
      return { installed: true }
    },

    async login(_ctx: Ctx): Promise<Session> {
      throw new CimientoError({
        code: 'ANTHROPIC_API_ERROR',
        provider: ID,
        resource: 'anthropic',
        message: 'Anthropic has no login in cimiento. The API key is a secret, set once.',
        hint: `Run cimiento secret set ${ANTHROPIC_KEY_NAME} in a terminal.`,
        retryable: false,
        needsHuman: true,
      })
    },

    resources(manifest: Manifest, _state: ProjectState): ResourceSpec[] {
      if (manifest.slots.ai !== ID) return []
      // After the key reaches the hosting env, so a key nobody has typed yet is one step waiting on
      // a person, not a failed check on top of it.
      const dependsOn = declaredSecretEnvIds(manifest, ANTHROPIC_KEY_NAME)
      return [{ id: 'anthropic.check.key', kind: 'check', provider: ID, dependsOn, inputs: { secret: ANTHROPIC_KEY_NAME } }]
    },

    async ensure(_spec: ResourceSpec, _ctx: Ctx): Promise<EnsureResult> {
      return { action: 'noop' }
    },

    async verify(spec: ResourceSpec, ctx: Ctx): Promise<CheckResult> {
      if (spec.id !== 'anthropic.check.key') return { ok: true }
      return verifyKey(spec, ctx)
    },

    async destroy(): Promise<void> {
      // The key is the person's. down never revokes it.
    },

    async outputs(): Promise<Record<string, Output>> {
      return {}
    },

    explain(key: string, lang: Lang): string {
      const entry = ANTHROPIC_EXPLAIN[key]
      if (!entry) return `No explanation for ${key} yet.`
      return (lang === 'es' && entry.es) || entry.en
    },
  }
}

/** GET /v1/models: authenticated, read only, free. A 200 proves the key is live. */
async function verifyKey(spec: ResourceSpec, ctx: Ctx): Promise<CheckResult> {
  const name = typeof spec.inputs.secret === 'string' ? spec.inputs.secret : ANTHROPIC_KEY_NAME
  const key = await ctx.secrets.get(name)
  if (!key) {
    return {
      ok: false,
      error: new CimientoError({
        code: 'SECRET_MISSING',
        provider: ID,
        resource: spec.id,
        message: `cimiento has no value for ${name}, so it cannot prove the Anthropic key works.`,
        hint: `Run cimiento secret set ${name} in a terminal in ${ctx.cwd}. It asks at a hidden prompt and keeps the value in the macOS keychain, never in a file or a chat.`,
        docsUrl: CONSOLE_KEYS_URL,
        retryable: true,
        needsHuman: true,
      }),
    }
  }
  ctx.redactor.addName(name)
  ctx.redactor.addValue(key)
  const res = await ctx.io.http({
    method: 'GET',
    url: `${ANTHROPIC_API}/v1/models?limit=1`,
    headers: { 'x-api-key': key, 'anthropic-version': '2023-06-01' },
  })
  if (res.ok) {
    const count = Array.isArray((res.json as { data?: unknown[] } | undefined)?.data) ? (res.json as { data: unknown[] }).data.length : 0
    return { ok: true, evidence: `${name}=**** accepted by api.anthropic.com (GET /v1/models answered ${res.status}, ${count} model listed)` }
  }
  const type = (res.json as { error?: { type?: string } } | undefined)?.error?.type ?? ''
  if (res.status === 401 || res.status === 403) {
    return {
      ok: false,
      error: new CimientoError({
        code: 'ANTHROPIC_KEY_INVALID',
        provider: ID,
        resource: spec.id,
        message: `api.anthropic.com refused ${name} (${res.status} ${type || 'authentication_error'}).`,
        hint: `Create a new key at ${CONSOLE_KEYS_URL}, then run cimiento secret rotate ${name} in a terminal. It replaces the value everywhere it was sent.`,
        docsUrl: CONSOLE_KEYS_URL,
        retryable: false,
        needsHuman: true,
      }),
    }
  }
  return {
    ok: false,
    error: new CimientoError({
      code: 'ANTHROPIC_API_ERROR',
      provider: ID,
      resource: spec.id,
      message: `api.anthropic.com answered ${res.status}${type ? ` ${type}` : ''} to a read only call.`,
      hint:
        res.status === 402 || type === 'billing_error'
          ? 'The key works but the organization has no credit. Add credit in the Anthropic Console billing page, then run cimiento doctor.'
          : 'This is on the Anthropic side. cimiento doctor runs the check again; it changes nothing.',
      retryable: res.status === 429 || res.status >= 500,
      needsHuman: res.status === 402 || type === 'billing_error',
    }),
  }
}

export default createAnthropicProvider()
