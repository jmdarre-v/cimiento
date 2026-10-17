// Where a secret value comes from: a hidden prompt, the environment, the macOS keychain or
// 1Password. Every external command goes through io, and a value never reaches argv.

import { CimientoError } from '../core/errors'
import type { Io } from '../core/io'
import type { SecretDecl, SecretSource } from '../manifest/schema'
import { askHidden } from './prompt'
import type { PersonStep } from '../core/person'
import { secretStep } from '../core/person-steps'

export interface SourceContext {
  projectSlug: string
  interactive: boolean
  io: Io
  declaration?: SecretDecl
  /** Reads a value at a hidden prompt. Tests replace it; a real run uses the terminal. */
  promptHidden?: (question: string) => Promise<string>
  /** Walks the person to the page where the value is created, before the hidden prompt. */
  walkStep?: (step: PersonStep, open?: () => Promise<void>) => Promise<void>
}

export interface Source {
  id: SecretSource
  available: boolean
  read(name: string, ctx: SourceContext): Promise<string | undefined>
  /** Stores a new value where the source reads it from, for secret set and rotate. */
  write?(name: string, value: string, ctx: SourceContext): Promise<void>
  /** Deletes the stored value, for secret remove. Only sources cimiento itself writes to have it. */
  remove?(name: string, ctx: SourceContext): Promise<boolean>
}

async function hidden(name: string, ctx: SourceContext): Promise<string | undefined> {
  if (!ctx.interactive) return undefined
  // Where to create the key and what to call it, before the prompt that takes it (BUG-41).
  const step = secretStep(name, ctx.projectSlug, ctx.declaration?.url)
  if (step && ctx.walkStep) await ctx.walkStep(step)
  const value = await (ctx.promptHidden ?? askHidden)(`Value for ${name} (input is hidden): `)
  return value.trim() || undefined
}

export const promptSource: Source = {
  id: 'prompt',
  available: true,
  read: hidden,
}

export const envSource: Source = {
  id: 'env',
  available: true,
  async read(name: string): Promise<string | undefined> {
    const value = process.env[name]
    return value && value.trim() ? value : undefined
  },
}

/** Spec section 8: service cimiento, account <project>/<NAME>. */
export const KEYCHAIN_SERVICE = 'cimiento'

export function keychainAccount(projectSlug: string, name: string): string {
  return `${projectSlug}/${name}`
}

/** One argument for security -i, which reads double quoted strings with backslash escapes. */
function quoted(value: string): string {
  return `"${value.replace(/\\/g, '\\\\').replace(/"/g, '\\"')}"`
}

export const keychainSource: Source = {
  id: 'keychain',
  available: true,
  async read(name: string, ctx: SourceContext): Promise<string | undefined> {
    const account = keychainAccount(ctx.projectSlug, name)
    const found = await ctx.io.exec('security', ['find-generic-password', '-s', KEYCHAIN_SERVICE, '-a', account, '-w'])
    if (found.code === 0) {
      const value = found.stdout.replace(/\n$/, '')
      if (value) return value
    }
    // Not stored yet. A person at a terminal types it once; it goes to the keychain, so doctor,
    // rotate and every later run read it from there without asking again.
    const typed = await hidden(name, ctx)
    if (typed === undefined) return undefined
    await keychainSource.write!(name, typed, ctx)
    return typed
  },
  async write(name: string, value: string, ctx: SourceContext): Promise<void> {
    const account = keychainAccount(ctx.projectSlug, name)
    // security -i reads the command from stdin, so the value never appears in the process list.
    const command = `add-generic-password -U -s ${quoted(KEYCHAIN_SERVICE)} -a ${quoted(account)} -w ${quoted(value)}\n`
    const result = await ctx.io.exec('security', ['-i'], { input: command })
    if (result.code !== 0 || /error|could not/i.test(result.stderr)) {
      throw new CimientoError({
        code: 'SECRET_SOURCE_UNAVAILABLE',
        provider: 'secrets',
        resource: `secret.${name}`,
        message: `Storing ${name} in the macOS keychain failed: ${result.stderr.trim().slice(0, 200) || `exit code ${result.code}`}`,
        hint: `Unlock the login keychain and run cimiento secret set ${name} again. cimiento stores it under service ${KEYCHAIN_SERVICE}, account ${account}.`,
        retryable: true,
        needsHuman: true,
      })
    }
  },
}

keychainSource.remove = async (name: string, ctx: SourceContext): Promise<boolean> => {
  const result = await ctx.io.exec('security', ['delete-generic-password', '-s', KEYCHAIN_SERVICE, '-a', keychainAccount(ctx.projectSlug, name)])
  return result.code === 0
}

/** The 1Password CLI. Installed with Homebrew in a terminal, where the desktop app can unlock it. */
async function ensureOp(name: string, ctx: SourceContext): Promise<void> {
  const version = await ctx.io.exec('op', ['--version']).catch(() => ({ code: 127, stdout: '', stderr: '' }))
  if (version.code === 0) return
  if (ctx.interactive) {
    const installed = await ctx.io.interactive('brew', ['install', '--cask', '1password-cli'])
    if (installed.code === 0) return
  }
  throw new CimientoError({
    code: 'SECRET_SOURCE_UNAVAILABLE',
    provider: 'secrets',
    resource: `secret.${name}`,
    message: `stack.yaml reads ${name} from 1Password, and the 1Password CLI (op) is not installed.`,
    hint: `Run cimiento up in a terminal. It installs the 1Password CLI with Homebrew, and 1Password asks you to unlock it the first time cimiento reads ${name}.`,
    retryable: true,
    needsHuman: true,
  })
}

export const onePasswordSource: Source = {
  id: '1password',
  available: true,
  async read(name: string, ctx: SourceContext): Promise<string | undefined> {
    const ref = ctx.declaration?.ref
    if (!ref) return undefined
    await ensureOp(name, ctx)
    // op read prints the value on stdout and nothing else; it stays in memory from here on.
    const result = await ctx.io.exec('op', ['read', '--no-newline', ref], { timeoutMs: 120_000 })
    if (result.code === 0 && result.stdout) return result.stdout
    if (/not signed in|sign in|authorization|unlock|session/i.test(result.stderr)) {
      throw new CimientoError({
        code: 'SECRET_SOURCE_UNAVAILABLE',
        provider: 'secrets',
        resource: `secret.${name}`,
        message: `1Password is locked or signed out, so cimiento cannot read ${name}.`,
        hint: `Run cimiento up in a terminal. 1Password asks you to unlock it, then cimiento reads ${ref}.`,
        retryable: true,
        needsHuman: true,
      })
    }
    return undefined
  },
}

export const SOURCES: Record<SecretSource, Source> = {
  prompt: promptSource,
  env: envSource,
  keychain: keychainSource,
  '1password': onePasswordSource,
}
