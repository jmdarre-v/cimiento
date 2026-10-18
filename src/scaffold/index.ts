// The scaffold. Writes the starter template plus every generated file spec section 11 lists.

import { parseHostingEnvId } from '../core/sink-ids'
import { existsSync, mkdirSync, readdirSync, writeFileSync } from 'node:fs'
import { dirname, join } from 'node:path'
import { CimientoError } from '../core/errors'
import type { Receipt } from '../core/executor'
import type { ResourceSpec } from '../core/types'
import type { Manifest } from '../manifest/schema'
import { nextjsAppFiles } from './templates/nextjs-app'
import { designerSiteFiles } from './templates/designer-site'

export { BASELINE_FILE, BASELINE_SQL, BASELINE_TABLE, MARKER_NAME } from './templates/nextjs-app'

export interface ScaffoldOptions {
  /** Binding and secret names that belong in .env.example, values never included. */
  envNames?: string[]
  force?: boolean
}

export function scaffoldFiles(m: Manifest, options: ScaffoldOptions = {}): Record<string, string> {
  const files: Record<string, string> = {}

  if (m.scaffold.template === 'nextjs-app') {
    Object.assign(files, nextjsAppFiles(m))
  } else if (m.scaffold.template === 'designer-site') {
    Object.assign(files, designerSiteFiles(m))
  } else if (m.scaffold.template !== 'none') {
    throw new CimientoError({
      code: 'SCAFFOLD_TEMPLATE_UNKNOWN',
      provider: 'scaffold',
      resource: 'scaffold.template',
      message: `No template named ${m.scaffold.template} in this build.`,
      hint: 'Use scaffold.template: nextjs-app, designer-site, or none.',
      retryable: false,
      needsHuman: true,
    })
  }

  files['.gitignore'] = gitignore()
  files['.env.example'] = envExample(m, options.envNames ?? [])
  files['.claude/settings.json'] = claudeSettings()
  files['README.md'] = readme(m, [])

  if (m.scaffold.claude_md) files['CLAUDE.md'] = claudeMd(m)
  if (m.scaffold.ci && m.slots.database !== 'none') {
    files['.github/workflows/migrations.yml'] = migrationsWorkflow(m)
  }

  return files
}

export function writeScaffold(dir: string, files: Record<string, string>, options: ScaffoldOptions = {}): string[] {
  if (!options.force && existsSync(dir) && readdirSync(dir).length > 0) {
    throw new CimientoError({
      code: 'SCAFFOLD_TARGET_EXISTS',
      provider: 'scaffold',
      resource: dir,
      message: `${dir} already exists and is not empty.`,
      hint: 'Pick another name, or run cimiento init inside the folder you already have. cimiento never writes over work that is already there.',
      retryable: false,
      needsHuman: true,
    })
  }
  const written: string[] = []
  for (const [relative, content] of Object.entries(files)) {
    const path = join(dir, relative)
    mkdirSync(dirname(path), { recursive: true })
    writeFileSync(path, content, 'utf8')
    written.push(relative)
  }
  return written.sort()
}

function gitignore(): string {
  return `node_modules/
.next/
dist/
.env*
!.env.example
.cimiento/cache
design/exports/*.zip
*.log
.DS_Store
.vercel
`
}

/** Names only. A value never reaches this file, and the file is gitignored anyway. */
export function envExample(m: Manifest, extraNames: string[]): string {
  const names = new Set<string>(extraNames)
  for (const secret of m.secrets) names.add(secret.name)
  if (m.slots.database === 'supabase' || m.slots.auth === 'supabase') {
    names.add('NEXT_PUBLIC_SUPABASE_URL')
    names.add('NEXT_PUBLIC_SUPABASE_ANON_KEY')
    names.add('SUPABASE_SERVICE_ROLE_KEY')
  }
  if (m.slots.jobs === 'inngest') {
    names.add('INNGEST_EVENT_KEY')
    names.add('INNGEST_SIGNING_KEY')
  }
  if (m.slots.bot_protection === 'turnstile') {
    names.add('NEXT_PUBLIC_TURNSTILE_SITE_KEY')
    names.add('TURNSTILE_SECRET_KEY')
  }
  const header = [
    '# Names only. cimiento never writes a value into this file.',
    '# Run cimiento env pull to get a filled .env.local, which is gitignored.',
    '',
  ]
  const lines = [...names].sort().map((name) => `${name}=`)
  return `${[...header, ...lines].join('\n')}\n`
}

function claudeSettings(): string {
  return `${JSON.stringify(
    {
      permissions: {
        deny: ['Read(./.env)', 'Read(./.env.*)', 'Read(**/.env)', 'Read(**/.env.*)'],
      },
    },
    null,
    2,
  )}\n`
}

export function claudeMd(m: Manifest): string {
  const slots = Object.entries(m.slots)
    .filter(([, provider]) => provider !== 'none')
    .map(([slot, provider]) => `- ${slot}: ${provider}`)
    .join('\n')
  return `# ${m.name}

This project's environment is managed by cimiento. \`stack.yaml\` declares what it should have and
\`.cimiento/state.json\` records what exists. Both are committed.

## Stack

${slots || '- nothing selected yet'}

## Commands

\`\`\`
cimiento plan
cimiento up
cimiento doctor
cimiento dev
cimiento join
cimiento env pull
cimiento secret set NAME
cimiento secret rotate NAME
\`\`\`

\`cimiento dev\` starts the local database, the jobs dev server and the app on fixed ports, and one
Ctrl+C stops all of them. \`cimiento join\` sets up a fresh clone on a new machine.

## Secrets

Secrets go through \`cimiento secret set NAME\`. Never paste a key into chat, into a file, into a
commit message or into a log line. cimiento prompts with hidden input, pushes the value to every
declared sink, and keeps no copy. \`.env*\` is gitignored and denied to Claude Code by
\`.claude/settings.json\`.

If a value is missing, the fix is \`cimiento secret set NAME\`, never writing it down here.

${
    m.scaffold.template === 'designer-site'
      ? `## Design

The design lives in \`design/\`: Claude Design exports go in \`design/exports/\` (gitignored) and the
unzipped export the site is built from in \`design/current/\`. When asked to update the site from
the design, rebuild \`app/page.tsx\` from \`design/current/\` and keep the cimiento-project meta tag
in \`app/layout.tsx\`, which \`cimiento doctor\` checks on the live page.

`
      : ''
  }## Rules

- Change the environment by editing \`stack.yaml\` and running \`cimiento up\`, not by clicking in a
  dashboard. A dashboard change makes \`cimiento doctor\` report drift.
- Run \`cimiento doctor\` before asking why something is broken. It tells you which item failed and
  what to do about it.
`
}

export function readme(m: Manifest, receipts: Receipt[]): string {
  const rows = receipts
    .filter((r) => r.url || r.externalId)
    .map((r) => `| \`${r.id}\` | ${r.url ? `<${r.url}>` : ''} | ${r.externalId ?? ''} |`)
  const receiptsSection = rows.length
    ? ['| Resource | URL | Id |', '|---|---|---|', ...rows].join('\n')
    : 'Nothing yet. Run `cimiento up`, and this section fills with one row per resource.'

  return `# ${m.name}

Set up with [cimiento](https://github.com/jmdarre-v/cimiento).

## Getting started

\`\`\`bash
cimiento join
cimiento dev
\`\`\`

\`join\` installs the tools, logs in, verifies access to everything in \`.cimiento/state.json\` and
writes \`.env.local\`. \`dev\` starts the local services and the app at http://localhost:3000.

## Environment

\`stack.yaml\` declares what this project needs. \`cimiento plan\` shows the difference between that
and reality, \`cimiento up\` closes it, and \`cimiento doctor\` proves the result still works.

Secrets go through \`cimiento secret set NAME\`. They never live in this repository.

## Receipts

${receiptsSection}
`
}

function migrationsWorkflow(m: Manifest): string {
  return `name: migrations

on:
  push:
    branches: [${m.options.github.defaultBranch}]
    paths:
      - '${m.options.supabase.migrations}/**'

jobs:
  apply:
    runs-on: ubuntu-latest
    steps:
      - uses: actions/checkout@v4
      - uses: supabase/setup-cli@v1
        with:
          version: latest
      - name: Apply migrations
        env:
          SUPABASE_ACCESS_TOKEN: \${{ secrets.SUPABASE_ACCESS_TOKEN }}
          SUPABASE_PROJECT_REF: \${{ secrets.SUPABASE_PROJECT_REF }}
        run: |
          supabase link --project-ref "$SUPABASE_PROJECT_REF"
          supabase db push --linked
`
}

/** Rewrites the Receipts section of an existing README after a successful up. */
export function readmeWithReceipts(existing: string, m: Manifest, receipts: Receipt[]): string {
  const fresh = readme(m, receipts)
  const marker = '## Receipts'
  const index = existing.indexOf(marker)
  if (index < 0) return `${existing.trimEnd()}\n\n${fresh.slice(fresh.indexOf(marker))}`
  return `${existing.slice(0, index)}${fresh.slice(fresh.indexOf(marker))}`
}

/** Binding names a plan will write into the hosting env store, for .env.example. */
export function bindingEnvNames(specs: ResourceSpec[]): string[] {
  const names = new Set<string>()
  for (const spec of specs) {
    const key = parseHostingEnvId(spec.id)?.key
    if (key) names.add(key)
  }
  return [...names].sort()
}
