export interface EnvReader {
  get(name: string): string | undefined;
}

/**
 * Résout la clé administrateur d'une Edge Function.
 *
 * Ordre : SUPABASE_SECRET_KEYS (dictionnaire JSON, entrée "default"), puis
 * SUPABASE_SERVICE_ROLE_KEY pour les environnements qui ne fournissent pas
 * encore le dictionnaire. Une valeur SUPABASE_SECRET_KEYS présente mais
 * illisible est une erreur de configuration : elle n'est pas masquée par le
 * repli. Les messages d'erreur ne contiennent jamais de valeur de clé.
 * Le préfixe d'une clé n'est volontairement pas utilisé comme preuve de validité.
 */
export function resolveAdminSecretKey(env: EnvReader): string {
  const rawSecretKeys = env.get('SUPABASE_SECRET_KEYS');

  if (rawSecretKeys !== undefined && rawSecretKeys.trim() !== '') {
    let parsed: unknown;
    try {
      parsed = JSON.parse(rawSecretKeys);
    } catch {
      throw new Error('SUPABASE_SECRET_KEYS contient un JSON invalide');
    }

    const candidate =
      parsed !== null && typeof parsed === 'object' && !Array.isArray(parsed)
        ? (parsed as Record<string, unknown>)['default']
        : undefined;

    if (typeof candidate === 'string' && candidate.trim() !== '') {
      return candidate;
    }
  }

  const legacy = env.get('SUPABASE_SERVICE_ROLE_KEY');
  if (legacy !== undefined && legacy.trim() !== '') {
    return legacy;
  }

  throw new Error(
    'Clé administrateur absente : SUPABASE_SECRET_KEYS (entrée default) ou SUPABASE_SERVICE_ROLE_KEY requis',
  );
}
