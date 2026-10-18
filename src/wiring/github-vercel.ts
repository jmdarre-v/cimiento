// github + any hosting: the hosting project is linked to the repository, production follows the
// default branch and pull requests get previews.

import type { ProjectState } from '../core/state'
import type { Manifest } from '../manifest/schema'
import type { WiringResult, WiringRule } from './types'

const EXPLAIN: Record<string, { en: string; es?: string }> = {
  'vercel.github-access': {
    en: 'Vercel can only build from a private GitHub repository when two things are true: your Vercel account has GitHub connected as a login, and the Vercel app on GitHub is allowed to see that repository. cimiento checks both, opens the page for whatever is missing, and waits while you do it.',
    es: 'Vercel solo puede construir desde un repositorio privado de GitHub si tu cuenta de Vercel tiene GitHub conectado como inicio de sesion y la app de Vercel en GitHub puede ver ese repositorio. cimiento revisa ambas cosas, abre la pagina de lo que falta y espera mientras lo haces.',
  },
  'vercel.check.preview': {
    en: 'A probe that every branch pushed to the repository, other than the production branch, has a ready preview deployment of its latest commit. Before the first branch it says there is nothing to preview yet.',
    es: 'Una prueba de que cada rama subida al repositorio, salvo la de produccion, tiene una vista previa lista de su ultimo commit. Antes de la primera rama dice que todavia no hay nada que previsualizar.',
  },
  'vercel.check.repo-linked': {
    en: 'A probe that Vercel still builds from your GitHub repository and the right production branch. When this drifts, pushing code stops changing the site and nobody notices for days.',
    es: 'Una prueba de que Vercel sigue construyendo desde tu repositorio de GitHub y la rama correcta. Si esto se desconfigura, subir codigo deja de cambiar el sitio.',
  },
}

export const githubVercelRule: WiringRule = {
  id: 'github+vercel',
  pair: ['github', 'vercel'],

  applies(m: Manifest): boolean {
    return m.slots.repo === 'github' && m.slots.hosting === 'vercel'
  },

  build(m: Manifest, _state: ProjectState): WiringResult {
    const projectId = { deferred: 'vercel.project:projectId' }
    const repo = { deferred: 'github.repo:fullName' }
    return {
      specs: [
        {
          // Linking a private repository needs a GitHub Login Connection on Vercel and the Vercel
          // GitHub app with access to that repository. One person step covers both, checked up
          // front, instead of two failures found one link attempt at a time.
          id: 'vercel.github-access',
          kind: 'manual',
          provider: 'vercel',
          dependsOn: ['vercel.session', 'github.repo'],
          inputs: { repo },
          manual: {
            instructions:
              'Vercel needs two things to link a private repository: GitHub connected under Login Connections in your Vercel account, and the Vercel GitHub app installed with access to the repository. cimiento checks both and names the exact pages.',
            url: 'https://vercel.com/account/authentication',
          },
        },
        {
          id: 'vercel.binding.git-repo',
          kind: 'binding',
          provider: 'vercel',
          dependsOn: ['vercel.project', 'github.repo', 'vercel.github-access'],
          inputs: {
            projectId,
            repo,
            productionBranch: m.options.github.defaultBranch,
          },
        },
        {
          id: 'vercel.check.repo-linked',
          kind: 'check',
          provider: 'vercel',
          dependsOn: ['vercel.binding.git-repo'],
          inputs: { projectId, repo },
        },
        {
          // hosting.preview from spec section 12.
          id: 'vercel.check.preview',
          kind: 'check',
          provider: 'vercel',
          dependsOn: ['vercel.binding.git-repo'],
          inputs: { projectId, repo, productionBranch: m.options.github.defaultBranch },
        },
      ],
      // The first deployment only makes sense once the repository is connected. The Vercel login
      // comes after the GitHub one, because a new Vercel account is made with Continue with GitHub.
      edges: [
        { from: 'vercel.deployment', to: 'vercel.binding.git-repo' },
        { from: 'vercel.session', to: 'github.session' },
      ],
    }
  },

  explain(key: string, lang: 'en' | 'es'): string | undefined {
    const entry = EXPLAIN[key]
    if (!entry) return undefined
    return (lang === 'es' && entry.es) || entry.en
  },
}
