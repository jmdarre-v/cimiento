// Builds the Ctx every provider receives, and the surrounding session the commands share.

import type { StaleLock } from '../core/lock'
import { ExitCode } from '../core/errors'
import { RealIo, type Io } from '../core/io'
import { ConsoleLogger } from '../core/logger'
import { Redactor } from '../core/redact'
import {
  emptyMachineState,
  emptyProjectState,
  machineStatePath,
  readMachineState,
  readProjectState,
  writeMachineState,
  type MachineState,
  type ProjectState,
} from '../core/state'
import type { ChoiceOption, Ctx, Lang, Provider, ResourceSpec } from '../core/types'
import { loadManifest, type Manifest } from '../manifest'
import { reconcilePins } from '../manifest/pin'
import { buildProviders, collectSpecs, explainKey } from '../registry'
import { SecretStore, ask, askHidden, isYes, pressEnter } from '../secrets'
import { RunLog } from '../core/runlog'
import { renderPersonStep, STEP_WORDS, type PersonStep } from '../core/person'
import { flagBool, flagList, flagString, type ParsedArgs } from './args'
import { Printer, type Writer } from './output'

export interface CliDeps {
  io?: Io
  cwd?: string
  writer?: Writer
  interactive?: boolean
  /** Lets a test or a guided run confirm a manual step without a terminal. */
  onManual?: (spec: ResourceSpec, ctx: Ctx) => Promise<boolean>
  /** Answers an account choice without a terminal, for tests. */
  choose?: (question: string, options: ChoiceOption[]) => Promise<string>
  /** Answers a free text question without a terminal, for tests. */
  ask?: (question: string, defaultValue?: string) => Promise<string>
  /** Pre-seeded secret values. Tests pass obviously fake ones. */
  secrets?: Record<string, string>
  /** Answers the hidden secret prompt without a terminal, for tests. */
  promptHidden?: (question: string) => Promise<string>
  /** Resolves when cimiento dev should stop. A real run stops on Ctrl+C. */
  stopSignal?: Promise<void>
}

export interface Session {
  args: ParsedArgs
  cwd: string
  io: Io
  lang: Lang
  json: boolean
  guided: boolean
  yes: boolean
  allowBilling: boolean
  only: string[]
  skip: string[]
  interactive: boolean
  redactor: Redactor
  printer: Printer
  machine: MachineState
  deps: CliDeps
  /** ~/.cimiento/runs/<UTC timestamp>-<command>.jsonl for this command. */
  runLog: RunLog
}

export const defaultWriter: Writer = {
  out: (text) => process.stdout.write(text),
  err: (text) => process.stderr.write(text),
}

export function openSession(args: ParsedArgs, deps: CliDeps): Session {
  const json = flagBool(args.flags, 'json')
  const redactor = new Redactor()
  const writer = deps.writer ?? defaultWriter
  const lang = resolveLang(flagString(args.flags, 'lang'))
  const machine = safeMachineState()
  const runLog = new RunLog([args.command, args.sub].filter(Boolean).join('-'), redactor)
  return {
    runLog,
    args,
    cwd: deps.cwd ?? process.cwd(),
    io: deps.io ?? new RealIo(),
    lang,
    json,
    guided: flagBool(args.flags, 'guided'),
    yes: flagBool(args.flags, 'yes'),
    allowBilling: flagBool(args.flags, 'allow-billing'),
    only: flagList(args.flags, 'only'),
    skip: flagList(args.flags, 'skip'),
    interactive: deps.interactive ?? (process.stdin.isTTY === true && !json),
    redactor,
    printer: new Printer(writer, redactor, json, {
      lang,
      guided: flagBool(args.flags, 'guided'),
      explain: (key: string) => explainKey(key, lang),
      runLog,
    }),
    machine,
    deps,
  }
}

function safeMachineState(): MachineState {
  try {
    return readMachineState()
  } catch {
    return emptyMachineState()
  }
}

export function saveMachineState(state: MachineState): void {
  writeMachineState(state, machineStatePath())
}

function resolveLang(flag: string | undefined): Lang {
  if (flag === 'es' || flag === 'en') return flag
  const locale = process.env.LC_ALL ?? process.env.LANG ?? ''
  return locale.toLowerCase().startsWith('es') ? 'es' : 'en'
}

export interface ProjectSession {
  manifest: Manifest
  manifestHash: string
  state: ProjectState
  providers: Provider[]
  specs: ResourceSpec[]
  ctx: Ctx
  secrets: SecretStore
}

/** Loads stack.yaml and state, and assembles everything the engine needs. */
export function openProject(session: Session, options: { dryRun: boolean; cwd?: string } ): ProjectSession {
  const cwd = options.cwd ?? session.cwd
  const loaded = loadManifest(cwd)
  const stored = readProjectState(cwd)
  // State follows stack.yaml for every pinned account, before anything reads either.
  const state: ProjectState = reconcilePins(loaded.manifest, { ...stored, manifestHash: loaded.hash })
  const providers = buildProviders(loaded.manifest)
  const specs = collectSpecs(loaded.manifest, state, providers)
  const secrets = new SecretStore(loaded.manifest, session.redactor, {
    interactive: session.interactive,
    values: session.deps.secrets ?? {},
    io: session.io,
    // Every hidden prompt is recorded as a prompt with the answer ****, never the value.
    promptHidden: session.runLog.recordAsk('hidden', session.deps.promptHidden ?? askHidden),
    ...(canWalk(session) ? { walkStep: walker(session) } : {}),
    ...(canWalk(session) && sessionChooser(session) ? { choose: sessionChooser(session)! } : {}),
    lang: session.lang,
  })
  const chooser = sessionChooser(session)
  const asker = sessionAsker(session)
  const ctx: Ctx = {
    io: session.io,
    manifest: loaded.manifest,
    state,
    machine: session.machine,
    cwd,
    lang: session.lang,
    logger: new ConsoleLogger(
      session.json ? 'silent' : 'expert',
      session.redactor,
      (t) => (session.deps.writer ?? defaultWriter).err(t),
      session.runLog,
    ),
    redactor: session.redactor,
    secrets,
    dryRun: options.dryRun,
    interactive: session.interactive,
    ...(chooser ? { choose: chooser } : {}),
    ...(asker ? { ask: asker } : {}),
    ...(session.interactive ? { openUrl: (url: string) => openUrlWith(session.io, url) } : {}),
    ...(canWalk(session) ? { walkStep: walker(session) } : {}),
  }
  return { manifest: loaded.manifest, manifestHash: loaded.hash, state, providers, specs, ctx, secrets }
}

export function emptyState(hash = ''): ProjectState {
  return { ...emptyProjectState(), manifestHash: hash }
}

export const EXIT = ExitCode

/** The question helpers a command uses outside a project: injected in tests, the terminal otherwise. */
export function sessionChooser(session: Session): ((question: string, options: ChoiceOption[]) => Promise<string>) | undefined {
  const fn = session.deps.choose ?? (session.interactive ? chooseInTerminal(session.lang) : undefined)
  if (!fn) return undefined
  return async (question, options) => {
    session.runLog.write({ type: 'prompt', kind: 'choose', question, options: options.map((o) => `${o.value}: ${o.label}`) })
    const answer = await fn(question, options)
    session.runLog.write({ type: 'answer', kind: 'choose', answer })
    return answer
  }
}

export function sessionAsker(session: Session): ((question: string, defaultValue?: string) => Promise<string>) | undefined {
  const fn = session.deps.ask ?? (session.interactive ? askInTerminal : undefined)
  return fn ? session.runLog.recordAsk('ask', fn) : undefined
}

/** A yes or no question, recorded in the run log, through the injected ask when there is one. */
export async function sessionConfirm(session: Session, question: string): Promise<boolean> {
  const suffix = session.lang === 'es' ? '[s/N]' : '[y/N]'
  const fn = session.deps.ask ? (q: string) => session.deps.ask!(`${q} ${suffix}`) : (q: string) => ask(`${q} ${suffix} `)
  return isYes(await session.runLog.recordAsk('confirm', fn)(question))
}

/** A numbered list in the terminal. Re-asks until the answer is one of the numbers shown. */
function chooseInTerminal(lang: Lang): (question: string, options: ChoiceOption[]) => Promise<string> {
  return (question, options) => chooseIn(lang, question, options)
}

async function chooseIn(lang: Lang, question: string, options: ChoiceOption[]): Promise<string> {
  const lines = options
    .map((o, i) => `  ${i + 1}. ${o.label}${o.warning ? `\n     ${lang === 'es' ? 'aviso' : 'warning'}: ${o.warning}` : ''}`)
    .join('\n')
  for (;;) {
    const answer = await ask(`\n${question}\n${lines}\n${lang === 'es' ? 'Numero' : 'Number'}: `)
    const index = Number(answer.trim()) - 1
    if (Number.isInteger(index) && options[index]) return options[index].value
  }
}

/** One line of text, with the default shown in brackets and used on an empty answer. */
async function askInTerminal(question: string, defaultValue?: string): Promise<string> {
  const answer = await ask(`${question}${defaultValue ? ` [${defaultValue}]` : ''} `)
  return answer.trim() || defaultValue || ''
}

/** The resource or error a person step belongs to, for its explanation. */
export function explainKeyForStep(id: string): string {
  const [provider, what] = [id.slice(0, id.indexOf('.')), id.slice(id.indexOf('.') + 1)]
  if (provider === 'secret') return `vercel.env.${what}.production`
  if (id === 'supabase.free-limit') return 'SUPABASE_FREE_PROJECT_LIMIT'
  if (id === 'vercel.github-connection') return 'vercel.github-access'
  if (['login', 'team', 'organization', 'account', 'signup'].includes(what)) return `${provider === 'github' ? 'github' : provider}.session`
  return id
}

/** A person at a real terminal, or a test answering for them. */
function canWalk(session: Session): boolean {
  return session.interactive && (Boolean(session.deps.ask) || process.stdin.isTTY === true)
}

/**
 * Walks the person through a step in the terminal: the whole step with its link, Enter to open
 * the page (or to start the vendor command that opens it), and Enter when done.
 */
export function walker(session: Session): (step: PersonStep, open?: () => Promise<void>) => Promise<void> {
  const enter = async (text: string): Promise<void> => {
    await session.runLog.recordAsk('enter', async (q: string) => {
      if (session.deps.ask) return session.deps.ask(q)
      await pressEnter(`${q} `)
      return ''
    })(text)
  }
  return async (step, open) => {
    // Guided mode, spec section 10: the explain text before every step a person does.
    const plain = session.guided ? explainKey(explainKeyForStep(step.id), session.lang) : undefined
    if (plain) session.printer.line(`\n${plain}`)
    session.printer.line(`\n${renderPersonStep(step, session.lang, { links: true, prompts: false })}`)
    await enter(STEP_WORDS.enterToOpen[session.lang])
    await (open ? open() : openUrlWith(session.io, step.url))
    await enter(STEP_WORDS.enterWhenDone[session.lang])
  }
}

async function openUrlWith(io: Io, url: string): Promise<void> {
  const opener = process.platform === 'darwin' ? 'open' : process.platform === 'win32' ? 'start' : 'xdg-open'
  await io.exec(opener, [url]).catch(() => undefined)
}

/** A lock left by a run that no longer runs, said out loud before it is taken over (BUG-72). */
export function reportStaleLock(session: Session, stale: StaleLock): void {
  const message = `A lock left by cimiento ${stale.command} (process ${stale.pid}, started ${stale.startedAt}) was stale: that run is gone. Taking it over. Run cimiento doctor if that run was interrupted.`
  if (session.json) session.printer.emit({ event: 'stale-lock', pid: stale.pid, command: stale.command, startedAt: stale.startedAt, message })
  else session.printer.line(message)
}
