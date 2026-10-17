// Thin wrapper over the Supabase Management API. The CLI owns the login and the migrations,
// the API owns projects, keys and auth configuration.

import { existsSync, readFileSync } from 'node:fs'
import { homedir } from 'node:os'
import { join } from 'node:path'
import { CimientoError } from '../../core/errors'
import type { Ctx } from '../../core/types'

export const SUPABASE_API = 'https://api.supabase.com'

const TOKEN_FILES = [
  join(homedir(), '.supabase', 'access-token'),
  join(homedir(), 'Library', 'Application Support', 'supabase', 'access-token'),
]

/**
 * Supabase CLI v2 keeps its login in the macOS Keychain through go-keyring, service
 * "Supabase CLI", account set to the profile name. Older versions wrote a plain file. Part A of
 * Goal 1 found a machine that was logged in through the Keychain while cimiento only looked for
 * the file, so it reported no session and started a second login.
 */
export const KEYCHAIN_SERVICE = 'Supabase CLI'
export const KEYCHAIN_ACCOUNT = 'supabase'
const KEYRING_PREFIX = 'go-keyring-base64:'

/** The token if there is one, from the environment, the Keychain or an old token file. */
export async function findSupabaseToken(ctx: Ctx): Promise<string | undefined> {
  const fromEnv = process.env.SUPABASE_ACCESS_TOKEN
  if (fromEnv) {
    ctx.redactor.addValue(fromEnv)
    return fromEnv
  }
  // Off macOS there is no security binary, the call fails and the file fallback runs.
  const keychain = await ctx.io
    .exec('security', ['find-generic-password', '-s', KEYCHAIN_SERVICE, '-a', KEYCHAIN_ACCOUNT, '-w'])
    .catch(() => undefined)
  if (keychain && keychain.code === 0 && keychain.stdout.trim()) {
    const stored = keychain.stdout.trim()
    const token = decodeKeyring(stored)
    ctx.redactor.addValue(stored)
    ctx.redactor.addValue(token)
    return token
  }
  for (const path of TOKEN_FILES) {
    if (!existsSync(path)) continue
    try {
      const token = readFileSync(path, 'utf8').trim()
      if (token) {
        ctx.redactor.addValue(token)
        return token
      }
    } catch {
      // Unreadable token file is the same as no token.
    }
  }
  return undefined
}

export function decodeKeyring(stored: string): string {
  if (!stored.startsWith(KEYRING_PREFIX)) return stored
  return Buffer.from(stored.slice(KEYRING_PREFIX.length), 'base64').toString('utf8').trim()
}

export async function resolveSupabaseToken(ctx: Ctx, resource: string): Promise<string> {
  const token = await findSupabaseToken(ctx)
  if (token) return token
  throw new CimientoError({
    code: 'SUPABASE_TOKEN_MISSING',
    provider: 'supabase',
    resource,
    message: 'cimiento found no Supabase login: nothing in the Keychain, no token file and no SUPABASE_ACCESS_TOKEN.',
    hint: 'cimiento up opens the Supabase login in your browser. On a machine with no browser, such as CI, set SUPABASE_ACCESS_TOKEN in the environment. cimiento never asks you to paste a token into chat.',
    retryable: true,
    needsHuman: true,
  })
}

export interface SupabaseCallResult<T> {
  status: number
  ok: boolean
  body: T | undefined
  raw: string
}

export async function supabaseCall<T>(
  ctx: Ctx,
  resource: string,
  method: string,
  path: string,
  body?: unknown,
  headers: Record<string, string> = {},
): Promise<SupabaseCallResult<T>> {
  const token = await resolveSupabaseToken(ctx, resource)
  const res = await ctx.io.http({
    method,
    url: `${SUPABASE_API}${path}`,
    headers: { ...headers, authorization: `Bearer ${token}` },
    ...(body === undefined ? {} : { body }),
  })
  return { status: res.status, ok: res.ok, body: res.json as T | undefined, raw: res.text }
}

export function supabaseError(
  resource: string,
  result: SupabaseCallResult<unknown>,
  fallback: { code: string; message: string; hint: string; needsHuman?: boolean },
): CimientoError {
  const body = result.body as { message?: string; error?: string } | undefined
  const detail = body?.message ?? body?.error ?? result.raw.slice(0, 300)
  return new CimientoError({
    code: fallback.code,
    provider: 'supabase',
    resource,
    message: `${fallback.message} Supabase answered ${result.status}: ${detail}`,
    hint: fallback.hint,
    retryable: result.status === 429 || result.status >= 500,
    needsHuman: fallback.needsHuman ?? (result.status === 401 || result.status === 403),
  })
}
