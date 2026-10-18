// cimiento env pull and cimiento env print.
//
// env pull is the only place a secret value touches disk, and the file it writes is gitignored.
// env print shows non secret outputs and URLs only.

import { ExitCode } from '../../core/errors'
import { pullHostingEnv } from '../../providers/hosting'
import { openProject, type ProjectSession, type Session } from '../context'

export async function envPullCommand(session: Session): Promise<number> {
  const project = openProject(session, { dryRun: false })
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

/** Writes .env.local from the hosting env store, and returns the names it wrote. */
export async function pullEnv(session: Session, project: ProjectSession): Promise<{ target: string; names: string[] }> {
  const target = '.env.local'
  const names = await pullHostingEnv(project.ctx, project.manifest, target)
  for (const name of names) session.redactor.addName(name)
  return { target, names }
}
