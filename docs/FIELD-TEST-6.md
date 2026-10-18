# Field test 6: interruption, resume and a provider swap on cimiento-test-6

Goal 6 in `docs/GOALS.md`, item 15, unattended, on the existing sessions, with the built `dist`
(`node dist/cli.js`, from `~/Code.nosync`). Timings come from the first and last line of each run
log in `~/.cimiento/runs/`; all times are UTC on 2026-10-18. Account identifiers are left out.

Status: complete. Every step passed; one bug found, BUG-81, fixed and proven on the same project.

## Result

| Step | Outcome |
|---|---|
| `new cimiento-test-6 --preset designer --json --yes`, killed with `kill -9` the moment the run log showed `ensured` for `vercel.project` | The process died with the repository and the Vercel project created and nothing deployed. state.json, version 2, already recorded `github.repo` and `vercel.project` as created, each with its spec; the lock of the dead process stayed in `~/.cimiento/locks` |
| `up --json --yes` | Exit 0. It reported the stale lock (`stale-lock`, process and start time) and took it over; `vercel.project` came back noop, not adopted, so down would still delete it; it deployed, and every check passed: `hosting.deployed` 200 from https://cimiento-test-6.vercel.app. The lock was released at the end. One Vercel project with the name, not two |
| Title changed in app/page.tsx, then `publish` with the push URL of origin pointing at a repository that does not exist | Exit 1: `git push to main failed: remote: Repository not found`, after the commit was made |
| Push URL restored, `publish --json` with a clean tree | Exit 0 with stages commit skipped, push done, deploy done; the new title live on https://cimiento-test-6.vercel.app |
| `slots.hosting` changed from vercel to netlify, `plan --json` | `vercel.project` and `vercel.deployment` listed as orphan, next to `netlify.project` create; plan sent nothing |
| `down --yes --json` | Exit 0: destroyed `vercel.deployment`, `vercel.project` and `github.repo`, each confirmed gone by its id. State kept `vercel.check.deployed`, `vercel.check.preview` and `vercel.check.repo-linked` (BUG-81) |
| `down --yes --json` again, before the fix | Nothing to destroy, and the three checks stayed (BUG-81, second path) |
| `down --yes --json` after the fix | Nothing to destroy; state holds only the machine's tool and session entries |

## Confirmation

- `gh repo view jmdarre-v/cimiento-test-6`: Could not resolve to a Repository.
- `vercel project ls`: no cimiento-test-6; https://cimiento-test-6.vercel.app answers 404.
- Netlify API `sites?name=cimiento-test-6`: none; no Netlify site was ever created, because `up`
  was not run after the swap.
- `~/.cimiento/locks`: empty.

## Timings per phase

From the first and last line of each run log.

| Phase | When (UTC) | Duration | Run log |
|---|---|---|---|
| `new`, killed after `vercel.project` | 16:40:10 to 16:40:41 | 30.6 s, no end line: the process was killed | 2026-10-18T16-40-10-709Z-new.jsonl |
| `up`, resume | 16:40:50 to 16:42:00 | 70.1 s | 2026-10-18T16-40-50-011Z-up.jsonl |
| `publish`, failed push | 16:42:10 to 16:42:13 | 2.4 s | 2026-10-18T16-42-10-718Z-publish.jsonl |
| `publish`, resume | 16:42:13 to 16:42:47 | 33.8 s | 2026-10-18T16-42-13-327Z-publish.jsonl |
| `plan` after the swap | 16:42:58 to 16:43:07 | 8.6 s | 2026-10-18T16-42-58-433Z-plan.jsonl |
| `down` | 16:43:07 to 16:43:12 | 4.8 s | 2026-10-18T16-43-07-269Z-down.jsonl |
| `down` again, before the second fix | 16:44:58 to 16:44:58 | under 0.1 s | 2026-10-18T16-44-57-998Z-down.jsonl |
| `down` after the fix | 16:46:17 to 16:46:17 | under 0.1 s | 2026-10-18T16-46-17-677Z-down.jsonl |
| Implementation and unit tests | | not measured | no run log |
| Confirmation with gh, vercel, curl and the Netlify API | | not measured | not a cimiento command |

## Bugs found in Goal 6

Ids continue from BUG-70 in `docs/FIELD-TEST-5.md`. Each has a knowledge base entry or `seen:`
note and a regression test that failed on the code before its fix: BUG-71 to 81 in
`test/unit/goal-6.test.ts`, BUG-75 also in `test/unit/planner.test.ts`, and BUG-77 also against a
real PostgreSQL in `test/unit/postgres.test.ts`. BUG-71 to 80 came from the goal's list, found
by those tests; BUG-81 came from this field test.

| Id | Description | Fix commit |
|---|---|---|
| BUG-71 | io.ts http had no timeout: a provider that never answered hung cimiento forever | fe1bae6 |
| BUG-72 | State was written only at the end of a run, so a run killed after a create left no record and the next run adopted what cimiento had made; no lock kept two runs apart | a85fd9b |
| BUG-73 | down forgot a resource when the check after its delete failed for any reason, a 503, a revoked token or a timeout included | ba3e97a |
| BUG-74 | plan and down only covered what stack.yaml selects: after hosting changed, the old project was invisible to plan and left running by down | 3bb9860 |
| BUG-75 | doctor called a step ok because manualDone said it was confirmed once, even when its live check failed; plan called it done; a Vercel 5xx was ok | efb2781 |
| BUG-76 | plan and doctor acted on the outside world: a Supabase SQL query, a Turnstile siteverify, an Inngest event, the Resend email, the PostHog event and Neon SQL | 2f761a2 |
| BUG-77 | Neon migrations were split at semicolons, which broke dollar quoted bodies, and an unreadable history table was taken as no migrations | 0bbfb9d |
| BUG-78 | publish with a clean tree said there was nothing to publish, after a failed push or a deploy wait that timed out | 3bf105d |
| BUG-79 | Templates pasted the project name raw into TypeScript and JSX, so a name with a quote did not build | bf71575 |
| BUG-80 | doctor in a project without stack.yaml stopped with MANIFEST_NOT_FOUND | 688e27a |
| BUG-81 | After a provider swap, down kept the old provider's checks in state, and a down with nothing to destroy never cleared them | 719b57c, 0344d84 |
