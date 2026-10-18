// cimiento publish, spec section 9: the designer's one command after changing the site. Three
// stages, each resumed when an earlier run stopped in it (BUG-78): commit what changed, push HEAD
// when the remote is not at it, and wait for the hosting deploy of HEAD when the live site is not
// built from it. A clean tree is not the end: a failed push or an interrupted wait leaves work.

import { CimientoError, ExitCode } from '../../core/errors'
import { HOSTING_NAMES } from '../../core/hosting'
import { writeProjectState } from '../../core/state'
import { gitIdentityArgs } from '../../providers/github'
import { hostingProductionUrl, liveCommit, requireHostingProject, waitForHostingCommit } from '../../providers/hosting'
import { flagString } from '../args'
import { openProject, sessionAsker, type Session } from '../context'

type Stage = 'done' | 'skipped'

export async function publishCommand(session: Session): Promise<number> {
  const project = openProject(session, { dryRun: false })
  const { ctx } = project
  const es = session.lang === 'es'
  const { hosting, projectId } = requireHostingProject(ctx, project.manifest, 'publish')
  const vendor = HOSTING_NAMES[hosting]
  const git = (args: string[]) => session.io.exec('git', args, { cwd: session.cwd })
  const stages: { commit: Stage; push: Stage; deploy: Stage } = { commit: 'skipped', push: 'skipped', deploy: 'skipped' }

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

  // 1. Commit, when something changed.
  let message: string | undefined
  if (status.stdout.trim()) {
    const fallback = es ? 'Actualizar el sitio' : 'Update the site'
    const asker = sessionAsker(session)
    message =
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
    stages.commit = 'done'
  }
  const sha = (await git(['rev-parse', 'HEAD'])).stdout.trim()
  const branch = (await git(['rev-parse', '--abbrev-ref', 'HEAD'])).stdout.trim() || project.manifest.options.github.defaultBranch

  // 2. Push, when the remote branch is not at HEAD, such as after a push that failed.
  const remote = await git(['ls-remote', 'origin', `refs/heads/${branch}`])
  const remoteSha = remote.code === 0 ? remote.stdout.trim().split(/\s+/)[0] ?? '' : ''
  if (remoteSha !== sha) {
    await session.io.exec('gh', ['auth', 'setup-git', '--hostname', 'github.com'], { cwd: session.cwd }).catch(() => undefined)
    const push = await git(['push', 'origin', branch])
    if (push.code !== 0) {
      throw new CimientoError({
        code: 'GITHUB_PERMISSION_DENIED',
        provider: 'github',
        resource: 'publish',
        message: `git push to ${branch} failed: ${(push.stderr || push.stdout).trim().slice(0, 300)}`,
        hint: 'Run cimiento doctor to check the GitHub login and the network, then cimiento publish again; the commit is made, and the next publish pushes it without committing twice.',
        retryable: true,
        needsHuman: false,
      })
    }
    stages.push = 'done'
  }

  // 3. Wait for the deploy, when the live site is not built from HEAD, such as after a wait that
  // timed out.
  const live = await liveCommit(ctx, hosting, projectId)
  let deployed: { url: string; productionUrl?: string } | undefined
  if (live !== sha) {
    if (!session.json) {
      session.printer.line(
        es ? `${sha.slice(0, 7)} esta en ${branch}. Esperando el despliegue de ${vendor}...` : `${sha.slice(0, 7)} is on ${branch}. Waiting for ${vendor} to deploy it...`,
      )
    }
    deployed = await waitForHostingCommit(ctx, hosting, projectId, sha)
    stages.deploy = 'done'
    // Recorded, so the next publish knows the live site is built from this commit.
    const id = `${hosting}.deployment`
    const entry = ctx.state.resources[id] ?? {}
    writeProjectState(session.cwd, {
      ...ctx.state,
      resources: { ...ctx.state.resources, [id]: { ...entry, outputs: { ...(entry.outputs ?? {}), commit: sha } } },
      manifestHash: ctx.state.manifestHash,
    })
  }

  const published = stages.commit === 'done' || stages.push === 'done' || stages.deploy === 'done'
  const url = deployed?.productionUrl ?? deployed?.url ?? hostingProductionUrl(ctx, hosting)
  if (session.json) {
    session.printer.emit({
      ok: true,
      command: 'publish',
      published,
      commit: sha,
      branch,
      ...(message ? { message } : {}),
      stages,
      deploymentUrl: deployed?.url ?? null,
      productionUrl: deployed?.productionUrl ?? hostingProductionUrl(ctx, hosting) ?? null,
    })
  } else if (!published) {
    session.printer.line(es ? `Nada que publicar: ${sha.slice(0, 7)} ya esta en linea.${url ? ` ${url}` : ''}` : `Nothing to publish: ${sha.slice(0, 7)} is already live.${url ? ` ${url}` : ''}`)
  } else {
    session.printer.line(es ? `Listo, en linea: ${url}` : `Live: ${url}`)
  }
  return ExitCode.ok
}
