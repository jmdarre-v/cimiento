// cimiento doctor. Re-detects tools and sessions, re-verifies every resource and binding, runs
// the checks, and prints a table plus structured errors.

import { existsSync } from 'node:fs'
import { join } from 'node:path'
import { ExitCode } from '../../core/errors'
import { detectWithoutManifest } from './detect'
import { runVerifyAll } from '../../core/executor'
import { isStale, writeMachineState, machineStatePath } from '../../core/state'
import { outdatedTools, toolVersion } from '../../core/toolkit'
import type { Detection } from '../../core/types'
import { announceSmoke, openProject, type Session } from '../context'

export async function doctorCommand(session: Session): Promise<number> {
  // An existing project without stack.yaml: detect, read only, create nothing (BUG-80).
  if (!existsSync(join(session.cwd, 'stack.yaml'))) return detectWithoutManifest(session)
  const project = openProject(session, { dryRun: true })

  // Refresh the machine level picture first: tools and sessions, per spec section 7.
  const machine = { ...project.ctx.machine, tools: { ...project.ctx.machine.tools }, sessions: { ...project.ctx.machine.sessions } }
  const now = new Date().toISOString()
  for (const provider of project.providers) {
    const detection: Detection = await provider.detect(project.ctx).catch(() => ({ installed: false }))
    // Each tool is asked for its own version. detect() reports one version per provider, which is
    // how git once got recorded with the version of gh.
    for (const tool of provider.tools) {
      const version = await toolVersion(project.ctx, tool)
      if (version) machine.tools[tool.bin] = { version, checkedAt: now }
      else delete machine.tools[tool.bin]
    }
    if (detection.session) {
      machine.sessions[provider.id] = {
        account: detection.session.account,
        checkedAt: now,
        ...(detection.session.expiresAt ? { expiresAt: detection.session.expiresAt } : {}),
      }
    } else {
      delete machine.sessions[provider.id]
    }
  }
  try {
    writeMachineState(machine, machineStatePath())
  } catch {
    // A machine state that cannot be written is not a reason to fail the report.
  }

  announceSmoke(session, project)

  const reports = await runVerifyAll({ ...project.ctx, machine }, project.providers, project.specs, {
    only: session.only,
    skip: session.skip,
  })

  // Reported, never asked about: doctor changes nothing (BUG-43).
  const outdated = (await outdatedTools(project.ctx, project.providers).catch(() => [])).map((t) => ({
    bin: t.bin,
    installed: t.installed,
    latest: t.latest,
    ...(t.upgrade ? { upgrade: `${t.upgrade.cmd} ${t.upgrade.args.join(' ')}` } : {}),
    skipped: t.skipped,
  }))

  const stale = project.specs
    .filter((spec) => project.state.resources[spec.id] && isStale(project.state.resources[spec.id]))
    .map((spec) => spec.id)

  if (session.json) {
    session.printer.emit({
      ok: reports.every((r) => r.ok),
      command: 'doctor',
      items: reports,
      stale,
      outdated,
      summary: {
        ok: reports.filter((r) => r.status === 'ok').length,
        failed: reports.filter((r) => r.status === 'failed').length,
        unknown: reports.filter((r) => r.status === 'unknown').length,
        total: reports.length,
      },
    })
  } else {
    session.printer.doctorTable(reports)
    if (outdated.length > 0) {
      session.printer.line(
        `\nNewer tool versions: ${outdated.map((t) => `${t.bin} ${t.installed} to ${t.latest}`).join(', ')}. cimiento up asks once before its plan.`,
      )
    }
    if (stale.length > 0) {
      session.printer.line(`\nRe-probed because the last check is older than seven days: ${stale.join(', ')}`)
    }
  }

  const failed = reports.filter((r) => !r.ok)
  if (failed.length === 0) return ExitCode.ok
  if (failed.every((r) => r.error?.needsHuman)) return ExitCode.needsHuman
  return ExitCode.failed
}
