// The database and ci sinks of spec section 8. A declared secret with sink database becomes a
// Supabase project secret (what Edge Functions read), and with sink ci a GitHub Actions secret on
// the repository. The value comes from the secret store, is registered with the redactor, and goes
// in a request body or on stdin, never on a command line.

import { previewDatabaseIsolated } from '../core/hosting'
import { CimientoError } from '../core/errors'
import { ciSecretId, databaseSecretId } from '../core/sink-ids'
import type { CheckResult, Ctx, EnsureResult, ResourceSpec, Value } from '../core/types'
import type { Manifest } from '../manifest/schema'
import { supabaseCall } from '../providers/supabase/api'

function str(value: Value | undefined): string {
  return typeof value === 'string' ? value : ''
}

/** The value of a declared secret, or the person step that provides it. */
export async function secretValue(ctx: Ctx, spec: ResourceSpec, key: string): Promise<string> {
  // A value the plan knows, such as the Neon project id the preview workflow needs (BUG-102).
  if (str(spec.inputs.source) === 'literal' && str(spec.inputs.value)) return str(spec.inputs.value)
  const value = await ctx.secrets.get(key)
  if (value) {
    ctx.redactor.addName(key)
    ctx.redactor.addValue(value)
    return value
  }
  throw new CimientoError({
    code: 'SECRET_MISSING',
    provider: spec.provider,
    resource: spec.id,
    message: `cimiento has no value for ${key}, so it cannot write it to ${spec.provider === 'github' ? 'GitHub Actions' : 'Supabase'}.`,
    hint: `Run cimiento secret set ${key} in a terminal in ${ctx.cwd}. It asks at a hidden prompt; never paste it into chat.`,
    retryable: true,
    needsHuman: true,
  })
}

/** Sink specs for the secrets a manifest sends to the database and ci sinks. */
export function databaseSinkSpecs(m: Manifest): ResourceSpec[] {
  if (m.slots.database !== 'supabase') return []
  return m.secrets
    .filter((s) => s.sinks.includes('database'))
    .map((s) => ({
      id: databaseSecretId(s.name),
      kind: 'binding' as const,
      provider: 'supabase',
      dependsOn: ['supabase.project'],
      inputs: { projectRef: { deferred: 'supabase.project:projectRef' }, key: s.name },
    }))
}

/** Where the version of a value cimiento makes comes from, so an Actions secret follows a new one. */
const GENERATED_VERSIONS: Record<string, string> = { NEON_API_KEY: 'neon.api-key:keyId' }

export function ciSinkSpecs(m: Manifest): ResourceSpec[] {
  if (m.slots.repo !== 'github') return []
  return m.secrets
    .filter((s) => s.sinks.includes('ci'))
    .map((s) => ({
      id: ciSecretId(s.name),
      kind: 'binding' as const,
      provider: 'github',
      dependsOn: ['github.repo'],
      inputs: {
        repo: { deferred: 'github.repo:fullName' },
        key: s.name,
        // A value cimiento made can be made again; the secret follows the version it was written from.
        ...(s.source === 'generated' && GENERATED_VERSIONS[s.name] && m.slots.database === 'neon' && previewDatabaseIsolated(m)
          ? { version: { deferred: GENERATED_VERSIONS[s.name] } }
          : {}),
      },
    }))
}

// Supabase project secrets

async function supabaseSecretNames(ctx: Ctx, spec: ResourceSpec): Promise<string[]> {
  const ref = str(spec.inputs.projectRef)
  const result = await supabaseCall<{ name: string }[]>(ctx, spec.id, 'GET', `/v1/projects/${encodeURIComponent(ref)}/secrets`)
  if (!result.ok) {
    throw new CimientoError({
      code: 'SUPABASE_API_ERROR',
      provider: 'supabase',
      resource: spec.id,
      message: `Listing the secrets of the Supabase project ${ref} failed with ${result.status}.`,
      hint: 'cimiento doctor shows whether the Supabase session reaches this project.',
      retryable: result.status >= 500,
      needsHuman: result.status === 401 || result.status === 403,
    })
  }
  return (result.body ?? []).map((s) => s.name)
}

export async function ensureDatabaseSecret(spec: ResourceSpec, ctx: Ctx): Promise<EnsureResult> {
  const ref = str(spec.inputs.projectRef)
  const key = str(spec.inputs.key)
  const rotate = str(spec.inputs.rotate) === 'true'
  const exists = (await supabaseSecretNames(ctx, spec)).includes(key)
  if (exists && !rotate) return { action: 'noop', externalId: `${ref}/${key}` }
  if (ctx.dryRun) return { action: 'noop' }
  const value = await secretValue(ctx, spec, key)
  const result = await supabaseCall(ctx, spec.id, 'POST', `/v1/projects/${encodeURIComponent(ref)}/secrets`, [{ name: key, value }])
  if (!result.ok) {
    throw new CimientoError({
      code: 'SUPABASE_API_ERROR',
      provider: 'supabase',
      resource: spec.id,
      message: `Writing ${key} to the Supabase project ${ref} failed with ${result.status}.`,
      hint: key.startsWith('SUPABASE_')
        ? `Supabase reserves names starting with SUPABASE_. Rename ${key} in stack.yaml, then run cimiento secret set again.`
        : `Run cimiento secret set ${key} again; it writes over the old value.`,
      retryable: result.status >= 500,
      needsHuman: false,
    })
  }
  return { action: exists ? 'updated' : 'created', externalId: `${ref}/${key}` }
}

export async function verifyDatabaseSecret(spec: ResourceSpec, ctx: Ctx): Promise<CheckResult> {
  const key = str(spec.inputs.key)
  if ((await supabaseSecretNames(ctx, spec)).includes(key)) return { ok: true, evidence: `${key}=**** present in supabase secrets` }
  return {
    ok: false,
    error: new CimientoError({
      code: 'SECRET_MISSING',
      provider: 'supabase',
      resource: spec.id,
      message: `${key} is not set in the Supabase project secrets.`,
      hint: `Run cimiento secret set ${key} in a terminal.`,
      retryable: true,
      needsHuman: true,
    }),
  }
}

// GitHub Actions secrets

async function githubSecretNames(ctx: Ctx, spec: ResourceSpec): Promise<string[]> {
  const repo = str(spec.inputs.repo)
  const result = await ctx.io.exec('gh', ['secret', 'list', '-R', repo, '--json', 'name'])
  if (result.code !== 0) {
    throw new CimientoError({
      code: 'GITHUB_PERMISSION_DENIED',
      provider: 'github',
      resource: spec.id,
      message: `Listing the Actions secrets of ${repo} failed: ${(result.stderr || result.stdout).trim().slice(0, 200)}`,
      hint: 'cimiento doctor shows whether gh is logged in as an account that administers this repository.',
      retryable: true,
      needsHuman: false,
    })
  }
  try {
    return (JSON.parse(result.stdout || '[]') as { name: string }[]).map((s) => s.name)
  } catch {
    return []
  }
}

export async function ensureCiSecret(spec: ResourceSpec, ctx: Ctx): Promise<EnsureResult> {
  const repo = str(spec.inputs.repo)
  const key = str(spec.inputs.key)
  const rotate = str(spec.inputs.rotate) === 'true'
  const exists = (await githubSecretNames(ctx, spec)).includes(key)
  // GitHub never shows a secret's value, so a generated one is judged by the version it was written from.
  const version = str(spec.inputs.version)
  const stale = version !== '' && ctx.state.resources[spec.id]?.outputs?.version !== version
  const versionOut = version ? { outputs: { version: { value: version, secret: false } } } : {}
  if (exists && !rotate && !stale) return { action: 'noop', externalId: `${repo}/${key}`, ...versionOut }
  if (ctx.dryRun) return { action: 'noop' }
  const value = await secretValue(ctx, spec, key)
  // gh reads the value from stdin when no --body is given, so it never shows in the process list.
  const result = await ctx.io.exec('gh', ['secret', 'set', key, '-R', repo], { input: value })
  if (result.code !== 0) {
    throw new CimientoError({
      code: 'GITHUB_PERMISSION_DENIED',
      provider: 'github',
      resource: spec.id,
      message: `Writing the Actions secret ${key} to ${repo} failed: ${(result.stderr || result.stdout).trim().slice(0, 200)}`,
      hint: 'Only an administrator of the repository can write its secrets. cimiento doctor shows which account gh uses.',
      retryable: true,
      needsHuman: false,
    })
  }
  return { action: exists ? 'updated' : 'created', externalId: `${repo}/${key}`, ...versionOut }
}

export async function verifyCiSecret(spec: ResourceSpec, ctx: Ctx): Promise<CheckResult> {
  const key = str(spec.inputs.key)
  const repo = str(spec.inputs.repo)
  if ((await githubSecretNames(ctx, spec)).includes(key)) return { ok: true, evidence: `${key}=**** present in the Actions secrets of ${repo}` }
  return {
    ok: false,
    error: new CimientoError({
      code: 'SECRET_MISSING',
      provider: 'github',
      resource: spec.id,
      message: `${key} is not set in the Actions secrets of ${repo}.`,
      hint: `Run cimiento secret set ${key} in a terminal.`,
      retryable: true,
      needsHuman: true,
    }),
  }
}

/** Deletes the secret from Supabase, for cimiento secret remove. True when there was one. */
export async function removeDatabaseSecret(spec: ResourceSpec, ctx: Ctx): Promise<boolean> {
  const ref = str(spec.inputs.projectRef)
  const key = str(spec.inputs.key)
  if (!(await supabaseSecretNames(ctx, spec)).includes(key)) return false
  const result = await supabaseCall(ctx, spec.id, 'DELETE', `/v1/projects/${encodeURIComponent(ref)}/secrets`, [key])
  if (!result.ok && result.status !== 404) {
    throw new CimientoError({
      code: 'SUPABASE_API_ERROR',
      provider: 'supabase',
      resource: spec.id,
      message: `Deleting ${key} from the Supabase project ${ref} failed with ${result.status}.`,
      hint: `Run cimiento secret remove ${key} again; it only deletes what is still there.`,
      retryable: true,
      needsHuman: false,
    })
  }
  return true
}

/** Deletes the Actions secret from the repository, for cimiento secret remove. */
export async function removeCiSecret(spec: ResourceSpec, ctx: Ctx): Promise<boolean> {
  const repo = str(spec.inputs.repo)
  const key = str(spec.inputs.key)
  if (!(await githubSecretNames(ctx, spec)).includes(key)) return false
  const result = await ctx.io.exec('gh', ['secret', 'delete', key, '-R', repo])
  if (result.code !== 0) {
    throw new CimientoError({
      code: 'GITHUB_PERMISSION_DENIED',
      provider: 'github',
      resource: spec.id,
      message: `Deleting the Actions secret ${key} from ${repo} failed: ${(result.stderr || result.stdout).trim().slice(0, 200)}`,
      hint: `Run cimiento secret remove ${key} again; it only deletes what is still there.`,
      retryable: true,
      needsHuman: false,
    })
  }
  return true
}

