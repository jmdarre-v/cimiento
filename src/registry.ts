// Assembles the provider modules a manifest selects and the full resource list the engine works
// on: every provider's resources, folded together with every wiring rule that applies.

import type { ProjectState } from './core/state'
import type { Lang, Provider, ResourceSpec } from './core/types'
import { selectedProviderIds, type Manifest } from './manifest/schema'
import { createAnthropicProvider } from './providers/anthropic'
import { createGithubProvider } from './providers/github'
import { createInngestProvider } from './providers/inngest'
import { createNeonProvider } from './providers/neon'
import { createNetlifyProvider } from './providers/netlify'
import { createPosthogProvider } from './providers/posthog'
import { createResendProvider } from './providers/resend'
import { createStripeProvider } from './providers/stripe'
import { createSupabaseProvider } from './providers/supabase'
import { createTurnstileProvider } from './providers/turnstile'
import { createVercelProvider } from './providers/vercel'
import { applyWiring, wiringExplain } from './wiring'
import { CORE_EXPLAIN } from './cli/explain-core'

type ProviderFactory = (m?: Manifest) => Provider

const FACTORIES: Record<string, ProviderFactory> = {
  github: createGithubProvider,
  vercel: createVercelProvider,
  netlify: createNetlifyProvider,
  supabase: createSupabaseProvider,
  inngest: createInngestProvider,
  turnstile: createTurnstileProvider,
  anthropic: createAnthropicProvider,
  neon: createNeonProvider,
  resend: createResendProvider,
  stripe: createStripeProvider,
  posthog: createPosthogProvider,
}

export function knownProviderIds(): string[] {
  return Object.keys(FACTORIES).sort()
}

/** Provider modules for the ids a manifest selects. Unknown ids are reported by the planner. */
export function buildProviders(m: Manifest): Provider[] {
  const providers: Provider[] = []
  for (const id of selectedProviderIds(m)) {
    const factory = FACTORIES[id]
    if (!factory) continue
    providers.push(factory(m))
  }
  return providers
}

/** Every provider module this build ships, regardless of the manifest. Used by explain. */
export function allProviders(m?: Manifest): Provider[] {
  return Object.values(FACTORIES).map((factory) => factory(m))
}

export function collectSpecs(m: Manifest, state: ProjectState, providers: Provider[]): ResourceSpec[] {
  const providerSpecs = providers.flatMap((p) => p.resources(m, state))
  return applyWiring(m, state, providerSpecs)
}

/** Plain language for a resource id or an error code, from whichever module owns it. */
export function explainKey(key: string, lang: Lang, m?: Manifest): string | undefined {
  for (const provider of allProviders(m)) {
    const text = provider.explain(key, lang)
    if (text && !text.startsWith('No explanation for')) return text
  }
  const fromWiring = wiringExplain(key, lang)
  if (fromWiring) return fromWiring
  const core = CORE_EXPLAIN[key]
  if (core) return (lang === 'es' && core.es) || core.en
  return undefined
}
