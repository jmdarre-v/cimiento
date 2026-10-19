# cimiento

![A key changed by hand in Vercel: cimiento doctor --smoke finds it and names the fix, cimiento secret set writes the right value back and deploys, and doctor is green again](docs/demo.gif)

cimiento connects your app's services, verifies the connections and helps you recover when they
break.

One command takes you from nothing to a deployed project on GitHub, hosting, a database and the
services you pick, with every key in the right place. It installs tools, logs in, creates
resources, wires them together, pushes secrets and deploys. Afterwards `cimiento doctor` checks
that each connection still works, and the commands pick up where an interrupted run stopped.

Everything runs on your machine with your own accounts. There is no hosted service.

## Install

On a Mac, or on Ubuntu, one line installs Homebrew if it is missing, then git, node, pnpm, gh,
vercel, supabase, Claude Code and cimiento, and logs you in to Claude Code at the end:

```bash
curl -fsSL https://raw.githubusercontent.com/jmdarre-v/cimiento/main/scripts/install.sh | bash
```

It skips whatever is already installed and ends with a table of every tool. Claude Code needs a
Claude Pro or Max plan. To install one release in particular, pin it:

```bash
curl -fsSL https://raw.githubusercontent.com/jmdarre-v/cimiento/main/scripts/install.sh | CIMIENTO_VERSION=0.4.2 bash
```
 If you already have Node 22, `npm install -g cimiento` installs cimiento
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
and a hook that stops Claude from reading, searching or printing `.env` files. The hook, like the
deny rule in the generated `.claude/settings.json`, is a guard against accidental disclosure, not
a security boundary: it keeps Claude Code from reading a key by mistake, and does not stop a
shell command that reads the file another way or a key pasted into a chat. See `SECURITY.md`.

## What it made

`stack.yaml` in the new project declares what the project should have. `.cimiento/state.json`
records what exists and when it was last verified. Both are committed, neither holds a secret.

To change the environment, edit `stack.yaml` and run `cimiento up`. Clicking in a dashboard also
works, and `cimiento doctor` will tell you about it the next time you run it.

## What a check proves

Each check says how far it got, from the weakest proof to the strongest:

| Level | Proves | Examples |
|---|---|---|
| Key exists | The value is in every place it was sent | `secrets.present`, `secret check` |
| Provider accepts it | The provider answers a read with that key | Stripe test balance, Anthropic models, Resend domains |
| App uses it | The deployed app answers with what the connection set up | `hosting.deployed` with the scaffold marker, Supabase Auth URLs, the Inngest app registered |
| End-to-end transaction | Something went all the way through | Inngest roundtrip event, Turnstile siteverify, Resend test email, PostHog event, a query on the migrated table |

`plan`, `doctor` and `up` only read, so they stop at the first three levels. The end-to-end checks
act on the outside world, and run only with `--smoke`, which says what each one will do before it
runs:

```bash
cimiento doctor --smoke
```

`doctor` reports each item as ok, failed or unknown. Unknown means the provider could not tell,
such as a timeout or a 503; it is never counted as ok, and something confirmed once and later
revoked, like GitHub access for Vercel, shows as failed again.

## What has been proven on real accounts

From the field tests in `docs/FIELD-TEST-*.md`. Unit tests cover every row on a fake cloud;
this table is about real accounts.

| Provider | Proven | Partially proven | Unproven |
|---|---|---|---|
| GitHub | Repository, push, delete, Actions secrets | | |
| Vercel | Project, repository link, env, deploy, publish, branch previews, preview values per git branch, a key changed by hand found by `doctor` and fixed by `secret set` (field test 7), deployment protection none, the commit stamp on a CLI deploy read back by `publish` on a clean tree (field test 8), a branch-scoped preview value read by that branch's preview (field test 9) | Custom domain: added, its DNS record named, removed; serving it was not run | |
| Netlify | Site, repository link, env per context, deploy, publish, pull request previews, secret set to remove, the commit of a rebuild read back by `publish` on a clean tree (field test 8), a branch context value read by that branch's deploy preview (field test 9) | | |
| Supabase | Direct and Marketplace paths, migrations, Auth URLs, project secrets | Preview project: the free limit stated first and the run stopped at it on an account with two active free projects (field tests 7 and 8; `test/field/supabase-preview.mjs` runs it when there is room) | The preview-only Marketplace database and a created preview project, covered by unit tests only |
| Neon | Project, connection strings in the hosting env, migrations through the Postgres client, a Neon branch per preview branch made, kept and removed by `up` and `down` (field test 7); the preview database workflow making and deleting a branch on a plain `git push`, a preview built before its branch answering with the clear message and then reading its own branch, the project scoped key revoked by `down` (field test 8); previews on Vercel and Netlify reading their own branch with no Neon key in reach; the workflow writing the branch's address, deploying it again and removing both with the branch, with no cimiento command between (field test 9) | | |
| Inngest | Integration, keys, roundtrip event | | |
| Turnstile | Widget, keys, domains, siteverify | | |
| Resend | Key, test email to the test inbox | The 0.3.0 read only key check | |
| Stripe | Test mode keys, test balance | | |
| PostHog | Project key, event received | | PostHog has no read only key check; without `--smoke` cimiento checks the key's shape |
| Anthropic | Key, read only call | | |
| Windows via WSL | | install.sh on Ubuntu 24.04 in a container | WSL itself |
| Recovery (0.3.0) | On Vercel: an up killed right after a create, resumed; a publish with a failed push, resumed; a hosting swap seen by plan and cleaned up by down (field test 6) | | The same on Netlify, Supabase and Neon, covered by unit tests only |

## Environments and databases

`stack.yaml` lists `dev`, `preview` and `production`, and secrets go to each environment you name.
Previews never read the production database by default.

- Neon: every git branch besides production gets a Neon branch of the project. The scaffold's
  GitHub Actions workflow, `preview-database`, makes it on every push and removes it when the git
  branch is deleted. With a hosting token you make (`cimiento secret set VERCEL_TOKEN`, or
  `NETLIFY_AUTH_TOKEN`), it also writes that branch's two addresses into the hosting env for that
  git branch only and deploys the branch again, so plain `git push` is enough; without one,
  `cimiento up` writes them. A preview built before its address exists answers with one sentence saying so and never
  reads production; the newer preview the workflow deploys reads its own branch. The app reads
  `DATABASE_URL` and nothing else: no preview holds a Neon key. `cimiento up` also writes each
  branch's address, and `down` removes every branch. A Neon branch starts as a copy of production
  taken when it is made; what the preview writes stays in it. `cimiento upgrade` brings a project
  made by an older version up to this.
- Supabase: previews read a second project, `<slug>-preview`, with the same migrations and its own
  sign in addresses. Through the Vercel Marketplace it is a second Marketplace database connected
  to the preview environment only, and production's is connected to production and development.
  With `accounts.supabase: direct`, cimiento creates it and writes its URL and keys into the
  preview env. Supabase's free plan allows 2 active projects per person, and this is the second
  for the app: `plan` and `up` say so before it is made, and at the limit cimiento lists which
  projects count and waits on you, with production untouched.
- A project set up by 0.3.0 or older through the Marketplace has its production database connected
  to previews too. `up` stops with SUPABASE_PREVIEW_SHARES_PRODUCTION and prints the two `vercel
  integration-resource` commands that reconnect it to production and development; cimiento never
  reconnects it on its own.
- To share the production database with previews on purpose, say so in `stack.yaml`; `plan` and
  `up` warn while it is set:

```yaml
environments:
  dev: {}
  preview:
    database: shared
  production: {}
```

## When something breaks

- An interrupted `up` resumes. State is written after every step, so the next run knows what was
  created; one run per project at a time, and a lock left by a killed run is reported and taken
  over.
- `cimiento publish` resumes too: with nothing new to commit it still pushes a commit that did not
  reach the remote, and waits for the deploy when the live site is not built from it.
- `cimiento down` forgets a resource only when the provider confirms it is gone. A timeout or an
  auth error keeps it in state and exits non zero; run it again.
- `cimiento down` deletes only by the id the provider gave when cimiento made the resource. A
  same-name project or repository someone made later is never touched: down refuses, keeps the
  record, and `cimiento down --release ID` stops tracking it without deleting anything.
- Changed a provider in `stack.yaml`, such as hosting from vercel to netlify? `plan` lists the old
  resources as orphans, and `up` asks whether to retain, release or destroy them:

```bash
cimiento up --orphans destroy
```

- In a project cimiento did not create, `cimiento doctor` without a `stack.yaml` does provider
  discovery and tool and session checks, not a full diagnosis. It reads `package.json`
  dependencies, `.vercel/project.json`, `vercel.json`, `netlify.toml`, `.netlify/state.json`,
  `supabase/config.toml` and the git remote, and lists each provider it finds with that evidence.
  For each one with a command line tool it says whether the tool is installed, its version and
  which account it is logged in as. It checks no resource, env var, key, deployment or database,
  runs none of the checks `doctor` runs in a project, writes nothing and always exits 0. `cimiento init` writes the `stack.yaml` that
  a full `doctor` needs.

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
| `cimiento down --release ID` | Stop tracking a resource, deleting nothing |
| `cimiento upgrade` | Bring a project made by an older cimiento up to the current scaffold, showing each change first |
| `cimiento doctor --smoke` | Also run the checks that act: a test email, an event, a test token |
| `cimiento up --orphans <choice>` | Retain, release or destroy resources `stack.yaml` no longer selects |
| `cimiento new <name> --scaffold-only` | Write the project files and stop, touching no account |
| `cimiento accounts set <provider>` | Pick the GitHub account, Vercel or Netlify team, Supabase or Neon organization, or Cloudflare account again |
| `cimiento domain add <domain>` | Put your own domain on the site; Supabase Auth URLs and Turnstile follow |
| `cimiento domain remove` | Take it off again; the default address keeps working |
| `cimiento explain <id>` | Plain language for a resource or an error, `--lang es` |
| `cimiento explain --list` | Sorted error codes and resource ids selected by `stack.yaml`; supports `--json` |

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
| jobs | Inngest | Checks the Vercel integration and keeps its keys in the env; with `--smoke`, proves a real event runs | Approves the Inngest Vercel integration once |
| bot_protection | Turnstile | Creates the widget, writes its keys, keeps its domains on the production host | Logs in with `wrangler login` |
| email | Resend | Reads what the key may do; with `--smoke`, sends one email to Resend's test inbox | Makes an API key; cimiento asks for it at a hidden prompt |
| payments | Stripe, test mode only | Reads the test balance to prove the key; refuses any live key | Copies the sandbox or test mode keys |
| analytics | PostHog | Writes the ingestion host, checks the key's shape; with `--smoke`, sends one event | Copies the project token (phc_) |
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

0.4.2: all of the above. Templates `nextjs-app` and `designer-site`. Expert, guided (English and
Spanish) and `--json` output. The installer script for macOS and Ubuntu, also under WSL, and the
Claude Code plugin. `CHANGELOG.md` has the details.

## Eject

cimiento is not a runtime. To stop using it, delete two things in the project:

```bash
rm -rf stack.yaml .cimiento
```

What stays, and keeps working without cimiento:

- A plain Next.js app. `package.json` has no cimiento dependency, so there is nothing to
  uninstall in the app. A few messages and comments in the code mention `cimiento doctor`; edit
  them when you like.
- The env vars in the hosting provider, as native Vercel or Netlify environment variables, per
  environment. `vercel env pull` or the Netlify dashboard reads them from then on.
- The GitHub repository, its Actions secrets and, with Supabase, the migrations workflow, which
  runs the Supabase CLI and needs no cimiento.
- The databases: the Supabase or Neon project, and the preview project or the Neon preview
  branches. Nothing removes a preview branch when its git branch goes any more; delete it in the
  Neon console. Neon migrations in `db/migrations` are no longer applied for you.
- The secret values in the macOS keychain under the service `cimiento`, and `~/.cimiento` with
  the run logs. Both are on your machine only; delete them when you like.

Nothing in any account is deleted by ejecting. To delete the resources instead, run
`cimiento down` before removing the files.

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
