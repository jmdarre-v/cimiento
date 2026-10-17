// cimiento down, spec section 9. Destroys everything in state across providers, in reverse
// dependency order, after the project name is typed back. Every destroy is then verified: a
// resource that still answers after its delete is reported, never assumed gone.

import { readFileSync } from 'node:fs'
import { join } from 'node:path'
import { asCimientoError, CimientoError, ExitCode, needsPerson, type CimientoErrorFields } from '../../core/errors'
import { topoSort } from '../../core/graph'
import { OutputResolver } from '../../core/resolve'
import { hashManifest, writeProjectState, type ProjectState } from '../../core/state'
import type { Leftover, ResourceSpec } from '../../core/types'
import { ask } from '../../secrets/prompt'
import { createdOrganizationLeftovers, type OrganizationLeftover } from '../../providers/supabase'
import { openProject, type Session } from '../context'

export interface DownEvent {
  event: 'start' | 'destroyed' | 'skipped' | 'pending' | 'failed'
  id: string
  provider: string
  message?: string
  error?: CimientoErrorFields
}

export async function downCommand(session: Session): Promise<number> {
  const project = openProject(session, { dryRun: false })
  const { ctx, manifest } = project

  // Only resources are destroyed. Bindings and checks live inside a resource and go with it;
  // tools and sessions belong to the machine, not to the project.
  const targets = topoSort(project.specs)
    .filter((s) => s.kind === 'resource' && ctx.state.resources[s.id])
    .reverse()
  const toDelete = targets.filter((t) => ctx.state.resources[t.id]?.origin !== 'adopted')

  if (targets.length === 0) {
    // Nothing left to delete, but an organization cimiento created may still be waiting for the
    // person to remove it, and down keeps saying so until it is gone.
    const leftovers = project.providers.some((p) => p.id === 'supabase')
      ? await createdOrganizationLeftovers(ctx).catch(() => [])
      : []
    const next = recordLeftovers(ctx.state, leftovers)
    writeProjectState(ctx.cwd, { ...next, manifestHash: hashManifest(readFileSync(join(ctx.cwd, 'stack.yaml'), 'utf8')) })
    const payload = {
      ok: true,
      command: 'down',
      destroyed: [],
      released: [],
      leftovers: leftovers.map(leftoverJson),
      pending: [],
      errors: [],
      message: 'Nothing in state to destroy.',
    }
    if (session.json) session.printer.emit(payload)
    else {
      session.printer.line('Nothing in state to destroy.')
      for (const left of leftovers) session.printer.line(leftoverLine(left))
    }
    return ExitCode.ok
  }

  if (!session.yes) {
    const list = toDelete.map((t) => t.id).join(', ') || 'nothing; every resource in state was adopted and is only released'
    if (!session.interactive) {
      throw new CimientoError({
        code: 'DOWN_CONFIRMATION_NEEDED',
        provider: 'core',
        resource: 'down',
        message: `cimiento down would delete ${list}, and nobody is at a terminal to type the project name.`,
        hint: `Run cimiento down in a terminal in ${session.cwd} and type ${manifest.slug} when it asks, or pass --yes when the deletion is already decided.`,
        retryable: true,
        needsHuman: true,
      })
    }
    session.printer.line(`\nThis deletes, for good: ${list}`)
    const typed = await session.runLog.recordAsk('ask', session.deps.ask ?? ask)(`Type the project name, ${manifest.slug}, to continue: `)
    if (typed.trim() !== manifest.slug) {
      session.printer.line('The name did not match. Nothing was deleted.')
      return ExitCode.needsHuman
    }
  }

  const byProvider = new Map(project.providers.map((p) => [p.id, p]))
  const resolver = new OutputResolver(ctx.state)
  let state: ProjectState = ctx.state
  const destroyed: string[] = []
  const attempted: ResourceSpec[] = []
  const released: string[] = []
  const pending: string[] = []
  const errors: CimientoErrorFields[] = []
  const emit = (event: DownEvent): void => {
    if (session.json) session.printer.emit(event)
    else if (event.event === 'destroyed') session.printer.line(`deleted  ${event.id}`)
    else if (event.event === 'pending' || event.event === 'failed') {
      session.printer.line(`${event.event === 'pending' ? 'waiting' : 'failed '}  ${event.id}  ${event.message ?? ''}`)
    }
  }

  for (const original of targets) {
    const provider = byProvider.get(original.provider)
    if (!provider) {
      emit({ event: 'skipped', id: original.id, provider: original.provider, message: 'No provider module in this build.' })
      continue
    }
    // Only what cimiento created is deleted. An adopted resource existed before this project and
    // may carry another application's data; it is released from state and left where it is.
    if (ctx.state.resources[original.id]?.origin === 'adopted') {
      released.push(original.id)
      state = forget(state, original.id, project.specs)
      emit({
        event: 'skipped',
        id: original.id,
        provider: original.provider,
        message: 'Adopted, not created by cimiento, so it is kept. cimiento no longer tracks it.',
      })
      continue
    }
    // Something this resource depends on refusing to go first is fine; something that depends on
    // it still existing is not, so a failure upstream in the reverse order stops the dependents.
    const blockedBy = targets
      .filter((t) => t.dependsOn.includes(original.id) || dependsOnDeferred(t, original.id))
      .filter((t) => !attempted.some((a) => a.id === t.id) && !released.includes(t.id))
      .map((t) => t.id)
    if (blockedBy.length > 0) {
      emit({
        event: 'skipped',
        id: original.id,
        provider: original.provider,
        message: `Kept, because ${blockedBy.join(', ')} still exists and depends on it.`,
      })
      continue
    }

    const runCtx = { ...ctx, state }
    resolver.useState(state)
    const { spec } = await resolver.resolveWithHydration(original, project.specs, byProvider, runCtx)
    emit({ event: 'start', id: spec.id, provider: spec.provider })
    try {
      await provider.destroy(spec, runCtx)
    } catch (err) {
      const error = asCimientoError(err, {
        code: 'CHECK_FAILED',
        provider: spec.provider,
        resource: spec.id,
        hint: 'cimiento down retries safely. The message above says what the provider refused.',
      })
      if (needsPerson(error)) {
        pending.push(spec.id)
        emit({ event: 'pending', id: spec.id, provider: spec.provider, message: error.hint, error: error.toJSON() })
      } else {
        errors.push(error.toJSON())
        emit({ event: 'failed', id: spec.id, provider: spec.provider, message: error.message, error: error.toJSON() })
      }
      continue
    }

    attempted.push(spec)
  }

  // Prove it is gone, once everything has been asked to go. A deployment only disappears with its
  // project, so checking each delete on its own would report it as surviving.
  for (const spec of attempted) {
    const provider = byProvider.get(spec.provider)!
    const still = await provider.verify(spec, { ...ctx, state }).catch(() => ({ ok: false }))
    if (still.ok) {
      const error = new CimientoError({
        code: 'CHECK_FAILED',
        provider: spec.provider,
        resource: spec.id,
        message: `${spec.id} was deleted but still answers.`,
        hint: 'Some providers delete in the background. Run cimiento down again in a minute; it only touches what is still there.',
        retryable: true,
        needsHuman: false,
      })
      errors.push(error.toJSON())
      emit({ event: 'failed', id: spec.id, provider: spec.provider, message: error.message, error: error.toJSON() })
      continue
    }
    destroyed.push(spec.id)
    state = forget(state, spec.id, project.specs)
    emit({ event: 'destroyed', id: spec.id, provider: spec.provider })
  }

  // A Supabase organization cimiento created cannot be deleted through the API (see
  // SUPABASE_CAN_DELETE_ORGANIZATIONS). It is listed as a leftover with its dashboard link, and
  // stays recorded until it is gone. A project creates at most one, so one record is kept.
  const leftovers: OrganizationLeftover[] = []
  // Reported even when another step is still pending: the person should hear about everything
  // they will have to remove by hand in the same run. The Goal 1 cleanup stayed silent about an
  // organization because the repository was waiting on a permission.
  if (byProvider.has('supabase')) {
    leftovers.push(...(await createdOrganizationLeftovers({ ...ctx, state: ctx.state }).catch(() => [])))
    state = recordLeftovers(state, leftovers)
  }
  // Every other provider reports what its API cannot delete, such as an app registered in Inngest.
  const others: Leftover[] = []
  for (const provider of project.providers) {
    if (!provider.leftovers) continue
    others.push(...(await provider.leftovers({ ...ctx, state: ctx.state }, state).catch(() => [])))
  }

  state = dropOrphanChecks(state, project.specs)

  const manifestHash = hashManifest(readFileSync(join(ctx.cwd, 'stack.yaml'), 'utf8'))
  writeProjectState(ctx.cwd, { ...state, manifestHash })

  const exitCode = errors.length > 0 ? ExitCode.failed : pending.length > 0 ? ExitCode.needsHuman : ExitCode.ok
  if (session.json) {
    session.printer.emit({
      ok: exitCode === ExitCode.ok,
      command: 'down',
      exitCode,
      destroyed,
      released,
      leftovers: [...leftovers.map(leftoverJson), ...others.map((left) => ({ ...left, code: 'DOWN_LEFTOVER' }))],
      pending,
      errors,
    })
  } else {
    session.printer.line(
      `\n${destroyed.length} deleted, ${released.length} kept because cimiento adopted them, ${pending.length} waiting on you, ${errors.length} failed.`,
    )
    for (const error of errors) session.printer.error(error)
    for (const left of leftovers) session.printer.line(leftoverLine(left))
    for (const left of others) session.printer.line(`Left over: the ${left.what} ${left.name}, which cimiento set up. ${left.hint}`)
  }
  return exitCode
}

function dependsOnDeferred(spec: ResourceSpec, id: string): boolean {
  return Object.values(spec.inputs).some((v) => typeof v === 'object' && v !== null && v.deferred.startsWith(`${id}:`))
}

/**
 * Drops a destroyed resource from state, together with the bindings, checks and manual steps that
 * only existed because of it. Tool and session entries stay: they describe the machine.
 */
function forget(state: ProjectState, id: string, specs: ResourceSpec[]): ProjectState {
  const gone = new Set([id])
  for (let changed = true; changed; ) {
    changed = false
    for (const spec of specs) {
      if (gone.has(spec.id)) continue
      if (spec.kind === 'tool' || spec.kind === 'session' || spec.kind === 'resource') continue
      if ([...gone].some((g) => spec.dependsOn.includes(g) || dependsOnDeferred(spec, g))) {
        gone.add(spec.id)
        changed = true
      }
    }
  }
  const resources = { ...state.resources }
  for (const key of gone) delete resources[key]
  return { ...state, resources, manualDone: state.manualDone.filter((m) => !gone.has(m)) }
}

/**
 * Once no resource is left, a check or binding that hangs on none, such as the Anthropic key
 * check, has nothing left to describe and goes too. Tools, sessions and manual steps stay.
 */
function dropOrphanChecks(state: ProjectState, specs: ResourceSpec[]): ProjectState {
  const kinds = new Map(specs.map((s) => [s.id, s.kind]))
  const anyResource = Object.keys(state.resources).some((id) => kinds.get(id) === 'resource')
  if (anyResource) return state
  const resources = { ...state.resources }
  for (const id of Object.keys(resources)) {
    const kind = kinds.get(id)
    if (kind === 'check' || kind === 'binding') delete resources[id]
  }
  return { ...state, resources }
}

/** Keeps a still existing organization on the Supabase session entry, and drops a deleted one. */
function recordLeftovers(state: ProjectState, leftovers: OrganizationLeftover[]): ProjectState {
  const resources = { ...state.resources }
  for (const [id, entry] of Object.entries(resources)) {
    if (!entry.outputs?.createdOrganizationId) continue
    const outputs = { ...entry.outputs }
    delete outputs.createdOrganizationId
    delete outputs.createdOrganizationName
    resources[id] = { ...entry, outputs }
  }
  const first = leftovers[0]
  if (first) {
    const session = resources['supabase.session'] ?? {}
    resources['supabase.session'] = {
      ...session,
      outputs: { ...(session.outputs ?? {}), createdOrganizationId: first.id, createdOrganizationName: first.name },
    }
  }
  return { ...state, resources }
}

function leftoverJson(left: OrganizationLeftover): Record<string, string> {
  return {
    provider: 'supabase',
    what: 'Supabase organization',
    ...left,
    code: 'DOWN_LEFTOVER',
    hint: `The Supabase API cannot delete organizations. Delete ${left.name} at ${left.url} when you no longer need it.`,
  }
}

function leftoverLine(left: OrganizationLeftover): string {
  return `Left over: the Supabase organization ${left.name} (${left.id}), which cimiento created. The Supabase API cannot delete organizations; delete it at ${left.url}.`
}
