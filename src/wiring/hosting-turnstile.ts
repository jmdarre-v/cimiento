// any hosting + turnstile, spec section 6. The site key is public and the secret key goes to the
// hosting env, both before the first deployment so the app is built with them. Production gets the
// widget's own keys; preview and dev get Cloudflare's test keys, because Turnstile has no wildcard
// hostnames and preview hosts are not subdomains of production (docs/DECISIONS.md). After the
// first deployment the widget's domains follow the production host.

import { defaultHost, HOSTING_NAMES, hostingDeploymentId, hostingEnvSpec, hostingOf, productionUrlRef } from '../core/hosting'
import { parseHostingEnvId } from '../core/sink-ids'
import type { ProjectState } from '../core/state'
import type { ResourceSpec, Value } from '../core/types'
import type { Manifest } from '../manifest/schema'
import { TURNSTILE_TEST_SECRET_KEY, TURNSTILE_TEST_SITE_KEY } from '../providers/turnstile'
import type { WiringResult, WiringRule } from './types'

export const TURNSTILE_SITE_KEY_NAME = 'NEXT_PUBLIC_TURNSTILE_SITE_KEY'
export const TURNSTILE_SECRET_KEY_NAME = 'TURNSTILE_SECRET_KEY'

export const hostingTurnstileRule: WiringRule = {
  id: 'hosting+turnstile',
  pair: ['hosting', 'turnstile'],

  applies(m: Manifest): boolean {
    return m.slots.bot_protection === 'turnstile' && hostingOf(m) !== undefined
  },

  build(m: Manifest, _state: ProjectState): WiringResult {
    const hosting = hostingOf(m)!
    const domains = [m.domain, defaultHost(hosting, m.slug)].filter(Boolean).join(',')
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
        const spec = hostingEnvSpec(hosting, key, environment, { source: 'literal', value, public: key === TURNSTILE_SITE_KEY_NAME }, production ? ['turnstile.widget'] : [])
        envIds.push(spec.id)
        specs.push(spec)
      }
    }
    specs.push({
      id: 'turnstile.binding.domains',
      kind: 'binding',
      provider: 'turnstile',
      dependsOn: ['turnstile.widget', hostingDeploymentId(hosting)],
      inputs: {
        accountId: { deferred: 'turnstile.session:account' },
        productionUrl: productionUrlRef(hosting),
        domain: m.domain ?? '',
      },
    })
    return {
      specs,
      edges: envIds.map((id) => ({ from: hostingDeploymentId(hosting), to: id })),
    }
  },

  explain(key: string, lang: 'en' | 'es'): string | undefined {
    const parsed = parseHostingEnvId(key)
    if (!parsed || (parsed.key !== TURNSTILE_SITE_KEY_NAME && parsed.key !== TURNSTILE_SECRET_KEY_NAME)) return undefined
    const environment = parsed.environment
    const vendor = HOSTING_NAMES[parsed.provider as 'vercel' | 'netlify']
    const isSecret = key.includes(TURNSTILE_SECRET_KEY_NAME)
    if (environment !== 'production') {
      return lang === 'es'
        ? `La clave ${isSecret ? 'secreta' : 'publica'} de Turnstile para ${environment}: la clave de prueba de Cloudflare, que siempre pasa, porque las direcciones de vista previa cambian con cada despliegue.`
        : `The Turnstile ${isSecret ? 'secret' : 'site'} key for ${environment}: Cloudflare's test key, which always passes, because preview addresses change with every deployment and a widget only loads on hosts it knows.`
    }
    return lang === 'es'
      ? `La clave ${isSecret ? 'secreta' : 'publica'} del widget de Turnstile de este proyecto, puesta en el entorno de produccion de ${vendor}. cimiento la escribe y nunca la imprime.`
      : `The ${isSecret ? 'secret' : 'site'} key of this project's Turnstile widget, written to the ${vendor} production env. ${isSecret ? 'cimiento writes it and never prints it.' : 'It is public by design: the page needs it to show the widget.'}`
  },
}
