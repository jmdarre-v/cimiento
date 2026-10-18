// Person steps for the v2 providers: Netlify, Neon, Resend, Stripe and PostHog. Same rules as
// person-steps.ts (BUG-41): one page per step, every field with its value, the button and what
// success looks like, in English and Spanish. Every vendor has a sign-up step for someone with no
// account yet, offered before the login or before the page where its key is made.

import type { Localized, PersonStep } from './person'

const L = (en: string, es: string): Localized => ({ en, es })

export const V2_URLS = {
  netlifySignup: 'https://app.netlify.com/signup',
  netlifyAuthorize: 'https://app.netlify.com/authorize',
  netlifyTeams: 'https://app.netlify.com/teams',
  neonSignup: 'https://console.neon.tech/signup',
  neonAuthorize: 'https://console.neon.tech/',
  neonOrganizations: 'https://console.neon.tech/app/projects',
  resendSignup: 'https://resend.com/signup',
  resendKeys: 'https://resend.com/api-keys',
  stripeSignup: 'https://dashboard.stripe.com/register',
  stripeTestKeys: 'https://dashboard.stripe.com/apikeys',
  posthogSignup: 'https://us.posthog.com/signup',
  posthogProjectKey: 'https://us.posthog.com/settings/project',
} as const

/** GitHub sign-in is offered first everywhere it exists, so a person has one login to remember. */
function signupWithGithub(id: string, vendor: string, url: string, extra: Localized[], fields: PersonStep['fields'], success: Localized, free: Localized): PersonStep {
  return {
    id,
    title: L(`Create a free ${vendor} account (${free.en})`, `Crea una cuenta gratis de ${vendor} (${free.es})`),
    url,
    path: [
      L('Click the GitHub button, so this account uses the same login as your code', 'Haz clic en el boton de GitHub, para que esta cuenta use el mismo inicio de sesion que tu codigo'),
      L(`On the GitHub page, click Authorize to let ${vendor} read your name and email`, `En la pagina de GitHub, haz clic en Authorize para que ${vendor} lea tu nombre y correo`),
      ...extra,
    ],
    fields,
    button: L('Continue with GitHub', 'Continue with GitHub'),
    success,
  }
}

export function netlifySignupStep(): PersonStep {
  return signupWithGithub(
    'netlify.signup',
    'Netlify',
    V2_URLS.netlifySignup,
    [
      L('Netlify asks a few questions about how you will use it; answer them, any answer works', 'Netlify hace unas preguntas sobre como lo usaras; respondelas, cualquier respuesta sirve'),
      L('When it offers to deploy a first project, skip it; cimiento creates the site', 'Cuando ofrezca desplegar un primer proyecto, omitelo; cimiento crea el sitio'),
    ],
    [{ label: L('Team name', 'Team name (nombre del equipo)'), value: L('your name, or the name your sites should live under', 'tu nombre, o el nombre bajo el que viviran tus sitios') }],
    L('Netlify opens your team overview, on the free Starter plan', 'Netlify abre el resumen de tu equipo, en el plan gratis Starter'),
    L('Starter plan', 'plan Starter'),
  )
}

export function netlifyLoginStep(): PersonStep {
  return {
    id: 'netlify.login',
    title: L('Log in to Netlify', 'Inicia sesion en Netlify'),
    url: V2_URLS.netlifyAuthorize,
    path: [
      L('cimiento starts netlify login, which opens this page with a ticket for this terminal', 'cimiento inicia netlify login, que abre esta pagina con un ticket para esta terminal'),
      L('Sign in to Netlify if it asks, the way you signed up (for example with GitHub)', 'Inicia sesion en Netlify si lo pide, como te registraste (por ejemplo con GitHub)'),
    ],
    fields: [],
    button: L('Authorize', 'Authorize'),
    success: L('this terminal prints "You are now logged into your Netlify account!"', 'esta terminal muestra "You are now logged into your Netlify account!"'),
  }
}

export function netlifyTeamStep(names: string[]): PersonStep {
  return {
    id: 'netlify.team',
    title: L(`Pick the Netlify team for this project (${names.join(', ')})`, `Elige el equipo de Netlify de este proyecto (${names.join(', ')})`),
    url: V2_URLS.netlifyTeams,
    path: [
      L('The page lists every team your login belongs to', 'La pagina lista cada equipo al que pertenece tu cuenta'),
      L('Find the team this site should live and bill in. Starter is free; paid plans bill the team', 'Busca el equipo donde este sitio debe vivir y facturar. Starter es gratis; los planes de pago facturan al equipo'),
    ],
    fields: [],
    button: L('nothing there; come back and type the number of your choice in the list below', 'nada alli; vuelve y escribe el numero de tu eleccion en la lista de abajo'),
    success: L('cimiento says which one it pinned in stack.yaml, and never asks again', 'cimiento dice cual fijo en stack.yaml y no vuelve a preguntar'),
  }
}

export function neonSignupStep(): PersonStep {
  return signupWithGithub(
    'neon.signup',
    'Neon',
    V2_URLS.neonSignup,
    [L('If Neon offers to create a first project, close it; cimiento creates the project with the right name', 'Si Neon ofrece crear un primer proyecto, cierralo; cimiento crea el proyecto con el nombre correcto')],
    [],
    L('the Neon console opens, signed in, on the Free plan', 'la consola de Neon abre, con la sesion iniciada, en el plan Free'),
    L('Free plan', 'plan Free'),
  )
}

export function neonLoginStep(): PersonStep {
  return {
    id: 'neon.login',
    title: L('Log in to Neon', 'Inicia sesion en Neon'),
    url: V2_URLS.neonAuthorize,
    path: [
      L('cimiento starts neonctl auth, which opens the Neon sign-in in your browser', 'cimiento inicia neonctl auth, que abre el inicio de sesion de Neon en tu navegador'),
      L('Sign in to Neon if it asks, the way you signed up (for example with GitHub)', 'Inicia sesion en Neon si lo pide, como te registraste (por ejemplo con GitHub)'),
      L('Neon asks to let neonctl use your account', 'Neon pide permitir que neonctl use tu cuenta'),
    ],
    fields: [],
    button: L('Authorize', 'Authorize'),
    success: L('the browser says you can close the window, and this terminal returns to cimiento', 'el navegador dice que puedes cerrar la ventana, y esta terminal vuelve a cimiento'),
  }
}

export function neonOrganizationStep(names: string[]): PersonStep {
  return {
    id: 'neon.organization',
    title: L(`Pick the Neon organization for this database (${names.join(', ')})`, `Elige la organizacion de Neon de esta base de datos (${names.join(', ')})`),
    url: V2_URLS.neonOrganizations,
    path: [
      L('The organization menu at the top lists every organization your login can use', 'El menu de organizaciones arriba lista cada organizacion que tu cuenta puede usar'),
      L('Find the one the database should live and bill in. Free allows a few projects per organization', 'Busca donde debe vivir y facturar la base de datos. Free permite unos pocos proyectos por organizacion'),
    ],
    fields: [],
    button: L('nothing there; come back and type the number of your choice in the list below', 'nada alli; vuelve y escribe el numero de tu eleccion en la lista de abajo'),
    success: L('cimiento says which one it pinned in stack.yaml, and never asks again', 'cimiento dice cual fijo en stack.yaml y no vuelve a preguntar'),
  }
}

export function resendSignupStep(): PersonStep {
  return signupWithGithub(
    'resend.signup',
    'Resend',
    V2_URLS.resendSignup,
    [L('Resend may email you a link to confirm the address; click it', 'Resend puede enviarte un enlace para confirmar el correo; haz clic en el')],
    [],
    L('the Resend dashboard opens, signed in', 'el panel de Resend abre, con la sesion iniciada'),
    L('Free plan, 3,000 emails a month', 'plan Free, 3.000 correos al mes'),
  )
}

export function stripeSignupStep(): PersonStep {
  return {
    id: 'stripe.signup',
    title: L('Create a free Stripe account; cimiento only ever uses its test mode', 'Crea una cuenta gratis de Stripe; cimiento solo usa su modo de prueba'),
    url: V2_URLS.stripeSignup,
    path: [
      L('Fill in the form the page shows', 'Llena el formulario que muestra la pagina'),
      L('Stripe emails you a link to verify the address; click it', 'Stripe te envia un enlace para verificar el correo; haz clic en el'),
      L('Skip activating payments: test mode works without it, and cimiento never touches live mode', 'Omite activar los pagos: el modo de prueba funciona sin eso, y cimiento nunca toca el modo real'),
    ],
    fields: [
      { label: L('Email', 'Email (correo)'), value: L('the email you want for this Stripe account', 'el correo que quieres para esta cuenta de Stripe') },
      { label: L('Full name', 'Full name (nombre completo)'), value: L('your name', 'tu nombre') },
      { label: L('Country', 'Country (pais)'), value: L('where you or your business are', 'donde estas tu o tu negocio') },
      { label: L('Password', 'Password (contrasena)'), value: L('a new password for Stripe', 'una contrasena nueva para Stripe') },
    ],
    button: L('Create account', 'Create account'),
    success: L('the Stripe dashboard opens; the test mode or sandbox switch is at the top', 'el panel de Stripe abre; el interruptor de modo de prueba o sandbox esta arriba'),
  }
}

export function posthogSignupStep(): PersonStep {
  return signupWithGithub(
    'posthog.signup',
    'PostHog',
    V2_URLS.posthogSignup,
    [
      L('Choose the US cloud unless stack.yaml says options.posthog.host: eu', 'Elige la nube de US salvo que stack.yaml diga options.posthog.host: eu'),
      L('PostHog asks which products you want; Product analytics is enough, then skip the install instructions', 'PostHog pregunta que productos quieres; Product analytics basta, luego omite las instrucciones de instalacion'),
    ],
    [{ label: L('Organization name', 'Organization name (organizacion)'), value: L('your name or your company', 'tu nombre o tu empresa') }],
    L('PostHog opens a project called Default project', 'PostHog abre un proyecto llamado Default project'),
    L('free up to 1 million events a month', 'gratis hasta 1 millon de eventos al mes'),
  )
}

/** The page where each v2 key is made, and the account to create first when there is none. */
export const V2_SECRETS: Record<
  string,
  { service: string; url: string; path: Localized[]; fields: PersonStep['fields']; button: string; success: Localized; signup: () => PersonStep }
> = {
  RESEND_API_KEY: {
    service: 'Resend',
    url: V2_URLS.resendKeys,
    path: [L('Click Create API Key', 'Haz clic en Create API Key')],
    fields: [{ label: L('Permission', 'Permission (permiso)'), value: L('Sending access', 'Sending access') }],
    button: 'Add',
    success: L('a dialog shows the new key, starting with re_, once, with a copy button', 'un dialogo muestra la clave nueva, que empieza con re_, una sola vez, con un boton para copiar'),
    signup: resendSignupStep,
  },
  STRIPE_SECRET_KEY: {
    service: 'Stripe test mode',
    url: V2_URLS.stripeTestKeys,
    path: [
      L('Switch to your sandbox (or Test mode) at the top of the page; cimiento refuses any live key', 'Cambia a tu sandbox (o Test mode) arriba en la pagina; cimiento rechaza cualquier clave real'),
      L('Under Standard keys, find Secret key and click Reveal test key', 'En Standard keys, busca Secret key y haz clic en Reveal test key'),
    ],
    fields: [],
    button: 'Reveal test key',
    success: L('the key shows, starting with sk_test_; copy it. A key starting with sk_live_ is refused', 'la clave aparece, empezando con sk_test_; copiala. Una clave que empiece con sk_live_ se rechaza'),
    signup: stripeSignupStep,
  },
  NEXT_PUBLIC_STRIPE_PUBLISHABLE_KEY: {
    service: 'Stripe test mode',
    url: V2_URLS.stripeTestKeys,
    path: [
      L('Switch to your sandbox (or Test mode) at the top of the page', 'Cambia a tu sandbox (o Test mode) arriba en la pagina'),
      L('Under Standard keys, find Publishable key, which is shown in full', 'En Standard keys, busca Publishable key, que se muestra completa'),
    ],
    fields: [],
    button: 'the copy icon next to it',
    success: L('the copied key starts with pk_test_. This one is public by design: the page needs it', 'la clave copiada empieza con pk_test_. Esta es publica a proposito: la pagina la necesita'),
    signup: stripeSignupStep,
  },
  NEXT_PUBLIC_POSTHOG_KEY: {
    service: 'PostHog',
    url: V2_URLS.posthogProjectKey,
    path: [
      L('On EU cloud the address starts with eu. instead of us.; the page is the same', 'En la nube EU la direccion empieza con eu. en lugar de us.; la pagina es la misma'),
      L('Find Project token (also called Project API key)', 'Busca Project token (tambien llamado Project API key)'),
    ],
    fields: [],
    button: 'the copy icon next to it',
    success: L('the copied key starts with phc_. It is public by design: the page sends events with it', 'la clave copiada empieza con phc_. Es publica a proposito: la pagina envia eventos con ella'),
    signup: posthogSignupStep,
  },
}

export function v2StepSamples(): PersonStep[] {
  return [
    netlifySignupStep(),
    netlifyLoginStep(),
    netlifyTeamStep(['Team A', 'Team B']),
    neonSignupStep(),
    neonLoginStep(),
    neonOrganizationStep(['Org A', 'Org B']),
    resendSignupStep(),
    stripeSignupStep(),
    posthogSignupStep(),
  ]
}
