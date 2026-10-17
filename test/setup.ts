// The environment every test runs in, the same on any machine and in CI.
import { mkdtempSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { join } from 'node:path'

// Run logs go to a temporary folder, never to ~/.cimiento/runs.
process.env.CIMIENTO_RUNS_DIR = mkdtempSync(join(tmpdir(), 'cimiento-runs-'))

// cimiento picks its language from LC_ALL or LANG. A developer's Spanish locale made the tests
// that read English output fail (BUG-55), so every test starts in English; Spanish tests pass
// --lang es themselves.
delete process.env.LC_ALL
delete process.env.LC_MESSAGES
process.env.LANG = 'en_US.UTF-8'

// A real token in the developer's environment must never reach the fake cloud.
for (const name of ['CLOUDFLARE_API_TOKEN', 'VERCEL_TOKEN', 'SUPABASE_ACCESS_TOKEN', 'GH_TOKEN', 'GITHUB_TOKEN', 'ANTHROPIC_API_KEY']) delete process.env[name]
