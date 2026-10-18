// cimiento publish, spec section 9: the designer's one command after changing the site. Three
// stages, each resumed when an earlier run stopped in it (BUG-78): commit what changed, push HEAD
// when the remote is not at it, and wait for the hosting deploy of HEAD when the live site is not
// built from it. A clean tree is not the end: a failed push or an interrupted wait leaves work.

import { CimientoError, ExitCode } from '../../core/errors'
import { HOSTING_NAMES } from '../../core/hosting'
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

  /** Whether every change from the given commit to HEAD is under .cimiento. */
  const onlyStateSince = async (from: string): Promise<boolean> => {
    const diff = await git(['diff', '--name-only', from, 'HEAD'])
    if (diff.code !== 0) return false
    const paths = diff.stdout.split('\n').map((p) => p.trim()).filter(Boolean)
    return paths.length > 0 && paths.every((p) => p.startsWith('.cimiento/'))
  }

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
  if (!live.known) {
    throw new CimientoError({
      code: 'PUBLISH_LIVE_COMMIT_UNKNOWN',
      provider: hosting,
      resource: 'publish',
      message: `cimiento could not ask ${vendor} which commit is live (${live.reason}), so it cannot say whether ${sha.slice(0, 7)} is deployed. It does not guess from what an earlier run recorded.`,
      hint: `${stages.push === 'done' || stages.commit === 'done' ? `${sha.slice(0, 7)} is committed and pushed. ` : ''}Run cimiento doctor to check the ${vendor} session, then cimiento publish again; it only waits for the deploy.`,
      retryable: true,
      needsHuman: false,
    })
  }
  // A live deployment that records no commit, such as one made by cimiento 0.3.0 or older, cannot
  // say whether HEAD is live. Only a push this run brings a deploy that will carry it.
  if (live.commit === undefined && stages.push !== 'done') {
    throw new CimientoError({
      code: 'PUBLISH_LIVE_COMMIT_UNKNOWN',
      provider: hosting,
      resource: 'publish',
      message: `The live ${vendor} deployment records no commit, so cimiento cannot say whether ${sha.slice(0, 7)} is deployed.`,
      hint: `Make a change and run cimiento publish --message "your message"; the deploy that push brings records its commit.`,
      retryable: true,
      needsHuman: false,
    })
  }
  let deployed: { url: string; productionUrl?: string } | undefined
  // A HEAD that only adds cimiento's own state on top of the live commit is the live app (BUG-100).
  const stateOnly = live.commit !== undefined && live.commit !== sha && (await onlyStateSince(live.commit))
  if (live.commit !== sha && !stateOnly) {
    if (!session.json) {
      session.printer.line(
        es ? `${sha.slice(0, 7)} esta en ${branch}. Esperando el despliegue de ${vendor}...` : `${sha.slice(0, 7)} is on ${branch}. Waiting for ${vendor} to deploy it...`,
      )
    }
    deployed = await waitForHostingCommit(ctx, hosting, projectId, sha)
    stages.deploy = 'done'
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
      live: { commit: deployed ? sha : (live.commit ?? null), source: deployed ? 'git' : (live.source ?? null) },
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
