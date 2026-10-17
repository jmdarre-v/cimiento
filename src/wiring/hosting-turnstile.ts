// any hosting + turnstile, spec section 6. The site key is public and the secret key goes to the
// hosting env, both before the first deployment so the app is built with them. Production gets the
// widget's own keys; preview and dev get Cloudflare's test keys, because Turnstile has no wildcard
// hostnames and preview hosts are not subdomains of production (docs/DECISIONS.md). After the
// first deployment the widget's domains follow the production host.

import type { ProjectState } from '../core/state'
import type { ResourceSpec, Value } from '../core/types'
import type { Manifest } from '../manifest/schema'
import { envResourceId } from '../providers/vercel'
import { TURNSTILE_TEST_SECRET_KEY, TURNSTILE_TEST_SITE_KEY } from '../providers/turnstile'
import type { WiringResult, WiringRule } from './types'

export const TURNSTILE_SITE_KEY_NAME = 'NEXT_PUBLIC_TURNSTILE_SITE_KEY'
export const TURNSTILE_SECRET_KEY_NAME = 'TURNSTILE_SECRET_KEY'

export const hostingTurnstileRule: WiringRule = {
  id: 'hosting+turnstile',
  pair: ['vercel', 'turnstile'],

  applies(m: Manifest): boolean {
    return m.slots.bot_protection === 'turnstile' && m.slots.hosting === 'vercel'
  },

  build(m: Manifest, _state: ProjectState): WiringResult {
    const projectId = { deferred: 'vercel.project:projectId' }
    const domains = [m.domain, `${m.slug}.vercel.app`].filter(Boolean).join(',')
    const specs: ResourceSpec[] = [
      { id: 'turnstile.widget', kind: 'resource', provider: 'turnstile', dependsOn: [], inputs: { domains } },
    ]
    const envIds: string[] = []
    for (const environment of m.environments) {
      const production = environment === 'production'
      const values: [string, Value][] = [
        [TURNSTILE_SITE_KEY_NAME, production ? { deferred: 'turnstile.widget:sitekey' } : TURNSTILE_TEST_SITE_KEY],
        [TURNSTILE_SECRET_KEY_NAME, production ? { deferred: 'turnstile.widget:secret' } : TURNSTILE_TEST_SECRET_KEY],
      ]
      for (const [key, value] of values) {
        const id = envResourceId(key, environment)
        envIds.push(id)
        specs.push({
          id,
          kind: 'binding',
          provider: 'vercel',
          dependsOn: production ? ['vercel.project', 'turnstile.widget'] : ['vercel.project'],
          inputs: { projectId, key, environment, source: 'literal', value, ...(key === TURNSTILE_SITE_KEY_NAME ? { public: 'true' } : {}) },
        })
      }
    }
    specs.push({
      id: 'turnstile.binding.domains',
      kind: 'binding',
      provider: 'turnstile',
      dependsOn: ['turnstile.widget', 'vercel.deployment'],
      inputs: {
        accountId: { deferred: 'turnstile.session:account' },
        productionUrl: { deferred: 'vercel.deployment:productionUrl' },
        domain: m.domain ?? '',
      },
    })
    return {
      specs,
      edges: envIds.map((id) => ({ from: 'vercel.deployment', to: id })),
    }
  },

  explain(key: string, lang: 'en' | 'es'): string | undefined {
    if (!key.startsWith(`vercel.env.${TURNSTILE_SITE_KEY_NAME}.`) && !key.startsWith(`vercel.env.${TURNSTILE_SECRET_KEY_NAME}.`)) return undefined
    const environment = key.split('.')[3] ?? 'an environment'
    const isSecret = key.includes(TURNSTILE_SECRET_KEY_NAME)
    if (environment !== 'production') {
      return lang === 'es'
        ? `La clave ${isSecret ? 'secreta' : 'publica'} de Turnstile para ${environment}: la clave de prueba de Cloudflare, que siempre pasa, porque las direcciones de vista previa cambian con cada despliegue.`
        : `The Turnstile ${isSecret ? 'secret' : 'site'} key for ${environment}: Cloudflare's test key, which always passes, because preview addresses change with every deployment and a widget only loads on hosts it knows.`
    }
    return lang === 'es'
      ? `La clave ${isSecret ? 'secreta' : 'publica'} del widget de Turnstile de este proyecto, puesta en el entorno de produccion de Vercel. cimiento la escribe y nunca la imprime.`
      : `The ${isSecret ? 'secret' : 'site'} key of this project's Turnstile widget, written to the Vercel production env. ${isSecret ? 'cimiento writes it and never prints it.' : 'It is public by design: the page needs it to show the widget.'}`
  },
}
