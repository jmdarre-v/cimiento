// Plain language for every Netlify resource id and error code, in English and Spanish.

export const NETLIFY_EXPLAIN: Record<string, { en: string; es?: string }> = {
  'netlify.tool.netlify': {
    en: 'The Netlify command line tool. cimiento uses it to log you in to Netlify, and reads that login to create the site and manage it.',
    es: 'La herramienta de linea de comandos de Netlify. cimiento la usa para iniciar tu sesion en Netlify y lee esa sesion para crear el sitio y administrarlo.',
  },
  'netlify.session': {
    en: 'Your Netlify login on this machine, through the Netlify CLI. cimiento uses it to create the site, set its environment variables and start builds.',
    es: 'Tu sesion de Netlify en esta maquina, con la CLI de Netlify. cimiento la usa para crear el sitio, poner sus variables de entorno e iniciar construcciones.',
  },
  'netlify.project': {
    en: 'The Netlify site that serves this project. Its default address is <name>.netlify.app; site names are global, so the name must be free across Netlify.',
    es: 'El sitio de Netlify que sirve este proyecto. Su direccion es <nombre>.netlify.app; los nombres son globales, asi que debe estar libre en todo Netlify.',
  },
  'netlify.binding.git-repo': {
    en: 'The link between the Netlify site and your GitHub repository: a read only deploy key Netlify clones with, and a webhook so every push builds. Pushing to main updates the live site; pull requests get previews.',
    es: 'El enlace entre el sitio de Netlify y tu repositorio de GitHub: una llave de solo lectura con la que Netlify clona, y un webhook para que cada push construya. Subir a main actualiza el sitio; los pull requests tienen vistas previas.',
  },
  'netlify.deployment': {
    en: 'The production deploy of the site. cimiento starts the first build and builds again when an environment variable changed after the last one.',
    es: 'El despliegue de produccion del sitio. cimiento inicia la primera construccion y construye de nuevo cuando una variable cambio despues de la ultima.',
  },
  'netlify.check.deployed': {
    en: 'A probe that the live address answers 200 with the page cimiento generated.',
    es: 'Una prueba de que la direccion en vivo responde 200 con la pagina que cimiento genero.',
  },
  'netlify.check.secrets-present': {
    en: 'A probe that every declared secret is set in every environment it declares, read from Netlify by name only.',
    es: 'Una prueba de que cada secreto declarado esta en cada entorno que declara, leido de Netlify solo por nombre.',
  },
  'netlify.check.repo-linked': {
    en: 'A probe that Netlify still builds from your GitHub repository and production branch.',
    es: 'Una prueba de que Netlify sigue construyendo desde tu repositorio de GitHub y la rama de produccion.',
  },
  'netlify.check.preview': {
    en: 'A probe that every branch other than production has a ready preview of its latest commit, as a branch deploy or the preview of its pull request.',
    es: 'Una prueba de que cada rama, salvo la de produccion, tiene una vista previa lista de su ultimo commit, como despliegue de rama o vista previa de su pull request.',
  },
  'netlify.binding.domain': {
    en: 'Your own domain on the Netlify site. Your DNS provider needs one record pointing at Netlify; cimiento names it exactly.',
    es: 'Tu propio dominio en el sitio de Netlify. Tu proveedor de DNS necesita un registro que apunte a Netlify; cimiento lo nombra exacto.',
  },
  NETLIFY_TOKEN_MISSING: {
    en: 'cimiento could not find your Netlify login. Run cimiento up in a terminal; it opens the Netlify login in your browser.',
    es: 'cimiento no encontro tu sesion de Netlify. Ejecuta cimiento up en una terminal; abre el inicio de sesion de Netlify en tu navegador.',
  },
  NETLIFY_API_ERROR: {
    en: 'Netlify refused or failed a request. The message says which; running the command again is usually enough.',
    es: 'Netlify rechazo o fallo una solicitud. El mensaje dice cual; normalmente basta con ejecutar el comando de nuevo.',
  },
  NETLIFY_SITE_NAME_TAKEN: {
    en: 'Someone on Netlify already has a site with this name. Set slug in stack.yaml to a name nobody uses yet.',
    es: 'Alguien en Netlify ya tiene un sitio con este nombre. Pon en slug de stack.yaml un nombre que nadie use.',
  },
  NETLIFY_SITE_NOT_FOUND: {
    en: 'The Netlify site is not visible to this login. Run cimiento up to create it, or pin the team it lives in.',
    es: 'El sitio de Netlify no es visible para esta sesion. Ejecuta cimiento up para crearlo, o fija el equipo donde vive.',
  },
  NETLIFY_REPO_LINK_FAILED: {
    en: 'Netlify could not be linked to the GitHub repository. Only an administrator of the repository can add the deploy key and webhook it needs.',
    es: 'No se pudo enlazar Netlify al repositorio de GitHub. Solo un administrador del repositorio puede agregar la llave y el webhook que necesita.',
  },
  NETLIFY_ENV_WRITE_FAILED: {
    en: 'An environment variable could not be written to the Netlify site. Run the command again; it only writes what is missing.',
    es: 'No se pudo escribir una variable de entorno en el sitio de Netlify. Ejecuta el comando de nuevo; solo escribe lo que falta.',
  },
  NETLIFY_DEPLOY_FAILED: {
    en: 'A Netlify build failed. The deploy log in Netlify says why; it is almost always an error in the site\'s code.',
    es: 'Una construccion de Netlify fallo. El registro del despliegue en Netlify dice por que; casi siempre es un error en el codigo del sitio.',
  },
  NETLIFY_DEPLOYMENT_NOT_READY: {
    en: 'The Netlify deploy is not ready yet. A first build takes a few minutes; run cimiento doctor again shortly.',
    es: 'El despliegue de Netlify aun no esta listo. La primera construccion tarda unos minutos; ejecuta cimiento doctor de nuevo en un rato.',
  },
}
