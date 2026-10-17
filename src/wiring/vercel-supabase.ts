// vercel + supabase, both paths from spec section 6.
//
// via-hosting: the project is created through the Vercel Marketplace and the keys land in the
// Vercel env by themselves. The first install needs a person to accept the Marketplace terms.
//
// direct: the project is created through the Supabase API and cimiento pushes the URL, the anon
// key and the service role key into the Vercel env, per environment.

import type { ProjectState } from '../core/state'
import type { ResourceSpec } from '../core/types'
import type { Manifest } from '../manifest/schema'
import { envResourceId } from '../providers/vercel'
import type { WiringResult, WiringRule } from './types'

const MARKETPLACE_URL = 'https://vercel.com/marketplace/supabase'

const EXPLAIN: Record<string, { en: string; es?: string }> = {
  'vercel.marketplace-terms': {
    en: 'Vercel asks a person to accept the Marketplace terms the first time an integration is installed on an account. cimiento cannot click that for you, so it opens the page, waits while you install it, and checks that Supabase really shows as installed before it continues.',
    es: 'Vercel pide que una persona acepte los terminos del Marketplace la primera vez que se instala una integracion. cimiento no puede hacerlo por ti: abre la pagina, espera mientras lo instalas y comprueba que Supabase aparece instalado antes de seguir.',
  },
  'vercel.binding.supabase-install': {
    en: 'Installing the Supabase integration into the Vercel project. This is what creates the database and puts its address and keys into your environment variables.',
    es: 'Instalar la integracion de Supabase en el proyecto de Vercel. Esto crea la base de datos y pone su direccion y claves en tus variables de entorno.',
  },
}

/** The three values a Next.js application needs to reach Supabase. */
const DIRECT_KEYS: { key: string; ref: string; publicValue: boolean }[] = [
  { key: 'NEXT_PUBLIC_SUPABASE_URL', ref: 'supabase.project:projectUrl', publicValue: true },
  { key: 'NEXT_PUBLIC_SUPABASE_ANON_KEY', ref: 'supabase.project:anonKey', publicValue: false },
  { key: 'SUPABASE_SERVICE_ROLE_KEY', ref: 'supabase.project:serviceRoleKey', publicValue: false },
]

export const vercelSupabaseRule: WiringRule = {
  id: 'vercel+supabase',
  pair: ['vercel', 'supabase'],

  applies(m: Manifest): boolean {
    const usesSupabase = m.slots.database === 'supabase' || m.slots.auth === 'supabase'
    return usesSupabase && m.slots.hosting === 'vercel'
  },

  build(m: Manifest, _state: ProjectState): WiringResult {
    const projectId = { deferred: 'vercel.project:projectId' }
    // On both paths the Supabase project first looks for the database the hosting env already
    // points at, so it needs the Vercel project to exist and to know its name.
    const database: ResourceSpec = {
      id: 'supabase.project',
      kind: 'resource',
      provider: 'supabase',
      dependsOn: ['vercel.project'],
      inputs: { hostingProject: m.slug },
    }
    if (m.accounts.supabase === 'via-hosting') {
      const specs: ResourceSpec[] = [
        // Whether the install step made the database decides created or adopted, and so whether
        // down may delete it.
        { ...database, inputs: { ...database.inputs, installedBy: { deferred: 'vercel.binding.supabase-install:installedBy' } } },
        {
          id: 'vercel.marketplace-terms',
          kind: 'manual',
          provider: 'vercel',
          // After the Supabase session, so the instructions can name the organization to link, and
          // after the Vercel project, so a database created in the Install dialog can be
          // connected to it.
          dependsOn: ['vercel.session', 'supabase.session', 'vercel.project'],
          inputs: {},
          manual: {
            // A fallback. At the moment of asking, the vercel provider's verify returns the same
            // words with the actual team and organization filled in.
            instructions: [
              'cimiento has opened the Supabase page of the Vercel Marketplace in your browser.',
              'Click Install, accept the terms, and choose the same Vercel team this project uses.',
              'When Vercel asks, choose Link Existing Supabase Account if you already use Supabase, and grant the organization stack.yaml pins; otherwise choose Create New Supabase Account.',
              'If Vercel then offers to create a database, you can let it: cimiento finds that database and adopts it, and never creates a second one.',
              'Come back here and press Enter. cimiento checks that Supabase shows as installed before it goes on.',
              'You only do this once per Vercel team.',
            ].join(' '),
            url: MARKETPLACE_URL,
          },
        },
        {
          id: 'vercel.binding.supabase-install',
          kind: 'binding',
          provider: 'vercel',
          dependsOn: ['vercel.project', 'vercel.marketplace-terms'],
          inputs: { projectId, name: m.slug },
          // Not billable on its own: it creates the one database supabase.project stands for, and
          // that item carries the single billing warning.
        },
      ]
      return {
        specs,
        // Nothing should deploy before the database keys are in the environment.
        edges: [{ from: 'vercel.deployment', to: 'vercel.binding.supabase-install' }],
      }
    }

    const specs: ResourceSpec[] = [database]
    const envIds: string[] = []
    for (const environment of m.environments) {
      for (const entry of DIRECT_KEYS) {
        const id = envResourceId(entry.key, environment)
        envIds.push(id)
        specs.push({
          id,
          kind: 'binding',
          provider: 'vercel',
          dependsOn: ['vercel.project', 'supabase.project'],
          inputs: {
            projectId,
            key: entry.key,
            environment,
            source: 'literal',
            value: { deferred: entry.ref },
          },
        })
      }
    }
    return {
      specs,
      edges: envIds.map((id) => ({ from: 'vercel.deployment', to: id })),
    }
  },

  explain(key: string, lang: 'en' | 'es'): string | undefined {
    const entry = EXPLAIN[key]
    if (!entry) return undefined
    return (lang === 'es' && entry.es) || entry.en
  },
}
