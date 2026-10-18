// Shared behavior every provider needs for its tool and session resources, so the three modules
// stay small and behave identically.

import { CimientoError } from './errors'
import type { PersonStep } from './person'
import type { CheckResult, Ctx, Detection, EnsureResult, Provider, ResourceSpec, ToolSpec } from './types'
import { cached, DETECT_TTL_MS, invalidate, UPDATE_TTL_MS } from './detect-cache'
import { compareVersions, parseVersion, satisfies } from './version'

export function toolResourceId(providerId: string, bin: string): string {
  return `${providerId}.tool.${bin}`
}

export function sessionResourceId(providerId: string): string {
  return `${providerId}.session`
}

/** The tool and session specs for a provider, in the shape the planner expects. */
export function baseResources(provider: Pick<Provider, 'id' | 'tools' | 'needsSession'>): ResourceSpec[] {
  const specs: ResourceSpec[] = provider.tools.map((tool) => ({
    id: toolResourceId(provider.id, tool.bin),
    kind: 'tool' as const,
    provider: provider.id,
    dependsOn: [],
    inputs: { bin: tool.bin, versionRange: tool.versionRange },
  }))
  if (provider.needsSession) {
    specs.push({
      id: sessionResourceId(provider.id),
      kind: 'session',
      provider: provider.id,
      dependsOn: specs.map((s) => s.id),
      inputs: {},
    })
  }
  return specs
}

export function findTool(provider: Pick<Provider, 'tools'>, spec: ResourceSpec): ToolSpec | undefined {
  const bin = typeof spec.inputs.bin === 'string' ? spec.inputs.bin : undefined
  return provider.tools.find((t) => t.bin === bin)
}

export async function toolVersion(ctx: Ctx, tool: ToolSpec): Promise<string | undefined> {
  return (await toolVersionOutput(ctx, tool))?.version
}

/** Asked once per run and kept per machine for a short time; a missing tool is never kept (BUG-93). */
export function toolVersionOutput(ctx: Ctx, tool: ToolSpec): Promise<{ version: string; raw: string } | undefined> {
  return cached(`tool:${tool.versionCmd}`, DETECT_TTL_MS, () => readToolVersion(ctx, tool), (v) => v !== undefined)
}

async function readToolVersion(ctx: Ctx, tool: ToolSpec): Promise<{ version: string; raw: string } | undefined> {
  const [cmd, ...args] = tool.versionCmd.split(' ')
  try {
    const result = await ctx.io.exec(cmd, args)
    if (result.code !== 0) return undefined
    const raw = `${result.stdout}\n${result.stderr}`
    const parsed = parseVersion(raw)
    return parsed ? { version: `${parsed.major}.${parsed.minor}.${parsed.patch}`, raw } : undefined
  } catch {
    return undefined
  }
}

export interface ToolUpdate {
  latest: string
  /** The command that upgrades it, when cimiento knows which package manager owns the binary. */
  upgrade?: { cmd: string; args: string[] }
}

/** Drops cached lookups. Tests use it; a real run looks each tool up once per hour. */
export function clearToolUpdateCache(): void {
  invalidate('update:')
  invalidate('tool:')
}

/**
 * Whether a newer version of an installed tool exists. The tool's own update notice counts first
 * (the Supabase CLI prints one with every command), then Homebrew's metadata when the binary is
 * Homebrew's, then npm for npm packages. A binary installed some other way, such as Apple's git,
 * is reported but never offered an upgrade cimiento cannot perform.
 */
export async function toolUpdate(ctx: Ctx, tool: ToolSpec, installed: string, raw = ''): Promise<ToolUpdate | undefined> {
  return (await cached(`update:${tool.bin}@${installed}`, UPDATE_TTL_MS, async () => (await lookUpUpdate(ctx, tool, installed, raw)) ?? null)) ?? undefined
}

async function lookUpUpdate(ctx: Ctx, tool: ToolSpec, installed: string, raw: string): Promise<ToolUpdate | undefined> {
  const candidates: string[] = []
  const notice = raw.split('\n').find((line) => /new (version|release)/i.test(line))
  if (notice) candidates.push(...(notice.match(/\d+\.\d+\.\d+/g) ?? []))

  let upgrade: ToolUpdate['upgrade']
  if (tool.install.brew && (await isHomebrewBinary(ctx, tool.bin))) {
    upgrade = { cmd: 'brew', args: ['upgrade', tool.install.brew] }
    const info = await ctx.io
      .exec('brew', ['info', '--json=v2', tool.install.brew], { env: { HOMEBREW_NO_AUTO_UPDATE: '1' } })
      .catch(() => undefined)
    try {
      const stable = info && info.code === 0 ? JSON.parse(info.stdout)?.formulae?.[0]?.versions?.stable : undefined
      if (typeof stable === 'string') candidates.push(stable)
    } catch {
      // Unreadable brew output means no candidate from brew, not an error.
    }
  } else if (tool.install.npm) {
    upgrade = { cmd: 'npm', args: ['install', '-g', `${tool.install.npm}@latest`] }
    const view = await ctx.io.exec('npm', ['view', tool.install.npm, 'version']).catch(() => undefined)
    if (view && view.code === 0 && parseVersion(view.stdout)) candidates.push(view.stdout.trim())
  }

  const current = parseVersion(installed)
  let best: string | undefined
  for (const candidate of candidates) {
    const parsed = parseVersion(candidate)
    if (!parsed || !current || compareVersions(parsed, current) <= 0) continue
    if (!best || compareVersions(parsed, parseVersion(best)!) > 0) best = `${parsed.major}.${parsed.minor}.${parsed.patch}`
  }
  return best ? { latest: best, ...(upgrade ? { upgrade } : {}) } : undefined
}

async function isHomebrewBinary(ctx: Ctx, bin: string): Promise<boolean> {
  const where = await ctx.io.exec('which', [bin]).catch(() => undefined)
  const path = where && where.code === 0 ? where.stdout.trim() : ''
  return /^(\/opt\/homebrew|\/usr\/local\/(Cellar|Homebrew|bin)|\/home\/linuxbrew)\//.test(path)
}

function updateNote(tool: ToolSpec, update: ToolUpdate | undefined): string {
  if (!update) return ''
  return update.upgrade
    ? `, ${update.latest} available: cimiento up offers ${update.upgrade.cmd} ${update.upgrade.args.join(' ')}`
    : `, ${update.latest} available, installed outside Homebrew and npm, so upgrade it the way you installed it`
}

export async function detectTool(ctx: Ctx, tool: ToolSpec): Promise<Detection> {
  const version = await toolVersion(ctx, tool)
  return version ? { installed: true, version } : { installed: false }
}

export async function verifyTool(providerId: string, tool: ToolSpec, spec: ResourceSpec, ctx: Ctx): Promise<CheckResult> {
  const out = await toolVersionOutput(ctx, tool)
  const version = out?.version
  if (!version) {
    return {
      ok: false,
      error: new CimientoError({
        code: 'TOOL_MISSING',
        provider: providerId,
        resource: spec.id,
        message: `${tool.name} is not installed, or ${tool.bin} is not on PATH.`,
        hint: installHint(tool),
        retryable: true,
        needsHuman: false,
      }),
    }
  }
  if (!satisfies(version, tool.versionRange)) {
    return {
      ok: false,
      error: new CimientoError({
        code: 'TOOL_VERSION_TOO_OLD',
        provider: providerId,
        resource: spec.id,
        message: `${tool.name} is ${version}, cimiento needs ${tool.versionRange}.`,
        hint: upgradeHint(tool),
        retryable: true,
        needsHuman: false,
      }),
    }
  }
  // A newer version is news, never a failure: the tool works, so the check passes.
  const update = await toolUpdate(ctx, tool, version, out?.raw)
  return { ok: true, evidence: `${tool.bin} ${version}${updateNote(tool, update)}` }
}

export async function ensureTool(providerId: string, tool: ToolSpec, spec: ResourceSpec, ctx: Ctx): Promise<EnsureResult> {
  const out = await toolVersionOutput(ctx, tool)
  const before = out?.version
  if (before && satisfies(before, tool.versionRange)) {
    return offerUpgrade(tool, spec, ctx, before, out?.raw)
  }
  if (ctx.dryRun) {
    return { action: 'noop', outputs: {} }
  }
  // An old version needs an upgrade, not an install: brew install is a no op on a present formula.
  const install = before ? upgradeCommand(tool) : installCommand(tool)
  if (!install) {
    throw new CimientoError({
      code: 'TOOL_INSTALL_FAILED',
      provider: providerId,
      resource: spec.id,
      message: `${tool.name} is missing and cimiento has no install recipe for it.`,
      hint: installHint(tool),
      retryable: false,
      needsHuman: true,
    })
  }
  const result = await ctx.io.exec(install.cmd, install.args)
  invalidate(`tool:${tool.versionCmd}`)
  if (result.code !== 0) {
    throw new CimientoError({
      code: 'TOOL_INSTALL_FAILED',
      provider: providerId,
      resource: spec.id,
      message: `Installing ${tool.name} failed: ${(result.stderr || result.stdout).trim().slice(0, 400)}`,
      hint: installHint(tool),
      retryable: true,
      needsHuman: true,
    })
  }
  const after = await toolVersion(ctx, tool)
  if (!after || !satisfies(after, tool.versionRange)) {
    throw new CimientoError({
      code: 'TOOL_VERSION_TOO_OLD',
      provider: providerId,
      resource: spec.id,
      message: `${tool.name} installed but reports ${after ?? 'no version'}, cimiento needs ${tool.versionRange}.`,
      hint: upgradeHint(tool),
      retryable: true,
      needsHuman: true,
    })
  }
  return {
    action: before ? 'updated' : 'created',
    outputs: { version: { value: after, secret: false } },
  }
}

export function installCommand(tool: ToolSpec): { cmd: string; args: string[] } | undefined {
  if (tool.install.brew) return { cmd: 'brew', args: ['install', tool.install.brew] }
  if (tool.install.npm) return { cmd: 'npm', args: ['install', '-g', tool.install.npm] }
  if (tool.install.script) return { cmd: 'bash', args: ['-lc', tool.install.script] }
  return undefined
}

export function upgradeCommand(tool: ToolSpec): { cmd: string; args: string[] } | undefined {
  if (tool.install.brew) return { cmd: 'brew', args: ['upgrade', tool.install.brew] }
  if (tool.install.npm) return { cmd: 'npm', args: ['install', '-g', `${tool.install.npm}@latest`] }
  return installCommand(tool)
}

export function installHint(tool: ToolSpec): string {
  const command = installCommand(tool)
  if (!command) return `${tool.name} has no install recipe in cimiento yet. Install it once, then cimiento up continues.`
  return `cimiento up installs ${tool.name} for you with ${command.cmd}. If that install fails, the installer message above says why.`
}

export function upgradeHint(tool: ToolSpec): string {
  const command = upgradeCommand(tool)
  if (!command) return `${tool.name} needs ${tool.versionRange}, and cimiento has no upgrade recipe for it yet.`
  return `cimiento up upgrades ${tool.name} for you with ${command.cmd}. If that fails, the installer message above says why.`
}

/** Shared session check: logged in at all, and logged in as the account the manifest pins. */
export function sessionCheck(
  providerId: string,
  spec: ResourceSpec,
  detection: Detection,
  expectedAccount: string | undefined,
  loginHint: string,
): CheckResult {
  if (!detection.session) {
    return {
      ok: false,
      error: new CimientoError({
        code: 'SESSION_MISSING',
        provider: providerId,
        resource: spec.id,
        message: `Not logged in to ${providerId}.`,
        hint: loginHint,
        retryable: true,
        needsHuman: false,
      }),
    }
  }
  if (expectedAccount && !accountMatches(detection.session.account, expectedAccount)) {
    // A cached identity may be the stale one; the next run asks the vendor again.
    invalidate(`session:${providerId}:`)
    return {
      ok: false,
      error: new CimientoError({
        code: 'SESSION_ACCOUNT_MISMATCH',
        provider: providerId,
        resource: spec.id,
        message: `Logged in to ${providerId} as ${detection.session.account}, but stack.yaml pins accounts.${providerId} to ${expectedAccount}.`,
        hint: `Either log in as ${expectedAccount}, or change accounts.${providerId} in stack.yaml. cimiento will not deploy to the wrong account silently.`,
        retryable: false,
        needsHuman: true,
      }),
    }
  }
  const expiry = detection.session.expiresAt
  return {
    ok: true,
    evidence: `${providerId} session as ${detection.session.account}${expiry ? ` until ${expiry}` : ''}`,
  }
}

export function accountMatches(actual: string, expected: string): boolean {
  return actual.trim().toLowerCase() === expected.trim().toLowerCase()
}

/** The line shown to a person, or to the agent driving cimiento, when a login has to happen. */
export function attendedUpHint(ctx: Ctx, what: string, command = 'cimiento up'): string {
  return `${what} needs you at a browser once. Run ${command} in a terminal in ${ctx.cwd}; it opens the page for you and waits while you approve it.`
}

/**
 * The one way every provider gets a session. An existing login is reused. With a person at the
 * terminal, the vendor's own browser or device login runs in the foreground so its code and link
 * are visible and it can wait as long as the approval takes. Without one, cimiento does not start
 * a login nobody can see: it stops with SESSION_MISSING, which the executor reports as a step
 * waiting on a person, exit code 2.
 */
export async function ensureVendorSession(
  provider: Pick<Provider, 'id' | 'detect' | 'login'>,
  spec: ResourceSpec,
  ctx: Ctx,
  vendor: string,
  signup?: PersonStep,
): Promise<{ account: string; action: 'noop' | 'created' }> {
  const detection = await provider.detect(ctx)
  if (detection.session) return { account: detection.session.account, action: 'noop' }
  if (!ctx.interactive) {
    throw new CimientoError({
      code: 'SESSION_MISSING',
      provider: provider.id,
      resource: spec.id,
      message: `Not logged in to ${vendor}, and this run has no terminal to open the login in.`,
      hint: attendedUpHint(ctx, `Logging in to ${vendor}`),
      retryable: true,
      needsHuman: true,
    })
  }
  // Someone who has never used the vendor needs an account before any login can work.
  if (signup && ctx.walkStep && ctx.choose) {
    const es = ctx.lang === 'es'
    const has = await ctx.choose(es ? `Tienes una cuenta de ${vendor}?` : `Do you have a ${vendor} account?`, [
      { value: 'yes', label: es ? 'Si, inicio sesion con ella' : 'Yes, log in with it' },
      { value: 'no', label: es ? 'No, crearla ahora; es gratis' : 'No, create one now; it is free' },
    ])
    if (has === 'no') await ctx.walkStep(signup)
  }
  ctx.logger.log({
    level: 'info',
    event: 'login',
    provider: provider.id,
    resource: spec.id,
    message: `Opening the ${vendor} login. Approve it in your browser, cimiento waits for you.`,
  })
  const session = await provider.login(ctx)
  return { account: session.account, action: 'created' }
}

/** Runs a vendor login in the foreground and turns a non zero exit into a CimientoError. */
export async function runVendorLogin(
  ctx: Ctx,
  providerId: string,
  vendor: string,
  cmd: string,
  args: string[],
  step?: PersonStep,
): Promise<void> {
  let result = { code: 1, stdout: '', stderr: '' }
  const login = async () => {
    result = await ctx.io.interactive(cmd, args, { cwd: ctx.cwd })
  }
  // The vendor CLI opens the page itself, so it starts only after the person presses Enter.
  if (step && ctx.walkStep) await ctx.walkStep(step, login)
  else await login()
  if (result.code === 0) return
  throw new CimientoError({
    code: 'SESSION_LOGIN_FAILED',
    provider: providerId,
    resource: `${providerId}.session`,
    message: `The ${vendor} login did not finish${result.stderr ? `: ${result.stderr.trim().slice(0, 200)}` : '.'}`,
    hint: `Run cimiento up again. It reopens the ${vendor} login, and nothing was left half done.`,
    retryable: true,
    needsHuman: true,
  })
}

/**
 * A working tool with a newer version available. up asks about every outdated tool once, before
 * the plan (offerToolUpgrades), so ensure never asks during apply: it records the newer version and
 * continues with the installed one (BUG-43).
 */
async function offerUpgrade(tool: ToolSpec, _spec: ResourceSpec, ctx: Ctx, installed: string, raw?: string): Promise<EnsureResult> {
  const keep: EnsureResult = { action: 'noop', outputs: { version: { value: installed, secret: false } } }
  const update = await toolUpdate(ctx, tool, installed, raw)
  if (update) keep.outputs!.latest = { value: update.latest, secret: false }
  return keep
}

export interface OutdatedTool {
  provider: string
  name: string
  bin: string
  installed: string
  latest: string
  upgrade?: { cmd: string; args: string[] }
  /** The person skipped this exact version before. */
  skipped: boolean
}

/** Every installed tool with a newer version, for the one question before the plan and for doctor. */
export async function outdatedTools(ctx: Ctx, providers: Pick<Provider, 'id' | 'tools'>[]): Promise<OutdatedTool[]> {
  const out: OutdatedTool[] = []
  const seen = new Set<string>()
  for (const provider of providers) {
    for (const tool of provider.tools) {
      if (seen.has(tool.bin)) continue
      seen.add(tool.bin)
      const version = await toolVersionOutput(ctx, tool)
      if (!version) continue
      const update = await toolUpdate(ctx, tool, version.version, version.raw)
      if (!update) continue
      out.push({
        provider: provider.id,
        name: tool.name,
        bin: tool.bin,
        installed: version.version,
        latest: update.latest,
        ...(update.upgrade ? { upgrade: update.upgrade } : {}),
        skipped: ctx.machine.toolSkips?.[tool.bin] === update.latest,
      })
    }
  }
  return out
}

/** Runs the upgrades the person approved, in the foreground, and drops the cached lookups. */
export async function upgradeTools(ctx: Ctx, tools: OutdatedTool[]): Promise<{ upgraded: string[]; failed: string[] }> {
  const upgraded: string[] = []
  const failed: string[] = []
  for (const tool of tools) {
    if (!tool.upgrade) continue
    const result = await ctx.io.interactive(tool.upgrade.cmd, tool.upgrade.args).catch(() => ({ code: 1, stdout: '', stderr: '' }))
    if (result.code === 0) upgraded.push(tool.bin)
    else failed.push(tool.bin)
    invalidate(`update:${tool.bin}@`)
    invalidate('tool:')
  }
  return { upgraded, failed }
}

/**
 * Asks every tool for its version and newer release, and every vendor CLI who it is logged in as,
 * all at once, before the plan reads them one by one (BUG-93). Each answer lands in the run cache,
 * so the plan, the apply and the checks reuse it. A failure here is only a cache miss.
 */
export async function warmDetection(ctx: Ctx, providers: Pick<Provider, 'id' | 'tools' | 'needsSession' | 'detect'>[]): Promise<void> {
  const tools = providers.flatMap((p) => p.tools)
  await Promise.all([
    ...tools.map(async (tool) => {
      const out = await toolVersionOutput(ctx, tool)
      if (out) await toolUpdate(ctx, tool, out.version, out.raw)
    }),
    ...providers.filter((p) => p.needsSession).map((p) => p.detect(ctx)),
  ].map((p) => p.catch(() => undefined)))
}
