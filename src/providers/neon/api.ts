// Thin wrapper over the Neon API and Neon's HTTP query endpoint. neonctl owns the login and keeps
// a short lived OAuth token that it refreshes on every command, so cimiento runs neonctl me before
// reading the token file when the token has expired. NEON_API_KEY wins when it is set.

import { existsSync, readFileSync } from 'node:fs'
import { homedir } from 'node:os'
import { join } from 'node:path'
import { CimientoError } from '../../core/errors'
import type { Ctx } from '../../core/types'

export const NEON_API = 'https://console.neon.tech/api/v2'

/**
 * Where neonctl keeps its login. Current releases use ~/.config/neon; older ones used
 * ~/.config/neonctl (BUG-67). The first that exists wins.
 */
export function neonCredentialsPaths(): string[] {
  const base = process.env.XDG_CONFIG_HOME || join(homedir(), '.config')
  return [join(base, 'neon', 'credentials.json'), join(base, 'neonctl', 'credentials.json')]
}

function fileToken(): { token: string; expired: boolean } | undefined {
  const path = neonCredentialsPaths().find((p) => existsSync(p))
  if (!path) return undefined
  try {
    const parsed = JSON.parse(readFileSync(path, 'utf8')) as { access_token?: string; expires_at?: number }
    if (!parsed.access_token) return undefined
    return { token: parsed.access_token, expired: typeof parsed.expires_at === 'number' && parsed.expires_at <= Date.now() }
  } catch {
    return undefined
  }
}

export async function resolveNeonToken(ctx: Ctx, resource: string): Promise<string> {
  const fromEnv = process.env.NEON_API_KEY
  if (fromEnv) {
    ctx.redactor.addValue(fromEnv)
    return fromEnv
  }
  let found = fileToken()
  if (found?.expired) {
    // Any neonctl command refreshes the token with the stored refresh token.
    await ctx.io.exec('neonctl', ['me', '--output', 'json']).catch(() => undefined)
    found = fileToken()
  }
  if (found && !found.expired) {
    ctx.redactor.addValue(found.token)
    return found.token
  }
  throw new CimientoError({
    code: 'NEON_TOKEN_MISSING',
    provider: 'neon',
    resource,
    message: 'cimiento could not find a Neon token from the neonctl login or from NEON_API_KEY.',
    hint: 'cimiento up opens the Neon login in your browser. On a machine with no browser, such as CI, set NEON_API_KEY in the environment. cimiento never asks you to paste a token into chat.',
    retryable: true,
    needsHuman: true,
  })
}

export interface NeonCallResult<T> {
  status: number
  ok: boolean
  body: T | undefined
}

export async function neonCall<T>(ctx: Ctx, resource: string, method: string, path: string, body?: unknown): Promise<NeonCallResult<T>> {
  const token = await resolveNeonToken(ctx, resource)
  const res = await ctx.io.http({
    method,
    url: `${NEON_API}${path}`,
    headers: { authorization: `Bearer ${token}`, accept: 'application/json', ...(body !== undefined ? { 'content-type': 'application/json' } : {}) },
    ...(body !== undefined ? { body } : {}),
  })
  return { status: res.status, ok: res.ok, body: res.json as T | undefined }
}

export function neonError(resource: string, result: NeonCallResult<unknown>, fallback: { code: string; message: string; hint: string }): CimientoError {
  const detail = (result.body as { message?: string } | undefined)?.message
  return new CimientoError({
    code: result.status === 401 ? 'NEON_TOKEN_MISSING' : fallback.code,
    provider: 'neon',
    resource,
    message: `${fallback.message} (${result.status}${detail ? `: ${detail.slice(0, 200)}` : ''})`,
    hint: result.status === 401 ? 'The Neon login expired. cimiento up opens the Neon login again.' : fallback.hint,
    retryable: result.status === 429 || result.status >= 500,
    needsHuman: result.status === 401,
  })
}
