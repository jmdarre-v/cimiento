// Plain language for every resource id and error code this module can produce.

/** Plain language for a secret carried to the database sink. */
export function databaseSecretExplain(key: string): { en: string; es: string } | undefined {
  const name = /^supabase\.secret\.([A-Z0-9_]+)$/.exec(key)?.[1]
  if (!name) return undefined
  return {
    en: `The secret ${name} stored in the Supabase project, where Edge Functions read it. cimiento writes the value, never prints it, and keeps no copy.`,
    es: `El secreto ${name} guardado en el proyecto de Supabase, donde lo leen las Edge Functions. cimiento escribe el valor, nunca lo imprime y no guarda copia.`,
  }
}

export const SUPABASE_EXPLAIN: Record<string, { en: string; es?: string }> = {
  'supabase.tool.supabase': {
    en: 'The Supabase command line tool. cimiento uses it to log in and to apply your database migrations.',
    es: 'La herramienta de linea de comandos de Supabase. cimiento la usa para iniciar sesion y aplicar las migraciones.',
  },
  'supabase.session': {
    en: 'Being logged in to Supabase. cimiento opens your browser once and Supabase remembers this machine.',
    es: 'Tu sesion de Supabase. cimiento abre el navegador una vez y Supabase recuerda esta computadora.',
  },
  'supabase.project': {
    en: 'Your database, and the login system that comes with it. If a project with this name already exists in your organization, cimiento adopts it instead of creating a second one.',
    es: 'Tu base de datos y el sistema de inicio de sesion que la acompana. Si ya existe un proyecto con este nombre, cimiento lo adopta.',
  },
  'supabase.migrations': {
    en: 'Applying the SQL files in your migrations folder to the database, so the tables your code expects really exist.',
    es: 'Aplicar los archivos SQL de tu carpeta de migraciones a la base de datos, para que las tablas que tu codigo espera existan de verdad.',
  },
  'supabase.check.migrated': {
    en: 'A probe that queries the migration history in the database. This proves the schema is really there, not just that a command exited without an error.',
    es: 'Una prueba que consulta el historial de migraciones en la base de datos. Prueba que el esquema existe de verdad.',
  },
  'supabase.binding.auth-urls': {
    en: 'Telling Supabase which address your site lives at, so that login links and password resets send people back to your site instead of to localhost.',
    es: 'Decirle a Supabase en que direccion vive tu sitio, para que los enlaces de inicio de sesion regresen a tu sitio y no a localhost.',
  },
  'supabase.check.auth-urls': {
    en: 'A probe that the Supabase Site URL matches your production URL. If these drift apart, login silently breaks for real users.',
    es: 'Una prueba de que la direccion del sitio en Supabase coincide con tu direccion de produccion. Si no coinciden, el inicio de sesion falla en silencio.',
  },
  SUPABASE_TOKEN_MISSING: {
    en: 'cimiento has no way to talk to the Supabase API. Either the CLI is not logged in yet or the machine has no SUPABASE_ACCESS_TOKEN.',
    es: 'cimiento no tiene forma de hablar con la API de Supabase. O la CLI no ha iniciado sesion o la maquina no tiene SUPABASE_ACCESS_TOKEN.',
  },
  SUPABASE_API_ERROR: {
    en: 'Supabase returned an error cimiento did not expect. The message from Supabase is included above.',
    es: 'Supabase devolvio un error inesperado. El mensaje de Supabase esta incluido arriba.',
  },
  SUPABASE_PROJECT_CREATE_FAILED: {
    en: 'Supabase refused to create the project. The usual causes are a free tier that already has its two projects, or an organization you cannot create projects in.',
    es: 'Supabase no pudo crear el proyecto. Suele ser que el plan gratuito ya tiene sus dos proyectos, o una organizacion sin permisos.',
  },
  SUPABASE_PROJECT_NOT_FOUND: {
    en: 'cimiento expected a Supabase project with this name and your organizations do not have one.',
    es: 'cimiento esperaba un proyecto de Supabase con este nombre y tus organizaciones no lo tienen.',
  },
  SUPABASE_ORG_MISSING: {
    en: 'cimiento needs to know which Supabase organization to create the project in, and the account has none or has several.',
    es: 'cimiento necesita saber en que organizacion de Supabase crear el proyecto, y la cuenta no tiene ninguna o tiene varias.',
  },
  SUPABASE_MIGRATION_FAILED: {
    en: 'Applying the migrations failed. This is a SQL error in your migration files, not a cimiento error. The database message is included above.',
    es: 'No se pudieron aplicar las migraciones. Es un error de SQL en tus archivos, no de cimiento. El mensaje de la base de datos esta arriba.',
  },
  SUPABASE_AUTH_URL_FAILED: {
    en: 'Writing the Site URL and redirect URLs into Supabase failed, so login links would still point at the wrong address.',
    es: 'No se pudo escribir la direccion del sitio en Supabase, asi que los enlaces de inicio de sesion apuntarian a la direccion equivocada.',
  },
  SUPABASE_DUPLICATE_REFUSED: {
    en: 'Your hosting already points at a Supabase database, but your Supabase login cannot see it. cimiento refuses to create a second database, because your app would then talk to one while cimiento manages the other. Giving your login access to that organization lets cimiento adopt the database that already exists.',
    es: 'Tu hosting ya apunta a una base de datos de Supabase, pero tu sesion de Supabase no la ve. cimiento no crea una segunda base, porque la aplicacion usaria una y cimiento administraria otra. Dar acceso a esa organizacion permite adoptar la que ya existe.',
  },
  SUPABASE_ADOPTION_CONFIRMATION_NEEDED: {
    en: 'Your hosting points at a Supabase database that is older than this project, so it may belong to another app. cimiento will not take it over, or change its login settings, until you say it belongs to this project.',
    es: 'Tu hosting apunta a una base de datos de Supabase mas vieja que este proyecto, asi que puede pertenecer a otra aplicacion. cimiento no la adopta ni cambia su configuracion de inicio de sesion hasta que confirmes que es de este proyecto.',
  },
  SUPABASE_FREE_PROJECT_LIMIT: {
    en: 'Supabase gives each person two active free projects, counted across every organization they own or run, not per organization. When both are in use, a new free project needs an old one paused or deleted, or a paid organization.',
    es: 'Supabase da a cada persona dos proyectos gratuitos activos, contando todas las organizaciones que administra, no por organizacion. Con ambos en uso, hay que pausar o borrar uno viejo, o usar una organizacion paga.',
  },
  SUPABASE_KEYS_MISSING: {
    en: 'The Supabase URL and keys have not reached your hosting environment variables, so the application cannot reach the database.',
    es: 'La direccion y las claves de Supabase no llegaron a las variables de entorno del hosting, asi que la aplicacion no puede llegar a la base de datos.',
  },
  SUPABASE_CONFIGURATION_CHOICE_NEEDED: {
    en: 'Your Vercel team already has Supabase installed, and that installation already holds the database of another project. A new database added through Vercel would land next to it, in an organization Vercel manages, not the one you picked. cimiento asks you first: reuse that installation, or create the database directly in your organization.',
    es: 'Tu equipo de Vercel ya tiene Supabase instalado, y esa instalacion ya tiene la base de datos de otro proyecto. Una base nueva agregada por Vercel quedaria junto a ella, en una organizacion que maneja Vercel, no en la que elegiste. cimiento te pregunta antes: reutilizar esa instalacion o crear la base directamente en tu organizacion.',
  },
}
