# Field test 7: preview data isolation, honest publish and the demo

Goal 7 in `docs/GOALS.md`, items 4, 5 and 7, unattended, on the existing sessions, with the built
`dist` (`node dist/cli.js`, from `~/Code.nosync`). Timings come from the first and last line of
each run log in `~/.cimiento/runs/`; all times are UTC on 2026-10-18. Account identifiers are
left out: `<team>`, `<project id>` and the like stand for them.

Status: complete. Neon preview isolation passed end to end. The Supabase preview project stopped
at Supabase's free limit, as the goal allows: the account already has two active free projects in
other organizations. Recorded below. The demo found BUG-92 in its rehearsal, fixed and proven on
the same project. Every resource is confirmed gone.

## Neon: a database per preview branch, on cimiento-test-7

Vercel hosting, Neon database, GitHub repository.

| Step | Outcome |
|---|---|
| `new cimiento-test-7 --repo github --hosting vercel --database neon --template nextjs-app --json --yes` | Exit 0. `DATABASE_URL` and `DATABASE_URL_UNPOOLED` written for production and development only, none for preview. `neon.preview-branches` noop: no branch besides main. Migrations applied through the Postgres client on real Neon |
| `publish --json` | Exit 0: committed and pushed what `new` leaves uncommitted (the account pins in `stack.yaml`, the README receipts, state) and waited for the deploy |
| `publish --json` again, clean tree | Exit 0, `published: false`: the live commit read from Vercel's deployment, not from state (item 4). It came from the git deploy the push made; the commit stamp on CLI deploys (`--meta cimientoCommit`) was never exercised on real Vercel, because every CLI deploy in this test ran with `.cimiento/state.json` modified, a dirty tree, so no stamp. Unit tests cover the stamp |
| `feature/login` pushed with plain git; its preview built, with no database address | Preview ready on Vercel |
| `up --json --yes` | Exit 0. `neon.preview-branches` created: Neon branch `preview/feature-login` with its own compute endpoint; `DATABASE_URL` and `DATABASE_URL_UNPOOLED` written as Vercel preview values for the git branch `feature/login` only |
| Confirmation | `vercel env ls`: the two keys for Production, Development and `Preview (feature/login)`, no plain Preview value. Neon API: two branches, `main` and `preview/feature-login`, each on its own endpoint host |
| `up --json --yes` again | Exit 0, `neon.preview-branches` noop |
| `git push origin --delete feature/login`, then `up --json --yes` | Exit 0, `updated`: the Neon branch and both branch values removed. `vercel env ls` shows no `feature/login` value; the Neon API lists only `main` |
| Branch pushed again, `up`, then `down --yes --json` | `up` created the branch database again. `down` exit 0, destroyed `vercel.deployment`, `neon.preview-branches`, `vercel.project`, `neon.migrations`, `neon.project` and `github.repo` |

## Supabase: the preview project and the free limit, on cimiento-test-7s

Vercel hosting, Supabase with `accounts.supabase: direct`, pinned to an existing free organization
with no active project, so nothing was created in a paid organization and no organization was
created.

| Step | Outcome |
|---|---|
| `new cimiento-test-7s ... --supabase-account direct --scaffold-only`, organization pinned in `stack.yaml` | Files only |
| `plan --json` | Two billing lines, `supabase.project` and `supabase.preview-project`, both in the free organization, and the notice before anything is made: the preview project is a second Supabase project, the free plan allows 2 active projects per person, and `environments.preview.database: shared` skips it |
| `up --json --yes --allow-billing` | Exit 2. The same notice as an event first. GitHub repository and Vercel project created. `supabase.project` waited on a person with SUPABASE_FREE_PROJECT_LIMIT, naming the two active free projects that count, each with its last API request. The preview project and every Supabase env value stayed blocked behind it. Nothing was created at Supabase |
| `down --yes --json` | Exit 0, destroyed `vercel.project` and `github.repo` |

The preview-only Marketplace database (`vercel integration add supabase --environment preview`)
and the direct preview project past the limit are covered by unit tests only.

## Demo: a key changed by hand, on cimiento-test-7-demo

The designer preset with one declared secret, `DEMO_TOKEN`, sinks hosting, environment
production, source env. Its value was a random token in a temporary file, read by the shell and
never typed, printed or committed; the file was deleted after the demo.

| Step | Outcome |
|---|---|
| `new cimiento-test-7-demo --preset designer --json --yes`, then `DEMO_TOKEN` declared and `up` | Exit 0. `DEMO_TOKEN` written to the Vercel production env |
| Rehearsal: `vercel env rm`, then `vercel env add` with a wrong value, `doctor --smoke` | Exit 1, but only for the stale deployment, whose hint was `cimiento up`. The env check said present: the Vercel CLI stores the value as sensitive, which Vercel never shows again, so the value compare had nothing to read (BUG-92) |
| Fix, then `vercel env rm` and `up` with the new build | Exit 0. State records the id and update time of the entry cimiento wrote. `doctor --smoke`: 16 ok, the value compared with the one cimiento holds |
| Rehearsal again | `doctor --smoke` exit 1 with SECRET_VALUE_MISMATCH and the hint `cimiento secret set DEMO_TOKEN`. `secret set` exit 0: written over the entry and deployed again. `doctor --smoke` 16 ok |
| Recorded with `vhs docs/demo.tape` into `docs/demo.gif` | The same steps. The first take showed team, project and installation ids in the full `doctor` table; the tape now shows only the summary, the failure with its hint and the result of `secret set`, so no id reaches the recording |
| `down --yes --json` | Exit 0, destroyed `vercel.deployment`, `vercel.project` and `github.repo` |

## Confirmation

- `gh repo view` for cimiento-test-7, cimiento-test-7s and cimiento-test-7-demo: Could not
  resolve to a Repository.
- `vercel project ls`: no project named cimiento-test-7*. https://cimiento-test-7.vercel.app
  first answered 200 from a cache with a body of DEPLOYMENT_NOT_FOUND, then 404 on a fresh
  request; https://cimiento-test-7-demo.vercel.app answers 404.
- Neon API, in the pinned organization: no project named cimiento-test-7.
- `supabase projects list`: no project named cimiento-test-7*; none was ever created.
- `~/.cimiento/locks`: empty.

## Timings per phase

From the first and last line of each run log.

| Phase | When (UTC) | Duration | Run log |
|---|---|---|---|
| `new` cimiento-test-7 | 19:15:34 to 19:17:24 | 109.7 s | 2026-10-18T19-15-34-495Z-new.jsonl |
| `publish`, what `new` left | 19:17:36 to 19:18:05 | 29.2 s | 2026-10-18T19-17-36-709Z-publish.jsonl |
| `publish`, clean tree | 19:18:15 to 19:18:17 | 2.2 s | 2026-10-18T19-18-15-158Z-publish.jsonl |
| `up`, branch database created | 19:22:28 to 19:23:53 | 85.6 s | 2026-10-18T19-22-28-079Z-up.jsonl |
| `up` again, noop | 19:24:32 to 19:26:02 | 90.4 s | 2026-10-18T19-24-32-118Z-up.jsonl |
| `up` after the branch was deleted | 19:26:05 to 19:27:33 | 87.9 s | 2026-10-18T19-26-05-182Z-up.jsonl |
| `up`, branch database again | 19:28:54 to 19:30:25 | 90.8 s | 2026-10-18T19-28-54-205Z-up.jsonl |
| `down` cimiento-test-7 | 19:30:25 to 19:30:32 | 7.2 s | 2026-10-18T19-30-25-226Z-down.jsonl |
| `new --scaffold-only` cimiento-test-7s | 19:31:44 to 19:31:44 | under 0.1 s | 2026-10-18T19-31-44-392Z-new.jsonl |
| `plan` cimiento-test-7s | 19:31:54 to 19:32:06 | 11.4 s | 2026-10-18T19-31-54-898Z-plan.jsonl |
| `up`, stopped at the free limit | 19:32:06 to 19:33:02 | 56.2 s | 2026-10-18T19-32-06-411Z-up.jsonl |
| `down` cimiento-test-7s | 19:33:09 to 19:33:13 | 4.1 s | 2026-10-18T19-33-09-656Z-down.jsonl |
| `new` cimiento-test-7-demo | 19:41:41 to 19:42:53 | 71.8 s | 2026-10-18T19-41-41-544Z-new.jsonl |
| `up`, `DEMO_TOKEN` written | 19:42:53 to 19:43:56 | 63.4 s | 2026-10-18T19-42-53-536Z-up.jsonl |
| `doctor --smoke`, first rehearsal (BUG-92) | 19:44:15 to 19:44:29 | 14.6 s | 2026-10-18T19-44-15-343Z-doctor.jsonl |
| `up` with the fix, entry recorded | 19:47:31 to 19:48:42 | 71.2 s | 2026-10-18T19-47-31-796Z-up.jsonl |
| `doctor --smoke`, wrong value found | 19:49:09 to 19:49:23 | 14.2 s | 2026-10-18T19-49-09-344Z-doctor.jsonl |
| `secret set`, written and deployed again | 19:49:23 to 19:50:11 | 47.3 s | 2026-10-18T19-49-23-699Z-secret-set.jsonl |
| `doctor --smoke`, green | 19:50:11 to 19:50:25 | 13.9 s | 2026-10-18T19-50-11-247Z-doctor.jsonl |
| Recorded take: `doctor`, `doctor`, `secret set`, `doctor` | 20:07:00 to 20:09:03 | 16.1 s, 17.5 s, 49.1 s, 17.8 s | 2026-10-18T20-07-00-841Z-doctor.jsonl to 2026-10-18T20-08-46-107Z-doctor.jsonl |
| `down` cimiento-test-7-demo | 20:10:48 to 20:10:53 | 4.8 s | 2026-10-18T20-10-48-913Z-down.jsonl |
| Two earlier takes, discarded for showing ids or clearing the screen | 19:56:45 to 20:03:44 | about 1 minute each | 2026-10-18T19-56-45-479Z-doctor.jsonl to 2026-10-18T20-03-29-087Z-doctor.jsonl |
| Implementation and unit tests | | not measured | no run log |
| Confirmation with gh, vercel, the Neon API and supabase | | not measured | not a cimiento command |

An `up` with nothing to change took about 90 s; most of it is the tool and session detection
before the plan and the plan itself, the same cost field test 6 measured, not the preview work.
The Postgres client prints a Node warning about `sslmode` on stderr; it changes nothing.

## Bugs found in Goal 7

Ids continue from BUG-81 in `docs/FIELD-TEST-6.md`. Each has a knowledge base entry or `seen:`
note and a regression test in `test/unit/goal-7.test.ts` that failed on the code before its fix.
BUG-82 to 91 came from the goal's list, found by those tests; BUG-92 came from this field test.

| Id | Description | Fix commit |
|---|---|---|
| BUG-82 | down deleted the Vercel project by name, so a project made later with the same name was deleted in place of the one cimiento made | cdfbbb5 |
| BUG-83 | down ran gh repo delete by name without comparing the node id cimiento recorded | cdfbbb5 |
| BUG-84 | Netlify, Neon and Turnstile destroy looked a resource up by name when state had no id | cdfbbb5 |
| BUG-85 | State from 0.1.0 and 0.2.0 has no specs, so after a provider swap down skipped the old resource and exited 0 with it still running | ebe5975 |
| BUG-86 | A legacy record no provider describes was skipped by down as if it were not there | ebe5975 |
| BUG-87 | publish filled a failed live-commit lookup, any non 2xx or a timeout, from the commit state recorded, and said there was nothing to publish | 9d875a9 |
| BUG-88 | Previews got the same DATABASE_URL as production, so every preview read and wrote the production Neon database | f654064 |
| BUG-89 | The Marketplace connected the production Supabase database to previews, and the direct path wrote production's keys into the preview env | b86fa21 |
| BUG-90 | doctor only checked that a hosting env name was present, so a key changed by hand passed | dc7f9e6 |
| BUG-91 | secret set reported noop and left a wrong value in the hosting env in place | dc7f9e6 |
| BUG-92 | A value the hosting never shows again, such as one the Vercel CLI stores as sensitive, could not be compared, so the wrong key still passed | c1739e0 |
