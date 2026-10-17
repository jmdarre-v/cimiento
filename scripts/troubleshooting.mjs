// Generates docs/TROUBLESHOOTING.md from the knowledge base in src/kb, spec section 13.
// node scripts/troubleshooting.mjs writes it; --check exits 1 when the file is out of date.

import { readdirSync, readFileSync, writeFileSync } from 'node:fs'
import { dirname, join } from 'node:path'
import { fileURLToPath } from 'node:url'
import { parse } from 'yaml'

const root = dirname(dirname(fileURLToPath(import.meta.url)))
const kbDir = join(root, 'src', 'kb')
const target = join(root, 'docs', 'TROUBLESHOOTING.md')

const ORDER = ['core', 'tools', 'secrets', 'scaffold', 'github', 'vercel', 'supabase', 'inngest', 'turnstile', 'anthropic']
const NAMES = {
  core: 'cimiento itself',
  tools: 'Tools and logins',
  secrets: 'Secrets',
  scaffold: 'Starter templates',
  github: 'GitHub',
  vercel: 'Vercel',
  supabase: 'Supabase',
  inngest: 'Inngest',
  turnstile: 'Cloudflare Turnstile',
  anthropic: 'Anthropic',
}

export function render() {
  const entries = readdirSync(kbDir)
    .filter((f) => f.endsWith('.yaml'))
    .sort()
    .flatMap((f) => parse(readFileSync(join(kbDir, f), 'utf8')) ?? [])
  const groups = new Map()
  for (const entry of entries) {
    const key = entry.provider === 'core' && entry.code.startsWith('SESSION_') ? 'tools' : entry.provider
    if (!groups.has(key)) groups.set(key, [])
    groups.get(key).push(entry)
  }
  const keys = [...groups.keys()].sort((a, b) => (ORDER.indexOf(a) + 1 || 99) - (ORDER.indexOf(b) + 1 || 99) || a.localeCompare(b))
  const lines = [
    '# Troubleshooting',
    '',
    'Every error cimiento can report, with what to do about it and why it happens. This file is',
    'generated from the knowledge base in `src/kb` by `node scripts/troubleshooting.mjs`; edit the',
    'yaml, not this file.',
    '',
    'Every error carries its code. `cimiento explain <CODE>` prints a plain explanation (in Spanish',
    'with `--lang es`) followed by the same hint and fix, and `cimiento doctor` shows which step',
    'failed. Exit codes: 0 ok, 1 failed, 2 waiting on a person, 3 blocked.',
    '',
    ...keys.map((k) => `- [${NAMES[k] ?? k}](#${(NAMES[k] ?? k).toLowerCase().replace(/[^a-z0-9 ]/g, '').replace(/ /g, '-')})`),
  ]
  for (const key of keys) {
    lines.push('', `## ${NAMES[key] ?? key}`)
    for (const e of groups.get(key).sort((a, b) => a.code.localeCompare(b.code))) {
      lines.push('', `### ${e.code}`, '', `${e.title.charAt(0).toUpperCase()}${e.title.slice(1)}.`, '', `**What to do:** ${e.hint}`, '', `**Why:** ${e.fix}`)
      if (e.signatures?.length) lines.push('', `**Looks like:** ${e.signatures.map((s) => `\`${s}\``).join(', ')}`)
      if (e.docsUrl) lines.push('', `**More:** <${e.docsUrl}>`)
    }
  }
  return `${lines.join('\n')}\n`
}

if (process.argv[1] === fileURLToPath(import.meta.url)) {
  const text = render()
  if (process.argv.includes('--check')) {
    let current = ''
    try {
      current = readFileSync(target, 'utf8')
    } catch {
      // Missing counts as out of date.
    }
    if (current !== text) {
      process.stderr.write('docs/TROUBLESHOOTING.md is out of date. Run node scripts/troubleshooting.mjs.\n')
      process.exit(1)
    }
    process.exit(0)
  }
  writeFileSync(target, text, 'utf8')
  process.stdout.write(`wrote ${target}\n`)
}
