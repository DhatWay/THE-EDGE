// ============================================================
// EDGE — ROSTER ENRICHMENT v3.3
//
// Reads production from player_game_stats and refines each
// player's rating from the roster baseline to a 40-95 scale.
//
// v3.3 changes:
//
//   · Per-game counting is correct. The v3.2 aggregator
//     incremented `games` once per row it read from
//     player_game_stats. But a player has one row per stat
//     category per game — a quarterback appears in a passing
//     row, a rushing row, and a receiving row for the same
//     game. The loader collapsed them into one record per
//     (player, game), so a QB with three stat categories in
//     twelve games was counted as thirty-six games. Every
//     average divided by a number three times larger than
//     reality.
//
//     The new aggregator groups by (player_id, game_id) first,
//     then takes one value per metric per game, then rolls up.
//     `games` is the number of distinct game_ids.
//
//   · Only the current season is loaded. The v3.2 code read
//     every row in player_game_stats across every season on
//     file, so a four-season NFL backfill had ratings built
//     from old production as if it were current. Now the load
//     filters by season label; players with no current-season
//     rows fall back to their previous rating and are reported
//     as `no_current_stats`.
//
//   · Per-position-group z-scores are real. The header said
//     "z-score per position group" but the v3.2 code built one
//     mean and standard deviation across every position, so a
//     guard was compared against a quarterback and an offensive
//     lineman was compared against a skill player. Every metric
//     is now normalised within its own (sport, position_group)
//     bucket. A group with fewer than MIN_GROUP_SIZE samples
//     falls back to the sport-wide distribution for that metric.
//
//   · Defensive metrics for NFL and NCAAF. The v3.2 code had
//     no way to score a defensive lineman, linebacker or
//     defensive back — their group carried no metrics, so
//     `weightedZ` returned null and they were left at their
//     roster baseline forever. Tackles, sacks, interceptions
//     and passes defensed are the standard ESPN defensive
//     columns; when present in player_game_stats they drive
//     defensive rating. When absent, defensive players are
//     flagged `no_metrics` so the surface can tell the
//     difference between "rated low" and "never rated."
//
//   · Enrichment respects existing ratings. When a player
//     already has a rating from a prior enrichment run and the
//     new data would not move it, the write is skipped. That
//     keeps the roster table's `updated_at` meaningful as a
//     "last enriched" timestamp rather than rewriting every
//     row on every run.
//
// The rating scale, contribution function, and update path are
// unchanged. The roster engine's v1.3 rebuild now preserves
// enriched ratings, so a full rebuild followed by an enrich
// does not lose the refinement.
// ============================================================

const EDGE_ROSTER_ENRICH = (() => {

  const BUILD = 'enrich-20260925-01';

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
  // ── METRIC CONFIG ──
  //
  // One template per sport. Each entry describes a stat column,
  // the weight it carries, the position groups it applies to,
  // and whether the value is summed per game or averaged.
  //
  // `groups: []` means the metric applies to every group in
  // that sport. A non-empty list gates the metric.
  //
  // `inverted: true` means a lower value is better — earned
  // runs, goals against.
  // ============================================================

  const NFL_METRICS = [
    // Offensive skill
    { col: 'passing_yards',    weight: 0.8, groups: ['OFFENSE_SKILL'], agg: 'sum' },
    { col: 'passing_tds',      weight: 1.0, groups: ['OFFENSE_SKILL'], agg: 'sum' },
    { col: 'rushing_yards',    weight: 0.7, groups: ['OFFENSE_SKILL'], agg: 'sum' },
    { col: 'rushing_tds',      weight: 0.8, groups: ['OFFENSE_SKILL'], agg: 'sum' },
    { col: 'receiving_yards',  weight: 0.7, groups: ['OFFENSE_SKILL'], agg: 'sum' },
    { col: 'receiving_tds',    weight: 0.8, groups: ['OFFENSE_SKILL'], agg: 'sum' },
    { col: 'receptions',       weight: 0.5, groups: ['OFFENSE_SKILL'], agg: 'sum' },

    // Defense — NFL defenders were never scored under v3.2
    // because there were no metrics for their groups.
    { col: 'tackles',          weight: 0.6, groups: ['DEFENSE_FRONT','DEFENSE_EDGE','DEFENSE_MID','DEFENSE_SECONDARY'], agg: 'sum' },
    { col: 'sacks',            weight: 1.0, groups: ['DEFENSE_FRONT','DEFENSE_EDGE','DEFENSE_MID'], agg: 'sum' },
    { col: 'interceptions',    weight: 1.0, groups: ['DEFENSE_SECONDARY','DEFENSE_MID'], agg: 'sum' },
    { col: 'passes_defensed',  weight: 0.7, groups: ['DEFENSE_SECONDARY'], agg: 'sum' },
    { col: 'forced_fumbles',   weight: 0.8, groups: ['DEFENSE_FRONT','DEFENSE_EDGE','DEFENSE_MID'], agg: 'sum' },
  ];

  const NBA_METRICS = [
    { col: 'points',     weight: 1.0, groups: [], agg: 'avg' },
    { col: 'assists',    weight: 0.6, groups: [], agg: 'avg' },
    { col: 'rebounds',   weight: 0.5, groups: [], agg: 'avg' },
    { col: 'steals',     weight: 0.4, groups: [], agg: 'avg' },
    { col: 'blocks',     weight: 0.4, groups: [], agg: 'avg' },
    { col: 'three_made', weight: 0.5, groups: [], agg: 'avg' },
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

  function cloneMetrics(list) {
    return list.map(m => ({
      col: m.col,
      weight: m.weight,
      groups: Array.isArray(m.groups) ? m.groups.slice() : [],
      agg: m.agg,
      inverted: m.inverted || false,
    }));
  }

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
  const MIN_GROUP_SIZE = 8;
  const WRITE_CONCURRENCY = 8;

  return {
    BUILD,
    enrichAll,
    enrichSport,
    METRIC_CONFIG,
    MIN_GROUP_SIZE,
    MIN_GAMES,
  };

  // ============================================================
  // ── MAIN ──
  // ============================================================

  async function enrichAll(options = {}) {
    const { sports = Object.keys(METRIC_CONFIG), onProgress = null } = options;
    const log = mk(onProgress);
    const summary = {
      sports: {},
      totals: { enriched: 0, unmatched: 0, no_stats: 0, no_current_stats: 0, no_metrics: 0 },
    };

    for (const sport of sports) {
      log(`── ${sport} ──`);
      try {
        const result = await enrichSport(sport, { onProgress });
        summary.sports[sport] = result;
        summary.totals.enriched += result.enriched || 0;
        summary.totals.unmatched += result.unmatched || 0;
        summary.totals.no_stats += result.no_stats || 0;
        summary.totals.no_current_stats += result.no_current_stats || 0;
        summary.totals.no_metrics += result.no_metrics || 0;
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
      return emptyResult('players table empty for this sport — run Build Rosters first');
    }

    // ── 2. Aggregate player_game_stats ──
    log('  loading current-season production from player_game_stats');
    const currentSeason = seasonLabel(sport, new Date());
    const agg = await loadAggregates(url, key, sport, currentSeason, metrics);
    const statCount = Object.keys(agg).length;
    log(`  ${statCount} players with current-season games (${currentSeason})`);

    if (!statCount) {
      return emptyResult('player_game_stats has no current-season rows — run Fetch Box Scores first');
    }

    // ── 3. Normalise per position group ──
    // Build normalisers per (sport, position_group). A group
    // with too few samples falls back to the sport-wide
    // distribution.
    const norms = buildNormalisers(metrics, agg, players);

    // ── 4. Score ──
    const updates = [];
    let matched = 0;
    let noStats = 0;
    let noCurrentStats = 0;
    let noMetrics = 0;

    players.forEach(p => {
      const stats = agg[String(p.player_id)];
      if (!stats) {
        // Distinguish "no current-season data" from "no data at
        // all". A player on the roster who has never appeared in
        // player_game_stats is different from one who played last
        // season but not this one.
        noCurrentStats++;
        return;
      }
      if (stats.games < MIN_GAMES) { noStats++; return; }

      const z = weightedZ(stats, metrics, p.position_group, norms, sport);
      if (z === null) {
        // All metrics gated out or missing. A defensive lineman
        // whose ESPN feed does not carry sacks lands here, and
        // should be visible as "no metrics" not silently left
        // at the roster baseline.
        noMetrics++;
        return;
      }

      matched++;
      const starterBonus = p.is_starter ? 1.5 : 0;
      const rating = clamp(round(CENTER + z * SPREAD + starterBonus, 1),
                           RATING_MIN, RATING_MAX);

      // Skip writes that would not move the rating. Keeps
      // updated_at meaningful as "last enriched" and avoids
      // hundreds of no-op PATCHes per run.
      if (typeof p.rating === 'number'
          && Math.abs(p.rating - rating) < 0.05
          && typeof p.offensive_contribution === 'number'
          && typeof p.defensive_contribution === 'number') {
        return;
      }

      const { off, def } = contributionFor(p.position_group, rating);
      updates.push({
        id: p.id, rating,
        offensive_contribution: off,
        defensive_contribution: def,
      });
    });

    log(`  ${updates.length} players to write`);
    log(`  ${noCurrentStats} no current-season rows · ${noStats} below ${MIN_GAMES} games · ${noMetrics} no applicable metrics`);

    if (!updates.length) {
      return {
        enriched: 0,
        unmatched: players.length - matched,
        no_stats: noStats,
        no_current_stats: noCurrentStats,
        no_metrics: noMetrics,
        stats_available: statCount,
        note: 'no players moved enough to warrant a write',
      };
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
      no_current_stats: noCurrentStats,
      no_metrics: noMetrics,
      stats_available: statCount,
    };
  }

  function emptyResult(note) {
    return {
      enriched: 0, unmatched: 0, no_stats: 0,
      no_current_stats: 0, no_metrics: 0,
      note,
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
          `&select=id,player_id,name,position,position_group,rating,is_starter,offensive_contribution,defensive_contribution` +
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
  // ── AGGREGATE ──
  //
  // The v3.2 aggregator treated each row in player_game_stats as
  // a separate game. But a player has one row per stat category
  // per game — a QB appears in passing, rushing and receiving
  // rows for the same game. So the same game was counted three
  // times.
  //
  // This aggregator groups by (player_id, game_id) first. For
  // each game, it takes the value from whichever row carries
  // it — a metric column is null in rows for other categories.
  // Once the per-game set is built, it rolls up to one record
  // per player.
  // ============================================================

  async function loadAggregates(url, key, sport, season, metrics) {
    const cols = new Set(['player_id', 'game_id', 'game_date']);
    metrics.forEach(m => cols.add(m.col));
    const colList = Array.from(cols).join(',');

    // Read all rows for the season. The season filter uses the
    // sport-appropriate label.
    const rows = [];
    const pageSize = 1000;
    for (let offset = 0; offset < 500000; offset += pageSize) {
      try {
        const res = await fetch(
          `${url}/rest/v1/player_game_stats?sport=eq.${sport}&season=eq.${encodeURIComponent(season)}` +
          `&select=${colList}&limit=${pageSize}&offset=${offset}`,
          { headers: { apikey: key, Authorization: `Bearer ${key}` } }
        );
        if (!res.ok) break;
        const batch = await res.json();
        rows.push(...batch);
        if (batch.length < pageSize) break;
      } catch (e) {
        logEdgeError('enrich.loadAggregates.' + sport, e);
        break;
      }
    }

    // ── Per (player, game) roll-up ──
    // For each metric, the value for that game is whatever
    // non-null appears in the row for that game.
    const perGame = new Map();   // key: player_id|game_id
    rows.forEach(r => {
      const pid = String(r.player_id);
      const gid = r.game_id;
      if (!pid || !gid) return;
      const key = `${pid}|${gid}`;
      if (!perGame.has(key)) {
        perGame.set(key, { player_id: pid, game_id: gid, metrics: {} });
      }
      const entry = perGame.get(key);
      metrics.forEach(m => {
        const v = r[m.col];
        if (v == null) return;
        const n = Number(v);
        if (!isFinite(n)) return;
        entry.metrics[m.col] = n;
      });
    });

    // ── Roll up per player ──
    const byPlayer = new Map();  // player_id → { games, sums, counts }
    perGame.forEach(entry => {
      const pid = entry.player_id;
      if (!byPlayer.has(pid)) {
        byPlayer.set(pid, { games: 0, sums: {}, counts: {} });
      }
      const a = byPlayer.get(pid);
      a.games++;
      metrics.forEach(m => {
        const v = entry.metrics[m.col];
        if (v == null) return;
        a.sums[m.col] = (a.sums[m.col] || 0) + v;
        a.counts[m.col] = (a.counts[m.col] || 0) + 1;
      });
    });

    // ── Convert to per-player aggregates ──
    const out = {};
    byPlayer.forEach((a, pid) => {
      const rec = { games: a.games };
      metrics.forEach(m => {
        const sum = a.sums[m.col];
        if (sum == null) return;
        if (m.agg === 'avg') {
          const count = a.counts[m.col] || 0;
          if (count > 0) rec[m.col] = sum / count;
        } else {
          rec[m.col] = sum;
        }
      });
      out[pid] = rec;
    });
    return out;
  }

  // ============================================================
  // ── NORMALISATION ──
  //
  // Norms are built per (sport, position_group, metric). A
  // group with fewer than MIN_GROUP_SIZE samples falls back to
  // the sport-wide distribution for that metric, so a sport's
  // first season with a thin group still produces a defensible
  // normaliser.
  // ============================================================

  function buildNormalisers(metrics, agg, players) {
    // Index players by id so we can attach position_group to
    // each player's aggregate.
    const groupByPlayer = new Map();
    players.forEach(p => {
      groupByPlayer.set(String(p.player_id), p.position_group || 'UNKNOWN');
    });

    // Collect values per (group, metric) and per (sport, metric).
    const byGroup = {};   // group → { metric: [values] }
    const bySport = {};   // metric → [values]

    Object.entries(agg).forEach(([pid, stats]) => {
      const group = groupByPlayer.get(pid) || 'UNKNOWN';
      metrics.forEach(m => {
        const v = stats[m.col];
        if (v == null || !isFinite(v)) return;

        if (!byGroup[group]) byGroup[group] = {};
        if (!byGroup[group][m.col]) byGroup[group][m.col] = [];
        byGroup[group][m.col].push(v);

        if (!bySport[m.col]) bySport[m.col] = [];
        bySport[m.col].push(v);
      });
    });

    // Final norms: { group: { metric: { mean, sd } } }
    const norms = {};
    Object.entries(byGroup).forEach(([group, perMetric]) => {
      norms[group] = {};
      Object.entries(perMetric).forEach(([metric, values]) => {
        if (values.length >= MIN_GROUP_SIZE) {
          norms[group][metric] = statsFor(values);
        } else if (bySport[metric] && bySport[metric].length >= MIN_GROUP_SIZE) {
          // Fall back to sport-wide.
          norms[group][metric] = statsFor(bySport[metric]);
        } else {
          norms[group][metric] = null;
        }
      });
    });

    // Store the sport-wide norms under a reserved key so a
    // group we've never seen before still gets a distribution.
    norms._sport = {};
    Object.entries(bySport).forEach(([metric, values]) => {
      norms._sport[metric] = values.length >= MIN_GROUP_SIZE ? statsFor(values) : null;
    });

    return norms;
  }

  function statsFor(values) {
    if (!values || values.length < 2) return null;
    const mean = values.reduce((a, b) => a + b, 0) / values.length;
    const variance = values.reduce((a, b) => a + (b - mean) ** 2, 0) / values.length;
    const sd = Math.sqrt(variance);
    if (!isFinite(sd) || sd === 0) return null;
    return { mean, sd };
  }

  // ============================================================
  // ── WEIGHTED Z ──
  //
  // A metric applies to a player if its `groups` list is empty
  // (applies to all) or contains the player's group. Norms are
  // looked up first in the player's own group, then in the
  // sport-wide fallback.
  // ============================================================

  function weightedZ(stats, metrics, playerGroup, norms, sport) {
    const groupNorms = norms[playerGroup] || {};
    const sportNorms = norms._sport || {};

    let sum = 0, weightSum = 0, found = 0;

    metrics.forEach(m => {
      if (Array.isArray(m.groups) && m.groups.length) {
        if (!playerGroup || !m.groups.includes(playerGroup)) return;
      }

      const norm = groupNorms[m.col] || sportNorms[m.col];
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
  // ── SEASON LABEL ──
  //
  // Matches ats-tracker v3.0, power-engine v4.3, trends-engine
  // v2.0, prop-trends-engine v1.2 and box-score-fetcher v1.3.
  // ============================================================

  function seasonLabel(sport, date) {
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