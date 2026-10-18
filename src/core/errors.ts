// CimientoError and the exit codes from spec section 10.

import type { PersonStep } from './person'

export interface CimientoErrorFields {
  code: string
  provider: string
  resource: string
  message: string
  hint: string
  docsUrl?: string
  retryable: boolean
  needsHuman: boolean
  /** The structured person step, for a step only a person can do. hint carries the same as text. */
  personStep?: PersonStep
}

export class CimientoError extends Error implements CimientoErrorFields {
  readonly code: string
  readonly provider: string
  readonly resource: string
  readonly hint: string
  readonly docsUrl?: string
  readonly retryable: boolean
  readonly needsHuman: boolean
  readonly personStep?: PersonStep

  constructor(fields: CimientoErrorFields) {
    super(fields.message)
    this.name = 'CimientoError'
    this.code = fields.code
    this.provider = fields.provider
    this.resource = fields.resource
    this.hint = fields.hint
    this.docsUrl = fields.docsUrl
    this.retryable = fields.retryable
    this.needsHuman = fields.needsHuman
    if (fields.personStep) this.personStep = fields.personStep
  }

  toJSON(): CimientoErrorFields {
    const out: CimientoErrorFields = {
      code: this.code,
      provider: this.provider,
      resource: this.resource,
      message: this.message,
      hint: this.hint,
      retryable: this.retryable,
      needsHuman: this.needsHuman,
    }
    if (this.docsUrl) out.docsUrl = this.docsUrl
    if (this.personStep) out.personStep = this.personStep
    return out
  }
}

export function isCimientoError(value: unknown): value is CimientoError {
  return value instanceof CimientoError
}

/** Wraps anything thrown by a provider into a CimientoError so the CLI never leaks a raw stack. */
export function asCimientoError(
  err: unknown,
  fallback: { code: string; provider: string; resource: string; hint: string },
): CimientoError {
  if (isCimientoError(err)) return err
  const message = err instanceof Error ? err.message : String(err)
  return new CimientoError({
    code: fallback.code,
    provider: fallback.provider,
    resource: fallback.resource,
    message,
    hint: fallback.hint,
    retryable: false,
    needsHuman: false,
  })
}

export const ExitCode = {
  ok: 0,
  failed: 1,
  needsHuman: 2,
  blocked: 3,
} as const

export type ExitCodeName = keyof typeof ExitCode

/** Every error code this build can emit. The knowledge base has one entry per code. */
export const ERROR_CODES = [
  'MANIFEST_INVALID',
  'MANIFEST_NOT_FOUND',
  'MANIFEST_UNKNOWN_PROVIDER',
  'PLAN_CYCLE',
  'PLAN_UNKNOWN_DEPENDENCY',
  'DEFERRED_UNRESOLVED',
  'STATE_UNREADABLE',
  'STATE_VERSION_UNSUPPORTED',
  'SECRET_SOURCE_UNAVAILABLE',
  'SECRET_MISSING',
  'SECRET_SINK_UNAVAILABLE',
  'SCAFFOLD_TARGET_EXISTS',
  'SCAFFOLD_TEMPLATE_UNKNOWN',
  'TOOL_MISSING',
  'TOOL_VERSION_TOO_OLD',
  'TOOL_INSTALL_FAILED',
  'SESSION_MISSING',
  'SESSION_ACCOUNT_MISMATCH',
  'SESSION_LOGIN_FAILED',
  'ACCOUNT_CHOICE_NEEDED',
  'GITHUB_REPO_CREATE_FAILED',
  'GITHUB_REPO_NOT_FOUND',
  'GITHUB_REPO_NAME_TAKEN',
  'GITHUB_PERMISSION_DENIED',
  'GITHUB_SCOPE_MISSING',
  'VERCEL_TOKEN_MISSING',
  'VERCEL_API_ERROR',
  'VERCEL_PROJECT_CREATE_FAILED',
  'VERCEL_PROJECT_NOT_FOUND',
  'VERCEL_GIT_LINK_FAILED',
  'VERCEL_ENV_WRITE_FAILED',
  'VERCEL_DEPLOY_FAILED',
  'VERCEL_DEPLOYMENT_NOT_READY',
  'VERCEL_PLAN_REQUIRED',
  'VERCEL_MARKETPLACE_TERMS_PENDING',
  'SUPABASE_TOKEN_MISSING',
  'SUPABASE_API_ERROR',
  'SUPABASE_PROJECT_CREATE_FAILED',
  'SUPABASE_PROJECT_NOT_FOUND',
  'SUPABASE_ORG_MISSING',
  'SUPABASE_MIGRATION_FAILED',
  'SUPABASE_AUTH_URL_FAILED',
  'SUPABASE_KEYS_MISSING',
  'SUPABASE_DUPLICATE_REFUSED',
  'CHECK_FAILED',
  'MANUAL_STEP_PENDING',
  'DOWN_CONFIRMATION_NEEDED',
  'BILLING_APPROVAL_NEEDED',
  'SUPABASE_ADOPTION_CONFIRMATION_NEEDED',
  'SUPABASE_FREE_PROJECT_LIMIT',
  'VERCEL_GITHUB_CONNECTION_NEEDED',
  'DOWN_LEFTOVER',
  'VERCEL_GITHUB_ACCESS_NEEDED',
  'TURNSTILE_API_ERROR',
  'TURNSTILE_WIDGET_NOT_FOUND',
  'TURNSTILE_SECRET_REJECTED',
  'INNGEST_KEYS_MISSING',
  'INNGEST_ENDPOINT_UNREACHABLE',
  'INNGEST_ROUNDTRIP_FAILED',
  'ANTHROPIC_KEY_INVALID',
  'ANTHROPIC_API_ERROR',
  'DEV_SERVICE_FAILED',
  'JOIN_NO_STATE',
  'SECRET_NOT_DECLARED',
  'SUPABASE_CONFIGURATION_CHOICE_NEEDED',
  'HOSTING_PREVIEW_NOT_READY',
  'STRIPE_LIVE_KEY_REFUSED',
  'STRIPE_KEY_INVALID',
  'STRIPE_API_ERROR',
  'RESEND_KEY_INVALID',
  'RESEND_API_ERROR',
  'POSTHOG_KEY_INVALID',
  'POSTHOG_API_ERROR',
  'NEON_TOKEN_MISSING',
  'NEON_API_ERROR',
  'NEON_PROJECT_LIMIT',
  'NEON_MIGRATION_FAILED',
  'NETLIFY_TOKEN_MISSING',
  'NETLIFY_API_ERROR',
  'NETLIFY_SITE_NAME_TAKEN',
  'NETLIFY_SITE_NOT_FOUND',
  'NETLIFY_REPO_LINK_FAILED',
  'NETLIFY_ENV_WRITE_FAILED',
  'NETLIFY_DEPLOY_FAILED',
  'NETLIFY_DEPLOYMENT_NOT_READY',
  'HOSTING_DOMAIN_FAILED',
  'HOSTING_DOMAIN_DNS_NEEDED',
  'HOSTING_DOMAIN_NOT_SERVING',
  'HTTP_TIMEOUT',
  'HTTP_UNREACHABLE',
  'PROJECT_LOCKED',
  'DOWN_UNCONFIRMED',
  'ORPHANS_DECISION_NEEDED',
  'NEON_MIGRATION_HISTORY_UNREADABLE',
  'DOWN_ID_MISSING',
  'DOWN_IDENTITY_MISMATCH',
  'LEGACY_STATE_UNRESOLVED',
  'PUBLISH_LIVE_COMMIT_UNKNOWN',
  'PREVIEW_DATABASE_FAILED',
  'PREVIEW_DATABASE_SHARED',
  'SUPABASE_PREVIEW_SHARES_PRODUCTION',
] as const

export type ErrorCode = (typeof ERROR_CODES)[number]

/**
 * Codes that mean a person has to do something before the run can continue: log in, pick an
 * account, accept terms, grant a scope. The executor reports these as pending steps with exit
 * code 2, never as failures, because nothing is broken and retrying after the person acts works.
 */
export const PERSON_CODES: ReadonlySet<string> = new Set([
  'SESSION_MISSING',
  'ACCOUNT_CHOICE_NEEDED',
  'MANUAL_STEP_PENDING',
  'VERCEL_MARKETPLACE_TERMS_PENDING',
  'GITHUB_SCOPE_MISSING',
  'DOWN_CONFIRMATION_NEEDED',
  'SUPABASE_DUPLICATE_REFUSED',
  'BILLING_APPROVAL_NEEDED',
  'SUPABASE_ADOPTION_CONFIRMATION_NEEDED',
  'SUPABASE_FREE_PROJECT_LIMIT',
  'VERCEL_GITHUB_CONNECTION_NEEDED',
  'VERCEL_GITHUB_ACCESS_NEEDED',
  'SECRET_MISSING',
  'SUPABASE_CONFIGURATION_CHOICE_NEEDED',
  'NEON_PROJECT_LIMIT',
  'NETLIFY_SITE_NAME_TAKEN',
  'HOSTING_DOMAIN_DNS_NEEDED',
  'ORPHANS_DECISION_NEEDED',
  'DOWN_ID_MISSING',
  'DOWN_IDENTITY_MISMATCH',
  'LEGACY_STATE_UNRESOLVED',
  'SUPABASE_PREVIEW_SHARES_PRODUCTION',
])

export function needsPerson(err: { code: string; needsHuman: boolean }): boolean {
  return err.needsHuman && PERSON_CODES.has(err.code)
}
