// The words cimiento itself prints around plans, person steps and failures, in English and
// Spanish (spec section 10). Provider explanations and person steps carry their own translations.

import type { Lang } from '../core/types'

const MESSAGES = {
  planFor: { en: 'Plan for {name}', es: 'Plan para {name}' },
  status: { en: 'STATUS', es: 'ESTADO' },
  resource: { en: 'RESOURCE', es: 'RECURSO' },
  provider: { en: 'PROVIDER', es: 'PROVEEDOR' },
  detail: { en: 'DETAIL', es: 'DETALLE' },
  action: { en: 'ACTION', es: 'ACCION' },
  urlOrEvidence: { en: 'URL OR EVIDENCE', es: 'URL O EVIDENCIA' },
  warning: { en: 'warning', es: 'aviso' },
  receipts: { en: 'Receipts', es: 'Comprobantes' },
  nothingToDo: { en: 'Nothing to do, everything already matches stack.yaml.', es: 'No hay nada que hacer, todo ya coincide con stack.yaml.' },
  doctor: { en: 'Doctor', es: 'Revision' },
  okFailed: { en: '{ok} ok, {failed} failed', es: '{ok} bien, {failed} con fallas' },
  whatHappened: { en: 'What happened', es: 'Que paso' },
  whatItMeans: { en: 'In plain words', es: 'En palabras simples' },
  whatToDo: { en: 'What to do', es: 'Que hacer' },
  next: { en: 'Next', es: 'Lo siguiente' },
  docs: { en: 'More', es: 'Mas' },
  personStepsAhead: {
    en: 'This run needs you for {steps}, all of them first, in this order:',
    es: 'Esta ejecucion te necesita para {steps}, todos al principio, en este orden:',
  },
  unattended: {
    en: 'That was everything that needs you. The rest runs unattended: {steps}, about {minutes} min. cimiento ends with the receipts.',
    es: 'Eso fue todo lo que te necesita. El resto corre solo: {steps}, unos {minutes} min. cimiento termina con los comprobantes.',
  },
  stillWaiting: {
    en: 'Still waiting on you: {ids}. The rest runs as far as it can without them.',
    es: 'Todavia falta lo tuyo: {ids}. El resto avanza hasta donde puede sin eso.',
  },
  personHasToDo: { en: 'A person has to do this one: {id}', es: 'Esto lo tiene que hacer una persona: {id}' },
  waitingOn: { en: 'Waiting on you: {id}.', es: 'Falta lo tuyo: {id}.' },
  applyPlan: { en: 'Apply this plan?', es: 'Aplicar este plan?' },
  approveBillable: {
    en: 'Approve {items} and continue?',
    es: 'Aprobar {items} y continuar?',
  },
  billableIntro: { en: 'Before anything that can cost money:', es: 'Antes de cualquier cosa que puede costar dinero:' },
  created: { en: 'Created {dir}', es: 'Creado {dir}' },
  files: { en: '  {count} files, including stack.yaml', es: '  {count} archivos, incluido stack.yaml' },
  done: { en: 'Done. cd {dir}', es: 'Listo. cd {dir}' },
  askName: { en: 'What is the project called?', es: 'Como se llama el proyecto?' },
  askFolder: { en: 'Where should cimiento put new projects?', es: 'Donde pone cimiento los proyectos nuevos?' },
  folderWhy: {
    en: '~/Code.nosync is the default because the .nosync ending tells iCloud Drive never to sync it, so thousands of dependency files never slow your Mac down or fill your iCloud.',
    es: '~/Code.nosync es la opcion por defecto porque la terminacion .nosync le dice a iCloud Drive que nunca la sincronice, asi miles de archivos de dependencias no hacen lenta tu Mac ni llenan tu iCloud.',
  },
  askKind: { en: 'What are you making?', es: 'Que vas a hacer?' },
  kindDesigner: {
    en: 'A website from a design: GitHub and Vercel, with a design/ folder for Claude Design exports',
    es: 'Un sitio web a partir de un diseno: GitHub y Vercel, con una carpeta design/ para lo que exportas de Claude Design',
  },
  kindFullstack: {
    en: 'A full app: GitHub, Vercel, Supabase, Inngest, Turnstile and Anthropic',
    es: 'Una app completa: GitHub, Vercel, Supabase, Inngest, Turnstile y Anthropic',
  },
  kindCustom: { en: 'I choose each piece, one question at a time', es: 'Elijo cada pieza, una pregunta a la vez' },
  askSlot: { en: 'Which {slot} should the project use?', es: 'Que {slot} debe usar el proyecto?' },
  none: { en: 'None', es: 'Ninguno' },
  upgradeQuestion: {
    en: 'Newer versions are available: {list}. Upgrade them now?',
    es: 'Hay versiones nuevas: {list}. Actualizarlas ahora?',
  },
} as const

export type MessageKey = keyof typeof MESSAGES

export function steps(lang: Lang, n: number): string {
  return lang === 'es' ? `${n} paso${n === 1 ? '' : 's'}` : `${n} step${n === 1 ? '' : 's'}`
}

export function billableItems(lang: Lang, n: number): string {
  if (lang === 'es') return n === 1 ? 'este elemento con costo' : `estos ${n} elementos con costo`
  return n === 1 ? 'this billable item' : `these ${n} billable items`
}

export function t(lang: Lang, key: MessageKey, vars: Record<string, string | number> = {}): string {
  const template: string = MESSAGES[key][lang] ?? MESSAGES[key].en
  return template.replace(/\{(\w+)\}/g, (_, name: string) => String(vars[name] ?? `{${name}}`))
}

/** Every message has both languages, checked by a test. */
export function messageKeys(): MessageKey[] {
  return Object.keys(MESSAGES) as MessageKey[]
}

export function messageIn(lang: Lang, key: MessageKey): string {
  return MESSAGES[key][lang]
}

const SLOT_NAMES: Record<string, { en: string; es: string }> = {
  repo: { en: 'code repository', es: 'repositorio de codigo' },
  hosting: { en: 'hosting', es: 'hosting' },
  database: { en: 'database', es: 'base de datos' },
  auth: { en: 'login system', es: 'sistema de inicio de sesion' },
  jobs: { en: 'background jobs service', es: 'servicio de tareas en segundo plano' },
  bot_protection: { en: 'bot protection', es: 'proteccion contra bots' },
  ai: { en: 'AI provider', es: 'proveedor de IA' },
}

export function slotName(lang: Lang, slot: string): string {
  return SLOT_NAMES[slot]?.[lang] ?? slot
}

/**
 * The exact next command a failure points at, taken from its hint, so guided mode can end every
 * failure with one thing to run. Falls back to doctor, which always says what is wrong.
 */
export function nextAction(hint: string): string {
  const match =
    /\bcimiento (?:up(?: --allow-billing)?|doctor|plan|down(?: --yes)?|join|dev|env pull|secret (?:set|rotate|remove) [A-Z0-9_]+|accounts set [a-z]+|explain [\w.-]+)/.exec(
      hint,
    )
  return match ? match[0] : 'cimiento doctor'
}
