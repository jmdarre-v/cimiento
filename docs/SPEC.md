# cimiento: project environment setup tool

Name: `cimiento`. Bin `cimiento`, with `cim` as a second bin entry for typing speed. Keychain service, config folder and state folder all use `cimiento`.

## 1. Purpose

One command that takes a person from "nothing" to a deployed, wired, verified project skeleton, and keeps that environment healthy afterwards. It installs tools, logs in, creates resources, wires them together, pushes secrets, deploys, and proves the result works.

Three audiences, one engine:

| Audience | How they use it | What they see |
|---|---|---|
| Expert | `cimiento new my-app --preset fullstack` | A plan, a confirmation, a URL |
| Beginner (designer, first-timer) | `cimiento new --guided` | One question at a time, explanations, Spanish or English |
| Agent (Claude Code) | `cimiento plan --json`, `cimiento up --json` | Machine-readable plan, structured errors with remediation hints |

## 2. Non-goals

- Managing real infrastructure (VPCs, clusters, IAM). When a project outgrows cimiento, the manifest and state file are the inputs to that migration.
- Running the application. `cimiento dev` starts local services; the app itself is the framework's business.
- A hosted service. Everything runs on the person's machine with their own accounts.
- Supporting providers nobody on the team uses. Every provider module is a maintenance surface.

## 3. Concepts

**Slot.** A capability the project needs. Each slot is filled by exactly one provider or by `none`.

| Slot | v0 | Later |
|---|---|---|
| repo | github | gitlab |
| hosting | vercel | netlify |
| database | supabase | neon |
| auth | supabase | clerk |
| jobs | inngest | trigger.dev |
| bot_protection | turnstile | none |
| email | none | resend |
| payments | none | stripe |
| analytics | none | posthog |
| ai | anthropic | openai |

**Provider.** A module that fills one or more slots. Vercel fills hosting and is also the env store and the marketplace path to a database. Supabase fills database, auth and storage.

**Resource.** Anything cimiento manages. Six kinds:

| Kind | Example | Managed where |
|---|---|---|
| tool | node 22.x, gh, vercel CLI | Machine |
| session | logged in to Vercel as team X | Machine |
| resource | repo, Vercel project, Supabase project, Turnstile widget | Provider account |
| binding | Supabase URL flows into Vercel env `NEXT_PUBLIC_SUPABASE_URL` | Provider account |
| manual | accept Marketplace terms in the browser | Human, then verified |
| check | deployed page returns 200, migration applied | Nothing; a probe |

**Manifest.** `stack.yaml` in the repo. Declares slots, accounts, environments, secrets and options. The only file a person edits.

**State.** What cimiento created and last verified. Machine state and project state are separate files. Secrets are in neither.

**Wiring rule.** A rule attached to a pair of providers, not to a provider. "Supabase auth URLs follow the hosting domain" is written once and works for Vercel or Netlify. "Database provisioned through the hosting marketplace" exists only for the Vercel plus Supabase pair.

**Deferred value.** An output known only after a later step (the production URL exists after the first deploy). The engine runs passes until nothing is pending instead of following a fixed order.

## 4. Manifest: `stack.yaml`

```yaml
version: 1
name: my-app
slug: my-app

slots:
  repo: github
  hosting: vercel
  database: supabase
  auth: supabase
  jobs: inngest
  bot_protection: turnstile
  email: none
  payments: none
  analytics: none
  ai: anthropic

accounts:
  github: your-handle
  vercel: team_abc123
  supabase: via-hosting

environments: [dev, preview, production]

options:
  github:
    visibility: private
  vercel:
    plan: pro
    deployment_protection: standard
    framework: nextjs
  supabase:
    region: us-east-1
    migrations: supabase/migrations
  turnstile:
    mode: managed

secrets:
  - name: ANTHROPIC_API_KEY
    sinks: [hosting]
    environments: [preview, production]
  # Per-project secrets: one specific project needs these two, so they are an example of what a
  # project adds to its own stack.yaml, not part of the standard stack or any preset.
  - name: TYPESAFE_API_KEY
    sinks: [hosting]
  - name: XPOZ_API_KEY
    sinks: [hosting]

domain: null

scaffold:
  template: nextjs-app
  claude_md: true
  ci: true
```

Rules:

- `slots` is the only required section. Everything else has defaults.
- `accounts` pins which account each provider must be logged in as. A session for a different account is a plan failure, not a silent misdeploy.
- `secrets` declares names and destinations only. Values are never in the manifest.
- A secret only one project needs, such as `TYPESAFE_API_KEY` and `XPOZ_API_KEY` above, is declared in that project's `stack.yaml`, never in a preset. `ANTHROPIC_API_KEY` belongs to the standard stack because the `ai` slot needs it.
- `accounts.supabase: via-hosting` means the Supabase project is created through the Vercel Marketplace and keys arrive automatically. `direct` means the Supabase CLI creates it and cimiento pushes keys to the hosting env store.
- Presets are manifest fragments: `--preset fullstack` merges the fragment above without its per-project secrets, so `ANTHROPIC_API_KEY` is its only secret; `--preset designer` sets hosting and repo only, everything else `none`.

## 5. Provider module interface

Every provider is one folder exporting one object. TypeScript, no framework.

```ts
type Slot = 'repo' | 'hosting' | 'database' | 'auth' | 'jobs'
  | 'bot_protection' | 'email' | 'payments' | 'analytics' | 'ai'

type Lang = 'en' | 'es'

interface ToolSpec {
  name: string
  bin: string
  versionRange: string
  install: { brew?: string; npm?: string; script?: string }
  versionCmd: string
}

interface Provider {
  id: string
  fills: Slot[]
  tools: ToolSpec[]
  needsSession: boolean
  planRequirements?: { plan: string; reason: string }

  detect(ctx: Ctx): Promise<Detection>
  login(ctx: Ctx): Promise<Session>
  resources(m: Manifest, state: ProjectState): ResourceSpec[]
  ensure(r: ResourceSpec, ctx: Ctx): Promise<EnsureResult>
  verify(r: ResourceSpec, ctx: Ctx): Promise<CheckResult>
  destroy(r: ResourceSpec, ctx: Ctx): Promise<void>
  outputs(r: ResourceSpec, ctx: Ctx): Promise<Record<string, Output>>
  explain(key: string, lang: Lang): string
}

interface Detection {
  installed: boolean
  version?: string
  session?: { account: string; expiresAt?: string }
}

interface ResourceSpec {
  id: string
  kind: 'tool' | 'session' | 'resource' | 'binding' | 'manual' | 'check'
  provider: string
  dependsOn: string[]
  inputs: Record<string, Value>
  billable?: boolean
  manual?: { instructions: string; url?: string }
}

type Value = string | { deferred: string }

interface EnsureResult {
  action: 'created' | 'adopted' | 'updated' | 'noop'
  externalId?: string
  url?: string
  outputs?: Record<string, Output>
}

interface Output {
  value?: string
  deferred?: boolean
  secret: boolean
}

interface CheckResult {
  ok: boolean
  error?: CimientoError
  evidence?: string
}

interface CimientoError {
  code: string
  provider: string
  resource: string
  message: string
  hint: string
  docsUrl?: string
  retryable: boolean
  needsHuman: boolean
}
```

Contracts every module must honor:

- `ensure` is idempotent. Second call with the same inputs returns `noop`. Existing resources are matched by name and account and returned as `adopted`, never duplicated.
- `verify` proves function, not existence. A hosting check fetches the deployed URL; a database check runs a migration and queries; a jobs check fires an event and sees it processed.
- `login` uses the vendor's browser or device flow. No password prompts, no token pasting unless the vendor offers nothing else, and then via hidden input.
- `explain` returns plain language for a non-developer, in the requested language, for every resource id and error code the module can produce.
- Prefer the vendor CLI for auth and the vendor API for resources. CLIs handle token storage; APIs give structured responses.

## 6. Wiring rules

Rules live in `src/wiring/`, one file per pair, each exporting a list of bindings and manual steps to add when both providers are selected.

| Pair | Rule |
|---|---|
| vercel + supabase (via-hosting) | Create Supabase through `vercel install supabase`; keys land in Vercel env; manual step: Marketplace terms on first install |
| vercel + supabase (direct) | Create with Supabase CLI; push URL, anon key, service role key to Vercel env per environment |
| any hosting + supabase | Supabase Auth Site URL and Redirect URLs follow the production URL and preview pattern; deferred until first deploy |
| vercel + inngest | Manual step: approve Inngest Vercel integration; deployment protection set to allow Inngest; signing key and event key land in Vercel env |
| any hosting + turnstile | Widget domains follow production and preview domains; site key public, secret key to hosting env |
| github + any hosting | Hosting project linked to repo; production branch `main`; preview on PRs |
| any hosting + custom domain | Domain added to hosting; Supabase Auth URLs and Turnstile domains updated |

## 7. State

**Machine state** `~/.config/cimiento/machine.json`

```json
{
  "version": 1,
  "os": "darwin",
  "shell": "zsh",
  "tools": { "gh": { "version": "2.x", "checkedAt": "..." } },
  "sessions": { "vercel": { "account": "team_abc", "checkedAt": "..." } },
  "lang": "en",
  "projectsDir": "~/Code.nosync"
}
```

**Project state** `.cimiento/state.json`, committed.

```json
{
  "version": 1,
  "manifestHash": "sha256",
  "resources": {
    "github.repo": { "externalId": "R_abc", "url": "https://github.com/x/y", "createdAt": "...", "verifiedAt": "..." },
    "vercel.project": { "externalId": "prj_abc", "url": "...", "outputs": { "productionUrl": "https://..." } }
  },
  "manualDone": ["vercel.marketplace-terms"]
}
```

Rules: no secret values anywhere in state; `verifiedAt` older than 7 days makes `doctor` re-probe; `manifestHash` mismatch makes `up` re-plan.

**Run logs** `~/.cimiento/runs/<UTC timestamp>-<command>.jsonl`, one per command and one per `install.sh` run. Every line has a UTC timestamp and is an event, a line shown, a prompt shown or the answer given. Hidden answers and secret values are never written; they appear as `****`.

## 8. Secrets

| Source | How |
|---|---|
| prompt | Hidden input in the terminal |
| keychain | macOS `security` CLI, service `cimiento`, account `<project>/<NAME>` |
| 1password | `op read op://vault/item/field` |
| env | Existing environment variable, for CI |

| Sink | How |
|---|---|
| hosting | `vercel env add` or Netlify env API, per environment |
| database | Supabase secrets |
| ci | `gh secret set` |

Rules:

- Values never appear in the manifest, state, logs, `--json` output or a chat window. Logs print `NAME=****`.
- `.env*` is in `.gitignore` from scaffold; the Claude Code plugin ships a permission rule denying reads of `.env*`.
- `cimiento secret set NAME` prompts and pushes to every declared sink. `cimiento secret rotate NAME` re-prompts and updates all sinks. `cimiento secret check` verifies every declared secret exists in every sink without printing values.
- `cimiento env pull` writes `.env.local` from the hosting env store for local dev. This is the only place secrets touch disk, and it is gitignored.

## 9. Commands

| Command | Behavior |
|---|---|
| `cimiento new [name]` | Creates `<projectsDir>/<slug>` (asks for `projectsDir` on first use, stored in machine state), interactive slot selection (or `--preset`, or flags), writes `stack.yaml`, scaffolds, then runs `plan` and `up` |
| `cimiento init` | Writes `stack.yaml` in an existing folder without scaffolding |
| `cimiento plan` | Reads manifest and state, refreshes reality, prints every item as create, adopt, update, noop, needs-human or blocked; warns on billable items and plan requirements; never changes anything |
| `cimiento up` | Applies the plan; stops at manual steps, explains, waits for Enter, verifies, continues; ends with checks and receipts |
| `cimiento doctor` | Re-detects tools and sessions, re-verifies every resource and binding, runs checks; prints a table and structured errors |
| `cimiento env pull` | Writes `.env.local` from the hosting env store |
| `cimiento env print --json` | Non-secret outputs and URLs |
| `cimiento secret set/rotate/check NAME` | See section 8 |
| `cimiento dev` | Starts local database, jobs dev server and framework with fixed ports; one process, one Ctrl+C |
| `cimiento publish` | Commits every change with a message, pushes, waits for the hosting deploy of that commit and prints the URL |
| `cimiento join` | On a cloned repo: tools, logins, access verification against every resource in state, env pull, checks |
| `cimiento down` | Destroys everything in state across providers, in reverse dependency order, after typed confirmation of the project name |
| `cimiento explain <resource|error>` | Plain-language explanation, `--lang es` |

Global flags: `--guided`, `--json`, `--lang en|es`, `--yes` (skip confirmation, refused when billable items exist unless `--allow-billing`), `--only <provider>`, `--skip <provider>`.

## 10. Output modes

**Expert (default).** Plan table, one confirmation, progress lines, receipts. No explanations unless something fails.

**Guided.** One question at a time. Before every manual step and every billable item, the `explain` text. After every failure, the hint in plain language and the exact next action. Spanish when `--lang es` or when the machine locale is Spanish.

**JSON.** `plan --json` emits the full item list with status, dependencies and `explain` keys. `up --json` emits one line per event. Errors are `CimientoError` objects. Exit codes: 0 ok, 1 failed, 2 needs human, 3 blocked.

## 11. Scaffold

`cimiento new` generates:

- Starter code from the selected template (`nextjs-app` in v0; `designer-site` in v1 with a `design/` folder for Claude Design exports)
- `.env.example` derived from bindings and declared secrets, names only
- `.gitignore` including `.env*`, `.cimiento/cache`, `design/exports/*.zip`
- `.github/workflows/migrations.yml` when database is set, applying migrations on merge to `main`
- `README.md` with a Receipts section listing every resource with its URL
- `CLAUDE.md` describing the stack, the commands, and the rule that secrets go through `cimiento secret`, never through chat
- `.claude/settings.json` with permission rules denying reads of `.env*`

## 12. Checks (probes)

| Check | Proves |
|---|---|
| hosting.deployed | Production URL returns 200 with the scaffold marker |
| hosting.preview | A preview deployment exists for a test branch (v1) |
| database.migrated | Migration applied; a query against the schema table succeeds |
| auth.urls | Supabase Auth Site URL equals production URL |
| jobs.roundtrip | Event sent, function ran, completion visible via Inngest API |
| bot_protection.verify | Test token validates against the secret key |
| secrets.present | Every declared secret exists in every sink |
| repo.linked | Hosting project points at the repo and branch |

Every check returns evidence (a URL, an id, a timestamp) that goes into the receipts.

## 13. Knowledge base

`src/kb/*.yaml`: known failure signatures mapped to a code, hint and fix. Every `CimientoError` code has an entry. When a field test surfaces a new stall, it becomes an entry before the fix is merged. This is the part of the tool that compounds.

## 14. Installer script

`scripts/install.sh`, macOS only in v0. Installs Homebrew if missing, then git, node, pnpm, gh, vercel, supabase and Claude Code. Idempotent. Ends with a table. Installs cimiento itself last. Windows via WSL is v2.

## 15. Claude Code plugin

`plugin/` with skills:

- `setup`: runs `cimiento doctor --json`, fixes only failing items, asks one question at a time
- `new-project`: runs `cimiento new --json` driven by a short conversation
- `explain`: wraps `cimiento explain`
- `secrets`: refuses any pasted key and points to `cimiento secret set`

Ships the `.env*` deny rule.

## 16. Repository layout

```
cimiento/
  src/
    core/         engine, planner, state, deferred values, errors
    manifest/     schema, defaults, presets
    providers/    github/ vercel/ supabase/ inngest/ turnstile/ anthropic/
    wiring/       one file per provider pair
    secrets/      sources and sinks
    scaffold/     templates
    cli/          commands, output modes, i18n
    kb/           failure signatures
  plugin/         Claude Code plugin
  scripts/        install.sh
  test/
    unit/         mocked CLIs and APIs
    field/        real accounts, cimiento-test- prefix, always ends with cimiento down
  docs/
    SPEC.md GOALS.md
```

## 17. Testing

- Unit: every provider against recorded CLI and API responses. Idempotency is a required test: `ensure` twice returns `noop`.
- Field: real accounts on the profiles cimiento already runs on, using the sessions they already have; every resource named `cimiento-test-<n>`, and `cimiento down` at the end. Run before each release, never in CI. A step that needs a browser stops the test with the exact attended command.
- Timings come from run logs in `~/.cimiento/runs/`, never from a person timing by hand. A phase with no run log says not measured.
- User zero: the from-nothing test is the first beginner on her own Mac, after the release in Goal 4: the install one-liner from the public repository, then `cimiento new --guided`. Her run logs are the record, and every stall in them becomes a knowledge base entry.

## 18. Priority

| Stage | Scope |
|---|---|
| v0 | Engine, manifest, state, plan/up/doctor, providers github, vercel, supabase (via-hosting and direct), scaffold nextjs-app, checks, expert mode, JSON mode |
| v1 | inngest, turnstile, anthropic; secrets sources keychain and 1password; `join`, `dev`, `down`; guided mode in English and Spanish; install.sh; Claude Code plugin; designer template |
| v2 | netlify, neon, resend, stripe, posthog; custom domain rule; Windows via WSL |
