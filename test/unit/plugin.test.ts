// Goal 3: the Claude Code plugin per spec section 15. Four skills, the .env rule shipped as a
// PreToolUse hook (a plugin cannot ship permission rules), and a marketplace file so the
// repository installs as a plugin source.

import { spawnSync } from 'node:child_process'
import { existsSync, readFileSync } from 'node:fs'
import { join, resolve } from 'node:path'
import { describe, expect, it } from 'vitest'

const ROOT = resolve(__dirname, '../..')
const PLUGIN = join(ROOT, 'plugin')
const EM_DASH = String.fromCharCode(0x2014)

function frontmatter(path: string): Record<string, string> {
  const text = readFileSync(path, 'utf8')
  const match = /^---\n([\s\S]*?)\n---\n/.exec(text)
  if (!match) return {}
  const out: Record<string, string> = {}
  for (const line of match[1].split('\n')) {
    const at = line.indexOf(':')
    if (at > 0) out[line.slice(0, at).trim()] = line.slice(at + 1).trim()
  }
  return out
}

function hook(event: unknown): number {
  const result = spawnSync('node', [join(PLUGIN, 'scripts', 'deny-env.mjs')], { input: JSON.stringify(event), encoding: 'utf8' })
  return result.status ?? -1
}

describe('the plugin package', () => {
  it('has a manifest named cimiento, and the repository marketplace points at it', () => {
    const manifest = JSON.parse(readFileSync(join(PLUGIN, '.claude-plugin', 'plugin.json'), 'utf8'))
    const marketplace = JSON.parse(readFileSync(join(ROOT, '.claude-plugin', 'marketplace.json'), 'utf8'))
    expect(manifest.name).toBe('cimiento')
    expect(marketplace.plugins).toEqual([expect.objectContaining({ name: 'cimiento', source: './plugin' })])
    expect(existsSync(join(ROOT, marketplace.plugins[0].source, '.claude-plugin', 'plugin.json'))).toBe(true)
  })

  it('ships the four skills of spec section 15, each with a name and a description, and no em dash', () => {
    for (const skill of ['setup', 'new-project', 'explain', 'secrets']) {
      const path = join(PLUGIN, 'skills', skill, 'SKILL.md')
      const meta = frontmatter(path)
      expect(meta.name, skill).toBe(skill)
      expect(meta.description?.length ?? 0, skill).toBeGreaterThan(40)
      expect(readFileSync(path, 'utf8')).not.toContain(EM_DASH)
    }
  })

  it('setup runs doctor --json and asks one question at a time; secrets points to cimiento secret set', () => {
    const setup = readFileSync(join(PLUGIN, 'skills', 'setup', 'SKILL.md'), 'utf8')
    expect(setup).toContain('cimiento doctor --json')
    expect(setup).toContain('one question at a time')
    const newProject = readFileSync(join(PLUGIN, 'skills', 'new-project', 'SKILL.md'), 'utf8')
    expect(newProject).toContain('cimiento new <name> --preset <designer|fullstack> --lang <en|es> --json --yes')
    const secrets = readFileSync(join(PLUGIN, 'skills', 'secrets', 'SKILL.md'), 'utf8')
    expect(secrets).toContain('cimiento secret set NAME')
    expect(secrets).toContain('do not repeat it')
  })

  it('registers the .env hook for every tool that can read, change or print a file', () => {
    const hooks = JSON.parse(readFileSync(join(PLUGIN, 'hooks', 'hooks.json'), 'utf8'))
    const entry = hooks.hooks.PreToolUse[0]
    for (const tool of ['Read', 'Edit', 'Write', 'Grep', 'Glob', 'Bash']) expect(entry.matcher.split('|')).toContain(tool)
    expect(entry.hooks[0].command).toContain('${CLAUDE_PLUGIN_ROOT}/scripts/deny-env.mjs')
  })
})

describe('the .env hook', () => {
  const blocked = (event: unknown) => expect(hook(event), JSON.stringify(event)).toBe(2)
  const allowed = (event: unknown) => expect(hook(event), JSON.stringify(event)).toBe(0)

  it('blocks reading, editing and writing any .env file', () => {
    blocked({ tool_name: 'Read', tool_input: { file_path: '/p/app/.env.local' } })
    blocked({ tool_name: 'Read', tool_input: { file_path: '/p/app/.env' } })
    blocked({ tool_name: 'Edit', tool_input: { file_path: '/p/app/.env.production', old_string: 'a', new_string: 'b' } })
    blocked({ tool_name: 'Write', tool_input: { file_path: '/p/app/.env.development.local', content: 'X=1' } })
  })

  it('blocks searching for or in .env files', () => {
    blocked({ tool_name: 'Grep', tool_input: { pattern: 'KEY', path: '/p/app/.env.local' } })
    blocked({ tool_name: 'Grep', tool_input: { pattern: 'KEY', glob: '.env*' } })
    blocked({ tool_name: 'Glob', tool_input: { pattern: '**/.env*' } })
  })

  it('blocks shell commands that name a .env file', () => {
    blocked({ tool_name: 'Bash', tool_input: { command: 'cat .env.local' } })
    blocked({ tool_name: 'Bash', tool_input: { command: 'grep KEY ./.env' } })
    blocked({ tool_name: 'Bash', tool_input: { command: 'source .env && echo $KEY' } })
  })

  it('allows .env.example, which holds names only, and everything else', () => {
    allowed({ tool_name: 'Read', tool_input: { file_path: '/p/app/.env.example' } })
    allowed({ tool_name: 'Read', tool_input: { file_path: '/p/app/src/environment.ts' } })
    allowed({ tool_name: 'Bash', tool_input: { command: 'cat .env.example' } })
    allowed({ tool_name: 'Bash', tool_input: { command: 'node -e "console.log(process.env.HOME)"' } })
    allowed({ tool_name: 'Bash', tool_input: { command: 'cimiento env pull' } })
    allowed({ tool_name: 'Grep', tool_input: { pattern: 'process.env', path: '/p/app/src' } })
  })

  it('lets a malformed event through rather than breaking every tool call', () => {
    const result = spawnSync('node', [join(PLUGIN, 'scripts', 'deny-env.mjs')], { input: 'not json', encoding: 'utf8' })
    expect(result.status).toBe(0)
  })
})
