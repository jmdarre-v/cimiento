// GitHub provider. Fills the repo slot. Everything goes through the gh CLI, which owns token
// storage and gives structured output with --json.

import { ciSinkSpecs, ensureCiSecret, verifyCiSecret } from '../../secrets/sinks'
import { sameResource } from '../../core/state'
import { githubLoginStep, githubSignupStep } from '../../core/person-steps'
import { existsSync } from 'node:fs'
import { join } from 'node:path'
import { CimientoError } from '../../core/errors'
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
import {
  attendedUpHint,
  baseResources,
  ensureTool,
  ensureVendorSession,
  findTool,
  runVendorLogin,
  sessionCheck,
  verifyTool,
} from '../../core/toolkit'
import { pinInManifest } from '../../manifest/pin'
import type { Manifest } from '../../manifest/schema'
import type { ProjectState } from '../../core/state'
import { GITHUB_EXPLAIN } from './explain'

const ID = 'github'

const TOOLS: ToolSpec[] = [
  {
    name: 'git',
    bin: 'git',
    versionRange: '>=2.30.0',
    install: { brew: 'git' },
    versionCmd: 'git --version',
  },
  {
    name: 'GitHub CLI',
    bin: 'gh',
    versionRange: '>=2.40.0',
    install: { brew: 'gh' },
    versionCmd: 'gh --version',
  },
]

const LOGIN_HINT = 'cimiento up opens the GitHub login in your browser and waits while you approve it.'

interface RepoView {
  name: string
  nameWithOwner: string
  url: string
  id: string
  visibility: string
  defaultBranchRef?: { name: string } | null
}

/** owner is a literal when stack.yaml pins accounts.github, otherwise it follows the session. */
function ownerValue(m: Manifest): Value {
  return m.accounts.github ? m.accounts.github : { deferred: 'github.session:account' }
}

export const githubProvider: Provider = {
  id: ID,
  fills: ['repo'] as Slot[],
  tools: TOOLS,
  needsSession: true,

  async detect(ctx: Ctx): Promise<Detection> {
    const version = await ctx.io
      .exec('gh', ['--version'])
      .then((r) => (r.code === 0 ? /(\d+\.\d+\.\d+)/.exec(r.stdout)?.[1] : undefined))
      .catch(() => undefined)
    if (!version) return { installed: false }
    const login = await ctx.io.exec('gh', ['api', 'user', '--jq', '.login']).catch(() => undefined)
    if (!login || login.code !== 0) return { installed: true, version }
    const account = login.stdout.trim()
    if (!account) return { installed: true, version }
    return { installed: true, version, session: { account } }
  },

  async login(ctx: Ctx): Promise<Session> {
    await runVendorLogin(ctx, ID, 'GitHub', 'gh', [
      'auth',
      'login',
      '--hostname',
      'github.com',
      '--git-protocol',
      'https',
      '--web',
    ], githubLoginStep())
    const detection = await githubProvider.detect(ctx)
    if (!detection.session) {
      throw new CimientoError({
        code: 'SESSION_LOGIN_FAILED',
        provider: ID,
        resource: 'github.session',
        message: 'The GitHub login finished but gh still reports no account.',
        hint: 'Run cimiento up again. It reopens the GitHub login, and nothing was left half done.',
        retryable: true,
        needsHuman: true,
      })
    }
    return detection.session
  },

  resources(m: Manifest, _state: ProjectState): ResourceSpec[] {
    if (m.slots.repo !== ID) return []
    const specs = baseResources({ id: ID, tools: TOOLS, needsSession: true })
    const owner = ownerValue(m)
    specs.push({
      id: 'github.repo',
      kind: 'resource',
      provider: ID,
      dependsOn: ['github.session', 'github.tool.git'],
      inputs: {
        owner,
        name: m.slug,
        visibility: m.options.github.visibility,
        description: m.options.github.description || `${m.name}, managed by cimiento.`,
        defaultBranch: m.options.github.defaultBranch,
      },
    })
    specs.push({
      id: 'github.check.repo',
      kind: 'check',
      provider: ID,
      dependsOn: ['github.repo'],
      inputs: { owner, name: m.slug, defaultBranch: m.options.github.defaultBranch },
    })
    specs.push(...ciSinkSpecs(m))
    return specs
  },

  async ensure(spec: ResourceSpec, ctx: Ctx): Promise<EnsureResult> {
    if (spec.kind === 'tool') {
      const tool = findTool({ tools: TOOLS }, spec)
      if (!tool) throw unknownResource(spec)
      return ensureTool(ID, tool, spec, ctx)
    }
    if (spec.kind === 'session') return ensureSession(spec, ctx)
    if (spec.id === 'github.repo') return ensureRepo(spec, ctx)
    if (spec.id.startsWith('github.secret.')) return ensureCiSecret(spec, ctx)
    if (spec.kind === 'check') return { action: 'noop' }
    throw unknownResource(spec)
  },

  async verify(spec: ResourceSpec, ctx: Ctx): Promise<CheckResult> {
    if (spec.kind === 'tool') {
      const tool = findTool({ tools: TOOLS }, spec)
      if (!tool) throw unknownResource(spec)
      return verifyTool(ID, tool, spec, ctx)
    }
    if (spec.kind === 'session') {
      const detection = await githubProvider.detect(ctx)
      if (!detection.installed) {
        return {
          ok: false,
          error: new CimientoError({
            code: 'TOOL_MISSING',
            provider: ID,
            resource: spec.id,
            message: 'gh is not installed yet, so cimiento cannot read the GitHub session.',
            hint: 'cimiento up installs gh for you before it needs the session.',
            retryable: true,
            needsHuman: false,
          }),
        }
      }
      return sessionCheck(ID, spec, detection, ctx.manifest.accounts.github, LOGIN_HINT)
    }
    if (spec.id.startsWith('github.secret.')) return verifyCiSecret(spec, ctx)
    if (spec.id === 'github.repo' || spec.id === 'github.check.repo') {
      const full = fullName(spec)
      const view = await viewRepo(ctx, full)
      if (!view) {
        return {
          ok: false,
          error: new CimientoError({
            code: 'GITHUB_REPO_NOT_FOUND',
            provider: ID,
            resource: spec.id,
            message: `No repository ${full} visible to this GitHub account.`,
            hint: `cimiento up creates ${full}. If it should already exist, it belongs to an account other than the one gh is logged in as.`,
            retryable: true,
            needsHuman: false,
          }),
        }
      }
      if (spec.id === 'github.check.repo' && !view.defaultBranchRef?.name) {
        return {
          ok: false,
          error: new CimientoError({
            code: 'GITHUB_REPO_NOT_FOUND',
            provider: ID,
            resource: spec.id,
            message: `${full} exists but has no default branch, so nothing has been pushed yet.`,
            hint: 'Make a first commit and push it, or run cimiento up which does that for a new project.',
            retryable: true,
            needsHuman: false,
          }),
        }
      }
      return {
        ok: true,
        evidence: `${view.nameWithOwner} ${view.url}${view.defaultBranchRef?.name ? ` on ${view.defaultBranchRef.name}` : ''}`,
      }
    }
    throw unknownResource(spec)
  },

  async destroy(spec: ResourceSpec, ctx: Ctx): Promise<void> {
    if (spec.id !== 'github.repo') return
    const full = fullName(spec)
    if (!(await viewRepo(ctx, full))) return
    let result = await ctx.io.exec('gh', ['repo', 'delete', full, '--yes'])
    if (result.code !== 0 && needsDeleteScope(result)) {
      // gh never asks for delete_repo at login. Granting it is a browser step, so cimiento runs
      // the refresh in the foreground when a person is there, and waits on them otherwise.
      if (!ctx.interactive) {
        throw new CimientoError({
          code: 'GITHUB_SCOPE_MISSING',
          provider: ID,
          resource: spec.id,
          message: `Deleting ${full} needs the delete_repo permission, which the GitHub login does not have yet.`,
          hint: attendedUpHint(ctx, 'Granting GitHub the delete_repo permission', 'cimiento down'),
          retryable: true,
          needsHuman: true,
        })
      }
      ctx.logger.log({
        level: 'info',
        event: 'login',
        provider: ID,
        resource: spec.id,
        message: 'GitHub needs one more permission to delete the repository. Approve it in your browser.',
      })
      await runVendorLogin(ctx, ID, 'GitHub', 'gh', ['auth', 'refresh', '--hostname', 'github.com', '--scopes', 'delete_repo'])
      result = await ctx.io.exec('gh', ['repo', 'delete', full, '--yes'])
    }
    if (result.code !== 0) {
      throw new CimientoError({
        code: 'GITHUB_PERMISSION_DENIED',
        provider: ID,
        resource: spec.id,
        message: `Deleting ${full} failed: ${(result.stderr || result.stdout).trim().slice(0, 300)}`,
        hint: 'Only an owner or admin of the repository can delete it. cimiento doctor shows which account gh is logged in as.',
        retryable: true,
        needsHuman: true,
      })
    }
  },

  async outputs(spec: ResourceSpec, ctx: Ctx): Promise<Record<string, Output>> {
    if (spec.id !== 'github.repo') return {}
    const view = await viewRepo(ctx, fullName(spec))
    if (!view) return {}
    return repoOutputs(view)
  },

  explain(key: string, lang: Lang): string {
    const name = /^github\.secret\.([A-Z0-9_]+)$/.exec(key)?.[1]
    const entry = GITHUB_EXPLAIN[key] ?? (name
      ? {
          en: `The secret ${name} stored as a GitHub Actions secret of the repository, where workflows read it. cimiento writes the value, never prints it, and keeps no copy.`,
          es: `El secreto ${name} guardado como secreto de GitHub Actions del repositorio, donde lo leen los workflows. cimiento escribe el valor, nunca lo imprime y no guarda copia.`,
        }
      : undefined)
    if (!entry) return `No explanation for ${key} yet.`
    return (lang === 'es' && entry.es) || entry.en
  },
}

async function ensureSession(spec: ResourceSpec, ctx: Ctx): Promise<EnsureResult> {
  const { account, action } = await ensureVendorSession(githubProvider, spec, ctx, 'GitHub', githubSignupStep())
  const check = sessionCheck(ID, spec, { installed: true, session: { account } }, ctx.manifest.accounts.github, LOGIN_HINT)
  if (!check.ok && check.error) throw check.error
  // A gh login is one account, so there is nothing to ask: pin it so later runs refuse any other.
  pinInManifest(ctx, ['accounts', 'github'], account)
  return {
    action,
    externalId: account,
    outputs: { account: { value: account, secret: false } },
  }
}

function needsDeleteScope(result: { stdout: string; stderr: string }): boolean {
  return /delete_repo|admin rights|HTTP 403/i.test(`${result.stderr}\n${result.stdout}`)
}

async function ensureRepo(spec: ResourceSpec, ctx: Ctx): Promise<EnsureResult> {
  const full = fullName(spec)
  const known = ctx.state.resources[spec.id]
  let existing = await viewRepo(ctx, full)

  if (existing) {
    await ensureLocalRemote(ctx, existing)
    // An empty repository, such as one created by a run that could not push (BUG-68), gets the
    // local commits now, so everything that builds from it has a branch to build.
    if (!existing.defaultBranchRef && !ctx.dryRun) {
      const view = await pushFirst(ctx, spec, existing)
      if (view) existing = view
    }
    return {
      // Another repository answering to the same name is adopted, never taken for ours (BUG-57).
      action: sameResource(known?.externalId, existing.id) ? 'noop' : 'adopted',
      externalId: existing.id,
      url: existing.url,
      outputs: repoOutputs(existing),
    }
  }

  if (ctx.dryRun) return { action: 'noop' }

  await ensureLocalGit(ctx, spec)
  // gh pushes over HTTPS with its own credential helper, which a fresh Mac account has not set up.
  await ctx.io.exec('gh', ['auth', 'setup-git', '--hostname', 'github.com'], { cwd: ctx.cwd }).catch(() => undefined)
  const visibility = str(spec.inputs.visibility) || 'private'
  const description = str(spec.inputs.description) || ''
  // After cimiento down the folder keeps its origin remote, pointing at the deleted repository of
  // the same name, and gh repo create --remote origin would create the repository and then fail
  // before pushing (BUG-68). That remote is cimiento's own, so it goes.
  const origin = await ctx.io.exec('git', ['remote', 'get-url', 'origin'], { cwd: ctx.cwd })
  if (origin.code === 0 && sameRepoUrl(origin.stdout.trim(), full)) {
    await ctx.io.exec('git', ['remote', 'remove', 'origin'], { cwd: ctx.cwd })
  }
  const args = ['repo', 'create', full, `--${visibility}`, '--source=.', '--remote=origin', '--push']
  if (description) args.push('--description', description)
  const created = await ctx.io.exec('gh', args, { cwd: ctx.cwd })
  if (created.code !== 0) {
    const text = `${created.stderr}\n${created.stdout}`
    const nameTaken = /already exists|name already/i.test(text)
    throw new CimientoError({
      code: nameTaken ? 'GITHUB_REPO_NAME_TAKEN' : 'GITHUB_REPO_CREATE_FAILED',
      provider: ID,
      resource: spec.id,
      message: `gh repo create ${full} failed: ${text.trim().slice(0, 400)}`,
      hint: nameTaken
        ? `A repository named ${full} already exists but this account cannot see it. Pick a different name in stack.yaml, or log in as the owner.`
        : 'Check that gh has the repo scope: gh auth status. For an organization, an owner may need to approve repository creation.',
      retryable: true,
      needsHuman: /permission|scope|forbidden/i.test(text),
    })
  }
  const view = await viewRepo(ctx, full)
  if (!view) {
    throw new CimientoError({
      code: 'GITHUB_REPO_CREATE_FAILED',
      provider: ID,
      resource: spec.id,
      message: `gh repo create ${full} reported success but the repository is not visible.`,
      hint: `GitHub accepted the create but the repository is not visible to the account gh is logged in as. cimiento doctor shows that account.`,
      retryable: true,
      needsHuman: false,
    })
  }
  return { action: 'created', externalId: view.id, url: view.url, outputs: repoOutputs(view) }
}

/**
 * git init plus a first commit, so gh repo create --source has something to push. A fresh Mac
 * account has no git identity, so the commit then uses the GitHub login and its noreply address,
 * for this one commit, without changing the person's git configuration.
 */
async function ensureLocalGit(ctx: Ctx, spec: ResourceSpec): Promise<void> {
  if (!existsSync(join(ctx.cwd, '.git'))) {
    await ctx.io.exec('git', ['init', '-b', 'main'], { cwd: ctx.cwd })
  }
  const head = await ctx.io.exec('git', ['rev-parse', '--verify', 'HEAD'], { cwd: ctx.cwd })
  if (head.code === 0) return
  await ctx.io.exec('git', ['add', '-A'], { cwd: ctx.cwd })
  const commit = await ctx.io.exec('git', [...(await gitIdentityArgs(ctx)), 'commit', '-m', 'chore: scaffold by cimiento'], { cwd: ctx.cwd })
  if (commit.code !== 0) {
    throw new CimientoError({
      code: 'GITHUB_REPO_CREATE_FAILED',
      provider: ID,
      resource: spec.id,
      message: `The first commit of the scaffold failed: ${(commit.stderr || commit.stdout).trim().slice(0, 300)}`,
      hint: 'cimiento up retries safely. If git asks who you are, run cimiento up again after logging in to GitHub; cimiento then commits as your GitHub login.',
      retryable: true,
      needsHuman: false,
    })
  }
}

/**
 * -c flags for one commit when git has no identity, as on a fresh Mac account: the GitHub login
 * and its noreply address. Empty when the person has their own git identity.
 */
export async function gitIdentityArgs(ctx: Ctx): Promise<string[]> {
  const email = await ctx.io.exec('git', ['config', 'user.email'], { cwd: ctx.cwd })
  if (email.code === 0 && email.stdout.trim()) return []
  const login = ctx.manifest.accounts.github ?? (await ctx.io.exec('gh', ['api', 'user', '--jq', '.login'])).stdout.trim()
  return login ? ['-c', `user.name=${login}`, '-c', `user.email=${login}@users.noreply.github.com`] : []
}

/** When the repository already exists, make sure this checkout points at it. */
function sameRepoUrl(url: string, full: string): boolean {
  return url.replace(/\.git$/, '').replace(/^git@github\.com:/, 'https://github.com/').toLowerCase() === `https://github.com/${full}`.toLowerCase()
}

/** Pushes the local branch to an empty repository, and returns the repository as it is after. */
async function pushFirst(ctx: Ctx, spec: ResourceSpec, view: RepoView): Promise<RepoView | undefined> {
  // No repository or no commit here: nothing to push.
  const head = await ctx.io.exec('git', ['rev-parse', '--verify', 'HEAD'], { cwd: ctx.cwd })
  if (head.code !== 0) return undefined
  const branch = ctx.manifest.options.github.defaultBranch
  await ctx.io.exec('gh', ['auth', 'setup-git', '--hostname', 'github.com'], { cwd: ctx.cwd }).catch(() => undefined)
  const pushed = await ctx.io.exec('git', ['push', '-u', 'origin', `HEAD:${branch}`], { cwd: ctx.cwd })
  if (pushed.code !== 0) {
    throw new CimientoError({
      code: 'GITHUB_PERMISSION_DENIED',
      provider: ID,
      resource: spec.id,
      message: `${view.nameWithOwner} is empty and pushing the local commits to it failed: ${(pushed.stderr || pushed.stdout).trim().slice(0, 300)}`,
      hint: 'cimiento doctor shows which account gh uses; then run cimiento up again, which pushes the first commit.',
      retryable: true,
      needsHuman: false,
    })
  }
  return viewRepo(ctx, view.nameWithOwner)
}

async function ensureLocalRemote(ctx: Ctx, view: RepoView): Promise<void> {
  if (ctx.dryRun) return
  if (!existsSync(join(ctx.cwd, '.git'))) return
  const remote = await ctx.io.exec('git', ['remote', 'get-url', 'origin'], { cwd: ctx.cwd })
  if (remote.code === 0 && remote.stdout.trim()) return
  await ctx.io.exec('git', ['remote', 'add', 'origin', `${view.url}.git`], { cwd: ctx.cwd })
}

async function viewRepo(ctx: Ctx, full: string): Promise<RepoView | undefined> {
  const result = await ctx.io.exec('gh', [
    'repo',
    'view',
    full,
    '--json',
    'id,name,nameWithOwner,url,visibility,defaultBranchRef',
  ])
  if (result.code !== 0) return undefined
  try {
    const parsed = JSON.parse(result.stdout) as RepoView
    return parsed.nameWithOwner ? parsed : undefined
  } catch {
    return undefined
  }
}

function repoOutputs(view: RepoView): Record<string, Output> {
  return {
    fullName: { value: view.nameWithOwner, secret: false },
    repoUrl: { value: view.url, secret: false },
    cloneUrl: { value: `${view.url}.git`, secret: false },
    defaultBranch: { value: view.defaultBranchRef?.name ?? 'main', secret: false },
    nodeId: { value: view.id, secret: false },
    visibility: { value: view.visibility, secret: false },
  }
}

function fullName(spec: ResourceSpec): string {
  const owner = str(spec.inputs.owner)
  const name = str(spec.inputs.name)
  if (!owner || !name) {
    throw new CimientoError({
      code: 'DEFERRED_UNRESOLVED',
      provider: ID,
      resource: spec.id,
      message: `${spec.id} needs the GitHub owner and repository name, and one of them is still unknown.`,
      hint: 'Set accounts.github in stack.yaml, or run cimiento up so the GitHub login resolves the account first.',
      retryable: true,
      needsHuman: false,
    })
  }
  return `${owner}/${name}`
}

function str(value: Value | undefined): string {
  return typeof value === 'string' ? value : ''
}

function unknownResource(spec: ResourceSpec): CimientoError {
  return new CimientoError({
    code: 'PLAN_UNKNOWN_DEPENDENCY',
    provider: ID,
    resource: spec.id,
    message: `The github provider does not know the resource ${spec.id}.`,
    hint: 'This is a bug. Run cimiento plan --json and open an issue with the output.',
    retryable: false,
    needsHuman: true,
  })
}

/** The github module has no manifest dependent shape, so the factory returns the same object. */
export function createGithubProvider(_m?: Manifest): Provider {
  return githubProvider
}

export default githubProvider
