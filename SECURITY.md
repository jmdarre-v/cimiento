# Security

## Reporting a vulnerability

Report it privately through GitHub: open the repository's Security tab and choose
**Report a vulnerability**. Please do not open a public issue for it. Include the cimiento version
(`cimiento --version`), the command, and what you saw; never include a real key or token, a
redacted placeholder is enough.

You get an answer within a week. A fix ships as a new release, and the affected versions are
deprecated on npm with a message that names the fixed one.

## What cimiento promises about secrets

- A secret value never goes into `stack.yaml`, `.cimiento/state.json`, a log line, a run log in
  `~/.cimiento/runs`, `--json` output or a command line. Logs print `NAME=****`.
- Values reach a provider in a request body or on stdin, never in argv, where other processes
  could read them.
- `cimiento env pull` is the one place a value touches disk, in `.env.local`, which the scaffold
  gitignores.
- Stripe is test mode only: a live key is refused the moment it is read.

A leak of a value through any of those paths is a vulnerability; please report it.

## What GitHub Actions holds for preview databases

A project with Neon, a GitHub repository and hosting has a workflow, `preview-database`, that
makes a Neon branch per git branch and writes its address into the hosting env. It holds, in
GitHub Actions secrets only:

- `NEON_API_KEY`, an organization API key scoped to the app's one Neon project. It can make,
  read and delete that project's branches, the production branch included, but cannot delete the
  project or reach another. cimiento makes it, and `down` revokes it.
- `VERCEL_TOKEN`, a Vercel token scoped to the team in `stack.yaml`, which cimiento makes for the
  workflow and `down` revokes; on Netlify, `NETLIFY_AUTH_TOKEN`, a personal access token you make,
  because Netlify offers no API to make one.
- The project, team and site ids, which are not secrets.

Previews hold none of these, only their own branch's address (since 0.4.2; 0.4.1 put the Neon key
in the preview env). Anyone who can push a branch to the repository controls what the workflow
runs and so can read these secrets; give push access accordingly.

## What cimiento does not promise

- The `.env` hook in the Claude Code plugin and the `.claude/settings.json` deny rule are guards
  against accidental disclosure, not a security boundary. They stop Claude Code from reading
  `.env` files by mistake; they do not stop a determined process, a shell command that
  reads the file another way, or a person who pastes a key into a chat.
- The keychain source relies on your operating system's keychain; on Linux without an unlocked
  keyring, a typed value lives for one run only.
- cimiento acts with the accounts you are logged in to. It deletes only what it created and
  confirms each delete, but a token with broad scopes can do whatever that account can.

## Supported versions

Only the latest release gets fixes. 0.1.0 and 0.2.0 can lose track of resources during teardown,
and 0.3.0 and older delete some resources by name, so a resource made later with the same name can
be deleted in place of the one cimiento made; upgrade to 0.4.0 or later.
