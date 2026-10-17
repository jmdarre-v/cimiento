import { describe, expect, it } from 'vitest'
import { CimientoError } from '../../src/core/errors'
import {
  parseManifest,
  presetFragment,
  renderManifest,
  selectedProviderIds,
  slugify,
  mergeFragments,
} from '../../src/manifest'

function parse(input: unknown) {
  return parseManifest(input, 'stack.yaml')
}

describe('manifest schema', () => {
  it('fills every default from slots alone', () => {
    const m = parse({ name: 'My App', slots: { repo: 'github' } })
    expect(m.version).toBe(1)
    expect(m.slug).toBe('my-app')
    expect(m.slots.hosting).toBe('none')
    expect(m.environments).toEqual(['dev', 'preview', 'production'])
    expect(m.accounts.supabase).toBe('via-hosting')
    expect(m.options.github.visibility).toBe('private')
    expect(m.options.vercel.framework).toBe('nextjs')
    expect(m.secrets).toEqual([])
    expect(m.domain).toBeNull()
    expect(m.scaffold.template).toBe('nextjs-app')
  })

  it('keeps an explicit slug and derives one otherwise', () => {
    expect(parse({ name: 'Anything', slug: 'chosen-name', slots: {} }).slug).toBe('chosen-name')
    expect(slugify('  Ada and the Big App!  ')).toBe('ada-and-the-big-app')
    expect(slugify('***')).toBe('app')
  })

  it('reports a missing name as MANIFEST_INVALID with a hint', () => {
    try {
      parse({ slots: { repo: 'github' } })
      expect.unreachable('should have thrown')
    } catch (err) {
      expect(err).toBeInstanceOf(CimientoError)
      const error = err as CimientoError
      expect(error.code).toBe('MANIFEST_INVALID')
      expect(error.needsHuman).toBe(true)
      expect(error.hint).toContain('stack.yaml')
      expect(error.message).toContain('name')
    }
  })

  it('lists every invalid field at once instead of stopping at the first', () => {
    try {
      parse({ name: 'x', slots: { repo: 'gitlab', hosting: 'netlify' } })
      expect.unreachable('should have thrown')
    } catch (err) {
      const error = err as CimientoError
      expect(error.message).toContain('slots.repo')
      expect(error.message).toContain('slots.hosting')
    }
  })

  it('rejects an unknown top level key rather than ignoring it', () => {
    expect(() => parse({ name: 'x', slots: {}, colour: 'blue' })).toThrowError(/colour/)
  })

  it('rejects a secret name that is not screaming snake case', () => {
    expect(() => parse({ name: 'x', slots: { hosting: 'vercel' }, secrets: [{ name: 'apiKey' }] })).toThrowError(
      /SCREAMING_SNAKE_CASE/,
    )
  })

  it('refuses a secret whose sink has no provider', () => {
    try {
      parse({ name: 'x', slots: {}, secrets: [{ name: 'API_KEY', sinks: ['hosting'] }] })
      expect.unreachable('should have thrown')
    } catch (err) {
      expect((err as CimientoError).message).toContain('slots.hosting is none')
    }
  })

  it('refuses a secret targeting an environment the manifest does not have', () => {
    try {
      parse({
        name: 'x',
        slots: { hosting: 'vercel' },
        environments: ['production'],
        secrets: [{ name: 'API_KEY', sinks: ['hosting'], environments: ['preview'] }],
      })
      expect.unreachable('should have thrown')
    } catch (err) {
      expect((err as CimientoError).message).toContain('environment preview')
    }
  })

  it('refuses the same secret declared twice', () => {
    try {
      parse({
        name: 'x',
        slots: { hosting: 'vercel' },
        secrets: [{ name: 'API_KEY' }, { name: 'API_KEY' }],
      })
      expect.unreachable('should have thrown')
    } catch (err) {
      expect((err as CimientoError).message).toContain('declared twice')
    }
  })

  it('refuses database and auth filled by different providers', () => {
    expect(() => parse({ name: 'x', slots: { database: 'supabase', auth: 'clerk' } })).toThrowError()
  })

  it('refuses via-hosting supabase with no hosting slot', () => {
    try {
      parse({ name: 'x', slots: { database: 'supabase' }, accounts: { supabase: 'via-hosting' } })
      expect.unreachable('should have thrown')
    } catch (err) {
      expect((err as CimientoError).message).toContain('accounts.supabase: direct')
    }
  })

  it('accepts the direct supabase path with no hosting', () => {
    const m = parse({ name: 'x', slots: { database: 'supabase', auth: 'supabase' }, accounts: { supabase: 'direct' } })
    expect(m.accounts.supabase).toBe('direct')
  })
})

describe('presets', () => {
  it('fullstack selects the providers this build implements', () => {
    const m = parseManifest(mergeFragments({ name: 'demo' }, presetFragment('fullstack')), 'stack.yaml')
    expect(selectedProviderIds(m)).toEqual(['github', 'vercel', 'supabase', 'inngest', 'turnstile', 'anthropic'])
    expect(m.secrets.map((x) => `${x.name}:${x.source}`)).toEqual(['ANTHROPIC_API_KEY:keychain'])
    expect(m.scaffold.template).toBe('nextjs-app')
  })

  it('designer selects repo and hosting only', () => {
    const m = parseManifest(mergeFragments({ name: 'demo' }, presetFragment('designer')), 'stack.yaml')
    expect(selectedProviderIds(m)).toEqual(['github', 'vercel'])
    expect(m.slots.database).toBe('none')
    expect(m.slots.auth).toBe('none')
  })

  it('a flag override beats the preset', () => {
    const m = parseManifest(
      mergeFragments({ name: 'demo' }, presetFragment('fullstack'), { slots: { database: 'none', auth: 'none' } }),
      'stack.yaml',
    )
    expect(m.slots.hosting).toBe('vercel')
    expect(m.slots.database).toBe('none')
  })
})

describe('rendering', () => {
  it('round trips through yaml without losing a field', () => {
    const original = parse({
      name: 'Round Trip',
      slots: { repo: 'github', hosting: 'vercel' },
      accounts: { github: 'someone' },
      secrets: [{ name: 'API_KEY', sinks: ['hosting'], environments: ['production'] }],
    })
    const text = renderManifest(original)
    expect(text).toContain('name: Round Trip')
    expect(text).not.toContain('undefined')
    const reparsed = parse(require('yaml').parse(text))
    expect(reparsed).toEqual(original)
  })

  it('never writes a secret value, only names and destinations', () => {
    const m = parse({
      name: 'x',
      slots: { hosting: 'vercel' },
      secrets: [{ name: 'API_KEY', sinks: ['hosting'] }],
    })
    const text = renderManifest(m)
    expect(text).toContain('API_KEY')
    expect(text).toContain('sinks:')
    // The schema has no field that could hold one, so a rendered manifest can never carry a value.
    expect(text).not.toMatch(/^\s*value:/m)
  })
})
