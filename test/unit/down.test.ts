// cimiento down, spec section 9: everything in state, across providers, in reverse dependency
// order, after the project name is typed back, and proven gone afterwards.

import { readFileSync } from 'node:fs'
import { join } from 'node:path'
import { afterEach, beforeEach, describe, expect, it } from 'vitest'
import { run } from '../../src/cli/index'
import { ExitCode } from '../../src/core/errors'
import { FakeCloud } from './fake-cloud'
import { CaptureWriter, personDoesIt, removeDir, tempDir, useFakeTokens } from './helpers'

describe('cimiento down', () => {
  let root: string
  let dir: string
  let configDir: string

  beforeEach(() => {
    useFakeTokens()
    root = tempDir()
    dir = join(root, 'cimiento-test-1')
    configDir = tempDir('cimiento-config-')
    process.env.CIMIENTO_CONFIG_DIR = configDir
  })

  afterEach(() => {
    removeDir(root)
    removeDir(configDir)
    delete process.env.CIMIENTO_CONFIG_DIR
  })

  /** A project brought all the way up on the fake cloud, the state Part B step 6 starts from. */
  async function upProject(cloud: FakeCloud, extra: string[] = []): Promise<void> {
    const code = await run(
      ['new', 'cimiento-test-1', '--preset', 'fullstack', '--json', '--yes', '--allow-billing', '--dir', dir, ...extra],
      { io: cloud, cwd: root, writer: new CaptureWriter(), interactive: false, onManual: personDoesIt },
    )
    expect(code).toBe(ExitCode.ok)
  }

  function state(): { resources: Record<string, unknown>; manualDone: string[] } {
    return JSON.parse(readFileSync(join(dir, '.cimiento', 'state.json'), 'utf8'))
  }

  it('deletes the repository, the Vercel project and the Supabase project, and proves each gone', async () => {
    const cloud = new FakeCloud({ ghDeleteScope: true })
    await upProject(cloud)
    expect(cloud.repos.size).toBe(1)
    expect(cloud.vercelProjects.size).toBe(1)
    // Production's database and the one previews read (Goal 7).
    expect(cloud.supabaseProjects.length).toBe(2)

    const writer = new CaptureWriter()
    const code = await run(['down', '--yes', '--json'], { io: cloud, cwd: dir, writer, interactive: false })

    expect(code).toBe(ExitCode.ok)
    expect(cloud.repos.size).toBe(0)
    expect(cloud.vercelProjects.size).toBe(0)
    expect(cloud.supabaseProjects.length).toBe(0)
    const summary = writer.jsonObjects().find((o) => (o as { command?: string }).command === 'down') as {
      destroyed: string[]
      errors: unknown[]
    }
    expect(summary.errors).toEqual([])
    expect(summary.destroyed.sort()).toEqual(['github.repo', 'supabase.preview-project', 'supabase.project', 'turnstile.widget', 'vercel.deployment', 'vercel.project'])
  })

  it('goes in reverse dependency order: the database before the project it was installed into', async () => {
    const cloud = new FakeCloud({ ghDeleteScope: true })
    await upProject(cloud)
    const writer = new CaptureWriter()
    await run(['down', '--yes', '--json'], { io: cloud, cwd: dir, writer, interactive: false })
    const starts = writer
      .jsonObjects()
      .filter((o) => (o as { event?: string }).event === 'start')
      .map((o) => (o as { id: string }).id)
    expect(starts.indexOf('supabase.project')).toBeLessThan(starts.indexOf('vercel.project'))
    expect(starts.indexOf('vercel.deployment')).toBeLessThan(starts.indexOf('vercel.project'))
  })

  it('empties state of every resource, binding and check, and keeps what describes the machine or team', async () => {
    const cloud = new FakeCloud({ ghDeleteScope: true })
    await upProject(cloud)
    await run(['down', '--yes', '--json'], { io: cloud, cwd: dir, writer: new CaptureWriter(), interactive: false })
    const left = Object.keys(state().resources).sort()
    // Tools and sessions describe the machine. The Marketplace step is a fact about the Vercel
    // team, which down cannot undo and the next project on that team should not be asked again.
    const keep = (id: string) => id.includes('.tool.') || id.endsWith('.session') || id === 'vercel.marketplace-terms'
    expect(left.filter((id) => !keep(id))).toEqual([])
    expect(left).toContain('github.session')
  })

  it('a second down has nothing to do', async () => {
    const cloud = new FakeCloud({ ghDeleteScope: true })
    await upProject(cloud)
    await run(['down', '--yes', '--json'], { io: cloud, cwd: dir, writer: new CaptureWriter(), interactive: false })
    const writer = new CaptureWriter()
    const code = await run(['down', '--yes', '--json'], { io: cloud, cwd: dir, writer, interactive: false })
    expect(code).toBe(ExitCode.ok)
    expect((writer.jsonObjects()[0] as { destroyed: string[] }).destroyed).toEqual([])
  })

  it('without --yes and nobody at a terminal, deletes nothing and waits on a person', async () => {
    const cloud = new FakeCloud({ ghDeleteScope: true })
    await upProject(cloud)
    const writer = new CaptureWriter()
    const code = await run(['down', '--json'], { io: cloud, cwd: dir, writer, interactive: false })
    expect(code).toBe(ExitCode.needsHuman)
    expect((writer.jsonObjects()[0] as { error: { code: string } }).error.code).toBe('DOWN_CONFIRMATION_NEEDED')
    expect(cloud.repos.size).toBe(1)
    expect(cloud.vercelProjects.size).toBe(1)
  })

  it('asks for the project name typed back and deletes nothing on a wrong answer', async () => {
    const cloud = new FakeCloud({ ghDeleteScope: true })
    await upProject(cloud)
    const code = await run(['down'], {
      io: cloud,
      cwd: dir,
      writer: new CaptureWriter(),
      interactive: true,
      ask: async () => 'cimiento-test-2',
    })
    expect(code).toBe(ExitCode.needsHuman)
    expect(cloud.repos.size).toBe(1)
  })

  it('deletes on the right name typed back', async () => {
    const cloud = new FakeCloud({ ghDeleteScope: true })
    await upProject(cloud)
    const questions: string[] = []
    const code = await run(['down'], {
      io: cloud,
      cwd: dir,
      writer: new CaptureWriter(),
      interactive: true,
      ask: async (q) => {
        questions.push(q)
        return 'cimiento-test-1'
      },
    })
    expect(code).toBe(ExitCode.ok)
    expect(questions[0]).toContain('cimiento-test-1')
    expect(cloud.repos.size).toBe(0)
  })

  it('asks GitHub for delete_repo in the foreground when a person is there, then deletes', async () => {
    const cloud = new FakeCloud({ ghDeleteScope: false })
    await upProject(cloud)
    const code = await run(['down', '--yes'], { io: cloud, cwd: dir, writer: new CaptureWriter(), interactive: true })
    expect(code).toBe(ExitCode.ok)
    expect(cloud.interactiveCalls.some((c) => c.startsWith('gh auth refresh') && c.includes('delete_repo'))).toBe(true)
    expect(cloud.repos.size).toBe(0)
  })

  it('without the scope and nobody at a terminal, deletes the rest and leaves the repository waiting', async () => {
    const cloud = new FakeCloud({ ghDeleteScope: false })
    await upProject(cloud)
    const writer = new CaptureWriter()
    const code = await run(['down', '--yes', '--json'], { io: cloud, cwd: dir, writer, interactive: false })
    expect(code).toBe(ExitCode.needsHuman)
    const summary = writer.jsonObjects().find((o) => (o as { command?: string }).command === 'down') as {
      pending: string[]
      errors: unknown[]
    }
    expect(summary.pending).toEqual(['github.repo'])
    expect(summary.errors).toEqual([])
    expect(cloud.repos.size).toBe(1)
    expect(cloud.vercelProjects.size).toBe(0)
    expect(cloud.interactiveCalls).toEqual([])
    // The repository stays in state so the next down finds it.
    expect(state().resources['github.repo']).toBeDefined()
  })

  it('does not touch a repository that was already deleted by hand', async () => {
    const cloud = new FakeCloud({ ghDeleteScope: true })
    await upProject(cloud)
    cloud.repos.clear()
    const code = await run(['down', '--yes', '--json'], { io: cloud, cwd: dir, writer: new CaptureWriter(), interactive: false })
    expect(code).toBe(ExitCode.ok)
    expect(cloud.execCalls.filter((c) => c.startsWith('gh repo delete'))).toEqual([])
  })
})

describe('BUG-57: a different repository under the same name was kept as the one cimiento created', () => {
  it('is adopted with its new id, and down keeps it', async () => {
    useFakeTokens()
    const root = tempDir()
    const dir = join(root, 'my-app')
    const configDir = tempDir('cimiento-config-')
    process.env.CIMIENTO_CONFIG_DIR = configDir
    try {
      const cloud = new FakeCloud({ ghDeleteScope: true })
      const writer = new CaptureWriter()
      await run(['new', 'my-app', '--preset', 'designer', '--json', '--yes', '--dir', dir], { io: cloud, cwd: root, writer, interactive: false, onManual: personDoesIt })
      const state = () => JSON.parse(readFileSync(join(dir, '.cimiento', 'state.json'), 'utf8'))
      expect(state().resources['github.repo'].origin).toBe('created')
      // The repository is replaced by another one with the same name, as the public repository
      // of cimiento itself replaced the private one in Goal 4.
      const repo = cloud.repos.get('test-handle/my-app')!
      repo.id = 'R_another_repository'
      expect(await run(['up', '--json', '--yes'], { io: cloud, cwd: dir, writer: new CaptureWriter(), interactive: false })).toBe(ExitCode.ok)
      expect(state().resources['github.repo']).toMatchObject({ externalId: 'R_another_repository', origin: 'adopted' })
      const down = new CaptureWriter()
      await run(['down', '--yes', '--json'], { io: cloud, cwd: dir, writer: down, interactive: false })
      expect(cloud.repos.has('test-handle/my-app')).toBe(true)
      expect((down.jsonObjects().pop() as { released: string[] }).released).toContain('github.repo')
    } finally {
      removeDir(root)
      removeDir(configDir)
    }
  })
})
