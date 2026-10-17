# Goals

Claude Code's goal input is capped at 4000 characters, so paste the short block below for the goal you want; the full definition lives in this file and Claude Code reads it from disk. Every goal starts with the preflight block and ends with a GOAL REPORT. A goal that cannot finish ends with one or more `BLOCKED:` lines and stops.

## Paste blocks

Goal 0:

```
Read docs/SPEC.md in full, then docs/GOALS.md in full. Follow the common rules in docs/GOALS.md. Complete Goal 0 exactly as written there: run its preflight, do steps 0 to 12 in order, commit after each, run its checks, push, and end with the line READY FOR FIELD TEST followed by the GOAL REPORT in the specified format. Stop with a BLOCKED: line if anything in the goal cannot be completed.
```

Goal 1 (paste after Part A of Goal 1 is complete):

```
Read docs/SPEC.md and docs/GOALS.md in full. Follow the common rules. Complete Part B of Goal 1 exactly as written, starting with its check that Part A is done, and end with the GOAL REPORT. Stop with a BLOCKED: line at any step that needs a browser.
```

Goals 2, 3 and 4: same block, changing the goal number and title.

Common rules for every goal:

- Read `docs/SPEC.md` in full before doing anything. It is the source of truth. If a decision is not covered, pick the simplest option, record it in `docs/DECISIONS.md` with one line of reasoning, and continue.
- Never create a GitHub, Vercel, Supabase, Inngest or Cloudflare resource unless the goal explicitly says field test.
- Never print, log or commit a secret value. Tests use obviously fake values.
- No em dashes anywhere in code comments, docs or output. No `#` inline comments in shell examples.
- TypeScript strict, pnpm, Node 22, Vitest. No framework for the CLI beyond a small prompt library.
- Every command works with `--json`. Every error is a `CimientoError` with a `hint`.
- Commit after every completed section with a conventional commit message. Do not push, except where a goal says so.

GOAL REPORT format, last thing printed:

```
GOAL REPORT
Goal: <n>
Done: <bullet list>
Decisions: <count, see docs/DECISIONS.md>
Tests: <passed>/<total>
Field-test bugs: <the full bug table of the current field test record, Id | Description | Fix commit, inline>
Field-test timings: <the timings per phase table of the current field test record, inline, taken from run logs; a phase without a run log says not measured>
Blocked: <none | list>
Next: <the single next action, as an exact command or paste block>
```

Every report includes the field-test bug table and timings inline, copied from the current
`docs/FIELD-TEST-<n>.md`, never by reference. A goal with no field test yet says so on both lines.

---

## Goal 0: engine and first three providers, no cloud resources

Preflight:

```
node -v && pnpm -v && git --version && gh auth status
```

If any fails, end with `BLOCKED: tooling` and stop.

Build v0 of cimiento exactly as `docs/SPEC.md` sections 3 to 12, 16 and 17 describe, scoped to:

0. Self-setup, done first and by hand once, exactly the way the scaffold in section 11 will do it for every future project. The folder already contains a placeholder `package.json` (name `cimiento`, version `0.0.0`, published to npm to reserve the name) and a stub `README.md`; keep the name, replace everything else in step 1. `git init` if needed, `.gitignore` with `.env*` and `.cimiento/cache`, `CLAUDE.md` describing this repo and the rule that secrets go through `cimiento secret`, `.claude/settings.json` denying reads of `.env*`, `docs/DECISIONS.md`, then `gh repo create cimiento --private --source=. --remote=origin --push`. This is the only resource this goal creates. Record in `docs/DECISIONS.md` that the repo was created by hand because the tool did not exist yet, and that step 12 replaces this with the tool adopting it.
1. Repository skeleton per section 16, `package.json` with `cimiento` as the bin, Vitest configured, `pnpm test` and `pnpm build` working.
2. `src/manifest`: Zod schema for `stack.yaml` per section 4, defaults, validation errors as `CimientoError`, presets `fullstack` and `designer`.
3. `src/core`: planner (reads manifest and state, calls each provider's `resources`, builds the dependency graph from `dependsOn` and deferred values, emits plan items with status create, adopt, update, noop, needs-human, blocked), executor (runs items in dependency order, multi-pass until no deferred value is pending, stops at manual items, verifies after ensure), state read and write for both machine and project state per section 7, `CimientoError` type and exit codes per section 10.
4. `src/providers/github`, `src/providers/vercel`, `src/providers/supabase` implementing the full `Provider` interface from section 5. Vercel and Supabase cover both `via-hosting` and `direct` paths. All external calls go through a thin `exec` and `http` layer in `src/core/io.ts` so tests can record and replay them.
5. `src/wiring`: the rules from section 6 that involve only these three providers.
6. `src/secrets`: sources `prompt` and `env`, sink `hosting` for Vercel. Keychain and 1Password are stubs that throw `CimientoError` code `SECRET_SOURCE_UNAVAILABLE` with a hint.
7. `src/scaffold`: template `nextjs-app` and every generated file from section 11.
8. `src/cli`: commands `new`, `init`, `plan`, `up`, `doctor`, `env pull`, `env print`, `secret set`, `secret check`, `explain`. Expert mode and `--json` only; guided mode is Goal 3 but the `explain` strings must exist in English for every resource id and error code now.
9. `src/kb`: an entry for every `CimientoError` code the three providers can produce.
10. Tests: unit tests for manifest validation, planner ordering with deferred values, idempotency of every `ensure` (second call returns `noop`), adoption of existing resources by name, secret redaction in logs and JSON, and one end-to-end `cimiento new --preset fullstack --json` run against fully mocked io that ends with every check passing and a receipts list.
11. `README.md` with a five-minute quick start for the expert path.
12. Dogfood: write `stack.yaml` for cimiento itself (slot `repo: github`, every other slot `none`, `accounts.github` set to the logged-in handle, `scaffold.template: none`), run `node dist/cli.js plan --json` in this repo, and confirm the plan adopts the existing repo and reports everything else as noop. Run `node dist/cli.js up --json` and confirm state lands in `.cimiento/state.json` with the repo's external id. Commit both files. From this point the repo is managed by the tool.

Checks before the report:

```
pnpm build && pnpm test && node dist/cli.js doctor --json
```

All three succeed and `doctor` reports every item ok. `git log --oneline | wc -l` is greater than 8. `git push` succeeds (this goal pushes, as an exception to the common rule, so the repo exists remotely from day one).

End with the line `READY FOR FIELD TEST` and the GOAL REPORT.

---

## Goal 1: field test against real accounts

This goal tests the beginner path, so logins, account choice and browser steps must be driven by cimiento, never done by hand beforehand.

### Part A: attended, in a normal terminal, before pasting the goal

```
cd ~/Code.nosync/cimiento && pnpm build
cd ~/Code.nosync && node cimiento/dist/cli.js new cimiento-test-1 --preset fullstack
```

Follow only what cimiento shows on screen (browser logins, team choice, Marketplace terms) and fix nothing by hand. Whatever the outcome, success or failure, paste the Goal 1 block next.

Check: `ls ~/Code.nosync/cimiento-test-1/stack.yaml` prints the path. If it does not, Part A did not run; run it before pasting.

### Part B: Claude Code

Preflight: `pnpm build && pnpm test`. Any failure ends with `BLOCKED: build` and stops.

1. Check that Part A is done: `~/Code.nosync/cimiento-test-1/stack.yaml` exists. If it does not, end with `BLOCKED: Part A not run` and stop. Otherwise run `plan --json` and `doctor --json` there to establish where Part A stopped.
2. Treat every place where cimiento did not handle something itself as a bug. At minimum: a missing session reported as an error instead of launching the vendor browser login; any message telling the user to run a command; an unpinned account (for example the Vercel team) not asked for and written to `stack.yaml`; a manual step without plain instructions and a verify. Fix each one, add a knowledge base entry and a unit test.
3. Implement `cimiento down` per SPEC section 9 for github, vercel and supabase if it does not exist yet (moved here from Goal 2), with unit tests.
4. Re-run `up --json` in `cimiento-test-1` to completion. Sessions already exist from Part A. If a step needs a browser, end with `BLOCKED: manual step <id>` and, as the Next line, the exact attended command: `cd ~/Code.nosync/cimiento-test-1 && node ../cimiento/dist/cli.js up`, followed by the Goal 1 block again.
5. Run `doctor --json` twice; the second run must be all noop.
6. Run `down --yes`, then confirm with `gh`, `vercel` and `supabase` CLIs that no `cimiento-test-1` resource remains.
7. Report timings per phase and a list of every bug Part A exposed, each with its fix commit.

## Goal 2: inngest, turnstile, anthropic, secrets, lifecycle

Providers `inngest`, `turnstile`, `anthropic`; wiring rules for them per section 6; secrets sources `keychain` and `1password`; commands `secret rotate`, `join`, `dev`; checks `jobs.roundtrip`, `bot_protection.verify`, `secrets.present`. Unit tests first, then the same field test as Goal 1 with the full preset.

---

## Goal 3: guided mode, installer, plugin, designer template

Guided mode in English and Spanish per section 10, `scripts/install.sh` per section 14, the Claude Code plugin per section 15, template `designer-site` with a `design/` folder, and run logs per section 7. Field test on the existing profile, unattended on its sessions: `cd ~/Code.nosync && cimiento new cimiento-test-3 --preset designer --json --yes`, then the deployed page, `doctor` twice, `down --yes` and confirmation with `gh` and `vercel`. A browser step stops it with the exact attended command. Every stall becomes a knowledge base entry. Before Goal 4, a pre-publication scan of the full history: gitleaks over every commit and every personal identifier, reported, with nothing changed.

---

## Goal 4: release, before user zero

1. Apply the history cleanup chosen from the Goal 3 pre-publication scan, then make the repository `jmdarre-v/cimiento` public. This goal pushes.
2. `npm publish` of version 0.1.0 as an attended step: the person runs `npm login` and the publish in their own terminal, and the goal verifies with `npm view cimiento version`.
3. The install one-liner from the public repository: `curl -fsSL https://raw.githubusercontent.com/jmdarre-v/cimiento/main/scripts/install.sh | bash`.
4. The plugin marketplace from the public repository: `/plugin marketplace add jmdarre-v/cimiento`, then `/plugin install cimiento@cimiento`.
5. README with the expert and guided paths, `docs/TROUBLESHOOTING.md` generated from the knowledge base, and a CHANGELOG.

End with the install one-liner and the two commands a new person runs. User zero, the first beginner on her own Mac, comes after this goal (SPEC section 17).
