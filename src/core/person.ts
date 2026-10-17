// A step only a person can do, described the same way everywhere: the page as a full clickable
// link, opened only after Enter, the clicks in order, every field with its value in the order the
// page shows them, the button, what the person sees when it worked, and Enter here when done
// before cimiento verifies it (BUG-41).

import type { Lang } from './types'

export interface Localized {
  en: string
  es: string
}

export interface PersonField {
  label: Localized
  value: Localized
}

export interface PersonStep {
  /** The resource id or the step's own id, such as vercel.login. */
  id: string
  title: Localized
  /** The full page address, opened only after the person presses Enter. */
  url: string
  /** The navigation path, in click order. */
  path: Localized[]
  /** Every field on the page with the value to give it, in the order the page shows them. */
  fields: PersonField[]
  button: Localized
  /** What the person sees when it worked. */
  success: Localized
}

export const STEP_WORDS = {
  open: { en: 'Open:', es: 'Abre:' },
  enterToOpen: { en: 'Press Enter to open it in your browser.', es: 'Pulsa Enter para abrirlo en tu navegador.' },
  path: { en: 'In the browser, in this order:', es: 'En el navegador, en este orden:' },
  fields: { en: 'On the page, in the order it shows them:', es: 'En la pagina, en el orden en que aparecen:' },
  noFields: { en: 'On the page: nothing to type.', es: 'En la pagina: no hay nada que escribir.' },
  button: { en: 'Click:', es: 'Haz clic en:' },
  success: { en: 'When it worked:', es: 'Cuando funciono:' },
  enterWhenDone: { en: 'Press Enter here when done.', es: 'Pulsa Enter aqui cuando termines.' },
  checks: { en: 'cimiento then checks it.', es: 'Luego cimiento lo comprueba.' },
} as const

const ESC = '\u001b'

/** An OSC 8 hyperlink whose visible text is the full address, so it works with or without support. */
export function terminalLink(url: string): string {
  return `${ESC}]8;;${url}${ESC}\\${url}${ESC}]8;;${ESC}\\`
}

export function stripLinks(text: string): string {
  // eslint-disable-next-line no-control-regex
  return text.replace(/\u001b\]8;;[^\u001b]*\u001b\\/g, '')
}

/**
 * The step as lines for a terminal (links on) or for a hint and --json (links off). When the walk
 * itself asks for each Enter, prompts: false leaves those two lines out, so neither is printed
 * twice (BUG-53).
 */
export function renderPersonStep(step: PersonStep, lang: Lang, opts: { links: boolean; prompts?: boolean } = { links: true }): string {
  const prompts = opts.prompts !== false
  const t = (l: Localized) => l[lang] || l.en
  const lines = [
    t(step.title),
    `${t(STEP_WORDS.open)} ${opts.links ? terminalLink(step.url) : step.url}`,
    ...(prompts ? [t(STEP_WORDS.enterToOpen)] : []),
    t(STEP_WORDS.path),
    ...step.path.map((p, i) => `  ${i + 1}. ${t(p)}`),
    ...(step.fields.length
      ? [t(STEP_WORDS.fields), ...step.fields.map((f) => `  ${t(f.label)}: ${t(f.value)}`)]
      : [t(STEP_WORDS.noFields)]),
    `${t(STEP_WORDS.button)} ${t(step.button)}`,
    `${t(STEP_WORDS.success)} ${t(step.success)}`,
    prompts ? `${t(STEP_WORDS.enterWhenDone)} ${t(STEP_WORDS.checks)}` : t(STEP_WORDS.checks),
  ]
  return lines.join('\n')
}

/** What is missing from a step, empty when it is complete in both languages. */
export function missingParts(step: PersonStep): string[] {
  const missing: string[] = []
  const both = (l: Localized | undefined, what: string) => {
    if (!l?.en?.trim()) missing.push(`${what} (en)`)
    if (!l?.es?.trim()) missing.push(`${what} (es)`)
  }
  both(step.title, 'title')
  if (!/^https:\/\/\S+$/.test(step.url)) missing.push('full https url')
  if (step.path.length === 0) missing.push('navigation path')
  step.path.forEach((p, i) => both(p, `path step ${i + 1}`))
  step.fields.forEach((f, i) => {
    both(f.label, `field ${i + 1} label`)
    both(f.value, `field ${i + 1} value`)
  })
  both(step.button, 'button label')
  both(step.success, 'what success looks like')
  return missing
}
