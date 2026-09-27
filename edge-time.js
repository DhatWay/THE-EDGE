// ============================================================
// EDGE — TIME v1.0
//
// One place for dates and times. Three rules, used everywhere:
//
//   · Stored times are UTC timestamps (ISO strings, timestamptz
//     columns). Supabase, ESPN and The Odds API all send UTC.
//   · A game's day is its US Eastern calendar date. ESPN groups
//     its scoreboards by Eastern date and the sportsbooks list
//     games the same way, so an 8:15pm Eastern kickoff belongs to
//     that evening, not to the next UTC day.
//   · "Today" in the app — bet dates, date pickers, "picks made
//     today" — is the phone's local date.
//
// Modules that need a date call this file when the page loads
// it, and fall back to the same Eastern-time logic inline when it
// doesn't, so a page without the tag still dates games correctly.
// ============================================================

const EDGE_TIME = (() => {
  const BUILD = 'time-20260926-01';
  const SPORTS_TZ = 'America/New_York';

  let _etFormatter = null;
  function etFormatter() {
    if (_etFormatter) return _etFormatter;
    _etFormatter = new Intl.DateTimeFormat('en-US', {
      timeZone: SPORTS_TZ,
      year: 'numeric', month: '2-digit', day: '2-digit',
      hour: '2-digit', minute: '2-digit', hourCycle: 'h23',
    });
    return _etFormatter;
  }

  function toDate(x) {
    if (x instanceof Date) return x;
    if (x == null) return new Date();
    return new Date(x);
  }

  const pad = (n) => String(n).padStart(2, '0');

  // Eastern-time calendar parts of an instant.
  function etParts(x) {
    const d = toDate(x);
    if (isNaN(d)) return null;
    try {
      const out = {};
      etFormatter().formatToParts(d).forEach(p => { if (p.type !== 'literal') out[p.type] = p.value; });
      return {
        y: Number(out.year), m: Number(out.month), d: Number(out.day),
        h: Number(out.hour) % 24, min: Number(out.minute),
      };
    } catch {
      // No time-zone support: the phone's own clock is the best
      // remaining guess.
      return { y: d.getFullYear(), m: d.getMonth() + 1, d: d.getDate(), h: d.getHours(), min: d.getMinutes() };
    }
  }

  // 'YYYY-MM-DD' — the Eastern date a game is played on.
  function gameDay(x) {
    const p = etParts(x);
    return p ? `${p.y}-${pad(p.m)}-${pad(p.d)}` : null;
  }

  // 'YYYYMMDD' — ESPN's ?dates= parameter.
  function espnDate(x) {
    const p = etParts(x);
    return p ? `${p.y}${pad(p.m)}${pad(p.d)}` : null;
  }

  // 0–23 in Eastern time. Primetime is an Eastern-clock idea.
  function etHour(x) {
    const p = etParts(x);
    return p ? p.h : null;
  }

  // 'YYYY-MM-DD' on the phone's own calendar.
  function localDay(x) {
    const d = toDate(x);
    if (isNaN(d)) return null;
    return `${d.getFullYear()}-${pad(d.getMonth() + 1)}-${pad(d.getDate())}`;
  }

  // UTC instants bounding one local calendar day, for filtering
  // timestamptz columns: { start, end } with end exclusive.
  function localDayBoundsIso(dayStr) {
    const [y, m, d] = String(dayStr).split('-').map(Number);
    if (!y || !m || !d) return null;
    return {
      start: new Date(y, m - 1, d, 0, 0, 0, 0).toISOString(),
      end: new Date(y, m - 1, d + 1, 0, 0, 0, 0).toISOString(),
    };
  }

  // Calendar arithmetic on 'YYYY-MM-DD', independent of any zone.
  function shiftDay(dayStr, n) {
    const [y, m, d] = String(dayStr).split('-').map(Number);
    const t = new Date(Date.UTC(y, m - 1, d + n));
    return `${t.getUTCFullYear()}-${pad(t.getUTCMonth() + 1)}-${pad(t.getUTCDate())}`;
  }

  return {
    BUILD,
    SPORTS_TZ,
    etParts,
    gameDay,
    espnDate,
    etHour,
    localDay,
    localDayBoundsIso,
    shiftDay,
  };
})();

if (typeof window !== 'undefined') window.EDGE_TIME = EDGE_TIME;
