/** Normalise les numéros béninois avant toute persistance ou appel Auth. */
export function normalizeBeninPhone(phone: string): string {
  const cleaned = phone.trim().replace(/\s+/g, '');
  if (/^\d{10}$/.test(cleaned)) return `+229${cleaned}`;
  return cleaned;
}

export const BENIN_PHONE_RE = /^\+229\d{10}$/;
