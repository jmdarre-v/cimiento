// Presets are manifest fragments, merged over the defaults by cimiento new and cimiento init.

import { SLOT_SECRET_NAMES, type ManifestInput } from './schema'

export type PresetName = 'fullstack' | 'designer'

export const PRESET_NAMES: PresetName[] = ['fullstack', 'designer']

/**
 * The fullstack preset is the spec section 4 fragment without its per-project secrets: the stack needs
 * ANTHROPIC_API_KEY for the ai slot, and a key one project needs belongs in that project's
 * stack.yaml, never in a preset. It reads from the macOS keychain, so a value typed once at the
 * hidden prompt is there for doctor and rotate.
 */
const fullstack: Omit<ManifestInput, 'name'> = {
  version: 1,
  slots: {
    repo: 'github',
    hosting: 'vercel',
    database: 'supabase',
    auth: 'supabase',
    jobs: 'inngest',
    bot_protection: 'turnstile',
    email: 'none',
    payments: 'none',
    analytics: 'none',
    ai: 'anthropic',
  },
  accounts: { supabase: 'via-hosting' },
  environments: ['dev', 'preview', 'production'],
  options: {
    github: { visibility: 'private' },
    vercel: { plan: 'hobby', deployment_protection: 'standard', framework: 'nextjs' },
    supabase: { region: 'us-east-1', migrations: 'supabase/migrations' },
    turnstile: { mode: 'managed' },
  },
  secrets: [
    { name: 'ANTHROPIC_API_KEY', sinks: ['hosting'], environments: ['preview', 'production'], source: 'keychain' },
  ],
  domain: null,
  scaffold: { template: 'nextjs-app', claude_md: true, ci: true },
}

/** The designer preset sets hosting and repo only. Everything else stays none. */
const designer: Omit<ManifestInput, 'name'> = {
  version: 1,
  slots: {
    repo: 'github',
    hosting: 'vercel',
    database: 'none',
    auth: 'none',
    jobs: 'none',
    bot_protection: 'none',
    email: 'none',
    payments: 'none',
    analytics: 'none',
    ai: 'none',
  },
  accounts: { supabase: 'via-hosting' },
  environments: ['preview', 'production'],
  options: {
    github: { visibility: 'private' },
    vercel: { plan: 'hobby', deployment_protection: 'standard', framework: 'nextjs' },
  },
  secrets: [],
  domain: null,
  scaffold: { template: 'designer-site', claude_md: true, ci: true },
}

const PRESETS: Record<PresetName, Omit<ManifestInput, 'name'>> = { fullstack, designer }

export function isPresetName(value: string): value is PresetName {
  return (PRESET_NAMES as string[]).includes(value)
}

/** Returns a deep copy so callers can mutate the fragment before parsing. */
export function presetFragment(name: PresetName): Omit<ManifestInput, 'name'> {
  return structuredClone(PRESETS[name])
}

/** The fragment used when no preset is given: an empty project with every slot none. */
export function emptyFragment(): Omit<ManifestInput, 'name'> {
  return {
    version: 1,
    slots: {
      repo: 'none',
      hosting: 'none',
      database: 'none',
      auth: 'none',
      jobs: 'none',
      bot_protection: 'none',
      email: 'none',
      payments: 'none',
      analytics: 'none',
      ai: 'none',
    },
    accounts: { supabase: 'via-hosting' },
    environments: ['dev', 'preview', 'production'],
    options: {},
    secrets: [],
    domain: null,
    scaffold: { template: 'none', claude_md: true, ci: false },
  }
}

/**
 * Fills in what a slot choice implies, so --email resend works without editing stack.yaml first:
 * each provider's key is declared as a keychain secret for the hosting env, and Supabase on Netlify
 * uses the direct path, because via-hosting is the Vercel Marketplace.
 */
export function completeFragment(input: ManifestInput): ManifestInput {
  const out = structuredClone(input)
  const slots = (out.slots ?? {}) as Record<string, string | undefined>
  const hosting = slots.hosting ?? 'none'
  if (hosting === 'netlify' && (slots.database === 'supabase' || slots.auth === 'supabase')) {
    out.accounts = { ...(out.accounts ?? {}), supabase: 'direct' }
  }
  if (hosting === 'none') return out
  const secrets = [...(out.secrets ?? [])]
  for (const [slot, provider, names] of SLOT_SECRET_NAMES) {
    if (slots[slot] !== provider) continue
    for (const name of names) {
      if (secrets.some((s) => s.name === name)) continue
      secrets.push({ name, sinks: ['hosting'], environments: ['preview', 'production'], source: 'keychain' })
    }
  }
  out.secrets = secrets
  return out
}
