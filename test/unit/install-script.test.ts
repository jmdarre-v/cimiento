// Goal 3: scripts/install.sh per spec section 14, run against stub commands on PATH and a
// temporary HOME, so no test installs anything or reaches the network.

import { spawnSync } from 'node:child_process'
import { chmodSync, existsSync, mkdirSync, readdirSync, readFileSync, writeFileSync } from 'node:fs'
import { join, resolve } from 'node:path'
import { afterEach, beforeEach, describe, expect, it } from 'vitest'
import { removeDir, tempDir } from './helpers'

const SCRIPT = resolve(__dirname, '../../scripts/install.sh')

let home: string
let stubs: string
let prefix: string
let log: string

function stub(name: string, body: string): void {
  const path = join(stubs, name)
  writeFileSync(path, `#!/bin/bash\n${body}\n`)
  chmodSync(path, 0o755)
}

/** A tool that answers --version, placed where an install would put it. */
function tool(dir: string, name: string, version: string): void {
  mkdirSync(dir, { recursive: true })
  const path = join(dir, name)
  writeFileSync(path, `#!/bin/bash\necho "${name} version ${version}"\n`)
  chmodSync(path, 0o755)
}

function setup(opts: { brew: boolean; brewWritable?: boolean; os?: string; present?: string[] }): void {
  stub('uname', `if [ "$1" = "-m" ]; then echo arm64; else echo ${opts.os ?? 'Darwin'}; fi`)
  stub('xcode-select', 'exit 0')
  stub('curl', `echo "curl $*" >> "${log}"; exit 1`)
  if (opts.brew) {
    // A prefix this account cannot write to. A folder that does not exist works for root too,
    // where a read-only mode would not.
    if (opts.brewWritable === false) prefix = join(home, 'owned-by-someone-else')
    else mkdirSync(join(prefix, 'bin'), { recursive: true })
    stub(
      'brew',
      [
        `echo "brew $*" >> "${log}"`,
        `if [ "$1" = "--prefix" ]; then echo "${prefix}"; exit 0; fi`,
        'if [ "$1" = "--version" ]; then echo "Homebrew 4.6.0"; exit 0; fi',
        'if [ "$1" = "shellenv" ]; then exit 0; fi',
        `if [ "$1" = "install" ]; then name=$(basename "$2"); name=\${name%@*}; printf '#!/bin/bash\\necho "%s version 9.9.9"\\n' "$name" > "${stubs}/$name"; chmod +x "${stubs}/$name"; fi`,
      ].join('\n'),
    )
  }
  stub(
    'npm',
    [
      `echo "npm $*" >> "${log}"`,
      'pkg="$3"; case "$pkg" in @anthropic-ai/claude-code) name=claude ;; cimiento@latest|*.tgz) name=cimiento ;; *) name="$pkg" ;; esac',
      `printf '#!/bin/bash\\necho "%s version 0.1.0"\\n' "$name" > "${stubs}/$name"; chmod +x "${stubs}/$name"`,
    ].join('\n'),
  )
  for (const name of opts.present ?? []) tool(stubs, name, name === 'node' ? 'v22.18.0' : '2.0.0')
}

function install(args: string[] = []) {
  const result = spawnSync('/bin/bash', [SCRIPT, ...args], {
    // Never the real Homebrew of the machine running the tests.
    env: { HOME: home, PATH: `${stubs}:/usr/bin:/bin`, CIMIENTO_PROFILE: join(home, '.zprofile'), CIMIENTO_BREW_CANDIDATES: join(home, 'brew-installed', 'brew') },
    encoding: 'utf8',
  })
  return { code: result.status, out: `${result.stdout}${result.stderr}`, calls: existsSync(log) ? readFileSync(log, 'utf8') : '' }
}

beforeEach(() => {
  home = tempDir('cimiento-install-home-')
  stubs = join(home, 'stubs')
  prefix = join(home, 'homebrew')
  log = join(home, 'calls.log')
  mkdirSync(stubs, { recursive: true })
})

afterEach(() => {
  try {
    chmodSync(join(prefix, 'bin'), 0o755)
  } catch {
    // Not every test makes the prefix read only.
  }
  removeDir(home)
})

const ALL = ['git', 'node', 'pnpm', 'gh', 'vercel', 'supabase', 'claude', 'cimiento']

describe('scripts/install.sh', () => {
  it('with everything present, installs nothing and ends with a table of every tool', () => {
    setup({ brew: true, present: ALL })
    const { code, out, calls } = install()
    expect(code).toBe(0)
    expect(calls).not.toMatch(/brew install|npm install/)
    for (const name of ['Homebrew', 'git', 'node', 'pnpm', 'gh', 'vercel', 'supabase', 'Claude Code', 'cimiento']) {
      expect(out).toMatch(new RegExp(`^${name}\\s+\\S+\\s+already there$`, 'm'))
    }
    expect(out).toMatch(/^TOOL\s+VERSION\s+HOW$/m)
  })

  it('installs only what is missing, from Homebrew, cimiento last, and is idempotent', () => {
    setup({ brew: true, present: ['git', 'node'] })
    const first = install()
    expect(first.code).toBe(0)
    const lines = first.calls.split('\n').filter((l) => / install /.test(l))
    expect(lines).toEqual([
      'npm install -g pnpm',
      'brew install gh',
      'npm install -g vercel',
      'brew install supabase/tap/supabase',
      'npm install -g @anthropic-ai/claude-code',
      'npm install -g cimiento@latest',
    ])
    writeFileSync(log, '')
    const second = install()
    expect(second.code).toBe(0)
    expect(second.calls).not.toMatch(/brew install|npm install/)
  })

  it('refuses a Homebrew owned by another account, with what to do instead, and installs nothing', () => {
    setup({ brew: true, brewWritable: false, present: ALL })
    const { code, out, calls } = install()
    expect(code).toBe(1)
    expect(out).toContain('Homebrew on this Mac belongs to another account')
    expect(calls).not.toMatch(/ install /)
  })

  it('installs Homebrew first when it is missing, then the tools from it', () => {
    setup({ brew: false, present: ['git'] })
    // The Homebrew installer, as curl would fetch it: it puts brew where the installer looks.
    const installed = join(home, 'brew-installed')
    stub(
      'curl',
      [
        `echo "curl $*" >> "${log}"`,
        `echo 'mkdir -p "${installed}"; printf "#!/bin/bash\\necho \\"brew \\$*\\" >> ${log}\\nif [ \\"\\$1\\" = --prefix ]; then echo ${prefix}; fi\\nif [ \\"\\$1\\" = --version ]; then echo Homebrew 4.6.0; fi\\nif [ \\"\\$1\\" = shellenv ]; then echo export PATH=${installed}:\\\\\\$PATH; fi\\n" > "${installed}/brew"; chmod +x "${installed}/brew"; mkdir -p "${prefix}/bin"'`,
      ].join('\n'),
    )
    const { code, out, calls } = install()
    expect(out).toContain('Homebrew is not installed. It installs now and asks for your Mac password once.')
    expect(calls).toContain('curl -fsSL https://raw.githubusercontent.com/Homebrew/install/HEAD/install.sh')
    expect(calls).toContain('brew install node@22')
    expect(out).toMatch(/^Homebrew\s+4\.6\.0\s+installed$/m)
    expect(code).toBe(0)
  })

  it('adds the PATH lines to the profile once, however often it runs', () => {
    setup({ brew: true, present: ALL })
    install()
    install()
    const profile = readFileSync(join(home, '.zprofile'), 'utf8')
    expect(profile.split('# added by the cimiento installer').length - 1).toBe(1)
  })

  it('refuses anything but macOS with a sentence that says what to do instead', () => {
    setup({ brew: false, os: 'Linux' })
    const { code, out } = install()
    expect(code).toBe(1)
    expect(out).toContain("cimiento's installer is for macOS")
  })

  it('is valid bash 3.2, the bash every Mac ships', () => {
    const result = spawnSync('/bin/bash', ['-n', SCRIPT], { encoding: 'utf8' })
    expect(result.status, result.stderr).toBe(0)
  })
})

describe('the install run log', () => {
  it('writes ~/.cimiento/runs/<UTC>-install.jsonl with a timestamp on every line, the table rows and the end', () => {
    setup({ brew: true, present: ALL })
    const runs = join(home, 'runs')
    const result = spawnSync('/bin/bash', [SCRIPT], {
      env: { HOME: home, PATH: `${stubs}:/usr/bin:/bin`, CIMIENTO_PROFILE: join(home, '.zprofile'), CIMIENTO_BREW_CANDIDATES: join(home, 'none'), CIMIENTO_RUNS_DIR: runs },
      encoding: 'utf8',
    })
    expect(result.status).toBe(0)
    const files = readdirSync(runs)
    expect(files).toHaveLength(1)
    expect(files[0]).toMatch(/^\d{4}-\d{2}-\d{2}T\d{2}-\d{2}-\d{2}Z-install\.jsonl$/)
    const lines = readFileSync(join(runs, files[0]), 'utf8').trim().split('\n').map((l) => JSON.parse(l))
    for (const line of lines) expect(line.ts).toMatch(/^\d{4}-\d{2}-\d{2}T\d{2}:\d{2}:\d{2}Z$/)
    expect(lines[0]).toMatchObject({ type: 'start', command: 'install' })
    expect(lines.filter((l) => l.type === 'event').map((l) => l.event.tool)).toContain('gh')
    expect(lines[lines.length - 1]).toMatchObject({ type: 'end', exitCode: 0 })
  })
})

describe('Claude Code login at the end of install.sh', () => {
  /** claude that answers auth status from a file, and logs in when auth login runs. */
  function claudeStub(loggedIn: boolean): void {
    const state = join(home, 'claude-logged-in')
    if (loggedIn) writeFileSync(state, 'yes')
    stub(
      'claude',
      [
        `echo "claude $*" >> "${log}"`,
        'if [ "$1" = "--version" ]; then echo "2.1.289 (Claude Code)"; exit 0; fi',
        `if [ "$1" = "auth" ] && [ "$2" = "status" ]; then if [ -f "${state}" ]; then echo '{"loggedIn": true}'; else echo '{"loggedIn": false}'; fi; exit 0; fi`,
        `if [ "$1" = "auth" ] && [ "$2" = "login" ]; then echo yes > "${state}"; exit 0; fi`,
      ].join('\n'),
    )
  }

  function attended(lang?: string) {
    const result = spawnSync('/bin/bash', [SCRIPT, ...(lang ? ['--lang', lang] : [])], {
      env: { HOME: home, PATH: `${stubs}:/usr/bin:/bin`, CIMIENTO_PROFILE: join(home, '.zprofile'), CIMIENTO_BREW_CANDIDATES: join(home, 'none'), CIMIENTO_INTERACTIVE: '1' },
      input: '\n\n',
      encoding: 'utf8',
    })
    return { code: result.status, out: `${result.stdout}${result.stderr}`, calls: existsSync(log) ? readFileSync(log, 'utf8') : '' }
  }

  it('walks the Claude login as a person step that says which plan it needs, and checks it', async () => {
    setup({ brew: true, present: ALL.filter((t) => t !== 'claude') })
    claudeStub(false)
    const { code, out, calls } = attended()
    expect(code).toBe(0)
    const { claudeLoginStep } = await import('../../src/core/person-steps')
    const { STEP_WORDS } = await import('../../src/core/person')
    const step = claudeLoginStep()
    expect(out).toContain(step.title.en)
    expect(out).toContain(`${STEP_WORDS.open.en} ${step.url}`)
    step.path.forEach((p, i) => expect(out).toContain(`${i + 1}. ${p.en}`))
    for (const f of step.fields) expect(out).toContain(`${f.label.en}: ${f.value.en}`)
    expect(out).toContain(`${STEP_WORDS.button.en} ${step.button.en}`)
    expect(out).toContain(`${STEP_WORDS.success.en} ${step.success.en}`)
    expect(out.split(STEP_WORDS.enterToOpen.en).length - 1).toBe(1)
    expect(out.split(STEP_WORDS.enterWhenDone.en).length - 1).toBe(1)
    expect(calls).toContain('claude auth login --claudeai')
    expect(out).toMatch(/^Claude login\s+-\s+logged in$/m)
  })

  it('in Spanish with --lang es', async () => {
    setup({ brew: true, present: ALL.filter((t) => t !== 'claude') })
    claudeStub(false)
    const { out } = attended('es')
    const { claudeLoginStep } = await import('../../src/core/person-steps')
    const step = claudeLoginStep()
    expect(out).toContain(step.title.es)
    step.path.forEach((p, i) => expect(out).toContain(`${i + 1}. ${p.es}`))
    expect(out).toContain('Pulsa Enter para abrirlo en tu navegador.')
  })

  it('without a terminal, says how to log in later and which plan it needs, and never starts the login', () => {
    setup({ brew: true, present: ALL.filter((t) => t !== 'claude') })
    claudeStub(false)
    const { out, calls } = install()
    expect(out).toContain('run claude auth login in a terminal; it needs a Claude Pro or Max plan')
    expect(calls).not.toContain('claude auth login')
  })

  it('already logged in, it only says so', () => {
    setup({ brew: true, present: ALL.filter((t) => t !== 'claude') })
    claudeStub(true)
    const { out, calls } = attended()
    expect(out).toMatch(/^Claude login\s+-\s+already logged in$/m)
    expect(calls).not.toContain('claude auth login')
  })
})
