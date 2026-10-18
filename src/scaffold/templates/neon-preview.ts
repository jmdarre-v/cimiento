// Neon preview databases without cimiento up (Goal 8, BUG-94, BUG-95). The scaffold ships a GitHub
// Actions workflow that makes a Neon branch for every git branch besides production on push and
// deletes it when the git branch is deleted, with a key scoped to the one Neon project. The app
// finds the branch for its own preview at request time with the same key, so the race between the
// build and the workflow does not matter. A preview whose branch does not exist yet fails with
// one clear sentence; nothing falls back to the production database, because previews have no
// DATABASE_URL of their own unless cimiento up wrote one for that branch.

import type { Manifest } from '../../manifest/schema'

/** The one helper the workflow script and the app share, so both use the same branch name. */
export const NEON_PREVIEW_HELPER = `// Written by cimiento. Finds, makes and removes the Neon branch a preview reads. The workflow in
// .github/workflows/preview-database.yml and lib/db.ts both use it, so they agree on the name.
// NEON_API_KEY is a key scoped to this one Neon project, which cannot delete the project, and
// NEON_PROJECT_ID names that project: a scoped key cannot list projects to find it.

const API = process.env.CIMIENTO_NEON_API || 'https://console.neon.tech/api/v2'

/** preview/ and the git branch in lowercase letters, digits and dashes, as cimiento names it. */
export function previewBranchName(gitBranch) {
  const slug = gitBranch.toLowerCase().replace(/[^a-z0-9]+/g, '-').replace(/^-+|-+$/g, '')
  return \`preview/\${slug || 'branch'}\`
}

async function neon(path, init = {}) {
  const key = process.env.NEON_API_KEY
  if (!key) throw new Error('NEON_API_KEY is not set, so this preview cannot find its database. cimiento up writes it for previews.')
  const res = await fetch(\`\${API}\${path}\`, {
    ...init,
    headers: { authorization: \`Bearer \${key}\`, accept: 'application/json', 'content-type': 'application/json' },
  })
  if (res.status === 404) return undefined
  if (!res.ok) throw new Error(\`Neon answered \${res.status} to \${init.method || 'GET'} \${path.split('?')[0]}.\`)
  return res.json()
}

/** This app's Neon project, which the key must reach. */
export async function previewProject() {
  const projectId = process.env.NEON_PROJECT_ID
  if (!projectId) throw new Error('NEON_PROJECT_ID is not set, so this preview cannot find its database. cimiento up writes it for previews.')
  if (!(await neon(\`/projects/\${encodeURIComponent(projectId)}\`))) {
    throw new Error(\`NEON_API_KEY cannot reach the Neon project \${projectId}; cimiento up makes a key scoped to it.\`)
  }
  return projectId
}

async function findBranch(projectId, name) {
  const branches = (await neon(\`/projects/\${projectId}/branches\`))?.branches ?? []
  return branches.find((b) => b.name === name)
}

/** The address of this git branch's own database. It never returns production's. */
export async function previewDatabaseUrl(gitBranch) {
  const projectId = await previewProject()
  const name = previewBranchName(gitBranch)
  const branch = await findBranch(projectId, name)
  if (!branch) {
    throw new Error(
      \`No Neon branch \${name} for the preview of \${gitBranch} yet. The preview database workflow in GitHub Actions makes it on every push; reload once it has run. This preview never falls back to the production database.\`,
    )
  }
  const db = (await neon(\`/projects/\${projectId}/branches/\${branch.id}/databases\`))?.databases?.[0] ?? { name: 'neondb', owner_name: 'neondb_owner' }
  const query = new URLSearchParams({ branch_id: branch.id, database_name: db.name, role_name: db.owner_name, pooled: 'true' })
  const uri = (await neon(\`/projects/\${projectId}/connection_uri?\${query}\`))?.uri
  if (!uri) throw new Error(\`Neon gave no address for \${name}.\`)
  return { url: uri, branch: name }
}

/** Makes the branch for a git branch, once. */
export async function createPreviewBranch(gitBranch) {
  const projectId = await previewProject()
  const name = previewBranchName(gitBranch)
  if (await findBranch(projectId, name)) return { name, created: false }
  await neon(\`/projects/\${projectId}/branches\`, { method: 'POST', body: JSON.stringify({ branch: { name }, endpoints: [{ type: 'read_write' }] }) })
  return { name, created: true }
}

/** Removes the branch of a git branch that was deleted. */
export async function deletePreviewBranch(gitBranch) {
  const projectId = await previewProject()
  const name = previewBranchName(gitBranch)
  const branch = await findBranch(projectId, name)
  if (!branch) return { name, deleted: false }
  await neon(\`/projects/\${projectId}/branches/\${branch.id}\`, { method: 'DELETE' })
  return { name, deleted: true }
}
`

const HELPER_TYPES = `// Types for neon-preview.mjs, written by cimiento.
export function previewBranchName(gitBranch: string): string
export function previewProject(): Promise<string>
export function previewDatabaseUrl(gitBranch: string): Promise<{ url: string; branch: string }>
export function createPreviewBranch(gitBranch: string): Promise<{ name: string; created: boolean }>
export function deletePreviewBranch(gitBranch: string): Promise<{ name: string; deleted: boolean }>
`

const SCRIPT = `// Written by cimiento. Run by .github/workflows/preview-database.yml on every push of a branch
// besides production, and on every deleted branch.
import { createPreviewBranch, deletePreviewBranch } from '../../lib/neon-preview.mjs'

const branch = process.env.GIT_BRANCH
if (!branch) {
  console.error('GIT_BRANCH is not set.')
  process.exit(1)
}
try {
  if (process.env.EVENT === 'delete') {
    const { name, deleted } = await deletePreviewBranch(branch)
    console.log(deleted ? \`Deleted the Neon branch \${name}.\` : \`No Neon branch \${name}; nothing to delete.\`)
  } else {
    const { name, created } = await createPreviewBranch(branch)
    console.log(created ? \`Created the Neon branch \${name}.\` : \`The Neon branch \${name} already exists.\`)
  }
} catch (err) {
  console.error(err instanceof Error ? err.message : String(err))
  process.exit(1)
}
`

function workflow(m: Manifest): string {
  const production = m.options.github.defaultBranch
  return `name: preview database

# Written by cimiento. Every git branch besides ${production} gets its own Neon branch, made on push
# and deleted with the git branch, so its preview never reads the production database.

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
      - name: Make or remove the Neon branch
        env:
          NEON_API_KEY: \${{ secrets.NEON_API_KEY }}
          NEON_PROJECT_ID: \${{ secrets.NEON_PROJECT_ID }}
          EVENT: \${{ github.event_name }}
          GIT_BRANCH: \${{ github.event_name == 'delete' && github.event.ref || github.ref_name }}
        run: node .github/scripts/preview-database.mjs
`
}

const DB = `// Written by cimiento. The address of this deployment's own database: DATABASE_URL when the
// environment has one (production, development, or a preview branch cimiento up wrote), else, on
// a preview, the Neon branch the preview database workflow made for this git branch. There is no
// other fallback, so a preview never reads the production database.
import { neon } from '@neondatabase/serverless'
import { previewDatabaseUrl } from './neon-preview.mjs'

export interface Database {
  url: string
  source: 'env' | 'preview branch'
  branch?: string
}

/** The git branch of this preview, or undefined outside a preview. */
export function previewGitBranch(): string | undefined {
  if (process.env.VERCEL_ENV === 'preview') return process.env.VERCEL_GIT_COMMIT_REF
  if (process.env.CONTEXT === 'deploy-preview' || process.env.CONTEXT === 'branch-deploy') return process.env.BRANCH || process.env.HEAD
  return undefined
}

let resolved: Promise<Database> | undefined

export function database(): Promise<Database> {
  if (!resolved) {
    resolved = (async (): Promise<Database> => {
      if (process.env.DATABASE_URL) return { url: process.env.DATABASE_URL, source: 'env' }
      const branch = previewGitBranch()
      if (!branch) throw new Error('DATABASE_URL is not set. Run cimiento env pull for local development, or cimiento doctor.')
      const found = await previewDatabaseUrl(branch)
      return { url: found.url, source: 'preview branch', branch: found.branch }
    })()
    // A preview whose branch did not exist yet looks again on the next request.
    resolved.catch(() => {
      resolved = undefined
    })
  }
  return resolved
}

export async function sql() {
  return neon((await database()).url)
}
`

const ROUTE = `// Written by cimiento. Says which database this deployment reads, by the Neon endpoint name only,
// and proves it answers. cimiento's field tests read it; the address itself is never shown.
import { NextResponse } from 'next/server'
import { database, sql } from '@/lib/db'

export const dynamic = 'force-dynamic'

export async function GET() {
  try {
    const db = await database()
    // The query function first, then the tagged query: Next.js compiled an awaited call used as
    // a template tag into a call on the promise itself (BUG-104).
    const query = await sql()
    const rows = (await query\`select count(*)::int as count from public.cimiento_baseline\`) as { count: number }[]
    const endpoint = new URL(db.url).hostname.split('.')[0].replace(/-pooler$/, '')
    return NextResponse.json({ ok: true, source: db.source, branch: db.branch ?? null, endpoint, rows: rows[0]?.count ?? 0 })
  } catch (err) {
    return NextResponse.json({ ok: false, error: err instanceof Error ? err.message : String(err) }, { status: 503 })
  }
}
`

/** The files, for a nextjs-app with Neon, a GitHub repository, hosting and previews of their own. */
export function neonPreviewFiles(m: Manifest): Record<string, string> {
  return {
    'lib/neon-preview.mjs': NEON_PREVIEW_HELPER,
    'lib/neon-preview.d.mts': HELPER_TYPES,
    'lib/db.ts': DB,
    'app/api/cimiento/database/route.ts': ROUTE,
    '.github/scripts/preview-database.mjs': SCRIPT,
    '.github/workflows/preview-database.yml': workflow(m),
  }
}
