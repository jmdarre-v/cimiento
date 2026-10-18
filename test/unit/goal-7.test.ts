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

const VERCEL_NEON = ['--repo', 'github', '--hosting', 'vercel', '--database', 'neon', '--template', 'nextjs-app']

/** A branch pushed with plain git, with the ready preview Vercel builds for it. */
function pushBranch(cloud: FakeCloud, branch: string): void {
  const sha = cloud.gitSha()
  cloud.pushedBranches.set(branch, sha)
  const project = [...cloud.vercelProjects.values()][0]
  const list = cloud.deployments.get(project.id) ?? []
  list.unshift({ uid: `dpl_${branch}`, url: `${project.name}-git-preview.vercel.app`, readyState: 'READY', target: null as unknown as string, createdAt: Date.now(), meta: { githubCommitSha: sha, githubCommitRef: branch } })
  cloud.deployments.set(project.id, list)
}

describe('BUG-88: previews never read the production Neon database by default', () => {
  it('the preview environment gets no DATABASE_URL of its own; each branch gets a Neon branch, created and removed with it', async () => {
    const cloud = new FakeCloud({ ghDeleteScope: true })
    await made(cloud, VERCEL_NEON)
    const projectId = [...cloud.vercelProjects.values()][0].id
    const envs = () => cloud.vercelEnv.get(projectId) ?? []
    expect(envs().filter((e) => e.key === 'DATABASE_URL' && e.target.includes('preview') && !e.gitBranch)).toEqual([])
    const production = envs().find((e) => e.key === 'DATABASE_URL' && e.target.includes('production'))!.value

    pushBranch(cloud, 'feature/login')
    const up = await cli(cloud, ['up', '--json', '--yes'])
    expect(up.code, up.writer.outText.slice(-800)).toBe(ExitCode.ok)
    const neon = [...cloud.v2.neonProjects.values()][0]
    expect(neon.branches.map((b) => b.name)).toContain('preview/feature-login')
    const scoped = envs().filter((e) => e.key === 'DATABASE_URL' && e.gitBranch === 'feature/login')
    expect(scoped).toHaveLength(1)
    expect(scoped[0].target).toEqual(['preview'])
    expect(scoped[0].value).not.toBe(production)
    expect(up.writer.outText).not.toContain(scoped[0].value)

    const again = await cli(cloud, ['up', '--json', '--yes'])
    expect(again.code).toBe(ExitCode.ok)
    expect(again.writer.outText).toMatch(/"id":"neon\.preview-branches"[^}]*"action":"noop"/)

    cloud.pushedBranches.delete('feature/login')
    const pruned = await cli(cloud, ['up', '--json', '--yes'])
    expect(pruned.code, pruned.writer.outText.slice(-800)).toBe(ExitCode.ok)
    expect(neon.branches.map((b) => b.name)).not.toContain('preview/feature-login')
    expect(envs().filter((e) => e.gitBranch === 'feature/login')).toEqual([])
  })

  it('on Netlify the branch address is a value for that branch context only', async () => {
    const cloud = new FakeCloud({ ghDeleteScope: true, keychain: V2_KEYS })
    await made(cloud, V2_ARGS)
    const site = [...cloud.v2.netlifySites.values()][0]
    const sha = cloud.gitSha()
    cloud.pushedBranches.set('feature/login', sha)
    cloud.v2.netlifyDeploys.unshift({ id: 'dep_branch', site_id: site.id, state: 'ready', context: 'branch-deploy', branch: 'feature/login', commit_ref: sha, deploy_ssl_url: 'https://feature-login--my-app.netlify.app', created_at: new Date().toISOString() })
    const up = await cli(cloud, ['up', '--json', '--yes'])
    expect(up.code, up.writer.outText.slice(-800)).toBe(ExitCode.ok)
    const entry = cloud.v2.netlifyEnv.get(site.id)!.find((e) => e.key === 'DATABASE_URL')!
    expect(entry.values.filter((v) => v.context === 'deploy-preview' || v.context === 'branch-deploy')).toEqual([])
    const branch = entry.values.find((v) => v.context === 'branch' && v.context_parameter === 'feature/login')
    expect(branch?.value).toBeDefined()
    expect(branch?.value).not.toBe(entry.values.find((v) => v.context === 'production')?.value)
  })

  it('down removes the preview branches with the project and confirms them gone', async () => {
    const cloud = new FakeCloud({ ghDeleteScope: true })
    await made(cloud, VERCEL_NEON)
    pushBranch(cloud, 'feature/login')
    await cli(cloud, ['up', '--json', '--yes'])
    const down = await cli(cloud, ['down', '--yes', '--json'])
    expect(down.code, down.writer.outText.slice(-800)).toBe(ExitCode.ok)
    expect(cloud.v2.neonProjects.size).toBe(0)
    expect(stateOf().resources['neon.preview-branches']).toBeUndefined()
  })

  it('environments.preview.database: shared keeps the old behavior and warns', async () => {
    const cloud = new FakeCloud({ ghDeleteScope: true })
    await made(cloud, VERCEL_NEON)
    const file = join(dir, 'stack.yaml')
    writeFileSync(file, readFileSync(file, 'utf8').replace(/environments:\n(  - .*\n)+/, 'environments:\n  dev: {}\n  preview:\n    database: shared\n  production: {}\n'))
    const plan = await cli(cloud, ['plan', '--json'])
    expect(plan.writer.outText).toContain('every preview deployment reads and writes the production database')
    const up = await cli(cloud, ['up', '--json', '--yes', '--orphans', 'destroy'])
    expect(up.code, up.writer.outText.slice(-800)).toBe(ExitCode.ok)
    expect(up.writer.outText).toContain('PREVIEW_DATABASE_SHARED')
    const projectId = [...cloud.vercelProjects.values()][0].id
    expect((cloud.vercelEnv.get(projectId) ?? []).some((e) => e.key === 'DATABASE_URL' && e.target.includes('preview') && !e.gitBranch)).toBe(true)
  })
})

describe('BUG-89: previews never read the production Supabase database by default', () => {
  const supabaseUrls = (cloud: FakeCloud) => {
    const projectId = [...cloud.vercelProjects.values()][0].id
    return (cloud.vercelEnv.get(projectId) ?? []).filter((e) => e.key === 'NEXT_PUBLIC_SUPABASE_URL')
  }

  it('Marketplace: production is connected to production and development, a second database to preview only', async () => {
    const cloud = new FakeCloud({ ghDeleteScope: true })
    await made(cloud, ['--preset', 'fullstack', '--allow-billing'])
    expect(cloud.stores.map((s) => s.name).sort()).toEqual(['my-app', 'my-app-preview'])
    const installs = cloud.execCalls.filter((c) => c.startsWith('vercel integration add supabase'))
    const main = installs.find((c) => / --name my-app( |$)/.test(c))!
    expect(main).toContain('--environment production')
    expect(main).toContain('--environment development')
    expect(main).not.toContain('--environment preview')
    expect(installs.find((c) => c.includes('--name my-app-preview'))).toContain('--environment preview')
    const urls = supabaseUrls(cloud)
    const production = urls.find((e) => e.target.includes('production'))!
    const preview = urls.find((e) => e.target.includes('preview'))!
    expect(production.target).not.toContain('preview')
    expect(preview.target).toEqual(['preview'])
    expect(preview.value).not.toBe(production.value)
  })

  it('direct: the preview env reads the preview project, and the free limit is said before it is made', async () => {
    const cloud = new FakeCloud({ ghDeleteScope: true })
    const result = await cli(cloud, ['new', 'my-app', '--preset', 'fullstack', '--supabase-account', 'direct', '--allow-billing', '--json', '--yes', '--dir', dir], root)
    expect(result.code, result.writer.outText.slice(-800)).toBe(ExitCode.ok)
    const text = result.writer.outText
    expect(text.indexOf("Supabase's free plan allows 2 active projects")).toBeGreaterThanOrEqual(0)
    expect(cloud.supabaseProjects.map((p) => p.name).sort()).toEqual(['my-app', 'my-app-preview'])
    const previewRef = cloud.supabaseProjects.find((p) => p.name === 'my-app-preview')!.id
    const urls = supabaseUrls(cloud)
    expect(urls.find((e) => e.target.includes('preview'))?.value).toBe(`https://${previewRef}.supabase.co`)
    expect(urls.find((e) => e.target.includes('production'))?.value).not.toBe(`https://${previewRef}.supabase.co`)
  })

  it('direct, at the free limit: the preview project waits on a person and production is untouched', async () => {
    const cloud = new FakeCloud({ ghDeleteScope: true, supabaseFreeLimit: 1 })
    const result = await cli(cloud, ['new', 'my-app', '--preset', 'fullstack', '--supabase-account', 'direct', '--allow-billing', '--json', '--yes', '--dir', dir], root)
    expect(result.code).toBe(ExitCode.needsHuman)
    expect(result.writer.outText).toContain('SUPABASE_FREE_PROJECT_LIMIT')
    expect(cloud.supabaseProjects.map((p) => p.name)).toEqual(['my-app'])
    expect(supabaseUrls(cloud).some((e) => e.target.includes('preview'))).toBe(false)
  })

  it('a database 0.3.0 connected to every environment is reported, and cimiento never reconnects it', async () => {
    const cloud = new FakeCloud({ ghDeleteScope: true })
    await made(cloud, ['--preset', 'fullstack', '--allow-billing'])
    // As 0.3.0 left it: one database, connected to every environment.
    const projectId = [...cloud.vercelProjects.values()][0].id
    const envs = cloud.vercelEnv.get(projectId)!
    cloud.vercelEnv.set(projectId, envs.filter((e) => !(/SUPABASE/.test(e.key) && e.target.join() === 'preview')))
    for (const e of cloud.vercelEnv.get(projectId)!) if (/SUPABASE/.test(e.key)) e.target = ['production', 'preview', 'development']
    cloud.stores.splice(cloud.stores.findIndex((s) => s.name === 'my-app-preview'), 1)
    cloud.supabaseProjects.splice(cloud.supabaseProjects.findIndex((p) => p.name === 'my-app-preview'), 1)
    editState((r) => {
      delete r['vercel.binding.supabase-preview-install']
      delete r['supabase.preview-project']
      delete r['supabase.preview-migrations']
      delete r['supabase.binding.preview-auth-urls']
    })
    const up = await cli(cloud, ['up', '--json', '--yes', '--allow-billing'])
    expect(up.code).toBe(ExitCode.needsHuman)
    expect(up.writer.outText).toContain('SUPABASE_PREVIEW_SHARES_PRODUCTION')
    expect(cloud.vercelEnv.get(projectId)!.filter((e) => /SUPABASE/.test(e.key)).every((e) => e.target.length === 3)).toBe(true)
    expect(cloud.stores.map((s) => s.name)).toEqual(['my-app'])
  })
})

describe('BUG-90 and BUG-91: a wrong value in the hosting env is seen by doctor and fixed by secret set', () => {
  const RIGHT = 'demo-right-value-not-a-real-key'
  const WRONG = 'demo-wrong-value-not-a-real-key'

  afterEach(() => {
    delete process.env.DEMO_TOKEN
  })

  async function withDemoToken(cloud: FakeCloud, args: string[]): Promise<void> {
    await made(cloud, args)
    const file = join(dir, 'stack.yaml')
    writeFileSync(file, readFileSync(file, 'utf8').replace(/^secrets:( \[\])?\n/m, 'secrets:\n  - name: DEMO_TOKEN\n    sinks: [hosting]\n    environments: [production]\n    source: env\n'))
    process.env.DEMO_TOKEN = RIGHT
    const up = await cli(cloud, ['up', '--json', '--yes'])
    expect(up.code, up.writer.outText.slice(-800)).toBe(ExitCode.ok)
  }

  it('Vercel: doctor --smoke fails with the secret set hint, secret set writes the right value, doctor is green', async () => {
    const cloud = new FakeCloud({ ghDeleteScope: true })
    await withDemoToken(cloud, ['--preset', 'designer'])
    const projectId = [...cloud.vercelProjects.values()][0].id
    const entry = () => cloud.vercelEnv.get(projectId)!.find((e) => e.key === 'DEMO_TOKEN')!
    expect(entry().value).toBe(RIGHT)
    entry().value = WRONG

    const broken = await cli(cloud, ['doctor', '--smoke', '--json'])
    expect(broken.code).not.toBe(ExitCode.ok)
    expect(broken.writer.outText).toContain('SECRET_VALUE_MISMATCH')
    expect(broken.writer.outText).toContain('cimiento secret set DEMO_TOKEN')
    expect(broken.writer.outText).not.toContain(WRONG)
    expect(broken.writer.outText).not.toContain(RIGHT)

    const set = await cli(cloud, ['secret', 'set', 'DEMO_TOKEN', '--json'])
    expect(set.code, set.writer.outText.slice(-800)).toBe(ExitCode.ok)
    expect(entry().value).toBe(RIGHT)
    const green = await cli(cloud, ['doctor', '--smoke', '--json'])
    expect(green.code, green.writer.outText.slice(-800)).toBe(ExitCode.ok)
  })

  it('BUG-92: a key replaced with a sensitive value Vercel never shows is still seen as changed, and secret set writes over it', async () => {
    const cloud = new FakeCloud({ ghDeleteScope: true })
    await withDemoToken(cloud, ['--preset', 'designer'])
    const projectId = [...cloud.vercelProjects.values()][0].id
    const envs = cloud.vercelEnv.get(projectId)!
    // As vercel env rm then vercel env add do: a new entry, sensitive, with a new id.
    envs.splice(envs.findIndex((e) => e.key === 'DEMO_TOKEN'), 1)
    envs.push({ id: 'env_by_hand', key: 'DEMO_TOKEN', value: WRONG, target: ['production'], type: 'sensitive', createdAt: Date.now() + 1000 })

    const broken = await cli(cloud, ['doctor', '--smoke', '--json'])
    expect(broken.code).not.toBe(ExitCode.ok)
    expect(broken.writer.outText).toContain('SECRET_VALUE_MISMATCH')
    expect(broken.writer.outText).toContain('cimiento secret set DEMO_TOKEN')

    const set = await cli(cloud, ['secret', 'set', 'DEMO_TOKEN', '--json'])
    expect(set.code, set.writer.outText.slice(-800)).toBe(ExitCode.ok)
    expect(envs.find((e) => e.key === 'DEMO_TOKEN')!.value).toBe(RIGHT)
    const green = await cli(cloud, ['doctor', '--smoke', '--json'])
    expect(green.code, green.writer.outText.slice(-800)).toBe(ExitCode.ok)
  })

  it('Netlify: the same', async () => {
    const cloud = new FakeCloud({ ghDeleteScope: true, keychain: V2_KEYS })
    await withDemoToken(cloud, V2_ARGS)
    const site = [...cloud.v2.netlifySites.values()][0]
    const value = () => cloud.v2.netlifyValue(site.id, 'DEMO_TOKEN', 'production')
    expect(value()).toBe(RIGHT)
    cloud.v2.netlifyEnv.get(site.id)!.find((e) => e.key === 'DEMO_TOKEN')!.values.find((v) => v.context === 'production')!.value = WRONG

    const broken = await cli(cloud, ['doctor', '--json'])
    expect(broken.code).not.toBe(ExitCode.ok)
    expect(broken.writer.outText).toContain('SECRET_VALUE_MISMATCH')
    const set = await cli(cloud, ['secret', 'set', 'DEMO_TOKEN', '--json'])
    expect(set.code, set.writer.outText.slice(-800)).toBe(ExitCode.ok)
    expect(value()).toBe(RIGHT)
  })
})
