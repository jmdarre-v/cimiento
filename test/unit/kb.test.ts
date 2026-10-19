// Spec section 13: every CimientoError code has a knowledge base entry.
// Spec section 5: explain returns plain language for every resource id and error code a module
// can produce, in the requested language.

import { describe, expect, it } from 'vitest'
import { ERROR_CODES } from '../../src/core/errors'
import { loadKb, lookupCode, matchSignature, missingCodes, orphanEntries } from '../../src/kb'
import { collectSpecs, explainKey, allProviders } from '../../src/registry'
import { emptyProjectState } from '../../src/core/state'
import { completeFragment } from '../../src/manifest/presets'
import type { ManifestInput } from '../../src/manifest/schema'
import { manifestFor } from './helpers'

/** Written as a code point so the character itself never appears in the source. */
const EM_DASH = String.fromCharCode(0x2014)

describe('knowledge base', () => {
  it('has an entry for every error code this build can emit', () => {
    expect(missingCodes()).toEqual([])
  })

  it('has no entry for a code that no longer exists', () => {
    expect(orphanEntries()).toEqual([])
  })

  it('gives every entry a hint and a fix', () => {
    for (const entry of loadKb()) {
      expect(entry.hint, `${entry.code} has no hint`).toBeTruthy()
      expect(entry.fix, `${entry.code} has no fix`).toBeTruthy()
      expect(entry.title, `${entry.code} has no title`).toBeTruthy()
      expect(entry.provider, `${entry.code} has no provider`).toBeTruthy()
    }
  })

  it('declares no code twice', () => {
    const codes = loadKb().map((e) => e.code)
    expect(codes.length).toBe(new Set(codes).size)
  })

  it('looks an entry up by code', () => {
    const entry = lookupCode('SESSION_ACCOUNT_MISMATCH')!
    expect(entry.provider).toBe('core')
    expect(entry.fix).toContain('deliberate')
  })

  it('matches raw vendor output against a known signature', () => {
    expect(matchSignature('bash: gh: command not found')?.code).toBe('TOOL_MISSING')
    expect(matchSignature('Could not resolve to a Repository with the name x')?.code).toBe('GITHUB_REPO_NOT_FOUND')
    expect(matchSignature('nothing familiar here at all')).toBeUndefined()
  })

  it('writes no em dash anywhere, per the house rule', () => {
    for (const entry of loadKb()) {
      const text = `${entry.title} ${entry.hint} ${entry.fix}`
      expect(text, `${entry.code} contains an em dash`).not.toContain(EM_DASH)
    }
  })
})

describe('explain coverage', () => {
  const manifest = manifestFor({}, 'fullstack')
  const providers = allProviders(manifest)
  const specs = collectSpecs(manifest, emptyProjectState(), providers)

  it('has English text for every resource id the fullstack preset produces', () => {
    const missing = specs
      .map((s) => s.id)
      .filter((id) => !explainKey(id, 'en', manifest))
    expect(missing).toEqual([])
  })

  it('has English text for every resource id the direct supabase path produces', () => {
    const direct = manifestFor({ accounts: { supabase: 'direct' } }, 'fullstack')
    const directSpecs = collectSpecs(direct, emptyProjectState(), allProviders(direct))
    const missing = directSpecs.map((s) => s.id).filter((id) => !explainKey(id, 'en', direct))
    expect(missing).toEqual([])
  })

  // BUG-116: neon.tool.neonctl and netlify.tool.netlify had no text, because no stack above
  // selects Neon or Netlify; cimiento explain --list (PR 4) showed them.
  for (const [name, slots, accounts] of [
    ['netlify, neon, resend, stripe and posthog', { repo: 'github', hosting: 'netlify', database: 'neon', email: 'resend', payments: 'stripe', analytics: 'posthog' }, {}],
    ['vercel and neon', { repo: 'github', hosting: 'vercel', database: 'neon' }, {}],
  ] as const) {
    it(`has English and Spanish text for every resource id the ${name} stack produces`, () => {
      const m = manifestFor({ ...completeFragment({ slots } as ManifestInput), accounts } as ManifestInput)
      const ids = collectSpecs(m, emptyProjectState(), allProviders(m)).map((s) => s.id)
      expect(ids.filter((id) => !explainKey(id, 'en', m))).toEqual([])
      expect(ids.filter((id) => explainKey(id, 'es', m) === explainKey(id, 'en', m))).toEqual([])
    })
  }

  it('has English text for every error code', () => {
    const missing = ERROR_CODES.filter((code) => !explainKey(code, 'en', manifest))
    expect(missing).toEqual([])
  })

  it('never returns an empty or placeholder explanation', () => {
    for (const id of specs.map((s) => s.id)) {
      const text = explainKey(id, 'en', manifest)!
      expect(text.length, `${id} explanation is too short to help anyone`).toBeGreaterThan(40)
      expect(text).not.toContain('No explanation')
    }
  })

  it('falls back to English when Spanish is missing rather than returning nothing', () => {
    for (const code of ERROR_CODES) {
      expect(explainKey(code, 'es', manifest), `${code} has no text in es`).toBeTruthy()
    }
  })

  it('writes no em dash in any explanation', () => {
    for (const id of [...specs.map((s) => s.id), ...ERROR_CODES]) {
      expect(explainKey(id, 'en', manifest), `${id} contains an em dash`).not.toContain(EM_DASH)
    }
  })
})

describe('docs/TROUBLESHOOTING.md', () => {
  it('is generated from the knowledge base and up to date, with one section per code', async () => {
    const { spawnSync } = await import('node:child_process')
    const { readFileSync } = await import('node:fs')
    const { join } = await import('node:path')
    const root = join(__dirname, '../..')
    const check = spawnSync('node', [join(root, 'scripts/troubleshooting.mjs'), '--check'], { encoding: 'utf8' })
    expect(check.status, check.stderr).toBe(0)
    const text = readFileSync(join(root, 'docs/TROUBLESHOOTING.md'), 'utf8')
    for (const code of ERROR_CODES) expect(text, code).toContain(`### ${code}\n`)
    expect(text).not.toContain(EM_DASH)
  })
})
