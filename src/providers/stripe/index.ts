// Stripe provider. Fills the payments slot, in test mode only: a live key is refused when it is read
// (src/secrets/guard.ts) and again here. The secret key and the publishable key land in the hosting
// env as declared secrets. The check reads the test balance, which proves the secret key works,
// that it is a test key (livemode false), and costs nothing.

import { CimientoError } from '../../core/errors'
import type { Manifest } from '../../manifest/schema'
import type { Provider } from '../../core/types'
import { isLiveStripeKey } from '../../secrets/guard'
import { createKeyedProvider, keyRefused, vendorTrouble } from '../keyed'

export const STRIPE_API = 'https://api.stripe.com'
export const STRIPE_SECRET_NAME = 'STRIPE_SECRET_KEY'
export const STRIPE_PUBLISHABLE_NAME = 'NEXT_PUBLIC_STRIPE_PUBLISHABLE_KEY'
const KEYS_URL = 'https://dashboard.stripe.com/apikeys'

export function createStripeProvider(_m?: Manifest): Provider {
  return createKeyedProvider({
    id: 'stripe',
    vendor: 'Stripe',
    slot: 'payments',
    secrets: [STRIPE_SECRET_NAME, STRIPE_PUBLISHABLE_NAME],
    check: 'stripe.check.test-mode',
    explain: {
      'stripe.check.test-mode': {
        en: 'A probe that the Stripe keys are test mode keys and work: cimiento reads the test balance, which moves no money. cimiento never accepts a live key.',
        es: 'Una prueba de que las claves de Stripe son de modo de prueba y funcionan: cimiento lee el saldo de prueba, que no mueve dinero. cimiento nunca acepta una clave real.',
      },
      STRIPE_LIVE_KEY_REFUSED: {
        en: 'You gave cimiento a Stripe live key. cimiento only uses test mode, so it refused it before storing or sending it anywhere. Copy the test key instead: it starts with sk_test_ or pk_test_.',
        es: 'Le diste a cimiento una clave real de Stripe. cimiento solo usa el modo de prueba, asi que la rechazo antes de guardarla o enviarla. Copia la clave de prueba: empieza con sk_test_ o pk_test_.',
      },
    },
    async verify(spec, ctx, keys) {
      const secret = keys[STRIPE_SECRET_NAME]
      const publishable = keys[STRIPE_PUBLISHABLE_NAME]
      for (const [name, value, test] of [
        [STRIPE_SECRET_NAME, secret, /^(sk|rk)_test_/],
        [STRIPE_PUBLISHABLE_NAME, publishable, /^pk_test_/],
      ] as const) {
        if (isLiveStripeKey(value) || !test.test(value)) {
          return {
            ok: false,
            error: new CimientoError({
              code: isLiveStripeKey(value) ? 'STRIPE_LIVE_KEY_REFUSED' : 'STRIPE_KEY_INVALID',
              provider: 'stripe',
              resource: spec.id,
              message: `${name} is not a Stripe test mode key of the right kind.`,
              hint: `Copy it from ${KEYS_URL} with Test mode or Sandbox on, then run cimiento secret rotate ${name}.`,
              docsUrl: KEYS_URL,
              retryable: false,
              needsHuman: true,
            }),
          }
        }
      }
      const res = await ctx.io.http({ method: 'GET', url: `${STRIPE_API}/v1/balance`, headers: { authorization: `Bearer ${secret}` } })
      if (res.status === 401 || res.status === 403) return keyRefused('stripe', 'STRIPE_KEY_INVALID', spec, STRIPE_SECRET_NAME, 'Stripe', res.status, KEYS_URL)
      if (!res.ok) return vendorTrouble('stripe', 'STRIPE_API_ERROR', spec, 'Stripe', res.status)
      const livemode = (res.json as { livemode?: boolean } | undefined)?.livemode
      if (livemode !== false) {
        return {
          ok: false,
          error: new CimientoError({
            code: 'STRIPE_LIVE_KEY_REFUSED',
            provider: 'stripe',
            resource: spec.id,
            message: 'Stripe did not confirm test mode for this key (livemode is not false).',
            hint: `Use a test key from ${KEYS_URL}, then run cimiento secret rotate ${STRIPE_SECRET_NAME}.`,
            docsUrl: KEYS_URL,
            retryable: false,
            needsHuman: true,
          }),
        }
      }
      return { ok: true, evidence: `${STRIPE_SECRET_NAME}=**** read the test balance (livemode false); ${STRIPE_PUBLISHABLE_NAME} is a pk_test_ key` }
    },
  })
}

export default createStripeProvider()
