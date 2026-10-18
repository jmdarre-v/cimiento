// The provider module interface from spec section 5, plus the context the engine passes around.

import type { CimientoError } from './errors'
import type { Io } from './io'
import type { Redactor } from './redact'
import type { PersonStep } from './person'
import type { Manifest } from '../manifest/schema'
import type { MachineState, ProjectState } from './state'

export type Slot =
  | 'repo'
  | 'hosting'
  | 'database'
  | 'auth'
  | 'jobs'
  | 'bot_protection'
  | 'email'
  | 'payments'
  | 'analytics'
  | 'ai'

export const SLOTS: Slot[] = [
  'repo',
  'hosting',
  'database',
  'auth',
  'jobs',
  'bot_protection',
  'email',
  'payments',
  'analytics',
  'ai',
]

export type Lang = 'en' | 'es'

export type ResourceKind = 'tool' | 'session' | 'resource' | 'binding' | 'manual' | 'check'

export interface ToolSpec {
  name: string
  bin: string
  versionRange: string
  install: { brew?: string; npm?: string; script?: string }
  versionCmd: string
}

export type Value = string | { deferred: string }

export interface ResourceSpec {
  id: string
  kind: ResourceKind
  provider: string
  dependsOn: string[]
  inputs: Record<string, Value>
  billable?: boolean
  manual?: { instructions: string; url?: string; step?: PersonStep }
}

export interface Output {
  value?: string
  deferred?: boolean
  secret: boolean
}

export interface EnsureResult {
  action: 'created' | 'adopted' | 'updated' | 'noop'
  externalId?: string
  url?: string
  outputs?: Record<string, Output>
}

export interface CheckResult {
  ok: boolean
  error?: CimientoError
  evidence?: string
  /** The provider could not tell, such as a 5xx or a timeout: neither ok nor failed (BUG-75). */
  unknown?: boolean
}

/**
 * Whether a resource still exists, by the id state recorded. absent only when an authenticated
 * lookup of that id said not found; an auth error, a timeout or a provider error is unknown, and
 * down keeps the record (BUG-73).
 */
export type Presence = 'present' | 'absent' | 'unknown'

/** The presence an http status of a by-id lookup proves. */
export function presenceFromStatus(status: number): Presence {
  if (status >= 200 && status < 300) return 'present'
  if (status === 404 || status === 410) return 'absent'
  return 'unknown'
}

export interface Detection {
  installed: boolean
  version?: string
  session?: { account: string; expiresAt?: string }
}

export interface Session {
  account: string
  expiresAt?: string
}

export interface LogEvent {
  /** UTC timestamp, ISO 8601, set by the logger when it is not given. */
  ts?: string
  level: 'info' | 'warn' | 'error'
  event: string
  resource?: string
  provider?: string
  message?: string
  data?: Record<string, unknown>
}

export interface Logger {
  log(event: LogEvent): void
}

export interface SecretResolver {
  /** Returns the value for a declared secret name, or undefined when it is not available. */
  get(name: string): Promise<string | undefined>
  /** Whether this run already holds the value, without reading any source. */
  has?(name: string): boolean
  /** Keeps a value cimiento made itself, such as the Neon key for previews. */
  keep?(name: string, value: string): Promise<void>
}

export interface Ctx {
  io: Io
  manifest: Manifest
  state: ProjectState
  machine: MachineState
  cwd: string
  lang: Lang
  logger: Logger
  redactor: Redactor
  secrets: SecretResolver
  /** plan runs read only; up runs with dryRun false. */
  dryRun: boolean
  /**
   * Run the checks that act on the outside world: send an email, an event, a test token. Off
   * unless --smoke; without it every check only reads (BUG-76).
   */
  smoke?: boolean
  /**
   * True when a person is at a terminal. Only then does cimiento launch a browser login or ask a
   * question. In --json and agent runs it stops at those points with exit code 2 instead.
   */
  interactive: boolean
  /** Asks the person to pick one option. Absent when nobody is there to answer. */
  choose?: (question: string, options: ChoiceOption[]) => Promise<string>
  /** Asks the person for a line of text, returning defaultValue on an empty answer. */
  ask?: (question: string, defaultValue?: string) => Promise<string>
  /** Opens a page in the person's browser. Absent when nobody is there to look at it. */
  openUrl?: (url: string) => Promise<void>
  /**
   * Walks a person through a step: shows it, waits for Enter, opens the page (or runs open, such
   * as a vendor login that opens it), then waits for Enter when done. The caller verifies after.
   * Absent when nobody is at a terminal.
   */
  walkStep?: (step: PersonStep, open?: () => Promise<void>) => Promise<void>
}

export interface ChoiceOption {
  value: string
  label: string
  /** Shown under the option, for example that it is on a paid plan. */
  warning?: string
}

/** Something cimiento created that down cannot delete, reported with where a person removes it. */
export interface Leftover {
  provider: string
  /** For example: Inngest app. */
  what: string
  id: string
  name: string
  url: string
  hint: string
}

/** Who a billable resource bills to, for the one warning the planner prints per item. */
export interface BillingInfo {
  /** For example: Supabase organization Acme. */
  account: string
  plan: string
  paid: boolean
}

export interface Provider {
  id: string
  fills: Slot[]
  tools: ToolSpec[]
  needsSession: boolean
  planRequirements?: { plan: string; reason: string }

  detect(ctx: Ctx): Promise<Detection>
  login(ctx: Ctx): Promise<Session>
  resources(m: Manifest, state: ProjectState): ResourceSpec[]
  ensure(r: ResourceSpec, ctx: Ctx): Promise<EnsureResult>
  verify(r: ResourceSpec, ctx: Ctx): Promise<CheckResult>
  destroy(r: ResourceSpec, ctx: Ctx): Promise<void>
  /** What a check does to the outside world when it runs under --smoke, said before it runs. */
  smokeEffect?(r: ResourceSpec, m: Manifest): string | undefined
  /** Whether a resource this provider destroys still exists, looked up by its recorded id. */
  presence?(r: ResourceSpec, ctx: Ctx): Promise<Presence>
  outputs(r: ResourceSpec, ctx: Ctx): Promise<Record<string, Output>>
  explain(key: string, lang: Lang): string
  /** Optional beyond spec section 5: the account and plan a billable resource bills to. */
  billing?(r: ResourceSpec, ctx: Ctx): Promise<BillingInfo | undefined>
  /**
   * Optional beyond spec section 5: what down leaves behind because the vendor API cannot delete
   * it. ctx.state is the state before down, after is the state down is about to write.
   */
  leftovers?(ctx: Ctx, after: ProjectState): Promise<Leftover[]>
}

export function isDeferred(v: Value | undefined): v is { deferred: string } {
  return typeof v === 'object' && v !== null && typeof (v as { deferred?: unknown }).deferred === 'string'
}

/**
 * The commit a live site is built from, as the hosting answered. A failed lookup is unknown and is
 * never filled from what state recorded earlier (BUG-87).
 */
export type LiveCommit = { known: true; commit?: string; source?: 'git' | 'cimiento stamp' } | { known: false; reason: string }
