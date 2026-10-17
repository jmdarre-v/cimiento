// Secret values never reach a log line, a json payload or the state file.

const MASK = '****'

export class Redactor {
  private values = new Set<string>()
  private names = new Set<string>()

  /** Registers a secret value so every later render replaces it with ****. */
  addValue(value: string | undefined): void {
    if (!value) return
    if (value.length < 4) return
    this.values.add(value)
  }

  /** Registers a declared secret name so NAME=value renders as NAME=****. */
  addName(name: string | undefined): void {
    if (!name) return
    this.names.add(name)
  }

  get size(): number {
    return this.values.size
  }

  redact(text: string): string {
    let out = text
    for (const value of this.values) {
      out = out.split(value).join(MASK)
    }
    for (const name of this.names) {
      const pattern = new RegExp(`(${escapeRegExp(name)}\\s*[=:]\\s*)(?!\\*\\*\\*\\*)("?)[^\\s"',}]+("?)`, 'g')
      out = out.replace(pattern, `$1${MASK}`)
    }
    return out
  }

  /** Deep copy with every secret value and every declared secret name masked. */
  redactValue<T>(value: T): T {
    return this.walk(value) as T
  }

  private walk(value: unknown): unknown {
    if (typeof value === 'string') return this.redact(value)
    if (Array.isArray(value)) return value.map((v) => this.walk(v))
    if (value && typeof value === 'object') {
      const out: Record<string, unknown> = {}
      for (const [k, v] of Object.entries(value as Record<string, unknown>)) {
        out[k] = this.names.has(k) && typeof v === 'string' ? MASK : this.walk(v)
      }
      return out
    }
    return value
  }
}

function escapeRegExp(s: string): string {
  return s.replace(/[.*+?^${}()|[\]\\]/g, '\\$&')
}

export const REDACTION_MASK = MASK
