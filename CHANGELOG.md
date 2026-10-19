# Changelog

## 0.4.2

Previews hold no Neon key, `down` cleans this machine, and `cimiento upgrade` brings older
projects along. 0.4.1 puts a Neon key that can read production in the preview env, and in 0.4.0
and 0.4.1 every preview's database address also opens production; upgrade.

### cimiento upgrade

- `cimiento upgrade` brings a project made by an older cimiento up to the current scaffold for its
  template: it shows each file it would add, replace, merge or remove, applies on confirmation or
  `--yes`, never replaces a file you changed without asking, and commits. In a project made by
  0.4.1 it also takes `NEON_API_KEY` and `NEON_PROJECT_ID` out of the preview env. `up` says when
  an upgrade is available and changes nothing.

### Local secrets

- `down` removes what cimiento wrote on this machine for the project once nothing is left to
  wait on: every keychain entry under service `cimiento` for its slug and the `.env.local` that
  `env pull` wrote.

### Preview credentials

- Previews no longer hold a Neon key. The preview database workflow writes only the branch's own
  addresses into the hosting env, for that git branch only, and deploys it again; `NEON_API_KEY`
  stays in GitHub Actions. 0.4.1 put `NEON_API_KEY` in the preview env, where preview code could
  read the production branch with it; run `cimiento upgrade` in a project made by 0.4.1.
- The workflow writes each branch's address with `VERCEL_TOKEN` or `NETLIFY_AUTH_TOKEN`, a token
  you make (neither host lets cimiento make one from its login) and set with `cimiento secret set`;
  it goes to GitHub Actions only. Both are optional: without one the workflow still makes and
  removes the Neon branch, and `cimiento up` writes its address.
- Each preview branch gets a database password of its own (BUG-114). Neon copies the roles of the
  branch a new branch is made from, passwords included, so in 0.4.0 and 0.4.1 the address a
  preview held also logged in to the production branch. The workflow and `cimiento up` now reset
  the preview role's password once before writing its address (after Neon has finished making the
  branch), and `doctor` reports
  `PREVIEW_PASSWORD_SHARED` for a preview branch that still has production's. In a project made by
  0.4.0 or 0.4.1, run `cimiento upgrade`, then `cimiento up`, which gives each existing preview
  branch its own password and writes its address again. Production's password is never changed.
- Secrets take `optional: true`: a missing value is skipped, never waited on.

## 0.4.1

Closes the limits 0.4.0 left: Neon previews without `cimiento up`, the commit stamp on CLI deploys,
and a noop `up` that took 90 s.

### Preview data

- Neon previews no longer wait for `cimiento up`. The scaffold ships a GitHub Actions workflow
  that makes a Neon branch for every branch besides production on push and deletes it with the
  branch, and the app finds its own branch at request time. A preview built before its branch
  exists answers with one clear sentence and never reads production. The key both use,
  `NEON_API_KEY`, is made by cimiento, scoped to the one Neon project, kept in the keychain
  (secret source `generated`), written to the Actions secret and the preview env, and revoked by
  `down`.
- `new` with `--template` writes `scaffold.ci: true`, so a project made from flags gets its
  workflows, as the presets do.

### Vercel

- `options.vercel.deployment_protection` is applied: `none` turns Vercel Authentication off on a
  project cimiento made, `strict` protects every deployment, and `standard` leaves the project's
  own setting alone. Before, the option was never sent to Vercel.

### Publish

- The commit stamp on Vercel CLI deploys now applies after any cimiento run: a tree where only
  `.cimiento/` changed counts as clean. `publish` treats a HEAD that only adds cimiento state on
  top of the live commit as live: it commits and pushes the state and waits for no deploy.
  `publish --json` reports the live commit it read and its source, `git` or `cimiento stamp`.

### Speed

- A noop `up` asks each tool for its version and each vendor CLI who is logged in once per run,
  all at once, and keeps both per machine for 10 minutes (`detect-cache.json` next to
  `machine.json`; the latest tool versions for an hour). A 401 or 403 from any vendor API, a CLI
  saying it is not logged in, an account mismatch or a login clears the identities. A run with no
  terminal builds the plan once instead of twice.

## 0.4.0

Identity-safe teardown, honest publish and isolated preview data. 0.3.0 and older delete some
resources by name; upgrade.

### Upgrading from 0.1.0 or 0.2.0

- State those versions wrote has no spec on any entry. The first command reads it as is and
  rebuilds each spec from `stack.yaml`, or, for a provider `stack.yaml` no longer selects, from
  `stack.yaml` with that provider put back in its slot. The first `up` or `down` saves the
  rebuilt state as version 2; `plan` only reports what it rebuilt.
- A record neither describes is reported by `plan` and by every command that writes state, and
  `down` exits non zero with LEGACY_STATE_UNRESOLVED until it is reconciled: delete the resource
  in its provider if it still exists, then run `cimiento down --release ID`.
- Run `cimiento plan` once after upgrading to see both lists before anything changes.
- A Marketplace Supabase database set up by 0.3.0 or older is connected to previews too. `up`
  stops with SUPABASE_PREVIEW_SHARES_PRODUCTION and prints the two commands that reconnect it to
  production and development, or set `environments.preview.database: shared` to keep sharing.
- A live Vercel deployment made by 0.3.0 or older records no commit. The first `publish` with
  nothing new stops with PUBLISH_LIVE_COMMIT_UNKNOWN; the next `publish` with a change brings a
  deploy that records it.

### Teardown

- `down` deletes by the id the provider gave when cimiento made the resource, never by a name.
  GitHub, whose delete takes a name, is read first and refused on a node id mismatch
  (DOWN_IDENTITY_MISMATCH). A record without an id is never looked up by name (DOWN_ID_MISSING).
- `down --release ID[,ID]` stops tracking resources and deletes nothing.

### Preview data

- Previews never share the production database by default. Neon: every git branch besides
  production gets a Neon branch, its address written for that branch's previews only, made and
  removed by `up` and removed by `down`. `environments.preview.database: shared` opts out, with a
  warning on every `plan` and `up`.
- Supabase: previews read a second project, `<slug>-preview`, with the same migrations. Through
  the Vercel Marketplace it is a second database connected to preview only, and production's is
  connected to production and development; direct, cimiento creates it. The free limit of 2
  active projects is stated by `plan` and `up` before it is made. `down` removes it.

### Secrets

- `doctor` and `up` compare each hosting env value with the one cimiento holds, when it has it
  without asking: a different value fails with SECRET_VALUE_MISMATCH, and `secret set` writes
  the right value over it and deploys again. Before, a key changed by hand passed `doctor` and
  `secret set` left it in place.

### Publish

- `publish` reads the live commit from the hosting only. A failed lookup, any non 2xx or a
  timeout, is unknown: publish exits non zero with PUBLISH_LIVE_COMMIT_UNKNOWN instead of saying
  there is nothing to publish from what an earlier run recorded.
- A Vercel deploy from the CLI with a clean tree carries its commit in the deployment meta.

## 0.3.0

Trustworthy state, teardown and health. 0.1.0 and 0.2.0 can lose track of resources during
teardown; upgrade.

### State and teardown

- `down` forgets a resource only when the provider confirms, by the id state recorded, that it is
  gone. A timeout, an auth error or a provider error keeps it in state and exits non zero.
- State, now version 2, records each resource's spec and the account it was made in. `plan` lists
  resources `stack.yaml` no longer selects as orphans, `up` asks whether to retain, release or
  destroy them (`--orphans`), and `down` deletes them in the account they were made in.
- State is written after every completed step, atomically, under a project lock; a lock left by
  a killed run is reported and taken over.

### Health

- `doctor` reports ok, failed or unknown, from the live check alone; a step confirmed once and
  later revoked shows as failed again.
- `plan` and `doctor` only read. The checks that act, the Resend test email, the PostHog event,
  the Inngest roundtrip, Turnstile siteverify and the Supabase table query, run under `--smoke`,
  which says what each will do first.
- `doctor` in a project without `stack.yaml` lists the providers it already uses, read only.

### Commands

- `publish` resumes: it pushes a commit that did not reach the remote and waits for the deploy
  when the live site is not built from HEAD, even with nothing new to commit.
- `new --scaffold-only` writes the project and touches no account.

### Providers and templates

- Neon migrations go whole through a Postgres client, dollar quoted bodies included, and an
  unreadable history table stops the run instead of reapplying everything.
- Every request has a bounded timeout; only reads are retried.
- Templates escape the project name in code, so any name builds.

### Project

- LICENSE (MIT), SECURITY.md and CONTRIBUTING.md.
- `install.sh` accepts `CIMIENTO_VERSION` to pin a release.
- A release workflow on version tags installs the packed tarball in a clean folder and builds a
  scaffolded project; CI runs the Neon migration tests against PostgreSQL.

### Fixed

BUG-71 to BUG-81, listed in `docs/FIELD-TEST-6.md`.

## 0.2.0

v2 of the spec: five more providers, the custom domain rule, the database and ci secret sinks,
and Windows through Ubuntu under WSL.

### Providers and wiring

- Netlify fills hosting. cimiento creates the site, links it to the GitHub repository with a read
  only deploy key and a webhook (no GitHub app install), sets the Next.js runtime, writes env per
  deploy context, builds, and waits for the deploy of each published commit.
- Neon fills database. neonctl logs in, the API creates the project, migrations in `db/migrations`
  run through Neon's HTTP query endpoint, and `DATABASE_URL` and `DATABASE_URL_UNPOOLED` go to the
  hosting env.
- Resend fills email; its check sends one email to Resend's test inbox.
- Stripe fills payments, in test mode only: a live key is refused the moment it is read.
- PostHog fills analytics; its check sends one event, and the ingestion host goes to the hosting
  env.
- The "any hosting" rules (Supabase Auth URLs, the Supabase direct keys, Turnstile, Neon, PostHog)
  work on Vercel and Netlify alike. Supabase on Netlify takes the direct path.
- Every new provider has its sign-up, login and key pages as person steps in English and Spanish.

### Commands

- `cimiento domain add <domain>` and `cimiento domain remove`: the domain on the hosting project,
  Supabase Auth URLs and Turnstile domains follow it, and a check proves it serves. A missing DNS
  record is a person step naming the exact record Vercel or Netlify asks for.
- `cimiento accounts set netlify` and `accounts set neon`.
- `cimiento publish`, `env pull`, `join` and `secret remove` work on Netlify.

### Secrets

- Sinks `database` (Supabase project secrets) and `ci` (GitHub Actions secrets, the value on
  stdin), covered by `secret set`, `rotate`, `check` and `remove`.
- `secret set` and `secret rotate` deploy again after they change a hosting env value, so the live
  app uses it at once.
- On Linux the keychain source uses `secret-tool` from libsecret.

### Checks

- `hosting.preview` on Vercel and Netlify: every pushed branch besides production has a ready
  preview of its head commit.
- A check that fails after its resource was applied, with a step only a person can do, now waits
  on the person (exit code 2) instead of failing.

### Install and CI

- `install.sh` supports Ubuntu, also under WSL on Windows: the apt packages Homebrew needs first,
  then the same Homebrew path as macOS.
- GitHub Actions runs typecheck, build, the tests and `install.sh --dry-run` on ubuntu-latest and
  macos-latest.

### Fixed

- BUG-58, 59: `install.sh --dry-run` fetched the Homebrew installer and said installed.
- BUG-60: `next-env.d.ts` was committed by the first publish after `cimiento dev`.
- BUG-61: a Next.js site on Netlify answered 404 without the Next.js runtime.
- BUG-62: `secret rotate` on Netlify talked about Vercel.
- BUG-63: `secret set` and `rotate` left the live app on the old value until the next deploy.
- BUG-64: the DNS step named the generic Vercel CNAME instead of the one Vercel recommends.
- BUG-66: a project without Supabase was asked where its Supabase database should go.
- BUG-67: the Neon login was not found where current neonctl keeps it.
- BUG-68: up after down in the same folder created the repository but pushed nothing.
- BUG-69: two keys on one page (Stripe) opened it twice and asked about the account twice.
- BUG-70: a repository left by a failed create was adopted on the next run, so down kept it.

## 0.1.0

The first public release.

### Commands

- `cimiento new` and `init` write `stack.yaml`, scaffold the project, and run `plan` and `up`.
- `cimiento plan`, `up` and `doctor`: plan, apply with person steps first and the rest
  unattended, and re-verify everything from reality.
- `cimiento down` deletes what cimiento created, in reverse dependency order, after the project
  name is typed back; it keeps what it adopted and lists what a vendor API cannot delete.
- `cimiento join` sets up a fresh clone: tools, logins, access, env pull and checks.
- `cimiento dev` starts the local database, the Inngest dev server and the app, one Ctrl+C.
- `cimiento publish` commits every change, pushes, waits for that commit's deploy and prints the
  URL.
- `cimiento secret set`, `rotate`, `remove` and `check`; `cimiento env pull` and `env print`;
  `cimiento accounts set`; `cimiento explain`.

### Providers and wiring

- GitHub, Vercel and Supabase, on the Vercel Marketplace path and the direct path.
- Inngest, with the Vercel integration and a roundtrip check of a real event.
- Cloudflare Turnstile, with widget domains that follow the production host and a siteverify check.
- Anthropic, with a free read only check of the key.

### Secrets

- Sources: hidden prompt, environment, macOS keychain and 1Password. Sink: the hosting env.
- Values never reach `stack.yaml`, state, logs, `--json` output, run logs or a chat window.

### Presets and templates

- `--preset fullstack`: GitHub, Vercel, Supabase, Inngest, Turnstile and Anthropic.
- `--preset designer`: GitHub and Vercel with the `designer-site` template and a `design/` folder
  for Claude Design exports.

### For people and agents

- Guided mode in English and Spanish: one question at a time, every step a person does explained
  first, every failure ending with one next command.
- Every person step gives the full link, Enter to open it, the clicks in order, each field and its
  value, the button, what success looks like, and Enter when done before cimiento verifies it.
- `--json` on every command, one line per event, exit codes 0 ok, 1 failed, 2 waiting on a person,
  3 blocked.
- Run logs in `~/.cimiento/runs/`, one per command, with UTC timestamps.
- `scripts/install.sh` installs Homebrew, the tools, Claude Code and cimiento, and logs in to
  Claude Code.
- The Claude Code plugin: `setup`, `new-project`, `explain` and `secrets` skills, and a hook that
  keeps `.env` files out of Claude.
- `docs/TROUBLESHOOTING.md`, generated from the knowledge base.
