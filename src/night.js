// Quiet hours: urgent jobs found at night are not alerted one by one; they
// wait in state.night and go out as one batch on the first poll after.

/** Hour of day in Vietnam with minutes as a fraction (23.5 = 23:30). */
export const hourGmt7 = (now) => { const d = new Date(now * 1000); return ((d.getUTCHours() + 7) % 24) + d.getUTCMinutes() / 60; };

/** True inside config.quietHours [from, to] (GMT+7); the window may wrap past midnight. */
export function isQuiet(config, now) {
  const q = config.quietHours;
  if (!Array.isArray(q) || q.length !== 2) return false;
  const [from, to] = q;
  const h = hourGmt7(now);
  return from > to ? h >= from || h < to : h >= from && h < to;
}

/** The date in Vietnam, e.g. "2026-11-20". */
export const dayGmt7 = (now) => new Date((now + 7 * 3600) * 1000).toISOString().slice(0, 10);
