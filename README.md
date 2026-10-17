# cimiento

One command that takes you from nothing to a deployed, wired, verified project skeleton, and
keeps that environment healthy afterwards. It installs tools, logs in, creates resources, wires
them together, pushes secrets, deploys, and proves the result works.

Everything runs on your machine with your own accounts. There is no hosted service.

## Five minute quick start, expert path

You need macOS, Node 22 and a GitHub account. Everything else cimiento installs for you.

```bash
npm install -g cimiento
```

You do not need to log in to anything first. The first time cimiento needs GitHub, Vercel or
Supabase, it opens that service's own login in your browser and waits while you approve it. You
never type a password or paste a token into cimiento.

Create a project. `--preset fullstack` selects GitHub for the repository, Vercel for hosting, and
Supabase for the database and auth through the Vercel Marketplace.

```bash
cimiento new my-app --preset fullstack
```

cimiento asks where to keep projects the first time, prints a plan, waits for one confirmation,
asks which Vercel team to use if you have more than one, and stops once at the Vercel Marketplace
page, which it opens for you, because only a person can accept terms. When it finishes
it prints the production URL and a receipt for every resource it touched.

Check the environment at any time. It re-probes reality, it does not trust the state file.

```bash
cimiento doctor
```

Pull the environment variables for local development. This is the only place secrets touch disk,
and the file is gitignored.

```bash
cimiento env pull
```

```bash
pnpm dev
```

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
| `cimiento down` | Delete everything in state, after you type the project name back |
| `cimiento accounts set <provider>` | Pick the GitHub account, Vercel team or Supabase organization again |
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

## Guided path

```bash
bash scripts/install.sh
cimiento new --guided --lang es
```

`scripts/install.sh` installs Homebrew when it is missing (it asks for the Mac password once),
then git, node, pnpm, gh, vercel, supabase, Claude Code and cimiento, skipping whatever is already
there, and ends with a table. `--guided` asks one question at a time, explains
every step a person has to do before it, and ends every failure with one next command.

## Claude Code plugin

```
/plugin marketplace add jmdarre-v/cimiento
/plugin install cimiento@cimiento
```

Skills `/cimiento:setup`, `/cimiento:new-project`, `/cimiento:explain` and `/cimiento:secrets`,
and a hook that blocks Claude from reading, searching or printing `.env` files.

## What is in this release

Providers: GitHub, Vercel, Supabase (both `via-hosting` and `direct`), Inngest, Turnstile and
Anthropic. Secret sources `prompt`, `env`, `keychain` and `1password`, secret sink `hosting`.
Templates `nextjs-app` and `designer-site`. Commands `join`, `dev`, `down`, `secret rotate` and
`secret remove`. Expert, guided (English and Spanish) and `--json` output. The installer script
and the Claude Code plugin.

## Contributing

`docs/SPEC.md` is the source of truth. `docs/GOALS.md` has the goals and their acceptance
criteria, and `docs/DECISIONS.md` records anything the spec did not cover.

```bash
pnpm install && pnpm build && pnpm test
```

## Receipts

| Resource | URL | Id |
|---|---|---|
| `github.session` |  | jmdarre-v |
| `github.repo` | <https://github.com/jmdarre-v/cimiento> | R_EXAMPLEPRIVATEREPO |
