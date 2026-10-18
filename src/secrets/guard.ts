// Stripe runs in test mode only (Goal 5). A live key is refused the moment it is read, before it
// can reach a sink, a check or the keychain; the error names the prefix, never the value.

import { CimientoError } from '../core/errors'

const LIVE_PREFIX = /^(sk|rk|pk)_live_/

export function isLiveStripeKey(value: string): boolean {
  return LIVE_PREFIX.test(value.trim())
}

export function assertTestModeValue(name: string, value: string): void {
  if (!isLiveStripeKey(value)) return
  const prefix = value.trim().slice(0, value.trim().indexOf('_live_') + 6)
  throw new CimientoError({
    code: 'STRIPE_LIVE_KEY_REFUSED',
    provider: 'stripe',
    resource: `secret.${name}`,
    message: `${name} is a Stripe live mode key (it starts with ${prefix}). cimiento only ever uses Stripe test mode.`,
    hint: `Open https://dashboard.stripe.com/apikeys, check the page says Test mode or Sandbox, copy the key that starts with ${prefix.replace('live', 'test')}, then run cimiento secret set ${name} again.`,
    docsUrl: 'https://dashboard.stripe.com/apikeys',
    retryable: false,
    needsHuman: true,
  })
}
