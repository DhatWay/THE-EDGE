// ============================================================
// EDGE — SCORE BACKFILL v1.0
//
// historical_odds has spread, no score. Every grading path —
// shadow_picks, ATS, calibration — needs to know who won.
// This walks the table, pulls ESPN scoreboard per date,
// matches on date + team name, and writes home_score / away_score.
//
// Run once per sport. Resumable — games already scored are skipped.
// ============================================================

const EDGE_SCORE_BACKFILL = (() => {

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

  return { buildAll, buildSport };

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

    log('  loading unscored games from historical_odds');
    const games = await loadGames(sport, url, key);
    log(`  ${games.length} games need scores`);
    if (!games.length) return { games: 0, dates: 0, updated: 0 };

    const byDate = {};
    games.forEach(g => {
      const d = (g.game_date || '').slice(0, 10);
      if (!d) return;
      if (!byDate[d]) byDate[d] = [];
      byDate[d].push(g);
    });
    const dates = Object.keys(byDate).sort();
    log(`  ${dates.length} unique dates`);

    let matched = 0;
    let updated = 0;
    let processed = 0;

    await parallelMap(dates, FETCH_CONCURRENCY, async (date) => {
      const espn = await fetchEspnDate(path, date);
      if (espn.length) {
        const index = {};
        espn.forEach(e => {
          const hk = normalize(e.homeName);
          const ak = normalize(e.awayName);
          if (hk && ak) index[`${hk}|${ak}`] = e;
          if (hk && !index[hk]) index[hk] = e;
        });

        const updates = [];
        byDate[date].forEach(g => {
          const hk = normalize(g.home);
          const ak = normalize(g.away);
          const hit = index[`${hk}|${ak}`] || index[hk];
          if (!hit) return;
          matched++;
          updates.push({
            game_id: g.game_id,
            home_score: hit.homeScore,
            away_score: hit.awayScore,
          });
        });

        if (updates.length) updated += await patchScores(url, key, updates);
      }
      processed++;
      if (processed % 25 === 0) log(`    ${processed}/${dates.length} dates · ${updated} updated`);
    });

    log(`  matched ${matched} · wrote ${updated}`);
    return { games: games.length, dates: dates.length, matched, updated };
  }

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
        out.push({
          homeName: h.team?.displayName,
          awayName: a.team?.displayName,
          homeScore: parseInt(h.score, 10),
          awayScore: parseInt(a.score, 10),
        });
      });
      return out;
    } catch { return []; }
  }

  async function patchScores(url, key, updates) {
    let ok = 0;
    // PostgREST cannot update multiple rows with different values in a
    // single PATCH, so each row is patched individually. At 6-way
    // parallelism a 10k-game backfill runs in a few minutes.
    await parallelMap(updates, 6, async (u) => {
      try {
        const res = await fetch(
          `${url}/rest/v1/historical_odds?game_id=eq.${encodeURIComponent(u.game_id)}`,
          {
            method: 'PATCH',
            headers: {
              apikey: key, Authorization: `Bearer ${key}`,
              'Content-Type': 'application/json',
              Prefer: 'return=minimal',
            },
            body: JSON.stringify({
              home_score: u.home_score,
              away_score: u.away_score,
              completed: true,
            }),
          }
        );
        if (res.ok) ok++;
      } catch {}
    });
    return ok;
  }

  function normalize(s) {
    return String(s || '').toLowerCase().replace(/[^a-z]/g, '');
  }

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