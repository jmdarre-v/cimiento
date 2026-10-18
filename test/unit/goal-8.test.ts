// Goal 8: close the Goal 7 limits. Each BUG test here was run red on the code before its fix
// (docs/FIELD-TEST-8.md lists the commits).

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
  root = tempDir('cimiento-goal8-')
  dir = join(root, 'my-app')
  configDir = tempDir('cimiento-config-')
  process.env.CIMIENTO_CONFIG_DIR = configDir
})

afterEach(() => {
  removeDir(root)
  removeDir(configDir)
  delete process.env.CIMIENTO_CONFIG_DIR
  delete process.env.CIMIENTO_DETECT_CACHE
})

async function cli(cloud: FakeCloud, args: string[], cwd = dir): Promise<{ code: number; writer: CaptureWriter }> {
  const writer = new CaptureWriter()
  const code = await run(args, { io: cloud, cwd, writer, interactive: false, onManual: personDoesIt })
  return { code, writer }
}

async function made(cloud: FakeCloud, args: string[]): Promise<void> {
  const result = await cli(cloud, ['new', 'my-app', ...args, '--json', '--yes', '--dir', dir], root)
  expect(result.code, result.writer.outText.slice(-800)).toBe(ExitCode.ok)
}

const VERCEL_NEON = ['--repo', 'github', '--hosting', 'vercel', '--database', 'neon', '--template', 'nextjs-app']

describe('BUG-93: a noop up asks each tool and each login once, not once per phase', () => {
  it('up --json runs every version command and every identity command once', async () => {
    const cloud = new FakeCloud({ ghDeleteScope: true })
    await made(cloud, VERCEL_NEON)
    const before = cloud.execCalls.length
    const up = await cli(cloud, ['up', '--json', '--yes'])
    expect(up.code, up.writer.outText.slice(-800)).toBe(ExitCode.ok)
    const calls = cloud.execCalls.slice(before)
    const count = (prefix: string) => calls.filter((c) => c.startsWith(prefix)).length
    for (const prefix of ['gh --version', 'git --version', 'vercel --version', 'neonctl --version', 'gh auth status', 'vercel whoami', 'neonctl me']) {
      expect(count(prefix), prefix).toBeLessThanOrEqual(1)
    }
  })

  it('a second up within the TTL reuses the machine cache, and an auth error clears it', async () => {
    process.env.CIMIENTO_DETECT_CACHE = 'on'
    const cloud = new FakeCloud({ ghDeleteScope: true })
    await made(cloud, VERCEL_NEON)
    await cli(cloud, ['up', '--json', '--yes'])
    const before = cloud.execCalls.length
    const again = await cli(cloud, ['up', '--json', '--yes'])
    expect(again.code).toBe(ExitCode.ok)
    const calls = cloud.execCalls.slice(before)
    expect(calls.filter((c) => c.startsWith('vercel whoami') || c.startsWith('vercel --version')).length).toBe(0)

    // A 401 from Vercel means the cached identity may be stale: the next run asks again.
    cloud.httpFaults.push({ method: 'GET', match: /api\.vercel\.com\/v9\/projects\//, status: 401 })
    await cli(cloud, ['up', '--json', '--yes'])
    cloud.httpFaults.length = 0
    const after = cloud.execCalls.length
    await cli(cloud, ['up', '--json', '--yes'])
    expect(cloud.execCalls.slice(after).some((c) => c.startsWith('vercel whoami'))).toBe(true)
  })
})

// Item 1: Neon preview branches without cimiento up.

import { createServer, type Server } from 'node:http'
import type { AddressInfo } from 'node:net'
import { mkdirSync } from 'node:fs'
import { pathToFileURL } from 'node:url'
import { previewBranchName } from '../../src/core/hosting'
import { manifestFor } from './helpers'
import { scaffoldFiles } from '../../src/scaffold'

const PREVIEW_FILES = ['.github/workflows/preview-database.yml', '.github/scripts/preview-database.mjs', 'lib/neon-preview.mjs', 'lib/neon-preview.d.mts', 'lib/db.ts', 'app/api/cimiento/database/route.ts']

describe('BUG-94: the scaffold gives previews a way to their own Neon branch without cimiento up', () => {
  it('vercel, neon and github: the workflow, its script, the helper, the database module and the route, and the Neon driver', () => {
    const files = scaffoldFiles(manifestFor({ slots: { repo: 'github', hosting: 'vercel', database: 'neon' } }))
    for (const path of PREVIEW_FILES) expect(files[path], path).toBeDefined()
    expect(JSON.parse(files['package.json']).dependencies['@neondatabase/serverless']).toBeDefined()
    const workflow = files['.github/workflows/preview-database.yml']
    expect(workflow).toContain('branches-ignore: [main]')
    expect(workflow).toContain('delete:')
    expect(workflow).toContain('secrets.NEON_API_KEY')
  })

  it('none of it for supabase, for shared previews, or without a repository', () => {
    for (const overrides of [
      { slots: { repo: 'github', hosting: 'vercel', database: 'supabase', auth: 'supabase' } },
      { slots: { repo: 'github', hosting: 'vercel', database: 'neon' }, environments: { dev: {}, preview: { database: 'shared' }, production: {} } },
      { slots: { repo: 'none', hosting: 'none', database: 'neon' } },
    ] as const) {
      const files = scaffoldFiles(manifestFor(overrides as never))
      for (const path of PREVIEW_FILES) expect(files[path], `${path} ${JSON.stringify(overrides)}`).toBeUndefined()
    }
  })
})

describe('BUG-95: the workflow script and the app find the preview database by the same branch name', () => {
  let server: Server | undefined
  afterEach(async () => {
    if (server) await new Promise((resolve) => server!.close(() => resolve(undefined)))
    server = undefined
    delete process.env.CIMIENTO_NEON_API
    delete process.env.NEON_API_KEY
  })

  /** A tiny Neon: projects the key reaches, branches, connection strings. */
  async function fakeNeon(projects = ['proj-one']): Promise<{ branches: { id: string; name: string }[]; calls: string[] }> {
    const branches = [{ id: 'br-main', name: 'main' }]
    const calls: string[] = []
    server = createServer((req, res) => {
      let body = ''
      req.on('data', (c) => (body += c))
      req.on('end', () => {
        const url = new URL(req.url ?? '/', 'http://x')
        calls.push(`${req.method} ${url.pathname}`)
        const send = (status: number, data?: unknown) => {
          res.writeHead(status, { 'content-type': 'application/json' })
          res.end(data === undefined ? '' : JSON.stringify(data))
        }
        if (req.headers.authorization !== 'Bearer neon-key-fake') return send(401, { message: 'unauthorized' })
        if (url.pathname === '/projects') return send(200, { projects: projects.map((id) => ({ id })) })
        const m = /^\/projects\/([^/]+)\/(branches|connection_uri)(?:\/([^/]+)(\/databases)?)?$/.exec(url.pathname)
        if (!m) return send(404, { message: 'no route' })
        if (m[2] === 'connection_uri') return send(200, { uri: `postgresql://u:p@ep-${url.searchParams.get('branch_id')}-pooler.example.neon.tech/neondb` })
        if (!m[3] && req.method === 'GET') return send(200, { branches })
        if (!m[3] && req.method === 'POST') {
          const name = (JSON.parse(body) as { branch: { name: string } }).branch.name
          const branch = { id: `br-${branches.length}`, name }
          branches.push(branch)
          return send(201, { branch })
        }
        const branch = branches.find((b) => b.id === m[3])
        if (!branch) return send(404, { message: 'not found' })
        if (m[4]) return send(200, { databases: [{ name: 'neondb', owner_name: 'neondb_owner' }] })
        if (req.method === 'DELETE') {
          branches.splice(branches.indexOf(branch), 1)
          return send(200, { branch })
        }
        return send(200, { branch })
      })
    })
    await new Promise((resolve) => server!.listen(0, '127.0.0.1', () => resolve(undefined)))
    process.env.CIMIENTO_NEON_API = `http://127.0.0.1:${(server!.address() as AddressInfo).port}`
    process.env.NEON_API_KEY = 'neon-key-fake'
    return { branches, calls }
  }

  /** The generated files, written to disk and imported the way the workflow and the app import them. */
  async function generated(): Promise<{ helper: Record<string, (...a: string[]) => Promise<unknown>> & { previewBranchName: (b: string) => string }; script: string }> {
    const files = scaffoldFiles(manifestFor({ slots: { repo: 'github', hosting: 'vercel', database: 'neon' } }))
    for (const path of ['lib/neon-preview.mjs', '.github/scripts/preview-database.mjs']) {
      mkdirSync(join(root, path, '..'), { recursive: true })
      writeFileSync(join(root, path), files[path])
    }
    const helper = await import(`${pathToFileURL(join(root, 'lib/neon-preview.mjs')).href}?t=${Date.now()}`)
    return { helper, script: join(root, '.github/scripts/preview-database.mjs') }
  }

  async function runScript(script: string, event: string, branch: string): Promise<{ code: number; out: string }> {
    const { execFile } = await import('node:child_process')
    return new Promise((resolve) => {
      execFile(process.execPath, [script], { env: { ...process.env, EVENT: event, GIT_BRANCH: branch } }, (err, stdout, stderr) => {
        resolve({ code: err ? ((err as { code?: number }).code ?? 1) : 0, out: `${stdout}${stderr}` })
      })
    })
  }

  it('one branch name everywhere: the generated helper agrees with cimiento on every shape of git branch', async () => {
    await fakeNeon()
    const { helper } = await generated()
    for (const name of ['feature/login', 'Feature/Login', 'fix.dots_and_more', '--dash-first', 'a//b', 'ÜBER/straße', '123']) {
      expect(helper.previewBranchName(name), name).toBe(previewBranchName(name))
    }
  })

  it('a push creates the Neon branch once, a second push changes nothing, deleting the git branch removes it', async () => {
    const neon = await fakeNeon()
    const { script } = await generated()
    const first = await runScript(script, 'push', 'feature/login')
    expect(first.code, first.out).toBe(0)
    expect(neon.branches.map((b) => b.name)).toEqual(['main', 'preview/feature-login'])
    const again = await runScript(script, 'push', 'feature/login')
    expect(again.code, again.out).toBe(0)
    expect(neon.branches).toHaveLength(2)
    const gone = await runScript(script, 'delete', 'feature/login')
    expect(gone.code, gone.out).toBe(0)
    expect(neon.branches.map((b) => b.name)).toEqual(['main'])
  })

  it('the app reads its own branch, says clearly when it does not exist yet, and never another project', async () => {
    const neon = await fakeNeon()
    const { helper } = await generated()
    await expect(helper.previewDatabaseUrl('feature/login')).rejects.toThrow(/No Neon branch preview\/feature-login.*never falls back to the production database/)
    neon.branches.push({ id: 'br-77', name: 'preview/feature-login' })
    const found = (await helper.previewDatabaseUrl('feature/login')) as { url: string; branch: string }
    expect(found.branch).toBe('preview/feature-login')
    expect(found.url).toContain('ep-br-77')
    expect(found.url).not.toContain('br-main')
  })

  it('a key that reaches more than one project is refused', async () => {
    await fakeNeon(['proj-one', 'proj-two'])
    const { helper } = await generated()
    await expect(helper.previewDatabaseUrl('feature/login')).rejects.toThrow(/reaches 2 Neon projects/)
  })
})

describe('BUG-96: cimiento makes the key the workflow and the previews use, scoped to the one Neon project', () => {
  it('new mints one project-scoped key, keeps it, writes it to the Actions secret and to previews only; up reuses it; down revokes it', async () => {
    const cloud = new FakeCloud({ ghDeleteScope: true })
    await made(cloud, VERCEL_NEON)
    const stack = readFileSync(join(dir, 'stack.yaml'), 'utf8')
    expect(stack).toMatch(/- name: NEON_API_KEY[\s\S]*?source: generated/)
    const project = [...cloud.v2.neonProjects.values()][0]
    const keys = cloud.v2.neonApiKeys.filter((k) => !k.revoked)
    expect(keys).toHaveLength(1)
    expect(keys[0].project_id).toBe(project.id)
    const value = keys[0].key
    const repo = [...cloud.actionsSecrets.keys()][0]
    expect(cloud.actionsSecrets.get(repo)?.get('NEON_API_KEY')).toBe(value)
    const projectId = [...cloud.vercelProjects.values()][0].id
    const env = (cloud.vercelEnv.get(projectId) ?? []).filter((e) => e.key === 'NEON_API_KEY')
    expect(env.map((e) => e.target)).toEqual([['preview']])
    expect(env[0].value).toBe(value)

    const up = await cli(cloud, ['up', '--json', '--yes'])
    expect(up.code, up.writer.outText.slice(-800)).toBe(ExitCode.ok)
    expect(up.writer.outText).not.toContain(value)
    expect(cloud.v2.neonApiKeys).toHaveLength(1)

    const down = await cli(cloud, ['down', '--yes', '--json'])
    expect(down.code, down.writer.outText.slice(-800)).toBe(ExitCode.ok)
    expect(cloud.v2.neonApiKeys.every((k) => k.revoked)).toBe(true)
  })

  it('a key whose value is gone from the keychain is replaced, the old one revoked, and every place that held it rewritten', async () => {
    const cloud = new FakeCloud({ ghDeleteScope: true })
    await made(cloud, VERCEL_NEON)
    for (const account of [...cloud.keychain.keys()]) if (account.endsWith('/NEON_API_KEY')) cloud.keychain.delete(account)
    cloud.keychainEmpty = true
    const up = await cli(cloud, ['up', '--json', '--yes'])
    expect(up.code, up.writer.outText.slice(-800)).toBe(ExitCode.ok)
    const live = cloud.v2.neonApiKeys.filter((k) => !k.revoked)
    expect(live).toHaveLength(1)
    expect(cloud.v2.neonApiKeys).toHaveLength(2)
    const repo = [...cloud.actionsSecrets.keys()][0]
    expect(cloud.actionsSecrets.get(repo)?.get('NEON_API_KEY')).toBe(live[0].key)
    const projectId = [...cloud.vercelProjects.values()][0].id
    expect((cloud.vercelEnv.get(projectId) ?? []).find((e) => e.key === 'NEON_API_KEY')?.value).toBe(live[0].key)
  })
})

describe('BUG-97: a branch the workflow made is a working preview database, even before cimiento up writes its address', () => {
  it('doctor passes the preview check when the Neon branch exists and previews hold the key', async () => {
    const cloud = new FakeCloud({ ghDeleteScope: true })
    await made(cloud, VERCEL_NEON)
    cloud.pushedBranches.set('feature/login', cloud.gitSha())
    const project = [...cloud.v2.neonProjects.values()][0]
    project.branches.push({ id: 'br-by-workflow', name: 'preview/feature-login' })
    const projectId = [...cloud.vercelProjects.values()][0].id
    const list = cloud.deployments.get(projectId) ?? []
    list.unshift({ uid: 'dpl_branch', url: 'my-app-git-preview.vercel.app', readyState: 'READY', target: null as unknown as string, createdAt: Date.now(), meta: { githubCommitSha: cloud.gitSha(), githubCommitRef: 'feature/login' } })
    cloud.deployments.set(projectId, list)
    const doctor = await cli(cloud, ['doctor', '--json'])
    const items = (doctor.writer.jsonObjects().pop() as { items: { id: string; ok: boolean; evidence?: string }[] }).items
    const preview = items.find((i) => i.id === 'neon.preview-branches')
    expect(preview?.ok, JSON.stringify(preview)).toBe(true)
  })
})

describe('BUG-98: a project made from flags with a template got no workflows', () => {
  it('new with --template nextjs-app writes scaffold.ci true and the preview database workflow', async () => {
    const result = await cli(new FakeCloud(), ['new', 'my-app', ...VERCEL_NEON, '--scaffold-only', '--json', '--dir', dir], root)
    expect(result.code, result.writer.outText.slice(-500)).toBe(ExitCode.ok)
    expect(readFileSync(join(dir, 'stack.yaml'), 'utf8')).toMatch(/scaffold:\n  template: nextjs-app\n  claude_md: true\n  ci: true/)
    expect(readFileSync(join(dir, '.github/workflows/preview-database.yml'), 'utf8')).toContain('NEON_API_KEY')
  })
})

describe('BUG-99 and BUG-100: the commit stamp on CLI deploys works with cimiento state changed', () => {
  async function demo(cloud: FakeCloud): Promise<void> {
    await made(cloud, ['--preset', 'designer'])
    const file = join(dir, 'stack.yaml')
    writeFileSync(file, readFileSync(file, 'utf8').replace(/^secrets: \[\]\n/m, 'secrets:\n  - name: DEMO_TOKEN\n    sinks: [hosting]\n    environments: [production]\n    source: env\n'))
    process.env.DEMO_TOKEN = 'demo-first-value-not-a-real-key'
    expect((await cli(cloud, ['up', '--json', '--yes'])).code).toBe(ExitCode.ok)
    // Everything committed and pushed, as after a publish.
    cloud.gitDirtyPaths = ['stack.yaml', '.cimiento/state.json']
    expect((await cli(cloud, ['publish', '--json'])).code).toBe(ExitCode.ok)
  }

  afterEach(() => {
    delete process.env.DEMO_TOKEN
  })

  it('a deploy from a tree where only .cimiento changed carries the commit, and publish reads it back', async () => {
    const cloud = new FakeCloud({ ghDeleteScope: true })
    await demo(cloud)
    const head = cloud.gitSha()
    // secret set writes state, then deploys again from the CLI.
    process.env.DEMO_TOKEN = 'demo-second-value-not-a-real-key'
    cloud.gitDirtyPaths = ['.cimiento/state.json']
    const set = await cli(cloud, ['secret', 'set', 'DEMO_TOKEN', '--json'])
    expect(set.code, set.writer.outText.slice(-600)).toBe(ExitCode.ok)
    const project = [...cloud.vercelProjects.values()][0]
    const cliDeploy = (cloud.deployments.get(project.id) ?? []).find((d) => d.readyState === 'READY' && d.target === 'production')!
    expect((cliDeploy.meta as Record<string, string> | undefined)?.cimientoCommit).toBe(head)

    // publish commits the state, pushes it, and needs no deploy: the app is the stamped commit.
    const publish = await cli(cloud, ['publish', '--json'])
    expect(publish.code, publish.writer.outText.slice(-600)).toBe(ExitCode.ok)
    const result = publish.writer.jsonObjects().pop() as { stages: Record<string, string>; live: { commit: string; source: string } }
    expect(result.stages).toMatchObject({ commit: 'done', push: 'done', deploy: 'skipped' })
    expect(result.live).toMatchObject({ commit: head, source: 'cimiento stamp' })
  })
})
