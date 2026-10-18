// vercel + supabase, both paths from spec section 6.
//
// via-hosting: the project is created through the Vercel Marketplace and the keys land in the
// Vercel env by themselves. The first install needs a person to accept the Marketplace terms.
//
// direct: see hosting-supabase-direct.ts, which serves every hosting provider.

import { previewDatabaseIsolated } from '../core/hosting'
import type { ProjectState } from '../core/state'
import type { ResourceSpec } from '../core/types'
import type { Manifest } from '../manifest/schema'
import type { WiringResult, WiringRule } from './types'

const MARKETPLACE_URL = 'https://vercel.com/marketplace/supabase'

const EXPLAIN: Record<string, { en: string; es?: string }> = {
  'vercel.marketplace-terms': {
    en: 'Vercel asks a person to accept the Marketplace terms the first time an integration is installed on an account. cimiento cannot click that for you, so it opens the page, waits while you install it, and checks that Supabase really shows as installed before it continues.',
    es: 'Vercel pide que una persona acepte los terminos del Marketplace la primera vez que se instala una integracion. cimiento no puede hacerlo por ti: abre la pagina, espera mientras lo instalas y comprueba que Supabase aparece instalado antes de seguir.',
  },
  'vercel.binding.supabase-preview-install': {
    en: 'A second Supabase database from the Vercel Marketplace, connected to the preview environment only, so previews never read the production database.',
    es: 'Una segunda base de datos de Supabase del Marketplace de Vercel, conectada solo al entorno de vista previa, para que las vistas previas nunca lean la base de datos de produccion.',
  },
  'vercel.binding.supabase-install': {
    en: 'Installing the Supabase integration into the Vercel project. This is what creates the database and puts its address and keys into your environment variables.',
    es: 'Instalar la integracion de Supabase en el proyecto de Vercel. Esto crea la base de datos y pone su direccion y claves en tus variables de entorno.',
  },
}

export const vercelSupabaseRule: WiringRule = {
  id: 'vercel+supabase',
  pair: ['vercel', 'supabase'],

  applies(m: Manifest): boolean {
    const usesSupabase = m.slots.database === 'supabase' || m.slots.auth === 'supabase'
    return usesSupabase && m.slots.hosting === 'vercel' && m.accounts.supabase === 'via-hosting'
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
      const isolated = previewDatabaseIsolated(m)
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
          // Previews never get the production keys unless stack.yaml says shared (Goal 7).
          inputs: { projectId, name: m.slug, environments: vercelTargets(isolated ? m.environments.filter((e) => e !== 'preview') : m.environments) },
          // Not billable on its own: it creates the one database supabase.project stands for, and
          // that item carries the single billing warning.
        },
      ]
      if (isolated) {
        // A second Marketplace database, connected to the preview environment only.
        specs.push({
          id: 'vercel.binding.supabase-preview-install',
          kind: 'binding',
          provider: 'vercel',
          dependsOn: ['vercel.project', 'vercel.marketplace-terms', 'vercel.binding.supabase-install'],
          inputs: { projectId, name: `${m.slug}-preview`, project: m.slug, environments: 'preview' },
        })
      }
      return {
        specs,
        // Nothing should deploy before the database keys are in the environment.
        edges: [{ from: 'vercel.deployment', to: 'vercel.binding.supabase-install' }],
      }
    }

    // The direct path is hosting-supabase-direct.ts, shared with Netlify.
    return { specs: [], edges: [] }
  },

  explain(key: string, lang: 'en' | 'es'): string | undefined {
    const entry = EXPLAIN[key]
    if (!entry) return undefined
    return (lang === 'es' && entry.es) || entry.en
  },
}

/** The Vercel environment names for cimiento's, as the CLI's --environment takes them. */
function vercelTargets(environments: Manifest['environments']): string {
  return environments.map((e) => (e === 'dev' ? 'development' : e)).join(',')
}
