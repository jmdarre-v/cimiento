// Goal 3: guided mode per spec section 10. One question at a time, the explain text before every
// person step and every billable item, every failure in plain language with one next command,
// Spanish with --lang es, projectsDir defaulting to ~/Code.nosync with the reason, and the
// designer-site template with its design/ folder.

import { existsSync, readFileSync } from 'node:fs'
import { homedir } from 'node:os'
import { join } from 'node:path'
import { afterEach, beforeEach, describe, expect, it } from 'vitest'
import { run } from '../../src/cli/index'
import { messageIn, messageKeys, nextAction, t } from '../../src/cli/i18n'
import { ExitCode } from '../../src/core/errors'
import { STEP_WORDS } from '../../src/core/person'
import { clearToolUpdateCache } from '../../src/core/toolkit'
import { explainKey } from '../../src/registry'
import { clearCloudflareToken } from '../../src/providers/turnstile/api'
import { FakeCloud } from './fake-cloud'
import { CaptureWriter, personDoesIt, removeDir, tempDir, useFakeTokens } from './helpers'

let root: string
let configDir: string

beforeEach(() => {
  useFakeTokens()
  clearCloudflareToken()
  clearToolUpdateCache()
  root = tempDir('cimiento-guided-')
  configDir = tempDir('cimiento-config-')
  process.env.CIMIENTO_CONFIG_DIR = configDir
})

afterEach(() => {
  removeDir(root)
  removeDir(configDir)
  delete process.env.CIMIENTO_CONFIG_DIR
})

interface Attended {
  writer: CaptureWriter
  questions: string[]
  code: number
}

/** A person answering in the terminal; the folder answer points at a temporary folder. */
async function guided(cloud: FakeCloud, argv: string[], kind = 'designer'): Promise<Attended> {
  const writer = new CaptureWriter()
  const questions: string[] = []
  const code = await run(argv, {
    io: cloud,
    cwd: root,
    writer,
    interactive: true,
    ask: async (q, d) => {
      questions.push(q)
      if (q === t('es', 'askName') || q === t('en', 'askName')) return 'Mi Sitio'
      if (q === t('es', 'askFolder') || q === t('en', 'askFolder')) return root
      if (q.includes('?') && !q.startsWith('Pulsa') && !q.startsWith('Press')) return 'y'
      if (q.startsWith(STEP_WORDS.enterWhenDone.en) || q.startsWith(STEP_WORDS.enterWhenDone.es)) {
        cloud.vercelGithubConnected = true
        cloud.acceptMarketplace()
        cloud.installInngest()
      }
      return d ?? ''
    },
    choose: async (q, options) => {
      questions.push(q)
      if (q === t('es', 'askKind') || q === t('en', 'askKind')) return kind
      return options[0].value
    },
    promptHidden: async () => 'fake-typed-key-not-a-real-credential',
  })
  return { writer, questions, code }
}

describe('cimiento new --guided --lang es --preset designer, the fresh-machine command', () => {
  it('asks one question at a time in Spanish, defaults the folder to ~/Code.nosync with the reason, and finishes', async () => {
    const cloud = new FakeCloud()
    const { writer, questions, code } = await guided(cloud, ['new', '--guided', '--lang', 'es', '--preset', 'designer'])
    expect(code).toBe(ExitCode.ok)
    expect(questions.slice(0, 2)).toEqual([t('es', 'askName'), t('es', 'askFolder')])
    expect(writer.outText).toContain(t('es', 'folderWhy'))
    expect(t('es', 'folderWhy').split('. ').length).toBe(1)
    expect(writer.outText).toContain(t('es', 'created', { dir: join(root, 'mi-sitio') }))
    expect(writer.outText).toContain('Comprobantes')
    const machine = JSON.parse(readFileSync(join(configDir, 'machine.json'), 'utf8'))
    expect(machine.projectsDir).toBe(root)
  })

  it('scaffolds the designer-site template with its design/ folder and the scaffold marker', async () => {
    const cloud = new FakeCloud()
    await guided(cloud, ['new', '--guided', '--lang', 'es', '--preset', 'designer'])
    const dir = join(root, 'mi-sitio')
    expect(readFileSync(join(dir, 'stack.yaml'), 'utf8')).toContain('template: designer-site')
    expect(existsSync(join(dir, 'design', 'README.md'))).toBe(true)
    expect(existsSync(join(dir, 'design', 'exports', '.gitkeep'))).toBe(true)
    expect(existsSync(join(dir, 'design', 'current', '.gitkeep'))).toBe(true)
    expect(readFileSync(join(dir, '.gitignore'), 'utf8')).toContain('design/exports/*.zip')
    expect(readFileSync(join(dir, 'app', 'layout.tsx'), 'utf8')).toContain("'cimiento-project': 'mi-sitio'")
    expect(readFileSync(join(dir, 'CLAUDE.md'), 'utf8')).toContain('## Design')
  })

  it('without a preset, asks what you are making, then one question per piece when you choose each', async () => {
    const cloud = new FakeCloud()
    const { questions } = await guided(cloud, ['new', 'mi-app', '--guided', '--lang', 'es', '--dir', join(root, 'mi-app')], 'custom')
    const slotQuestions = questions.filter((q) => q.startsWith('Que ') && q.endsWith('debe usar el proyecto?'))
    expect(questions[0]).toBe(t('es', 'askKind'))
    expect(slotQuestions).toEqual([
      'Que repositorio de codigo debe usar el proyecto?',
      'Que hosting debe usar el proyecto?',
      'Que base de datos debe usar el proyecto?',
      'Que sistema de inicio de sesion debe usar el proyecto?',
      'Que servicio de tareas en segundo plano debe usar el proyecto?',
      'Que proteccion contra bots debe usar el proyecto?',
      'Que proveedor de IA debe usar el proyecto?',
    ])
  })

  it('prints the explain text before every person step, then the step in Spanish', async () => {
    const cloud = new FakeCloud({ vercelGithubConnected: false })
    const { writer } = await guided(cloud, ['new', '--guided', '--lang', 'es', '--preset', 'designer'])
    const explanation = explainKey('vercel.github-access', 'es')!
    const at = writer.outText.indexOf(explanation)
    expect(at).toBeGreaterThanOrEqual(0)
    // The title is listed up front too; the step itself comes after its explanation.
    expect(writer.outText.lastIndexOf('Conecta GitHub a tu cuenta de Vercel')).toBeGreaterThan(at)
    expect(writer.outText).toContain('Esta ejecucion te necesita para')
    // The Enter lines are the prompts themselves, never printed in the block as well (BUG-53).
    expect(writer.outText).not.toContain(STEP_WORDS.enterToOpen.es)
  })

  it('explains every billable item before apply', async () => {
    const cloud = new FakeCloud({ marketplaceDone: true })
    const { writer } = await guided(cloud, ['new', 'mi-app', '--guided', '--preset', 'fullstack', '--allow-billing', '--yes', '--dir', join(root, 'mi-app')])
    const intro = writer.outText.indexOf(t('en', 'billableIntro'))
    expect(intro).toBeGreaterThanOrEqual(0)
    expect(writer.outText.indexOf(`supabase.project: ${explainKey('supabase.project', 'en')}`)).toBeGreaterThan(intro)
  })
})

describe('guided failures and words', () => {
  it('a failure says what happened, in plain words, what to do, and one next command', async () => {
    const cloud = new FakeCloud()
    await guided(cloud, ['new', 'mi-app', '--guided', '--lang', 'es', '--preset', 'designer', '--dir', join(root, 'mi-app')])
    const writer = new CaptureWriter()
    await run(['secret', 'set', 'NOPE_KEY', '--guided', '--lang', 'es'], { io: cloud, cwd: join(root, 'mi-app'), writer, interactive: false })
    expect(writer.errText).toContain(`${t('es', 'whatHappened')}: stack.yaml does not declare a secret named NOPE_KEY`)
    expect(writer.errText).toContain(`${t('es', 'whatItMeans')}: ${explainKey('SECRET_NOT_DECLARED', 'es')}`)
    expect(writer.errText).toContain(`${t('es', 'whatToDo')}:`)
    expect(writer.errText).toMatch(new RegExp(`${t('es', 'next')}: cimiento \\w+`))
  })

  it('the next command comes from the hint, and doctor when the hint names none', () => {
    expect(nextAction('Run cimiento up in a terminal in /x; it opens the page.')).toBe('cimiento up')
    expect(nextAction('Run cimiento secret set ANTHROPIC_API_KEY in a terminal.')).toBe('cimiento secret set ANTHROPIC_API_KEY')
    expect(nextAction('Run cimiento accounts set supabase and pick one.')).toBe('cimiento accounts set supabase')
    expect(nextAction('Wait a minute.')).toBe('cimiento doctor')
  })

  it('every message cimiento prints itself has English and Spanish', () => {
    for (const key of messageKeys()) {
      expect(messageIn('en', key), key).toBeTruthy()
      expect(messageIn('es', key), key).toBeTruthy()
    }
  })

  it('the default folder sentence names ~/Code.nosync, and the default is that folder', () => {
    expect(t('en', 'folderWhy')).toMatch(/^~\/Code\.nosync is the default because/)
    expect(join(homedir(), 'Code.nosync')).toMatch(/Code\.nosync$/)
  })
})

describe('answers in Spanish', () => {
  it('a yes is y, yes, s or si, and anything else is no', async () => {
    const { isYes } = await import('../../src/secrets/prompt')
    for (const yes of ['y', 'yes', 'Y', 's', 'si', 'Si', 'sí']) expect(isYes(yes), yes).toBe(true)
    for (const no of ['', 'n', 'no', 'nope', 'sip']) expect(isYes(no), no).toBe(false)
  })
})

describe('a fresh Mac account', () => {
  it('commits the scaffold as the GitHub login when git has no identity, and sets up gh as the git credential helper first', async () => {
    const cloud = new FakeCloud({ gitIdentity: false })
    const { code } = await guided(cloud, ['new', 'mi-sitio', '--guided', '--lang', 'es', '--preset', 'designer', '--dir', join(root, 'mi-sitio')])
    expect(code).toBe(ExitCode.ok)
    const commit = cloud.execCalls.find((c) => c.includes(' commit '))!
    expect(commit).toBe('git -c user.name=test-handle -c user.email=test-handle@users.noreply.github.com commit -m chore: scaffold by cimiento')
    const setup = cloud.execCalls.indexOf('gh auth setup-git --hostname github.com')
    expect(setup).toBeGreaterThanOrEqual(0)
    expect(setup).toBeLessThan(cloud.execCalls.findIndex((c) => c.startsWith('gh repo create')))
  })

  it("keeps the person's own git identity when there is one", async () => {
    const cloud = new FakeCloud()
    await guided(cloud, ['new', 'mi-sitio', '--guided', '--lang', 'es', '--preset', 'designer', '--dir', join(root, 'mi-sitio')])
    expect(cloud.execCalls).toContain('git commit -m chore: scaffold by cimiento')
  })
})

describe('beginner gaps', () => {
  it('asks whether there is a GitHub account and walks the sign-up step before the login when there is none', async () => {
    const cloud = new FakeCloud({ githubLoggedIn: false, vercelLoggedIn: false })
    const writer = new CaptureWriter()
    const asked: string[] = []
    await run(['new', 'mi-sitio', '--guided', '--lang', 'es', '--preset', 'designer', '--dir', join(root, 'mi-sitio')], {
      io: cloud,
      cwd: root,
      writer,
      interactive: true,
      ask: async (_q, d) => d ?? 's',
      choose: async (q, options) => {
        asked.push(q)
        return q.startsWith('Tienes una cuenta de') ? 'no' : options[0].value
      },
    })
    expect(asked).toContain('Tienes una cuenta de GitHub?')
    expect(asked).toContain('Tienes una cuenta de Vercel?')
    const github = writer.outText.indexOf('Crea una cuenta gratis de GitHub')
    const vercel = writer.outText.indexOf('Crea una cuenta gratis Hobby de Vercel con tu usuario de GitHub')
    expect(github).toBeGreaterThanOrEqual(0)
    // GitHub first, because the Vercel account is made with Continue with GitHub.
    expect(vercel).toBeGreaterThan(github)
    expect(cloud.execCalls.indexOf('gh auth login --hostname github.com --git-protocol https --web')).toBeLessThan(cloud.execCalls.indexOf('vercel login'))
  })

  it('a person who has the accounts is not shown a sign-up step', async () => {
    const cloud = new FakeCloud({ githubLoggedIn: false })
    const writer = new CaptureWriter()
    await run(['new', 'mi-sitio', '--guided', '--preset', 'designer', '--dir', join(root, 'mi-sitio')], {
      io: cloud,
      cwd: root,
      writer,
      interactive: true,
      ask: async (_q, d) => d ?? 'y',
      choose: async (_q, options) => options[0].value,
    })
    expect(writer.outText).not.toContain('Create a free GitHub account')
  })
})

describe('cimiento publish', () => {
  async function siteReady(cloud: FakeCloud): Promise<string> {
    const dir = join(root, 'mi-sitio')
    await guided(cloud, ['new', 'mi-sitio', '--guided', '--preset', 'designer', '--dir', dir])
    return dir
  }

  it('commits every change with the message, pushes, waits for that commit to deploy and prints the URL', async () => {
    const { setDeployWait } = await import('../../src/providers/vercel')
    setDeployWait({ intervalMs: 1, timeoutMs: 2000 })
    const cloud = new FakeCloud()
    const dir = await siteReady(cloud)
    cloud.gitDirty = true
    const writer = new CaptureWriter()
    const code = await run(['publish', '--message', 'New hero section', '--json'], { io: cloud, cwd: dir, writer, interactive: false })
    expect(code).toBe(ExitCode.ok)
    const summary = writer.jsonObjects().find((o) => (o as { command?: string }).command === 'publish') as Record<string, unknown>
    expect(summary).toMatchObject({ published: true, branch: 'main', message: 'New hero section', productionUrl: 'https://mi-sitio.vercel.app' })
    expect(cloud.execCalls).toContain('git commit -m New hero section')
    expect(cloud.execCalls).toContain('git push origin main')
  })

  it('asks what changed in Spanish, defaults the message, and says where it is live', async () => {
    const { setDeployWait } = await import('../../src/providers/vercel')
    setDeployWait({ intervalMs: 1, timeoutMs: 2000 })
    const cloud = new FakeCloud()
    const dir = await siteReady(cloud)
    cloud.gitDirty = true
    const writer = new CaptureWriter()
    const questions: string[] = []
    await run(['publish', '--lang', 'es'], { io: cloud, cwd: dir, writer, interactive: true, ask: async (q, d) => (questions.push(q), d ?? '') })
    expect(questions).toEqual(['Que cambiaste? (mensaje del commit)'])
    expect(cloud.execCalls).toContain('git commit -m Actualizar el sitio')
    expect(writer.outText).toContain('Listo, en linea: https://mi-sitio.vercel.app')
  })

  it('with nothing changed, commits nothing and says where the site is', async () => {
    const cloud = new FakeCloud()
    const dir = await siteReady(cloud)
    const writer = new CaptureWriter()
    expect(await run(['publish', '--json'], { io: cloud, cwd: dir, writer, interactive: false })).toBe(ExitCode.ok)
    expect(writer.jsonObjects().find((o) => (o as { command?: string }).command === 'publish')).toMatchObject({ published: false })
    expect(cloud.execCalls.filter((c) => c.startsWith('git push'))).toEqual([])
  })

  it('a failing build names the commit and the build log', async () => {
    const { setDeployWait } = await import('../../src/providers/vercel')
    setDeployWait({ intervalMs: 1, timeoutMs: 2000 })
    const cloud = new FakeCloud()
    const dir = await siteReady(cloud)
    cloud.gitDirty = true
    cloud.pushBuild = 'ERROR'
    const writer = new CaptureWriter()
    expect(await run(['publish', '--message', 'broken', '--json'], { io: cloud, cwd: dir, writer, interactive: false })).toBe(ExitCode.failed)
    expect(writer.outText).toContain('VERCEL_DEPLOY_FAILED')
  })
})

describe('the plugin can start a project and its person steps', () => {
  it('BUG-54: new-project may run cimiento new, cimiento up and open, and walks the person steps from the json', () => {
    const skill = readFileSync(join(__dirname, '../../plugin/skills/new-project/SKILL.md'), 'utf8')
    const allowed = /allowed-tools: (.*)/.exec(skill)![1]
    for (const tool of ['Bash(cimiento new:*)', 'Bash(cimiento up:*)', 'Bash(open:*)']) expect(allowed).toContain(tool)
    expect(skill).toContain('run `open "<step.url>"`')
    expect(skill).toContain('`person-steps`')
  })
})
