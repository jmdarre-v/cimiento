// The value an env binding should hold, when cimiento has it without asking anyone (BUG-90, BUG-91):
// a literal the plan resolved, a secret this run already read, or one whose source reads without a
// person, the environment or the keychain. A prompt source is never asked just to compare.

import type { Ctx, ResourceSpec, Value } from '../core/types'

function str(value: Value | undefined): string {
  return typeof value === 'string' ? value : ''
}

export async function knownEnvValue(spec: ResourceSpec, ctx: Ctx): Promise<string | undefined> {
  const key = str(spec.inputs.key)
  if (str(spec.inputs.source) === 'literal') return str(spec.inputs.value) || undefined
  if (ctx.secrets.has?.(key)) return ctx.secrets.get(key)
  const source = ctx.manifest.secrets.find((s) => s.name === key)?.source
  if (source !== 'env' && source !== 'keychain' && source !== 'generated') return undefined
  return ctx.secrets.get(key).catch(() => undefined)
}
