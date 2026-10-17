// Run logs, spec section 7: every command writes ~/.cimiento/runs/<UTC timestamp>-<command>.jsonl.
// Each line carries a UTC timestamp and is an event, a line shown, a prompt shown or the answer
// given. Everything passes through the redactor when it is written, and a hidden answer is never
// written at all.

import { appendFileSync, mkdirSync } from 'node:fs'
import { homedir } from 'node:os'
import { join } from 'node:path'
import type { Redactor } from './redact'

export const HIDDEN = '****'

export function runsDir(): string {
  return process.env.CIMIENTO_RUNS_DIR ?? join(homedir(), '.cimiento', 'runs')
}

export function utcStamp(date = new Date()): string {
  return date.toISOString()
}

export type RunRecord =
  | { type: 'start'; command: string; argv: string[] }
  | { type: 'event'; event: unknown }
  | { type: 'output'; stream: 'stdout' | 'stderr'; text: string }
  | { type: 'json'; payload: unknown }
  | { type: 'prompt'; kind: 'choose' | 'ask' | 'enter' | 'confirm' | 'hidden'; question: string; options?: string[] }
  | { type: 'answer'; kind: 'choose' | 'ask' | 'enter' | 'confirm' | 'hidden'; answer: string }
  | { type: 'end'; exitCode: number }

export class RunLog {
  readonly path: string
  private ready = false

  constructor(
    command: string,
    private readonly redactor: Redactor,
    dir = runsDir(),
  ) {
    const stamp = utcStamp().replace(/[:.]/g, '-')
    this.path = join(dir, `${stamp}-${command.replace(/[^a-z0-9-]/gi, '-') || 'help'}.jsonl`)
  }

  write(record: RunRecord): void {
    try {
      if (!this.ready) {
        mkdirSync(join(this.path, '..'), { recursive: true })
        this.ready = true
      }
      const safe = this.redactor.redactValue({ ts: utcStamp(), ...record })
      appendFileSync(this.path, `${JSON.stringify(safe)}\n`, { encoding: 'utf8', mode: 0o600 })
    } catch {
      // A run log that cannot be written never stops the command it records.
    }
  }

  /** Wraps a question so the prompt and the answer land in the log. Hidden answers stay hidden. */
  recordAsk<A extends unknown[]>(kind: Exclude<RunRecord & { type: 'prompt' }, never>['kind'], fn: (question: string, ...rest: A) => Promise<string>) {
    return async (question: string, ...rest: A): Promise<string> => {
      this.write({ type: 'prompt', kind, question })
      const answer = await fn(question, ...rest)
      this.write({ type: 'answer', kind, answer: kind === 'hidden' ? HIDDEN : answer })
      return answer
    }
  }
}
