// Neon migrations against a real PostgreSQL (Goal 6, item 14). CI starts a postgres service on the
// Linux runner and sets CIMIENTO_TEST_PG_URL; there, a missing URL fails the run instead of
// skipping it, so the job cannot go green without the database. Locally: run postgres in Docker
// and set the URL, or the test is skipped.

import { describe, expect, it } from 'vitest'
import { RealIo } from '../../src/core/io'
import { applyMigrations, migrationHistory } from '../../src/providers/neon'

const URL = process.env.CIMIENTO_TEST_PG_URL
const REQUIRED = Boolean(process.env.CI) && process.platform === 'linux'
const spec = { id: 'neon.migrations', kind: 'resource' as const, provider: 'neon', dependsOn: [], inputs: {} }

describe('Neon migrations on a real PostgreSQL', () => {
  it('the database URL is there when CI says it should be', () => {
    if (REQUIRED) expect(URL, 'CIMIENTO_TEST_PG_URL is not set on the Linux CI runner').toBeTruthy()
  })

  it.skipIf(!URL)('applies a dollar quoted function and a trigger whole, records them, and a second run applies nothing', async () => {
    const io = new RealIo()
    const schema = `t${Date.now()}`
    await io.sql(URL!, `drop table if exists public.cimiento_migrations; drop schema if exists ${schema} cascade; create schema ${schema}`)
    const files = [
      { name: '0001_baseline.sql', sql: `create table ${schema}.items (id int primary key, updated_at timestamptz);\n-- a comment; with a semicolon\n` },
      {
        name: '0002_touch.sql',
        sql: `create or replace function ${schema}.touch() returns trigger as $$
begin
  new.updated_at = now();
  return new;
end;
$$ language plpgsql;
create trigger touch before insert on ${schema}.items for each row execute function ${schema}.touch();`,
      },
    ]
    expect((await migrationHistory(io, URL!)).state).toBe('missing')
    const first = await applyMigrations(io, URL!, files, spec)
    expect(first.applied).toEqual(['0001_baseline.sql', '0002_touch.sql'])
    const insert = await io.sql(URL!, `insert into ${schema}.items (id) values (1) returning updated_at`)
    expect(insert.ok, insert.error?.message).toBe(true)
    expect(insert.rows[0].updated_at).not.toBeNull()
    const second = await applyMigrations(io, URL!, files, spec)
    expect(second.applied).toEqual([])
  })

  it.skipIf(!URL)('a failing file leaves no table and no record behind', async () => {
    const io = new RealIo()
    const schema = `f${Date.now()}`
    await io.sql(URL!, `drop table if exists public.cimiento_migrations; create schema ${schema}`)
    const files = [{ name: '0001_broken.sql', sql: `create table ${schema}.half (id int);\nthis is not sql;` }]
    await expect(applyMigrations(io, URL!, files, spec)).rejects.toMatchObject({ code: 'NEON_MIGRATION_FAILED' })
    const table = await io.sql(URL!, `select to_regclass('${schema}.half') as t`)
    expect(table.rows[0].t).toBeNull()
    const history = await migrationHistory(io, URL!)
    expect(history.state === 'ok' ? history.names : []).toEqual([])
  })

  it.skipIf(!URL)('a history table this role cannot read is unreadable, not missing', async () => {
    const io = new RealIo()
    await io.sql(URL!, `drop table if exists public.cimiento_migrations; create table public.cimiento_migrations (name text primary key, applied_at timestamptz default now());
      do $$ begin if not exists (select from pg_roles where rolname = 'cimiento_reader') then create role cimiento_reader login password 'fake-reader-not-a-secret'; end if; end $$;
      revoke all on public.cimiento_migrations from cimiento_reader`)
    const reader = URL!.replace(/\/\/[^@]+@/, '//cimiento_reader:fake-reader-not-a-secret@')
    const history = await migrationHistory(io, reader)
    expect(history.state).toBe('unreadable')
  })
})
