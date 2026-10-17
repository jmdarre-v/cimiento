# Changelog

## 0.1.0

The first public release.

### Commands

- `cimiento new` and `init` write `stack.yaml`, scaffold the project, and run `plan` and `up`.
- `cimiento plan`, `up` and `doctor`: plan, apply with person steps first and the rest
  unattended, and re-verify everything from reality.
- `cimiento down` deletes what cimiento created, in reverse dependency order, after the project
  name is typed back; it keeps what it adopted and lists what a vendor API cannot delete.
- `cimiento join` sets up a fresh clone: tools, logins, access, env pull and checks.
- `cimiento dev` starts the local database, the Inngest dev server and the app, one Ctrl+C.
- `cimiento publish` commits every change, pushes, waits for that commit's deploy and prints the
  URL.
- `cimiento secret set`, `rotate`, `remove` and `check`; `cimiento env pull` and `env print`;
  `cimiento accounts set`; `cimiento explain`.

### Providers and wiring

- GitHub, Vercel and Supabase, on the Vercel Marketplace path and the direct path.
- Inngest, with the Vercel integration and a roundtrip check of a real event.
- Cloudflare Turnstile, with widget domains that follow the production host and a siteverify check.
- Anthropic, with a free read only check of the key.

### Secrets

- Sources: hidden prompt, environment, macOS keychain and 1Password. Sink: the hosting env.
- Values never reach `stack.yaml`, state, logs, `--json` output, run logs or a chat window.

### Presets and templates

- `--preset fullstack`: GitHub, Vercel, Supabase, Inngest, Turnstile and Anthropic.
- `--preset designer`: GitHub and Vercel with the `designer-site` template and a `design/` folder
  for Claude Design exports.

### For people and agents

- Guided mode in English and Spanish: one question at a time, every step a person does explained
  first, every failure ending with one next command.
- Every person step gives the full link, Enter to open it, the clicks in order, each field and its
  value, the button, what success looks like, and Enter when done before cimiento verifies it.
- `--json` on every command, one line per event, exit codes 0 ok, 1 failed, 2 waiting on a person,
  3 blocked.
- Run logs in `~/.cimiento/runs/`, one per command, with UTC timestamps.
- `scripts/install.sh` installs Homebrew, the tools, Claude Code and cimiento, and logs in to
  Claude Code.
- The Claude Code plugin: `setup`, `new-project`, `explain` and `secrets` skills, and a hook that
  keeps `.env` files out of Claude.
- `docs/TROUBLESHOOTING.md`, generated from the knowledge base.
