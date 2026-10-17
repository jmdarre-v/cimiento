// Just enough semver for tool version ranges. Ranges look like ">=2.40.0" or "22.x".

export interface Semver {
  major: number
  minor: number
  patch: number
}

export function parseVersion(text: string): Semver | undefined {
  const match = /(\d+)\.(\d+)(?:\.(\d+))?/.exec(text)
  if (!match) return undefined
  return { major: Number(match[1]), minor: Number(match[2]), patch: Number(match[3] ?? 0) }
}

export function compareVersions(a: Semver, b: Semver): number {
  if (a.major !== b.major) return a.major - b.major
  if (a.minor !== b.minor) return a.minor - b.minor
  return a.patch - b.patch
}

/** Supports ">=x.y.z", ">x.y.z", "x.y.z", "x.x" and "*". Unknown ranges accept anything. */
export function satisfies(versionText: string, range: string): boolean {
  const version = parseVersion(versionText)
  if (!version) return false
  const trimmed = range.trim()
  if (trimmed === '*' || trimmed === '') return true

  const wildcard = /^(\d+)\.x(?:\.x)?$/.exec(trimmed)
  if (wildcard) return version.major === Number(wildcard[1])

  const operator = /^(>=|>|<=|<|=)?\s*(.+)$/.exec(trimmed)
  if (!operator) return true
  const bound = parseVersion(operator[2])
  if (!bound) return true
  const cmp = compareVersions(version, bound)
  switch (operator[1]) {
    case '>':
      return cmp > 0
    case '<':
      return cmp < 0
    case '<=':
      return cmp <= 0
    case '=':
    case undefined:
      return cmp === 0
    default:
      return cmp >= 0
  }
}

export function formatVersion(v: Semver): string {
  return `${v.major}.${v.minor}.${v.patch}`
}
