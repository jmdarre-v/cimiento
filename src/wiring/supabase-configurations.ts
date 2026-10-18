// Supabase installations on the Vercel team, for the via-hosting path. `vercel integration add
// supabase` takes the first Marketplace configuration on the team without asking, and a database
// it creates lands in that configuration's Vercel-managed organization, whatever organization
// stack.yaml pins. cimiento shows that configuration with the databases and projects it already
// serves and lets the person choose before anything is created (BUG-46).

import { CimientoError } from '../core/errors'
import type { Ctx } from '../core/types'
import { setInManifest } from '../manifest/pin'
import { vercelCall } from '../providers/vercel/api'

export interface ServedDatabase {
  name: string
  ref: string
  storeId: string
  projects: string[]
}

export interface SupabaseConfiguration {
  id: string
  /** The Supabase organization Vercel manages for this configuration. */
  organization: string
  databases: ServedDatabase[]
}

interface Store {
  id: string
  name: string
  externalResourceId?: string
  product?: { slug?: string; integrationConfigurationId?: string }
  projectsMetadata?: { name?: string; projectId?: string }[]
}

async function stores(ctx: Ctx, resource: string): Promise<Store[]> {
  const result = await vercelCall<{ stores?: Store[] }>(ctx, resource, 'GET', '/v1/storage/stores')
  return result.ok ? (result.body?.stores ?? []) : []
}

/** The configuration `vercel integration add supabase` would use, with what it already serves. */
export async function marketplaceSupabaseConfiguration(ctx: Ctx, resource: string): Promise<SupabaseConfiguration | undefined> {
  // The same query the Vercel CLI makes in getFirstConfiguration.
  const list = await vercelCall<{ id: string }[] | { configurations?: { id: string }[] }>(
    ctx,
    resource,
    'GET',
    '/v2/integrations/configurations?view=account&installationType=marketplace&integrationIdOrSlug=supabase',
  )
  if (!list.ok) return undefined
  const configurations = Array.isArray(list.body) ? list.body : (list.body?.configurations ?? [])
  const first = configurations[0]
  if (!first) return undefined
  const databases = (await stores(ctx, resource))
    .filter((s) => s.product?.integrationConfigurationId === first.id)
    .map((s) => ({
      name: s.name,
      ref: s.externalResourceId ?? '',
      storeId: s.id,
      projects: (s.projectsMetadata ?? []).map((p) => p.name ?? p.projectId ?? '').filter(Boolean),
    }))
  return { id: first.id, organization: `vercel_${first.id}`, databases }
}

/** The Vercel Marketplace resource that holds a database, when the Marketplace created it. */
export async function storeForDatabase(ctx: Ctx, resource: string, ref: string): Promise<(Store & { sameName: number }) | undefined> {
  const all = await stores(ctx, resource)
  const store = all.find((s) => s.externalResourceId === ref)
  if (!store) return undefined
  return { ...store, sameName: all.filter((s) => s.name === store.name).length }
}

export function describeConfiguration(cfg: SupabaseConfiguration): string {
  const serves = cfg.databases.length
    ? cfg.databases.map((d) => `${d.name} (${d.ref}) for ${d.projects.join(', ') || 'no project'}`).join('; ')
    : 'no database yet'
  return `Supabase configuration ${cfg.id} on the Vercel team, organization ${cfg.organization}, serving: ${serves}`
}

/**
 * Settles the via-hosting path when the team already has a Marketplace configuration: reuse it,
 * pinned as options.supabase.marketplace_configuration, or switch to the direct path with the
 * organization stack.yaml pins. Asked only in a terminal, before the plan; during apply a missing
 * answer is a step waiting on a person, never a silent reuse.
 */
export async function settleSupabasePath(ctx: Ctx, resource: string, opts: { ask: boolean }): Promise<'reuse' | 'direct' | 'install' | undefined> {
  if (ctx.manifest.accounts.supabase !== 'via-hosting') return undefined
  // Only a project that uses Supabase, on Vercel, has a Marketplace path to settle (BUG-66).
  const m = ctx.manifest
  if ((m.slots.database !== 'supabase' && m.slots.auth !== 'supabase') || m.slots.hosting !== 'vercel') return undefined
  const cfg = await marketplaceSupabaseConfiguration(ctx, resource)
  if (!cfg) return 'install'
  if (ctx.manifest.options.supabase.marketplace_configuration === cfg.id) return 'reuse'
  // A configuration that serves nothing else, such as the one the person installed for this
  // project in the Marketplace step, is not shared, so there is nothing to choose.
  const others = cfg.databases.filter((d) => !d.projects.includes(ctx.manifest.slug))
  if (others.length === 0) return 'reuse'
  const description = describeConfiguration(cfg)
  const org = ctx.manifest.options.supabase.organization_id
  if (!opts.ask || !ctx.interactive || !ctx.choose) {
    throw new CimientoError({
      code: 'SUPABASE_CONFIGURATION_CHOICE_NEEDED',
      provider: 'vercel',
      resource,
      message: `${description}. vercel integration add would put the ${ctx.manifest.slug} database there, in ${cfg.organization}, not in the organization stack.yaml pins.`,
      hint: `Run cimiento up in a terminal in ${ctx.cwd}. Before the plan it asks whether to reuse ${cfg.id} or to create the database directly in ${org ?? 'an organization you pick'}.`,
      retryable: true,
      needsHuman: true,
    })
  }
  const answer = await ctx.choose(`${description}.\nWhere should the ${ctx.manifest.slug} database go?`, [
    {
      value: 'direct',
      label: `Create it directly with the Supabase API in ${org ? `organization ${org}` : 'the organization you pick next'}, and leave ${cfg.id} as it is`,
    },
    {
      value: 'reuse',
      label: `Reuse ${cfg.id}: a new database in ${cfg.organization}, next to ${cfg.databases.map((d) => d.name).join(', ') || 'nothing else'}`,
      warning: 'It bills through that configuration on the Vercel team, and down deletes only the database cimiento creates there.',
    },
  ])
  if (answer === 'reuse') setInManifest(ctx, ['options', 'supabase', 'marketplace_configuration'], cfg.id)
  else setInManifest(ctx, ['accounts', 'supabase'], 'direct')
  return answer === 'reuse' ? 'reuse' : 'direct'
}
