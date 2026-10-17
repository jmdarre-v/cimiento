// The knowledge base, spec section 13. Known failure signatures mapped to a code, a hint and a
// fix. Every CimientoError code this build can emit has an entry, which a unit test enforces.

import { existsSync, readFileSync, readdirSync } from 'node:fs'
import { join } from 'node:path'
import { parse as parseYaml } from 'yaml'
import { ERROR_CODES } from '../core/errors'

export interface KbEntry {
  code: string
  provider: string
  title: string
  signatures: string[]
  hint: string
  fix: string
  docsUrl?: string
  /** Where a field test first surfaced this, per spec section 13. */
  seen?: string
}

let cache: KbEntry[] | undefined

function kbDir(): string {
  // Runs from dist/kb after a build and from src/kb under vitest.
  const here = __dirname
  if (existsSync(join(here, 'core.yaml'))) return here
  const fromSrc = join(here, '..', '..', 'src', 'kb')
  if (existsSync(join(fromSrc, 'core.yaml'))) return fromSrc
  return here
}

export function loadKb(): KbEntry[] {
  if (cache) return cache
  const dir = kbDir()
  const entries: KbEntry[] = []
  if (existsSync(dir)) {
    for (const file of readdirSync(dir).sort()) {
      if (!file.endsWith('.yaml')) continue
      const parsed = parseYaml(readFileSync(join(dir, file), 'utf8')) as KbEntry[] | null
      if (!Array.isArray(parsed)) continue
      for (const entry of parsed) {
        entries.push({ ...entry, signatures: entry.signatures ?? [] })
      }
    }
  }
  cache = entries
  return entries
}

export function lookupCode(code: string): KbEntry | undefined {
  return loadKb().find((entry) => entry.code === code)
}

/** Matches raw vendor output against known signatures, newest knowledge first. */
export function matchSignature(text: string): KbEntry | undefined {
  const haystack = text.toLowerCase()
  for (const entry of loadKb()) {
    for (const signature of entry.signatures) {
      if (haystack.includes(signature.toLowerCase())) return entry
    }
  }
  return undefined
}

/** Codes declared in errors.ts that have no knowledge base entry. The test asserts this is empty. */
export function missingCodes(): string[] {
  const known = new Set(loadKb().map((entry) => entry.code))
  return ERROR_CODES.filter((code) => !known.has(code))
}

/** Entries whose code is not declared in errors.ts, which means the code was renamed. */
export function orphanEntries(): string[] {
  const declared = new Set<string>(ERROR_CODES)
  return loadKb()
    .map((entry) => entry.code)
    .filter((code) => !declared.has(code))
}
