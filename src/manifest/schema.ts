// Zod schema for stack.yaml, spec section 4. Validation failures surface as CimientoError.

import { z } from 'zod'
import { CimientoError } from '../core/errors'
import { SLOTS, type Slot } from '../core/types'

export const ENVIRONMENTS = ['dev', 'preview', 'production'] as const
export type Environment = (typeof ENVIRONMENTS)[number]

export const SINKS = ['hosting', 'database', 'ci'] as const
export type Sink = (typeof SINKS)[number]

export const SECRET_SOURCES = ['prompt', 'keychain', '1password', 'env'] as const
export type SecretSource = (typeof SECRET_SOURCES)[number]

/** Which provider ids may fill each slot. `none` leaves the slot empty. */
export const SLOT_PROVIDERS: Record<Slot, readonly string[]> = {
  repo: ['github', 'none'],
  hosting: ['vercel', 'none'],
  database: ['supabase', 'none'],
  auth: ['supabase', 'none'],
  jobs: ['inngest', 'none'],
  bot_protection: ['turnstile', 'none'],
  email: ['resend', 'none'],
  payments: ['stripe', 'none'],
  analytics: ['posthog', 'none'],
  ai: ['anthropic', 'none'],
}

/** Provider ids this build can actually plan and apply. */
export const IMPLEMENTED_PROVIDERS = ['github', 'vercel', 'supabase', 'inngest', 'turnstile', 'anthropic'] as const

const slotsSchema = z
  .object({
    repo: z.enum(['github', 'none']).default('none'),
    hosting: z.enum(['vercel', 'none']).default('none'),
    database: z.enum(['supabase', 'none']).default('none'),
    auth: z.enum(['supabase', 'none']).default('none'),
    jobs: z.enum(['inngest', 'none']).default('none'),
    bot_protection: z.enum(['turnstile', 'none']).default('none'),
    email: z.enum(['resend', 'none']).default('none'),
    payments: z.enum(['stripe', 'none']).default('none'),
    analytics: z.enum(['posthog', 'none']).default('none'),
    ai: z.enum(['anthropic', 'none']).default('none'),
  })
  .strict()

const accountsSchema = z
  .object({
    github: z.string().min(1).optional(),
    vercel: z.string().min(1).optional(),
    supabase: z.enum(['via-hosting', 'direct']).default('via-hosting'),
    cloudflare: z.string().min(1).optional(),
  })
  .strict()

const optionsSchema = z
  .object({
    github: z
      .object({
        visibility: z.enum(['private', 'public', 'internal']).default('private'),
        defaultBranch: z.string().min(1).default('main'),
        description: z.string().default(''),
      })
      .strict()
      .default({}),
    vercel: z
      .object({
        plan: z.enum(['hobby', 'pro', 'enterprise']).default('hobby'),
        deployment_protection: z.enum(['none', 'standard', 'strict']).default('standard'),
        framework: z.string().min(1).default('nextjs'),
      })
      .strict()
      .default({}),
    supabase: z
      .object({
        region: z.string().min(1).default('us-east-1'),
        migrations: z.string().min(1).default('supabase/migrations'),
        organization_id: z.string().min(1).optional(),
        /** The Vercel Marketplace configuration the person chose to reuse on the via-hosting path. */
        marketplace_configuration: z.string().min(1).optional(),
      })
      .strict()
      .default({}),
    turnstile: z
      .object({ mode: z.enum(['managed', 'invisible', 'non-interactive']).default('managed') })
      .strict()
      .default({}),
  })
  .strict()

const secretSchema = z
  .object({
    name: z
      .string()
      .min(1)
      .regex(/^[A-Z][A-Z0-9_]*$/, 'secret names are SCREAMING_SNAKE_CASE'),
    sinks: z.array(z.enum(SINKS)).min(1).default(['hosting']),
    environments: z.array(z.enum(ENVIRONMENTS)).min(1).default(['preview', 'production']),
    source: z.enum(SECRET_SOURCES).default('prompt'),
    /** The page where the value is created, shown with the hidden prompt. Known services need none. */
    url: z.string().url().optional(),
    /** Where the 1password source reads the value, op://vault/item/field. */
    ref: z
      .string()
      .regex(/^op:\/\/[^/]+\/[^/]+\/.+$/, 'ref is a 1Password reference, op://vault/item/field')
      .optional(),
  })
  .strict()

const scaffoldSchema = z
  .object({
    template: z.enum(['nextjs-app', 'designer-site', 'none']).default('nextjs-app'),
    claude_md: z.boolean().default(true),
    ci: z.boolean().default(true),
  })
  .strict()

export const manifestSchema = z
  .object({
    version: z.literal(1).default(1),
    name: z.string().min(1),
    slug: z
      .string()
      .min(1)
      .regex(/^[a-z0-9][a-z0-9-]*$/, 'slug is lowercase letters, digits and dashes')
      .optional(),
    slots: slotsSchema,
    accounts: accountsSchema.default({}),
    environments: z.array(z.enum(ENVIRONMENTS)).min(1).default([...ENVIRONMENTS]),
    options: optionsSchema.default({}),
    secrets: z.array(secretSchema).default([]),
    domain: z.string().min(1).nullable().default(null),
    scaffold: scaffoldSchema.default({}),
  })
  .strict()
  .transform((m) => ({ ...m, slug: m.slug ?? slugify(m.name) }))

export type Manifest = z.infer<typeof manifestSchema>
export type ManifestInput = z.input<typeof manifestSchema>
export type SecretDecl = Manifest['secrets'][number]

export function slugify(name: string): string {
  const slug = name
    .trim()
    .toLowerCase()
    .replace(/[^a-z0-9]+/g, '-')
    .replace(/^-+|-+$/g, '')
  return slug || 'app'
}

/** Parses an already decoded object. Throws MANIFEST_INVALID listing every problem at once. */
export function parseManifest(raw: unknown, source = 'stack.yaml'): Manifest {
  const result = manifestSchema.safeParse(raw)
  if (result.success) {
    crossValidate(result.data, source)
    return result.data
  }
  const issues = result.error.issues.map((i) => `${i.path.join('.') || '(root)'}: ${i.message}`)
  throw new CimientoError({
    code: 'MANIFEST_INVALID',
    provider: 'core',
    resource: source,
    message: `${source} is not valid:\n  ${issues.join('\n  ')}`,
    hint: 'Fix the listed fields in stack.yaml. Run cimiento explain MANIFEST_INVALID for the field reference.',
    docsUrl: 'https://github.com/jmdarre-v/cimiento/blob/main/docs/SPEC.md#4-manifest-stackyaml',
    retryable: false,
    needsHuman: true,
  })
}

/** Rules zod cannot express: slot pairs, account pinning and sinks that need a provider. */
function crossValidate(m: Manifest, source: string): void {
  const problems: string[] = []
  const hosting = m.slots.hosting
  const database = m.slots.database
  const auth = m.slots.auth

  if (database !== 'none' && auth !== 'none' && database !== auth) {
    problems.push(`slots.database is ${database} and slots.auth is ${auth}; v0 requires the same provider for both`)
  }
  if (m.accounts.supabase === 'via-hosting' && (database === 'supabase' || auth === 'supabase') && hosting === 'none') {
    problems.push('accounts.supabase is via-hosting but slots.hosting is none; set slots.hosting or use accounts.supabase: direct')
  }
  for (const secret of m.secrets) {
    if (secret.sinks.includes('hosting') && hosting === 'none') {
      problems.push(`secrets.${secret.name} targets the hosting sink but slots.hosting is none`)
    }
    if (secret.sinks.includes('database') && database !== 'supabase') {
      problems.push(`secrets.${secret.name} targets the database sink, which is Supabase project secrets, but slots.database is ${database}`)
    }
    if (secret.sinks.includes('ci') && m.slots.repo === 'none') {
      problems.push(`secrets.${secret.name} targets the ci sink but slots.repo is none`)
    }
    for (const env of secret.environments) {
      if (!m.environments.includes(env)) {
        problems.push(`secrets.${secret.name} targets environment ${env} which is not in environments`)
      }
    }
  }
  for (const secret of m.secrets) {
    if (secret.source === '1password' && !secret.ref) {
      problems.push(`secrets.${secret.name} reads from 1password but has no ref; add ref: op://vault/item/field`)
    }
  }
  if (m.slots.jobs === 'inngest' && hosting !== 'vercel') {
    problems.push('slots.jobs is inngest, which reaches the app through the Vercel integration, but slots.hosting is not vercel')
  }
  if (m.slots.bot_protection === 'turnstile' && hosting === 'none') {
    problems.push('slots.bot_protection is turnstile, whose keys go to the hosting env, but slots.hosting is none')
  }
  if (m.slots.ai === 'anthropic' && !m.secrets.some((s) => s.name === 'ANTHROPIC_API_KEY')) {
    problems.push('slots.ai is anthropic but secrets does not declare ANTHROPIC_API_KEY')
  }
  const seen = new Set<string>()
  for (const secret of m.secrets) {
    if (seen.has(secret.name)) problems.push(`secrets.${secret.name} is declared twice`)
    seen.add(secret.name)
  }
  if (problems.length === 0) return
  throw new CimientoError({
    code: 'MANIFEST_INVALID',
    provider: 'core',
    resource: source,
    message: `${source} is not valid:\n  ${problems.join('\n  ')}`,
    hint: 'Fix the listed fields in stack.yaml. Run cimiento explain MANIFEST_INVALID for the field reference.',
    docsUrl: 'https://github.com/jmdarre-v/cimiento/blob/main/docs/SPEC.md#4-manifest-stackyaml',
    retryable: false,
    needsHuman: true,
  })
}

/** Provider ids selected by the manifest, deduplicated, in slot order. */
export function selectedProviderIds(m: Manifest): string[] {
  const ids: string[] = []
  for (const slot of SLOTS) {
    const id = m.slots[slot]
    if (id === 'none') continue
    if (!ids.includes(id)) ids.push(id)
  }
  return ids
}

export function slotsFilledBy(m: Manifest, providerId: string): Slot[] {
  return SLOTS.filter((slot) => m.slots[slot] === providerId)
}
