// The secret store. Values live in memory for the length of one run, are registered with the
// redactor the moment they are known, and are never written to state, logs or json output.

import { CimientoError } from '../core/errors'
import { RealIo, type Io } from '../core/io'
import type { PersonStep } from '../core/person'
import type { Redactor } from '../core/redact'
import type { ResourceSpec, SecretResolver } from '../core/types'
import type { Manifest, SecretDecl, Sink } from '../manifest/schema'
import { SOURCES, type SourceContext } from './sources'

export * from './sources'
export * from './prompt'

export interface SecretStoreOptions {
  interactive: boolean
  /** Pre-seeded values, used by tests and by secret set. */
  values?: Record<string, string>
  /** Where the keychain and 1password sources run their commands. Tests pass the fake cloud. */
  io?: Io
  /** Replaces the terminal's hidden prompt, for tests. */
  promptHidden?: (question: string) => Promise<string>
  walkStep?: (step: PersonStep, open?: () => Promise<void>) => Promise<void>
}

export class SecretStore implements SecretResolver {
  private cache = new Map<string, string>()

  constructor(
    private readonly manifest: Manifest,
    private readonly redactor: Redactor,
    private readonly options: SecretStoreOptions,
  ) {
    for (const decl of manifest.secrets) redactor.addName(decl.name)
    for (const [name, value] of Object.entries(options.values ?? {})) this.set(name, value)
  }

  set(name: string, value: string): void {
    this.cache.set(name, value)
    this.redactor.addName(name)
    this.redactor.addValue(value)
  }

  has(name: string): boolean {
    return this.cache.has(name)
  }

  async get(name: string): Promise<string | undefined> {
    const cached = this.cache.get(name)
    if (cached !== undefined) return cached
    const decl = this.declaration(name)
    const source = SOURCES[decl?.source ?? 'env']
    const value = await source.read(name, this.sourceContext(name))
    if (value === undefined) return undefined
    this.set(name, value)
    return value
  }

  private sourceContext(name: string): SourceContext {
    return {
      projectSlug: this.manifest.slug,
      interactive: this.options.interactive,
      io: this.options.io ?? new RealIo(),
      declaration: this.declaration(name),
      ...(this.options.promptHidden ? { promptHidden: this.options.promptHidden } : {}),
      ...(this.options.walkStep ? { walkStep: this.options.walkStep } : {}),
    }
  }

  /**
   * A fresh value, for secret set and secret rotate. prompt and keychain secrets are typed again at
   * a hidden prompt, and a keychain secret is stored over the old one. env and 1password secrets
   * are read again from where they live, which is where a person rotates them.
   */
  async prompt(name: string): Promise<string> {
    const decl = this.declaration(name)
    const sourceId = decl?.source ?? 'prompt'
    const ctx = this.sourceContext(name)
    let value: string | undefined
    if (sourceId === 'prompt' || sourceId === 'keychain') {
      value = await SOURCES.prompt.read(name, ctx)
      if (value !== undefined && sourceId === 'keychain') await SOURCES.keychain.write!(name, value, ctx)
    } else {
      value = await SOURCES[sourceId].read(name, ctx)
    }
    if (value === undefined) {
      throw new CimientoError({
        code: 'SECRET_MISSING',
        provider: 'secrets',
        resource: `secret.${name}`,
        message: `No value for ${name} from the ${decl?.source ?? 'prompt'} source.`,
        hint: this.options.interactive
          ? `Run cimiento secret set ${name} again and type the value at the hidden prompt.`
          : `This run has no terminal for the hidden prompt. Run cimiento secret set ${name} in a terminal in the project folder.`,
        retryable: true,
        needsHuman: true,
      })
    }
    this.set(name, value)
    return value
  }

  /** Deletes the value from the declared source when cimiento owns that store. */
  async removeStored(name: string): Promise<boolean> {
    const source = SOURCES[this.declaration(name)?.source ?? 'prompt']
    this.cache.delete(name)
    return source.remove ? source.remove(name, this.sourceContext(name)) : false
  }

  declaration(name: string): SecretDecl | undefined {
    return this.manifest.secrets.find((s) => s.name === name)
  }

  /** The names a manifest declares for a given sink. */
  namesForSink(sink: Sink): string[] {
    return this.manifest.secrets.filter((s) => s.sinks.includes(sink)).map((s) => s.name)
  }
}

/** The sinks this build can write to. Database and ci land in Goal 2. */
export const AVAILABLE_SINKS: Sink[] = ['hosting']

export function assertSinkAvailable(sink: Sink, name: string): void {
  if (AVAILABLE_SINKS.includes(sink)) return
  throw new CimientoError({
    code: 'SECRET_SINK_UNAVAILABLE',
    provider: 'secrets',
    resource: `secret.${name}`,
    message: `stack.yaml sends ${name} to the ${sink} sink, and this build of cimiento only writes to ${AVAILABLE_SINKS.join(', ')}.`,
    hint: `Remove ${sink} from the sinks of ${name} in stack.yaml, or upgrade to a build that ships it.`,
    retryable: false,
    needsHuman: true,
  })
}

/** The resource ids that carry a secret to its sinks, so secret set can apply just those. */
export function sinkSpecsFor(name: string, specs: ResourceSpec[]): ResourceSpec[] {
  return specs.filter((s) => s.id.startsWith(`vercel.env.${name}.`))
}

/** Every secret carrying resource, for secret check. */
export function allSinkSpecs(manifest: Manifest, specs: ResourceSpec[]): ResourceSpec[] {
  const names = new Set(manifest.secrets.map((s) => s.name))
  return specs.filter((s) => {
    if (!s.id.startsWith('vercel.env.')) return false
    const key = s.id.split('.')[2]
    return key !== undefined && names.has(key)
  })
}
