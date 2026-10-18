// Where a declared secret lands, as resource ids, for every sink in spec section 8:
//   hosting   <vercel|netlify>.env.<NAME>.<environment>
//   database  supabase.secret.<NAME>
//   ci        github.secret.<NAME>
// One place, so secret set, rotate, check and the planner agree on what carries a secret.

export const HOSTING_ENV_PROVIDERS = ['vercel', 'netlify'] as const

export function hostingEnvId(hosting: string, key: string, environment: string): string {
  return `${hosting}.env.${key}.${environment}`
}

export function databaseSecretId(key: string): string {
  return `supabase.secret.${key}`
}

export function ciSecretId(key: string): string {
  return `github.secret.${key}`
}

const HOSTING_ENV = /^(vercel|netlify)\.env\.([A-Z][A-Z0-9_]*)\.([a-z]+)$/

export function parseHostingEnvId(id: string): { provider: string; key: string; environment: string } | undefined {
  const match = HOSTING_ENV.exec(id)
  return match ? { provider: match[1], key: match[2], environment: match[3] } : undefined
}

export function isHostingEnvId(id: string): boolean {
  return HOSTING_ENV.test(id)
}

/** The secret name a sink resource carries, whichever sink it is. */
export function sinkSecretName(id: string): string | undefined {
  const env = parseHostingEnvId(id)
  if (env) return env.key
  const match = /^(?:supabase|github)\.secret\.([A-Z][A-Z0-9_]*)$/.exec(id)
  return match?.[1]
}
