// One cimiento run per project at a time. Two runs on one project could each create what the
// other is creating, and each would write state over the other. The lock lives outside the
// project folder, under ~/.cimiento/locks keyed by the project path, so git never sees it and
// publish can never commit it.

import { createHash } from 'node:crypto'
import { existsSync, mkdirSync, readFileSync, realpathSync, unlinkSync, writeFileSync } from 'node:fs'
import { homedir, hostname } from 'node:os'
import { join } from 'node:path'
import { CimientoError } from './errors'

interface LockRecord {
  pid: number
  host: string
  command: string
  startedAt: string
}

export interface StaleLock extends LockRecord {
  path: string
}

/** Locks this process holds, so a command that runs another one inside (new runs up) does not block itself. */
const held = new Map<string, number>()

export function lockPath(cwd: string): string {
  const base = process.env.CIMIENTO_LOCK_DIR ?? join(homedir(), '.cimiento', 'locks')
  let real = cwd
  try {
    real = realpathSync(cwd)
  } catch {
    // A folder that does not exist yet is keyed by the path as given.
  }
  return join(base, `${createHash('sha256').update(real).digest('hex').slice(0, 24)}.lock`)
}

function alive(pid: number): boolean {
  try {
    process.kill(pid, 0)
    return true
  } catch (err) {
    // EPERM means the process exists but belongs to someone else.
    return (err as NodeJS.ErrnoException).code === 'EPERM'
  }
}

function read(path: string): LockRecord | undefined {
  try {
    return JSON.parse(readFileSync(path, 'utf8')) as LockRecord
  } catch {
    return undefined
  }
}

/**
 * Takes the project lock and returns the function that releases it. A lock held by a live
 * process on this machine stops the run with PROJECT_LOCKED. A lock whose process is gone, such
 * as one left by a run that was killed, is reported through onStale and taken over.
 */
export function acquireProjectLock(cwd: string, command: string, onStale?: (stale: StaleLock) => void): () => void {
  const path = lockPath(cwd)
  const count = held.get(path)
  if (count !== undefined) {
    held.set(path, count + 1)
    return () => release(path)
  }
  mkdirSync(join(path, '..'), { recursive: true })
  const existing = existsSync(path) ? read(path) : undefined
  if (existing) {
    const sameMachine = existing.host === hostname()
    const running = sameMachine ? existing.pid !== process.pid && alive(existing.pid) : Date.now() - Date.parse(existing.startedAt) < 24 * 60 * 60 * 1000
    if (running) {
      throw new CimientoError({
        code: 'PROJECT_LOCKED',
        provider: 'core',
        resource: cwd,
        message: `Another cimiento ${existing.command} (process ${existing.pid} on ${existing.host}, started ${existing.startedAt}) is working on this project.`,
        hint: 'Wait for it to finish, then run the command again. Two runs at once could each create what the other is creating.',
        retryable: true,
        needsHuman: false,
      })
    }
    onStale?.({ ...existing, path })
    unlinkSync(path)
  }
  const record: LockRecord = { pid: process.pid, host: hostname(), command, startedAt: new Date().toISOString() }
  try {
    writeFileSync(path, `${JSON.stringify(record)}\n`, { flag: 'wx' })
  } catch (err) {
    if ((err as NodeJS.ErrnoException).code !== 'EEXIST') throw err
    // Another run took it between the check and the write.
    return acquireProjectLock(cwd, command, onStale)
  }
  held.set(path, 1)
  return () => release(path)
}

function release(path: string): void {
  const count = held.get(path) ?? 0
  if (count > 1) {
    held.set(path, count - 1)
    return
  }
  held.delete(path)
  const record = read(path)
  if (record && record.pid === process.pid) {
    try {
      unlinkSync(path)
    } catch {
      // Already gone.
    }
  }
}
