# Field test 2: cimiento-test-2 with the full fullstack preset

Goal 2 in `docs/GOALS.md`: the same field test as Goal 1, now with inngest, turnstile, anthropic
and keychain secrets. `cimiento new cimiento-test-2` was run from `~/Code.nosync`, and every login,
account choice and browser step was left to cimiento. Billing was approved, so `up` ran with
`--allow-billing`. All times are UTC, measured on the run clock in the session scratchpad and by
commit, vendor and wrangler log timestamps.

Status: complete. up exit 0, doctor 40/40 twice with plan all noop, every check passing on real
accounts, down exit 0, and nothing left except the two listed leftovers.

## Result

| Step | Outcome |
|---|---|
| Unit tests first | 34 Goal 2 tests, then regression tests for every bug below; 286 in total, all passing |
| `cimiento new cimiento-test-2 --preset fullstack --json --yes --allow-billing` | Exit 2 after 61 s: GitHub repo and Vercel project created, wrangler installed, 9 person steps reported. BUG-35 to 39 |
| Second unattended `up` | Exit 2 after 48 s, nothing created, same person steps |
| BUG-40 | TYPESAFE_API_KEY and XPOZ_API_KEY removed from the preset and, through `cimiento secret remove`, from cimiento-test-2 |
| Two attended `up --allow-billing` runs, by a person | Supabase organization created (cimiento-test-2), database installed through the Marketplace, ANTHROPIC_API_KEY stored in the keychain, Inngest integration approved (configuration created 20:20:58). Both Cloudflare logins failed at once (BUG-47); the person then ran a plain `wrangler login` at 20:38:03. The database landed in a shared configuration (BUG-46) |
| Fixes BUG-41 to 47 | Commits 302bd02 to ffec240 |
| `plan --json` | `turnstile.session` noop: detection was fine, the login itself had failed. `turnstile.widget` create, no longer waiting on an account choice |
| `up --json --yes --allow-billing`, first | Exit 1: widget, production Turnstile keys and deployment created; `inngest.app` failed with a 401 from the Inngest SDK, reported as deployment protection (BUG-48); site key shown as **** (BUG-49) |
| `up --json --yes --allow-billing`, second | Exit 0, no person step. Checks with evidence below |
| `doctor --json` twice | 40/40 ok both times; `plan --json` all 40 noop. doctor listed gh, vercel and supabase as outdated without asking |
| `down --yes --json` | Exit 0 in 20 s. Destroyed supabase.project, vercel.deployment, turnstile.widget, github.repo, vercel.project. Leftovers: Supabase organization cimiento-test-2 (example-org-test-2), Inngest app cimiento-test-2 |
| Confirmation | Below |

Checks on real accounts, from the exit 0 up:

| Check | Evidence |
|---|---|
| jobs.roundtrip | event 01EXAMPLEEVENT (cimiento/roundtrip) ran cimiento-roundtrip, run 01EXAMPLERUN Completed |
| bot_protection.verify | siteverify accepted the secret key of widget 0xEXAMPLESITEKEY and rejected a dummy token (invalid-input-response) |
| secrets.present | 1 declared secret present in 2 vercel targets: ANTHROPIC_API_KEY=**** |
| Anthropic key | ANTHROPIC_API_KEY=**** accepted by api.anthropic.com (GET /v1/models answered 200) |
| inngest.app | https://cimiento-test-2.vercel.app/api/inngest serves 1 function in cloud mode with both keys |
| hosting.deployed | 200 from https://cimiento-test-2.vercel.app |
| database.migrated | 1 migration applied in example-db-test-2; public.cimiento_baseline answers with 1 row |
| auth.urls | Supabase site URL is https://cimiento-test-2.vercel.app |
| repo.linked | Vercel project linked to jmdarre-v/cimiento-test-2 on main |

Confirmation after down, 21:17:35 to 21:17:57:

- `gh repo view jmdarre-v/cimiento-test-2`: Could not resolve to a Repository.
- `vercel project ls`: no cimiento-test-2; another project is listed.
- `supabase projects list`: no example-db-test-2; another project's database (example-db-other) ACTIVE_HEALTHY in
  vercel_icfg_EXAMPLESHARED.
- Vercel API: the only Marketplace resource left is another project's (store_EXAMPLEOTHER, configuration
  icfg_EXAMPLESHARED); store_EXAMPLETEST2 for cimiento-test-2 is gone. Configurations
  icfg_EXAMPLESHARED, icfg_EXAMPLELINKED and the Inngest icfg_EXAMPLEINNGEST
  are all still installed.
- Cloudflare API: the account example-cloudflare-account has one widget, belonging to another project, which
  cimiento did not create; the cimiento-test-2 widget is gone.
- Leftovers, as listed by down: the empty Supabase organization cimiento-test-2 (0 projects), and
  the Inngest app cimiento-test-2.

## Timings per phase

| Phase | When (UTC) | Duration | Source |
|---|---|---|---|
| Read the spec and goals, tooling and vendor research | 10-17 17:29:16 to the first Goal 2 edit | not timed separately | run timer |
| Implementation and unit tests | to 17:57:03 | 27 min 47 s from the start | commit 5ae9098 |
| Preflight: build and 233 tests | 17:57:18 to 17:57:25 | 7 s | run timer |
| Unattended `cimiento new cimiento-test-2` | 17:57:32 to 17:58:33 | 61 s | run timer |
| Fixes BUG-35 to 39, regression tests, build | 17:58:33 to 18:00:37 | 2 min 4 s | run timer, commit fd5ed2a |
| Second unattended `up` | 18:00:45 to 18:01:33 | 48 s | run timer |
| Hint wording fix | to 18:01:53 | 20 s | commit 5660952 |
| BUG-40: preset, SPEC section 4, `secret remove`, KB entry, regression tests | 19:34:37 to 19:37:49 | 3 min 12 s | run timer, commit 5e53ab0 |
| `secret remove` of both secrets in cimiento-test-2 | 19:37:35 to 19:37:38 | 3 s | run timer |
| Attended `up` runs, by a person | about 20:20 to 20:38 | about 18 min | Inngest configuration 20:20:58, failed wrangler logins 20:24:26 and 20:37:05, manual wrangler login 20:38:03 |
| GOALS.md report format | 20:40:15 to 20:40:26 | 11 s | commit fb41237 |
| Diagnosis of the Cloudflare login and the shared configuration, BUG-47 | 20:40:26 to 20:46:54 | 6 min 28 s | commit 302bd02 |
| BUG-46 | to 20:50:11 | 3 min 17 s | commit 3ff417e |
| BUG-41 and BUG-45 | to 20:58:52 | 8 min 41 s | commit 134c6f9 |
| BUG-42, 43 and 44 | to 21:02:20 | 3 min 28 s | commit ffec240 |
| Build, 282 tests, `plan --json` | 21:02:30 to 21:03:08 | 38 s | run timer |
| `up --json --yes --allow-billing`, first (exit 1) | 21:03:08 to 21:05:29 | 2 min 21 s | run timer |
| BUG-48 and 49, build | 21:05:29 to 21:07:43 | 2 min 14 s | run timer, commit 1e0dc94 |
| `up --json --yes --allow-billing`, second (exit 0) | 21:07:43 to 21:13:45 | 6 min 2 s | run timer |
| `doctor --json` twice | 21:13:55 to 21:15:59 | 61 s and 63 s | run timer |
| `down --yes --json` | 21:17:01 to 21:17:21 | 20 s | run timer |
| Confirmation with gh, vercel, supabase and the Vercel and Cloudflare APIs | 21:17:35 to 21:17:57 | 22 s | run timer |

## Bugs found in Goal 2

Ids continue from BUG-34 in `docs/FIELD-TEST-1.md`. Each has a knowledge base entry or `seen:` note
and a regression test: BUG-35 to 40 and 42 to 49 in `test/unit/goal-2.test.ts`, BUG-41 in
`test/unit/person-steps.test.ts`.

| Id | Description | Fix commit |
|---|---|---|
| BUG-35 | `--json` printed every event across many lines, where spec section 10 asks for one line per event | fd5ed2a |
| BUG-36 | Env binding ids came out as `prj:NAME:****`, because the redactor read `NAME:target` as a secret | fd5ed2a |
| BUG-37 | An unattended run said cimiento had opened the Inngest and Marketplace pages in the browser, when nothing was opened | fd5ed2a |
| BUG-38 | A missing keychain secret said run secret set, without saying it needs a terminal or that the value goes to the keychain; then said it was asked once per environment, when it is asked once | fd5ed2a, 5660952 |
| BUG-39 | The Inngest step named the Vercel team by its id instead of its name | fd5ed2a |
| BUG-40 | The fullstack preset required TYPESAFE_API_KEY and XPOZ_API_KEY, which SPEC section 4 only showed as one project's own secrets, and there was no way to take a declared secret out of a project | 5e53ab0 |
| BUG-41 | Person steps did not give the full clickable link, Enter to open (opening before it), the clicks in order, each field and value, the button, what success looks like, and Enter when done, in en and es | 134c6f9 |
| BUG-42 | Person steps were spread through the run instead of listed and done first, with no word that the rest is unattended or how long it takes | ffec240 |
| BUG-43 | Tool upgrades were asked one by one during apply, skips were not remembered, and doctor did not report outdated tools | ffec240 |
| BUG-44 | The Supabase organization was asked after the plan, so the billing warning could not name it and its plan | ffec240 |
| BUG-45 | The Inngest integration step did not say whether to pick Create New or Link Existing Inngest Account | 134c6f9 |
| BUG-46 | The Marketplace path silently put the database in configuration icfg_EXAMPLESHARED, which already served another project, instead of the organization picked; down had no rule against touching a configuration it did not create | 3ff417e |
| BUG-47 | Every Cloudflare login failed at once on wrangler's `Invalid authentication scope: "offline_access"`, the error only said the login did not finish, and a single account was not pinned without a question | 302bd02 |
| BUG-48 | `/api/inngest` answered 401 from the Inngest SDK, which requires signed introspection, and cimiento blamed Vercel deployment protection | 1e0dc94 |
| BUG-49 | The public Turnstile site key was masked as **** in receipts | 1e0dc94 |

## Left for a person

- The Supabase organization cimiento-test-2 (example-org-test-2), empty. `supabase orgs list`
  still shows it on 2026-10-17 23:08 UTC; delete it at
  https://supabase.com/dashboard/org/example-org-test-2/general
- The Inngest app cimiento-test-2, to archive at https://app.inngest.com/env/production/apps
- On this Mac, the keychain item cimiento / cimiento-test-2/ANTHROPIC_API_KEY, which down does not
  touch. `cimiento secret remove` deletes such an item, but it needs the project folder's stack.yaml.
