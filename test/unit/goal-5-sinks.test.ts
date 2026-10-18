// Goal 5 item 1: the database sink (Supabase project secrets) and the ci sink (GitHub Actions
// secrets) of spec section 8, through secret set, rotate, check and remove, and the hosting.preview
// check of section 12. Values are obviously fake and never reach a command line or the output.

import { readFileSync, writeFileSync } from 'node:fs'
import { join } from 'node:path'
import { afterEach, beforeEach, describe, expect, it } from 'vitest'
import { parseDocument } from 'yaml'
import { run } from '../../src/cli/index'
import { ExitCode } from '../../src/core/errors'
import { clearToolUpdateCache } from '../../src/core/toolkit'
import { FakeCloud } from './fake-cloud'
import { CaptureWriter, personDoesIt, removeDir, tempDir, useFakeTokens } from './helpers'

const FIRST = 'fake-cimiento-test-secret-one-not-real'
const SECOND = 'fake-cimiento-test-secret-two-not-real'
const NAME = 'CIMIENTO_TEST_SECRET'

let root: string
let dir: string
let configDir: string

beforeEach(() => {
  useFakeTokens()
  clearToolUpdateCache()
  root = tempDir('cimiento-goal5-')
  dir = join(root, 'my-app')
  configDir = tempDir('cimiento-config-')
  process.env.CIMIENTO_CONFIG_DIR = configDir
})

afterEach(() => {
  removeDir(root)
  removeDir(configDir)
  delete process.env.CIMIENTO_CONFIG_DIR
  delete process.env[NAME]
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

/** A designer project plus a supabase database, so all three sinks exist. */
async function projectWithSecret(cloud: FakeCloud, sinks: string[]): Promise<void> {
  const created = await run(['new', 'my-app', '--preset', 'fullstack', '--json', '--yes', '--allow-billing', '--dir', dir], {
    io: cloud,
    cwd: root,
    writer: new CaptureWriter(),
    interactive: false,
    onManual: personDoesIt,
  })
  expect(created).toBe(ExitCode.ok)
  const file = join(dir, 'stack.yaml')
  const doc = parseDocument(readFileSync(file, 'utf8'))
  doc.addIn(['secrets'], doc.createNode({ name: NAME, sinks, environments: ['preview', 'production'], source: 'env' }))
  writeFileSync(file, doc.toString(), 'utf8')
}

function repoOf(cloud: FakeCloud): string {
  return [...cloud.repos.keys()][0]
}

function refOf(cloud: FakeCloud): string {
  return (cloud.supabaseProjects[0] as { id?: string; ref?: string }).ref ?? (cloud.supabaseProjects[0] as { id: string }).id
}

describe('the database and ci sinks', () => {
  it('secret set writes the value to the hosting env, Supabase secrets and Actions secrets, never on a command line', async () => {
    const cloud = new FakeCloud()
    await projectWithSecret(cloud, ['hosting', 'database', 'ci'])
    process.env[NAME] = FIRST
    const { code, writer } = await cli(cloud, ['secret', 'set', NAME, '--json'])
    expect(code).toBe(ExitCode.ok)
    const targets = (lastJson(writer, 'secret set').targets as string[]).sort()
    expect(targets).toEqual([`github.secret.${NAME}`, `supabase.secret.${NAME}`, `vercel.env.${NAME}.preview`, `vercel.env.${NAME}.production`])
    expect(cloud.actionsSecrets.get(repoOf(cloud))?.get(NAME)).toBe(FIRST)
    expect(cloud.supabaseSecrets.get(refOf(cloud))?.get(NAME)).toBe(FIRST)
    expect(cloud.execCalls.some((c) => c.includes(FIRST))).toBe(false)
    expect(writer.outText).not.toContain(FIRST)
  })

  it('a second secret set is a noop for every sink', async () => {
    const cloud = new FakeCloud()
    await projectWithSecret(cloud, ['database', 'ci'])
    process.env[NAME] = FIRST
    await cli(cloud, ['secret', 'set', NAME, '--json'])
    const writes = cloud.execCalls.filter((c) => c.startsWith('gh secret set')).length
    await cli(cloud, ['secret', 'set', NAME, '--json'])
    expect(cloud.execCalls.filter((c) => c.startsWith('gh secret set')).length).toBe(writes)
  })

  it('secret check reports each sink, and a missing one fails with the secret set hint', async () => {
    const cloud = new FakeCloud()
    await projectWithSecret(cloud, ['database', 'ci'])
    process.env[NAME] = FIRST
    await cli(cloud, ['secret', 'set', NAME, '--json'])
    let check = await cli(cloud, ['secret', 'check', '--json'])
    expect(check.code).toBe(ExitCode.ok)
    const ids = (lastJson(check.writer, 'secret check').items as { id: string; ok: boolean }[]).map((i) => i.id)
    expect(ids).toEqual(expect.arrayContaining([`github.secret.${NAME}`, `supabase.secret.${NAME}`]))

    cloud.actionsSecrets.get(repoOf(cloud))!.delete(NAME)
    check = await cli(cloud, ['secret', 'check', '--json'])
    expect(check.code).toBe(ExitCode.failed)
    const missing = (lastJson(check.writer, 'secret check').items as { id: string; ok: boolean; error?: { hint: string } }[]).find((i) => !i.ok)!
    expect(missing.id).toBe(`github.secret.${NAME}`)
    expect(missing.error!.hint).toContain(`cimiento secret set ${NAME}`)
  })

  it('secret rotate writes the new value over every sink and prints none of it', async () => {
    const cloud = new FakeCloud()
    await projectWithSecret(cloud, ['hosting', 'database', 'ci'])
    process.env[NAME] = FIRST
    await cli(cloud, ['secret', 'set', NAME, '--json'])
    process.env[NAME] = SECOND
    const { code, writer } = await cli(cloud, ['secret', 'rotate', NAME, '--json'])
    expect(code).toBe(ExitCode.ok)
    const summary = lastJson(writer, 'secret rotate') as { updated: string[] }
    expect(summary.updated.sort()).toEqual([`github.secret.${NAME}`, `supabase.secret.${NAME}`, `vercel.env.${NAME}.preview`, `vercel.env.${NAME}.production`])
    expect(cloud.actionsSecrets.get(repoOf(cloud))?.get(NAME)).toBe(SECOND)
    expect(cloud.supabaseSecrets.get(refOf(cloud))?.get(NAME)).toBe(SECOND)
    const project = [...cloud.vercelProjects.values()][0]
    expect(cloud.vercelEnv.get(project.id)!.filter((e) => e.key === NAME).map((e) => e.value)).toEqual([SECOND, SECOND])
    expect(writer.outText).not.toContain(SECOND)
    expect(cloud.execCalls.some((c) => c.includes(SECOND))).toBe(false)
  })

  it('secret remove deletes the value from Supabase and from Actions', async () => {
    const cloud = new FakeCloud()
    await projectWithSecret(cloud, ['database', 'ci'])
    process.env[NAME] = FIRST
    await cli(cloud, ['secret', 'set', NAME, '--json'])
    const { code, writer } = await cli(cloud, ['secret', 'remove', NAME, '--json'])
    expect(code).toBe(ExitCode.ok)
    expect((lastJson(writer, 'secret remove').deleted as string[]).sort()).toEqual([`github.secret.${NAME}`, `supabase.secret.${NAME}`])
    expect(cloud.actionsSecrets.get(repoOf(cloud))?.has(NAME)).toBe(false)
    expect(cloud.supabaseSecrets.get(refOf(cloud))?.has(NAME)).toBe(false)
  })

  it('the database sink needs database: supabase in stack.yaml', async () => {
    const cloud = new FakeCloud()
    await projectWithSecret(cloud, ['database'])
    const file = join(dir, 'stack.yaml')
    const doc = parseDocument(readFileSync(file, 'utf8'))
    doc.setIn(['slots', 'database'], null)
    writeFileSync(file, doc.toString(), 'utf8')
    const { code, writer } = await cli(cloud, ['plan', '--json'])
    expect(code).not.toBe(ExitCode.ok)
    expect(writer.outText).toContain('database')
  })
})

describe('hosting.preview on Vercel', () => {
  it('passes with only main, fails while a pushed branch builds, and passes once its preview is ready', async () => {
    const cloud = new FakeCloud()
    const created = await run(['new', 'my-app', '--preset', 'designer', '--json', '--yes', '--dir', dir], {
      io: cloud,
      cwd: root,
      writer: new CaptureWriter(),
      interactive: false,
      onManual: personDoesIt,
    })
    expect(created).toBe(ExitCode.ok)
    const item = (w: CaptureWriter) => (lastJson(w, 'doctor').items as { id: string; ok: boolean; evidence?: string; error?: { code: string } }[]).find((i) => i.id === 'vercel.check.preview')!

    let doctor = await cli(cloud, ['doctor', '--json'])
    expect(item(doctor.writer).ok).toBe(true)
    expect(item(doctor.writer).evidence).toContain('no branch besides main')

    await cloud.exec('git', ['checkout', '-b', 'feature'])
    await cloud.exec('git', ['commit', '-m', 'change'])
    await cloud.exec('git', ['push', '-u', 'origin', 'feature'])
    const project = [...cloud.vercelProjects.values()][0]
    const preview = cloud.deployments.get(project.id)![0]
    expect(preview.target).toBeNull()
    cloud.pushBuild = 'BUILDING'

    doctor = await cli(cloud, ['doctor', '--json'])
    expect(item(doctor.writer).ok).toBe(false)
    expect(item(doctor.writer).error!.code).toBe('HOSTING_PREVIEW_NOT_READY')

    cloud.pushBuild = 'READY'
    doctor = await cli(cloud, ['doctor', '--json'])
    expect(item(doctor.writer).ok).toBe(true)
    expect(item(doctor.writer).evidence).toContain('feature')
  })
})
