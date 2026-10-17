// cimiento join, spec section 9. On a cloned repository: tools, logins, access verification
// against every resource in state, env pull, checks. It never creates a cloud resource: a
// resource missing from the cloud is reported, and up is the command that creates it.

import { readFileSync } from 'node:fs'
import { join } from 'node:path'
import { CimientoError, ExitCode, needsPerson, type CimientoErrorFields } from '../../core/errors'
import { runUp, runVerifyAll, type VerifyReport } from '../../core/executor'
import { hashManifest, writeProjectState } from '../../core/state'
import { openProject, type Session } from '../context'
import { pullEnv } from './env'

export async function joinCommand(session: Session): Promise<number> {
  const project = openProject(session, { dryRun: false })
  const inState = project.specs.filter((s) => s.kind === 'resource' && project.state.resources[s.id])
  if (inState.length === 0) {
    throw new CimientoError({
      code: 'JOIN_NO_STATE',
      provider: 'core',
      resource: 'join',
      message: `${session.cwd} has no .cimiento/state.json with resources in it, so there is no existing project to join.`,
      hint: 'Pull the latest commit, which carries .cimiento/state.json. If this project was never set up, run cimiento up instead.',
      retryable: false,
      needsHuman: true,
    })
  }

  // 1. Tools and logins on this machine, and the account pins stack.yaml asks for.
  const machineSpecs = project.specs.filter((s) => s.kind === 'tool' || s.kind === 'session')
  const setup = await runUp(project.ctx, project.providers, machineSpecs, {
    onManual: async () => false,
    onEvent: (event) => {
      if (session.json) session.printer.emit({ ...event, phase: 'setup' })
      else if (event.event === 'ensured' && event.id) session.printer.line(`ok      ${event.id}`)
    },
  })
  const manifestHash = hashManifest(readFileSync(join(session.cwd, 'stack.yaml'), 'utf8'))
  writeProjectState(session.cwd, { ...setup.state, manifestHash })

  // 2. Every resource, binding, manual step and check, verified without changing anything.
  const reports: VerifyReport[] =
    setup.exitCode === ExitCode.ok ? await runVerifyAll({ ...project.ctx, state: setup.state }, project.providers, project.specs) : []

  // 3. env pull, once the hosting project is reachable from this machine.
  let envPull: { file: string; names: string[] } | undefined
  const errors: CimientoErrorFields[] = [...setup.errors]
  const hostingOk = reports.some((r) => r.id === 'vercel.project' && r.ok)
  if (project.manifest.slots.hosting === 'vercel' && hostingOk) {
    try {
      const pulled = await pullEnv(session, { ...project, ctx: { ...project.ctx, state: setup.state } })
      envPull = { file: pulled.target, names: pulled.names }
    } catch (err) {
      if (err instanceof CimientoError) errors.push(err.toJSON())
      else throw err
    }
  }

  const failed = reports.filter((r) => !r.ok)
  const waiting = [...setup.pendingManual, ...failed.filter((r) => r.error && needsPerson(r.error)).map((r) => r.id)]
  const exitCode =
    errors.length > 0 || failed.some((r) => !r.error || !needsPerson(r.error))
      ? ExitCode.failed
      : waiting.length > 0
        ? ExitCode.needsHuman
        : ExitCode.ok

  if (session.json) {
    session.printer.emit({
      ok: exitCode === ExitCode.ok,
      command: 'join',
      exitCode,
      setup: { receipts: setup.receipts, pending: setup.pendingManual },
      items: reports,
      envPull: envPull ?? null,
      waiting,
      errors,
      summary: { ok: reports.filter((r) => r.ok).length, failed: failed.length, total: reports.length },
    })
  } else {
    if (reports.length > 0) session.printer.doctorTable(reports)
    if (envPull) session.printer.line(`\nWrote ${envPull.file} with ${envPull.names.length} variables, names only: ${envPull.names.join(', ')}`)
    for (const error of errors) session.printer.error(error)
    for (const id of setup.pendingManual) session.printer.line(`Waiting on you: ${id}. Run cimiento join in a terminal; it opens the login.`)
    if (exitCode === ExitCode.ok) session.printer.line('\nThis machine is joined: tools, logins, access and env are all in place.')
  }
  return exitCode
}
