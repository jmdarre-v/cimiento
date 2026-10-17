// The plugin's .env rule, spec section 15. A plugin cannot ship permission rules, so this
// PreToolUse hook blocks every tool call that would read, search, change or print a .env file.
// .env.example is allowed: cimiento writes names only into it. Exit code 2 blocks the call and
// shows stderr to Claude.

import { readFileSync } from 'node:fs'
import { basename } from 'node:path'

const ENV_FILE = /^\.env(\..+)?$/
const ALLOWED = new Set(['.env.example'])
const IN_TEXT = /(?<![\w.])\.env(\.[A-Za-z0-9_-]+)*(?![\w-])/g

function isEnvFile(path) {
  if (typeof path !== 'string' || !path) return false
  const name = basename(path)
  return ENV_FILE.test(name) && !ALLOWED.has(name)
}

function mentionsEnvFile(text) {
  if (typeof text !== 'string') return false
  return [...text.matchAll(IN_TEXT)].some((m) => !ALLOWED.has(m[0]))
}

export function decide(event) {
  const tool = event?.tool_name ?? ''
  const input = event?.tool_input ?? {}
  if (['Read', 'Edit', 'Write', 'MultiEdit', 'NotebookEdit'].includes(tool)) return isEnvFile(input.file_path ?? input.notebook_path)
  if (tool === 'Grep' || tool === 'Glob') {
    return isEnvFile(input.path) || mentionsEnvFile(input.glob) || mentionsEnvFile(input.pattern && tool === 'Glob' ? input.pattern : '')
  }
  if (tool === 'Bash') return mentionsEnvFile(input.command)
  return false
}

const MESSAGE =
  'Blocked by the cimiento plugin: .env files hold secret values, and they never go through the chat. ' +
  'To see which variables exist, run cimiento env print. To set or change one, ask the person to run ' +
  'cimiento secret set NAME in their own terminal, where it is typed at a hidden prompt.'

if (import.meta.url === `file://${process.argv[1]}`) {
  let event = {}
  try {
    event = JSON.parse(readFileSync(0, 'utf8') || '{}')
  } catch {
    process.exit(0)
  }
  if (decide(event)) {
    process.stderr.write(`${MESSAGE}\n`)
    process.exit(2)
  }
  process.exit(0)
}
