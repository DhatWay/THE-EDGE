// ============================================================
// EDGE — PROP TRENDS ENGINE v1.3
//
// Reads player_game_stats and mines per-player, per-opponent
// streaks like "Josh Allen 300+ pass yards vs NYJ — 10 straight".
//
// v1.3 changes:
//
//   · The position_group gate is bypassed when the row does
//     not carry a group. The v1.2 config adds a `groups` list
//     to most thresholds and rejects any row whose
//     position_group is not in that list. Older rows in
//     player_game_stats were written before the fetcher
//     started populating position_group, so those rows carry
//     null and the gate rejected them all. The engine now
//     applies the gate only when the row actually carries a
//     group — a null position_group means the row was written
//     before position_group existed and the threshold applies
//     as if the group were permissive.
//
//   · earned_runs is inverted. Every other threshold measures
//     "at least this many" — passing yards, points, hits. Earned
//     runs is the only stat where a lower number is better, and
//     the old threshold list [0, 1, 2] tested `>= 0` which is
//     always true. Any pitcher with a single appearance
//     qualified for "0+ ER" streaks that were really just
//     "pitched at all". The threshold is now tested with <= and
//     the direction is inverted so a "0 earned runs" streak
//     means what it says.
//
//   · The pitcher-K column is pitching_strikeouts. The
//     thresholds read that column directly, separate from the
//     batter `strikeouts` column.
//
//   · Season labels match ats-tracker v3.0, power-engine v4.4,
//     trends-engine v2.1, and box-score-fetcher.
//
// v1.2 changes (retained):
//   · THRESHOLDS is built from per-sport templates via
//     cloneThresholds().
// ============================================================

const EDGE_PROP_TRENDS = (() => {

  const BUILD = 'props-20260926-01';

  const SUPABASE_URL = () => localStorage.getItem('edge_supabase_url');
  const SUPABASE_KEY = () => localStorage.getItem('edge_supabase_key');

  function logEdgeError(where, err) {
    try {
      const list = JSON.parse(localStorage.getItem('edge_errors') || '[]');
      list.unshift({ t: Date.now(), where, msg: err && err.message ? err.message : String(err) });
      localStorage.setItem('edge_errors', JSON.stringify(list.slice(0, 50)));
    } catch {}
  }

  function cloneThresholds(list) {
    return list.map(t => ({
      stat: t.stat,
      label: t.label,
      thresholds: Array.isArray(t.thresholds) ? t.thresholds.slice() : t.thresholds,
      computed: t.computed || false,
      // Direction. 'over' means a higher value is a hit, which
      // is what every threshold except earned_runs uses.
      // 'under' means a lower value is a hit.
      direction: t.direction || 'over',
      groups: Array.isArray(t.groups) ? t.groups.slice() : null,
    }));
  }

  // ============================================================
  // ── THRESHOLDS ──
  // Each entry: { stat, label, thresholds, computed?, direction?, groups? }
  // ============================================================

  const NFL_THRESHOLDS = [
    { stat: 'passing_yards',    label: 'pass yds',   thresholds: [200, 250, 300, 350], groups: ['OFFENSE_SKILL'] },
    { stat: 'passing_tds',      label: 'pass TD',    thresholds: [1, 2, 3], groups: ['OFFENSE_SKILL'] },
    { stat: 'rushing_yards',    label: 'rush yds',   thresholds: [50, 75, 100, 125], groups: ['OFFENSE_SKILL'] },
    { stat: 'rushing_tds',      label: 'rush TD',    thresholds: [1, 2], groups: ['OFFENSE_SKILL'] },
    { stat: 'receptions',       label: 'receptions', thresholds: [4, 6, 8, 10], groups: ['OFFENSE_SKILL'] },
    { stat: 'receiving_yards',  label: 'rec yds',    thresholds: [50, 75, 100], groups: ['OFFENSE_SKILL'] },
    { stat: 'receiving_tds',    label: 'rec TD',     thresholds: [1, 2], groups: ['OFFENSE_SKILL'] },
  ];

  const NBA_THRESHOLDS = [
    { stat: 'points',     label: 'points',   thresholds: [15, 20, 25, 30, 40] },
    { stat: 'rebounds',   label: 'rebounds', thresholds: [5, 8, 10, 12] },
    { stat: 'assists',    label: 'assists',  thresholds: [4, 6, 8, 10] },
    { stat: 'three_made', label: '3PM',      thresholds: [2, 3, 4, 5] },
  ];

  const MLB_THRESHOLDS = [
    // Batter lines.
    { stat: 'hits',       label: 'hits',     thresholds: [1, 2, 3], groups: ['CATCHER', 'INFIELD', 'OUTFIELD', 'DH', 'HITTER'] },
    { stat: 'home_runs',  label: 'HR',       thresholds: [1, 2],    groups: ['CATCHER', 'INFIELD', 'OUTFIELD', 'DH', 'HITTER'] },
    { stat: 'rbis',       label: 'RBIs',     thresholds: [1, 2, 3], groups: ['CATCHER', 'INFIELD', 'OUTFIELD', 'DH', 'HITTER'] },
    { stat: 'runs',       label: 'runs',     thresholds: [1, 2],    groups: ['CATCHER', 'INFIELD', 'OUTFIELD', 'DH', 'HITTER'] },
    { stat: 'strikeouts', label: 'batter K', thresholds: [1, 2, 3], groups: ['CATCHER', 'INFIELD', 'OUTFIELD', 'DH', 'HITTER'] },

    // Pitcher lines. earned_runs is inverted — a lower number
    // is better, so a "0 earned runs" streak means the pitcher
    // allowed zero earned runs in each of those starts. The old
    // threshold list [0, 1, 2] tested >= 0 which is always true;
    // every pitching line qualified for a "0+ ER" streak.
    { stat: 'pitching_strikeouts', label: 'pitcher K', thresholds: [4, 5, 6, 7, 8, 10], groups: ['PITCHER_START', 'PITCHER_RELIEF', 'PITCHER'] },
    { stat: 'earned_runs',         label: 'ER', thresholds: [0, 1, 2], direction: 'under', groups: ['PITCHER_START', 'PITCHER_RELIEF', 'PITCHER'] },
  ];

  const NHL_THRESHOLDS = [
    { stat: 'goals',   label: 'goals',   thresholds: [1, 2], groups: ['FORWARD', 'DEFENSE'] },
    { stat: 'assists', label: 'assists', thresholds: [1, 2], groups: ['FORWARD', 'DEFENSE'] },
    { stat: 'points',  label: 'points',  thresholds: [1, 2, 3], computed: true, groups: ['FORWARD', 'DEFENSE'] },
    { stat: 'saves',   label: 'saves',   thresholds: [25, 30, 35], groups: ['GOALIE'] },
  ];

  const MLS_THRESHOLDS = [
    { stat: 'goals',   label: 'goals',   thresholds: [1, 2], groups: ['FORWARD', 'MIDFIELD', 'DEFENSE'] },
    { stat: 'assists', label: 'assists', thresholds: [1], groups: ['FORWARD', 'MIDFIELD', 'DEFENSE'] },
    { stat: 'saves',   label: 'saves',   thresholds: [3, 5, 7], groups: ['GOALKEEPER'] },
  ];

  const THRESHOLDS = {
    NFL:   cloneThresholds(NFL_THRESHOLDS),
    NCAAF: cloneThresholds(NFL_THRESHOLDS),
    NBA:   cloneThresholds(NBA_THRESHOLDS),
    NCAAB: cloneThresholds(NBA_THRESHOLDS),
    WNBA:  cloneThresholds(NBA_THRESHOLDS),
    MLB:   cloneThresholds(MLB_THRESHOLDS),
    NHL:   cloneThresholds(NHL_THRESHOLDS),
    MLS:   cloneThresholds(MLS_THRESHOLDS),
  };

  const MIN_STREAK = 3;
  const MIN_HIT_RATE = 0.70;
  const MIN_GAMES_VS_OPPONENT = 3;

  return {
    BUILD,
    buildAll,
    buildSport,
    THRESHOLDS,
    MIN_STREAK,
    MIN_HIT_RATE,
    MIN_GAMES_VS_OPPONENT,
  };

  // ============================================================
  // ── MAIN ──
  // ============================================================

  async function buildAll(options = {}) {
    const { sports = ['NFL'], onProgress = null } = options;
    const log = mk(onProgress);
    const summary = { sports: {}, totals: { rows: 0, qualified: 0, skipped_no_group: 0 } };

    for (const sport of sports) {
      log(`── ${sport} ──`);
      try {
        const r = await buildSport(sport, { onProgress });
        summary.sports[sport] = r;
        summary.totals.rows += r.rows_written || 0;
        summary.totals.qualified += r.qualified || 0;
        summary.totals.skipped_no_group += r.skipped_no_group || 0;
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

    if (!stats.length) return { rows_written: 0, qualified: 0, skipped_no_group: 0 };

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
          position_group: row.position_group || null,
          games: [],
        };
      }
      groups[k].games.push(row);
    });
    log(`  ${Object.keys(groups).length} player-opponent pairs`);

    const allRows = [];
    let skippedNoGroup = 0;

    Object.values(groups).forEach(g => {
      g.games.sort((a, b) => new Date(a.game_date) - new Date(b.game_date));
      if (g.games.length < MIN_GAMES_VS_OPPONENT) return;

      thresholds.forEach(t => {
        // Position-group gate. Applied only when both sides of
        // the comparison are known. A threshold that names
        // groups and a row that carries a position_group are
        // both required to evaluate the gate. When either is
        // missing, the threshold is evaluated as if it
        // applied — the older rows in player_game_stats were
        // written before position_group existed, and rejecting
        // them silently produced zero trends.
        if (Array.isArray(t.groups) && t.groups.length) {
          if (g.position_group && !t.groups.includes(g.position_group)) {
            skippedNoGroup++;
            return;
          }
        }

        t.thresholds.forEach(thr => {
          const row = evaluateStreak(sport, g, t, thr);
          if (row) allRows.push(row);
        });
      });
    });

    const qualified = allRows.filter(r => r.qualified).length;
    log(`  ${allRows.length} prop trends · ${qualified} qualifying`);
    if (skippedNoGroup) log(`  ${skippedNoGroup} threshold checks skipped on group mismatch`);

    const written = await writeRows(url, key, sport, allRows, log);
    return { rows_written: written, qualified, skipped_no_group: skippedNoGroup };
  }

  // ============================================================
  // ── STREAK EVALUATION ──
  // ============================================================

  function evaluateStreak(sport, group, threshold, limit) {
    const stat = threshold.stat;
    const isUnder = threshold.direction === 'under';

    const seq = group.games.map(g => {
      let v = g[stat];
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

    // Direction: 'over' means a hit when value >= limit;
    // 'under' means a hit when value <= limit. earned_runs is
    // the only metric that uses 'under'.
    const hits = seq.map(x => isUnder ? x.value <= limit : x.value >= limit);
    const hitCount = hits.filter(Boolean).length;
    const hitRate = hitCount / seq.length;

    let current = 0;
    for (let i = hits.length - 1; i >= 0; i--) {
      if (hits[i]) current++;
      else break;
    }

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
      date: (window.EDGE_TIME ? window.EDGE_TIME.gameDay(x.date) : null) || String(x.date).slice(0, 10),
      value: x.value,
      hit: isUnder ? x.value <= limit : x.value >= limit,
      opponent: group.opponent,
    }));

    const headline = buildHeadline(group, threshold, limit, current, hitCount, seq.length);

    return {
      sport,
      player_id: group.player_id,
      player_name: group.player_name,
      team_name: group.team_name,
      opponent: group.opponent,
      position_group: group.position_group,
      stat_name: stat,
      threshold: limit,
      direction: isUnder ? 'under' : 'over',
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
    const label = threshold.label;
    const isUnder = threshold.direction === 'under';
    const verb = isUnder ? 'or fewer' : '+';

    if (current >= MIN_STREAK) {
      return `${group.player_name} has ${limit} ${verb} ${label} in ${current} straight vs ${group.opponent}`;
    }
    return `${group.player_name} has hit ${limit} ${verb} ${label} in ${hits} of ${total} vs ${group.opponent}`;
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
          `&select=player_id,player_name,team_name,opponent,game_date,position_group,` +
          `passing_yards,passing_tds,rushing_yards,rushing_tds,` +
          `receptions,receiving_yards,receiving_tds,` +
          `points,rebounds,assists,three_made,` +
          `hits,home_runs,rbis,runs,strikeouts,` +
          `earned_runs,pitching_strikeouts,` +
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
  // ── SEASON LABEL ──
  // ============================================================

  function seasonOf(sport, date) {
    const m = date.getMonth() + 1;
    const y = date.getFullYear();

    if (sport === 'NBA' || sport === 'NHL' || sport === 'NCAAB' || sport === 'WNBA') {
      return String(m >= 9 ? y : y - 1);
    }
    if (sport === 'NFL' || sport === 'NCAAF') {
      return String(m >= 3 ? y : y - 1);
    }
    return String(y);
  }

  function mk(onProgress) {
    return (m) => { if (typeof onProgress === 'function') onProgress(m); };
  }

  function round(v, d) { const f = Math.pow(10, d); return Math.round(v * f) / f; }

})();

if (typeof window !== 'undefined') window.EDGE_PROP_TRENDS = EDGE_PROP_TRENDS;