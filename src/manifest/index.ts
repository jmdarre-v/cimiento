// Reading, writing and merging stack.yaml.

import { existsSync, readFileSync, writeFileSync } from 'node:fs'
import { join } from 'node:path'
import { parse as parseYaml, stringify as stringifyYaml } from 'yaml'
import { CimientoError } from '../core/errors'
import { hashManifest } from '../core/state'
import { parseManifest, type Manifest, type ManifestInput } from './schema'

export * from './schema'
export * from './presets'

export const MANIFEST_FILE = 'stack.yaml'

export function manifestPath(cwd: string): string {
  return join(cwd, MANIFEST_FILE)
}

export function manifestExists(cwd: string): boolean {
  return existsSync(manifestPath(cwd))
}

export interface LoadedManifest {
  manifest: Manifest
  raw: string
  hash: string
  path: string
}

export function loadManifest(cwd: string): LoadedManifest {
  const path = manifestPath(cwd)
  if (!existsSync(path)) {
    throw new CimientoError({
      code: 'MANIFEST_NOT_FOUND',
      provider: 'core',
      resource: path,
      message: `No ${MANIFEST_FILE} in ${cwd}.`,
      hint: `Run cimiento init to write a ${MANIFEST_FILE} here, or cimiento new <name> to create a project.`,
      retryable: false,
      needsHuman: true,
    })
  }
  const raw = readFileSync(path, 'utf8')
  let decoded: unknown
  try {
    decoded = parseYaml(raw)
  } catch (err) {
    throw new CimientoError({
      code: 'MANIFEST_INVALID',
      provider: 'core',
      resource: path,
      message: `${MANIFEST_FILE} is not valid yaml: ${err instanceof Error ? err.message : String(err)}`,
      hint: 'Check indentation and quoting. Two spaces per level, no tabs.',
      retryable: false,
      needsHuman: true,
    })
  }
  const manifest = parseManifest(decoded, MANIFEST_FILE)
  return { manifest, raw, hash: hashManifest(raw), path }
}

export function renderManifest(m: Manifest): string {
  const doc: Record<string, unknown> = {
    version: m.version,
    name: m.name,
    slug: m.slug,
    slots: m.slots,
    accounts: pruneUndefined(m.accounts),
    environments: m.environments,
    options: m.options,
    secrets: m.secrets,
    domain: m.domain,
    scaffold: m.scaffold,
  }
  const header = [
    '# cimiento manifest. The only file you edit by hand.',
    '# Values for secrets never live here, only their names and destinations.',
    '',
  ].join('\n')
  return `${header}${stringifyYaml(doc, { lineWidth: 100 })}`
}

export function writeManifest(cwd: string, m: Manifest): string {
  const path = manifestPath(cwd)
  const text = renderManifest(m)
  writeFileSync(path, text, 'utf8')
  return path
}

/** Shallow per section merge, right hand side wins. Used to layer preset then flags. */
export function mergeFragments(...fragments: Partial<ManifestInput>[]): ManifestInput {
  const out: Record<string, unknown> = {}
  for (const fragment of fragments) {
    for (const [key, value] of Object.entries(fragment)) {
      if (value === undefined) continue
      const existing = out[key]
      if (isPlainObject(existing) && isPlainObject(value)) {
        out[key] = mergeDeep(existing, value)
      } else {
        out[key] = value
      }
    }
  }
  return out as ManifestInput
}

function mergeDeep(a: Record<string, unknown>, b: Record<string, unknown>): Record<string, unknown> {
  const out: Record<string, unknown> = { ...a }
  for (const [key, value] of Object.entries(b)) {
    if (value === undefined) continue
    const existing = out[key]
    out[key] = isPlainObject(existing) && isPlainObject(value) ? mergeDeep(existing, value) : value
  }
  return out
}

function isPlainObject(value: unknown): value is Record<string, unknown> {
  return typeof value === 'object' && value !== null && !Array.isArray(value)
}

function pruneUndefined<T extends Record<string, unknown>>(obj: T): Partial<T> {
  const out: Record<string, unknown> = {}
  for (const [key, value] of Object.entries(obj)) {
    if (value === undefined) continue
    out[key] = value
  }
  return out as Partial<T>
}
