// Logging. Every line passes through the redactor before it reaches a stream.

import type { Redactor } from './redact'
import type { RunLog } from './runlog'
import type { Logger, LogEvent } from './types'

/** Every event carries a UTC timestamp. */
export function stamped(event: LogEvent): LogEvent {
  return event.ts ? event : { ts: new Date().toISOString(), ...event }
}

export type LogMode = 'expert' | 'json' | 'silent'

export class ConsoleLogger implements Logger {
  readonly lines: string[] = []

  constructor(
    private readonly mode: LogMode,
    private readonly redactor: Redactor,
    private readonly write: (text: string) => void = (t) => process.stderr.write(t),
    private readonly runLog?: RunLog,
  ) {}

  log(input: LogEvent): void {
    const event = stamped(input)
    this.runLog?.write({ type: 'event', event })
    const rendered =
      this.mode === 'json'
        ? JSON.stringify(this.redactor.redactValue(event))
        : this.redactor.redact(format(event))
    this.lines.push(rendered)
    if (this.mode === 'silent') return
    this.write(`${rendered}\n`)
  }
}

export class MemoryLogger implements Logger {
  readonly events: LogEvent[] = []
  readonly lines: string[] = []

  constructor(private readonly redactor?: Redactor) {}

  log(input: LogEvent): void {
    const event = stamped(input)
    const safe = this.redactor ? this.redactor.redactValue(event) : event
    this.events.push(safe)
    this.lines.push(this.redactor ? this.redactor.redact(format(event)) : format(event))
  }
}

function format(event: LogEvent): string {
  const parts = [event.event]
  if (event.resource) parts.push(event.resource)
  if (event.message) parts.push(event.message)
  return parts.join(' ')
}
