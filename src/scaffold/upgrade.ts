// cimiento upgrade (Goal 9, BUG-109 to 111): what a project made by an older cimiento lacks next to
// the current scaffold for its template, and what changes stack.yaml needs. cimiento owns some
// files outright (workflows, scripts, the database route, lib helpers); it adds those that are
// missing and replaces those nobody changed, judged by the hashes it recorded when it wrote them in
// .cimiento/scaffold.json or by the hashes of what 0.4.1 wrote. A file the person changed is never
// replaced without asking. .gitignore and package.json are only added to. Everything else in the
// app is the person's and is never touched.

import { createHash } from 'node:crypto'
import { existsSync, readFileSync } from 'node:fs'
import { join } from 'node:path'
import { isMap, isSeq, parseDocument } from 'yaml'
import { completeFragment } from '../manifest/presets'
import { parseManifest, type Manifest, type ManifestInput } from '../manifest/schema'
import { scaffoldFiles } from './index'
import { RETIRED_FILES } from './templates/neon-preview'

export type UpgradeAction = 'add' | 'replace' | 'merge' | 'remove' | 'changed by you' | 'remove from previews'

export interface UpgradeChange {
  path: string
  action: UpgradeAction
  detail: string
  /** The content to write, for add, replace and merge. */
  content?: string
  /** The content cimiento would write, for a file the person changed. */
  proposed?: string
}

export interface UpgradePlan {
  changes: UpgradeChange[]
  manifest: Manifest
  /** Hosting env keys to take out of the preview environment. */
  removeFromPreviews: string[]
}

export const BASELINE_PATH = '.cimiento/scaffold.json'

export function sha256(content: string): string {
  return createHash('sha256').update(content).digest('hex')
}

/** What cimiento 0.4.1 wrote for these files, which an upgrade may replace like its own (BUG-110). */
const EARLIER: Record<string, string[]> = {
  'lib/db.ts': ['a6d8ec48de78817406cbe739b06c50bdc52ded7ffb89329531fa1b9db60b13a0'],
  'lib/neon-preview.mjs': ['fc79e38bea5d45e8c36b7aa9bf62ffba096dfe39fa567730da819f2a1dafd2f0'],
  'lib/neon-preview.d.mts': ['4905b9390258256b370ce2403311320d71c047f8c70469911ac819dc56d1e3c1'],
  'app/api/cimiento/database/route.ts': ['798719506868749be1ee0afd5e7a227482d4fa3fb50f3d452c3e84c78658bd8c'],
  '.github/scripts/preview-database.mjs': ['ef30e94114ec5e3ff8824de00c957babc69f69cde04fd8bce862ba14fd060343'],
  '.github/workflows/preview-database.yml': ['7df2b795cca672007b0506251dcff62703d837d0439dcb55593b54d6e05c508e'],
}

/** The files cimiento owns outright; the person's own files are never in this list. */
function owned(path: string): boolean {
  return /^\.github\//.test(path) || /^app\/api\/cimiento\//.test(path) || /^lib\//.test(path) || path === '.claude/settings.json' || /_cimiento_baseline\.sql$/.test(path)
}

export function readBaseline(dir: string): Record<string, string> {
  try {
    return (JSON.parse(readFileSync(join(dir, BASELINE_PATH), 'utf8')) as { files?: Record<string, string> }).files ?? {}
  } catch {
    return {}
  }
}

function unchangedByPerson(path: string, content: string, baseline: Record<string, string>): boolean {
  const hash = sha256(content)
  return baseline[path] === hash || (EARLIER[path] ?? []).includes(hash)
}

/** stack.yaml as the current cimiento would complete it, with what changed. */
function upgradeStack(raw: string, m: Manifest): { text?: string; details: string[]; removeFromPreviews: string[] } {
  const doc = parseDocument(raw)
  const details: string[] = []
  const removeFromPreviews: string[] = []
  let secrets = doc.get('secrets')
  if (!isSeq(secrets)) {
    doc.set('secrets', doc.createNode([]))
    secrets = doc.get('secrets')
  }
  const seq = secrets as { items: unknown[]; flow?: boolean }
  // secrets: [] is a flow sequence; entries added to it are written as a block list.
  seq.flow = false
  // 0.4.1 sent the Neon key to previews, where it can read the production branch (BUG-110).
  for (const item of seq.items) {
    if (!isMap(item) || item.get('name') !== 'NEON_API_KEY') continue
    const sinks = item.get('sinks')
    if (isSeq(sinks) && sinks.items.some((s) => String((s as { value?: unknown }).value ?? s) === 'hosting')) {
      item.set('sinks', doc.createNode(['ci']))
      details.push('NEON_API_KEY goes to GitHub Actions only, not to previews')
      removeFromPreviews.push('NEON_API_KEY', 'NEON_PROJECT_ID')
    }
  }
  // A template project made from flags by 0.4.0 has scaffold.ci false (BUG-98): no workflows.
  const wantsWorkflow = m.scaffold.template === 'nextjs-app' && m.slots.database === 'neon' && m.slots.repo === 'github'
  if (wantsWorkflow && m.scaffold.ci === false) {
    doc.setIn(['scaffold', 'ci'], true)
    details.push('scaffold.ci true, so the project gets its workflows')
  }
  // What the current cimiento declares for this stack and the file lacks.
  const input = { slots: m.slots, environments: (doc.toJS() as ManifestInput).environments, secrets: m.secrets } as ManifestInput
  const declared = new Set(m.secrets.map((s) => s.name))
  for (const secret of completeFragment(input).secrets ?? []) {
    if (declared.has(secret.name)) continue
    seq.items.push(doc.createNode(secret))
    details.push(`declares ${secret.name} (${secret.sinks?.join(', ')})`)
  }
  return details.length > 0 ? { text: doc.toString(), details, removeFromPreviews } : { details, removeFromPreviews }
}

function mergeGitignore(current: string, wanted: string): string | undefined {
  const have = new Set(current.split('\n').map((l) => l.trim()))
  const missing = wanted.split('\n').filter((l) => l.trim() && !have.has(l.trim()))
  if (missing.length === 0) return undefined
  return `${current.replace(/\n*$/, '\n')}${missing.join('\n')}\n`
}

function mergePackage(current: string, wanted: string): { content: string; added: string[] } | undefined {
  let have: Record<string, Record<string, string>>
  try {
    have = JSON.parse(current) as Record<string, Record<string, string>>
  } catch {
    return undefined
  }
  const want = JSON.parse(wanted) as Record<string, Record<string, string>>
  const added: string[] = []
  for (const field of ['dependencies', 'devDependencies']) {
    for (const [name, version] of Object.entries(want[field] ?? {})) {
      if (have[field]?.[name] !== undefined || have[field === 'dependencies' ? 'devDependencies' : 'dependencies']?.[name] !== undefined) continue
      have[field] = { ...(have[field] ?? {}), [name]: version }
      added.push(name)
    }
  }
  return added.length > 0 ? { content: `${JSON.stringify(have, null, 2)}\n`, added } : undefined
}

export function planUpgrade(dir: string, m: Manifest, raw: string): UpgradePlan {
  const changes: UpgradeChange[] = []
  const stack = upgradeStack(raw, m)
  const manifest = stack.text ? parseManifest(parseDocument(stack.text).toJS(), 'stack.yaml') : m
  if (stack.text) changes.push({ path: 'stack.yaml', action: 'merge', detail: stack.details.join('; '), content: stack.text })

  const baseline = readBaseline(dir)
  const wanted = scaffoldFiles(manifest)
  for (const [path, content] of Object.entries(wanted).sort(([a], [b]) => a.localeCompare(b))) {
    const file = join(dir, path)
    const current = existsSync(file) ? readFileSync(file, 'utf8') : undefined
    if (path === '.gitignore') {
      const merged = current === undefined ? content : mergeGitignore(current, content)
      if (merged !== undefined) changes.push({ path, action: current === undefined ? 'add' : 'merge', detail: 'lines this scaffold ignores', content: merged })
      continue
    }
    if (path === 'package.json') {
      const merged = current === undefined ? undefined : mergePackage(current, content)
      if (merged) changes.push({ path, action: 'merge', detail: `adds ${merged.added.join(', ')}`, content: merged.content })
      continue
    }
    if (!owned(path)) continue
    if (current === undefined) changes.push({ path, action: 'add', detail: 'new in this scaffold', content })
    else if (current === content) continue
    else if (unchangedByPerson(path, current, baseline)) changes.push({ path, action: 'replace', detail: 'cimiento wrote it and nobody changed it', content })
    else changes.push({ path, action: 'changed by you', detail: 'differs from what cimiento wrote; replaced only if you say so', proposed: content })
  }

  // Files the scaffold no longer has, once nothing still imports them.
  const db = changes.find((c) => c.path === 'lib/db.ts')
  const dbAfter = db?.content ?? (existsSync(join(dir, 'lib/db.ts')) ? readFileSync(join(dir, 'lib/db.ts'), 'utf8') : '')
  for (const path of RETIRED_FILES) {
    const file = join(dir, path)
    if (!existsSync(file) || dbAfter.includes('neon-preview')) continue
    const current = readFileSync(file, 'utf8')
    if (unchangedByPerson(path, current, baseline)) changes.push({ path, action: 'remove', detail: 'no longer part of the scaffold' })
  }
  if (stack.removeFromPreviews.length > 0) {
    changes.push({ path: stack.removeFromPreviews.join(', '), action: 'remove from previews', detail: 'previews must not hold a key that can read production' })
  }
  return { changes, manifest, removeFromPreviews: stack.removeFromPreviews }
}

/** The hashes of what cimiento wrote, for the next upgrade to tell its files from the person's. */
export function baselineFor(files: Record<string, string>, previous: Record<string, string> = {}): Record<string, string> {
  const out = { ...previous }
  for (const [path, content] of Object.entries(files)) if (owned(path)) out[path] = sha256(content)
  return Object.fromEntries(Object.entries(out).sort(([a], [b]) => a.localeCompare(b)))
}
