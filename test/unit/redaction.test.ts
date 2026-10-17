// Spec section 8: a secret value never appears in the manifest, state, logs, json output or a
// chat window. Logs print NAME=****.

import { describe, expect, it } from 'vitest'
import { runUp } from '../../src/core/executor'
import { MemoryLogger } from '../../src/core/logger'
import { Printer } from '../../src/cli/output'
import { Redactor, REDACTION_MASK } from '../../src/core/redact'
import { applyEnsureToState, emptyProjectState } from '../../src/core/state'
import { SecretStore } from '../../src/secrets'
import { FakeCloud } from './fake-cloud'
import { CaptureWriter, manifestFor, testContext, personDoesIt } from './helpers'

const FAKE_KEY = 'sk-fake-0123456789abcdef-not-a-real-credential'

describe('redactor', () => {
  it('masks a registered value anywhere it appears', () => {
    const r = new Redactor()
    r.addValue(FAKE_KEY)
    expect(r.redact(`token is ${FAKE_KEY} ok`)).toBe(`token is ${REDACTION_MASK} ok`)
    expect(r.redact(`{"k":"${FAKE_KEY}"}`)).not.toContain('0123456789')
  })

  it('masks NAME=value for a registered name even when the value is unknown', () => {
    const r = new Redactor()
    r.addName('ANTHROPIC_API_KEY')
    expect(r.redact('ANTHROPIC_API_KEY=whatever-this-is')).toBe(`ANTHROPIC_API_KEY=${REDACTION_MASK}`)
    expect(r.redact('ANTHROPIC_API_KEY: whatever')).toBe(`ANTHROPIC_API_KEY: ${REDACTION_MASK}`)
  })

  it('does not mask an already masked value twice', () => {
    const r = new Redactor()
    r.addName('API_KEY')
    expect(r.redact(`API_KEY=${REDACTION_MASK}`)).toBe(`API_KEY=${REDACTION_MASK}`)
  })

  it('masks values and named keys inside a nested object', () => {
    const r = new Redactor()
    r.addValue(FAKE_KEY)
    r.addName('API_KEY')
    const out = r.redactValue({
      items: [{ evidence: `used ${FAKE_KEY}` }],
      env: { API_KEY: 'something-else-entirely' },
    }) as { items: { evidence: string }[]; env: { API_KEY: string } }
    expect(out.items[0].evidence).toBe(`used ${REDACTION_MASK}`)
    expect(out.env.API_KEY).toBe(REDACTION_MASK)
  })

  it('leaves short strings alone so it cannot mangle ordinary output', () => {
    const r = new Redactor()
    r.addValue('ok')
    expect(r.redact('everything is ok')).toBe('everything is ok')
  })
})

describe('secret store', () => {
  it('registers a name and a value with the redactor as soon as it learns them', async () => {
    const manifest = manifestFor(
      { slots: { hosting: 'vercel' }, secrets: [{ name: 'API_KEY', sinks: ['hosting'], source: 'env' }] },
    )
    const redactor = new Redactor()
    const store = new SecretStore(manifest, redactor, { interactive: false })
    process.env.API_KEY = FAKE_KEY
    try {
      expect(await store.get('API_KEY')).toBe(FAKE_KEY)
    } finally {
      delete process.env.API_KEY
    }
    expect(redactor.redact(`API_KEY is ${FAKE_KEY}`)).not.toContain('0123456789')
  })

  it('reads a keychain secret through the fake keychain, never the real one, and registers it with the redactor', async () => {
    const cloud = new FakeCloud({ keychain: { 'my-app/API_KEY': FAKE_KEY } })
    const manifest = manifestFor(
      { slots: { hosting: 'vercel' }, secrets: [{ name: 'API_KEY', sinks: ['hosting'], source: 'keychain' }] },
    )
    const redactor = new Redactor()
    const store = new SecretStore(manifest, redactor, { interactive: false, io: cloud })
    expect(await store.get('API_KEY')).toBe(FAKE_KEY)
    expect(cloud.execCalls).toContain('security find-generic-password -s cimiento -a my-app/API_KEY -w')
    expect(redactor.redact(`value ${FAKE_KEY}`)).not.toContain(FAKE_KEY)
  })

  it('refuses a 1password secret without a ref, at manifest validation', () => {
    expect(() =>
      manifestFor({ slots: { hosting: 'vercel' }, secrets: [{ name: 'API_KEY', sinks: ['hosting'], source: '1password' }] }),
    ).toThrow(/ref/)
  })
})

describe('state never holds a secret', () => {
  it('drops a secret output while keeping the non secret ones', () => {
    const state = applyEnsureToState(
      emptyProjectState(),
      { id: 'supabase.project', kind: 'resource', provider: 'supabase', dependsOn: [], inputs: {} },
      {
        action: 'created',
        externalId: 'sbref_1',
        outputs: {
          projectRef: { value: 'sbref_1', secret: false },
          serviceRoleKey: { value: FAKE_KEY, secret: true },
        },
      },
    )
    const serialized = JSON.stringify(state)
    expect(serialized).toContain('sbref_1')
    expect(serialized).not.toContain(FAKE_KEY)
    expect(state.resources['supabase.project'].outputs?.serviceRoleKey).toBeUndefined()
  })

  it('keeps no supabase key in state after a full up on the direct path', async () => {
    const manifest = manifestFor({ accounts: { supabase: 'direct' } }, 'fullstack')
    const t = testContext(manifest, { cloud: new FakeCloud() })
    const result = await runUp(t.ctx, t.providers, t.specs, { onManual: personDoesIt })
    expect(result.errors).toEqual([])
    const serialized = JSON.stringify(result.state)
    expect(serialized).not.toContain('fake-anon-key')
    expect(serialized).not.toContain('fake-service-role-key')
  })
})

describe('logs and json output', () => {
  it('masks a secret value in every log line', async () => {
    const manifest = manifestFor({ accounts: { supabase: 'direct' } }, 'fullstack')
    const t = testContext(manifest)
    const result = await runUp(t.ctx, t.providers, t.specs, { onManual: personDoesIt })
    expect(result.errors).toEqual([])
    const logText = (t.logger as MemoryLogger).lines.join('\n')
    expect(logText).not.toContain('fake-anon-key')
    expect(logText).not.toContain('fake-service-role-key')
  })

  it('masks a secret value in a json payload', () => {
    const redactor = new Redactor()
    redactor.addValue(FAKE_KEY)
    redactor.addName('API_KEY')
    const writer = new CaptureWriter()
    const printer = new Printer(writer, redactor, true)
    printer.emit({ receipts: [{ id: 'x', evidence: `wrote ${FAKE_KEY}` }], env: { API_KEY: 'anything' } })
    expect(writer.outText).not.toContain('0123456789')
    expect(writer.outText).toContain(REDACTION_MASK)
  })

  it('masks the api token the providers use', async () => {
    const manifest = manifestFor({}, 'designer')
    const t = testContext(manifest)
    await runUp(t.ctx, t.providers, t.specs, { onManual: personDoesIt })
    expect(t.redactor.redact('bearer fake-vercel-token-not-a-real-credential')).toContain(REDACTION_MASK)
  })
})
