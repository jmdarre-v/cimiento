// Plain language for every resource id and error code this module can produce.

export const ANTHROPIC_EXPLAIN: Record<string, { en: string; es?: string }> = {
  'anthropic.check.key': {
    en: 'A probe that asks the Anthropic API for its list of models with your key. It costs nothing and proves the key is real, active and allowed to call the API, before your app finds out the hard way.',
    es: 'Una prueba que pide a la API de Anthropic su lista de modelos con tu clave. No cuesta nada y demuestra que la clave es real, esta activa y puede llamar a la API.',
  },
  ANTHROPIC_KEY_INVALID: {
    en: 'The Anthropic API refused the key. It was revoked, mistyped, or belongs to a workspace that cannot call the API. A new key and cimiento secret rotate fix it everywhere at once.',
    es: 'La API de Anthropic rechazo la clave. Fue revocada, esta mal escrita o pertenece a un espacio que no puede llamar a la API. Una clave nueva y cimiento secret rotate lo arreglan en todas partes.',
  },
  ANTHROPIC_API_ERROR: {
    en: 'The Anthropic API answered with an error that is not about the key itself, such as missing credit or a temporary outage.',
    es: 'La API de Anthropic respondio con un error que no es de la clave, como falta de credito o una caida temporal.',
  },
}
