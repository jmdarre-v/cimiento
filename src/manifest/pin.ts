// Writes an account choice back into stack.yaml. Spec section 4 says accounts pin which account
// each provider must be logged in as, so the first time cimiento learns or asks for one, it
// records it. Every later run then refuses to deploy anywhere else.

import { existsSync, readFileSync, writeFileSync } from 'node:fs'
import { parseDocument } from 'yaml'
import { CimientoError } from '../core/errors'
import type { ProjectState } from '../core/state'
import type { ChoiceOption, Ctx } from '../core/types'
import type { PersonStep } from '../core/person'
import type { Manifest } from './schema'
import { manifestPath } from './index'

/**
 * Sets one value in stack.yaml, keeping the person's comments and ordering, and mirrors it into
 * ctx.manifest so the rest of the run sees it. Returns false when a value was already there.
 * Never writes during plan, which is read only.
 */
export function pinInManifest(ctx: Ctx, path: string[], value: string): boolean {
  const current = readPath(ctx.manifest as unknown as Record<string, unknown>, path)
  if (current !== undefined && current !== null && current !== '') return false
  if (ctx.dryRun) return false

  setPath(ctx.manifest as unknown as Record<string, unknown>, path, value)

  const file = manifestPath(ctx.cwd)
  if (!existsSync(file)) return true
  const doc = parseDocument(readFileSync(file, 'utf8'))
  // Pinning only fills an empty slot. A value already in the file is the person's decision, and
  // a session that disagrees with it is SESSION_ACCOUNT_MISMATCH, never a silent overwrite.
  const onDisk = doc.getIn(path)
  if (onDisk !== undefined && onDisk !== null && onDisk !== '') return false
  doc.setIn(path, value)
  writeFileSync(file, doc.toString({ lineWidth: 100 }), 'utf8')
  ctx.logger.log({
    level: 'info',
    event: 'pinned',
    message: `stack.yaml now pins ${path.join('.')} to ${value}`,
  })
  return true
}

function readPath(obj: Record<string, unknown>, path: string[]): unknown {
  let node: unknown = obj
  for (const key of path) {
    if (!node || typeof node !== 'object') return undefined
    node = (node as Record<string, unknown>)[key]
  }
  return node
}

function setPath(obj: Record<string, unknown>, path: string[], value: string): void {
  let node = obj
  for (const key of path.slice(0, -1)) {
    if (!node[key] || typeof node[key] !== 'object') node[key] = {}
    node = node[key] as Record<string, unknown>
  }
  node[path[path.length - 1]] = value
}

/**
 * Settles which account a provider works in. One option is pinned without asking, several are
 * put to the person, and with nobody at the terminal the run stops as a step waiting on a person
 * rather than guessing, because the choice decides who owns and who pays for what gets created.
 */
export async function chooseAndPin(
  ctx: Ctx,
  args: {
    provider: string
    resource: string
    what: string
    path: string[]
    options: ChoiceOption[]
    /** The person step shown before the question, with the page to compare the options on. */
    step?: PersonStep
  },
): Promise<string | undefined> {
  const { options } = args
  if (options.length === 0) return undefined
  if (options.length === 1) {
    pinInManifest(ctx, args.path, options[0].value)
    return options[0].value
  }
  if (ctx.interactive && ctx.choose) {
    if (args.step) await ctx.walkStep?.(args.step)
    const picked = await ctx.choose(`Which ${args.what} should this project use?`, options)
    pinInManifest(ctx, args.path, picked)
    return picked
  }
  throw new CimientoError({
    code: 'ACCOUNT_CHOICE_NEEDED',
    provider: args.provider,
    resource: args.resource,
    message: `You have ${options.length} ${args.what}s and stack.yaml does not say which one this project uses: ${options
      .map((o) => `${o.label} (${o.value})`)
      .join(', ')}.`,
    hint: `Run cimiento up in a terminal in ${ctx.cwd} and pick one when it asks. cimiento writes the choice to ${args.path.join('.')} in stack.yaml so it is never asked again.`,
    retryable: true,
    needsHuman: true,
  })
}

/**
 * Overwrites a pinned value, in stack.yaml and in ctx.manifest. Only cimiento accounts set calls
 * this: changing an account is always an explicit act by the person, never a side effect of up.
 */
export function setInManifest(ctx: Ctx, path: string[], value: string): void {
  setPath(ctx.manifest as unknown as Record<string, unknown>, path, value)
  const file = manifestPath(ctx.cwd)
  if (!existsSync(file)) return
  const doc = parseDocument(readFileSync(file, 'utf8'))
  doc.setIn(path, value)
  writeFileSync(file, doc.toString({ lineWidth: 100 }), 'utf8')
}

/** Where each provider's account is pinned in stack.yaml, and where state keeps a copy of it. */
export const PINS: Record<string, { path: string[]; stateId: string; outputKey: string; what: string }> = {
  github: { path: ['accounts', 'github'], stateId: 'github.session', outputKey: 'account', what: 'GitHub account' },
  vercel: { path: ['accounts', 'vercel'], stateId: 'vercel.session', outputKey: 'team', what: 'Vercel team' },
  supabase: {
    path: ['options', 'supabase', 'organization_id'],
    stateId: 'supabase.session',
    outputKey: 'organizationId',
    what: 'Supabase organization',
  },
  turnstile: { path: ['accounts', 'cloudflare'], stateId: 'turnstile.session', outputKey: 'account', what: 'Cloudflare account' },
  netlify: { path: ['accounts', 'netlify'], stateId: 'netlify.session', outputKey: 'team', what: 'Netlify team' },
  neon: { path: ['accounts', 'neon'], stateId: 'neon.session', outputKey: 'organizationId', what: 'Neon organization' },
}

export function pinnedValue(m: Manifest, provider: string): string | undefined {
  const pin = PINS[provider]
  if (!pin) return undefined
  const value = readPath(m as unknown as Record<string, unknown>, pin.path)
  return typeof value === 'string' && value ? value : undefined
}

/**
 * stack.yaml is the source of truth for every pinned account, and state follows it. A value the
 * person removed or changed in stack.yaml is removed or changed in state too, so an old choice can
 * never linger there and quietly win.
 */
export function reconcilePins(m: Manifest, state: ProjectState): ProjectState {
  let next = state
  for (const [provider, pin] of Object.entries(PINS)) {
    const entry = next.resources[pin.stateId]
    if (!entry) continue
    const wanted = pinnedValue(m, provider)
    const outputs = { ...(entry.outputs ?? {}) }
    if (outputs[pin.outputKey] === wanted) continue
    if (wanted) outputs[pin.outputKey] = wanted
    else delete outputs[pin.outputKey]
    const updated = { ...entry, outputs }
    // The Supabase session records the organization as its external id as well.
    if (provider === 'supabase') {
      if (wanted) updated.externalId = wanted
      else delete updated.externalId
    }
    next = { ...next, resources: { ...next.resources, [pin.stateId]: updated } }
  }
  return next
}
