// Goal 6: trustworthy state, teardown and health. Each BUG test here was run red on the code
// before its fix (docs/FIELD-TEST-6.md lists the commits).

import { createServer, type Server } from 'node:http'
import type { AddressInfo } from 'node:net'
import { afterEach, describe, expect, it } from 'vitest'
import { RealIo, setHttpPolicy } from '../../src/core/io'

let server: Server | undefined

afterEach(async () => {
  setHttpPolicy({})
  if (server) await new Promise((resolve) => server!.close(() => resolve(undefined)))
  server = undefined
})

async function serve(handler: (count: number, method: string) => { status: number; body?: string } | 'hang'): Promise<{ url: string; calls: () => number }> {
  let count = 0
  server = createServer((req, res) => {
    count += 1
    const answer = handler(count, req.method ?? 'GET')
    if (answer === 'hang') return
    res.writeHead(answer.status, { 'content-type': 'application/json' })
    res.end(answer.body ?? '{}')
  })
  await new Promise((resolve) => server!.listen(0, '127.0.0.1', () => resolve(undefined)))
  const { port } = server.address() as AddressInfo
  return { url: `http://127.0.0.1:${port}/x`, calls: () => count }
}

describe('BUG-71: every http request has a bounded timeout', () => {
  it('a provider that never answers fails with HTTP_TIMEOUT instead of hanging the command', async () => {
    setHttpPolicy({ timeoutMs: 200, backoffMs: 1 })
    const { url } = await serve(() => 'hang')
    const started = Date.now()
    await expect(new RealIo().http({ method: 'POST', url, body: {} })).rejects.toMatchObject({ code: 'HTTP_TIMEOUT', retryable: true })
    expect(Date.now() - started).toBeLessThan(2000)
  }, 5000)
})

describe('http retries only idempotent reads', () => {
  it('a GET answered 503 then 200 is retried and succeeds', async () => {
    setHttpPolicy({ timeoutMs: 1000, backoffMs: 1 })
    const { url, calls } = await serve((n) => (n === 1 ? { status: 503 } : { status: 200, body: '{"ok":true}' }))
    const res = await new RealIo().http({ method: 'GET', url })
    expect(res.status).toBe(200)
    expect(calls()).toBe(2)
  })

  it('a POST answered 503 is returned as is, never sent twice', async () => {
    setHttpPolicy({ timeoutMs: 1000, backoffMs: 1 })
    const { url, calls } = await serve(() => ({ status: 503 }))
    const res = await new RealIo().http({ method: 'POST', url, body: {} })
    expect(res.status).toBe(503)
    expect(calls()).toBe(1)
  })

  it('a GET that keeps failing gives up after the bounded number of retries', async () => {
    setHttpPolicy({ timeoutMs: 1000, backoffMs: 1, retries: 2 })
    const { url, calls } = await serve(() => ({ status: 503 }))
    const res = await new RealIo().http({ method: 'GET', url })
    expect(res.status).toBe(503)
    expect(calls()).toBe(3)
  })
})
