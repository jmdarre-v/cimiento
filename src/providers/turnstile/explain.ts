// Plain language for every resource id and error code this module can produce.

export const TURNSTILE_EXPLAIN: Record<string, { en: string; es?: string }> = {
  'turnstile.tool.wrangler': {
    en: 'Cloudflare wrangler, the command line tool cimiento uses to log in to Cloudflare. cimiento installs it with npm if it is missing.',
    es: 'Cloudflare wrangler, la herramienta de linea de comandos que cimiento usa para iniciar sesion en Cloudflare. cimiento la instala con npm si falta.',
  },
  'turnstile.session': {
    en: 'Being logged in to Cloudflare, with permission to manage Turnstile widgets. cimiento opens your browser once, and asks which Cloudflare account to use if you have more than one.',
    es: 'Tu sesion de Cloudflare, con permiso para manejar widgets de Turnstile. cimiento abre el navegador una vez y pregunta que cuenta usar si tienes mas de una.',
  },
  'turnstile.widget': {
    en: 'The Cloudflare Turnstile widget for this project: the box that tells people from bots without a puzzle. It has a public site key for the page and a secret key for the server, and both go into the hosting env by themselves.',
    es: 'El widget de Cloudflare Turnstile de este proyecto: la casilla que distingue personas de bots sin acertijos. Tiene una clave publica para la pagina y una secreta para el servidor, y ambas van solas al entorno de hosting.',
  },
  'turnstile.binding.domains': {
    en: 'Telling the Turnstile widget which address your site lives at. A widget refuses to load on a host it does not know, so this follows the production address after the first deployment.',
    es: 'Decirle al widget de Turnstile en que direccion vive tu sitio. Un widget no carga en un dominio que no conoce, asi que esto sigue la direccion de produccion despues del primer despliegue.',
  },
  'turnstile.check.verify': {
    en: 'A probe that sends a dummy token to Cloudflare with your secret key. Cloudflare rejects the token and accepts the key, which proves the server side half of bot protection works.',
    es: 'Una prueba que envia un token falso a Cloudflare con tu clave secreta. Cloudflare rechaza el token y acepta la clave, lo que demuestra que la mitad del servidor funciona.',
  },
  TURNSTILE_API_ERROR: {
    en: 'The Cloudflare API refused a Turnstile request. The message has Cloudflare\'s own words for why.',
    es: 'La API de Cloudflare rechazo una solicitud de Turnstile. El mensaje trae la razon que dio Cloudflare.',
  },
  TURNSTILE_WIDGET_NOT_FOUND: {
    en: 'The Turnstile widget this project uses is not in the Cloudflare account anymore, or was never created. cimiento up creates it again and rewrites the keys.',
    es: 'El widget de Turnstile de este proyecto ya no esta en la cuenta de Cloudflare, o nunca se creo. cimiento up lo crea de nuevo y reescribe las claves.',
  },
  TURNSTILE_SECRET_REJECTED: {
    en: 'Cloudflare did not recognize the secret key, so the server could never confirm a real visitor. Usually the widget was deleted or its secret rotated by hand.',
    es: 'Cloudflare no reconocio la clave secreta, asi que el servidor nunca podria confirmar a un visitante real. Casi siempre el widget fue borrado o su secreto cambiado a mano.',
  },
}
