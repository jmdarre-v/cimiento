// Vercel provider. Fills the hosting slot, and is the env store every secret with the hosting
// sink lands in. The CLI owns login and deploy, the REST API owns projects, links and env vars.

import { sameResource } from '../../core/state'
import { existsSync, readFileSync } from 'node:fs'
import { join } from 'node:path'
import { CimientoError } from '../../core/errors'
import { recordedId } from '../../core/identity'
import type { LiveCommit } from '../../core/types'
import type { ProjectState } from '../../core/state'
import {
  attendedUpHint,
  baseResources,
  ensureTool,
  ensureVendorSession,
  findTool,
  runVendorLogin,
  verifyTool,
} from '../../core/toolkit'
import { chooseAndPin, setInManifest } from '../../manifest/pin'
import { marketplaceInstructions, marketplacePersonStep, vercelTeamPlan } from '../../wiring/vercel-supabase-runtime'
import { settleSupabasePath } from '../../wiring/supabase-configurations'
import { githubAccessStep, vercelLoginStep, vercelSignupStep, vercelTeamStep } from '../../core/person-steps'
import { renderPersonStep } from '../../core/person'
import { presenceFromStatus, type Presence } from '../../core/types'
import type {
  BillingInfo,
  CheckResult,
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
import { toVercelTarget, vercelCall, vercelError } from './api'
import { VERCEL_EXPLAIN } from './explain'
import { recordName, verifyDomainServes, type DnsRecord } from '../domain-check'

const ID = 'vercel'

/** Long enough for a first build on a cold project. */
export const DEPLOY_TIMEOUT_MS = 15 * 60 * 1000

const TOOLS: ToolSpec[] = [
  {
    name: 'Vercel CLI',
    bin: 'vercel',
    versionRange: '>=37.0.0',
    install: { npm: 'vercel' },
    versionCmd: 'vercel --version',
  },
]

const LOGIN_HINT = 'cimiento up opens the Vercel login in your browser and waits while you approve it.'

interface VercelProject {
  id: string
  name: string
  accountId?: string
  framework?: string | null
  link?: { type?: string; org?: string; repo?: string; repoId?: number; productionBranch?: string } | null
  targets?: { production?: { alias?: string[]; url?: string; readyState?: string } } | null
}

interface VercelEnv {
  id: string
  key: string
  target: string[]
  type: string
  createdAt?: number
  updatedAt?: number
}

interface VercelDeployment {
  uid: string
  url: string
  state?: string
  readyState?: string
  target?: string | null
  createdAt?: number
  created?: number
}

export function envResourceId(key: string, environment: string): string {
  return `vercel.env.${key}.${environment}`
}

export function createVercelProvider(m?: Manifest): Provider {
  const paidPlan = m ? m.options.vercel.plan !== 'hobby' : false
  const provider: Provider = {
    id: ID,
    fills: ['hosting'] as Slot[],
    tools: TOOLS,
    needsSession: true,
    ...(paidPlan
      ? {
          planRequirements: {
            plan: m!.options.vercel.plan,
            reason:
              'stack.yaml asks for this plan. Team projects and stricter deployment protection are paid features on Vercel.',
          },
        }
      : {}),

    async detect(ctx: Ctx): Promise<Detection> {
      const version = await ctx.io
        .exec('vercel', ['--version'])
        .then((r) => (r.code === 0 ? /(\d+\.\d+\.\d+)/.exec(`${r.stdout} ${r.stderr}`)?.[1] : undefined))
        .catch(() => undefined)
      if (!version) return { installed: false }
      const who = await ctx.io.exec('vercel', ['whoami']).catch(() => undefined)
      if (!who || who.code !== 0) return { installed: true, version }
      const account = who.stdout.trim().split('\n').filter(Boolean).pop() ?? ''
      if (!account) return { installed: true, version }
      return { installed: true, version, session: { account } }
    },

    async login(ctx: Ctx): Promise<Session> {
      // In the foreground, so the device code and link are on screen and the CLI can wait for as
      // long as the approval takes. Part A of Goal 1 lost this login to a captured, timed exec.
      await runVendorLogin(ctx, ID, 'Vercel', 'vercel', ['login'], vercelLoginStep())
      const detection = await provider.detect(ctx)
      if (!detection.session) {
        throw new CimientoError({
          code: 'SESSION_LOGIN_FAILED',
          provider: ID,
          resource: 'vercel.session',
          message: 'The Vercel login finished but vercel whoami still reports no account.',
          hint: 'Run cimiento up again. It reopens the Vercel login, and nothing was left half done.',
          retryable: true,
          needsHuman: true,
        })
      }
      return detection.session
    },

    resources(manifest: Manifest, _state: ProjectState): ResourceSpec[] {
      if (manifest.slots.hosting !== ID) return []
      const specs = baseResources({ id: ID, tools: TOOLS, needsSession: true })
      const projectId: Value = { deferred: 'vercel.project:projectId' }

      specs.push({
        id: 'vercel.project',
        kind: 'resource',
        provider: ID,
        dependsOn: ['vercel.session'],
        inputs: {
          name: manifest.slug,
          framework: manifest.options.vercel.framework,
          deploymentProtection: manifest.options.vercel.deployment_protection,
        },
        billable: manifest.options.vercel.plan !== 'hobby',
      })

      const envIds: string[] = []
      for (const secret of manifest.secrets) {
        if (!secret.sinks.includes('hosting')) continue
        for (const environment of secret.environments) {
          const id = envResourceId(secret.name, environment)
          envIds.push(id)
          specs.push({
            id,
            kind: 'binding',
            provider: ID,
            dependsOn: ['vercel.project'],
            inputs: {
              projectId,
              key: secret.name,
              environment,
              source: 'secret',
            },
          })
        }
      }

      if (envIds.length > 0) {
        // secrets.present from spec section 12: every declared secret in every environment it
        // declares, proved from the env store itself, names only.
        specs.push({
          id: 'vercel.check.secrets-present',
          kind: 'check',
          provider: ID,
          dependsOn: [...envIds],
          inputs: {
            projectId,
            expected: manifest.secrets
              .filter((s) => s.sinks.includes('hosting'))
              .map((s) => `${s.name}:${s.environments.join('|')}`)
              .join(','),
          },
        })
      }

      specs.push({
        id: 'vercel.deployment',
        kind: 'resource',
        provider: ID,
        dependsOn: ['vercel.project', ...envIds],
        inputs: {
          projectId,
          name: manifest.slug,
          productionBranch: manifest.options.github.defaultBranch,
        },
      })

      specs.push({
        id: 'vercel.check.deployed',
        kind: 'check',
        provider: ID,
        dependsOn: ['vercel.deployment'],
        inputs: {
          url: { deferred: 'vercel.deployment:productionUrl' },
          slug: manifest.slug,
          requireMarker: manifest.scaffold.template === 'none' ? 'false' : 'true',
        },
      })

      return specs
    },

    async ensure(spec: ResourceSpec, ctx: Ctx): Promise<EnsureResult> {
      if (spec.kind === 'check' || spec.kind === 'manual') return { action: 'noop' }
      if (spec.kind === 'tool') {
        const tool = findTool({ tools: TOOLS }, spec)
        if (!tool) throw unknownResource(spec)
        return ensureTool(ID, tool, spec, ctx)
      }
      if (spec.kind === 'session') return ensureSession(provider, spec, ctx)
      if (spec.id === 'vercel.project') return ensureProject(spec, ctx)
      if (spec.id === 'vercel.binding.git-repo') return ensureGitLink(spec, ctx)
      if (spec.id.startsWith('vercel.env.')) return ensureEnv(spec, ctx)
      if (spec.id === 'vercel.binding.supabase-install') return ensureSupabaseInstall(spec, ctx)
      if (spec.id === 'vercel.deployment') return ensureDeployment(spec, ctx)
      if (spec.id === 'vercel.binding.domain') return ensureDomain(spec, ctx)
      throw unknownResource(spec)
    },

    async verify(spec: ResourceSpec, ctx: Ctx): Promise<CheckResult> {
      if (spec.id === 'vercel.marketplace-terms') return verifyMarketplaceInstalled(spec, ctx)
      if (spec.id === 'vercel.github-access') return verifyGithubAccess(spec, ctx)
      if (spec.kind === 'tool') {
        const tool = findTool({ tools: TOOLS }, spec)
        if (!tool) throw unknownResource(spec)
        return verifyTool(ID, tool, spec, ctx)
      }
      if (spec.kind === 'session') return verifySession(provider, spec, ctx)
      if (spec.id === 'vercel.project') return verifyProject(spec, ctx)
      if (spec.id === 'vercel.binding.git-repo' || spec.id === 'vercel.check.repo-linked') {
        return verifyGitLink(spec, ctx)
      }
      if (spec.id.startsWith('vercel.env.')) return verifyEnv(spec, ctx)
      if (spec.id === 'vercel.binding.supabase-install') return verifySupabaseInstall(spec, ctx)
      if (spec.id === 'vercel.deployment') return verifyDeployment(spec, ctx)
      if (spec.id === 'vercel.check.deployed') return verifyDeployed(spec, ctx)
      if (spec.id === 'vercel.check.secrets-present') return verifySecretsPresent(spec, ctx)
      if (spec.id === 'vercel.check.preview') return verifyPreview(spec, ctx)
      if (spec.id === 'vercel.binding.domain') return verifyDomain(spec, ctx)
      if (spec.id === 'vercel.check.domain') return verifyVercelDomainServes(spec, ctx)
      throw unknownResource(spec)
    },

    async destroy(spec: ResourceSpec, ctx: Ctx): Promise<void> {
      if (spec.id !== 'vercel.project') return
      const name = str(spec.inputs.name)
      // By the recorded id: a project made later under the same name is not this one (BUG-82).
      const id = recordedId(ctx, spec, `the Vercel project ${name}`)
      const result = await vercelCall(ctx, spec.id, 'DELETE', `/v9/projects/${encodeURIComponent(id)}`)
      if (!result.ok && result.status !== 404) {
        throw vercelError(spec.id, result, {
          code: 'VERCEL_API_ERROR',
          message: `Deleting the Vercel project ${name} failed.`,
          hint: 'Vercel refused the delete. cimiento down retries safely; if it keeps failing, the login is not an owner of the team.',
        })
      }
    },

    async presence(spec: ResourceSpec, ctx: Ctx): Promise<Presence> {
      // A deployment exists only inside its project.
      if (spec.id !== 'vercel.project' && spec.id !== 'vercel.deployment') return 'unknown'
      const id = ctx.state.resources['vercel.project']?.externalId
      if (!id) return 'unknown'
      const result = await vercelCall(ctx, spec.id, 'GET', `/v9/projects/${encodeURIComponent(id)}`)
      return presenceFromStatus(result.status)
    },

    async outputs(spec: ResourceSpec, ctx: Ctx): Promise<Record<string, Output>> {
      if (spec.id === 'vercel.project') {
        const project = await getProject(ctx, spec, str(spec.inputs.name))
        return project ? projectOutputs(project) : {}
      }
      if (spec.id === 'vercel.binding.supabase-install') {
        const keys = await supabaseKeysInEnv(ctx, spec, str(spec.inputs.projectId))
        if (keys.length === 0) return {}
        return {
          keys: { value: keys.join(','), secret: false },
          installedBy: { value: ctx.state.resources[spec.id]?.outputs?.installedBy ?? 'existing', secret: false },
        }
      }
      if (spec.id === 'vercel.deployment') {
        const deployment = await latestProductionDeployment(ctx, spec, str(spec.inputs.projectId))
        if (!deployment) return {}
        const project = await getProject(ctx, spec, str(spec.inputs.name))
        return deploymentOutputs(deployment, project)
      }
      return {}
    },

    async billing(spec: ResourceSpec, ctx: Ctx): Promise<BillingInfo | undefined> {
      if (spec.id !== 'vercel.project') return undefined
      const team = ctx.manifest.accounts.vercel
      if (!team) return { account: 'the Vercel team picked at login', plan: 'unknown', paid: false }
      const info = await vercelTeamPlan(ctx, spec.id, team)
      if (!info) return { account: `Vercel team ${team}`, plan: 'unknown', paid: false }
      return { account: `Vercel team ${info.name}`, plan: info.plan, paid: info.plan !== 'hobby' }
    },

    explain(key: string, lang: Lang): string {
      const entry = VERCEL_EXPLAIN[key] ?? envExplain(key)
      if (!entry) return `No explanation for ${key} yet.`
      return (lang === 'es' && entry.es) || entry.en
    },
  }
  return provider
}

export const vercelProvider = createVercelProvider()

function envExplain(key: string): { en: string; es?: string } | undefined {
  if (!key.startsWith('vercel.env.')) return undefined
  const parts = key.split('.')
  const name = parts[2] ?? 'a secret'
  const environment = parts[3] ?? 'an environment'
  return {
    en: `The secret ${name} stored in the Vercel project for the ${environment} environment. cimiento writes the value, never prints it, and never keeps a copy.`,
    es: `El secreto ${name} guardado en el proyecto de Vercel para el entorno ${environment}. cimiento escribe el valor, nunca lo imprime y nunca guarda una copia.`,
  }
}

async function ensureSession(provider: Provider, spec: ResourceSpec, ctx: Ctx): Promise<EnsureResult> {
  const { account, action } = await ensureVendorSession(provider, spec, ctx, 'Vercel', vercelSignupStep())
  if (!ctx.manifest.accounts.vercel) await pinTeam(spec, ctx)
  const check = await verifySession(provider, spec, ctx)
  if (!check.ok && check.error) throw check.error
  const team = ctx.manifest.accounts.vercel
  return {
    action,
    externalId: account,
    outputs: { account: { value: account, secret: false }, ...(team ? { team: { value: team, secret: false } } : {}) },
  }
}

/**
 * Every Vercel project lives in a team, and the choice decides who is billed. With one team there
 * is nothing to ask. With several, the person picks, and the answer goes into stack.yaml.
 */
async function pinTeam(spec: ResourceSpec, ctx: Ctx, opts: { alwaysAsk?: boolean; to?: string } = {}): Promise<string | undefined> {
  const result = await vercelCall<{ teams?: { id: string; slug: string; name?: string }[] }>(ctx, spec.id, 'GET', '/v2/teams')
  if (!result.ok) {
    throw vercelError(spec.id, result, {
      code: 'VERCEL_API_ERROR',
      message: 'Listing your Vercel teams failed.',
      hint: 'cimiento up retries this safely. A 403 means the login belongs to a different Vercel account than expected.',
    })
  }
  const options = (result.body?.teams ?? []).map((t) => ({ value: t.id, label: `${t.name ?? t.slug} (${t.slug})`, slug: t.slug }))
  if (opts.to) {
    const match = options.find((o) => o.value === opts.to || o.slug === opts.to)
    if (!match) {
      throw new CimientoError({
        code: 'ACCOUNT_CHOICE_NEEDED',
        provider: ID,
        resource: spec.id,
        message: `No Vercel team ${opts.to} is visible to this login. The choices are ${options.map((o) => o.label).join(', ')}.`,
        hint: 'Pass one of the listed teams with --to, or run cimiento accounts set vercel in a terminal to pick one.',
        retryable: true,
        needsHuman: true,
      })
    }
    setInManifest(ctx, ['accounts', 'vercel'], match.value)
    return match.value
  }
  if (opts.alwaysAsk && options.length > 1) {
    if (!ctx.interactive || !ctx.choose) {
      throw new CimientoError({
        code: 'ACCOUNT_CHOICE_NEEDED',
        provider: ID,
        resource: spec.id,
        message: `You have ${options.length} Vercel teams: ${options.map((o) => o.label).join(', ')}.`,
        hint: `Run cimiento accounts set vercel in a terminal in ${ctx.cwd} and pick one, or pass --to with the team id.`,
        retryable: true,
        needsHuman: true,
      })
    }
    await ctx.walkStep?.(vercelTeamStep(options.map((o) => o.label)))
    const picked = await ctx.choose('Which Vercel team should this project use?', options)
    setInManifest(ctx, ['accounts', 'vercel'], picked)
    return picked
  }
  if (opts.alwaysAsk && options.length === 1) {
    setInManifest(ctx, ['accounts', 'vercel'], options[0].value)
    return options[0].value
  }
  return chooseAndPin(ctx, {
    provider: ID,
    resource: spec.id,
    what: 'Vercel team',
    path: ['accounts', 'vercel'],
    options,
    step: vercelTeamStep(options.map((o) => o.label)),
  })
}

/** cimiento accounts set vercel: ask again and overwrite. */
export async function chooseVercelTeam(ctx: Ctx, to?: string): Promise<string | undefined> {
  const spec: ResourceSpec = { id: 'vercel.session', kind: 'session', provider: ID, dependsOn: [], inputs: {} }
  await ensureVendorSession(vercelProvider, spec, ctx, 'Vercel')
  return pinTeam(spec, ctx, { alwaysAsk: true, ...(to ? { to } : {}) })
}

/**
 * Vercel accounts pin a team, not a user, so the session check confirms the login exists and that
 * the pinned team is reachable with it.
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
        message: 'The Vercel CLI is not installed yet, so cimiento cannot read the Vercel session.',
        hint: 'cimiento up installs the Vercel CLI for you before it needs the session.',
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
        message: 'Not logged in to Vercel.',
        hint: LOGIN_HINT,
        retryable: true,
        needsHuman: false,
      }),
    }
  }
  const team = ctx.manifest.accounts.vercel
  if (!team) return { ok: true, evidence: `vercel session as ${detection.session.account}` }
  const result = await vercelCall<{ id?: string; slug?: string; name?: string }>(
    ctx,
    spec.id,
    'GET',
    team.startsWith('team_') ? `/v2/teams/${encodeURIComponent(team)}` : `/v2/teams?slug=${encodeURIComponent(team)}`,
  )
  if (!result.ok) {
    return {
      ok: false,
      error: new CimientoError({
        code: 'SESSION_ACCOUNT_MISMATCH',
        provider: ID,
        resource: spec.id,
        message: `Logged in to Vercel as ${detection.session.account}, but that login cannot reach the team ${team} that stack.yaml pins.`,
        hint: `Either log in as a member of ${team}, or change accounts.vercel in stack.yaml. cimiento will not deploy into the wrong team silently.`,
        retryable: false,
        needsHuman: true,
      }),
    }
  }
  return { ok: true, evidence: `vercel session as ${detection.session.account} in team ${team}` }
}

async function getProject(ctx: Ctx, spec: ResourceSpec, idOrName: string): Promise<VercelProject | undefined> {
  if (!idOrName) return undefined
  const result = await vercelCall<VercelProject>(ctx, spec.id, 'GET', `/v9/projects/${encodeURIComponent(idOrName)}`)
  if (result.status === 404) return undefined
  if (!result.ok) {
    throw vercelError(spec.id, result, {
      code: 'VERCEL_API_ERROR',
      message: `Reading the Vercel project ${idOrName} failed.`,
      hint: 'Check vercel whoami and that accounts.vercel in stack.yaml points at the right team.',
    })
  }
  return result.body
}

async function ensureProject(spec: ResourceSpec, ctx: Ctx): Promise<EnsureResult> {
  const name = str(spec.inputs.name)
  const known = ctx.state.resources[spec.id]
  const existing = await getProject(ctx, spec, name)
  if (existing) {
    return {
      action: sameResource(known?.externalId, existing.id) ? 'noop' : 'adopted',
      externalId: existing.id,
      url: dashboardUrl(existing),
      outputs: projectOutputs(existing),
    }
  }
  if (ctx.dryRun) return { action: 'noop' }
  const created = await vercelCall<VercelProject>(ctx, spec.id, 'POST', '/v10/projects', {
    name,
    framework: str(spec.inputs.framework) || null,
  })
  if (!created.ok || !created.body) {
    throw vercelError(spec.id, created, {
      code: 'VERCEL_PROJECT_CREATE_FAILED',
      message: `Creating the Vercel project ${name} failed.`,
      hint: 'Pick a different name in stack.yaml, or check that accounts.vercel points at a team you belong to.',
    })
  }
  return {
    action: 'created',
    externalId: created.body.id,
    url: dashboardUrl(created.body),
    outputs: projectOutputs(created.body),
  }
}

/** The page a person opens to look at the project, not the deployed site. */
function dashboardUrl(project: VercelProject): string {
  return `https://vercel.com/projects/${project.name}`
}

async function verifyProject(spec: ResourceSpec, ctx: Ctx): Promise<CheckResult> {
  const name = str(spec.inputs.name)
  const project = await getProject(ctx, spec, name)
  if (!project) {
    return {
      ok: false,
      error: new CimientoError({
        code: 'VERCEL_PROJECT_NOT_FOUND',
        provider: ID,
        resource: spec.id,
        message: `No Vercel project named ${name} in this account.`,
        hint: 'Run cimiento up to create it, or check that accounts.vercel in stack.yaml points at the right team.',
        retryable: true,
        needsHuman: false,
      }),
    }
  }
  return { ok: true, evidence: `vercel project ${project.name} (${project.id})` }
}

function projectOutputs(project: VercelProject): Record<string, Output> {
  const alias = project.targets?.production?.alias?.[0]
  const outputs: Record<string, Output> = {
    projectId: { value: project.id, secret: false },
    projectName: { value: project.name, secret: false },
  }
  if (project.accountId) outputs.orgId = { value: project.accountId, secret: false }
  if (alias) outputs.productionAlias = { value: `https://${alias}`, secret: false }
  return outputs
}

async function ensureGitLink(spec: ResourceSpec, ctx: Ctx): Promise<EnsureResult> {
  const projectId = str(spec.inputs.projectId)
  const repo = str(spec.inputs.repo)
  const branch = str(spec.inputs.productionBranch) || 'main'
  const project = await getProject(ctx, spec, projectId)
  if (project && linkedRepo(project) === repo) {
    return { action: 'noop', externalId: projectId, outputs: { repo: { value: repo, secret: false } } }
  }
  if (ctx.dryRun) return { action: 'noop' }
  const [org, name] = splitRepo(spec, repo)
  const linked = await vercelCall<VercelProject>(ctx, spec.id, 'POST', `/v9/projects/${encodeURIComponent(projectId)}/link`, {
    type: 'github',
    org,
    repo: name,
    productionBranch: branch,
  })
  if (!linked.ok && /Login Connection/i.test(linked.raw)) {
    throw new CimientoError({
      code: 'VERCEL_GITHUB_CONNECTION_NEEDED',
      provider: ID,
      resource: spec.id,
      message: 'Vercel cannot link the repository because your Vercel account has no GitHub Login Connection.',
      hint: 'Connect GitHub under Login Connections at https://vercel.com/account/authentication, then run cimiento up again.',
      docsUrl: 'https://vercel.com/account/authentication',
      retryable: true,
      needsHuman: true,
    })
  }
  if (!linked.ok) {
    throw vercelError(spec.id, linked, {
      code: 'VERCEL_GIT_LINK_FAILED',
      message: `Linking the Vercel project to ${repo} failed.`,
      hint: 'Install the Vercel app on the GitHub repository at https://github.com/apps/vercel, then run cimiento up again.',
    })
  }
  return {
    action: project?.link ? 'updated' : 'created',
    externalId: projectId,
    outputs: { repo: { value: repo, secret: false }, productionBranch: { value: branch, secret: false } },
  }
}

async function verifyGitLink(spec: ResourceSpec, ctx: Ctx): Promise<CheckResult> {
  const projectId = str(spec.inputs.projectId)
  const repo = str(spec.inputs.repo)
  const project = await getProject(ctx, spec, projectId)
  const actual = project ? linkedRepo(project) : undefined
  if (!project || actual !== repo) {
    return {
      ok: false,
      error: new CimientoError({
        code: 'VERCEL_GIT_LINK_FAILED',
        provider: ID,
        resource: spec.id,
        message: `The Vercel project points at ${actual ?? 'no repository'}, cimiento expects ${repo}.`,
        hint: 'Run cimiento up to relink it, or connect the repository in the Vercel project settings.',
        retryable: true,
        needsHuman: false,
      }),
    }
  }
  const branch = project.link?.productionBranch ?? 'main'
  return { ok: true, evidence: `vercel project linked to ${repo} on ${branch}` }
}

function linkedRepo(project: VercelProject): string | undefined {
  const link = project.link
  if (!link?.org || !link?.repo) return undefined
  return `${link.org}/${link.repo}`
}

function splitRepo(spec: ResourceSpec, repo: string): [string, string] {
  const parts = repo.split('/')
  if (parts.length !== 2 || !parts[0] || !parts[1]) {
    throw new CimientoError({
      code: 'VERCEL_GIT_LINK_FAILED',
      provider: ID,
      resource: spec.id,
      message: `Expected a repository as owner/name and got "${repo}".`,
      hint: 'This is a bug in the github provider or the wiring rule. Run cimiento plan --json and open an issue.',
      retryable: false,
      needsHuman: true,
    })
  }
  return [parts[0], parts[1]]
}

async function listEnv(ctx: Ctx, spec: ResourceSpec, projectId: string): Promise<VercelEnv[]> {
  const result = await vercelCall<{ envs?: VercelEnv[] }>(
    ctx,
    spec.id,
    'GET',
    `/v9/projects/${encodeURIComponent(projectId)}/env`,
  )
  if (!result.ok) {
    throw vercelError(spec.id, result, {
      code: 'VERCEL_API_ERROR',
      message: 'Reading the environment variables of the Vercel project failed.',
      hint: 'Check vercel whoami, then run cimiento doctor --json.',
    })
  }
  return result.body?.envs ?? []
}

async function ensureEnv(spec: ResourceSpec, ctx: Ctx): Promise<EnsureResult> {
  // secret rotate asks every sink to write over the value it holds.
  if (str(spec.inputs.rotate) === 'true' && !ctx.dryRun) return rotateEnv({ ...spec, inputs: { ...spec.inputs, rotate: '' } }, ctx)
  const projectId = str(spec.inputs.projectId)
  const key = str(spec.inputs.key)
  const environment = str(spec.inputs.environment)
  const target = toVercelTarget(environment)

  const existing = await listEnv(ctx, spec, projectId)
  if (existing.some((e) => e.key === key && e.target.includes(target))) {
    return { action: 'noop', externalId: `${projectId}/${key}/${target}` }
  }
  if (ctx.dryRun) return { action: 'noop' }

  const value = await resolveEnvValue(spec, ctx, key)
  // A value marked public, such as the Turnstile site key the page ships to every browser, is
  // shown in receipts; everything else is masked from here on (BUG-49).
  if (str(spec.inputs.public) !== 'true') {
    ctx.redactor.addName(key)
    ctx.redactor.addValue(value)
  }

  const created = await vercelCall<unknown>(ctx, spec.id, 'POST', `/v10/projects/${encodeURIComponent(projectId)}/env`, {
    key,
    value,
    type: 'encrypted',
    target: [target],
  })
  if (!created.ok) {
    throw vercelError(spec.id, created, {
      code: 'VERCEL_ENV_WRITE_FAILED',
      message: `Writing ${key} to the ${target} environment of the Vercel project failed.`,
      hint: `Run cimiento secret set ${key} again, or add it by hand in the Vercel project settings.`,
    })
  }
  return { action: 'created', externalId: `${projectId}/${key}/${target}` }
}

/**
 * secret rotate: writes the new value over the env entry that already holds the key, keeping its
 * id and targets, or creates the entry when it is missing.
 */
export async function rotateEnv(spec: ResourceSpec, ctx: Ctx): Promise<EnsureResult> {
  const projectId = str(spec.inputs.projectId)
  const key = str(spec.inputs.key)
  const target = toVercelTarget(str(spec.inputs.environment))
  const existing = (await listEnv(ctx, spec, projectId)).find((e) => e.key === key && e.target.includes(target))
  if (!existing) return ensureEnv(spec, ctx)
  const value = await resolveEnvValue(spec, ctx, key)
  // A value marked public, such as the Turnstile site key the page ships to every browser, is
  // shown in receipts; everything else is masked from here on (BUG-49).
  if (str(spec.inputs.public) !== 'true') {
    ctx.redactor.addName(key)
    ctx.redactor.addValue(value)
  }
  const updated = await vercelCall<unknown>(
    ctx,
    spec.id,
    'PATCH',
    `/v9/projects/${encodeURIComponent(projectId)}/env/${encodeURIComponent(existing.id)}`,
    { value, type: 'encrypted' },
  )
  if (!updated.ok) {
    throw vercelError(spec.id, updated, {
      code: 'VERCEL_ENV_WRITE_FAILED',
      message: `Replacing ${key} in the ${target} environment of the Vercel project failed.`,
      hint: `Run cimiento secret rotate ${key} again; it only writes, it never deletes.`,
    })
  }
  return { action: 'updated', externalId: `${projectId}/${key}/${target}` }
}

/**
 * secret remove: deletes every entry of the key in the environments the spec covers. A missing
 * entry is already the wanted outcome.
 */
export async function removeEnv(spec: ResourceSpec, ctx: Ctx): Promise<boolean> {
  const projectId = str(spec.inputs.projectId)
  const key = str(spec.inputs.key)
  const target = toVercelTarget(str(spec.inputs.environment))
  const entries = (await listEnv(ctx, spec, projectId)).filter((e) => e.key === key && e.target.includes(target))
  for (const entry of entries) {
    const deleted = await vercelCall<unknown>(ctx, spec.id, 'DELETE', `/v9/projects/${encodeURIComponent(projectId)}/env/${encodeURIComponent(entry.id)}`)
    if (!deleted.ok && deleted.status !== 404) {
      throw vercelError(spec.id, deleted, {
        code: 'VERCEL_ENV_WRITE_FAILED',
        message: `Deleting ${key} from the ${target} environment of the Vercel project failed.`,
        hint: `Run cimiento secret remove ${key} again; it only deletes what is still there.`,
      })
    }
  }
  return entries.length > 0
}

async function resolveEnvValue(spec: ResourceSpec, ctx: Ctx, key: string): Promise<string> {
  if (str(spec.inputs.source) === 'literal') {
    const value = str(spec.inputs.value)
    if (value) return value
  } else {
    const value = await ctx.secrets.get(key)
    if (value) return value
  }
  throw new CimientoError({
    code: 'SECRET_MISSING',
    provider: ID,
    resource: spec.id,
    message: `cimiento has no value for ${key}, so it cannot write it to Vercel.`,
    hint: `Run cimiento up in a terminal in ${ctx.cwd}: it asks for ${key} at a hidden prompt${
      ctx.secrets && ctx.manifest.secrets.find((x) => x.name === key)?.source === 'keychain' ? ' and keeps it in the macOS keychain' : ''
    }, once for all its environments. cimiento secret set ${key} does the same on its own. Never paste it into chat.`,
    retryable: true,
    needsHuman: true,
  })
}

async function verifyEnv(spec: ResourceSpec, ctx: Ctx): Promise<CheckResult> {
  const projectId = str(spec.inputs.projectId)
  const key = str(spec.inputs.key)
  const target = toVercelTarget(str(spec.inputs.environment))
  const existing = await listEnv(ctx, spec, projectId)
  if (!existing.some((e) => e.key === key && e.target.includes(target))) {
    return {
      ok: false,
      error: new CimientoError({
        code: 'SECRET_MISSING',
        provider: ID,
        resource: spec.id,
        message: `${key} is not set in the ${target} environment of the Vercel project.`,
        hint: `Run cimiento secret set ${key}.`,
        retryable: true,
        needsHuman: true,
      }),
    }
  }
  return { ok: true, evidence: `${key}=**** present in vercel ${target}` }
}

/**
 * The via-hosting path from spec section 6: the Supabase project is created by the Vercel
 * Marketplace and its keys arrive in the project env by themselves.
 */
async function ensureSupabaseInstall(spec: ResourceSpec, ctx: Ctx): Promise<EnsureResult> {
  const projectId = str(spec.inputs.projectId)
  const name = str(spec.inputs.name)
  const already = await supabaseKeysInEnv(ctx, spec, projectId)
  if (already.length > 0) {
    // Keys this step did not put there came from somewhere else, such as a Link Existing install.
    // installedBy tells supabase.project whether the database is cimiento's own or adopted.
    const installedBy = ctx.state.resources[spec.id]?.outputs?.installedBy ?? 'existing'
    return {
      action: 'noop',
      externalId: projectId,
      outputs: { keys: { value: already.join(','), secret: false }, installedBy: { value: installedBy, secret: false } },
    }
  }
  if (ctx.dryRun) return { action: 'noop' }

  // Never a silent reuse of a configuration that serves other projects: the person settles it
  // before the plan, and an unsettled one waits on them (BUG-46).
  await settleSupabasePath(ctx, spec.id, { ask: false })

  await ensureLocalLink(ctx, spec, name)
  // --name so the Supabase project carries the slug cimiento looks it up by, and --no-env-pull
  // because the vendor default writes .env.local, and cimiento env pull is the only place secrets
  // may touch disk.
  const args = ['integration', 'add', 'supabase', '--name', name, '--no-env-pull']
  const account = ctx.manifest.accounts.vercel
  if (account) args.push('--scope', account)
  const result = ctx.interactive
    ? await ctx.io.interactive('vercel', args, { cwd: ctx.cwd })
    : await ctx.io.exec('vercel', [...args, '--non-interactive'], { cwd: ctx.cwd })
  if (result.code !== 0) {
    const text = `${result.stderr}\n${result.stdout}`
    const terms = /terms|marketplace|accept/i.test(text) || !ctx.interactive
    throw new CimientoError({
      code: terms ? 'VERCEL_MARKETPLACE_TERMS_PENDING' : 'VERCEL_API_ERROR',
      provider: ID,
      resource: spec.id,
      message: `Installing Supabase from the Vercel Marketplace did not finish${text.trim() ? `: ${text.trim().slice(0, 400)}` : '.'}`,
      hint: terms
        ? attendedUpHint(ctx, 'Adding Supabase from the Vercel Marketplace')
        : 'cimiento up retries this safely. If it keeps failing, the Vercel message above says why.',
      retryable: true,
      needsHuman: true,
    })
  }
  const keys = await supabaseKeysInEnv(ctx, spec, projectId)
  return {
    action: 'created',
    externalId: projectId,
    outputs: { keys: { value: keys.join(','), secret: false }, installedBy: { value: 'cimiento', secret: false } },
  }
}

/**
 * The vendor CLI acts on the project linked in .vercel/project.json. cimiento links explicitly by
 * name and team instead of letting deploy or integration add guess from the folder name.
 */
export async function ensureLocalLink(ctx: Ctx, spec: ResourceSpec, projectName: string): Promise<void> {
  const linkFile = join(ctx.cwd, '.vercel', 'project.json')
  if (existsSync(linkFile)) {
    try {
      const linked = JSON.parse(readFileSync(linkFile, 'utf8')) as { projectName?: string; projectId?: string }
      const project = await getProject(ctx, spec, projectName)
      if (project && (linked.projectId === project.id || linked.projectName === projectName)) return
    } catch {
      // An unreadable link file is relinked below.
    }
  }
  const args = ['link', '--yes', '--project', projectName]
  const account = ctx.manifest.accounts.vercel
  if (account) args.push('--scope', account)
  const result = await ctx.io.exec('vercel', args, { cwd: ctx.cwd })
  if (result.code !== 0) {
    throw new CimientoError({
      code: 'VERCEL_PROJECT_NOT_FOUND',
      provider: ID,
      resource: spec.id,
      message: `Linking this folder to the Vercel project ${projectName} failed: ${(result.stderr || result.stdout).trim().slice(0, 300)}`,
      hint: 'cimiento up creates the project before it links, so this usually means the pinned Vercel team is not the one the project lives in. cimiento doctor shows both.',
      retryable: true,
      needsHuman: false,
    })
  }
}

interface GitNamespace {
  id: number | string
  slug: string
  ownerType?: string
  installationId?: number | string
}


/**
 * Both things Vercel needs to link a private repository, checked before any link is attempted.
 * git-namespaces answers only when Vercel has a GitHub Login Connection, and lists every GitHub
 * account the Vercel app is installed on. search-repo lists the repositories the app can see.
 * These are the endpoints the Vercel import screen uses; see docs/DECISIONS.md.
 */
async function verifyGithubAccess(spec: ResourceSpec, ctx: Ctx): Promise<CheckResult> {
  const repo = str(spec.inputs.repo)
  const [owner, name] = repo.split('/')
  const namespaces = await vercelCall<GitNamespace[]>(ctx, spec.id, 'GET', '/v1/integrations/git-namespaces?provider=github', undefined, {
    unscoped: true,
  })
  if (namespaces.status >= 500) {
    // Vercel is having trouble, which says nothing about access. The link step reports any real
    // problem, so this does not ask the person for something that may already be done.
    return {
      ok: false,
      unknown: true,
      error: new CimientoError({
        code: 'VERCEL_API_ERROR',
        provider: ID,
        resource: spec.id,
        message: `Could not check GitHub access: Vercel answered ${namespaces.status}.`,
        hint: 'This is on the Vercel side. Run cimiento doctor again in a minute; the repository link step checks access too.',
        retryable: true,
        needsHuman: false,
      }),
    }
  }
  const connected = namespaces.ok
  const namespace = connected
    ? (namespaces.body ?? []).find((n) => n.slug.toLowerCase() === (owner ?? '').toLowerCase())
    : undefined
  let repoVisible = false
  if (namespace) {
    const search = await vercelCall<{ repos?: { name?: string; slug?: string }[] }>(
      ctx,
      spec.id,
      'GET',
      `/v1/integrations/search-repo?provider=github&namespaceId=${encodeURIComponent(String(namespace.id))}&query=${encodeURIComponent(name ?? '')}`,
      undefined,
      { unscoped: true },
    )
    repoVisible = search.ok && (search.body?.repos ?? []).some((r) => (r.slug ?? r.name) === name)
  }
  if (connected && repoVisible) {
    return { ok: true, evidence: `Vercel sees ${repo} through its GitHub app (installation ${namespace!.installationId ?? namespace!.id})` }
  }

  const configure =
    namespace?.installationId !== undefined
      ? namespace.ownerType === 'team'
        ? `https://github.com/organizations/${owner}/settings/installations/${namespace.installationId}`
        : `https://github.com/settings/installations/${namespace.installationId}`
      : undefined
  const personStep = githubAccessStep({ repo, connected, ...(configure ? { configureUrl: configure } : {}) })
  return {
    ok: false,
    error: new CimientoError({
      code: 'VERCEL_GITHUB_ACCESS_NEEDED',
      provider: ID,
      resource: spec.id,
      message: connected
        ? `Vercel cannot link ${repo} yet: the Vercel GitHub app cannot see the repository.`
        : `Vercel cannot link ${repo} yet: your Vercel account has no GitHub Login Connection, so cimiento cannot tell whether the Vercel GitHub app can see the repository either.`,
      hint: renderPersonStep(personStep, ctx.lang, { links: false }),
      personStep,
      docsUrl: personStep.url,
      retryable: true,
      needsHuman: true,
    }),
  }
}

/**
 * Proves the Marketplace step instead of taking the person's word for it: the Supabase
 * integration shows up as installed on the pinned team.
 */
async function verifyMarketplaceInstalled(spec: ResourceSpec, ctx: Ctx): Promise<CheckResult> {
  const result = await vercelCall<IntegrationConfiguration[] | { configurations?: IntegrationConfiguration[] }>(
    ctx,
    spec.id,
    'GET',
    '/v1/integrations/configurations?view=account',
  )
  const list = Array.isArray(result.body) ? result.body : (result.body?.configurations ?? [])
  const supabase = result.ok
    ? list.find((c) => c.slug === 'supabase' || c.integration?.slug === 'supabase')
    : undefined
  const personStep = supabase ? undefined : await marketplacePersonStep(ctx, spec.id).catch(() => undefined)
  if (!supabase) {
    return {
      ok: false,
      error: new CimientoError({
        code: 'MANUAL_STEP_PENDING',
        provider: ID,
        resource: spec.id,
        message: 'The Supabase integration is not installed on this Vercel team yet.',
        // Built now rather than at plan time, so it names the team and organization pinned
        // earlier in this run and says which Install dialog choice to make.
        hint: await marketplaceInstructions(ctx, spec.id).catch(
          () => spec.manual?.instructions ?? attendedUpHint(ctx, 'Accepting the Vercel Marketplace terms'),
        ),
        ...(personStep ? { personStep, docsUrl: personStep.url } : {}),
        retryable: true,
        needsHuman: true,
      }),
    }
  }
  return { ok: true, evidence: `supabase integration installed on vercel, configuration ${supabase.id}` }
}

interface IntegrationConfiguration {
  id: string
  slug?: string
  integration?: { slug?: string }
}

async function verifySupabaseInstall(spec: ResourceSpec, ctx: Ctx): Promise<CheckResult> {
  const projectId = str(spec.inputs.projectId)
  const keys = await supabaseKeysInEnv(ctx, spec, projectId)
  if (keys.length === 0) {
    return {
      ok: false,
      error: new CimientoError({
        code: 'SUPABASE_KEYS_MISSING',
        provider: ID,
        resource: spec.id,
        message: 'No Supabase URL or key is present in the Vercel project environment.',
        hint: 'cimiento up adds Supabase from the Vercel Marketplace, and the keys arrive in the project by themselves after that.',
        retryable: true,
        needsHuman: true,
      }),
    }
  }
  return { ok: true, evidence: `supabase keys in vercel env: ${keys.join(', ')}` }
}

async function supabaseKeysInEnv(ctx: Ctx, spec: ResourceSpec, projectId: string): Promise<string[]> {
  if (!projectId) return []
  const envs = await listEnv(ctx, spec, projectId)
  return envs.filter((e) => /SUPABASE/.test(e.key)).map((e) => e.key)
}

async function latestProductionDeployment(
  ctx: Ctx,
  spec: ResourceSpec,
  projectId: string,
): Promise<VercelDeployment | undefined> {
  if (!projectId) return undefined
  const result = await vercelCall<{ deployments?: VercelDeployment[] }>(
    ctx,
    spec.id,
    'GET',
    `/v6/deployments?projectId=${encodeURIComponent(projectId)}&target=production&limit=1`,
  )
  if (!result.ok) {
    throw vercelError(spec.id, result, {
      code: 'VERCEL_API_ERROR',
      message: 'Listing deployments failed.',
      hint: 'Check vercel whoami, then run cimiento doctor --json.',
    })
  }
  return result.body?.deployments?.[0]
}

function isReady(deployment: VercelDeployment): boolean {
  const state = (deployment.readyState ?? deployment.state ?? '').toUpperCase()
  return state === 'READY'
}

/** The deployment meta key a CLI deploy from a clean tree carries its commit in. */
const COMMIT_META = 'cimientoCommit'

async function ensureDeployment(spec: ResourceSpec, ctx: Ctx): Promise<EnsureResult> {
  const projectId = str(spec.inputs.projectId)
  const name = str(spec.inputs.name)
  const known = ctx.state.resources[spec.id]
  const existing = await latestProductionDeployment(ctx, spec, projectId)
  const stale = existing && isReady(existing) ? await envNewerThan(ctx, spec, projectId, existing) : []
  if (existing && isReady(existing) && stale.length > 0 && !ctx.dryRun) {
    ctx.logger.log({
      level: 'info',
      event: 'redeploy',
      resource: spec.id,
      message: `Deploying again: ${stale.map((k) => `${k}=****`).join(', ')} changed after the last production deployment, and Vercel only reads env when it builds.`,
    })
  }
  if (existing && isReady(existing) && (stale.length === 0 || ctx.dryRun)) {
    const project = await getProject(ctx, spec, projectId)
    const outputs = deploymentOutputs(existing, project)
    return {
      action: known ? 'noop' : 'adopted',
      externalId: existing.uid,
      url: outputs.productionUrl?.value,
      outputs,
    }
  }
  if (ctx.dryRun) return { action: 'noop' }

  await ensureLocalLink(ctx, spec, name)
  const args = ['deploy', '--prod', '--yes']
  const account = ctx.manifest.accounts.vercel
  if (account) args.push('--scope', account)
  // An upload from the CLI records no commit on Vercel. With a clean tree the upload is exactly
  // HEAD, so the deployment carries it, and publish reads it from Vercel, not from state (BUG-87).
  const head = await ctx.io.exec('git', ['rev-parse', 'HEAD'], { cwd: ctx.cwd }).catch(() => undefined)
  const dirty = await ctx.io.exec('git', ['status', '--porcelain'], { cwd: ctx.cwd }).catch(() => undefined)
  const sha = head?.code === 0 ? head.stdout.trim() : ''
  if (sha && dirty?.code === 0 && dirty.stdout.trim() === '') args.push('--meta', `${COMMIT_META}=${sha}`)
  // deploy waits for the build to finish. A first Next.js build takes minutes, far past the
  // default exec timeout that killed the Vercel login in Goal 1 Part A.
  const result = await ctx.io.exec('vercel', args, { cwd: ctx.cwd, timeoutMs: DEPLOY_TIMEOUT_MS })
  if (result.code !== 0) {
    throw new CimientoError({
      code: 'VERCEL_DEPLOY_FAILED',
      provider: ID,
      resource: spec.id,
      message: `vercel deploy --prod failed: ${(result.stderr || result.stdout).trim().slice(0, 500)}`,
      hint: 'Open the build log the message links to. A failing build is almost always an application error, not a cimiento one.',
      retryable: true,
      needsHuman: false,
    })
  }
  const deployed = await latestProductionDeployment(ctx, spec, projectId)
  if (!deployed) {
    throw new CimientoError({
      code: 'VERCEL_DEPLOYMENT_NOT_READY',
      provider: ID,
      resource: spec.id,
      message: `vercel deploy reported success but no production deployment is listed for ${name}.`,
      hint: 'Vercel accepted the deploy but lists nothing yet. cimiento up checks again; a first build on a new project can take a few minutes.',
      retryable: true,
      needsHuman: false,
    })
  }
  const project = await getProject(ctx, spec, projectId)
  const outputs = deploymentOutputs(deployed, project, result.stdout)
  return { action: existing ? 'updated' : 'created', externalId: deployed.uid, url: outputs.productionUrl?.value, outputs }
}

/**
 * Production env keys written after a deployment was built. Vercel bakes the env into each
 * deployment, so a key added by an integration or changed by secret rotate only reaches the app
 * through a new one.
 */
async function envNewerThan(ctx: Ctx, spec: ResourceSpec, projectId: string, deployment: VercelDeployment): Promise<string[]> {
  const built = deployment.createdAt ?? deployment.created
  if (!built) return []
  const envs = await listEnv(ctx, spec, projectId)
  return envs.filter((e) => e.target.includes('production') && (e.updatedAt ?? e.createdAt ?? 0) > built).map((e) => e.key)
}

const deployWait = { intervalMs: 5000, timeoutMs: 15 * 60 * 1000 }

/** Tests shorten the wait between polls of a deployment. */
export function setDeployWait(next: Partial<typeof deployWait>): void {
  Object.assign(deployWait, next)
}

/**
 * The deployment Vercel builds from one pushed commit, waited for until it is ready. Vercel starts
 * it from the GitHub push by itself, so cimiento only watches for the commit's sha.
 */
export async function waitForCommitDeployment(
  ctx: Ctx,
  spec: ResourceSpec,
  projectId: string,
  sha: string,
): Promise<{ url: string; productionUrl?: string; state: string }> {
  const deadline = Date.now() + deployWait.timeoutMs
  let state = 'not started'
  for (;;) {
    const list = await vercelCall<{ deployments?: (VercelDeployment & { meta?: Record<string, string | undefined> })[] }>(
      ctx,
      spec.id,
      'GET',
      `/v6/deployments?projectId=${encodeURIComponent(projectId)}&limit=20`,
    )
    const deployment = (list.body?.deployments ?? []).find((d) => d.meta?.githubCommitSha === sha)
    if (deployment) {
      state = (deployment.readyState ?? deployment.state ?? 'unknown').toUpperCase()
      if (state === 'READY') {
        const project = await getProject(ctx, spec, projectId)
        const alias = defaultAlias(project)
        return { url: `https://${deployment.url}`, ...(alias && deployment.target === 'production' ? { productionUrl: `https://${alias}` } : {}), state }
      }
      if (state === 'ERROR' || state === 'CANCELED') {
        throw new CimientoError({
          code: 'VERCEL_DEPLOY_FAILED',
          provider: ID,
          resource: spec.id,
          message: `Vercel's deployment of commit ${sha.slice(0, 7)} ended ${state}.`,
          hint: `Open the build log at https://${deployment.url} on Vercel. A failing build is almost always an error in the site's code; fix it and run cimiento publish again.`,
          retryable: true,
          needsHuman: false,
        })
      }
    }
    if (Date.now() >= deadline) {
      throw new CimientoError({
        code: 'VERCEL_DEPLOYMENT_NOT_READY',
        provider: ID,
        resource: spec.id,
        message: `No ready Vercel deployment of commit ${sha.slice(0, 7)} after ${Math.round(deployWait.timeoutMs / 60000)} min (last state: ${state}).`,
        hint: 'Check that the Vercel project is linked to the repository with cimiento doctor, then run cimiento publish again; it does not commit twice.',
        retryable: true,
        needsHuman: false,
      })
    }
    await new Promise((resolve) => setTimeout(resolve, deployWait.intervalMs))
  }
}

function deploymentOutputs(
  deployment: VercelDeployment,
  project: VercelProject | undefined,
  cliOutput = '',
): Record<string, Output> {
  const alias = defaultAlias(project)
  const fromCli = /https:\/\/[^\s]+/.exec(cliOutput)?.[0]
  const url = alias ? `https://${alias}` : (fromCli ?? `https://${deployment.url}`)
  return {
    deploymentId: { value: deployment.uid, secret: false },
    productionUrl: { value: url, secret: false },
    deploymentUrl: { value: `https://${deployment.url}`, secret: false },
  }
}

async function verifyDeployment(spec: ResourceSpec, ctx: Ctx): Promise<CheckResult> {
  const projectId = str(spec.inputs.projectId)
  const deployment = await latestProductionDeployment(ctx, spec, projectId)
  if (!deployment) {
    return {
      ok: false,
      error: new CimientoError({
        code: 'VERCEL_DEPLOYMENT_NOT_READY',
        provider: ID,
        resource: spec.id,
        message: 'No production deployment exists for this Vercel project yet.',
        hint: 'Run cimiento up, which sends the first deployment.',
        retryable: true,
        needsHuman: false,
      }),
    }
  }
  if (!isReady(deployment)) {
    return {
      ok: false,
      error: new CimientoError({
        code: 'VERCEL_DEPLOYMENT_NOT_READY',
        provider: ID,
        resource: spec.id,
        message: `The latest production deployment is ${deployment.readyState ?? deployment.state ?? 'in an unknown state'}.`,
        hint: 'Wait for the build to finish, then run cimiento doctor again. If it failed, open the build log in Vercel.',
        retryable: true,
        needsHuman: false,
      }),
    }
  }
  const stale = await envNewerThan(ctx, spec, projectId, deployment)
  if (stale.length > 0) {
    return {
      ok: false,
      error: new CimientoError({
        code: 'VERCEL_DEPLOYMENT_NOT_READY',
        provider: ID,
        resource: spec.id,
        message: `The production deployment was built before ${stale.map((k) => `${k}=****`).join(', ')} changed, so the live app still runs with the old env.`,
        hint: 'Run cimiento up. It deploys again so the live app reads the current env.',
        retryable: true,
        needsHuman: false,
      }),
    }
  }
  return { ok: true, evidence: `deployment ${deployment.uid} ready at https://${deployment.url}` }
}

async function verifyDeployed(spec: ResourceSpec, ctx: Ctx): Promise<CheckResult> {
  const url = str(spec.inputs.url)
  const requireMarker = str(spec.inputs.requireMarker) === 'true'
  const slug = str(spec.inputs.slug)
  const res = await ctx.io.http({ method: 'GET', url })
  if (res.status !== 200) {
    return {
      ok: false,
      error: new CimientoError({
        code: 'CHECK_FAILED',
        provider: ID,
        resource: spec.id,
        message: `${url} answered ${res.status}, cimiento expects 200.`,
        hint:
          res.status === 401
            ? 'Deployment protection is on. Set options.vercel.deployment_protection to none in stack.yaml, or open the URL while logged in to Vercel.'
            : 'Open the URL in a browser and check the Vercel build log for the latest production deployment.',
        retryable: true,
        needsHuman: res.status === 401,
      }),
    }
  }
  if (requireMarker && !res.text.includes(`cimiento-project`)) {
    return {
      ok: false,
      error: new CimientoError({
        code: 'CHECK_FAILED',
        provider: ID,
        resource: spec.id,
        message: `${url} answered 200 but the page does not carry the cimiento scaffold marker.`,
        hint: `The deployed page is not the scaffold cimiento generated for ${slug}. If you replaced the home page on purpose, set scaffold.template to none in stack.yaml.`,
        retryable: false,
        needsHuman: true,
      }),
    }
  }
  return { ok: true, evidence: `200 from ${url}` }
}

/** The branches of a repository and their head commits, through gh. */
export async function repoBranches(ctx: Ctx, repo: string): Promise<{ name: string; sha: string }[]> {
  const result = await ctx.io.exec('gh', ['api', `repos/${repo}/branches?per_page=100`, '--jq', '[.[] | {name: .name, sha: .commit.sha}]'])
  if (result.code !== 0) return []
  try {
    return JSON.parse(result.stdout || '[]') as { name: string; sha: string }[]
  } catch {
    return []
  }
}

/**
 * hosting.preview, spec section 12: every pushed branch besides production has a ready preview
 * of its head commit. Vercel builds one per push by itself; this proves it happened.
 */
async function verifyPreview(spec: ResourceSpec, ctx: Ctx): Promise<CheckResult> {
  const repo = str(spec.inputs.repo)
  const production = str(spec.inputs.productionBranch) || 'main'
  const branches = (await repoBranches(ctx, repo)).filter((b) => b.name !== production).slice(0, 10)
  if (branches.length === 0) {
    return { ok: true, evidence: `no branch besides ${production} yet; the first pushed branch gets a preview, and this check then proves it` }
  }
  const list = await vercelCall<{ deployments?: (VercelDeployment & { meta?: { githubCommitSha?: string; githubCommitRef?: string } })[] }>(
    ctx,
    spec.id,
    'GET',
    `/v6/deployments?projectId=${encodeURIComponent(str(spec.inputs.projectId))}&limit=100`,
  )
  const deployments = list.body?.deployments ?? []
  const ready: string[] = []
  const missing: string[] = []
  for (const branch of branches) {
    const d = deployments.find((x) => x.meta?.githubCommitSha === branch.sha && x.meta?.githubCommitRef === branch.name)
    const state = (d?.readyState ?? d?.state ?? '').toUpperCase()
    if (d && state === 'READY') ready.push(`${branch.name} at https://${d.url}`)
    else missing.push(`${branch.name} (${d ? state.toLowerCase() || 'unknown' : 'no deployment of its head commit yet'})`)
  }
  if (missing.length > 0) {
    return {
      ok: false,
      error: new CimientoError({
        code: 'HOSTING_PREVIEW_NOT_READY',
        provider: ID,
        resource: spec.id,
        message: `No ready preview for ${missing.join(', ')}.`,
        hint: 'Vercel builds a preview for every pushed branch by itself, usually within two minutes. Run cimiento doctor again; if the state says error, open the build log in the Vercel project.',
        retryable: true,
        needsHuman: false,
      }),
    }
  }
  return { ok: true, evidence: `preview ready for ${ready.join(', ')}` }
}

async function verifySecretsPresent(spec: ResourceSpec, ctx: Ctx): Promise<CheckResult> {
  const envs = await listEnv(ctx, spec, str(spec.inputs.projectId))
  const expected = str(spec.inputs.expected)
    .split(',')
    .filter(Boolean)
    .map((entry) => {
      const [name, environments] = entry.split(':')
      return { name, targets: (environments ?? '').split('|').filter(Boolean).map(toVercelTarget) }
    })
  const missing: string[] = []
  let present = 0
  for (const { name, targets } of expected) {
    for (const target of targets) {
      if (envs.some((e) => e.key === name && e.target.includes(target))) present += 1
      else missing.push(`${name} in ${target}`)
    }
  }
  if (missing.length > 0) {
    const names = [...new Set(missing.map((m) => m.split(' ')[0]))]
    return {
      ok: false,
      error: new CimientoError({
        code: 'SECRET_MISSING',
        provider: ID,
        resource: spec.id,
        message: `Declared secrets missing from the Vercel env: ${missing.join(', ')}.`,
        hint: `Run ${names.map((n) => `cimiento secret set ${n}`).join(', then ')} in a terminal.`,
        retryable: true,
        needsHuman: true,
      }),
    }
  }
  return {
    ok: true,
    evidence: `${expected.length} declared secret${expected.length === 1 ? '' : 's'} present in ${present} vercel target${present === 1 ? '' : 's'}: ${expected.map((e) => `${e.name}=****`).join(', ')}`,
  }
}

function str(value: Value | undefined): string {
  return typeof value === 'string' ? value : ''
}

function unknownResource(spec: ResourceSpec): CimientoError {
  return new CimientoError({
    code: 'PLAN_UNKNOWN_DEPENDENCY',
    provider: ID,
    resource: spec.id,
    message: `The vercel provider does not know the resource ${spec.id}.`,
    hint: 'This is a bug. Run cimiento plan --json and open an issue with the output.',
    retryable: false,
    needsHuman: true,
  })
}

export default vercelProvider

/**
 * The production address on vercel.app. With a custom domain Vercel lists it among the aliases too,
 * and the default address must stay what checks and wiring follow, so domain remove changes nothing
 * but the domain.
 */
function defaultAlias(project: VercelProject | undefined): string | undefined {
  const aliases = project?.targets?.production?.alias ?? []
  return aliases.find((a) => a.endsWith('.vercel.app')) ?? aliases[0]
}

/** The DNS record a domain at an outside DNS provider needs to reach Vercel. */
export function vercelDnsRecord(domain: string): DnsRecord {
  const name = recordName(domain)
  return name === '@' ? { type: 'A', name, value: '76.76.21.21' } : { type: 'CNAME', name, value: 'cname.vercel-dns.com' }
}

/** Adds the custom domain to the project, or with inputs.remove, takes it off. */
async function ensureDomain(spec: ResourceSpec, ctx: Ctx): Promise<EnsureResult> {
  const projectId = str(spec.inputs.projectId)
  const domain = str(spec.inputs.domain)
  const remove = str(spec.inputs.remove) === 'true'
  const path = `/v9/projects/${encodeURIComponent(projectId)}/domains/${encodeURIComponent(domain)}`
  const current = await vercelCall<{ name?: string; verified?: boolean }>(ctx, spec.id, 'GET', path)
  const present = current.ok
  const externalId = `${projectId}/${domain}`
  if (present !== remove) return { action: 'noop', externalId }
  if (ctx.dryRun) return { action: 'noop' }
  if (remove) {
    const deleted = await vercelCall(ctx, spec.id, 'DELETE', path)
    if (!deleted.ok && deleted.status !== 404) {
      throw vercelError(spec.id, deleted, { code: 'HOSTING_DOMAIN_FAILED', message: `Removing ${domain} from the Vercel project failed.`, hint: `Run cimiento domain remove ${domain} again; it only removes what is still there.` })
    }
    return { action: 'updated', externalId, outputs: { domain: { value: '', secret: false } } }
  }
  const added = await vercelCall<{ verified?: boolean }>(ctx, spec.id, 'POST', `/v10/projects/${encodeURIComponent(projectId)}/domains`, { name: domain })
  if (!added.ok) {
    throw vercelError(spec.id, added, {
      code: 'HOSTING_DOMAIN_FAILED',
      message: `Adding ${domain} to the Vercel project failed.`,
      hint: added.status === 409
        ? `${domain} already belongs to another Vercel project. Remove it there, or pick another subdomain, then run cimiento domain add again.`
        : `Run cimiento domain add ${domain} again; it only adds what is missing.`,
    })
  }
  return { action: 'created', externalId, url: `https://${domain}`, outputs: { domain: { value: domain, secret: false } } }
}

async function verifyDomain(spec: ResourceSpec, ctx: Ctx): Promise<CheckResult> {
  const projectId = str(spec.inputs.projectId)
  const domain = str(spec.inputs.domain)
  const current = await vercelCall(ctx, spec.id, 'GET', `/v9/projects/${encodeURIComponent(projectId)}/domains/${encodeURIComponent(domain)}`)
  if (current.ok) return { ok: true, evidence: `${domain} is a domain of the Vercel project` }
  return {
    ok: false,
    error: new CimientoError({
      code: 'HOSTING_DOMAIN_FAILED',
      provider: ID,
      resource: spec.id,
      message: `${domain} is not a domain of the Vercel project.`,
      hint: `Run cimiento domain add ${domain}.`,
      retryable: true,
      needsHuman: false,
    }),
  }
}

interface VercelDomainConfig {
  misconfigured?: boolean
  recommendedCNAME?: { rank: number; value: string }[]
  recommendedIPv4?: { rank: number; value: string[] }[]
}

/**
 * The record Vercel itself recommends for this domain, first by rank, and whether Vercel already
 * sees it configured. Vercel recommends a project specific CNAME first now; cname.vercel-dns.com is
 * the fallback when it says nothing (BUG-64).
 */
async function vercelDomainDns(ctx: Ctx, spec: ResourceSpec, domain: string): Promise<{ record: DnsRecord; ready?: boolean }> {
  const fallback = vercelDnsRecord(domain)
  const config = await vercelCall<VercelDomainConfig>(ctx, spec.id, 'GET', `/v6/domains/${encodeURIComponent(domain)}/config`)
  if (!config.ok || !config.body) return { record: fallback }
  const byRank = <T extends { rank: number }>(list: T[] | undefined) => [...(list ?? [])].sort((a, b) => a.rank - b.rank)[0]
  const record =
    fallback.type === 'CNAME'
      ? { ...fallback, value: (byRank(config.body.recommendedCNAME)?.value ?? fallback.value).replace(/\.$/, '') }
      : { ...fallback, value: byRank(config.body.recommendedIPv4)?.value?.[0] ?? fallback.value }
  return { record, ...(typeof config.body.misconfigured === 'boolean' ? { ready: !config.body.misconfigured } : {}) }
}

async function verifyVercelDomainServes(spec: ResourceSpec, ctx: Ctx): Promise<CheckResult> {
  const domain = str(spec.inputs.domain)
  const projectId = str(spec.inputs.projectId)
  // A domain whose apex lives in another account must first be proved with a TXT record.
  const info = await vercelCall<{ verified?: boolean; verification?: { type: string; domain: string; value: string }[] }>(
    ctx,
    spec.id,
    'GET',
    `/v9/projects/${encodeURIComponent(projectId)}/domains/${encodeURIComponent(domain)}`,
  )
  const challenge = info.body?.verified === false ? info.body.verification?.[0] : undefined
  if (challenge) {
    const record = { type: challenge.type, name: challenge.domain.replace(`.${domain.split('.').slice(-2).join('.')}`, ''), value: challenge.value }
    return verifyDomainServes(spec, ctx, { domain, record, vendor: 'Vercel', requireMarker: str(spec.inputs.requireMarker) === 'true', dnsReady: false })
  }
  const dns = await vercelDomainDns(ctx, spec, domain)
  return verifyDomainServes(spec, ctx, {
    domain,
    record: dns.record,
    vendor: 'Vercel',
    requireMarker: str(spec.inputs.requireMarker) === 'true',
    ...(dns.ready !== undefined ? { dnsReady: dns.ready } : {}),
  })
}

/** The commit of the newest ready production deployment, when Vercel recorded one. */
export async function vercelLiveCommit(ctx: Ctx, spec: ResourceSpec, projectId: string): Promise<LiveCommit> {
  const list = await vercelCall<{ deployments?: (VercelDeployment & { meta?: Record<string, string | undefined> })[] }>(
    ctx,
    spec.id,
    'GET',
    `/v6/deployments?projectId=${encodeURIComponent(projectId)}&target=production&limit=20`,
  )
  if (!list.ok) return { known: false, reason: `Vercel answered ${list.status} to the deployments lookup` }
  const ready = (list.body?.deployments ?? []).find((d) => (d.readyState ?? d.state ?? '').toUpperCase() === 'READY')
  return { known: true, commit: ready?.meta?.githubCommitSha ?? ready?.meta?.[COMMIT_META] }
}

