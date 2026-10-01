import { describe, it, expect } from 'vitest';
import { normalizeBeninPhone, BENIN_PHONE_RE } from '../apps/web/src/lib/phone';

const PHONE_RE = /^\+229[0-9]{10}$/;

describe('Benin phone validation (+229 10 digits)', () => {
  it('normalizes local and spaced Benin formats to the canonical E.164 form', () => {
    expect(normalizeBeninPhone('0100000000')).toBe('+2290100000000');
    expect(normalizeBeninPhone('01 00 00 00 00')).toBe('+2290100000000');
    expect(normalizeBeninPhone('+229 01 00 00 00 00')).toBe('+2290100000000');
    expect(normalizeBeninPhone('+2290100000000')).toBe('+2290100000000');
  });

  it('keeps invalid phone values invalid after normalization', () => {
    expect(BENIN_PHONE_RE.test(normalizeBeninPhone('97123456'))).toBe(false);
    expect(BENIN_PHONE_RE.test(normalizeBeninPhone('+225 01 00 00 00 00'))).toBe(false);
  });

  it('accepts valid +229 format', () => {
    expect(PHONE_RE.test('+2290100000000')).toBe(true);
    expect(PHONE_RE.test('+2299712345678')).toBe(true);
    expect(PHONE_RE.test('+2290199887766')).toBe(true);
  });

  it('rejects missing +229 prefix', () => {
    expect(PHONE_RE.test('0100000000')).toBe(false);
    expect(PHONE_RE.test('97123456')).toBe(false);
  });

  it('rejects wrong prefix', () => {
    expect(PHONE_RE.test('+3301000000000')).toBe(false);
    expect(PHONE_RE.test('+2250100000000')).toBe(false);
  });

  it('rejects too few digits', () => {
    expect(PHONE_RE.test('+229010000000')).toBe(false);
    expect(PHONE_RE.test('+22901000000')).toBe(false);
  });

  it('rejects too many digits', () => {
    expect(PHONE_RE.test('+22901000000001')).toBe(false);
    expect(PHONE_RE.test('+229010000000000')).toBe(false);
  });

  it('rejects spaces in number', () => {
    expect(PHONE_RE.test('+229 01 00 00 00 00')).toBe(false);
  });

  it('rejects empty string', () => {
    expect(PHONE_RE.test('')).toBe(false);
  });
});
