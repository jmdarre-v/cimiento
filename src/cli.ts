#!/usr/bin/env node
// The bin entry. Compiles to dist/cli.js, which package.json points both cimiento and cim at.

import { run } from './cli/index'

run(process.argv.slice(2))
  .then((code) => {
    process.exitCode = code
  })
  .catch((err: unknown) => {
    process.stderr.write(`cimiento crashed: ${err instanceof Error ? err.message : String(err)}\n`)
    process.stderr.write('This is a bug. Run the same command with --json and open an issue with the output.\n')
    process.exitCode = 1
  })
