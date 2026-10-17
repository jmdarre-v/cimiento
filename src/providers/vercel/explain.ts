// Plain language for every resource id and error code this module can produce.

export const VERCEL_EXPLAIN: Record<string, { en: string; es?: string }> = {
  'vercel.tool.vercel': {
    en: 'The Vercel command line tool. cimiento uses it to log in and to send your first deployment.',
    es: 'La herramienta de linea de comandos de Vercel. cimiento la usa para iniciar sesion y enviar el primer despliegue.',
  },
  'vercel.session': {
    en: 'Being logged in to Vercel. cimiento opens your browser once and Vercel remembers this machine.',
    es: 'Tu sesion de Vercel. cimiento abre el navegador una vez y Vercel recuerda esta computadora.',
  },
  'vercel.project': {
    en: 'The Vercel project: the thing that builds your code and puts it on the internet. If a project with this name already exists in the account, cimiento adopts it.',
    es: 'El proyecto de Vercel: lo que construye tu codigo y lo publica en internet. Si ya existe uno con este nombre, cimiento lo adopta.',
  },
  'vercel.binding.git-repo': {
    en: 'The link between your GitHub repository and the Vercel project, so that pushing to main deploys production and opening a pull request makes a preview.',
    es: 'El enlace entre tu repositorio de GitHub y el proyecto de Vercel, para que main despliegue a produccion y los pull requests creen vistas previas.',
  },
  'vercel.deployment': {
    en: 'The first production deployment. This is the step that turns your code into a URL you can open.',
    es: 'El primer despliegue de produccion. Es el paso que convierte tu codigo en una direccion que puedes abrir.',
  },
  'vercel.check.deployed': {
    en: 'A probe that opens your production URL and checks it answers. This is the proof that the project really is live, not just configured.',
    es: 'Una prueba que abre tu direccion de produccion y confirma que responde. Es la prueba de que el proyecto esta realmente en linea.',
  },
  'vercel.check.repo-linked': {
    en: 'A probe that the Vercel project still points at the right GitHub repository and the right production branch.',
    es: 'Una prueba de que el proyecto de Vercel sigue apuntando al repositorio y la rama correctos.',
  },
  'vercel.marketplace-terms': {
    en: 'Vercel asks you to accept the Marketplace terms the first time you install an integration such as Supabase. Only a person can accept them, once per account.',
    es: 'Vercel pide aceptar los terminos del Marketplace la primera vez que instalas una integracion como Supabase. Solo una persona puede aceptarlos, una vez por cuenta.',
  },
  'vercel.binding.supabase-install': {
    en: 'Installing the Supabase integration into your Vercel account, which is how the database gets created and how its keys reach your environment variables automatically.',
    es: 'Instalar la integracion de Supabase en tu cuenta de Vercel, que es como se crea la base de datos y como sus claves llegan a tus variables de entorno.',
  },
  VERCEL_TOKEN_MISSING: {
    en: 'cimiento has no way to talk to the Vercel API. Either the CLI is not logged in yet or the machine has no VERCEL_TOKEN.',
    es: 'cimiento no tiene forma de hablar con la API de Vercel. O la CLI no ha iniciado sesion o la maquina no tiene VERCEL_TOKEN.',
  },
  VERCEL_API_ERROR: {
    en: 'Vercel returned an error cimiento did not expect. The message from Vercel is included above.',
    es: 'Vercel devolvio un error inesperado. El mensaje de Vercel esta incluido arriba.',
  },
  VERCEL_PROJECT_CREATE_FAILED: {
    en: 'Vercel refused to create the project. The usual causes are a name already in use in the team, or a login that belongs to a different team.',
    es: 'Vercel no pudo crear el proyecto. Suele ser un nombre ya usado en el equipo, o una sesion de otro equipo.',
  },
  VERCEL_PROJECT_NOT_FOUND: {
    en: 'cimiento expected a Vercel project with this name and the account cannot see one.',
    es: 'cimiento esperaba un proyecto de Vercel con este nombre y la cuenta no lo ve.',
  },
  VERCEL_GIT_LINK_FAILED: {
    en: 'Vercel could not connect the project to the GitHub repository. Usually the Vercel GitHub app has not been given access to that repository yet.',
    es: 'Vercel no pudo conectar el proyecto con el repositorio de GitHub. Normalmente la app de Vercel en GitHub aun no tiene acceso a ese repositorio.',
  },
  VERCEL_ENV_WRITE_FAILED: {
    en: 'Writing an environment variable into the Vercel project failed. The value is never printed, only the name.',
    es: 'No se pudo escribir una variable de entorno en el proyecto de Vercel. El valor nunca se imprime, solo el nombre.',
  },
  VERCEL_GITHUB_CONNECTION_NEEDED: {
    en: 'Vercel links a project to a GitHub repository through your own GitHub login on Vercel. Your Vercel account has not connected GitHub yet, which is a one time step in your Vercel account settings.',
    es: 'Vercel conecta un proyecto con un repositorio de GitHub a traves de tu propia sesion de GitHub en Vercel. Tu cuenta de Vercel aun no conecto GitHub, un paso unico en la configuracion de tu cuenta.',
  },
  VERCEL_GITHUB_ACCESS_NEEDED: {
    en: 'Vercel can only link a private GitHub repository when your Vercel account has GitHub connected as a login and the Vercel GitHub app can see that repository. cimiento checks both before it tries, opens the page for what is missing, and waits while you do it.',
    es: 'Vercel solo puede conectar un repositorio privado de GitHub si tu cuenta de Vercel tiene GitHub conectado y la app de Vercel en GitHub puede ver ese repositorio. cimiento revisa ambas cosas antes de intentarlo, abre la pagina de lo que falta y espera mientras lo haces.',
  },
  VERCEL_DEPLOY_FAILED: {
    en: 'The deployment did not finish. This is almost always a build error in the application, not in cimiento. The build log link is in the message.',
    es: 'El despliegue no termino. Casi siempre es un error de compilacion de la aplicacion, no de cimiento. El enlace al registro esta en el mensaje.',
  },
  VERCEL_DEPLOYMENT_NOT_READY: {
    en: 'There is a deployment but it is still building, or it never reached a ready state.',
    es: 'Hay un despliegue pero sigue compilando, o nunca llego a estar listo.',
  },
  VERCEL_PLAN_REQUIRED: {
    en: 'This part of the stack needs a paid Vercel plan on the account you are logged in as.',
    es: 'Esta parte del stack necesita un plan pago de Vercel en la cuenta que estas usando.',
  },
  VERCEL_MARKETPLACE_TERMS_PENDING: {
    en: 'The Vercel Marketplace terms have not been accepted on this account yet, so the integration cannot be installed.',
    es: 'Los terminos del Marketplace de Vercel no han sido aceptados en esta cuenta, asi que la integracion no se puede instalar.',
  },
  'vercel.check.secrets-present': {
    en: 'A probe that lists the Vercel env and confirms every secret stack.yaml declares is there, in every environment it declares, without reading a single value.',
    es: 'Una prueba que lista el entorno de Vercel y confirma que cada secreto declarado en stack.yaml esta ahi, en cada entorno declarado, sin leer ningun valor.',
  },
}
