// The only place the engine touches the outside world. Every provider call goes through this so
// tests can record and replay exec and http traffic.

import { execFile, spawn } from 'node:child_process'

export interface ExecOptions {
  cwd?: string
  env?: Record<string, string>
  input?: string
  timeoutMs?: number
}

export interface ExecResult {
  code: number
  stdout: string
  stderr: string
}

/** A long running child, for cimiento dev. */
export interface Running {
  readonly label: string
  /** Resolves with the exit code once the process has stopped, on its own or by kill. */
  readonly exited: Promise<number>
  kill(signal?: NodeJS.Signals): void
}

export interface SpawnOptions extends ExecOptions {
  /** Every line the process prints, with which stream it came from. */
  onLine?: (line: string, stream: 'stdout' | 'stderr') => void
}

export interface HttpRequest {
  method: string
  url: string
  headers?: Record<string, string>
  body?: unknown
}

export interface HttpResponse {
  status: number
  ok: boolean
  text: string
  json: unknown
  /** Response headers, lower case. */
  headers?: Record<string, string>
}

export interface Io {
  exec(cmd: string, args: string[], opts?: ExecOptions): Promise<ExecResult>
  /**
   * Runs a vendor command in the foreground with the person's own terminal attached: stdin,
   * stdout and stderr are inherited, nothing is captured, and there is no short timeout. Browser
   * and device logins need all three, because the vendor prints a code and waits for as long as
   * the person takes to approve it.
   */
  interactive(cmd: string, args: string[], opts?: ExecOptions): Promise<ExecResult>
  /** Starts a process that keeps running until it is killed, such as a dev server. */
  spawn(cmd: string, args: string[], opts?: SpawnOptions): Running
  http(req: HttpRequest): Promise<HttpResponse>
}

/** Long enough for a person to find the browser tab, sign in and approve, short of forever. */
export const INTERACTIVE_TIMEOUT_MS = 15 * 60 * 1000

/** Stable key for a command, used by the recorded fixtures. */
export function execKey(cmd: string, args: string[]): string {
  return [cmd, ...args].join(' ')
}

/** Stable key for a request, used by the recorded fixtures. */
export function httpKey(method: string, url: string): string {
  return `${method.toUpperCase()} ${url}`
}

export class RealIo implements Io {
  exec(cmd: string, args: string[], opts: ExecOptions = {}): Promise<ExecResult> {
    return new Promise((resolve) => {
      const child = execFile(
        cmd,
        args,
        {
          cwd: opts.cwd,
          env: opts.env ? { ...process.env, ...opts.env } : process.env,
          timeout: opts.timeoutMs ?? 120_000,
          maxBuffer: 16 * 1024 * 1024,
        },
        (err, stdout, stderr) => {
          const code =
            err && typeof (err as NodeJS.ErrnoException & { code?: number }).code === 'number'
              ? ((err as unknown as { code: number }).code as number)
              : err
                ? 1
                : 0
          resolve({ code, stdout: String(stdout ?? ''), stderr: String(stderr ?? '') })
        },
      )
      if (opts.input !== undefined && child.stdin) {
        child.stdin.end(opts.input)
      }
    })
  }

  interactive(cmd: string, args: string[], opts: ExecOptions = {}): Promise<ExecResult> {
    return new Promise((resolve) => {
      const child = spawn(cmd, args, {
        cwd: opts.cwd,
        env: opts.env ? { ...process.env, ...opts.env } : process.env,
        stdio: 'inherit',
      })
      const timer = setTimeout(() => child.kill('SIGTERM'), opts.timeoutMs ?? INTERACTIVE_TIMEOUT_MS)
      child.on('error', (err) => {
        clearTimeout(timer)
        resolve({ code: 127, stdout: '', stderr: err.message })
      })
      child.on('exit', (code, signal) => {
        clearTimeout(timer)
        resolve({ code: code ?? (signal ? 1 : 0), stdout: '', stderr: signal ? `stopped by ${signal}` : '' })
      })
    })
  }

  spawn(cmd: string, args: string[], opts: SpawnOptions = {}): Running {
    const child = spawn(cmd, args, {
      cwd: opts.cwd,
      env: opts.env ? { ...process.env, ...opts.env } : process.env,
      stdio: ['ignore', 'pipe', 'pipe'],
    })
    const forward = (stream: 'stdout' | 'stderr') => {
      let buffer = ''
      return (chunk: Buffer): void => {
        buffer += chunk.toString('utf8')
        const lines = buffer.split('\n')
        buffer = lines.pop() ?? ''
        for (const line of lines) opts.onLine?.(line, stream)
      }
    }
    child.stdout?.on('data', forward('stdout'))
    child.stderr?.on('data', forward('stderr'))
    const exited = new Promise<number>((resolve) => {
      child.on('error', () => resolve(127))
      child.on('exit', (code, signal) => resolve(code ?? (signal ? 130 : 0)))
    })
    return {
      label: execKey(cmd, args),
      exited,
      kill: (signal: NodeJS.Signals = 'SIGTERM') => {
        if (child.exitCode === null) child.kill(signal)
      },
    }
  }

  async http(req: HttpRequest): Promise<HttpResponse> {
    const headers: Record<string, string> = { accept: 'application/json', ...(req.headers ?? {}) }
    let body: string | undefined
    if (req.body !== undefined) {
      body = typeof req.body === 'string' ? req.body : JSON.stringify(req.body)
      if (!headers['content-type']) headers['content-type'] = 'application/json'
    }
    const res = await fetch(req.url, { method: req.method, headers, body })
    const text = await res.text()
    let json: unknown = undefined
    try {
      json = text ? JSON.parse(text) : undefined
    } catch {
      json = undefined
    }
    const headersOut: Record<string, string> = {}
    res.headers.forEach((value, key) => {
      headersOut[key.toLowerCase()] = value
    })
    return { status: res.status, ok: res.ok, text, json, headers: headersOut }
  }
}

export interface ScriptedExec {
  /** Matches execKey exactly, or as a prefix when endsWithWildcard is used. */
  match: string | RegExp
  result: Partial<ExecResult> & { code?: number }
  /** When set, the entry is consumed once and later calls fall through to the next match. */
  once?: boolean
}

export interface ScriptedHttp {
  match: string | RegExp
  result: Partial<HttpResponse> & { status?: number }
  once?: boolean
}

/**
 * Replays recorded exec and http traffic. Unmatched calls throw so a test can never
 * accidentally reach a real account.
 */
export class ScriptedIo implements Io {
  readonly execCalls: string[] = []
  readonly httpCalls: string[] = []
  private execScript: ScriptedExec[]
  private httpScript: ScriptedHttp[]
  private consumed = new Set<ScriptedExec | ScriptedHttp>()

  constructor(script: { exec?: ScriptedExec[]; http?: ScriptedHttp[] } = {}) {
    this.execScript = script.exec ?? []
    this.httpScript = script.http ?? []
  }

  addExec(entry: ScriptedExec): void {
    this.execScript.unshift(entry)
  }

  addHttp(entry: ScriptedHttp): void {
    this.httpScript.unshift(entry)
  }

  readonly interactiveCalls: string[] = []

  /** Recorded separately so a test can prove a login ran in the foreground. */
  async interactive(cmd: string, args: string[]): Promise<ExecResult> {
    this.interactiveCalls.push(execKey(cmd, args))
    return this.exec(cmd, args)
  }

  readonly spawnCalls: string[] = []

  spawn(cmd: string, args: string[]): Running {
    const label = execKey(cmd, args)
    this.spawnCalls.push(label)
    let stop: (code: number) => void = () => undefined
    const exited = new Promise<number>((resolve) => {
      stop = resolve
    })
    return { label, exited, kill: () => stop(0) }
  }

  async exec(cmd: string, args: string[]): Promise<ExecResult> {
    const key = execKey(cmd, args)
    this.execCalls.push(key)
    for (const entry of this.execScript) {
      if (entry.once && this.consumed.has(entry)) continue
      if (!matches(entry.match, key)) continue
      if (entry.once) this.consumed.add(entry)
      return { code: entry.result.code ?? 0, stdout: entry.result.stdout ?? '', stderr: entry.result.stderr ?? '' }
    }
    throw new Error(`ScriptedIo: no recorded exec for "${key}"`)
  }

  async http(req: HttpRequest): Promise<HttpResponse> {
    const key = httpKey(req.method, req.url)
    this.httpCalls.push(key)
    for (const entry of this.httpScript) {
      if (entry.once && this.consumed.has(entry)) continue
      if (!matches(entry.match, key)) continue
      if (entry.once) this.consumed.add(entry)
      const status = entry.result.status ?? 200
      const json = entry.result.json
      const text = entry.result.text ?? (json === undefined ? '' : JSON.stringify(json))
      return { status, ok: entry.result.ok ?? (status >= 200 && status < 300), text, json }
    }
    throw new Error(`ScriptedIo: no recorded http for "${key}"`)
  }
}

function matches(match: string | RegExp, key: string): boolean {
  return typeof match === 'string' ? key === match || key.startsWith(match) : match.test(key)
}
