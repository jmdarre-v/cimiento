# Contributing

`docs/SPEC.md` is the source of truth; read it first. `docs/DECISIONS.md` records every choice
the spec does not cover, one line each, and `docs/GOALS.md` lists the goals that built the tool.

## Local setup

Node 22 and pnpm. Then:

```bash
pnpm install
```

```bash
pnpm build && pnpm test
```

The tests never reach a real account: every external call goes through `src/core/io.ts`, and the
tests pass a fake (`test/unit/fake-cloud.ts`, `test/unit/fake-v2.ts`) that keeps state like the
real providers do. To run the Neon migration tests against a real PostgreSQL, start one and point
`CIMIENTO_TEST_PG_URL` at it:

```bash
docker run -d --name cimiento-pg -e POSTGRES_PASSWORD=postgres -p 55432:5432 postgres:16
```

```bash
CIMIENTO_TEST_PG_URL=postgres://postgres:postgres@127.0.0.1:55432/postgres pnpm test
```

Run the built CLI from the repository with `node dist/cli.js`, for example
`node dist/cli.js plan --json` inside a project.

## Architecture map

| Path | What lives there |
|---|---|
| `src/cli/` | Commands (`commands/*.ts`), argument parsing, output modes, English and Spanish text |
| `src/core/executor.ts` | Applies a plan: ensure, verify, checkpoint state after each step |
| `src/core/planner.ts` | Builds a plan from `stack.yaml`, state and a read only look at reality |
| `src/core/state.ts` | `.cimiento/state.json`: ids, outputs and the spec of each resource, written atomically |
| `src/core/lock.ts` | One run per project at a time |
| `src/core/io.ts` | Every command, HTTP request and SQL query cimiento makes |
| `src/core/orphans.ts` | Resources in state that `stack.yaml` no longer selects |
| `src/manifest/` | The `stack.yaml` schema, presets and account pins |
| `src/providers/<id>/` | One provider each: GitHub, Vercel, Netlify, Supabase, Neon, Inngest, Turnstile, Resend, Stripe, PostHog, Anthropic |
| `src/wiring/` | Rules that connect two providers, one file per pair |
| `src/secrets/` | Secret sources (prompt, env, keychain, 1Password) and sinks |
| `src/scaffold/` | The project templates |
| `src/kb/` | The knowledge base: one entry per error code, the source of `docs/TROUBLESHOOTING.md` |
| `plugin/` | The Claude Code plugin |
| `scripts/install.sh` | The installer for macOS and Ubuntu |

## A provider, in outline

A provider fills one or more slots and implements the `Provider` interface in
`src/core/types.ts`. A minimal one that only checks a key, as Resend does, is a call to
`createKeyedProvider` in `src/providers/keyed.ts`:

```ts
export function createExampleProvider(): Provider {
  return createKeyedProvider({
    id: 'example',
    vendor: 'Example',
    slot: 'email',
    secrets: ['EXAMPLE_API_KEY'],
    check: 'example.check.key',
    explain: { 'example.check.key': { en: 'A probe that Example accepts the key.', es: 'Una prueba de que Example acepta la clave.' } },
    // Reads only: plan, doctor and up run this.
    async inspect(spec, ctx, keys) {
      const res = await ctx.io.http({ method: 'GET', url: 'https://api.example.test/me', headers: { authorization: `Bearer ${keys.EXAMPLE_API_KEY}` } })
      return res.ok ? { ok: true, evidence: 'EXAMPLE_API_KEY=**** accepted' } : keyRefused('example', 'EXAMPLE_KEY_INVALID', spec, 'EXAMPLE_API_KEY', 'Example', res.status, 'https://example.test/keys')
    },
    // Acts on the outside world: only under --smoke, after smokeEffect says what it does.
    smokeEffect: () => 'sends one test message to Example',
    async verify(spec, ctx, keys) {
      return { ok: true, evidence: 'sent one test message' }
    },
  })
}
```

Then register it in `src/registry.ts`, allow it in the slot in `src/manifest/schema.ts`, and add
a wiring rule in `src/wiring/` if its values go to the hosting env. A provider that creates
resources also implements `ensure` (idempotent: the second call returns `noop`), `destroy`, and
`presence`, which looks the resource up by the id state recorded and answers absent only on an
authenticated not found.

## What a change needs

- A test. A bug fix comes with a regression test that fails on the code before the fix; say so
  in the commit message. New behavior comes with tests on the fake cloud, and `ensure` twice must
  return `noop`.
- Every error is a `CimientoError` with a `hint` that says the next thing to do, and every error
  code has a knowledge base entry in `src/kb/*.yaml` and an explanation in English and Spanish.
  `node scripts/troubleshooting.mjs` regenerates `docs/TROUBLESHOOTING.md`, and a test fails when
  it is out of date.
- Every command works with `--json`, and `plan` and `doctor` stay passive: no POST, PUT, PATCH or
  DELETE unless `--smoke`.
- A person step names the full link, the clicks, each field and value, the button and what
  success looks like, in English and Spanish (`src/core/person-steps*.ts`).
- No secret value in code, tests, logs or output; tests use obviously fake values.
- No em dashes in code comments, docs or output, and no `#` inline comments in shell examples.
- Conventional commit messages.

Field tests against real accounts are run by the maintainer before a release, with resources
named `cimiento-test-<n>` and `cimiento down` at the end; they never run in CI.
