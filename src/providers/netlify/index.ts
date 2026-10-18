// Netlify provider. Fills the hosting slot and is the env store for every secret with the hosting
// sink when stack.yaml says hosting: netlify. netlify login owns the session, the API owns sites,
// env vars, builds and deploys. Netlify builds from the GitHub repository: cimiento links it with a
// deploy key and a repository webhook, the path netlify init takes, so no GitHub app install is
// asked of the person (docs/DECISIONS.md). Production, previews and branch deploys then follow
// pushes by themselves.

import { CimientoError } from '../../core/errors'
import { netlifyLoginStep, netlifySignupStep, netlifyTeamStep } from '../../core/person-steps-v2'
import { hostingEnvId } from '../../core/sink-ids'
import { sameResource, type ProjectState } from '../../core/state'
import { baseResources, ensureTool, ensureVendorSession, findTool, runVendorLogin, sessionCheck, verifyTool } from '../../core/toolkit'
import { presenceFromStatus, type Presence } from '../../core/types'
import type { CheckResult, Ctx, Detection, EnsureResult, Lang, Output, Provider, ResourceSpec, Session, Slot, ToolSpec, Value } from '../../core/types'
import { chooseAndPin } from '../../manifest/pin'
import type { Manifest } from '../../manifest/schema'
import { recordName, verifyDomainServes, type DnsRecord } from '../domain-check'
import { repoBranches } from '../vercel'
import { findNetlifyToken, netlifyCall, netlifyContexts, netlifyError } from './api'
import { NETLIFY_EXPLAIN } from './explain'

const ID = 'netlify'

const TOOLS: ToolSpec[] = [
  { name: 'Netlify CLI', bin: 'netlify', versionRange: '>=17.0.0', install: { npm: 'netlify-cli' }, versionCmd: 'netlify --version' },
]

const LOGIN_HINT = 'cimiento up opens the Netlify login in your browser and waits while you approve it.'
const ENV_SCOPES = ['builds', 'functions', 'runtime', 'post-processing']

export interface NetlifySite {
  id: string
  name: string
  account_id?: string
  account_slug?: string
  url?: string
  ssl_url?: string
  admin_url?: string
  custom_domain?: string | null
  domain_aliases?: string[]
  deploy_hook?: string
  build_settings?: { repo_path?: string; repo_branch?: string; provider?: string; deploy_key_id?: string; allowed_branches?: string[]; updated_at?: string } | null
  plugins?: { package: string; pinned_version?: string }[]
}

/**
 * The Next.js runtime on Netlify. Without it Netlify publishes the raw .next folder and every page
 * answers 404 (BUG-61). netlify init sets it on the site with the repository settings; so does
 * cimiento, for every scaffold it makes, which is Next.js.
 */
export const NEXT_PLUGIN = '@netlify/plugin-nextjs'

function wantsNextPlugin(ctx: Ctx): boolean {
  return ctx.manifest.scaffold.template !== 'none' || ctx.manifest.options.vercel.framework === 'nextjs'
}

export interface NetlifyDeploy {
  id: string
  state?: string
  context?: string
  branch?: string
  commit_ref?: string | null
  ssl_url?: string
  deploy_ssl_url?: string
  created_at?: string
  error_message?: string | null
}

interface NetlifyEnvVar {
  key: string
  values?: { id?: string; value?: string; context?: string }[]
  updated_at?: string
}

function str(value: Value | undefined): string {
  return typeof value === 'string' ? value : ''
}

export function createNetlifyProvider(_m?: Manifest): Provider {
  const provider: Provider = {
    id: ID,
    fills: ['hosting'] as Slot[],
    tools: TOOLS,
    needsSession: true,

    async detect(ctx: Ctx): Promise<Detection> {
      const version = await ctx.io
        .exec('netlify', ['--version'])
        .then((r) => (r.code === 0 ? /(\d+\.\d+\.\d+)/.exec(`${r.stdout} ${r.stderr}`)?.[1] : undefined))
        .catch(() => undefined)
      if (!version) return { installed: false }
      if (!findNetlifyToken()) return { installed: true, version }
      const me = await netlifyCall<{ email?: string; full_name?: string }>(ctx, 'netlify.session', 'GET', '/user').catch(() => undefined)
      if (!me?.ok) return { installed: true, version }
      const account = me.body?.email ?? me.body?.full_name
      return account ? { installed: true, version, session: { account } } : { installed: true, version }
    },

    async login(ctx: Ctx): Promise<Session> {
      await runVendorLogin(ctx, ID, 'Netlify', 'netlify', ['login'], netlifyLoginStep())
      const detection = await provider.detect(ctx)
      if (!detection.session) {
        throw new CimientoError({
          code: 'SESSION_LOGIN_FAILED',
          provider: ID,
          resource: 'netlify.session',
          message: 'The Netlify login finished but the Netlify API still reports no account.',
          hint: 'Run cimiento up again. It reopens the Netlify login, and nothing was left half done.',
          retryable: true,
          needsHuman: true,
        })
      }
      return detection.session
    },

    resources(manifest: Manifest, _state: ProjectState): ResourceSpec[] {
      if (manifest.slots.hosting !== ID) return []
      const specs = baseResources({ id: ID, tools: TOOLS, needsSession: true })
      const projectId: Value = { deferred: 'netlify.project:projectId' }
      specs.push({ id: 'netlify.project', kind: 'resource', provider: ID, dependsOn: ['netlify.session'], inputs: { name: manifest.slug } })

      const envIds: string[] = []
      for (const secret of manifest.secrets) {
        if (!secret.sinks.includes('hosting')) continue
        for (const environment of secret.environments) {
          const id = hostingEnvId(ID, secret.name, environment)
          envIds.push(id)
          specs.push({ id, kind: 'binding', provider: ID, dependsOn: ['netlify.project'], inputs: { projectId, key: secret.name, environment, source: 'secret' } })
        }
      }
      if (envIds.length > 0) {
        specs.push({
          id: 'netlify.check.secrets-present',
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
        id: 'netlify.deployment',
        kind: 'resource',
        provider: ID,
        dependsOn: ['netlify.project', ...envIds],
        inputs: { projectId, name: manifest.slug, productionBranch: manifest.options.github.defaultBranch },
      })
      specs.push({
        id: 'netlify.check.deployed',
        kind: 'check',
        provider: ID,
        dependsOn: ['netlify.deployment'],
        inputs: {
          url: { deferred: 'netlify.deployment:productionUrl' },
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
        if (!tool) throw unknown(spec)
        return ensureTool(ID, tool, spec, ctx)
      }
      if (spec.kind === 'session') return ensureSession(provider, spec, ctx)
      if (spec.id === 'netlify.project') return ensureSite(spec, ctx)
      if (spec.id === 'netlify.binding.git-repo') return ensureGitLink(spec, ctx)
      if (spec.id.startsWith('netlify.env.')) return ensureEnv(spec, ctx)
      if (spec.id === 'netlify.deployment') return ensureDeployment(spec, ctx)
      if (spec.id === 'netlify.binding.domain') return ensureDomain(spec, ctx)
      throw unknown(spec)
    },

    async verify(spec: ResourceSpec, ctx: Ctx): Promise<CheckResult> {
      if (spec.kind === 'tool') {
        const tool = findTool({ tools: TOOLS }, spec)
        if (!tool) throw unknown(spec)
        return verifyTool(ID, tool, spec, ctx)
      }
      if (spec.kind === 'session') return sessionCheck(ID, spec, await provider.detect(ctx), undefined, LOGIN_HINT)
      if (spec.id === 'netlify.project') return verifySite(spec, ctx)
      if (spec.id === 'netlify.binding.git-repo' || spec.id === 'netlify.check.repo-linked') return verifyGitLink(spec, ctx)
      if (spec.id.startsWith('netlify.env.')) return verifyEnv(spec, ctx)
      if (spec.id === 'netlify.deployment') return verifyDeployment(spec, ctx)
      if (spec.id === 'netlify.check.deployed') return verifyDeployed(spec, ctx)
      if (spec.id === 'netlify.check.secrets-present') return verifySecretsPresent(spec, ctx)
      if (spec.id === 'netlify.check.preview') return verifyPreview(spec, ctx)
      if (spec.id === 'netlify.binding.domain') return verifyDomain(spec, ctx)
      if (spec.id === 'netlify.check.domain') {
        const domain = str(spec.inputs.domain)
        return verifyDomainServes(spec, ctx, { domain, record: netlifyDnsRecord(str(spec.inputs.name), domain), vendor: 'Netlify', requireMarker: str(spec.inputs.requireMarker) === 'true' })
      }
      throw unknown(spec)
    },

    async destroy(spec: ResourceSpec, ctx: Ctx): Promise<void> {
      if (spec.id !== 'netlify.project') return
      const id = ctx.state.resources[spec.id]?.externalId ?? (await findSite(ctx, spec, str(spec.inputs.name)))?.id
      if (!id) return
      const result = await netlifyCall(ctx, spec.id, 'DELETE', `/sites/${encodeURIComponent(id)}`)
      if (!result.ok && result.status !== 404) {
        throw netlifyError(spec.id, result, {
          code: 'NETLIFY_API_ERROR',
          message: `Deleting the Netlify site ${str(spec.inputs.name)} failed`,
          hint: 'cimiento down retries safely; if it keeps failing, the login is not an owner of the team.',
        })
      }
    },

    async presence(spec: ResourceSpec, ctx: Ctx): Promise<Presence> {
      if (spec.id !== 'netlify.project' && spec.id !== 'netlify.deployment') return 'unknown'
      const id = ctx.state.resources['netlify.project']?.externalId
      if (!id) return 'unknown'
      const result = await netlifyCall(ctx, spec.id, 'GET', `/sites/${encodeURIComponent(id)}`)
      return presenceFromStatus(result.status)
    },

    async outputs(spec: ResourceSpec, ctx: Ctx): Promise<Record<string, Output>> {
      if (spec.id === 'netlify.project') {
        const site = await findSite(ctx, spec, str(spec.inputs.name))
        return site ? siteOutputs(site) : {}
      }
      if (spec.id === 'netlify.deployment') {
        const site = await getSite(ctx, spec, str(spec.inputs.projectId))
        const deploy = site ? await latestProductionDeploy(ctx, spec, site.id) : undefined
        return site && deploy ? deployOutputs(site, deploy) : {}
      }
      return {}
    },

    explain(key: string, lang: Lang): string {
      const entry = NETLIFY_EXPLAIN[key] ?? envExplain(key)
      if (!entry) return `No explanation for ${key} yet.`
      return (lang === 'es' && entry.es) || entry.en
    },
  }
  return provider
}

function envExplain(key: string): { en: string; es?: string } | undefined {
  if (!key.startsWith('netlify.env.')) return undefined
  const [, , name = 'a secret', environment = 'an environment'] = key.split('.')
  return {
    en: `The value ${name} stored in the Netlify site for the ${environment} environment. cimiento writes it, never prints it, and never keeps a copy.`,
    es: `El valor ${name} guardado en el sitio de Netlify para el entorno ${environment}. cimiento lo escribe, nunca lo imprime y nunca guarda una copia.`,
  }
}

function unknown(spec: ResourceSpec): CimientoError {
  return new CimientoError({
    code: 'NETLIFY_API_ERROR',
    provider: ID,
    resource: spec.id,
    message: `The netlify provider does not know the resource ${spec.id}.`,
    hint: 'This is a cimiento bug. Run cimiento plan --json and report the item.',
    retryable: false,
    needsHuman: false,
  })
}

// Session and team

async function ensureSession(provider: Provider, spec: ResourceSpec, ctx: Ctx): Promise<EnsureResult> {
  const { account, action } = await ensureVendorSession(provider, spec, ctx, 'Netlify', netlifySignupStep())
  if (!ctx.manifest.accounts.netlify) {
    const accounts = await netlifyCall<{ slug: string; name?: string }[]>(ctx, spec.id, 'GET', '/accounts')
    if (accounts.ok) {
      const teams = accounts.body ?? []
      await chooseAndPin(ctx, {
        provider: ID,
        resource: spec.id,
        what: 'Netlify team',
        path: ['accounts', 'netlify'],
        options: teams.map((t) => ({ value: t.slug, label: `${t.name ?? t.slug} (${t.slug})` })),
        step: netlifyTeamStep(teams.map((t) => t.name ?? t.slug)),
      })
    }
  }
  const team = ctx.manifest.accounts.netlify
  return { action, externalId: account, outputs: { account: { value: account, secret: false }, ...(team ? { team: { value: team, secret: false } } : {}) } }
}

// Site

async function findSite(ctx: Ctx, spec: ResourceSpec, name: string): Promise<NetlifySite | undefined> {
  const team = ctx.manifest.accounts.netlify
  const path = team ? `/${encodeURIComponent(team)}/sites?name=${encodeURIComponent(name)}&per_page=100` : `/sites?name=${encodeURIComponent(name)}&filter=all&per_page=100`
  const result = await netlifyCall<NetlifySite[]>(ctx, spec.id, 'GET', path)
  if (!result.ok) {
    throw netlifyError(spec.id, result, { code: 'NETLIFY_API_ERROR', message: 'Listing Netlify sites failed', hint: 'cimiento up retries this safely.' })
  }
  // The name filter can match partially, so only the exact name counts.
  return (result.body ?? []).find((s) => s.name === name)
}

export async function getSite(ctx: Ctx, spec: ResourceSpec, siteId: string): Promise<NetlifySite | undefined> {
  if (!siteId) return undefined
  const result = await netlifyCall<NetlifySite>(ctx, spec.id, 'GET', `/sites/${encodeURIComponent(siteId)}`)
  return result.ok ? result.body : undefined
}

function siteOutputs(site: NetlifySite): Record<string, Output> {
  return {
    projectId: { value: site.id, secret: false },
    ...(site.account_id ? { accountId: { value: site.account_id, secret: false } } : {}),
    siteUrl: { value: site.ssl_url ?? `https://${site.name}.netlify.app`, secret: false },
    ...(site.admin_url ? { adminUrl: { value: site.admin_url, secret: false } } : {}),
  }
}

async function ensureSite(spec: ResourceSpec, ctx: Ctx): Promise<EnsureResult> {
  const name = str(spec.inputs.name)
  const known = ctx.state.resources[spec.id]
  const existing = await findSite(ctx, spec, name)
  if (existing) {
    return { action: sameResource(known?.externalId, existing.id) ? 'noop' : 'adopted', externalId: existing.id, url: existing.admin_url, outputs: siteOutputs(existing) }
  }
  if (ctx.dryRun) return { action: 'noop' }
  const team = ctx.manifest.accounts.netlify
  const created = await netlifyCall<NetlifySite>(ctx, spec.id, 'POST', team ? `/${encodeURIComponent(team)}/sites` : '/sites', { name })
  if (!created.ok || !created.body) {
    if (created.status === 422) {
      throw new CimientoError({
        code: 'NETLIFY_SITE_NAME_TAKEN',
        provider: ID,
        resource: spec.id,
        message: `Netlify refused the site name ${name}: site names are global across Netlify, and someone else has this one.`,
        hint: `Set slug in stack.yaml to a name nobody uses yet, for example ${name}-${Math.random().toString(36).slice(2, 6)}, and run cimiento up again.`,
        retryable: false,
        needsHuman: true,
      })
    }
    throw netlifyError(spec.id, created, { code: 'NETLIFY_API_ERROR', message: `Creating the Netlify site ${name} failed`, hint: 'cimiento up retries this safely; it never creates a second site with the same name.' })
  }
  return { action: 'created', externalId: created.body.id, url: created.body.admin_url, outputs: siteOutputs(created.body) }
}

async function verifySite(spec: ResourceSpec, ctx: Ctx): Promise<CheckResult> {
  const site = await findSite(ctx, spec, str(spec.inputs.name))
  if (!site) {
    return {
      ok: false,
      error: new CimientoError({
        code: 'NETLIFY_SITE_NOT_FOUND',
        provider: ID,
        resource: spec.id,
        message: `No Netlify site named ${str(spec.inputs.name)} is visible to this login.`,
        hint: 'Run cimiento up to create it. If it lives in another team, pin that team in accounts.netlify.',
        retryable: true,
        needsHuman: false,
      }),
    }
  }
  return { ok: true, evidence: `netlify site ${site.name} (${site.id}) at ${site.ssl_url ?? site.url}` }
}

// Git link

/**
 * Links the site to the GitHub repository the way netlify init does without the GitHub app: a
 * deploy key Netlify clones with, added read only to the repository, the repository settings on
 * the site, and a repository webhook to the site's deploy hook so every push builds.
 */
async function ensureGitLink(spec: ResourceSpec, ctx: Ctx): Promise<EnsureResult> {
  const siteId = str(spec.inputs.projectId)
  const repo = str(spec.inputs.repo)
  const branch = str(spec.inputs.productionBranch) || 'main'
  const site = await getSite(ctx, spec, siteId)
  const linked = site?.build_settings?.repo_path === repo && site.build_settings?.repo_branch === branch
  const plugins = site?.plugins ?? []
  const pluginOk = !wantsNextPlugin(ctx) || plugins.some((p) => p.package === NEXT_PLUGIN)
  if (linked && pluginOk && site?.deploy_hook && (await hasHook(ctx, repo, site.deploy_hook))) return { action: 'noop', externalId: `${siteId}/${repo}` }
  if (ctx.dryRun) return { action: 'noop' }

  let keyId = site?.build_settings?.deploy_key_id
  if (!linked || !keyId) {
    const key = await netlifyCall<{ id: string; public_key: string }>(ctx, spec.id, 'POST', '/deploy_keys')
    if (!key.ok || !key.body) throw netlifyError(spec.id, key, { code: 'NETLIFY_REPO_LINK_FAILED', message: 'Creating a Netlify deploy key failed', hint: 'cimiento up retries this safely.' })
    keyId = key.body.id
    const added = await ctx.io.exec('gh', ['api', '-X', 'POST', `repos/${repo}/keys`, '-f', 'title=Netlify Deploy Key', '-f', `key=${key.body.public_key}`, '-F', 'read_only=true'])
    if (added.code !== 0) throw linkFailed(spec, repo, `adding the deploy key: ${(added.stderr || added.stdout).trim().slice(0, 200)}`)
  }
  const repoId = (await ctx.io.exec('gh', ['api', `repos/${repo}`, '--jq', '.id'])).stdout.trim()
  const patched = await netlifyCall<NetlifySite>(ctx, spec.id, 'PATCH', `/sites/${encodeURIComponent(siteId)}`, {
    repo: {
      ...(repoId ? { id: Number(repoId) } : {}),
      provider: 'github',
      repo_path: repo,
      repo_branch: branch,
      allowed_branches: [branch],
      deploy_key_id: keyId,
      cmd: ctx.manifest.options.netlify.build_command,
      dir: ctx.manifest.options.netlify.publish_dir,
    },
    ...(wantsNextPlugin(ctx) && !pluginOk ? { plugins: [...plugins.map((p) => ({ package: p.package })), { package: NEXT_PLUGIN }] } : {}),
  })
  if (!patched.ok || !patched.body) throw netlifyError(spec.id, patched, { code: 'NETLIFY_REPO_LINK_FAILED', message: `Linking the Netlify site to ${repo} failed`, hint: 'cimiento up retries this safely.' })
  const hook = patched.body.deploy_hook
  if (hook && !(await hasHook(ctx, repo, hook))) {
    const created = await ctx.io.exec('gh', [
      'api', '-X', 'POST', `repos/${repo}/hooks`,
      '-f', 'name=web', '-f', `config[url]=${hook}`, '-f', 'config[content_type]=json',
      '-f', 'events[]=push', '-f', 'events[]=pull_request', '-f', 'events[]=delete', '-F', 'active=true',
    ])
    if (created.code !== 0) throw linkFailed(spec, repo, `adding the webhook: ${(created.stderr || created.stdout).trim().slice(0, 200)}`)
  }
  return { action: linked ? 'updated' : 'created', externalId: `${siteId}/${repo}` }
}

async function hasHook(ctx: Ctx, repo: string, url: string): Promise<boolean> {
  const hooks = await ctx.io.exec('gh', ['api', `repos/${repo}/hooks`, '--jq', '[.[].config.url]'])
  if (hooks.code !== 0) return false
  try {
    return (JSON.parse(hooks.stdout || '[]') as string[]).includes(url)
  } catch {
    return false
  }
}

function linkFailed(spec: ResourceSpec, repo: string, what: string): CimientoError {
  return new CimientoError({
    code: 'NETLIFY_REPO_LINK_FAILED',
    provider: ID,
    resource: spec.id,
    message: `Linking Netlify to ${repo} failed while ${what}`,
    hint: 'Only an administrator of the repository can add deploy keys and webhooks. cimiento doctor shows which account gh uses.',
    retryable: true,
    needsHuman: false,
  })
}

async function verifyGitLink(spec: ResourceSpec, ctx: Ctx): Promise<CheckResult> {
  const repo = str(spec.inputs.repo)
  const branch = str(spec.inputs.productionBranch) || 'main'
  const site = await getSite(ctx, spec, str(spec.inputs.projectId))
  const settings = site?.build_settings
  if (settings?.repo_path === repo && (!settings.repo_branch || settings.repo_branch === branch)) {
    return { ok: true, evidence: `Netlify site linked to ${repo} on ${settings.repo_branch ?? branch}` }
  }
  return {
    ok: false,
    error: new CimientoError({
      code: 'NETLIFY_REPO_LINK_FAILED',
      provider: ID,
      resource: spec.id,
      message: settings?.repo_path ? `The Netlify site builds from ${settings.repo_path} on ${settings.repo_branch}, not ${repo} on ${branch}.` : `The Netlify site is not linked to ${repo}.`,
      hint: 'Run cimiento up. It links the site to the repository again.',
      retryable: true,
      needsHuman: false,
    }),
  }
}

// Env

async function listEnv(ctx: Ctx, spec: ResourceSpec, siteId: string, accountId: string): Promise<NetlifyEnvVar[]> {
  const result = await netlifyCall<NetlifyEnvVar[]>(ctx, spec.id, 'GET', `/accounts/${encodeURIComponent(accountId)}/env?site_id=${encodeURIComponent(siteId)}`)
  if (!result.ok) {
    throw netlifyError(spec.id, result, { code: 'NETLIFY_API_ERROR', message: 'Listing the env vars of the Netlify site failed', hint: 'cimiento doctor shows whether the Netlify session reaches this site.' })
  }
  return result.body ?? []
}

async function accountOf(ctx: Ctx, spec: ResourceSpec, siteId: string): Promise<string> {
  const recorded = ctx.state.resources['netlify.project']?.outputs?.accountId
  if (recorded) return recorded
  const site = await getSite(ctx, spec, siteId)
  if (site?.account_id) return site.account_id
  throw new CimientoError({
    code: 'NETLIFY_SITE_NOT_FOUND',
    provider: ID,
    resource: spec.id,
    message: `cimiento could not read the Netlify site ${siteId}, so it does not know its team.`,
    hint: 'Run cimiento up, which creates or adopts the site first.',
    retryable: true,
    needsHuman: false,
  })
}

async function resolveEnvValue(spec: ResourceSpec, ctx: Ctx, key: string): Promise<string> {
  const value = str(spec.inputs.source) === 'literal' ? str(spec.inputs.value) : await ctx.secrets.get(key)
  if (value) {
    if (str(spec.inputs.public) !== 'true') {
      ctx.redactor.addName(key)
      ctx.redactor.addValue(value)
    }
    return value
  }
  throw new CimientoError({
    code: 'SECRET_MISSING',
    provider: ID,
    resource: spec.id,
    message: `cimiento has no value for ${key}, so it cannot write it to Netlify.`,
    hint: `Run cimiento up in a terminal in ${ctx.cwd}: it asks for ${key} at a hidden prompt, once for all its environments. cimiento secret set ${key} does the same on its own. Never paste it into chat.`,
    retryable: true,
    needsHuman: true,
  })
}

async function ensureEnv(spec: ResourceSpec, ctx: Ctx): Promise<EnsureResult> {
  const siteId = str(spec.inputs.projectId)
  const key = str(spec.inputs.key)
  const environment = str(spec.inputs.environment)
  const contexts = netlifyContexts(environment)
  const rotate = str(spec.inputs.rotate) === 'true'
  const accountId = await accountOf(ctx, spec, siteId)
  const existing = (await listEnv(ctx, spec, siteId, accountId)).find((e) => e.key === key)
  const have = new Set((existing?.values ?? []).map((v) => v.context))
  const externalId = `${siteId}/${key}/${environment}`
  if (!rotate && contexts.every((c) => have.has(c) || have.has('all'))) return { action: 'noop', externalId }
  if (ctx.dryRun) return { action: 'noop' }
  const value = await resolveEnvValue(spec, ctx, key)
  const base = `/accounts/${encodeURIComponent(accountId)}/env`
  if (!existing) {
    const created = await netlifyCall(ctx, spec.id, 'POST', `${base}?site_id=${encodeURIComponent(siteId)}`, [
      { key, scopes: ENV_SCOPES, values: contexts.map((context) => ({ context, value })) },
    ])
    if (!created.ok) throw envFailed(spec, created, key, environment)
    return { action: 'created', externalId }
  }
  for (const context of contexts) {
    const set = await netlifyCall(ctx, spec.id, 'PATCH', `${base}/${encodeURIComponent(key)}?site_id=${encodeURIComponent(siteId)}`, { context, value })
    if (!set.ok) throw envFailed(spec, set, key, environment)
  }
  return { action: have.size > 0 && contexts.some((c) => have.has(c)) ? 'updated' : 'created', externalId }
}

function envFailed(spec: ResourceSpec, result: { status: number; ok: boolean; body: unknown }, key: string, environment: string): CimientoError {
  return netlifyError(spec.id, result, {
    code: 'NETLIFY_ENV_WRITE_FAILED',
    message: `Writing ${key} to the ${environment} environment of the Netlify site failed`,
    hint: `Run cimiento secret set ${key} again, or add it by hand under Site configuration, Environment variables.`,
  })
}

/** For cimiento secret remove: deletes the values of the binding's contexts. True when there were any. */
export async function removeNetlifyEnv(spec: ResourceSpec, ctx: Ctx): Promise<boolean> {
  const siteId = str(spec.inputs.projectId)
  const key = str(spec.inputs.key)
  const contexts = netlifyContexts(str(spec.inputs.environment))
  const accountId = await accountOf(ctx, spec, siteId)
  const existing = (await listEnv(ctx, spec, siteId, accountId)).find((e) => e.key === key)
  const values = (existing?.values ?? []).filter((v) => v.id && v.context && contexts.includes(v.context))
  for (const v of values) {
    const deleted = await netlifyCall(ctx, spec.id, 'DELETE', `/accounts/${encodeURIComponent(accountId)}/env/${encodeURIComponent(key)}/value/${encodeURIComponent(v.id!)}?site_id=${encodeURIComponent(siteId)}`)
    if (!deleted.ok && deleted.status !== 404) throw envFailed(spec, deleted, key, str(spec.inputs.environment))
  }
  return values.length > 0
}

/** For cimiento env pull: every variable with a value for the dev context, by name. */
export async function netlifyDevEnv(ctx: Ctx, spec: ResourceSpec, siteId: string): Promise<Record<string, string>> {
  const accountId = await accountOf(ctx, spec, siteId)
  const out: Record<string, string> = {}
  for (const entry of await listEnv(ctx, spec, siteId, accountId)) {
    const value = entry.values?.find((v) => v.context === 'dev')?.value ?? entry.values?.find((v) => v.context === 'all')?.value
    if (value === undefined) continue
    ctx.redactor.addName(entry.key)
    ctx.redactor.addValue(value)
    out[entry.key] = value
  }
  return out
}

async function verifyEnv(spec: ResourceSpec, ctx: Ctx): Promise<CheckResult> {
  const siteId = str(spec.inputs.projectId)
  const key = str(spec.inputs.key)
  const environment = str(spec.inputs.environment)
  const accountId = await accountOf(ctx, spec, siteId)
  const existing = (await listEnv(ctx, spec, siteId, accountId)).find((e) => e.key === key)
  const have = new Set((existing?.values ?? []).map((v) => v.context))
  const missing = netlifyContexts(environment).filter((c) => !have.has(c) && !have.has('all'))
  if (missing.length > 0) {
    return {
      ok: false,
      error: new CimientoError({
        code: 'SECRET_MISSING',
        provider: ID,
        resource: spec.id,
        message: `${key} has no value for ${missing.join(' and ')} in the Netlify site.`,
        hint: `Run cimiento secret set ${key}.`,
        retryable: true,
        needsHuman: true,
      }),
    }
  }
  return { ok: true, evidence: `${key}=**** present in netlify ${netlifyContexts(environment).join(', ')}` }
}

async function verifySecretsPresent(spec: ResourceSpec, ctx: Ctx): Promise<CheckResult> {
  const siteId = str(spec.inputs.projectId)
  const envs = await listEnv(ctx, spec, siteId, await accountOf(ctx, spec, siteId))
  const expected = str(spec.inputs.expected)
    .split(',')
    .filter(Boolean)
    .map((entry) => {
      const [name, environments] = entry.split(':')
      return { name, environments: (environments ?? '').split('|').filter(Boolean) }
    })
  const missing: string[] = []
  let present = 0
  for (const { name, environments } of expected) {
    const have = new Set((envs.find((e) => e.key === name)?.values ?? []).map((v) => v.context))
    for (const environment of environments) {
      if (netlifyContexts(environment).every((c) => have.has(c) || have.has('all'))) present += 1
      else missing.push(`${name} in ${environment}`)
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
        message: `Declared secrets missing from the Netlify env: ${missing.join(', ')}.`,
        hint: `Run ${names.map((n) => `cimiento secret set ${n}`).join(', then ')} in a terminal.`,
        retryable: true,
        needsHuman: true,
      }),
    }
  }
  return { ok: true, evidence: `${expected.length} declared secret${expected.length === 1 ? '' : 's'} present in ${present} netlify environment${present === 1 ? '' : 's'}: ${expected.map((e) => `${e.name}=****`).join(', ')}` }
}

// Deploys

const deployWait = { intervalMs: 5000, timeoutMs: 15 * 60 * 1000 }

/** Tests shorten the wait between polls of a deploy. */
export function setNetlifyDeployWait(next: Partial<typeof deployWait>): void {
  Object.assign(deployWait, next)
}

async function listDeploys(ctx: Ctx, spec: ResourceSpec, siteId: string, query = ''): Promise<NetlifyDeploy[]> {
  const result = await netlifyCall<NetlifyDeploy[]>(ctx, spec.id, 'GET', `/sites/${encodeURIComponent(siteId)}/deploys?per_page=50${query}`)
  return result.ok ? (result.body ?? []) : []
}

async function latestProductionDeploy(ctx: Ctx, spec: ResourceSpec, siteId: string): Promise<NetlifyDeploy | undefined> {
  return (await listDeploys(ctx, spec, siteId, '&production=true')).find((d) => d.context === 'production' || d.context === undefined)
}

function staleName(key: string): string {
  return key === 'the build settings' ? key : `${key}=****`
}

function productionUrl(site: NetlifySite): string {
  return site.custom_domain ? `https://${site.custom_domain}` : (site.ssl_url ?? `https://${site.name}.netlify.app`)
}

function deployOutputs(site: NetlifySite, deploy: NetlifyDeploy): Record<string, Output> {
  return {
    deploymentId: { value: deploy.id, secret: false },
    // The default address keeps working with a custom domain, and checks prove it.
    productionUrl: { value: site.ssl_url ?? `https://${site.name}.netlify.app`, secret: false },
    ...(site.custom_domain ? { customUrl: { value: productionUrl(site), secret: false } } : {}),
    ...(deploy.deploy_ssl_url ? { deploymentUrl: { value: deploy.deploy_ssl_url, secret: false } } : {}),
  }
}

/**
 * What changed after a deploy was built, since Netlify reads env and build settings when it builds:
 * env keys by name, and the build settings themselves, such as the Next.js runtime (BUG-61).
 */
async function envNewerThan(ctx: Ctx, spec: ResourceSpec, siteId: string, deploy: NetlifyDeploy, site?: NetlifySite): Promise<string[]> {
  const built = deploy.created_at ? Date.parse(deploy.created_at) : NaN
  if (Number.isNaN(built)) return []
  const envs = await listEnv(ctx, spec, siteId, await accountOf(ctx, spec, siteId))
  const changed = envs.filter((e) => e.updated_at && Date.parse(e.updated_at) > built).map((e) => e.key)
  const settings = site?.build_settings?.updated_at
  if (settings && Date.parse(settings) > built) changed.push('the build settings')
  return changed
}

async function ensureDeployment(spec: ResourceSpec, ctx: Ctx): Promise<EnsureResult> {
  const siteId = str(spec.inputs.projectId)
  const site = await getSite(ctx, spec, siteId)
  if (!site) throw (await verifySite({ ...spec, inputs: { name: str(spec.inputs.name) } }, ctx)).error!
  const known = ctx.state.resources[spec.id]
  const existing = await latestProductionDeploy(ctx, spec, siteId)
  const ready = existing?.state === 'ready'
  const stale = existing && ready ? await envNewerThan(ctx, spec, siteId, existing, site) : []
  if (existing && ready && (stale.length === 0 || ctx.dryRun)) {
    return { action: known ? 'noop' : 'adopted', externalId: existing.id, url: productionUrl(site), outputs: deployOutputs(site, existing) }
  }
  if (ctx.dryRun) return { action: 'noop' }
  if (stale.length > 0) {
    ctx.logger.log({ level: 'info', event: 'redeploy', resource: spec.id, message: `Building again: ${stale.map(staleName).join(', ')} changed after the last production deploy, and Netlify only reads them when it builds.` })
  }
  // A build of the production branch, from the linked repository.
  const build = await netlifyCall<{ id: string; deploy_id?: string }>(
    ctx,
    spec.id,
    'POST',
    `/sites/${encodeURIComponent(siteId)}/builds?branch=${encodeURIComponent(str(spec.inputs.productionBranch) || 'main')}`,
  )
  if (!build.ok || !build.body) {
    throw netlifyError(spec.id, build, {
      code: 'NETLIFY_DEPLOY_FAILED',
      message: 'Starting a Netlify build failed',
      hint: 'Netlify builds from the linked repository. cimiento doctor shows whether the site is linked; then run cimiento up again.',
    })
  }
  const deploy = await waitForDeploy(ctx, spec, siteId, (d) => (build.body!.deploy_id ? d.id === build.body!.deploy_id : d.context === 'production'))
  return { action: existing ? 'updated' : 'created', externalId: deploy.id, url: productionUrl(site), outputs: deployOutputs(site, deploy) }
}

async function waitForDeploy(ctx: Ctx, spec: ResourceSpec, siteId: string, match: (d: NetlifyDeploy) => boolean, what = 'the production build'): Promise<NetlifyDeploy> {
  const deadline = Date.now() + deployWait.timeoutMs
  let state = 'not started'
  for (;;) {
    const deploy = (await listDeploys(ctx, spec, siteId)).find(match)
    if (deploy) {
      state = deploy.state ?? 'unknown'
      if (state === 'ready') return deploy
      if (state === 'error' || state === 'rejected') {
        throw new CimientoError({
          code: 'NETLIFY_DEPLOY_FAILED',
          provider: ID,
          resource: spec.id,
          message: `Netlify's deploy of ${what} ended ${state}${deploy.error_message ? `: ${deploy.error_message.slice(0, 300)}` : ''}.`,
          hint: 'Open the deploy log in the Netlify site, under Deploys. A failing build is almost always an error in the site\'s code; fix it and run cimiento publish again.',
          retryable: true,
          needsHuman: false,
        })
      }
    }
    if (Date.now() >= deadline) {
      throw new CimientoError({
        code: 'NETLIFY_DEPLOYMENT_NOT_READY',
        provider: ID,
        resource: spec.id,
        message: `No ready Netlify deploy of ${what} after ${Math.round(deployWait.timeoutMs / 60000)} min (last state: ${state}).`,
        hint: 'Check that the site is linked to the repository with cimiento doctor, then run the command again; it does not deploy twice.',
        retryable: true,
        needsHuman: false,
      })
    }
    await new Promise((resolve) => setTimeout(resolve, deployWait.intervalMs))
  }
}

/** The production deploy Netlify builds from one pushed commit, for cimiento publish. */
export async function waitForNetlifyCommit(ctx: Ctx, spec: ResourceSpec, siteId: string, sha: string): Promise<{ url: string; productionUrl?: string; state: string }> {
  const deploy = await waitForDeploy(ctx, spec, siteId, (d) => d.commit_ref === sha && d.context === 'production', `commit ${sha.slice(0, 7)}`)
  const site = await getSite(ctx, spec, siteId)
  return { url: deploy.deploy_ssl_url ?? deploy.ssl_url ?? '', ...(site ? { productionUrl: productionUrl(site) } : {}), state: 'READY' }
}

async function verifyDeployment(spec: ResourceSpec, ctx: Ctx): Promise<CheckResult> {
  const siteId = str(spec.inputs.projectId)
  const deploy = await latestProductionDeploy(ctx, spec, siteId)
  const fail = (message: string, hint: string): CheckResult => ({
    ok: false,
    error: new CimientoError({ code: 'NETLIFY_DEPLOYMENT_NOT_READY', provider: ID, resource: spec.id, message, hint, retryable: true, needsHuman: false }),
  })
  if (!deploy) return fail('No production deploy exists for this Netlify site yet.', 'Run cimiento up, which starts the first build.')
  if (deploy.state !== 'ready') return fail(`The latest production deploy is ${deploy.state ?? 'in an unknown state'}.`, 'Wait for the build to finish, then run cimiento doctor again. If it failed, open the deploy log in Netlify.')
  const stale = await envNewerThan(ctx, spec, siteId, deploy, await getSite(ctx, spec, siteId))
  if (stale.length > 0) {
    return fail(`The production deploy was built before ${stale.map(staleName).join(', ')} changed, so the live site still runs with the old settings.`, 'Run cimiento up. It builds again so the live site reads the current env and settings.')
  }
  return { ok: true, evidence: `deploy ${deploy.id} ready${deploy.deploy_ssl_url ? ` at ${deploy.deploy_ssl_url}` : ''}` }
}

async function verifyDeployed(spec: ResourceSpec, ctx: Ctx): Promise<CheckResult> {
  const url = str(spec.inputs.url)
  const res = await ctx.io.http({ method: 'GET', url })
  if (res.status !== 200) {
    return {
      ok: false,
      error: new CimientoError({
        code: 'CHECK_FAILED',
        provider: ID,
        resource: spec.id,
        message: `${url} answered ${res.status}, cimiento expects 200.`,
        hint: 'Open the URL in a browser and check the deploy log of the latest production deploy in Netlify.',
        retryable: true,
        needsHuman: false,
      }),
    }
  }
  if (str(spec.inputs.requireMarker) === 'true' && !res.text.includes('cimiento-project')) {
    return {
      ok: false,
      error: new CimientoError({
        code: 'CHECK_FAILED',
        provider: ID,
        resource: spec.id,
        message: `${url} answered 200 but the page does not carry the cimiento scaffold marker.`,
        hint: `The deployed page is not the scaffold cimiento generated for ${str(spec.inputs.slug)}. If you replaced the home page on purpose, set scaffold.template to none in stack.yaml.`,
        retryable: false,
        needsHuman: true,
      }),
    }
  }
  return { ok: true, evidence: `200 from ${url}` }
}

/**
 * hosting.preview on Netlify: every pushed branch besides production has a ready deploy of its
 * head commit, as a branch deploy or as the deploy preview of its pull request. Netlify builds
 * previews for pull requests by itself, so a branch with neither gets told to open one.
 */
async function verifyPreview(spec: ResourceSpec, ctx: Ctx): Promise<CheckResult> {
  const repo = str(spec.inputs.repo)
  const production = str(spec.inputs.productionBranch) || 'main'
  const branches = (await repoBranches(ctx, repo)).filter((b) => b.name !== production).slice(0, 10)
  if (branches.length === 0) return { ok: true, evidence: `no branch besides ${production} yet; the first pull request gets a preview, and this check then proves it` }
  const deploys = await listDeploys(ctx, spec, str(spec.inputs.projectId))
  const ready: string[] = []
  const missing: string[] = []
  for (const branch of branches) {
    const d = deploys.find((x) => x.commit_ref === branch.sha && (x.context === 'deploy-preview' || x.context === 'branch-deploy'))
    if (d?.state === 'ready') ready.push(`${branch.name} at ${d.deploy_ssl_url ?? d.ssl_url}`)
    else missing.push(`${branch.name} (${d ? d.state : 'no preview of its head commit yet; open a pull request for it'})`)
  }
  if (missing.length > 0) {
    return {
      ok: false,
      error: new CimientoError({
        code: 'HOSTING_PREVIEW_NOT_READY',
        provider: ID,
        resource: spec.id,
        message: `No ready preview for ${missing.join(', ')}.`,
        hint: 'Netlify builds a deploy preview for every pull request, usually within two minutes. Open a pull request for the branch, or wait and run cimiento doctor again; if the state says error, open the deploy log in Netlify.',
        retryable: true,
        needsHuman: false,
      }),
    }
  }
  return { ok: true, evidence: `preview ready for ${ready.join(', ')}` }
}

// Custom domain

async function ensureDomain(spec: ResourceSpec, ctx: Ctx): Promise<EnsureResult> {
  const siteId = str(spec.inputs.projectId)
  const domain = str(spec.inputs.domain)
  const site = await getSite(ctx, spec, siteId)
  const remove = str(spec.inputs.remove) === 'true'
  const current = site?.custom_domain ?? null
  if (!remove && current === domain) return { action: 'noop', externalId: `${siteId}/${domain}` }
  if (remove && current !== domain) return { action: 'noop', externalId: `${siteId}/${domain}` }
  if (ctx.dryRun) return { action: 'noop' }
  const patched = await netlifyCall<NetlifySite>(ctx, spec.id, 'PATCH', `/sites/${encodeURIComponent(siteId)}`, { custom_domain: remove ? null : domain })
  if (!patched.ok) {
    throw netlifyError(spec.id, patched, {
      code: 'HOSTING_DOMAIN_FAILED',
      message: `${remove ? 'Removing' : 'Adding'} ${domain} ${remove ? 'from' : 'to'} the Netlify site failed`,
      hint: 'A domain can belong to one Netlify site at a time. Check no other site uses it, then run the command again.',
    })
  }
  return { action: remove ? 'updated' : 'created', externalId: `${siteId}/${domain}`, outputs: { domain: { value: remove ? '' : domain, secret: false } } }
}

async function verifyDomain(spec: ResourceSpec, ctx: Ctx): Promise<CheckResult> {
  const site = await getSite(ctx, spec, str(spec.inputs.projectId))
  const domain = str(spec.inputs.domain)
  if (site?.custom_domain === domain) return { ok: true, evidence: `${domain} is the custom domain of the Netlify site ${site.name}` }
  return {
    ok: false,
    error: new CimientoError({
      code: 'HOSTING_DOMAIN_FAILED',
      provider: ID,
      resource: spec.id,
      message: `${domain} is not the custom domain of the Netlify site.`,
      hint: `Run cimiento domain add ${domain}.`,
      retryable: true,
      needsHuman: false,
    }),
  }
}

/** The DNS record a subdomain needs at an outside DNS provider to reach a Netlify site. */
export function netlifyDnsRecord(siteName: string, domain: string): DnsRecord {
  const name = recordName(domain)
  return name === '@' ? { type: 'A', name, value: '75.2.60.5' } : { type: 'CNAME', name, value: `${siteName}.netlify.app` }
}

export default createNetlifyProvider()

/** The commit of the newest ready production deploy. */
export async function netlifyLiveCommit(ctx: Ctx, spec: ResourceSpec, siteId: string): Promise<string | undefined> {
  const deploys = await listDeploys(ctx, spec, siteId, '&production=true')
  return deploys.find((d) => d.state === 'ready' && d.context === 'production')?.commit_ref ?? undefined
}

