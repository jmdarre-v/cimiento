// Thin wrapper over the Vercel REST API. The CLI owns the login, the API owns the resources,
// which is the split spec section 5 asks for.

import { existsSync, readFileSync } from 'node:fs'
import { homedir } from 'node:os'
import { join } from 'node:path'
import { CimientoError } from '../../core/errors'
import type { Ctx } from '../../core/types'

export const VERCEL_API = 'https://api.vercel.com'

const AUTH_FILES = [
  join(homedir(), 'Library', 'Application Support', 'com.vercel.cli', 'auth.json'),
  join(homedir(), '.local', 'share', 'com.vercel.cli', 'auth.json'),
  join(homedir(), '.config', 'com.vercel.cli', 'auth.json'),
]

/** Env var first, then whatever the vercel CLI stored when the person logged in. */
export function resolveVercelToken(ctx: Ctx, resource: string): string {
  const fromEnv = process.env.VERCEL_TOKEN
  if (fromEnv) {
    ctx.redactor.addValue(fromEnv)
    return fromEnv
  }
  for (const path of AUTH_FILES) {
    if (!existsSync(path)) continue
    try {
      const parsed = JSON.parse(readFileSync(path, 'utf8')) as { token?: string }
      if (parsed.token) {
        ctx.redactor.addValue(parsed.token)
        return parsed.token
      }
    } catch {
      // A corrupt auth file is the same as no auth file: fall through to the login hint.
    }
  }
  throw new CimientoError({
    code: 'VERCEL_TOKEN_MISSING',
    provider: 'vercel',
    resource,
    message: 'cimiento could not find a Vercel token from the CLI login or from VERCEL_TOKEN.',
    hint: 'cimiento up opens the Vercel login in your browser. On a machine with no browser, such as CI, set VERCEL_TOKEN in the environment. cimiento never asks you to paste a token into chat.',
    retryable: true,
    needsHuman: true,
  })
}

/** Appends teamId or slug so every call lands in the account stack.yaml pins. */
export function scopeQuery(ctx: Ctx): string {
  const account = ctx.manifest.accounts.vercel
  if (!account) return ''
  return account.startsWith('team_') ? `teamId=${encodeURIComponent(account)}` : `slug=${encodeURIComponent(account)}`
}

export function withScope(ctx: Ctx, path: string): string {
  const scope = scopeQuery(ctx)
  if (!scope) return `${VERCEL_API}${path}`
  return `${VERCEL_API}${path}${path.includes('?') ? '&' : '?'}${scope}`
}

export interface VercelCallResult<T> {
  status: number
  ok: boolean
  body: T | undefined
  raw: string
}

export async function vercelCall<T>(
  ctx: Ctx,
  resource: string,
  method: string,
  path: string,
  body?: unknown,
  options: { unscoped?: boolean } = {},
): Promise<VercelCallResult<T>> {
  const token = resolveVercelToken(ctx, resource)
  const res = await ctx.io.http({
    method,
    // A few account level endpoints refuse a team scope, the GitHub connection ones among them.
    url: options.unscoped ? `${VERCEL_API}${path}` : withScope(ctx, path),
    headers: { authorization: `Bearer ${token}` },
    ...(body === undefined ? {} : { body }),
  })
  return { status: res.status, ok: res.ok, body: res.json as T | undefined, raw: res.text }
}

/** Turns a non 2xx response into a CimientoError with the Vercel error message in it. */
export function vercelError(
  resource: string,
  result: VercelCallResult<unknown>,
  fallback: { code: string; message: string; hint: string; needsHuman?: boolean },
): CimientoError {
  const body = result.body as { error?: { code?: string; message?: string } } | undefined
  const detail = body?.error?.message ?? result.raw.slice(0, 300)
  const retryable = result.status === 429 || result.status >= 500
  return new CimientoError({
    code: fallback.code,
    provider: 'vercel',
    resource,
    message: `${fallback.message} Vercel answered ${result.status}: ${detail}`,
    hint: fallback.hint,
    retryable,
    needsHuman: fallback.needsHuman ?? (result.status === 401 || result.status === 403),
  })
}

/** Manifest environment names to the target names the Vercel API uses. */
export function toVercelTarget(environment: string): 'production' | 'preview' | 'development' {
  if (environment === 'production') return 'production'
  if (environment === 'preview') return 'preview'
  return 'development'
}

export interface VercelEnvEntry {
  id: string
  key: string
  target: string[]
  type?: string
}

/** The env entries of a project, names and targets only. */
export async function listEnvEntries(ctx: Ctx, resource: string, projectId: string): Promise<VercelEnvEntry[] | undefined> {
  if (!projectId) return undefined
  const list = await vercelCall<{ envs?: VercelEnvEntry[] }>(ctx, resource, 'GET', `/v9/projects/${encodeURIComponent(projectId)}/env`)
  return list.ok ? (list.body?.envs ?? []) : undefined
}

/**
 * One env value, decrypted, for a probe that needs it in memory. It is registered with the
 * redactor before it is returned, so no log line or json output can carry it.
 */
export async function readEnvValue(
  ctx: Ctx,
  resource: string,
  projectId: string,
  key: string,
  target: 'production' | 'preview' | 'development' = 'production',
): Promise<string | undefined> {
  const envs = await listEnvEntries(ctx, resource, projectId)
  const entry = envs?.find((e) => e.key === key && e.target.includes(target))
  if (!entry) return undefined
  const one = await vercelCall<{ value?: string }>(
    ctx,
    resource,
    'GET',
    `/v1/projects/${encodeURIComponent(projectId)}/env/${encodeURIComponent(entry.id)}`,
  )
  const value = one.ok ? one.body?.value : undefined
  if (!value) return undefined
  ctx.redactor.addName(key)
  ctx.redactor.addValue(value)
  return value
}
