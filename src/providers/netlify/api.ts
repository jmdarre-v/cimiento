// Thin wrapper over the Netlify API. netlify login stores a token in the CLI's global config; the
// API owns sites, env vars and deploys, the split spec section 5 asks for.

import { existsSync, readFileSync } from 'node:fs'
import { homedir } from 'node:os'
import { join } from 'node:path'
import { CimientoError } from '../../core/errors'
import type { Ctx } from '../../core/types'

export const NETLIFY_API = 'https://api.netlify.com/api/v1'

export function netlifyConfigPaths(): string[] {
  const xdg = process.env.XDG_CONFIG_HOME || join(homedir(), '.config')
  return [
    join(homedir(), 'Library', 'Preferences', 'netlify', 'config.json'),
    join(xdg, 'netlify', 'config.json'),
    join(homedir(), '.netlify', 'config.json'),
  ]
}

/** NETLIFY_AUTH_TOKEN first, then the token of the user netlify login stored. Undefined when none. */
export function findNetlifyToken(): string | undefined {
  const fromEnv = process.env.NETLIFY_AUTH_TOKEN
  if (fromEnv && fromEnv !== 'null') return fromEnv
  for (const path of netlifyConfigPaths()) {
    if (!existsSync(path)) continue
    try {
      const parsed = JSON.parse(readFileSync(path, 'utf8')) as { userId?: string; users?: Record<string, { auth?: { token?: string } }> }
      const token = parsed.userId ? parsed.users?.[parsed.userId]?.auth?.token : undefined
      if (token) return token
    } catch {
      // A corrupt config is the same as no config: fall through to the login hint.
    }
  }
  return undefined
}

export function resolveNetlifyToken(ctx: Ctx, resource: string): string {
  const token = findNetlifyToken()
  if (token) {
    ctx.redactor.addValue(token)
    return token
  }
  throw new CimientoError({
    code: 'NETLIFY_TOKEN_MISSING',
    provider: 'netlify',
    resource,
    message: 'cimiento could not find a Netlify token from the netlify login or from NETLIFY_AUTH_TOKEN.',
    hint: 'cimiento up opens the Netlify login in your browser. On a machine with no browser, such as CI, set NETLIFY_AUTH_TOKEN in the environment. cimiento never asks you to paste a token into chat.',
    retryable: true,
    needsHuman: true,
  })
}

export interface NetlifyCallResult<T> {
  status: number
  ok: boolean
  body: T | undefined
}

export async function netlifyCall<T>(ctx: Ctx, resource: string, method: string, path: string, body?: unknown): Promise<NetlifyCallResult<T>> {
  const token = resolveNetlifyToken(ctx, resource)
  const res = await ctx.io.http({
    method,
    url: `${NETLIFY_API}${path}`,
    headers: { authorization: `Bearer ${token}`, ...(body !== undefined ? { 'content-type': 'application/json' } : {}) },
    ...(body !== undefined ? { body } : {}),
  })
  return { status: res.status, ok: res.ok, body: res.json as T | undefined }
}

export function netlifyError(resource: string, result: NetlifyCallResult<unknown>, fallback: { code: string; message: string; hint: string }): CimientoError {
  const detail = (result.body as { message?: string; errors?: unknown } | undefined)?.message
  return new CimientoError({
    code: result.status === 401 ? 'NETLIFY_TOKEN_MISSING' : fallback.code,
    provider: 'netlify',
    resource,
    message: `${fallback.message} (${result.status}${detail ? `: ${String(detail).slice(0, 200)}` : ''})`,
    hint: result.status === 401 ? 'The Netlify login expired or was revoked. cimiento up opens the Netlify login again.' : fallback.hint,
    retryable: result.status === 429 || result.status >= 500,
    needsHuman: result.status === 401,
  })
}

/** Netlify deploy contexts for a cimiento environment. A preview is both a PR preview and a branch deploy. */
export function netlifyContexts(environment: string): string[] {
  if (environment === 'production') return ['production']
  if (environment === 'preview') return ['deploy-preview', 'branch-deploy']
  return ['dev']
}
