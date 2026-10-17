// cimiento init and cimiento new. init writes a manifest into a folder that already exists,
// new creates the folder, scaffolds it, and then runs plan and up.

import { existsSync, mkdirSync } from 'node:fs'
import { homedir } from 'node:os'
import { isAbsolute, join, resolve } from 'node:path'
import { CimientoError, ExitCode } from '../../core/errors'
import { emptyProjectState } from '../../core/state'
import {
  emptyFragment,
  isPresetName,
  manifestExists,
  mergeFragments,
  parseManifest,
  presetFragment,
  slugify,
  writeManifest,
  type ManifestInput,
} from '../../manifest'
import { buildProviders, collectSpecs } from '../../registry'
import { bindingEnvNames, scaffoldFiles, writeScaffold } from '../../scaffold'
import { ask } from '../../secrets/prompt'
import { flagBool, flagString } from '../args'
import { openSession, saveMachineState, sessionAsker, sessionChooser, type Session } from '../context'
import { machineStatePath } from '../../core/state'
import { slotName, t } from '../i18n'
import { IMPLEMENTED_PROVIDERS, SLOT_PROVIDERS } from '../../manifest/schema'
import { runUpIn } from './up'

export async function initCommand(session: Session): Promise<number> {
  const cwd = session.cwd
  if (manifestExists(cwd) && !flagBool(session.args.flags, 'force')) {
    throw new CimientoError({
      code: 'SCAFFOLD_TARGET_EXISTS',
      provider: 'core',
      resource: join(cwd, 'stack.yaml'),
      message: 'This folder already has a stack.yaml.',
      hint: 'Edit it by hand, or pass --force to overwrite it with the preset.',
      retryable: false,
      needsHuman: true,
    })
  }
  const name = session.args.positionals[0] ?? flagString(session.args.flags, 'name') ?? basename(cwd)
  const manifest = buildManifest(session, name)
  const path = writeManifest(cwd, manifest)
  if (session.json) {
    session.printer.emit({ ok: true, command: 'init', manifest: path, slug: manifest.slug, slots: manifest.slots })
  } else {
    session.printer.line(`Wrote ${path}`)
    session.printer.line('Run cimiento plan to see what it would do, then cimiento up.')
  }
  return ExitCode.ok
}

export async function newCommand(session: Session): Promise<number> {
  const guided = session.guided && session.interactive
  let name: string | undefined = session.args.positionals[0] ?? flagString(session.args.flags, 'name')
  // Guided mode, spec section 10: one question at a time, in the person's language.
  if (!name && guided) name = (await sessionAsker(session)?.(t(session.lang, 'askName')))?.trim() || undefined
  if (guided) await guidedSlots(session)
  if (!name) {
    throw new CimientoError({
      code: 'MANIFEST_INVALID',
      provider: 'core',
      resource: 'cimiento new',
      message: 'cimiento new needs a project name.',
      hint: 'Run cimiento new my-app --preset fullstack.',
      retryable: false,
      needsHuman: true,
    })
  }
  const manifest = buildManifest(session, name)
  const dir = await targetDir(session, manifest.slug)

  if (existsSync(join(dir, 'stack.yaml')) && !flagBool(session.args.flags, 'force')) {
    throw new CimientoError({
      code: 'SCAFFOLD_TARGET_EXISTS',
      provider: 'core',
      resource: dir,
      message: `${dir} already has a stack.yaml.`,
      hint: 'Pick another name, or run cimiento up inside that folder.',
      retryable: false,
      needsHuman: true,
    })
  }

  const providers = buildProviders(manifest)
  const specs = collectSpecs(manifest, emptyProjectState(), providers)
  const files = scaffoldFiles(manifest, { envNames: bindingEnvNames(specs) })
  mkdirSync(dir, { recursive: true })
  const written = writeScaffold(dir, files, { force: flagBool(session.args.flags, 'force') })
  writeManifest(dir, manifest)

  if (session.json) {
    session.printer.emit({
      ok: true,
      command: 'new',
      stage: 'scaffold',
      dir,
      slug: manifest.slug,
      files: [...written, 'stack.yaml'].sort(),
    })
  } else {
    session.printer.line(t(session.lang, 'created', { dir }))
    session.printer.line(t(session.lang, 'files', { count: written.length + 1 }))
  }

  const inner = { ...session, cwd: dir }
  const outcome = await runUpIn(inner, dir)
  if (!session.json && outcome.exitCode === ExitCode.ok) {
    const url = outcome.receipts.find((r) => r.id === 'vercel.deployment')?.url
    session.printer.line(url ? `\n${url}` : `\n${t(session.lang, 'done', { dir })}`)
  }
  return outcome.exitCode
}

function buildManifest(session: Session, name: string) {
  const presetName = flagString(session.args.flags, 'preset')
  if (presetName && !isPresetName(presetName)) {
    throw new CimientoError({
      code: 'MANIFEST_INVALID',
      provider: 'core',
      resource: '--preset',
      message: `No preset named ${presetName}.`,
      hint: 'The presets in this build are fullstack and designer.',
      retryable: false,
      needsHuman: true,
    })
  }
  const base = presetName && isPresetName(presetName) ? presetFragment(presetName) : emptyFragment()
  const overrides: Partial<ManifestInput> = { name, slug: slugify(name) }

  const slots: Record<string, string> = {}
  for (const slot of ['repo', 'hosting', 'database', 'auth', 'jobs', 'bot_protection', 'email', 'payments', 'analytics', 'ai']) {
    const value = flagString(session.args.flags, slot)
    if (value) slots[slot] = value
  }
  if (Object.keys(slots).length > 0) overrides.slots = slots as ManifestInput['slots']

  const accounts: Record<string, string> = {}
  const github = flagString(session.args.flags, 'github-account')
  const vercel = flagString(session.args.flags, 'vercel-account')
  const supabase = flagString(session.args.flags, 'supabase-account')
  if (github) accounts.github = github
  if (vercel) accounts.vercel = vercel
  if (supabase) accounts.supabase = supabase
  if (Object.keys(accounts).length > 0) overrides.accounts = accounts as ManifestInput['accounts']

  const template = flagString(session.args.flags, 'template')
  if (template) overrides.scaffold = { template } as ManifestInput['scaffold']

  return parseManifest(mergeFragments(base, overrides), 'stack.yaml')
}

/** Asks for projectsDir on first use and remembers it in machine state, per spec section 9. */
async function targetDir(session: Session, slug: string): Promise<string> {
  const explicit = flagString(session.args.flags, 'dir')
  if (explicit) return isAbsolute(explicit) ? explicit : resolve(session.cwd, explicit)

  let projectsDir = session.machine.projectsDir
  const isFirstUse = !existsSync(machineStatePath())
  if (session.guided && isFirstUse) {
    // Guided mode starts from ~/Code.nosync and says why, in one sentence.
    projectsDir = join(homedir(), 'Code.nosync')
    session.printer.line(`\n${t(session.lang, 'folderWhy')}`)
  }
  if (isFirstUse && session.interactive) {
    const asker = sessionAsker(session)
    const answer = asker
      ? await asker(t(session.lang, 'askFolder'), projectsDir)
      : await session.runLog.recordAsk('ask', ask)(`${t(session.lang, 'askFolder')} [${projectsDir}] `)
    if (answer.trim() && answer.trim() !== projectsDir) projectsDir = expandHome(answer.trim())
  }
  const machine = { ...session.machine, projectsDir }
  try {
    saveMachineState(machine)
  } catch {
    // A machine state that cannot be written still lets this run finish.
  }
  return join(expandHome(projectsDir), slug)
}

/**
 * What to build, asked one question at a time when no preset or slot flag says it already: a
 * website from a design, the full app, or each piece. The answers become the same flags an
 * expert would type, so the rest of new is shared.
 */
async function guidedSlots(session: Session): Promise<void> {
  const flags = session.args.flags
  const slots = ['repo', 'hosting', 'database', 'auth', 'jobs', 'bot_protection', 'ai'] as const
  if (flagString(flags, 'preset') || slots.some((s) => flagString(flags, s))) return
  const choose = sessionChooser(session)
  if (!choose) return
  const kind = await choose(t(session.lang, 'askKind'), [
    { value: 'designer', label: t(session.lang, 'kindDesigner') },
    { value: 'fullstack', label: t(session.lang, 'kindFullstack') },
    { value: 'custom', label: t(session.lang, 'kindCustom') },
  ])
  if (kind !== 'custom') {
    flags.preset = kind
    return
  }
  for (const slot of slots) {
    const providers = SLOT_PROVIDERS[slot].filter((p) => p === 'none' || (IMPLEMENTED_PROVIDERS as readonly string[]).includes(p))
    const answer = await choose(
      t(session.lang, 'askSlot', { slot: slotName(session.lang, slot) }),
      providers.map((p) => ({ value: p, label: p === 'none' ? t(session.lang, 'none') : p })),
    )
    flags[slot] = answer
  }
}

function expandHome(path: string): string {
  return path.startsWith('~') ? join(homedir(), path.slice(1)) : path
}

function basename(path: string): string {
  const parts = path.split('/').filter(Boolean)
  return parts[parts.length - 1] ?? 'app'
}

export { openSession }
