// cimiento upgrade (Goal 9, BUG-109 to 111): brings a project made by an older cimiento up to the
// current scaffold for its template. It shows every file it would add, replace, merge or remove,
// applies on confirmation (a yes in a terminal, or --yes), never replaces a file the person changed
// without asking, takes a key 0.4.1 put in previews back out, and commits what it changed.

import { mkdirSync, readFileSync, rmSync, writeFileSync } from 'node:fs'
import { dirname, join } from 'node:path'
import { ExitCode } from '../../core/errors'
import { hostingOf, hostingProjectId } from '../../core/hosting'
import { hostingEnvId } from '../../core/sink-ids'
import { writeProjectState } from '../../core/state'
import type { ResourceSpec } from '../../core/types'
import { gitIdentityArgs } from '../../providers/github'
import { removeHostingEnv } from '../../providers/hosting'
import { BASELINE_PATH, baselineFor, planUpgrade, readBaseline, type UpgradeChange } from '../../scaffold/upgrade'
import { VERSION } from '../../version'
import { flagBool } from '../args'
import { openProject, type Session } from '../context'

export async function upgradeCommand(session: Session): Promise<number> {
  const project = openProject(session, { dryRun: false })
  const { ctx } = project
  const raw = readFileSync(join(session.cwd, 'stack.yaml'), 'utf8')
  const plan = planUpgrade(session.cwd, project.manifest, raw)
  const changes = plan.changes
  const describe = (c: UpgradeChange) => ({ path: c.path, action: c.action, detail: c.detail })

  if (!session.json) {
    if (changes.length === 0) session.printer.line(`This project matches the cimiento ${VERSION} scaffold.`)
    else {
      session.printer.line(`To match the cimiento ${VERSION} scaffold:`)
      for (const c of changes) session.printer.line(`  ${c.action.padEnd(20)} ${c.path}  ${c.detail}`)
    }
  }
  const yes = session.yes || flagBool(session.args.flags, 'yes')
  let confirmed = yes
  if (!yes && session.interactive && changes.length > 0 && session.deps.ask !== undefined) {
    const answer = await session.runLog.recordAsk('ask', session.deps.ask)('Apply these changes and commit them? (y/N) ')
    confirmed = /^y(es)?$/i.test(answer.trim())
  }
  if (!confirmed || changes.length === 0) {
    if (session.json) session.printer.emit({ ok: true, command: 'upgrade', version: VERSION, applied: false, changes: changes.map(describe) })
    return ExitCode.ok
  }

  // A file the person changed: asked one by one in a terminal, never replaced otherwise.
  const kept: UpgradeChange[] = []
  for (const c of changes.filter((x) => x.action === 'changed by you')) {
    const replace = session.interactive && !session.json && session.deps.ask
      ? /^y(es)?$/i.test((await session.runLog.recordAsk('ask', session.deps.ask)(`${c.path} differs from what cimiento wrote. Replace it with the ${VERSION} version? (y/N) `)).trim())
      : false
    if (replace) {
      c.action = 'replace'
      c.content = c.proposed
    } else kept.push(c)
  }

  const touched: string[] = []
  for (const c of changes) {
    const path = join(session.cwd, c.path)
    if ((c.action === 'add' || c.action === 'replace' || c.action === 'merge') && c.content !== undefined) {
      mkdirSync(dirname(path), { recursive: true })
      writeFileSync(path, c.content, 'utf8')
      touched.push(c.path)
    } else if (c.action === 'remove') {
      rmSync(path, { force: true })
      touched.push(c.path)
    }
  }

  // The preview env loses what 0.4.1 put there; the records of those bindings go with them.
  let state = ctx.state
  const hosting = hostingOf(plan.manifest)
  const projectId = hosting ? ctx.state.resources[hostingProjectId(hosting)]?.externalId : undefined
  if (hosting && projectId) {
    for (const key of plan.removeFromPreviews) {
      const id = hostingEnvId(hosting, key, 'preview')
      const spec: ResourceSpec = { id, kind: 'binding', provider: hosting, dependsOn: [], inputs: { projectId, key, environment: 'preview' } }
      await removeHostingEnv(spec, ctx)
      const resources = { ...state.resources }
      delete resources[id]
      state = { ...state, resources }
    }
    if (plan.removeFromPreviews.length > 0) {
      writeProjectState(session.cwd, { ...state, manifestHash: ctx.state.manifestHash })
      touched.push('.cimiento/state.json')
    }
  }

  // What cimiento wrote now, for the next upgrade to tell its files from the person's.
  const written: Record<string, string> = {}
  for (const c of changes) if ((c.action === 'add' || c.action === 'replace') && c.content !== undefined) written[c.path] = c.content
  const baseline = baselineFor(written, readBaseline(session.cwd))
  for (const c of changes) if (c.action === 'remove') delete baseline[c.path]
  mkdirSync(dirname(join(session.cwd, BASELINE_PATH)), { recursive: true })
  writeFileSync(join(session.cwd, BASELINE_PATH), `${JSON.stringify({ cimiento: VERSION, files: baseline }, null, 2)}\n`)
  touched.push(BASELINE_PATH)

  const git = (args: string[]) => session.io.exec('git', args, { cwd: session.cwd })
  let committed = false
  if ((await git(['rev-parse', '--is-inside-work-tree'])).code === 0) {
    await git(['add', '--all', '--', ...touched])
    const commit = await git([...(await gitIdentityArgs(ctx)), 'commit', '-m', `chore: cimiento upgrade to ${VERSION}`])
    committed = commit.code === 0
  }

  const exitCode = kept.length > 0 ? ExitCode.needsHuman : ExitCode.ok
  if (session.json) {
    session.printer.emit({
      ok: exitCode === ExitCode.ok,
      command: 'upgrade',
      version: VERSION,
      applied: true,
      committed,
      changes: changes.map(describe),
      ...(kept.length > 0 ? { code: 'UPGRADE_FILE_CHANGED', hint: `Left as you changed them: ${kept.map((c) => c.path).join(', ')}. Run cimiento upgrade in a terminal to replace them one by one.` } : {}),
    })
  } else {
    session.printer.line(committed ? `Applied and committed: chore: cimiento upgrade to ${VERSION}.` : 'Applied. This folder is not a git repository, so nothing was committed.')
    if (kept.length > 0) session.printer.line(`Left as you changed them: ${kept.map((c) => c.path).join(', ')}.`)
  }
  return exitCode
}

/** For up: what an upgrade would change, without changing it (BUG-111). */
export function upgradeAvailable(session: Session, cwd: string, manifest: Parameters<typeof planUpgrade>[1]): string[] {
  try {
    const raw = readFileSync(join(cwd, 'stack.yaml'), 'utf8')
    return planUpgrade(cwd, manifest, raw)
      .changes.filter((c) => c.action !== 'changed by you')
      .map((c) => c.path)
  } catch {
    return []
  }
}
