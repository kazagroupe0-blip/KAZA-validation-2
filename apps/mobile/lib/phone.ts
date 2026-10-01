export const BENIN_PHONE_RE = /^\+229\d{10}$/;

export function normalizeBeninPhone(phone: string): string {
  const cleaned = phone.trim().replace(/\s+/g, '');
  return /^\d{10}$/.test(cleaned) ? `+229${cleaned}` : cleaned;
}

export function isValidBeninPhoneNumber(phone: string): boolean {
  return BENIN_PHONE_RE.test(normalizeBeninPhone(phone));
}
