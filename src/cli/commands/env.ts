// cimiento env pull and cimiento env print.
//
// env pull is the only place a secret value touches disk, and the file it writes is gitignored.
// env print shows non secret outputs and URLs only.

import { existsSync, readFileSync } from 'node:fs'
import { join } from 'node:path'
import { CimientoError, ExitCode } from '../../core/errors'
import { ensureLocalLink } from '../../providers/vercel'
import { openProject, type ProjectSession, type Session } from '../context'

export async function envPullCommand(session: Session): Promise<number> {
  const project = openProject(session, { dryRun: false })
  if (project.manifest.slots.hosting !== 'vercel') {
    throw new CimientoError({
      code: 'SECRET_SINK_UNAVAILABLE',
      provider: 'core',
      resource: 'env pull',
      message: 'env pull reads from the hosting env store, and slots.hosting is none in stack.yaml.',
      hint: 'Set slots.hosting to vercel, or write .env.local by hand for a project with no hosting.',
      retryable: false,
      needsHuman: true,
    })
  }

  const { target, names } = await pullEnv(session, project)
  if (session.json) {
    session.printer.emit({ ok: true, command: 'env pull', file: target, names })
  } else {
    session.printer.line(`Wrote ${target} with ${names.length} variables.`)
    for (const name of names) session.printer.line(`  ${name}=****`)
    session.printer.line('This file is gitignored. It is the only place these values touch disk.')
  }
  return ExitCode.ok
}

export async function envPrintCommand(session: Session): Promise<number> {
  const project = openProject(session, { dryRun: true })
  const outputs: Record<string, Record<string, string>> = {}
  const urls: Record<string, string> = {}
  for (const [id, entry] of Object.entries(project.state.resources)) {
    if (entry.url) urls[id] = entry.url
    if (entry.outputs && Object.keys(entry.outputs).length > 0) outputs[id] = entry.outputs
  }
  const payload = {
    ok: true,
    command: 'env print',
    name: project.manifest.name,
    slug: project.manifest.slug,
    urls,
    outputs,
    secretNames: project.manifest.secrets.map((s) => s.name),
  }
  if (session.json) {
    session.printer.emit(payload)
  } else {
    session.printer.line(`\n${project.manifest.name}`)
    for (const [id, url] of Object.entries(urls)) session.printer.line(`  ${id}  ${url}`)
    for (const [id, values] of Object.entries(outputs)) {
      for (const [key, value] of Object.entries(values)) session.printer.line(`  ${id}.${key}  ${value}`)
    }
    if (payload.secretNames.length > 0) {
      session.printer.line(`\nDeclared secrets, names only: ${payload.secretNames.join(', ')}`)
    }
  }
  return ExitCode.ok
}

function readEnvNames(path: string): string[] {
  if (!existsSync(path)) return []
  const names: string[] = []
  for (const line of readFileSync(path, 'utf8').split('\n')) {
    const match = /^\s*([A-Za-z_][A-Za-z0-9_]*)\s*=/.exec(line)
    if (match) names.push(match[1])
  }
  return names.sort()
}

/** Writes .env.local from the Vercel env through the vendor CLI, and returns the names it wrote. */
export async function pullEnv(session: Session, project: ProjectSession): Promise<{ target: string; names: string[] }> {
  await ensureLocalLink(project.ctx, { id: 'env pull', kind: 'binding', provider: 'vercel', dependsOn: [], inputs: {} }, project.manifest.slug)
  const target = '.env.local'
  const args = ['env', 'pull', target, '--yes']
  if (project.manifest.accounts.vercel) args.push('--scope', project.manifest.accounts.vercel)
  const result = await session.io.exec('vercel', args, { cwd: project.ctx.cwd })
  if (result.code !== 0) {
    throw new CimientoError({
      code: 'VERCEL_ENV_WRITE_FAILED',
      provider: 'vercel',
      resource: 'env pull',
      message: `vercel env pull failed: ${(result.stderr || result.stdout).trim().slice(0, 400)}`,
      hint: 'cimiento linked this folder to the Vercel project first, so this is a Vercel side error. cimiento doctor shows whether the project and session are healthy.',
      retryable: true,
      needsHuman: false,
    })
  }

  const names = readEnvNames(join(project.ctx.cwd, target))
  for (const name of names) session.redactor.addName(name)

  return { target, names }
}
