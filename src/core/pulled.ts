// The files on this machine that hold env values cimiento pulled, so down can remove them (Goal 9,
// BUG-108, BUG-113): .env.local from env pull, and the .env.local the Vercel CLI writes when
// cimiento links the folder. The record is in the gitignored .cimiento/cache.

import { mkdirSync, readFileSync, writeFileSync } from 'node:fs'
import { dirname, join } from 'node:path'

export function pulledRecordPath(cwd: string): string {
  return join(cwd, '.cimiento', 'cache', 'pulled.json')
}

export function recordPulled(cwd: string, target: string): void {
  const path = pulledRecordPath(cwd)
  let files: string[] = []
  try {
    files = (JSON.parse(readFileSync(path, 'utf8')) as { files?: string[] }).files ?? []
  } catch {
    files = []
  }
  if (!files.includes(target)) files.push(target)
  mkdirSync(dirname(path), { recursive: true })
  writeFileSync(path, `${JSON.stringify({ files }, null, 2)}\n`)
}
