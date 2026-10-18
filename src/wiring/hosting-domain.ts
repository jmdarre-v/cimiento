// any hosting + custom domain, spec section 6: the domain is added to the hosting project, and a
// check proves it serves the site over https. Supabase Auth URLs and Turnstile domains follow
// stack.yaml's domain in their own rules (hosting-supabase.ts, hosting-turnstile.ts), so cimiento
// domain add and remove only change stack.yaml and apply the affected items.

import { hostingDeploymentId, hostingOf, hostingProjectId, hostingProjectRef } from '../core/hosting'
import type { ProjectState } from '../core/state'
import type { Manifest } from '../manifest/schema'
import type { WiringResult, WiringRule } from './types'

/** The items cimiento domain add and remove apply, for whichever providers the manifest selects. */
export function domainAffectedIds(m: Manifest): string[] {
  const hosting = hostingOf(m)
  if (!hosting) return []
  return [`${hosting}.binding.domain`, `${hosting}.check.domain`, 'supabase.binding.auth-urls', 'supabase.check.auth-urls', 'turnstile.binding.domains', 'turnstile.widget']
}

export const hostingDomainRule: WiringRule = {
  id: 'hosting+domain',
  pair: ['hosting', 'domain'],

  applies(m: Manifest): boolean {
    return hostingOf(m) !== undefined && Boolean(m.domain)
  },

  build(m: Manifest, _state: ProjectState): WiringResult {
    const hosting = hostingOf(m)!
    const projectId = hostingProjectRef(hosting)
    const domain = m.domain!
    return {
      specs: [
        {
          id: `${hosting}.binding.domain`,
          kind: 'binding',
          provider: hosting,
          // After the first deployment, so the domain points at a site that already answers.
          dependsOn: [hostingProjectId(hosting), hostingDeploymentId(hosting)],
          inputs: { projectId, domain, name: m.slug },
        },
        {
          id: `${hosting}.check.domain`,
          kind: 'check',
          provider: hosting,
          dependsOn: [`${hosting}.binding.domain`],
          inputs: { projectId, domain, name: m.slug, requireMarker: m.scaffold.template === 'none' ? 'false' : 'true' },
        },
      ],
      edges: [],
    }
  },

  explain(key: string, lang: 'en' | 'es'): string | undefined {
    if (!/^(vercel|netlify)\.(binding|check)\.domain$/.test(key)) return undefined
    const check = key.includes('.check.')
    if (lang === 'es') {
      return check
        ? 'Una prueba de que tu dominio responde 200 por https con el sitio. Si falla, cimiento dice el registro DNS exacto que falta.'
        : 'Tu propio dominio agregado al proyecto de hosting. Tu proveedor de DNS necesita un registro que apunte al hosting; cimiento lo nombra exacto.'
    }
    return check
      ? 'A probe that your domain answers 200 over https with the site. When it does not, cimiento names the exact DNS record that is missing.'
      : 'Your own domain added to the hosting project. Your DNS provider needs one record pointing at the hosting; cimiento names it exactly.'
  },
}
