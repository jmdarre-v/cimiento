// Plain language for every resource id and error code this module can produce.

export const INNGEST_EXPLAIN: Record<string, { en: string; es?: string }> = {
  'inngest.vercel-integration': {
    en: 'Inngest runs your background jobs and reaches your app through its Vercel integration. A person approves it once per Vercel team; Inngest then puts its two keys into the project by itself, and cimiento checks they arrived.',
    es: 'Inngest ejecuta tus tareas en segundo plano y llega a tu app por su integracion con Vercel. Una persona la aprueba una vez por equipo de Vercel; Inngest pone sus dos claves en el proyecto y cimiento comprueba que llegaron.',
  },
  'inngest.app': {
    en: 'Registering your app with Inngest Cloud at its production address, so Inngest knows which functions exist and where to call them.',
    es: 'Registrar tu app en Inngest Cloud en su direccion de produccion, para que Inngest sepa que funciones existen y donde llamarlas.',
  },
  'inngest.check.roundtrip': {
    en: 'A probe that sends one real event to Inngest, waits for the function in your app to run it, and asks the Inngest API whether the run completed. It proves jobs work end to end, not just that the pieces exist.',
    es: 'Una prueba que envia un evento real a Inngest, espera a que la funcion de tu app lo ejecute y pregunta a la API de Inngest si termino. Demuestra que las tareas funcionan de punta a punta.',
  },
  INNGEST_KEYS_MISSING: {
    en: 'The Inngest event key or signing key is not where the app reads it. The Inngest Vercel integration puts both into the project; a deployment built before that has neither.',
    es: 'La clave de eventos o la clave de firma de Inngest no estan donde la app las lee. La integracion de Inngest con Vercel pone ambas en el proyecto; un despliegue anterior no tiene ninguna.',
  },
  INNGEST_ENDPOINT_UNREACHABLE: {
    en: 'Inngest calls your app at /api/inngest on the production address, and that address did not answer the way Inngest needs: protected by Vercel, missing from the app, or built without keys.',
    es: 'Inngest llama a tu app en /api/inngest de la direccion de produccion, y esa direccion no respondio como Inngest necesita: protegida por Vercel, ausente en la app o construida sin claves.',
  },
  INNGEST_ROUNDTRIP_FAILED: {
    en: 'An event reached Inngest but the function in your app did not finish running it in time, or Inngest could not tell cimiento about the run.',
    es: 'Un evento llego a Inngest pero la funcion de tu app no termino de ejecutarlo a tiempo, o Inngest no pudo informar a cimiento sobre la ejecucion.',
  },
}
