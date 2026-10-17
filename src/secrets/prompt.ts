// A small prompt helper. No dependency, and hidden input for anything secret so a value never
// reaches the scrollback.

import { createInterface } from 'node:readline'

export async function ask(question: string): Promise<string> {
  const rl = createInterface({ input: process.stdin, output: process.stdout })
  try {
    return await new Promise<string>((resolve) => rl.question(question, resolve))
  } finally {
    rl.close()
  }
}

export async function confirm(question: string, lang: 'en' | 'es' = 'en'): Promise<boolean> {
  const answer = await ask(`${question} ${lang === 'es' ? '[s/N]' : '[y/N]'} `)
  return isYes(answer)
}

/** Yes in English or Spanish: y, yes, s, si. */
export function isYes(answer: string): boolean {
  return /^(y|yes|s|si|sí)$/i.test(answer.trim())
}

/** Waits for Enter. Used before and after a manual step. */
export async function pressEnter(question: string): Promise<void> {
  await ask(question)
}

/** Reads a line without echoing it. The value never appears on screen or in the scrollback. */
export async function askHidden(question: string): Promise<string> {
  if (!process.stdin.isTTY) {
    return ask(question)
  }
  process.stdout.write(question)
  const stdin = process.stdin
  const wasRaw = stdin.isRaw === true
  stdin.setRawMode(true)
  stdin.resume()
  stdin.setEncoding('utf8')

  return new Promise<string>((resolve, reject) => {
    let value = ''
    const onData = (chunk: string): void => {
      for (const char of chunk) {
        if (char === '\r' || char === '\n') {
          cleanup()
          process.stdout.write('\n')
          resolve(value)
          return
        }
        if (char === '') {
          cleanup()
          process.stdout.write('\n')
          reject(new Error('cancelled'))
          return
        }
        if (char === '' || char === '\b') {
          value = value.slice(0, -1)
          continue
        }
        value += char
      }
    }
    const cleanup = (): void => {
      stdin.removeListener('data', onData)
      stdin.setRawMode(wasRaw)
      stdin.pause()
    }
    stdin.on('data', onData)
  })
}
