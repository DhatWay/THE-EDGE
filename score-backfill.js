// ============================================================
// EDGE — SCORE BACKFILL v2.0
//
// historical_odds rows written by ats-tracker carry the ESPN
// event id as game_id. That is the same id ESPN uses in its
// scoreboard. So scores are matched by id, not by team name
// or date buckets.
//
// v2.0 changes:
//
//   · Match by ESPN event id. ats-tracker.js writes
//     historical_odds.game_id from the ESPN event's own id
//     field, so the id is already the link. The old code
//     re-matched by name and UTC date, which is where the
//     doubleheader and next-game-of-series errors came from.
//
//   · Fetch window is date ±1. The Odds API sends UTC; ESPN
//     sends US Eastern. A 10pm Eastern kickoff rolls to the
//     next UTC day, so a single-day fetch could miss it. The
//     id lookup ignores which bucket the event landed in, so
//     a wider window costs nothing but a few more calls.
//
//   · The old fallback (index[home|away] || index[home]) is
//     gone. That shape could match the wrong side of a
//     doubleheader or the wrong game of a series. With id
//     matching, no fallback is needed.
//
//   · Schema probe on `completed`. If the column is missing,
//     the patch omits it rather than 400ing every row.
//
// Run once per sport. Resumable — games already scored are
// skipped.
// ============================================================

const EDGE_SCORE_BACKFILL = (() => {

  const BUILD = 'sb-20260925-01';

  const SUPABASE_URL = () => localStorage.getItem('edge_supabase_url');
  const SUPABASE_KEY = () => localStorage.getItem('edge_supabase_key');

  const ESPN_MAP = {
    NFL:   'football/nfl',
    NCAAF: 'football/college-football',
    NBA:   'basketball/nba',
    WNBA:  'basketball/wnba',
    NCAAB: 'basketball/mens-college-basketball',
    MLB:   'baseball/mlb',
    NHL:   'hockey/nhl',
    MLS:   'soccer/usa.1',
  };

  const FETCH_CONCURRENCY = 4;
  const PATCH_CONCURRENCY = 6;
  const BATCH_SIZE = 200;

  return { BUILD, buildAll, buildSport };

  async function buildAll(options = {}) {
    const { sports = ['NFL'], onProgress = null } = options;
    const log = mk(onProgress);
    const summary = {};
    for (const sport of sports) {
      log(`── ${sport} ──`);
      try {
        summary[sport] = await buildSport(sport, { onProgress });
      } catch (e) {
        log(`  failed: ${e.message}`);
        summary[sport] = { error: e.message };
      }
    }
    return summary;
  }

  async function buildSport(sport, options = {}) {
    const log = mk(options.onProgress);
    const url = SUPABASE_URL();
    const key = SUPABASE_KEY();
    if (!url || !key) throw new Error('Supabase not connected');
    const path = ESPN_MAP[sport];
    if (!path) throw new Error(`Unknown sport: ${sport}`);

    const hasCompleted = await hasCompletedColumn(url, key);

    log('  loading unscored games from historical_odds');
    const games = await loadGames(sport, url, key);
    log(`  ${games.length} games need scores`);
    if (!games.length) return { games: 0, dates: 0, updated: 0 };

    // Bucket rows by their UTC date only to know which ESPN
    // scoreboards to fetch. The id lookup below does not rely
    // on which bucket a game lands in.
    const byDate = {};
    games.forEach(g => {
      const d = (g.game_date || '').slice(0, 10);
      if (!d) return;
      if (!byDate[d]) byDate[d] = [];
      byDate[d].push(g);
    });
    const dates = Object.keys(byDate).sort();
    log(`  ${dates.length} unique dates`);

    // Expand every date to ±1 so an evening Eastern kickoff that
    // rolled to the next UTC day is still covered. Deduped.
    const fetchSet = new Set();
    dates.forEach(d => {
      fetchSet.add(d);
      const base = new Date(d + 'T00:00:00Z');
      if (isNaN(base)) return;
      fetchSet.add(new Date(base.getTime() - 86400000).toISOString().slice(0, 10));
      fetchSet.add(new Date(base.getTime() + 86400000).toISOString().slice(0, 10));
    });
    const uniqueDates = Array.from(fetchSet).sort();
    log(`  fetching ${uniqueDates.length} ESPN scoreboards (window ±1 day)`);

    // Index every ESPN event by its own id. One pass, shared
    // across all games regardless of which date bucket they
    // came from.
    const espnIndex = {};
    await parallelMap(uniqueDates, FETCH_CONCURRENCY, async (date) => {
      const events = await fetchEspnDate(path, date);
      events.forEach(e => { espnIndex[e.id] = e; });
    });
    log(`  ${Object.keys(espnIndex).length} ESPN events indexed`);

    let matched = 0;
    let updated = 0;
    let noMatch = 0;
    let nameMismatch = 0;
    let processed = 0;

    const queue = [];

    for (const g of games) {
      const e = espnIndex[String(g.game_id)];
      if (!e) { noMatch++; continue; }

      // Defensive: if the ESPN event's names do not agree with
      // the row at all, something is off about the id. Skip so
      // a wrong score cannot be written.
      if (!teamsConsistent(g, e)) { nameMismatch++; continue; }

      matched++;
      queue.push({
        game_id: g.game_id,
        home_score: e.homeScore,
        away_score: e.awayScore,
      });

      if (queue.length >= BATCH_SIZE) {
        const batch = queue.splice(0, BATCH_SIZE);
        updated += await patchScores(url, key, batch, hasCompleted);
      }

      processed++;
      if (processed % 500 === 0) {
        log(`    ${processed} checked · ${matched} matched · ${updated} updated`);
      }
    }

    if (queue.length) {
      updated += await patchScores(url, key, queue, hasCompleted);
    }

    log(`  matched ${matched} · updated ${updated} · ${noMatch} no ESPN id · ${nameMismatch} name mismatch`);

    return {
      games: games.length,
      dates: dates.length,
      matched,
      updated,
      no_match: noMatch,
      name_mismatch: nameMismatch,
    };
  }

  // ============================================================
  // ── SCHEMA PROBE ──
  // ============================================================

  async function hasCompletedColumn(url, key) {
    try {
      const res = await fetch(`${url}/rest/v1/historical_odds?select=completed&limit=1`, {
        headers: { apikey: key, Authorization: `Bearer ${key}` },
      });
      return res.ok;
    } catch { return false; }
  }

  // ============================================================
  // ── LOAD ──
  // ============================================================

  async function loadGames(sport, url, key) {
    const out = [];
    const pageSize = 1000;
    for (let offset = 0; offset < 200000; offset += pageSize) {
      try {
        const res = await fetch(
          `${url}/rest/v1/historical_odds?sport=eq.${sport}&home_score=is.null` +
          `&select=game_id,home,away,game_date` +
          `&order=game_date.desc&limit=${pageSize}&offset=${offset}`,
          { headers: { apikey: key, Authorization: `Bearer ${key}` } }
        );
        if (!res.ok) break;
        const rows = await res.json();
        out.push(...rows);
        if (rows.length < pageSize) break;
      } catch { break; }
    }
    return out;
  }

  // ============================================================
  // ── ESPN FETCH ──
  // ============================================================

  async function fetchEspnDate(path, date) {
    const compact = date.replace(/-/g, '');
    const group = /college-football/.test(path) ? 80
                : /college-basketball/.test(path) ? 50
                : null;
    let url = `https://site.api.espn.com/apis/site/v2/sports/${path}/scoreboard?dates=${compact}&limit=500`;
    if (group) url += `&groups=${group}`;

    try {
      const res = await fetch(url, { cache: 'no-store' });
      if (!res.ok) return [];
      const data = await res.json();
      const out = [];
      (data.events || []).forEach(e => {
        const c = e.competitions?.[0];
        if (!c || c.status?.type?.completed !== true) return;
        const h = c.competitors?.find(x => x.homeAway === 'home');
        const a = c.competitors?.find(x => x.homeAway === 'away');
        if (!h || !a) return;
        const hs = parseInt(h.score, 10);
        const as = parseInt(a.score, 10);
        if (!isFinite(hs) || !isFinite(as)) return;
        out.push({
          id: String(e.id),
          homeName: h.team?.displayName,
          awayName: a.team?.displayName,
          homeScore: hs,
          awayScore: as,
        });
      });
      return out;
    } catch { return []; }
  }

  // ============================================================
  // ── CONSISTENCY CHECK ──
  // Lenient. One name agreeing is enough. Two names disagreeing
  // is the case we are protecting against — the id resolved to
  // a different game.
  // ============================================================

  function teamsConsistent(row, e) {
    if (!e.homeName || !e.awayName) return false;
    if (!row.home || !row.away) return true;

    const norm = s => String(s || '').toLowerCase().replace(/[^a-z]/g, '');
    const hOK = norm(row.home) === norm(e.homeName);
    const aOK = norm(row.away) === norm(e.awayName);
    return hOK || aOK;
  }

  // ============================================================
  // ── PATCH ──
  // ============================================================

  async function patchScores(url, key, updates, hasCompleted) {
    let ok = 0;
    await parallelMap(updates, PATCH_CONCURRENCY, async (u) => {
      try {
        const body = {
          home_score: u.home_score,
          away_score: u.away_score,
        };
        if (hasCompleted) body.completed = true;

        const res = await fetch(
          `${url}/rest/v1/historical_odds?game_id=eq.${encodeURIComponent(u.game_id)}`,
          {
            method: 'PATCH',
            headers: {
              apikey: key, Authorization: `Bearer ${key}`,
              'Content-Type': 'application/json',
              Prefer: 'return=minimal',
            },
            body: JSON.stringify(body),
          }
        );
        if (res.ok) ok++;
      } catch {}
    });
    return ok;
  }

  // ============================================================
  // ── UTILITIES ──
  // ============================================================

  async function parallelMap(items, concurrency, fn) {
    const queue = [...items];
    await Promise.all(Array.from({ length: concurrency }, async () => {
      while (queue.length) {
        const item = queue.shift();
        if (item === undefined) break;
        await fn(item);
      }
    }));
  }

  function mk(onProgress) {
    return (m) => { if (typeof onProgress === 'function') onProgress(m); };
  }

})();

if (typeof window !== 'undefined') window.EDGE_SCORE_BACKFILL = EDGE_SCORE_BACKFILL;