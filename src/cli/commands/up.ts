// cimiento up. Applies the plan, stops at manual steps, verifies after every ensure, and ends
// with checks and receipts.

import { existsSync, readFileSync, writeFileSync } from 'node:fs'
import { join } from 'node:path'
import { CimientoError, ExitCode } from '../../core/errors'
import { runUp, type Receipt, type UpEvent } from '../../core/executor'
import { topoSort } from '../../core/graph'
import { outdatedTools, upgradeTools } from '../../core/toolkit'
import { machineStatePath, writeMachineState } from '../../core/state'
import { settleSupabasePath } from '../../wiring/supabase-configurations'
import { sessionConfirm, type ProjectSession } from '../context'
import { billableItems, steps, t } from '../i18n'
import { stepTitleFor } from '../../core/person-steps'
import { explainKey } from '../../registry'
import { billableCreates, buildPlan } from '../../core/planner'
import { hashManifest, writeProjectState } from '../../core/state'
import type { Ctx, ResourceSpec } from '../../core/types'
import { readmeWithReceipts } from '../../scaffold'
import { pressEnter } from '../../secrets/prompt'
import { openProject, type Session } from '../context'

export interface UpOutcome {
  exitCode: number
  receipts: Receipt[]
}

export async function upCommand(session: Session, cwd?: string): Promise<number> {
  const outcome = await runUpIn(session, cwd ?? session.cwd)
  return outcome.exitCode
}

export async function runUpIn(session: Session, cwd: string): Promise<UpOutcome> {
  let project = openProject(session, { dryRun: false, cwd })
  let personPhase: { pending: string[] } = { pending: [] }
  if (session.interactive) {
    // Everything that needs the person comes first, so the rest can run without them (BUG-42):
    // one question about tool upgrades (BUG-43), then the logins and account choices, the
    // Supabase organization among them, before the plan, so its billing line names the
    // organization and its plan (BUG-44).
    await offerToolUpgrades(session, project)
    const ahead = await personStepsAhead(project)
    if (ahead.length > 0) {
      session.printer.line(`\n${t(session.lang, 'personStepsAhead', { steps: steps(session.lang, ahead.length) })}`)
      ahead.forEach((label, i) => session.printer.line(`  ${i + 1}. ${label}`))
    }
    personPhase = await runPersonPhase(session, project, (s) => s.kind === 'tool' || s.kind === 'session')
    if (!project.state.resources['supabase.project']) {
      await settleSupabasePath(project.ctx, 'up', { ask: true }).catch((err: unknown) => {
        if (!(err instanceof CimientoError)) throw err
        session.printer.error(err.toJSON())
      })
    }
    // Logins pin accounts and the path choice can change stack.yaml, so read it again.
    project = openProject(session, { dryRun: false, cwd })
  } else if (session.json) {
    const ahead = await personStepsAhead(project)
    session.printer.emit({ event: 'person-steps', steps: ahead })
  }
  const plan = await buildPlan({ ...project.ctx, dryRun: true }, project.providers, project.specs, {
    only: session.only,
    skip: session.skip,
    billingApproved: session.allowBilling,
  })

  const billable = billableCreates(plan)
  if (billable.length > 0 && !session.allowBilling) {
    if (session.yes || !session.interactive) {
      const lines = plan.warnings.filter((w) => billable.some((i) => w.startsWith(`${i.id} `)))
      throw new CimientoError({
        code: 'BILLING_APPROVAL_NEEDED',
        provider: 'core',
        resource: billable.map((i) => i.id).join(', '),
        message: `This plan creates resources that can cost money. ${lines.join(' ')}`,
        hint: 'Approve them with --allow-billing, or run cimiento up in a terminal and answer the question, or set those slots to none in stack.yaml.',
        retryable: false,
        needsHuman: true,
      })
    }
    // planTable already printed one warning per billable item, with who it bills to.
    session.printer.planTable(plan)
    explainBillable(session, project, billable.map((i) => i.id))
    const approved = await confirmWith(session, `\n${t(session.lang, 'approveBillable', { items: billableItems(session.lang, billable.length) })}`)
    if (!approved) return { exitCode: ExitCode.needsHuman, receipts: [] }
  } else if (!session.yes && session.interactive) {
    session.printer.planTable(plan)
    const approved = await confirmWith(session, `\n${t(session.lang, 'applyPlan')}`)
    if (!approved) return { exitCode: ExitCode.needsHuman, receipts: [] }
  }
  // Guided mode explains every billable item before apply, approved by flag or not.
  if (billable.length > 0 && session.allowBilling && session.guided) explainBillable(session, project, billable.map((i) => i.id))

  if (session.interactive) {
    // The remaining person steps, the ones that need a resource first: the Marketplace, GitHub
    // access, the Inngest integration and the secret prompts.
    const second = await runPersonPhase(session, project, (s) => s.kind === 'manual' || isSecretBinding(project, s))
    personPhase = { pending: [...personPhase.pending, ...second.pending] }
    project = openProject(session, { dryRun: false, cwd })
    const after = await buildPlan({ ...project.ctx, dryRun: true }, project.providers, project.specs, {
      only: session.only,
      skip: session.skip,
      billingApproved: true,
    })
    const left = after.items.filter((i) => i.status !== 'noop')
    if (personPhase.pending.length > 0) {
      session.printer.line(`\n${t(session.lang, 'stillWaiting', { ids: personPhase.pending.join(', ') })}`)
    } else {
      session.printer.line(
        `\n${t(session.lang, 'unattended', { steps: steps(session.lang, left.length), minutes: estimateMinutes(left.map((i) => i.id)) })}`,
      )
    }
  }

  const events: UpEvent[] = []
  const pendingHints = new Map<string, string>()
  // Every block of instructions is printed once. The attended Goal 1 run showed the Marketplace
  // instructions twice: once from the event and once more from the logger.
  const shown = new Set<string>()
  const showOnce = (text: string | undefined): void => {
    if (!text || shown.has(text)) return
    shown.add(text)
    session.printer.line(`  ${text}`)
  }
  const result = await runUp(project.ctx, project.providers, project.specs, {
    only: session.only,
    skip: session.skip,
    onManual: manualHandler(session),
    onEvent: (event) => {
      events.push(event)
      if (event.event === 'manual' && event.id) pendingHints.set(event.id, event.error?.hint ?? event.message ?? '')
      if (session.json) session.printer.emit(event)
      else if (event.event === 'manual' && event.step && session.interactive && !session.deps.onManual) {
        // walkStep prints the whole step when it asks, so nothing is printed twice.
      } else if (event.event === 'manual') {
        session.printer.line(`\n${t(session.lang, 'personHasToDo', { id: event.id ?? '' })}`)
        showOnce(event.message)
        if (event.error?.hint && event.error.hint !== event.message) showOnce(event.error.hint)
        showOnce(event.url)
      }
    },
  })

  // A login can pin an account into stack.yaml during the run, so hash the file as it is now.
  const manifestHash = hashManifest(readFileSync(join(cwd, 'stack.yaml'), 'utf8'))
  writeProjectState(cwd, { ...result.state, manifestHash })
  updateReadmeReceipts(cwd, project, result.receipts)

  if (session.json) {
    session.printer.emit({
      ok: result.exitCode === ExitCode.ok,
      command: 'up',
      exitCode: result.exitCode,
      passes: result.passes,
      receipts: result.receipts,
      errors: result.errors,
      pendingManual: result.pendingManual,
      blocked: result.blocked,
    })
  } else {
    session.printer.receipts(result.receipts)
    for (const error of result.errors) session.printer.error(error)
    for (const id of result.pendingManual) {
      session.printer.line(`\n${t(session.lang, 'waitingOn', { id })}`)
      showOnce(pendingHints.get(id))
    }
  }

  return { exitCode: result.exitCode, receipts: result.receipts }
}

function manualHandler(session: Session): (spec: ResourceSpec, ctx: Ctx) => Promise<boolean> {
  if (session.deps.onManual) return session.deps.onManual
  if (!session.interactive) return async () => false
  return async (spec: ResourceSpec, ctx: Ctx): Promise<boolean> => {
    // The whole step, then Enter to open the page, then Enter when done; the executor verifies.
    if (spec.manual?.step && ctx.walkStep) {
      await ctx.walkStep(spec.manual.step)
      return true
    }
    if (spec.manual?.url) await openInBrowser(session, spec.manual.url)
    await session.runLog.recordAsk('enter', async (q: string) => {
      await pressEnter(q)
      return ''
    })('  Press Enter when it is done. ')
    return true
  }
}

/** Opens a page for the person rather than asking them to copy a link. The link is still shown. */
export async function openInBrowser(session: Session, url: string): Promise<void> {
  const opener = process.platform === 'darwin' ? 'open' : process.platform === 'win32' ? 'start' : 'xdg-open'
  await session.io.exec(opener, [url]).catch(() => undefined)
}

function updateReadmeReceipts(
  cwd: string,
  project: { manifest: Parameters<typeof readmeWithReceipts>[1] },
  receipts: Receipt[],
): void {
  const path = join(cwd, 'README.md')
  if (!existsSync(path)) return
  try {
    const existing = readFileSync(path, 'utf8')
    const next = readmeWithReceipts(existing, project.manifest, receipts)
    if (next !== existing) writeFileSync(path, next, 'utf8')
  } catch {
    // A README that cannot be rewritten is not a reason to fail a successful up.
  }
}

/** A yes or no question, through the injected ask when there is one, so tests can answer it. */
async function confirmWith(session: Session, question: string): Promise<boolean> {
  return sessionConfirm(session, question)
}

/** How long the unattended part takes, from what each kind of step usually takes. */
const SECONDS: [RegExp, number][] = [
  [/^vercel\.deployment$/, 180],
  [/^vercel\.binding\.supabase-install$|^supabase\.project$/, 120],
  [/^supabase\.migrations$/, 20],
  [/\.tool\./, 30],
  [/^inngest\.check\.roundtrip$/, 30],
]

export function estimateMinutes(ids: string[]): number {
  const seconds = ids.reduce((sum, id) => sum + (SECONDS.find(([re]) => re.test(id))?.[1] ?? 5), 0)
  return Math.max(1, Math.round(seconds / 60))
}

function isSecretBinding(project: ProjectSession, spec: ResourceSpec): boolean {
  if (!spec.id.startsWith('vercel.env.')) return false
  return project.manifest.secrets.some((s) => spec.id.startsWith(`vercel.env.${s.name}.`))
}

/** Runs the steps a filter picks, with everything they depend on, asking the person as it goes. */
async function runPersonPhase(session: Session, project: ProjectSession, pick: (spec: ResourceSpec) => boolean): Promise<{ pending: string[] }> {
  const byId = new Map(project.specs.map((s) => [s.id, s]))
  const keep = new Set<string>()
  const visit = (id: string): void => {
    if (keep.has(id)) return
    keep.add(id)
    for (const dep of byId.get(id)?.dependsOn ?? []) visit(dep)
  }
  for (const spec of project.specs) if (pick(spec)) visit(spec.id)
  const specs = topoSort(project.specs.filter((s) => keep.has(s.id)))
  if (specs.length === 0) return { pending: [] }
  const result = await runUp(project.ctx, project.providers, specs, {
    only: session.only,
    skip: session.skip,
    onManual: manualHandler(session),
    onEvent: (event) => {
      if (event.event === 'manual' && !(event.step && session.interactive)) {
        session.printer.line(`\n${t(session.lang, 'personHasToDo', { id: event.id ?? '' })}`)
        if (event.error?.hint) session.printer.line(`  ${event.error.hint}`)
      }
    },
  })
  const manifestHash = hashManifest(readFileSync(join(project.ctx.cwd, 'stack.yaml'), 'utf8'))
  writeProjectState(project.ctx.cwd, { ...result.state, manifestHash })
  for (const error of result.errors) session.printer.error(error)
  return { pending: result.pendingManual }
}

/** The person steps a run will ask for, in order, from a plan that changes nothing. */
export async function personStepsAhead(project: ProjectSession): Promise<string[]> {
  const plan = await buildPlan({ ...project.ctx, dryRun: true }, project.providers, project.specs, { billingApproved: true })
  const labels: string[] = []
  for (const item of plan.items) {
    const person =
      item.status === 'needs-human' ||
      (item.kind === 'manual' && item.status !== 'noop') ||
      (item.kind === 'session' && item.status === 'create')
    if (!person) continue
    const lang = project.ctx.lang
    const title = item.error?.personStep?.title ?? stepTitleFor(item.id, project.manifest.slug)
    const label = title ? title[lang] : `${item.id}: ${item.reason}`
    if (!labels.includes(label)) labels.push(label)
  }
  return labels
}

/**
 * One question for every outdated tool, before the plan. A skipped version is remembered in
 * machine state and not offered again; a newer one is. Nothing is asked during apply.
 */
async function offerToolUpgrades(session: Session, project: ProjectSession): Promise<void> {
  const ctx = project.ctx
  if (!ctx.choose) return
  const outdated = (await outdatedTools(ctx, project.providers)).filter((t) => !t.skipped && t.upgrade)
  if (outdated.length === 0) return
  const list = outdated.map((t) => `${t.name} ${t.installed} to ${t.latest} (${t.upgrade!.cmd} ${t.upgrade!.args.join(' ')})`).join(', ')
  const answer = await ctx.choose(t(session.lang, 'upgradeQuestion', { list }), [
    { value: 'upgrade', label: `Upgrade ${outdated.length === 1 ? 'it' : `all ${outdated.length}`} now` },
    { value: 'skip', label: 'Skip these versions; cimiento asks again only when a newer one comes out' },
  ])
  if (answer === 'upgrade') {
    const { failed } = await upgradeTools(ctx, outdated)
    if (failed.length > 0) session.printer.line(`The upgrade of ${failed.join(', ')} did not finish; cimiento continues with the installed version.`)
    return
  }
  const machine = { ...ctx.machine, toolSkips: { ...(ctx.machine.toolSkips ?? {}) } }
  for (const tool of outdated) machine.toolSkips[tool.bin] = tool.latest
  ctx.machine.toolSkips = machine.toolSkips
  try {
    writeMachineState(machine, machineStatePath())
  } catch {
    // A skip that cannot be remembered is asked again next time, which is harmless.
  }
}

/** Guided mode, spec section 10: the explain text of every billable item, before it is created. */
function explainBillable(session: Session, project: ProjectSession, ids: string[]): void {
  if (!session.guided) return
  session.printer.line(`\n${t(session.lang, 'billableIntro')}`)
  for (const id of ids) {
    const text = explainKey(id, session.lang, project.manifest)
    if (text) session.printer.line(`  ${id}: ${text}`)
  }
}
