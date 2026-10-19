// cimiento explain <resource|error>. Plain language, with the knowledge base fix when the key is
// an error code.

import { ERROR_CODES, ExitCode } from '../../core/errors'
import { loadManifest, manifestExists } from '../../manifest'
import { lookupCode } from '../../kb'
import { buildProviders, collectSpecs, explainKey } from '../../registry'
import { emptyProjectState } from '../../core/state'
import { flagBool } from '../args'
import { openProject, type Session } from '../context'

export async function explainCommand(session: Session): Promise<number> {
  if (flagBool(session.args.flags, 'list')) return listKeys(session)

  const key = session.args.positionals[0]
  if (!key) {
    if (session.json) session.printer.emit({ ok: false, command: 'explain', message: 'explain needs a resource id or an error code' })
    else session.printer.line('Usage: cimiento explain <resource id or error code> [--lang es], or cimiento explain --list [--json]')
    return ExitCode.failed
  }

  const manifest = manifestExists(session.cwd) ? safeManifest(session) : undefined
  const text = explainKey(key, session.lang, manifest)
  const entry = lookupCode(key)

  if (session.json) {
    session.printer.emit({
      ok: Boolean(text || entry),
      command: 'explain',
      key,
      lang: session.lang,
      explanation: text,
      ...(entry ? { knowledgeBase: entry } : {}),
    })
    return text || entry ? ExitCode.ok : ExitCode.failed
  }

  if (!text && !entry) {
    session.printer.line(`cimiento has nothing written about ${key} yet.`)
    return ExitCode.failed
  }
  session.printer.line(`\n${key}`)
  if (text) session.printer.line(`\n${text}`)
  if (entry) {
    session.printer.line(`\nhint: ${entry.hint}`)
    session.printer.line(`fix: ${entry.fix}`)
    if (entry.docsUrl) session.printer.line(`docs: ${entry.docsUrl}`)
  }
  return ExitCode.ok
}

function safeManifest(session: Session) {
  try {
    return openProject(session, { dryRun: true }).manifest
  } catch {
    return undefined
  }
}

/** Listing needs only the manifest and static specs, never state, logins or live probes. */
function listKeys(session: Session): number {
  const errorCodes = [...new Set(ERROR_CODES)].sort()
  const manifest = manifestExists(session.cwd) ? loadManifest(session.cwd).manifest : undefined
  const resourceIds = manifest
    ? [...new Set(collectSpecs(manifest, emptyProjectState(), buildProviders(manifest)).map((spec) => spec.id))].sort()
    : []
  if (session.json) {
    session.printer.emit({ ok: true, command: 'explain', errorCodes, resourceIds })
  } else {
    session.printer.line(session.lang === 'es' ? 'Codigos de error:' : 'Error codes:')
    for (const code of errorCodes) session.printer.line(`  ${code}`)
    session.printer.line(session.lang === 'es' ? '\nRecursos seleccionados:' : '\nSelected resource ids:')
    for (const id of resourceIds) session.printer.line(`  ${id}`)
    if (!manifest) session.printer.line(session.lang === 'es' ? 'No hay stack.yaml en esta carpeta.' : 'No stack.yaml in this folder.')
  }
  return ExitCode.ok
}
