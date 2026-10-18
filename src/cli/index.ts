// Command dispatch. Every command works with --json and every failure leaves as a CimientoError
// with a hint, per the common rules in docs/GOALS.md.

import { asCimientoError, ExitCode } from '../core/errors'
import { parseArgs, flagBool } from './args'
import { openSession, defaultWriter, type CliDeps } from './context'
import { accountsSetCommand } from './commands/accounts'
import { domainAddCommand, domainRemoveCommand } from './commands/domain'
import { doctorCommand } from './commands/doctor'
import { downCommand } from './commands/down'
import { envPrintCommand, envPullCommand } from './commands/env'
import { explainCommand } from './commands/explain'
import { initCommand, newCommand } from './commands/init'
import { devCommand } from './commands/dev'
import { joinCommand } from './commands/join'
import { publishCommand } from './commands/publish'
import { planCommand } from './commands/plan'
import { secretCheckCommand, secretRemoveCommand, secretRotateCommand, secretSetCommand } from './commands/secret'
import { upCommand } from './commands/up'

import { VERSION } from '../version'

export { VERSION }

const HELP = `cimiento, one command from nothing to a deployed project.

Usage
  cimiento new <name> [--preset fullstack|designer]   create, scaffold, plan and up
  cimiento init [name]                           write stack.yaml in this folder
  cimiento plan                                  show what would change, change nothing
  cimiento up                                    apply the plan
  cimiento doctor                                re-verify everything and report
  cimiento env pull                              write .env.local from the hosting env store
  cimiento env print                             non secret outputs and URLs
  cimiento secret set <NAME>                     hidden prompt, push to every sink
  cimiento secret rotate <NAME>                  new value, written over every sink
  cimiento secret remove <NAME>                  undeclare it, delete it from every sink
  cimiento secret check                          prove every declared secret exists
  cimiento join                                  on a clone: tools, logins, access, env, checks
  cimiento dev                                   local database, jobs server and app, one Ctrl+C
  cimiento publish [--message <text>]            commit every change, push, wait for the deploy, print the URL
  cimiento down                                  delete everything in state, after typing the name
  cimiento accounts set <provider> [--to <id>]   pick the account again: github, vercel, netlify, supabase, neon or turnstile
  cimiento domain add <domain>                   put your own domain on the site, with auth URLs and Turnstile following
  cimiento domain remove [domain]                take it off again; the default address keeps working
  cimiento explain <resource|error>              plain language

Flags
  --json                 machine readable output, one object or one event per line
  --lang en|es           language for explanations
  --yes                  skip the confirmation, refused when billable items exist
  --allow-billing        approve the billable items in this plan
  --only <provider>      restrict to one provider, comma separated
  --skip <provider>      skip a provider, comma separated
  --dir <path>           where cimiento new puts the project

Exit codes
  0 ok    1 failed    2 needs human    3 blocked
`

export async function run(argv: string[], deps: CliDeps = {}): Promise<number> {
  const args = parseArgs(argv)
  const writer = deps.writer ?? defaultWriter

  if (flagBool(args.flags, 'version') || args.command === 'version') {
    writer.out(`${VERSION}\n`)
    return ExitCode.ok
  }
  if (flagBool(args.flags, 'help') || args.command === 'help' || args.command === '') {
    writer.out(HELP)
    return ExitCode.ok
  }

  const session = openSession(args, deps)
  session.runLog.write({ type: 'start', command: [args.command, args.sub].filter(Boolean).join(' '), argv })
  const code = await dispatch(session, args)
  session.runLog.write({ type: 'end', exitCode: code })
  return code
}

async function dispatch(session: ReturnType<typeof openSession>, args: ReturnType<typeof parseArgs>): Promise<number> {
  try {
    switch (args.command) {
      case 'new':
        return await newCommand(session)
      case 'init':
        return await initCommand(session)
      case 'plan':
        return await planCommand(session)
      case 'up':
        return await upCommand(session)
      case 'doctor':
        return await doctorCommand(session)
      case 'down':
        return await downCommand(session)
      case 'join':
        return await joinCommand(session)
      case 'dev':
        return await devCommand(session)
      case 'publish':
        return await publishCommand(session)
      case 'env':
        if (args.sub === 'pull') return await envPullCommand(session)
        if (args.sub === 'print') return await envPrintCommand(session)
        return unknown(session, `env ${args.sub ?? ''}`.trim(), 'env pull, env print')
      case 'secret':
        if (args.sub === 'set') return await secretSetCommand(session)
        if (args.sub === 'rotate') return await secretRotateCommand(session)
        if (args.sub === 'remove') return await secretRemoveCommand(session)
        if (args.sub === 'check') return await secretCheckCommand(session)
        return unknown(session, `secret ${args.sub ?? ''}`.trim(), 'secret set, secret rotate, secret remove, secret check')
      case 'accounts':
        if (args.sub === 'set') return await accountsSetCommand(session)
        return unknown(session, `accounts ${args.sub ?? ''}`.trim(), 'accounts set')
      case 'domain':
        if (args.sub === 'add') return await domainAddCommand(session)
        if (args.sub === 'remove') return await domainRemoveCommand(session)
        return unknown(session, `domain ${args.sub ?? ''}`.trim(), 'domain add, domain remove')
      case 'explain':
        return await explainCommand(session)
      default:
        return unknown(session, args.command, 'new, init, plan, up, doctor, join, dev, publish, down, accounts, domain, env, secret, explain')
    }
  } catch (err) {
    const error = asCimientoError(err, {
      code: 'CHECK_FAILED',
      provider: 'core',
      resource: args.command,
      hint: 'Run cimiento doctor --json for the full picture, or cimiento explain <resource> for what a step does.',
    })
    session.printer.error(error.toJSON())
    if (error.needsHuman) return ExitCode.needsHuman
    return ExitCode.failed
  }
}

function unknown(
  session: ReturnType<typeof openSession>,
  command: string,
  available: string,
): number {
  session.printer.error({
    code: 'MANIFEST_INVALID',
    provider: 'core',
    resource: command,
    message: `No command named ${command}.`,
    hint: `The commands in this build are: ${available}. Run cimiento --help.`,
    retryable: false,
    needsHuman: true,
  })
  return ExitCode.failed
}

export { parseArgs }
export type { CliDeps }
