// A small argument parser. The spec asks for no CLI framework, and the surface is small enough
// that a hand written parser is clearer than a dependency.

export interface ParsedArgs {
  command: string
  sub?: string
  positionals: string[]
  flags: Record<string, string | boolean>
}

const GLOBAL_BOOLEANS = new Set([
  'guided',
  'json',
  'yes',
  'allow-billing',
  'help',
  'version',
  'force',
  'no-verify',
])

const COMMANDS_WITH_SUB = new Set(['env', 'secret', 'accounts', 'domain'])

export function parseArgs(argv: string[]): ParsedArgs {
  const flags: Record<string, string | boolean> = {}
  const positionals: string[] = []

  for (let i = 0; i < argv.length; i += 1) {
    const token = argv[i]
    if (token === '--') {
      positionals.push(...argv.slice(i + 1))
      break
    }
    if (token.startsWith('--')) {
      const body = token.slice(2)
      const eq = body.indexOf('=')
      if (eq >= 0) {
        flags[body.slice(0, eq)] = body.slice(eq + 1)
        continue
      }
      const next = argv[i + 1]
      if (GLOBAL_BOOLEANS.has(body) || next === undefined || next.startsWith('-')) {
        flags[body] = true
        continue
      }
      flags[body] = next
      i += 1
      continue
    }
    if (token.startsWith('-') && token.length > 1) {
      const short = token.slice(1)
      if (short === 'h') flags.help = true
      else if (short === 'v') flags.version = true
      else if (short === 'y') flags.yes = true
      else flags[short] = true
      continue
    }
    positionals.push(token)
  }

  const command = positionals.shift() ?? 'help'
  let sub: string | undefined
  if (COMMANDS_WITH_SUB.has(command)) sub = positionals.shift()
  return { command, sub, positionals, flags }
}

export function flagString(flags: Record<string, string | boolean>, name: string): string | undefined {
  const value = flags[name]
  return typeof value === 'string' ? value : undefined
}

export function flagBool(flags: Record<string, string | boolean>, name: string): boolean {
  return flags[name] === true || flags[name] === 'true'
}

export function flagList(flags: Record<string, string | boolean>, name: string): string[] {
  const value = flagString(flags, name)
  if (!value) return []
  return value
    .split(',')
    .map((s) => s.trim())
    .filter(Boolean)
}
