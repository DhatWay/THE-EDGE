// ============================================================
// EDGE — ROSTER ENRICHMENT v3.0
//
// Reads the players table for a sport, pulls real production
// stats from ESPN for each player who has them, z-scores those
// stats across the league by position group, and replaces the
// baseline rating with a production-derived one.
//
// v3.0 changes from v2:
//   · WNBA added
//   · ESPN leaders endpoint tries three URL shapes, because the
//     site.api.espn.com surface has been dropping CORS headers
//     on some endpoints (the /teams one is already gone). Falls
//     back to core API if site fails.
//   · Per-sport progress: how many players matched, how many
//     had stats, how many were enriched
//   · Never writes an empty batch — a run that fetched nothing
//     leaves the existing ratings in place
//   · Works off the existing players table only — no ESPN
//     calls for roster names
// ============================================================

const EDGE_ROSTER_ENRICH = (() => {

  const SUPABASE_URL = () => localStorage.getItem('edge_supabase_url');
  const SUPABASE_KEY = () => localStorage.getItem('edge_supabase_key');

  const ESPN_MAP = {
    NFL:   { site: 'football/nfl',                       core: ['football','nfl'] },
    NCAAF: { site: 'football/college-football',          core: ['football','college-football'] },
    NBA:   { site: 'basketball/nba',                     core: ['basketball','nba'] },
    WNBA:  { site: 'basketball/wnba',                    core: ['basketball','wnba'] },
    NCAAB: { site: 'basketball/mens-college-basketball', core: ['basketball','mens-college-basketball'] },
    MLB:   { site: 'baseball/mlb',                       core: ['baseball','mlb'] },
    NHL:   { site: 'hockey/nhl',                         core: ['hockey','nhl'] },
    MLS:   { site: 'soccer/usa.1',                       core: ['soccer','usa.1'] },
  };

  // What each position group's contribution is worth. Same table
  // roster-engine uses so contributions scale the same way.
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

  // Each metric: the key ESPN sends, the weight in the blend,
  // which position groups it applies to, and whether higher is
  // worse (ERA, WHIP, goals allowed).
  const METRIC_CONFIG = {
    NFL: [
      { name: 'passingYards',        weight: 0.8, groups: ['OFFENSE_SKILL'] },
      { name: 'passingTouchdowns',   weight: 1.0, groups: ['OFFENSE_SKILL'] },
      { name: 'rushingYards',        weight: 0.7, groups: ['OFFENSE_SKILL'] },
      { name: 'rushingTouchdowns',   weight: 0.8, groups: ['OFFENSE_SKILL'] },
      { name: 'receivingYards',      weight: 0.7, groups: ['OFFENSE_SKILL'] },
      { name: 'receivingTouchdowns', weight: 0.8, groups: ['OFFENSE_SKILL'] },
      { name: 'sacks',               weight: 1.0, groups: ['DEFENSE_EDGE','DEFENSE_FRONT'] },
      { name: 'totalTackles',        weight: 0.6, groups: ['DEFENSE_MID','DEFENSE_FRONT','DEFENSE_SECONDARY'] },
      { name: 'interceptions',       weight: 0.9, groups: ['DEFENSE_SECONDARY','DEFENSE_MID'] },
      { name: 'passesDefended',      weight: 0.6, groups: ['DEFENSE_SECONDARY'] },
    ],
    NBA: [
      { name: 'pointsPerGame',   weight: 1.0, groups: [] },
      { name: 'assistsPerGame',  weight: 0.6, groups: [] },
      { name: 'reboundsPerGame', weight: 0.5, groups: [] },
      { name: 'stealsPerGame',   weight: 0.4, groups: [] },
      { name: 'blocksPerGame',   weight: 0.4, groups: [] },
      { name: 'fieldGoalPct',    weight: 0.5, groups: [] },
    ],
    MLB: [
      { name: 'battingAverage',     weight: 0.7, groups: ['CATCHER','INFIELD','OUTFIELD','DH','HITTER'] },
      { name: 'homeRuns',           weight: 0.9, groups: ['CATCHER','INFIELD','OUTFIELD','DH','HITTER'] },
      { name: 'RBIs',               weight: 0.7, groups: ['CATCHER','INFIELD','OUTFIELD','DH','HITTER'] },
      { name: 'onBasePlusSlugging', weight: 0.9, groups: ['CATCHER','INFIELD','OUTFIELD','DH','HITTER'] },
      { name: 'ERA',                weight: 1.0, groups: ['PITCHER_START','PITCHER_RELIEF','PITCHER'], inverted: true },
      { name: 'WHIP',               weight: 0.8, groups: ['PITCHER_START','PITCHER_RELIEF','PITCHER'], inverted: true },
      { name: 'strikeouts',         weight: 0.8, groups: ['PITCHER_START','PITCHER_RELIEF','PITCHER'] },
      { name: 'wins',               weight: 0.4, groups: ['PITCHER_START','PITCHER'] },
      { name: 'saves',              weight: 0.7, groups: ['PITCHER_RELIEF'] },
    ],
    NHL: [
      { name: 'goals',               weight: 0.9, groups: ['FORWARD','DEFENSE'] },
      { name: 'assists',             weight: 0.8, groups: ['FORWARD','DEFENSE'] },
      { name: 'points',              weight: 1.0, groups: ['FORWARD','DEFENSE'] },
      { name: 'plusMinus',           weight: 0.5, groups: ['FORWARD','DEFENSE'] },
      { name: 'goalsAgainstAverage', weight: 1.0, groups: ['GOALIE'], inverted: true },
      { name: 'savePct',             weight: 1.0, groups: ['GOALIE'] },
      { name: 'wins',                weight: 0.5, groups: ['GOALIE'] },
    ],
    MLS: [
      { name: 'goals',         weight: 1.0, groups: ['FORWARD','MIDFIELD','DEFENSE'] },
      { name: 'assists',       weight: 0.7, groups: ['FORWARD','MIDFIELD','DEFENSE'] },
      { name: 'shotsOnTarget', weight: 0.4, groups: ['FORWARD','MIDFIELD'] },
      { name: 'saves',         weight: 1.0, groups: ['GOALKEEPER'] },
      { name: 'goalsAgainst',  weight: 0.8, groups: ['GOALKEEPER'], inverted: true },
    ],
  };
  METRIC_CONFIG.NCAAF = METRIC_CONFIG.NFL;
  METRIC_CONFIG.NCAAB = METRIC_CONFIG.NBA;
  METRIC_CONFIG.WNBA  = METRIC_CONFIG.NBA;

  // The z-score scale. A z of 0 becomes 62. Each standard
  // deviation moves the rating 11 points. Fixed scale so a 70
  // means the same thing across runs and sports.
  const CENTER = 62;
  const SPREAD = 11;
  const RATING_MIN = 42;
  const RATING_MAX = 95;

  const WRITE_CONCURRENCY = 8;

  return {
    enrichAll,
    enrichSport,
    METRIC_CONFIG,
  };

  // ============================================================
  // ── MAIN ──
  // ============================================================

  async function enrichAll(options = {}) {
    const { sports = Object.keys(ESPN_MAP), onProgress = null } = options;
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

    // ── 1. Roster from the DB ──
    log('  loading roster rows');
    const players = await loadPlayers(url, key, sport);
    log(`  ${players.length} players in table`);
    if (!players.length) {
      return {
        enriched: 0, unmatched: 0, no_stats: 0,
        note: 'players table empty for this sport — run Build Rosters first',
      };
    }

    // ── 2. Production from ESPN ──
    log('  fetching production stats');
    const statsById = await fetchProduction(sport, metrics, log);
    const statCount = Object.keys(statsById).length;
    log(`  ${statCount} players with stats`);
    if (!statCount) {
      return {
        enriched: 0,
        unmatched: players.length,
        no_stats: players.length,
        note: 'ESPN returned no production data — existing ratings untouched',
      };
    }

    // ── 3. Normalise ──
    const norms = buildNormalisers(metrics, statsById);

    // ── 4. Score ──
    const updates = [];
    let matched = 0;
    let noStats = 0;

    players.forEach(p => {
      const stats = statsById[String(p.player_id)];
      if (!stats) { noStats++; return; }

      const z = weightedZ(stats, metrics, p.position_group, norms);
      if (z === null) { noStats++; return; }

      matched++;
      const starterBonus = p.is_starter ? 1.5 : 0;
      const rating = clamp(
        round(CENTER + z * SPREAD + starterBonus, 1),
        RATING_MIN, RATING_MAX
      );

      const { off, def } = contributionFor(p.position_group, rating);
      updates.push({
        id: p.id,
        rating,
        offensive_contribution: off,
        defensive_contribution: def,
      });
    });

    log(`  ${updates.length} players to enrich`);
    if (!updates.length) {
      return {
        enriched: 0, unmatched: players.length - noStats, no_stats: noStats,
        note: 'no id overlap between roster and stats',
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
          `&select=id,player_id,name,position,position_group,rating,is_starter,team_name` +
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
  // ── PRODUCTION FETCH ──
  //
  // ESPN's site.api.espn.com surface has been dropping CORS
  // headers on a few endpoints. The leaders endpoint may be one
  // of them. Try three shapes in order; if all fail, fall back
  // to the core API which serves the same data.
  // ============================================================

  async function fetchProduction(sport, metrics, log) {
    const cfg = ESPN_MAP[sport];
    if (!cfg) return {};

    const year = new Date().getFullYear();
    const wanted = new Set(metrics.map(m => m.name.toLowerCase()));
    const merged = {};

    const siteUrls = [
      `https://site.api.espn.com/apis/site/v3/sports/${cfg.site}/leaders?season=${year}&seasontype=2&limit=500`,
      `https://site.api.espn.com/apis/site/v3/sports/${cfg.site}/leaders?limit=500`,
      `https://site.api.espn.com/apis/site/v2/sports/${cfg.site}/leaders?season=${year}`,
      `https://site.api.espn.com/apis/site/v2/sports/${cfg.site}/leaders`,
    ];

    for (const url of siteUrls) {
      try {
        const res = await fetch(url, { cache: 'no-store' });
        if (!res.ok) continue;
        const data = await res.json();
        absorbLeaders(data, wanted, merged);
        if (Object.keys(merged).length >= 200) break;
      } catch {}
    }

    if (Object.keys(merged).length) return merged;

    // Core API fallback
    try {
      const [espnSport, espnLeague] = cfg.core;
      const coreUrl = `https://sports.core.api.espn.com/v3/sports/${espnSport}/${espnLeague}/leaders?season=${year}`;
      const res = await fetch(coreUrl, { cache: 'no-store' });
      if (res.ok) {
        const data = await res.json();
        absorbLeaders(data, wanted, merged);
      }
    } catch {}

    return merged;
  }

  // Walk any JSON shape ESPN returns and pick up {athlete, value}
  // pairs under a name we care about.
  function absorbLeaders(data, wanted, out) {
    if (!data || typeof data !== 'object') return;

    const buckets = [];
    const visit = node => {
      if (!node || typeof node !== 'object') return;
      if (Array.isArray(node)) { node.forEach(visit); return; }

      if (Array.isArray(node.categories)) {
        node.categories.forEach(c => buckets.push(c));
      }
      if (Array.isArray(node.leaders) && (node.name || node.abbreviation)) {
        buckets.push(node);
      }
      if (Array.isArray(node.items)) {
        node.items.forEach(it => {
          if (it && (it.name || it.abbreviation)) buckets.push(it);
        });
      }
      Object.keys(node).forEach(k => {
        if (k === 'categories' || k === 'items' || k === 'leaders') return;
        if (typeof node[k] === 'object') visit(node[k]);
      });
    };
    visit(data);

    buckets.forEach(cat => {
      const name = String(cat.name || cat.abbreviation || cat.displayName || '').toLowerCase();
      if (!wanted.has(name)) return;

      const entries = Array.isArray(cat.leaders) ? cat.leaders : [];
      entries.forEach(entry => {
        const athlete = entry.athlete || entry.player;
        const id = athlete?.id ?? entry.athleteId;
        if (!id) return;
        const raw = entry.value ?? entry.displayValue ?? entry.statValue;
        const value = parseFloat(raw);
        if (!isFinite(value)) return;
        const k = String(id);
        if (!out[k]) out[k] = {};
        if (out[k][name] === undefined) out[k][name] = value;
      });
    });
  }

  // ============================================================
  // ── NORMALISATION ──
  // ============================================================

  function buildNormalisers(metrics, statsById) {
    const buckets = {};
    metrics.forEach(m => { buckets[m.name.toLowerCase()] = []; });

    Object.values(statsById).forEach(stats => {
      Object.entries(stats).forEach(([k, v]) => {
        if (buckets[k] && isFinite(v)) buckets[k].push(v);
      });
    });

    const norms = {};
    Object.entries(buckets).forEach(([k, values]) => {
      if (values.length < 3) { norms[k] = null; return; }
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
      const key = m.name.toLowerCase();
      if (Array.isArray(m.groups) && m.groups.length) {
        if (!playerGroup || !m.groups.includes(playerGroup)) return;
      }
      const norm = norms[key];
      if (!norm) return;
      const raw = stats[key];
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