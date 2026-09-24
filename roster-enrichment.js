// ============================================================
// EDGE — ROSTER ENRICHMENT v3.2
//
// Reads production from player_game_stats and refines each
// player's rating from the 50 baseline to a 40-95 scale.
//
// Workflow:
//   1. Fetch Box Scores  → fills player_game_stats
//   2. Enrich Rosters    → reads player_game_stats, z-scores
//                          per position group, updates players
//
// v3.2 changes:
//
//   · METRIC_CONFIG now holds independent objects per sport.
//     The v3.1 code did `METRIC_CONFIG.NCAAF = METRIC_CONFIG.NFL`,
//     which made the two keys point at the same array — and the
//     array's inner objects were shared too. Nothing currently
//     mutates the config, so the bug is latent rather than active.
//     But the next person who adds a college-specific tweak to
//     NCAAF would silently change NFL as well, and the mistake
//     would not surface until the two sports' numbers disagreed
//     in a way that was hard to trace back. Each key now owns
//     its own array and its own objects, produced by cloning the
//     template at module load.
//
//   · POSITION_WEIGHTS was duplicated between roster-engine.js
//     and this file. Same values in both. Not a bug — just a
//     maintenance hazard worth noting for whenever the two files
//     are next touched together. Left as-is here because fixing
//     it properly means exporting from one file and importing
//     in the other, which is a change to roster-engine.js.
//
// v3.1 — Reads production from player_game_stats instead of
// ESPN. The leaders endpoint is CORS-blocked in the browser
// (same as /teams), and re-fetching data we already own was
// the wrong shape anyway. player_game_stats has every stat
// we need, already mapped, already local.
// ============================================================

const EDGE_ROSTER_ENRICH = (() => {

  const BUILD = 'enrich-20260924-01';

  const SUPABASE_URL = () => localStorage.getItem('edge_supabase_url');
  const SUPABASE_KEY = () => localStorage.getItem('edge_supabase_key');

  // Deep clone of a metric config array. Each entry becomes its
  // own object with its own `groups` array, so mutating a clone
  // cannot reach the original.
  function cloneMetrics(list) {
    return list.map(m => ({
      col: m.col,
      weight: m.weight,
      groups: Array.isArray(m.groups) ? m.groups.slice() : m.groups,
      agg: m.agg,
      inverted: m.inverted,
    }));
  }

  const NFL_METRICS = [
    { col: 'passing_yards',    weight: 0.8, groups: ['OFFENSE_SKILL'], agg: 'sum' },
    { col: 'passing_tds',      weight: 1.0, groups: ['OFFENSE_SKILL'], agg: 'sum' },
    { col: 'rushing_yards',    weight: 0.7, groups: ['OFFENSE_SKILL'], agg: 'sum' },
    { col: 'rushing_tds',      weight: 0.8, groups: ['OFFENSE_SKILL'], agg: 'sum' },
    { col: 'receiving_yards',  weight: 0.7, groups: ['OFFENSE_SKILL'], agg: 'sum' },
    { col: 'receiving_tds',    weight: 0.8, groups: ['OFFENSE_SKILL'], agg: 'sum' },
    // Defense — no per-player sacks/tackles stored yet, skip
  ];

  const NBA_METRICS = [
    { col: 'points',    weight: 1.0, groups: [], agg: 'avg' },
    { col: 'assists',   weight: 0.6, groups: [], agg: 'avg' },
    { col: 'rebounds',  weight: 0.5, groups: [], agg: 'avg' },
    { col: 'steals',    weight: 0.4, groups: [], agg: 'avg' },
    { col: 'blocks',    weight: 0.4, groups: [], agg: 'avg' },
    { col: 'three_made',weight: 0.5, groups: [], agg: 'avg' },
  ];

  const MLB_METRICS = [
    { col: 'hits',                weight: 0.7, groups: ['CATCHER','INFIELD','OUTFIELD','DH','HITTER'], agg: 'avg' },
    { col: 'home_runs',           weight: 0.9, groups: ['CATCHER','INFIELD','OUTFIELD','DH','HITTER'], agg: 'sum' },
    { col: 'rbis',                weight: 0.7, groups: ['CATCHER','INFIELD','OUTFIELD','DH','HITTER'], agg: 'sum' },
    { col: 'earned_runs',         weight: 1.0, groups: ['PITCHER_START','PITCHER_RELIEF','PITCHER'], agg: 'avg', inverted: true },
    { col: 'pitching_strikeouts', weight: 0.8, groups: ['PITCHER_START','PITCHER_RELIEF','PITCHER'], agg: 'avg' },
  ];

  const NHL_METRICS = [
    { col: 'goals',         weight: 0.9, groups: ['FORWARD','DEFENSE'], agg: 'sum' },
    { col: 'assists',       weight: 0.8, groups: ['FORWARD','DEFENSE'], agg: 'sum' },
    { col: 'shots',         weight: 0.5, groups: ['FORWARD','DEFENSE'], agg: 'sum' },
    { col: 'saves',         weight: 1.0, groups: ['GOALIE'], agg: 'avg' },
    { col: 'goals_against', weight: 1.0, groups: ['GOALIE'], agg: 'avg', inverted: true },
  ];

  const MLS_METRICS = [
    { col: 'goals',           weight: 1.0, groups: ['FORWARD','MIDFIELD','DEFENSE'], agg: 'sum' },
    { col: 'assists',         weight: 0.7, groups: ['FORWARD','MIDFIELD','DEFENSE'], agg: 'sum' },
    { col: 'shots_on_target', weight: 0.4, groups: ['FORWARD','MIDFIELD'], agg: 'sum' },
    { col: 'saves',           weight: 1.0, groups: ['GOALKEEPER'], agg: 'sum' },
  ];

  // Every key owns its own array and its own inner objects. No
  // two keys share a reference.
  const METRIC_CONFIG = {
    NFL:   cloneMetrics(NFL_METRICS),
    NCAAF: cloneMetrics(NFL_METRICS),
    NBA:   cloneMetrics(NBA_METRICS),
    NCAAB: cloneMetrics(NBA_METRICS),
    WNBA:  cloneMetrics(NBA_METRICS),
    MLB:   cloneMetrics(MLB_METRICS),
    NHL:   cloneMetrics(NHL_METRICS),
    MLS:   cloneMetrics(MLS_METRICS),
  };

  const POSITION_WEIGHTS = {
    OFFENSE_SKILL: 0.55, OFFENSE_LINE: 0.45,
    DEFENSE_FRONT: 0.40, DEFENSE_EDGE: 0.55,
    DEFENSE_MID: 0.40, DEFENSE_SECONDARY: 0.50,
    SPECIAL: 0.15,
    GUARD: 0.95, WING: 0.90, BIG: 0.85,
    PITCHER_START: 1.00, PITCHER_RELIEF: 0.40, PITCHER: 0.70,
    CATCHER: 0.55, INFIELD: 0.55, OUTFIELD: 0.55, DH: 0.50, HITTER: 0.55,
    GOALIE: 1.00, FORWARD: 0.75, MIDFIELD: 0.80,
    DEFENSE: 0.75, GOALKEEPER: 1.00,
  };

  const OFFENSE_GROUPS = new Set([
    'OFFENSE_SKILL', 'OFFENSE_LINE', 'GUARD', 'WING', 'BIG',
    'PITCHER_START', 'PITCHER_RELIEF', 'CATCHER', 'INFIELD', 'OUTFIELD', 'DH',
    'FORWARD', 'MIDFIELD', 'HITTER',
  ]);
  const DEFENSE_GROUPS = new Set([
    'DEFENSE_FRONT', 'DEFENSE_EDGE', 'DEFENSE_MID', 'DEFENSE_SECONDARY',
    'GOALIE', 'GOALKEEPER', 'DEFENSE', 'PITCHER',
  ]);

  const CENTER = 62;
  const SPREAD = 11;
  const RATING_MIN = 42;
  const RATING_MAX = 95;
  const MIN_GAMES = 4;
  const WRITE_CONCURRENCY = 8;

  return {
    BUILD,
    enrichAll,
    enrichSport,
    METRIC_CONFIG,
  };

  // ============================================================
  // ── MAIN ──
  // ============================================================

  async function enrichAll(options = {}) {
    const { sports = Object.keys(METRIC_CONFIG), onProgress = null } = options;
    const log = mk(onProgress);
    const summary = { sports: {}, totals: { enriched: 0, unmatched: 0, no_stats: 0 } };

    for (const sport of sports) {
      log(`── ${sport} ──`);
      try {
        const result = await enrichSport(sport, { onProgress });
        summary.sports[sport] = result;
        summary.totals.enriched += result.enriched || 0;
        summary.totals.unmatched += result.unmatched || 0;
        summary.totals.no_stats += result.no_stats || 0;
      } catch (e) {
        log(`${sport} failed: ${e.message}`);
        summary.sports[sport] = { error: e.message };
      }
    }
    return summary;
  }

  async function enrichSport(sport, options = {}) {
    const log = mk(options.onProgress);
    const url = SUPABASE_URL();
    const key = SUPABASE_KEY();
    if (!url || !key) throw new Error('Supabase not connected');

    const metrics = METRIC_CONFIG[sport];
    if (!metrics) throw new Error(`No metric config for ${sport}`);

    // ── 1. Roster ──
    log('  loading roster rows');
    const players = await loadPlayers(url, key, sport);
    log(`  ${players.length} players in table`);
    if (!players.length) {
      return { enriched: 0, unmatched: 0, no_stats: 0,
        note: 'players table empty for this sport — run Build Rosters first' };
    }

    // ── 2. Aggregate player_game_stats ──
    log('  loading production from player_game_stats');
    const agg = await loadAggregates(url, key, sport, metrics);
    const statCount = Object.keys(agg).length;
    log(`  ${statCount} players with game stats`);
    if (!statCount) {
      return { enriched: 0, unmatched: players.length, no_stats: players.length,
        note: 'player_game_stats empty for this sport — run Fetch Box Scores first' };
    }

    // ── 3. Normalise ──
    const norms = buildNormalisers(metrics, agg);

    // ── 4. Score ──
    const updates = [];
    let matched = 0, noStats = 0;

    players.forEach(p => {
      const stats = agg[String(p.player_id)];
      if (!stats || stats.games < MIN_GAMES) { noStats++; return; }

      const z = weightedZ(stats, metrics, p.position_group, norms);
      if (z === null) { noStats++; return; }

      matched++;
      const starterBonus = p.is_starter ? 1.5 : 0;
      const rating = clamp(round(CENTER + z * SPREAD + starterBonus, 1),
                           RATING_MIN, RATING_MAX);
      const { off, def } = contributionFor(p.position_group, rating);
      updates.push({
        id: p.id, rating,
        offensive_contribution: off,
        defensive_contribution: def,
      });
    });

    log(`  ${updates.length} players to enrich`);
    if (!updates.length) {
      return { enriched: 0, unmatched: players.length - noStats, no_stats: noStats,
        note: 'no id overlap between players and player_game_stats' };
    }

    // ── 5. Write ──
    let written = 0;
    await parallelMap(updates, WRITE_CONCURRENCY, async u => {
      try {
        const res = await fetch(`${url}/rest/v1/players?id=eq.${u.id}`, {
          method: 'PATCH',
          headers: {
            apikey: key, Authorization: `Bearer ${key}`,
            'Content-Type': 'application/json',
            Prefer: 'return=minimal',
          },
          body: JSON.stringify({
            rating: u.rating,
            offensive_contribution: u.offensive_contribution,
            defensive_contribution: u.defensive_contribution,
            updated_at: new Date().toISOString(),
          }),
        });
        if (res.ok) written++;
      } catch {}
    });

    log(`  wrote ${written} enriched players`);
    return {
      enriched: written,
      unmatched: players.length - matched,
      no_stats: noStats,
      stats_available: statCount,
    };
  }

  // ============================================================
  // ── ROSTER READ ──
  // ============================================================

  async function loadPlayers(url, key, sport) {
    const out = [];
    const pageSize = 1000;
    for (let offset = 0; offset < 200000; offset += pageSize) {
      try {
        const res = await fetch(
          `${url}/rest/v1/players?sport=eq.${sport}` +
          `&select=id,player_id,name,position,position_group,rating,is_starter` +
          `&order=id.asc&limit=${pageSize}&offset=${offset}`,
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
  // ── AGGREGATE player_game_stats ──
  // Sum or average each metric per player, per game. Returns
  // { player_id: { games, sum_col: X, avg_col: Y, ... } }
  // ============================================================

  async function loadAggregates(url, key, sport, metrics) {
    const cols = new Set(['player_id']);
    metrics.forEach(m => cols.add(m.col));
    const colList = Array.from(cols).join(',');

    const rows = [];
    const pageSize = 1000;
    for (let offset = 0; offset < 500000; offset += pageSize) {
      try {
        const res = await fetch(
          `${url}/rest/v1/player_game_stats?sport=eq.${sport}` +
          `&select=${colList}&limit=${pageSize}&offset=${offset}`,
          { headers: { apikey: key, Authorization: `Bearer ${key}` } }
        );
        if (!res.ok) break;
        const batch = await res.json();
        rows.push(...batch);
        if (batch.length < pageSize) break;
      } catch { break; }
    }

    const sums = {};
    const counts = {};

    rows.forEach(r => {
      const pid = String(r.player_id);
      if (!pid) return;
      if (!sums[pid]) { sums[pid] = { games: 0 }; counts[pid] = { games: 0 }; }

      // Count games where at least one metric was non-null. That
      // avoids dividing by exhibition or DNPs.
      let had = false;
      metrics.forEach(m => {
        const v = r[m.col];
        if (v == null) return;
        const n = Number(v);
        if (!isFinite(n)) return;
        had = true;
        if (m.agg === 'sum') {
          sums[pid][m.col] = (sums[pid][m.col] || 0) + n;
        } else {
          sums[pid][m.col] = (sums[pid][m.col] || 0) + n;
          counts[pid][m.col] = (counts[pid][m.col] || 0) + 1;
        }
      });
      if (had) {
        sums[pid].games++;
        counts[pid].games++;
      }
    });

    // Convert avg metrics
    const out = {};
    Object.keys(sums).forEach(pid => {
      const s = sums[pid];
      const c = counts[pid];
      const rec = { games: s.games };
      metrics.forEach(m => {
        if (s[m.col] == null) return;
        if (m.agg === 'avg' && c[m.col] > 0) {
          rec[m.col] = s[m.col] / c[m.col];
        } else {
          rec[m.col] = s[m.col];
        }
      });
      out[pid] = rec;
    });
    return out;
  }

  // ============================================================
  // ── NORMALISATION ──
  // ============================================================

  function buildNormalisers(metrics, statsById) {
    const buckets = {};
    metrics.forEach(m => { buckets[m.col] = []; });

    Object.values(statsById).forEach(stats => {
      Object.entries(stats).forEach(([k, v]) => {
        if (buckets[k] && isFinite(v)) buckets[k].push(v);
      });
    });

    const norms = {};
    Object.entries(buckets).forEach(([k, values]) => {
      if (values.length < 5) { norms[k] = null; return; }
      const mean = values.reduce((a, b) => a + b, 0) / values.length;
      const variance = values.reduce((a, b) => a + (b - mean) ** 2, 0) / values.length;
      const sd = Math.sqrt(variance);
      norms[k] = sd > 0 ? { mean, sd } : null;
    });
    return norms;
  }

  function weightedZ(stats, metrics, playerGroup, norms) {
    let sum = 0, weightSum = 0, found = 0;

    metrics.forEach(m => {
      if (Array.isArray(m.groups) && m.groups.length) {
        if (!playerGroup || !m.groups.includes(playerGroup)) return;
      }
      const norm = norms[m.col];
      if (!norm) return;
      const raw = stats[m.col];
      if (raw == null || !isFinite(raw)) return;

      let z = (raw - norm.mean) / norm.sd;
      if (m.inverted) z = -z;
      z = clamp(z, -3, 3);

      const w = m.weight || 1;
      sum += z * w;
      weightSum += w;
      found++;
    });

    if (!found || weightSum === 0) return null;
    return sum / weightSum;
  }

  function contributionFor(group, rating) {
    const weight = POSITION_WEIGHTS[group] ?? 0.40;
    const base = rating * weight;
    if (OFFENSE_GROUPS.has(group)) return { off: round(base, 2), def: 0 };
    if (DEFENSE_GROUPS.has(group)) return { off: 0, def: round(base, 2) };
    return { off: round(base / 2, 2), def: round(base / 2, 2) };
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

  function clamp(v, min, max) { return Math.max(min, Math.min(max, v)); }
  function round(v, d) { const f = Math.pow(10, d); return Math.round(v * f) / f; }

})();

if (typeof window !== 'undefined') window.EDGE_ROSTER_ENRICH = EDGE_ROSTER_ENRICH;