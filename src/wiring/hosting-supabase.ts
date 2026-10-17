// any hosting + supabase: the Supabase Auth Site URL and redirect list follow the production URL
// and the preview pattern. Both are deferred until the first deployment exists.

import type { ProjectState } from '../core/state'
import type { Manifest } from '../manifest/schema'
import type { WiringResult, WiringRule } from './types'

const EXPLAIN: Record<string, { en: string; es?: string }> = {
  'supabase.binding.auth-urls': {
    en: 'Supabase needs to know the address of your site so that sign in links, magic links and password resets bring people back to it. cimiento only knows that address after the first deployment, so it sets this last.',
    es: 'Supabase necesita saber la direccion de tu sitio para que los enlaces de inicio de sesion regresen a el. cimiento solo conoce esa direccion despues del primer despliegue, asi que la configura al final.',
  },
}

export const hostingSupabaseRule: WiringRule = {
  id: 'hosting+supabase',
  pair: ['vercel', 'supabase'],

  applies(m: Manifest): boolean {
    return m.slots.auth === 'supabase' && m.slots.hosting !== 'none'
  },

  build(m: Manifest, _state: ProjectState): WiringResult {
    const projectRef = { deferred: 'supabase.project:projectRef' }
    const siteUrl = m.domain ? `https://${m.domain}` : { deferred: 'vercel.deployment:productionUrl' }
    const previewPattern = `https://${m.slug}-*.vercel.app/**`
    return {
      specs: [
        {
          id: 'supabase.binding.auth-urls',
          kind: 'binding',
          provider: 'supabase',
          dependsOn: ['supabase.project', 'vercel.deployment'],
          inputs: { projectRef, siteUrl, previewPattern },
        },
        {
          id: 'supabase.check.auth-urls',
          kind: 'check',
          provider: 'supabase',
          dependsOn: ['supabase.binding.auth-urls'],
          inputs: { projectRef, siteUrl },
        },
      ],
      edges: [],
    }
  },

  explain(key: string, lang: 'en' | 'es'): string | undefined {
    const entry = EXPLAIN[key]
    if (!entry) return undefined
    return (lang === 'es' && entry.es) || entry.en
  },
}
