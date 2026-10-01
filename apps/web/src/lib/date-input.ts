/**
 * Format a Date as a local calendar date (YYYY-MM-DD).
 *
 * Calendar dates are not instants. Avoid toISOString().slice(0, 10),
 * because toISOString() serializes the instant in UTC and can shift the
 * displayed calendar date to the previous day around local midnight.
 */
export function formatLocalDateInput(date: Date = new Date()): string {
  const year = date.getFullYear();
  const month = String(date.getMonth() + 1).padStart(2, '0');
  const day = String(date.getDate()).padStart(2, '0');
  return `${year}-${month}-${day}`;
}

/**
 * Format a Date as the value expected by an HTML month input (YYYY-MM).
 */
export function formatLocalMonthInput(date: Date = new Date()): string {
  const year = date.getFullYear();
  const month = String(date.getMonth() + 1).padStart(2, '0');
  return `${year}-${month}`;
}

/**
 * Convert an HTML month input value (YYYY-MM) to the first day of that month.
 *
 * Calendar-date API parameters use YYYY-MM-DD so they remain unambiguous.
 */
export function monthInputToDate(value: string): string {
  if (!/^\d{4}-(0[1-9]|1[0-2])$/.test(value)) {
    throw new Error('Mois invalide — format attendu : YYYY-MM');
  }
  return `${value}-01`;
}
