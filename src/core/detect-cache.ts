// What a run learns about the machine, tool versions and who each vendor CLI is logged in as, is
// asked once per run and kept per machine for a short time (Goal 8, BUG-93). A noop up asked
// gh --version eight times and vercel whoami three, and took 90 s. Nothing secret is kept: a
// version, an account name. Any auth error or login clears the identities, because a cached one
// could be stale exactly then.

import { existsSync, mkdirSync, readFileSync, renameSync, writeFileSync } from 'node:fs'
import { dirname, join } from 'node:path'
import type { Io } from './io'
import { machineStatePath } from './state'

/** Tool versions and identities: long enough for back to back commands, short enough to notice a change. */
export const DETECT_TTL_MS = 10 * 60 * 1000
/** The latest version of a tool, a network lookup that changes slowly. */
export const UPDATE_TTL_MS = 60 * 60 * 1000

interface Entry {
  at: number
  value: unknown
}

const memory = new Map<string, Promise<unknown>>()
let disk: Record<string, Entry> | undefined

/** The machine cache is on unless CIMIENTO_DETECT_CACHE is off; the tests turn it off. */
function diskEnabled(): boolean {
  return process.env.CIMIENTO_DETECT_CACHE !== 'off'
}

export function cachePath(): string {
  return join(dirname(machineStatePath()), 'detect-cache.json')
}

function load(): Record<string, Entry> {
  if (disk) return disk
  disk = {}
  if (!diskEnabled()) return disk
  try {
    if (existsSync(cachePath())) disk = JSON.parse(readFileSync(cachePath(), 'utf8')) as Record<string, Entry>
  } catch {
    disk = {}
  }
  return disk
}

function save(): void {
  if (!diskEnabled() || !disk) return
  try {
    const path = cachePath()
    mkdirSync(dirname(path), { recursive: true })
    const temp = `${path}.${process.pid}.tmp`
    writeFileSync(temp, JSON.stringify(disk), { mode: 0o600 })
    renameSync(temp, path)
  } catch {
    // A cache that cannot be written only costs time.
  }
}

/**
 * The value for key: from this run, then from the machine cache when younger than ttl, else
 * computed once, even when several callers ask at the same time. keep says whether a computed
 * value may be stored; a failure or an absent login is never cached on disk.
 */
export function cached<T>(key: string, ttl: number, compute: () => Promise<T>, keep: (value: T) => boolean = () => true): Promise<T> {
  const hit = memory.get(key)
  if (hit) return hit as Promise<T>
  const entry = load()[key]
  if (entry && Date.now() - entry.at < ttl) {
    const value = Promise.resolve(entry.value as T)
    memory.set(key, value)
    return value
  }
  const pending = compute().then(
    (value) => {
      if (keep(value)) {
        load()[key] = { at: Date.now(), value }
        save()
      } else {
        memory.delete(key)
      }
      return value
    },
    (err: unknown) => {
      memory.delete(key)
      throw err
    },
  )
  memory.set(key, pending)
  return pending
}

/** Drops every key starting with prefix, in this run and on the machine. */
export function invalidate(prefix = ''): void {
  for (const key of [...memory.keys()]) if (key.startsWith(prefix)) memory.delete(key)
  const entries = load()
  let changed = false
  for (const key of Object.keys(entries)) {
    if (key.startsWith(prefix)) {
      delete entries[key]
      changed = true
    }
  }
  if (changed) save()
}

/** The identities, after an auth error anywhere: the next ask goes to the vendor again. */
export function invalidateSessions(): void {
  invalidate('session:')
}

/** A new run starts from the machine cache, never from another run's memory. */
export function resetRunCache(): void {
  memory.clear()
  disk = undefined
}

const AUTH_FAILURE = /not logged in|logged out|log in again|authentication (required|failed)|unauthori[sz]ed|token (is )?(invalid|expired|revoked)|re-?authenticate|\b401\b/i

/**
 * The io every command uses, watching for auth errors: a 401 or 403 from any vendor API, a vendor
 * CLI that says it is not logged in, or a login run in the terminal, clears the cached identities.
 */
export function watchingAuth(io: Io): Io & { inner: Io } {
  return {
    /** The io underneath, for tests that drive a fake cloud through ctx.io. */
    inner: io,
    exec: async (cmd, args, opts) => {
      const result = await io.exec(cmd, args, opts)
      if (result.code !== 0 && AUTH_FAILURE.test(`${result.stderr}\n${result.stdout}`)) invalidateSessions()
      return result
    },
    interactive: async (cmd, args, opts) => {
      const result = await io.interactive(cmd, args, opts)
      // A command in the person's terminal is a login or a vendor step that may change who is logged in.
      invalidateSessions()
      return result
    },
    spawn: (cmd, args, opts) => io.spawn(cmd, args, opts),
    http: async (req) => {
      const result = await io.http(req)
      if (result.status === 401 || result.status === 403) invalidateSessions()
      return result
    },
    sql: (connectionString, text) => io.sql(connectionString, text),
  }
}
