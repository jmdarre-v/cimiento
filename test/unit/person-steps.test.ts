// BUG-41: a person step has to say everything: the full page link, Enter to open it (and only
// then), the clicks in order, every field with its value, the button, what success looks like,
// and Enter here when done before cimiento verifies. One test per step, in English and Spanish,
// then the walk itself in a real up run for each kind of step.

import { join } from 'node:path'
import { afterEach, beforeEach, describe, expect, it } from 'vitest'
import { run } from '../../src/cli/index'
import { missingParts, renderPersonStep, STEP_WORDS, terminalLink } from '../../src/core/person'
import { everyStepSample } from '../../src/core/person-steps'
import { clearToolUpdateCache } from '../../src/core/toolkit'
import { clearCloudflareToken } from '../../src/providers/turnstile/api'
import { FakeCloud } from './fake-cloud'
import { CaptureWriter, personDoesIt, removeDir, tempDir, useFakeTokens } from './helpers'

describe('every person step names every part, in en and es', () => {
  for (const step of everyStepSample()) {
    it(`${step.id}: ${step.title.en.slice(0, 60)}`, () => {
      expect(missingParts(step)).toEqual([])
      for (const lang of ['en', 'es'] as const) {
        const text = renderPersonStep(step, lang, { links: true })
        expect(text).toContain(step.title[lang])
        expect(text).toContain(terminalLink(step.url))
        expect(text).toContain(STEP_WORDS.enterToOpen[lang])
        step.path.forEach((p, i) => expect(text).toContain(`${i + 1}. ${p[lang]}`))
        if (step.fields.length === 0) expect(text).toContain(STEP_WORDS.noFields[lang])
        for (const field of step.fields) expect(text).toContain(`${field.label[lang]}: ${field.value[lang]}`)
        expect(text).toContain(`${STEP_WORDS.button[lang]} ${step.button[lang]}`)
        expect(text).toContain(`${STEP_WORDS.success[lang]} ${step.success[lang]}`)
        expect(text).toContain(STEP_WORDS.enterWhenDone[lang])
        // The order the person reads it in: open, path, fields, button, success, done.
        const order = [STEP_WORDS.enterToOpen[lang], STEP_WORDS.path[lang], STEP_WORDS.button[lang], STEP_WORDS.success[lang], STEP_WORDS.enterWhenDone[lang]]
        const at = order.map((w) => text.indexOf(w))
        expect(at).toEqual([...at].sort((a, b) => a - b))
      }
    })
  }

  it('a step missing a part is caught', () => {
    const broken = { ...everyStepSample()[0], button: { en: 'Allow', es: '' }, path: [] }
    expect(missingParts(broken)).toEqual(['navigation path', 'button label (es)'])
  })
})

describe('the walk in a real up run: Enter, then open, then Enter when done, then verify', () => {
  let root: string
  let dir: string
  let configDir: string

  beforeEach(() => {
    useFakeTokens()
    clearCloudflareToken()
    clearToolUpdateCache()
    root = tempDir('cimiento-steps-')
    dir = join(root, 'my-app')
    configDir = tempDir('cimiento-config-')
    process.env.CIMIENTO_CONFIG_DIR = configDir
  })

  afterEach(() => {
    removeDir(root)
    removeDir(configDir)
    delete process.env.CIMIENTO_CONFIG_DIR
  })

  /** One timeline of questions and commands, so the order between them can be checked. */
  async function attended(cloud: FakeCloud, extra: { lang?: 'es'; onManual?: typeof personDoesIt } = {}): Promise<CaptureWriter> {
    const writer = new CaptureWriter()
    await run(['new', 'my-app', '--preset', 'fullstack', '--yes', '--allow-billing', '--dir', dir, ...(extra.lang ? ['--lang', extra.lang] : [])], {
      io: cloud,
      cwd: root,
      writer,
      interactive: true,
      ask: async (question, d) => {
        cloud.execCalls.push(`ASK ${question}`)
        // The person does the browser part between the two Enters.
        if (question.startsWith(STEP_WORDS.enterWhenDone.en) || question.startsWith(STEP_WORDS.enterWhenDone.es)) {
          const opened = [...cloud.execCalls].reverse().find((c) => /^(xdg-)?open /.test(c)) ?? ''
          if (opened.includes('marketplace/supabase')) cloud.acceptMarketplace()
          if (opened.includes('integrations/inngest')) cloud.installInngest()
        }
        return d ?? ''
      },
      choose: async (_q, options) => options[0].value,
      promptHidden: async () => 'fake-typed-key-not-a-real-credential',
      ...(extra.onManual ? { onManual: extra.onManual } : {}),
    })
    return writer
  }

  /** command is written the macOS way; on Linux the opener is xdg-open. */
  function between(cloud: FakeCloud, command: string): void {
    const at = cloud.execCalls.findIndex((c) => c === command || c === `xdg-${command}`)
    expect(at, `${command} never ran`).toBeGreaterThan(0)
    const before = cloud.execCalls.slice(0, at).reverse()
    expect(before.find((c) => c.startsWith('ASK '))).toBe(`ASK ${STEP_WORDS.enterToOpen.en}`)
    expect(cloud.execCalls.slice(at).find((c) => c.startsWith('ASK '))).toBe(`ASK ${STEP_WORDS.enterWhenDone.en}`)
  }

  it('Vercel login: the step is shown, and vercel login starts only after Enter', async () => {
    const cloud = new FakeCloud({ vercelLoggedIn: false, marketplaceDone: true })
    const writer = await attended(cloud)
    expect(writer.outText).toContain('Log in to Vercel')
    between(cloud, 'vercel login')
  })

  it('Cloudflare login: wrangler login starts only after Enter', async () => {
    const cloud = new FakeCloud({ cloudflareLoggedIn: false, marketplaceDone: true })
    const writer = await attended(cloud)
    expect(writer.outText).toContain('Log in to Cloudflare, for the Turnstile widget')
    between(cloud, 'wrangler login')
  })

  it('Vercel team: the step comes before the numbered question', async () => {
    const cloud = new FakeCloud({
      marketplaceDone: true,
      vercelTeams: [
        { id: 'team_a', slug: 'a', name: 'Alpha' },
        { id: 'team_b', slug: 'b', name: 'Beta' },
      ],
    })
    const writer = await attended(cloud)
    expect(writer.outText).toContain('Pick the Vercel team for this project (Alpha (a), Beta (b))')
    between(cloud, 'open https://vercel.com/account/teams')
  })

  it('Inngest integration and Marketplace: the page opens only after the first Enter, and verify follows the second', async () => {
    const cloud = new FakeCloud()
    const writer = await attended(cloud)
    expect(writer.outText).toContain('Install Inngest on Vercel for my-app')
    expect(writer.outText).toContain('Install Supabase from the Vercel Marketplace')
    between(cloud, 'open https://vercel.com/integrations/inngest')
    between(cloud, 'open https://vercel.com/marketplace/supabase')
  })

  it('a secret prompt says where to create the key and its name, before the hidden prompt', async () => {
    const cloud = new FakeCloud({ marketplaceDone: true, keychainEmpty: true })
    const writer = await attended(cloud)
    expect(writer.outText).toContain('Create ANTHROPIC_API_KEY in the Claude Console')
    expect(writer.outText).toContain('Name: my-app, so you can find and revoke it later')
    between(cloud, 'open https://platform.claude.com/settings/keys')
    expect(writer.outText).not.toContain('fake-typed-key-not-a-real-credential')
  })

  it('in Spanish with --lang es', async () => {
    const cloud = new FakeCloud({ cloudflareLoggedIn: false, marketplaceDone: true })
    const writer = await attended(cloud, { lang: 'es' })
    expect(writer.outText).toContain('Inicia sesion en Cloudflare, para el widget de Turnstile')
    expect(cloud.execCalls).toContain(`ASK ${STEP_WORDS.enterToOpen.es}`)
    expect(cloud.execCalls).toContain(`ASK ${STEP_WORDS.enterWhenDone.es}`)
  })

  it('without a terminal, --json carries the structured step and the hint carries the same text', async () => {
    const cloud = new FakeCloud({ marketplaceDone: true, inngestInstalled: false })
    const writer = new CaptureWriter()
    await run(['new', 'my-app', '--preset', 'fullstack', '--json', '--yes', '--allow-billing', '--dir', dir], { io: cloud, cwd: root, writer, interactive: false })
    const manual = writer.jsonObjects().find((o) => (o as { event?: string; id?: string }).event === 'manual' && (o as { id: string }).id === 'inngest.vercel-integration') as {
      step?: { id: string; url: string }
      message: string
    }
    expect(manual.step?.url).toBe('https://vercel.com/integrations/inngest')
    expect(manual.message).toContain('When Inngest asks, choose Create New Inngest Account')
  })
})

describe('person-step format fixes', () => {
  it('BUG-51: an account choice lists no fields, because its page has nothing to fill in', () => {
    for (const step of everyStepSample().filter((s) => ['vercel.team', 'supabase.organization', 'turnstile.account'].includes(s.id))) {
      expect(step.fields, step.id).toEqual([])
    }
  })

  it('BUG-52: every step has one URL, in its link and nowhere else', () => {
    for (const step of everyStepSample()) {
      const text = renderPersonStep(step, 'en', { links: false })
      expect(new Set(text.match(/https:\/\/\S+/g) ?? []), step.id).toEqual(new Set([step.url]))
    }
  })

  it('BUG-53: in a walk, each Enter line is said once, by the prompt, and not printed in the block too', () => {
    const step = everyStepSample()[0]
    const block = renderPersonStep(step, 'en', { links: true, prompts: false })
    expect(block).not.toContain(STEP_WORDS.enterToOpen.en)
    expect(block).not.toContain(STEP_WORDS.enterWhenDone.en)
    const plain = renderPersonStep(step, 'en', { links: false })
    expect(plain.split(STEP_WORDS.enterToOpen.en).length - 1).toBe(1)
  })
})
