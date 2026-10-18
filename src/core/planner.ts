// The planner: read the manifest and state, refresh reality through each provider, and emit one
// item per resource with status create, adopt, update, noop, needs-human or blocked.

import { orphanSpecs } from './orphans'
import { asCimientoError, type CimientoErrorFields } from './errors'
import { dependenciesOf, topoSort } from './graph'
import { OutputResolver } from './resolve'
import type { BillingInfo, CheckResult, Ctx, Provider, ResourceSpec } from './types'

export type PlanStatus = 'create' | 'adopt' | 'update' | 'noop' | 'needs-human' | 'blocked' | 'orphan'

export interface PlanItem {
  id: string
  kind: ResourceSpec['kind']
  provider: string
  status: PlanStatus
  dependsOn: string[]
  deferred: string[]
  billable: boolean
  reason: string
  explainKey: string
  externalId?: string
  url?: string
  evidence?: string
  blockedBy?: string[]
  manual?: { instructions: string; url?: string }
  error?: CimientoErrorFields
}

export interface Plan {
  name: string
  slug: string
  manifestHash: string
  stateHash: string
  items: PlanItem[]
  warnings: string[]
  planRequirements: { provider: string; plan: string; reason: string }[]
  summary: Record<PlanStatus, number>
}

/** Statuses that mean a dependent item cannot be probed yet. */
const NOT_YET_REAL: PlanStatus[] = ['create', 'blocked', 'needs-human']

export interface PlanOptions {
  only?: string[]
  skip?: string[]
  /** The run carries --allow-billing, so warnings say approved instead of asking for the flag. */
  billingApproved?: boolean
}

export async function buildPlan(
  ctx: Ctx,
  providers: Provider[],
  specs: ResourceSpec[],
  options: PlanOptions = {},
): Promise<Plan> {
  const byProvider = new Map(providers.map((p) => [p.id, p]))
  const filtered = specs.filter((s) => {
    if (options.only && options.only.length > 0 && !options.only.includes(s.provider)) return false
    if (options.skip && options.skip.includes(s.provider)) return false
    return true
  })
  const ordered = topoSort(filtered, { allowExternal: filtered.length !== specs.length })
  const items = new Map<string, PlanItem>()
  const warnings: string[] = []
  const resolver = new OutputResolver(ctx.state)

  for (const original of ordered) {
    const provider = byProvider.get(original.provider)
    const deps = dependenciesOf(original).filter((d) => items.has(d))
    const blockedBy = deps.filter((d) => NOT_YET_REAL.includes(items.get(d)!.status))
    // Resolve deferred inputs before probing, so verify sees the same spec the executor would.
    const { spec, unresolved } = await resolver.resolveWithHydration(original, ordered, byProvider, ctx)
    const base: PlanItem = {
      id: spec.id,
      kind: spec.kind,
      provider: spec.provider,
      status: 'blocked',
      dependsOn: deps,
      deferred: unresolved,
      billable: spec.billable === true,
      reason: '',
      explainKey: spec.id,
    }
    if (spec.manual) base.manual = spec.manual

    if (!provider) {
      items.set(spec.id, {
        ...base,
        status: 'blocked',
        reason: `No provider module named ${spec.provider} in this build.`,
        blockedBy: [],
      })
      continue
    }

    if (spec.kind === 'manual') {
      // Probed live every time: manualDone is history, and access confirmed once can be revoked
      // (BUG-75). A step already done on this account, for an earlier project or by hand, is not
      // asked for.
      let done = false
      let probeError: CimientoErrorFields | undefined
      if (blockedBy.length === 0 && unresolved.length === 0) {
        const probe: CheckResult = await provider.verify(spec, ctx).catch(() => ({ ok: false }))
        done = probe.ok
        probeError = probe.error?.toJSON()
      }
      items.set(spec.id, {
        ...base,
        ...(probeError ? { error: probeError } : {}),
        status: done ? 'noop' : 'needs-human',
        reason: done ? 'Already done on this account.' : 'A person has to do this once in the browser. cimiento opens the page.',
        ...(blockedBy.length > 0 && !done ? { blockedBy } : {}),
      })
      continue
    }

    if (blockedBy.length > 0) {
      items.set(spec.id, {
        ...base,
        status: 'blocked',
        blockedBy,
        reason: `Waiting on ${blockedBy.join(', ')}.`,
      })
      continue
    }

    if (unresolved.length > 0) {
      items.set(spec.id, {
        ...base,
        status: 'blocked',
        blockedBy: unresolved.map((r) => r.split(':')[0]),
        reason: `Waiting on values that only exist after an earlier step: ${unresolved.join(', ')}.`,
      })
      continue
    }

    const known = ctx.state.resources[spec.id]
    let probe: Awaited<ReturnType<Provider['verify']>>
    try {
      probe = await provider.verify(spec, ctx)
    } catch (err) {
      const error = asCimientoError(err, {
        code: 'CHECK_FAILED',
        provider: spec.provider,
        resource: spec.id,
        hint: `Run cimiento explain ${spec.id} for what this resource is, then cimiento doctor --json for detail.`,
      })
      items.set(spec.id, {
        ...base,
        status: error.needsHuman ? 'needs-human' : 'create',
        reason: error.message,
        error: error.toJSON(),
      })
      continue
    }

    const item: PlanItem = { ...base, status: 'create', reason: '' }
    if (probe.evidence) item.evidence = probe.evidence
    if (known?.externalId) item.externalId = known.externalId
    if (known?.url) item.url = known.url

    if (spec.kind === 'check') {
      item.status = probe.ok ? 'noop' : 'update'
      item.reason = probe.ok ? 'Check passes now.' : 'Check does not pass yet, cimiento up re-runs it after the apply.'
      if (!probe.ok && probe.error) item.error = probe.error.toJSON()
    } else if (spec.kind === 'tool' || spec.kind === 'session') {
      // A tool or a session is not adopted, because cimiento never owns one. It is either good
      // enough already, which is a noop, or it has to be installed or logged in to.
      item.status = probe.ok ? 'noop' : probe.error?.needsHuman ? 'needs-human' : 'create'
      item.reason = probe.ok
        ? spec.kind === 'tool'
          ? 'Installed and new enough.'
          : 'Logged in to the account stack.yaml pins.'
        : (probe.error?.message ?? 'Not ready yet.')
      if (!probe.ok && probe.error) item.error = probe.error.toJSON()
    } else if (probe.ok && known) {
      item.status = 'noop'
      item.reason = 'Already exists and matches state.'
    } else if (probe.ok && !known) {
      item.status = 'adopt'
      item.reason = 'Exists in the account under this name, cimiento adopts it instead of creating a second one.'
    } else if (!probe.ok && known) {
      item.status = 'update'
      item.reason = probe.error?.message ?? 'Recorded in state but reality does not match, cimiento updates it.'
      if (probe.error) item.error = probe.error.toJSON()
    } else {
      item.status = 'create'
      item.reason = 'Does not exist yet.'
      if (probe.error?.needsHuman) {
        item.status = 'needs-human'
        item.reason = probe.error.message
        item.error = probe.error.toJSON()
      }
    }

    items.set(spec.id, item)
  }

  // One warning per billable item, wherever it lands, including items still blocked behind a
  // step that has to run first. It names who the item bills to and on which plan, because
  // "this can cost money" means nothing until you know whose money.
  for (const item of items.values()) {
    if (!item.billable || item.status === 'noop') continue
    const spec = ordered.find((s) => s.id === item.id)!
    const provider = byProvider.get(item.provider)
    const bill = provider?.billing ? await provider.billing(resolver.resolve(spec).spec, ctx).catch(() => undefined) : undefined
    warnings.push(billingWarning(item.id, bill, options.billingApproved === true))
  }

  const planRequirements = providers
    .filter((p) => p.planRequirements && ordered.some((s) => s.provider === p.id))
    .map((p) => ({ provider: p.id, plan: p.planRequirements!.plan, reason: p.planRequirements!.reason }))
  for (const req of planRequirements) {
    warnings.push(`${req.provider} needs the ${req.plan} plan: ${req.reason}`)
  }

  const list = ordered.map((s) => items.get(s.id)!).filter(Boolean)
  // Resources state still has and stack.yaml no longer selects (BUG-74). Reported, never probed:
  // plan stays passive.
  for (const orphan of orphanSpecs(ctx.state, specs).filter((o) => o.kind === 'resource')) {
    const entry = ctx.state.resources[orphan.id]
    list.push({
      id: orphan.id,
      kind: orphan.kind,
      provider: orphan.provider,
      status: 'orphan',
      dependsOn: orphan.dependsOn,
      deferred: [],
      billable: false,
      reason: entry?.retained
        ? 'No longer in stack.yaml, kept on purpose. cimiento down still deletes it.'
        : 'No longer in stack.yaml. cimiento up asks whether to retain, release or destroy it (--orphans); cimiento down deletes it.',
      explainKey: 'ORPHANS_DECISION_NEEDED',
      ...(entry?.externalId ? { externalId: entry.externalId } : {}),
      ...(entry?.url ? { url: entry.url } : {}),
    })
  }
  return {
    name: ctx.manifest.name,
    slug: ctx.manifest.slug,
    manifestHash: ctx.state.manifestHash,
    stateHash: ctx.state.manifestHash,
    items: list,
    warnings,
    planRequirements,
    summary: summarize(list),
  }
}

export function summarize(items: PlanItem[]): Record<PlanStatus, number> {
  const summary: Record<PlanStatus, number> = {
    create: 0,
    adopt: 0,
    update: 0,
    noop: 0,
    'needs-human': 0,
    blocked: 0,
    orphan: 0,
  }
  for (const item of items) summary[item.status] += 1
  return summary
}

export function planIsClean(plan: Plan): boolean {
  return plan.items.every((i) => i.status === 'noop')
}

/**
 * Billable items this plan would bring into existence. A blocked item counts: it is blocked only
 * because something before it has to be created first, and up will reach it in a later pass.
 */
export function billableCreates(plan: Plan): PlanItem[] {
  return plan.items.filter((i) => i.billable && i.status !== 'noop')
}

export function billingWarning(id: string, bill: BillingInfo | undefined, approved = false): string {
  // Asking for a flag the run already carries reads as if the approval had not registered.
  const ask = approved ? 'Approved for this run with --allow-billing.' : 'Approve it with --allow-billing.'
  if (!bill) return `${id} can cost money. ${ask}`
  const plan = bill.plan === 'unknown' ? 'plan unknown' : `${bill.plan} plan`
  const cost = bill.paid
    ? 'a paid plan, so this is charged to it'
    : bill.plan === 'unknown'
      ? 'check its plan before approving'
      : 'no charge unless you go over the plan limits'
  return `${id} bills to ${bill.account}, ${plan}: ${cost}. ${ask}`
}
