// cimiento secret set, rotate, remove and check.
//
// set reads the value from the declared source, pushes it to every declared sink and keeps no
// copy. rotate reads a fresh value and writes it over every sink. remove takes a secret out of
// stack.yaml and out of every place cimiento put it. check proves every declared secret exists in
// every sink without printing a value.

import { existsSync, readFileSync, writeFileSync } from 'node:fs'
import { join } from 'node:path'
import { isMap, isSeq, parseDocument } from 'yaml'
import { asCimientoError, CimientoError, ExitCode, type CimientoErrorFields } from '../../core/errors'
import { runUp, runVerifyAll } from '../../core/executor'
import { OutputResolver } from '../../core/resolve'
import { applyEnsureToState, hashManifest, writeProjectState, type ProjectState } from '../../core/state'
import { manifestPath } from '../../manifest'
import { parseManifest } from '../../manifest/schema'
import { removeHostingEnv } from '../../providers/hosting'
import { removeCiSecret, removeDatabaseSecret } from '../../secrets/sinks'
import { allSinkSpecs, assertSinkAvailable, sinkSpecsFor } from '../../secrets'
import { HOSTING_NAMES, hostingOf } from '../../core/hosting'
import { dropFromStoredSpecs } from '../../core/orphans'
import type { Ctx, ResourceSpec } from '../../core/types'
import { openProject, type ProjectSession, type Session } from '../context'

export async function secretSetCommand(session: Session): Promise<number> {
  const name = session.args.positionals[0]
  if (!name) {
    throw new CimientoError({
      code: 'SECRET_MISSING',
      provider: 'secrets',
      resource: 'secret set',
      message: 'cimiento secret set needs the name of the secret.',
      hint: 'Run cimiento secret set ANTHROPIC_API_KEY. The value is typed at a hidden prompt, never on the command line.',
      retryable: false,
      needsHuman: true,
    })
  }
  const project = openProject(session, { dryRun: false })
  const declaration = project.secrets.declaration(name)
  if (!declaration) {
    throw new CimientoError({
      code: 'SECRET_NOT_DECLARED',
      provider: 'secrets',
      resource: `secret.${name}`,
      message: `stack.yaml does not declare a secret named ${name}.`,
      hint: `Add it to the secrets section of stack.yaml with the sinks it belongs in, then run cimiento secret set ${name} again.`,
      retryable: false,
      needsHuman: true,
    })
  }
  for (const sink of declaration.sinks) assertSinkAvailable(sink, name)

  if (!project.secrets.has(name)) await project.secrets.prompt(name)

  const specs = sinkSpecsFor(name, project.specs)
  if (specs.length === 0) {
    throw new CimientoError({
      code: 'SECRET_SINK_UNAVAILABLE',
      provider: 'secrets',
      resource: `secret.${name}`,
      message: `Nothing in the plan carries ${name} to a sink yet.`,
      hint: 'Run cimiento up first so the hosting project exists, then run cimiento secret set again.',
      retryable: true,
      needsHuman: false,
    })
  }

  // The sink resources depend on the hosting project, so the whole graph is passed in and the
  // executor only touches what these specs need.
  const needed = withDependencies(specs, project.specs)
  const result = await runUp(project.ctx, project.providers, needed, { onManual: async () => false })
  let state = result.state
  const errors = [...result.errors]
  let redeployed: string | undefined
  if (result.exitCode === ExitCode.ok) {
    const outcome = await redeployAfterEnvChange(project, state)
    state = outcome.state
    redeployed = outcome.redeployed
    if (outcome.error) errors.push(outcome.error)
  }
  writeProjectState(session.cwd, { ...state, manifestHash: project.manifestHash })
  const exitCode = errors.length > result.errors.length ? ExitCode.failed : result.exitCode

  if (session.json) {
    session.printer.emit({
      ok: exitCode === ExitCode.ok,
      command: 'secret set',
      name,
      sinks: declaration.sinks,
      targets: specs.map((s) => s.id),
      redeployed: redeployed ?? null,
      errors,
    })
  } else {
    session.printer.line(`${name}=**** pushed to ${specs.length} destinations.`)
    if (redeployed) session.printer.line(`Deployed again so the live app uses it: ${redeployed}`)
    for (const error of errors) session.printer.error(error)
  }
  return exitCode
}

/**
 * Vercel and Netlify read env only when they build, so a value written to a hosting env after the
 * last deployment does not reach the live app until it is deployed again (BUG-63). After secret set
 * or rotate, the hosting deployment is applied: it sees the newer env and deploys again. A project
 * that was never deployed is left for cimiento up.
 */
async function redeployAfterEnvChange(
  project: ProjectSession,
  state: ProjectState,
): Promise<{ state: ProjectState; redeployed?: string; error?: CimientoErrorFields }> {
  const hosting = hostingOf(project.manifest)
  const id = hosting ? `${hosting}.deployment` : undefined
  const spec = id ? project.specs.find((s) => s.id === id) : undefined
  const provider = hosting ? project.providers.find((p) => p.id === hosting) : undefined
  if (!id || !spec || !provider || !state.resources[id]) return { state }
  const ctx = { ...project.ctx, state }
  try {
    const attempt = await new OutputResolver(state).resolveWithHydration(spec, project.specs, new Map(project.providers.map((p) => [p.id, p])), ctx)
    if (attempt.unresolved.length > 0) return { state }
    const result = await provider.ensure(attempt.spec, ctx)
    const next = applyEnsureToState(state, spec, result)
    return { state: next, ...(result.action !== 'noop' ? { redeployed: result.url ?? id } : {}) }
  } catch (err) {
    return {
      state,
      error: asCimientoError(err, { code: 'CHECK_FAILED', provider: hosting!, resource: id, hint: 'Run cimiento up. It deploys again so the live app reads the current env.' }).toJSON(),
    }
  }
}

export async function secretRotateCommand(session: Session): Promise<number> {
  const name = session.args.positionals[0]
  if (!name) {
    throw new CimientoError({
      code: 'SECRET_MISSING',
      provider: 'secrets',
      resource: 'secret rotate',
      message: 'cimiento secret rotate needs the name of the secret.',
      hint: 'Run cimiento secret rotate ANTHROPIC_API_KEY. The new value is typed at a hidden prompt, never on the command line.',
      retryable: false,
      needsHuman: true,
    })
  }
  const project = openProject(session, { dryRun: false })
  const declaration = project.secrets.declaration(name)
  if (!declaration) {
    throw new CimientoError({
      code: 'SECRET_NOT_DECLARED',
      provider: 'secrets',
      resource: `secret.${name}`,
      message: `stack.yaml does not declare a secret named ${name}.`,
      hint: `Add it to the secrets section of stack.yaml, then run cimiento secret set ${name}.`,
      retryable: false,
      needsHuman: true,
    })
  }
  for (const sink of declaration.sinks) assertSinkAvailable(sink, name)

  const specs = sinkSpecsFor(name, project.specs)
  const byProvider = new Map(project.providers.map((p) => [p.id, p]))
  const resolver = new OutputResolver(project.state)
  const resolved = []
  for (const spec of specs) {
    const attempt = await resolver.resolveWithHydration(spec, project.specs, byProvider, project.ctx)
    if (attempt.unresolved.length > 0) {
      throw new CimientoError({
        code: 'SECRET_SINK_UNAVAILABLE',
        provider: 'secrets',
        resource: `secret.${name}`,
        message: `There is nowhere to rotate ${name} into yet: the hosting project does not exist.`,
        hint: 'Run cimiento up first. rotate replaces a value that is already there.',
        retryable: true,
        needsHuman: false,
      })
    }
    resolved.push(attempt.spec)
  }

  // Fresh, never the cached value: a keychain secret is typed again and stored over the old one.
  await project.secrets.prompt(name)

  const updated: string[] = []
  const created: string[] = []
  const errors: CimientoErrorFields[] = []
  for (const spec of resolved) {
    try {
      // Each sink writes over what it holds: the hosting env, Supabase secrets, Actions secrets.
      const provider = byProvider.get(spec.provider)!
      const result = await provider.ensure({ ...spec, inputs: { ...spec.inputs, rotate: 'true' } }, project.ctx)
      ;(result.action === 'created' ? created : updated).push(spec.id)
    } catch (err) {
      errors.push(
        asCimientoError(err, { code: 'VERCEL_ENV_WRITE_FAILED', provider: spec.provider, resource: spec.id, hint: `Run cimiento secret rotate ${name} again.` }).toJSON(),
      )
    }
  }
  // Named for the hosting this project uses (BUG-62); with no hosting sink there is nothing to rebuild.
  const hosting = hostingOf(project.manifest)
  const note =
    hosting && declaration.sinks.includes('hosting')
      ? `${HOSTING_NAMES[hosting]} reads env when it builds. cimiento up deploys again so the live app uses the new value, and cimiento doctor reports the deployment until then.`
      : 'Every sink holds the new value now.'
  let redeployed: string | undefined
  if (errors.length === 0) {
    const outcome = await redeployAfterEnvChange(project, project.state)
    redeployed = outcome.redeployed
    if (outcome.error) errors.push(outcome.error)
    else if (outcome.state !== project.state) writeProjectState(session.cwd, { ...outcome.state, manifestHash: project.manifestHash })
  }
  const exitCode = errors.length > 0 ? ExitCode.failed : ExitCode.ok
  const finalNote = redeployed ? `Deployed again so the live app uses the new value: ${redeployed}` : note
  if (session.json) {
    session.printer.emit({ ok: exitCode === ExitCode.ok, command: 'secret rotate', name, source: declaration.source, updated, created, redeployed: redeployed ?? null, errors, note: finalNote })
  } else {
    session.printer.line(`${name}=**** rotated in ${updated.length + created.length} destinations.`)
    for (const error of errors) session.printer.error(error)
    session.printer.line(finalNote)
  }
  return exitCode
}

/**
 * Takes a secret out of the project: its declaration in stack.yaml, its entries in every sink, and
 * its value in the keychain when cimiento stored it there. The rest of stack.yaml, comments
 * included, is left as it was, and nothing is changed when the result would not validate.
 */
export async function secretRemoveCommand(session: Session): Promise<number> {
  const name = session.args.positionals[0]
  if (!name) {
    throw new CimientoError({
      code: 'SECRET_NOT_DECLARED',
      provider: 'secrets',
      resource: 'secret remove',
      message: 'cimiento secret remove needs the name of the secret.',
      hint: 'Run cimiento secret remove NAME with a name from the secrets section of stack.yaml.',
      retryable: false,
      needsHuman: true,
    })
  }
  const project = openProject(session, { dryRun: false })
  const declaration = project.secrets.declaration(name)
  if (!declaration) {
    throw new CimientoError({
      code: 'SECRET_NOT_DECLARED',
      provider: 'secrets',
      resource: `secret.${name}`,
      message: `stack.yaml does not declare a secret named ${name}, so there is nothing to remove.`,
      hint: `The declared secrets are: ${project.manifest.secrets.map((s) => s.name).join(', ') || 'none'}.`,
      retryable: false,
      needsHuman: true,
    })
  }

  // Validate the manifest without the secret before touching anything, so a secret a slot needs,
  // such as ANTHROPIC_API_KEY for ai: anthropic, is refused with the reason and nothing changes.
  const file = manifestPath(session.cwd)
  const doc = parseDocument(readFileSync(file, 'utf8'))
  const seq = doc.get('secrets')
  if (isSeq(seq)) {
    const index = seq.items.findIndex((item) => isMap(item) && item.get('name') === name)
    if (index >= 0) seq.items.splice(index, 1)
  }
  parseManifest(doc.toJS(), 'stack.yaml')

  const specs = sinkSpecsFor(name, project.specs)
  const byProvider = new Map(project.providers.map((p) => [p.id, p]))
  const resolver = new OutputResolver(project.state)
  const deleted: string[] = []
  for (const spec of specs) {
    const attempt = await resolver.resolveWithHydration(spec, project.specs, byProvider, project.ctx)
    // No hosting project yet means nothing was ever written there.
    if (attempt.unresolved.length > 0) continue
    if (await removeSinkValue(attempt.spec, project.ctx)) deleted.push(spec.id)
  }
  const keychain = declaration.source === 'keychain' ? await project.secrets.removeStored(name) : false

  writeFileSync(file, doc.toString({ lineWidth: 100 }), 'utf8')
  const resources = { ...project.state.resources }
  for (const spec of specs) delete resources[spec.id]
  const next = dropFromStoredSpecs({ ...project.state, resources }, specs.map((s) => s.id))
  writeProjectState(session.cwd, { ...next, manifestHash: hashManifest(readFileSync(file, 'utf8')) })
  const example = join(session.cwd, '.env.example')
  if (existsSync(example)) {
    const text = readFileSync(example, 'utf8')
    const next = text
      .split('\n')
      .filter((line) => !new RegExp(`^${name}=`).test(line))
      .join('\n')
    if (next !== text) writeFileSync(example, next, 'utf8')
  }

  if (session.json) {
    session.printer.emit({ ok: true, command: 'secret remove', name, manifest: 'stack.yaml', deleted, keychain: keychain ? 'deleted' : 'none' })
  } else {
    session.printer.line(`${name} is no longer declared in stack.yaml.`)
    if (deleted.length > 0) session.printer.line(`Deleted from ${deleted.join(', ')}.`)
    if (keychain) session.printer.line(`Deleted from the macOS keychain (service cimiento, account ${project.manifest.slug}/${name}).`)
  }
  return ExitCode.ok
}

export async function secretCheckCommand(session: Session): Promise<number> {
  const project = openProject(session, { dryRun: true })
  const specs = allSinkSpecs(project.manifest, project.specs)
  if (specs.length === 0) {
    if (session.json) session.printer.emit({ ok: true, command: 'secret check', items: [] })
    else session.printer.line('stack.yaml declares no secrets with a sink this build writes to.')
    return ExitCode.ok
  }
  const reports = await runVerifyAll(project.ctx, project.providers, withDependencies(specs, project.specs))
  const relevant = reports.filter((r) => specs.some((s) => s.id === r.id))

  if (session.json) {
    session.printer.emit({
      ok: relevant.every((r) => r.ok),
      command: 'secret check',
      items: relevant.map((r) => ({ id: r.id, ok: r.ok, evidence: r.evidence, error: r.error })),
    })
  } else {
    for (const report of relevant) {
      session.printer.line(`${report.ok ? 'ok    ' : 'missing'} ${report.id}`)
      if (!report.ok && report.error) session.printer.line(`        hint: ${report.error.hint}`)
    }
  }
  return relevant.every((r) => r.ok) ? ExitCode.ok : ExitCode.failed
}

/** The transitive closure of a set of specs, so the executor can satisfy their dependencies. */
function withDependencies<T extends { id: string; dependsOn: string[] }>(wanted: T[], all: T[]): T[] {
  const byId = new Map(all.map((s) => [s.id, s]))
  const keep = new Set<string>()
  const visit = (id: string): void => {
    if (keep.has(id)) return
    keep.add(id)
    const spec = byId.get(id)
    if (!spec) return
    for (const dep of spec.dependsOn) visit(dep)
  }
  for (const spec of wanted) visit(spec.id)
  return all.filter((s) => keep.has(s.id))
}

/** Deletes one sink's copy of a secret, whichever sink the spec belongs to. */
async function removeSinkValue(spec: ResourceSpec, ctx: Ctx): Promise<boolean> {
  if (spec.id.startsWith('supabase.secret.')) return removeDatabaseSecret(spec, ctx)
  if (spec.id.startsWith('github.secret.')) return removeCiSecret(spec, ctx)
  return removeHostingEnv(spec, ctx)
}
