# cimiento

One command that takes you from nothing to a deployed, wired, verified project skeleton, and
keeps that environment healthy afterwards. It installs tools, logs in, creates resources, wires
them together, pushes secrets, deploys, and proves the result works.

Everything runs on your machine with your own accounts. There is no hosted service.

## Install

On a Mac, or on Ubuntu, one line installs Homebrew if it is missing, then git, node, pnpm, gh,
vercel, supabase, Claude Code and cimiento, and logs you in to Claude Code at the end:

```bash
curl -fsSL https://raw.githubusercontent.com/jmdarre-v/cimiento/main/scripts/install.sh | bash
```

It skips whatever is already installed and ends with a table of every tool. Claude Code needs a
Claude Pro or Max plan. If you already have Node 22, `npm install -g cimiento` installs cimiento
alone. The CLIs of the other providers (Netlify, Neon, wrangler for Turnstile) are installed by
cimiento the first time a project needs them.

On Windows, install Ubuntu under WSL first, in PowerShell:

```bash
wsl --install
```

Then open the Ubuntu window and run the same one line there. On Ubuntu the installer first adds,
with apt, what Homebrew needs and `libsecret-tools` for keychain secrets, asking for the sudo
password once.

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

It commits your changes, pushes them, waits for the hosting (Vercel, or Netlify with
`--hosting netlify`) to deploy them and prints the address.

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
| `cimiento accounts set <provider>` | Pick the GitHub account, Vercel or Netlify team, Supabase or Neon organization, or Cloudflare account again |
| `cimiento domain add <domain>` | Put your own domain on the site; Supabase Auth URLs and Turnstile follow |
| `cimiento domain remove` | Take it off again; the default address keeps working |
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

| Sink | Where the value goes |
|---|---|
| `hosting` | The Vercel or Netlify env, per environment. Set and rotate deploy again so the live app uses it |
| `database` | Supabase project secrets, which Edge Functions read |
| `ci` | GitHub Actions secrets, through `gh secret set` with the value on stdin |

Sources: a hidden `prompt`, the `env`, the `keychain` (macOS keychain, or libsecret's
`secret-tool` on Linux) and `1password`.

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

## Providers

Each slot in `stack.yaml` is filled by one provider or `none`. Pick them with `--preset`, with a
flag per slot (`--hosting netlify --database neon`), or in `cimiento new --guided`.

| Slot | Provider | What cimiento does | What a person does, once |
|---|---|---|---|
| repo | GitHub | Creates the repository and pushes the scaffold | Logs in with `gh` |
| hosting | Vercel | Creates the project, links it to the repository, writes env, deploys | Logs in; on a private repository, lets the Vercel GitHub app see it |
| hosting | Netlify | Creates the site, links it with a deploy key and a webhook, sets the Next.js runtime, writes env per deploy context, builds | Logs in with `netlify login`; picks the team when there are several |
| database, auth | Supabase | Creates the database through the Vercel Marketplace (`via-hosting`) or the Supabase API (`direct`), runs migrations, sets Auth URLs | Logs in; accepts the Marketplace terms once per team |
| database | Neon | Creates the project, runs `db/migrations`, writes `DATABASE_URL` and `DATABASE_URL_UNPOOLED` to the hosting env | Logs in with `neonctl auth`; picks the organization when there are several |
| jobs | Inngest | Checks the Vercel integration, keeps its keys in the env, proves a real event runs | Approves the Inngest Vercel integration once |
| bot_protection | Turnstile | Creates the widget, writes its keys, keeps its domains on the production host | Logs in with `wrangler login` |
| email | Resend | Sends one email to Resend's test inbox to prove the key | Makes an API key; cimiento asks for it at a hidden prompt |
| payments | Stripe, test mode only | Reads the test balance to prove the key; refuses any live key | Copies the sandbox or test mode keys |
| analytics | PostHog | Writes the ingestion host, sends one event | Copies the project token (phc_) |
| ai | Anthropic | Proves the key with a free read only call | Makes an API key |

Every person step says the full link, the clicks in order, each field and value, the button and
what success looks like, in English and Spanish, and starts with a free sign-up when there is no
account yet. Netlify needs `repo: github`. Supabase on Netlify uses the `direct` path. Jobs with
Inngest need Vercel.

## Your own domain

```bash
cimiento domain add app.example.com
```

The domain goes on the Vercel project or Netlify site, Supabase Auth URLs and Turnstile widget
domains follow it, and a check fetches `https://app.example.com`. When your DNS lives elsewhere,
cimiento names the one record to add there (the CNAME Vercel recommends for the project, or
`<site>.netlify.app`) and checks it again on the next `cimiento doctor`.

## What is in this release

0.2.0: all of the above. Templates `nextjs-app` and `designer-site`. Expert, guided (English and
Spanish) and `--json` output. The installer script for macOS and Ubuntu, also under WSL, and the
Claude Code plugin. `CHANGELOG.md` has the details.

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
