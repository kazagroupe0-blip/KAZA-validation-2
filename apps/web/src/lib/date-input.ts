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
