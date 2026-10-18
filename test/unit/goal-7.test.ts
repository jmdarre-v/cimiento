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
