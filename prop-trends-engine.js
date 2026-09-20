// ============================================================
// EDGE — PROP TRENDS ENGINE v1.0
//
// Reads player_game_stats and mines per-player, per-opponent
// streaks like "Josh Allen 300+ pass yards vs NYJ — 10 straight".
//
// For every player against every opponent, tests a fixed set of
// stat/threshold pairs (300+ pass yds, 2+ TD, 25+ points, etc.).
// Writes the results to prop_trends.
//
// Run once per sport. Reads only from the local database — no
// external fetches. Takes seconds.
// ============================================================

const EDGE_PROP_TRENDS = (() => {

  const SUPABASE_URL = () => localStorage.getItem('edge_supabase_url');
  const SUPABASE_KEY = () => localStorage.getItem('edge_supabase_key');

  function logEdgeError(where, err) {
    try {
      const list = JSON.parse(localStorage.getItem('edge_errors') || '[]');
      list.unshift({ t: Date.now(), where, msg: err && err.message ? err.message : String(err) });
      localStorage.setItem('edge_errors', JSON.stringify(list.slice(0, 50)));
    } catch {}
  }

  // ============================================================
  // ── THRESHOLDS ──
  // Each entry: { stat, label, threshold, direction }
  // direction 'over' = we're tracking games AT OR ABOVE the number.
  // ============================================================

  const THRESHOLDS = {
    NFL: [
      { stat: 'passing_yards',    label: 'pass yds',    thresholds: [200, 250, 300, 350] },
      { stat: 'passing_tds',      label: 'pass TD',     thresholds: [1, 2, 3] },
      { stat: 'rushing_yards',    label: 'rush yds',    thresholds: [50, 75, 100, 125] },
      { stat: 'rushing_tds',      label: 'rush TD',     thresholds: [1, 2] },
      { stat: 'receptions',       label: 'receptions',  thresholds: [4, 6, 8, 10] },
      { stat: 'receiving_yards',  label: 'rec yds',     thresholds: [50, 75, 100] },
      { stat: 'receiving_tds',    label: 'rec TD',      thresholds: [1, 2] },
    ],
    NCAAF: null,   // same as NFL — assigned below
    NBA: [
      { stat: 'points',    label: 'points',   thresholds: [15, 20, 25, 30, 40] },
      { stat: 'rebounds',  label: 'rebounds', thresholds: [5, 8, 10, 12] },
      { stat: 'assists',   label: 'assists',  thresholds: [4, 6, 8, 10] },
      { stat: 'three_made',label: '3PM',      thresholds: [2, 3, 4, 5] },
    ],
    NCAAB: null,   // same as NBA
    MLB: [
      { stat: 'hits',       label: 'hits',    thresholds: [1, 2, 3] },
      { stat: 'home_runs',  label: 'HR',      thresholds: [1, 2] },
      { stat: 'rbis',       label: 'RBIs',    thresholds: [1, 2, 3] },
      { stat: 'runs',       label: 'runs',    thresholds: [1, 2] },
      { stat: 'strikeouts', label: 'K',       thresholds: [5, 7, 10] },
    ],
    NHL: [
      { stat: 'goals',  label: 'goals',    thresholds: [1, 2] },
      { stat: 'assists',label: 'assists',  thresholds: [1, 2] },
      { stat: 'points', label: 'points',   thresholds: [1, 2, 3], computed: true },
      { stat: 'saves',  label: 'saves',    thresholds: [25, 30, 35] },
    ],
    MLS: [
      { stat: 'goals',   label: 'goals',    thresholds: [1, 2] },
      { stat: 'assists', label: 'assists',  thresholds: [1] },
      { stat: 'saves',   label: 'saves',    thresholds: [3, 5, 7] },
    ],
  };
  THRESHOLDS.NCAAF = THRESHOLDS.NFL;
  THRESHOLDS.NCAAB = THRESHOLDS.NBA;

  // Streak shorter than this doesn't qualify on its own.
  const MIN_STREAK = 3;
  // Hit rate at or above this qualifies regardless of current streak.
  const MIN_HIT_RATE = 0.70;
  // Minimum games against an opponent before anything is written.
  const MIN_GAMES_VS_OPPONENT = 3;

  return {
    buildAll,
    buildSport,
    THRESHOLDS,
    MIN_STREAK,
    MIN_HIT_RATE,
  };

  // ============================================================
  // ── MAIN ──
  // ============================================================

  async function buildAll(options = {}) {
    const { sports = ['NFL'], onProgress = null } = options;
    const log = mk(onProgress);
    const summary = { sports: {}, totals: { rows: 0, qualified: 0 } };

    for (const sport of sports) {
      log(`── ${sport} ──`);
      try {
        const r = await buildSport(sport, { onProgress });
        summary.sports[sport] = r;
        summary.totals.rows += r.rows_written || 0;
        summary.totals.qualified += r.qualified || 0;
      } catch (e) {
        log(`${sport} failed: ${e.message}`);
        summary.sports[sport] = { error: e.message };
      }
    }
    return summary;
  }

  async function buildSport(sport, options = {}) {
    const log = mk(options.onProgress);
    const url = SUPABASE_URL();
    const key = SUPABASE_KEY();
    if (!url || !key) throw new Error('Supabase not connected');

    const thresholds = THRESHOLDS[sport];
    if (!thresholds) throw new Error(`No thresholds configured for ${sport}`);

    log('  loading player game stats');
    const stats = await loadPlayerStats(sport, url, key);
    log(`  ${stats.length} player-game rows`);

    if (!stats.length) return { rows_written: 0, qualified: 0 };

    // Group by player + opponent
    log('  grouping by player and opponent');
    const groups = {};
    stats.forEach(row => {
      if (!row.player_id || !row.opponent) return;
      const k = `${row.player_id}|${row.opponent}`;
      if (!groups[k]) {
        groups[k] = {
          player_id: row.player_id,
          player_name: row.player_name,
          team_name: row.team_name,
          opponent: row.opponent,
          games: [],
        };
      }
      groups[k].games.push(row);
    });
    log(`  ${Object.keys(groups).length} player-opponent pairs`);

    // Evaluate each group
    const allRows = [];
    Object.values(groups).forEach(g => {
      g.games.sort((a, b) => new Date(a.game_date) - new Date(b.game_date));
      if (g.games.length < MIN_GAMES_VS_OPPONENT) return;

      thresholds.forEach(t => {
        t.thresholds.forEach(thr => {
          const row = evaluateStreak(sport, g, t, thr);
          if (row) allRows.push(row);
        });
      });
    });

    const qualified = allRows.filter(r => r.qualified).length;
    log(`  ${allRows.length} prop trends · ${qualified} qualifying`);

    const written = await writeRows(url, key, sport, allRows, log);
    return { rows_written: written, qualified };
  }

  // ============================================================
  // ── STREAK EVALUATION ──
  // ============================================================

  function evaluateStreak(sport, group, threshold, limit) {
    const stat = threshold.stat;

    // Build the sequence of (date, value, hit?)
    const seq = group.games.map(g => {
      let v = g[stat];
      // Hockey/soccer "points" is goals + assists, computed on the fly.
      if (threshold.computed && stat === 'points') {
        v = (Number(g.goals) || 0) + (Number(g.assists) || 0);
      }
      return {
        date: g.game_date,
        value: v == null ? null : Number(v),
        raw: g,
      };
    }).filter(x => x.value != null && isFinite(x.value));

    if (seq.length < MIN_GAMES_VS_OPPONENT) return null;

    const hits = seq.map(x => x.value >= limit);
    const hitCount = hits.filter(Boolean).length;
    const hitRate = hitCount / seq.length;

    // Current streak: consecutive hits from the end backwards
    let current = 0;
    for (let i = hits.length - 1; i >= 0; i--) {
      if (hits[i]) current++;
      else break;
    }

    // Longest streak anywhere in the sequence
    let longest = 0, run = 0;
    hits.forEach(h => {
      if (h) { run++; longest = Math.max(longest, run); }
      else run = 0;
    });

    const qualified = current >= MIN_STREAK || hitRate >= MIN_HIT_RATE;
    if (!qualified) return null;

    const seasons = Array.from(new Set(
      seq.map(x => seasonOf(sport, new Date(x.date)))
    )).sort();

    const recent = seq.slice(-5).map(x => ({
      date: String(x.date).slice(0, 10),
      value: x.value,
      hit: x.value >= limit,
      opponent: group.opponent,
    }));

    const headline = buildHeadline(group, threshold, limit, current, hitCount, seq.length);

    return {
      sport,
      player_id: group.player_id,
      player_name: group.player_name,
      team_name: group.team_name,
      opponent: group.opponent,
      stat_name: stat,
      threshold: limit,
      direction: 'over',
      games_vs_opponent: seq.length,
      hit_count: hitCount,
      hit_rate: round(hitRate, 4),
      current_streak: current,
      longest_streak: longest,
      seasons_covered: seasons.length,
      first_date: seq[0].date,
      last_date: seq[seq.length - 1].date,
      recent_games: recent,
      qualified,
      headline,
      updated_at: new Date().toISOString(),
    };
  }

  function buildHeadline(group, threshold, limit, current, hits, total) {
    if (current >= MIN_STREAK) {
      return `${group.player_name} has ${limit}+ ${threshold.label} in ${current} straight vs ${group.opponent}`;
    }
    return `${group.player_name} has hit ${limit}+ ${threshold.label} in ${hits} of ${total} vs ${group.opponent}`;
  }

  // ============================================================
  // ── LOAD ──
  // ============================================================

  async function loadPlayerStats(sport, url, key) {
    const out = [];
    const pageSize = 1000;
    for (let offset = 0; offset < 500000; offset += pageSize) {
      try {
        const res = await fetch(
          `${url}/rest/v1/player_game_stats?sport=eq.${sport}` +
          `&select=player_id,player_name,team_name,opponent,game_date,` +
          `passing_yards,passing_tds,rushing_yards,rushing_tds,` +
          `receptions,receiving_yards,receiving_tds,` +
          `points,rebounds,assists,three_made,` +
          `hits,home_runs,rbis,runs,strikeouts,` +
          `goals,saves` +
          `&order=game_date.asc&limit=${pageSize}&offset=${offset}`,
          { headers: { apikey: key, Authorization: `Bearer ${key}` } }
        );
        if (!res.ok) break;
        const rows = await res.json();
        out.push(...rows);
        if (rows.length < pageSize) break;
      } catch (e) {
        logEdgeError('propTrends.loadPlayerStats.' + sport, e);
        break;
      }
    }
    return out;
  }

  // ============================================================
  // ── WRITE ──
  // ============================================================

  async function writeRows(url, key, sport, rows, log) {
    if (!rows.length) return 0;

    const headers = {
      apikey: key, Authorization: `Bearer ${key}`,
      'Content-Type': 'application/json', Prefer: 'return=minimal',
    };

    // Clear this sport's previous rows first. prop_trends is fully
    // recomputed each run, so a clean slate is safe.
    try {
      await fetch(`${url}/rest/v1/prop_trends?sport=eq.${sport}`, {
        method: 'DELETE', headers: { apikey: key, Authorization: `Bearer ${key}` },
      });
    } catch (e) { logEdgeError('propTrends.clearPrevious.' + sport, e); }

    const size = 400;
    let written = 0;

    for (let i = 0; i < rows.length; i += size) {
      const chunk = rows.slice(i, i + size);
      let ok = false;
      for (let attempt = 0; attempt < 3 && !ok; attempt++) {
        try {
          const res = await fetch(`${url}/rest/v1/prop_trends`, {
            method: 'POST', headers, body: JSON.stringify(chunk),
          });
          if (res.ok) { ok = true; written += chunk.length; break; }
          const txt = await res.text().catch(() => '');
          log(`    write attempt ${attempt + 1}: HTTP ${res.status} ${txt.slice(0, 140)}`);
        } catch (e) {
          log(`    write attempt ${attempt + 1}: ${e.message}`);
        }
        if (!ok) await new Promise(r => setTimeout(r, 500 * (attempt + 1)));
      }
    }
    return written;
  }

  // ============================================================
  // ── UTILITIES ──
  // ============================================================

  function seasonOf(sport, date) {
    const m = date.getMonth() + 1;
    const y = date.getFullYear();
    const cross = (startMonth) => (m >= startMonth ? y : y - 1);
    switch (sport) {
      case 'NBA':
      case 'NHL':
      case 'NCAAB': return cross(9);
      case 'NFL':
      case 'NCAAF': return cross(3);
      default:      return y;
    }
  }

  function mk(onProgress) {
    return (m) => { if (typeof onProgress === 'function') onProgress(m); };
  }

  function round(v, d) { const f = Math.pow(10, d); return Math.round(v * f) / f; }

})();

if (typeof window !== 'undefined') window.EDGE_PROP_TRENDS = EDGE_PROP_TRENDS;