// Copies non TypeScript assets that the compiled CLI reads at runtime.
// Today that is the knowledge base, which the spec keeps as yaml under src/kb.
import { cpSync, mkdirSync, readdirSync } from 'node:fs'
import { dirname, join } from 'node:path'
import { fileURLToPath } from 'node:url'

const root = dirname(dirname(fileURLToPath(import.meta.url)))
const from = join(root, 'src', 'kb')
const to = join(root, 'dist', 'kb')

mkdirSync(to, { recursive: true })
let copied = 0
for (const name of readdirSync(from)) {
  if (!name.endsWith('.yaml')) continue
  cpSync(join(from, name), join(to, name))
  copied += 1
}
process.stdout.write(`copied ${copied} knowledge base files\n`)
