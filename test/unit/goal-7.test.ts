// Goal 7: identity-safe teardown, honest publish, isolated preview data. Each BUG test here was
// run red on the code before its fix (docs/FIELD-TEST-7.md lists the commits).

import { readFileSync, writeFileSync } from 'node:fs'
import { join } from 'node:path'
import { afterEach, beforeEach, describe, expect, it } from 'vitest'
import { run } from '../../src/cli/index'
import { ExitCode } from '../../src/core/errors'
import { clearToolUpdateCache } from '../../src/core/toolkit'
import { FakeCloud } from './fake-cloud'
import { CaptureWriter, personDoesIt, removeDir, tempDir, useFakeTokens } from './helpers'

let root = ''
let dir = ''
let configDir = ''

beforeEach(() => {
  useFakeTokens()
  clearToolUpdateCache()
  root = tempDir('cimiento-goal7-')
  dir = join(root, 'my-app')
  configDir = tempDir('cimiento-config-')
  process.env.CIMIENTO_CONFIG_DIR = configDir
})

afterEach(() => {
  removeDir(root)
  removeDir(configDir)
  delete process.env.CIMIENTO_CONFIG_DIR
})

async function cli(cloud: FakeCloud, args: string[], cwd = dir): Promise<{ code: number; writer: CaptureWriter }> {
  const writer = new CaptureWriter()
  const code = await run(args, { io: cloud, cwd, writer, interactive: false, onManual: personDoesIt })
  return { code, writer }
}

type StoredResource = { origin?: string; externalId?: string; spec?: unknown }

function stateOf(folder = dir): { resources: Record<string, StoredResource> } {
  return JSON.parse(readFileSync(join(folder, '.cimiento', 'state.json'), 'utf8'))
}

function editState(edit: (resources: Record<string, StoredResource>) => void): void {
  const path = join(dir, '.cimiento', 'state.json')
  const state = JSON.parse(readFileSync(path, 'utf8')) as { resources: Record<string, StoredResource> }
  edit(state.resources)
  writeFileSync(path, JSON.stringify(state, null, 2))
}

async function made(cloud: FakeCloud, args: string[]): Promise<void> {
  const result = await cli(cloud, ['new', 'my-app', ...args, '--json', '--yes', '--dir', dir], root)
  expect(result.code, result.writer.outText.slice(-800)).toBe(ExitCode.ok)
}

const V2_KEYS = {
  'my-app/RESEND_API_KEY': 're_fake_not_a_real_key',
  'my-app/STRIPE_SECRET_KEY': 'sk_test_fake_not_a_real_key',
  'my-app/NEXT_PUBLIC_STRIPE_PUBLISHABLE_KEY': 'pk_test_fake_not_a_real_key',
  'my-app/NEXT_PUBLIC_POSTHOG_KEY': 'phc_fakeprojectkeynotreal0000',
}
const V2_ARGS = ['--repo', 'github', '--hosting', 'netlify', '--database', 'neon', '--email', 'resend', '--payments', 'stripe', '--analytics', 'posthog', '--template', 'nextjs-app']

describe('BUG-82: down deletes the Vercel project by its recorded id, never by name', () => {
  it('a same-name project that replaced the one cimiento made survives down', async () => {
    const cloud = new FakeCloud({ ghDeleteScope: true })
    await made(cloud, ['--preset', 'designer'])
    const ours = [...cloud.vercelProjects.values()][0]
    cloud.vercelProjects.delete(ours.id)
    cloud.vercelProjects.set('prj_stranger', { ...ours, id: 'prj_stranger' })

    const down = await cli(cloud, ['down', '--yes', '--json'])
    expect(down.code, down.writer.outText.slice(-800)).toBe(ExitCode.ok)
    expect(cloud.vercelProjects.has('prj_stranger')).toBe(true)
    expect(stateOf().resources['vercel.project']).toBeUndefined()
  })
})

describe('BUG-83: down compares the GitHub node id before deleting a repository by name', () => {
  it('a same-name repository with another node id is refused, kept, and the record stays', async () => {
    const cloud = new FakeCloud({ ghDeleteScope: true })
    await made(cloud, ['--preset', 'designer'])
    const [full, ours] = [...cloud.repos.entries()][0]
    cloud.repos.set(full, { ...ours, id: 'R_stranger' })

    const down = await cli(cloud, ['down', '--yes', '--json'])
    expect(down.code).not.toBe(ExitCode.ok)
    expect(down.writer.outText).toContain('DOWN_IDENTITY_MISMATCH')
    expect(cloud.repos.get(full)?.id).toBe('R_stranger')
    expect(stateOf().resources['github.repo']).toBeDefined()
  })

  it('down --release github.repo then drops the record and touches nothing on GitHub', async () => {
    const cloud = new FakeCloud({ ghDeleteScope: true })
    await made(cloud, ['--preset', 'designer'])
    const [full, ours] = [...cloud.repos.entries()][0]
    cloud.repos.set(full, { ...ours, id: 'R_stranger' })
    await cli(cloud, ['down', '--yes', '--json'])

    const released = await cli(cloud, ['down', '--release', 'github.repo', '--yes', '--json'])
    expect(released.code, released.writer.outText.slice(-800)).toBe(ExitCode.ok)
    expect(cloud.repos.get(full)?.id).toBe('R_stranger')
    expect(stateOf().resources['github.repo']).toBeUndefined()
  })
})

describe('BUG-84: a record without an id is never deleted by finding a same-name resource', () => {
  it('Netlify and Neon: down refuses with DOWN_ID_MISSING and the site and project survive', async () => {
    const cloud = new FakeCloud({ ghDeleteScope: true, keychain: V2_KEYS })
    await made(cloud, V2_ARGS)
    editState((r) => {
      delete r['netlify.project'].externalId
      delete r['neon.project'].externalId
    })
    const down = await cli(cloud, ['down', '--yes', '--json'])
    expect(down.code).not.toBe(ExitCode.ok)
    expect(down.writer.outText).toContain('DOWN_ID_MISSING')
    expect(cloud.v2.netlifySites.size).toBe(1)
    expect(cloud.v2.neonProjects.size).toBe(1)
    expect(stateOf().resources['netlify.project']).toBeDefined()
    expect(stateOf().resources['neon.project']).toBeDefined()
  })

  it('Turnstile: a widget record without its sitekey is refused, and the same-name widget survives', async () => {
    const cloud = new FakeCloud({ ghDeleteScope: true })
    await made(cloud, ['--preset', 'fullstack', '--allow-billing'])
    editState((r) => {
      delete r['turnstile.widget'].externalId
    })
    const down = await cli(cloud, ['down', '--yes', '--json'])
    expect(down.code).not.toBe(ExitCode.ok)
    expect(down.writer.outText).toContain('DOWN_ID_MISSING')
    expect([...cloud.widgets.values()].flat().length).toBe(1)
    expect(stateOf().resources['turnstile.widget']).toBeDefined()
  })
})

/** state.json as 0.1.0 and 0.2.0 wrote it: version 1, no spec and no account on any entry. */
function makeLegacy(): void {
  const path = join(dir, '.cimiento', 'state.json')
  const state = JSON.parse(readFileSync(path, 'utf8')) as { version: number; resources: Record<string, Record<string, unknown>> }
  state.version = 1
  for (const entry of Object.values(state.resources)) {
    delete entry.spec
    delete entry.account
  }
  writeFileSync(path, JSON.stringify(state, null, 2))
}

function swapHosting(to: string): void {
  const file = join(dir, 'stack.yaml')
  writeFileSync(file, readFileSync(file, 'utf8').replace(/hosting: vercel/, `hosting: ${to}`))
}

describe('BUG-85: legacy state from 0.1.0 and 0.2.0 is rebuilt, never silently skipped by down', () => {
  it('after a hosting swap, the legacy Vercel project is rebuilt from stack.yaml, listed as orphan, and deleted by down', async () => {
    const cloud = new FakeCloud({ ghDeleteScope: true })
    await made(cloud, ['--preset', 'designer'])
    makeLegacy()
    swapHosting('netlify')

    const plan = await cli(cloud, ['plan', '--json'])
    const items = (plan.writer.jsonObjects().pop() as { items: { id: string; status: string }[] }).items
    expect(items.find((i) => i.id === 'vercel.project')?.status).toBe('orphan')

    const down = await cli(cloud, ['down', '--yes', '--json'])
    expect(down.code, down.writer.outText.slice(-800)).toBe(ExitCode.ok)
    expect(cloud.vercelProjects.size).toBe(0)
    expect(stateOf().resources['vercel.project']).toBeUndefined()
  })

  it('the first command that writes state stores the rebuilt specs back', async () => {
    const cloud = new FakeCloud({ ghDeleteScope: true })
    await made(cloud, ['--preset', 'designer'])
    makeLegacy()
    const up = await cli(cloud, ['up', '--json', '--yes'])
    expect(up.code, up.writer.outText.slice(-800)).toBe(ExitCode.ok)
    expect(up.writer.outText).toContain('"event":"legacy-rebuilt"')
    const saved = JSON.parse(readFileSync(join(dir, '.cimiento', 'state.json'), 'utf8')) as { version: number; resources: Record<string, StoredResource> }
    expect(saved.version).toBe(2)
    expect(saved.resources['vercel.project'].spec).toBeDefined()
    expect(saved.resources['github.repo'].spec).toBeDefined()
  })
})

describe('BUG-86: a legacy record that cannot be rebuilt keeps down non-zero until it is reconciled', () => {
  it('down reports LEGACY_STATE_UNRESOLVED and exits non-zero; down --release reconciles it', async () => {
    const cloud = new FakeCloud({ ghDeleteScope: true })
    await made(cloud, ['--preset', 'designer'])
    editState((r) => {
      r['oldhost.project'] = { origin: 'created', externalId: 'old_123' }
    })
    makeLegacy()

    const plan = await cli(cloud, ['plan', '--json'])
    expect(plan.writer.outText).toContain('oldhost.project')

    const down = await cli(cloud, ['down', '--yes', '--json'])
    expect(down.code).not.toBe(ExitCode.ok)
    expect(down.writer.outText).toContain('LEGACY_STATE_UNRESOLVED')
    expect(stateOf().resources['oldhost.project']).toBeDefined()

    const released = await cli(cloud, ['down', '--release', 'oldhost.project', '--yes', '--json'])
    expect(released.code).toBe(ExitCode.ok)
    const again = await cli(cloud, ['down', '--yes', '--json'])
    expect(again.code, again.writer.outText.slice(-800)).toBe(ExitCode.ok)
    expect(stateOf().resources['oldhost.project']).toBeUndefined()
  })
})

describe('BUG-87: publish never fills a failed live-commit lookup from cached state', () => {
  for (const [label, status] of [['a 503', 503], ['a timeout', 0], ['a 401', 401]] as const) {
    it(`Vercel answering ${label} to the deployments lookup is unknown: publish exits non-zero with a hint`, async () => {
      const cloud = new FakeCloud({ ghDeleteScope: true })
      await made(cloud, ['--preset', 'designer'])
      cloud.httpFaults.push({ method: 'GET', match: /api\.vercel\.com\/v6\/deployments/, status })
      const publish = await cli(cloud, ['publish', '--json'])
      expect(publish.code).not.toBe(ExitCode.ok)
      expect(publish.writer.outText).toContain('PUBLISH_LIVE_COMMIT_UNKNOWN')
      expect(publish.writer.outText).not.toContain('"published":false')
    })
  }

  it('Netlify answering 503 to the deploys lookup is unknown too', async () => {
    const cloud = new FakeCloud({ ghDeleteScope: true, keychain: V2_KEYS })
    await made(cloud, V2_ARGS)
    cloud.httpFaults.push({ method: 'GET', match: /api\.netlify\.com\/api\/v1\/sites\/[^/]+\/deploys/, status: 503 })
    const publish = await cli(cloud, ['publish', '--json'])
    expect(publish.code).not.toBe(ExitCode.ok)
    expect(publish.writer.outText).toContain('PUBLISH_LIVE_COMMIT_UNKNOWN')
  })

  it('Netlify with the lookup healthy: a clean tree that is live says nothing to publish, without waiting', async () => {
    const cloud = new FakeCloud({ ghDeleteScope: true, keychain: V2_KEYS })
    await made(cloud, V2_ARGS)
    const started = Date.now()
    const publish = await cli(cloud, ['publish', '--json'])
    expect(publish.code, publish.writer.outText.slice(-500)).toBe(ExitCode.ok)
    expect(publish.writer.outText).toContain('"published":false')
    expect(Date.now() - started).toBeLessThan(5000)
  })

  it('a live deployment that records no commit, as 0.3.0 made them, is unknown, not a wait', async () => {
    const cloud = new FakeCloud({ ghDeleteScope: true })
    await made(cloud, ['--preset', 'designer'])
    for (const list of cloud.deployments.values()) for (const d of list) delete d.meta
    const publish = await cli(cloud, ['publish', '--json'])
    expect(publish.code).not.toBe(ExitCode.ok)
    expect(publish.writer.outText).toContain('records no commit')
  })

  it('with the lookup healthy, a clean tree that is live still says nothing to publish', async () => {
    const cloud = new FakeCloud({ ghDeleteScope: true })
    await made(cloud, ['--preset', 'designer'])
    const publish = await cli(cloud, ['publish', '--json'])
    expect(publish.code, publish.writer.outText.slice(-500)).toBe(ExitCode.ok)
    expect(publish.writer.outText).toContain('"published":false')
  })
})
