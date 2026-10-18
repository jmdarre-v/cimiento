// Shared test scaffolding: a temporary project on disk, fake tokens, and a Ctx wired to the
// fake cloud so no test can reach a real account.

import { mkdtempSync, rmSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { MemoryLogger } from '../../src/core/logger'
import { Redactor } from '../../src/core/redact'
import { emptyMachineState, emptyProjectState, type ProjectState } from '../../src/core/state'
import type { Ctx, Provider, ResourceSpec } from '../../src/core/types'
import { mergeFragments, parseManifest, presetFragment, type Manifest, type ManifestInput } from '../../src/manifest'
import { buildProviders, collectSpecs } from '../../src/registry'
import { SecretStore } from '../../src/secrets'
import type { Writer } from '../../src/cli/output'
import { FakeCloud } from './fake-cloud'

/** Obviously fake. Nothing in the suite may use a value that could be real. */
export const FAKE_VERCEL_TOKEN = 'fake-vercel-token-not-a-real-credential'
export const FAKE_SUPABASE_TOKEN = 'fake-supabase-token-not-a-real-credential'

export const FAKE_NETLIFY_TOKEN = 'fake-netlify-token-not-a-real-credential'
export const FAKE_NEON_KEY = 'fake-neon-api-key-not-a-real-credential'

export function useFakeTokens(): void {
  process.env.VERCEL_TOKEN = FAKE_VERCEL_TOKEN
  process.env.SUPABASE_ACCESS_TOKEN = FAKE_SUPABASE_TOKEN
  process.env.NETLIFY_AUTH_TOKEN = FAKE_NETLIFY_TOKEN
  process.env.NEON_API_KEY = FAKE_NEON_KEY
}

export function tempDir(prefix = 'cimiento-test-'): string {
  return mkdtempSync(join(tmpdir(), prefix))
}

export function removeDir(dir: string): void {
  rmSync(dir, { recursive: true, force: true })
}

export function manifestFor(overrides: Partial<ManifestInput> = {}, preset?: 'fullstack' | 'designer'): Manifest {
  const base = preset ? presetFragment(preset) : {}
  return parseManifest(mergeFragments({ name: 'my-app' }, base, overrides), 'stack.yaml')
}

/**
 * A manifest as 0.3.0 and older planned it, previews sharing the production database. For the
 * tests written before Goal 7 about something else, so they keep testing what they were for.
 */
export function manifestForShared(overrides: Partial<ManifestInput> = {}, preset?: 'fullstack' | 'designer'): Manifest {
  return manifestFor({ environments: { dev: {}, preview: { database: 'shared' }, production: {} }, ...overrides }, preset)
}

export interface TestContext {
  ctx: Ctx
  providers: Provider[]
  specs: ResourceSpec[]
  cloud: FakeCloud
  logger: MemoryLogger
  redactor: Redactor
  secrets: SecretStore
  setState(next: ProjectState): void
}

export function testContext(
  manifest: Manifest,
  options: { cloud?: FakeCloud; state?: ProjectState; cwd?: string; secrets?: Record<string, string> } = {},
): TestContext {
  useFakeTokens()
  const cloud = options.cloud ?? new FakeCloud()
  const redactor = new Redactor()
  const logger = new MemoryLogger(redactor)
  const state = options.state ?? emptyProjectState()
  const secrets = new SecretStore(manifest, redactor, { interactive: false, values: options.secrets ?? {}, io: cloud })
  const providers = buildProviders(manifest)
  const specs = collectSpecs(manifest, state, providers)
  const ctx: Ctx = {
    io: cloud,
    manifest,
    state,
    machine: emptyMachineState(),
    // Never the repository itself: a provider may write stack.yaml or .vercel into ctx.cwd.
    cwd: options.cwd ?? tempDir('cimiento-ctx-'),
    lang: 'en',
    logger,
    redactor,
    secrets,
    dryRun: false,
    interactive: false,
  }
  return {
    ctx,
    providers,
    specs,
    cloud,
    logger,
    redactor,
    secrets,
    setState(next: ProjectState) {
      ctx.state = next
    },
  }
}

export function specById(specs: ResourceSpec[], id: string): ResourceSpec {
  const spec = specs.find((s) => s.id === id)
  if (!spec) throw new Error(`no spec named ${id} in [${specs.map((s) => s.id).join(', ')}]`)
  return spec
}

export class CaptureWriter implements Writer {
  readonly stdout: string[] = []
  readonly stderr: string[] = []

  out(text: string): void {
    this.stdout.push(text)
  }

  err(text: string): void {
    this.stderr.push(text)
  }

  get outText(): string {
    return this.stdout.join('')
  }

  get errText(): string {
    return this.stderr.join('')
  }

  /** Every json object the command emitted, in order. */
  jsonObjects(): unknown[] {
    const objects: unknown[] = []
    for (const chunk of this.stdout) {
      const trimmed = chunk.trim()
      if (!trimmed.startsWith('{') && !trimmed.startsWith('[')) continue
      try {
        objects.push(JSON.parse(trimmed))
      } catch {
        // Not every chunk is a whole json document, and that is fine.
      }
    }
    return objects
  }
}

/**
 * Stands in for the person at a manual step: they do what the page asks, then press Enter. On
 * the fake cloud that means installing Supabase from the Marketplace. Pressing Enter without
 * doing it is a different test, and verify has to catch it.
 */
export async function personDoesIt(spec: ResourceSpec, ctx: Ctx): Promise<boolean> {
  const io = ((ctx.io as { inner?: unknown }).inner ?? ctx.io) as Partial<FakeCloud>
  if (spec.id === 'inngest.vercel-integration') io.installInngest?.()
  else io.acceptMarketplace?.()
  return true
}
