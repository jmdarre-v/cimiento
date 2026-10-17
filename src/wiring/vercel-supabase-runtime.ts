// Runtime knowledge that belongs to the vercel + supabase pair rather than to either provider:
// which Supabase database the hosting env already points at, what the Marketplace Install
// dialog will ask, and which Supabase organization a project bills to.
//
// It imports only the two API helpers, never a provider module, so either provider can use it
// without an import cycle.

import { renderPersonStep, type PersonStep } from '../core/person'
import { marketplaceStep } from '../core/person-steps'
import type { Ctx } from '../core/types'
import { supabaseCall } from '../providers/supabase/api'
import { vercelCall } from '../providers/vercel/api'

/** Env var names that carry the database address, in the order they are trusted. */
const URL_KEYS = ['SUPABASE_URL', 'NEXT_PUBLIC_SUPABASE_URL']

interface VercelEnvEntry {
  id: string
  key: string
  target: string[]
}

/**
 * The ref of the Supabase database the hosting project's env already points at, or undefined when
 * there is none. Goal 1 Part B found a Marketplace install that created a database named after
 * something other than the project, so a lookup by name missed it and the planner offered to
 * create a second one. The env is the source of truth for which database the app will use.
 *
 * Only the URL variable is read. It is not a secret, but Vercel stores integration variables
 * encrypted, so it is fetched on its own and nothing else is decrypted.
 */
export async function hostingSupabaseRef(ctx: Ctx, resource: string, vercelProject: string): Promise<string | undefined> {
  if (!vercelProject) return undefined
  const list = await vercelCall<{ envs?: VercelEnvEntry[] }>(
    ctx,
    resource,
    'GET',
    `/v9/projects/${encodeURIComponent(vercelProject)}/env`,
  ).catch(() => undefined)
  if (!list?.ok) return undefined
  const envs = list.body?.envs ?? []
  for (const key of URL_KEYS) {
    const entry = envs.find((e) => e.key === key)
    if (!entry) continue
    const one = await vercelCall<{ value?: string }>(
      ctx,
      resource,
      'GET',
      `/v1/projects/${encodeURIComponent(vercelProject)}/env/${encodeURIComponent(entry.id)}`,
    ).catch(() => undefined)
    const ref = refFromUrl(one?.body?.value)
    if (ref) return ref
  }
  return undefined
}

export function refFromUrl(value: string | undefined): string | undefined {
  if (!value) return undefined
  try {
    const host = new URL(value).host
    const match = /^([a-z0-9]{20})\.supabase\.(co|in)$/.exec(host)
    return match ? match[1] : undefined
  } catch {
    return undefined
  }
}

export interface SupabaseOrg {
  id: string
  name: string
  plan: string
}

/** Every organization with its plan. The list endpoint has no plan, so each is read once. */
export async function supabaseOrgsWithPlans(ctx: Ctx, resource: string): Promise<SupabaseOrg[]> {
  const list = await supabaseCall<{ id: string; name: string }[]>(ctx, resource, 'GET', '/v1/organizations')
  if (!list.ok) return []
  const orgs: SupabaseOrg[] = []
  for (const org of list.body ?? []) {
    const detail = await supabaseCall<{ plan?: string }>(ctx, resource, 'GET', `/v1/organizations/${encodeURIComponent(org.id)}`)
    orgs.push({ id: org.id, name: org.name, plan: (detail.ok && detail.body?.plan) || 'unknown' })
  }
  return orgs
}

export function isPaidPlan(plan: string): boolean {
  return plan !== 'free' && plan !== 'hobby' && plan !== 'unknown'
}

export async function supabaseOrg(ctx: Ctx, resource: string, id: string): Promise<SupabaseOrg | undefined> {
  const detail = await supabaseCall<{ id?: string; name?: string; plan?: string }>(
    ctx,
    resource,
    'GET',
    `/v1/organizations/${encodeURIComponent(id)}`,
  ).catch(() => undefined)
  if (!detail?.ok || !detail.body) return undefined
  return { id, name: detail.body.name ?? id, plan: detail.body.plan ?? 'unknown' }
}

export async function vercelTeamPlan(ctx: Ctx, resource: string, team: string): Promise<{ name: string; plan: string } | undefined> {
  const path = team.startsWith('team_') ? `/v2/teams/${encodeURIComponent(team)}` : `/v2/teams?slug=${encodeURIComponent(team)}`
  const result = await vercelCall<{ name?: string; slug?: string; billing?: { plan?: string } }>(ctx, resource, 'GET', path).catch(
    () => undefined,
  )
  if (!result?.ok || !result.body) return undefined
  return { name: result.body.name ?? result.body.slug ?? team, plan: result.body.billing?.plan ?? 'unknown' }
}

/**
 * The words for the Marketplace step. The Install dialog asks whether to create a new Supabase
 * account or link an existing one. With a Supabase login and a pinned organization, linking keeps
 * the database in the organization cimiento manages and bills to; otherwise Vercel creates one.
 */
export async function marketplacePersonStep(ctx: Ctx, resource: string): Promise<PersonStep> {
  const orgId = ctx.manifest.options.supabase.organization_id
  const org = orgId ? await supabaseOrg(ctx, resource, orgId) : undefined
  const team = ctx.manifest.accounts.vercel
  const teamInfo = team ? await vercelTeamPlan(ctx, resource, team) : undefined
  return marketplaceStep({ ...(teamInfo ? { team: teamInfo.name } : team ? { team } : {}), ...(org ? { organization: org.name } : {}) })
}

export async function marketplaceInstructions(ctx: Ctx, resource: string): Promise<string> {
  const step = await marketplacePersonStep(ctx, resource)
  const text = renderPersonStep(step, ctx.lang, { links: false })
  // Only an attended run opens the page. An unattended one says where the person continues.
  return ctx.interactive ? text : `This needs you at a browser once. Run cimiento up in a terminal in ${ctx.cwd}; it walks you through it.\n${text}`
}

/** When the hosting project was created, to tell a database made for it from an older one. */
export async function hostingProjectCreatedAt(ctx: Ctx, resource: string, vercelProject: string): Promise<number | undefined> {
  const result = await vercelCall<{ createdAt?: number }>(ctx, resource, 'GET', `/v9/projects/${encodeURIComponent(vercelProject)}`).catch(
    () => undefined,
  )
  return result?.ok ? result.body?.createdAt : undefined
}
