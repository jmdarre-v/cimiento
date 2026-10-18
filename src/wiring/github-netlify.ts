// github + netlify: the Netlify site builds from the repository, production follows the default
// branch, and pull requests get previews. Spec section 6, github + any hosting.

import type { ProjectState } from '../core/state'
import type { Manifest } from '../manifest/schema'
import type { WiringResult, WiringRule } from './types'

export const githubNetlifyRule: WiringRule = {
  id: 'github+netlify',
  pair: ['github', 'netlify'],

  applies(m: Manifest): boolean {
    return m.slots.repo === 'github' && m.slots.hosting === 'netlify'
  },

  build(m: Manifest, _state: ProjectState): WiringResult {
    const projectId = { deferred: 'netlify.project:projectId' }
    const repo = { deferred: 'github.repo:fullName' }
    const productionBranch = m.options.github.defaultBranch
    return {
      specs: [
        {
          id: 'netlify.binding.git-repo',
          kind: 'binding',
          provider: 'netlify',
          // After the first push, so Netlify's first build finds the scaffold on the branch.
          dependsOn: ['netlify.project', 'github.repo'],
          inputs: { projectId, repo, productionBranch },
        },
        { id: 'netlify.check.repo-linked', kind: 'check', provider: 'netlify', dependsOn: ['netlify.binding.git-repo'], inputs: { projectId, repo, productionBranch } },
        { id: 'netlify.check.preview', kind: 'check', provider: 'netlify', dependsOn: ['netlify.binding.git-repo'], inputs: { projectId, repo, productionBranch } },
      ],
      edges: [{ from: 'netlify.deployment', to: 'netlify.binding.git-repo' }],
    }
  },

  explain(): string | undefined {
    return undefined
  },
}
