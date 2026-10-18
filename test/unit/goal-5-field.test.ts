// Regression tests for the bugs field test 5 found (docs/FIELD-TEST-5.md), from BUG-60 on.

import { readFileSync, writeFileSync } from 'node:fs'
import { join } from 'node:path'
import { parseDocument } from 'yaml'
import { afterEach, beforeEach, describe, expect, it } from 'vitest'
import { run } from '../../src/cli/index'
import { ExitCode } from '../../src/core/errors'
import { clearToolUpdateCache } from '../../src/core/toolkit'
import { setNetlifyDeployWait } from '../../src/providers/netlify'
import { scaffoldFiles } from '../../src/scaffold'
import { FakeCloud } from './fake-cloud'
import { CaptureWriter, manifestFor, personDoesIt, removeDir, tempDir, useFakeTokens } from './helpers'

let root: string
let dir: string
let configDir: string

beforeEach(() => {
  useFakeTokens()
  clearToolUpdateCache()
  setNetlifyDeployWait({ intervalMs: 1, timeoutMs: 50 })
  root = tempDir('cimiento-goal5f-')
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

describe('BUG-60: files next dev writes stay out of the repository', () => {
  it('the scaffold .gitignore lists next-env.d.ts and *.tsbuildinfo, so cimiento publish never commits them', () => {
    for (const preset of ['designer', 'fullstack'] as const) {
      const gitignore = scaffoldFiles(manifestFor({}, preset))['.gitignore']
      expect(gitignore, preset).toContain('next-env.d.ts')
      expect(gitignore, preset).toContain('*.tsbuildinfo')
    }
  })
})

describe('BUG-61: a Next.js site on Netlify gets the Next.js runtime', () => {
  it('the link sets @netlify/plugin-nextjs, so the deployed page answers 200 instead of 404', async () => {
    const cloud = new FakeCloud()
    const { code, writer } = await cli(cloud, ['new', 'my-app', '--preset', 'designer', '--hosting', 'netlify', '--json', '--yes', '--dir', dir], root)
    expect(code, writer.outText).toBe(ExitCode.ok)
    const site = [...cloud.v2.netlifySites.values()][0]
    expect(site.plugins).toEqual([{ package: '@netlify/plugin-nextjs' }])
    expect(cloud.pages.get('https://my-app.netlify.app')?.status).toBe(200)
  })

  it('a site linked without it gets it on the next up, which builds again because the build settings changed', async () => {
    const cloud = new FakeCloud()
    await cli(cloud, ['new', 'my-app', '--preset', 'designer', '--hosting', 'netlify', '--json', '--yes', '--dir', dir], root)
    const site = [...cloud.v2.netlifySites.values()][0]
    cloud.v2.linkWithoutRuntime(site.id)
    cloud.pages.set(site.ssl_url, { status: 404, body: '<title>Page not found</title>' })
    const deploys = cloud.v2.netlifyDeploys.length
    const doctor = await cli(cloud, ['doctor', '--json'])
    expect(doctor.code).toBe(ExitCode.failed)
    const up = await cli(cloud, ['up', '--json', '--yes'])
    expect(up.code, up.writer.outText).toBe(ExitCode.ok)
    expect(site.plugins).toEqual([{ package: '@netlify/plugin-nextjs' }])
    expect(cloud.v2.netlifyDeploys.length).toBe(deploys + 1)
    expect(cloud.pages.get(site.ssl_url)?.status).toBe(200)
  })
})

describe('BUG-62: secret rotate names the hosting the project uses', () => {
  it('on Netlify the note says Netlify reads env when it builds, not Vercel', async () => {
    const cloud = new FakeCloud()
    await cli(cloud, ['new', 'my-app', '--preset', 'designer', '--hosting', 'netlify', '--json', '--yes', '--dir', dir], root)
    const file = join(dir, 'stack.yaml')
    const doc = parseDocument(readFileSync(file, 'utf8'))
    doc.set('secrets', doc.createNode([{ name: 'CIMIENTO_TEST_SECRET', sinks: ['hosting'], environments: ['preview', 'production'], source: 'env' }]))
    writeFileSync(file, doc.toString(), 'utf8')
    process.env.CIMIENTO_TEST_SECRET = 'fake-rotate-note-value-not-real'
    try {
      await cli(cloud, ['secret', 'set', 'CIMIENTO_TEST_SECRET', '--json'])
      const { writer } = await cli(cloud, ['secret', 'rotate', 'CIMIENTO_TEST_SECRET', '--json'])
      const note = (writer.jsonObjects().find((o) => (o as { command?: string }).command === 'secret rotate') as { note: string }).note
      expect(note).toContain('Netlify reads env when it builds')
      expect(note).not.toContain('Vercel')
    } finally {
      delete process.env.CIMIENTO_TEST_SECRET
    }
  })
})
