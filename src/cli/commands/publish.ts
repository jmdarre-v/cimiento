// cimiento publish, spec section 9: the designer's one command after changing the site. It commits
// every change with a message, pushes, waits for Vercel to deploy that commit, and prints the URL.

import { CimientoError, ExitCode } from '../../core/errors'
import type { ResourceSpec } from '../../core/types'
import { gitIdentityArgs } from '../../providers/github'
import { waitForCommitDeployment } from '../../providers/vercel'
import { flagString } from '../args'
import { openProject, sessionAsker, type Session } from '../context'

export async function publishCommand(session: Session): Promise<number> {
  const project = openProject(session, { dryRun: false })
  const { ctx } = project
  const es = session.lang === 'es'
  const projectId = ctx.state.resources['vercel.project']?.externalId ?? ctx.state.resources['vercel.project']?.outputs?.projectId
  if (project.manifest.slots.hosting !== 'vercel' || !projectId) {
    throw new CimientoError({
      code: 'VERCEL_PROJECT_NOT_FOUND',
      provider: 'vercel',
      resource: 'publish',
      message: 'This project has no Vercel project yet, so there is nowhere to publish to.',
      hint: 'Run cimiento up first. publish sends changes to a site that already exists.',
      retryable: false,
      needsHuman: true,
    })
  }
  const git = (args: string[]) => session.io.exec('git', args, { cwd: session.cwd })
  const spec: ResourceSpec = { id: 'publish', kind: 'resource', provider: 'vercel', dependsOn: [], inputs: {} }

  const status = await git(['status', '--porcelain'])
  if (status.code !== 0) {
    throw new CimientoError({
      code: 'GITHUB_REPO_NOT_FOUND',
      provider: 'github',
      resource: 'publish',
      message: `This folder is not a git repository: ${(status.stderr || status.stdout).trim().slice(0, 200)}`,
      hint: 'Run cimiento publish inside the project folder cimiento created.',
      retryable: false,
      needsHuman: true,
    })
  }
  if (!status.stdout.trim()) {
    const url = ctx.state.resources['vercel.deployment']?.outputs?.productionUrl
    if (session.json) session.printer.emit({ ok: true, command: 'publish', published: false, productionUrl: url ?? null })
    else session.printer.line(es ? `No hay cambios para publicar.${url ? ` El sitio esta en ${url}` : ''}` : `Nothing to publish: no changes.${url ? ` The site is at ${url}` : ''}`)
    return ExitCode.ok
  }

  const fallback = es ? 'Actualizar el sitio' : 'Update the site'
  const asker = sessionAsker(session)
  const message =
    flagString(session.args.flags, 'message') ??
    (asker ? (await asker(es ? 'Que cambiaste? (mensaje del commit)' : 'What changed? (the commit message)', fallback)).trim() || fallback : fallback)

  await git(['add', '-A'])
  const commit = await git([...(await gitIdentityArgs(ctx)), 'commit', '-m', message])
  if (commit.code !== 0) {
    throw new CimientoError({
      code: 'GITHUB_REPO_CREATE_FAILED',
      provider: 'github',
      resource: 'publish',
      message: `The commit failed: ${(commit.stderr || commit.stdout).trim().slice(0, 300)}`,
      hint: 'Run cimiento publish again. It commits whatever changed and pushes it.',
      retryable: true,
      needsHuman: false,
    })
  }
  const sha = (await git(['rev-parse', 'HEAD'])).stdout.trim()
  const branch = (await git(['rev-parse', '--abbrev-ref', 'HEAD'])).stdout.trim() || project.manifest.options.github.defaultBranch
  await session.io.exec('gh', ['auth', 'setup-git', '--hostname', 'github.com'], { cwd: session.cwd }).catch(() => undefined)
  const push = await git(['push', 'origin', branch])
  if (push.code !== 0) {
    throw new CimientoError({
      code: 'GITHUB_PERMISSION_DENIED',
      provider: 'github',
      resource: 'publish',
      message: `git push to ${branch} failed: ${(push.stderr || push.stdout).trim().slice(0, 300)}`,
      hint: 'Run cimiento doctor to check the GitHub login, then cimiento publish again; the commit is already made and is pushed then.',
      retryable: true,
      needsHuman: false,
    })
  }
  if (!session.json) session.printer.line(es ? `Publicado ${sha.slice(0, 7)} en ${branch}. Esperando el despliegue de Vercel...` : `Pushed ${sha.slice(0, 7)} to ${branch}. Waiting for Vercel to deploy it...`)

  const deployed = await waitForCommitDeployment(ctx, spec, projectId, sha)
  const url = deployed.productionUrl ?? deployed.url
  if (session.json) {
    session.printer.emit({ ok: true, command: 'publish', published: true, commit: sha, branch, message, deploymentUrl: deployed.url, productionUrl: deployed.productionUrl ?? null })
  } else {
    session.printer.line(es ? `Listo, en linea: ${url}` : `Live: ${url}`)
  }
  return ExitCode.ok
}
