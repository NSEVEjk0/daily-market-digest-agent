/**
 * Daily Market Digest — schedule math
 * ────────────────────────────────────────────────────────────
 * Owner / Creator: Itachi
 * Made by CRYPTFRANI
 *
 * Pure, side-effect-free helpers that decide WHEN a digest should run.
 * The daemon ticks once a minute and asks `dueSlot()` whether a scheduled
 * slot is currently owed. A slot is identified by a stable local-date key
 * (e.g. "2026-08-23@08:00") so the persisted "already delivered" set makes
 * runs idempotent across restarts.
 *
 * Catch-up is free: we treat a slot as "due" for `graceMs` after its wall time.
 * A process that boots a few minutes late still fires the slot exactly once;
 * a process that's been down for hours past the window simply skips it and
 * waits for the next slot (no thundering blast of stale digests on restart).
 */

/** Minutes-of-day → "HH:MM" (zero-padded). */
export function hhmm(minuteOfDay) {
  const h = Math.floor(minuteOfDay / 60);
  const m = minuteOfDay % 60;
  return `${String(h).padStart(2, '0')}:${String(m).padStart(2, '0')}`;
}

/** Local-time YYYY-MM-DD for a Date. */
function localDateStamp(d) {
  const y = d.getFullYear();
  const mo = String(d.getMonth() + 1).padStart(2, '0');
  const da = String(d.getDate()).padStart(2, '0');
  return `${y}-${mo}-${da}`;
}

/** Build the local Date at `minuteOfDay` on the calendar day of `baseDate`. */
function slotDate(baseDate, minuteOfDay) {
  return new Date(
    baseDate.getFullYear(),
    baseDate.getMonth(),
    baseDate.getDate(),
    Math.floor(minuteOfDay / 60),
    minuteOfDay % 60,
    0,
    0,
  );
}

/** Stable identifier for one slot occurrence, e.g. "2026-08-23@20:00". */
export function slotKey(date, minuteOfDay) {
  return `${localDateStamp(date)}@${hhmm(minuteOfDay)}`;
}

/**
 * Enumerate slot occurrences near `now` (yesterday + today) as
 * { key, min, scheduledTs, scheduledAt }.
 */
function candidates(times, now) {
  const out = [];
  for (const dayOffset of [-1, 0]) {
    const base = new Date(now.getFullYear(), now.getMonth(), now.getDate() + dayOffset);
    for (const min of times) {
      const d = slotDate(base, min);
      out.push({ key: slotKey(d, min), min, scheduledTs: d.getTime(), scheduledAt: d });
    }
  }
  return out;
}

/**
 * The slot that is currently owed, or null.
 * A slot qualifies when its wall time has passed but by no more than `graceMs`.
 * The most recent qualifying slot wins. Idempotency (has it already run?) is the
 * caller's concern — pass a `delivered(key)` predicate to skip finished slots.
 *
 * @param {number[]} times           minutes-of-day, e.g. [480, 1200]
 * @param {object}   opts
 * @param {Date}     [opts.now]
 * @param {number}   [opts.graceMs]  how long after wall time a slot stays due
 * @param {(key:string)=>boolean} [opts.delivered] returns true if key already ran
 */
export function dueSlot(times, { now = new Date(), graceMs = 90 * 60_000, delivered } = {}) {
  if (!Array.isArray(times) || times.length === 0) return null;
  const nowTs = now.getTime();
  const owed = candidates(times, now)
    .filter((c) => c.scheduledTs <= nowTs && nowTs - c.scheduledTs <= graceMs)
    .filter((c) => (delivered ? !delivered(c.key) : true))
    .sort((a, b) => b.scheduledTs - a.scheduledTs);
  return owed[0] ?? null;
}

/**
 * The next slot strictly in the future, as { key, min, scheduledTs, scheduledAt }.
 * Used only for friendly "next digest at …" logging.
 */
export function nextSlot(times, now = new Date()) {
  if (!Array.isArray(times) || times.length === 0) return null;
  const nowTs = now.getTime();
  let best = null;
  for (const dayOffset of [0, 1]) {
    const base = new Date(now.getFullYear(), now.getMonth(), now.getDate() + dayOffset);
    for (const min of times) {
      const d = slotDate(base, min);
      if (d.getTime() > nowTs && (!best || d.getTime() < best.scheduledTs)) {
        best = { key: slotKey(d, min), min, scheduledTs: d.getTime(), scheduledAt: d };
      }
    }
  }
  return best;
}

/** Human summary of the configured schedule, e.g. "08:00, 20:00". */
export function describeSchedule(times) {
  return times.map(hhmm).join(', ');
}

const MONTHS = ['Jan', 'Feb', 'Mar', 'Apr', 'May', 'Jun', 'Jul', 'Aug', 'Sep', 'Oct', 'Nov', 'Dec'];

/** Locale-stable local label for a slot time, e.g. "Aug 24, 20:00". */
export function prettyStamp(date = new Date()) {
  return `${MONTHS[date.getMonth()]} ${date.getDate()}, ${hhmm(date.getHours() * 60 + date.getMinutes())}`;
}

export default { hhmm, slotKey, dueSlot, nextSlot, describeSchedule, prettyStamp };
