// The v2 vendors on the fake cloud: Netlify, Neon (API and HTTP SQL), Resend, Stripe, PostHog,
// public DNS over HTTPS and Vercel project domains. Stateful like the rest of FakeCloud, so ensure
// twice is a noop and down leaves nothing. Every value is obviously fake.

import type { ExecResult, HttpRequest, HttpResponse } from '../../src/core/io'

export interface V2Host {
  readonly pages: Map<string, { status: number; body: string }>
  gitSha(): string
  now(): number
}

export interface FakeNetlifySite {
  id: string
  name: string
  account_id: string
  account_slug: string
  ssl_url: string
  admin_url: string
  custom_domain: string | null
  deploy_hook?: string
  build_settings: { repo_path?: string; repo_branch?: string; deploy_key_id?: string; provider?: string; updated_at?: string } | null
  plugins: { package: string }[]
}

export interface FakeNetlifyDeploy {
  id: string
  site_id: string
  state: string
  context: string
  branch: string
  commit_ref: string | null
  deploy_ssl_url: string
  created_at: string
}

interface FakeNeonProject {
  id: string
  name: string
  region_id: string
  org_id?: string
  tables: Set<string>
  migrations: string[]
}

function ok(stdout: string): ExecResult {
  return { code: 0, stdout, stderr: '' }
}

function fail(stderr: string, code = 1): ExecResult {
  return { code, stdout: '', stderr }
}

function json(status: number, body?: unknown): HttpResponse {
  return { status, ok: status >= 200 && status < 300, text: body === undefined ? '' : JSON.stringify(body), json: body }
}

export class FakeV2 {
  netlifyLoggedIn = true
  neonLoggedIn = true
  readonly netlifyAccounts = [{ id: 'acct_fake', slug: 'fake-team', name: 'Fake Team' }]
  readonly netlifySites = new Map<string, FakeNetlifySite>()
  readonly netlifyEnv = new Map<string, { key: string; updated_at: string; values: { id: string; context: string; value: string }[] }[]>()
  readonly netlifyDeploys: FakeNetlifyDeploy[] = []
  /** Adds a site linked the way cimiento did before BUG-61: repository settings, no Next.js runtime. */
  linkWithoutRuntime(siteId: string): void {
    const site = this.netlifySites.get(siteId)!
    site.plugins = []
  }

  /** Site names someone else on Netlify already has. */
  readonly takenSiteNames = new Set<string>()
  /** What a Netlify build ends as. */
  netlifyBuild: 'ready' | 'error' | 'building' = 'ready'
  readonly deployKeys = new Map<string, string[]>()
  readonly repoHooks = new Map<string, string[]>()
  readonly neonOrganizations = [{ id: 'org-fake-neon', name: 'Fake Neon Org' }]
  readonly neonProjects = new Map<string, FakeNeonProject>()
  neonProjectLimit = 10
  readonly resendSent: { from: string; to: string[] }[] = []
  readonly posthogEvents: { event: string; api_key: string }[] = []
  /** Public DNS answers by name and type, as DNS over HTTPS reports them. */
  readonly dns = new Map<string, string>()
  readonly vercelDomains = new Map<string, Set<string>>()
  /** Vercel asks for a TXT record first, as when the apex belongs to another account. */
  vercelTxtChallenge: string | undefined
  private counter = 0

  constructor(private readonly host: V2Host) {}

  private id(prefix: string): string {
    this.counter += 1
    return `${prefix}${String(this.counter).padStart(6, '0')}`
  }

  private iso(): string {
    return new Date(this.host.now()).toISOString()
  }

  // Commands

  exec(cmd: string, args: string[]): ExecResult | undefined {
    if (cmd === 'netlify') {
      if (args[0] === 'login') {
        this.netlifyLoggedIn = true
        return ok('You are now logged into your Netlify account!')
      }
      return ok('')
    }
    if (cmd === 'neonctl') {
      if (args[0] === 'auth') {
        this.neonLoggedIn = true
        return ok('Auth complete')
      }
      if (args[0] === 'me') return this.neonLoggedIn ? ok(JSON.stringify({ email: 'person@example.test', login: 'person' })) : fail('ERROR: Authentication required')
      return ok('')
    }
    return undefined
  }

  /** gh calls Netlify's link makes: deploy keys, the repository id and webhooks. */
  gh(args: string[]): ExecResult | undefined {
    if (args[0] !== 'api') return undefined
    const post = args[1] === '-X' && args[2] === 'POST'
    const path = post ? args[3] : args[1]
    const keys = /^repos\/([^/]+\/[^/]+)\/keys$/.exec(path ?? '')
    if (keys && post) {
      const list = this.deployKeys.get(keys[1]) ?? []
      list.push(args[args.indexOf('-f', args.indexOf('title=Netlify Deploy Key')) + 1] ?? '')
      this.deployKeys.set(keys[1], list)
      return ok('{}')
    }
    const hooks = /^repos\/([^/]+\/[^/]+)\/hooks$/.exec(path ?? '')
    if (hooks) {
      const list = this.repoHooks.get(hooks[1]) ?? []
      if (post) {
        const url = args.find((a) => a.startsWith('config[url]='))?.slice('config[url]='.length) ?? ''
        list.push(url)
        this.repoHooks.set(hooks[1], list)
        return ok('{}')
      }
      return ok(JSON.stringify(list))
    }
    if (/^repos\/[^/]+\/[^/]+$/.test(path ?? '') && args.includes('.id')) return ok('424242\n')
    return undefined
  }

  /** A push builds on Netlify by itself once the site is linked: production on main, a preview otherwise. */
  onPush(repo: string | undefined, branch: string): void {
    for (const site of this.netlifySites.values()) {
      if (!site.build_settings?.repo_path || (repo && site.build_settings.repo_path !== repo)) continue
      const production = branch === (site.build_settings.repo_branch ?? 'main')
      this.addDeploy(site, production ? 'production' : 'deploy-preview', branch, this.host.gitSha())
    }
  }

  private addDeploy(site: FakeNetlifySite, context: string, branch: string, sha: string | null): FakeNetlifyDeploy {
    const deploy: FakeNetlifyDeploy = {
      id: this.id('dep'),
      site_id: site.id,
      state: this.netlifyBuild,
      context,
      branch,
      commit_ref: sha,
      deploy_ssl_url: `https://${this.id('d')}--${site.name}.netlify.app`,
      created_at: this.iso(),
    }
    this.netlifyDeploys.unshift(deploy)
    // Without the Next.js runtime, Netlify publishes the raw .next folder and the page is a 404.
    if (deploy.state === 'ready' && context === 'production') {
      if (site.plugins.some((p) => p.package === '@netlify/plugin-nextjs')) this.servePage(site)
      else this.host.pages.set(site.ssl_url, { status: 404, body: '<title>Page not found</title>' })
    }
    return deploy
  }

  private servePage(site: FakeNetlifySite): void {
    const body = `<html><head><meta name="cimiento-project" content="${site.name}"></head><body>ok</body></html>`
    this.host.pages.set(site.ssl_url, { status: 200, body })
  }

  // HTTP

  http(req: HttpRequest, url: URL): HttpResponse | undefined {
    if (url.hostname === 'api.netlify.com') return this.netlify(req, url)
    if (url.hostname === 'console.neon.tech') return this.neon(req, url)
    if (url.hostname.startsWith('api.') && url.hostname.endsWith('.neon.tech') && url.pathname === '/sql') return this.neonSql(req)
    if (url.hostname === 'api.resend.com') return this.resend(req, url)
    if (url.hostname === 'api.stripe.com') return this.stripe(req, url)
    if (url.hostname.endsWith('.i.posthog.com')) return this.posthog(req)
    if (url.hostname === 'cloudflare-dns.com') {
      const name = url.searchParams.get('name') ?? ''
      const type = url.searchParams.get('type') ?? 'A'
      const value = this.dns.get(`${type} ${name}`)
      return json(200, { Status: 0, Answer: value ? [{ name, type: type === 'CNAME' ? 5 : 1, data: `${value}.` }] : [] })
    }
    return undefined
  }

  private netlifyAuthed(req: HttpRequest): boolean {
    return this.netlifyLoggedIn && Boolean(req.headers?.authorization?.startsWith('Bearer fake-'))
  }

  private netlify(req: HttpRequest, url: URL): HttpResponse {
    if (!this.netlifyAuthed(req)) return json(401, { message: 'Access Denied' })
    const path = url.pathname.replace(/^\/api\/v1/, '')
    const method = req.method.toUpperCase()
    if (path === '/user') return json(200, { id: 'user_fake', email: 'person@example.test', full_name: 'Fake Person' })
    if (path === '/accounts') return json(200, this.netlifyAccounts)
    if (path === '/deploy_keys' && method === 'POST') return json(201, { id: this.id('key'), public_key: 'ssh-ed25519 AAAAfakekeynotreal netlify' })

    const team = /^\/([^/]+)\/sites$/.exec(path)
    if (path === '/sites' || (team && team[1] !== 'sites')) {
      const account = this.netlifyAccounts.find((a) => a.slug === team?.[1]) ?? this.netlifyAccounts[0]
      if (method === 'GET') {
        const name = url.searchParams.get('name') ?? ''
        return json(200, [...this.netlifySites.values()].filter((s) => s.name.includes(name) && s.account_slug === account.slug))
      }
      const name = (req.body as { name: string }).name
      if (this.takenSiteNames.has(name) || [...this.netlifySites.values()].some((s) => s.name === name)) return json(422, { message: 'subdomain must be unique' })
      const site: FakeNetlifySite = {
        id: this.id('site-'),
        name,
        account_id: account.id,
        account_slug: account.slug,
        ssl_url: `https://${name}.netlify.app`,
        admin_url: `https://app.netlify.com/projects/${name}`,
        custom_domain: null,
        build_settings: null,
        plugins: [],
      }
      this.netlifySites.set(site.id, site)
      return json(201, site)
    }
    const builds = /^\/sites\/([^/]+)\/builds$/.exec(path)
    if (builds && method === 'POST') {
      const site = this.netlifySites.get(builds[1])
      if (!site) return json(404, { message: 'Not Found' })
      if (!site.build_settings?.repo_path) return json(422, { message: 'no repository linked' })
      const deploy = this.addDeploy(site, 'production', url.searchParams.get('branch') ?? 'main', this.host.gitSha())
      return json(200, { id: this.id('build'), deploy_id: deploy.id, sha: deploy.commit_ref, done: false })
    }
    const deploys = /^\/sites\/([^/]+)\/deploys$/.exec(path)
    if (deploys) {
      if (!this.netlifySites.has(deploys[1])) return json(404, { message: 'Not Found' })
      let list = this.netlifyDeploys.filter((d) => d.site_id === deploys[1])
      if (url.searchParams.get('production') === 'true') list = list.filter((d) => d.context === 'production')
      return json(200, list)
    }
    const site = /^\/sites\/([^/]+)$/.exec(path)
    if (site) {
      const found = this.netlifySites.get(site[1])
      if (!found) return json(404, { message: 'Not Found' })
      if (method === 'GET') return json(200, found)
      if (method === 'DELETE') {
        this.netlifySites.delete(found.id)
        this.host.pages.delete(found.ssl_url)
        return json(204)
      }
      const body = req.body as { repo?: { repo_path: string; repo_branch: string; deploy_key_id: string }; custom_domain?: string | null; plugins?: { package: string }[] }
      if (body.repo) {
        found.build_settings = { provider: 'github', repo_path: body.repo.repo_path, repo_branch: body.repo.repo_branch, deploy_key_id: body.repo.deploy_key_id, updated_at: this.iso() }
        found.deploy_hook = `https://api.netlify.com/hooks/github`
      }
      if (body.plugins) found.plugins = body.plugins
      if ('custom_domain' in body) {
        if (found.custom_domain && !body.custom_domain) this.host.pages.delete(`https://${found.custom_domain}`)
        found.custom_domain = body.custom_domain ?? null
        if (found.custom_domain) this.refreshDomainPage(found.custom_domain, found.name)
      }
      return json(200, found)
    }
    const env = /^\/accounts\/([^/]+)\/env(?:\/([^/]+))?(?:\/value\/([^/]+))?$/.exec(path)
    if (env) {
      const siteId = url.searchParams.get('site_id') ?? ''
      const list = this.netlifyEnv.get(siteId) ?? []
      this.netlifyEnv.set(siteId, list)
      if (!env[2] && method === 'GET') return json(200, list)
      if (!env[2] && method === 'POST') {
        for (const v of req.body as { key: string; values: { context: string; value: string }[] }[]) {
          if (list.some((e) => e.key === v.key)) return json(409, { message: 'already exists' })
          list.push({ key: v.key, updated_at: this.iso(), values: v.values.map((x) => ({ id: this.id('val'), ...x })) })
        }
        return json(201, req.body)
      }
      const entry = list.find((e) => e.key === env[2])
      if (!entry) return json(404, { message: 'Not Found' })
      if (method === 'PATCH') {
        const { context, value } = req.body as { context: string; value: string }
        const existing = entry.values.find((v) => v.context === context)
        if (existing) existing.value = value
        else entry.values.push({ id: this.id('val'), context, value })
        entry.updated_at = this.iso()
        return json(201, entry)
      }
      if (method === 'DELETE' && env[3]) {
        entry.values = entry.values.filter((v) => v.id !== env[3])
        return json(204)
      }
    }
    return json(404, { message: `fake netlify has no route for ${method} ${path}` })
  }

  /** Values the fake Netlify env holds for a site, by key and context. */
  netlifyValue(siteId: string, key: string, context: string): string | undefined {
    return this.netlifyEnv.get(siteId)?.find((e) => e.key === key)?.values.find((v) => v.context === context)?.value
  }

  private neon(req: HttpRequest, url: URL): HttpResponse {
    if (!this.neonLoggedIn || !req.headers?.authorization?.startsWith('Bearer fake-')) return json(401, { code: 'unauthorized', message: 'authentication required' })
    const path = url.pathname.replace(/^\/api\/v2/, '')
    const method = req.method.toUpperCase()
    if (path === '/users/me/organizations') return json(200, { organizations: this.neonOrganizations })
    if (path === '/projects' && method === 'GET') {
      const search = url.searchParams.get('search') ?? ''
      const org = url.searchParams.get('org_id') ?? undefined
      return json(200, { projects: [...this.neonProjects.values()].filter((p) => p.name.includes(search) && (!org || p.org_id === org)).map(({ tables: _t, migrations: _m, ...p }) => p) })
    }
    if (path === '/projects' && method === 'POST') {
      if (this.neonProjects.size >= this.neonProjectLimit) return json(422, { code: '', message: 'projects limit exceeded' })
      const input = (req.body as { project: { name: string; region_id: string; org_id?: string } }).project
      const project: FakeNeonProject = { id: `fake-neon-${this.id('')}`, name: input.name, region_id: input.region_id, ...(input.org_id ? { org_id: input.org_id } : {}), tables: new Set(), migrations: [] }
      this.neonProjects.set(project.id, project)
      return json(201, { project: { id: project.id, name: project.name, region_id: project.region_id }, databases: [{ name: 'neondb', owner_name: 'neondb_owner' }] })
    }
    const one = /^\/projects\/([^/]+)(\/.*)?$/.exec(path)
    const project = one ? this.neonProjects.get(one[1]) : undefined
    if (!one || !project) return json(404, { code: '', message: 'project not found' })
    const rest = one[2] ?? ''
    if (!rest && method === 'GET') return json(200, { project: { id: project.id, name: project.name, region_id: project.region_id } })
    if (!rest && method === 'DELETE') {
      this.neonProjects.delete(project.id)
      return json(200, { project: { id: project.id } })
    }
    if (rest === '/branches') return json(200, { branches: [{ id: 'br-main', name: 'main', default: true }] })
    if (rest === '/branches/br-main/databases') return json(200, { databases: [{ name: 'neondb', owner_name: 'neondb_owner' }] })
    if (rest === '/connection_uri') {
      const pooled = url.searchParams.get('pooled') === 'true'
      return json(200, { uri: `postgresql://neondb_owner:fake-neon-password@ep-${project.id}${pooled ? '-pooler' : ''}.us-east-2.aws.neon.tech/neondb?sslmode=require` })
    }
    return json(404, { code: '', message: `fake neon has no route for ${method} ${path}` })
  }

  private neonSql(req: HttpRequest): HttpResponse {
    const conn = req.headers?.['neon-connection-string'] ?? ''
    const host = /@ep-(.+?)(-pooler)?\.us-east-2/.exec(conn)?.[1] ?? ''
    const project = this.neonProjects.get(host)
    if (!project) return json(400, { message: 'endpoint not found' })
    const body = req.body as { query?: string; queries?: { query: string }[] }
    const queries = body.queries ? body.queries.map((q) => q.query) : [body.query ?? '']
    const results: { rows: Record<string, unknown>[] }[] = []
    const tables = new Set(project.tables)
    const migrations = [...project.migrations]
    for (const query of queries) {
      const q = query.toLowerCase()
      const created = /create table if not exists public\.(\w+)/.exec(q)
      const selected = /from public\.(\w+)/.exec(q)
      if (created) tables.add(created[1])
      if (/insert into public\.cimiento_migrations/.test(q)) migrations.push(/values \('([^']+)'\)/.exec(query)?.[1] ?? '')
      if (selected && !tables.has(selected[1])) return json(400, { message: `relation "public.${selected[1]}" does not exist`, code: '42P01' })
      if (q.includes('syntax error here')) return json(400, { message: 'syntax error at or near "here"', code: '42601' })
      if (selected?.[1] === 'cimiento_migrations') results.push({ rows: migrations.map((name) => ({ name })) })
      else if (selected?.[1] === 'cimiento_baseline') results.push({ rows: [{ n: '1' }] })
      else results.push({ rows: [] })
    }
    // A batch is one transaction: nothing above is kept unless every statement ran.
    project.tables = tables
    project.migrations = migrations
    return json(200, body.queries ? { results } : { command: 'SELECT', rowCount: results[0].rows.length, rows: results[0].rows, fields: [] })
  }

  private resend(req: HttpRequest, url: URL): HttpResponse {
    if (!req.headers?.['user-agent']) return json(403, { statusCode: 403, name: 'missing_user_agent', message: 'User-Agent header is required' })
    const key = req.headers?.authorization?.replace('Bearer ', '') ?? ''
    if (!key.startsWith('re_fake')) return json(401, { statusCode: 401, name: 'validation_error', message: 'API key is invalid' })
    if (url.pathname !== '/emails') return json(404, {})
    const body = req.body as { from: string; to: string[] }
    if (!/onboarding@resend\.dev/.test(body.from)) return json(403, { statusCode: 403, name: 'validation_error', message: 'The domain is not verified' })
    this.resendSent.push({ from: body.from, to: body.to })
    return json(200, { id: `fake-email-${this.id('')}` })
  }

  private stripe(req: HttpRequest, url: URL): HttpResponse {
    const key = req.headers?.authorization?.replace('Bearer ', '') ?? ''
    if (url.pathname !== '/v1/balance') return json(404, {})
    if (!key.startsWith('sk_test_fake')) return json(401, { error: { type: 'invalid_request_error', message: 'Invalid API Key provided' } })
    return json(200, { object: 'balance', available: [], pending: [], livemode: false })
  }

  private posthog(req: HttpRequest): HttpResponse {
    const body = req.body as { api_key: string; event: string }
    if (!body.api_key || body.api_key.startsWith('phx_')) return json(401, undefined)
    this.posthogEvents.push({ event: body.event, api_key: body.api_key })
    return json(200, { status: 'Ok' })
  }

  /** Vercel's view of a domain's DNS: configured once the CNAME points at Vercel. */
  vercelDomainConfig(domain: string): HttpResponse {
    const pointed = this.dns.get(`CNAME ${domain}`)
    return json(200, {
      misconfigured: !pointed,
      recommendedCNAME: [
        { rank: 2, value: 'cname.vercel-dns.com.' },
        { rank: 1, value: 'fakeproject.vercel-dns-016.com.' },
      ],
      recommendedIPv4: [{ rank: 1, value: ['76.76.21.21'] }],
    })
  }

  /** Vercel project domains, which the main Vercel fake routes here. */
  vercelDomain(projectId: string, method: string, domain: string | undefined, body: unknown): HttpResponse {
    const set = this.vercelDomains.get(projectId) ?? new Set<string>()
    this.vercelDomains.set(projectId, set)
    const name = domain ?? (body as { name?: string })?.name ?? ''
    if (method === 'POST') {
      for (const [id, other] of this.vercelDomains) if (id !== projectId && other.has(name)) return json(409, { error: { code: 'domain_already_in_use', message: 'already in use' } })
      set.add(name)
      this.refreshDomainPage(name, projectId)
      return json(200, { name, verified: true })
    }
    if (method === 'DELETE') {
      set.delete(name)
      this.host.pages.delete(`https://${name}`)
      return json(200, {})
    }
    if (set.has(name) && this.vercelTxtChallenge) {
      const apex = name.split('.').slice(-2).join('.')
      return json(200, { name, verified: false, verification: [{ type: 'TXT', domain: `_vercel.${apex}`, value: this.vercelTxtChallenge, reason: 'pending_domain_verification' }] })
    }
    return set.has(name) ? json(200, { name, verified: true }) : json(404, { error: { code: 'not_found' } })
  }

  /** A custom domain serves the site once it is on the project and its DNS points at the hosting. */
  refreshDomainPage(domain: string, projectName?: string): void {
    const pointed = this.dns.get(`CNAME ${domain}`)
    if (!pointed) return
    this.host.pages.set(`https://${domain}`, { status: 200, body: `<html><head><meta name="cimiento-project" content="${projectName ?? domain}"></head><body>ok</body></html>` })
  }
}
