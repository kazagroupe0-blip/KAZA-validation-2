import { describe, expect, it } from 'vitest';
import { formatLocalDateInput, formatLocalMonthInput, monthInputToDate } from '../apps/web/src/lib/date-input';

describe('date input helpers', () => {
  it('formats a local calendar date without UTC shifting', () => {
    expect(formatLocalDateInput(new Date(2026, 9, 1, 0, 30))).toBe('2026-10-01');
  });

  it('formats local months for HTML month inputs', () => {
    expect(formatLocalMonthInput(new Date(2026, 9, 1, 0, 30))).toBe('2026-10');
  });

  it('converts a valid month input to the first calendar day', () => {
    expect(monthInputToDate('2026-10')).toBe('2026-10-01');
  });

  it('rejects malformed month input', () => {
    expect(() => monthInputToDate('2026-13')).toThrow();
    expect(() => monthInputToDate('2026-10-01')).toThrow();
  });
});
