// ============================================================
// EDGE — ROSTER ENRICHMENT v3.4
//
// Reads production from player_game_stats and refines each
// player's rating from the roster baseline to a 40-95 scale.
//
// v3.4 changes:
//
//   · NFL defensive metrics are gone. The v3.3 config asked
//     for tackles, sacks, interceptions, passes_defensed and
//     forced_fumbles on NFL defensive groups. ESPN's box score
//     summary does not carry those fields, so the columns do
//     not exist on player_game_stats and the enrichment query
//     failed with a 400 for the whole sport — every NFL
//     player came back unreached. The five metrics are
//     removed. NFL defensive players now fall through to the
//     no_metrics counter, which is the honest report: we do
//     not have defensive production data, and their rating
//     stays at the roster baseline.
//
//     Adding defensive ratings later is a separate job —
//     either scraping the ESPN tackle feed, or an external
//     source — and should not be faked by leaving a metric in
//     the config that cannot fire.
//
//   · position_group is read from the roster row with an
//     explicit fallback. If the column is missing on a stale
//     roster row, the player is skipped from enrichment
//     rather than dropped into the sport-wide distribution
//     bucket as if they had no position. This is rare but
//     shows up after a schema change.
//
//   · The write path no longer sends an `enriched` flag.
//     Preservation is decided by the roster engine on the
//     next rebuild, based on whether position_group and
//     is_starter still match. Nothing here needs to say the
//     rating came from enrichment — the shape comparison
//     handles it.
//
//   · Defensive players on every sport are counted in a new
//     `no_metrics` bucket rather than silently skipped, so
//     the run summary tells the truth about who got rated.
//
// v3.3 changes (retained):
//   · Per-game counting is correct. Rows are grouped by
//     (player_id, game_id) before rolling up, so a QB who
//     appears in a passing row and a rushing row for the
//     same game is not counted twice.
//   · Only the current season is loaded.
//   · Per-position-group z-scores are real. Metrics normalise
//     within their own (sport, position_group) bucket, with
//     a sport-wide fallback for thin groups.
// ============================================================

const EDGE_ROSTER_ENRICH = (() => {

  const BUILD = 'enrich-20261006-01';

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
  //
  // IMPORTANT: every column listed here must exist on
  // player_game_stats and be populated by box-score-fetcher.js.
  // A metric that names a nonexistent column makes the whole
  // sport's read fail with HTTP 400, not just that one metric.
  // ============================================================

  const NFL_METRICS = [
    // Offensive skill only. Defensive metrics are intentionally
    // absent — the box score does not carry them and the old
    // config's five defensive columns caused the entire NFL
    // enrichment read to fail.
    // Per game, and each position measured against its own position:
    // quarterbacks on passing, backs on rushing, receivers and tight ends
    // on catching. (Season totals across one mixed group rated a
    // receiver against quarterbacks' passing yards.) The old lumped group
    // stays listed for rows written before the split.
    { col: 'passing_yards',    weight: 1.0, groups: ['QB', 'OFFENSE_SKILL'], agg: 'avg' },
    { col: 'passing_tds',      weight: 0.9, groups: ['QB', 'OFFENSE_SKILL'], agg: 'avg' },
    { col: 'interceptions',    weight: 0.6, groups: ['QB'], agg: 'avg', inverted: true },
    { col: 'rushing_yards',    weight: 0.3, groups: ['QB'], agg: 'avg' },
    { col: 'rushing_yards',    weight: 1.0, groups: ['RB', 'OFFENSE_SKILL'], agg: 'avg' },
    { col: 'rushing_tds',      weight: 0.8, groups: ['RB', 'OFFENSE_SKILL'], agg: 'avg' },
    { col: 'receiving_yards',  weight: 0.4, groups: ['RB'], agg: 'avg' },
    { col: 'receiving_yards',  weight: 1.0, groups: ['WR', 'TE', 'OFFENSE_SKILL'], agg: 'avg' },
    { col: 'receptions',       weight: 0.7, groups: ['WR', 'TE', 'OFFENSE_SKILL'], agg: 'avg' },
    { col: 'receiving_tds',    weight: 0.8, groups: ['WR', 'TE', 'OFFENSE_SKILL'], agg: 'avg' },
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
    QB: 0.75, RB: 0.45, WR: 0.50, TE: 0.40,
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
    'QB', 'RB', 'WR', 'TE',
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

    // Early in a season most players have fewer than MIN_GAMES games, so
    // almost no one was rated and everyone kept the roster template
    // (the -22.6 seen on backups everywhere). Until a player has
    // MIN_GAMES this season, last season's per-game numbers fill in,
    // weighted by how many games each season has.
    const prevSeason = String(Number(currentSeason) - 1);
    const thin = Object.entries(agg).filter(([, a]) => (a.games || 0) < MIN_GAMES);
    if (thin.length || statCount < players.length / 4) {
      const prev = await loadAggregates(url, key, sport, prevSeason, metrics);
      let filled = 0;
      const mergeOne = (cur, old) => {
        const out = { games: (cur?.games || 0) + (old?.games || 0) };
        metrics.forEach(m => {
          const c = cur?.[m.col], o = old?.[m.col];
          if (c == null && o == null) return;
          if (m.agg === 'avg') {
            const cg = cur?.games || 0, og = old?.games || 0;
            out[m.col] = (c != null && o != null) ? (c * cg + o * og) / Math.max(1, cg + og) : (c ?? o);
          } else {
            out[m.col] = (c || 0) + (o || 0);
          }
        });
        return out;
      };
      Object.entries(prev).forEach(([pid, old]) => {
        const cur = agg[pid];
        if (cur && (cur.games || 0) >= MIN_GAMES) return;
        agg[pid] = mergeOne(cur, old);
        filled++;
      });
      log(`  ${filled} players filled in with last season (${prevSeason}) until they have ${MIN_GAMES} games this season`);
    }

    if (!statCount) {
      return emptyResult('player_game_stats has no current-season rows — run Fetch Box Scores first');
    }

    // ── 3. Normalise per position group ──
    const norms = buildNormalisers(metrics, agg, players);

    // ── 4. Score ──
    const updates = [];
    let matched = 0;
    let noStats = 0;
    let noCurrentStats = 0;
    let noMetrics = 0;
    let noGroup = 0;

    players.forEach(p => {
      // A player with no position_group cannot be scored
      // against a group distribution, and dropping them into
      // the sport-wide bucket would mix a lineman's stats into
      // a quarterback's. Skip and report.
      if (!p.position_group) { noGroup++; return; }

      const stats = agg[String(p.player_id)];
      if (!stats) {
        noCurrentStats++;
        return;
      }
      if (stats.games < MIN_GAMES) { noStats++; return; }

      const z = weightedZ(stats, metrics, p.position_group, norms, sport);
      if (z === null) {
        // All metrics gated out or missing. This is the
        // expected path for every NFL defensive player — the
        // box score does not carry the fields needed to rate
        // them, so their rating stays at the roster baseline.
        // Reported honestly, not silently skipped.
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
    log(`  ${noCurrentStats} no current-season rows · ${noStats} below ${MIN_GAMES} games · ` +
        `${noMetrics} no applicable metrics · ${noGroup} missing position group`);

    if (!updates.length) {
      return {
        enriched: 0,
        unmatched: players.length - matched,
        no_stats: noStats,
        no_current_stats: noCurrentStats,
        no_metrics: noMetrics,
        no_group: noGroup,
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
      no_group: noGroup,
      stats_available: statCount,
    };
  }

  function emptyResult(note) {
    return {
      enriched: 0, unmatched: 0, no_stats: 0,
      no_current_stats: 0, no_metrics: 0, no_group: 0,
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
  // Groups by (player_id, game_id) first. For each game, it
  // takes the value from whichever row carries it — a metric
  // column is null in rows for other categories. Once the
  // per-game set is built, it rolls up to one record per
  // player.
  // ============================================================

  async function loadAggregates(url, key, sport, season, metrics) {
    const cols = new Set(['player_id', 'game_id', 'game_date']);
    metrics.forEach(m => cols.add(m.col));
    const colList = Array.from(cols).join(',');

    const rows = [];
    const pageSize = 1000;
    for (let offset = 0; offset < 500000; offset += pageSize) {
      try {
        const res = await fetch(
          `${url}/rest/v1/player_game_stats?sport=eq.${sport}&season=eq.${encodeURIComponent(season)}` +
          `&select=${colList}&limit=${pageSize}&offset=${offset}`,
          { headers: { apikey: key, Authorization: `Bearer ${key}` } }
        );
        if (!res.ok) {
          logEdgeError('enrich.loadAggregates.' + sport, new Error('HTTP ' + res.status));
          break;
        }
        const batch = await res.json();
        rows.push(...batch);
        if (batch.length < pageSize) break;
      } catch (e) {
        logEdgeError('enrich.loadAggregates.' + sport, e);
        break;
      }
    }

    // ── Per (player, game) roll-up ──
    const perGame = new Map();
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
    const byPlayer = new Map();
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
  // ============================================================

  function buildNormalisers(metrics, agg, players) {
    const groupByPlayer = new Map();
    players.forEach(p => {
      groupByPlayer.set(String(p.player_id), p.position_group || 'UNKNOWN');
    });

    const byGroup = {};
    const bySport = {};

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

    const norms = {};
    Object.entries(byGroup).forEach(([group, perMetric]) => {
      norms[group] = {};
      Object.entries(perMetric).forEach(([metric, values]) => {
        if (values.length >= MIN_GROUP_SIZE) {
          norms[group][metric] = statsFor(values);
        } else if (bySport[metric] && bySport[metric].length >= MIN_GROUP_SIZE) {
          norms[group][metric] = statsFor(bySport[metric]);
        } else {
          norms[group][metric] = null;
        }
      });
    });

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
  // Matches ats-tracker, power-engine, trends-engine,
  // prop-trends-engine and box-score-fetcher.
  // ============================================================

  function seasonLabel(sport, date) {
    const m = date.getMonth() + 1;
    const y = date.getFullYear();

    // WNBA plays inside a calendar year, like MLB and MLS.
    if (sport === 'NBA' || sport === 'NHL' || sport === 'NCAAB') {
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