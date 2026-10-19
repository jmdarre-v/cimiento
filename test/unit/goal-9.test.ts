// Goal 9: close the Goal 8 limits. Each BUG test here was run red on the code before its fix
// (docs/FIELD-TEST-9.md lists the commits).

import { execFile } from 'node:child_process'
import { mkdirSync, readFileSync, writeFileSync } from 'node:fs'
import { createServer, type Server } from 'node:http'
import type { AddressInfo } from 'node:net'
import { join } from 'node:path'
import { pathToFileURL } from 'node:url'
import { afterEach, beforeEach, describe, expect, it } from 'vitest'
import { run } from '../../src/cli/index'
import { ExitCode } from '../../src/core/errors'
import { previewBranchName } from '../../src/core/hosting'
import { clearToolUpdateCache } from '../../src/core/toolkit'
import { scaffoldFiles } from '../../src/scaffold'
import { FakeCloud } from './fake-cloud'
import { CaptureWriter, manifestFor, personDoesIt, removeDir, tempDir, useFakeTokens } from './helpers'

let root = ''
let dir = ''
let configDir = ''

beforeEach(() => {
  useFakeTokens()
  clearToolUpdateCache()
  root = tempDir('cimiento-goal9-')
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

async function made(cloud: FakeCloud, args: string[]): Promise<void> {
  const result = await cli(cloud, ['new', 'my-app', ...args, '--json', '--yes', '--dir', dir], root)
  expect(result.code, result.writer.outText.slice(-800)).toBe(ExitCode.ok)
}

const VERCEL_NEON = ['--repo', 'github', '--hosting', 'vercel', '--database', 'neon', '--template', 'nextjs-app']

describe('BUG-105: previews held a Neon key that can read the production branch', () => {
  it('no Neon key or project id in the hosting env; the workflow gets the Neon key, a Vercel token cimiento makes and the ids it needs', async () => {
    const cloud = new FakeCloud({ ghDeleteScope: true })
    await made(cloud, VERCEL_NEON)
    expect(readFileSync(join(dir, 'stack.yaml'), 'utf8')).toMatch(/- name: NEON_API_KEY\n    sinks:\n      - ci\n    environments/)
    const project = [...cloud.vercelProjects.values()][0]
    const env = cloud.vercelEnv.get(project.id) ?? []
    expect(env.filter((e) => /^NEON_/.test(e.key))).toEqual([])
    const repo = [...cloud.actionsSecrets.keys()][0]
    const secrets = cloud.actionsSecrets.get(repo)!
    for (const name of ['NEON_API_KEY', 'NEON_PROJECT_ID', 'VERCEL_TOKEN', 'VERCEL_PROJECT_ID', 'VERCEL_TEAM_ID']) expect(secrets.has(name), name).toBe(true)
    expect(secrets.get('VERCEL_PROJECT_ID')).toBe(project.id)
    const tokens = cloud.vercelTokens.filter((t) => !t.revoked)
    expect(tokens).toHaveLength(1)
    expect(secrets.get('VERCEL_TOKEN')).toBe(tokens[0].bearerToken)

    const again = await cli(cloud, ['up', '--json', '--yes'])
    expect(again.code, again.writer.outText.slice(-800)).toBe(ExitCode.ok)
    expect(cloud.vercelTokens).toHaveLength(1)
    const down = await cli(cloud, ['down', '--yes', '--json'])
    expect(down.code, down.writer.outText.slice(-800)).toBe(ExitCode.ok)
    expect(cloud.vercelTokens.every((t) => t.revoked)).toBe(true)
  })
})

describe('BUG-107: the app looked its database up with a Neon key at request time', () => {
  it('the app reads DATABASE_URL only; the Neon helper lives with the workflow; the route says whether a Neon key is in reach', () => {
    const files = scaffoldFiles(manifestFor({ slots: { repo: 'github', hosting: 'vercel', database: 'neon' } }))
    expect(files['lib/neon-preview.mjs']).toBeUndefined()
    expect(files['lib/neon-preview.d.mts']).toBeUndefined()
    expect(files['.github/scripts/neon-preview.mjs']).toBeDefined()
    expect(files['lib/db.ts']).not.toMatch(/neon-preview|NEON_API_KEY|NEON_PROJECT_ID/)
    expect(files['lib/db.ts']).toContain('preview database workflow')
    expect(files['app/api/cimiento/database/route.ts']).toContain('const neonKeyInEnv = Boolean(process.env.NEON_API_KEY)')
    const workflow = files['.github/workflows/preview-database.yml']
    for (const name of ['NEON_API_KEY', 'NEON_PROJECT_ID', 'VERCEL_TOKEN', 'VERCEL_PROJECT_ID', 'VERCEL_TEAM_ID']) expect(workflow).toContain(`secrets.${name}`)
    expect(workflow).toContain('HOSTING: vercel')
  })
})

describe('BUG-106: the workflow writes only the branch address into the hosting env, and removes it with the branch', () => {
  let server: Server | undefined
  afterEach(async () => {
    if (server) await new Promise((resolve) => server!.close(() => resolve(undefined)))
    server = undefined
  })

  interface World {
    branches: { id: string; name: string }[]
    vercelEnv: { id: string; key: string; value: string; target: string[]; gitBranch?: string; type: string }[]
    deployments: { gitSource: { ref: string; sha: string; repoId: number } }[]
    netlifyEnv: { key: string; values: { id: string; context: string; context_parameter?: string; value: string }[] }[]
    netlifyBuilds: string[]
  }

  /** Neon, Vercel and Netlify as the workflow sees them, on one local port. */
  async function world(): Promise<{ w: World; base: string }> {
    const w: World = { branches: [{ id: 'br-main', name: 'main' }], vercelEnv: [], deployments: [], netlifyEnv: [], netlifyBuilds: [] }
    let n = 0
    server = createServer((req, res) => {
      let body = ''
      req.on('data', (c) => (body += c))
      req.on('end', () => {
        const url = new URL(req.url ?? '/', 'http://x')
        const send = (status: number, data?: unknown) => {
          res.writeHead(status, { 'content-type': 'application/json' })
          res.end(data === undefined ? '' : JSON.stringify(data))
        }
        const input = body ? JSON.parse(body) : {}
        const path = url.pathname
        if (path.startsWith('/neon')) {
          if (req.headers.authorization !== 'Bearer neon-key-fake') return send(401, { message: 'unauthorized' })
          const p = path.replace('/neon', '')
          const m = /^\/projects\/proj-one(?:\/(branches|connection_uri)(?:\/([^/]+)(\/databases)?)?)?$/.exec(p)
          if (!m) return send(404, { message: 'not allowed outside the project' })
          if (!m[1]) return send(200, { project: { id: 'proj-one' } })
          if (m[1] === 'connection_uri') return send(200, { uri: `postgresql://u:p@ep-${url.searchParams.get('branch_id')}${url.searchParams.get('pooled') === 'true' ? '-pooler' : ''}.example.neon.tech/neondb` })
          if (!m[2] && req.method === 'GET') return send(200, { branches: w.branches })
          if (!m[2] && req.method === 'POST') {
            const branch = { id: `br-${++n}`, name: input.branch.name }
            w.branches.push(branch)
            return send(201, { branch })
          }
          const branch = w.branches.find((b) => b.id === m[2])
          if (!branch) return send(404, {})
          if (m[3]) return send(200, { databases: [{ name: 'neondb', owner_name: 'neondb_owner' }] })
          if (req.method === 'DELETE') w.branches.splice(w.branches.indexOf(branch), 1)
          return send(200, { branch })
        }
        if (path.startsWith('/vercel')) {
          if (req.headers.authorization !== 'Bearer vercel-token-fake' || url.searchParams.get('teamId') !== 'team_fake') return send(403, { error: { message: 'forbidden' } })
          const p = path.replace('/vercel', '')
          if (p === '/v9/projects/prj_one' && req.method === 'GET') return send(200, { id: 'prj_one', name: 'my-app', link: { type: 'github', repoId: 4242 } })
          if (p === '/v9/projects/prj_one/env' && req.method === 'GET') return send(200, { envs: w.vercelEnv.map(({ value: _v, ...e }) => e) })
          if (p === '/v10/projects/prj_one/env' && req.method === 'POST') {
            const same = w.vercelEnv.findIndex((e) => e.key === input.key && e.gitBranch === input.gitBranch && e.target.join() === input.target.join())
            if (same >= 0) w.vercelEnv.splice(same, 1)
            w.vercelEnv.push({ id: `env_${++n}`, ...input })
            return send(200, {})
          }
          const one = /^\/v9\/projects\/prj_one\/env\/([^/]+)$/.exec(p)
          if (one && req.method === 'DELETE') {
            w.vercelEnv = w.vercelEnv.filter((e) => e.id !== one[1])
            return send(200, {})
          }
          if (p === '/v13/deployments' && req.method === 'POST') {
            w.deployments.push(input)
            return send(200, { id: `dpl_${n}` })
          }
          return send(404, {})
        }
        if (path.startsWith('/netlify')) {
          if (req.headers.authorization !== 'Bearer netlify-token-fake') return send(401, {})
          const p = path.replace('/netlify', '')
          if (p === '/sites/site-one' && req.method === 'GET') return send(200, { id: 'site-one', account_id: 'acct-one' })
          if (p === '/accounts/acct-one/env' && req.method === 'GET') return send(200, w.netlifyEnv)
          if (p === '/accounts/acct-one/env' && req.method === 'POST') {
            for (const v of input) w.netlifyEnv.push({ key: v.key, values: v.values.map((x: object) => ({ id: `val_${++n}`, ...x })) })
            return send(201, input)
          }
          const key = /^\/accounts\/acct-one\/env\/([^/]+)(?:\/value\/([^/]+))?$/.exec(p)
          const entry = key ? w.netlifyEnv.find((e) => e.key === key[1]) : undefined
          if (key && entry && req.method === 'PATCH') {
            const existing = entry.values.find((v) => v.context === input.context && v.context_parameter === input.context_parameter)
            if (existing) existing.value = input.value
            else entry.values.push({ id: `val_${++n}`, ...input })
            return send(200, entry)
          }
          if (key && entry && key[2] && req.method === 'DELETE') {
            entry.values = entry.values.filter((v) => v.id !== key[2])
            return send(204)
          }
          if (p === '/sites/site-one/builds' && req.method === 'POST') {
            w.netlifyBuilds.push(url.searchParams.get('branch') ?? '')
            return send(200, {})
          }
          return send(404, {})
        }
        return send(404, {})
      })
    })
    await new Promise((resolve) => server!.listen(0, '127.0.0.1', () => resolve(undefined)))
    return { w, base: `http://127.0.0.1:${(server!.address() as AddressInfo).port}` }
  }

  async function scripts(hosting: 'vercel' | 'netlify'): Promise<string> {
    const files = scaffoldFiles(manifestFor({ slots: { repo: 'github', hosting, database: 'neon' } }))
    for (const path of ['.github/scripts/neon-preview.mjs', '.github/scripts/preview-database.mjs']) {
      mkdirSync(join(root, path, '..'), { recursive: true })
      writeFileSync(join(root, path), files[path])
    }
    return join(root, '.github/scripts/preview-database.mjs')
  }

  function runScript(script: string, env: Record<string, string>): Promise<{ code: number; out: string }> {
    return new Promise((resolve) => {
      execFile(process.execPath, [script], { env: { ...process.env, ...env } }, (err, stdout, stderr) => {
        resolve({ code: err ? ((err as { code?: number }).code ?? 1) : 0, out: `${stdout}${stderr}` })
      })
    })
  }

  function common(base: string): Record<string, string> {
    return { CIMIENTO_NEON_API: `${base}/neon`, NEON_API_KEY: 'neon-key-fake', NEON_PROJECT_ID: 'proj-one', GIT_BRANCH: 'feature/login', GIT_SHA: 'abc123' }
  }

  it('one branch name everywhere: the workflow helper agrees with cimiento', async () => {
    await scripts('vercel')
    const helper = await import(`${pathToFileURL(join(root, '.github/scripts/neon-preview.mjs')).href}?t=${Date.now()}`)
    for (const name of ['feature/login', 'Feature/Login', 'fix.dots_and_more', '--dash-first', 'a//b', 'ÜBER/straße', '123']) {
      expect(helper.previewBranchName(name), name).toBe(previewBranchName(name))
    }
  })

  it('Vercel: a push makes the Neon branch, writes both addresses for that git branch only and deploys once; a second push changes nothing; delete removes both', async () => {
    const { w, base } = await world()
    const script = await scripts('vercel')
    const env = { ...common(base), HOSTING: 'vercel', CIMIENTO_VERCEL_API: `${base}/vercel`, VERCEL_TOKEN: 'vercel-token-fake', VERCEL_PROJECT_ID: 'prj_one', VERCEL_TEAM_ID: 'team_fake' }
    const push = await runScript(script, { ...env, EVENT: 'push' })
    expect(push.code, push.out).toBe(0)
    expect(w.branches.map((b) => b.name)).toEqual(['main', 'preview/feature-login'])
    expect(w.vercelEnv.map((e) => [e.key, e.gitBranch, e.target.join(), e.type]).sort()).toEqual([
      ['DATABASE_URL', 'feature/login', 'preview', 'encrypted'],
      ['DATABASE_URL_UNPOOLED', 'feature/login', 'preview', 'encrypted'],
    ])
    expect(w.vercelEnv.find((e) => e.key === 'DATABASE_URL')!.value).toContain('-pooler')
    expect(w.vercelEnv.every((e) => !e.value.includes('br-main'))).toBe(true)
    expect(w.deployments.map((d) => d.gitSource)).toEqual([{ type: 'github', repoId: 4242, ref: 'feature/login', sha: 'abc123' }])

    const again = await runScript(script, { ...env, EVENT: 'push' })
    expect(again.code, again.out).toBe(0)
    expect(w.branches).toHaveLength(2)
    expect(w.vercelEnv).toHaveLength(2)
    expect(w.deployments).toHaveLength(1)

    const gone = await runScript(script, { ...env, EVENT: 'delete' })
    expect(gone.code, gone.out).toBe(0)
    expect(w.vercelEnv).toEqual([])
    expect(w.branches.map((b) => b.name)).toEqual(['main'])
  })

  it('Netlify: the same with branch context values and a build of the branch', async () => {
    const { w, base } = await world()
    const script = await scripts('netlify')
    const env = { ...common(base), HOSTING: 'netlify', CIMIENTO_NETLIFY_API: `${base}/netlify`, NETLIFY_AUTH_TOKEN: 'netlify-token-fake', NETLIFY_SITE_ID: 'site-one' }
    const push = await runScript(script, { ...env, EVENT: 'push' })
    expect(push.code, push.out).toBe(0)
    const values = w.netlifyEnv.flatMap((e) => e.values.map((v) => [e.key, v.context, v.context_parameter]))
    expect(values.sort()).toEqual([
      ['DATABASE_URL', 'branch', 'feature/login'],
      ['DATABASE_URL_UNPOOLED', 'branch', 'feature/login'],
    ])
    expect(w.netlifyBuilds).toEqual(['feature/login'])
    await runScript(script, { ...env, EVENT: 'push' })
    expect(w.netlifyBuilds).toHaveLength(1)
    const gone = await runScript(script, { ...env, EVENT: 'delete' })
    expect(gone.code, gone.out).toBe(0)
    expect(w.netlifyEnv.flatMap((e) => e.values)).toEqual([])
    expect(w.branches.map((b) => b.name)).toEqual(['main'])
  })
})

describe('BUG-108: down left the project\'s secrets on this machine', () => {
  it('a clean down removes every keychain entry of the project and the .env.local cimiento pulled, and nothing of another project', async () => {
    const cloud = new FakeCloud({ ghDeleteScope: true, keychain: { 'my-app/RESEND_API_KEY': 're_fake_not_a_real_key', 'other-app/RESEND_API_KEY': 're_other_fake_not_a_real_key' } })
    await made(cloud, VERCEL_NEON)
    // A value cimiento stored for a secret the project no longer declares is the project's too.
    cloud.keychain.set('my-app/OLD_SECRET', 'old-fake-value')
    const pull = await cli(cloud, ['env', 'pull', '--json'])
    expect(pull.code, pull.writer.outText.slice(-400)).toBe(ExitCode.ok)
    writeFileSync(join(dir, '.env.local'), '# Created by Vercel CLI\nDATABASE_URL="fake"\n')
    expect([...cloud.keychain.keys()].filter((k) => k.startsWith('my-app/')).length).toBeGreaterThan(1)

    const down = await cli(cloud, ['down', '--yes', '--json'])
    expect(down.code, down.writer.outText.slice(-600)).toBe(ExitCode.ok)
    expect([...cloud.keychain.keys()].filter((k) => k.startsWith('my-app/'))).toEqual([])
    expect(cloud.keychain.get('other-app/RESEND_API_KEY')).toBe('re_other_fake_not_a_real_key')
    const { existsSync } = await import('node:fs')
    expect(existsSync(join(dir, '.env.local'))).toBe(false)
    expect(down.writer.outText).not.toContain('old-fake-value')
  })

  it('a down that still waits on something keeps the local secrets, so the next down can finish', async () => {
    const cloud = new FakeCloud({ ghDeleteScope: false })
    await made(cloud, VERCEL_NEON)
    const down = await cli(cloud, ['down', '--yes', '--json'])
    expect(down.code).not.toBe(ExitCode.ok)
    expect([...cloud.keychain.keys()].some((k) => k.startsWith('my-app/'))).toBe(true)
  })
})
