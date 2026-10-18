// Plain language for the error codes the engine itself produces, as opposed to the ones a
// provider produces. Spec section 5 asks for an explanation for every code cimiento can emit.

export const CORE_EXPLAIN: Record<string, { en: string; es?: string }> = {
  MANIFEST_INVALID: {
    en: 'stack.yaml has a problem cimiento will not guess its way around. The message lists every field that is wrong, with the rule it broke.',
    es: 'stack.yaml tiene un problema que cimiento no va a adivinar. El mensaje lista cada campo incorrecto y la regla que rompe.',
  },
  MANIFEST_NOT_FOUND: {
    en: 'There is no stack.yaml in this folder, so cimiento does not know what this project is meant to have.',
    es: 'No hay stack.yaml en esta carpeta, asi que cimiento no sabe que debe tener este proyecto.',
  },
  MANIFEST_UNKNOWN_PROVIDER: {
    en: 'stack.yaml names a provider this build of cimiento does not ship a module for.',
    es: 'stack.yaml nombra un proveedor para el que esta version de cimiento no trae un modulo.',
  },
  PLAN_CYCLE: {
    en: 'Two or more steps wait on each other, so there is no order that works. This is a bug in cimiento, not in your project.',
    es: 'Dos o mas pasos se esperan entre si, asi que no hay un orden posible. Es un error de cimiento, no de tu proyecto.',
  },
  PLAN_UNKNOWN_DEPENDENCY: {
    en: 'A step waits on something no provider produces. This is a bug in cimiento, not in your project.',
    es: 'Un paso espera algo que ningun proveedor produce. Es un error de cimiento, no de tu proyecto.',
  },
  DEFERRED_UNRESOLVED: {
    en: 'A step needs a value that only exists after an earlier step runs, such as the production URL, which exists only after the first deployment. Running cimiento up produces it.',
    es: 'Un paso necesita un valor que solo existe despues de un paso anterior, como la direccion de produccion, que existe despues del primer despliegue.',
  },
  STATE_UNREADABLE: {
    en: 'The state file is damaged. cimiento can rebuild it: deleting it and running plan again adopts everything that already exists.',
    es: 'El archivo de estado esta danado. cimiento puede reconstruirlo: borralo y ejecuta plan de nuevo para adoptar lo que ya existe.',
  },
  STATE_VERSION_UNSUPPORTED: {
    en: 'The state file was written by a newer version of cimiento than the one you are running.',
    es: 'El archivo de estado fue escrito por una version de cimiento mas nueva que la que estas usando.',
  },
  SECRET_SOURCE_UNAVAILABLE: {
    en: 'The place this secret is meant to come from could not be read: the keychain or 1Password is locked, or the 1Password command line tool is missing. Running cimiento in a terminal lets them ask you to unlock.',
    es: 'No se pudo leer el lugar de donde viene este secreto: el llavero o 1Password estan bloqueados, o falta la herramienta de 1Password. Ejecutar cimiento en una terminal les permite pedirte que los desbloquees.',
  },
  SECRET_MISSING: {
    en: 'A secret that stack.yaml declares has no value yet, so cimiento cannot push it anywhere. cimiento never invents one and never asks you to paste it into a chat window.',
    es: 'Un secreto declarado en stack.yaml no tiene valor, asi que cimiento no puede enviarlo. cimiento nunca lo inventa ni te pide pegarlo en un chat.',
  },
  SECRET_SINK_UNAVAILABLE: {
    en: 'A secret is declared for a destination this build cannot write to yet.',
    es: 'Un secreto esta declarado para un destino al que esta version no puede escribir todavia.',
  },
  SCAFFOLD_TARGET_EXISTS: {
    en: 'The folder cimiento would create already exists and is not empty. cimiento never writes over work that is already there.',
    es: 'La carpeta que cimiento crearia ya existe y no esta vacia. cimiento nunca escribe sobre trabajo existente.',
  },
  SCAFFOLD_TEMPLATE_UNKNOWN: {
    en: 'stack.yaml asks for a starter template this build does not ship.',
    es: 'stack.yaml pide una plantilla que esta version no incluye.',
  },
  TOOL_MISSING: {
    en: 'A command line tool cimiento needs is not installed, or is not on your PATH.',
    es: 'Una herramienta de linea de comandos que cimiento necesita no esta instalada, o no esta en tu PATH.',
  },
  TOOL_VERSION_TOO_OLD: {
    en: 'A command line tool is installed but too old for what cimiento asks it to do.',
    es: 'Una herramienta esta instalada pero es demasiado vieja para lo que cimiento le pide.',
  },
  TOOL_INSTALL_FAILED: {
    en: 'cimiento tried to install a tool for you and the install command failed. The message from the installer is included.',
    es: 'cimiento intento instalar una herramienta y el instalador fallo. El mensaje del instalador esta incluido.',
  },
  SESSION_MISSING: {
    en: 'You are not logged in to this service yet. cimiento uses the vendor browser login, so nothing is typed into cimiento.',
    es: 'No has iniciado sesion en este servicio. cimiento usa el inicio de sesion del navegador del proveedor, asi que no escribes nada en cimiento.',
  },
  SESSION_ACCOUNT_MISMATCH: {
    en: 'You are logged in, but as a different account than the one stack.yaml pins. cimiento stops rather than deploy your project into the wrong account.',
    es: 'Iniciaste sesion, pero con una cuenta distinta a la que fija stack.yaml. cimiento se detiene en vez de desplegar en la cuenta equivocada.',
  },
  SESSION_LOGIN_FAILED: {
    en: 'The browser login did not finish. Usually the window was closed, or the approval timed out.',
    es: 'El inicio de sesion en el navegador no termino. Normalmente se cerro la ventana o expiro la aprobacion.',
  },
  ACCOUNT_CHOICE_NEEDED: {
    en: 'You have more than one account at this service, for example several Vercel teams, and stack.yaml does not say which one this project belongs to. cimiento asks you once and writes the answer into stack.yaml, because the choice decides who owns and pays for what it creates.',
    es: 'Tienes mas de una cuenta en este servicio, por ejemplo varios equipos de Vercel, y stack.yaml no dice a cual pertenece el proyecto. cimiento te pregunta una vez y guarda la respuesta en stack.yaml.',
  },
  DOWN_CONFIRMATION_NEEDED: {
    en: 'cimiento down deletes real things in your real accounts, so it asks you to type the project name before it starts. In a script, --yes says you already decided.',
    es: 'cimiento down borra cosas reales en tus cuentas, asi que te pide escribir el nombre del proyecto antes de empezar. En un script, --yes indica que ya lo decidiste.',
  },
  BILLING_APPROVAL_NEEDED: {
    en: 'This plan would create something that can cost money, and nobody has said yes to that yet. cimiento lists each item with the account it bills to and that account\'s plan, so you know whose money it is before you approve.',
    es: 'Este plan crearia algo que puede costar dinero, y nadie lo ha aprobado. cimiento lista cada elemento con la cuenta a la que se cobra y su plan, para que sepas de quien es el dinero antes de aprobar.',
  },
  DOWN_LEFTOVER: {
    en: 'cimiento down removed everything it could, but something cimiento created cannot be deleted through the vendor API, such as a Supabase organization. It is listed with a link to the page where you can delete it, and cimiento keeps reporting it until it is gone.',
    es: 'cimiento down borro todo lo que pudo, pero algo que creo no se puede borrar por la API del proveedor, como una organizacion de Supabase. Se lista con el enlace donde puedes borrarla, y cimiento la sigue reportando hasta que desaparezca.',
  },
  CHECK_FAILED: {
    en: 'A probe that is meant to prove something works came back negative. cimiento reports the thing it could not prove, not just the command that exited badly.',
    es: 'Una prueba que deberia confirmar que algo funciona salio negativa. cimiento reporta lo que no pudo probar, no solo el comando que fallo.',
  },
  MANUAL_STEP_PENDING: {
    en: 'A step only a person can do has not been done yet. cimiento shows you the link and continues when you say you are done.',
    es: 'Un paso que solo una persona puede hacer no se ha hecho. cimiento te muestra el enlace y sigue cuando le dices que terminaste.',
  },
  DEV_SERVICE_FAILED: {
    en: 'cimiento dev could not start one of the local services: the database, the jobs dev server or the app. It stops the others so nothing is left running, and the message names the one that failed.',
    es: 'cimiento dev no pudo iniciar uno de los servicios locales: la base de datos, el servidor de tareas o la app. Detiene los demas para no dejar nada corriendo, y el mensaje nombra el que fallo.',
  },
  SECRET_NOT_DECLARED: {
    en: 'The secret named in the command is not in the secrets section of stack.yaml. cimiento only sets, rotates or removes secrets a project declares, and a key only one project needs is declared in that project, not in a preset.',
    es: 'El secreto que nombra el comando no esta en la seccion secrets de stack.yaml. cimiento solo guarda, cambia o quita secretos que el proyecto declara, y una clave que solo un proyecto necesita se declara en ese proyecto, no en un preset.',
  },
  JOIN_NO_STATE: {
    en: 'cimiento join connects this machine to a project that already exists, and this folder has no record of one. The record is .cimiento/state.json, which the repository carries once the project is set up.',
    es: 'cimiento join conecta esta computadora a un proyecto que ya existe, y esta carpeta no tiene registro de uno. El registro es .cimiento/state.json, que el repositorio trae una vez que el proyecto esta configurado.',
  },
  HOSTING_PREVIEW_NOT_READY: {
    en: 'A branch you pushed does not have a working preview yet. The hosting provider builds one for every branch by itself; this usually clears in a minute, unless the build failed.',
    es: 'Una rama que subiste todavia no tiene una vista previa funcionando. El proveedor de hosting construye una por cada rama; normalmente se resuelve en un minuto, salvo que la construccion haya fallado.',
  },
  STRIPE_KEY_INVALID: {
    en: 'Stripe refused the key, or it is not a test key of the right kind. The secret key starts with sk_test_ and the publishable key with pk_test_.',
    es: 'Stripe rechazo la clave, o no es una clave de prueba del tipo correcto. La clave secreta empieza con sk_test_ y la publicable con pk_test_.',
  },
  STRIPE_API_ERROR: {
    en: 'Stripe failed a read only check. This is on the Stripe side; run cimiento doctor again.',
    es: 'Stripe fallo una revision de solo lectura. Es del lado de Stripe; ejecuta cimiento doctor de nuevo.',
  },
  RESEND_KEY_INVALID: {
    en: 'Resend refused the API key. Make a new one at resend.com/api-keys and run cimiento secret rotate RESEND_API_KEY.',
    es: 'Resend rechazo la clave. Crea una nueva en resend.com/api-keys y ejecuta cimiento secret rotate RESEND_API_KEY.',
  },
  RESEND_API_ERROR: {
    en: 'Resend did not send the check email. If it names the sender, use onboarding@resend.dev until your own domain is verified in Resend.',
    es: 'Resend no envio el correo de prueba. Si menciona el remitente, usa onboarding@resend.dev hasta verificar tu propio dominio en Resend.',
  },
  POSTHOG_KEY_INVALID: {
    en: 'The PostHog key is not a project key. Copy the Project token, which starts with phc_, from your PostHog project settings.',
    es: 'La clave de PostHog no es una clave de proyecto. Copia el Project token, que empieza con phc_, de la configuracion de tu proyecto en PostHog.',
  },
  POSTHOG_API_ERROR: {
    en: 'PostHog did not accept the check event. This is on the PostHog side; run cimiento doctor again.',
    es: 'PostHog no acepto el evento de prueba. Es del lado de PostHog; ejecuta cimiento doctor de nuevo.',
  },
  HOSTING_DOMAIN_FAILED: {
    en: 'The custom domain could not be added to or removed from the hosting project. A domain belongs to one project at a time.',
    es: 'No se pudo agregar o quitar el dominio del proyecto de hosting. Un dominio pertenece a un solo proyecto a la vez.',
  },
  HOSTING_DOMAIN_DNS_NEEDED: {
    en: "Your domain is on the hosting project, but its DNS does not point there yet. Add the one record cimiento names where you manage the domain's DNS.",
    es: 'Tu dominio esta en el proyecto de hosting, pero su DNS aun no apunta alli. Agrega el registro que cimiento indica donde administras el DNS del dominio.',
  },
  HOSTING_DOMAIN_NOT_SERVING: {
    en: 'Your domain points at the hosting, but the site does not answer on it yet. The https certificate takes a few minutes; run cimiento doctor again.',
    es: 'Tu dominio apunta al hosting, pero el sitio aun no responde en el. El certificado https tarda unos minutos; ejecuta cimiento doctor de nuevo.',
  },
}
