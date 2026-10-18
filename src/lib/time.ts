/** Formats e.g. "2026-10-18 14:02 IST" without relying on Intl tz data. */
export function formatLogTimestamp(date: Date, offsetMinutes: number): string {
  const shifted = new Date(date.getTime() + offsetMinutes * 60_000);
  const iso = shifted.toISOString();
  const label = offsetMinutes === 330 ? "IST" : formatOffset(offsetMinutes);
  return `${iso.slice(0, 10)} ${iso.slice(11, 16)} ${label}`;
}

function formatOffset(minutes: number): string {
  const sign = minutes < 0 ? "-" : "+";
  const abs = Math.abs(minutes);
  return `UTC${sign}${String(Math.floor(abs / 60)).padStart(2, "0")}:${String(abs % 60).padStart(2, "0")}`;
}
