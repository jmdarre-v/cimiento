# Field test 3: cimiento-test-3 with the designer preset, unattended

Goal 3 in `docs/GOALS.md`: on the existing profile and its sessions,
`cd ~/Code.nosync && cimiento new cimiento-test-3 --preset designer --json --yes` with the built
`dist`, then the deployed page, `doctor` twice, `down --yes`, and confirmation with `gh` and
`vercel`. Timings come from the run logs in `~/.cimiento/runs/`; all times are UTC.

Status: complete. No step needed a browser.

## Result

| Step | Outcome |
|---|---|
| `cimiento new cimiento-test-3 --preset designer --json --yes` | Exit 0, no person step, no error. Created the private repo jmdarre-v/cimiento-test-3, the Vercel project linked to it on main, and the production deployment. `vercel.github-access` verified on its own: the Vercel GitHub app already sees new repositories (installation EXAMPLE-INSTALLATION) |
| Deployed page | https://cimiento-test-3.vercel.app answered 200 with the title cimiento-test-3, the `cimiento-project` meta tag, and the four design steps: export from Claude Design into design/exports, unzip into design/current, ask Claude Code to turn design/current into app/page.tsx, push to main |
| `doctor --json` twice | 13/13 ok both times; `plan --json` all 13 noop |
| `down --yes --json` | Exit 0: destroyed vercel.deployment, vercel.project and github.repo; no leftovers, no errors |
| Confirmation | `gh repo view jmdarre-v/cimiento-test-3`: Could not resolve to a Repository. `vercel project ls`: no cimiento-test-3. The page answered 200 once from Vercel's cache right after down, then 404 with x-vercel-error DEPLOYMENT_NOT_FOUND |

Checks, from the receipts:

| Check | Evidence |
|---|---|
| repo.linked | Vercel project linked to jmdarre-v/cimiento-test-3 on main |
| hosting.deployed | 200 from https://cimiento-test-3.vercel.app, with the scaffold marker |

## Timings per phase

From the first and last line of each run log.

| Phase | When (UTC) | Duration | Run log |
|---|---|---|---|
| Goal 3 implementation and unit tests | | not measured | no run log |
| `cimiento new cimiento-test-3 --preset designer --json --yes` | 10-17 23:05:16 to 23:06:31 | 74.9 s | 2026-10-17T23-05-16-489Z-new.jsonl |
| `doctor --json`, first | 23:06:51 to 23:07:03 | 12.2 s | 2026-10-17T23-06-51-439Z-doctor.jsonl |
| `doctor --json`, second | 23:07:03 to 23:07:15 | 11.3 s | 2026-10-17T23-07-03-806Z-doctor.jsonl |
| `plan --json` | 23:07:15 to 23:07:23 | 7.8 s | 2026-10-17T23-07-15-262Z-plan.jsonl |
| `down --yes --json` | 23:07:23 to 23:07:27 | 4.4 s | 2026-10-17T23-07-23-223Z-down.jsonl |
| Confirmation with gh, vercel and curl | | not measured | not a cimiento command |

## Bugs found in Goal 3

Ids continue from BUG-49 in `docs/FIELD-TEST-2.md`. None came from the field run itself; BUG-50
to 56 were found in review, from the Goal 3 close findings, and in the Linux and locale runs of
the tests, and BUG-57 in Goal 4. Fix commits up to f4589fa are in the private pre-release history;
the public history starts at 07d5c2b.

| Id | Description | Fix commit |
|---|---|---|
| BUG-50 | A fresh Mac account has no git identity, so the scaffold commit would fail unnoticed, and gh would push without a credential helper | 937fa51 |
| BUG-51 | Account choices listed Name and Plan as fields, though their pages have nothing to fill in | 10abc55 |
| BUG-52 | The GitHub step for Vercel named two pages, the Login Connections page and the GitHub app page, in one step | 10abc55 |
| BUG-53 | The walk printed Press Enter to open it in your browser twice, in the block and as the prompt | 10abc55 |
| BUG-54 | The plugin's new-project skill could not run cimiento new, so it could not start the person steps | 614454b |
| BUG-55 | Tests depended on the developer's locale: under a Spanish LANG, cimiento's output turned Spanish and the goal-2.test.ts BUG-42 test and twelve others failed | f4589fa |
| BUG-56 | The version lived in two places, the CLI source and package.json | f4589fa |
| BUG-57 | Found in Goal 4 by cimiento up in this repository: after the private repository was renamed and a new public one took its name, up kept the record as its own, and down would have deleted the public repository | 7393f81 |
