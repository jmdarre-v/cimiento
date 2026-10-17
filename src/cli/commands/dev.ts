// cimiento dev, spec section 9. Starts the local database, the jobs dev server and the framework
// with fixed ports, as one process with one Ctrl+C. Secrets reach the app through its environment
// in memory, read from their declared source; nothing new is written to disk.

import { existsSync } from 'node:fs'
import { join } from 'node:path'
import { CimientoError, ExitCode } from '../../core/errors'
import type { Running } from '../../core/io'
import { openProject, type Session } from '../context'

export const DEV_PORTS = { app: 3000, jobs: 8288, database: 54321 } as const
/** Pinned so every machine runs the same dev server. */
export const INNGEST_CLI_VERSION = '1.46.0'

interface Service {
  name: 'database' | 'jobs' | 'app'
  running: Running
}

export async function devCommand(session: Session): Promise<number> {
  const project = openProject(session, { dryRun: true })
  const { manifest } = project
  const cwd = project.ctx.cwd
  const io = session.io
  const services: Service[] = []
  const env: Record<string, string> = { PORT: String(DEV_PORTS.app) }
  let databaseStarted = false

  const announce = (service: string, url: string): void => {
    if (session.json) session.printer.emit({ event: 'started', command: 'dev', service, url })
    else session.printer.line(`${service.padEnd(8)} ${url}`)
  }
  const forward = (name: string) => (line: string) => {
    if (!session.json && line.trim()) session.printer.line(`[${name}] ${line}`)
  }
  const stopAll = async (): Promise<void> => {
    for (const service of services) service.running.kill('SIGINT')
    await Promise.race([Promise.all(services.map((s) => s.running.exited)), delay(10_000, true)])
    if (databaseStarted) await io.exec('supabase', ['stop'], { cwd, timeoutMs: 120_000 }).catch(() => undefined)
  }

  try {
    if (manifest.slots.database === 'supabase') {
      await ensureDocker(session)
      if (!existsSync(join(cwd, 'supabase', 'config.toml'))) {
        const init = await io.exec('supabase', ['init'], { cwd })
        if (init.code !== 0) throw devError('database', `supabase init failed: ${(init.stderr || init.stdout).trim().slice(0, 300)}`)
      }
      if (!session.json) session.printer.line('Starting the local database. The first run downloads the Supabase images, which takes a few minutes.')
      const started = await io.exec('supabase', ['start'], { cwd, timeoutMs: 20 * 60 * 1000 })
      if (started.code !== 0) throw devError('database', `supabase start failed: ${(started.stderr || started.stdout).trim().slice(0, 400)}`)
      databaseStarted = true
      const status = await io.exec('supabase', ['status', '-o', 'env'], { cwd })
      const local = parseEnvLines(status.stdout)
      for (const value of [local.ANON_KEY, local.SERVICE_ROLE_KEY]) if (value) session.redactor.addValue(value)
      // The local database wins over the hosted one that .env.local points at: Next.js never
      // overrides a variable that is already in the process environment.
      if (local.API_URL) env.NEXT_PUBLIC_SUPABASE_URL = local.API_URL
      if (local.ANON_KEY) env.NEXT_PUBLIC_SUPABASE_ANON_KEY = local.ANON_KEY
      if (local.SERVICE_ROLE_KEY) env.SUPABASE_SERVICE_ROLE_KEY = local.SERVICE_ROLE_KEY
      announce('database', local.API_URL ?? `http://127.0.0.1:${DEV_PORTS.database}`)
    }

    for (const secret of manifest.secrets) {
      const value = await project.secrets.get(secret.name).catch(() => undefined)
      if (value) env[secret.name] = value
    }

    if (manifest.slots.jobs === 'inngest') {
      env.INNGEST_DEV = '1'
      env.INNGEST_BASE_URL = `http://localhost:${DEV_PORTS.jobs}`
      services.push({
        name: 'jobs',
        running: io.spawn(
          'npx',
          ['--yes', `inngest-cli@${INNGEST_CLI_VERSION}`, 'dev', '-u', `http://localhost:${DEV_PORTS.app}/api/inngest`, '--port', String(DEV_PORTS.jobs), '--no-discovery'],
          { cwd, onLine: forward('jobs') },
        ),
      })
      announce('jobs', `http://localhost:${DEV_PORTS.jobs}`)
    }

    if (existsSync(join(cwd, 'package.json'))) {
      const pm = existsSync(join(cwd, 'pnpm-lock.yaml')) ? 'pnpm' : existsSync(join(cwd, 'yarn.lock')) ? 'yarn' : 'npm'
      if (!existsSync(join(cwd, 'node_modules'))) {
        const installed = await io.exec(pm, ['install'], { cwd, timeoutMs: 15 * 60 * 1000 })
        if (installed.code !== 0) throw devError('app', `${pm} install failed: ${(installed.stderr || installed.stdout).trim().slice(0, 300)}`)
      }
      const args = pm === 'npm' ? ['run', 'dev', '--', '--port', String(DEV_PORTS.app)] : ['dev', '--port', String(DEV_PORTS.app)]
      services.push({ name: 'app', running: io.spawn(pm, args, { cwd, env, onLine: forward('app') }) })
      announce('app', `http://localhost:${DEV_PORTS.app}`)
    }
  } catch (err) {
    await stopAll()
    throw err
  }

  if (services.length === 0 && !databaseStarted) {
    throw devError('app', 'There is nothing to start here: no package.json, no database and no jobs slot.')
  }
  if (!session.json) session.printer.line('\nEverything is running. Press Ctrl+C once to stop all of it.')

  let stopped = false
  const stop =
    session.deps.stopSignal ??
    new Promise<void>((resolve) => {
      process.once('SIGINT', () => resolve())
    })
  const ended = Promise.race(services.map((s) => s.running.exited.then((code) => ({ name: s.name, code }))))
  const first = await Promise.race([stop.then(() => ((stopped = true), undefined)), ended])
  await stopAll()

  if (!stopped && first) {
    const error = devError(first.name, `The ${first.name} service stopped on its own with exit code ${first.code}, so cimiento stopped the others.`)
    if (session.json) session.printer.emit({ ok: false, command: 'dev', errors: [error.toJSON()] })
    else session.printer.error(error.toJSON())
    return ExitCode.failed
  }
  if (session.json) session.printer.emit({ ok: true, command: 'dev', event: 'stopped', services: services.map((s) => s.name) })
  else session.printer.line('Stopped everything.')
  return ExitCode.ok
}

/** Docker runs the local database. On a Mac, cimiento opens Docker Desktop and waits for it. */
async function ensureDocker(session: Session): Promise<void> {
  const ready = async () => (await session.io.exec('docker', ['info']).catch(() => ({ code: 1 }))).code === 0
  if (await ready()) return
  if (session.interactive && process.platform === 'darwin') {
    session.printer.line('Docker is not running. Opening Docker Desktop and waiting for it.')
    await session.io.exec('open', ['-a', 'Docker']).catch(() => undefined)
    for (let i = 0; i < 40; i += 1) {
      await delay(3000)
      if (await ready()) return
    }
  }
  throw new CimientoError({
    code: 'DEV_SERVICE_FAILED',
    provider: 'core',
    resource: 'dev.database',
    message: 'Docker is not running, and the local Supabase database runs on Docker.',
    hint: 'Run cimiento dev in a terminal on this Mac; it opens Docker Desktop and waits. Without Docker Desktop installed, install it from docker.com once.',
    retryable: true,
    needsHuman: true,
  })
}

function devError(service: string, message: string): CimientoError {
  return new CimientoError({
    code: 'DEV_SERVICE_FAILED',
    provider: 'core',
    resource: `dev.${service}`,
    message,
    hint: 'The lines above, prefixed with the service name, say why. Fix that and run cimiento dev again; nothing was left running.',
    retryable: true,
    needsHuman: false,
  })
}

function parseEnvLines(text: string): Record<string, string> {
  const out: Record<string, string> = {}
  for (const line of text.split('\n')) {
    const match = /^\s*([A-Z_][A-Z0-9_]*)=\s*"?(.*?)"?\s*$/.exec(line)
    if (match) out[match[1]] = match[2]
  }
  return out
}

/** unref lets the process exit without waiting out a timer that only bounds a shutdown. */
function delay(ms: number, unref = false): Promise<void> {
  return new Promise((resolve) => {
    const timer = setTimeout(resolve, ms)
    if (unref) timer.unref()
  })
}
