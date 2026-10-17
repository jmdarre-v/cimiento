// Spec section 13: every CimientoError code has a knowledge base entry.
// Spec section 5: explain returns plain language for every resource id and error code a module
// can produce, in the requested language.

import { describe, expect, it } from 'vitest'
import { ERROR_CODES } from '../../src/core/errors'
import { loadKb, lookupCode, matchSignature, missingCodes, orphanEntries } from '../../src/kb'
import { collectSpecs, explainKey, allProviders } from '../../src/registry'
import { emptyProjectState } from '../../src/core/state'
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
