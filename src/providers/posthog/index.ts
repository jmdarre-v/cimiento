// PostHog provider. Fills the analytics slot. The project API key is public by design (the page
// sends events with it) and lands in the hosting env as NEXT_PUBLIC_POSTHOG_KEY, with the ingestion
// host as NEXT_PUBLIC_POSTHOG_HOST. The check sends one event. PostHog's ingestion edge only checks
// the shape of a project key and answers 200 to any well formed one, so the evidence says the
// event was received, and the key's shape is checked here first (docs/DECISIONS.md).

import type { Manifest } from '../../manifest/schema'
import type { CheckResult, Provider, ResourceSpec } from '../../core/types'
import { CimientoError } from '../../core/errors'
import { createKeyedProvider, keyRefused, vendorTrouble } from '../keyed'

export const POSTHOG_KEY_NAME = 'NEXT_PUBLIC_POSTHOG_KEY'
export const POSTHOG_HOST_NAME = 'NEXT_PUBLIC_POSTHOG_HOST'
const KEY_URL = 'https://us.posthog.com/settings/project'

export function posthogHost(region: 'us' | 'eu'): string {
  return `https://${region}.i.posthog.com`
}

export function createPosthogProvider(_m?: Manifest): Provider {
  return createKeyedProvider({
    id: 'posthog',
    vendor: 'PostHog',
    slot: 'analytics',
    secrets: [POSTHOG_KEY_NAME],
    check: 'posthog.check.capture',
    explain: {
      'posthog.check.capture': {
        en: 'A probe that PostHog accepts the project key: cimiento sends one event named cimiento_check, which shows in the PostHog activity list.',
        es: 'Una prueba de que PostHog acepta la clave del proyecto: cimiento envia un evento llamado cimiento_check, que aparece en la actividad de PostHog.',
      },
    },
    smokeEffect: () => 'sends one event named cimiento_check to PostHog, which shows under Activity',
    async inspect(spec, _ctx, keys) {
      const shape = keyShape(spec, keys[POSTHOG_KEY_NAME])
      if (shape) return shape
      // PostHog has no read only way to check a project key from outside, so this proves the shape.
      return { ok: true, evidence: `${POSTHOG_KEY_NAME}=**** has the shape of a project key (phc_); --smoke sends an event` }
    },
    async verify(spec, ctx, keys) {
      const shape = keyShape(spec, keys[POSTHOG_KEY_NAME])
      if (shape) return shape
      if (!/^phc_[A-Za-z0-9]{20,64}$/.test(keys[POSTHOG_KEY_NAME])) {
        return {
          ok: false,
          error: new CimientoError({
            code: 'POSTHOG_KEY_INVALID',
            provider: 'posthog',
            resource: spec.id,
            message: `${POSTHOG_KEY_NAME} does not look like a PostHog project key, which starts with phc_. A personal key (phx_) must never go to the page.`,
            hint: `Copy the Project API key from ${KEY_URL}, then run cimiento secret rotate ${POSTHOG_KEY_NAME}.`,
            docsUrl: KEY_URL,
            retryable: false,
            needsHuman: true,
          }),
        }
      }
      const host = posthogHost(ctx.manifest.options.posthog.host)
      const res = await ctx.io.http({
        method: 'POST',
        url: `${host}/i/v0/e/`,
        headers: { 'content-type': 'application/json' },
        body: { api_key: keys[POSTHOG_KEY_NAME], event: 'cimiento_check', distinct_id: `cimiento-${ctx.manifest.slug}`, properties: { $lib: 'cimiento' } },
      })
      if (res.ok) return { ok: true, evidence: `event cimiento_check received by ${host} with the phc_ key ${POSTHOG_KEY_NAME}=****; it shows under Activity in PostHog` }
      if (res.status === 401 || res.status === 403) return keyRefused('posthog', 'POSTHOG_KEY_INVALID', spec, POSTHOG_KEY_NAME, 'PostHog', res.status, KEY_URL)
      return vendorTrouble('posthog', 'POSTHOG_API_ERROR', spec, 'PostHog', res.status)
    },
  })
}

export default createPosthogProvider()

function keyShape(spec: ResourceSpec, key: string): CheckResult | undefined {
  if (/^phc_[A-Za-z0-9]{20,64}$/.test(key)) return undefined
  return {
    ok: false,
    error: new CimientoError({
      code: 'POSTHOG_KEY_INVALID',
      provider: 'posthog',
      resource: spec.id,
      message: `${POSTHOG_KEY_NAME} does not look like a PostHog project key, which starts with phc_. A personal key (phx_) must never go to the page.`,
      hint: `Copy the Project API key from ${KEY_URL}, then run cimiento secret rotate ${POSTHOG_KEY_NAME}.`,
      docsUrl: KEY_URL,
      retryable: false,
      needsHuman: true,
    }),
  }
}

