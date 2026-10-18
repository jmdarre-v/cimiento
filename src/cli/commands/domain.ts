// cimiento domain add <domain> and cimiento domain remove [domain]: the custom domain rule of spec
// section 6. stack.yaml's domain is the source of truth. add writes it, then applies only what
// follows from it: the domain on the hosting project, the Supabase Auth URLs and the Turnstile
// widget domains, and the check that the domain serves the site. remove takes the domain off the
// hosting project, clears it in stack.yaml and applies the same items back.

import { readFileSync, writeFileSync } from 'node:fs'
import { parseDocument } from 'yaml'
import { CimientoError, ExitCode, type CimientoErrorFields } from '../../core/errors'
import { runUp, type UpEvent, type UpResult } from '../../core/executor'
import { HOSTING_NAMES, hostingOf, type HostingId } from '../../core/hosting'
import { OutputResolver } from '../../core/resolve'
import { hashManifest, writeProjectState } from '../../core/state'
import type { ResourceSpec } from '../../core/types'
import { manifestPath } from '../../manifest'
import { domainAffectedIds } from '../../wiring/hosting-domain'
import { openProject, type ProjectSession, type Session } from '../context'

const DOMAIN = /^(?=.{4,253}$)([a-z0-9](?:[a-z0-9-]{0,61}[a-z0-9])?\.)+[a-z]{2,63}$/

function requireHosting(project: ProjectSession, command: string): HostingId {
  const hosting = hostingOf(project.manifest)
  if (hosting && project.state.resources[`${hosting}.project`]) return hosting
  throw new CimientoError({
    code: 'HOSTING_DOMAIN_FAILED',
    provider: hosting ?? 'core',
    resource: command,
    message: hosting ? `This project has no ${HOSTING_NAMES[hosting]} project yet, so there is nothing to put a domain on.` : 'slots.hosting is none in stack.yaml, so there is nothing to put a domain on.',
    hint: hosting ? 'Run cimiento up first, then cimiento domain add again.' : 'Set slots.hosting in stack.yaml and run cimiento up first.',
    retryable: false,
    needsHuman: true,
  })
}

function writeDomain(cwd: string, domain: string | null): void {
  const file = manifestPath(cwd)
  const doc = parseDocument(readFileSync(file, 'utf8'))
  doc.set('domain', domain)
  writeFileSync(file, doc.toString({ lineWidth: 100 }), 'utf8')
}

/** The affected items and everything they depend on, so the executor can resolve their inputs. */
function affectedWithDependencies(project: ProjectSession, overrides: Record<string, Record<string, string>> = {}): ResourceSpec[] {
  const wanted = new Set(domainAffectedIds(project.manifest))
  const byId = new Map(project.specs.map((s) => [s.id, s]))
  const keep = new Set<string>()
  const visit = (id: string): void => {
    if (keep.has(id)) return
    keep.add(id)
    for (const dep of byId.get(id)?.dependsOn ?? []) visit(dep)
  }
  for (const id of wanted) if (byId.has(id)) visit(id)
  return project.specs.filter((s) => keep.has(s.id)).map((s) => (overrides[s.id] ? { ...s, inputs: { ...s.inputs, ...overrides[s.id] } } : s))
}

/** What each pending item waits on, with its person step, collected from the run's events. */
function collector(): { onEvent: (event: UpEvent) => void; waiting: CimientoErrorFields[] } {
  const waiting: CimientoErrorFields[] = []
  return { waiting, onEvent: (event) => (event.event === 'manual' && event.error ? void waiting.push(event.error) : undefined) }
}

function report(session: Session, command: string, domain: string, result: UpResult, waiting: CimientoErrorFields[], extra: Record<string, unknown> = {}): number {
  const touched = new Set(domainAffectedIds(openProject(session, { dryRun: true }).manifest))
  const items = result.receipts.filter((r) => touched.has(r.id) || r.id.endsWith('.domain'))
  if (session.json) {
    session.printer.emit({
      ok: result.exitCode === ExitCode.ok,
      command,
      domain,
      items: items.map((r) => ({ id: r.id, action: r.action, evidence: r.evidence, url: r.url })),
      pending: result.pendingManual,
      waiting,
      errors: result.errors,
      ...extra,
    })
  } else {
    for (const r of items) session.printer.line(`${(r.action ?? 'ok').padEnd(8)} ${r.id}${r.evidence ? `  ${r.evidence}` : ''}`)
    for (const error of [...waiting, ...result.errors]) session.printer.error(error)
  }
  return result.exitCode
}

export async function domainAddCommand(session: Session): Promise<number> {
  const domain = (session.args.positionals[0] ?? '').trim().toLowerCase().replace(/^https?:\/\//, '').replace(/\/.*$/, '')
  if (!DOMAIN.test(domain)) {
    throw new CimientoError({
      code: 'HOSTING_DOMAIN_FAILED',
      provider: 'core',
      resource: 'domain add',
      message: domain ? `${domain} is not a domain name cimiento can add.` : 'cimiento domain add needs a domain.',
      hint: 'Run cimiento domain add app.example.com, with a domain or subdomain you control the DNS of.',
      retryable: false,
      needsHuman: true,
    })
  }
  const before = openProject(session, { dryRun: false })
  requireHosting(before, 'domain add')
  if (before.manifest.domain && before.manifest.domain !== domain) {
    throw new CimientoError({
      code: 'HOSTING_DOMAIN_FAILED',
      provider: 'core',
      resource: 'domain add',
      message: `stack.yaml already has the domain ${before.manifest.domain}. cimiento keeps one custom domain per project.`,
      hint: `Run cimiento domain remove ${before.manifest.domain} first, then cimiento domain add ${domain}.`,
      retryable: false,
      needsHuman: true,
    })
  }
  writeDomain(session.cwd, domain)
  const project = openProject(session, { dryRun: false })
  const events = collector()
  const result = await runUp(project.ctx, project.providers, affectedWithDependencies(project), { onManual: async () => false, onEvent: events.onEvent })
  writeProjectState(session.cwd, { ...result.state, manifestHash: hashManifest(readFileSync(manifestPath(session.cwd), 'utf8')) })
  return report(session, 'domain add', domain, result, events.waiting)
}

export async function domainRemoveCommand(session: Session): Promise<number> {
  const project = openProject(session, { dryRun: false })
  const hosting = requireHosting(project, 'domain remove')
  const domain = (session.args.positionals[0] ?? project.manifest.domain ?? '').trim().toLowerCase()
  if (!domain || (project.manifest.domain && project.manifest.domain !== domain)) {
    throw new CimientoError({
      code: 'HOSTING_DOMAIN_FAILED',
      provider: 'core',
      resource: 'domain remove',
      message: project.manifest.domain ? `The domain in stack.yaml is ${project.manifest.domain}, not ${domain}.` : 'stack.yaml has no custom domain to remove.',
      hint: project.manifest.domain ? `Run cimiento domain remove ${project.manifest.domain}.` : 'Nothing to do.',
      retryable: false,
      needsHuman: true,
    })
  }

  // 1. Off the hosting project, while the binding still knows the domain.
  const bindingId = `${hosting}.binding.domain`
  const binding: ResourceSpec = project.specs.find((s) => s.id === bindingId) ?? {
    id: bindingId,
    kind: 'binding',
    provider: hosting,
    dependsOn: [`${hosting}.project`],
    inputs: { projectId: { deferred: `${hosting}.project:projectId` }, domain, name: project.manifest.slug },
  }
  const byProvider = new Map(project.providers.map((p) => [p.id, p]))
  const attempt = await new OutputResolver(project.state).resolveWithHydration(binding, project.specs, byProvider, project.ctx)
  const removed = await byProvider.get(hosting)!.ensure({ ...attempt.spec, inputs: { ...attempt.spec.inputs, domain, remove: 'true' } }, project.ctx)

  // 2. stack.yaml, then the items that follow it back to the default address.
  writeDomain(session.cwd, null)
  const after = openProject(session, { dryRun: false })
  const resources = { ...after.state.resources }
  delete resources[bindingId]
  delete resources[`${hosting}.check.domain`]
  after.ctx.state = { ...after.state, resources }
  const events = collector()
  const result = await runUp(after.ctx, after.providers, affectedWithDependencies(after, { 'turnstile.binding.domains': { removed: domain } }), {
    onManual: async () => false,
    onEvent: events.onEvent,
  })
  writeProjectState(session.cwd, { ...result.state, manifestHash: hashManifest(readFileSync(manifestPath(session.cwd), 'utf8')) })
  return report(session, 'domain remove', domain, result, events.waiting, { hosting: { id: bindingId, action: removed.action } })
}
