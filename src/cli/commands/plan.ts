// cimiento plan. Reads the manifest and state, refreshes reality, changes nothing.

import { ExitCode } from '../../core/errors'
import { buildPlan } from '../../core/planner'
import { openProject, type Session } from '../context'

export async function planCommand(session: Session): Promise<number> {
  const project = openProject(session, { dryRun: true })
  const plan = await buildPlan(project.ctx, project.providers, project.specs, {
    only: session.only,
    skip: session.skip,
    billingApproved: session.allowBilling,
  })

  if (project.state.manifestHash && project.state.manifestHash !== project.manifestHash) {
    plan.warnings.push('stack.yaml changed since the last up, so this plan is computed from the new manifest.')
  }

  session.printer.planTable(plan)
  // plan is read only, so it reports rather than fails. A blocked item on a fresh project is the
  // normal shape of a plan, not an error.
  return ExitCode.ok
}
