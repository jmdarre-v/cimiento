// any hosting + posthog: the ingestion host goes to the hosting env next to the project key, so the
// app sends events to the region the project lives in. The key itself is a declared secret.

import { hostingDeploymentId, hostingEnvSpec, hostingOf } from '../core/hosting'
import type { ProjectState } from '../core/state'
import type { Manifest } from '../manifest/schema'
import { POSTHOG_HOST_NAME, posthogHost } from '../providers/posthog'
import type { WiringResult, WiringRule } from './types'

export const hostingPosthogRule: WiringRule = {
  id: 'hosting+posthog',
  pair: ['hosting', 'posthog'],

  applies(m: Manifest): boolean {
    return m.slots.analytics === 'posthog' && hostingOf(m) !== undefined
  },

  build(m: Manifest, _state: ProjectState): WiringResult {
    const hosting = hostingOf(m)!
    const specs = m.environments.map((environment) =>
      hostingEnvSpec(hosting, POSTHOG_HOST_NAME, environment, { source: 'literal', value: posthogHost(m.options.posthog.host), public: true }),
    )
    return { specs, edges: specs.map((s) => ({ from: hostingDeploymentId(hosting), to: s.id })) }
  },

  explain(key: string, lang: 'en' | 'es'): string | undefined {
    if (!key.includes(`.env.${POSTHOG_HOST_NAME}.`)) return undefined
    return lang === 'es'
      ? 'La direccion de PostHog a la que la app envia eventos, segun la region del proyecto. Es publica.'
      : 'The PostHog address the app sends events to, for the region the project lives in. It is public.'
  },
}
