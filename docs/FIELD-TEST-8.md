# Field test 8: preview branches without cimiento up, the commit stamp, speed

Goal 8 in `docs/GOALS.md`, items 1 to 4, unattended, on the existing sessions, with the built
`dist` (`node dist/cli.js`, from `~/Code.nosync`). Timings come from the first and last line of
each run log in `~/.cimiento/runs/`; all times are UTC on 2026-10-18. Account identifiers are
left out.

Status: items 1 to 3 passed on real accounts; item 4, the Supabase preview project, is completed
by the owner's decision after the run stopped at Supabase's free limit. The field test found BUG-101 to 104, each fixed and proven on the same
project. Every resource is confirmed gone.

## Item 1: Neon preview branches without cimiento up, on cimiento-test-8

Vercel hosting, Neon database, GitHub repository, `options.vercel.deployment_protection: none` so
the preview route answers a plain request, and one declared secret `DEMO_TOKEN` (source env) for
item 2. The token was a random value in a temporary file, never printed, deleted afterwards.

| Step | Outcome |
|---|---|
| `new cimiento-test-8 --repo github --hosting vercel --database neon --template nextjs-app --scaffold-only`, then `up` | Exit 0. `neon.api-key` made an organization API key scoped to the project; `NEON_API_KEY` written to the Actions secrets and to the Vercel preview env only. The scaffold carried the preview database workflow, its script, `lib/neon-preview.mjs`, `lib/db.ts` and `app/api/cimiento/database` |
| `feature/login` pushed with plain git | The workflow ran and failed in 1 s: `NEON_API_KEY reaches 0 Neon projects`. A project scoped key gets 404 on `GET /projects` (not allowed outside its project) and can read only its project (BUG-102) |
| Fix: `NEON_PROJECT_ID` beside the key; files copied from a new scaffold, `up`, `publish` | Exit 0: `github.secret.NEON_PROJECT_ID` and `vercel.env.NEON_PROJECT_ID.preview` created |
| The preview answered `Protected by Vercel Authentication` | `deployment_protection: none` was never sent to Vercel (BUG-103). Fixed; `up` updated `vercel.project` and the preview answered plain requests |
| The preview route answered 503 with a minified `sql(...) is not a function` | Next.js compiled an awaited call used as a template tag into a call on the promise; reproduced locally with `next dev` against the real branch (BUG-104). Fixed; the same build answered `ok` locally against real Neon |
| Workflow disabled, `feature/two` pushed with plain git, its preview fetched at `/api/cimiento/database` | HTTP 503: `No Neon branch preview/feature-two for the preview of feature/two yet. The preview database workflow in GitHub Actions makes it on every push; reload once it has run. This preview never falls back to the production database.` |
| Workflow enabled, an empty commit pushed to `feature/two` | The workflow run printed `Created the Neon branch preview/feature-two.` |
| The same preview URL fetched again, built before the branch existed | HTTP 200: `source: preview branch`, `branch: preview/feature-two`, one baseline row. The Neon API puts the endpoint it reads on `preview/feature-two`, not on `main` |
| `git push origin --delete feature/two` | The delete run printed `Deleted the Neon branch preview/feature-two.`; the Neon API listed `main` and the two older test branches |
| `feature/early` and `feature/login` deleted the same way | Both delete runs succeeded; the Neon API listed only `main` |

## Item 2: the commit stamp, on Vercel (cimiento-test-8) and Netlify (cimiento-test-8n)

| Step | Outcome |
|---|---|
| Vercel: `publish`, then `secret set DEMO_TOKEN` with a new value, a CLI deploy with only `.cimiento/state.json` changed | The Vercel API shows the new deployment with `cimientoCommit` = HEAD. It also shows what the CLI itself records on every CLI deploy: `githubCommitSha` = HEAD and `gitDirty=1` when the tree had changes, which cimiento read as the commit even for a dirty upload (BUG-101) |
| Vercel: `publish` with only state changed | Exit 0: `commit done, push done, deploy skipped`, `live: { commit: <stamped HEAD>, source: cimiento stamp }` |
| Vercel: `publish` on a clean tree | Exit 0, `published: false`, `live: { commit: <stamped HEAD>, source: cimiento stamp }`: the stamp read back |
| Netlify: `new cimiento-test-8n --repo github --hosting netlify --template designer-site`, `up`, `publish`, `secret set DEMO_TOKEN` | Netlify builds every deploy from the repository; the rebuild after `secret set` records `commit_ref` = HEAD. No stamp is needed |
| Netlify: `publish` with only state changed, then on a clean tree | `deploy skipped`, then `published: false`, both with `live: { commit: <HEAD before the state commit>, source: git }` |

## Item 3: speed

The noop `up` asked `gh --version` eight times and each vendor login once per phase, and in a run
with no terminal built the plan twice (BUG-93).

| Stack | Before (0.4.0) | After |
|---|---|---|
| The cimiento repository itself, GitHub only | 8.2 s, 7.6 s, 7.8 s (2026-10-18T22-54-04-602Z-up.jsonl to 22-54-20-857Z) | 4.1 s with an empty machine cache, 3.5 s and 3.1 s with it (2026-10-18T23-05-42-796Z-up.jsonl to 23-05-50-707Z) |
| Vercel and Neon (cimiento-test-7 and cimiento-test-8) | 90.4 s, 87.9 s, 90.8 s (field test 7) | 51.6 s and 51.7 s (2026-10-18T23-27-46-897Z-up.jsonl, 23-28-38-798Z) |

The target, a noop `up` under 20 s on the cimiento repository, is met. On the Vercel and Neon
stack the rest is the plan (about 20 s) and the apply (about 30 s) reading live state: each
provider read, the env value compares and the Neon migration history over Postgres, about 4 s per
read. That is what `up` is for, so it stays.

## Item 4: the Supabase preview project

`node test/field/supabase-preview.mjs` at 2026-10-18T23:59 UTC printed:

```
status: blocked, activeFreeProjects: 2, reason: Supabase's free limit: 2 active free projects of
2, and this test needs 2 slots (the production project and the preview project).
```

Stopped as the goal allows: the two active free projects are in other organizations, and the test
never pauses or deletes a project it did not create. Nothing was created at Supabase. With two free
slots, or with `CIMIENTO_FIELD_SUPABASE_ORG` naming a paid organization the person chose, the same
script runs `cimiento-test-8s` up, checks the production and preview projects are separate, and
takes it down.

## Confirmation

- `gh repo view` for cimiento-test-8 and cimiento-test-8n: Could not resolve to a Repository.
- `vercel project ls`: no project named cimiento-test-8*; https://cimiento-test-8.vercel.app
  answers 404.
- Netlify API: no site named cimiento-test-8n; https://cimiento-test-8n.netlify.app answers 404.
- Neon API, in the organization the key was made in: no project named cimiento-test-8*, and the
  key for previews no longer listed among the organization's API keys (revoked by `down`).
- `supabase`: nothing was created.
- `~/.cimiento/locks`: empty.

## Timings per phase

From the first and last line of each run log.

| Phase | When (UTC) | Duration | Run log |
|---|---|---|---|
| Noop `up` on the cimiento repository, before, three runs | 22:54:04 to 22:54:28 | 8.2 s, 7.6 s, 7.8 s | 2026-10-18T22-54-04-602Z-up.jsonl to 2026-10-18T22-54-20-857Z-up.jsonl |
| Noop `up` on the cimiento repository, after, three runs | 23:05:42 to 23:05:53 | 4.1 s, 3.5 s, 3.1 s | 2026-10-18T23-05-42-796Z-up.jsonl to 2026-10-18T23-05-50-707Z-up.jsonl |
| `new --scaffold-only` cimiento-test-8 | 23:25:53 | under 0.1 s | 2026-10-18T23-25-53-953Z-new.jsonl |
| `up` cimiento-test-8 | 23:26:01 to 23:27:39 | 97.8 s | 2026-10-18T23-26-01-605Z-up.jsonl |
| Noop `up`, two runs | 23:27:46 to 23:29:30 | 51.6 s, 51.7 s | 2026-10-18T23-27-46-897Z-up.jsonl, 2026-10-18T23-28-38-798Z-up.jsonl |
| `publish` | 23:29:49 to 23:30:23 | 34.1 s | 2026-10-18T23-29-49-674Z-publish.jsonl |
| `secret set DEMO_TOKEN`, CLI deploy with the stamp | 23:30:24 to 23:31:11 | 47.3 s | 2026-10-18T23-30-24-019Z-secret-set.jsonl |
| `publish` with only state changed, then on a clean tree | 23:34:13 to 23:34:20 | 4.5 s, 2.0 s | 2026-10-18T23-34-13-567Z-publish.jsonl, 2026-10-18T23-34-18-207Z-publish.jsonl |
| `up` writing `NEON_PROJECT_ID` (BUG-102) | 23:38:54 to 23:39:56 | 61.5 s | 2026-10-18T23-38-54-736Z-up.jsonl |
| `publish` of the new workflow files | 23:40:02 to 23:40:36 | 33.8 s | 2026-10-18T23-40-02-474Z-publish.jsonl |
| `up` applying `deployment_protection: none` (BUG-103) | 23:44:58 to 23:45:57 | 59.5 s | 2026-10-18T23-44-58-366Z-up.jsonl |
| `publish` of the route fix (BUG-104) | 23:50:36 to 23:51:10 | 34.4 s | 2026-10-18T23-50-36-435Z-publish.jsonl |
| `new --scaffold-only` and `up` cimiento-test-8n | 23:53:46 to 23:55:17 | 90.6 s | 2026-10-18T23-53-46-788Z-up.jsonl |
| `publish` cimiento-test-8n | 23:55:26 to 23:56:17 | 51.4 s | 2026-10-18T23-55-26-565Z-publish.jsonl |
| `secret set DEMO_TOKEN`, Netlify rebuild | 23:56:18 to 23:57:07 | 49.8 s | 2026-10-18T23-56-18-155Z-secret-set.jsonl |
| `publish` with only state changed, then on a clean tree | 23:57:12 to 23:57:19 | 4.4 s, 2.3 s | 2026-10-18T23-57-12-971Z-publish.jsonl, 2026-10-18T23-57-17-561Z-publish.jsonl |
| `down` cimiento-test-8, then cimiento-test-8n | 23:57:27 to 23:57:41 | 9.5 s, 4.2 s | 2026-10-18T23-57-27-635Z-down.jsonl, 2026-10-18T23-57-37-255Z-down.jsonl |
| The preview database workflow runs in GitHub Actions | 23:34 to 23:53 | not measured by a run log; each finished within about 15 s of its push, per `gh run watch` | not a cimiento command |
| Scaffolds regenerated in a temporary folder to copy files and to build the app locally | 23:18 to 23:48 | under 0.1 s each | 2026-10-18T23-18-50-904Z-new.jsonl, 23-19-55-899Z, 23-38-54-424Z, 23-47-58-683Z |
| Supabase preview field test path | 23:59 | not measured by a run log | not a cimiento command |
| Implementation and unit tests | | not measured | no run log |
| Confirmation with gh, vercel and the Neon and Netlify APIs | | not measured | not a cimiento command |

## Bugs found in Goal 8

Ids continue from BUG-92 in `docs/FIELD-TEST-7.md`. Each has a knowledge base entry or `seen:`
note and a regression test in `test/unit/goal-8.test.ts` that failed on the code before its fix.
BUG-93 to 97, 99 and 100 came from the goal's list, found by those tests; BUG-98 came from building
a scaffolded project locally; BUG-101 to 104 came from this field test.

| Id | Description | Fix commit |
|---|---|---|
| BUG-93 | A noop up asked each tool and each login once per phase and, with no terminal, built the plan twice | 267d7a1 |
| BUG-94 | A branch pushed with plain git had no preview database until the next cimiento up | 59a7c43 |
| BUG-95 | Nothing outside cimiento up could make or find a preview branch with the same name cimiento uses | 59a7c43 |
| BUG-96 | The workflow and the previews needed a Neon key nobody had | 59a7c43 |
| BUG-97 | doctor failed a preview whose Neon branch the workflow made, because cimiento up had not written its address | 59a7c43 |
| BUG-98 | A project made from flags with a template got no workflows: scaffold.ci stayed false | 59a7c43 |
| BUG-99 | The commit stamp on Vercel CLI deploys never applied, because cimiento's own state made every tree dirty | 30a3954 |
| BUG-100 | publish waited for a deploy when HEAD only added cimiento state on top of the live commit | 30a3954 |
| BUG-101 | publish read the commit a Vercel CLI deploy names even when the deploy was marked gitDirty | f95945f |
| BUG-102 | A project scoped Neon key cannot list projects, so the preview workflow found none | 0b1d9d6 |
| BUG-103 | options.vercel.deployment_protection was never sent to Vercel | 8784d4b |
| BUG-104 | The preview route's awaited template tag was compiled by Next.js into a call on the promise | 1626ba1 |
