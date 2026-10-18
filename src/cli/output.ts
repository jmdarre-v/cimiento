// Output modes from spec section 10. Expert prints a table, json prints structured objects, and
// every byte of both goes through the redactor first.

import type { CimientoErrorFields } from '../core/errors'
import type { Receipt } from '../core/executor'
import type { Plan, PlanItem } from '../core/planner'
import type { Redactor } from '../core/redact'
import type { VerifyReport } from '../core/executor'
import type { Lang } from '../core/types'
import type { RunLog } from '../core/runlog'
import { nextAction, t } from './i18n'

export interface PrinterOptions {
  lang?: Lang
  /** Guided mode, spec section 10: every failure in plain language with one next action. */
  guided?: boolean
  /** Plain language for an error code or resource id, in the printer's language. */
  explain?: (key: string) => string | undefined
  /** Where every line and payload is also recorded. */
  runLog?: RunLog
}

export interface Writer {
  out(text: string): void
  err(text: string): void
}

export class Printer {
  readonly lang: Lang
  readonly guided: boolean
  private readonly explain: (key: string) => string | undefined
  readonly runLog?: RunLog

  constructor(
    private writer: Writer,
    private readonly redactor: Redactor,
    readonly json: boolean,
    options: PrinterOptions = {},
  ) {
    this.lang = options.lang ?? 'en'
    this.guided = options.guided ?? false
    this.explain = options.explain ?? (() => undefined)
    if (options.runLog) this.runLog = options.runLog
    // Every byte shown also goes to the run log, through the same redactor.
    const out = writer.out.bind(writer)
    const err = writer.err.bind(writer)
    this.writer = {
      out: (text: string) => {
        if (!this.json) this.runLog?.write({ type: 'output', stream: 'stdout', text })
        out(text)
      },
      err: (text: string) => {
        this.runLog?.write({ type: 'output', stream: 'stderr', text })
        err(text)
      },
    }
  }

  /** The one place a json payload is produced, so redaction cannot be forgotten. */
  emit(payload: unknown): void {
    this.runLog?.write({ type: 'json', payload })
    // One line per event, spec section 10, so an agent can read the stream line by line.
    this.writer.out(`${JSON.stringify(this.redactor.redactValue(payload))}\n`)
  }

  line(text = ''): void {
    if (this.json) return
    this.writer.out(`${this.redactor.redact(text)}\n`)
  }

  warn(text: string): void {
    if (this.json) return
    this.writer.err(`${this.redactor.redact(text)}\n`)
  }

  error(err: CimientoErrorFields): void {
    if (this.json) {
      this.emit({ ok: false, error: err })
      return
    }
    if (this.guided) {
      // Guided mode: what happened, the same in plain words, what to do, and one command to run.
      const plain = this.explain(err.code)
      const lines = [
        '',
        `${t(this.lang, 'whatHappened')}: ${err.message}`,
        ...(plain ? [`  ${t(this.lang, 'whatItMeans')}: ${plain}`] : []),
        `  ${t(this.lang, 'whatToDo')}: ${err.hint}`,
        `  ${t(this.lang, 'next')}: ${nextAction(err.hint)}`,
        ...(err.docsUrl ? [`  ${t(this.lang, 'docs')}: ${err.docsUrl}`] : []),
      ]
      this.writer.err(`${this.redactor.redact(lines.join('\n'))}\n`)
      return
    }
    this.writer.err(`${this.redactor.redact(`\n${err.code}: ${err.message}\n  ${this.lang === 'es' ? 'que hacer' : 'hint'}: ${err.hint}`)}\n`)
    if (err.docsUrl) this.writer.err(`  docs: ${err.docsUrl}\n`)
  }

  planTable(plan: Plan): void {
    if (this.json) {
      this.emit({
        ok: true,
        command: 'plan',
        name: plan.name,
        slug: plan.slug,
        manifestHash: plan.manifestHash,
        summary: plan.summary,
        warnings: plan.warnings,
        planRequirements: plan.planRequirements,
        items: plan.items,
      })
      return
    }
    this.line(`\n${t(this.lang, 'planFor', { name: plan.name })}`)
    this.line(
      table(
        [t(this.lang, 'status'), t(this.lang, 'resource'), t(this.lang, 'provider'), t(this.lang, 'detail')],
        plan.items.map((item) => [statusLabel(item, this.lang), item.id, item.provider, detailOf(item)]),
      ),
    )
    this.line(summaryLine(plan))
    for (const warning of plan.warnings) this.line(`${t(this.lang, 'warning')}: ${warning}`)
  }

  doctorTable(reports: VerifyReport[]): void {
    if (this.json) {
      this.emit({
        ok: reports.every((r) => r.ok),
        command: 'doctor',
        items: reports,
        summary: {
          ok: reports.filter((r) => r.status === 'ok').length,
          failed: reports.filter((r) => r.status === 'failed').length,
          unknown: reports.filter((r) => r.status === 'unknown').length,
        },
      })
      return
    }
    this.line(`\n${t(this.lang, 'doctor')}`)
    this.line(
      table(
        [t(this.lang, 'status'), t(this.lang, 'resource'), t(this.lang, 'provider'), t(this.lang, 'detail')],
        reports.map((r) => [
          r.status === 'ok' ? (this.lang === 'es' ? 'bien' : 'ok') : r.status === 'unknown' ? (this.lang === 'es' ? 'sin saber' : 'unknown') : this.lang === 'es' ? 'falla' : 'failed',
          r.id,
          r.provider,
          r.ok ? (r.evidence ?? '') : (r.error?.message ?? ''),
        ]),
      ),
    )
    const failed = reports.filter((r) => !r.ok)
    this.line(t(this.lang, 'okFailed', { ok: reports.length - failed.length, failed: failed.length }))
    for (const item of failed) {
      if (!item.error) continue
      this.line(`\n${item.id} ${item.error.code}`)
      this.line(`  ${item.error.message}`)
      this.line(`  ${t(this.lang, 'whatToDo')}: ${item.error.hint}`)
      if (this.guided) this.line(`  ${t(this.lang, 'next')}: ${nextAction(item.error.hint)}`)
    }
  }

  receipts(receipts: Receipt[]): void {
    if (this.json) return
    if (receipts.length === 0) {
      this.line(`\n${t(this.lang, 'nothingToDo')}`)
      return
    }
    this.line(`\n${t(this.lang, 'receipts')}`)
    this.line(
      table(
        [t(this.lang, 'resource'), t(this.lang, 'action'), t(this.lang, 'urlOrEvidence')],
        receipts.map((r) => [r.id, this.lang === 'es' ? (ACTION_ES[r.action] ?? r.action) : r.action, r.url ?? r.evidence ?? '']),
      ),
    )
  }
}

const STATUS_ES: Record<string, string> = {
  create: 'crear',
  adopt: 'adoptar',
  update: 'actualizar',
  noop: 'sin cambios',
  'needs-human': 'te necesita',
  blocked: 'en espera',
  orphan: 'huerfano',
}

const ACTION_ES: Record<string, string> = {
  created: 'creado',
  adopted: 'adoptado',
  updated: 'actualizado',
  noop: 'sin cambios',
  verified: 'verificado',
  confirmed: 'confirmado',
}

function statusLabel(item: PlanItem, lang: Lang = 'en'): string {
  return lang === 'es' ? (STATUS_ES[item.status] ?? item.status) : item.status
}

function detailOf(item: PlanItem): string {
  if (item.url) return item.url
  if (item.evidence) return item.evidence
  return item.reason
}

function summaryLine(plan: Plan): string {
  const parts = Object.entries(plan.summary)
    .filter(([, count]) => count > 0)
    .map(([status, count]) => `${count} ${status}`)
  return parts.length ? parts.join(', ') : 'nothing to do'
}

export function table(headers: string[], rows: string[][]): string {
  const all = [headers, ...rows]
  const widths = headers.map((_, column) => Math.max(...all.map((row) => (row[column] ?? '').length)))
  const render = (row: string[]): string =>
    row
      .map((cell, column) => (column === row.length - 1 ? (cell ?? '') : (cell ?? '').padEnd(widths[column])))
      .join('  ')
      .trimEnd()
  return [render(headers), ...rows.map(render)].join('\n')
}
