// vercel + inngest, spec section 6. A person approves the Inngest Vercel integration once per team,
// and the integration puts the signing key and the event key into the project env. The first
// deployment waits for both, so the app is built with them. Deployment protection: standard
// protection leaves production public, which is where Inngest calls the app (docs/DECISIONS.md).

import type { ProjectState } from '../core/state'
import type { Manifest } from '../manifest/schema'
import { INNGEST_INTEGRATION_URL } from '../providers/inngest'
import type { WiringResult, WiringRule } from './types'

export const vercelInngestRule: WiringRule = {
  id: 'vercel+inngest',
  pair: ['vercel', 'inngest'],

  applies(m: Manifest): boolean {
    return m.slots.jobs === 'inngest' && m.slots.hosting === 'vercel'
  },

  build(m: Manifest, _state: ProjectState): WiringResult {
    const projectId = { deferred: 'vercel.project:projectId' }
    const url = m.domain ? `https://${m.domain}` : { deferred: 'vercel.deployment:productionUrl' }
    return {
      specs: [
        {
          id: 'inngest.vercel-integration',
          kind: 'manual',
          provider: 'inngest',
          dependsOn: ['vercel.session', 'vercel.project'],
          inputs: { projectId, project: m.slug },
          manual: {
            // A fallback. At the moment of asking, verify returns the same steps with the team and
            // what is still missing filled in.
            instructions: `Approve the Inngest integration on Vercel at ${INNGEST_INTEGRATION_URL} for the project ${m.slug}. Inngest puts INNGEST_EVENT_KEY and INNGEST_SIGNING_KEY into the project by itself, and cimiento checks both before it goes on.`,
            url: INNGEST_INTEGRATION_URL,
          },
        },
        {
          id: 'inngest.app',
          kind: 'binding',
          provider: 'inngest',
          dependsOn: ['vercel.deployment', 'inngest.vercel-integration'],
          inputs: { url, projectId },
        },
        {
          id: 'inngest.check.roundtrip',
          kind: 'check',
          provider: 'inngest',
          dependsOn: ['inngest.app'],
          inputs: { projectId },
        },
      ],
      edges: [{ from: 'vercel.deployment', to: 'inngest.vercel-integration' }],
    }
  },

  explain(): string | undefined {
    return undefined
  },
}
