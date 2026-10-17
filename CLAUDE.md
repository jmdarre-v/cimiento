# cimiento

This repository is the `cimiento` CLI itself: one command that takes a person from nothing to a
deployed, wired, verified project skeleton, and keeps that environment healthy afterwards.

The source of truth is `docs/SPEC.md`. Read it before changing anything. Goals and their
acceptance criteria live in `docs/GOALS.md`. Decisions that the spec does not cover are recorded
one line at a time in `docs/DECISIONS.md`.

## Stack

TypeScript strict, Node 22, pnpm, Vitest. No CLI framework beyond a small local prompt helper.
The bin is `cimiento`, with `cim` as a second entry.

## Layout

```
src/core/       engine, planner, executor, state, deferred values, errors, io
src/manifest/   zod schema, defaults, presets
src/providers/  github, vercel, supabase
src/wiring/     one file per provider pair
src/secrets/    sources and sinks
src/scaffold/   templates
src/cli/        commands, output modes
src/kb/         failure signatures, one yaml entry per error code
test/unit/      mocked CLIs and APIs
test/field/     real accounts, cimiento-test- prefix, always ends with cimiento down
```

## Rules

- Secrets go through `cimiento secret set NAME`. Never paste a key into chat, a file, a commit,
  a log line or `--json` output. Logs print `NAME=****`.
- `.env*` is gitignored and denied to Claude Code by `.claude/settings.json`.
- Every external call goes through `src/core/io.ts` so tests can record and replay.
- Every command works with `--json`. Every error is a `CimientoError` with a `hint`.
- `ensure` is idempotent: the second call with the same inputs returns `noop`.
- No em dashes in code comments, docs or output.
- Never create a real cloud resource outside a goal that explicitly says field test.
- Commit after every completed section with a conventional commit message.

## Commands

```
pnpm build
pnpm test
node dist/cli.js plan --json
node dist/cli.js doctor --json
```
