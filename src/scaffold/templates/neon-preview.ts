// Neon preview databases without cimiento up (Goal 8) and without a Neon key in the preview (Goal 9,
// BUG-105 to 107). The scaffold ships a GitHub Actions workflow that, on every push of a branch
// besides production, makes a Neon branch for it, writes that branch's two addresses into the
// hosting env for that git branch only, and deploys the branch again so the preview is built with
// them; when the git branch is deleted it removes both. The Neon key, scoped to the one project,
// and the hosting token live only in GitHub Actions secrets. The app reads DATABASE_URL and
// nothing else: a preview built before its address exists says so in one sentence and never
// reaches production.

import { hostingOf } from '../../core/hosting'
import type { Manifest } from '../../manifest/schema'

/** The Neon calls the workflow makes, and the branch name cimiento uses too. */
export const NEON_PREVIEW_HELPER = `// Written by cimiento. Makes, reads and removes the Neon branch of a git branch, for
// .github/workflows/preview-database.yml. NEON_API_KEY is a key scoped to this one Neon project,
// which cannot delete the project; NEON_PROJECT_ID names that project, since a scoped key cannot
// list projects. Both live only in GitHub Actions secrets, never in a preview.

const API = process.env.CIMIENTO_NEON_API || 'https://console.neon.tech/api/v2'

/** preview/ and the git branch in lowercase letters, digits and dashes, as cimiento names it. */
export function previewBranchName(gitBranch) {
  const slug = gitBranch.toLowerCase().replace(/[^a-z0-9]+/g, '-').replace(/^-+|-+$/g, '')
  return \`preview/\${slug || 'branch'}\`
}

async function neon(path, init = {}) {
  const key = process.env.NEON_API_KEY
  if (!key) throw new Error('The NEON_API_KEY Actions secret is not set. cimiento up writes it.')
  const res = await fetch(\`\${API}\${path}\`, {
    ...init,
    headers: { authorization: \`Bearer \${key}\`, accept: 'application/json', 'content-type': 'application/json' },
  })
  if (res.status === 404) return undefined
  if (!res.ok) throw new Error(\`Neon answered \${res.status} to \${init.method || 'GET'} \${path.split('?')[0]}.\`)
  return res.json()
}

function projectId() {
  const id = process.env.NEON_PROJECT_ID
  if (!id) throw new Error('The NEON_PROJECT_ID Actions secret is not set. cimiento up writes it.')
  return id
}

let reached = false

/** The key must reach the project; a scoped key answers 404 for any other. */
async function reach() {
  if (reached) return
  if (!(await neon(\`/projects/\${projectId()}\`))) throw new Error(\`NEON_API_KEY cannot reach the Neon project \${projectId()}; cimiento up makes a key scoped to it.\`)
  reached = true
}

async function findBranch(name) {
  await reach()
  const branches = (await neon(\`/projects/\${projectId()}/branches\`))?.branches ?? []
  return branches.find((b) => b.name === name)
}

/** The Neon branch of a git branch, made once. */
export async function ensurePreviewBranch(gitBranch) {
  const name = previewBranchName(gitBranch)
  const found = await findBranch(name)
  if (found) return { name, id: found.id, created: false }
  const made = await neon(\`/projects/\${projectId()}/branches\`, { method: 'POST', body: JSON.stringify({ branch: { name }, endpoints: [{ type: 'read_write' }] }) })
  if (!made?.branch?.id) throw new Error(\`Neon made no branch \${name}.\`)
  return { name, id: made.branch.id, created: true }
}

/** The pooled and direct addresses of a branch. */
export async function branchAddresses(branchId) {
  const db = (await neon(\`/projects/\${projectId()}/branches/\${branchId}/databases\`))?.databases?.[0] ?? { name: 'neondb', owner_name: 'neondb_owner' }
  const address = async (pooled) => {
    const query = new URLSearchParams({ branch_id: branchId, database_name: db.name, role_name: db.owner_name, pooled: String(pooled) })
    const uri = (await neon(\`/projects/\${projectId()}/connection_uri?\${query}\`))?.uri
    if (!uri) throw new Error(\`Neon gave no address for the branch \${branchId}.\`)
    return uri
  }
  return { DATABASE_URL: await address(true), DATABASE_URL_UNPOOLED: await address(false) }
}

/** Removes the Neon branch of a deleted git branch. */
export async function deletePreviewBranch(gitBranch) {
  const name = previewBranchName(gitBranch)
  const found = await findBranch(name)
  if (!found) return { name, deleted: false }
  await neon(\`/projects/\${projectId()}/branches/\${found.id}\`, { method: 'DELETE' })
  return { name, deleted: true }
}
`

const SCRIPT = `// Written by cimiento. Run by .github/workflows/preview-database.yml on every push of a branch
// besides production, and on every deleted branch. It writes only the branch's own addresses into
// the hosting env, for that git branch only, so a preview never holds a Neon key.
import { branchAddresses, deletePreviewBranch, ensurePreviewBranch } from './neon-preview.mjs'

const KEYS = ['DATABASE_URL', 'DATABASE_URL_UNPOOLED']
const branch = process.env.GIT_BRANCH
const hosting = process.env.HOSTING

function need(name) {
  const value = process.env[name]
  if (!value) throw new Error(\`The \${name} Actions secret is not set. cimiento up writes it.\`)
  return value
}

async function call(base, token, path, init = {}) {
  const res = await fetch(\`\${base}\${path}\`, {
    ...init,
    headers: { authorization: \`Bearer \${token}\`, accept: 'application/json', 'content-type': 'application/json' },
  })
  if (!res.ok && res.status !== 404) throw new Error(\`\${hosting} answered \${res.status} to \${init.method || 'GET'} \${path.split('?')[0]}.\`)
  return res.status === 204 || res.status === 404 ? undefined : res.json().catch(() => undefined)
}

const vercel = {
  base: process.env.CIMIENTO_VERCEL_API || 'https://api.vercel.com',
  path(path) {
    return \`\${path}\${path.includes('?') ? '&' : '?'}teamId=\${encodeURIComponent(need('VERCEL_TEAM_ID'))}\`
  },
  request(path, init) {
    return call(this.base, need('VERCEL_TOKEN'), this.path(path), init)
  },
  async entries() {
    const envs = (await this.request(\`/v9/projects/\${need('VERCEL_PROJECT_ID')}/env\`))?.envs ?? []
    return envs.filter((e) => KEYS.includes(e.key) && e.gitBranch === branch)
  },
  async write(values) {
    for (const [key, value] of Object.entries(values)) {
      await this.request(\`/v10/projects/\${need('VERCEL_PROJECT_ID')}/env?upsert=true\`, {
        method: 'POST',
        body: JSON.stringify({ key, value, type: 'encrypted', target: ['preview'], gitBranch: branch }),
      })
    }
  },
  /** Vercel reads env when it starts a build, so the branch is built again with its addresses. */
  async deploy() {
    const project = await this.request(\`/v9/projects/\${need('VERCEL_PROJECT_ID')}\`)
    if (!project?.link?.repoId) throw new Error('The Vercel project is not linked to the repository.')
    await this.request('/v13/deployments', {
      method: 'POST',
      body: JSON.stringify({ name: project.name, project: project.id, gitSource: { type: 'github', repoId: project.link.repoId, ref: branch, sha: process.env.GIT_SHA } }),
    })
  },
  async remove() {
    for (const entry of await this.entries()) await this.request(\`/v9/projects/\${need('VERCEL_PROJECT_ID')}/env/\${entry.id}\`, { method: 'DELETE' })
  },
}

const netlify = {
  base: process.env.CIMIENTO_NETLIFY_API || 'https://api.netlify.com/api/v1',
  request(path, init) {
    return call(this.base, need('NETLIFY_AUTH_TOKEN'), path, init)
  },
  async account() {
    const site = await this.request(\`/sites/\${need('NETLIFY_SITE_ID')}\`)
    if (!site?.account_id) throw new Error('Netlify gave no team for the site.')
    return site.account_id
  },
  async all(account) {
    return (await this.request(\`/accounts/\${account}/env?site_id=\${need('NETLIFY_SITE_ID')}\`)) ?? []
  },
  async entries() {
    const account = await this.account()
    return (await this.all(account)).filter((e) => KEYS.includes(e.key) && (e.values ?? []).some((v) => v.context === 'branch' && v.context_parameter === branch))
  },
  async write(values) {
    const account = await this.account()
    const existing = await this.all(account)
    const site = need('NETLIFY_SITE_ID')
    for (const [key, value] of Object.entries(values)) {
      const entry = { context: 'branch', context_parameter: branch, value }
      if (existing.some((e) => e.key === key)) await this.request(\`/accounts/\${account}/env/\${key}?site_id=\${site}\`, { method: 'PATCH', body: JSON.stringify(entry) })
      else await this.request(\`/accounts/\${account}/env?site_id=\${site}\`, { method: 'POST', body: JSON.stringify([{ key, values: [entry] }]) })
    }
  },
  /** Netlify reads env when it builds, so the branch is built again with its addresses. */
  async deploy() {
    await this.request(\`/sites/\${need('NETLIFY_SITE_ID')}/builds?branch=\${encodeURIComponent(branch)}\`, { method: 'POST' })
  },
  async remove() {
    const account = await this.account()
    for (const entry of await this.all(account)) {
      if (!KEYS.includes(entry.key)) continue
      for (const v of entry.values ?? []) {
        if (v.context !== 'branch' || v.context_parameter !== branch) continue
        await this.request(\`/accounts/\${account}/env/\${entry.key}/value/\${v.id}?site_id=\${need('NETLIFY_SITE_ID')}\`, { method: 'DELETE' })
      }
    }
  },
}

try {
  if (!branch) throw new Error('GIT_BRANCH is not set.')
  const host = hosting === 'netlify' ? netlify : hosting === 'vercel' ? vercel : undefined
  if (!host) throw new Error(\`HOSTING is \${hosting}, not vercel or netlify.\`)
  if (process.env.EVENT === 'delete') {
    await host.remove()
    const { name, deleted } = await deletePreviewBranch(branch)
    console.log(\`Removed the database address of \${branch}. \${deleted ? \`Deleted the Neon branch \${name}.\` : \`No Neon branch \${name}.\`}\`)
  } else {
    const { name, id, created } = await ensurePreviewBranch(branch)
    console.log(created ? \`Created the Neon branch \${name}.\` : \`The Neon branch \${name} already exists.\`)
    if ((await host.entries()).length < KEYS.length) {
      await host.write(await branchAddresses(id))
      await host.deploy()
      console.log(\`Wrote the database address for \${branch} only, and deployed it again.\`)
    } else {
      console.log(\`The database address for \${branch} is already in place.\`)
    }
  }
} catch (err) {
  console.error(err instanceof Error ? err.message : String(err))
  process.exit(1)
}
`

function workflow(m: Manifest): string {
  const production = m.options.github.defaultBranch
  const hosting = hostingOf(m) ?? 'vercel'
  const hostSecrets =
    hosting === 'netlify'
      ? `          NETLIFY_AUTH_TOKEN: \${{ secrets.NETLIFY_AUTH_TOKEN }}
          NETLIFY_SITE_ID: \${{ secrets.NETLIFY_SITE_ID }}`
      : `          VERCEL_TOKEN: \${{ secrets.VERCEL_TOKEN }}
          VERCEL_PROJECT_ID: \${{ secrets.VERCEL_PROJECT_ID }}
          VERCEL_TEAM_ID: \${{ secrets.VERCEL_TEAM_ID }}`
  return `name: preview database

# Written by cimiento. Every git branch besides ${production} gets its own Neon branch, made on push
# and deleted with the git branch. Only that branch's address goes into the hosting env, for that
# git branch only; the keys below stay in GitHub Actions.

on:
  push:
    branches-ignore: [${production}]
  delete:

permissions:
  contents: read

concurrency:
  group: preview-database-\${{ github.event.ref || github.ref }}

jobs:
  branch:
    if: github.event_name == 'push' || github.event.ref_type == 'branch'
    runs-on: ubuntu-latest
    steps:
      - uses: actions/checkout@v4
      - uses: actions/setup-node@v4
        with:
          node-version: 22
      - name: Make or remove the preview database
        env:
          HOSTING: ${hosting}
          NEON_API_KEY: \${{ secrets.NEON_API_KEY }}
          NEON_PROJECT_ID: \${{ secrets.NEON_PROJECT_ID }}
${hostSecrets}
          EVENT: \${{ github.event_name }}
          GIT_BRANCH: \${{ github.event_name == 'delete' && github.event.ref || github.ref_name }}
          GIT_SHA: \${{ github.sha }}
        run: node .github/scripts/preview-database.mjs
`
}

const DB = `// Written by cimiento. This deployment's own database: DATABASE_URL and nothing else. A preview
// gets it from the preview database workflow, for its git branch only; one built before that says
// so, and never falls back to the production database.
import { neon } from '@neondatabase/serverless'

/** The git branch of this preview, or undefined outside a preview. */
export function previewGitBranch(): string | undefined {
  if (process.env.VERCEL_ENV === 'preview') return process.env.VERCEL_GIT_COMMIT_REF
  if (process.env.CONTEXT === 'deploy-preview' || process.env.CONTEXT === 'branch-deploy') return process.env.BRANCH || process.env.HEAD
  return undefined
}

export function databaseUrl(): string {
  const url = process.env.DATABASE_URL
  if (url) return url
  const branch = previewGitBranch()
  if (branch) {
    throw new Error(
      \`No database for the preview of \${branch} yet. The preview database workflow in GitHub Actions makes its Neon branch, writes its address for this branch only and deploys it again; open that newer preview once it is ready. This preview never falls back to the production database.\`,
    )
  }
  throw new Error('DATABASE_URL is not set. Run cimiento env pull for local development, or cimiento doctor.')
}

export async function sql() {
  return neon(databaseUrl())
}
`

const ROUTE = `// Written by cimiento. Says which database this deployment reads, by the Neon endpoint name only,
// proves it answers, and says whether a Neon API key is within its reach. The address itself is
// never shown.
import { NextResponse } from 'next/server'
import { databaseUrl, previewGitBranch, sql } from '@/lib/db'

export const dynamic = 'force-dynamic'

export async function GET() {
  const neonKeyInEnv = Boolean(process.env.NEON_API_KEY)
  const branch = previewGitBranch() ?? null
  try {
    const endpoint = new URL(databaseUrl()).hostname.split('.')[0].replace(/-pooler$/, '')
    // The query function first, then the tagged query: Next.js compiled an awaited call used as
    // a template tag into a call on the promise itself (BUG-104).
    const query = await sql()
    const rows = (await query\`select count(*)::int as count from public.cimiento_baseline\`) as { count: number }[]
    return NextResponse.json({ ok: true, branch, endpoint, rows: rows[0]?.count ?? 0, neonKeyInEnv })
  } catch (err) {
    return NextResponse.json({ ok: false, branch, error: err instanceof Error ? err.message : String(err), neonKeyInEnv }, { status: 503 })
  }
}
`

/** The files, for a nextjs-app with Neon, a GitHub repository, hosting and previews of their own. */
export function neonPreviewFiles(m: Manifest): Record<string, string> {
  return {
    'lib/db.ts': DB,
    'app/api/cimiento/database/route.ts': ROUTE,
    '.github/scripts/neon-preview.mjs': NEON_PREVIEW_HELPER,
    '.github/scripts/preview-database.mjs': SCRIPT,
    '.github/workflows/preview-database.yml': workflow(m),
  }
}

/** Files earlier versions wrote that this scaffold no longer has: cimiento upgrade removes them. */
export const RETIRED_FILES = ['lib/neon-preview.mjs', 'lib/neon-preview.d.mts']
