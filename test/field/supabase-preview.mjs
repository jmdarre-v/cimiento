// Field test path for the Supabase preview project (Goal 8, item 4). It runs only when the account
// has room: a paid organization the person chose (CIMIENTO_FIELD_SUPABASE_ORG), or two free slots,
// since the app needs its production project and its preview project. Otherwise it records why it
// stopped and exits 0. It never pauses, deletes or creates anything outside cimiento-test-8s.
//
// node test/field/supabase-preview.mjs [projectsDir]

import { execFileSync } from 'node:child_process'
import { existsSync, readFileSync, writeFileSync } from 'node:fs'
import { homedir } from 'node:os'
import { join, resolve } from 'node:path'
import { createRequire } from 'node:module'
import { fileURLToPath } from 'node:url'

const NAME = 'cimiento-test-8s'
const FREE_LIMIT = 2

/**
 * Whether the test can run, and in which organization. active is the number of active projects in
 * free organizations; orgs are the organizations the login sees, with their plans.
 */
export function decide({ chosen, orgs, active, freeLimit = FREE_LIMIT }) {
  if (chosen) {
    const org = orgs.find((o) => o.id === chosen)
    if (!org) return { run: false, reason: `CIMIENTO_FIELD_SUPABASE_ORG names ${chosen}, which this Supabase login cannot see.` }
    if (org.paid) return { run: true, org: org.id, reason: `the paid organization ${org.name}, chosen by the person` }
  }
  const slots = freeLimit - active
  if (slots >= 2) {
    const free = orgs.find((o) => !o.paid && (!chosen || o.id === chosen))
    if (free) return { run: true, org: free.id, reason: `${slots} free slots, in the free organization ${free.name}` }
    return { run: false, reason: 'two free slots, but no free organization to use' }
  }
  return {
    run: false,
    reason: `Supabase's free limit: ${active} active free project${active === 1 ? '' : 's'} of ${freeLimit}, and this test needs 2 slots (the production project and the preview project). Free a slot in the Supabase dashboard, or set CIMIENTO_FIELD_SUPABASE_ORG to a paid organization, then run this again.`,
  }
}

async function main() {
  const repo = resolve(fileURLToPath(new URL('../..', import.meta.url)))
  const require = createRequire(join(repo, 'package.json'))
  const { RealIo } = require('./dist/core/io')
  const { Redactor } = require('./dist/core/redact')
  const { activeFreeProjects } = require('./dist/providers/supabase')
  const { supabaseOrgsWithPlans, isPaidPlan } = require('./dist/wiring/vercel-supabase-runtime')
  const ctx = { io: new RealIo(), redactor: new Redactor(), manifest: { accounts: {}, options: { supabase: {} } }, state: { resources: {} } }

  const orgs = (await supabaseOrgsWithPlans(ctx, 'field')).map((o) => ({ id: o.id, name: o.name, paid: isPaidPlan(o.plan) }))
  const active = (await activeFreeProjects(ctx, 'field')).length
  const decision = decide({ chosen: process.env.CIMIENTO_FIELD_SUPABASE_ORG, orgs, active })
  const record = { test: 'supabase preview project', at: new Date().toISOString(), activeFreeProjects: active, ...decision }
  if (!decision.run) {
    console.log(JSON.stringify({ ...record, status: 'blocked' }))
    return
  }

  const dir = resolve(process.argv[2] ?? join(homedir(), 'Code.nosync'))
  const project = join(dir, NAME)
  if (existsSync(project)) throw new Error(`${project} exists; remove it or run cimiento down there first.`)
  const cli = (args, cwd) => execFileSync(process.execPath, [join(repo, 'dist/cli.js'), ...args], { cwd, encoding: 'utf8', stdio: ['ignore', 'pipe', 'ignore'] })
  const steps = []
  cli(['new', NAME, '--repo', 'github', '--hosting', 'vercel', '--database', 'supabase', '--auth', 'supabase', '--supabase-account', 'direct', '--template', 'nextjs-app', '--scaffold-only', '--json'], dir)
  const stack = join(project, 'stack.yaml')
  writeFileSync(stack, readFileSync(stack, 'utf8').replace(/^  supabase:\n/m, `  supabase:\n    organization_id: ${decision.org}\n`))
  let up = 0
  try {
    cli(['up', '--json', '--yes', '--allow-billing'], project)
  } catch (err) {
    up = err.status ?? 1
  }
  const state = JSON.parse(readFileSync(join(project, '.cimiento/state.json'), 'utf8')).resources
  const production = state['supabase.project']?.outputs?.projectRef
  const preview = state['supabase.preview-project']?.outputs?.projectRef
  steps.push({ step: 'up', exit: up, production: Boolean(production), preview: Boolean(preview), separate: Boolean(production && preview && production !== preview) })
  let down = 0
  try {
    cli(['down', '--yes', '--json'], project)
  } catch (err) {
    down = err.status ?? 1
  }
  steps.push({ step: 'down', exit: down })
  const passed = up === 0 && down === 0 && steps[0].separate
  console.log(JSON.stringify({ ...record, status: passed ? 'passed' : 'failed', steps }))
  if (!passed) process.exitCode = 1
}

if (process.argv[1] && resolve(process.argv[1]) === fileURLToPath(import.meta.url)) {
  main().catch((err) => {
    console.error(err instanceof Error ? err.message : String(err))
    process.exitCode = 1
  })
}
