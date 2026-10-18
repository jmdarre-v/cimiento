// What down deletes is named by the id the provider gave when cimiento made it, never by a name.
// A name can be taken again by a resource cimiento did not make; an id cannot (BUG-82 to 84).

import { CimientoError } from './errors'
import type { Ctx, ResourceSpec } from './types'

/** The recorded id of a resource down is about to delete, or a refusal when state has none. */
export function recordedId(ctx: Ctx, spec: ResourceSpec, what: string): string {
  const id = ctx.state.resources[spec.id]?.externalId
  if (id) return id
  throw new CimientoError({
    code: 'DOWN_ID_MISSING',
    provider: spec.provider,
    resource: spec.id,
    message: `State has no id for ${what}, so cimiento cannot prove which ${what} it made and deletes nothing.`,
    hint: `Run cimiento up once; it records the id when it can rebuild it. If ${what} is already gone, or is not one cimiento made, run cimiento down --release ${spec.id} to stop tracking it without touching the provider.`,
    retryable: false,
    needsHuman: true,
  })
}

/** The refusal for a name that now answers with another id than the one recorded. */
export function identityMismatch(spec: ResourceSpec, what: string, recorded: string, found: string): CimientoError {
  return new CimientoError({
    code: 'DOWN_IDENTITY_MISMATCH',
    provider: spec.provider,
    resource: spec.id,
    message: `${what} now has the id ${found}, not ${recorded}, the one cimiento made. It is another resource with the same name, so cimiento leaves it alone and keeps its record.`,
    hint: `If the one cimiento made was deleted or renamed, run cimiento down --release ${spec.id} to stop tracking it; nothing is deleted. Delete ${what} yourself only if you are sure it is not in use.`,
    retryable: false,
    needsHuman: true,
  })
}
