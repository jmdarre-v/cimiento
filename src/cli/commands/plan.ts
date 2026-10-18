// cimiento plan. Reads the manifest and state, refreshes reality, changes nothing.

import { ExitCode } from '../../core/errors'
import { buildPlan } from '../../core/planner'
import { sharedPreviewWarning } from '../../core/hosting'
import { previewProjectNotice } from '../../providers/supabase'
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

  const shared = sharedPreviewWarning(project.manifest)
  if (shared) plan.warnings.push(shared)
  const second = previewProjectNotice(project.manifest, project.state)
  if (second) plan.warnings.push(second)
  for (const { id, reason } of project.legacy.unresolved) {
    plan.warnings.push(`${id} is in state from an older cimiento and cannot be rebuilt: ${reason}. cimiento down exits non zero until you run cimiento down --release ${id}.`)
  }
  if (project.legacy.rebuilt.length > 0) {
    plan.warnings.push(`State from an older cimiento had no specs; rebuilt from stack.yaml: ${project.legacy.rebuilt.join(', ')}. The next up or down saves them.`)
  }

  session.printer.planTable(plan)
  // plan is read only, so it reports rather than fails. A blocked item on a fresh project is the
  // normal shape of a plan, not an error.
  return ExitCode.ok
}
