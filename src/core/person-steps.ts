// Every person step cimiento can ask for, in English and Spanish, built from what cimiento knows at
// the moment of asking. One builder per step; test/unit/person-steps.test.ts checks every one for
// every part a person needs (BUG-41).

import type { Localized, PersonStep } from './person'

const L = (en: string, es: string): Localized => ({ en, es })

export const URLS = {
  vercelDevice: 'https://vercel.com/oauth/device',
  vercelTeams: 'https://vercel.com/account/teams',
  vercelLoginConnections: 'https://vercel.com/account/authentication',
  vercelGithubApp: 'https://github.com/apps/vercel/installations/new',
  marketplaceSupabase: 'https://vercel.com/marketplace/supabase',
  inngestIntegration: 'https://vercel.com/integrations/inngest',
  githubDevice: 'https://github.com/login/device',
  supabaseCliLogin: 'https://supabase.com/dashboard/cli/login',
  supabaseOrganizations: 'https://supabase.com/dashboard/organizations',
  supabaseProjects: 'https://supabase.com/dashboard/projects',
  cloudflareLogin: 'https://dash.cloudflare.com/oauth2/auth',
  cloudflareAccounts: 'https://dash.cloudflare.com/',
  anthropicKeys: 'https://platform.claude.com/settings/keys',
  githubSignup: 'https://github.com/signup',
  vercelSignup: 'https://vercel.com/signup',
  claudeLogin: 'https://claude.ai/login',
} as const

export function vercelLoginStep(): PersonStep {
  return {
    id: 'vercel.login',
    title: L('Log in to Vercel', 'Inicia sesion en Vercel'),
    url: URLS.vercelDevice,
    path: [
      L('cimiento starts vercel login, which opens this page with your device code already in it', 'cimiento inicia vercel login, que abre esta pagina con tu codigo de dispositivo ya escrito'),
      L('Sign in to Vercel if it asks, the way you always do (for example Continue with GitHub)', 'Inicia sesion en Vercel si lo pide, como siempre (por ejemplo Continue with GitHub)'),
      L('Check that the code on the page is the one vercel login prints in this terminal', 'Comprueba que el codigo de la pagina es el que vercel login muestra en esta terminal'),
    ],
    fields: [{ label: L('Code', 'Code (codigo)'), value: L('already filled in; it must match this terminal', 'ya escrito; debe coincidir con esta terminal') }],
    button: L('Authorize', 'Authorize'),
    success: L('this terminal prints "Congratulations! You are now signed in."', 'esta terminal muestra "Congratulations! You are now signed in."'),
  }
}

/** For someone with no GitHub account yet, before the GitHub login. */
export function githubSignupStep(): PersonStep {
  return {
    id: 'github.signup',
    title: L('Create a free GitHub account', 'Crea una cuenta gratis de GitHub'),
    url: URLS.githubSignup,
    path: [
      L('Fill in the form the page shows', 'Llena el formulario que muestra la pagina'),
      L('Click Create account, then solve the short visual check GitHub shows', 'Haz clic en Create account y resuelve la verificacion visual que muestra GitHub'),
      L('GitHub emails you a code; type it on the page', 'GitHub te envia un codigo por correo; escribelo en la pagina'),
    ],
    fields: [
      { label: L('Email', 'Email (correo)'), value: L('the email address you want to use for your projects', 'el correo que quieres usar para tus proyectos') },
      { label: L('Password', 'Password (contrasena)'), value: L('a new password, at least 15 characters, or 8 with a number and a lowercase letter', 'una contrasena nueva, de al menos 15 caracteres, u 8 con un numero y una minuscula') },
      { label: L('Username', 'Username (usuario)'), value: L('lowercase letters, numbers and dashes; it becomes part of your project addresses', 'minusculas, numeros y guiones; sera parte de las direcciones de tus proyectos') },
      { label: L('Your Country/Region', 'Your Country/Region (pais)'), value: L('where you live', 'donde vives') },
    ],
    button: L('Create account', 'Create account'),
    success: L('GitHub opens your dashboard, signed in with the new username', 'GitHub abre tu panel, con la sesion iniciada con el usuario nuevo'),
  }
}

/** For someone with no Vercel account yet: a free Hobby account through their GitHub login. */
export function vercelSignupStep(): PersonStep {
  return {
    id: 'vercel.signup',
    title: L('Create a free Vercel Hobby account with your GitHub login', 'Crea una cuenta gratis Hobby de Vercel con tu usuario de GitHub'),
    url: URLS.vercelSignup,
    path: [
      L("Under Plan Type, choose I'm working on personal projects, which is the free Hobby plan", "En Plan Type, elige I'm working on personal projects, que es el plan gratis Hobby"),
      L('Type your name and click Continue', 'Escribe tu nombre y haz clic en Continue'),
      L('Click Continue with GitHub, then Authorize Vercel on the GitHub page', 'Haz clic en Continue with GitHub y luego en Authorize Vercel en la pagina de GitHub'),
    ],
    fields: [
      { label: L('Plan Type', 'Plan Type (tipo de plan)'), value: L("I'm working on personal projects (Hobby, free)", "I'm working on personal projects (Hobby, gratis)") },
      { label: L('Your Name', 'Your Name (nombre)'), value: L('your name, as you want it on your Vercel team', 'tu nombre, como lo quieres en tu equipo de Vercel') },
    ],
    button: L('Continue with GitHub', 'Continue with GitHub'),
    success: L('Vercel opens your dashboard, with a team named after you on the Hobby plan', 'Vercel abre tu panel, con un equipo a tu nombre en el plan Hobby'),
  }
}

/** The end of install.sh: Claude Code signs in with a paid Claude plan. */
export function claudeLoginStep(): PersonStep {
  return {
    id: 'claude.login',
    title: L('Log in to Claude Code. It needs a Claude Pro or Max plan; the free plan does not include Claude Code', 'Inicia sesion en Claude Code. Necesita un plan Claude Pro o Max; el plan gratis no incluye Claude Code'),
    url: URLS.claudeLogin,
    path: [
      L('The installer starts claude auth login, which opens this page', 'El instalador inicia claude auth login, que abre esta pagina'),
      L('Sign in with the account that has your Pro or Max plan', 'Inicia sesion con la cuenta que tiene tu plan Pro o Max'),
      L('Claude asks to let Claude Code use your account', 'Claude pide permitir que Claude Code use tu cuenta'),
    ],
    fields: [{ label: L('Email', 'Email (correo)'), value: L('the email of your Claude Pro or Max account', 'el correo de tu cuenta Claude Pro o Max') }],
    button: L('Authorize', 'Authorize'),
    success: L('this terminal says the login succeeded, and claude auth status shows loggedIn true', 'esta terminal dice que el inicio de sesion funciono, y claude auth status muestra loggedIn true'),
  }
}

export function githubLoginStep(): PersonStep {
  return {
    id: 'github.login',
    title: L('Log in to GitHub', 'Inicia sesion en GitHub'),
    url: URLS.githubDevice,
    path: [
      L('cimiento starts gh auth login, which prints a one-time code here and opens this page', 'cimiento inicia gh auth login, que muestra aqui un codigo de un solo uso y abre esta pagina'),
      L('Sign in to GitHub if it asks', 'Inicia sesion en GitHub si lo pide'),
      L('On Device Activation, type the code, click Continue', 'En Device Activation, escribe el codigo y haz clic en Continue'),
    ],
    fields: [{ label: L('Code', 'Code (codigo)'), value: L('the one-time code gh prints in this terminal, for example ABCD-1234', 'el codigo de un solo uso que gh muestra en esta terminal, por ejemplo ABCD-1234') }],
    button: L('Authorize github', 'Authorize github'),
    success: L('the page says "Congratulations, you\'re all set!" and this terminal prints "Logged in as" your handle', 'la pagina dice "Congratulations, you\'re all set!" y esta terminal muestra "Logged in as" con tu usuario'),
  }
}

export function supabaseLoginStep(): PersonStep {
  return {
    id: 'supabase.login',
    title: L('Log in to Supabase', 'Inicia sesion en Supabase'),
    url: URLS.supabaseCliLogin,
    path: [
      L('cimiento starts supabase login, which opens this page', 'cimiento inicia supabase login, que abre esta pagina'),
      L('Sign in to Supabase if it asks', 'Inicia sesion en Supabase si lo pide'),
      L('The page shows a verification code; copy it into this terminal where supabase login asks for it', 'La pagina muestra un codigo de verificacion; copialo en esta terminal donde supabase login lo pide'),
    ],
    fields: [{ label: L('Verification code', 'Verification code (codigo)'), value: L('the code the page shows, typed here in the terminal', 'el codigo que muestra la pagina, escrito aqui en la terminal') }],
    button: L('Authorize Supabase CLI', 'Authorize Supabase CLI'),
    success: L('this terminal prints "You are now logged in."', 'esta terminal muestra "You are now logged in."'),
  }
}

export function cloudflareLoginStep(): PersonStep {
  return {
    id: 'turnstile.login',
    title: L('Log in to Cloudflare, for the Turnstile widget', 'Inicia sesion en Cloudflare, para el widget de Turnstile'),
    url: URLS.cloudflareLogin,
    path: [
      L('cimiento starts wrangler login, which opens this page; wrangler waits two minutes for you', 'cimiento inicia wrangler login, que abre esta pagina; wrangler espera dos minutos'),
      L('Sign in to Cloudflare if it asks', 'Inicia sesion en Cloudflare si lo pide'),
      L('Read the list of permissions Wrangler asks for; it includes Turnstile widgets', 'Lee la lista de permisos que pide Wrangler; incluye los widgets de Turnstile'),
    ],
    fields: [],
    button: L('Allow', 'Allow'),
    success: L('the page says "Authorization granted to Wrangler" and this terminal prints "Successfully logged in."', 'la pagina dice "Authorization granted to Wrangler" y esta terminal muestra "Successfully logged in."'),
  }
}

/**
 * For account choices: the page to compare the options on, then the numbered question here. The
 * page has nothing to fill in, so the step lists no fields (BUG-51); what to look for goes in the
 * path.
 */
function choiceStep(id: string, title: Localized, url: string, view: Localized[], what: Localized, compare: Localized): PersonStep {
  return {
    id,
    title,
    url,
    path: [...view, L(`Look for ${what.en}. ${compare.en}`, `Busca ${what.es}. ${compare.es}`)],
    fields: [],
    button: L('nothing there; come back and type the number of your choice in the list below', 'nada alli; vuelve y escribe el numero de tu eleccion en la lista de abajo'),
    success: L('cimiento says which one it pinned in stack.yaml, and never asks again', 'cimiento dice cual fijo en stack.yaml y no vuelve a preguntar'),
  }
}

export function vercelTeamStep(names: string[]): PersonStep {
  return choiceStep(
    'vercel.team',
    L(`Pick the Vercel team for this project (${names.join(', ')})`, `Elige el equipo de Vercel de este proyecto (${names.join(', ')})`),
    URLS.vercelTeams,
    [L('The page lists every team your login belongs to', 'La pagina lista cada equipo al que pertenece tu cuenta'), L('Find the team this project should live and bill in', 'Busca el equipo donde este proyecto debe vivir y facturar')],
    L('the team this project belongs to', 'el equipo al que pertenece este proyecto'),
    L('Hobby is free; Pro bills the team', 'Hobby es gratis; Pro factura al equipo'),
  )
}

export function supabaseOrganizationStep(names: string[]): PersonStep {
  return choiceStep(
    'supabase.organization',
    L(`Pick the Supabase organization for this project (${names.join(', ')}, or a new one)`, `Elige la organizacion de Supabase de este proyecto (${names.join(', ')}, o una nueva)`),
    URLS.supabaseOrganizations,
    [L('The page lists every organization your login can use', 'La pagina lista cada organizacion que tu cuenta puede usar'), L('Find the one the database should live and bill in, or decide on a new one', 'Busca donde debe vivir y facturar la base de datos, o decide crear una nueva')],
    L('the organization for this database; a new one is created by cimiento with the name it asks for', 'la organizacion de esta base de datos; una nueva la crea cimiento con el nombre que pregunta'),
    L('Free is free and allows 2 active projects per person; Pro and above bill the organization', 'Free es gratis y permite 2 proyectos activos por persona; Pro y superiores facturan a la organizacion'),
  )
}

export function cloudflareAccountStep(names: string[]): PersonStep {
  return choiceStep(
    'turnstile.account',
    L(`Pick the Cloudflare account for the Turnstile widget (${names.join(', ')})`, `Elige la cuenta de Cloudflare para el widget de Turnstile (${names.join(', ')})`),
    URLS.cloudflareAccounts,
    [L('The page opens on the account list of your login', 'La pagina abre la lista de cuentas de tu usuario'), L('Find the account the widget should live in', 'Busca la cuenta donde debe vivir el widget')],
    L('the account for this project', 'la cuenta de este proyecto'),
    L('Turnstile is free on every plan', 'Turnstile es gratis en todos los planes'),
  )
}

export function supabaseFreeLimitStep(counted: string): PersonStep {
  return {
    id: 'supabase.free-limit',
    title: L(`Free a Supabase project slot: 2 active free projects per person, and these count: ${counted}`, `Libera un lugar de proyecto en Supabase: 2 proyectos gratis activos por persona, y cuentan estos: ${counted}`),
    url: URLS.supabaseProjects,
    path: [
      L('Click the project you no longer need, one of the ones listed above', 'Haz clic en el proyecto que ya no necesitas, uno de los de arriba'),
      L('Open Project Settings, then General', 'Abre Project Settings y luego General'),
      L('Scroll to Pause project (keeps the data) or Delete project (removes it)', 'Baja hasta Pause project (conserva los datos) o Delete project (lo borra)'),
    ],
    fields: [{ label: L('Project name, when Delete asks for it', 'Nombre del proyecto, si Delete lo pide'), value: L('the name of that project, typed exactly', 'el nombre de ese proyecto, escrito exacto') }],
    button: L('Pause project, or Delete project', 'Pause project, o Delete project'),
    success: L('the project shows as Paused, or is gone from the list; cimiento then counts again', 'el proyecto aparece como Paused, o ya no esta en la lista; luego cimiento cuenta de nuevo'),
  }
}

export function marketplaceStep(opts: { team?: string; organization?: string }): PersonStep {
  const link = Boolean(opts.organization)
  return {
    id: 'vercel.marketplace-terms',
    title: L('Install Supabase from the Vercel Marketplace', 'Instala Supabase desde el Marketplace de Vercel'),
    url: URLS.marketplaceSupabase,
    path: [
      L('Click Install', 'Haz clic en Install'),
      L(`Choose the Vercel team ${opts.team ?? 'this project uses'}`, `Elige el equipo de Vercel ${opts.team ?? 'de este proyecto'}`),
      L('Read and accept the Marketplace terms', 'Lee y acepta los terminos del Marketplace'),
      link
        ? L(`Choose Link Existing Supabase Account, sign in to Supabase, and grant the organization ${opts.organization}`, `Elige Link Existing Supabase Account, inicia sesion en Supabase y da acceso a la organizacion ${opts.organization}`)
        : L('Choose Create New Supabase Account', 'Elige Create New Supabase Account'),
      L('If Vercel then offers to create a database, close that dialog; cimiento creates it next', 'Si Vercel ofrece crear una base de datos, cierra ese dialogo; cimiento la crea despues'),
    ],
    fields: [{ label: L('Team', 'Team (equipo)'), value: L(opts.team ?? 'the team stack.yaml pins', opts.team ?? 'el equipo que fija stack.yaml') }],
    button: L(link ? 'Link Account' : 'Accept and Create', link ? 'Link Account' : 'Accept and Create'),
    success: L('Supabase shows under Integrations of the team as Installed', 'Supabase aparece en Integrations del equipo como Installed'),
  }
}

/**
 * Vercel needs GitHub connected as a login before it can see any repository. One page, one step
 * (BUG-52); the repository access is the next step, on its own page.
 */
export function githubConnectionStep(): PersonStep {
  return {
    id: 'vercel.github-connection',
    title: L('Connect GitHub to your Vercel account', 'Conecta GitHub a tu cuenta de Vercel'),
    url: URLS.vercelLoginConnections,
    path: [
      L('Find the Login Connections section', 'Busca la seccion Login Connections'),
      L('Next to GitHub, click Connect', 'Junto a GitHub, haz clic en Connect'),
      L('GitHub asks to authorize Vercel; click Authorize Vercel', 'GitHub pide autorizar a Vercel; haz clic en Authorize Vercel'),
    ],
    fields: [],
    button: L('Connect, then Authorize Vercel', 'Connect, luego Authorize Vercel'),
    success: L('Login Connections lists GitHub with your GitHub handle', 'Login Connections muestra GitHub con tu usuario de GitHub'),
  }
}

export function githubAccessStep(opts: { repo: string; connected: boolean; configureUrl?: string }): PersonStep {
  if (!opts.connected) return githubConnectionStep()
  const [owner, name] = opts.repo.split('/')
  const appPage = opts.configureUrl ?? URLS.vercelGithubApp
  const path: Localized[] = []
  if (!opts.configureUrl) path.push(L(`Choose the account ${owner}`, `Elige la cuenta ${owner}`))
  path.push(L('Under Repository access, choose Only select repositories', 'En Repository access, elige Only select repositories'))
  path.push(L(`Open Select repositories and add ${name}`, `Abre Select repositories y agrega ${name}`))
  return {
    id: 'vercel.github-access',
    title: L(`Let Vercel see the private repository ${opts.repo}`, `Deja que Vercel vea el repositorio privado ${opts.repo}`),
    url: appPage,
    path,
    fields: [{ label: L('Repository', 'Repository (repositorio)'), value: L(name, name) }],
    button: L(opts.configureUrl ? 'Save' : 'Install', opts.configureUrl ? 'Save' : 'Install'),
    success: L(`GitHub lists ${name} under the Vercel app's repository access`, `GitHub muestra ${name} en el acceso a repositorios de la app de Vercel`),
  }
}

/**
 * BUG-45: says which Inngest account path to take. A team that already has the integration only
 * adds the project; a team without it takes Create New Inngest Account, which Vercel manages and
 * bills, so the project never lands in an Inngest account cimiento cannot see.
 */
export function inngestIntegrationStep(opts: { team?: string; project: string; installed: boolean }): PersonStep {
  if (opts.installed) {
    return {
      id: 'inngest.vercel-integration',
      title: L(`Add ${opts.project} to the Inngest integration`, `Agrega ${opts.project} a la integracion de Inngest`),
      url: URLS.inngestIntegration,
      path: [
        L('Click Manage', 'Haz clic en Manage'),
        L('Under Projects, click Edit', 'En Projects, haz clic en Edit'),
        L(`Add ${opts.project}, or choose All Projects`, `Agrega ${opts.project}, o elige All Projects`),
        L('No account choice here: the integration already uses the Inngest account linked when it was installed', 'Aqui no se elige cuenta: la integracion ya usa la cuenta de Inngest vinculada al instalarla'),
      ],
      fields: [{ label: L('Projects', 'Projects (proyectos)'), value: L(opts.project, opts.project) }],
      button: L('Save', 'Save'),
      success: L(`${opts.project} shows INNGEST_EVENT_KEY and INNGEST_SIGNING_KEY under Settings, Environment Variables`, `${opts.project} muestra INNGEST_EVENT_KEY e INNGEST_SIGNING_KEY en Settings, Environment Variables`),
    }
  }
  return {
    id: 'inngest.vercel-integration',
    title: L(`Install Inngest on Vercel for ${opts.project}`, `Instala Inngest en Vercel para ${opts.project}`),
    url: URLS.inngestIntegration,
    path: [
      L('Click Install', 'Haz clic en Install'),
      L(`Choose the Vercel team ${opts.team ?? 'this project uses'}`, `Elige el equipo de Vercel ${opts.team ?? 'de este proyecto'}`),
      L(`Under Projects, choose Specific Projects and pick ${opts.project}`, `En Projects, elige Specific Projects y selecciona ${opts.project}`),
      L('When Inngest asks, choose Create New Inngest Account, not Link Existing Inngest Account: Vercel manages it and the free plan applies', 'Cuando Inngest pregunte, elige Create New Inngest Account, no Link Existing Inngest Account: lo maneja Vercel y aplica el plan gratis'),
    ],
    fields: [
      { label: L('Team', 'Team (equipo)'), value: L(opts.team ?? 'the team stack.yaml pins', opts.team ?? 'el equipo que fija stack.yaml') },
      { label: L('Projects', 'Projects (proyectos)'), value: L(`Specific Projects: ${opts.project}`, `Specific Projects: ${opts.project}`) },
      { label: L('Inngest account', 'Inngest account (cuenta)'), value: L('Create New Inngest Account', 'Create New Inngest Account') },
    ],
    button: L('Install, then Create Account', 'Install, luego Create Account'),
    success: L(`the Inngest dashboard opens, and ${opts.project} shows INNGEST_EVENT_KEY and INNGEST_SIGNING_KEY under Settings, Environment Variables`, `se abre el panel de Inngest, y ${opts.project} muestra INNGEST_EVENT_KEY e INNGEST_SIGNING_KEY en Settings, Environment Variables`),
  }
}

/** Where a secret's value is created, for the services cimiento knows. */
const KNOWN_SECRETS: Record<string, { service: string; url: string; button: string; success: Localized }> = {
  ANTHROPIC_API_KEY: {
    service: 'the Claude Console',
    url: URLS.anthropicKeys,
    button: 'Add',
    success: L('a dialog shows the new key, starting with sk-ant-, once, with a Copy button', 'un dialogo muestra la clave nueva, que empieza con sk-ant-, una sola vez, con un boton Copy'),
  },
}

export function secretStep(name: string, projectSlug: string, url?: string): PersonStep | undefined {
  const known = KNOWN_SECRETS[name]
  const page = known?.url ?? url
  if (!page) return undefined
  return {
    id: `secret.${name}`,
    title: L(`Create ${name}${known ? ` in ${known.service}` : ''}; you paste it at a hidden prompt here, never in a chat`, `Crea ${name}${known ? ` en ${known.service}` : ''}; lo pegas aqui en una pregunta oculta, nunca en un chat`),
    url: page,
    path: [
      L('Sign in with the account that should own and pay for this key', 'Inicia sesion con la cuenta que debe ser duena de esta clave y pagarla'),
      L('Click Create Key', 'Haz clic en Create Key'),
    ],
    fields: [
      { label: L('Name', 'Name (nombre)'), value: L(`${projectSlug}, so you can find and revoke it later`, `${projectSlug}, para encontrarla y revocarla despues`) },
      ...(known ? [{ label: L('Workspace', 'Workspace (espacio)'), value: L('Default', 'Default') }] : []),
    ],
    button: L(known?.button ?? 'Create', known?.button ?? 'Create'),
    success: known?.success ?? L('the page shows the new value once; copy it', 'la pagina muestra el valor nuevo una vez; copialo'),
  }
}

/** The title of the person step a plan item stands for, for the list of steps a run asks for. */
export function stepTitleFor(id: string, project: string): Localized | undefined {
  const secret = /^vercel\.env\.([A-Z0-9_]+)\./.exec(id)?.[1]
  if (secret) return secretStep(secret, project)?.title ?? L(`Type ${secret} at a hidden prompt`, `Escribe ${secret} en una pregunta oculta`)
  switch (id) {
    case 'vercel.session':
      return vercelLoginStep().title
    case 'github.session':
      return githubLoginStep().title
    case 'supabase.session':
      return supabaseLoginStep().title
    case 'turnstile.session':
      return cloudflareLoginStep().title
    case 'vercel.github-access':
      return githubAccessStep({ repo: `you/${project}`, connected: true }).title
    case 'vercel.marketplace-terms':
      return marketplaceStep({}).title
    case 'inngest.vercel-integration':
      return inngestIntegrationStep({ project, installed: false }).title
    default:
      return undefined
  }
}

/** One complete example of every step, for the test that checks each one for every part. */
export function everyStepSample(): PersonStep[] {
  return [
    vercelLoginStep(),
    vercelTeamStep(['Fake Team', 'Other Team']),
    githubLoginStep(),
    githubAccessStep({ repo: 'handle/my-app', connected: false }),
    githubAccessStep({ repo: 'handle/my-app', connected: true }),
    githubAccessStep({ repo: 'handle/my-app', connected: true, configureUrl: 'https://github.com/settings/installations/1' }),
    supabaseLoginStep(),
    supabaseOrganizationStep(['Alpha', 'Beta']),
    supabaseFreeLimitStep('old-app (ref1) in Alpha'),
    marketplaceStep({ team: 'Fake Team', organization: 'Alpha' }),
    marketplaceStep({ team: 'Fake Team' }),
    cloudflareLoginStep(),
    cloudflareAccountStep(['A', 'B']),
    inngestIntegrationStep({ team: 'Fake Team', project: 'my-app', installed: false }),
    inngestIntegrationStep({ team: 'Fake Team', project: 'my-app', installed: true }),
    secretStep('ANTHROPIC_API_KEY', 'my-app')!,
    secretStep('OTHER_API_KEY', 'my-app', 'https://example.com/keys')!,
    githubSignupStep(),
    vercelSignupStep(),
    claudeLoginStep(),
  ]
}
