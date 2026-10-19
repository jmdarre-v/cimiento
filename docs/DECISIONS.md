# Decisions

One line per decision the spec does not cover, with the reasoning.

- 2026-09-21 The GitHub repository for cimiento was created by hand with `gh repo create` because
  the tool did not exist yet. Step 12 of Goal 0 replaces this with the tool adopting the repo
  through its own `stack.yaml`, after which the repo is managed by cimiento like any other.

- 2026-09-21 `docs/SPEC.md` and `docs/GOALS.md` were moved from the repository root into `docs/`,
  which is where section 16 of the spec says they live and where every goal block reads them from.

- 2026-09-21 The `fullstack` preset ships only the providers v0 implements: github, vercel and
  supabase. The spec section 4 fragment also names inngest, turnstile and anthropic, and Goal 2
  adds them back to the preset once those modules exist. A preset that selects a provider the
  build cannot plan would make the Goal 0 end to end test impossible to pass honestly.

- 2026-09-21 `cimiento plan` always exits 0 when it managed to produce a plan. The exit codes in
  spec section 10 describe the outcome of applying, and a blocked item is the normal shape of a
  plan for a project that does not exist yet, not a failure. `up` and `doctor` carry 1, 2 and 3.

- 2026-09-21 Statuses `tool` and `session` are reported as `noop` when the probe passes, never as
  `adopt`. cimiento never owns a tool or a login, so there is nothing to take over: the tool is
  either good enough already or it has to be installed.

- 2026-09-21 Vercel and Supabase tokens are read from the vendor CLI's own stored credentials, or
  from `VERCEL_TOKEN` and `SUPABASE_ACCESS_TOKEN` for a machine with no browser. The spec asks for
  the vendor CLI for auth and the vendor API for resources, and this is the seam between them.
  cimiento never prompts for a token.

- 2026-09-21 Deferred values that are secret, such as the Supabase anon and service role keys, are
  resolved from the producing provider's `outputs` and held in memory for one run. State holds the
  non secret outputs only, per spec section 7, so a secret can never be resolved through it.

- 2026-09-21 The Supabase database password generated at project creation is returned as a secret
  output. It is kept in memory for the run, never written to state or logs, and is not recoverable
  afterwards. Rotate it from the Supabase dashboard if it is ever needed.

- 2026-09-21 `secrets` entries carry an optional `source` field, defaulting to `prompt`. Spec
  section 4 shows only names and sinks, and section 8 lists four sources, so the manifest needs
  somewhere to say which one a given secret uses.

- 2026-09-21 The `hosting.deployed` check requires a 200, and requires the scaffold marker only
  when `scaffold.template` is not `none`. Requiring the marker forever would fail the check the
  first time somebody replaces the generated home page, which is the point of the scaffold.

- 2026-09-21 The supabase provider needs a session on the `via-hosting` path too, even though the
  Marketplace creates the project and delivers its keys. Setting the Auth Site URL from the
  production URL is a Management API call, and that rule applies to any hosting plus supabase pair.

- 2026-09-21 `github.repo` takes its owner from `accounts.github` when the manifest pins one, and
  otherwise from the resolved GitHub session as a deferred value. This keeps a manifest with no
  accounts section working while still failing loudly when a pinned account does not match.

- 2026-09-21 Wiring rules contribute dependency edges as well as resources, so a rule can make an
  existing resource wait on something it added. Without this, `vercel.deployment` could not be
  made to wait for the repository link, which no single provider knows about.

- 2026-09-25 Every vendor login and every other vendor command that may open a browser runs
  through `io.interactive`: stdin, stdout and stderr inherited, nothing captured, capped at 15
  minutes. Part A showed that a captured exec hides the device code and kills a slow approval.

- 2026-09-25 In a run with no terminal (`--json`, an agent, CI), cimiento never starts a login,
  an account question or a browser step. Those raise a code from `PERSON_CODES`, which the
  executor records as pending with exit code 2, never as a failure with exit code 1. The hint
  names the attended `cimiento up` command and folder, never a vendor command.

- 2026-09-25 Accounts are pinned into `stack.yaml` the first time a session exists: the GitHub
  handle without asking, the Vercel team when there is one or after asking when there are
  several, and the Supabase organization the same way. The organization goes to
  `options.supabase.organization_id`, because `accounts.supabase` already holds the path.

- 2026-09-25 Pinning only fills an empty slot and never overwrites a value already in the file.
  A session that disagrees with a pinned value is `SESSION_ACCOUNT_MISMATCH`.

- 2026-09-25 The Marketplace manual step is verified by finding the Supabase integration in
  `GET /v1/integrations/configurations?view=account`. The exact response shape is an assumption,
  matched on `slug` or `integration.slug`, and is the first thing to confirm in the next attended
  run. A step that already verifies is never asked for, in plan or in up.

- 2026-09-25 The via-hosting install uses `vercel integration add supabase --name <slug>
  --no-env-pull`. `--name` gives the database the name cimiento looks it up by, and
  `--no-env-pull` stops the vendor default from writing `.env.local`, which spec section 8
  reserves for `cimiento env pull`.

- 2026-09-25 cimiento runs `vercel link --yes --project <slug>` itself before any vendor command
  that acts on the linked project (integration add, deploy, env pull), instead of letting the CLI
  guess from the folder name or telling the person to link by hand.

- 2026-09-25 The Supabase token is read from the environment, then the macOS Keychain (service
  `Supabase CLI`, account `supabase`, the default profile name, go-keyring base64 encoded), then
  the old token file. The Keychain item's attributes were confirmed on this machine; its value was
  never read by hand.

- 2026-09-25 `cimiento down` without `--yes` asks for the project name typed back. With no terminal
  and no `--yes` it stops with `DOWN_CONFIRMATION_NEEDED`, exit code 2. When GitHub refuses a delete
  for lack of `delete_repo`, cimiento runs `gh auth refresh --scopes delete_repo` in the foreground
  and retries.

- 2026-09-25 Unit tests never run with the repository as their working directory. A test that did
  let the new pinning code write a fake handle into cimiento's own `stack.yaml`; it was restored
  from git before any commit.

- 2026-09-25 The Supabase database a project uses is the one its hosting env points at. cimiento
  reads the ref from `SUPABASE_URL` (then `NEXT_PUBLIC_SUPABASE_URL`) in the Vercel env, fetching
  that one variable and decrypting nothing else, and adopts that database whatever its name.
  Lookup order is the ref in state, the ref in the hosting env, then a project named like the slug.
  Renaming the adopted database is not attempted.

- 2026-09-25 While the hosting env points at a Supabase database the current login cannot see,
  `supabase.project` verifies as `SUPABASE_DUPLICATE_REFUSED`, a person code: plan shows
  needs-human, up waits with exit code 2, and nothing ever posts a new project. This holds on the
  direct path too.

- 2026-09-25 One database, one billing warning: `vercel.binding.supabase-install` is no longer
  billable, because it creates the database `supabase.project` stands for. Providers may implement
  an optional `billing()` returning the account and plan an item bills to; the planner prints one
  warning per billable item with it. Refusing `up` for lack of `--allow-billing` has its own code,
  `BILLING_APPROVAL_NEEDED`, instead of borrowing `MANUAL_STEP_PENDING`.

- 2026-09-25 A plan counts as paid unless it is `free`, `hobby` or unknown. The Supabase plan is
  read from `GET /v1/organizations/{id}`, since the list endpoint has none, and the Vercel plan from
  `billing.plan` on the team. Both shapes were confirmed against the real accounts, printing only
  names and plans.

- 2026-09-25 The Supabase organization question always offers creating a new organization, named
  after the slug unless the person types another, through `POST /v1/organizations`. A single free
  organization is pinned without asking; a single paid one is asked about. Organization creation
  was not exercised against the real account in this goal.

- 2026-09-25 The Marketplace instructions are computed when the step is asked, from the provider's
  verify, so they can name the pinned team and organization and say Link Existing Supabase Account
  (with a Supabase login and a pinned organization) or Create New Supabase Account (without). The
  step now waits on `supabase.session` and `vercel.project`. The old advice to close the database
  dialog is gone: a database created there is adopted.

- 2026-09-25 `--only` and `--skip` keep dependency order among the kept steps and ignore edges to
  filtered providers, whose deferred values come from state.

- 2026-09-25 State records `origin: created | adopted` per resource. `cimiento down` deletes only
  what cimiento created; an adopted resource is released from state and left in place, because it
  existed before the project and may hold another application's data. This narrows spec section 9,
  "destroys everything in state", on purpose.

- 2026-09-25 A database reached through the hosting env that is older than the hosting project is
  adopted only after a person says yes (`SUPABASE_ADOPTION_CONFIRMATION_NEEDED`, a person code). A
  database the install step itself created in this project's name counts as created, via the
  install binding's `installedBy` output.

- 2026-09-25 `cimiento accounts set <provider> [--to <id>]` is the one way to change a pinned
  account. It always asks, even when there is a single option, overwrites the value in
  `stack.yaml`, and makes state follow. `--to` is for runs with no terminal; without it they stop
  with `ACCOUNT_CHOICE_NEEDED`. For GitHub the pin follows whoever gh is logged in as.

- 2026-09-25 stack.yaml is the source of truth for pinned accounts. Every time a project is opened,
  state's copies (the session entries' `account`, `team` and `organizationId`) are reconciled to
  it, so a value removed or changed by hand can never linger in state.

- 2026-09-25 "Last activity" for a Supabase project is the last day with API requests in
  `usage.api-counts?interval=7day`. The Management API has no last-activity field. A project with no
  requests in that window is shown as such.

- 2026-09-25 The free project limit step counts active projects in free organizations the login
  can see, retries the create after the person frees a slot or picks another organization, and
  gives up to the person step after five rounds without progress. cimiento never calls pause or
  delete on a project it did not create.

- 2026-09-25 The Supabase Management API cannot delete organizations (its OpenAPI spec lists GET
  and POST only). An organization cimiento created is recorded in state and listed by down as a
  `DOWN_LEFTOVER` with its dashboard link on every down until it is gone.

- 2026-09-25 The Supabase session reports and verifies the organization stack.yaml pins, read with
  `GET /v1/organizations/{id}`. An inaccessible pinned organization fails the session with
  `SESSION_ACCOUNT_MISMATCH` rather than falling back to whatever organization comes first.

- 2026-09-25 Migrations are applied through `POST /v1/projects/{ref}/database/migrations`, one per
  file, named after the file without its version, with an Idempotency-Key per file, and compared
  by name against `GET` of the same path. No database password or CLI link is needed. The
  nextjs-app scaffold ships `20250101000000_cimiento_baseline.sql`; up writes it into a project
  scaffolded before it existed; database.migrated fails with no files and queries the baseline
  table when the baseline is present.

- 2026-09-25 GitHub access for Vercel is checked before any link attempt with the endpoints the
  Vercel import screen uses, `GET /v1/integrations/git-namespaces?provider=github` and
  `GET /v1/integrations/search-repo`, both without a team scope, which they refuse. They are not in
  Vercel's published API reference; a 5xx from them lets the link step decide instead of asking.

- 2026-09-25 A newer tool version is reported, never blocking. The latest version comes from the
  tool's own update notice, then Homebrew's metadata when `which` resolves under a Homebrew prefix,
  then npm for npm packages, looked up once per run. up offers the upgrade once, in a terminal only.

- 2026-10-17 The Anthropic key check is GET /v1/models through io.http with x-api-key, not the SDK:
  every external call goes through io.ts so tests replay it, and the call is read only and free.
- 2026-10-17 Turnstile widget domains are the production host only; preview and dev get
  Cloudflare's documented test keys. Turnstile has no wildcard hostnames and Vercel preview hosts
  are not subdomains of production, and adding vercel.app would let any Vercel site use the key.
- 2026-10-17 The widget is created before the first deployment with `<slug>.vercel.app` as its
  domain, so NEXT_PUBLIC_TURNSTILE_SITE_KEY is in the build; turnstile.binding.domains then adds
  the real production host once it is known.
- 2026-10-17 wrangler owns the Cloudflare login, with `--scopes account:read user:read
  challenge-widgets.write offline_access`; cimiento reads the token from `wrangler auth token
  --json` once per run and pins the account id to `accounts.cloudflare`.
- 2026-10-17 bot_protection.verify posts a dummy token with the widget's secret to siteverify and
  passes on invalid-input-response, fails on invalid-input-secret. A real token needs a browser.
- 2026-10-17 Inngest has no session in cimiento: the Vercel integration is the one person step,
  proved by the integration configuration plus INNGEST_EVENT_KEY and INNGEST_SIGNING_KEY in the
  project's production env. The first deployment waits for it so the build has both keys.
- 2026-10-17 Deployment protection for Inngest: standard protection leaves production public, which
  is where Inngest calls the app, so v1 adds no bypass; a 401 or 403 on /api/inngest is reported.
- 2026-10-17 The app is registered with a PUT on `<production>/api/inngest`, which the Inngest
  serve handler signs with its own key; the integration also syncs on deploy, and PUT is idempotent.
- 2026-10-17 jobs.roundtrip reads both Inngest keys from the Vercel production env, sends
  cimiento/roundtrip to inn.gs, and polls GET api.inngest.com/v1/events/{id}/runs with the signing
  key for up to 120 s until the scaffolded cimiento-roundtrip run is Completed.
- 2026-10-17 down lists the Inngest app as a leftover in the run that removes its endpoint: the
  Inngest API has no delete or archive for apps, and no later run can tell it still exists.
- 2026-10-17 vercel.deployment deploys again when a production env key is newer than the live
  deployment, because Vercel bakes env into each build; doctor reports that drift. This is how a
  rotated secret or a late integration key reaches the app.
- 2026-10-17 The keychain source reads with `security find-generic-password -w` and writes with
  `security -i`, the command on stdin, so the value never appears in argv or ps. A missing value is
  asked for once at a hidden prompt in a terminal and stored; without a terminal it is a step
  waiting on a person (SECRET_MISSING joined PERSON_CODES).
- 2026-10-17 The 1password source requires `ref: op://vault/item/field` on the secret, validated
  in stack.yaml, and reads with `op read --no-newline`; a missing op is installed with
  `brew install --cask 1password-cli` in a terminal only.
- 2026-10-17 secret set and secret rotate both read a fresh value: prompt and keychain secrets at a
  hidden prompt (keychain stores it over the old one), env and 1password from where they live.
  rotate PATCHes the existing Vercel env entry and leaves the redeploy to up.
- 2026-10-17 join runs tools and sessions through the executor, then verify for everything, then
  env pull when the Vercel project verifies. It never creates a cloud resource.
- 2026-10-17 dev uses fixed ports 3000 (app), 8288 (Inngest dev, inngest-cli 1.46.0 through npx)
  and the Supabase CLI defaults (54321); local Supabase keys and declared secrets reach the app
  through its process env in memory, which Next.js prefers over .env.local.
- 2026-10-17 The anthropic check depends on the ANTHROPIC_API_KEY env bindings, so a key nobody
  has typed is one step waiting on a person rather than a failed check as well.
- 2026-10-17 BUG-40: the fullstack preset declares ANTHROPIC_API_KEY only. TYPESAFE_API_KEY and
  XPOZ_API_KEY were SPEC section 4's example of per-project secrets; a preset holds what every
  project on the stack needs, and the ai slot is what needs the Anthropic key.
- 2026-10-17 `cimiento secret remove NAME`, beyond the set/rotate/check of spec section 9, is how a
  declared secret leaves a project: it validates stack.yaml without the secret first (refusing
  ANTHROPIC_API_KEY while ai is anthropic), then deletes the hosting env entries, the keychain
  value cimiento stored, the state entries and the .env.example line, and edits stack.yaml in
  place so comments survive. The command itself is the confirmation: it removes one named secret.
- 2026-10-17 A name stack.yaml does not declare is SECRET_NOT_DECLARED in set, rotate and remove,
  not SECRET_MISSING, which now means only a declared secret with no value.
- 2026-10-17 BUG-47: the Cloudflare login is a plain `wrangler login`. wrangler 4 asks for
  challenge-widgets.write by default, a narrower --scopes would drop permissions a person uses for
  Workers, and wrangler rejects offline_access as a --scopes key. The cause of a failed login is
  read from wrangler's debug log in a WRANGLER_LOG_PATH folder of cimiento's own, because the login
  keeps the person's terminal. The turnstile resources take the account from the session output,
  so a login with one account is planned and pinned without a question.
- 2026-10-17 BUG-46: on the via-hosting path, a Marketplace configuration that already serves
  another project's database is shown with what it serves and settled by the person before the
  plan: reuse (options.supabase.marketplace_configuration) or the direct path. One that serves
  nothing else, such as one installed for this project, is used without a question. down deletes
  a Marketplace-created database with `vercel integration-resource remove <name> --disconnect-all`,
  which removes that one resource, refuses when names collide, and never uninstalls a configuration.
- 2026-10-17 BUG-41: one PersonStep shape for every step only a person can do, rendered the same
  in the terminal (with an OSC 8 link whose text is the full address) and in hints and --json
  (plain text plus the structured step). The walk is: show, Enter to open (or to start the vendor
  command that opens the page), Enter when done, then verify. Account choices get a step too,
  with the vendor page listing the options to compare, then the numbered question. Labels of
  pages behind a login come from the vendor flows as known on 2026-10-17; the field test checks
  them. A secret declaration may carry url: for the page that issues it.
- 2026-10-17 BUG-45: the Inngest step picks Create New Inngest Account on a team without the
  integration (Vercel manages and bills it, free plan), and only adds the project, with no account
  choice, on a team that has it. cimiento cannot see a person's other Inngest accounts, so it
  never sends them to Link Existing.
- 2026-10-17 BUG-42: an attended up runs in four parts: one tool question, the list of person
  steps, the logins and account choices (and the Supabase configuration choice) before the plan,
  then after the confirmation the person steps that need a resource (Marketplace, GitHub access,
  Inngest, secrets) with what they depend on, then the unattended rest. The estimate counts 180 s
  per deployment, 120 s per database, 30 s per tool or roundtrip, 20 s for migrations and 5 s for
  anything else. --json runs ask nothing and emit the person-steps list as their first event.
- 2026-10-17 BUG-43: tool upgrades are one question before the plan; a skip is stored per binary
  and version in machine.json toolSkips; ensure never asks; doctor lists outdated tools in its
  output and asks nothing.
- 2026-10-17 BUG-44: logins and account choices, the Supabase organization among them, run before
  the plan, so the billing warning names the organization and its plan.
- 2026-10-17 BUG-48: inngest.app signs its introspection GET with the INNGEST_SIGNING_KEY read
  from the Vercel env (x-inngest-signature, HMAC SHA-256 of the empty body and the timestamp, key
  without its signkey-env- prefix), as inngest 3.54 requires in cloud mode. A 401 or 403 carrying
  x-inngest-sdk-handled is the SDK refusing the key; any other is Vercel deployment protection.
- 2026-10-17 BUG-49: an env binding with input public: 'true' (the Turnstile site key) is not
  registered with the redactor; every other value still is.
- 2026-10-17 Goal 3, guided mode: --guided changes what is printed, not what runs. The printer
  explains each failure in plain words (the code's explain text), the hint, and one next command
  taken from the hint (cimiento doctor when the hint names none). The person-step walker prints
  the explain text before each step, and up explains every billable item before apply. The words
  cimiento prints itself live in src/cli/i18n.ts in en and es and follow --lang in both modes;
  hints and vendor messages stay in English, with the plain-words line in Spanish.
- 2026-10-17 Goal 3, new --guided asks the name, the folder on first use (default ~/Code.nosync,
  with the iCloud reason in one sentence), what is being made (designer, fullstack, or each piece) and,
  for each piece, one slot at a time with the providers this build implements. The answers become
  the flags an expert would pass.
- 2026-10-17 Goal 3, designer-site is the nextjs-app base with its own page and design/exports
  (gitignored zips) and design/current (the committed unzipped export). The designer preset uses
  it. Keeping Next.js means the same Vercel framework setting and the same scaffold marker check.
- 2026-10-17 Goal 3, install.sh picks one of three modes: brew (Homebrew present and writable),
  admin (no Homebrew, administrator account: install Homebrew, which asks for the password once),
  and user (a standard account, or Homebrew owned by another account: node 22, gh and supabase from
  their vendors' releases checked against the published SHA-256, and npm tools under
  ~/.cimiento/tools with NPM_CONFIG_PREFIX, no password). A second account on a Mac whose Homebrew
  belongs to the first can never use that Homebrew, and a standard account cannot install it.
- 2026-10-17 Goal 3, install.sh takes --from <tarball> for cimiento itself, because npm holds only
  the 0.0.0 placeholder until Goal 4 and the repository is private. Without --from it installs
  cimiento@latest from npm.
- 2026-10-17 Goal 3, the plugin's .env rule is a PreToolUse hook in node (a plugin cannot ship
  permission rules, and a fresh Mac has no jq). It blocks Read, Edit, Write, Grep, Glob and Bash
  calls naming a .env file and allows .env.example, which holds names only. The scaffold's
  .claude/settings.json deny rule stays the hard guarantee in each project.
- 2026-10-17 Goal 3, the repository root carries .claude-plugin/marketplace.json named cimiento
  with the plugin at ./plugin, so /plugin marketplace add jmdarre-v/cimiento and /plugin install
  cimiento@cimiento install it; both manifests pass claude plugin validate.
- 2026-10-17 Goal 3, for a fresh Mac account: when git has no user.email, the scaffold commit
  passes -c user.name=<GitHub login> -c user.email=<login>@users.noreply.github.com for that one
  commit and leaves the person's git configuration alone; the commit result is checked; and
  gh auth setup-git runs before gh repo create --push so the HTTPS push has credentials.
- 2026-10-17 Goal 3 close: field tests run on the existing profile and its sessions; the fresh
  macOS account, the VM, timing by hand and the one-hour and ten-minute targets are dropped. The
  from-nothing test is user zero, the first beginner on her own Mac after Goal 4, recorded by her
  run logs. This replaces the Goal 3 fresh-machine procedure and its /Users/Shared kit.
- 2026-10-17 Goal 3 close: install.sh has one path, Homebrew. The per-account mode (vendor
  downloads into ~/.cimiento/tools), --from and the /Users/Shared kit are removed: a beginner on
  her own Mac is an administrator and installs Homebrew, and a Homebrew owned by another account is
  refused with what to do instead. Brew locations are overridable (CIMIENTO_BREW_CANDIDATES) only
  so tests never touch the real Homebrew. This replaces the earlier three-mode and --from decisions.
- 2026-10-17 Goal 3 close, run logs: every LogEvent carries ts (UTC ISO 8601), stamped by the
  logger. Each command writes ~/.cimiento/runs/<UTC start>-<command>.jsonl (CIMIENTO_RUNS_DIR
  overrides it, and tests always do) with start, every log event, every line and json payload
  shown, every prompt with its options, every answer and the exit code. Lines are redacted when
  written, the file is 0600, and a hidden answer is written as ****. install.sh writes
  <UTC>-install.jsonl the same way. There is no runs command; the files are the record.
- 2026-10-17 BUG-51 to 53: a person step has exactly one URL and lists only real fields; a manual
  resource that needs two pages returns one step per page from its verify, and the executor asks
  the next one in the same run (at most three in a row); the walk renders the block without the
  two Enter lines because the prompts say them, while hints and --json keep them.
- 2026-10-17 Goal 3 close, beginner gaps: in a terminal, before the GitHub and Vercel logins,
  cimiento asks whether the account exists and walks the sign-up step when it does not; the
  Vercel login waits on the GitHub one so Continue with GitHub works. install.sh ends with the
  Claude Code login as a person step (claude auth login --claudeai, checked with claude auth
  status --json), saying it needs Claude Pro or Max; without a terminal it says how to do it later.
- 2026-10-17 Goal 3 close, cimiento publish: git add -A, commit with --message (asked in a terminal,
  default Update the site), gh auth setup-git, push to the current branch, then wait for the Vercel
  deployment whose meta.githubCommitSha is that commit (5 s polls, 15 min), and print the
  production URL. Nothing to commit is not an error. Vercel builds the push by itself, so
  publish never runs vercel deploy.
- 2026-10-17 BUG-55: test/setup.ts pins the test environment: LANG=en_US.UTF-8 with LC_ALL and
  LC_MESSAGES removed (a developer's Spanish locale turned cimiento's output Spanish and failed the
  BUG-42 test and twelve others), and vendor tokens such as CLOUDFLARE_API_TOKEN removed so none
  reaches the fake cloud. Tests accept xdg-open where macOS has open, and the read-only Homebrew
  test uses a prefix that does not exist, which root cannot write either. Verified on macOS in an
  English and a Spanish locale and on Linux in the node:22 Docker image.
- 2026-10-17 BUG-56: package.json is the one version (0.1.0), read at runtime by src/version.ts,
  whose relative path is the same in the repository and in the installed package; plugin.json
  carries no version of its own.
- 2026-10-17 Goal 4, before publication: the preset juan is fullstack, with no alias. Real ids in
  the field test records, the knowledge base and the tests are clearly fake placeholders
  (icfg_EXAMPLESHARED, example-org-test-2, example-db-other, 01EXAMPLEEVENT and so on), and other
  projects and organizations are "another project", Pro Org or Free Org. The GitHub handle
  jmdarre-v stays: it owns the public repository. This repository commits as
  190653303+jmdarre-v@users.noreply.github.com.
- 2026-10-17 BUG-57: the GitHub repository, the Vercel project and the Turnstile widget compare
  the id they find by name with the id state recorded; a different id, or none recorded, is
  adopted, which replaces the record (new createdAt, no old outputs) so down never deletes it.
  Deployments keep their noop, because their id changes with every deploy.
- 2026-10-17 Goal 4: docs/TROUBLESHOOTING.md is generated by scripts/troubleshooting.mjs from
  src/kb, grouped by provider, one section per code with what to do, why and what it looks like;
  a test fails when it is out of date. The npm package ships dist and CHANGELOG.md (plus README and
  package.json, which npm always includes); no tests and no docs beyond those.
- 2026-10-18 Goal 5: the database sink writes Supabase project secrets (what Edge Functions read)
  and is refused unless slots.database is supabase; the ci sink writes GitHub Actions secrets with
  `gh secret set NAME -R repo`, the value on stdin so it never shows in a process list. Both are
  bindings of their own provider, so down removes them with the project or repository they live in.
- 2026-10-18 Goal 5: secret rotate is ensure with inputs.rotate set, so each sink writes over the
  value it holds; secret remove deletes from every sink, including Supabase and Actions.
- 2026-10-18 Goal 5: hosting.preview is a passive check. It never pushes a branch itself: with no
  branch besides production it passes and says so, and otherwise every other branch (up to ten)
  must have a ready preview of its head commit. A failed preview build is HOSTING_PREVIEW_NOT_READY.
- 2026-10-18 Goal 5: the hosting slot has one resource shape for every provider (<id>.session,
  <id>.project with projectId, <id>.deployment with productionUrl, <id>.env.<NAME>.<env>), in
  src/core/hosting.ts, so the "any hosting" wiring rules (supabase auth URLs, supabase direct keys,
  turnstile, neon, posthog, custom domain) serve Vercel and Netlify alike. Commands reach the
  hosting provider through src/providers/hosting.ts.
- 2026-10-18 Goal 5: Netlify links the GitHub repository the way netlify init does without the
  GitHub app: a read only deploy key added with gh, the repo settings on the site, and a repository
  webhook to the site's deploy_hook. No GitHub app install is asked of the person. Netlify hosting
  therefore needs slots.repo github. Supabase on Netlify uses the direct path; via-hosting is the
  Vercel Marketplace and is refused with netlify.
- 2026-10-18 Goal 5: Netlify env values are written per deploy context: production to production,
  preview to deploy-preview and branch-deploy, dev to dev. Values are not marked is_secret, because
  Netlify refuses secret values in the dev context that env pull reads; cimiento never prints them.
- 2026-10-18 Goal 5: Netlify's hosting.preview accepts a ready branch deploy or deploy preview of
  each branch head; Netlify builds previews for pull requests, so a branch with neither is told to
  open one.
- 2026-10-18 Goal 5: Neon migrations run through Neon's HTTP query endpoint (the serverless
  driver's protocol), each file in one transaction, recorded in cimiento_migrations, so no Postgres
  client is needed. The migrations workflow in .github stays Supabase only. DATABASE_URL (pooled)
  and DATABASE_URL_UNPOOLED go to the hosting env. A personal Neon login always names the
  organization (accounts.neon), and an expired neonctl token is refreshed by running neonctl me.
- 2026-10-18 Goal 5: Resend, Stripe and PostHog have no session in cimiento; each key is a declared
  keychain secret, added by completeFragment when the slot is chosen, with a sign-up step offered
  before the key page. Checks prove function at no cost: Resend sends to delivered@resend.dev from
  onboarding@resend.dev; Stripe reads the test balance and requires livemode false; PostHog sends
  one event. PostHog's edge only checks a key's shape, so the PostHog check also checks for phc_ and
  its evidence says received, not validated.
- 2026-10-18 Goal 5: Stripe is test mode only. A value starting sk_live_, rk_live_ or pk_live_ is
  refused the moment it is read (src/secrets/guard.ts), before the keychain stores it or any sink
  or check sees it. No Stripe webhook endpoint is created: its signing secret is shown once, and
  cimiento keeps no copy of a secret to write it again later.
- 2026-10-18 Goal 5: one custom domain per project, in stack.yaml's domain. cimiento domain add and
  remove change only that field and apply the affected items. The domain check fetches
  https://<domain>; when it fails, DNS over HTTPS (through io) tells a missing record, a person step
  naming the exact CNAME (cname.vercel-dns.com, or <site>.netlify.app), from a certificate still
  being issued. Vercel's productionUrl stays the vercel.app alias, so removing a domain changes
  nothing else.
- 2026-10-18 Goal 5: a check that fails after its resource was applied, with a code that needs a
  person (a DNS record, a key to make), is pending with exit code 2, like the same failure in ensure.
- 2026-10-18 Goal 5: Windows is supported through Ubuntu under WSL. install.sh reads ID from
  /etc/os-release (only ubuntu is accepted on Linux), detects WSL from /proc/version, installs with
  apt what Homebrew on Linux needs plus libsecret-tools, then takes the same Homebrew path as macOS,
  with ~/.bashrc as the profile. The keychain source uses secret-tool (libsecret) on Linux; with no
  unlocked keyring, as on a bare WSL, a typed value is used for that run only and nothing is
  written to disk. CIMIENTO_KEYCHAIN pins the kind, which the tests set to macos.
- 2026-10-18 Goal 5: CI (.github/workflows/ci.yml) runs typecheck, build, the unit tests and
  install.sh --dry-run on ubuntu-latest and macos-latest. Field tests never run in CI.
- 2026-10-18 Goal 5: field test c is completed by the owner's decision without adding a live DNS
  record, because the only listed domain serves a production project. domain add and remove were
  proven on the real Vercel account; the step after DNS is covered by unit tests.
- 2026-10-18 Goal 6: the goal says to continue BUG ids from BUG-66, but BUG-66 to 70 were used at
  the end of Goal 5 (docs/FIELD-TEST-5.md), so Goal 6 starts at BUG-71 to keep every id unique.
- 2026-10-18 Goal 6: http has a 30 s bound per request; GET and HEAD are retried twice on a
  timeout, network error, 429, 502, 503 or 504, and a write is never sent twice, because it may
  have happened.
- 2026-10-18 Goal 6: the executor checkpoints state after every completed operation, before it
  reports it, unless dryRun; writes go to a temporary file renamed over state.json, the temporary
  file inside .git when there is one. The project lock lives in ~/.cimiento/locks keyed by the
  project's real path, so publish's git add -A can never commit it; a dead process's lock is
  reported as stale and taken over, a live one stops the run with PROJECT_LOCKED.
- 2026-10-18 Goal 6: presence is a provider method looking a resource up by the id state recorded
  (never by name: a lookup in the wrong team or organization would look absent). 2xx is present,
  404 or 410 is absent, anything else, an exception included, is unknown. down forgets only on
  absent; a deployment or migrations record follows its project's presence.
- 2026-10-18 Goal 6: project state is version 2 and records each resource, binding and manual
  step's unresolved spec (deferred values stay references) and the account it was made in. A
  version 1 file is read as is; 0.2.0 refuses a version 2 file. Orphans, recorded specs stack.yaml
  no longer selects, are listed by plan, deleted by down in the account they were made in, and
  decided by up before anything changes: --orphans retain, release or destroy, one question in a
  terminal, or ORPHANS_DECISION_NEEDED (exit 2). Never a default destroy.
- 2026-10-18 Goal 6: doctor reports ok, failed or unknown per item. ok only from a live check that
  passed; unknown when the provider could not tell (a 5xx, a timeout, a check that threw), which
  doctor counts as not ok. manualDone is history: plan and doctor probe manual steps live. In up,
  an unknown on a manual step lets the run go on without asking and without recording it, because
  the step that needs it checks again.
- 2026-10-18 Goal 6: Neon migrations and checks go through io.sql, a pg client using the simple
  query protocol, instead of Neon's HTTP endpoint and a semicolon splitter. Each file is sent
  whole with its history insert, one implicit transaction. A missing history table is created; an
  unreadable one stops the run. The pg path is proven on a local PostgreSQL in CI; on Neon it was
  last field tested over HTTP (Goal 5), so it is partially proven until the next attended run.
- 2026-10-18 Goal 6: checks split into inspect, which only reads, and smoke, which acts. plan,
  doctor and up run inspect; --smoke on doctor or up runs smoke and first lists each effect:
  Resend sends a test email (inspect reads GET /domains, 401 restricted_api_key is a live sending
  key), PostHog sends an event (inspect checks the phc_ shape; PostHog has no read only key
  check), Inngest sends a roundtrip event (inspect reads both keys), Turnstile calls siteverify
  (inspect reads the widget), Supabase runs a read only query (inspect reads the migration
  history; the query endpoint is a POST). plan ignores --smoke.
- 2026-10-18 Goal 6: publish runs commit, push and deploy-wait as stages and resumes the one that
  did not finish. Push when git ls-remote shows the remote branch is not at HEAD; wait when the
  live production deployment is not built from HEAD. The live commit comes from the provider
  when its deployment records it, or else from the commit output publish and up write to state.
- 2026-10-18 Goal 6: doctor without stack.yaml detects providers read only from package.json
  dependencies, .vercel/project.json, vercel.json, netlify.toml, .netlify/state.json,
  supabase/config.toml and the github remote, then runs each provider's own detect (tool version,
  login) against a manifest built in memory. It writes no file and exits 0; init is what writes.
- 2026-10-18 Goal 6: the release workflow runs on v* tags only, checks the tag against
  package.json, builds and tests with the postgres service, packs, installs the tarball in a clean
  prefix and checks cimiento --version, then scaffolds a designer project with new
  --scaffold-only (no account touched), builds it and reads plan --json. It never publishes.
  install.sh takes CIMIENTO_VERSION to pin a release.

- 2026-10-18 Goal 6: completed. 0.3.0 is published on npm, and 0.1.0 and 0.2.0 are deprecated.

- 2026-10-18 Goal 7: down deletes only by the id state recorded. Vercel, Netlify, Neon, Supabase
  and Turnstile send it to the API; GitHub, whose delete takes a name, reads the repository first
  and refuses on a node id mismatch (DOWN_IDENTITY_MISMATCH). A record without an id is never
  looked up by name (DOWN_ID_MISSING). The Supabase Marketplace path already resolves the store
  from the recorded ref and refuses when more than one store shares the name. The env, secret and
  domain deletes are keyed by the recorded project id plus the key or domain, which is their
  identity. Resend, Stripe, PostHog, Anthropic and Inngest delete nothing.
- 2026-10-18 Goal 7: down --release ID[,ID] stops tracking resources and deletes nothing. It is
  the reconcile path for both refusals above and for unresolved legacy state, and needs no typed
  confirmation because nothing outside the project changes.
- 2026-10-18 Goal 7: legacy state (entries without spec) is rebuilt in openProject from stack.yaml,
  then from stack.yaml with each provider this build ships put back in the slots it fills, the
  id's own provider first. Only up, down and the other writing commands save it; plan and doctor
  only report. Tool, session and check entries never had a spec and are not legacy.
- 2026-10-18 Goal 7: publish reads the live commit from the hosting only (BUG-87). Vercel CLI
  deploys from a clean tree carry it as the deployment meta key cimientoCommit; state no longer
  records a commit. Audit of the other live reads with a fallback: the Vercel DNS record for a
  custom domain falls back to Vercel's documented generic record, a default and not a cache, and
  is only printed as a step; Netlify listDeploys reads a failed call as no deploys and feeds
  outputs, where the executor keeps the outputs state already has, which name things and decide
  no status. Neither reports a live status from cached state, so both stay.
- 2026-10-18 Goal 7: Neon preview isolation is reconciled by up, not by a hook at build time:
  cimiento does not run when the hosting builds a preview, and a GitHub Actions hook would need a
  hosting token made in a browser. neon.preview-branches lists the remote branches with gh, makes
  a Neon branch named preview/<branch in lowercase letters, digits and dashes> with a read write
  endpoint, writes both addresses as Vercel preview values with gitBranch or Netlify branch
  context values, and deletes only the branches state recorded, by id. A failed branch listing
  stops the run and removes nothing. environments accepts an object form so preview can carry
  database: shared; stack.yaml keeps the list form otherwise.
- 2026-10-18 Goal 7: Supabase preview isolation is one preview project per app, not one per branch:
  Supabase branching is a paid feature and the free plan allows 2 active projects. Via the
  Marketplace, vercel integration add takes --environment, so production's database is connected
  to production and development and a second one, <slug>-preview, to preview only; direct, the
  preview project is created through the Management API after production's. A database 0.3.0
  connected to every environment is reported with the reconnect commands, never reconnected by
  cimiento, because that touches production. The finding tests written before Goal 7 run with
  preview.database shared, so they keep testing what they were written for.
- 2026-10-18 Goal 7: completed. Field test 7 in docs/FIELD-TEST-7.md, BUG-82 to 92, v0.4.0 tagged
  and pushed. npm publish of 0.4.0 and npm deprecate of 0.3.0 are person steps.
- 2026-10-18 Goal 7: 0.4.0 is published on npm and 0.3.0 is deprecated.
- 2026-10-18 Goal 8: detection is cached per machine in detect-cache.json beside machine.json, not
  in machine.json itself, so the cache can be deleted at any time without losing tool skips or the
  projects folder. Tool versions and identities live 10 minutes, latest versions an hour; only a
  logged in identity is kept, never a missing tool or login. The io every command uses clears the
  identities on a 401 or 403 and on CLI output saying the login is gone; a login, a command run in
  the person's terminal and an account mismatch clear them too. Tests run with the machine cache
  off (CIMIENTO_DETECT_CACHE=off) and a fresh run cache per test.
- 2026-10-18 Goal 8: Neon previews find their branch without cimiento up. The scaffold ships
  .github/workflows/preview-database.yml (push of any branch besides production makes
  preview/<branch>, delete removes it) and lib/neon-preview.mjs, which the workflow script and the
  app share so the branch name is computed once. The app resolves its database at request time,
  not at build, because the build and the workflow start on the same push: DATABASE_URL when set,
  else on a preview the branch for VERCEL_GIT_COMMIT_REF or Netlify's BRANCH, else an error. There
  is no other fallback, so a preview cannot reach production's address. app/api/cimiento/database
  reports the source, the branch and only the Neon endpoint name, never the address.
- 2026-10-18 Goal 8: the workflow and the previews use NEON_API_KEY, an organization API key scoped
  to the one project (member level: it makes and removes branches, cannot delete the project or
  reach another), made by neon.api-key and declared with the new secret source generated: kept in
  the keychain like a typed one, never asked for, made again when the keychain lost it, the old
  key revoked. The Actions secret follows the key id through a version input, since GitHub never
  shows a secret's value; the preview env follows it through the value compare. down revokes it.
  A preview's code can use the key to read the project, the production branch included; anyone who
  can push a branch can already change what the preview runs, so this is recorded, not blocked.
- 2026-10-18 Goal 8: new with --template (other than none) writes scaffold.ci true, as the presets
  do (BUG-98). Projects made by 0.4.0 or older get the preview database workflow only by copying
  it from a new scaffold: up never adds scaffold files.
- 2026-10-18 Goal 8: .cimiento/ is not the app. A Vercel CLI deploy stamps HEAD when every changed
  path is under .cimiento/, and publish skips the deploy wait when git diff from the live commit to
  HEAD touches only .cimiento/; the state commit is still made and pushed, and the hosting may
  build it, which publish does not wait for. Netlify builds every deploy from the repository, so
  its commit_ref is always the commit; it needs no stamp.
- 2026-10-18 Goal 8: field test 8 showed the Vercel CLI records githubCommitSha and githubCommitRef on
  CLI deploys too, with gitDirty 1 when the tree had changes. The live commit is githubCommitSha
  unless gitDirty is set, then cimiento's own stamp, else unknown (BUG-101).
- 2026-10-18 Goal 8: a project scoped Neon key cannot list projects (404, outside the project), so
  NEON_PROJECT_ID, which is not a secret, is written beside it: a preview env value marked public
  and an Actions secret from a literal, since the ci sink writes secrets only (BUG-102).
- 2026-10-18 Goal 8: options.vercel.deployment_protection is applied with PATCH ssoProtection on a
  project cimiento created: none is null, strict is deploymentType all. standard is Vercel's own
  default for a new project, so cimiento never patches toward it and a setting changed in the
  dashboard stays. An adopted project is never changed (BUG-103).
- 2026-10-18 Goal 8: the Supabase preview field test is test/field/supabase-preview.mjs. It runs
  only with two free slots (the app needs its production project and its preview project) or with
  CIMIENTO_FIELD_SUPABASE_ORG naming a paid organization the person chose; otherwise it prints a
  blocked record and exits 0. It never pauses or deletes a project it did not create, and makes
  nothing but cimiento-test-8s, which it takes down at the end.
- 2026-10-18 Goal 8: completed. Field test 8 in docs/FIELD-TEST-8.md, BUG-93 to 104, v0.4.1 tagged
  and pushed; the Supabase preview field test stopped at the free limit. npm publish of 0.4.1 is a
  person step.
- 2026-10-18 Goal 8: 0.4.1 is published on npm. The Supabase preview field test is completed by the
  owner's decision.
- 2026-10-19 Goal 9: previews hold no Neon key (BUG-105). The preview database workflow makes the
  Neon branch, writes DATABASE_URL and DATABASE_URL_UNPOOLED as Vercel preview values with
  gitBranch or Netlify branch context values (Netlify's per branch value is the branch context
  with context_parameter), and deploys the branch again, since both hosts read env when a build
  starts and the push build starts with the workflow. It writes only when the branch's values are
  missing, so a later push neither rewrites nor redeploys. NEON_API_KEY has sink ci only; the Neon
  helper moved to .github/scripts and the app reads DATABASE_URL only.
- 2026-10-19 Goal 9: the workflow's hosting credential is one a person makes. Vercel refuses to
  make a token from the CLI's own login (POST /v3/user/tokens answered 403 Cannot create tokens for
  this app in field test 9), and Netlify has no documented API to make a personal access token (its
  Open API lists none; the forum's create_token is internal). VERCEL_TOKEN and NETLIFY_AUTH_TOKEN
  are keychain secrets with sink ci only and optional: true, a new manifest field meaning a missing
  value is skipped, never waited on, and doctor says it is optional. Without the token the
  workflow makes and removes the Neon branch and cimiento up writes the address, as in 0.4.0.
  cimiento does not copy either CLI's own login into GitHub: it is the person's whole account and
  cannot be revoked without logging the CLI out (BUG-112).
- 2026-10-19 Goal 9: down removes what cimiento wrote on this machine for the project, after a down
  with nothing pending or failed: every keychain account under service cimiento that starts with
  <slug>/ (security dump-keychain without -d, or secret-tool search, so no value is read) and
  every file env pull wrote, which env pull records in the gitignored .cimiento/cache/pulled.json.
  A down that still waits keeps them, because the next down may need a key. The leftovers of
  earlier field tests (six keychain entries, nine pulled .env.local files) were removed by hand.
- 2026-10-19 Goal 9: cimiento upgrade owns only the files cimiento writes outright (.github/,
  app/api/cimiento/, lib/, .claude/settings.json, the baseline migration): missing ones are added,
  ones nobody changed are replaced, judged by sha256 in .cimiento/scaffold.json, written by new and
  upgrade, or by the hashes of what 0.4.1 wrote, taken from its npm package. .gitignore and
  package.json are only added to. stack.yaml is edited in place: NEON_API_KEY loses the hosting
  sink, declarations the current scaffold makes are added, and scaffold.ci false becomes true for a
  Neon app with a GitHub repository, since 0.4.0 wrote false for projects made from flags. A file
  that is no longer scaffolded is removed only when nothing left imports it. up reports
  upgrade-available first and changes nothing.
- 2026-10-19 Goal 9: vercel link --yes pulls the development env into .env.local and has no flag to
  skip it. When cimiento's own link creates that file, it is recorded with what env pull wrote and
  down removes it; a .env.local that existed before the link is the person's and stays (BUG-113).
- 2026-10-19 Goal 9: completed. Field test 9 in docs/FIELD-TEST-9.md, BUG-105 to 113, v0.4.2 tagged
  and pushed. 0.4.1 is the only published version whose previews hold a key that can read
  production: 0.4.0 declares no NEON_API_KEY, and 0.4.1 declares it with sinks ci and hosting.
- 2026-10-19 Goal 9: to prove the workflow writes the address on real hosts unattended, field test 9
  set each test repository's VERCEL_TOKEN or NETLIFY_AUTH_TOKEN Actions secret from the existing
  CLI login, on stdin, never printed, in repositories down deleted with their secrets. This is a
  field test step only; cimiento itself never copies a CLI login into GitHub.
