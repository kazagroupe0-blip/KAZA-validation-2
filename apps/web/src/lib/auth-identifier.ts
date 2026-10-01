import { BENIN_PHONE_RE, normalizeBeninPhone } from './phone';

export type AuthIdentifier =
  | { type: 'email'; value: string }
  | { type: 'phone'; value: string };

const EMAIL_RE = /^[^\s@]+@[^\s@]+\.[^\s@]+$/;

export function resolveAuthIdentifier(input: string): AuthIdentifier | null {
  const value = input.trim();
  if (!value) return null;

  if (EMAIL_RE.test(value)) {
    return { type: 'email', value: value.toLowerCase() };
  }

  const phone = normalizeBeninPhone(value);
  if (BENIN_PHONE_RE.test(phone)) {
    return { type: 'phone', value: phone };
  }

  return null;
}
