// Plain language for every resource id and error code this module can produce.

export const GITHUB_EXPLAIN: Record<string, { en: string; es?: string }> = {
  'github.tool.gh': {
    en: 'The GitHub command line tool. cimiento uses it to log in to GitHub and to create the repository, so it has to be installed first.',
    es: 'La herramienta de linea de comandos de GitHub. cimiento la usa para iniciar sesion y crear el repositorio.',
  },
  'github.tool.git': {
    en: 'Git itself, the program that tracks the history of your code. Everything else depends on it.',
    es: 'Git, el programa que guarda el historial de tu codigo. Todo lo demas depende de el.',
  },
  'github.session': {
    en: 'Being logged in to GitHub. cimiento opens your browser once, you approve, and GitHub remembers the machine.',
    es: 'Tu sesion de GitHub. cimiento abre el navegador una vez, apruebas, y GitHub recuerda esta computadora.',
  },
  'github.repo': {
    en: 'The repository that holds your code on GitHub. If one with this name already exists in your account, cimiento adopts it instead of creating a second one.',
    es: 'El repositorio que guarda tu codigo en GitHub. Si ya existe uno con este nombre, cimiento lo adopta en vez de crear otro.',
  },
  'github.check.repo': {
    en: 'A probe that the repository really is there, reachable by your account, with a default branch.',
    es: 'Una prueba de que el repositorio existe, es accesible con tu cuenta y tiene una rama principal.',
  },
  GITHUB_REPO_CREATE_FAILED: {
    en: 'GitHub refused to create the repository. The usual causes are a name that is already taken, a missing repo scope on your login, or an organization that requires approval.',
    es: 'GitHub no pudo crear el repositorio. Suele ser un nombre ya usado, permisos faltantes o una organizacion que requiere aprobacion.',
  },
  GITHUB_REPO_NOT_FOUND: {
    en: 'cimiento expected a repository at this name and your account cannot see one. It may have been renamed, deleted, or it may belong to another account.',
    es: 'cimiento esperaba un repositorio con este nombre y tu cuenta no lo ve. Puede haber sido renombrado, borrado, o pertenecer a otra cuenta.',
  },
  GITHUB_REPO_NAME_TAKEN: {
    en: 'Another repository in this account already uses this name and it is not the one cimiento manages.',
    es: 'Otro repositorio de esta cuenta ya usa este nombre y no es el que cimiento administra.',
  },
  GITHUB_SCOPE_MISSING: {
    en: 'GitHub logins do not include permission to delete repositories unless someone asks for it. cimiento asks GitHub for that one extra permission in your browser the first time down needs it.',
    es: 'Las sesiones de GitHub no incluyen permiso para borrar repositorios salvo que se pida. cimiento lo pide en tu navegador la primera vez que down lo necesita.',
  },
  GITHUB_PERMISSION_DENIED: {
    en: 'Your GitHub login does not have permission for this action. The token is usually missing the repo or workflow scope.',
    es: 'Tu sesion de GitHub no tiene permiso para esta accion. Normalmente falta el permiso repo o workflow.',
  },
}
