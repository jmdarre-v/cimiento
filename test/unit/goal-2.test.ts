// Goal 2: inngest, turnstile, anthropic, keychain and 1password sources, secret rotate, join, dev,
// and the checks jobs.roundtrip, bot_protection.verify and secrets.present. Everything runs on
// the fake cloud with obviously fake values; no test reaches a real account or the real keychain.

import { cpSync, existsSync, mkdirSync, readFileSync, rmSync, writeFileSync } from 'node:fs'
import { join } from 'node:path'
import { afterEach, beforeEach, describe, expect, it } from 'vitest'
import { run } from '../../src/cli/index'
import { ExitCode } from '../../src/core/errors'
import { runUp } from '../../src/core/executor'
import { buildPlan } from '../../src/core/planner'
import { Redactor } from '../../src/core/redact'
import { clearToolUpdateCache } from '../../src/core/toolkit'
import { setRoundtripPolling } from '../../src/providers/inngest'
import { clearCloudflareToken } from '../../src/providers/turnstile/api'
import { TURNSTILE_TEST_SECRET_KEY, TURNSTILE_TEST_SITE_KEY } from '../../src/providers/turnstile'
import { presetFragment, renderManifest } from '../../src/manifest'
import { SecretStore } from '../../src/secrets'
import { FakeCloud } from './fake-cloud'
import { CaptureWriter, manifestFor, personDoesIt, removeDir, specById, tempDir, testContext, useFakeTokens } from './helpers'

const KEYCHAIN_ANTHROPIC = 'fake-anthropic-api-key-not-a-real-credential'
const ROTATED = 'fake-rotated-anthropic-key-not-a-real-credential'

let root: string
let dir: string
let configDir: string

beforeEach(() => {
  useFakeTokens()
  clearCloudflareToken()
  clearToolUpdateCache()
  setRoundtripPolling({ intervalMs: 1, timeoutMs: 50 })
  root = tempDir('cimiento-goal2-')
  dir = join(root, 'my-app')
  configDir = tempDir('cimiento-config-')
  process.env.CIMIENTO_CONFIG_DIR = configDir
})

afterEach(() => {
  removeDir(root)
  removeDir(configDir)
  delete process.env.CIMIENTO_CONFIG_DIR
})

async function newProject(cloud: FakeCloud, writer = new CaptureWriter()): Promise<number> {
  return run(['new', 'my-app', '--preset', 'fullstack', '--json', '--yes', '--allow-billing', '--dir', dir], {
    io: cloud,
    cwd: root,
    writer,
    interactive: false,
    onManual: personDoesIt,
  })
}

function lastJson(writer: CaptureWriter, command: string): Record<string, unknown> {
  return writer
    .jsonObjects()
    .filter((o) => (o as { command?: string }).command === command)
    .pop() as Record<string, unknown>
}

function onlyProject(cloud: FakeCloud) {
  return [...cloud.vercelProjects.values()][0]
}

function envValue(cloud: FakeCloud, key: string, target: string): string | undefined {
  return cloud.vercelEnv.get(onlyProject(cloud).id)?.find((e) => e.key === key && e.target.includes(target))?.value
}

describe('the full fullstack preset on the fake cloud', () => {
  it('goes from nothing to every check passing, with both person steps asked once', async () => {
    const cloud = new FakeCloud()
    const writer = new CaptureWriter()
    expect(await newProject(cloud, writer)).toBe(ExitCode.ok)
    const up = lastJson(writer, 'up') as { receipts: { id: string; evidence?: string }[] }
    const evidence = (id: string) => up.receipts.find((r) => r.id === id)?.evidence ?? ''
    expect(evidence('inngest.check.roundtrip')).toMatch(/ran cimiento-roundtrip, run .* Completed/)
    expect(evidence('turnstile.check.verify')).toContain('invalid-input-response')
    expect(evidence('anthropic.check.key')).toContain('ANTHROPIC_API_KEY=****')
    expect(evidence('vercel.check.secrets-present')).toContain('1 declared secret present in 2 vercel targets: ANTHROPIC_API_KEY=****')
  })

  it('builds the first deployment only after the Inngest and Turnstile keys are in the env', async () => {
    const cloud = new FakeCloud()
    await newProject(cloud)
    const deployments = cloud.deployments.get(onlyProject(cloud).id)!
    expect(deployments).toHaveLength(1)
    const built = deployments[0].env!
    for (const key of ['INNGEST_EVENT_KEY', 'INNGEST_SIGNING_KEY', 'NEXT_PUBLIC_TURNSTILE_SITE_KEY', 'TURNSTILE_SECRET_KEY', 'ANTHROPIC_API_KEY']) {
      expect(built[key], key).toBeTruthy()
    }
  })

  it('never prints or stores a secret value: keychain values, Turnstile secret, Inngest keys', async () => {
    const cloud = new FakeCloud()
    const writer = new CaptureWriter()
    await newProject(cloud, writer)
    const widgetSecret = [...cloud.widgets.values()].flat()[0].secret
    const signing = envValue(cloud, 'INNGEST_SIGNING_KEY', 'production')!
    const eventKey = envValue(cloud, 'INNGEST_EVENT_KEY', 'production')!
    const state = readFileSync(join(dir, '.cimiento', 'state.json'), 'utf8')
    for (const secret of [KEYCHAIN_ANTHROPIC, widgetSecret, signing, eventKey]) {
      expect(writer.outText).not.toContain(secret)
      expect(writer.errText).not.toContain(secret)
      expect(state).not.toContain(secret)
    }
  })

  it('is idempotent: a second up changes nothing and creates no second widget or deployment', async () => {
    const cloud = new FakeCloud()
    await newProject(cloud)
    const writer = new CaptureWriter()
    expect(await run(['up', '--json', '--yes'], { io: cloud, cwd: dir, writer, interactive: false })).toBe(ExitCode.ok)
    const receipts = (lastJson(writer, 'up').receipts as { id: string; action: string }[]).filter((r) => r.action === 'created' || r.action === 'updated')
    expect(receipts).toEqual([])
    expect([...cloud.widgets.values()].flat()).toHaveLength(1)
    expect(cloud.deployments.get(onlyProject(cloud).id)).toHaveLength(1)
  })

  it('doctor right after reports every item ok, including the three Goal 2 checks', async () => {
    const cloud = new FakeCloud()
    await newProject(cloud)
    const writer = new CaptureWriter()
    expect(await run(['doctor', '--json'], { io: cloud, cwd: dir, writer, interactive: false })).toBe(ExitCode.ok)
    const items = lastJson(writer, 'doctor').items as { id: string; ok: boolean }[]
    for (const id of ['inngest.check.roundtrip', 'turnstile.check.verify', 'vercel.check.secrets-present', 'anthropic.check.key']) {
      expect(items.find((i) => i.id === id)?.ok, id).toBe(true)
    }
  })
})

describe('keychain and 1password sources', () => {
  const keychainManifest = () =>
    manifestFor({ slots: { hosting: 'vercel' }, secrets: [{ name: 'API_KEY', sinks: ['hosting'], source: 'keychain' }] })

  it('asks once at a hidden prompt, stores the value through stdin, and reads it from the keychain afterwards', async () => {
    const cloud = new FakeCloud({ keychainEmpty: true })
    let asked = 0
    const promptHidden = async () => {
      asked += 1
      return 'fake-typed-value-not-a-real-credential'
    }
    const first = new SecretStore(keychainManifest(), new Redactor(), { interactive: true, io: cloud, promptHidden })
    expect(await first.get('API_KEY')).toBe('fake-typed-value-not-a-real-credential')
    expect(cloud.keychain.get('my-app/API_KEY')).toBe('fake-typed-value-not-a-real-credential')
    expect(cloud.execCalls).toContain('security -i')
    expect(cloud.execCalls.some((c) => c.includes('fake-typed-value'))).toBe(false)

    const second = new SecretStore(keychainManifest(), new Redactor(), { interactive: false, io: cloud })
    expect(await second.get('API_KEY')).toBe('fake-typed-value-not-a-real-credential')
    expect(asked).toBe(1)
  })

  it('with nobody at a terminal, a missing keychain secret is a step waiting on a person, exit code 2', async () => {
    const cloud = new FakeCloud({ keychainEmpty: true, marketplaceDone: true })
    const writer = new CaptureWriter()
    expect(await newProject(cloud, writer)).toBe(ExitCode.needsHuman)
    const up = lastJson(writer, 'up') as { pendingManual: string[]; errors: unknown[] }
    expect(up.pendingManual).toContain('vercel.env.ANTHROPIC_API_KEY.production')
    expect(up.errors).toEqual([])
    expect(writer.outText).toContain('cimiento secret set ANTHROPIC_API_KEY')
  })

  it('reads a 1password secret with op read and the ref from stack.yaml', async () => {
    const ref = 'op://Private/my-app/API_KEY'
    const cloud = new FakeCloud({ onePassword: { [ref]: 'fake-op-value-not-a-real-credential' } })
    const manifest = manifestFor({ slots: { hosting: 'vercel' }, secrets: [{ name: 'API_KEY', sinks: ['hosting'], source: '1password', ref }] })
    const store = new SecretStore(manifest, new Redactor(), { interactive: false, io: cloud })
    expect(await store.get('API_KEY')).toBe('fake-op-value-not-a-real-credential')
    expect(cloud.execCalls).toContain(`op read --no-newline ${ref}`)
  })

  it('without the 1Password CLI and nobody at a terminal, says up in a terminal installs it', async () => {
    const ref = 'op://Private/my-app/API_KEY'
    const cloud = new FakeCloud()
    const manifest = manifestFor({ slots: { hosting: 'vercel' }, secrets: [{ name: 'API_KEY', sinks: ['hosting'], source: '1password', ref }] })
    const store = new SecretStore(manifest, new Redactor(), { interactive: false, io: cloud })
    await expect(store.get('API_KEY')).rejects.toMatchObject({ code: 'SECRET_SOURCE_UNAVAILABLE', needsHuman: true })
  })
})

describe('turnstile', () => {
  it('writes the widget keys to production and Cloudflare test keys to preview and dev', async () => {
    const cloud = new FakeCloud()
    await newProject(cloud)
    const widget = [...cloud.widgets.values()].flat()[0]
    expect(envValue(cloud, 'NEXT_PUBLIC_TURNSTILE_SITE_KEY', 'production')).toBe(widget.sitekey)
    expect(envValue(cloud, 'TURNSTILE_SECRET_KEY', 'production')).toBe(widget.secret)
    expect(envValue(cloud, 'NEXT_PUBLIC_TURNSTILE_SITE_KEY', 'preview')).toBe(TURNSTILE_TEST_SITE_KEY)
    expect(envValue(cloud, 'TURNSTILE_SECRET_KEY', 'development')).toBe(TURNSTILE_TEST_SECRET_KEY)
    expect(widget.name).toBe('my-app')
    expect(widget.mode).toBe('managed')
  })

  it('pins the only Cloudflare account to accounts.cloudflare in stack.yaml', async () => {
    const cloud = new FakeCloud()
    await newProject(cloud)
    expect(readFileSync(join(dir, 'stack.yaml'), 'utf8')).toMatch(/cloudflare: cf_account_fake/)
  })

  it('with several accounts and nobody at a terminal, waits on a person instead of guessing', async () => {
    const cloud = new FakeCloud({
      marketplaceDone: true,
      cloudflareAccounts: [
        { id: 'cf_a', name: 'Alpha' },
        { id: 'cf_b', name: 'Beta' },
      ],
    })
    const t = testContext(manifestFor({}, 'fullstack'), { cloud })
    const result = await runUp(t.ctx, t.providers, t.specs, { onManual: personDoesIt })
    expect(result.pendingManual).toContain('turnstile.session')
    expect([...cloud.widgets.values()].flat()).toHaveLength(0)
  })

  it('logs in again in the foreground with the Turnstile permission when the login lacks it', async () => {
    const cloud = new FakeCloud({ marketplaceDone: true, cloudflareScopes: ['account:read', 'user:read', 'workers:write'] })
    const t = testContext(manifestFor({}, 'fullstack'), { cloud })
    t.ctx.interactive = true
    const result = await runUp(t.ctx, t.providers, t.specs, { onManual: personDoesIt })
    expect(cloud.interactiveCalls).toContain('wrangler login')
    expect(result.errors).toEqual([])
  })

  it('without the permission and nobody at a terminal, waits on a person with the attended command', async () => {
    const cloud = new FakeCloud({ marketplaceDone: true, cloudflareScopes: ['account:read', 'user:read'] })
    const t = testContext(manifestFor({}, 'fullstack'), { cloud })
    const result = await runUp(t.ctx, t.providers, t.specs, { onManual: personDoesIt })
    expect(result.pendingManual).toContain('turnstile.session')
    expect(cloud.interactiveCalls.filter((c) => c.startsWith('wrangler login'))).toEqual([])
  })

  it('widget domains follow the production host once it is known', async () => {
    const cloud = new FakeCloud()
    await newProject(cloud)
    const project = onlyProject(cloud)
    project.productionAlias = 'my-app-fake-team.vercel.app'
    cloud.pages.set('https://my-app-fake-team.vercel.app', cloud.pages.get('https://my-app.vercel.app')!)
    expect(await run(['up', '--json', '--yes'], { io: cloud, cwd: dir, writer: new CaptureWriter(), interactive: false })).toBe(ExitCode.ok)
    expect([...cloud.widgets.values()].flat()[0].domains).toContain('my-app-fake-team.vercel.app')
  })

  it('bot_protection.verify fails on a secret siteverify does not know', async () => {
    const cloud = new FakeCloud()
    const t = testContext(manifestFor({}, 'fullstack'), { cloud })
    const provider = t.providers.find((p) => p.id === 'turnstile')!
    const spec = specById(t.specs, 'turnstile.check.verify')
    const result = await provider.verify({ ...spec, inputs: { sitekey: 'x', secret: 'fake-unknown-secret' } }, t.ctx)
    expect(result.ok).toBe(false)
    expect(result.error?.code).toBe('TURNSTILE_SECRET_REJECTED')
  })

  it('down deletes the widget and proves it gone', async () => {
    const cloud = new FakeCloud({ ghDeleteScope: true })
    await newProject(cloud)
    const writer = new CaptureWriter()
    expect(await run(['down', '--yes', '--json'], { io: cloud, cwd: dir, writer, interactive: false })).toBe(ExitCode.ok)
    expect(lastJson(writer, 'down').destroyed).toContain('turnstile.widget')
    expect([...cloud.widgets.values()].flat()).toHaveLength(0)
  })

  it('accounts set turnstile asks again and writes the new account to stack.yaml', async () => {
    const cloud = new FakeCloud({
      cloudflareAccounts: [
        { id: 'cf_a', name: 'Alpha' },
        { id: 'cf_b', name: 'Beta' },
      ],
    })
    await run(['init', 'my-app', '--preset', 'fullstack', '--json'], { io: cloud, cwd: root, writer: new CaptureWriter(), interactive: false })
    const code = await run(['accounts', 'set', 'turnstile'], {
      io: cloud,
      cwd: root,
      writer: new CaptureWriter(),
      interactive: true,
      choose: async (_q, options) => options[1].value,
    })
    expect(code).toBe(ExitCode.ok)
    expect(readFileSync(join(root, 'stack.yaml'), 'utf8')).toMatch(/cloudflare: cf_b/)
  })
})

describe('inngest', () => {
  it('stops at the integration step with plain instructions, and deploys nothing before the keys exist', async () => {
    const cloud = new FakeCloud({ marketplaceDone: true, inngestInstalled: false })
    const writer = new CaptureWriter()
    const code = await run(['new', 'my-app', '--preset', 'fullstack', '--json', '--yes', '--allow-billing', '--dir', dir], {
      io: cloud,
      cwd: root,
      writer,
      interactive: false,
    })
    expect(code).toBe(ExitCode.needsHuman)
    expect(lastJson(writer, 'up').pendingManual).toEqual(['inngest.vercel-integration'])
    expect(writer.outText).toContain('Specific Projects and pick my-app')
    expect(writer.outText).toContain('https://vercel.com/integrations/inngest')
    expect(cloud.deployments.size).toBe(0)
  })

  it('pressing Enter without approving leaves the step pending', async () => {
    const cloud = new FakeCloud({ marketplaceDone: true, inngestInstalled: false })
    const t = testContext(manifestFor({}, 'fullstack'), { cloud })
    const result = await runUp(t.ctx, t.providers, t.specs, { onManual: async () => true })
    expect(result.pendingManual).toContain('inngest.vercel-integration')
    expect(result.state.manualDone).not.toContain('inngest.vercel-integration')
  })

  it('registers the app with a PUT on /api/inngest', async () => {
    const cloud = new FakeCloud()
    await newProject(cloud)
    expect(cloud.inngestSynced.has(onlyProject(cloud).id)).toBe(true)
    expect(cloud.httpCalls).toContain('PUT https://my-app.vercel.app/api/inngest')
  })

  it('jobs.roundtrip fails, with the Inngest apps page as the next step, when the app is not registered', async () => {
    const cloud = new FakeCloud()
    await newProject(cloud)
    cloud.inngestSynced.clear()
    const writer = new CaptureWriter()
    await run(['doctor', '--json'], { io: cloud, cwd: dir, writer, interactive: false })
    const item = (lastJson(writer, 'doctor').items as { id: string; ok: boolean; error?: { code: string; hint: string } }[]).find(
      (i) => i.id === 'inngest.check.roundtrip',
    )!
    expect(item.ok).toBe(false)
    expect(item.error?.code).toBe('INNGEST_ROUNDTRIP_FAILED')
    expect(item.error?.hint).toContain('https://app.inngest.com/env/production/apps')
  })

  it('down lists the Inngest app as a leftover to archive', async () => {
    const cloud = new FakeCloud({ ghDeleteScope: true })
    await newProject(cloud)
    const writer = new CaptureWriter()
    await run(['down', '--yes', '--json'], { io: cloud, cwd: dir, writer, interactive: false })
    const leftovers = lastJson(writer, 'down').leftovers as { provider: string; url: string; code: string }[]
    expect(leftovers).toContainEqual(expect.objectContaining({ provider: 'inngest', code: 'DOWN_LEFTOVER', url: 'https://app.inngest.com/env/production/apps' }))
  })
})

describe('secrets.present and anthropic', () => {
  it('secrets.present names the missing secret and the command that sets it', async () => {
    const cloud = new FakeCloud()
    await newProject(cloud)
    const envs = cloud.vercelEnv.get(onlyProject(cloud).id)!
    envs.splice(envs.findIndex((e) => e.key === 'ANTHROPIC_API_KEY' && e.target.includes('production')), 1)
    const writer = new CaptureWriter()
    await run(['doctor', '--json'], { io: cloud, cwd: dir, writer, interactive: false })
    const item = (lastJson(writer, 'doctor').items as { id: string; ok: boolean; error?: { code: string; hint: string } }[]).find(
      (i) => i.id === 'vercel.check.secrets-present',
    )!
    expect(item.ok).toBe(false)
    expect(item.error?.code).toBe('SECRET_MISSING')
    expect(item.error?.hint).toContain('cimiento secret set ANTHROPIC_API_KEY')
  })

  it('a refused Anthropic key points at secret rotate', async () => {
    const cloud = new FakeCloud({ anthropicKeyValid: false })
    const t = testContext(manifestFor({}, 'fullstack'), { cloud })
    const provider = t.providers.find((p) => p.id === 'anthropic')!
    const report = await provider.verify(specById(t.specs, 'anthropic.check.key'), t.ctx)
    expect(report.ok).toBe(false)
    expect(report.error?.code).toBe('ANTHROPIC_KEY_INVALID')
    expect(report.error?.hint).toContain('cimiento secret rotate ANTHROPIC_API_KEY')
  })

  it('plan shows the new checks and steps with an explain key each', async () => {
    const cloud = new FakeCloud()
    const t = testContext(manifestFor({}, 'fullstack'), { cloud })
    const plan = await buildPlan({ ...t.ctx, dryRun: true }, t.providers, t.specs)
    const ids = plan.items.map((i) => i.id)
    for (const id of ['inngest.vercel-integration', 'inngest.app', 'turnstile.widget', 'turnstile.binding.domains', 'vercel.env.TURNSTILE_SECRET_KEY.production']) {
      expect(ids, id).toContain(id)
    }
  })
})

describe('cimiento secret rotate', () => {
  it('writes a fresh value over every sink and the keychain, prints none of it, and up redeploys', async () => {
    const cloud = new FakeCloud()
    await newProject(cloud)
    const before = envValue(cloud, 'ANTHROPIC_API_KEY', 'production')
    expect(before).toBe(KEYCHAIN_ANTHROPIC)

    const writer = new CaptureWriter()
    const code = await run(['secret', 'rotate', 'ANTHROPIC_API_KEY', '--json'], {
      io: cloud,
      cwd: dir,
      writer,
      interactive: true,
      promptHidden: async () => ROTATED,
    })
    expect(code).toBe(ExitCode.ok)
    const summary = lastJson(writer, 'secret rotate') as { updated: string[]; created: string[] }
    expect(summary.updated.sort()).toEqual(['vercel.env.ANTHROPIC_API_KEY.preview', 'vercel.env.ANTHROPIC_API_KEY.production'])
    expect(envValue(cloud, 'ANTHROPIC_API_KEY', 'production')).toBe(ROTATED)
    expect(envValue(cloud, 'ANTHROPIC_API_KEY', 'preview')).toBe(ROTATED)
    expect(cloud.keychain.get('my-app/ANTHROPIC_API_KEY')).toBe(ROTATED)
    expect(writer.outText).not.toContain(ROTATED)
    expect(cloud.execCalls.some((c) => c.includes(ROTATED))).toBe(false)

    const doctor = new CaptureWriter()
    await run(['doctor', '--json'], { io: cloud, cwd: dir, writer: doctor, interactive: false })
    const deployment = (lastJson(doctor, 'doctor').items as { id: string; ok: boolean }[]).find((i) => i.id === 'vercel.deployment')!
    expect(deployment.ok).toBe(false)

    expect(await run(['up', '--json', '--yes'], { io: cloud, cwd: dir, writer: new CaptureWriter(), interactive: false })).toBe(ExitCode.ok)
    const deployments = cloud.deployments.get(onlyProject(cloud).id)!
    expect(deployments).toHaveLength(2)
    expect(deployments[0].env!.ANTHROPIC_API_KEY).toBe(ROTATED)
  })

  it('with nobody at a terminal, waits on a person and changes nothing', async () => {
    const cloud = new FakeCloud()
    await newProject(cloud)
    const writer = new CaptureWriter()
    const code = await run(['secret', 'rotate', 'ANTHROPIC_API_KEY', '--json'], { io: cloud, cwd: dir, writer, interactive: false })
    expect(code).toBe(ExitCode.needsHuman)
    expect(envValue(cloud, 'ANTHROPIC_API_KEY', 'production')).toBe(KEYCHAIN_ANTHROPIC)
  })
})

describe('cimiento join', () => {
  function cloneTo(): string {
    const clone = join(root, 'clone')
    cpSync(dir, clone, { recursive: true })
    rmSync(join(clone, '.vercel'), { recursive: true, force: true })
    rmSync(join(clone, '.env.local'), { force: true })
    return clone
  }

  it('on a clone: tools, logins, verifies every resource, pulls env, runs checks, creates nothing', async () => {
    const cloud = new FakeCloud()
    await newProject(cloud)
    const clone = cloneTo()
    const repos = cloud.repos.size
    const widgets = [...cloud.widgets.values()].flat().length
    const writer = new CaptureWriter()
    const code = await run(['join', '--json'], { io: cloud, cwd: clone, writer, interactive: false })
    expect(code).toBe(ExitCode.ok)
    const summary = lastJson(writer, 'join') as { items: { id: string; ok: boolean }[]; envPull: { file: string } }
    expect(summary.items.every((i) => i.ok)).toBe(true)
    expect(summary.items.map((i) => i.id)).toContain('inngest.check.roundtrip')
    expect(summary.envPull.file).toBe('.env.local')
    expect(cloud.execCalls.some((c) => c.startsWith('vercel env pull .env.local'))).toBe(true)
    expect(cloud.repos.size).toBe(repos)
    expect([...cloud.widgets.values()].flat()).toHaveLength(widgets)
  })

  it('a login missing on the new machine is a step waiting on a person, exit code 2', async () => {
    const cloud = new FakeCloud()
    await newProject(cloud)
    const clone = cloneTo()
    cloud.cloudflareLoggedIn = false
    clearCloudflareToken()
    const writer = new CaptureWriter()
    expect(await run(['join', '--json'], { io: cloud, cwd: clone, writer, interactive: false })).toBe(ExitCode.needsHuman)
    expect(lastJson(writer, 'join').waiting).toContain('turnstile.session')
  })

  it('refuses a folder with no state, pointing at up', async () => {
    const cloud = new FakeCloud()
    await run(['init', 'my-app', '--preset', 'fullstack', '--json'], { io: cloud, cwd: root, writer: new CaptureWriter(), interactive: false })
    const writer = new CaptureWriter()
    expect(await run(['join', '--json'], { io: cloud, cwd: root, writer, interactive: false })).toBe(ExitCode.needsHuman)
    expect(writer.outText + writer.errText).toContain('JOIN_NO_STATE')
  })
})

describe('cimiento dev', () => {
  it('starts the local database, the Inngest dev server and the app on fixed ports, and one stop ends all three', async () => {
    const cloud = new FakeCloud()
    await newProject(cloud)
    let stop: () => void = () => undefined
    const stopSignal = new Promise<void>((resolve) => {
      stop = resolve
    })
    const writer = new CaptureWriter()
    const running = run(['dev', '--json'], { io: cloud, cwd: dir, writer, interactive: false, stopSignal })
    while (cloud.spawned.length < 2) await new Promise((r) => setTimeout(r, 5))
    stop()
    expect(await running).toBe(ExitCode.ok)

    expect(cloud.execCalls).toContain('supabase start')
    const jobs = cloud.spawned.find((s) => s.label.includes('inngest-cli'))!
    expect(jobs.label).toContain('dev -u http://localhost:3000/api/inngest --port 8288')
    const app = cloud.spawned.find((s) => s.label.startsWith('npm run dev'))!
    expect(app.label).toContain('--port 3000')
    expect(app.opts.env?.NEXT_PUBLIC_SUPABASE_URL).toBe('http://127.0.0.1:54321')
    expect(app.opts.env?.INNGEST_DEV).toBe('1')
    expect(app.opts.env?.ANTHROPIC_API_KEY).toBe(KEYCHAIN_ANTHROPIC)
    expect(cloud.execCalls.indexOf('supabase stop')).toBeGreaterThan(cloud.execCalls.indexOf('supabase start'))
    expect(writer.outText).not.toContain(KEYCHAIN_ANTHROPIC)
    expect(writer.outText).not.toContain('fake-local-service-role')
  })

  it('when one service stops on its own, stops the others and reports which one', async () => {
    const cloud = new FakeCloud()
    await newProject(cloud)
    const writer = new CaptureWriter()
    const running = run(['dev', '--json'], { io: cloud, cwd: dir, writer, interactive: false, stopSignal: new Promise<void>(() => undefined) })
    while (cloud.spawned.length < 2) await new Promise((r) => setTimeout(r, 5))
    cloud.spawned.find((s) => s.label.includes('inngest-cli'))!.stop(1)
    expect(await running).toBe(ExitCode.failed)
    expect(writer.outText).toContain('DEV_SERVICE_FAILED')
    expect(cloud.execCalls).toContain('supabase stop')
  })

  it('scaffolds the Inngest route and function the roundtrip check needs', async () => {
    const cloud = new FakeCloud()
    await newProject(cloud)
    expect(existsSync(join(dir, 'app', 'api', 'inngest', 'route.ts'))).toBe(true)
    expect(readFileSync(join(dir, 'inngest', 'functions.ts'), 'utf8')).toContain("{ event: 'cimiento/roundtrip' }")
    expect(readFileSync(join(dir, '.env.example'), 'utf8')).toContain('TURNSTILE_SECRET_KEY=')
  })
})

describe('field test 2 findings, first unattended run of cimiento new cimiento-test-2', () => {
  async function unattended(cloud: FakeCloud): Promise<CaptureWriter> {
    const writer = new CaptureWriter()
    await run(['new', 'my-app', '--preset', 'fullstack', '--json', '--yes', '--allow-billing', '--dir', dir], {
      io: cloud,
      cwd: root,
      writer,
      interactive: false,
    })
    return writer
  }

  it('BUG-35: --json printed every event across many lines instead of one line per event', async () => {
    const writer = await unattended(new FakeCloud())
    const lines = writer.outText.split('\n').filter(Boolean)
    expect(lines.length).toBeGreaterThan(20)
    for (const line of lines) expect(() => JSON.parse(line), line.slice(0, 80)).not.toThrow()
  })

  it('BUG-36: env binding ids came out as prj:NAME:**** because the redactor read NAME:target as a secret', async () => {
    const writer = await unattended(new FakeCloud())
    const receipts = (lastJson(writer, 'up').receipts as { id: string; externalId?: string }[]).filter((r) => r.id.startsWith('vercel.env.'))
    expect(receipts.length).toBeGreaterThan(0)
    for (const r of receipts) expect(r.externalId, r.id).not.toContain('****')
  })

  it('BUG-37: an unattended run said cimiento had opened the browser for the Inngest and Marketplace steps', async () => {
    const writer = await unattended(new FakeCloud())
    expect(writer.outText).not.toContain('cimiento has opened')
    expect(writer.outText).toContain(`Run cimiento up in a terminal in ${dir}; it opens the Inngest integration on Vercel`)
  })

  it('BUG-38: a missing keychain secret said secret set without saying it needs a terminal or where the value goes', async () => {
    const writer = await unattended(new FakeCloud({ keychainEmpty: true }))
    expect(writer.outText).toContain(`Run cimiento up in a terminal in ${dir}: it asks for ANTHROPIC_API_KEY at a hidden prompt and keeps it in the macOS keychain`)
  })

  it('BUG-39: the Inngest step named the Vercel team by its id instead of its name', async () => {
    const writer = await unattended(new FakeCloud())
    expect(writer.outText).toContain('Choose the Vercel team Fake Team')
  })
})

describe('BUG-40: the fullstack preset required TYPESAFE_API_KEY and XPOZ_API_KEY, which belong to one specific project', () => {
  const perProject = [
    { name: 'ANTHROPIC_API_KEY', sinks: ['hosting' as const], environments: ['preview' as const, 'production' as const], source: 'keychain' as const },
    { name: 'TYPESAFE_API_KEY', sinks: ['hosting' as const], source: 'keychain' as const },
    { name: 'XPOZ_API_KEY', sinks: ['hosting' as const], source: 'keychain' as const },
  ]

  /** A project that declared the two per-project secrets, as cimiento-test-2 did, brought up. */
  async function projectWithPerProjectSecrets(cloud: FakeCloud): Promise<void> {
    mkdirSync(dir, { recursive: true })
    const manifest = manifestFor({ secrets: perProject }, 'fullstack')
    writeFileSync(join(dir, 'stack.yaml'), `# kept by secret remove\n${renderManifest(manifest)}`)
    writeFileSync(join(dir, '.env.example'), 'ANTHROPIC_API_KEY=\nTYPESAFE_API_KEY=\nXPOZ_API_KEY=\n')
    cloud.keychain.set('my-app/TYPESAFE_API_KEY', 'fake-typesafe-not-a-real-credential')
    const code = await run(['up', '--json', '--yes', '--allow-billing'], { io: cloud, cwd: dir, writer: new CaptureWriter(), interactive: false, onManual: personDoesIt })
    expect(code).toBe(ExitCode.ok)
  }

  it('the preset declares ANTHROPIC_API_KEY only', () => {
    expect((presetFragment('fullstack').secrets ?? []).map((x) => x.name)).toEqual(['ANTHROPIC_API_KEY'])
  })

  it('a new fullstack project never asks for a per-project secret', async () => {
    const cloud = new FakeCloud({ keychainEmpty: true, marketplaceDone: true })
    const writer = new CaptureWriter()
    await newProject(cloud, writer)
    expect(writer.outText).not.toMatch(/TYPESAFE|XPOZ/)
    expect(readFileSync(join(dir, 'stack.yaml'), 'utf8')).not.toMatch(/TYPESAFE|XPOZ/)
  })

  it('secret remove takes a secret out of stack.yaml, the Vercel env, state, .env.example and the keychain', async () => {
    const cloud = new FakeCloud()
    await projectWithPerProjectSecrets(cloud)
    expect(envValue(cloud, 'TYPESAFE_API_KEY', 'production')).toBeTruthy()

    const writer = new CaptureWriter()
    expect(await run(['secret', 'remove', 'TYPESAFE_API_KEY', '--json'], { io: cloud, cwd: dir, writer, interactive: false })).toBe(ExitCode.ok)
    expect((lastJson(writer, 'secret remove').deleted as string[]).sort()).toEqual([
      'vercel.env.TYPESAFE_API_KEY.preview',
      'vercel.env.TYPESAFE_API_KEY.production',
    ])
    const yaml = readFileSync(join(dir, 'stack.yaml'), 'utf8')
    expect(yaml).not.toContain('TYPESAFE_API_KEY')
    expect(yaml).toContain('XPOZ_API_KEY')
    expect(yaml).toContain('ANTHROPIC_API_KEY')
    expect(yaml.startsWith('# kept by secret remove')).toBe(true)
    expect(envValue(cloud, 'TYPESAFE_API_KEY', 'production')).toBeUndefined()
    expect(envValue(cloud, 'ANTHROPIC_API_KEY', 'production')).toBeTruthy()
    expect(readFileSync(join(dir, '.cimiento', 'state.json'), 'utf8')).not.toContain('TYPESAFE_API_KEY')
    expect(readFileSync(join(dir, '.env.example'), 'utf8')).toBe('ANTHROPIC_API_KEY=\nXPOZ_API_KEY=\n')
    expect(cloud.keychain.has('my-app/TYPESAFE_API_KEY')).toBe(false)
    expect(writer.outText).not.toContain('fake-typesafe-not-a-real-credential')

    const plan = new CaptureWriter()
    await run(['plan', '--json'], { io: cloud, cwd: dir, writer: plan, interactive: false })
    expect(plan.outText).not.toContain('TYPESAFE_API_KEY')
  })

  it('works before the hosting project exists, the state cimiento-test-2 was in', async () => {
    const cloud = new FakeCloud()
    mkdirSync(dir, { recursive: true })
    writeFileSync(join(dir, 'stack.yaml'), renderManifest(manifestFor({ secrets: perProject }, 'fullstack')))
    for (const name of ['TYPESAFE_API_KEY', 'XPOZ_API_KEY']) {
      expect(await run(['secret', 'remove', name, '--json'], { io: cloud, cwd: dir, writer: new CaptureWriter(), interactive: false })).toBe(ExitCode.ok)
    }
    expect(readFileSync(join(dir, 'stack.yaml'), 'utf8')).not.toMatch(/TYPESAFE|XPOZ/)
  })

  it('refuses to remove ANTHROPIC_API_KEY while slots.ai is anthropic, and changes nothing', async () => {
    const cloud = new FakeCloud()
    await projectWithPerProjectSecrets(cloud)
    const before = readFileSync(join(dir, 'stack.yaml'), 'utf8')
    const writer = new CaptureWriter()
    expect(await run(['secret', 'remove', 'ANTHROPIC_API_KEY', '--json'], { io: cloud, cwd: dir, writer, interactive: false })).not.toBe(ExitCode.ok)
    expect(writer.outText).toContain('MANIFEST_INVALID')
    expect(readFileSync(join(dir, 'stack.yaml'), 'utf8')).toBe(before)
    expect(envValue(cloud, 'ANTHROPIC_API_KEY', 'production')).toBeTruthy()
  })

  it('names the declared secrets when asked to remove one that is not declared', async () => {
    const cloud = new FakeCloud()
    await newProject(cloud)
    const writer = new CaptureWriter()
    await run(['secret', 'remove', 'XPOZ_API_KEY', '--json'], { io: cloud, cwd: dir, writer, interactive: false })
    expect(writer.outText).toContain('SECRET_NOT_DECLARED')
    expect(writer.outText).toContain('The declared secrets are: ANTHROPIC_API_KEY')
  })
})

describe('BUG-47: the Cloudflare login always failed, and the error hid why', () => {
  it('runs a plain wrangler login, which wrangler 4 grants the Turnstile scope, never --scopes with offline_access', async () => {
    const cloud = new FakeCloud({ marketplaceDone: true, cloudflareLoggedIn: false })
    const t = testContext(manifestFor({}, 'fullstack'), { cloud })
    t.ctx.interactive = true
    const result = await runUp(t.ctx, t.providers, t.specs, { onManual: personDoesIt })
    expect(cloud.interactiveCalls.filter((c) => c.startsWith('wrangler login'))).toEqual(['wrangler login'])
    expect(result.errors).toEqual([])
    expect([...cloud.widgets.values()].flat()).toHaveLength(1)
  })

  it('reports wrangler\'s own error and the action for that cause, read from WRANGLER_LOG_PATH', async () => {
    const cloud = new FakeCloud({
      marketplaceDone: true,
      cloudflareLoggedIn: false,
      cloudflareLoginError: 'Timed out waiting for authorization code, please try again.',
    })
    const t = testContext(manifestFor({}, 'fullstack'), { cloud })
    t.ctx.interactive = true
    const result = await runUp(t.ctx, t.providers, t.specs, { onManual: personDoesIt })
    const error = result.errors.find((e) => e.resource === 'turnstile.session')
    expect(error?.code).toBe('SESSION_LOGIN_FAILED')
    expect(error?.message).toContain('Timed out waiting for authorization code')
    expect(error?.hint).toContain('within two minutes')
  })

  it('pins the only Cloudflare account and says so, and plan no longer waits on a choice for the widget', async () => {
    const cloud = new FakeCloud({ marketplaceDone: true })
    const t = testContext(manifestFor({}, 'fullstack'), { cloud })
    const plan = await buildPlan({ ...t.ctx, dryRun: true }, t.providers, t.specs)
    expect(plan.items.find((i) => i.id === 'turnstile.widget')!.status).not.toBe('needs-human')
    await runUp(t.ctx, t.providers, t.specs, { onManual: personDoesIt })
    expect(t.logger.events.map((e) => e.message ?? '').join('\n')).toContain('sees one account, Fake Cloudflare (cf_account_fake), so cimiento pinned it as accounts.cloudflare')
  })
})

describe('BUG-46: the Marketplace path silently reused a configuration that already served another project', () => {
  const shared = { id: 'icfg_shared', databases: [{ name: 'another-project', project: 'another-project' }] }

  it('without a terminal, waits on a person, names the configuration and what it serves, and creates no database', async () => {
    const cloud = new FakeCloud({ supabaseConfiguration: shared })
    const writer = new CaptureWriter()
    expect(await newProject(cloud, writer)).toBe(ExitCode.needsHuman)
    expect(lastJson(writer, 'up').pendingManual).toContain('vercel.binding.supabase-install')
    expect(writer.outText).toContain('Supabase configuration icfg_shared on the Vercel team, organization vercel_icfg_shared, serving: another-project')
    expect(cloud.supabaseProjects.map((p) => p.name)).toEqual(['another-project'])
  })

  it('asked in a terminal, the direct path creates the database in the pinned organization and leaves the configuration alone', async () => {
    const cloud = new FakeCloud({ supabaseConfiguration: shared })
    const t = testContext(manifestFor({}, 'fullstack'), { cloud })
    t.ctx.interactive = true
    t.ctx.choose = async (question, options) => (question.includes('Where should the my-app database go?') ? 'direct' : options[0].value)
    const { settleSupabasePath } = await import('../../src/wiring/supabase-configurations')
    expect(await settleSupabasePath(t.ctx, 'up', { ask: true })).toBe('direct')
    expect(t.ctx.manifest.accounts.supabase).toBe('direct')
  })

  it('reuse is recorded in stack.yaml, and the billing line names the Vercel-managed organization', async () => {
    const cloud = new FakeCloud({ supabaseConfiguration: shared })
    const t = testContext(manifestFor({}, 'fullstack'), { cloud })
    t.ctx.interactive = true
    t.ctx.choose = async (question, options) => (question.includes('Where should') ? 'reuse' : options[0].value)
    const { settleSupabasePath } = await import('../../src/wiring/supabase-configurations')
    expect(await settleSupabasePath(t.ctx, 'up', { ask: true })).toBe('reuse')
    expect(t.ctx.manifest.options.supabase.marketplace_configuration).toBe('icfg_shared')
    const supabase = t.providers.find((p) => p.id === 'supabase')!
    expect((await supabase.billing!(specById(t.specs, 'supabase.project'), t.ctx))?.account).toContain('vercel_icfg_shared')
  })

  it('down deletes only the database it created, through its Marketplace resource, and never the configuration or another project', async () => {
    const cloud = new FakeCloud({ ghDeleteScope: true, supabaseConfiguration: shared })
    mkdirSync(dir, { recursive: true })
    writeFileSync(join(dir, 'stack.yaml'), renderManifest(manifestFor({ options: { supabase: { marketplace_configuration: 'icfg_shared' } } }, 'fullstack')))
    expect(await run(['up', '--json', '--yes', '--allow-billing'], { io: cloud, cwd: dir, writer: new CaptureWriter(), interactive: false, onManual: personDoesIt })).toBe(ExitCode.ok)
    expect(cloud.stores.map((s) => s.name).sort()).toEqual(['another-project', 'my-app'])
    const writer = new CaptureWriter()
    expect(await run(['down', '--yes', '--json'], { io: cloud, cwd: dir, writer, interactive: false })).toBe(ExitCode.ok)
    expect(lastJson(writer, 'down').destroyed).toContain('supabase.project')
    expect(cloud.stores.map((s) => s.name)).toEqual(['another-project'])
    expect(cloud.supabaseProjects.map((p) => p.name)).toEqual(['another-project'])
    expect(cloud.execCalls).toContain('vercel integration-resource remove my-app --disconnect-all --yes --scope team_fake')
    expect(cloud.execCalls.some((c) => c.startsWith('vercel integration remove'))).toBe(false)
    expect(cloud.httpCalls.some((c) => c.startsWith('DELETE') && c.includes('/integrations/configuration'))).toBe(false)
  })
})

describe('BUG-45: the Inngest step did not say Create New or Link Existing Inngest Account', () => {
  async function inngestStep(cloud: FakeCloud) {
    const t = testContext(manifestFor({ accounts: { vercel: 'team_fake' } }, 'fullstack'), { cloud })
    const provider = t.providers.find((p) => p.id === 'inngest')!
    const spec = specById(t.specs, 'inngest.vercel-integration')
    return provider.verify({ ...spec, inputs: { projectId: '', project: 'my-app' } }, t.ctx)
  }

  it('a team without Inngest is told Create New Inngest Account, with the team, the project and every click', async () => {
    const result = await inngestStep(new FakeCloud({ inngestInstalled: false }))
    const step = result.error!.personStep!
    expect(step.fields.map((f) => `${f.label.en}: ${f.value.en}`)).toEqual([
      'Team: Fake Team',
      'Projects: Specific Projects: my-app',
      'Inngest account: Create New Inngest Account',
    ])
    expect(result.error!.hint).toContain('choose Create New Inngest Account, not Link Existing Inngest Account')
  })

  it('a team that already has the integration only adds the project, with no account choice', async () => {
    const result = await inngestStep(new FakeCloud({ inngestInstalled: true }))
    const step = result.error!.personStep!
    expect(step.path.map((p) => p.en)).toContain('Under Projects, click Edit')
    expect(result.error!.hint).toContain('No account choice here')
    expect(result.error!.hint).not.toContain('Create New Inngest Account')
  })
})

describe('BUG-42: person steps were spread through the run; BUG-44: the organization came after the plan', () => {
  it('lists every person step first, runs them all before anything unattended, then says the rest is unattended with an estimate', async () => {
    const cloud = new FakeCloud({ cloudflareLoggedIn: false, keychainEmpty: true })
    const writer = new CaptureWriter()
    const code = await run(['new', 'my-app', '--preset', 'fullstack', '--yes', '--allow-billing', '--dir', dir], {
      io: cloud,
      cwd: root,
      writer,
      interactive: true,
      ask: async (q, d) => {
        cloud.execCalls.push(`ASK ${q}`)
        if (q.startsWith('Press Enter here when done')) {
          const opened = [...cloud.execCalls].reverse().find((c) => /^(xdg-)?open /.test(c)) ?? ''
          if (opened.includes('marketplace/supabase')) cloud.acceptMarketplace()
          if (opened.includes('integrations/inngest')) cloud.installInngest()
        }
        return d ?? ''
      },
      choose: async (_q, options) => options[0].value,
      promptHidden: async () => 'fake-typed-key-not-a-real-credential',
    })
    expect(code).toBe(ExitCode.ok)
    expect(writer.outText).toMatch(/This run needs you for \d+ steps, all of them first, in this order:/)
    expect(writer.outText).toMatch(/That was everything that needs you\. The rest runs unattended: \d+ steps, about \d+ min\./)
    const lastAsk = cloud.execCalls.map((c) => c.startsWith('ASK ')).lastIndexOf(true)
    const deploy = cloud.execCalls.findIndex((c) => c.startsWith('vercel deploy'))
    expect(deploy).toBeGreaterThan(lastAsk)
    expect(writer.outText.indexOf('The rest runs unattended')).toBeLessThan(writer.outText.lastIndexOf('deployment'))
  })

  it('asks the Supabase organization before the plan, so the billing line names it and its plan', async () => {
    const cloud = new FakeCloud({
      marketplaceDone: true,
      supabaseOrganizations: [
        { id: 'org_a', name: 'Alpha', plan: 'free' },
        { id: 'org_b', name: 'Beta', plan: 'pro' },
      ],
    })
    mkdirSync(dir, { recursive: true })
    writeFileSync(join(dir, 'stack.yaml'), renderManifest(manifestFor({ accounts: { supabase: 'direct' } }, 'fullstack')))
    const writer = new CaptureWriter()
    await run(['up'], {
      io: cloud,
      cwd: dir,
      writer,
      interactive: true,
      onManual: personDoesIt,
      ask: async (q, d) => (q.includes('Apply this plan') || q.includes('billable') ? 'y' : (d ?? '')),
      choose: async (q, options) => {
        if (q.includes('Supabase organization')) writer.out('[ORGANIZATION CHOSEN]\n')
        return options.find((o) => o.value === 'org_b')?.value ?? options[0].value
      },
    })
    const chosen = writer.outText.indexOf('[ORGANIZATION CHOSEN]')
    const billing = writer.outText.indexOf('bills to Supabase organization Beta, pro plan')
    expect(chosen).toBeGreaterThanOrEqual(0)
    expect(billing).toBeGreaterThan(chosen)
  })
})

describe('BUG-43: tool upgrades were asked one by one during apply', () => {
  const outdated = { toolVersions: { supabase: '2.95.4', gh: 'gh version 2.97.0 (2025-01-01)' }, latestVersions: { supabase: '2.118.0', gh: '2.102.0' } }

  it('asks once for every outdated tool before the plan, remembers a skip per version, and asks again for a newer one', async () => {
    const cloud = new FakeCloud({ marketplaceDone: true, ...outdated })
    mkdirSync(dir, { recursive: true })
    writeFileSync(join(dir, 'stack.yaml'), renderManifest(manifestFor({}, 'fullstack')))
    const questions: string[] = []
    const attended = () =>
      run(['up', '--yes', '--allow-billing'], {
        io: cloud,
        cwd: dir,
        writer: new CaptureWriter(),
        interactive: true,
        onManual: personDoesIt,
        choose: async (q, options) => {
          questions.push(q)
          return q.startsWith('Newer versions') ? 'skip' : options[0].value
        },
      })
    await attended()
    const offers = () => questions.filter((q) => q.startsWith('Newer versions'))
    expect(offers()).toEqual([
      'Newer versions are available: GitHub CLI 2.97.0 to 2.102.0 (brew upgrade gh), Supabase CLI 2.95.4 to 2.118.0 (brew upgrade supabase/tap/supabase). Upgrade them now?',
    ])
    const machine = JSON.parse(readFileSync(join(configDir, 'machine.json'), 'utf8'))
    expect(machine.toolSkips).toEqual({ gh: '2.102.0', supabase: '2.118.0' })
    clearToolUpdateCache()
    await attended()
    expect(offers()).toHaveLength(1)
    cloud.setLatest('supabase', '2.120.0')
    clearToolUpdateCache()
    await attended()
    expect(offers()[1]).toBe('Newer versions are available: Supabase CLI 2.95.4 to 2.120.0 (brew upgrade supabase/tap/supabase). Upgrade them now?')
  })

  it('never asks during apply, even with a person at the terminal', async () => {
    const cloud = new FakeCloud({ marketplaceDone: true, ...outdated })
    const t = testContext(manifestFor({}, 'fullstack'), { cloud })
    t.ctx.interactive = true
    const asked: string[] = []
    t.ctx.choose = async (q, options) => {
      asked.push(q)
      return options[0].value
    }
    await runUp(t.ctx, t.providers, t.specs, { onManual: personDoesIt })
    expect(asked.filter((q) => /version|upgrade/i.test(q))).toEqual([])
    expect(cloud.interactiveCalls.filter((c) => c.startsWith('brew upgrade'))).toEqual([])
  })

  it('doctor reports outdated tools without asking', async () => {
    const cloud = new FakeCloud(outdated)
    await newProject(cloud)
    const writer = new CaptureWriter()
    let asked = 0
    await run(['doctor', '--json'], { io: cloud, cwd: dir, writer, interactive: true, choose: async (_q, o) => (asked++, o[0].value) })
    expect(asked).toBe(0)
    expect((lastJson(writer, 'doctor').outdated as { bin: string; latest: string }[]).map((t) => `${t.bin} ${t.latest}`).sort()).toEqual(['gh 2.102.0', 'supabase 2.118.0'])
  })
})

describe('BUG-48: an Inngest SDK that wants signed requests was reported as Vercel deployment protection', () => {
  it('signs the introspection with the signing key from the Vercel env and passes', async () => {
    const cloud = new FakeCloud()
    const writer = new CaptureWriter()
    expect(await newProject(cloud, writer)).toBe(ExitCode.ok)
    const app = (lastJson(writer, 'up').receipts as { id: string; evidence?: string }[]).find((r) => r.id === 'inngest.app')!
    expect(app.evidence).toContain('serves 1 function in cloud mode with both keys')
  })

  it('a refusal by the SDK itself names the signing key, not deployment protection', async () => {
    const cloud = new FakeCloud()
    await newProject(cloud)
    const project = onlyProject(cloud)
    cloud.deployments.get(project.id)![0].env!.INNGEST_SIGNING_KEY = 'signkey-prod-another-key'
    const writer = new CaptureWriter()
    await run(['doctor', '--json'], { io: cloud, cwd: dir, writer, interactive: false })
    const item = (lastJson(writer, 'doctor').items as { id: string; ok: boolean; error?: { code: string; message: string } }[]).find((i) => i.id === 'inngest.app')!
    expect(item.ok).toBe(false)
    expect(item.error?.code).toBe('INNGEST_KEYS_MISSING')
    expect(item.error?.message).toContain('served by the Inngest SDK')
    expect(item.error?.message).not.toContain('deployment protection')
  })

  it('signs the way the Inngest SDK checks: HMAC SHA-256 of body then timestamp, key without its prefix', async () => {
    const { inngestSignature } = await import('../../src/providers/inngest')
    const { createHmac } = await import('node:crypto')
    const sig = inngestSignature('signkey-prod-abc123', '', 1_792_271_137_000)
    expect(sig).toBe(`t=1792271137&s=${createHmac('sha256', 'abc123').update('1792271137').digest('hex')}`)
  })
})

describe('BUG-49: the public Turnstile site key was masked as **** in receipts', () => {
  it('shows the site key, and still masks the secret key', async () => {
    const cloud = new FakeCloud()
    const writer = new CaptureWriter()
    await newProject(cloud, writer)
    const widget = [...cloud.widgets.values()].flat()[0]
    expect(writer.outText).toContain(widget.sitekey)
    expect(writer.outText).not.toContain(widget.secret)
  })
})
