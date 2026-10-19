// Neon provider. Fills the database slot with serverless Postgres. neonctl owns the login, the Neon
// API owns projects, and migrations and checks run through a Postgres client (io.sql), which
// sends each file whole. The pooled and direct connection strings are secret outputs that
// the hosting + neon wiring rule writes into the hosting env.

import { readdirSync, readFileSync, existsSync } from 'node:fs'
import { join } from 'node:path'
import { CimientoError } from '../../core/errors'
import { recordedId } from '../../core/identity'
import { neonLoginStep, neonOrganizationStep, neonSignupStep } from '../../core/person-steps-v2'
import { sameResource, type ProjectState } from '../../core/state'
import { baseResources, ensureTool, ensureVendorSession, findTool, runVendorLogin, sessionCheck, verifyTool, toolVersion } from '../../core/toolkit'
import { presenceFromStatus, type Presence } from '../../core/types'
import type { CheckResult, Ctx, Detection, EnsureResult, Lang, Output, Provider, ResourceSpec, Session, Slot, ToolSpec, Value } from '../../core/types'
import { chooseAndPin } from '../../manifest/pin'
import type { Manifest } from '../../manifest/schema'
import { BASELINE_TABLE } from '../../scaffold/templates/nextjs-app'
import { neonCall, neonError } from './api'
import { apiKeyPresence, destroyApiKey, ensureApiKey, verifyApiKey } from './key'
import { destroyPreviewBranches, ensurePreviewBranches, previewBranchesPresence, verifyPreviewBranches } from './preview'
import type { Io } from '../../core/io'

const ID = 'neon'

const TOOLS: ToolSpec[] = [
  { name: 'Neon CLI', bin: 'neonctl', versionRange: '>=2.0.0', install: { npm: 'neonctl' }, versionCmd: 'neonctl --version' },
]

const LOGIN_HINT = 'cimiento up opens the Neon login in your browser and waits while you approve it.'
const MIGRATIONS_TABLE = 'cimiento_migrations'

interface NeonProject {
  id: string
  name: string
  region_id?: string
  org_id?: string
  created_at?: string
}

const EXPLAIN: Record<string, { en: string; es?: string }> = {
  'neon.tool.neonctl': {
    en: 'The Neon command line tool, neonctl. cimiento uses it to log you in to Neon, and reads that login to create the database and its branches.',
    es: 'La herramienta de linea de comandos de Neon, neonctl. cimiento la usa para iniciar tu sesion en Neon y lee esa sesion para crear la base de datos y sus ramas.',
  },
  'neon.session': {
    en: 'Your Neon login on this machine, through neonctl. cimiento uses it to create the database and read its connection details.',
    es: 'Tu sesion de Neon en esta maquina, con neonctl. cimiento la usa para crear la base de datos y leer sus datos de conexion.',
  },
  'neon.project': {
    en: 'The Neon project that holds this app\'s Postgres database. Free plan projects sleep when idle and wake on the first query.',
    es: 'El proyecto de Neon que guarda la base de datos Postgres de esta app. En el plan Free duerme cuando no se usa y despierta con la primera consulta.',
  },
  'neon.migrations': {
    en: 'The SQL files in the migrations folder, applied in order, each once. cimiento records what it applied in a table called cimiento_migrations.',
    es: 'Los archivos SQL de la carpeta de migraciones, aplicados en orden, cada uno una vez. cimiento anota lo aplicado en una tabla llamada cimiento_migrations.',
  },
  'neon.check.migrated': {
    en: 'A probe that migrations reach the database: cimiento queries the baseline table the first migration created.',
    es: 'Una prueba de que las migraciones llegan a la base de datos: cimiento consulta la tabla base que creo la primera migracion.',
  },
  NEON_TOKEN_MISSING: {
    en: 'cimiento could not find your Neon login. Run cimiento up in a terminal; it opens the Neon login in your browser.',
    es: 'cimiento no encontro tu sesion de Neon. Ejecuta cimiento up en una terminal; abre el inicio de sesion de Neon en tu navegador.',
  },
  NEON_API_ERROR: {
    en: 'Neon refused or failed a request. The message says which one; most of the time running cimiento up again is enough.',
    es: 'Neon rechazo o fallo una solicitud. El mensaje dice cual; casi siempre basta con ejecutar cimiento up de nuevo.',
  },
  NEON_PROJECT_LIMIT: {
    en: 'Your Neon organization has as many projects as its plan allows. Delete one you no longer need in the Neon console, then run cimiento up again.',
    es: 'Tu organizacion de Neon tiene tantos proyectos como permite su plan. Borra uno que ya no uses en la consola de Neon y vuelve a ejecutar cimiento up.',
  },
  NEON_MIGRATION_HISTORY_UNREADABLE: {
    en: 'The table where cimiento records applied migrations exists but this database role cannot read it, so nothing was applied. Give the role read access to public.cimiento_migrations and run cimiento up again.',
    es: 'La tabla donde cimiento anota las migraciones aplicadas existe pero este rol no puede leerla, asi que no se aplico nada. Da al rol acceso de lectura a public.cimiento_migrations y vuelve a ejecutar cimiento up.',
  },
  NEON_MIGRATION_FAILED: {
    en: 'A migration file did not run on the Neon database. The message has the Postgres error; fix the SQL file and run cimiento up again.',
    es: 'Un archivo de migracion no se ejecuto en la base de datos de Neon. El mensaje tiene el error de Postgres; corrige el archivo SQL y vuelve a ejecutar cimiento up.',
  },
}

function str(value: Value | undefined): string {
  return typeof value === 'string' ? value : ''
}

export function createNeonProvider(_m?: Manifest): Provider {
  const provider: Provider = {
    id: ID,
    fills: ['database'] as Slot[],
    tools: TOOLS,
    needsSession: true,

    async detect(ctx: Ctx): Promise<Detection> {
      const version = await toolVersion(ctx, TOOLS.find((t) => t.bin === 'neonctl')!)
      if (!version) return { installed: false }
      // neonctl me refreshes an expired token on the way, so a session from last week still counts.
      const me = await ctx.io.exec('neonctl', ['me', '--output', 'json']).catch(() => undefined)
      if (!me || me.code !== 0) return { installed: true, version }
      try {
        const parsed = JSON.parse(me.stdout) as { email?: string; login?: string; name?: string }
        const account = parsed.email ?? parsed.login ?? parsed.name
        return account ? { installed: true, version, session: { account } } : { installed: true, version }
      } catch {
        return { installed: true, version }
      }
    },

    async login(ctx: Ctx): Promise<Session> {
      await runVendorLogin(ctx, ID, 'Neon', 'neonctl', ['auth'], neonLoginStep())
      const detection = await provider.detect(ctx)
      if (!detection.session) {
        throw new CimientoError({
          code: 'SESSION_LOGIN_FAILED',
          provider: ID,
          resource: 'neon.session',
          message: 'The Neon login finished but neonctl me still reports no account.',
          hint: 'Run cimiento up again. It reopens the Neon login, and nothing was left half done.',
          retryable: true,
          needsHuman: true,
        })
      }
      return detection.session
    },

    resources(manifest: Manifest, _state: ProjectState): ResourceSpec[] {
      if (manifest.slots.database !== ID) return []
      const specs = baseResources({ id: ID, tools: TOOLS, needsSession: true })
      const projectId: Value = { deferred: 'neon.project:projectId' }
      specs.push({
        id: 'neon.project',
        kind: 'resource',
        provider: ID,
        dependsOn: ['neon.session'],
        inputs: { name: manifest.slug, region: manifest.options.neon.region, pgVersion: String(manifest.options.neon.pg_version) },
      })
      specs.push({
        id: 'neon.migrations',
        kind: 'resource',
        provider: ID,
        dependsOn: ['neon.project'],
        inputs: { projectId, dir: manifest.options.neon.migrations },
      })
      specs.push({ id: 'neon.check.migrated', kind: 'check', provider: ID, dependsOn: ['neon.migrations'], inputs: { projectId } })
      return specs
    },

    async ensure(spec: ResourceSpec, ctx: Ctx): Promise<EnsureResult> {
      if (spec.kind === 'check' || spec.kind === 'manual') return { action: 'noop' }
      if (spec.kind === 'tool') {
        const tool = findTool({ tools: TOOLS }, spec)
        if (!tool) throw unknown(spec)
        return ensureTool(ID, tool, spec, ctx)
      }
      if (spec.kind === 'session') return ensureSession(provider, spec, ctx)
      if (spec.id === 'neon.project') return ensureProject(spec, ctx)
      if (spec.id === 'neon.migrations') return ensureMigrations(spec, ctx)
      if (spec.id === 'neon.preview-branches') return ensurePreviewBranches(spec, ctx)
      if (spec.id === 'neon.api-key') return ensureApiKey(spec, ctx)
      throw unknown(spec)
    },

    async verify(spec: ResourceSpec, ctx: Ctx): Promise<CheckResult> {
      if (spec.kind === 'tool') {
        const tool = findTool({ tools: TOOLS }, spec)
        if (!tool) throw unknown(spec)
        return verifyTool(ID, tool, spec, ctx)
      }
      if (spec.kind === 'session') return sessionCheck(ID, spec, await provider.detect(ctx), undefined, LOGIN_HINT)
      if (spec.id === 'neon.project') return verifyProject(spec, ctx)
      if (spec.id === 'neon.migrations') return verifyMigrations(spec, ctx)
      if (spec.id === 'neon.check.migrated') return verifyMigrated(spec, ctx)
      if (spec.id === 'neon.preview-branches') return verifyPreviewBranches(spec, ctx)
      if (spec.id === 'neon.api-key') return verifyApiKey(spec, ctx)
      throw unknown(spec)
    },

    async destroy(spec: ResourceSpec, ctx: Ctx): Promise<void> {
      if (spec.id === 'neon.preview-branches') return destroyPreviewBranches(spec, ctx)
      if (spec.id === 'neon.api-key') return destroyApiKey(spec, ctx)
      if (spec.id !== 'neon.project') return
      const id = recordedId(ctx, spec, `the Neon project ${str(spec.inputs.name) || ctx.manifest.slug}`)
      const result = await neonCall(ctx, spec.id, 'DELETE', `/projects/${encodeURIComponent(id)}`)
      if (!result.ok && result.status !== 404) {
        throw neonError(spec.id, result, {
          code: 'NEON_API_ERROR',
          message: `Deleting the Neon project ${id} failed`,
          hint: 'cimiento down retries safely. Neon keeps a deleted project recoverable for 7 days.',
        })
      }
    },

    async presence(spec: ResourceSpec, ctx: Ctx): Promise<Presence> {
      if (spec.id === 'neon.preview-branches') return previewBranchesPresence(spec, ctx)
      if (spec.id === 'neon.api-key') return apiKeyPresence(spec, ctx)
      if (spec.id !== 'neon.project' && spec.id !== 'neon.migrations') return 'unknown'
      const id = ctx.state.resources['neon.project']?.externalId
      if (!id) return 'unknown'
      const result = await neonCall(ctx, spec.id, 'GET', `/projects/${encodeURIComponent(id)}`)
      return presenceFromStatus(result.status)
    },

    async outputs(spec: ResourceSpec, ctx: Ctx): Promise<Record<string, Output>> {
      if (spec.id !== 'neon.project') return {}
      const project = await findProject(ctx, spec)
      return project ? projectOutputs(ctx, spec, project) : {}
    },

    explain(key: string, lang: Lang): string {
      const entry = EXPLAIN[key]
      if (!entry) return `No explanation for ${key} yet.`
      return (lang === 'es' && entry.es) || entry.en
    },
  }
  return provider
}

function unknown(spec: ResourceSpec): CimientoError {
  return new CimientoError({
    code: 'NEON_API_ERROR',
    provider: ID,
    resource: spec.id,
    message: `The neon provider does not know the resource ${spec.id}.`,
    hint: 'This is a cimiento bug. Run cimiento plan --json and report the item.',
    retryable: false,
    needsHuman: false,
  })
}

async function ensureSession(provider: Provider, spec: ResourceSpec, ctx: Ctx): Promise<EnsureResult> {
  const { account, action } = await ensureVendorSession(provider, spec, ctx, 'Neon', neonSignupStep())
  if (!ctx.manifest.accounts.neon) await pinOrganization(spec, ctx)
  const org = ctx.manifest.accounts.neon
  return { action, externalId: account, outputs: { account: { value: account, secret: false }, ...(org ? { organizationId: { value: org, secret: false } } : {}) } }
}

/** A personal Neon login can own projects in several organizations; the person picks one once. */
async function pinOrganization(spec: ResourceSpec, ctx: Ctx): Promise<void> {
  const result = await neonCall<{ organizations?: { id: string; name: string }[] }>(ctx, spec.id, 'GET', '/users/me/organizations')
  if (!result.ok) return
  const orgs = result.body?.organizations ?? []
  await chooseAndPin(ctx, {
    provider: ID,
    resource: spec.id,
    what: 'Neon organization',
    path: ['accounts', 'neon'],
    options: orgs.map((o) => ({ value: o.id, label: `${o.name} (${o.id})` })),
    step: neonOrganizationStep(orgs.map((o) => o.name)),
  })
}

function orgQuery(ctx: Ctx): string {
  const org = ctx.manifest.accounts.neon
  return org ? `&org_id=${encodeURIComponent(org)}` : ''
}

async function findProject(ctx: Ctx, spec: ResourceSpec): Promise<NeonProject | undefined> {
  const name = str(spec.inputs.name) || ctx.manifest.slug
  const result = await neonCall<{ projects?: NeonProject[] }>(ctx, spec.id, 'GET', `/projects?search=${encodeURIComponent(name)}&limit=100${orgQuery(ctx)}`)
  if (!result.ok) {
    throw neonError(spec.id, result, { code: 'NEON_API_ERROR', message: 'Listing Neon projects failed', hint: 'cimiento up retries this safely.' })
  }
  return (result.body?.projects ?? []).find((p) => p.name === name)
}

async function defaultDatabase(ctx: Ctx, spec: ResourceSpec, projectId: string): Promise<{ database: string; role: string }> {
  const branches = await neonCall<{ branches?: { id: string; default?: boolean }[] }>(ctx, spec.id, 'GET', `/projects/${encodeURIComponent(projectId)}/branches`)
  const branch = (branches.body?.branches ?? []).find((b) => b.default) ?? branches.body?.branches?.[0]
  if (branch) {
    const dbs = await neonCall<{ databases?: { name: string; owner_name: string }[] }>(
      ctx,
      spec.id,
      'GET',
      `/projects/${encodeURIComponent(projectId)}/branches/${encodeURIComponent(branch.id)}/databases`,
    )
    const db = dbs.body?.databases?.[0]
    if (db) return { database: db.name, role: db.owner_name }
  }
  return { database: 'neondb', role: 'neondb_owner' }
}

async function connectionUri(ctx: Ctx, spec: ResourceSpec, projectId: string, db: { database: string; role: string }, pooled: boolean): Promise<string | undefined> {
  const result = await neonCall<{ uri?: string }>(
    ctx,
    spec.id,
    'GET',
    `/projects/${encodeURIComponent(projectId)}/connection_uri?database_name=${encodeURIComponent(db.database)}&role_name=${encodeURIComponent(db.role)}&pooled=${pooled}`,
  )
  const uri = result.body?.uri
  if (uri) ctx.redactor.addValue(uri)
  return uri
}

async function projectOutputs(ctx: Ctx, spec: ResourceSpec, project: NeonProject): Promise<Record<string, Output>> {
  const db = await defaultDatabase(ctx, spec, project.id)
  const pooled = await connectionUri(ctx, spec, project.id, db, true)
  const direct = await connectionUri(ctx, spec, project.id, db, false)
  return {
    projectId: { value: project.id, secret: false },
    databaseName: { value: db.database, secret: false },
    roleName: { value: db.role, secret: false },
    ...(pooled ? { databaseUrl: { value: pooled, secret: true } } : {}),
    ...(direct ? { databaseUrlUnpooled: { value: direct, secret: true } } : {}),
  }
}

async function ensureProject(spec: ResourceSpec, ctx: Ctx): Promise<EnsureResult> {
  const known = ctx.state.resources[spec.id]
  const existing = await findProject(ctx, spec)
  if (existing) {
    const outputs = await projectOutputs(ctx, spec, existing)
    const url = `https://console.neon.tech/app/projects/${existing.id}`
    return { action: sameResource(known?.externalId, existing.id) ? 'noop' : 'adopted', externalId: existing.id, url, outputs }
  }
  if (ctx.dryRun) return { action: 'noop' }
  const org = ctx.manifest.accounts.neon
  const created = await neonCall<{ project?: NeonProject; databases?: { name: string; owner_name: string }[] }>(ctx, spec.id, 'POST', '/projects', {
    project: {
      name: str(spec.inputs.name),
      region_id: str(spec.inputs.region),
      pg_version: Number(str(spec.inputs.pgVersion) || '17'),
      ...(org ? { org_id: org } : {}),
    },
  })
  if (!created.ok || !created.body?.project) {
    const message = ((created.body as { message?: string } | undefined)?.message ?? '').toLowerCase()
    if (created.status === 422 && message.includes('limit')) {
      throw new CimientoError({
        code: 'NEON_PROJECT_LIMIT',
        provider: ID,
        resource: spec.id,
        message: `Neon refused a new project: the organization is at its project limit (${message.slice(0, 160)}).`,
        hint: 'Delete a Neon project you no longer need at https://console.neon.tech/app/projects, then run cimiento up again.',
        docsUrl: 'https://console.neon.tech/app/projects',
        retryable: true,
        needsHuman: true,
      })
    }
    throw neonError(spec.id, created, { code: 'NEON_API_ERROR', message: `Creating the Neon project ${str(spec.inputs.name)} failed`, hint: 'cimiento up retries this safely; it never creates a second project with the same name.' })
  }
  const project = created.body.project
  const outputs = await projectOutputs(ctx, spec, project)
  return { action: 'created', externalId: project.id, url: `https://console.neon.tech/app/projects/${project.id}`, outputs }
}

async function verifyProject(spec: ResourceSpec, ctx: Ctx): Promise<CheckResult> {
  const project = await findProject(ctx, spec)
  if (!project) {
    return {
      ok: false,
      error: new CimientoError({
        code: 'NEON_API_ERROR',
        provider: ID,
        resource: spec.id,
        message: `No Neon project named ${str(spec.inputs.name)} is visible to this login.`,
        hint: 'Run cimiento up to create it. If it exists in another organization, pin that one in accounts.neon.',
        retryable: true,
        needsHuman: false,
      }),
    }
  }
  return { ok: true, evidence: `neon project ${project.name} (${project.id}) in ${project.region_id ?? 'its region'}` }
}

/** The migration files, sorted by name, which is the order they run in. */
function migrationFiles(ctx: Ctx, dir: string): { name: string; sql: string }[] {
  const path = join(ctx.cwd, dir)
  if (!existsSync(path)) return []
  return readdirSync(path)
    .filter((f) => f.endsWith('.sql'))
    .sort()
    .map((name) => ({ name, sql: readFileSync(join(path, name), 'utf8') }))
}

async function directUrl(spec: ResourceSpec, ctx: Ctx): Promise<string> {
  const projectId = str(spec.inputs.projectId)
  const db = await defaultDatabase(ctx, spec, projectId)
  const uri = await connectionUri(ctx, spec, projectId, db, false)
  if (!uri) {
    throw new CimientoError({
      code: 'NEON_API_ERROR',
      provider: ID,
      resource: spec.id,
      message: `Neon gave no connection string for project ${projectId}.`,
      hint: 'cimiento up retries this safely. cimiento doctor shows whether the Neon project still exists.',
      retryable: true,
      needsHuman: false,
    })
  }
  return uri
}

export type History = { state: 'missing' } | { state: 'unreadable'; message: string } | { state: 'ok'; names: string[] }

/**
 * The migrations already applied. A history table that does not exist yet is missing, and the
 * first run creates it; one that exists but cannot be read is unreadable, and nothing is applied,
 * because applying everything again on top of a database that has it would break it (BUG-77).
 */
export async function migrationHistory(io: Io, url: string): Promise<History> {
  const exists = await io.sql(url, `select to_regclass('public.${MIGRATIONS_TABLE}') as t`)
  if (!exists.ok) return { state: 'unreadable', message: exists.error?.message ?? 'no answer' }
  if (exists.rows[0]?.t === null || exists.rows[0]?.t === undefined) return { state: 'missing' }
  const list = await io.sql(url, `select name from public.${MIGRATIONS_TABLE} order by name`)
  if (!list.ok) return { state: 'unreadable', message: list.error?.message ?? 'no answer' }
  return { state: 'ok', names: list.rows.map((r) => String(r.name)) }
}

function historyUnreadable(spec: ResourceSpec, message: string): CimientoError {
  return new CimientoError({
    code: 'NEON_MIGRATION_HISTORY_UNREADABLE',
    provider: ID,
    resource: spec.id,
    message: `The migration history table public.${MIGRATIONS_TABLE} exists but cannot be read: ${message.slice(0, 200)}`,
    hint: `Nothing was applied. Check that the role in the connection string can read public.${MIGRATIONS_TABLE} (grant select on it), then run cimiento up again.`,
    retryable: true,
    needsHuman: true,
  })
}

/**
 * Applies the files not in the history yet, in name order, each whole and in one implicit
 * transaction with its record. Returns the names applied before and now.
 */
export async function applyMigrations(io: Io, url: string, files: { name: string; sql: string }[], spec: ResourceSpec): Promise<{ before: string[]; applied: string[] }> {
  const history = await migrationHistory(io, url)
  if (history.state === 'unreadable') throw historyUnreadable(spec, history.message)
  const before = history.state === 'ok' ? history.names : []
  const pending = files.filter((f) => !before.includes(f.name))
  if (pending.length > 0 && history.state === 'missing') {
    const created = await io.sql(url, `create table if not exists public.${MIGRATIONS_TABLE} (name text primary key, applied_at timestamptz not null default now())`)
    if (!created.ok) throw migrationFailed(spec, MIGRATIONS_TABLE, created.error?.message)
  }
  for (const file of pending) {
    // The whole file, never split: dollar quoted bodies, comments and semicolons inside strings
    // reach Postgres as written (BUG-77). The record goes in the same implicit transaction, so a
    // file that fails leaves no trace and no record.
    const result = await io.sql(url, `${file.sql}\n;\ninsert into public.${MIGRATIONS_TABLE} (name) values ('${file.name.replace(/'/g, "''")}')`)
    if (!result.ok) throw migrationFailed(spec, file.name, result.error?.message)
  }
  return { before, applied: pending.map((f) => f.name) }
}

async function ensureMigrations(spec: ResourceSpec, ctx: Ctx): Promise<EnsureResult> {
  const files = migrationFiles(ctx, str(spec.inputs.dir))
  const url = await directUrl(spec, ctx)
  const outputs = (count: number): Record<string, Output> => ({ applied: { value: String(count), secret: false } })
  if (ctx.dryRun) {
    const history = await migrationHistory(ctx.io, url)
    if (history.state === 'unreadable') throw historyUnreadable(spec, history.message)
    return { action: 'noop', ...(history.state === 'ok' ? { outputs: outputs(history.names.length) } : {}) }
  }
  const { before, applied } = await applyMigrations(ctx.io, url, files, spec)
  if (applied.length === 0) return { action: 'noop', externalId: str(spec.inputs.projectId), outputs: outputs(before.length) }
  return { action: before.length > 0 ? 'updated' : 'created', externalId: str(spec.inputs.projectId), outputs: outputs(before.length + applied.length) }
}

function migrationFailed(spec: ResourceSpec, name: string, message = 'no answer'): CimientoError {
  return new CimientoError({
    code: 'NEON_MIGRATION_FAILED',
    provider: ID,
    resource: spec.id,
    message: `The migration ${name} failed on Neon: ${message.slice(0, 300)}`,
    hint: 'Fix the SQL in that file and run cimiento up again. Each file runs in one transaction with its record, so a failed file leaves nothing half applied.',
    retryable: false,
    needsHuman: true,
  })
}

async function verifyMigrations(spec: ResourceSpec, ctx: Ctx): Promise<CheckResult> {
  const files = migrationFiles(ctx, str(spec.inputs.dir))
  const history = await migrationHistory(ctx.io, await directUrl(spec, ctx))
  if (history.state === 'unreadable') return { ok: false, error: historyUnreadable(spec, history.message) }
  const applied = history.state === 'ok' ? history.names : []
  const pending = files.filter((f) => !applied.includes(f.name)).map((f) => f.name)
  if (pending.length > 0) {
    return {
      ok: false,
      error: new CimientoError({
        code: 'NEON_MIGRATION_FAILED',
        provider: ID,
        resource: spec.id,
        message: `${pending.length} migration${pending.length === 1 ? '' : 's'} not applied yet: ${pending.join(', ')}.`,
        hint: 'Run cimiento up, which applies them in order.',
        retryable: true,
        needsHuman: false,
      }),
    }
  }
  return { ok: true, evidence: `${applied.length} migration${applied.length === 1 ? '' : 's'} applied` }
}

async function verifyMigrated(spec: ResourceSpec, ctx: Ctx): Promise<CheckResult> {
  const url = await directUrl(spec, ctx)
  const result = await ctx.io.sql(url, `select count(*) as n from public.${BASELINE_TABLE}`)
  if (!result.ok) {
    return {
      ok: false,
      error: new CimientoError({
        code: 'NEON_MIGRATION_FAILED',
        provider: ID,
        resource: spec.id,
        message: `Querying public.${BASELINE_TABLE} on Neon failed: ${(result.error?.message ?? 'no answer').slice(0, 200)}`,
        hint: 'Run cimiento up, which applies the baseline migration. If the file was removed from the migrations folder, restore it.',
        retryable: true,
        needsHuman: false,
      }),
    }
  }
  const n = String(result.rows[0]?.n ?? '0')
  return { ok: true, evidence: `public.${BASELINE_TABLE} answers with ${n} row${n === '1' ? '' : 's'} on Neon` }
}

export default createNeonProvider()
