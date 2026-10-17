// The one version of cimiento: package.json, read at runtime. The same relative path works in the
// repository (src/version.ts) and in the installed package (dist/version.js).

import { readFileSync } from 'node:fs'
import { join } from 'node:path'

export const VERSION: string = (JSON.parse(readFileSync(join(__dirname, '..', 'package.json'), 'utf8')) as { version: string }).version
