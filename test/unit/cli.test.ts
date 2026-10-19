// The command surface: every command works with --json, every failure is a CimientoError with a
// hint, and the exit codes follow spec section 10.

import { readFileSync, writeFileSync, mkdirSync, readdirSync, statSync } from 'node:fs'
import { join } from 'node:path'
import { afterEach, beforeEach, describe, expect, it, vi, type MockInstance } from 'vitest'
import { run, VERSION } from '../../src/cli/index'
import { parseArgs } from '../../src/cli/args'
import { writeManifest } from '../../src/manifest'
import { buildProviders, collectSpecs } from '../../src/registry'
import * as registry from '../../src/registry'
import { emptyProjectState } from '../../src/core/state'
import { ERROR_CODES, ExitCode } from '../../src/core/errors'
import { FakeCloud } from './fake-cloud'
import { CaptureWriter, removeDir, tempDir, useFakeTokens, personDoesIt, manifestFor } from './helpers'

function snapshot(dir: string): Record<string, string> {
  return Object.fromEntries(readdirSync(dir).sort().flatMap((name) => {
    const path = join(dir, name)
    return statSync(path).isDirectory()
      ? Object.entries(snapshot(path)).map(([child, contents]) => [`${name}/${child}`, contents])
      : [[name, readFileSync(path, 'utf8')]]
  }))
}

describe('argument parsing', () => {
  it('splits a command, a subcommand and flags', () => {
    const parsed = parseArgs(['secret', 'set', 'API_KEY', '--json'])
    expect(parsed).toMatchObject({ command: 'secret', sub: 'set', positionals: ['API_KEY'] })
    expect(parsed.flags.json).toBe(true)
  })

  it('accepts both --flag value and --flag=value', () => {
    expect(parseArgs(['new', 'x', '--preset', 'fullstack']).flags.preset).toBe('fullstack')
    expect(parseArgs(['new', 'x', '--preset=fullstack']).flags.preset).toBe('fullstack')
  })

  it('treats a known boolean flag as a boolean even when a word follows', () => {
    const parsed = parseArgs(['up', '--yes', 'extra'])
    expect(parsed.flags.yes).toBe(true)
    expect(parsed.positionals).toEqual(['extra'])
  })
})

describe('commands', () => {
  let dir: string
  let configDir: string
  let writer: CaptureWriter
  let cloud: FakeCloud

  beforeEach(() => {
    useFakeTokens()
    dir = tempDir()
    configDir = tempDir('cimiento-config-')
    process.env.CIMIENTO_CONFIG_DIR = configDir
    writer = new CaptureWriter()
    cloud = new FakeCloud()
  })

  afterEach(() => {
    removeDir(dir)
    removeDir(configDir)
    delete process.env.CIMIENTO_CONFIG_DIR
  })

  const deps = () => ({ io: cloud, cwd: dir, writer, interactive: false })

  it('prints the version', async () => {
    expect(await run(['--version'], deps())).toBe(ExitCode.ok)
    expect(writer.outText.trim()).toBe(VERSION)
  })

  it('prints help with no arguments', async () => {
    expect(await run([], deps())).toBe(ExitCode.ok)
    expect(writer.outText).toContain('cimiento new')
    expect(writer.outText).toContain('Exit codes')
  })

  it('reports an unknown command as a CimientoError with a hint', async () => {
    expect(await run(['teleport', '--json'], deps())).toBe(ExitCode.failed)
    const payload = writer.jsonObjects()[0] as { ok: boolean; error: { code: string; hint: string } }
    expect(payload.ok).toBe(false)
    expect(payload.error.hint).toContain('cimiento --help')
  })

  it('init writes a manifest and plan reads it back', async () => {
    expect(await run(['init', 'demo-app', '--preset', 'designer', '--json'], deps())).toBe(ExitCode.ok)
    const manifest = readFileSync(join(dir, 'stack.yaml'), 'utf8')
    expect(manifest).toContain('name: demo-app')
    expect(manifest).toContain('repo: github')

    const planWriter = new CaptureWriter()
    const code = await run(['plan', '--json'], { ...deps(), writer: planWriter })
    expect(code).toBe(ExitCode.ok)
    const plan = planWriter.jsonObjects()[0] as { command: string; items: { id: string }[] }
    expect(plan.command).toBe('plan')
    expect(plan.items.map((i) => i.id)).toContain('vercel.project')
  })

  it('init refuses to overwrite an existing manifest without --force', async () => {
    await run(['init', 'demo-app', '--preset', 'designer', '--json'], deps())
    const second = new CaptureWriter()
    const code = await run(['init', 'demo-app', '--json'], { ...deps(), writer: second })
    expect(code).toBe(ExitCode.needsHuman)
    expect((second.jsonObjects()[0] as { error: { code: string } }).error.code).toBe('SCAFFOLD_TARGET_EXISTS')
  })

  it('plan in a folder with no manifest explains what to do', async () => {
    const code = await run(['plan', '--json'], deps())
    expect(code).toBe(ExitCode.needsHuman)
    const payload = writer.jsonObjects()[0] as { error: { code: string; hint: string } }
    expect(payload.error.code).toBe('MANIFEST_NOT_FOUND')
    expect(payload.error.hint).toContain('cimiento init')
  })

  it('rejects an unknown preset by name', async () => {
    const code = await run(['init', 'x', '--preset', 'nope', '--json'], deps())
    expect(code).toBe(ExitCode.needsHuman)
    expect(writer.outText).toContain('fullstack and designer')
  })

  it('explain --list works without a manifest, with every error code and no resource ids', async () => {
    expect(await run(['explain', '--list', '--json'], deps())).toBe(ExitCode.ok)
    const payload = writer.jsonObjects()[0] as { errorCodes: string[]; resourceIds: string[] }
    expect(payload.errorCodes).toEqual([...ERROR_CODES].sort())
    expect(payload.resourceIds).toEqual([])
    expect(new Set(payload.errorCodes).size).toBe(payload.errorCodes.length)
    expect(snapshot(dir)).toEqual({})
  })

  it('explain --list text and JSON agree on selected provider and wiring ids, without external IO or project writes', async () => {
    const manifest = manifestFor({}, 'designer')
    writeManifest(dir, manifest)
    mkdirSync(join(dir, '.cimiento'))
    writeFileSync(join(dir, '.cimiento/state.json'), 'not valid state, and not needed for listing')
    const before = snapshot(dir)
    const expected = [...new Set(collectSpecs(manifest, emptyProjectState(), buildProviders(manifest)).map((spec) => spec.id))].sort()
    const spies: MockInstance[] = [vi.spyOn(cloud, 'exec'), vi.spyOn(cloud, 'interactive'), vi.spyOn(cloud, 'spawn'), vi.spyOn(cloud, 'http'), vi.spyOn(cloud, 'sql')]
    const originalBuild = registry.buildProviders
    const build = vi.spyOn(registry, 'buildProviders').mockImplementation((...args) => {
      const providers = originalBuild(...args)
      for (const provider of providers) {
        for (const method of ['detect', 'login', 'ensure', 'verify', 'destroy', 'outputs'] as const) {
          spies.push(vi.spyOn(provider, method))
        }
      }
      return providers
    })
    try {
      expect(await run(['explain', '--list', '--json'], deps())).toBe(ExitCode.ok)
      const payload = writer.jsonObjects()[0] as { errorCodes: string[]; resourceIds: string[] }
      expect(payload.resourceIds).toEqual(expected)
      expect(payload.resourceIds).toContain('github.repo')
      expect(payload.resourceIds).toContain('vercel.binding.git-repo')
      expect(payload.resourceIds.some((id) => id.startsWith('supabase.'))).toBe(false)
      expect(payload.resourceIds.some((id) => id.startsWith('neon.'))).toBe(false)
      expect(new Set(payload.resourceIds).size).toBe(payload.resourceIds.length)
      const text = new CaptureWriter()
      expect(await run(['explain', '--list'], { ...deps(), writer: text })).toBe(ExitCode.ok)
      const listed = text.outText.split('\n').filter((line) => line.startsWith('  ')).map((line) => line.trim())
      expect(listed).toEqual([...payload.errorCodes, ...payload.resourceIds])
      expect(snapshot(dir)).toEqual(before)
      for (const spy of spies) expect(spy).not.toHaveBeenCalled()
    } finally {
      for (const spy of spies) spy.mockRestore()
      build.mockRestore()
    }
  })

  it('explain --list deduplicates a provider selected for two slots', async () => {
    writeManifest(dir, manifestFor({ slots: { database: 'supabase', auth: 'supabase' }, accounts: { supabase: 'direct' } }))
    expect(await run(['explain', '--list', '--json'], deps())).toBe(ExitCode.ok)
    const payload = writer.jsonObjects()[0] as { resourceIds: string[] }
    expect(payload.resourceIds.filter((id) => id === 'supabase.project')).toHaveLength(1)
    expect(payload.resourceIds).toEqual([...new Set(payload.resourceIds)].sort())
  })

  it('explain --list reports an invalid manifest instead of silently omitting its resources', async () => {
    writeFileSync(join(dir, 'stack.yaml'), 'not: [valid')
    expect(await run(['explain', '--list', '--json'], deps())).toBe(ExitCode.needsHuman)
    expect(writer.outText).toContain('MANIFEST_INVALID')
  })

  it('explain answers for a resource id and for an error code', async () => {
    const code = await run(['explain', 'github.repo', '--json'], deps())
    expect(code).toBe(ExitCode.ok)
    const payload = writer.jsonObjects()[0] as { explanation: string; knowledgeBase?: unknown }
    expect(payload.explanation).toContain('repository')

    const errWriter = new CaptureWriter()
    await run(['explain', 'SUPABASE_MIGRATION_FAILED', '--json'], { ...deps(), writer: errWriter })
    const errPayload = errWriter.jsonObjects()[0] as { explanation: string; knowledgeBase: { fix: string } }
    expect(errPayload.explanation).toBeTruthy()
    expect(errPayload.knowledgeBase.fix).toContain('Postgres')
  })

  it('explain answers in Spanish when asked', async () => {
    await run(['explain', 'github.repo', '--lang', 'es', '--json'], deps())
    const payload = writer.jsonObjects()[0] as { lang: string; explanation: string }
    expect(payload.lang).toBe('es')
    expect(payload.explanation).toContain('repositorio')
  })

  it('explain says so plainly when it has nothing written', async () => {
    const code = await run(['explain', 'nothing.like.this', '--json'], deps())
    expect(code).toBe(ExitCode.failed)
  })

  it('env print reports urls and outputs from state without any secret', async () => {
    await run(['init', 'demo-app', '--preset', 'designer', '--json'], deps())
    mkdirSync(join(dir, '.cimiento'), { recursive: true })
    writeFileSync(
      join(dir, '.cimiento/state.json'),
      JSON.stringify({
        version: 1,
        manifestHash: 'x',
        resources: { 'github.repo': { externalId: 'R_1', url: 'https://github.com/a/b', outputs: { defaultBranch: 'main' } } },
        manualDone: [],
      }),
    )
    const printWriter = new CaptureWriter()
    const code = await run(['env', 'print', '--json'], { ...deps(), writer: printWriter })
    expect(code).toBe(ExitCode.ok)
    const payload = printWriter.jsonObjects()[0] as { urls: Record<string, string>; secretNames: string[] }
    expect(payload.urls['github.repo']).toBe('https://github.com/a/b')
    expect(payload.secretNames).toEqual([])
  })

  it('env pull refuses when there is no hosting slot, with a hint', async () => {
    await run(['init', 'demo-app', '--json'], deps())
    const pullWriter = new CaptureWriter()
    const code = await run(['env', 'pull', '--json'], { ...deps(), writer: pullWriter })
    expect(code).toBe(ExitCode.needsHuman)
    expect((pullWriter.jsonObjects()[0] as { error: { code: string } }).error.code).toBe('SECRET_SINK_UNAVAILABLE')
  })

  it('secret set refuses a name stack.yaml does not declare', async () => {
    await run(['init', 'demo-app', '--preset', 'designer', '--json'], deps())
    const secretWriter = new CaptureWriter()
    const code = await run(['secret', 'set', 'MYSTERY_KEY', '--json'], { ...deps(), writer: secretWriter })
    expect(code).toBe(ExitCode.needsHuman)
    const payload = secretWriter.jsonObjects()[0] as { error: { code: string; hint: string } }
    expect(payload.error.code).toBe('SECRET_NOT_DECLARED')
    expect(payload.error.hint).toContain('secrets section of stack.yaml')
  })

  it('secret set pushes a declared value to the hosting sink and prints only the name', async () => {
    await run(['init', 'demo-app', '--preset', 'designer', '--json'], deps())
    const manifestPath = join(dir, 'stack.yaml')
    writeFileSync(
      manifestPath,
      `${readFileSync(manifestPath, 'utf8')}\n`.replace(
        'secrets: []',
        'secrets:\n  - name: API_KEY\n    sinks: [hosting]\n    environments: [production]\n    source: env',
      ),
    )
    const upWriter = new CaptureWriter()
    await run(['up', '--json', '--yes', '--allow-billing'], { ...deps(), writer: upWriter, onManual: personDoesIt })

    const secretWriter = new CaptureWriter()
    const code = await run(['secret', 'set', 'API_KEY', '--json'], {
      ...deps(),
      writer: secretWriter,
      secrets: { API_KEY: 'fake-api-key-not-a-real-credential' },
    })
    expect(code).toBe(ExitCode.ok)
    expect(secretWriter.outText).not.toContain('fake-api-key')

    const checkWriter = new CaptureWriter()
    const checkCode = await run(['secret', 'check', '--json'], { ...deps(), writer: checkWriter })
    expect(checkCode).toBe(ExitCode.ok)
    const report = checkWriter.jsonObjects()[0] as { ok: boolean; items: { id: string; ok: boolean }[] }
    expect(report.ok).toBe(true)
    expect(report.items.map((i) => i.id)).toContain('vercel.env.API_KEY.production')
  })

  it('secret check reports a missing secret without printing a value', async () => {
    await run(['init', 'demo-app', '--preset', 'designer', '--json'], deps())
    const manifestPath = join(dir, 'stack.yaml')
    writeFileSync(
      manifestPath,
      readFileSync(manifestPath, 'utf8').replace(
        'secrets: []',
        'secrets:\n  - name: API_KEY\n    sinks: [hosting]\n    environments: [production]\n    source: env',
      ),
    )
    await run(['up', '--json', '--yes', '--allow-billing'], {
      ...deps(),
      writer: new CaptureWriter(),
      onManual: personDoesIt,
    })
    const checkWriter = new CaptureWriter()
    const code = await run(['secret', 'check', '--json'], { ...deps(), writer: checkWriter })
    expect(code).toBe(ExitCode.failed)
    const report = checkWriter.jsonObjects()[0] as { ok: boolean; items: { ok: boolean; error?: { hint: string } }[] }
    expect(report.ok).toBe(false)
    expect(report.items.find((i) => !i.ok)!.error!.hint).toContain('cimiento secret set API_KEY')
  })

  it('doctor on a project that was never applied reports failures with hints, not a crash', async () => {
    await run(['init', 'demo-app', '--preset', 'designer', '--json'], deps())
    const doctorWriter = new CaptureWriter()
    const code = await run(['doctor', '--json'], { ...deps(), writer: doctorWriter })
    expect(code).toBe(ExitCode.failed)
    const report = doctorWriter.jsonObjects()[0] as { ok: boolean; items: { ok: boolean; error?: { hint: string } }[] }
    expect(report.ok).toBe(false)
    for (const item of report.items.filter((i) => !i.ok)) {
      expect(item.error?.hint, 'every failed item carries a hint').toBeTruthy()
    }
  })
})

describe('BUG-56: one version, from package.json', () => {
  it('cimiento --version prints the version package.json holds, and nothing else carries one', async () => {
    const { readFileSync } = await import('node:fs')
    const { join } = await import('node:path')
    const pkg = JSON.parse(readFileSync(join(__dirname, '../../package.json'), 'utf8'))
    const writer = new CaptureWriter()
    await run(['--version'], { writer })
    expect(writer.outText.trim()).toBe(pkg.version)
    const plugin = JSON.parse(readFileSync(join(__dirname, '../../plugin/.claude-plugin/plugin.json'), 'utf8'))
    expect(plugin.version).toBeUndefined()
    expect(readFileSync(join(__dirname, '../../src/cli/index.ts'), 'utf8')).not.toMatch(/VERSION = '\d/)
  })
})
