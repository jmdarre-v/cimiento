// The designer-site starter, spec section 11: the nextjs-app base with a design/ folder for Claude
// Design exports, and a page meant to be replaced by the design. It carries the same marker the
// hosting.deployed check looks for.

import type { Manifest } from '../../manifest/schema'
import { nextjsAppFiles } from './nextjs-app'

export function designerSiteFiles(m: Manifest): Record<string, string> {
  const host = m.slots.hosting === 'netlify' ? 'Netlify' : 'Vercel'
  return {
    ...nextjsAppFiles(m),
    'app/page.tsx': `export default function Home() {
  return (
    <main>
      <h1>${m.name}</h1>
      <p>This site was set up by cimiento and is live. The design goes here next.</p>
      <ol>
        <li>Export your design from Claude Design and put the zip in design/exports.</li>
        <li>Unzip it into design/current.</li>
        <li>Ask Claude Code: turn design/current into app/page.tsx.</li>
        <li>Push to main. ${host} publishes the new version by itself.</li>
      </ol>
    </main>
  )
}
`,
    'design/README.md': `# design

This folder is where the design of ${m.name} lives before it becomes code.

- \`design/exports/\` holds the zip files exported from Claude Design. They are gitignored, so a
  large export never lands in the repository.
- \`design/current/\` holds the unzipped export the site is built from. It is committed, so the
  history shows which design each version of the site came from.

To update the site from a new design:

1. Export from Claude Design and save the zip in \`design/exports/\`.
2. Replace the contents of \`design/current/\` with the unzipped export.
3. Ask Claude Code: turn design/current into app/page.tsx, keeping the cimiento-project meta tag.
4. Commit and push to main. ${host} deploys it, and \`cimiento doctor\` checks the live page.
`,
    'design/exports/.gitkeep': '',
    'design/current/.gitkeep': '',
  }
}
