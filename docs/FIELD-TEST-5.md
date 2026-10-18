# Field test 5: v2 on the existing sessions, unattended

Goal 5 in `docs/GOALS.md`, item 4, on the profile cimiento already runs on, with the built `dist`
(`node dist/cli.js`, run from `~/Code.nosync`). Timings come from the first and last line of each
run log in `~/.cimiento/runs/`; all times are UTC on 2026-10-18. Identifiers that belong to the
accounts (team, project, deployment and site ids, the domain) are written as placeholders.

Status: a passed; b blocked on a person (Neon login and four keys); c blocked on one DNS record.
Every project was taken down and confirmed gone with each provider.

## a) cimiento-test-5, designer preset, on Vercel

| Step | Outcome |
|---|---|
| `cimiento new cimiento-test-5 --preset designer --json --yes` | Exit 0, no person step. Repo, Vercel project linked on main, production deployment; every check passed, hosting.preview said there was no branch besides main yet |
| Title changed in app/page.tsx, `cimiento publish` | Exit 0. https://cimiento-test-5.vercel.app served the new title |
| Branch preview-check pushed | hosting.preview failed while the preview built (HOSTING_PREVIEW_NOT_READY, state building), then passed: preview ready for preview-check |
| CIMIENTO_TEST_SECRET declared with sinks hosting and ci, source env | `secret set` exit 0 to github.secret and vercel.env preview and production; `secret check` all present; `secret rotate` with a second fake value updated all three; `secret check` all present. gh secret list showed the Actions secret updated at the rotate. No fake value appears in any output or run log |
| `cimiento dev` | The local page answered 200 after 17 s and again 30 s later (curl probe); one Ctrl+C stopped everything |
| Clone into a second folder, `cimiento join` | First run exit 1 (BUG-63): the stack.yaml change was not pushed, and vercel.deployment was stale after the rotate. After the fix, rotate with a third fake value deployed again by itself, and `join` on a fresh clone passed 18 of 18 with nothing in between |
| `doctor --json` twice | 18/18 ok both times |

## b) cimiento-test-5b: netlify, neon, resend, stripe, posthog

| Step | Outcome |
|---|---|
| `cimiento new cimiento-test-5b --repo github --hosting netlify --database neon --email resend --payments stripe --analytics posthog --template nextjs-app --json --yes` | Exit 2. Installed the Netlify CLI and neonctl with npm. This Mac already had a Netlify login, so the Netlify part ran for real: the site was created in the only team (pinned in accounts.netlify), linked to the new repository with a read only deploy key and a webhook to the site's deploy hook, and NEXT_PUBLIC_POSTHOG_HOST written to dev, deploy-preview, branch-deploy and production. Waiting on a person: neon.session, and the four keys RESEND_API_KEY, STRIPE_SECRET_KEY, NEXT_PUBLIC_STRIPE_PUBLISHABLE_KEY and NEXT_PUBLIC_POSTHOG_KEY (no account or key for Resend or PostHog on this machine; Stripe keys only reach cimiento through a person and secret set) |
| `doctor --json` twice | 15/39 ok both times; everything else waits on neon.session or a key |
| `down --yes --json`, then `plan --json` | Down destroyed the Netlify site and the repository. Plan in the folder: 3 create, 6 noop, 30 blocked on the person steps, which is what an attended `cimiento up` there picks up |

Netlify had no real deploy in b, so a small extra project, **cimiento-test-5c** (designer preset on
Netlify), was created to prove deploy, publish, preview and the Netlify env on a real account
before the attended run of b. It was taken down like the others.

| Step | Outcome |
|---|---|
| `cimiento new cimiento-test-5c --preset designer --hosting netlify --json --yes` | Exit 1 (BUG-61): the deploy was ready, but https://cimiento-test-5c.netlify.app answered 404, because the raw .next folder was published without the Next.js runtime |
| `cimiento up` after the fix | Exit 0: the link added @netlify/plugin-nextjs, the deployment built again because the build settings changed, and the page answered 200 with the scaffold marker |
| Title changed, `cimiento publish` | Exit 0, the new title live on https://cimiento-test-5c.netlify.app |
| Branch pushed with a pull request | hosting.preview building, then ready at the pull request's deploy preview |
| CIMIENTO_TEST_SECRET with sinks hosting and ci | set, check, rotate, check and remove all exit 0, on netlify.env preview and production and github.secret (BUG-62 found in the rotate note) |
| `doctor --json` twice | 13/13 ok both times |

## c) Custom domain on cimiento-test-5

`vercel domains ls` lists one domain, with Third Party nameservers, so its DNS lives outside
Vercel.

| Step | Outcome |
|---|---|
| `cimiento domain add cimiento-test.<domain> --json` | Exit 2: the subdomain was added to the Vercel project (verified, no TXT challenge), and HOSTING_DOMAIN_DNS_NEEDED named the record. The first run named cname.vercel-dns.com; Vercel's domain config recommends a project specific CNAME first (BUG-64). After the fix: CNAME cimiento-test <project-specific>.vercel-dns-016.com |
| `cimiento domain remove --json` | Exit 0: the domain is off the project (the project domains API lists only cimiento-test-5.vercel.app) and stack.yaml says domain: null |

Serving the domain needs that one CNAME at the outside DNS provider, which is a person step.

## Windows via WSL

WSL cannot run on this Mac, so the Ubuntu path of install.sh was proved in an ubuntu:24.04
container as a user with sudo: the first real run installed the apt packages, Homebrew, node 22,
pnpm, gh, vercel, supabase, Claude Code and cimiento, and ended with the table and exit 0; the
second run found everything already there. The WSL branch (detected from /proc/version) differs
only in two sentences, covered by the unit tests.

## Teardown and confirmation

| Project | `down --yes --json` | Confirmation |
|---|---|---|
| cimiento-test-5 | Exit 0: vercel.deployment, vercel.project, github.repo | `gh repo view`: Could not resolve to a Repository. `vercel project ls`: no cimiento-test-5 |
| cimiento-test-5c | Exit 0: netlify.deployment, netlify.project, github.repo | `gh repo view`: Could not resolve. Netlify API sites?name=cimiento-test-5c: none |
| cimiento-test-5b | Exit 0: netlify.project, github.repo | `gh repo view`: Could not resolve. Netlify API sites?name=cimiento-test-5b: none. Neon: nothing was created; neon.project never reached state because neon.session stayed pending |

Deploy keys, webhooks, the pull request and the Actions secret went with the repositories; env
values went with the Vercel project and Netlify sites. No leftovers were reported.

## Timings per phase

From the first and last line of each run log.

| Phase | When (UTC) | Duration | Run log |
|---|---|---|---|
| install.sh, Ubuntu 24.04 container, first run | 02:11:26 to 02:14:22 | 176 s | 2026-10-18T02-11-26Z-install.jsonl (container) |
| install.sh, Ubuntu 24.04 container, second run | 02:14:23 to 02:14:24 | 1 s | 2026-10-18T02-14-22Z-install.jsonl (container) |
| a: `new cimiento-test-5` | 02:14:53 to 02:16:08 | 74.5 s | 2026-10-18T02-14-53-656Z-new.jsonl |
| a: `publish` | 02:16:20 to 02:16:52 | 32.7 s | 2026-10-18T02-16-20-153Z-publish.jsonl |
| a: `doctor --only vercel`, preview building | 02:17:18 to 02:17:29 | 11.1 s | 2026-10-18T02-17-18-461Z-doctor.jsonl |
| a: `doctor --only vercel`, preview ready | 02:17:44 to 02:17:55 | 10.8 s | 2026-10-18T02-17-44-820Z-doctor.jsonl |
| a: `secret set` | 02:18:06 to 02:18:21 | 15.6 s | 2026-10-18T02-18-06-132Z-secret-set.jsonl |
| a: `secret check` | 02:18:21 to 02:18:28 | 7.0 s | 2026-10-18T02-18-21-887Z-secret-check.jsonl |
| a: `secret rotate` | 02:18:38 to 02:18:42 | 3.4 s | 2026-10-18T02-18-38-817Z-secret-rotate.jsonl |
| a: `secret check` | 02:18:42 to 02:18:50 | 8.3 s | 2026-10-18T02-18-42-310Z-secret-check.jsonl |
| a: `dev` | 02:19:00 to 02:19:47 | 46.8 s | 2026-10-18T02-19-00-408Z-dev.jsonl |
| a: `join`, exit 1 (BUG-63) | 02:20:02 to 02:20:23 | 21.3 s | 2026-10-18T02-20-02-272Z-join.jsonl |
| a: `publish` of the declaration | 02:20:49 to 02:21:28 | 38.5 s | 2026-10-18T02-20-49-862Z-publish.jsonl |
| a: `join` | 02:21:30 to 02:21:54 | 23.9 s | 2026-10-18T02-21-30-902Z-join.jsonl |
| b: `new cimiento-test-5b`, exit 2 | 02:23:39 to 02:25:46 | 127.6 s | 2026-10-18T02-23-39-242Z-new.jsonl |
| 5c: `new cimiento-test-5c`, exit 1 (BUG-61) | 02:26:26 to 02:27:48 | 82.7 s | 2026-10-18T02-26-26-151Z-new.jsonl |
| 5c: `up` after the fix | 02:29:42 to 02:30:59 | 76.8 s | 2026-10-18T02-29-42-255Z-up.jsonl |
| 5c: `publish` | 02:32:00 to 02:32:46 | 46.3 s | 2026-10-18T02-32-00-498Z-publish.jsonl |
| 5c: `doctor --only netlify`, preview building | 02:33:10 to 02:33:21 | 11.0 s | 2026-10-18T02-33-10-616Z-doctor.jsonl |
| 5c: `doctor --only netlify`, preview ready | 02:33:36 to 02:33:47 | 10.5 s | 2026-10-18T02-33-36-911Z-doctor.jsonl |
| 5c: `secret set`, check, rotate, check, remove | 02:34:01 to 02:34:39 | 13.5 s, 7.1 s, 5.1 s, 8.1 s, 4.3 s | 2026-10-18T02-34-01-055Z-secret-set.jsonl to 2026-10-18T02-34-35-589Z-secret-remove.jsonl |
| a: `secret rotate` with the BUG-63 fix, deploys again | 02:44:40 to 02:45:17 | 36.5 s | 2026-10-18T02-44-40-538Z-secret-rotate.jsonl |
| a: `join` on a fresh clone | 02:45:19 to 02:45:44 | 24.5 s | 2026-10-18T02-45-19-642Z-join.jsonl |
| c: `domain add`, exit 2, before BUG-64 | 02:46:17 to 02:46:37 | 20.2 s | 2026-10-18T02-46-17-290Z-domain-add.jsonl |
| c: `domain add`, exit 2, after BUG-64 | 02:48:53 to 02:49:15 | 21.6 s | 2026-10-18T02-48-53-809Z-domain-add.jsonl |
| c: `domain remove` | 02:49:15 to 02:49:17 | 1.8 s | 2026-10-18T02-49-15-629Z-domain-remove.jsonl |
| `doctor` twice, cimiento-test-5 | 02:49:31 to 02:50:02 | 15.7 s and 15.3 s | 2026-10-18T02-49-31-365Z-doctor.jsonl, 2026-10-18T02-49-47-311Z-doctor.jsonl |
| `doctor` twice, cimiento-test-5c | 02:50:02 to 02:50:30 | 15.6 s and 12.2 s | 2026-10-18T02-50-02-735Z-doctor.jsonl, 2026-10-18T02-50-18-598Z-doctor.jsonl |
| `doctor` twice, cimiento-test-5b | 02:50:31 to 02:51:12 | 21.6 s and 19.9 s | 2026-10-18T02-50-31-034Z-doctor.jsonl, 2026-10-18T02-50-52-856Z-doctor.jsonl |
| `down`, cimiento-test-5, 5c, 5b | 02:51:24 to 02:51:39 | 5.2 s, 5.2 s, 4.2 s | 2026-10-18T02-51-24-431Z-down.jsonl, 2026-10-18T02-51-29-826Z-down.jsonl, 2026-10-18T02-51-35-245Z-down.jsonl |
| b: `plan` after down | 02:52:21 to 02:52:30 | 8.6 s | 2026-10-18T02-52-21-647Z-plan.jsonl |
| Implementation, unit tests, fixes | | not measured | no run log |
| Confirmation with gh, vercel and the Netlify API | | not measured | not a cimiento command |

## Bugs found in Goal 5

Ids continue from BUG-57 in `docs/FIELD-TEST-3.md`. Each has a knowledge base entry or `seen:` note
and a regression test: BUG-58 and 59 in `test/unit/install-script.test.ts`, BUG-60 to 64 and 66 to 69 in
`test/unit/goal-5-field.test.ts` (BUG-63 also in `test/unit/goal-2.test.ts`), BUG-65 in
`test/unit/install-script.test.ts`.

| Id | Description | Fix commit |
|---|---|---|
| BUG-58 | install.sh --dry-run still ran curl to fetch the Homebrew installer, because the command substitution ran before the dry-run check | 4654633 |
| BUG-59 | install.sh --dry-run ended with a table saying installed for everything it would only install | 4654633 |
| BUG-60 | The scaffold .gitignore did not list next-env.d.ts, so the first publish after cimiento dev committed it | 228c8c7 |
| BUG-61 | A Next.js site on Netlify answered 404: the link did not set the Next.js runtime (@netlify/plugin-nextjs), so Netlify published the raw .next folder | 33a6649 |
| BUG-62 | secret rotate on a Netlify project said Vercel reads env when it builds | f120fac |
| BUG-63 | secret set and rotate wrote the hosting env but did not deploy again, so the live app kept the old value and a fresh join failed vercel.deployment | 4d59548 |
| BUG-64 | The DNS step named cname.vercel-dns.com while Vercel recommends a project specific CNAME first, and could not name a TXT challenge | 4c88d5c |
| BUG-65 | The first CI run failed on ubuntu-latest: the installer tests used the machine's /usr/bin, where the GitHub runner has gh, so gh counted as already installed | e721e4d |
| BUG-66 | In the attended up of cimiento-test-5b (Neon on Netlify), up asked where the Supabase database should go and offered a Supabase configuration serving another project, because stack.yaml still had accounts.supabase via-hosting | aea037f |
| BUG-67 | After the Neon sign-up and login in that run, neon.project failed with NEON_TOKEN_MISSING: neonctl now keeps its login in ~/.config/neon, and cimiento only read ~/.config/neonctl | aea037f |
| BUG-68 | In the attended up of cimiento-test-5b, gh repo create made the repository but failed to add the origin remote the folder kept after down, so nothing was pushed and the Netlify link and deploy were skipped | 509edf7 |
| BUG-69 | The same run opened the Stripe keys page twice, once per key, and asked about a Stripe account twice | 509edf7 |

## Left for a person

Until 0.2.0 is on npm, the attended commands run the built CLI from the repository
(`node ~/Code.nosync/cimiento/dist/cli.js`, written `cim5` below); after the release,
`npm install -g cimiento@latest` and plain `cimiento` do the same.

- b, in a terminal: `cd ~/Code.nosync/cimiento-test-5b`, then `cim5 up`. It walks the Neon sign-up
  and login, then the page of each key with a hidden prompt (Resend, Stripe in a sandbox or test
  mode, PostHog), creates the repository, site and database again, and deploys. Then `cim5 doctor`
  twice and `cim5 down --yes`.
- c: `cd ~/Code.nosync/cimiento-test-5`, then `up --yes` with `CIMIENTO_TEST_SECRET` set to any
  fake value (stack.yaml still declares it with source env), which recreates the repository,
  project and deployment. Then `cim5 domain add cimiento-test.<domain>`, which prints the CNAME
  Vercel recommends for the new project (it is project specific, so it differs from the one above).
  Add that CNAME where the domain's DNS is managed, run `cim5 domain add cimiento-test.<domain>`
  again until the check passes and the domain serves, then `cim5 domain remove` and
  `cim5 down --yes`.
