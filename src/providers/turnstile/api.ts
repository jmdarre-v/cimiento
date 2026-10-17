// Thin wrapper over the Cloudflare API. wrangler owns the login and stores the OAuth token, and
// cimiento asks it for that token once per run. Nothing is written to disk by cimiento.

import { readdirSync, readFileSync } from 'node:fs'
import { join } from 'node:path'
import { CimientoError } from '../../core/errors'
import type { Ctx } from '../../core/types'

export const CLOUDFLARE_API = 'https://api.cloudflare.com/client/v4'
export const SITEVERIFY_URL = 'https://challenges.cloudflare.com/turnstile/v0/siteverify'

/**
 * The scope the Turnstile provider needs. wrangler 4 asks for it in its default login, so cimiento
 * runs a plain wrangler login: narrowing --scopes would drop the Workers permissions a person may
 * rely on, and wrangler rejects offline_access as a --scopes key (BUG-47).
 */
export const WIDGET_SCOPE = 'challenge-widgets.write'

/**
 * The last error wrangler wrote to its debug log, which cimiento points at a folder of its own with
 * WRANGLER_LOG_PATH. The login runs with the person's terminal attached, so this is the only place
 * the real cause can be read from.
 */
export function wranglerLogError(dir: string): string | undefined {
  let files: string[] = []
  try {
    files = readdirSync(dir).filter((f) => f.endsWith('.log')).sort()
  } catch {
    return undefined
  }
  for (const file of files.reverse()) {
    const text = readFileSync(join(dir, file), 'utf8')
    const match = /\[ERROR\]\s*(.+)/.exec(text.split('\n').reverse().join('\n'))
    if (match) return match[1].trim()
  }
  return undefined
}

export interface Whoami {
  loggedIn: boolean
  email?: string
  accounts: { id: string; name: string }[]
  tokenPermissions?: string[]
}

/** First JSON object in the output. wrangler can print a banner or a warning before it. */
function parseJson<T>(text: string): T | undefined {
  const start = text.indexOf('{')
  const end = text.lastIndexOf('}')
  if (start < 0 || end < start) return undefined
  try {
    return JSON.parse(text.slice(start, end + 1)) as T
  } catch {
    return undefined
  }
}

export async function wranglerWhoami(ctx: Ctx): Promise<Whoami | undefined> {
  const result = await ctx.io.exec('wrangler', ['whoami', '--json']).catch(() => undefined)
  if (!result || result.code !== 0) return undefined
  const parsed = parseJson<Partial<Whoami>>(result.stdout)
  if (!parsed?.loggedIn) return undefined
  return {
    loggedIn: true,
    ...(parsed.email ? { email: parsed.email } : {}),
    accounts: (parsed.accounts ?? []).filter((a) => a && typeof a.id === 'string'),
    ...(Array.isArray(parsed.tokenPermissions) ? { tokenPermissions: parsed.tokenPermissions } : {}),
  }
}

let cachedToken: string | undefined

/** Drops the cached token. Tests use it, and a fresh login makes the old one useless. */
export function clearCloudflareToken(): void {
  cachedToken = undefined
}

export async function cloudflareToken(ctx: Ctx, resource: string): Promise<string> {
  if (cachedToken) return cachedToken
  const fromEnv = process.env.CLOUDFLARE_API_TOKEN
  if (fromEnv) {
    ctx.redactor.addValue(fromEnv)
    cachedToken = fromEnv
    return fromEnv
  }
  const result = await ctx.io.exec('wrangler', ['auth', 'token', '--json']).catch(() => undefined)
  const parsed = result && result.code === 0 ? parseJson<{ token?: string }>(result.stdout) : undefined
  if (!parsed?.token) {
    throw new CimientoError({
      code: 'SESSION_MISSING',
      provider: 'turnstile',
      resource,
      message: 'wrangler has no Cloudflare login, so cimiento has no token for the Cloudflare API.',
      hint: `cimiento up opens the Cloudflare login in your browser. Run it in a terminal in ${ctx.cwd}. On a machine with no browser, such as CI, set CLOUDFLARE_API_TOKEN in the environment.`,
      retryable: true,
      needsHuman: true,
    })
  }
  ctx.redactor.addValue(parsed.token)
  cachedToken = parsed.token
  return parsed.token
}

export interface CloudflareResult<T> {
  status: number
  ok: boolean
  result: T | undefined
  message: string
}

export async function cloudflareCall<T>(ctx: Ctx, resource: string, method: string, path: string, body?: unknown): Promise<CloudflareResult<T>> {
  const token = await cloudflareToken(ctx, resource)
  const res = await ctx.io.http({
    method,
    url: `${CLOUDFLARE_API}${path}`,
    headers: { authorization: `Bearer ${token}` },
    ...(body === undefined ? {} : { body }),
  })
  const json = res.json as { success?: boolean; result?: T; errors?: { message?: string }[] } | undefined
  const ok = res.ok && json?.success !== false
  const message = (json?.errors ?? []).map((e) => e.message).filter(Boolean).join('; ') || res.text.slice(0, 300)
  return { status: res.status, ok, result: json?.result, message }
}

export function cloudflareError(resource: string, result: CloudflareResult<unknown>, message: string, hint: string): CimientoError {
  const scope = result.status === 403
  return new CimientoError({
    code: scope ? 'SESSION_MISSING' : 'TURNSTILE_API_ERROR',
    provider: 'turnstile',
    resource,
    message: `${message} Cloudflare answered ${result.status}: ${result.message}`,
    hint: scope
      ? 'The Cloudflare login has no permission to manage Turnstile widgets. Run cimiento up in a terminal; it logs in again asking for that permission.'
      : hint,
    retryable: result.status === 429 || result.status >= 500,
    needsHuman: scope,
  })
}
