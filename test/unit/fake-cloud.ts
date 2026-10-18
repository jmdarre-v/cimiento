// A stateful in-memory stand in for gh, the Vercel API and the Supabase API.
//
// Recorded fixtures replay one call at a time, which makes an end to end run brittle. This keeps
// a tiny world instead, so the same command sequence behaves the way the real services do: a
// thing does not exist, then it is created, then it is found by name.

import { createHmac } from 'node:crypto'
import { writeFileSync } from 'node:fs'
import { join } from 'node:path'
import { FakeV2 } from './fake-v2'
import type { ExecOptions, ExecResult, HttpRequest, HttpResponse, Io, Running, SpawnOptions, SqlResult } from '../../src/core/io'

export interface FakeRepo {
  id: string
  name: string
  owner: string
  url: string
  visibility: string
  defaultBranch: string | null
}

export interface FakeVercelProject {
  id: string
  name: string
  accountId: string
  framework: string | null
  link: { type: string; org: string; repo: string; productionBranch: string } | null
  productionAlias: string | null
  createdAt?: number
}

export interface FakeVercelEnv {
  id: string
  key: string
  value: string
  target: string[]
  gitBranch?: string
  type: string
  createdAt?: number
  updatedAt?: number
}

export interface FakeDeployment {
  uid: string
  url: string
  readyState: string
  target: string
  createdAt?: number
  /** The env this deployment was built with, as Vercel bakes it in. */
  env?: Record<string, string>
  meta?: { githubCommitSha?: string; githubCommitRef?: string }
}

export interface FakeWidget {
  sitekey: string
  secret: string
  name: string
  domains: string[]
  mode: string
}

export interface FakeSupabaseProject {
  created_at?: string
  /** Day of the last API request, for usage.api-counts. */
  lastRequest?: string
  id: string
  name: string
  organization_id: string
  region: string
  status: string
}

export interface FakeCloudOptions {
  githubLogin?: string
  /** Terms accepted and the Supabase integration installed on the team, as after a first project. */
  marketplaceDone?: boolean
  toolVersions?: Record<string, string>
  /** Newest version per tool, as Homebrew or npm would report it. Defaults to the installed one. */
  latestVersions?: Record<string, string>
  /** An update notice a tool prints with its version, as the Supabase CLI does. */
  versionNotices?: Record<string, string>
  vercelLoggedIn?: boolean
  /** Teams the Vercel login can see. Defaults to one. */
  vercelTeams?: { id: string; slug: string; name: string; plan?: string }[]
  supabaseOrganizations?: { id: string; name: string; plan?: string }[]
  /** Whether gh already holds delete_repo. gh never asks for it at login, so the default is no. */
  ghDeleteScope?: boolean
  /**
   * Supabase's limit on active projects in free organizations, per person. When set, creating a
   * project in a free organization fails once that many are active, as the real API does.
   */
  supabaseFreeLimit?: number
  /** The Vercel account has no GitHub Login Connection, so repository links fail. */
  vercelGithubConnected?: boolean
  /** Repositories the Vercel GitHub app can see: all of them, or a list of names. */
  githubAppRepos?: 'all' | string[]
  /** A Supabase token stored the way CLI v2 stores it, in the Keychain. */
  keychainSupabaseToken?: string
  /**
   * cimiento secrets in the macOS keychain, by account. By default every cimiento account answers
   * with an obviously fake value, as if the person had typed it once; keychainEmpty turns that off.
   */
  keychain?: Record<string, string>
  keychainEmpty?: boolean
  cloudflareLoggedIn?: boolean
  /** Scopes the wrangler login holds. Defaults to the ones cimiento asks for. */
  cloudflareScopes?: string[]
  cloudflareAccounts?: { id: string; name: string }[]
  /** Makes wrangler login fail with this error, written to its debug log as wrangler does. */
  cloudflareLoginError?: string
  /** The Inngest Vercel integration is approved on the team. */
  inngestInstalled?: boolean
  /** Whether an Anthropic key is accepted. Defaults to any key starting with fake-. */
  anthropicKeyValid?: boolean
  /**
   * A Supabase Marketplace configuration already on the team, with the databases it serves, as
   * icfg_EXAMPLESHARED served another project in field test 2.
   */
  supabaseConfiguration?: { id: string; databases: { name: string; project: string }[] }
  /** gh holds a login. A person new to GitHub has none. */
  githubLoggedIn?: boolean
  /** git has user.name and user.email configured. A fresh Mac account has neither. */
  gitIdentity?: boolean
  /** Items in 1Password by reference. When absent, op is not installed. */
  onePassword?: Record<string, string>
}

export class FakeCloud implements Io {
  readonly execCalls: string[] = []
  readonly httpCalls: string[] = []

  readonly repos = new Map<string, FakeRepo>()
  /** Answers that replace a route's own, by method and URL; status 0 throws a timeout. */
  readonly httpFaults: { method: string; match: RegExp; status: number }[] = []
  /** Netlify, Neon, Resend, Stripe, PostHog, DNS and Vercel domains. */
  readonly v2: FakeV2 = new FakeV2(this)
  /** GitHub Actions secrets by repository, and Supabase project secrets by project ref. */
  readonly actionsSecrets = new Map<string, Map<string, string>>()
  readonly supabaseSecrets = new Map<string, Map<string, string>>()
  readonly vercelProjects = new Map<string, FakeVercelProject>()
  readonly vercelEnv = new Map<string, FakeVercelEnv[]>()
  readonly deployments = new Map<string, FakeDeployment[]>()
  readonly supabaseProjects: FakeSupabaseProject[] = []
  readonly supabaseAuth = new Map<string, { site_url: string; uri_allow_list: string }>()
  readonly supabaseOrganizations: { id: string; name: string; plan: string }[]
  readonly vercelTeams: { id: string; slug: string; name: string; plan?: string }[]
  readonly linkedProjects = new Map<string, string>()
  readonly pages = new Map<string, { status: number; body: string }>()
  /** Migrations applied per project ref, in the order the API recorded them. */
  readonly migrations = new Map<string, { version: string; name: string; query: string }[]>()

  marketplaceDone: boolean
  inngestInstalled: boolean
  cloudflareLoggedIn: boolean
  cloudflareScopes: string[]
  cloudflareLoginError: string | undefined
  readonly cloudflareAccounts: { id: string; name: string }[]
  readonly widgets = new Map<string, FakeWidget[]>()
  readonly keychain = new Map<string, string>()
  keychainEmpty: boolean
  anthropicKeyValid: boolean | undefined
  onePassword: Record<string, string> | undefined
  gitIdentity: boolean
  githubLoggedIn: boolean
  /** The working tree has changes git status would list. */
  gitDirty = false
  gitCommits = 0
  /** The checked out branch, and every branch pushed to the repository with its head commit. */
  gitBranch = 'main'
  /** git push fails, as with no network. */
  pushFails = false
  /** The URL of the local origin remote, as git remote get-url prints it. */
  gitOrigin: string | undefined
  readonly pushedBranches = new Map<string, string>()
  /** What a push makes Vercel's build end as. */
  pushBuild: 'READY' | 'ERROR' | 'BUILDING' = 'READY'
  /** Vercel projects whose Inngest app was registered with a PUT on /api/inngest. */
  readonly inngestSynced = new Set<string>()
  /** Marketplace resources, one per database the Marketplace created. */
  readonly stores: { id: string; name: string; cfg: string; ref: string; projects: string[] }[] = []
  supabaseConfigurationId = 'icfg_fake'
  readonly inngestEvents = new Map<string, { name: string; projectId: string; status: string }>()
  readonly spawned: { label: string; opts: SpawnOptions; running: Running; stop(code?: number): void }[] = []
  private tick = 1_700_000_000_000
  vercelLoggedIn: boolean
  ghDeleteScope: boolean
  keychainSupabaseToken: string | undefined
  supabaseFreeLimit: number | undefined
  vercelGithubConnected: boolean
  githubAppRepos: 'all' | string[]
  private readonly login: string
  private readonly versions: Record<string, string>
  private readonly latest: Record<string, string>
  private readonly notices: Record<string, string>
  private counter = 0

  constructor(options: FakeCloudOptions = {}) {
    this.login = options.githubLogin ?? 'test-handle'
    this.marketplaceDone = options.marketplaceDone ?? false
    // A team that has been through a first project has both integrations approved.
    this.inngestInstalled = options.inngestInstalled ?? options.marketplaceDone ?? false
    this.cloudflareLoggedIn = options.cloudflareLoggedIn ?? true
    this.cloudflareLoginError = options.cloudflareLoginError
    this.cloudflareScopes = options.cloudflareScopes ?? ['account:read', 'user:read', 'challenge-widgets.write', 'offline_access']
    this.cloudflareAccounts = options.cloudflareAccounts ?? [{ id: 'cf_account_fake', name: 'Fake Cloudflare' }]
    this.keychainEmpty = options.keychainEmpty ?? false
    this.anthropicKeyValid = options.anthropicKeyValid
    this.onePassword = options.onePassword
    this.gitIdentity = options.gitIdentity ?? true
    this.githubLoggedIn = options.githubLoggedIn ?? true
    if (options.supabaseConfiguration) {
      this.marketplaceDone = true
      this.supabaseConfigurationId = options.supabaseConfiguration.id
      for (const db of options.supabaseConfiguration.databases) {
        const ref = this.ref()
        this.supabaseProjects.push({ id: ref, name: db.name, organization_id: `vercel_${options.supabaseConfiguration.id}`, region: 'us-east-1', status: 'ACTIVE_HEALTHY', created_at: '2026-09-27T00:00:00Z' })
        this.stores.push({ id: this.id('store'), name: db.name, cfg: options.supabaseConfiguration.id, ref, projects: [db.project] })
      }
    }
    for (const [account, value] of Object.entries(options.keychain ?? {})) this.keychain.set(account, value)
    this.vercelLoggedIn = options.vercelLoggedIn ?? true
    this.ghDeleteScope = options.ghDeleteScope ?? false
    this.keychainSupabaseToken = options.keychainSupabaseToken
    this.supabaseFreeLimit = options.supabaseFreeLimit
    this.vercelGithubConnected = options.vercelGithubConnected ?? true
    this.latest = { ...(options.latestVersions ?? {}) }
    this.notices = options.versionNotices ?? {}
    this.githubAppRepos = options.githubAppRepos ?? 'all'
    this.vercelTeams = options.vercelTeams ?? [{ id: 'team_fake', slug: 'fake-team', name: 'Fake Team' }]
    this.supabaseOrganizations = (options.supabaseOrganizations ?? [{ id: 'org_fake', name: 'Fake Org' }]).map((o) => ({
      plan: 'free',
      ...o,
    }))
    this.versions = {
      git: 'git version 2.54.0',
      gh: 'gh version 2.60.0 (2025-01-01)',
      vercel: 'Vercel CLI 39.0.0',
      supabase: '1.200.0',
      wrangler: ' ⛅️ wrangler 4.151.1',
      netlify: 'netlify-cli/17.38.1 darwin-arm64 node-v22.11.0',
      neonctl: '2.27.0',
      ...(options.toolVersions ?? {}),
    }
    if (this.onePassword) this.versions.op = '2.32.0'
  }

  gitSha(): string {
    return `${String(this.gitCommits).padStart(4, '0')}fakesha${'0'.repeat(29)}`.slice(0, 40)
  }

  /** A newer release of a tool appears, as Homebrew or npm would report it. */
  setLatest(bin: string, version: string): void {
    this.latest[bin] = version
  }

  /** A clock that only moves forward, so created and updated times order the way they happened. */
  now(): number {
    this.tick += 1000
    return this.tick
  }

  spawn(cmd: string, args: string[], opts: SpawnOptions = {}): Running {
    const label = [cmd, ...args].join(' ')
    this.execCalls.push(`spawn ${label}`)
    let resolve: (code: number) => void = () => undefined
    const exited = new Promise<number>((r) => {
      resolve = r
    })
    const running: Running = { label, exited, kill: () => resolve(130) }
    this.spawned.push({ label, opts, running, stop: (code = 1) => resolve(code) })
    return running
  }

  private id(prefix: string): string {
    this.counter += 1
    return `${prefix}_${String(this.counter).padStart(4, '0')}`
  }

  /** Supabase refs are twenty lowercase letters and digits, and cimiento parses them from URLs. */
  private ref(): string {
    this.counter += 1
    return `fakeref${String(this.counter).padStart(13, '0')}`
  }

  readonly interactiveCalls: string[] = []

  /** Foreground vendor commands: logins, scope refreshes, the Marketplace install. */
  async interactive(cmd: string, args: string[], opts: ExecOptions = {}): Promise<ExecResult> {
    this.interactiveCalls.push([cmd, ...args].join(' '))
    return this.exec(cmd, args, opts)
  }

  async exec(cmd: string, args: string[], _opts: ExecOptions = {}): Promise<ExecResult> {
    const key = [cmd, ...args].join(' ')
    this.execCalls.push(key)

    if (args[0] === '--version' || args[0] === '-v') {
      const version = this.versions[cmd]
      if (!version) return fail(`${cmd}: command not found`)
      return this.notices[cmd] ? { code: 0, stdout: version, stderr: this.notices[cmd] } : ok(version)
    }
    if (cmd === 'which') {
      if (!this.versions[args[0]]) return fail('')
      // git is Apple's own, the rest come from Homebrew, as on the machine Goal 1 ran on.
      return ok(args[0] === 'git' ? '/usr/bin/git\n' : `/opt/homebrew/bin/${args[0]}\n`)
    }
    if (cmd === 'brew' && args[0] === 'info') {
      const bin = (args[2] ?? '').split('/').pop() ?? ''
      const installed = /\d+\.\d+\.\d+/.exec(this.versions[bin] ?? '')?.[0]
      return ok(JSON.stringify({ formulae: [{ versions: { stable: this.latest[bin] ?? installed }, installed: installed ? [{ version: installed }] : [] }] }))
    }
    if (cmd === 'npm' && args[0] === 'view') {
      const installed = /\d+\.\d+\.\d+/.exec(this.versions[args[1]] ?? '')?.[0]
      return ok(`${this.latest[args[1]] ?? installed ?? '0.0.0'}\n`)
    }
    if ((cmd === 'brew' && args[0] === 'upgrade') || (cmd === 'npm' && args[0] === 'install')) {
      const bin = (args[args.length - 1] ?? '').split('/').pop()!.replace(/@latest$/, '')
      if (this.latest[bin]) {
        this.versions[bin] = `${bin} version ${this.latest[bin]}`
        delete this.notices[bin]
      }
      return ok('upgraded')
    }
    if (cmd === 'git') return this.git(args)
    const v2 = this.v2.exec(cmd, args)
    if (v2) return v2
    if (cmd === 'gh') return this.v2.gh(args) ?? this.gh(args, _opts)
    if (cmd === 'vercel') return this.vercel(args)
    if (cmd === 'supabase') return this.supabase(args)
    if (cmd === 'brew' || cmd === 'npm' || cmd === 'pnpm') return ok('installed')
    if (cmd === 'open' || cmd === 'xdg-open') return ok('')
    if (cmd === 'security' && args[0] === 'find-generic-password') {
      const service = args[args.indexOf('-s') + 1]
      const account = args[args.indexOf('-a') + 1]
      if (service === 'cimiento') {
        const stored = this.keychain.get(account)
        if (stored !== undefined) return ok(`${stored}\n`)
        if (this.keychainEmpty) return fail('security: SecKeychainSearchCopyNext: The specified item could not be found in the keychain.', 44)
        return ok(`fake-${account.split('/').pop()!.toLowerCase().replace(/_/g, '-')}-not-a-real-credential\n`)
      }
      if (!this.keychainSupabaseToken) return fail('security: The specified item could not be found in the keychain.', 44)
      return ok(`${this.keychainSupabaseToken}\n`)
    }
    if (cmd === 'security' && args[0] === 'delete-generic-password') {
      const account = args[args.indexOf('-a') + 1]
      if (!this.keychain.delete(account)) return fail('security: The specified item could not be found in the keychain.', 44)
      return ok('password has been deleted.')
    }
    if (cmd === 'security' && args[0] === '-i') {
      const line = _opts.input ?? ''
      if (args.some((a) => a.includes('-w'))) return fail('the value must never be on the command line')
      const parts = [...line.matchAll(/"((?:[^"\\]|\\.)*)"/g)].map((m) => m[1].replace(/\\(.)/g, '$1'))
      const [service, account, value] = parts
      if (!line.startsWith('add-generic-password') || service !== 'cimiento' || !account || value === undefined) {
        return fail(`security: unexpected command ${line.split(' ')[0]}`)
      }
      this.keychain.set(account, value)
      return ok('')
    }
    if (cmd === 'wrangler') return this.wrangler(args, _opts)
    if (cmd === 'op') {
      if (!this.onePassword) return fail('op: command not found', 127)
      if (args[0] === '--version') return ok('2.32.0')
      if (args[0] === 'read') {
        const value = this.onePassword[args[args.length - 1]]
        return value === undefined ? fail('[ERROR] could not read secret: item not found') : ok(value)
      }
    }
    if (cmd === 'docker' && args[0] === 'info') return ok('Server Version: 29.8.2')
    return fail(`FakeCloud: no behavior for "${key}"`)
  }

  private async wrangler(args: string[], opts: ExecOptions = {}): Promise<ExecResult> {
    if (args[0] === 'login') {
      // As wrangler 4.151.1 does: --scopes keys are checked against its list, offline_access is
      // not on it, and errors go to the debug log in WRANGLER_LOG_PATH.
      const scopes = args.indexOf('--scopes') >= 0 ? args.slice(args.indexOf('--scopes') + 1) : undefined
      const error = scopes?.includes('offline_access')
        ? 'Invalid authentication scope: "offline_access". Run "wrangler login --scopes-list" to see all valid scopes.'
        : this.cloudflareLoginError
      if (error) {
        const dir = opts.env?.WRANGLER_LOG_PATH
        if (dir) writeFileSync(join(dir, 'wrangler-2026-10-17_20-24-26_119.log'), `--- 2026-10-17T20:24:27.018Z error\n✘ [ERROR] ${error}\n`)
        return fail('')
      }
      this.cloudflareLoggedIn = true
      this.cloudflareScopes = scopes ?? ['user:read', 'offline_access', 'account:read', 'workers:write', 'challenge-widgets.write']
      return ok('Successfully logged in.')
    }
    if (args[0] === 'whoami') {
      if (!this.cloudflareLoggedIn) return fail('{"loggedIn":false}')
      return ok(
        JSON.stringify({
          loggedIn: true,
          authType: 'OAuth Token',
          email: 'person@example.test',
          accounts: this.cloudflareAccounts,
          tokenPermissions: this.cloudflareScopes,
        }),
      )
    }
    if (args[0] === 'auth' && args[1] === 'token') {
      if (!this.cloudflareLoggedIn) return fail('Not logged in. Please run `wrangler login` to authenticate.')
      return ok(JSON.stringify({ type: 'oauth', token: 'fake-cloudflare-token-not-a-real-credential' }))
    }
    return fail(`FakeCloud: no wrangler behavior for "${args.join(' ')}"`)
  }

  /** What a person does on the Inngest integration page: approve it for the team's projects. */
  installInngest(): void {
    this.inngestInstalled = true
    for (const project of this.vercelProjects.values()) {
      const envs = this.vercelEnv.get(project.id) ?? []
      if (envs.some((e) => e.key === 'INNGEST_EVENT_KEY')) continue
      const at = this.now()
      envs.push(
        { id: this.id('env'), key: 'INNGEST_EVENT_KEY', value: `fake-inngest-event-key-${project.name}`, target: ['production', 'preview'], type: 'encrypted', createdAt: at },
        { id: this.id('env'), key: 'INNGEST_SIGNING_KEY', value: `signkey-prod-fake-${project.name}`, target: ['production', 'preview'], type: 'encrypted', createdAt: at },
      )
      this.vercelEnv.set(project.id, envs)
    }
  }

  private async git(args: string[]): Promise<ExecResult> {
    if (args[0] === 'init') return ok('Initialized empty Git repository')
    if (args[0] === 'rev-parse' && args.includes('--abbrev-ref')) return ok(`${this.gitBranch}\n`)
    if (args[0] === 'checkout') {
      this.gitBranch = args[args.length - 1]
      return ok(`Switched to branch '${this.gitBranch}'`)
    }
    if (args[0] === 'rev-parse') return this.gitCommits > 0 ? ok(`${this.gitSha()}\n`) : fail('fatal: Needed a single revision')
    if (args[0] === 'status') return ok(this.gitDirty ? ' M app/page.tsx\n' : '')
    if (args[0] === 'ls-remote') {
      const branch = (args[args.length - 1] ?? '').replace('refs/heads/', '')
      const sha = this.pushedBranches.get(branch)
      return ok(sha ? `${sha}\trefs/heads/${branch}\n` : '')
    }
    if (args[0] === 'push' && this.pushFails) return fail('fatal: unable to access the remote: Could not resolve host: github.com')
    if (args[0] === 'push') {
      // Vercel's GitHub app starts a production build of the pushed commit by itself.
      const branch = args[args.length - 1].replace(/^HEAD:/, '')
      this.pushedBranches.set(branch, this.gitSha())
      // The first push to an empty repository makes its branch the default one.
      for (const repo of this.repos.values()) {
        if (`${repo.url}.git` === this.gitOrigin && !repo.defaultBranch) repo.defaultBranch = branch
      }
      const project = [...this.vercelProjects.values()][0]
      if (project) {
        const list = this.deployments.get(project.id) ?? []
        list.unshift({
          uid: this.id('dpl'),
          url: `${project.name}-${this.id('git')}.vercel.app`,
          readyState: 'BUILDING',
          // Only the production branch deploys to production; any other branch gets a preview.
          target: branch === 'main' ? 'production' : (null as unknown as string),
          createdAt: this.now(),
          meta: { githubCommitSha: this.gitSha(), githubCommitRef: branch },
        })
        this.deployments.set(project.id, list)
      }
      this.v2.onPush(undefined, branch)
      return ok('To https://github.com/x/y.git')
    }
    if (args[0] === 'add') return ok('')
    if (args[0] === 'config' && args[1] === 'user.email') return this.gitIdentity ? ok('person@example.test\n') : fail('', 1)
    if (args.includes('commit')) {
      if (!this.gitIdentity && !args.some((a) => a.startsWith('user.email='))) {
        return fail('Author identity unknown\n\n*** Please tell me who you are.')
      }
      this.gitCommits += 1
      this.gitDirty = false
      return ok(`[main ${this.gitSha().slice(0, 7)}] commit`)
    }
    if (args[0] === 'remote' && args[1] === 'get-url') return this.gitOrigin ? ok(`${this.gitOrigin}\n`) : fail('error: No such remote')
    if (args[0] === 'remote' && args[1] === 'add') {
      if (this.gitOrigin) return fail('error: remote origin already exists.')
      this.gitOrigin = args[3]
      return ok('')
    }
    if (args[0] === 'remote' && args[1] === 'remove') {
      this.gitOrigin = undefined
      return ok('')
    }
    return ok('')
  }

  private async gh(args: string[], opts: ExecOptions = {}): Promise<ExecResult> {
    if (!this.githubLoggedIn && !(args[0] === 'auth' && args[1] === 'login')) {
      return fail('You are not logged into any GitHub hosts. To log in, run: gh auth login')
    }
    if (args[0] === 'api' && args[1] === 'user') return ok(`${this.login}\n`)
    if (args[0] === 'secret') {
      const repo = args[args.indexOf('-R') + 1]
      const store = this.actionsSecrets.get(repo) ?? new Map<string, string>()
      this.actionsSecrets.set(repo, store)
      if (args[1] === 'list') return ok(JSON.stringify([...store.keys()].map((name) => ({ name }))))
      if (args[1] === 'set') {
        store.set(args[2], opts.input ?? '')
        return ok('')
      }
      if (args[1] === 'delete') {
        store.delete(args[2])
        return ok('')
      }
    }
    if (args[0] === 'api' && /^repos\/[^/]+\/[^/]+\/branches/.test(args[1] ?? '')) {
      const branches = [{ name: 'main', sha: this.pushedBranches.get('main') ?? this.gitSha() }]
      for (const [name, sha] of this.pushedBranches) if (name !== 'main') branches.push({ name, sha })
      return ok(JSON.stringify(branches))
    }
    if (args[0] === 'auth' && args[1] === 'status') return ok(`Logged in to github.com account ${this.login}`)
    if (args[0] === 'auth' && args[1] === 'login') {
      this.githubLoggedIn = true
      return ok('Logged in')
    }
    if (args[0] === 'auth' && args[1] === 'setup-git') return ok('')
    if (args[0] === 'auth' && args[1] === 'refresh') {
      if (args.includes('delete_repo')) this.ghDeleteScope = true
      return ok('Authentication refreshed')
    }
    if (args[0] === 'repo' && args[1] === 'view') {
      const full = args[2]
      const repo = this.repos.get(full)
      if (!repo) return fail(`Could not resolve to a Repository with the name '${full}'.`)
      return ok(
        JSON.stringify({
          id: repo.id,
          name: repo.name,
          nameWithOwner: full,
          url: repo.url,
          visibility: repo.visibility,
          // As gh prints it: an empty repository has a default branch ref with an empty name.
          defaultBranchRef: { name: repo.defaultBranch ?? '' },
        }),
      )
    }
    if (args[0] === 'repo' && args[1] === 'create') {
      const full = args[2]
      if (this.repos.has(full)) return fail(`Name already exists on this account`)
      const [owner, name] = full.split('/')
      const visibility = args.find((a) => a === '--private' || a === '--public')?.slice(2) ?? 'private'
      // As gh does: the repository is created first, then adding the remote fails if one exists.
      const remoteClash = args.includes('--remote=origin') && this.gitOrigin !== undefined
      this.repos.set(full, {
        id: this.id('R'),
        name,
        owner,
        url: `https://github.com/${full}`,
        visibility,
        defaultBranch: args.includes('--push') && !remoteClash ? 'main' : null,
      })
      if (remoteClash) return fail(`X Unable to add remote "origin"\n\nhttps://github.com/${full}`)
      if (args.includes('--remote=origin')) this.gitOrigin = `https://github.com/${full}.git`
      if (args.includes('--push') && this.gitCommits > 0) this.pushedBranches.set('main', this.gitSha())
      return ok(`https://github.com/${full}`)
    }
    if (args[0] === 'repo' && args[1] === 'delete') {
      if (!this.ghDeleteScope) {
        return fail('HTTP 403: Must have admin rights to Repository. This API operation needs the "delete_repo" scope.')
      }
      this.repos.delete(args[2])
      return ok('')
    }
    return fail(`FakeCloud: no gh behavior for "${args.join(' ')}"`)
  }

  private async vercel(args: string[]): Promise<ExecResult> {
    if (args[0] === 'whoami') return this.vercelLoggedIn ? ok(`${this.login}\n`) : fail('> Logged out.')
    if (args[0] === 'login') {
      this.vercelLoggedIn = true
      return ok('Success')
    }
    if (args[0] === 'link') {
      const name = args[args.indexOf('--project') + 1]
      const project = this.findVercelProject(name)
      if (!project) return fail(`Project not found: ${name}`)
      this.linkedProjects.set(project.name, project.id)
      return ok(`Linked to ${project.name}`)
    }
    if (args[0] === 'integration' && args[1] === 'add' && args[2] === 'supabase') {
      if (!this.marketplaceDone) {
        return fail('You must accept the Marketplace terms for Supabase before it can be added.')
      }
      const name = args[args.indexOf('--name') + 1]
      // As the CLI does: the resource goes to the linked project, connected to the environments
      // named with --environment, or all of them.
      const linkedId = [...this.linkedProjects.values()].pop()
      const project = linkedId ? this.findVercelProject(linkedId) : undefined
      if (!project) return fail('No project linked')
      const targets = args.flatMap((a, i) => ((a === '--environment' || a === '-e') && args[i + 1] ? [args[i + 1]] : []))
      const wanted = targets.length > 0 ? targets : ['production', 'preview', 'development']
      const clash = (this.vercelEnv.get(project.id) ?? []).find((e) => /SUPABASE/.test(e.key) && !e.gitBranch && e.target.some((t) => wanted.includes(t)))
      if (clash) return fail(`Error: A variable with the name \`${clash.key}\` already exists for the target ${clash.target.join(',')}`)
      this.installSupabase(project, name, 'org_fake', wanted)
      return ok('Installed supabase')
    }
    if (args[0] === 'deploy') {
      const project = [...this.vercelProjects.values()][0]
      if (!project) return fail('No project linked')
      const url = `${project.name}-${this.id('dpl')}.vercel.app`
      const alias = project.productionAlias ?? `${project.name}.vercel.app`
      project.productionAlias = alias
      const list = this.deployments.get(project.id) ?? []
      const env = Object.fromEntries(
        (this.vercelEnv.get(project.id) ?? []).filter((e) => e.target.includes('production')).map((e) => [e.key, e.value]),
      )
      // As the CLI does: each --meta KEY=value lands in the deployment's meta.
      const meta: Record<string, string> = {}
      args.forEach((a, i) => {
        if ((a === '--meta' || a === '-m') && args[i + 1]) {
          const [key, ...rest] = args[i + 1].split('=')
          meta[key] = rest.join('=')
        }
      })
      list.unshift({ uid: this.id('dpl'), url, readyState: 'READY', target: 'production', createdAt: this.now(), env, ...(Object.keys(meta).length ? { meta } : {}) })
      this.deployments.set(project.id, list)
      this.pages.set(`https://${alias}`, {
        status: 200,
        body: `<html><head><meta name="cimiento-project" content="${project.name}"></head><body>ok</body></html>`,
      })
      return ok(`Production: https://${alias}`)
    }
    if (args[0] === 'env' && args[1] === 'pull') return ok('Downloaded environment variables')
    if (args[0] === 'integration-resource' && args[1] === 'remove') {
      const matches = this.stores.filter((s) => s.name === args[2])
      if (matches.length !== 1) return fail(`Error: resource ${args[2]} not found or ambiguous`)
      if (!args.includes('--disconnect-all') && matches[0].projects.length > 0) return fail('Error: resource has connected projects')
      this.stores.splice(this.stores.indexOf(matches[0]), 1)
      const index = this.supabaseProjects.findIndex((p) => p.id === matches[0].ref)
      if (index >= 0) this.supabaseProjects.splice(index, 1)
      return ok(`Success! ${args[2]} deleted`)
    }
    if (args[0] === 'integration' && args[1] === 'remove') return fail('FakeCloud: cimiento must never uninstall an integration')
    return fail(`FakeCloud: no vercel behavior for "${args.join(' ')}"`)
  }

  /** What the Vercel Marketplace integration does: create the project and push its keys. */
  private installSupabase(project: FakeVercelProject, name: string, organizationId = 'org_fake', targets = ['production', 'preview', 'development']): void {
    const ref = this.ref()
    this.stores.push({ id: this.id('store'), name, cfg: this.supabaseConfigurationId, ref, projects: [project.name] })
    this.supabaseProjects.push({
      created_at: new Date().toISOString(),
      id: ref,
      name,
      organization_id: organizationId,
      region: 'us-east-1',
      status: 'ACTIVE_HEALTHY',
    })
    this.supabaseAuth.set(ref, { site_url: 'http://localhost:3000', uri_allow_list: '' })
    const envs = this.vercelEnv.get(project.id) ?? []
    for (const [key, value] of [
      ['NEXT_PUBLIC_SUPABASE_URL', `https://${ref}.supabase.co`],
      ['NEXT_PUBLIC_SUPABASE_ANON_KEY', 'fake-anon-key-not-a-real-credential'],
      ['SUPABASE_SERVICE_ROLE_KEY', 'fake-service-role-key-not-a-real-credential'],
    ]) {
      envs.push({
        id: this.id('env'),
        key,
        value,
        target: [...targets],
        type: 'encrypted',
      })
    }
    this.vercelEnv.set(project.id, envs)
  }

  private async supabase(args: string[]): Promise<ExecResult> {
    if (args[0] === 'login') {
      this.keychainSupabaseToken = 'go-keyring-base64:ZmFrZS1zdXBhYmFzZS10b2tlbi1ub3QtYS1yZWFsLWNyZWRlbnRpYWw='
      return ok('You are now logged in.')
    }
    if (args[0] === 'link') return ok('Finished supabase link')
    if (args[0] === 'db' && args[1] === 'push') return ok('Applying migration')
    if (args[0] === 'init') return ok('Finished supabase init.')
    if (args[0] === 'start') return ok('Started supabase local development setup.')
    if (args[0] === 'stop') return ok('Stopped supabase local development setup.')
    if (args[0] === 'status') {
      return ok(
        ['API_URL="http://127.0.0.1:54321"', 'ANON_KEY="fake-local-anon-key-not-a-real-credential"', 'SERVICE_ROLE_KEY="fake-local-service-role-not-a-real-credential"'].join('\n'),
      )
    }
    return fail(`FakeCloud: no supabase behavior for "${args.join(' ')}"`)
  }

  async sql(connectionString: string, text: string): Promise<SqlResult> {
    return this.v2.sql(connectionString, text)
  }

  async http(req: HttpRequest): Promise<HttpResponse> {
    const key = `${req.method.toUpperCase()} ${req.url}`
    this.httpCalls.push(key)
    const url = new URL(req.url)

    // A provider having a bad moment: the first matching fault answers instead of the route.
    const fault = this.httpFaults.find((f) => f.method === req.method.toUpperCase() && f.match.test(req.url))
    if (fault) {
      if (fault.status === 0) throw Object.assign(new Error('timeout'), { name: 'TimeoutError' })
      return json(fault.status, { error: { message: `fault ${fault.status}` } })
    }
    const v2 = this.v2.http(req, url)
    if (v2) return v2
    if (url.hostname === 'api.vercel.com') return this.vercelApi(req, url)
    if (url.hostname === 'api.supabase.com') return this.supabaseApi(req, url)
    if (url.hostname === 'api.cloudflare.com') return this.cloudflareApi(req, url)
    if (url.hostname === 'challenges.cloudflare.com') return this.siteverify(req)
    if (url.hostname === 'api.anthropic.com') return this.anthropicApi(req, url)
    if (url.hostname === 'inn.gs') return this.inngestEvent(req, url)
    if (url.hostname === 'api.inngest.com') return this.inngestApi(req, url)
    if (url.pathname === '/api/inngest') return this.inngestEndpoint(req, url)

    const page = this.pages.get(`${url.origin}${url.pathname === '/' ? '' : url.pathname}`)
    if (page) return json(page.status, undefined, page.body)
    return json(404, { error: 'not found' })
  }

  private projectByAlias(host: string): FakeVercelProject | undefined {
    return [...this.vercelProjects.values()].find((p) => p.productionAlias === host)
  }

  /** The Inngest serve handler in the deployed app: introspection on GET, registration on PUT. */
  private inngestEndpoint(req: HttpRequest, url: URL): HttpResponse {
    const project = this.projectByAlias(url.hostname)
    if (!project) return json(404, { error: 'not found' })
    const built = this.deployments.get(project.id)?.[0]?.env ?? {}
    const keys = Boolean(built.INNGEST_EVENT_KEY) && Boolean(built.INNGEST_SIGNING_KEY)
    if (req.method.toUpperCase() === 'PUT') {
      if (!built.INNGEST_SIGNING_KEY) return json(500, { message: 'No signing key found' })
      this.inngestSynced.add(project.id)
      return json(200, { message: 'Successfully registered', modified: true })
    }
    // As inngest 3.54 does in cloud mode: introspection needs a request signed with the signing
    // key the deployment was built with, and the SDK marks every answer it gives.
    const sdk = { 'x-inngest-sdk-handled': 'true' }
    const signature = new URLSearchParams(req.headers?.['x-inngest-signature'] ?? '')
    const ts = signature.get('t') ?? ''
    const key = (built.INNGEST_SIGNING_KEY ?? '').replace(/^signkey-[\w]+-/, '')
    const expected = key ? createHmac('sha256', key).update(ts).digest('hex') : ''
    if (!expected || signature.get('s') !== expected) return json(401, { message: 'Unauthorized' }, undefined, sdk)
    return json(
      200,
      {
        has_event_key: keys,
        has_signing_key: Boolean(built.INNGEST_SIGNING_KEY),
        function_count: 1,
        mode: 'cloud',
        schema_version: '2024-05-24',
      },
      undefined,
      sdk,
    )
  }

  private envValue(key: string, value: string): FakeVercelProject | undefined {
    for (const project of this.vercelProjects.values()) {
      if ((this.vercelEnv.get(project.id) ?? []).some((e) => e.key === key && e.value === value)) return project
    }
    return undefined
  }

  private inngestEvent(req: HttpRequest, url: URL): HttpResponse {
    const key = decodeURIComponent(url.pathname.replace(/^\/e\//, ''))
    const project = this.envValue('INNGEST_EVENT_KEY', key)
    if (!project) return json(401, { error: 'Event key not found' })
    const id = this.id('01EVT')
    const name = (req.body as { name?: string }).name ?? ''
    this.inngestEvents.set(id, { name, projectId: project.id, status: this.inngestSynced.has(project.id) && name === 'cimiento/roundtrip' ? 'Completed' : 'none' })
    return json(200, { ids: [id], status: 200 })
  }

  private inngestApi(req: HttpRequest, url: URL): HttpResponse {
    const match = /^\/v1\/events\/([^/]+)\/runs$/.exec(url.pathname)
    if (!match) return json(404, { error: 'not found' })
    const signing = (req.headers?.authorization ?? '').replace(/^Bearer /, '')
    const event = this.inngestEvents.get(decodeURIComponent(match[1]))
    if (!this.envValue('INNGEST_SIGNING_KEY', signing)) return json(401, { error: 'unauthorized' })
    if (!event || event.status === 'none') return json(200, { data: [] })
    return json(200, { data: [{ run_id: `01RUN${match[1]}`, status: event.status }] })
  }

  private anthropicApi(req: HttpRequest, url: URL): HttpResponse {
    if (url.pathname !== '/v1/models') return json(404, { type: 'error', error: { type: 'not_found_error' } })
    const key = req.headers?.['x-api-key'] ?? ''
    const valid = this.anthropicKeyValid ?? key.startsWith('fake-')
    if (!valid) return json(401, { type: 'error', error: { type: 'authentication_error', message: 'invalid x-api-key' } })
    return json(200, { data: [{ id: 'claude-opus-5-5', type: 'model' }], has_more: true })
  }

  private siteverify(req: HttpRequest): HttpResponse {
    const body = req.body as { secret?: string; response?: string }
    const known = [...this.widgets.values()].flat().some((w) => w.secret === body.secret) || body.secret === '1x0000000000000000000000000000000AA'
    if (!known) return json(200, { success: false, 'error-codes': ['invalid-input-secret'] })
    return json(200, { success: false, 'error-codes': ['invalid-input-response'] })
  }

  private cloudflareApi(req: HttpRequest, url: URL): HttpResponse {
    if ((req.headers?.authorization ?? '') !== 'Bearer fake-cloudflare-token-not-a-real-credential') {
      return json(403, { success: false, errors: [{ message: 'Authentication error' }] })
    }
    const match = /^\/client\/v4\/accounts\/([^/]+)\/challenges\/widgets(?:\/([^/]+))?$/.exec(url.pathname)
    if (!match) return json(404, { success: false, errors: [{ message: 'No route for that URI' }] })
    if (!this.cloudflareScopes.includes('challenge-widgets.write')) {
      return json(403, { success: false, errors: [{ message: 'Unauthorized to access requested resource' }] })
    }
    const account = decodeURIComponent(match[1])
    const list = this.widgets.get(account) ?? []
    this.widgets.set(account, list)
    const method = req.method.toUpperCase()
    const strip = (w: FakeWidget) => ({ sitekey: w.sitekey, name: w.name, domains: w.domains, mode: w.mode })
    if (!match[2]) {
      if (method === 'GET') return json(200, { success: true, result: list.map(strip) })
      const body = req.body as { name: string; domains: string[]; mode: string }
      const widget: FakeWidget = { sitekey: `0x4AAAAAAA${this.id('sk')}`, secret: `0x4AAAAAAA-fake-turnstile-secret-${this.counter}`, ...body }
      list.push(widget)
      return json(200, { success: true, result: widget })
    }
    const sitekey = decodeURIComponent(match[2])
    const widget = list.find((w) => w.sitekey === sitekey)
    if (!widget) return json(404, { success: false, errors: [{ message: 'widget not found' }] })
    if (method === 'GET') return json(200, { success: true, result: widget })
    if (method === 'PUT') {
      Object.assign(widget, req.body as Partial<FakeWidget>)
      return json(200, { success: true, result: strip(widget) })
    }
    if (method === 'DELETE') {
      list.splice(list.indexOf(widget), 1)
      return json(200, { success: true, result: strip(widget) })
    }
    return json(405, { success: false, errors: [{ message: 'method not allowed' }] })
  }

  private overFreeLimit(organizationId: string): boolean {
    if (this.supabaseFreeLimit === undefined) return false
    const free = new Set(this.supabaseOrganizations.filter((o) => o.plan === 'free').map((o) => o.id))
    if (!free.has(organizationId)) return false
    const active = this.supabaseProjects.filter((p) => free.has(p.organization_id) && /^ACTIVE/.test(p.status))
    return active.length >= this.supabaseFreeLimit
  }

  /** A person deleting an organization in the dashboard, which the API cannot do. */
  deleteOrganization(id: string): void {
    const index = this.supabaseOrganizations.findIndex((o) => o.id === id)
    if (index >= 0) this.supabaseOrganizations.splice(index, 1)
  }

  /** What a person does on the Marketplace page: accept the terms and install Supabase. */
  acceptMarketplace(options: { createDatabase?: string; organizationId?: string } = {}): void {
    this.marketplaceDone = true
    // The Install dialog can create a database on the spot, named however the person or Vercel
    // chose, and connect it to the linked project. Goal 1 Part B met exactly this: a database
    // named after another project next to a project named cimiento-test-1.
    if (options.createDatabase) {
      const project = [...this.vercelProjects.values()][0]
      if (project) this.installSupabase(project, options.createDatabase, options.organizationId)
    }
  }

  private vercelApi(req: HttpRequest, url: URL): HttpResponse {
    const path = url.pathname
    const method = req.method.toUpperCase()

    if (path === '/v2/teams') return json(200, { teams: this.vercelTeams })
    const domainConfig = /^\/v6\/domains\/([^/]+)\/config$/.exec(path)
    if (domainConfig) return this.v2.vercelDomainConfig(decodeURIComponent(domainConfig[1]))
    const domains = /^\/v(?:9|10)\/projects\/([^/]+)\/domains(?:\/([^/]+))?$/.exec(path)
    if (domains) return this.v2.vercelDomain(decodeURIComponent(domains[1]), method, domains[2] ? decodeURIComponent(domains[2]) : undefined, req.body)
    if (path === '/v1/integrations/git-namespaces') {
      if (url.searchParams.has('teamId')) return json(400, { error: { message: 'specifying `teamId` or `slug` is not supported by this endpoint.' } })
      if (!this.vercelGithubConnected) return json(403, { error: { message: 'No GitHub account connected' } })
      return json(200, [{ id: 101, slug: this.login, name: this.login, ownerType: 'user', installationId: 101, provider: 'github' }])
    }
    if (path === '/v1/integrations/search-repo') {
      if (!this.vercelGithubConnected) return json(403, { error: { message: 'No GitHub account connected' } })
      const query = url.searchParams.get('query') ?? ''
      const visible = [...this.repos.values()]
        .filter((r) => this.githubAppRepos === 'all' || this.githubAppRepos.includes(r.name))
        .filter((r) => r.name.includes(query))
      return json(200, { gitAccount: { slug: this.login }, repos: visible.map((r) => ({ name: r.name, slug: r.name, private: true })) })
    }
    const teamMatch = /^\/v2\/teams\/([^/]+)$/.exec(path)
    if (teamMatch) {
      const team = this.vercelTeams.find((t) => t.id === decodeURIComponent(teamMatch[1]))
      return team ? json(200, { ...team, billing: { plan: team.plan ?? 'hobby' } }) : json(403, { error: { message: 'Not authorized' } })
    }
    if (path === '/v2/integrations/configurations') {
      const wantsSupabase = url.searchParams.get('integrationIdOrSlug') === 'supabase' && url.searchParams.get('installationType') === 'marketplace'
      return json(200, wantsSupabase && this.marketplaceDone ? [{ id: this.supabaseConfigurationId, slug: 'supabase', installationType: 'marketplace' }] : [])
    }
    if (path === '/v1/storage/stores') {
      return json(200, {
        stores: this.stores.map((s) => ({
          id: s.id,
          name: s.name,
          externalResourceId: s.ref,
          product: { slug: 'supabase', integrationConfigurationId: s.cfg },
          projectsMetadata: s.projects.map((name) => ({ name })),
        })),
      })
    }
    if (path.startsWith('/v1/integrations/configuration/') && method === 'DELETE') {
      return json(500, { error: { message: 'FakeCloud: cimiento must never uninstall an integration configuration' } })
    }
    if (path === '/v1/integrations/configurations') {
      return json(200, [
        ...(this.marketplaceDone ? [{ id: 'icfg_fake', slug: 'supabase' }] : []),
        ...(this.inngestInstalled ? [{ id: 'icfg_inngest', slug: 'inngest' }] : []),
      ])
    }

    const patchEnv = /^\/v9\/projects\/([^/]+)\/env\/([^/]+)$/.exec(path)
    if (patchEnv && method === 'DELETE') {
      const project = this.findVercelProject(decodeURIComponent(patchEnv[1]))
      const envs = project ? (this.vercelEnv.get(project.id) ?? []) : []
      const index = envs.findIndex((e) => e.id === decodeURIComponent(patchEnv[2]))
      if (index < 0) return json(404, { error: { message: 'env not found' } })
      envs.splice(index, 1)
      return json(200, {})
    }
    if (patchEnv && method === 'PATCH') {
      const project = this.findVercelProject(decodeURIComponent(patchEnv[1]))
      const entry = project ? (this.vercelEnv.get(project.id) ?? []).find((e) => e.id === decodeURIComponent(patchEnv[2])) : undefined
      if (!entry) return json(404, { error: { message: 'env not found' } })
      entry.value = (req.body as { value: string }).value
      entry.updatedAt = this.now()
      return json(200, { key: entry.key, target: entry.target })
    }

    const oneEnv = /^\/v1\/projects\/([^/]+)\/env\/([^/]+)$/.exec(path)
    if (oneEnv) {
      const project = this.findVercelProject(decodeURIComponent(oneEnv[1]))
      const entry = project ? (this.vercelEnv.get(project.id) ?? []).find((e) => e.id === decodeURIComponent(oneEnv[2])) : undefined
      // As Vercel does: a sensitive value is write only and never comes back.
      if (entry?.type === 'sensitive') return json(200, { key: entry.key, target: entry.target, type: entry.type })
      return entry ? json(200, { key: entry.key, value: entry.value, target: entry.target }) : json(404, { error: { message: 'env not found' } })
    }

    const envMatch = /^\/v(?:9|10)\/projects\/([^/]+)\/env$/.exec(path)
    if (envMatch) {
      const project = this.findVercelProject(decodeURIComponent(envMatch[1]))
      if (!project) return json(404, { error: { message: 'project not found' } })
      if (method === 'GET') return json(200, { envs: this.vercelEnv.get(project.id) ?? [] })
      const body = req.body as { key: string; value: string; target: string[]; gitBranch?: string }
      const envs = this.vercelEnv.get(project.id) ?? []
      // As Vercel does with upsert=true: the same key, targets and branch is written over.
      if (url.searchParams.get('upsert') === 'true') {
        const same = envs.findIndex((e) => e.key === body.key && e.gitBranch === body.gitBranch && e.target.join() === body.target.join())
        if (same >= 0) envs.splice(same, 1)
      }
      envs.push({ id: this.id('env'), key: body.key, value: body.value, target: body.target, ...(body.gitBranch ? { gitBranch: body.gitBranch } : {}), type: 'encrypted', createdAt: this.now() })
      this.vercelEnv.set(project.id, envs)
      return json(200, { key: body.key, target: body.target })
    }

    const linkMatch = /^\/v9\/projects\/([^/]+)\/link$/.exec(path)
    if (linkMatch && method === 'POST') {
      const project = this.findVercelProject(decodeURIComponent(linkMatch[1]))
      if (!project) return json(404, { error: { message: 'project not found' } })
      const repoName = (req.body as { repo?: string }).repo ?? ''
      if (this.vercelGithubConnected && this.githubAppRepos !== 'all' && !this.githubAppRepos.includes(repoName)) {
        return json(400, { error: { message: 'To link a GitHub repository, you need to install the GitHub integration first.' } })
      }
      if (!this.vercelGithubConnected) {
        return json(400, { error: { message: `Failed to link ${project.name}. You need to add a Login Connection to your GitHub account first.` } })
      }
      const body = req.body as { org: string; repo: string; productionBranch?: string }
      project.link = {
        type: 'github',
        org: body.org,
        repo: body.repo,
        productionBranch: body.productionBranch ?? 'main',
      }
      return json(200, this.renderVercelProject(project))
    }

    const projectMatch = /^\/v9\/projects\/([^/]+)$/.exec(path)
    if (projectMatch) {
      const project = this.findVercelProject(decodeURIComponent(projectMatch[1]))
      if (method === 'DELETE') {
        if (project) this.vercelProjects.delete(project.id)
        return json(200, {})
      }
      if (!project) return json(404, { error: { message: 'project not found' } })
      return json(200, this.renderVercelProject(project))
    }

    if (/^\/v(?:9|10)\/projects$/.test(path) && method === 'POST') {
      const body = req.body as { name: string; framework?: string | null }
      if ([...this.vercelProjects.values()].some((p) => p.name === body.name)) {
        return json(409, { error: { message: 'A project with the provided name already exists' } })
      }
      const project: FakeVercelProject = {
        id: this.id('prj'),
        name: body.name,
        accountId: 'team_fake',
        framework: body.framework ?? null,
        link: null,
        productionAlias: null,
        createdAt: Date.now(),
      }
      this.vercelProjects.set(project.id, project)
      // An integration approved for all projects adds its keys to a new project as well.
      if (this.inngestInstalled) this.installInngest()
      return json(200, this.renderVercelProject(project))
    }

    if (/^\/v6\/deployments$/.test(path)) {
      const projectId = url.searchParams.get('projectId') ?? ''
      const project = this.findVercelProject(projectId)
      const list = project ? (this.deployments.get(project.id) ?? []) : []
      const page = list.slice(0, Number(url.searchParams.get('limit') ?? 20)).map((d) => ({ ...d }))
      // A build is seen building once, then it has finished.
      for (const d of list) if (d.readyState === 'BUILDING') d.readyState = this.pushBuild
      return json(200, { deployments: page })
    }

    return json(404, { error: { message: `FakeCloud: no vercel api route for ${path}` } })
  }

  private findVercelProject(idOrName: string): FakeVercelProject | undefined {
    return this.vercelProjects.get(idOrName) ?? [...this.vercelProjects.values()].find((p) => p.name === idOrName)
  }

  private renderVercelProject(project: FakeVercelProject): unknown {
    return {
      id: project.id,
      name: project.name,
      accountId: project.accountId,
      createdAt: project.createdAt,
      framework: project.framework,
      link: project.link,
      targets: project.productionAlias ? { production: { alias: [project.productionAlias] } } : null,
    }
  }

  private supabaseApi(req: HttpRequest, url: URL): HttpResponse {
    const path = url.pathname
    const method = req.method.toUpperCase()

    if (path === '/v1/organizations' && method === 'GET') {
      return json(200, this.supabaseOrganizations.map((o) => ({ id: o.id, slug: o.id, name: o.name })))
    }
    if (path === '/v1/organizations' && method === 'POST') {
      const body = req.body as { name: string }
      const org = { id: this.id('org'), name: body.name, plan: 'free' }
      this.supabaseOrganizations.push(org)
      return json(201, { id: org.id, name: org.name })
    }
    const usage = /^\/v1\/projects\/([^/]+)\/analytics\/endpoints\/usage\.api-counts$/.exec(path)
    if (usage) {
      const project = this.supabaseProjects.find((p) => p.id === decodeURIComponent(usage[1]))
      const rows = project?.lastRequest
        ? [
            { timestamp: '2026-09-19T00:00:00', total_rest_requests: 3, total_auth_requests: 0 },
            { timestamp: `${project.lastRequest}T00:00:00`, total_rest_requests: 1, total_auth_requests: 0 },
          ]
        : [{ timestamp: '2026-09-19T00:00:00', total_rest_requests: 0, total_auth_requests: 0 }]
      return json(200, { result: rows })
    }

    const secretsMatch = /^\/v1\/projects\/([^/]+)\/secrets$/.exec(path)
    if (secretsMatch) {
      const ref = decodeURIComponent(secretsMatch[1])
      const store = this.supabaseSecrets.get(ref) ?? new Map<string, string>()
      this.supabaseSecrets.set(ref, store)
      if (method === 'GET') return json(200, [...store.keys()].map((name) => ({ name, value: 'digest-not-the-value' })))
      if (method === 'POST') {
        for (const s of req.body as { name: string; value: string }[]) {
          if (s.name.startsWith('SUPABASE_')) return json(400, { message: 'Env var name cannot start with SUPABASE_' })
          store.set(s.name, s.value)
        }
        return json(201, {})
      }
      if (method === 'DELETE') {
        for (const name of req.body as string[]) store.delete(name)
        return json(200, {})
      }
    }

    const orgMatch = /^\/v1\/organizations\/([^/]+)$/.exec(path)
    if (orgMatch) {
      const org = this.supabaseOrganizations.find((o) => o.id === decodeURIComponent(orgMatch[1]))
      return org ? json(200, { id: org.id, name: org.name, plan: org.plan }) : json(404, { message: 'not found' })
    }
    if (path === '/v1/projects' && method === 'GET') return json(200, this.supabaseProjects)
    if (path === '/v1/projects' && method === 'POST' && this.overFreeLimit((req.body as { organization_id: string }).organization_id)) {
      return json(400, {
        message:
          'The following organization members have reached their maximum limits for the number of active free projects within organizations where they are an administrator or owner: test-handle (2 project limit).',
      })
    }
    if (path === '/v1/projects' && method === 'POST') {
      const body = req.body as { name: string; organization_id: string; region: string }
      const project: FakeSupabaseProject = {
        id: this.ref(),
        name: body.name,
        organization_id: body.organization_id,
        region: body.region,
        status: 'ACTIVE_HEALTHY',
      }
      this.supabaseProjects.push(project)
      this.supabaseAuth.set(project.id, { site_url: 'http://localhost:3000', uri_allow_list: '' })
      return json(201, project)
    }

    const keys = /^\/v1\/projects\/([^/]+)\/api-keys$/.exec(path)
    if (keys) {
      return json(200, [
        { name: 'anon', api_key: 'fake-anon-key-not-a-real-credential' },
        { name: 'service_role', api_key: 'fake-service-role-key-not-a-real-credential' },
      ])
    }

    const auth = /^\/v1\/projects\/([^/]+)\/config\/auth$/.exec(path)
    if (auth) {
      const ref = decodeURIComponent(auth[1])
      if (method === 'GET') return json(200, this.supabaseAuth.get(ref) ?? { site_url: '', uri_allow_list: '' })
      const body = req.body as { site_url: string; uri_allow_list: string }
      this.supabaseAuth.set(ref, { site_url: body.site_url, uri_allow_list: body.uri_allow_list })
      return json(200, this.supabaseAuth.get(ref))
    }

    const migrations = /^\/v1\/projects\/([^/]+)\/database\/migrations$/.exec(path)
    if (migrations) {
      const ref = decodeURIComponent(migrations[1])
      const list = this.migrations.get(ref) ?? []
      if (method === 'GET') return json(200, list.map(({ version, name }) => ({ version, name })))
      const body = req.body as { name: string; query: string }
      list.push({ version: String(20260925000000 + list.length), name: body.name, query: body.query })
      this.migrations.set(ref, list)
      return json(200, {})
    }

    const query = /^\/v1\/projects\/([^/]+)\/database\/query$/.exec(path)
    if (query) {
      const ref = decodeURIComponent(query[1])
      const sql = (req.body as { query: string }).query
      const table = /from public\.(\w+)/.exec(sql)?.[1]
      const created = (this.migrations.get(ref) ?? []).some((m) => table && m.query.includes(`public.${table}`))
      if (table && !created) return json(400, { message: `relation "public.${table}" does not exist` })
      return json(200, [{ count: table ? 1 : 0 }])
    }

    const project = /^\/v1\/projects\/([^/]+)$/.exec(path)
    if (project && method === 'DELETE') {
      const ref = decodeURIComponent(project[1])
      const index = this.supabaseProjects.findIndex((p) => p.id === ref)
      if (index >= 0) this.supabaseProjects.splice(index, 1)
      return json(200, {})
    }

    return json(404, { message: `FakeCloud: no supabase api route for ${path}` })
  }
}

function ok(stdout: string): ExecResult {
  return { code: 0, stdout, stderr: '' }
}

function fail(stderr: string, code = 1): ExecResult {
  return { code, stdout: '', stderr }
}

function json(status: number, body?: unknown, text?: string, headers?: Record<string, string>): HttpResponse {
  const raw = text ?? (body === undefined ? '' : JSON.stringify(body))
  return { status, ok: status >= 200 && status < 300, text: raw, json: body, ...(headers ? { headers } : {}) }
}
