// Shared shape for providers whose only resource is a key the person makes on the vendor's site:
// Resend, Stripe and PostHog, like Anthropic. Nothing is created or destroyed; the key arrives
// through the secret store, lands in the hosting env as a declared secret, and one check proves
// it works. The check waits on the env bindings, so a key nobody has typed yet is one step waiting
// on a person instead of a failed check on top of it.

import { CimientoError } from '../core/errors'
import { declaredSecretEnvIds } from '../core/hosting'
import { renderPersonStep } from '../core/person'
import { secretStep } from '../core/person-steps'
import type { ProjectState } from '../core/state'
import type { CheckResult, Ctx, Detection, EnsureResult, Lang, Output, Provider, ResourceSpec, Session, Slot } from '../core/types'
import type { Manifest } from '../manifest/schema'

export interface KeyedProviderOptions {
  id: string
  vendor: string
  slot: Slot
  /** The declared secrets the check reads, the first being the one it proves. */
  secrets: string[]
  check: string
  explain: Record<string, { en: string; es?: string }>
  verify(spec: ResourceSpec, ctx: Ctx, keys: Record<string, string>): Promise<CheckResult>
}

export function createKeyedProvider(options: KeyedProviderOptions): Provider {
  return {
    id: options.id,
    fills: [options.slot],
    tools: [],
    needsSession: false,

    async detect(_ctx: Ctx): Promise<Detection> {
      return { installed: true }
    },

    async login(_ctx: Ctx): Promise<Session> {
      throw new CimientoError({
        code: 'SECRET_MISSING',
        provider: options.id,
        resource: options.id,
        message: `${options.vendor} has no login in cimiento. Its key is a secret, set once.`,
        hint: `Run cimiento secret set ${options.secrets[0]} in a terminal.`,
        retryable: false,
        needsHuman: true,
      })
    },

    resources(manifest: Manifest, _state: ProjectState): ResourceSpec[] {
      if (manifest.slots[options.slot] !== options.id) return []
      const dependsOn = options.secrets.flatMap((name) => declaredSecretEnvIds(manifest, name))
      return [{ id: options.check, kind: 'check', provider: options.id, dependsOn, inputs: { secrets: options.secrets.join(',') } }]
    },

    async ensure(_spec: ResourceSpec, _ctx: Ctx): Promise<EnsureResult> {
      return { action: 'noop' }
    },

    async verify(spec: ResourceSpec, ctx: Ctx): Promise<CheckResult> {
      if (spec.id !== options.check) return { ok: true }
      const keys: Record<string, string> = {}
      for (const name of options.secrets) {
        const value = await ctx.secrets.get(name)
        if (!value) return missingKey(options, spec, ctx, name)
        ctx.redactor.addName(name)
        // A public key is still never printed whole by cimiento; it is only in the page source.
        ctx.redactor.addValue(value)
        keys[name] = value
      }
      return options.verify(spec, ctx, keys)
    },

    async destroy(): Promise<void> {
      // The key and the account are the person's. down never revokes them.
    },

    async outputs(): Promise<Record<string, Output>> {
      return {}
    },

    explain(key: string, lang: Lang): string {
      const entry = options.explain[key]
      if (!entry) return `No explanation for ${key} yet.`
      return (lang === 'es' && entry.es) || entry.en
    },
  }
}

function missingKey(options: KeyedProviderOptions, spec: ResourceSpec, ctx: Ctx, name: string): CheckResult {
  const step = secretStep(name, ctx.manifest.slug)
  return {
    ok: false,
    error: new CimientoError({
      code: 'SECRET_MISSING',
      provider: options.id,
      resource: spec.id,
      message: `cimiento has no value for ${name}, so it cannot prove ${options.vendor} works.`,
      hint: `Run cimiento secret set ${name} in a terminal in ${ctx.cwd}. It asks at a hidden prompt; never paste it into chat.${step ? `\n${renderPersonStep(step, ctx.lang, { links: false })}` : ''}`,
      ...(step ? { personStep: step, docsUrl: step.url } : {}),
      retryable: true,
      needsHuman: true,
    }),
  }
}

/** The standard refusal for a key the vendor does not accept. */
export function keyRefused(id: string, code: string, spec: ResourceSpec, name: string, vendor: string, status: number, url: string): CheckResult {
  return {
    ok: false,
    error: new CimientoError({
      code,
      provider: id,
      resource: spec.id,
      message: `${vendor} refused ${name} (${status}).`,
      hint: `Make a new key at ${url}, then run cimiento secret rotate ${name} in a terminal. It replaces the value everywhere it was sent.`,
      docsUrl: url,
      retryable: false,
      needsHuman: true,
    }),
  }
}

/** A vendor side failure that says nothing about the key. */
export function vendorTrouble(id: string, code: string, spec: ResourceSpec, vendor: string, status: number): CheckResult {
  return {
    ok: false,
    error: new CimientoError({
      code,
      provider: id,
      resource: spec.id,
      message: `${vendor} answered ${status} to cimiento's check.`,
      hint: `This is on the ${vendor} side. cimiento doctor runs the check again; it changes nothing.`,
      retryable: status === 429 || status >= 500,
      needsHuman: false,
    }),
  }
}
