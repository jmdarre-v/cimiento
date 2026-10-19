# Field test 9: preview credentials, local secrets, cimiento upgrade

Goal 9 in `docs/GOALS.md`, items 1 to 3, unattended, on the existing sessions, with the built
`dist` (`node dist/cli.js`, from `~/Code.nosync`). Timings come from the first and last line of
each run log in `~/.cimiento/runs/`; all times are UTC on 2026-10-19. Account identifiers are
left out.

Status: items 2 and 3 passed. Item 1's guarantees passed on real Vercel and real Netlify: a
preview reads its own branch, no preview env holds a Neon key, and deleting the git branch removes
both the Neon branch and the address. The workflow writing the address itself needs a hosting
token only a person can make (BUG-112), so that part is proven by unit tests and stays blocked on
a real host; without the token `cimiento up` writes the address. The field test found BUG-112 and
BUG-113, both fixed and proven. Every resource is confirmed gone.

## Item 1 on Vercel, cimiento-test-9

Vercel hosting, Neon database, GitHub repository, `deployment_protection: none`.

| Step | Outcome |
|---|---|
| `new --scaffold-only`, then `up` | Exit 1: `vercel.api-token` was refused, `403 Cannot create tokens for this app`. Vercel does not let the CLI's own login make a token (BUG-112). Everything else was made; no `NEON_*` value in any Vercel environment; `NEON_API_KEY`, `NEON_PROJECT_ID`, `VERCEL_PROJECT_ID` and `VERCEL_TEAM_ID` in the Actions secrets only |
| Fix: the hosting token is an optional secret a person makes; `stack.yaml` changed to it, `up` | Exit 0; `github.secret.VERCEL_TOKEN` noop: `VERCEL_TOKEN is not set; it is optional` |
| `feature/nine` pushed with plain git | The workflow made `preview/feature-nine` and failed on the old script, which still required the token; the push preview answered HTTP 503 with the clear sentence and `neonKeyInEnv: false` |
| `cimiento upgrade` on main | Showed `replace .github/scripts/preview-database.mjs` and `replace lib/db.ts` (both unchanged since cimiento wrote them, by the baseline), applied, committed |
| Branch pushed again | The workflow run: `The Neon branch preview/feature-nine already exists.` and `No VERCEL_TOKEN Actions secret, so the address of feature/nine is written by the next cimiento up.` |
| `up`, then an empty commit to the branch | `neon.preview-branches` created the address for `feature/nine` only. The new preview answered `ok: true, branch: feature/nine, rows: 1, neonKeyInEnv: false`; the Neon API puts its endpoint on `preview/feature-nine`, not on main |
| `vercel env ls` | `DATABASE_URL` and `DATABASE_URL_UNPOOLED` for Production, Development and `Preview (feature/nine)` only; no `NEON_*` entry anywhere |
| `git push origin --delete feature/nine`, then `up` | The delete run: `Deleted the Neon branch preview/feature-nine.`; `up` removed the branch values: `vercel env ls` shows no `feature/nine` entry, the Neon API lists only main |

## Item 1 on Netlify, cimiento-test-9n

| Step | Outcome |
|---|---|
| `new --scaffold-only` with Netlify and Neon, `up`, `publish` | Exit 0; `NETLIFY_AUTH_TOKEN` declared optional; no Neon key in the site env |
| `feature/nine` pushed with plain git | The workflow made `preview/feature-nine` and said the address is written by the next `cimiento up` |
| `up` | `neon.preview-branches` wrote the branch context values for `feature/nine`; exit 1 only for `netlify.check.preview`, since Netlify builds a branch through a pull request |
| `gh pr create`, then the deploy preview's `/api/cimiento/database` | HTTP 200, `neonKeyInEnv: false`; the Neon API puts its endpoint on `preview/feature-nine`. Netlify applies a branch context value to that branch's deploy preview |
| PR closed with the branch deleted, then `up` | The delete run deleted the Neon branch; `up` removed the branch values; the site env lists `DATABASE_URL` and `DATABASE_URL_UNPOOLED` for dev and production only |

Netlify functions do not see `CONTEXT` or `BRANCH`, so the route reports `branch: null` there and
a deploy preview with no address would say `DATABASE_URL is not set` rather than the preview
sentence; it still never reaches production.

## Item 2: local secrets

| Step | Outcome |
|---|---|
| Leftovers before the goal | Six keychain accounts under service `cimiento` from earlier test projects (test-2, test-5b, test-8) and nine `.env.local` files the Vercel CLI wrote in test folders; removed, names only printed |
| `down` of cimiento-test-9 and cimiento-test-9n | Exit 0 each, with `local: { keychain: [NEON_API_KEY] }`: the project's keychain entry removed |
| A `.env.local` left in cimiento-test-9 | Written by `vercel link --yes`, which cimiento runs before a deploy and which pulls the development env (BUG-113); now recorded and removed by `down`. The one from this run was removed by hand |
| `security dump-keychain`, service `cimiento`, accounts starting `cimiento-test-` | None |

## Item 3: cimiento upgrade on a project scaffolded by cimiento 0.4.0 from npm

| Step | Outcome |
|---|---|
| `npm exec --package=cimiento@0.4.0 -- cimiento new upgrade040 --repo github --hosting vercel --database neon --template nextjs-app --scaffold-only`, `git init`, commit | No account touched |
| `upgrade --json` | `applied: false` and seven changes: `merge stack.yaml` (scaffold.ci true; declares NEON_API_KEY for ci; declares VERCEL_TOKEN), `add` the workflow, its two scripts, the route and `lib/db.ts`, `merge package.json` (adds `@neondatabase/serverless`). Nothing changed on disk |
| `upgrade --yes --json` | `applied: true, committed: true`; one commit, `chore: cimiento upgrade to 0.4.1` (the version before the bump) |
| `upgrade --json` again | No changes |
| `npm install`, `tsc --noEmit`, `next build` | Built, with the route `/api/cimiento/database` |

## Confirmation

- `gh repo view` for cimiento-test-9 and cimiento-test-9n: Could not resolve to a Repository.
- `vercel project ls`: no project named cimiento-test-9*; https://cimiento-test-9.vercel.app
  answers 404.
- Netlify API: no site named cimiento-test-9n; https://cimiento-test-9n.netlify.app answers 404.
- Neon API, in the organization the keys were made in: no project named cimiento-test-9*, and
  neither project scoped key is listed (both revoked by `down`).
- `security dump-keychain`: no account starting `cimiento-test-` under service `cimiento`.
- No `.env.local` in any cimiento-test folder; `~/.cimiento/locks` empty.

## Timings per phase

From the first and last line of each run log.

| Phase | When (UTC) | Duration | Run log |
|---|---|---|---|
| `new --scaffold-only` by cimiento 0.4.0, then `upgrade --json`, `upgrade --yes --json`, `upgrade --json` | 01:18:52 to 01:19:01 | under 0.1 s, under 0.1 s, 0.2 s, under 0.1 s | 2026-10-19T01-18-52-027Z-new.jsonl, 01-18-52-716Z-upgrade, 01-19-01-282Z-upgrade, 01-19-01-689Z-upgrade |
| `up` cimiento-test-9, refused token (BUG-112) | 01:21:03 to 01:22:49 | 106.1 s | 2026-10-19T01-21-03-020Z-up.jsonl |
| `up` with the optional token | 01:30:39 to 01:31:42 | 62.8 s | 2026-10-19T01-30-39-818Z-up.jsonl |
| `publish` | 01:31:53 to 01:32:28 | 34.7 s | 2026-10-19T01-31-53-567Z-publish.jsonl |
| `upgrade --json`, `upgrade --yes --json` on cimiento-test-9 | 01:34:14 to 01:34:15 | under 0.1 s, 0.2 s | 2026-10-19T01-34-14-880Z-upgrade.jsonl, 01-34-15-015Z-upgrade |
| `up` writing the branch address | 01:34:48 to 01:35:49 | 61.4 s | 2026-10-19T01-34-48-540Z-up.jsonl |
| `up` after the branch was deleted | 01:37:05 to 01:38:02 | 57.2 s | 2026-10-19T01-37-05-614Z-up.jsonl |
| `up` cimiento-test-9n | 01:39:51 to 01:41:58 | 126.7 s | 2026-10-19T01-39-51-711Z-up.jsonl |
| `publish` cimiento-test-9n | 01:41:58 to 01:42:44 | 45.5 s | 2026-10-19T01-41-58-565Z-publish.jsonl |
| `up` writing the branch context values | 01:43:13 to 01:44:50 | 97.6 s, exit 1 for the preview check before the pull request | 2026-10-19T01-43-13-243Z-up.jsonl |
| `up` after the branch was deleted | 01:46:25 to 01:47:14 | 49.2 s | 2026-10-19T01-46-25-746Z-up.jsonl |
| `down` cimiento-test-9, then cimiento-test-9n | 01:47:28 to 01:47:39 | 5.5 s, 5.3 s | 2026-10-19T01-47-28-357Z-down.jsonl, 01-47-34-025Z-down |
| Scaffolds in a temporary folder to build and to hash 0.4.1's files | 01:07 to 01:14 | under 0.1 s each | 2026-10-19T01-07-07-898Z-new.jsonl, 01-14-36-549Z-new |
| The preview database workflow runs in GitHub Actions | 01:33 to 01:47 | not measured by a run log; each finished within about 15 s of its push or delete, per `gh run watch` | not a cimiento command |
| Implementation and unit tests | | not measured | no run log |
| Confirmation with gh, vercel, the Neon and Netlify APIs and security | | not measured | not a cimiento command |

## Bugs found in Goal 9

Ids continue from BUG-104 in `docs/FIELD-TEST-8.md`. Each has a knowledge base entry or `seen:`
note and a regression test in `test/unit/goal-9.test.ts` that failed on the code before its fix.
BUG-105 to 111 came from the goal's list, found by those tests; BUG-112 and 113 came from this
field test.

| Id | Description | Fix commit |
|---|---|---|
| BUG-105 | 0.4.1 put NEON_API_KEY, which can read the production branch, in the preview env | ce5f993 |
| BUG-106 | Nothing wrote a branch's own address into the hosting env when the branch was pushed, or removed it with the branch | ce5f993 |
| BUG-107 | The app looked its database up at request time with a Neon key | ce5f993 |
| BUG-108 | down left the project's keychain entries and the .env.local env pull wrote | cd8e4b4 |
| BUG-109 | A project made by an older cimiento kept the old scaffold forever: up never adds scaffold files | 5bd11c7 |
| BUG-110 | A project made by 0.4.1 kept the Neon key in its previews after cimiento was updated | 5bd11c7 |
| BUG-111 | up never said that a project could be upgraded | 5bd11c7 |
| BUG-112 | Vercel refuses to make a token from the CLI's login, and Netlify has no API to make one, so the workflow's hosting token cannot be made unattended | fd7a4b5 |
| BUG-113 | The .env.local that vercel link writes when cimiento links the folder stayed after down | d73d92e |
