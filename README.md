# cimiento

One command that takes you from nothing to a deployed, wired, verified project skeleton, and
keeps that environment healthy afterwards. It installs tools, logs in, creates resources, wires
them together, pushes secrets, deploys, and proves the result works.

Everything runs on your machine with your own accounts. There is no hosted service.

## Install

On a Mac, one line installs Homebrew if it is missing, then git, node, pnpm, gh, vercel,
supabase, Claude Code and cimiento, and logs you in to Claude Code at the end:

```bash
curl -fsSL https://raw.githubusercontent.com/jmdarre-v/cimiento/main/scripts/install.sh | bash
```

It skips whatever is already installed and ends with a table of every tool. Claude Code needs a
Claude Pro or Max plan. If you already have Node 22, `npm install -g cimiento` installs cimiento
alone.

## Guided path, for a first project

```bash
cimiento new my-site --guided --lang es --preset designer
```

cimiento asks one question at a time, in Spanish here or in English without `--lang es`. It
explains each step a person has to do before asking for it, lists all of them first, and then
says the rest runs on its own. Each step gives the full link, the clicks in order, each field and
its value, the button and what you will see when it worked; you press Enter to open the page and
Enter when you are done, and cimiento checks it. If you have no GitHub or Vercel account yet, it
walks you through creating one.

The designer preset makes a website on GitHub and Vercel with a `design/` folder for Claude
Design exports. When you change the site:

```bash
cimiento publish
```

It commits your changes, pushes them, waits for Vercel to deploy them and prints the address.

## Expert path

```bash
cimiento new my-app --preset fullstack --allow-billing
```

`--preset fullstack` selects GitHub, Vercel, Supabase, Inngest, Turnstile and Anthropic. cimiento
asks for the logins and account choices before it prints the plan, so every billing line names
who pays and on which plan, then waits for one confirmation and runs the rest unattended. It ends
with the production URL and a receipt for every resource it touched.

```bash
cimiento doctor
```

`doctor` re-probes reality instead of trusting the state file. Every command takes `--json` for
agents and scripts. Pull the environment variables for local work with `cimiento env pull`, the
only place secrets touch disk, in a gitignored file, and start everything locally with
`cimiento dev`.

## Claude Code plugin

```
/plugin marketplace add jmdarre-v/cimiento
/plugin install cimiento@cimiento
```

Skills `/cimiento:setup`, `/cimiento:new-project`, `/cimiento:explain` and `/cimiento:secrets`,
and a hook that blocks Claude from reading, searching or printing `.env` files.

## What it made

`stack.yaml` in the new project declares what the project should have. `.cimiento/state.json`
records what exists and when it was last verified. Both are committed, neither holds a secret.

To change the environment, edit `stack.yaml` and run `cimiento up`. Clicking in a dashboard also
works, and `cimiento doctor` will tell you about it the next time you run it.

## Commands

| Command | What it does |
|---|---|
| `cimiento new <name>` | Create the folder, scaffold it, plan and apply |
| `cimiento init` | Write `stack.yaml` into a project you already have |
| `cimiento plan` | Show what would change. Changes nothing |
| `cimiento up` | Apply the plan, stopping at anything only a person can do |
| `cimiento doctor` | Re-verify every tool, session, resource, binding and check |
| `cimiento env pull` | Write `.env.local` from the hosting env store |
| `cimiento env print` | Non secret outputs and URLs |
| `cimiento secret set NAME` | Hidden prompt, then push to every declared destination |
| `cimiento secret check` | Prove every declared secret exists, without printing one |
| `cimiento join` | On a fresh clone: tools, logins, access, env pull and checks |
| `cimiento dev` | Local database, jobs dev server and app on fixed ports, one Ctrl+C |
| `cimiento publish` | Commit every change, push, wait for the deploy, print the URL |
| `cimiento secret rotate NAME` | A new value, written over every destination |
| `cimiento secret remove NAME` | Take a secret out of the project and every destination |
| `cimiento down` | Delete everything in state, after you type the project name back |
| `cimiento accounts set <provider>` | Pick the GitHub account, Vercel team, Supabase organization or Cloudflare account again |
| `cimiento explain <id>` | Plain language for a resource or an error, `--lang es` |

Every command takes `--json`. Exit codes are 0 ok, 1 failed, 2 needs human, 3 blocked.

## Secrets

Values never live in `stack.yaml`, in state, in a log line, in `--json` output or in a chat
window. Logs print `NAME=****`.

```bash
cimiento secret set ANTHROPIC_API_KEY
```

cimiento prompts with hidden input, pushes the value to every sink the manifest declares, and
keeps no copy. `.env*` is gitignored from the scaffold, and the generated `.claude/settings.json`
denies Claude Code any read of it.

## stack.yaml

The only file you edit by hand.

```yaml
version: 1
name: my-app
slug: my-app

slots:
  repo: github
  hosting: vercel
  database: supabase
  auth: supabase

accounts:
  github: your-handle
  supabase: via-hosting

environments: [dev, preview, production]

secrets:
  - name: ANTHROPIC_API_KEY
    sinks: [hosting]
    environments: [preview, production]

scaffold:
  template: nextjs-app
```

`accounts` pins which account each provider must be logged in as. A session for a different
account stops the run instead of deploying your project somewhere you did not mean.

## What is in this release

Providers: GitHub, Vercel, Supabase (both `via-hosting` and `direct`), Inngest, Turnstile and
Anthropic. Secret sources `prompt`, `env`, `keychain` and `1password`, secret sink `hosting`.
Templates `nextjs-app` and `designer-site`. Commands `join`, `dev`, `down`, `secret rotate` and
`secret remove`. Expert, guided (English and Spanish) and `--json` output. The installer script
and the Claude Code plugin.

## Contributing

`docs/SPEC.md` is the source of truth. `docs/GOALS.md` has the goals and their acceptance
criteria, and `docs/DECISIONS.md` records anything the spec did not cover.
`docs/TROUBLESHOOTING.md` lists every error and what to do about it, and `CHANGELOG.md` what
each release brought.

```bash
pnpm install && pnpm build && pnpm test
```

## Receipts

| Resource | URL | Id |
|---|---|---|
| `github.session` |  | jmdarre-v |
| `github.repo` | <https://github.com/jmdarre-v/cimiento> | R_kgDOVN4WAw |
