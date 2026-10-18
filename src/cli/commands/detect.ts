// cimiento doctor in a project with no stack.yaml (Goal 6, BUG-80). It only reads: package.json,
// the hosting link files, the Supabase folder and the git remote say which providers the project
// uses, and each provider's own detect says whether its tool is installed and logged in. Nothing
// is written, no stack.yaml and no state; cimiento init is the step that writes.

import { existsSync, readFileSync } from 'node:fs'
import { basename, join } from 'node:path'
import { ExitCode } from '../../core/errors'
import { emptyMachineState, emptyProjectState } from '../../core/state'
import type { Ctx, Detection } from '../../core/types'
import { parseManifest, type ManifestInput } from '../../manifest/schema'
import { buildProviders } from '../../registry'
import { SecretStore } from '../../secrets'
import { ConsoleLogger } from '../../core/logger'
import type { Session } from '../context'

interface Found {
  provider: string
  slot: string
  evidence: string[]
}

/** Dependencies that say a provider is in use. */
const PACKAGES: Record<string, { provider: string; slot: string }> = {
  '@supabase/supabase-js': { provider: 'supabase', slot: 'database' },
  '@supabase/ssr': { provider: 'supabase', slot: 'database' },
  '@neondatabase/serverless': { provider: 'neon', slot: 'database' },
  inngest: { provider: 'inngest', slot: 'jobs' },
  resend: { provider: 'resend', slot: 'email' },
  stripe: { provider: 'stripe', slot: 'payments' },
  '@stripe/stripe-js': { provider: 'stripe', slot: 'payments' },
  'posthog-js': { provider: 'posthog', slot: 'analytics' },
  'posthog-node': { provider: 'posthog', slot: 'analytics' },
  '@anthropic-ai/sdk': { provider: 'anthropic', slot: 'ai' },
  '@marsidev/react-turnstile': { provider: 'turnstile', slot: 'bot_protection' },
}

function readJson(path: string): Record<string, unknown> | undefined {
  try {
    return JSON.parse(readFileSync(path, 'utf8')) as Record<string, unknown>
  } catch {
    return undefined
  }
}

async function findProviders(session: Session): Promise<{ found: Found[]; name: string }> {
  const cwd = session.cwd
  const found = new Map<string, Found>()
  const add = (provider: string, slot: string, evidence: string): void => {
    const entry = found.get(provider) ?? { provider, slot, evidence: [] }
    if (!entry.evidence.includes(evidence)) entry.evidence.push(evidence)
    found.set(provider, entry)
  }
  const pkg = readJson(join(cwd, 'package.json'))
  const deps = { ...((pkg?.dependencies as Record<string, string>) ?? {}), ...((pkg?.devDependencies as Record<string, string>) ?? {}) }
  for (const dep of Object.keys(deps)) {
    const hit = PACKAGES[dep]
    if (hit) add(hit.provider, hit.slot, `package.json depends on ${dep}`)
  }
  if (existsSync(join(cwd, '.vercel', 'project.json'))) add('vercel', 'hosting', '.vercel/project.json links this folder to a Vercel project')
  if (existsSync(join(cwd, 'vercel.json'))) add('vercel', 'hosting', 'vercel.json')
  if (existsSync(join(cwd, 'netlify.toml'))) add('netlify', 'hosting', 'netlify.toml')
  if (existsSync(join(cwd, '.netlify', 'state.json'))) add('netlify', 'hosting', '.netlify/state.json links this folder to a Netlify site')
  if (existsSync(join(cwd, 'supabase', 'config.toml'))) add('supabase', 'database', 'supabase/config.toml')
  const origin = await session.io.exec('git', ['remote', 'get-url', 'origin'], { cwd }).catch(() => undefined)
  const url = origin?.code === 0 ? origin.stdout.trim() : ''
  if (/github\.com[:/]/.test(url)) add('github', 'repo', `git remote origin is ${url.replace(/\.git$/, '')}`)
  const name = typeof pkg?.name === 'string' && pkg.name ? pkg.name : basename(cwd)
  return { found: [...found.values()].sort((a, b) => a.provider.localeCompare(b.provider)), name }
}

export async function detectWithoutManifest(session: Session): Promise<number> {
  const { found, name } = await findProviders(session)
  // A manifest in memory only, so each provider can run its own read only detect.
  const slots: Record<string, string> = {}
  for (const f of found) if (!slots[f.slot]) slots[f.slot] = f.provider
  if (slots.hosting === 'netlify' && !slots.repo) slots.repo = 'github'
  let detections: (Found & { installed?: boolean; version?: string; account?: string })[] = found
  try {
    const manifest = parseManifest({ name, slots: slots as ManifestInput['slots'], secrets: [], accounts: { supabase: 'direct' } })
    const ctx: Ctx = {
      io: session.io,
      manifest,
      state: emptyProjectState(),
      machine: emptyMachineState(),
      cwd: session.cwd,
      lang: session.lang,
      logger: new ConsoleLogger('silent', session.redactor, () => undefined),
      redactor: session.redactor,
      secrets: new SecretStore(manifest, session.redactor, { interactive: false, io: session.io }),
      dryRun: true,
      interactive: false,
    }
    const providers = buildProviders(manifest)
    detections = await Promise.all(
      found.map(async (f) => {
        const provider = providers.find((p) => p.id === f.provider)
        if (!provider || provider.tools.length === 0) return f
        const d: Detection = await provider.detect(ctx).catch(() => ({ installed: false }))
        return { ...f, installed: d.installed, ...(d.version ? { version: d.version } : {}), ...(d.session ? { account: d.session.account } : {}) }
      }),
    )
  } catch {
    // A combination stack.yaml would refuse still gets its evidence listed, without tool checks.
  }
  const hint = 'Nothing was created. cimiento init writes a stack.yaml for this project; then cimiento plan shows what it would add.'
  if (session.json) {
    session.printer.emit({ ok: true, command: 'doctor', manifest: false, name, detected: detections, hint })
  } else {
    session.printer.line(`\nNo stack.yaml here. What this project already uses, read only:`)
    for (const d of detections) {
      const tool = d.installed === undefined ? '' : d.installed ? `, tool ${d.version ?? 'installed'}${d.account ? `, logged in as ${d.account}` : ', not logged in'}` : ', tool not installed'
      session.printer.line(`  ${d.provider} (${d.slot})${tool}: ${d.evidence.join('; ')}`)
    }
    if (detections.length === 0) session.printer.line('  nothing cimiento knows')
    session.printer.line(`\n${hint}`)
  }
  return ExitCode.ok
}
