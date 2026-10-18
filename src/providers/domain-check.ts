// The domain check both hosting providers share: the custom domain answers 200 over https with the
// site. When it does not, the error is a person step naming the exact DNS record to add, because
// the DNS provider is the one place cimiento cannot reach.

import { CimientoError } from '../core/errors'
import { renderPersonStep, type PersonStep } from '../core/person'
import type { CheckResult, Ctx, ResourceSpec } from '../core/types'

export interface DnsRecord {
  type: string
  name: string
  value: string
}

/** The host part of a domain relative to its registered domain, assuming a two label registered domain. */
export function recordName(domain: string): string {
  const labels = domain.split('.')
  return labels.length <= 2 ? '@' : labels.slice(0, -2).join('.')
}

export function dnsStep(domain: string, record: DnsRecord, vendor: string): PersonStep {
  const L = (en: string, es: string) => ({ en, es })
  const zone = domain.split('.').slice(-2).join('.')
  return {
    id: 'domain.dns',
    title: L(`Point ${domain} at ${vendor} with one DNS record`, `Apunta ${domain} a ${vendor} con un registro DNS`),
    url: `https://www.whatsmydns.net/#${record.type}/${domain}`,
    path: [
      L(`Sign in where the DNS of ${zone} is managed (the company you bought it from, unless you moved it)`, `Inicia sesion donde se administra el DNS de ${zone} (donde lo compraste, salvo que lo hayas movido)`),
      L(`Open the DNS records of ${zone} and add a new record with the values below`, `Abre los registros DNS de ${zone} y agrega un registro nuevo con los valores de abajo`),
      L('This page then shows when the record is visible around the world, usually within minutes', 'Esta pagina muestra cuando el registro es visible en el mundo, normalmente en minutos'),
    ],
    fields: [
      { label: L('Type', 'Type (tipo)'), value: L(record.type, record.type) },
      { label: L('Name or Host', 'Name o Host (nombre)'), value: L(record.name, record.name) },
      { label: L('Value or Target', 'Value o Target (valor)'), value: L(record.value, record.value) },
      { label: L('TTL', 'TTL'), value: L('the default, or 300', 'el predeterminado, o 300') },
    ],
    button: L('Save, or Add record', 'Save, o Add record'),
    success: L(`this page shows ${record.value} for ${domain} in most places; then cimiento doctor passes`, `esta pagina muestra ${record.value} para ${domain} en casi todos lados; luego cimiento doctor pasa`),
  }
}

/**
 * Whether public DNS already answers the record, through DNS over HTTPS so it goes through io like
 * every other call. A or CNAME, compared without the trailing dot.
 */
export async function dnsPointsTo(ctx: Ctx, domain: string, record: DnsRecord): Promise<boolean> {
  const res = await ctx.io
    .http({ method: 'GET', url: `https://cloudflare-dns.com/dns-query?name=${encodeURIComponent(domain)}&type=${record.type}`, headers: { accept: 'application/dns-json' } })
    .catch(() => undefined)
  const answers = ((res?.json as { Answer?: { data?: string }[] } | undefined)?.Answer ?? []).map((a) => (a.data ?? '').replace(/\.$/, '').toLowerCase())
  return answers.includes(record.value.replace(/\.$/, '').toLowerCase())
}

export async function verifyDomainServes(
  spec: ResourceSpec,
  ctx: Ctx,
  opts: { domain: string; record: DnsRecord; vendor: string; requireMarker: boolean; dnsReady?: boolean },
): Promise<CheckResult> {
  const url = `https://${opts.domain}`
  const res = await ctx.io.http({ method: 'GET', url }).catch(() => undefined)
  if (res && res.status === 200 && (!opts.requireMarker || res.text.includes('cimiento-project'))) {
    return { ok: true, evidence: `200 from ${url}` }
  }
  if (!(opts.dnsReady ?? (await dnsPointsTo(ctx, opts.domain, opts.record)))) {
    const step = dnsStep(opts.domain, opts.record, opts.vendor)
    return {
      ok: false,
      error: new CimientoError({
        code: 'HOSTING_DOMAIN_DNS_NEEDED',
        provider: spec.provider,
        resource: spec.id,
        message: `${opts.domain} is added to ${opts.vendor}, but its DNS does not point there yet: it needs ${opts.record.type} ${opts.record.name} ${opts.record.value}.`,
        hint: renderPersonStep(step, ctx.lang, { links: false }),
        personStep: step,
        docsUrl: step.url,
        retryable: true,
        needsHuman: true,
      }),
    }
  }
  return {
    ok: false,
    error: new CimientoError({
      code: 'HOSTING_DOMAIN_NOT_SERVING',
      provider: spec.provider,
      resource: spec.id,
      message: `${url} ${res ? `answered ${res.status}${res.status === 200 ? ' without the cimiento scaffold marker' : ''}` : 'did not answer'}, though its DNS points at ${opts.vendor}.`,
      hint: `${opts.vendor} issues the https certificate a few minutes after DNS points at it. Run cimiento doctor again in a few minutes.`,
      retryable: true,
      needsHuman: false,
    }),
  }
}
