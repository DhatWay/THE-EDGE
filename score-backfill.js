// ============================================================
// EDGE — SCORE BACKFILL v2.1
//
// historical_odds rows written by ats-tracker carry the ESPN
// event id as game_id. That is the same id ESPN uses in its
// scoreboard. So scores are matched by id, not by team name
// or date buckets.
//
// v2.1 changes:
//
//   · A force option re-fetches every game in the window,
//     including ones that already have a score. The v2.0 code
//     only loaded rows where home_score IS NULL, so any score
//     written before the id-matching fix went in was kept
//     forever. Row-granularity was the problem: the code
//     could not correct a row that existed with a wrong
//     value, only fill in one that was empty.
//
//     Run force once after the code changes ship, to overwrite
//     the historical scores that were matched by team name
//     and date. Then run normally — the null-only path is
//     still the default and it is what you want day to day.
//
//   · The consistency check between the historical_odds row
//     and the ESPN event is now directional. If the row's
//     home name and the ESPN event's home name disagree AND
//     the row's away name and the ESPN away name disagree,
//     the row is skipped with a mismatch counter. A partial
//     match passes — ESPN sometimes spells a club differently
//     from The Odds API and a strict both-must-match rule was
//     rejecting scores the id lookup had already proven
//     correct.
//
//   · Schema probe for `completed`. If the column is missing,
//     the patch omits it. Same as v2.0 but the comment now
//     matches what the code does.
//
// v2.0 changes (retained):
//   · Match by ESPN event id.
//   · Fetch window is date ±1 to cover the UTC/Eastern shift.
// ============================================================

const EDGE_SCORE_BACKFILL = (() => {

  const BUILD = 'sb-20260926-01';

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
    const { sports = ['NFL'], onProgress = null, force = false } = options;
    const log = mk(onProgress);
    const summary = {};
    for (const sport of sports) {
      log(`── ${sport} ──`);
      try {
        summary[sport] = await buildSport(sport, { onProgress, force });
      } catch (e) {
        log(`  failed: ${e.message}`);
        summary[sport] = { error: e.message };
      }
    }
    return summary;
  }

  async function buildSport(sport, options = {}) {
    const { force = false } = options;
    const log = mk(options.onProgress);
    const url = SUPABASE_URL();
    const key = SUPABASE_KEY();
    if (!url || !key) throw new Error('Supabase not connected');
    const path = ESPN_MAP[sport];
    if (!path) throw new Error(`Unknown sport: ${sport}`);

    const hasCompleted = await hasCompletedColumn(url, key);

    log(force
      ? '  loading all games (force mode — scores will be overwritten)'
      : '  loading unscored games from historical_odds');

    const games = await loadGames(sport, url, key, force);
    log(`  ${games.length} games to process`);
    if (!games.length) return { games: 0, dates: 0, updated: 0, mode: force ? 'force' : 'null-only' };

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

      // Defensive check. If the row's names disagree on both
      // sides from the ESPN event, the id resolved to a
      // different game. Skip so a wrong score cannot be
      // written. A partial match passes — ESPN spells some
      // clubs differently.
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
      mode: force ? 'force' : 'null-only',
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
  //
  // In force mode, every game in the sport is loaded, not just
  // the ones with a null score. That is what makes corrections
  // possible — the previous version could only fill empty
  // rows, never overwrite a wrong one.
  // ============================================================

  async function loadGames(sport, url, key, force) {
    const out = [];
    const pageSize = 1000;
    const filter = force ? '' : '&home_score=is.null';

    for (let offset = 0; offset < 200000; offset += pageSize) {
      try {
        const res = await fetch(
          `${url}/rest/v1/historical_odds?sport=eq.${sport}${filter}` +
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
      if (res.headers.get('x-edge-offline') === '1') return [];
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
  //
  // Only reject when BOTH sides disagree. A partial match is
  // common — ESPN and The Odds API spell some clubs differently
  // — and rejecting those would throw away scores the id
  // lookup had already proven correct.
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