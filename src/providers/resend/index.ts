// Resend provider. Fills the email slot. The key is the person's and lands in the hosting env as the
// declared secret RESEND_API_KEY. The check sends one real email to Resend's own test inbox,
// delivered@resend.dev, from its shared onboarding sender: that proves the key can send, works on a
// free account with no domain, and reaches nobody.

import type { Manifest } from '../../manifest/schema'
import type { Provider } from '../../core/types'
import { createKeyedProvider, keyRefused, vendorTrouble } from '../keyed'

export const RESEND_API = 'https://api.resend.com'
export const RESEND_KEY_NAME = 'RESEND_API_KEY'
export const RESEND_TEST_INBOX = 'delivered@resend.dev'
const KEYS_URL = 'https://resend.com/api-keys'

export function createResendProvider(_m?: Manifest): Provider {
  return createKeyedProvider({
    id: 'resend',
    vendor: 'Resend',
    slot: 'email',
    secrets: [RESEND_KEY_NAME],
    check: 'resend.check.send',
    explain: {
      'resend.check.send': {
        en: 'A probe that the Resend key can send email: cimiento sends one message to Resend\'s own test inbox, which reaches nobody and costs nothing.',
        es: 'Una prueba de que la clave de Resend puede enviar correo: cimiento envia un mensaje a la bandeja de prueba de Resend, que no llega a nadie y no cuesta nada.',
      },
      'resend.session': {
        en: 'Resend has no login in cimiento. Its key is made once at resend.com/api-keys and set with cimiento secret set RESEND_API_KEY.',
        es: 'Resend no tiene inicio de sesion en cimiento. Su clave se crea una vez en resend.com/api-keys y se guarda con cimiento secret set RESEND_API_KEY.',
      },
    },
    smokeEffect: (m) => `sends one email from ${m.options.resend.from} to Resend's test inbox delivered@resend.dev, which reaches nobody and counts against the monthly quota`,
    // Reads only: the domains list answers 200 to a full access key and 401 restricted_api_key to
    // a sending key, both live keys; anything that says invalid is refused.
    async inspect(spec, ctx, keys) {
      const key = keys[RESEND_KEY_NAME]
      const res = await ctx.io.http({ method: 'GET', url: `${RESEND_API}/domains`, headers: { authorization: `Bearer ${key}`, 'user-agent': 'cimiento' } })
      const name = (res.json as { name?: string } | undefined)?.name ?? ''
      if (res.ok) return { ok: true, evidence: `${RESEND_KEY_NAME}=**** is a full access key Resend accepts; --smoke sends a test email` }
      if (name === 'restricted_api_key') return { ok: true, evidence: `${RESEND_KEY_NAME}=**** is a sending key Resend accepts; --smoke sends a test email` }
      if (res.status === 400 || res.status === 401 || res.status === 403) return keyRefused('resend', 'RESEND_KEY_INVALID', spec, RESEND_KEY_NAME, 'Resend', res.status, KEYS_URL)
      return { ...vendorTrouble('resend', 'RESEND_API_ERROR', spec, 'Resend', res.status), unknown: true }
    },
    async verify(spec, ctx, keys) {
      const key = keys[RESEND_KEY_NAME]
      const from = ctx.manifest.options.resend.from
      const res = await ctx.io.http({
        method: 'POST',
        url: `${RESEND_API}/emails`,
        // Resend answers 403 to a request with no User-Agent.
        headers: { authorization: `Bearer ${key}`, 'content-type': 'application/json', 'user-agent': 'cimiento' },
        body: {
          from: `cimiento <${from}>`,
          to: [RESEND_TEST_INBOX],
          subject: `cimiento check for ${ctx.manifest.slug}`,
          text: 'cimiento sent this to prove the Resend key can send. Nobody receives it.',
        },
      })
      if (res.ok) {
        const id = (res.json as { id?: string } | undefined)?.id ?? 'unknown'
        return { ok: true, evidence: `${RESEND_KEY_NAME}=**** sent email ${id} from ${from} to ${RESEND_TEST_INBOX}` }
      }
      const name = (res.json as { name?: string } | undefined)?.name ?? ''
      if (res.status === 401 || name === 'restricted_api_key' || name === 'suspended_api_key' || name === 'invalid_api_key') {
        return keyRefused('resend', 'RESEND_KEY_INVALID', spec, RESEND_KEY_NAME, 'Resend', res.status, KEYS_URL)
      }
      if (res.status === 422 || (res.status === 403 && name === 'validation_error')) {
        return vendorTrouble('resend', 'RESEND_API_ERROR', spec, `Resend (the sender ${from} is not allowed: set options.resend.from to onboarding@resend.dev or an address on a domain you verified in Resend)`, res.status)
      }
      return vendorTrouble('resend', 'RESEND_API_ERROR', spec, 'Resend', res.status)
    },
  })
}

export default createResendProvider()
