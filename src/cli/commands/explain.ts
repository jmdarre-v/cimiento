// cimiento explain <resource|error>. Plain language, with the knowledge base fix when the key is
// an error code.

import { ExitCode } from '../../core/errors'
import { manifestExists } from '../../manifest'
import { lookupCode } from '../../kb'
import { explainKey } from '../../registry'
import { openProject, type Session } from '../context'

export async function explainCommand(session: Session): Promise<number> {
  const key = session.args.positionals[0]
  if (!key) {
    if (session.json) session.printer.emit({ ok: false, command: 'explain', message: 'explain needs a resource id or an error code' })
    else session.printer.line('Usage: cimiento explain <resource id or error code> [--lang es]')
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
