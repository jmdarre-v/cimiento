// Turnstile provider. Fills the bot_protection slot with one Cloudflare Turnstile widget per
// project. wrangler owns the Cloudflare login, the Cloudflare API owns the widget, and the site key
// and secret key reach the hosting env through the hosting + turnstile wiring rule.

import { sameResource } from '../../core/state'
import { CimientoError } from '../../core/errors'
import type { ProjectState } from '../../core/state'
import {
  attendedUpHint,
  baseResources,
  ensureTool,
  ensureVendorSession,
  findTool,
  verifyTool,
} from '../../core/toolkit'
import type {
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
import { chooseAndPin, setInManifest } from '../../manifest/pin'
import type { Manifest } from '../../manifest/schema'
import {
  SITEVERIFY_URL,
  WIDGET_SCOPE,
  clearCloudflareToken,
  cloudflareCall,
  cloudflareError,
  wranglerLogError,
  wranglerWhoami,
  type Whoami,
} from './api'
import { mkdtempSync, rmSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { TURNSTILE_EXPLAIN } from './explain'
import { cloudflareAccountStep, cloudflareLoginStep } from '../../core/person-steps'

const ID = 'turnstile'

const TOOLS: ToolSpec[] = [
  {
    name: 'Cloudflare wrangler',
    bin: 'wrangler',
    versionRange: '>=4.0.0',
    install: { npm: 'wrangler' },
    versionCmd: 'wrangler --version',
  },
]

/**
 * Cloudflare's documented test keys. The site key always shows a passing widget and the secret
 * always validates, on any host. Preview and dev get these, because Turnstile has no wildcard
 * hostnames and Vercel preview hosts are not subdomains of the production host.
 */
export const TURNSTILE_TEST_SITE_KEY = '1x00000000000000000000AA'
export const TURNSTILE_TEST_SECRET_KEY = '1x0000000000000000000000000000000AA'

/** What siteverify needs to see in a response to know it is not a real token. */
const DUMMY_TOKEN = 'XXXX.DUMMY.TOKEN.XXXX'

interface Widget {
  sitekey: string
  secret?: string
  name: string
  domains: string[]
  mode: string
}

export function createTurnstileProvider(_m?: Manifest): Provider {
  const provider: Provider = {
    id: ID,
    fills: ['bot_protection'] as Slot[],
    tools: TOOLS,
    needsSession: true,

    async detect(ctx: Ctx): Promise<Detection> {
      const version = await ctx.io
        .exec('wrangler', ['--version'])
        .then((r) => (r.code === 0 ? /(\d+\.\d+\.\d+)/.exec(`${r.stdout} ${r.stderr}`)?.[1] : undefined))
        .catch(() => undefined)
      if (!version) return { installed: false }
      const who = await wranglerWhoami(ctx)
      if (!who) return { installed: true, version }
      return { installed: true, version, session: { account: who.email ?? who.accounts[0]?.name ?? 'cloudflare' } }
    },

    async login(ctx: Ctx): Promise<Session> {
      // In the foreground, with the person's terminal, and wrangler's debug log in a folder of
      // cimiento's own so a failure can be reported with wrangler's words instead of a guess.
      const logDir = mkdtempSync(join(tmpdir(), 'cimiento-wrangler-'))
      try {
        let result = { code: 1, stdout: '', stderr: '' }
        const login = async () => {
          result = await ctx.io.interactive('wrangler', ['login'], { cwd: ctx.cwd, env: { WRANGLER_LOG_PATH: logDir } })
        }
        // wrangler opens the page itself, so it starts only after the person presses Enter.
        if (ctx.walkStep) await ctx.walkStep(cloudflareLoginStep(), login)
        else await login()
        clearCloudflareToken()
        const who = await wranglerWhoami(ctx)
        if (who && hasWidgetScope(who)) return { account: who.email ?? who.accounts[0]?.name ?? 'cloudflare' }
        throw loginFailed(who, result.code, wranglerLogError(logDir) ?? result.stderr.trim())
      } finally {
        rmSync(logDir, { recursive: true, force: true })
      }
    },

    resources(manifest: Manifest, _state: ProjectState): ResourceSpec[] {
      if (manifest.slots.bot_protection !== ID) return []
      const specs = baseResources({ id: ID, tools: TOOLS, needsSession: true })
      const sitekey: Value = { deferred: 'turnstile.widget:sitekey' }
      specs.push({
        id: 'turnstile.widget',
        kind: 'resource',
        provider: ID,
        dependsOn: ['turnstile.session'],
        inputs: {
          name: manifest.slug,
          accountId: { deferred: 'turnstile.session:account' },
          mode: manifest.options.turnstile.mode,
          // The hosting + turnstile wiring rule adds the hosting's own production host.
          domains: manifest.domain ?? '',
        },
      })
      specs.push({
        id: 'turnstile.check.verify',
        kind: 'check',
        provider: ID,
        dependsOn: ['turnstile.widget'],
        inputs: { sitekey, secret: { deferred: 'turnstile.widget:secret' }, accountId: { deferred: 'turnstile.session:account' } },
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
      if (spec.id === 'turnstile.widget') return ensureWidget(spec, ctx)
      if (spec.id === 'turnstile.binding.domains') return ensureDomains(spec, ctx)
      throw unknownResource(spec)
    },

    async verify(spec: ResourceSpec, ctx: Ctx): Promise<CheckResult> {
      if (spec.kind === 'tool') {
        const tool = findTool({ tools: TOOLS }, spec)
        if (!tool) throw unknownResource(spec)
        return verifyTool(ID, tool, spec, ctx)
      }
      if (spec.kind === 'session') return verifySession(spec, ctx)
      if (spec.id === 'turnstile.widget') return verifyWidget(spec, ctx)
      if (spec.id === 'turnstile.binding.domains') return verifyDomains(spec, ctx)
      if (spec.id === 'turnstile.check.verify') return verifySecret(spec, ctx)
      throw unknownResource(spec)
    },

    async destroy(spec: ResourceSpec, ctx: Ctx): Promise<void> {
      if (spec.id !== 'turnstile.widget') return
      const widget = await findWidget(ctx, spec)
      if (!widget) return
      const result = await cloudflareCall(ctx, spec.id, 'DELETE', `${widgetsPath(ctx, spec)}/${encodeURIComponent(widget.sitekey)}`)
      if (!result.ok && result.status !== 404) {
        throw cloudflareError(spec.id, result, `Deleting the Turnstile widget ${widget.name} failed.`, 'cimiento down retries safely.')
      }
    },

    async outputs(spec: ResourceSpec, ctx: Ctx): Promise<Record<string, Output>> {
      if (spec.id === 'turnstile.session') {
        // The pinned account, or the only one the login sees, which up pins without asking. plan
        // reads this too, so the widget is planned in that account instead of waiting on a choice.
        let account = ctx.manifest.accounts.cloudflare
        if (!account) {
          const who = await wranglerWhoami(ctx)
          if (who?.accounts.length === 1) account = who.accounts[0].id
        }
        return account ? { account: { value: account, secret: false } } : {}
      }
      if (spec.id !== 'turnstile.widget') return {}
      const widget = await findWidget(ctx, spec, { withSecret: true })
      return widget ? widgetOutputs(ctx, widget) : {}
    },

    explain(key: string, lang: Lang): string {
      const entry = TURNSTILE_EXPLAIN[key]
      if (!entry) return `No explanation for ${key} yet.`
      return (lang === 'es' && entry.es) || entry.en
    },
  }
  return provider
}

export const turnstileProvider = createTurnstileProvider()

/** The real cause of a failed Cloudflare login, with the action that fixes that cause. */
function loginFailed(who: Whoami | undefined, code: number, cause: string): CimientoError {
  let hint = 'Run cimiento up again in a terminal. It opens the Cloudflare login, and nothing was left half done.'
  if (/timed out/i.test(cause)) {
    hint = 'wrangler waits two minutes for the approval. Run cimiento up again and click Allow on the Cloudflare page within two minutes of it opening.'
  } else if (/denied|access_denied/i.test(cause)) {
    hint = 'The Cloudflare page was answered with Deny. Run cimiento up again and click Allow.'
  } else if (who && !hasWidgetScope(who)) {
    hint = `This wrangler's login does not ask for ${WIDGET_SCOPE}. cimiento up upgrades wrangler; then run it again.`
  }
  return new CimientoError({
    code: 'SESSION_LOGIN_FAILED',
    provider: ID,
    resource: 'turnstile.session',
    message: who
      ? `The Cloudflare login finished without permission to manage Turnstile widgets (${WIDGET_SCOPE} is missing).`
      : `The Cloudflare login did not finish: ${cause || `wrangler login exited with code ${code} and wrote no error`}.`,
    hint,
    retryable: true,
    needsHuman: true,
  })
}

function hasWidgetScope(who: Whoami): boolean {
  // An API token from the environment reports no scopes; the API call itself is the test then.
  return !who.tokenPermissions || who.tokenPermissions.includes(WIDGET_SCOPE)
}

async function ensureSession(provider: Provider, spec: ResourceSpec, ctx: Ctx): Promise<EnsureResult> {
  let { action } = await ensureVendorSession(provider, spec, ctx, 'Cloudflare')
  let who = await wranglerWhoami(ctx)
  if (who && !hasWidgetScope(who)) {
    // Logged in for Workers, not for Turnstile. The same browser login, with one more permission.
    if (!ctx.interactive) {
      throw new CimientoError({
        code: 'SESSION_MISSING',
        provider: ID,
        resource: spec.id,
        message: 'wrangler is logged in to Cloudflare, but without permission to manage Turnstile widgets.',
        hint: attendedUpHint(ctx, 'Giving cimiento permission to manage Turnstile widgets'),
        retryable: true,
        needsHuman: true,
      })
    }
    await provider.login(ctx)
    action = 'created'
    who = await wranglerWhoami(ctx)
  }
  if (!who) {
    throw new CimientoError({
      code: 'SESSION_MISSING',
      provider: ID,
      resource: spec.id,
      message: 'Not logged in to Cloudflare.',
      hint: attendedUpHint(ctx, 'Logging in to Cloudflare'),
      retryable: true,
      needsHuman: true,
    })
  }
  const account = await pinAccount(spec, ctx, who)
  return {
    action,
    outputs: {
      account: { value: account, secret: false },
      ...(who.email ? { login: { value: who.email, secret: false } } : {}),
    },
  }
}

/** The Cloudflare account the widget lives in, pinned to accounts.cloudflare in stack.yaml. */
async function pinAccount(spec: ResourceSpec, ctx: Ctx, who: Whoami): Promise<string> {
  const pinned = ctx.manifest.accounts.cloudflare
  if (pinned) {
    if (who.accounts.length > 0 && !who.accounts.some((a) => a.id === pinned)) throw mismatch(spec, ctx, who, pinned)
    return pinned
  }
  const picked = await chooseAndPin(ctx, {
    provider: ID,
    resource: spec.id,
    what: 'Cloudflare account',
    path: ['accounts', 'cloudflare'],
    options: who.accounts.map((a) => ({ value: a.id, label: a.name })),
    step: cloudflareAccountStep(who.accounts.map((a) => a.name)),
  })
  if (picked && who.accounts.length === 1 && !ctx.dryRun) {
    ctx.logger.log({
      level: 'info',
      event: 'pinned',
      resource: spec.id,
      message: `The Cloudflare login ${who.email ?? ''} sees one account, ${who.accounts[0].name} (${picked}), so cimiento pinned it as accounts.cloudflare in stack.yaml.`.replace('  ', ' '),
    })
  }
  if (!picked) {
    throw new CimientoError({
      code: 'SESSION_ACCOUNT_MISMATCH',
      provider: ID,
      resource: spec.id,
      message: `The Cloudflare login ${who.email ?? ''} sees no account to create a Turnstile widget in.`.replace('  ', ' '),
      hint: 'Run cimiento up in a terminal and log in to Cloudflare as a member of the account this project should use.',
      retryable: true,
      needsHuman: true,
    })
  }
  return picked
}

/** cimiento accounts set turnstile: pick the Cloudflare account again, always asking. */
export async function chooseCloudflareAccount(ctx: Ctx, to?: string): Promise<string> {
  const spec: ResourceSpec = { id: 'turnstile.session', kind: 'session', provider: ID, dependsOn: [], inputs: {} }
  await ensureVendorSession(turnstileProvider, spec, ctx, 'Cloudflare')
  const who = await wranglerWhoami(ctx)
  const accounts = who?.accounts ?? []
  const options = accounts.map((a) => ({ value: a.id, label: a.name }))
  let picked: string | undefined
  if (to) {
    picked = accounts.find((a) => a.id === to || a.name.toLowerCase() === to.toLowerCase())?.id
    if (!picked) throw mismatch(spec, ctx, who ?? { loggedIn: true, accounts: [] }, to)
  } else if (options.length === 1) {
    picked = options[0].value
  } else if (ctx.interactive && ctx.choose && options.length > 1) {
    await ctx.walkStep?.(cloudflareAccountStep(options.map((o) => o.label)))
    picked = await ctx.choose('Which Cloudflare account should this project use?', options)
  }
  if (!picked) {
    throw new CimientoError({
      code: 'ACCOUNT_CHOICE_NEEDED',
      provider: ID,
      resource: spec.id,
      message: `The Cloudflare login sees ${options.length} accounts: ${options.map((o) => `${o.label} (${o.value})`).join(', ') || 'none'}.`,
      hint: `Run cimiento accounts set turnstile in a terminal in ${ctx.cwd}, or pass --to <account id>.`,
      retryable: true,
      needsHuman: true,
    })
  }
  setInManifest(ctx, ['accounts', 'cloudflare'], picked)
  return picked
}

function mismatch(spec: ResourceSpec, ctx: Ctx, who: Whoami, pinned: string): CimientoError {
  return new CimientoError({
    code: 'SESSION_ACCOUNT_MISMATCH',
    provider: ID,
    resource: spec.id,
    message: `stack.yaml pins accounts.cloudflare to ${pinned}, and the Cloudflare login ${who.email ?? ''} cannot see it. It sees ${who.accounts.map((a) => `${a.name} (${a.id})`).join(', ') || 'no account'}.`,
    hint: `Log in as a member of ${pinned}, or run cimiento accounts set turnstile in ${ctx.cwd} to pick another account.`,
    retryable: false,
    needsHuman: true,
  })
}

async function verifySession(spec: ResourceSpec, ctx: Ctx): Promise<CheckResult> {
  const who = await wranglerWhoami(ctx)
  if (!who) {
    return {
      ok: false,
      error: new CimientoError({
        code: 'SESSION_MISSING',
        provider: ID,
        resource: spec.id,
        message: 'Not logged in to Cloudflare.',
        hint: attendedUpHint(ctx, 'Logging in to Cloudflare'),
        retryable: true,
        needsHuman: true,
      }),
    }
  }
  if (!hasWidgetScope(who)) {
    return {
      ok: false,
      error: new CimientoError({
        code: 'SESSION_MISSING',
        provider: ID,
        resource: spec.id,
        message: 'wrangler is logged in to Cloudflare, but without permission to manage Turnstile widgets.',
        hint: attendedUpHint(ctx, 'Giving cimiento permission to manage Turnstile widgets'),
        retryable: true,
        needsHuman: true,
      }),
    }
  }
  const pinned = ctx.manifest.accounts.cloudflare
  if (pinned && who.accounts.length > 0 && !who.accounts.some((a) => a.id === pinned)) {
    return { ok: false, error: mismatch(spec, ctx, who, pinned) }
  }
  const account = who.accounts.find((a) => a.id === pinned)
  return {
    ok: true,
    evidence: `cloudflare session as ${who.email ?? 'an API token'}${account ? `, account ${account.name} (${account.id})` : ''}`,
  }
}

function accountId(ctx: Ctx, spec: ResourceSpec): string {
  const account =
    ctx.manifest.accounts.cloudflare ?? (str(spec.inputs.accountId) || undefined) ?? ctx.state.resources['turnstile.session']?.outputs?.account
  if (account) return account
  throw new CimientoError({
    code: 'ACCOUNT_CHOICE_NEEDED',
    provider: ID,
    resource: spec.id,
    message: 'stack.yaml does not pin a Cloudflare account yet.',
    hint: `Run cimiento up in a terminal in ${ctx.cwd}. It asks which Cloudflare account to use and writes it to accounts.cloudflare.`,
    retryable: true,
    needsHuman: true,
  })
}

function widgetsPath(ctx: Ctx, spec: ResourceSpec): string {
  return `/accounts/${encodeURIComponent(accountId(ctx, spec))}/challenges/widgets`
}

function str(value: Value | undefined): string {
  return typeof value === 'string' ? value : ''
}

/** The widget this project owns: the sitekey state recorded, or else the one named after the slug. */
async function findWidget(ctx: Ctx, spec: ResourceSpec, opts: { withSecret?: boolean } = {}): Promise<Widget | undefined> {
  const path = widgetsPath(ctx, spec)
  const known = ctx.state.resources['turnstile.widget']?.externalId
  let sitekey = known
  if (!sitekey) {
    const list = await cloudflareCall<Widget[]>(ctx, spec.id, 'GET', `${path}?per_page=100`)
    if (!list.ok) throw cloudflareError(spec.id, list, 'Listing Turnstile widgets failed.', 'Run cimiento doctor --json to see whether the Cloudflare session is healthy.')
    const name = str(spec.inputs.name) || ctx.manifest.slug
    const match = (list.result ?? []).find((w) => w.name === name)
    if (!match) return undefined
    if (!opts.withSecret) return match
    sitekey = match.sitekey
  }
  const one = await cloudflareCall<Widget>(ctx, spec.id, 'GET', `${path}/${encodeURIComponent(sitekey)}`)
  if (one.status === 404) return undefined
  if (!one.ok) throw cloudflareError(spec.id, one, 'Reading the Turnstile widget failed.', 'Run cimiento doctor --json to see whether the Cloudflare session is healthy.')
  return one.result
}

function widgetOutputs(ctx: Ctx, widget: Widget): Record<string, Output> {
  const outputs: Record<string, Output> = { sitekey: { value: widget.sitekey, secret: false } }
  if (widget.secret) {
    ctx.redactor.addValue(widget.secret)
    outputs.secret = { value: widget.secret, secret: true }
  }
  return outputs
}

function dashboardUrl(ctx: Ctx, spec: ResourceSpec, sitekey: string): string {
  return `https://dash.cloudflare.com/${accountId(ctx, spec)}/turnstile/widget/${sitekey}`
}

async function ensureWidget(spec: ResourceSpec, ctx: Ctx): Promise<EnsureResult> {
  const known = ctx.state.resources[spec.id]
  const existing = await findWidget(ctx, spec, { withSecret: true })
  if (existing) {
    return {
      action: sameResource(known?.externalId, existing.sitekey) ? 'noop' : 'adopted',
      externalId: existing.sitekey,
      url: dashboardUrl(ctx, spec, existing.sitekey),
      outputs: widgetOutputs(ctx, existing),
    }
  }
  if (ctx.dryRun) return { action: 'noop' }
  const created = await cloudflareCall<Widget>(ctx, spec.id, 'POST', widgetsPath(ctx, spec), {
    name: str(spec.inputs.name),
    mode: str(spec.inputs.mode) || 'managed',
    domains: str(spec.inputs.domains).split(',').filter(Boolean),
  })
  if (!created.ok || !created.result) {
    throw cloudflareError(spec.id, created, `Creating the Turnstile widget ${str(spec.inputs.name)} failed.`, 'cimiento up retries safely; it finds the widget by name and never creates a second one.')
  }
  return {
    action: 'created',
    externalId: created.result.sitekey,
    url: dashboardUrl(ctx, spec, created.result.sitekey),
    outputs: widgetOutputs(ctx, created.result),
  }
}

async function verifyWidget(spec: ResourceSpec, ctx: Ctx): Promise<CheckResult> {
  const widget = await findWidget(ctx, spec)
  if (!widget) {
    return {
      ok: false,
      error: new CimientoError({
        code: 'TURNSTILE_WIDGET_NOT_FOUND',
        provider: ID,
        resource: spec.id,
        message: `No Turnstile widget named ${str(spec.inputs.name)} in the Cloudflare account.`,
        hint: 'Run cimiento up. It creates the widget and puts its keys in the hosting env.',
        retryable: true,
        needsHuman: false,
      }),
    }
  }
  return { ok: true, evidence: `turnstile widget ${widget.name} (${widget.sitekey}), ${widget.mode}, domains ${widget.domains.join(', ')}` }
}

function wantedDomains(spec: ResourceSpec): string[] {
  const hosts = new Set<string>()
  for (const raw of [str(spec.inputs.productionUrl), str(spec.inputs.domain)]) {
    if (!raw) continue
    try {
      hosts.add(new URL(raw.startsWith('http') ? raw : `https://${raw}`).hostname)
    } catch {
      // Not a URL; nothing to add.
    }
  }
  return [...hosts].sort()
}

/** Widget domains follow the production host, which is only known after the first deployment. */
async function ensureDomains(spec: ResourceSpec, ctx: Ctx): Promise<EnsureResult> {
  const widget = await findWidget(ctx, { ...spec, inputs: { ...spec.inputs, name: ctx.manifest.slug } })
  if (!widget) throw (await verifyWidget({ ...spec, inputs: { name: ctx.manifest.slug } }, ctx)).error!
  const wanted = wantedDomains(spec)
  const current = [...widget.domains].sort()
  if (wanted.every((d) => current.includes(d))) {
    return { action: 'noop', externalId: widget.sitekey, outputs: { domains: { value: current.join(','), secret: false } } }
  }
  if (ctx.dryRun) return { action: 'noop' }
  const domains = [...new Set([...current, ...wanted])].sort()
  const updated = await cloudflareCall<Widget>(ctx, spec.id, 'PUT', `${widgetsPath(ctx, spec)}/${encodeURIComponent(widget.sitekey)}`, {
    name: widget.name,
    mode: widget.mode,
    domains,
  })
  if (!updated.ok) {
    throw cloudflareError(spec.id, updated, 'Updating the Turnstile widget domains failed.', 'cimiento up retries safely.')
  }
  return { action: 'updated', externalId: widget.sitekey, outputs: { domains: { value: domains.join(','), secret: false } } }
}

async function verifyDomains(spec: ResourceSpec, ctx: Ctx): Promise<CheckResult> {
  const widget = await findWidget(ctx, { ...spec, inputs: { ...spec.inputs, name: ctx.manifest.slug } })
  const wanted = wantedDomains(spec)
  const missing = wanted.filter((d) => !widget?.domains.includes(d))
  if (!widget || missing.length > 0) {
    return {
      ok: false,
      error: new CimientoError({
        code: 'TURNSTILE_API_ERROR',
        provider: ID,
        resource: spec.id,
        message: `The Turnstile widget does not allow ${missing.join(', ') || 'the production host'}, so the widget would refuse to load on the live site.`,
        hint: 'Run cimiento up. It adds the production host to the widget.',
        retryable: true,
        needsHuman: false,
      }),
    }
  }
  return { ok: true, evidence: `turnstile widget allows ${wanted.join(', ')}` }
}

/**
 * bot_protection.verify from spec section 12. siteverify answers invalid-input-secret for a secret
 * it does not know and invalid-input-response for a token that is not real, so a dummy token
 * answered with invalid-input-response proves the secret key is the widget's own and is live.
 */
async function verifySecret(spec: ResourceSpec, ctx: Ctx): Promise<CheckResult> {
  const secret = str(spec.inputs.secret)
  if (!secret) {
    return {
      ok: false,
      error: new CimientoError({
        code: 'TURNSTILE_SECRET_REJECTED',
        provider: ID,
        resource: spec.id,
        message: 'cimiento could not read the secret key of the Turnstile widget.',
        hint: 'Run cimiento up so the widget exists, then cimiento doctor.',
        retryable: true,
        needsHuman: false,
      }),
    }
  }
  ctx.redactor.addValue(secret)
  const res = await ctx.io.http({ method: 'POST', url: SITEVERIFY_URL, body: { secret, response: DUMMY_TOKEN } })
  const body = res.json as { success?: boolean; 'error-codes'?: string[] } | undefined
  const codes = body?.['error-codes'] ?? []
  if (codes.includes('invalid-input-response') && !codes.includes('invalid-input-secret')) {
    return { ok: true, evidence: `siteverify accepted the secret key of widget ${str(spec.inputs.sitekey)} and rejected a dummy token (invalid-input-response)` }
  }
  return {
    ok: false,
    error: new CimientoError({
      code: 'TURNSTILE_SECRET_REJECTED',
      provider: ID,
      resource: spec.id,
      message: `siteverify did not accept the secret key of widget ${str(spec.inputs.sitekey)}: ${codes.join(', ') || `status ${res.status}`}.`,
      hint: 'The widget may have been deleted or its secret rotated in the Cloudflare dashboard. Run cimiento up; it finds the widget again and rewrites the keys.',
      retryable: true,
      needsHuman: false,
    }),
  }
}

function unknownResource(spec: ResourceSpec): CimientoError {
  return new CimientoError({
    code: 'PLAN_UNKNOWN_DEPENDENCY',
    provider: ID,
    resource: spec.id,
    message: `The turnstile provider has no resource named ${spec.id}.`,
    hint: 'This is a bug in cimiento. Run cimiento plan --json and open an issue with the output.',
    retryable: false,
    needsHuman: false,
  })
}

export default turnstileProvider
