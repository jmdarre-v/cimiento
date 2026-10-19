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
- A goal contains only work Claude Code can finish and show in its own output. Steps that need a person (`npm publish`, `npm deprecate`, browser logins, typing keys, DNS records, revoking keys) never belong to a goal; they go only in the GOAL REPORT's Next line.
- Every goal ends with a sentence starting "The goal is met when", naming checks Claude Code can show.

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

---

## Goal 5: close v1 and build v2 (SPEC section 18); version 0.2.0

1. Build the database sink (Supabase secrets) and the ci sink (`gh secret set`) from SPEC section 8, covered by `secret set`, `rotate` and `check`. Build the `hosting.preview` check from section 12 for Vercel and Netlify.
2. Providers `netlify` (hosting), `neon` (database), `resend` (email), `stripe` (payments, test mode only, never live keys), `posthog` (analytics), each with the full Provider interface, wiring rules per section 6 (env vars into the hosting provider, auth URLs and domains following hosting), person steps in the BUG-41 format in en and es including account sign-up, down, KB entries and unit tests. The custom domain rule from section 6 as `cimiento domain add <domain>`, updating hosting, Supabase Auth URLs and Turnstile domains, and `cimiento domain remove`.
3. Windows via WSL: `install.sh` supports Ubuntu under WSL. Add a GitHub Actions workflow running build, tests and `install.sh --dry-run` on ubuntu-latest and macos-latest.
4. Field tests on existing sessions, unattended, recorded in `docs/FIELD-TEST-5.md` with timings from the run logs:
   - a) `cimiento new cimiento-test-5 --preset designer --json --yes`; change the title in `app/page.tsx`, run `cimiento publish`, confirm the new title is live; push a branch and confirm `hosting.preview` passes; declare `CIMIENTO_TEST_SECRET` with sinks hosting and ci, set it from the env source with a fake value, check, rotate with a second fake value, check; run `cimiento dev` for 30 seconds and confirm the local page answers 200; clone the repo into a second folder and run `cimiento join`, every check ok.
   - b) A second project `cimiento-test-5b` with hosting netlify, database neon, email resend, payments stripe, analytics posthog: up to a live URL with every check passing.
   - c) `cimiento domain add` with a cimiento-test subdomain of a domain listed by `vercel domains ls`, confirm it serves, then `cimiento domain remove`.

   Then `doctor` twice and `down --yes` for both projects, and confirm with each provider's CLI or API that nothing remains. A missing account, session or key is a person step: end with `BLOCKED:` and the exact attended command as Next. If `vercel domains ls` lists no domain, end with `BLOCKED: domain` and say what is needed.
5. Every failure is a bug: fix it with a KB entry and a regression test, continuing from BUG-58.
6. Mark v1 and v2 done in SPEC section 18. Bump to 0.2.0, CHANGELOG, regenerate `docs/TROUBLESHOOTING.md`, README covering every provider, `npm pack` check, push. Do not run `npm publish`; end with `BLOCKED: npm publish`.

The GOAL REPORT includes the bug table and timings inline.

## Goal 6: trustworthy state, teardown and health; version 0.3.0

Status: complete. 0.3.0 is on npm; 0.1.0 and 0.2.0 are deprecated.

0.2.0 is already on npm and has these bugs; 0.3.0 replaces it.

1. Verification returns present, absent or unknown. `down` forgets a resource only on confirmed absent; auth errors, timeouts and provider errors keep it in state and exit non-zero.
2. State records each managed resource's full spec. `down` and `plan` cover every resource in state, including ones whose slot was removed or changed in `stack.yaml`; a removed slot asks retain, release or destroy (flag for `--yes`).
3. Checkpoint state after every completed operation, written to a temp file then renamed, with a project lock file that blocks concurrent runs and reports a stale lock.
4. `publish` runs commit, push and deploy-wait as resumable stages: with a clean tree it still compares HEAD with the remote and the deployed commit and resumes the missing stage.
5. `doctor`: a failed live verify is failed or unknown, never ok; `manualDone` is history only.
6. `plan` and `doctor` are passive. Split verify into inspect and smoke; the Resend email and the PostHog event only run in smoke, behind `--smoke`, with the effect stated. Test that `plan` makes no POST.
7. Neon migrations: no semicolon splitting; send whole files through a path that understands dollar quoting; tell a missing history table from an unreadable one.
8. `io.ts` http: bounded timeout on every request; retries only for idempotent reads.
9. Templates escape string literals and JSX text; test with the name `Jane's "app" & co`.
10. README: the `.env` hook is an accidental-disclosure guard, not a boundary. Tagline: cimiento connects your app's services, verifies the connections and helps you recover when they break. A capability matrix per provider with proven, partially proven, unproven from the field tests. Verification levels explained: key exists, provider accepts it, app uses it, end-to-end transaction. State that dev, preview and production do not imply separate databases unless configured.
11. `cimiento doctor` works in an existing project with no `stack.yaml`: detect providers read-only, create nothing.
12. LICENSE (MIT, jmdarre-v), SECURITY.md, CONTRIBUTING.md with architecture map, local setup, a provider example and test expectations; three good-first-issue GitHub issues.
13. Release workflow: on a `v*` tag, build, test, `npm pack`, install the tarball in a clean dir and run `cimiento --version` and `plan --json` in a scaffolded project that builds; `install.sh` accepts `CIMIENTO_VERSION`, README shows the pinned form.
14. Tests at operational boundaries: interruption right after create, accepted delete plus 503 verify, revoked permission after a confirmed integration, provider swap in `stack.yaml`, failed push and deploy-wait retry, real PostgreSQL via a local postgres in CI.
15. Field test on existing sessions, unattended, in `docs/FIELD-TEST-6.md` with run-log timings: `new cimiento-test-6 --preset designer`, interrupt `up` right after the Vercel project is created and resume, `publish` with a failed push then resume, change hosting to netlify and confirm `plan` and `down` handle the old Vercel project, `down`, confirm nothing remains.
16. Bump to 0.3.0, CHANGELOG, TROUBLESHOOTING, push.

The GOAL REPORT includes the bug table and timings inline.

## Goal 7: identity-safe teardown, honest publish, isolated preview data; version 0.4.0

Status: complete. 0.4.0 is on npm; 0.3.0 is deprecated.

Continue BUG ids from BUG-82, each with a KB entry and a regression test that reproduces the
failure first.

1. `docs/GOALS.md` common rules: a goal contains only work Claude Code can finish and show in its own output; steps that need a person (`npm publish`, `npm deprecate`, browser logins, typing keys, DNS records, revoking keys) never belong to a goal and go only in the GOAL REPORT's Next line; every goal ends with a sentence starting "The goal is met when" naming checks Claude Code can show. Rewrite Goal 6 item 16 to end at the push and mark Goal 6 complete.
2. Delete by immutable id, never by name: Vercel `DELETE /v9/projects/<recorded id>`. Before any delete by name (GitHub repos, any provider without ids), read the resource and compare its recorded id or node id; on mismatch refuse, keep state, explain. Audit every provider's destroy for the same pattern.
3. Legacy state from 0.1.0 and 0.2.0 (entries without spec): on first run, rebuild each spec from the manifest and recorded ids where possible and write it back; anything not rebuildable is reported as unresolved legacy, and `down` exits non-zero until it is reconciled. CHANGELOG states the upgrade path.
4. `publish`: a failed live-commit lookup (any non-2xx, timeout) is unknown, never filled from cached state; `publish` exits non-zero with an actionable hint. Same rule for every live read that has a cached fallback.
5. Preview data isolation: preview deployments never share the production database by default. Neon: a branch per preview, created and removed with the preview. Supabase: a separate preview project, with the free project limit stated before creating it. Option `environments.preview.database: shared` to opt out, with a warning. `down` removes preview branches and projects. Field test both on existing sessions, unattended; if the Supabase free limit blocks it, record that and continue.
6. README: an "Eject" section (delete `stack.yaml` and `.cimiento/`, what stays: a plain Next.js app, native env vars in the hosting provider, the repo, the databases; nothing to uninstall in the app). State precisely what `doctor` without `stack.yaml` does: provider discovery and tool and session checks, not full diagnosis.
7. Demo: on a real project created for it, break a key (write a wrong value to one env var), run `doctor --smoke` and show the failure with its hint, fix it with `secret set`, doctor green. Record it with vhs into `docs/demo.gif`, embed it at the top of the README, then `down` and confirm nothing remains.
8. Record field tests in `docs/FIELD-TEST-7.md` with run-log timings. Bump to 0.4.0, CHANGELOG, TROUBLESHOOTING, tag v0.4.0, push.

The goal is met when the GOAL REPORT is printed showing every item committed, `pnpm test` and CI green on the last commit, the v0.4.0 tag pushed, git status clean, and every field-test resource confirmed gone with each provider's CLI or API. The report includes the bug table and timings inline; its Next line lists only person steps: `npm publish` of 0.4.0, and `npm deprecate` of 0.3.0 because its teardown deletes by name.

## Goal 8: close the Goal 7 limits; version 0.4.1

Status: complete. 0.4.1 is on npm. The Supabase preview field test is completed by the owner's
decision.

Continue BUG ids from BUG-93, each with a KB entry and a regression test that reproduces the
failure first.

1. Neon preview branches without `cimiento up`: the scaffold ships a GitHub Actions workflow that, on push of any branch other than main, creates the Neon branch for it (and deletes it when the branch is deleted), using a `NEON_API_KEY` repo secret that cimiento sets through the ci sink. A preview built before the branch exists must fail with a clear message, never read production. Field test unattended on existing sessions: push a branch with plain git, confirm the preview reads its own database, delete the branch, confirm the Neon branch is gone.
2. Commit stamp on CLI deploys: field test unattended on Vercel and Netlify with a clean tree, confirm the deployment records the commit and `publish` on a clean tree reads it back. Fix whatever fails.
3. Speed: an `up` with nothing to change takes about 90 s, mostly tool and session detection. Cache tool versions and session identities per machine with a short TTL, invalidated on any auth error, and run detection concurrently. Target: a noop `up` under 20 s on the cimiento repo itself; report the measured before and after from run logs.
4. Supabase preview project: implement a field test path that runs when a free slot or a paid organization the person chose is available; when the free limit blocks it, record that and continue. Do not pause, delete or create anything outside cimiento-test-8 resources.
5. Record in `docs/FIELD-TEST-8.md` with run-log timings. Update the README capability matrix with what is now proven. Bump to 0.4.1, CHANGELOG, TROUBLESHOOTING, tag v0.4.1, push.

The goal is met when the GOAL REPORT is printed showing every item committed or recorded as stopped with its reason, `pnpm test` and CI green on the last commit, the v0.4.1 tag pushed, git status clean, and every field-test resource confirmed gone with each provider's CLI or API. The report includes the bug table and timings inline; its Next line lists only person steps: `npm publish` of 0.4.1, and freeing a Supabase free slot if the Supabase preview test was blocked.

## Goal 9: close the Goal 8 limits; version 0.4.2

Status: complete. v0.4.2 is tagged and pushed; publishing it to npm is a person step.

Continue BUG ids from BUG-105, each with a KB entry and a regression test that reproduces the
failure first.

1. Preview credentials: previews must not hold a key that can read the production branch. The GitHub Actions workflow creates the Neon branch and writes only that branch's connection string as a branch-scoped preview env var in the hosting provider (Vercel gitBranch env, Netlify branch-deploy context); the project-scoped Neon key lives only in GitHub Actions secrets, never in hosting env. On branch delete the workflow removes the branch and its env var. Prove on real Vercel and real Netlify, unattended on existing sessions: a preview reads its own branch, the preview runtime has no Neon API key in its env, deleting the git branch removes both.
2. `down` removes every local secret cimiento wrote for the project: keychain entries under service cimiento for that project, and `.env.local` values it pulled. Clean up the leftover `cimiento-test-8/NEON_API_KEY`.
3. Existing projects: add `cimiento upgrade`, which compares the project with the current scaffold for its template, shows each file it would add or change (workflows, route helpers, `.gitignore` lines), never overwrites a file the person changed without asking, applies on confirmation, and commits. `up` reports when an upgrade is available. Test on a project scaffolded by 0.4.0 from the npm tarball.
4. Record in `docs/FIELD-TEST-9.md` with run-log timings. Update the README capability matrix and the security notes on preview credentials. Bump to 0.4.2, CHANGELOG, TROUBLESHOOTING, tag v0.4.2, push.

The goal is met when the GOAL REPORT is printed showing every item committed, `pnpm test` and CI green on the last commit, the v0.4.2 tag pushed, git status clean, every field-test resource confirmed gone with each provider's CLI or API, and `security find-generic-password` returning nothing for service cimiento with a cimiento-test- account. The report includes the bug table and timings inline; its Next line lists only person steps: `npm publish` of 0.4.2, and the exact `npm deprecate` command for each published version whose previews hold a key that can read production (check 0.4.0 and 0.4.1 in the code, list only those that do).
