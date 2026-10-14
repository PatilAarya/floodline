/** Formatting and clamping helpers shared by the UI. Pure functions. */

export const clamp = (v: number, lo: number, hi: number): number => (v < lo ? lo : v > hi ? hi : v);
export const lerp = (a: number, b: number, t: number): number => a + (b - a) * t;
export const invLerp = (a: number, b: number, v: number): number => (a === b ? 0 : (v - a) / (b - a));

/** Snap v to the nearest multiple of step measured from min, and avoid float noise. */
export function snap(v: number, min: number, step: number): number {
  if (!(step > 0)) return v;
  const n = Math.round((v - min) / step);
  const decimals = Math.max(0, -Math.floor(Math.log10(step)) + 1);
  return Number((min + n * step).toFixed(Math.min(decimals, 10)));
}

/** Minutes as "1 h 05 min" or "42 min". */
export function fmtMinutes(min: number): string {
  if (!Number.isFinite(min)) return 'n/a';
  const m = Math.max(0, Math.round(min));
  if (m < 60) return `${m} min`;
  const h = Math.floor(m / 60);
  return `${h} h ${String(m % 60).padStart(2, '0')} min`;
}

/** Simulation clock: t in minutes as "t+02:15". */
export function fmtClock(min: number): string {
  if (!Number.isFinite(min)) return 't+--:--';
  const m = Math.max(0, Math.floor(min));
  return `t+${String(Math.floor(m / 60)).padStart(2, '0')}:${String(m % 60).padStart(2, '0')}`;
}

export const fmtMetres = (m: number, digits = 2): string => (Number.isFinite(m) ? `${m.toFixed(digits)} m` : 'n/a');
export const fmtPct = (p: number, digits = 0): string => (Number.isFinite(p) ? `${(p * 100).toFixed(digits)}%` : 'n/a');
export const fmtProb = (p: number, digits = 3): string => (Number.isFinite(p) ? p.toFixed(digits) : 'n/a');

export function fmtInt(n: number): string {
  if (!Number.isFinite(n)) return 'n/a';
  return Math.round(n).toLocaleString('en-GB');
}

/** Generic number with a fixed number of decimals. */
export function fmtNum(n: number, digits = 1): string {
  return Number.isFinite(n) ? n.toFixed(digits) : 'n/a';
}

/** Parse a number from an untrusted string (URL hash) and clamp it. */
export function parseClamped(raw: string | null | undefined, fallback: number, lo: number, hi: number): number {
  if (raw == null || raw.length > 32) return fallback;
  const v = Number(raw);
  return Number.isFinite(v) ? clamp(v, lo, hi) : fallback;
}

/** Keep a short, safe seed string from an untrusted source. */
export function sanitizeSeed(raw: string | null | undefined, fallback: string): string {
  if (!raw) return fallback;
  const s = raw.replace(/[^a-zA-Z0-9\-_]/g, '').slice(0, 32);
  return s.length > 0 ? s : fallback;
}
