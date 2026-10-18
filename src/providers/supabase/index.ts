// Supabase provider. Fills the database and auth slots, on both paths spec section 6 describes:
// via-hosting, where the Vercel Marketplace creates the project, and direct, where cimiento
// creates it through the Management API and pushes the keys into the hosting env store.

import { presenceFromStatus, type Presence } from '../../core/types'
import { randomBytes } from 'node:crypto'
import { existsSync, mkdirSync, readdirSync, readFileSync, writeFileSync } from 'node:fs'
import { isAbsolute, join } from 'node:path'
import { CimientoError } from '../../core/errors'
import { previewDatabaseIsolated } from '../../core/hosting'
import { recordedId } from '../../core/identity'
import type { ProjectState } from '../../core/state'
import {
  baseResources,
  ensureTool,
  ensureVendorSession,
  findTool,
  runVendorLogin,
  verifyTool, toolVersion } from '../../core/toolkit'
import { pinInManifest, setInManifest } from '../../manifest/pin'
import { BASELINE_FILE, BASELINE_SQL, BASELINE_TABLE } from '../../scaffold/templates/nextjs-app'
import type {
  BillingInfo,
  CheckResult,
  ChoiceOption,
  Ctx,
  Detection,
  EnsureResult,
  Lang,
  Output,
  Provider,
  ResourceSpec,
  Session,
  Slot,
  ToolSpec,
  Value,
} from '../../core/types'
import type { Manifest } from '../../manifest/schema'
import { findSupabaseToken, supabaseCall, supabaseError } from './api'
import {
  hostingProjectCreatedAt,
  hostingSupabaseRef,
  isPaidPlan,
  supabaseOrg,
  supabaseOrgsWithPlans,
} from '../../wiring/vercel-supabase-runtime'
import { databaseSecretExplain, SUPABASE_EXPLAIN } from './explain'
import { storeForDatabase } from '../../wiring/supabase-configurations'
import { databaseSinkSpecs, ensureDatabaseSecret, verifyDatabaseSecret } from '../../secrets/sinks'
import { supabaseFreeLimitStep, supabaseLoginStep, supabaseOrganizationStep } from '../../core/person-steps'

const ID = 'supabase'

const TOOLS: ToolSpec[] = [
  {
    name: 'Supabase CLI',
    bin: 'supabase',
    versionRange: '>=1.180.0',
    install: { brew: 'supabase/tap/supabase' },
    versionCmd: 'supabase --version',
  },
]

const LOGIN_HINT = 'cimiento up opens the Supabase login in your browser and waits while you approve it.'

interface SupabaseProject {
  created_at?: string
  id: string
  ref?: string
  name: string
  organization_id?: string
  region?: string
  status?: string
}

interface SupabaseApiKey {
  name: string
  api_key: string
}

interface SupabaseAuthConfig {
  site_url?: string
  uri_allow_list?: string
}

/** The project previews read when they do not share production's (Goal 7). */
export const PREVIEW_PROJECT = 'supabase.preview-project'

/** Said by plan and up before the preview project exists: it is a second project on the free limit. */
export function previewProjectNotice(m: Manifest, state: ProjectState): string | undefined {
  const usesSupabase = m.slots.database === ID || m.slots.auth === ID
  if (!usesSupabase || !previewDatabaseIsolated(m) || state.resources[PREVIEW_PROJECT]) return undefined
  return `${PREVIEW_PROJECT} is a second Supabase project, ${m.slug}-preview, which previews read instead of production. Supabase's free plan allows 2 active projects per person; with another active free project, Supabase refuses it and cimiento lists which projects count. environments.preview.database: shared in stack.yaml skips it.`
}

export function createSupabaseProvider(_m?: Manifest): Provider {
  const provider: Provider = {
    id: ID,
    fills: ['database', 'auth'] as Slot[],
    tools: TOOLS,
    needsSession: true,

    async detect(ctx: Ctx): Promise<Detection> {
      const version = await toolVersion(ctx, TOOLS.find((t) => t.bin === 'supabase')!)
      if (!version) return { installed: false }
      if (!(await findSupabaseToken(ctx))) return { installed: true, version }
      const orgs = await supabaseCall<{ id: string; name: string }[]>(ctx, 'supabase.session', 'GET', '/v1/organizations').catch(
        () => undefined,
      )
      const list = orgs?.ok ? (orgs.body ?? []) : []
      if (list.length === 0) return { installed: true, version }
      // The session is reported in the organization stack.yaml pins when the login can see it.
      // Reporting the first organization instead once named a paid organization the project does
      // not use, in the Goal 1 run.
      const pinned = ctx.manifest.options.supabase.organization_id
      const account = pinned && list.some((o) => o.id === pinned) ? pinned : list[0].id
      return { installed: true, version, session: { account } }
    },

    async login(ctx: Ctx): Promise<Session> {
      // Foreground with the terminal attached. Without a TTY the Supabase CLI refuses its browser
      // flow, which is how Part A of Goal 1 failed.
      await runVendorLogin(ctx, ID, 'Supabase', 'supabase', ['login'], supabaseLoginStep())
      const detection = await provider.detect(ctx)
      if (!detection.session) {
        throw new CimientoError({
          code: 'SESSION_LOGIN_FAILED',
          provider: ID,
          resource: 'supabase.session',
          message: 'The Supabase login finished but cimiento still cannot list your organizations.',
          hint: LOGIN_HINT,
          retryable: true,
          needsHuman: true,
        })
      }
      return detection.session
    },

    resources(manifest: Manifest, _state: ProjectState): ResourceSpec[] {
      const usesSupabase = manifest.slots.database === ID || manifest.slots.auth === ID
      if (!usesSupabase) return []
      const viaHosting = manifest.accounts.supabase === 'via-hosting'
      const specs = baseResources({ id: ID, tools: TOOLS, needsSession: true })

      // On the via-hosting path the Marketplace install creates the project, so the resource waits
      // on the wiring binding instead of creating anything itself.
      specs.push({
        id: 'supabase.project',
        kind: 'resource',
        provider: ID,
        dependsOn: viaHosting ? ['supabase.session', 'vercel.binding.supabase-install'] : ['supabase.session'],
        inputs: {
          name: manifest.slug,
          region: manifest.options.supabase.region,
          mode: viaHosting ? 'via-hosting' : 'direct',
          ...(manifest.options.supabase.organization_id
            ? { organizationId: manifest.options.supabase.organization_id }
            : {}),
        },
        billable: true,
      })

      if (manifest.slots.database === ID) {
        specs.push({
          id: 'supabase.migrations',
          // The schema lives inside the database, so this binds migrations to the project and
          // goes away with it, rather than being a resource of its own.
          kind: 'binding',
          provider: ID,
          dependsOn: ['supabase.project', 'supabase.tool.supabase'],
          inputs: {
            projectRef: { deferred: 'supabase.project:projectRef' },
            migrations: manifest.options.supabase.migrations,
          },
        })
        specs.push({
          id: 'supabase.check.migrated',
          kind: 'check',
          provider: ID,
          dependsOn: ['supabase.migrations'],
          inputs: {
            projectRef: { deferred: 'supabase.project:projectRef' },
            migrations: manifest.options.supabase.migrations,
          },
        })
      }

      // Previews read their own project, never production's (Goal 7). Via the Marketplace it is a
      // second database connected to the preview environment only; direct, cimiento creates it.
      if (previewDatabaseIsolated(manifest)) {
        specs.push({
          id: PREVIEW_PROJECT,
          kind: 'resource',
          provider: ID,
          dependsOn: viaHosting ? ['supabase.session', 'vercel.binding.supabase-preview-install'] : ['supabase.session', 'supabase.project'],
          inputs: {
            name: `${manifest.slug}-preview`,
            region: manifest.options.supabase.region,
            mode: viaHosting ? 'via-hosting' : 'direct',
            ...(manifest.options.supabase.organization_id ? { organizationId: manifest.options.supabase.organization_id } : {}),
            ...(viaHosting ? { installedBy: { deferred: 'vercel.binding.supabase-preview-install:installedBy' } } : {}),
          },
          billable: true,
        })
        if (manifest.slots.database === ID) {
          specs.push({
            id: 'supabase.preview-migrations',
            kind: 'binding',
            provider: ID,
            dependsOn: [PREVIEW_PROJECT, 'supabase.tool.supabase'],
            inputs: { projectRef: { deferred: `${PREVIEW_PROJECT}:projectRef` }, migrations: manifest.options.supabase.migrations },
          })
        }
      }

      specs.push(...databaseSinkSpecs(manifest))
      return specs
    },

    async ensure(spec: ResourceSpec, ctx: Ctx): Promise<EnsureResult> {
      if (spec.kind === 'check') return { action: 'noop' }
      if (spec.id.startsWith('supabase.secret.')) return ensureDatabaseSecret(spec, ctx)
      if (spec.kind === 'tool') {
        const tool = findTool({ tools: TOOLS }, spec)
        if (!tool) throw unknownResource(spec)
        return ensureTool(ID, tool, spec, ctx)
      }
      if (spec.kind === 'session') return ensureSession(provider, spec, ctx)
      if (spec.id === 'supabase.project' || spec.id === PREVIEW_PROJECT) return ensureProject(spec, ctx)
      if (spec.id === 'supabase.migrations' || spec.id === 'supabase.preview-migrations') return ensureMigrations(spec, ctx)
      if (spec.id === 'supabase.binding.auth-urls' || spec.id === 'supabase.binding.preview-auth-urls') return ensureAuthUrls(spec, ctx)
      throw unknownResource(spec)
    },

    async verify(spec: ResourceSpec, ctx: Ctx): Promise<CheckResult> {
      if (spec.kind === 'tool') {
        const tool = findTool({ tools: TOOLS }, spec)
        if (!tool) throw unknownResource(spec)
        return verifyTool(ID, tool, spec, ctx)
      }
      if (spec.kind === 'session') return verifySession(provider, spec, ctx)
      if (spec.id.startsWith('supabase.secret.')) return verifyDatabaseSecret(spec, ctx)
      if (spec.id === 'supabase.project' || spec.id === PREVIEW_PROJECT) return verifyProject(spec, ctx)
      if (spec.id === 'supabase.migrations' || spec.id === 'supabase.check.migrated' || spec.id === 'supabase.preview-migrations') {
        return verifyMigrations(spec, ctx)
      }
      if (spec.id === 'supabase.binding.auth-urls' || spec.id === 'supabase.check.auth-urls' || spec.id === 'supabase.binding.preview-auth-urls') {
        return verifyAuthUrls(spec, ctx)
      }
      throw unknownResource(spec)
    },

    async destroy(spec: ResourceSpec, ctx: Ctx): Promise<void> {
      if (spec.id !== 'supabase.project' && spec.id !== PREVIEW_PROJECT) return
      const ref = recordedId(ctx, spec, `the Supabase project ${str(spec.inputs.name) || ctx.manifest.slug}`)
      // A database the Vercel Marketplace created is a resource of a Marketplace configuration
      // that may serve other projects. Only that one resource is deleted, through Vercel, the way
      // the dashboard does it; the configuration is never uninstalled (BUG-46).
      const store = await storeForDatabase(ctx, spec.id, ref).catch(() => undefined)
      if (store) {
        if (store.sameName !== 1) {
          throw new CimientoError({
            code: 'SUPABASE_API_ERROR',
            provider: ID,
            resource: spec.id,
            message: `The Marketplace resource for ${ref} is named ${store.name}, and ${store.sameName} resources on the team share that name, so cimiento will not delete by name.`,
            hint: `Delete the resource ${store.id} in the Vercel dashboard under Storage, then run cimiento down again.`,
            retryable: false,
            needsHuman: true,
          })
        }
        const args = ['integration-resource', 'remove', store.name, '--disconnect-all', '--yes']
        if (ctx.manifest.accounts.vercel) args.push('--scope', ctx.manifest.accounts.vercel)
        const removed = await ctx.io.exec('vercel', args, { cwd: ctx.cwd })
        if (removed.code !== 0) {
          throw new CimientoError({
            code: 'SUPABASE_API_ERROR',
            provider: ID,
            resource: spec.id,
            message: `Removing the Marketplace database ${store.name} (${ref}) failed: ${(removed.stderr || removed.stdout).trim().slice(0, 300)}`,
            hint: 'cimiento down retries safely and only touches this one database.',
            retryable: true,
            needsHuman: false,
          })
        }
        return
      }
      const result = await supabaseCall(ctx, spec.id, 'DELETE', `/v1/projects/${encodeURIComponent(ref)}`)
      if (!result.ok && result.status !== 404) {
        throw supabaseError(spec.id, result, {
          code: 'SUPABASE_API_ERROR',
          message: `Deleting the Supabase project ${ref} failed.`,
          hint: 'Supabase refused the delete. cimiento down retries safely. A project created through the Vercel Marketplace may have to be removed from the Vercel integration instead; cimiento doctor shows which.',
        })
      }
    },

    smokeEffect(spec: ResourceSpec): string | undefined {
      return spec.id === 'supabase.check.migrated' ? `runs one read only query on the database, select count(*) from public.${BASELINE_TABLE}` : undefined
    },

    async presence(spec: ResourceSpec, ctx: Ctx): Promise<Presence> {
      if (spec.id !== 'supabase.project' && spec.id !== PREVIEW_PROJECT) return 'unknown'
      const ref = ctx.state.resources[spec.id]?.externalId
      if (!ref) return 'unknown'
      const result = await supabaseCall(ctx, spec.id, 'GET', `/v1/projects/${encodeURIComponent(ref)}`)
      return presenceFromStatus(result.status)
    },

    async outputs(spec: ResourceSpec, ctx: Ctx): Promise<Record<string, Output>> {
      if (spec.id !== 'supabase.project' && spec.id !== PREVIEW_PROJECT) return {}
      const { project } = await findTarget(ctx, spec)
      if (!project) return {}
      return projectOutputs(ctx, spec, project)
    },

    async billing(spec: ResourceSpec, ctx: Ctx): Promise<BillingInfo | undefined> {
      if (spec.id !== 'supabase.project' && spec.id !== PREVIEW_PROJECT) return undefined
      const reused = ctx.manifest.accounts.supabase === 'via-hosting' ? ctx.manifest.options.supabase.marketplace_configuration : undefined
      if (reused) {
        return { account: `Supabase organization vercel_${reused}, managed by the Vercel Marketplace configuration ${reused}`, plan: 'billed through the Vercel team', paid: false }
      }
      const orgId = ctx.manifest.options.supabase.organization_id
      if (!orgId) return { account: 'the Supabase organization picked at login', plan: 'unknown', paid: false }
      const org = await supabaseOrg(ctx, spec.id, orgId)
      if (!org) return { account: `Supabase organization ${orgId}`, plan: 'unknown', paid: false }
      return { account: `Supabase organization ${org.name}`, plan: org.plan, paid: isPaidPlan(org.plan) }
    },

    explain(key: string, lang: Lang): string {
      const entry = SUPABASE_EXPLAIN[key] ?? databaseSecretExplain(key)
      if (!entry) return `No explanation for ${key} yet.`
      return (lang === 'es' && entry.es) || entry.en
    },
  }
  return provider
}

export const supabaseProvider = createSupabaseProvider()

async function ensureSession(provider: Provider, spec: ResourceSpec, ctx: Ctx): Promise<EnsureResult> {
  const { account, action } = await ensureVendorSession(provider, spec, ctx, 'Supabase')
  // accounts.supabase holds the path, via-hosting or direct, so the organization is pinned in
  // options.supabase.organization_id, where project creation reads it.
  let organization = ctx.manifest.options.supabase.organization_id
  let created: { id: string; name: string } | undefined
  if (!organization) {
    const choice = await pickOrganization(spec, ctx)
    organization = choice?.id
    created = choice?.created
  }
  const pinned = organization ?? account
  const access = await verifySession(provider, spec, ctx)
  if (!access.ok && access.error) throw access.error
  return {
    action,
    externalId: pinned,
    outputs: {
      organizationId: { value: pinned, secret: false },
      ...(created ? createdOrganizationOutputs(created) : {}),
    },
  }
}

const NEW_ORG = '__new_organization__'

/** State keeps the organization cimiento created, since the Supabase API cannot delete it for down. */
export function createdOrganizationOutputs(org: { id: string; name: string }): Record<string, Output> {
  return {
    createdOrganizationId: { value: org.id, secret: false },
    createdOrganizationName: { value: org.name, secret: false },
  }
}

/**
 * Which Supabase organization the project lives and bills in. Each existing one is shown with its
 * plan, a paid one carries a warning, and creating a new organization is always on the list, named
 * after the project unless the person types another name. A single free organization is pinned
 * without asking, since there is nothing to weigh.
 */
export interface OrganizationChoice {
  id: string
  /** Set when cimiento created the organization, so down can report it as a leftover. */
  created?: { id: string; name: string }
}

export interface PickOptions {
  /** Ask even when a single free organization would be pinned silently. accounts set uses this. */
  alwaysAsk?: boolean
  /** A value given on the command line, for runs with nobody at a terminal. */
  to?: string
  /** How to write the answer. up only fills an empty slot; accounts set overwrites. */
  pin?: (ctx: Ctx, path: string[], value: string) => void
}

const ORG_PATH = ['options', 'supabase', 'organization_id']

async function pickOrganization(spec: ResourceSpec, ctx: Ctx, opts: PickOptions = {}): Promise<OrganizationChoice | undefined> {
  const pin = opts.pin ?? ((c: Ctx, path: string[], value: string) => void pinInManifest(c, path, value))
  const orgs = await supabaseOrgsWithPlans(ctx, spec.id)
  if (opts.to) {
    const match = orgs.find((o) => o.id === opts.to || o.name === opts.to)
    if (!match) {
      throw new CimientoError({
        code: 'ACCOUNT_CHOICE_NEEDED',
        provider: ID,
        resource: spec.id,
        message: `No Supabase organization ${opts.to} is visible to this login. The choices are ${orgs.map((o) => `${o.name} (${o.id})`).join(', ')}.`,
        hint: 'Pass one of the listed ids with --to, or run cimiento accounts set supabase in a terminal to pick or create one.',
        retryable: true,
        needsHuman: true,
      })
    }
    pin(ctx, ORG_PATH, match.id)
    return { id: match.id }
  }
  if (!opts.alwaysAsk && orgs.length === 1 && !isPaidPlan(orgs[0].plan)) {
    pin(ctx, ORG_PATH, orgs[0].id)
    return { id: orgs[0].id }
  }
  const options: ChoiceOption[] = [
    ...orgs.map((o) => ({
      value: o.id,
      label: `${o.name}, ${o.plan} plan`,
      ...(isPaidPlan(o.plan) ? { warning: `${o.name} is on the ${o.plan} plan. A new database there is billed to it.` } : {}),
    })),
    { value: NEW_ORG, label: `Create a new organization (free plan), named ${ctx.manifest.slug} unless you type another name` },
  ]
  if (!ctx.interactive || !ctx.choose) {
    throw new CimientoError({
      code: 'ACCOUNT_CHOICE_NEEDED',
      provider: ID,
      resource: spec.id,
      message: `stack.yaml does not say which Supabase organization this project uses. The choices are ${orgs
        .map((o) => `${o.name} (${o.plan} plan${isPaidPlan(o.plan) ? ', paid' : ''})`)
        .join(', ')}${orgs.length ? ', or ' : ''}a new organization.`,
      hint: `Run cimiento accounts set supabase in a terminal in ${ctx.cwd} and pick one, or create a new one. cimiento writes the choice to options.supabase.organization_id in stack.yaml.`,
      retryable: true,
      needsHuman: true,
    })
  }
  await ctx.walkStep?.(supabaseOrganizationStep(options.filter((o) => o.value !== NEW_ORG).map((o) => o.label)))
  const picked = await ctx.choose('Which Supabase organization should this project use?', options)
  if (picked !== NEW_ORG) {
    pin(ctx, ORG_PATH, picked)
    return { id: picked }
  }
  const created = await createOrganization(spec, ctx)
  pin(ctx, ORG_PATH, created.id)
  return { id: created.id, created }
}

async function createOrganization(spec: ResourceSpec, ctx: Ctx): Promise<{ id: string; name: string }> {
  const name = ((await ctx.ask?.('Name for the new Supabase organization:', ctx.manifest.slug)) || ctx.manifest.slug).trim()
  const created = await supabaseCall<{ id?: string; name?: string }>(ctx, spec.id, 'POST', '/v1/organizations', { name })
  if (!created.ok || !created.body?.id) {
    throw supabaseError(spec.id, created, {
      code: 'SUPABASE_ORG_MISSING',
      message: `Creating the Supabase organization ${name} failed.`,
      hint: 'cimiento asks again, and you can pick an existing organization instead.',
    })
  }
  return { id: created.body.id, name: created.body.name ?? name }
}

/** cimiento accounts set supabase: ask again, including creating an organization, and overwrite. */
export async function chooseSupabaseOrganization(ctx: Ctx, to?: string): Promise<OrganizationChoice | undefined> {
  const spec: ResourceSpec = { id: 'supabase.session', kind: 'session', provider: ID, dependsOn: [], inputs: {} }
  await ensureVendorSession(supabaseProvider, spec, ctx, 'Supabase')
  return pickOrganization(spec, ctx, { alwaysAsk: true, ...(to ? { to } : {}), pin: setInManifest })
}

/**
 * accounts.supabase pins the path, not an account, so this check confirms a usable session
 * rather than comparing account names.
 */
async function verifySession(provider: Provider, spec: ResourceSpec, ctx: Ctx): Promise<CheckResult> {
  const detection = await provider.detect(ctx)
  if (!detection.installed) {
    return {
      ok: false,
      error: new CimientoError({
        code: 'TOOL_MISSING',
        provider: ID,
        resource: spec.id,
        message: 'The Supabase CLI is not installed yet, so cimiento cannot read the Supabase session.',
        hint: 'cimiento up installs the Supabase CLI for you before it needs the session.',
        retryable: true,
        needsHuman: false,
      }),
    }
  }
  if (!detection.session) {
    return {
      ok: false,
      error: new CimientoError({
        code: 'SESSION_MISSING',
        provider: ID,
        resource: spec.id,
        message: 'Not logged in to Supabase, or the account has no organization.',
        hint: LOGIN_HINT,
        retryable: true,
        needsHuman: false,
      }),
    }
  }
  const pinned = ctx.manifest.options.supabase.organization_id
  if (!pinned) return { ok: true, evidence: 'supabase session, no organization pinned yet: cimiento up asks for one' }
  const org = await supabaseOrg(ctx, spec.id, pinned)
  if (!org) {
    return {
      ok: false,
      error: new CimientoError({
        code: 'SESSION_ACCOUNT_MISMATCH',
        provider: ID,
        resource: spec.id,
        message: `stack.yaml pins the Supabase organization ${pinned}, and this Supabase login cannot access it.`,
        hint: `Log in to Supabase as a member of ${pinned}, or run cimiento accounts set supabase to pick an organization this login can use.`,
        retryable: true,
        needsHuman: true,
      }),
    }
  }
  return { ok: true, evidence: `supabase session in organization ${org.name} (${org.id}), ${org.plan} plan, the one stack.yaml pins` }
}

async function listProjects(ctx: Ctx, spec: ResourceSpec): Promise<SupabaseProject[]> {
  const result = await supabaseCall<SupabaseProject[]>(ctx, spec.id, 'GET', '/v1/projects')
  if (!result.ok) {
    throw supabaseError(spec.id, result, {
      code: 'SUPABASE_API_ERROR',
      message: 'Listing Supabase projects failed.',
      hint: 'cimiento up logs you in again if the Supabase login expired. A 403 means this login cannot see the organization stack.yaml pins.',
    })
  }
  return result.body ?? []
}

interface Target {
  project?: SupabaseProject
  /** How it was found, for the evidence line. */
  via?: 'state' | 'hosting env' | 'name'
  /** The database the hosting env points at, whether or not this login can see it. */
  hostingRef?: string
}

/**
 * The database this project uses. In order: the ref state recorded, the ref the hosting env's
 * Supabase URL points at, then a project with the slug as its name. The env comes before the name
 * because the Marketplace names its database however it likes, and the env is what the app
 * actually connects to.
 */
async function findTarget(ctx: Ctx, spec: ResourceSpec): Promise<Target> {
  const projects = await listProjects(ctx, spec)
  const byRef = (ref: string | undefined) => (ref ? projects.find((p) => projectRefOf(p) === ref) : undefined)

  const stateRef = ctx.state.resources[spec.id]?.externalId
  const fromState = byRef(stateRef)
  if (fromState) return { project: fromState, via: 'state' }

  const hostingProject = str(spec.inputs.hostingProject)
  const hostingRef = hostingProject ? await hostingSupabaseRef(ctx, spec.id, hostingProject) : undefined
  const fromHosting = byRef(hostingRef)
  if (fromHosting) return { project: fromHosting, via: 'hosting env', hostingRef }

  const name = str(spec.inputs.name)
  const fromName = name ? projects.find((p) => p.name === name) : undefined
  if (fromName) return { project: fromName, via: 'name', hostingRef }
  return { hostingRef }
}

/**
 * The creation date of a database found through the hosting env, when it is older than the hosting
 * project. Goal 1 Part B nearly adopted, re-pointed and then deleted a database made eight months
 * earlier for another application, because the Link Existing dialog had connected it.
 */
async function predatesHosting(spec: ResourceSpec, ctx: Ctx, project: SupabaseProject): Promise<string | undefined> {
  const hostingProject = str(spec.inputs.hostingProject)
  if (!project.created_at || !hostingProject) return undefined
  const hostingCreated = await hostingProjectCreatedAt(ctx, spec.id, hostingProject)
  const dbCreated = Date.parse(project.created_at)
  if (!hostingCreated || !Number.isFinite(dbCreated) || dbCreated >= hostingCreated) return undefined
  return project.created_at.slice(0, 10)
}

async function confirmOlderAdoption(spec: ResourceSpec, ctx: Ctx, project: SupabaseProject): Promise<void> {
  const created = await predatesHosting(spec, ctx, project)
  if (!created) return
  const ref = projectRefOf(project)
  const question = `The hosting env points at the Supabase database ${project.name} (${ref}), created ${created}, before this project. Adopting it lets cimiento change its Auth URLs. Adopt it?`
  if (ctx.interactive && ctx.choose) {
    const answer = await ctx.choose(question, [
      { value: 'no', label: 'No, leave it alone' },
      { value: 'adopt', label: `Yes, ${project.name} is this project's database`, warning: 'cimiento will manage its Auth URLs. down never deletes an adopted database.' },
    ])
    if (answer === 'adopt') return
  }
  throw new CimientoError({
    code: 'SUPABASE_ADOPTION_CONFIRMATION_NEEDED',
    provider: ID,
    resource: spec.id,
    message: `The hosting env points at ${project.name} (${ref}), a Supabase database created ${created}, before this project. cimiento does not adopt an older database without a person saying it belongs to this project.`,
    hint: `Run cimiento up in a terminal in ${ctx.cwd} and answer yes if ${project.name} is this project's database. If it belongs to something else, disconnect it from the hosting project, and cimiento then creates a new one.`,
    retryable: true,
    needsHuman: true,
  })
}

/** Never a second database: the env already points at one this login cannot see. */
function duplicateRefused(spec: ResourceSpec, ref: string): CimientoError {
  return new CimientoError({
    code: 'SUPABASE_DUPLICATE_REFUSED',
    provider: ID,
    resource: spec.id,
    message: `The hosting env already points at the Supabase database ${ref}, and this Supabase login cannot see it. cimiento will not create a second database.`,
    hint: `Run cimiento up in a terminal: it asks you to grant this Supabase login access to the organization that holds ${ref}, then adopts that database.`,
    retryable: true,
    needsHuman: true,
  })
}

function projectRefOf(project: SupabaseProject): string {
  return project.ref ?? project.id
}

async function ensureProject(spec: ResourceSpec, ctx: Ctx): Promise<EnsureResult> {
  const name = str(spec.inputs.name)
  const mode = str(spec.inputs.mode)
  const known = ctx.state.resources[spec.id]?.externalId
  const target = await findTarget(ctx, spec)
  const existing = target.project

  if (existing) {
    const ref = projectRefOf(existing)
    // The install step created this database in this project's name: it is cimiento's own.
    const ours = str(spec.inputs.installedBy) === 'cimiento'
    if (known !== ref && target.via === 'hosting env' && !ours) await confirmOlderAdoption(spec, ctx, existing)
    return {
      action: known === ref ? 'noop' : ours ? 'created' : 'adopted',
      externalId: ref,
      url: `https://supabase.com/dashboard/project/${ref}`,
      outputs: await projectOutputs(ctx, spec, existing),
    }
  }

  if (target.hostingRef) throw duplicateRefused(spec, target.hostingRef)

  if (mode === 'via-hosting') {
    throw new CimientoError({
      code: 'SUPABASE_PROJECT_NOT_FOUND',
      provider: ID,
      resource: spec.id,
      message: `The Vercel Marketplace install finished but no Supabase project named ${name} is visible in your organizations.`,
      hint: 'The Supabase integration may still be provisioning. cimiento up checks again safely. Setting accounts.supabase to direct in stack.yaml has cimiento create the database itself instead.',
      retryable: true,
      needsHuman: true,
    })
  }

  if (ctx.dryRun) return { action: 'noop' }

  if (spec.id === PREVIEW_PROJECT) {
    ctx.logger.log({
      level: 'info',
      event: 'billing',
      resource: spec.id,
      message: `Creating ${name}, a second Supabase project for previews. Supabase's free plan allows 2 active projects per person, and this app now uses 2; with another active free project, Supabase refuses it and cimiento says which projects count.`,
    })
  }
  // The database password is a secret output: it is kept in memory for this run and never
  // written to state, logs or json output.
  const dbPass = randomBytes(24).toString('base64url')
  ctx.redactor.addValue(dbPass)

  let createdOrg: { id: string; name: string } | undefined
  let created: Awaited<ReturnType<typeof postProject>>
  for (let attempt = 1; ; attempt += 1) {
    // The manifest first: the session step, or the choice below, may have pinned a different
    // organization during this run, after the spec inputs were built.
    const organizationId =
      ctx.manifest.options.supabase.organization_id || str(spec.inputs.organizationId) || (await defaultOrganization(ctx, spec))
    created = await postProject(ctx, spec, name, organizationId, dbPass)
    if (created.ok || !/maximum limits for the number of active free projects/i.test(created.raw)) break
    // Each round waits on the person; the cap only stops a loop that makes no progress.
    const next = await freeProjectLimitStep(spec, ctx, attempt >= MAX_LIMIT_ROUNDS)
    if (next.created) createdOrg = next.created
  }
  if (!created.ok || !created.body) {
    throw supabaseError(spec.id, created, {
      code: 'SUPABASE_PROJECT_CREATE_FAILED',
      message: `Creating the Supabase project ${name} failed.`,
      hint: 'The message above is Supabase saying why. cimiento up retries safely once that is fixed.',
    })
  }
  const ref = projectRefOf(created.body)
  const outputs = await projectOutputs(ctx, spec, created.body)
  outputs.dbPassword = { value: dbPass, secret: true }
  if (createdOrg) Object.assign(outputs, createdOrganizationOutputs(createdOrg))
  return {
    action: 'created',
    externalId: ref,
    url: `https://supabase.com/dashboard/project/${ref}`,
    outputs,
  }
}

function postProject(ctx: Ctx, spec: ResourceSpec, name: string, organizationId: string, dbPass: string) {
  return supabaseCall<SupabaseProject>(ctx, spec.id, 'POST', '/v1/projects', {
    name,
    organization_id: organizationId,
    region: str(spec.inputs.region) || 'us-east-1',
    db_pass: dbPass,
  })
}

const ACTIVE = /^(ACTIVE_HEALTHY|ACTIVE|COMING_UP)$/i

export interface FreeProject {
  ref: string
  name: string
  organization: string
  /** The day of the last API request in the past week, or undefined when there was none. */
  lastRequest?: string
}

/**
 * The active projects in free organizations, the ones that count against Supabase's limit of two
 * per person, each with the last day it served an API request in the past week.
 */
export async function activeFreeProjects(ctx: Ctx, resource: string): Promise<FreeProject[]> {
  const orgs = await supabaseOrgsWithPlans(ctx, resource)
  const free = new Map(orgs.filter((o) => !isPaidPlan(o.plan)).map((o) => [o.id, o.name]))
  const projects = (await listProjects(ctx, { id: resource, kind: 'resource', provider: ID, dependsOn: [], inputs: {} })).filter(
    (p) => p.organization_id && free.has(p.organization_id) && ACTIVE.test(p.status ?? ''),
  )
  const out: FreeProject[] = []
  for (const p of projects) {
    const ref = projectRefOf(p)
    const usage = await supabaseCall<{ result?: Record<string, string | number>[] }>(
      ctx,
      resource,
      'GET',
      `/v1/projects/${encodeURIComponent(ref)}/analytics/endpoints/usage.api-counts?interval=7day`,
    ).catch(() => undefined)
    const rows = usage?.ok ? (usage.body?.result ?? []) : []
    const active = rows.filter((r) => Object.entries(r).some(([k, v]) => k !== 'timestamp' && Number(v) > 0))
    const last = active.length ? String(active[active.length - 1].timestamp).slice(0, 10) : undefined
    out.push({ ref, name: p.name, organization: free.get(p.organization_id!) ?? p.organization_id!, ...(last ? { lastRequest: last } : {}) })
  }
  return out
}

export function describeFreeProjects(projects: FreeProject[]): string {
  if (projects.length === 0) return 'Supabase did not list which projects count; they may be in an organization this login cannot see.'
  return projects
    .map((p) => `${p.name} (${p.ref}) in ${p.organization}, ${p.lastRequest ? `last API request ${p.lastRequest}` : 'no API requests in the last 7 days'}`)
    .join('; ')
}

const DASHBOARD_PROJECTS = 'https://supabase.com/dashboard/projects'

/**
 * The person step for Supabase's limit of two active free projects per person. cimiento lists
 * the projects that count, with their last activity, and offers two ways forward: free a slot in
 * the dashboard, which cimiento never does itself for a project it did not create, or use a
 * paid-plan or new organization. After either, the caller retries the create.
 */
const MAX_LIMIT_ROUNDS = 5

async function freeProjectLimitStep(
  spec: ResourceSpec,
  ctx: Ctx,
  lastRound = false,
): Promise<{ created?: { id: string; name: string } }> {
  const projects = await activeFreeProjects(ctx, spec.id)
  const list = describeFreeProjects(projects)
  const headline = `Supabase allows 2 active free projects per person, across every organization you own or administer, and these count: ${list}.`
  if (!ctx.interactive || !ctx.choose || lastRound) {
    throw new CimientoError({
      code: 'SUPABASE_FREE_PROJECT_LIMIT',
      provider: ID,
      resource: spec.id,
      message: headline,
      hint: `Either pause or delete one of them in the Supabase dashboard (${DASHBOARD_PROJECTS}); cimiento never pauses or deletes a project it did not create. Or run cimiento accounts set supabase and pick a paid-plan or new organization; on a paid plan the database is billed to it. Then run cimiento up again.`,
      docsUrl: DASHBOARD_PROJECTS,
      retryable: true,
      needsHuman: true,
    })
  }
  const picked = await ctx.choose(`${headline} How do you want to continue?`, [
    {
      value: 'free',
      label: 'Free a slot: I will pause or delete one of them in the Supabase dashboard',
      warning: 'cimiento never pauses or deletes a project it did not create. It opens the dashboard and checks again when you press Enter.',
    },
    {
      value: 'org',
      label: 'Use a paid-plan organization or a new one instead',
      warning: 'On a paid plan the new database is billed to that organization. A new organization is free, but still counts against the same two-project limit.',
    },
    { value: 'stop', label: 'Stop for now' },
  ])
  if (picked === 'free') {
    const step = supabaseFreeLimitStep(list)
    if (ctx.walkStep) await ctx.walkStep(step)
    else {
      await ctx.openUrl?.(DASHBOARD_PROJECTS)
      await ctx.ask?.('Press Enter once a project is paused or deleted, and cimiento checks the limit again.')
    }
    return {}
  }
  if (picked === 'org') {
    const choice = await pickOrganization(spec, ctx, { alwaysAsk: true, pin: setInManifest })
    return choice?.created ? { created: choice.created } : {}
  }
  throw new CimientoError({
    code: 'SUPABASE_FREE_PROJECT_LIMIT',
    provider: ID,
    resource: spec.id,
    message: headline,
    hint: 'Run cimiento up again when a slot is free, or run cimiento accounts set supabase to pick a paid-plan or new organization.',
    docsUrl: DASHBOARD_PROJECTS,
    retryable: true,
    needsHuman: true,
  })
}

async function defaultOrganization(ctx: Ctx, spec: ResourceSpec): Promise<string> {
  const result = await supabaseCall<{ id: string; name: string }[]>(ctx, spec.id, 'GET', '/v1/organizations')
  const orgs = result.ok ? (result.body ?? []) : []
  if (orgs.length === 1) return orgs[0].id
  throw new CimientoError({
    code: 'SUPABASE_ORG_MISSING',
    provider: ID,
    resource: spec.id,
    message:
      orgs.length === 0
        ? 'This Supabase account has no organization to create a project in.'
        : `This Supabase account has ${orgs.length} organizations, so cimiento cannot pick one for you.`,
    hint:
      orgs.length === 0
        ? 'Create an organization at https://supabase.com/dashboard, then run cimiento up again.'
        : `Set options.supabase.organization_id in stack.yaml to one of: ${orgs.map((o) => `${o.id} (${o.name})`).join(', ')}`,
    retryable: false,
    needsHuman: true,
  })
}

async function projectOutputs(ctx: Ctx, spec: ResourceSpec, project: SupabaseProject): Promise<Record<string, Output>> {
  const ref = projectRefOf(project)
  const outputs: Record<string, Output> = {
    projectRef: { value: ref, secret: false },
    projectName: { value: project.name, secret: false },
    projectUrl: { value: `https://${ref}.supabase.co`, secret: false },
    dashboardUrl: { value: `https://supabase.com/dashboard/project/${ref}`, secret: false },
  }
  if (project.organization_id) outputs.organizationId = { value: project.organization_id, secret: false }

  const keys = await supabaseCall<SupabaseApiKey[]>(ctx, spec.id, 'GET', `/v1/projects/${encodeURIComponent(ref)}/api-keys`)
  if (keys.ok && keys.body) {
    for (const key of keys.body) {
      if (key.name === 'anon') {
        outputs.anonKey = { value: key.api_key, secret: true }
        ctx.redactor.addValue(key.api_key)
      }
      if (key.name === 'service_role') {
        outputs.serviceRoleKey = { value: key.api_key, secret: true }
        ctx.redactor.addValue(key.api_key)
      }
    }
  }
  return outputs
}

async function verifyProject(spec: ResourceSpec, ctx: Ctx): Promise<CheckResult> {
  const name = str(spec.inputs.name)
  const target = await findTarget(ctx, spec)
  const project = target.project
  if (!project) {
    // The planner turns a needs-human error into needs-human instead of create, which is how it
    // refuses to plan a second database while the hosting env already points at one.
    if (target.hostingRef) return { ok: false, error: duplicateRefused(spec, target.hostingRef) }
    return {
      ok: false,
      error: new CimientoError({
        code: 'SUPABASE_PROJECT_NOT_FOUND',
        provider: ID,
        resource: spec.id,
        message: `No Supabase project named ${name} in your organizations.`,
        hint:
          str(spec.inputs.mode) === 'via-hosting'
            ? 'The Vercel Marketplace creates this database. cimiento up runs the Marketplace step and then adopts it.'
            : 'cimiento up creates it.',
        retryable: true,
        needsHuman: false,
      }),
    }
  }
  const ref = projectRefOf(project)
  if (project.status && !/^(ACTIVE_HEALTHY|ACTIVE|COMING_UP)$/i.test(project.status)) {
    return {
      ok: false,
      error: new CimientoError({
        code: 'SUPABASE_API_ERROR',
        provider: ID,
        resource: spec.id,
        message: `The Supabase project ${project.name} is ${project.status}.`,
        hint: 'A paused project has to be restored from the Supabase dashboard before cimiento can use it.',
        retryable: true,
        needsHuman: true,
      }),
    }
  }
  const how = target.via === 'hosting env' ? ', the database the hosting env points at' : ''
  const older = target.via === 'hosting env' && !ctx.state.resources[spec.id] ? await predatesHosting(spec, ctx, project) : undefined
  const warning = older ? `, created ${older}, before this project: up asks before adopting it` : ''
  return { ok: true, evidence: `supabase project ${project.name} (${ref})${how}${warning}` }
}

function migrationDir(ctx: Ctx, spec: ResourceSpec): string {
  const declared = str(spec.inputs.migrations) || 'supabase/migrations'
  return isAbsolute(declared) ? declared : join(ctx.cwd, declared)
}

function migrationFiles(ctx: Ctx, spec: ResourceSpec): string[] {
  const dir = migrationDir(ctx, spec)
  if (!existsSync(dir)) return []
  try {
    return readdirSync(dir).filter((f) => f.endsWith('.sql')).sort()
  } catch {
    return []
  }
}

/** The name a migration file is recorded under: the file name without its version and extension. */
export function migrationName(file: string): string {
  return file.replace(/\.sql$/, '').replace(/^\d+_/, '')
}

async function appliedMigrationNames(ctx: Ctx, spec: ResourceSpec, ref: string): Promise<Set<string> | undefined> {
  if (!ref) return undefined
  const result = await supabaseCall<{ version: string; name?: string }[]>(
    ctx,
    spec.id,
    'GET',
    `/v1/projects/${encodeURIComponent(ref)}/database/migrations`,
  )
  if (!result.ok) return undefined
  return new Set((result.body ?? []).map((m) => m.name ?? '').filter(Boolean))
}

/**
 * Applies every migration file the database has not recorded yet, through the Management API,
 * which records each one in the migration history. No database password is needed; cimiento
 * generates one at creation and never keeps it. A project scaffolded before the baseline existed
 * gets the baseline file written first, so the check always has a table to query.
 */
async function ensureMigrations(spec: ResourceSpec, ctx: Ctx): Promise<EnsureResult> {
  const ref = str(spec.inputs.projectRef)
  let files = migrationFiles(ctx, spec)
  if (files.length === 0 && ctx.manifest.scaffold.template !== 'none') {
    if (ctx.dryRun) return { action: 'noop' }
    const dir = migrationDir(ctx, spec)
    mkdirSync(dir, { recursive: true })
    writeFileSync(join(dir, BASELINE_FILE), BASELINE_SQL, 'utf8')
    files = migrationFiles(ctx, spec)
  }
  const applied = await appliedMigrationNames(ctx, spec, ref)
  if (!applied) {
    throw new CimientoError({
      code: 'SUPABASE_MIGRATION_FAILED',
      provider: ID,
      resource: spec.id,
      message: `cimiento could not read the migration history of ${ref}.`,
      hint: 'cimiento up retries safely. A 403 means this Supabase login cannot reach the project.',
      retryable: true,
      needsHuman: false,
    })
  }
  const missing = files.filter((f) => !applied.has(migrationName(f)))
  if (missing.length === 0) {
    return { action: 'noop', externalId: ref, outputs: { migrationCount: { value: String(files.length), secret: false } } }
  }
  if (ctx.dryRun) return { action: 'noop' }
  for (const file of missing) {
    const query = readFileSync(join(migrationDir(ctx, spec), file), 'utf8')
    const result = await supabaseCall(
      ctx,
      spec.id,
      'POST',
      `/v1/projects/${encodeURIComponent(ref)}/database/migrations`,
      { name: migrationName(file), query },
      // The same file never applies twice, even if a retry follows a lost response.
      { 'Idempotency-Key': `${ref}:${file}` },
    )
    if (!result.ok) {
      throw supabaseError(spec.id, result, {
        code: 'SUPABASE_MIGRATION_FAILED',
        message: `Applying the migration ${file} failed.`,
        hint: 'The message above comes from Postgres. Fix the SQL in that file, then run cimiento up again.',
        needsHuman: false,
      })
    }
  }
  return {
    action: 'updated',
    externalId: ref,
    outputs: { migrationCount: { value: String(files.length), secret: false } },
  }
}

/**
 * database.migrated from spec section 12: every migration file is in the history, and a query
 * against the table the baseline creates succeeds. No migration files at all is a failure, not a
 * pass: it proves nothing about the database.
 */
async function verifyMigrations(spec: ResourceSpec, ctx: Ctx): Promise<CheckResult> {
  const files = migrationFiles(ctx, spec)
  const ref = str(spec.inputs.projectRef)
  const fail = (message: string, hint: string): CheckResult => ({
    ok: false,
    error: new CimientoError({ code: 'SUPABASE_MIGRATION_FAILED', provider: ID, resource: spec.id, message, hint, retryable: true, needsHuman: false }),
  })
  if (files.length === 0) {
    return fail(
      `No migration files in ${str(spec.inputs.migrations) || 'supabase/migrations'}, so nothing proves the database takes migrations.`,
      'cimiento up writes the baseline migration and applies it.',
    )
  }
  const applied = await appliedMigrationNames(ctx, spec, ref)
  if (!applied) return fail(`cimiento could not read the migration history of ${ref}.`, 'cimiento up retries safely.')
  const missing = files.filter((f) => !applied.has(migrationName(f)))
  if (missing.length > 0) {
    return fail(`${missing.length} of ${files.length} migration files are not applied: ${missing.join(', ')}.`, 'cimiento up applies them.')
  }
  if (!files.includes(BASELINE_FILE)) {
    return { ok: true, evidence: `${files.length} migrations applied in ${ref}` }
  }
  // The query below is a POST, even though it only reads; without --smoke the history is the proof.
  if (!ctx.smoke) return { ok: true, evidence: `${files.length} migrations recorded in the history of ${ref}; --smoke queries public.${BASELINE_TABLE}` }
  const query = await supabaseCall<{ count?: number | string }[]>(
    ctx,
    spec.id,
    'POST',
    `/v1/projects/${encodeURIComponent(ref)}/database/query`,
    { query: `select count(*)::int as count from public.${BASELINE_TABLE}`, read_only: true },
  )
  const rows = query.ok ? Number(query.body?.[0]?.count ?? NaN) : NaN
  if (!Number.isFinite(rows)) {
    return fail(
      `The baseline migration is recorded but public.${BASELINE_TABLE} does not answer a query in ${ref}.`,
      'cimiento up applies the baseline again. If it keeps failing, the table was dropped by hand.',
    )
  }
  return { ok: true, evidence: `${files.length} migrations applied in ${ref}; public.${BASELINE_TABLE} answers with ${rows} row` }
}

async function getAuthConfig(ctx: Ctx, spec: ResourceSpec, ref: string): Promise<SupabaseAuthConfig | undefined> {
  const result = await supabaseCall<SupabaseAuthConfig>(
    ctx,
    spec.id,
    'GET',
    `/v1/projects/${encodeURIComponent(ref)}/config/auth`,
  )
  if (!result.ok) return undefined
  return result.body
}

function redirectList(siteUrl: string, previewPattern: string, extra = ''): string {
  const entries = [`${siteUrl}/**`]
  if (extra) entries.push(extra)
  if (previewPattern) entries.push(previewPattern)
  entries.push('http://localhost:3000/**')
  return entries.join(',')
}

async function ensureAuthUrls(spec: ResourceSpec, ctx: Ctx): Promise<EnsureResult> {
  const ref = str(spec.inputs.projectRef)
  const siteUrl = str(spec.inputs.siteUrl)
  const preview = str(spec.inputs.previewPattern)
  const wanted = redirectList(siteUrl, preview, str(spec.inputs.extraRedirect))
  const current = await getAuthConfig(ctx, spec, ref)
  if (current?.site_url === siteUrl && current?.uri_allow_list === wanted) {
    return { action: 'noop', externalId: ref, outputs: { siteUrl: { value: siteUrl, secret: false } } }
  }
  if (ctx.dryRun) return { action: 'noop' }
  const patched = await supabaseCall(ctx, spec.id, 'PATCH', `/v1/projects/${encodeURIComponent(ref)}/config/auth`, {
    site_url: siteUrl,
    uri_allow_list: wanted,
  })
  if (!patched.ok) {
    throw supabaseError(spec.id, patched, {
      code: 'SUPABASE_AUTH_URL_FAILED',
      message: `Setting the Supabase Site URL of ${ref} to ${siteUrl} failed.`,
      hint: 'Set it by hand under Authentication, URL Configuration in the Supabase dashboard, then run cimiento doctor.',
    })
  }
  return {
    action: current ? 'updated' : 'created',
    externalId: ref,
    outputs: { siteUrl: { value: siteUrl, secret: false } },
  }
}

async function verifyAuthUrls(spec: ResourceSpec, ctx: Ctx): Promise<CheckResult> {
  const ref = str(spec.inputs.projectRef)
  const siteUrl = str(spec.inputs.siteUrl)
  const config = await getAuthConfig(ctx, spec, ref)
  if (!config) {
    return {
      ok: false,
      error: new CimientoError({
        code: 'SUPABASE_AUTH_URL_FAILED',
        provider: ID,
        resource: spec.id,
        message: `cimiento could not read the auth configuration of ${ref}.`,
        hint: 'cimiento up logs you in again if the Supabase login expired. A 403 means this login cannot see the organization stack.yaml pins.',
        retryable: true,
        needsHuman: false,
      }),
    }
  }
  if (config.site_url !== siteUrl) {
    return {
      ok: false,
      error: new CimientoError({
        code: 'SUPABASE_AUTH_URL_FAILED',
        provider: ID,
        resource: spec.id,
        message: `Supabase Site URL is ${config.site_url ?? 'empty'}, cimiento expects ${siteUrl}.`,
        hint: 'Run cimiento up to set it. Until it matches, login links send people to the wrong address.',
        retryable: true,
        needsHuman: false,
      }),
    }
  }
  return { ok: true, evidence: `supabase site url is ${siteUrl}` }
}

function str(value: Value | undefined): string {
  return typeof value === 'string' ? value : ''
}

function unknownResource(spec: ResourceSpec): CimientoError {
  return new CimientoError({
    code: 'PLAN_UNKNOWN_DEPENDENCY',
    provider: ID,
    resource: spec.id,
    message: `The supabase provider does not know the resource ${spec.id}.`,
    hint: 'This is a bug. Run cimiento plan --json and open an issue with the output.',
    retryable: false,
    needsHuman: true,
  })
}

export default supabaseProvider

/**
 * Whether the Supabase Management API can delete an organization. Checked against its OpenAPI
 * spec on 2026-09-25: /v1/organizations has GET and POST only, so down cannot remove one.
 */
export const SUPABASE_CAN_DELETE_ORGANIZATIONS = false

export interface OrganizationLeftover {
  id: string
  name: string
  url: string
}

/** Organizations cimiento created, recorded on any state entry, that still exist. */
export async function createdOrganizationLeftovers(ctx: Ctx): Promise<OrganizationLeftover[]> {
  const seen = new Map<string, string>()
  for (const entry of Object.values(ctx.state.resources)) {
    const id = entry.outputs?.createdOrganizationId
    if (id) seen.set(id, entry.outputs?.createdOrganizationName ?? id)
  }
  const leftovers: OrganizationLeftover[] = []
  for (const [id, name] of seen) {
    const org = await supabaseOrg(ctx, 'supabase.session', id)
    if (!org) continue
    leftovers.push({ id, name: org.name ?? name, url: `https://supabase.com/dashboard/org/${id}/general` })
  }
  return leftovers
}
