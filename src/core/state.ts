// Machine state and project state from spec section 7. No secret value is ever written here.

import { createHash } from 'node:crypto'
import { existsSync, mkdirSync, readFileSync, renameSync, statSync, writeFileSync } from 'node:fs'
import { homedir } from 'node:os'
import { dirname, join } from 'node:path'
import { CimientoError } from './errors'
import type { EnsureResult, Output, ResourceSpec } from './types'

export const STATE_VERSION = 1
export const STALE_AFTER_DAYS = 7

export interface MachineTool {
  version: string
  checkedAt: string
}

export interface MachineSession {
  account: string
  checkedAt: string
  expiresAt?: string
}

export interface MachineState {
  version: number
  os: string
  shell: string
  tools: Record<string, MachineTool>
  sessions: Record<string, MachineSession>
  lang: 'en' | 'es'
  projectsDir: string
  /** Tool versions the person chose to skip, by binary, so the same offer is not made again. */
  toolSkips?: Record<string, string>
}

export interface StateResource {
  externalId?: string
  url?: string
  createdAt?: string
  /**
   * created when cimiento made it, adopted when it already existed. down deletes only what
   * cimiento created: an adopted database may belong to another application.
   */
  origin?: 'created' | 'adopted'
  verifiedAt?: string
  outputs?: Record<string, string>
}

export interface ProjectState {
  version: number
  manifestHash: string
  resources: Record<string, StateResource>
  manualDone: string[]
}

export function machineStatePath(): string {
  const base = process.env.CIMIENTO_CONFIG_DIR ?? join(process.env.XDG_CONFIG_HOME ?? join(homedir(), '.config'), 'cimiento')
  return join(base, 'machine.json')
}

export function projectStatePath(cwd: string): string {
  return join(cwd, '.cimiento', 'state.json')
}

export function emptyMachineState(): MachineState {
  return {
    version: STATE_VERSION,
    os: process.platform,
    shell: basenameOf(process.env.SHELL ?? 'zsh'),
    tools: {},
    sessions: {},
    lang: 'en',
    projectsDir: join(homedir(), 'Code.nosync'),
  }
}

export function emptyProjectState(): ProjectState {
  return { version: STATE_VERSION, manifestHash: '', resources: {}, manualDone: [] }
}

export function readMachineState(path = machineStatePath()): MachineState {
  const parsed = readJson<Partial<MachineState>>(path, 'machine state')
  if (!parsed) return emptyMachineState()
  assertVersion(parsed.version, path)
  return { ...emptyMachineState(), ...parsed, version: STATE_VERSION }
}

export function writeMachineState(state: MachineState, path = machineStatePath()): void {
  writeJson(path, { ...state, version: STATE_VERSION })
}

export function readProjectState(cwd: string): ProjectState {
  const path = projectStatePath(cwd)
  const parsed = readJson<Partial<ProjectState>>(path, 'project state')
  if (!parsed) return emptyProjectState()
  assertVersion(parsed.version, path)
  return {
    version: STATE_VERSION,
    manifestHash: parsed.manifestHash ?? '',
    resources: parsed.resources ?? {},
    manualDone: parsed.manualDone ?? [],
  }
}

export function writeProjectState(cwd: string, state: ProjectState): void {
  const git = join(cwd, '.git')
  const tempDir = existsSync(git) && statSync(git).isDirectory() ? git : dirname(projectStatePath(cwd))
  writeJson(projectStatePath(cwd), {
    version: STATE_VERSION,
    manifestHash: state.manifestHash,
    resources: sortKeys(state.resources),
    manualDone: [...state.manualDone].sort(),
  }, tempDir)
}

/** Records the result of an ensure call. Secret outputs are dropped, never stored. */
/**
 * Whether the resource found by name is the one state recorded. A different id, or no id to
 * compare, means cimiento cannot claim it, so it is adopted and down never deletes it (BUG-57).
 */
export function sameResource(recorded: string | undefined, found: string): boolean {
  return recorded !== undefined && recorded === found
}

export function applyEnsureToState(state: ProjectState, spec: ResourceSpec, result: EnsureResult): ProjectState {
  const now = new Date().toISOString()
  const recorded = state.resources[spec.id]
  // An adopted resource with another id replaces the record: its dates and outputs are not ours.
  const replaced = result.action === 'adopted' && recorded?.externalId !== undefined && result.externalId !== undefined && recorded.externalId !== result.externalId
  const previous = replaced ? undefined : recorded
  const entry: StateResource = {
    ...previous,
    createdAt: previous?.createdAt ?? now,
  }
  if (result.action === 'created') entry.origin = 'created'
  else if (result.action === 'adopted') entry.origin = 'adopted'
  if (result.externalId) entry.externalId = result.externalId
  if (result.url) entry.url = result.url
  const outputs = { ...(previous?.outputs ?? {}) }
  for (const [key, out] of Object.entries(result.outputs ?? {})) {
    if (out.secret) continue
    if (out.value === undefined) continue
    outputs[key] = out.value
  }
  if (Object.keys(outputs).length > 0) entry.outputs = outputs
  const next: ProjectState = { ...state, resources: { ...state.resources, [spec.id]: entry } }
  if (spec.kind === 'manual' && !next.manualDone.includes(spec.id)) {
    next.manualDone = [...next.manualDone, spec.id]
  }
  return next
}

export function markVerified(state: ProjectState, id: string, at = new Date().toISOString()): ProjectState {
  const existing = state.resources[id] ?? {}
  return { ...state, resources: { ...state.resources, [id]: { ...existing, verifiedAt: at } } }
}

export function isStale(entry: StateResource | undefined, now = Date.now()): boolean {
  if (!entry?.verifiedAt) return true
  const age = now - Date.parse(entry.verifiedAt)
  return !Number.isFinite(age) || age > STALE_AFTER_DAYS * 24 * 60 * 60 * 1000
}

/** Reads a non secret output recorded by an earlier ensure, for resolving deferred values. */
export function outputFromState(state: ProjectState, ref: string): string | undefined {
  const [id, key] = splitRef(ref)
  const entry = state.resources[id]
  if (!entry) return undefined
  if (key === 'url') return entry.url
  if (key === 'externalId') return entry.externalId
  return entry.outputs?.[key]
}

export function splitRef(ref: string): [string, string] {
  const idx = ref.lastIndexOf(':')
  if (idx < 0) return [ref, 'url']
  return [ref.slice(0, idx), ref.slice(idx + 1)]
}

export function hashManifest(raw: unknown): string {
  const text = typeof raw === 'string' ? raw : JSON.stringify(raw)
  return createHash('sha256').update(text).digest('hex')
}

export function outputsToStrings(outputs: Record<string, Output>): Record<string, string> {
  const out: Record<string, string> = {}
  for (const [key, value] of Object.entries(outputs)) {
    if (value.secret || value.value === undefined) continue
    out[key] = value.value
  }
  return out
}

function readJson<T>(path: string, what: string): T | undefined {
  if (!existsSync(path)) return undefined
  try {
    return JSON.parse(readFileSync(path, 'utf8')) as T
  } catch (err) {
    throw new CimientoError({
      code: 'STATE_UNREADABLE',
      provider: 'core',
      resource: path,
      message: `Could not read ${what} at ${path}: ${err instanceof Error ? err.message : String(err)}`,
      hint: `Delete ${path} and run cimiento plan again. State is rebuilt from the providers.`,
      retryable: false,
      needsHuman: true,
    })
  }
}

/**
 * Written to a temporary file, then renamed over the old one, so a run killed mid write never
 * leaves a half written state file. The temporary file of a project state lives in .git when the
 * project has one, where git add never picks it up.
 */
function writeJson(path: string, value: unknown, tempDir = dirname(path)): void {
  mkdirSync(dirname(path), { recursive: true })
  const temp = join(tempDir, `.${basenameOf(path)}.${process.pid}.tmp`)
  writeFileSync(temp, `${JSON.stringify(value, null, 2)}\n`, 'utf8')
  renameSync(temp, path)
}

function assertVersion(version: number | undefined, path: string): void {
  if (version === undefined || version === STATE_VERSION) return
  throw new CimientoError({
    code: 'STATE_VERSION_UNSUPPORTED',
    provider: 'core',
    resource: path,
    message: `State file ${path} has version ${version}, this build understands version ${STATE_VERSION}.`,
    hint: 'Upgrade cimiento, or delete the state file and let cimiento plan rebuild it by adoption.',
    retryable: false,
    needsHuman: true,
  })
}

function sortKeys<T>(obj: Record<string, T>): Record<string, T> {
  const out: Record<string, T> = {}
  for (const key of Object.keys(obj).sort()) out[key] = obj[key]
  return out
}

function basenameOf(p: string): string {
  const parts = p.split('/')
  return parts[parts.length - 1] || p
}
