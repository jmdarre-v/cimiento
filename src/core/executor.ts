// The executor: apply a plan in dependency order, in as many passes as deferred values need,
// stopping at manual steps and verifying after every ensure.

import type { PersonStep } from './person'
import { asCimientoError, CimientoError, ExitCode, needsPerson, type CimientoErrorFields } from './errors'
import { dependenciesOf, deferredRefs, topoSort } from './graph'
import { OutputResolver } from './resolve'
import { applyEnsureToState, markVerified, type ProjectState } from './state'
import type { Ctx, EnsureResult, Provider, ResourceSpec } from './types'

export interface Receipt {
  id: string
  kind: ResourceSpec['kind']
  provider: string
  action: EnsureResult['action'] | 'verified' | 'confirmed'
  url?: string
  externalId?: string
  evidence?: string
}

export interface UpEvent {
  event: 'pass' | 'start' | 'ensured' | 'verified' | 'manual' | 'skipped' | 'failed' | 'done'
  pass?: number
  id?: string
  provider?: string
  action?: string
  message?: string
  url?: string
  error?: CimientoErrorFields
  /** The structured person step, when the event is one. */
  step?: PersonStep
}

export interface UpOptions {
  /** Called when a manual step is reached. Return true once the person says they did it. */
  onManual?: (spec: ResourceSpec, ctx: Ctx) => Promise<boolean>
  onEvent?: (event: UpEvent) => void
  only?: string[]
  skip?: string[]
  maxPasses?: number
}

export interface UpResult {
  state: ProjectState
  receipts: Receipt[]
  errors: CimientoErrorFields[]
  pendingManual: string[]
  blocked: string[]
  passes: number
  exitCode: number
}

export async function runUp(
  ctx: Ctx,
  providers: Provider[],
  allSpecs: ResourceSpec[],
  options: UpOptions = {},
): Promise<UpResult> {
  const byProvider = new Map(providers.map((p) => [p.id, p]))
  const kept = filterSpecs(allSpecs, options)
  const specs = topoSort(kept, { allowExternal: kept.length !== allSpecs.length })
  const emit = (event: UpEvent): void => {
    options.onEvent?.(event)
    ctx.logger.log({
      level: event.error ? 'error' : 'info',
      event: event.event,
      resource: event.id,
      provider: event.provider,
      // The command shows a manual step's instructions itself. Logging them as well printed them
      // twice in the Goal 1 attended run.
      ...(event.event === 'manual' ? {} : { message: event.message }),
    })
  }

  let state = ctx.state
  const resolver = new OutputResolver(state)
  const receipts: Receipt[] = []
  const errors: CimientoErrorFields[] = []
  const completed = new Set<string>()
  const failed = new Set<string>()
  const pendingManual = new Set<string>()
  const maxPasses = options.maxPasses ?? Math.max(3, specs.length + 2)
  let pass = 0

  for (; pass < maxPasses; pass += 1) {
    let progressed = false
    emit({ event: 'pass', pass: pass + 1 })

    for (const original of specs) {
      if (completed.has(original.id) || failed.has(original.id)) continue
      // Already waiting on a person this run. Asking again in the next pass would repeat a
      // question, or reopen a login, that the person has already been given.
      if (pendingManual.has(original.id)) continue

      const deps = dependenciesOf(original).filter((d) => specs.some((s) => s.id === d))
      const failedDeps = deps.filter((d) => failed.has(d))
      if (failedDeps.length > 0) {
        failed.add(original.id)
        emit({
          event: 'skipped',
          id: original.id,
          provider: original.provider,
          message: `Skipped, an earlier step failed: ${failedDeps.join(', ')}`,
        })
        continue
      }
      if (deps.some((d) => !completed.has(d))) continue

      resolver.useState(state)
      const runCtx = { ...ctx, state }
      const { spec, unresolved } = await resolver.resolveWithHydration(original, specs, byProvider, runCtx)
      if (unresolved.length > 0) continue

      const provider = byProvider.get(spec.provider)
      if (!provider) {
        const error = unknownProviderError(spec)
        failed.add(spec.id)
        errors.push(error.toJSON())
        emit({ event: 'failed', id: spec.id, provider: spec.provider, error: error.toJSON() })
        continue
      }

      if (spec.kind === 'manual') {
        let instructions: string | undefined
        let url: string | undefined
        let step: PersonStep | undefined
        // A step already recorded in manualDone is not asked again, and never reaches ensure.
        if (state.manualDone.includes(spec.id)) {
          const done = await safeVerify(provider, spec, runCtx)
          if (done.ok) {
            state = markVerified(state, spec.id)
            completed.add(spec.id)
            progressed = true
            emit({ event: 'verified', id: spec.id, provider: spec.provider, message: done.evidence })
            continue
          }
          // Reality no longer matches what was confirmed, so ask again below.
          state = { ...state, manualDone: state.manualDone.filter((id) => id !== spec.id) }
        } else {
          // Someone may already have done it, on another project or by hand. Never ask a person
          // for something that already verifies.
          const already = await safeVerify(provider, spec, runCtx)
          if (!already.ok && already.error?.hint) instructions = already.error.hint
          // The step's verify knows which page the person needs first, when there are several.
          if (!already.ok && already.error?.docsUrl) url = already.error.docsUrl
          if (!already.ok && already.error?.personStep) step = already.error.personStep
          if (already.ok) {
            state = markVerified(applyEnsureToState(state, spec, { action: 'updated' }), spec.id)
            completed.add(spec.id)
            progressed = true
            emit({ event: 'verified', id: spec.id, provider: spec.provider, message: already.evidence })
            receipts.push({
              id: spec.id,
              kind: spec.kind,
              provider: spec.provider,
              action: 'verified',
              ...(already.evidence ? { evidence: already.evidence } : {}),
            })
            continue
          }
        }
        emit({
          event: 'manual',
          id: spec.id,
          provider: spec.provider,
          message: instructions ?? spec.manual?.instructions ?? provider.explain(spec.id, ctx.lang),
          url: url ?? spec.manual?.url,
          ...(step ? { step } : {}),
        })
        const asked: ResourceSpec = {
          ...spec,
          manual: {
            instructions: instructions ?? spec.manual?.instructions ?? '',
            ...((url ?? spec.manual?.url) ? { url: url ?? spec.manual?.url } : {}),
            ...(step ? { step } : {}),
          },
        }
        let confirmed = options.onManual ? await options.onManual(asked, runCtx) : false
        if (!confirmed) {
          pendingManual.add(spec.id)
          continue
        }
        const afterManual = applyEnsureToState(state, spec, { action: 'updated' })
        let check = await safeVerify(provider, spec, { ...ctx, state: afterManual })
        // A step can need two pages, one after the other, such as GitHub connected to Vercel and
        // then the repository shared with it. Each page is its own person step, asked in turn in
        // the same run (BUG-52).
        let lastStep = asked.manual?.step?.id
        for (let round = 0; round < 3 && confirmed && !check.ok && check.error?.personStep && check.error.personStep.id !== lastStep; round += 1) {
          const next = check.error.personStep
          lastStep = next.id
          emit({ event: 'manual', id: spec.id, provider: spec.provider, message: check.error.hint, url: next.url, step: next })
          confirmed = options.onManual
            ? await options.onManual({ ...spec, manual: { instructions: check.error.hint, url: next.url, step: next } }, runCtx)
            : false
          if (confirmed) check = await safeVerify(provider, spec, { ...ctx, state: afterManual })
        }
        if (!check.ok && check.error && needsPerson(check.error)) {
          // The person pressed Enter but the step still does not verify. Waiting on them is the
          // honest status, not a failure.
          pendingManual.add(spec.id)
          emit({ event: 'manual', id: spec.id, provider: spec.provider, message: check.error.message, error: check.error.toJSON() })
          continue
        }
        if (!check.ok) {
          const error =
            check.error ??
            new CimientoError({
              code: 'MANUAL_STEP_PENDING',
              provider: spec.provider,
              resource: spec.id,
              message: `${spec.id} still does not look done.`,
              hint: spec.manual?.instructions ?? 'Finish the step in the browser, then run cimiento up again.',
              retryable: true,
              needsHuman: true,
            })
          failed.add(spec.id)
          errors.push(error.toJSON())
          emit({ event: 'failed', id: spec.id, provider: spec.provider, error: error.toJSON() })
          continue
        }
        state = markVerified(afterManual, spec.id)
        completed.add(spec.id)
        progressed = true
        receipts.push({
          id: spec.id,
          kind: spec.kind,
          provider: spec.provider,
          action: 'confirmed',
          ...(check.evidence ? { evidence: check.evidence } : {}),
          ...(spec.manual?.url ? { url: spec.manual.url } : {}),
        })
        continue
      }

      emit({ event: 'start', id: spec.id, provider: spec.provider })
      let result: EnsureResult
      try {
        result = await provider.ensure(spec, runCtx)
      } catch (err) {
        const error = asCimientoError(err, {
          code: 'CHECK_FAILED',
          provider: spec.provider,
          resource: spec.id,
          hint: `Run cimiento explain ${spec.id} to see what this step does, then cimiento doctor --json.`,
        })
        if (needsPerson(error)) {
          // A login, an account choice or a browser step. Everything after it waits, and the run
          // ends with exit code 2 and this step in pendingManual.
          pendingManual.add(spec.id)
          emit({ event: 'manual', id: spec.id, provider: spec.provider, message: error.message, error: error.toJSON() })
          continue
        }
        failed.add(spec.id)
        errors.push(error.toJSON())
        emit({ event: 'failed', id: spec.id, provider: spec.provider, error: error.toJSON() })
        continue
      }

      state = applyEnsureToState(state, spec, result)
      resolver.useState(state)
      resolver.record(spec.id, result.outputs, ctx)

      emit({
        event: 'ensured',
        id: spec.id,
        provider: spec.provider,
        action: result.action,
        url: result.url,
      })

      const check = await safeVerify(provider, spec, { ...ctx, state })
      if (!check.ok) {
        const error =
          check.error ??
          new CimientoError({
            code: 'CHECK_FAILED',
            provider: spec.provider,
            resource: spec.id,
            message: `${spec.id} was applied but did not verify.`,
            hint: `Run cimiento doctor --json, then cimiento explain ${spec.id}.`,
            retryable: true,
            needsHuman: false,
          })
        failed.add(spec.id)
        errors.push(error.toJSON())
        emit({ event: 'failed', id: spec.id, provider: spec.provider, error: error.toJSON() })
        continue
      }

      state = markVerified(state, spec.id)
      completed.add(spec.id)
      pendingManual.delete(spec.id)
      progressed = true
      emit({ event: 'verified', id: spec.id, provider: spec.provider, message: check.evidence })
      receipts.push({
        id: spec.id,
        kind: spec.kind,
        provider: spec.provider,
        action: result.action,
        ...(result.url ? { url: result.url } : {}),
        ...(result.externalId ? { externalId: result.externalId } : {}),
        ...(check.evidence ? { evidence: check.evidence } : {}),
      })
    }

    if (!progressed) break
  }

  const blocked = specs
    .map((s) => s.id)
    .filter((id) => !completed.has(id) && !failed.has(id) && !pendingManual.has(id))

  let exitCode: number = ExitCode.ok
  if (errors.length > 0) exitCode = ExitCode.failed
  else if (pendingManual.size > 0) exitCode = ExitCode.needsHuman
  else if (blocked.length > 0) exitCode = ExitCode.blocked

  emit({ event: 'done', pass: pass + 1, message: `${receipts.length} receipts, ${errors.length} errors` })

  return {
    state,
    receipts,
    errors,
    pendingManual: [...pendingManual],
    blocked,
    passes: pass + 1,
    exitCode,
  }
}

export interface VerifyReport {
  id: string
  provider: string
  kind: ResourceSpec['kind']
  ok: boolean
  evidence?: string
  error?: CimientoErrorFields
}

/** Re-verify everything without changing anything. Used by doctor. */
export async function runVerifyAll(
  ctx: Ctx,
  providers: Provider[],
  allSpecs: ResourceSpec[],
  options: { only?: string[]; skip?: string[] } = {},
): Promise<VerifyReport[]> {
  const byProvider = new Map(providers.map((p) => [p.id, p]))
  const kept = filterSpecs(allSpecs, options)
  const specs = topoSort(kept, { allowExternal: kept.length !== allSpecs.length })
  const resolver = new OutputResolver(ctx.state)
  const results: VerifyReport[] = []

  for (const original of specs) {
    const provider = byProvider.get(original.provider)
    if (!provider) {
      results.push({
        id: original.id,
        provider: original.provider,
        kind: original.kind,
        ok: false,
        error: unknownProviderError(original).toJSON(),
      })
      continue
    }
    if (original.kind === 'manual') {
      // Verified live, like plan does. Trusting manualDone alone made doctor fail a Marketplace
      // step that plan reported as done, in the Goal 1 run.
      const live = await safeVerify(provider, original, ctx)
      if (live.ok) {
        results.push({ id: original.id, provider: original.provider, kind: original.kind, ok: true, ...(live.evidence ? { evidence: live.evidence } : {}) })
        continue
      }
      const done = ctx.state.manualDone.includes(original.id)
      results.push({
        id: original.id,
        provider: original.provider,
        kind: original.kind,
        ok: done,
        ...(done
          ? { evidence: 'confirmed earlier, recorded in manualDone' }
          : {
              error: {
                code: 'MANUAL_STEP_PENDING',
                provider: original.provider,
                resource: original.id,
                message: `${original.id} has not been confirmed yet.`,
                hint: original.manual?.instructions ?? 'Run cimiento up and follow the step in the browser.',
                retryable: true,
                needsHuman: true,
              },
            }),
      })
      continue
    }
    const { spec, unresolved } = await resolver.resolveWithHydration(original, specs, byProvider, ctx)
    if (unresolved.length > 0) {
      results.push({
        id: spec.id,
        provider: spec.provider,
        kind: spec.kind,
        ok: false,
        error: {
          code: 'DEFERRED_UNRESOLVED',
          provider: spec.provider,
          resource: spec.id,
          message: `${spec.id} needs values that do not exist yet: ${unresolved.join(', ')}`,
          hint: 'Run cimiento up so the earlier steps produce those values, then run doctor again.',
          retryable: true,
          needsHuman: false,
        },
      })
      continue
    }
    const check = await safeVerify(provider, spec, ctx)
    results.push({
      id: spec.id,
      provider: spec.provider,
      kind: spec.kind,
      ok: check.ok,
      ...(check.evidence ? { evidence: check.evidence } : {}),
      ...(check.error ? { error: check.error.toJSON() } : {}),
    })
  }
  return results
}

function filterSpecs(specs: ResourceSpec[], options: { only?: string[]; skip?: string[] }): ResourceSpec[] {
  return specs.filter((s) => {
    if (options.only && options.only.length > 0 && !options.only.includes(s.provider)) return false
    if (options.skip && options.skip.includes(s.provider)) return false
    return true
  })
}

async function safeVerify(
  provider: Provider,
  spec: ResourceSpec,
  ctx: Ctx,
): Promise<{ ok: boolean; error?: CimientoError; evidence?: string }> {
  try {
    return await provider.verify(spec, ctx)
  } catch (err) {
    return {
      ok: false,
      error: asCimientoError(err, {
        code: 'CHECK_FAILED',
        provider: spec.provider,
        resource: spec.id,
        hint: `Run cimiento explain ${spec.id} for what this step proves.`,
      }),
    }
  }
}

function unknownProviderError(spec: ResourceSpec): CimientoError {
  return new CimientoError({
    code: 'MANIFEST_UNKNOWN_PROVIDER',
    provider: spec.provider,
    resource: spec.id,
    message: `No provider module named ${spec.provider} in this build.`,
    hint: 'Set that slot to none in stack.yaml, or upgrade cimiento to a build that ships the provider.',
    retryable: false,
    needsHuman: true,
  })
}

export function deferredSummary(specs: ResourceSpec[]): string[] {
  const refs = new Set<string>()
  for (const spec of specs) for (const ref of deferredRefs(spec)) refs.add(ref)
  return [...refs].sort()
}
