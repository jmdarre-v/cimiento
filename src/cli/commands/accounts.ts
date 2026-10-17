// cimiento accounts set <provider>. The one way to change a pinned account. It asks again, the
// same way up asks the first time (for Supabase including creating a new organization), then
// writes the answer to stack.yaml and makes state follow. stack.yaml is the source of truth.

import { readFileSync } from 'node:fs'
import { join } from 'node:path'
import { CimientoError, ExitCode } from '../../core/errors'
import { hashManifest, writeProjectState, type ProjectState } from '../../core/state'
import { ensureVendorSession } from '../../core/toolkit'
import type { ResourceSpec } from '../../core/types'
import { PINS, pinnedValue, reconcilePins, setInManifest } from '../../manifest/pin'
import { githubProvider } from '../../providers/github'
import { chooseSupabaseOrganization, createdOrganizationOutputs } from '../../providers/supabase'
import { chooseCloudflareAccount } from '../../providers/turnstile'
import { chooseVercelTeam } from '../../providers/vercel'
import { flagString } from '../args'
import { openProject, type Session } from '../context'

export async function accountsSetCommand(session: Session): Promise<number> {
  const provider = session.args.positionals[0]
  const pin = provider ? PINS[provider] : undefined
  if (!provider || !pin) {
    throw new CimientoError({
      code: 'MANIFEST_INVALID',
      provider: 'core',
      resource: 'accounts set',
      message: provider ? `cimiento has no account to set for ${provider}.` : 'cimiento accounts set needs a provider.',
      hint: `Run cimiento accounts set with one of: ${Object.keys(PINS).join(', ')}.`,
      retryable: false,
      needsHuman: true,
    })
  }

  const project = openProject(session, { dryRun: false })
  const { ctx } = project
  const to = flagString(session.args.flags, 'to')
  const previous = pinnedValue(ctx.manifest, provider)
  let created: { id: string; name: string } | undefined

  if (provider === 'supabase') {
    const choice = await chooseSupabaseOrganization(ctx, to)
    created = choice?.created
  } else if (provider === 'vercel') {
    await chooseVercelTeam(ctx, to)
  } else if (provider === 'turnstile') {
    await chooseCloudflareAccount(ctx, to)
  } else {
    // A gh login is one account, so the pin follows whoever is logged in.
    const spec: ResourceSpec = { id: 'github.session', kind: 'session', provider: 'github', dependsOn: [], inputs: {} }
    const { account } = await ensureVendorSession(githubProvider, spec, ctx, 'GitHub')
    if (to && to.toLowerCase() !== account.toLowerCase()) {
      throw new CimientoError({
        code: 'SESSION_ACCOUNT_MISMATCH',
        provider: 'github',
        resource: spec.id,
        message: `gh is logged in as ${account}, so cimiento cannot pin accounts.github to ${to}.`,
        hint: `Log in to GitHub as ${to} first; cimiento accounts set github then pins whoever is logged in.`,
        retryable: true,
        needsHuman: true,
      })
    }
    setInManifest(ctx, pin.path, account)
  }

  const value = pinnedValue(ctx.manifest, provider)
  let state: ProjectState = reconcilePins(ctx.manifest, ctx.state)
  if (created) {
    const entry = state.resources[pin.stateId] ?? {}
    const outputs = { ...(entry.outputs ?? {}) }
    for (const [key, out] of Object.entries(createdOrganizationOutputs(created))) outputs[key] = out.value ?? ''
    state = { ...state, resources: { ...state.resources, [pin.stateId]: { ...entry, outputs } } }
  }
  const manifestHash = hashManifest(readFileSync(join(ctx.cwd, 'stack.yaml'), 'utf8'))
  writeProjectState(ctx.cwd, { ...state, manifestHash })

  // Changing the organization does not move a database cimiento already created in the old one.
  const database = state.resources['supabase.project']
  const note =
    provider === 'supabase' && previous && previous !== value && database?.externalId
      ? `The database ${database.externalId} stays in the previous organization ${previous}. cimiento down still deletes it if cimiento created it.`
      : undefined

  if (session.json) {
    session.printer.emit({
      ok: true,
      command: 'accounts set',
      provider,
      path: pin.path.join('.'),
      previous: previous ?? null,
      value: value ?? null,
      ...(created ? { createdOrganization: created } : {}),
      ...(note ? { note } : {}),
    })
  } else {
    session.printer.line(
      previous === value
        ? `${pin.path.join('.')} stays ${value}.`
        : `${pin.path.join('.')} is now ${value}${previous ? `, was ${previous}` : ''}. stack.yaml and state both say so.`,
    )
    if (created) session.printer.line(`Created the Supabase organization ${created.name} (${created.id}).`)
    if (note) session.printer.line(note)
  }
  return ExitCode.ok
}
