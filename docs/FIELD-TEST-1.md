# Field test 1: cimiento-test-1 against real accounts

Goal 1 in `docs/GOALS.md`. `cimiento new cimiento-test-1 --preset fullstack` on a real GitHub account,
Vercel team and Supabase account, then up, doctor and down, fixing every place cimiento did not
handle something itself.

Rebuilt on 2026-10-17 from `git log`, `docs/DECISIONS.md`, the knowledge base `seen:` notes, the
regression test files and the vendors' own timestamps. All times are UTC.

## Result

| Step | Outcome |
|---|---|
| Part A, attended `cimiento new` | Created the GitHub repo, then stopped at the Vercel login (BUG-1) |
| 1. Part A check, plan, doctor | Done four times, once per round |
| 2. Fix what cimiento did not handle | 29 numbered bugs and 5 smaller ones, each fixed; the numbered ones each have a knowledge base entry and a regression test |
| 3. `cimiento down` | Implemented in b1a5abb, 10 unit tests |
| 4. `up --json` to completion | Exit 0 on 2026-09-26 00:42, baseline migration applied through the Management API and queried |
| 5. `doctor --json` twice | 29/29 ok both times; plan all 29 noop |
| 6. `down --yes` and CLI confirmation | Vercel project, deployment and Supabase database deleted on 2026-09-26; GitHub repo deleted in the attended down on 2026-10-17. On 2026-10-17 17:22 `gh`, `vercel` and `supabase` show no cimiento-test-1 repo, project or database. The Supabase organization cimiento-test-1 (example-org-test-1), which the Supabase API cannot delete, was then still listed; on 2026-10-17 23:08 UTC `supabase orgs list` no longer shows it, so nothing of cimiento-test-1 remains |
| 7. Timings and bug list | This document |

Tests went from 103 at the end of Goal 0 to 199.

## Timings per phase

| Phase | When (UTC) | Duration | Source |
|---|---|---|---|
| Part A: attended `cimiento new`, stopped at the Vercel login | 09-25 20:34 to about 20:40 | about 6 min | test project scaffold commit 20:35:05, repo created 20:35:17, Vercel CLI installed 20:38:04 |
| Round 1: preflight and diagnosis | 09-25 21:42 to 21:46 | 4 min 17 s | run timer |
| Round 1: BUG-1 to 8, `cimiento down` | 09-25 21:46 to 21:58 | 12 min 8 s | run timer, commits fc7afb3 and b1a5abb |
| Round 1: step 4 re-run, BUG-9 | 09-25 21:58 to 22:00 | 1 min 16 s | run timer, commit f643c77; each up run 8 to 9 s |
| Attended run 1: logins, team and organization, Marketplace Install | 09-25 22:16 to about 22:27 | about 11 min | Supabase session 22:16:44, Vercel session 22:17:01, integration created 22:26:02, env vars 22:26:32 |
| Round 2: diagnosis and findings 1 to 5 (BUG-10 to 16) | 09-25 22:33 to 22:42 | 9 min 30 s | run timer, commit 4d4d7b9 |
| Round 2: older database check, guards, disconnect, step 4 attempt (BUG-17 to 20) | 09-25 22:42 to 23:28 | 46 min | run timer, commits 7b1732f, 4432b4a, 416abe4 |
| Round 3: accounts set, free limit step, billing wording, leftovers (BUG-21 to 24), no up | 09-25 23:48 to 09-26 00:02 | 14 min 19 s | run timer, commit 3ab1b7a |
| Attended run 2: accounts set created an organization, up to a live site | 09-26 00:09 to before 00:32 | under 23 min | stack.yaml re-pinned 00:09:38, next round started 00:32 |
| Round 4: preflight, diagnosis, BUG-25 to 28 | 09-26 00:32 to 00:41 | 8 min 56 s | run timer, commit b8618a9 |
| Round 4: step 4, up to completion | 09-26 00:42 | 32 s | baseline migration written 00:42:25 |
| Round 4: step 5, doctor twice | 09-26 00:42 to 00:43 | 31 s (16 s and 15 s) | run timer |
| Round 4: step 6, down, CLI confirmation, BUG-29 | 09-26 00:43 to 00:44 | 54 s | run timer, commit b9b6eca |
| Attended down: delete_repo approved, repo deleted | 10-17 15:50 | not timed | project state written 15:50:07 |
| Close: confirmation, this record, push | 10-17 17:22 onward | | |

Agent time across the four rounds was about 1 h 40 min, 46 min of it in round 2. Attended time by
a person was about 6 min for Part A, 11 min and under 23 min for the two attended runs, and one
attended down.

## Bugs found in Goal 1

BUG-1 to 29 carry the number used in their regression test, under `test/unit/part-*-findings.test.ts`.
BUG-30 to 34 were fixed in the same commits but never numbered; they are listed so the record is
complete.

| Id | Description | Fix commit |
|---|---|---|
| BUG-1 | Vendor logins ran captured, with no terminal and a 120 s timeout: the Vercel device code stayed hidden until the login was killed, and supabase login refused its browser flow | fc7afb3 |
| BUG-2 | A missing session in a run with no terminal failed with exit 1 instead of waiting on a person with exit 2 | fc7afb3 |
| BUG-3 | Hints told the person to run vercel login, supabase login, brew, npm or gh by hand; brew install on an old formula did nothing | fc7afb3 |
| BUG-4 | stack.yaml came out with no accounts pinned, and the Vercel team was never asked for | fc7afb3 |
| BUG-5 | The Marketplace step verified whenever Enter was pressed, with no probe, and only printed a link | fc7afb3 |
| BUG-6 | The Marketplace install used vendor defaults that name the database at random and pull secrets into .env.local, with no explicit vercel link | fc7afb3 |
| BUG-7 | doctor recorded the version of gh as the version of git in machine state | fc7afb3 |
| BUG-8 | A Supabase login kept in the macOS Keychain was invisible, so cimiento started a second login | fc7afb3 |
| BUG-9 | A step waiting on a person was attempted again in every executor pass | f643c77 |
| BUG-10 | The Marketplace connected a database cimiento could not find by name, and plan offered to create a second one | 4d4d7b9 |
| BUG-11 | The Supabase organization prompt listed existing organizations only, with no plan and no way to create one | 4d4d7b9 |
| BUG-12 | The Marketplace instructions left out the Create New or Link Existing Supabase Account choice | 4d4d7b9 |
| BUG-13 | Manual step instructions were printed twice | 4d4d7b9 |
| BUG-14 | Billing warnings were printed twice in two phrasings, without saying who pays | 4d4d7b9 |
| BUG-15 | doctor failed the Marketplace step that plan showed as done, because it never ran the verify | 4d4d7b9 |
| BUG-16 | --only and --skip crashed on a dependency across providers | 4d4d7b9 |
| BUG-17 | A database older than the project, connected through Link Existing (another project's database, from 2026-01-25), was about to be adopted, re-pointed and deleted by down | 7b1732f |
| BUG-18 | vercel deploy ran under the 120 s exec timeout, too short for a first build | 4432b4a |
| BUG-19 | The Supabase free project limit was reported as a failure, with a hint that called it per organization when it is per person | 416abe4 |
| BUG-20 | A missing GitHub Login Connection on Vercel was reported as a failure, with a hint pointing at the GitHub app | 416abe4 |
| BUG-21 | A pinned account could not be changed, and state kept its own copy of the Supabase organization | 3ab1b7a |
| BUG-22 | The free project limit step did not show which projects count, their last activity, or how to continue | 3ab1b7a |
| BUG-23 | The billing warning asked for --allow-billing on a run that already had it | 3ab1b7a |
| BUG-24 | down did not account for a Supabase organization cimiento created | 3ab1b7a |
| BUG-25 | The Supabase session reported the first organization the login could see, a paid one the project did not use, not the pinned one | b8618a9 |
| BUG-26 | supabase.check.migrated passed with no migration files, proving nothing | b8618a9 |
| BUG-27 | GitHub access for Vercel came as two failures, one link attempt at a time, each telling the person to run up again | b8618a9 |
| BUG-28 | A newer tool version went unmentioned (Supabase CLI 2.95.4 with 2.118.0 available) | b8618a9 |
| BUG-29 | down said nothing about a leftover organization while another step was pending | b9b6eca |
| BUG-30 | The Supabase status check matched INACTIVE as active, so a paused database passed verify | 4d4d7b9 |
| BUG-31 | Pinning could overwrite a value already in stack.yaml; a unit test running in the repository wrote a fake handle into cimiento's own stack.yaml, restored before any commit | fc7afb3 |
| BUG-32 | supabase.migrations was modeled as a resource, so down would have tried to delete it and reported it as surviving | b1a5abb |
| BUG-33 | The free limit retry read the organization from spec inputs built before a re-pin and could loop forever; caught in development | 3ab1b7a |
| BUG-34 | up's yes or no confirmations read stdin directly and could not be answered in tests; caught in development | 3ab1b7a |

## What the field test proved and did not prove

Proved against the real accounts: browser logins in the foreground, account pinning, the Vercel
team and Supabase organization questions, the Supabase direct path end to end, the Vercel
deployment and its 200 check, Auth URLs following the production URL, migrations through the
Management API, doctor twice, and down with typed confirmation and the delete_repo permission.

Not proved: the via-hosting path end to end, because the attended Marketplace Install linked an
existing database through Link Existing and the test switched to the direct path
(`docs/DECISIONS.md`); creating a Supabase organization was proved once, in attended run 2, but
deleting one cannot be automated.

## Left for a person

- The Supabase organization cimiento-test-1 (example-org-test-1): deleted by a person;
  `supabase orgs list` no longer shows it on 2026-10-17 23:08 UTC.
- The Supabase integration on the Vercel team still has access to all projects on the team, and
  its connection between another project's database and the deleted cimiento-test-1 project lives on the Supabase side.
