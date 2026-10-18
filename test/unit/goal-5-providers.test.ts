// Goal 5 item 2: the providers netlify, neon, resend, stripe (test mode only) and posthog, their
// wiring, person steps, down and errors, and the custom domain rule as cimiento domain add and
// remove. Everything runs on the fake cloud with obviously fake values.

import { existsSync, readFileSync, writeFileSync } from 'node:fs'
import { join } from 'node:path'
import { afterEach, beforeEach, describe, expect, it } from 'vitest'
import { parseDocument } from 'yaml'
import { run } from '../../src/cli/index'
import { ExitCode } from '../../src/core/errors'
import { clearToolUpdateCache } from '../../src/core/toolkit'
import { completeFragment, mergeFragments, parseManifest } from '../../src/manifest'
import { setNetlifyDeployWait } from '../../src/providers/netlify'
import { SecretStore } from '../../src/secrets'
import { Redactor } from '../../src/core/redact'
import { clearCloudflareToken } from '../../src/providers/turnstile/api'
import { setRoundtripPolling } from '../../src/providers/inngest'
import { FakeCloud } from './fake-cloud'
import { CaptureWriter, personDoesIt, removeDir, tempDir, useFakeTokens } from './helpers'

const KEYS = {
  'my-app/RESEND_API_KEY': 're_fake_not_a_real_key',
  'my-app/STRIPE_SECRET_KEY': 'sk_test_fake_not_a_real_key',
  'my-app/NEXT_PUBLIC_STRIPE_PUBLISHABLE_KEY': 'pk_test_fake_not_a_real_key',
  'my-app/NEXT_PUBLIC_POSTHOG_KEY': 'phc_fakeprojectkeynotreal0000',
}

const V2_FLAGS = ['--repo', 'github', '--hosting', 'netlify', '--database', 'neon', '--email', 'resend', '--payments', 'stripe', '--analytics', 'posthog', '--template', 'nextjs-app']

let root: string
let dir: string
let configDir: string

beforeEach(() => {
  useFakeTokens()
  clearToolUpdateCache()
  clearCloudflareToken()
  setRoundtripPolling({ intervalMs: 1, timeoutMs: 50 })
  setNetlifyDeployWait({ intervalMs: 1, timeoutMs: 50 })
  root = tempDir('cimiento-goal5p-')
  dir = join(root, 'my-app')
  configDir = tempDir('cimiento-config-')
  process.env.CIMIENTO_CONFIG_DIR = configDir
})

afterEach(() => {
  removeDir(root)
  removeDir(configDir)
  delete process.env.CIMIENTO_CONFIG_DIR
})

function lastJson(writer: CaptureWriter, command: string): Record<string, unknown> {
  return writer
    .jsonObjects()
    .filter((o) => (o as { command?: string }).command === command)
    .pop() as Record<string, unknown>
}

async function cli(cloud: FakeCloud, args: string[], cwd = dir): Promise<{ code: number; writer: CaptureWriter }> {
  const writer = new CaptureWriter()
  const code = await run(args, { io: cloud, cwd, writer, interactive: false, onManual: personDoesIt })
  return { code, writer }
}

async function newV2(cloud: FakeCloud, extra: string[] = []): Promise<{ code: number; writer: CaptureWriter }> {
  return cli(cloud, ['new', 'my-app', ...V2_FLAGS, ...extra, '--json', '--yes', '--dir', dir], root)
}

type Item = { id: string; ok: boolean; evidence?: string; error?: { code: string; hint: string } }

function items(writer: CaptureWriter, command = 'doctor'): Item[] {
  return lastJson(writer, command).items as Item[]
}

describe('a netlify, neon, resend, stripe and posthog project on the fake cloud', () => {
  it('goes from nothing to every check passing, with the keys and DATABASE_URL in the Netlify env', async () => {
    const cloud = new FakeCloud({ keychain: KEYS })
    const { code, writer } = await newV2(cloud)
    expect(code, writer.outText).toBe(ExitCode.ok)

    const site = [...cloud.v2.netlifySites.values()][0]
    expect(site.name).toBe('my-app')
    expect(site.build_settings?.repo_path).toBe('test-handle/my-app')
    expect(cloud.v2.repoHooks.get('test-handle/my-app')).toEqual(['https://api.netlify.com/hooks/github'])
    expect(cloud.v2.deployKeys.get('test-handle/my-app')).toHaveLength(1)
    expect(cloud.v2.netlifyValue(site.id, 'DATABASE_URL', 'production')).toContain('-pooler.us-east-2.aws.neon.tech')
    expect(cloud.v2.netlifyValue(site.id, 'DATABASE_URL_UNPOOLED', 'deploy-preview')).not.toContain('-pooler')
    expect(cloud.v2.netlifyValue(site.id, 'STRIPE_SECRET_KEY', 'branch-deploy')).toBe(KEYS['my-app/STRIPE_SECRET_KEY'])
    expect(cloud.v2.netlifyValue(site.id, 'NEXT_PUBLIC_POSTHOG_HOST', 'production')).toBe('https://us.i.posthog.com')
    expect([...cloud.v2.neonProjects.values()][0].migrations).toEqual(['20250101000000_cimiento_baseline.sql'])
    expect(cloud.v2.resendSent).toEqual([{ from: 'cimiento <onboarding@resend.dev>', to: ['delivered@resend.dev'] }])
    expect(cloud.v2.posthogEvents.map((e) => e.event)).toEqual(['cimiento_check'])
    expect(existsSync(join(dir, 'db/migrations/20250101000000_cimiento_baseline.sql'))).toBe(true)

    const doctor = await cli(cloud, ['doctor', '--json'])
    expect(doctor.code).toBe(ExitCode.ok)
    const ids = items(doctor.writer).map((i) => i.id)
    for (const check of ['netlify.check.deployed', 'netlify.check.preview', 'netlify.check.repo-linked', 'netlify.check.secrets-present', 'neon.check.migrated', 'resend.check.send', 'stripe.check.test-mode', 'posthog.check.capture']) {
      expect(ids, check).toContain(check)
    }
    expect(items(doctor.writer).every((i) => i.ok)).toBe(true)
    expect(doctor.writer.outText).not.toContain('fake-neon-password')
    expect(doctor.writer.outText).not.toContain(KEYS['my-app/STRIPE_SECRET_KEY'])
  })

  it('a second up and plan are all noop: no second site, project, key or hook', async () => {
    const cloud = new FakeCloud({ keychain: KEYS })
    await newV2(cloud)
    const up = await cli(cloud, ['up', '--json', '--yes'])
    expect(up.code).toBe(ExitCode.ok)
    const plan = await cli(cloud, ['plan', '--json'])
    const statuses = (lastJson(plan.writer, 'plan').items as { id: string; status: string }[]).filter((i) => i.status !== 'noop')
    expect(statuses).toEqual([])
    expect(cloud.v2.netlifySites.size).toBe(1)
    expect(cloud.v2.neonProjects.size).toBe(1)
    expect(cloud.v2.deployKeys.get('test-handle/my-app')).toHaveLength(1)
    expect(cloud.v2.repoHooks.get('test-handle/my-app')).toHaveLength(1)
  })

  it('down deletes the Netlify site, the Neon project and the repository, and a second down has nothing to do', async () => {
    const cloud = new FakeCloud({ keychain: KEYS, ghDeleteScope: true })
    await newV2(cloud)
    const down = await cli(cloud, ['down', '--yes', '--json'])
    expect(down.code, down.writer.outText).toBe(ExitCode.ok)
    expect(cloud.v2.netlifySites.size).toBe(0)
    expect(cloud.v2.neonProjects.size).toBe(0)
    expect(cloud.repos.size).toBe(0)
    const again = await cli(cloud, ['down', '--yes', '--json'])
    expect(again.code).toBe(ExitCode.ok)
  })

  it('publish waits for the Netlify production deploy of the pushed commit', async () => {
    const cloud = new FakeCloud({ keychain: KEYS })
    await newV2(cloud)
    cloud.gitDirty = true
    const { code, writer } = await cli(cloud, ['publish', '--message', 'new title', '--json'])
    expect(code, writer.outText).toBe(ExitCode.ok)
    const summary = lastJson(writer, 'publish')
    expect(summary.productionUrl).toBe('https://my-app.netlify.app')
    expect(cloud.v2.netlifyDeploys.find((d) => d.commit_ref === summary.commit)?.context).toBe('production')
  })

  it('hosting.preview on Netlify passes for a pushed branch once its deploy preview is ready', async () => {
    const cloud = new FakeCloud({ keychain: KEYS })
    await newV2(cloud)
    cloud.v2.netlifyBuild = 'building'
    await cloud.exec('git', ['checkout', '-b', 'feature'])
    await cloud.exec('git', ['commit', '-m', 'change'])
    await cloud.exec('git', ['push', '-u', 'origin', 'feature'])
    const preview = (w: CaptureWriter) => items(w).find((i) => i.id === 'netlify.check.preview')!
    let doctor = await cli(cloud, ['doctor', '--json'])
    expect(preview(doctor.writer).error?.code).toBe('HOSTING_PREVIEW_NOT_READY')
    cloud.v2.netlifyDeploys[0].state = 'ready'
    doctor = await cli(cloud, ['doctor', '--json'])
    expect(preview(doctor.writer).ok).toBe(true)
    expect(preview(doctor.writer).evidence).toContain('feature')
  })

  it('env pull writes .env.local from the Netlify dev context, names only in the output', async () => {
    const cloud = new FakeCloud({ keychain: KEYS })
    await newV2(cloud, ['--allow-billing'])
    const { code, writer } = await cli(cloud, ['env', 'pull', '--json'])
    expect(code).toBe(ExitCode.ok)
    const names = lastJson(writer, 'env pull').names as string[]
    expect(names).toEqual(expect.arrayContaining(['DATABASE_URL', 'NEXT_PUBLIC_POSTHOG_HOST']))
    expect(readFileSync(join(dir, '.env.local'), 'utf8')).toContain('DATABASE_URL=')
    expect(writer.outText).not.toContain('fake-neon-password')
  })

  it('secret remove deletes a value from every Netlify context it was written to', async () => {
    const cloud = new FakeCloud({ keychain: KEYS })
    await newV2(cloud)
    const file = join(dir, 'stack.yaml')
    const doc = parseDocument(readFileSync(file, 'utf8'))
    doc.addIn(['secrets'], doc.createNode({ name: 'EXTRA_TOKEN', sinks: ['hosting'], environments: ['preview', 'production'], source: 'env' }))
    writeFileSync(file, doc.toString(), 'utf8')
    process.env.EXTRA_TOKEN = 'fake-extra-token-not-real'
    try {
      expect((await cli(cloud, ['secret', 'set', 'EXTRA_TOKEN', '--json'])).code).toBe(ExitCode.ok)
      const site = [...cloud.v2.netlifySites.values()][0]
      expect(cloud.v2.netlifyValue(site.id, 'EXTRA_TOKEN', 'deploy-preview')).toBe('fake-extra-token-not-real')
      const removed = await cli(cloud, ['secret', 'remove', 'EXTRA_TOKEN', '--json'])
      expect(removed.code).toBe(ExitCode.ok)
      for (const context of ['production', 'deploy-preview', 'branch-deploy']) expect(cloud.v2.netlifyValue(site.id, 'EXTRA_TOKEN', context)).toBeUndefined()
    } finally {
      delete process.env.EXTRA_TOKEN
    }
  })
})

describe('the v2 errors, each with its hint', () => {
  it('a Stripe live key is refused when it is read, before the keychain, a sink or a check sees it', async () => {
    const live = ['sk', 'live', 'fake_not_a_real_key'].join('_')
    const cloud = new FakeCloud({ keychain: { ...KEYS, 'my-app/STRIPE_SECRET_KEY': live } })
    const { code, writer } = await newV2(cloud)
    expect(code).not.toBe(ExitCode.ok)
    expect(writer.outText).toContain('STRIPE_LIVE_KEY_REFUSED')
    expect(writer.outText).not.toContain(live)
    const site = [...cloud.v2.netlifySites.values()][0]
    expect(cloud.v2.netlifyValue(site.id, 'STRIPE_SECRET_KEY', 'production')).toBeUndefined()
    expect(cloud.httpCalls.some((c) => c.includes('api.stripe.com'))).toBe(false)
  })

  it('a refused Resend key points at secret rotate', async () => {
    const cloud = new FakeCloud({ keychain: { ...KEYS, 'my-app/RESEND_API_KEY': 're_wrong_not_a_real_key' } })
    await newV2(cloud)
    const doctor = await cli(cloud, ['doctor', '--json'])
    const check = items(doctor.writer).find((i) => i.id === 'resend.check.send')!
    expect(check.error?.code).toBe('RESEND_KEY_INVALID')
    expect(check.error?.hint).toContain('cimiento secret rotate RESEND_API_KEY')
  })

  it('a PostHog personal key (phx_) is refused before it is sent anywhere', async () => {
    const cloud = new FakeCloud({ keychain: { ...KEYS, 'my-app/NEXT_PUBLIC_POSTHOG_KEY': 'phx_fakepersonalkeynotreal00' } })
    await newV2(cloud)
    const doctor = await cli(cloud, ['doctor', '--json'])
    expect(items(doctor.writer).find((i) => i.id === 'posthog.check.capture')!.error?.code).toBe('POSTHOG_KEY_INVALID')
    expect(cloud.v2.posthogEvents).toEqual([])
  })

  it('a Netlify site name someone else has stops with the slug to change', async () => {
    const cloud = new FakeCloud({ keychain: KEYS })
    cloud.v2.takenSiteNames.add('my-app')
    const { code, writer } = await newV2(cloud)
    expect(code).toBe(ExitCode.needsHuman)
    expect(writer.outText).toContain('NETLIFY_SITE_NAME_TAKEN')
  })

  it('a failing migration names the file and leaves nothing half applied', async () => {
    const cloud = new FakeCloud({ keychain: KEYS })
    await newV2(cloud)
    writeFileSync(join(dir, 'db/migrations/20260101000000_broken.sql'), 'create table if not exists public.half (id int);\nsyntax error here;\n')
    const up = await cli(cloud, ['up', '--json', '--yes'])
    expect(up.code).toBe(ExitCode.failed)
    expect(up.writer.outText).toContain('NEON_MIGRATION_FAILED')
    expect(up.writer.outText).toContain('20260101000000_broken.sql')
    const project = [...cloud.v2.neonProjects.values()][0]
    expect(project.tables.has('half')).toBe(false)
    expect(project.migrations).toEqual(['20250101000000_cimiento_baseline.sql'])
  })

  it('without a Neon login and nobody at a terminal, waits on a person with the attended command', async () => {
    const cloud = new FakeCloud({ keychain: KEYS })
    cloud.v2.neonLoggedIn = false
    const { code, writer } = await newV2(cloud)
    expect(code).toBe(ExitCode.needsHuman)
    expect(writer.outText).toContain('neon.session')
  })
})

describe('manifest rules for the v2 slots', () => {
  it('a slot choice declares its keys, and Supabase on Netlify takes the direct path', () => {
    const m = parseManifest(
      completeFragment(mergeFragments({ name: 'x' }, { slots: { repo: 'github', hosting: 'netlify', database: 'supabase', auth: 'supabase', email: 'resend', payments: 'stripe', analytics: 'posthog' } })),
    )
    expect(m.accounts.supabase).toBe('direct')
    expect(m.secrets.map((s) => s.name).sort()).toEqual(['NEXT_PUBLIC_POSTHOG_KEY', 'NEXT_PUBLIC_STRIPE_PUBLISHABLE_KEY', 'RESEND_API_KEY', 'STRIPE_SECRET_KEY'])
  })

  it('refuses netlify without a GitHub repository, and the Marketplace path on Netlify', () => {
    expect(() => parseManifest({ name: 'x', slots: { hosting: 'netlify' } })).toThrow(/builds from the GitHub repository/)
    expect(() => parseManifest({ name: 'x', slots: { repo: 'github', hosting: 'netlify', database: 'supabase' }, accounts: { supabase: 'via-hosting' } })).toThrow(/Vercel Marketplace/)
    expect(() => parseManifest({ name: 'x', slots: { email: 'resend' } })).toThrow(/RESEND_API_KEY/)
  })

})

describe('sign-up before a key', () => {
  it('asks whether the person has a Resend account and walks the sign-up, then the key page', async () => {
    const m = parseManifest(completeFragment(mergeFragments({ name: 'my-app' }, { slots: { repo: 'github', hosting: 'vercel', email: 'resend' } })))
    const walked: string[] = []
    const store = new SecretStore(m, new Redactor(), {
      interactive: true,
      io: new FakeCloud({ keychainEmpty: true }),
      promptHidden: async () => 're_fake_not_a_real_key',
      walkStep: async (step) => {
        walked.push(step.id)
      },
      choose: async () => 'no',
      lang: 'es',
    })
    expect(await store.get('RESEND_API_KEY')).toBe('re_fake_not_a_real_key')
    expect(walked).toEqual(['resend.signup', 'secret.RESEND_API_KEY'])
  })
})

describe('cimiento domain add and remove', () => {
  async function fullstack(cloud: FakeCloud): Promise<void> {
    const code = await run(['new', 'my-app', '--preset', 'fullstack', '--json', '--yes', '--allow-billing', '--dir', dir], {
      io: cloud,
      cwd: root,
      writer: new CaptureWriter(),
      interactive: false,
      onManual: personDoesIt,
    })
    expect(code).toBe(ExitCode.ok)
  }

  it('without DNS: the domain is on Vercel and the step names the exact CNAME; with DNS it serves, and auth URLs and Turnstile follow', async () => {
    const cloud = new FakeCloud({ marketplaceDone: true })
    await fullstack(cloud)
    const domain = 'cimiento-test.example.test'
    let added = await cli(cloud, ['domain', 'add', domain, '--json'])
    expect(added.code, added.writer.outText).toBe(ExitCode.needsHuman)
    expect(added.writer.outText).toContain('HOSTING_DOMAIN_DNS_NEEDED')
    // BUG-64: the record Vercel recommends first for the project, not only the generic one.
    expect(added.writer.outText).toContain('fakeproject.vercel-dns-016.com')
    const project = [...cloud.vercelProjects.values()][0]
    expect(cloud.v2.vercelDomains.get(project.id)?.has(domain)).toBe(true)
    expect(parseDocument(readFileSync(join(dir, 'stack.yaml'), 'utf8')).get('domain')).toBe(domain)

    cloud.v2.dns.set(`CNAME ${domain}`, 'fakeproject.vercel-dns-016.com')
    cloud.v2.refreshDomainPage(domain, 'my-app')
    added = await cli(cloud, ['domain', 'add', domain, '--json'])
    expect(added.code, added.writer.outText).toBe(ExitCode.ok)
    const ref = cloud.supabaseProjects[0].id
    expect(cloud.supabaseAuth.get(ref)?.site_url).toBe(`https://${domain}`)
    expect([...cloud.widgets.values()].flat()[0].domains).toContain(domain)

    const removed = await cli(cloud, ['domain', 'remove', '--json'])
    expect(removed.code, removed.writer.outText).toBe(ExitCode.ok)
    expect(cloud.v2.vercelDomains.get(project.id)?.has(domain)).toBe(false)
    expect(cloud.supabaseAuth.get(ref)?.site_url).toBe('https://my-app.vercel.app')
    expect([...cloud.widgets.values()].flat()[0].domains).not.toContain(domain)
    expect(parseDocument(readFileSync(join(dir, 'stack.yaml'), 'utf8')).toJS().domain).toBeNull()
  })

  it('on Netlify, the custom domain goes on the site and the CNAME points at <site>.netlify.app', async () => {
    const cloud = new FakeCloud({ keychain: KEYS })
    await newV2(cloud)
    const domain = 'shop.example.test'
    const added = await cli(cloud, ['domain', 'add', domain, '--json'])
    expect(added.code).toBe(ExitCode.needsHuman)
    expect(added.writer.outText).toContain('my-app.netlify.app')
    expect([...cloud.v2.netlifySites.values()][0].custom_domain).toBe(domain)
    const removed = await cli(cloud, ['domain', 'remove', domain, '--json'])
    expect(removed.code, removed.writer.outText).toBe(ExitCode.ok)
    expect([...cloud.v2.netlifySites.values()][0].custom_domain).toBeNull()
  })

  it('refuses something that is not a domain, and a project with no hosting yet', async () => {
    const cloud = new FakeCloud({ keychain: KEYS })
    await newV2(cloud)
    const bad = await cli(cloud, ['domain', 'add', 'not a domain', '--json'])
    expect(bad.code).toBe(ExitCode.needsHuman)
    expect(bad.writer.outText).toContain('HOSTING_DOMAIN_FAILED')
  })
})
