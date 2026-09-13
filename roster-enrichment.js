// ============================================================
// EDGE — ROSTER ENRICHMENT v1.0
// Pulls real per-player production stats from ESPN, computes a
// percentile rank within position group, converts to a rating
// on the 40-95 scale. Overwrites the placeholder ratings that
// roster-engine.js wrote.
//
// Flow:
//   1. Fetch ESPN stat leaders per sport (one call per metric)
//   2. Build player_id → { metric: value }
//   3. For each player in the players table, compute percentile
//      within their position group and derive the rating
//   4. Recompute offensive/defensive contribution from the new
//      rating and upsert back to Supabase
// ============================================================

const EDGE_ROSTER_ENRICH = (() => {

  const SUPABASE_URL = () => localStorage.getItem('edge_supabase_url');
  const SUPABASE_KEY = () => localStorage.getItem('edge_supabase_key');

  const ESPN_MAP = {
    NFL:   { path: 'football/nfl',                 league: 'nfl' },
    NBA:   { path: 'basketball/nba',               league: 'nba' },
    MLB:   { path: 'baseball/mlb',                 league: 'mlb' },
    NHL:   { path: 'hockey/nhl',                   league: 'nhl' },
    NCAAF: { path: 'football/college-football',    league: 'college-football' },
    NCAAB: { path: 'basketball/mens-college-basketball', league: 'mens-college-basketball' },
    MLS:   { path: 'soccer/usa.1',                 league: 'usa.1' },
  };

  // For each sport, define the metrics that matter and how they
  // roll up per position group. Metrics are from the ESPN leaders
  // endpoint; percentile computed within each position group.
  const METRIC_CONFIG = {
    NFL: {
      categories: [
        { name: 'passingTouchdowns', group: 'OFFENSE_SKILL', weight: 1.0 },
        { name: 'passingYards',       group: 'OFFENSE_SKILL', weight: 0.8 },
        { name: 'rushingYards',       group: 'OFFENSE_SKILL', weight: 0.7 },
        { name: 'receivingYards',     group: 'OFFENSE_SKILL', weight: 0.7 },
        { name: 'sacks',              group: 'DEFENSE_EDGE',  weight: 1.0 },
        { name: 'tackles',            group: 'DEFENSE_MID',   weight: 0.6 },
        { name: 'interceptions',      group: 'DEFENSE_SECONDARY', weight: 0.9 },
      ],
    },
    NBA: {
      categories: [
        { name: 'pointsPerGame',      group: 'ALL', weight: 1.0 },
        { name: 'assistsPerGame',     group: 'ALL', weight: 0.6 },
        { name: 'reboundsPerGame',    group: 'ALL', weight: 0.5 },
        { name: 'fieldGoalPct',       group: 'ALL', weight: 0.5 },
      ],
    },
    MLB: {
      categories: [
        { name: 'battingAverage',     group: 'HITTER', weight: 0.7 },
        { name: 'homeRuns',           group: 'HITTER', weight: 0.9 },
        { name: 'RBIs',               group: 'HITTER', weight: 0.7 },
        { name: 'ERA',                group: 'PITCHER', weight: 1.0, inverted: true },
        { name: 'strikeouts',         group: 'PITCHER', weight: 0.8 },
        { name: 'wins',               group: 'PITCHER', weight: 0.4 },
      ],
    },
    NHL: {
      categories: [
        { name: 'goals',              group: 'FORWARD', weight: 0.9 },
        { name: 'assists',            group: 'FORWARD', weight: 0.8 },
        { name: 'points',             group: 'FORWARD', weight: 1.0 },
        { name: 'goalsAgainstAverage',group: 'GOALIE', weight: 1.0, inverted: true },
        { name: 'savePct',            group: 'GOALIE', weight: 1.0 },
      ],
    },
    NCAAF: {
      categories: [
        { name: 'passingTouchdowns', group: 'OFFENSE_SKILL', weight: 1.0 },
        { name: 'passingYards',       group: 'OFFENSE_SKILL', weight: 0.8 },
        { name: 'rushingYards',       group: 'OFFENSE_SKILL', weight: 0.7 },
        { name: 'receivingYards',     group: 'OFFENSE_SKILL', weight: 0.7 },
        { name: 'sacks',              group: 'DEFENSE_EDGE',  weight: 1.0 },
        { name: 'interceptions',      group: 'DEFENSE_SECONDARY', weight: 0.9 },
      ],
    },
    NCAAB: {
      categories: [
        { name: 'pointsPerGame',      group: 'ALL', weight: 1.0 },
        { name: 'assistsPerGame',     group: 'ALL', weight: 0.6 },
        { name: 'reboundsPerGame',    group: 'ALL', weight: 0.5 },
      ],
    },
    MLS: {
      categories: [
        { name: 'goals',              group: 'ALL', weight: 1.0 },
        { name: 'assists',            group: 'ALL', weight: 0.7 },
      ],
    },
  };

  // Rating envelope for enriched players. Anyone with real stats
  // can reach up to 95; floor is 42 so backups still register.
  const RATING_MIN = 42;
  const RATING_MAX = 95;

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
    const log = makeLogger(onProgress);
    const summary = { sports: {}, totals: { enriched: 0, unmatched: 0 } };

    for (const sport of sports) {
      log(`── ${sport} ──`);
      try {
        const result = await enrichSport(sport, { onProgress });
        summary.sports[sport] = result;
        summary.totals.enriched += result.enriched;
        summary.totals.unmatched += result.unmatched;
      } catch (e) {
        log(`${sport} failed: ${e.message}`);
        summary.sports[sport] = { error: e.message };
      }
    }

    return summary;
  }

  async function enrichSport(sport, options = {}) {
    const log = makeLogger(options.onProgress);
    const url = SUPABASE_URL();
    const key = SUPABASE_KEY();
    if (!url || !key) throw new Error('Supabase not connected');

    const config = METRIC_CONFIG[sport];
    if (!config) throw new Error(`No metric config for ${sport}`);

    // ── 1. Fetch ESPN leaders ──
    log(`  fetching leaders`);
    const leaders = await fetchLeaders(sport, config.categories);
    const playerStats = buildPlayerStatMap(leaders);
    log(`  ${Object.keys(playerStats).length} players in leaders`);

    if (!Object.keys(playerStats).length) {
      return { enriched: 0, unmatched: 0, note: 'No leaders returned' };
    }

    // ── 2. Load existing players from Supabase ──
    log(`  loading roster rows`);
    const rosterRes = await fetch(
      `${url}/rest/v1/players?sport=eq.${sport}&select=id,player_id,name,position,position_group,rating,is_starter,team_name`,
      { headers: { apikey: key, Authorization: `Bearer ${key}` } }
    );
    if (!rosterRes.ok) throw new Error('Failed to load players');
    const players = await rosterRes.json();
    log(`  ${players.length} players in table`);

    // ── 3. Compute new ratings ──
    // For each player group, compute the distribution of weighted
    // stat scores across all matched players. Then percentile-rank
    // each player within their group and map to rating range.
    const scoresByGroup = {};
    const matchedPlayers = [];

    players.forEach(p => {
      const stats = playerStats[p.player_id];
      if (!stats) return;

      // Position group may differ between our table and the metric
      // config (e.g. we store FORWARD while config uses FORWARD). Align.
      const weightScore = computeWeightedScore(stats, config.categories, p.position_group);
      if (weightScore == null) return;

      const group = p.position_group || 'UNKNOWN';
      if (!scoresByGroup[group]) scoresByGroup[group] = [];
      scoresByGroup[group].push({ player: p, score: weightScore });
      matchedPlayers.push(p);
    });

    if (!matchedPlayers.length) {
      return { enriched: 0, unmatched: players.length };
    }

    // Sort each group's scores to compute percentile ranks
    Object.values(scoresByGroup).forEach(arr => arr.sort((a, b) => a.score - b.score));

    // For each matched player, find their percentile in the group
    // and map to rating.
    const ratingUpdates = [];
    Object.entries(scoresByGroup).forEach(([group, arr]) => {
      arr.forEach((entry, i) => {
        const percentile = arr.length > 1 ? i / (arr.length - 1) : 0.5;
        const rating = RATING_MIN + (RATING_MAX - RATING_MIN) * percentile;
        // Starters get a small boost; non-starters a small cut.
        const starterBonus = entry.player.is_starter ? 2 : 0;
        const finalRating = clamp(round(rating + starterBonus, 1), RATING_MIN, RATING_MAX);

        // Recompute contributions from rating and position weight.
        const { off, def } = contributionFromRating(group, finalRating);

        ratingUpdates.push({
          id: entry.player.id,
          rating: finalRating,
          offensive_contribution: off,
          defensive_contribution: def,
          updated_at: new Date().toISOString(),
        });
      });
    });

    log(`  ${ratingUpdates.length} players to enrich`);

    // ── 4. Upsert in chunks ──
    const chunkSize = 200;
    let written = 0;
    for (let i = 0; i < ratingUpdates.length; i += chunkSize) {
      const chunk = ratingUpdates.slice(i, i + chunkSize);
      try {
        const res = await fetch(`${url}/rest/v1/players?id=in.(${chunk.map(u => `"${u.id}"`).join(',')})`, {
          method: 'PATCH',
          headers: {
            apikey: key, Authorization: `Bearer ${key}`,
            'Content-Type': 'application/json',
            Prefer: 'return=minimal',
          },
          // PostgREST doesn't support bulk PATCH by id with different
          // bodies in one call. Use individual PATCHes in parallel
          // with a small concurrency limit instead.
        });
      } catch {}
    }

    // Do the real updates — one PATCH per player, batched by concurrency
    await parallelMap(ratingUpdates, 8, async u => {
      try {
        await fetch(`${url}/rest/v1/players?id=eq.${u.id}`, {
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
            updated_at: u.updated_at,
          }),
        });
        written += 1;
      } catch {}
    });

    log(`  wrote ${written} enriched players`);

    return {
      enriched: written,
      unmatched: players.length - matchedPlayers.length,
    };
  }

  // ============================================================
  // ── ESPN LEADERS ──
  // ============================================================

  async function fetchLeaders(sport, categories) {
    const cfg = ESPN_MAP[sport];
    if (!cfg) return {};

    const year = new Date().getFullYear();
    const urls = [
      `https://site.api.espn.com/apis/site/v2/sports/${cfg.path}/leaders?season=${year}`,
      `https://site.api.espn.com/apis/site/v2/sports/${cfg.path}/leaders`,
    ];

    for (const url of urls) {
      try {
        const res = await fetch(url, { cache: 'no-store' });
        if (!res.ok) continue;
        const data = await res.json();
        const flat = flattenLeaders(data, categories);
        if (Object.keys(flat).length) return flat;
      } catch {}
    }
    return {};
  }

  // ESPN's leaders response shape varies. Two shapes we handle:
  //   1) { categories: [ { name, leaders: [ { athlete: {...}, value } ] } ] }
  //   2) { leaders: [ { name: "passingYards", leaders: [...] } ] }
  function flattenLeaders(data, wantedCategories) {
    const wanted = new Set(wantedCategories.map(c => c.name.toLowerCase()));
    const out = {};

    const buckets =
      Array.isArray(data.categories) ? data.categories :
      Array.isArray(data.leaders)    ? data.leaders    : [];

    buckets.forEach(cat => {
      const catName = String(cat.name || cat.displayName || '').toLowerCase();
      if (!wanted.has(catName)) return;

      (cat.leaders || []).forEach(entry => {
        const athlete = entry.athlete;
        if (!athlete || !athlete.id) return;
        const id = String(athlete.id);
        const value = parseFloat(entry.value ?? entry.displayValue ?? '0') || 0;
        if (!out[id]) out[id] = {};
        out[id][catName] = value;
      });
    });

    return out;
  }

  function buildPlayerStatMap(leadersFlat) {
    return leadersFlat;
  }

  // ============================================================
  // ── SCORING ──
  // ============================================================

  // Compute a weighted z-score for a player based on their stats
  // across the configured categories. Higher = better.
  function computeWeightedScore(stats, categories, playerGroup) {
    let totalWeight = 0;
    let score = 0;
    let found = 0;

    categories.forEach(cat => {
      const key = cat.name.toLowerCase();

      // Category only applies to players in the matching group.
      if (cat.group !== 'ALL') {
        if (playerGroup === 'HITTER' || playerGroup === 'PITCHER') {
          // MLB groups
          const isHitter = ['CATCHER','INFIELD','OUTFIELD','DH'].includes(playerGroup);
          const isPitcher = playerGroup === 'PITCHER_START' || playerGroup === 'PITCHER_RELIEF';
          if (cat.group === 'HITTER' && !isHitter) return;
          if (cat.group === 'PITCHER' && !isPitcher) return;
        } else if (cat.group === 'FORWARD' || cat.group === 'GOALIE') {
          if (cat.group !== playerGroup) return;
        } else if (cat.group === 'OFFENSE_SKILL' || cat.group === 'OFFENSE_LINE' ||
                   cat.group === 'DEFENSE_FRONT' || cat.group === 'DEFENSE_EDGE' ||
                   cat.group === 'DEFENSE_MID' || cat.group === 'DEFENSE_SECONDARY') {
          if (cat.group !== playerGroup) return;
        }
      }

      const val = stats[key];
      if (val == null || !isFinite(val)) return;

      // Inverted metrics (ERA, GAA) — lower is better.
      const effective = cat.inverted ? -val : val;
      score += effective * (cat.weight || 1);
      totalWeight += cat.weight || 1;
      found += 1;
    });

    if (!found) return null;
    return score / Math.max(totalWeight, 0.001);
  }

  function contributionFromRating(group, rating) {
    // Simple weight that matches roster-engine's positional weighting.
    const weight = POSITION_WEIGHTS_LOOKUP(group);
    const base = rating * weight;

    const offenseGroups = new Set([
      'OFFENSE_SKILL', 'OFFENSE_LINE', 'GUARD', 'WING', 'BIG',
      'PITCHER_START', 'PITCHER_RELIEF', 'CATCHER', 'INFIELD', 'OUTFIELD', 'DH',
      'FORWARD', 'MIDFIELD', 'HITTER',
    ]);
    const defenseGroups = new Set([
      'DEFENSE_FRONT', 'DEFENSE_EDGE', 'DEFENSE_MID', 'DEFENSE_SECONDARY',
      'GOALIE', 'GOALKEEPER', 'DEFENSE', 'PITCHER',
    ]);

    if (offenseGroups.has(group) && defenseGroups.has(group)) {
      return { off: round(base / 2, 2), def: round(base / 2, 2) };
    }
    if (offenseGroups.has(group)) return { off: round(base, 2), def: 0 };
    if (defenseGroups.has(group)) return { off: 0, def: round(base, 2) };
    return { off: round(base / 2, 2), def: round(base / 2, 2) };
  }

  function POSITION_WEIGHTS_LOOKUP(group) {
    return {
      OFFENSE_SKILL: 0.55,
      OFFENSE_LINE: 0.45,
      DEFENSE_FRONT: 0.40,
      DEFENSE_EDGE: 0.55,
      DEFENSE_MID: 0.40,
      DEFENSE_SECONDARY: 0.50,
      GUARD: 0.95,
      WING: 0.90,
      BIG: 0.85,
      PITCHER_START: 1.00,
      PITCHER_RELIEF: 0.40,
      PITCHER: 0.70,
      CATCHER: 0.55,
      INFIELD: 0.55,
      OUTFIELD: 0.55,
      DH: 0.50,
      HITTER: 0.55,
      GOALIE: 1.00,
      FORWARD: 0.75,
      MIDFIELD: 0.80,
      DEFENSE: 0.75,
      GOALKEEPER: 1.00,
    }[group] || 0.40;
  }

  // ============================================================
  // ── UTILITIES ──
  // ============================================================

  async function parallelMap(items, concurrency, fn) {
    const queue = [...items];
    const workers = Array.from({ length: concurrency }, async () => {
      while (queue.length) {
        const item = queue.shift();
        if (!item) break;
        await fn(item);
      }
    });
    await Promise.all(workers);
  }

  function makeLogger(onProgress) {
    return (msg) => { if (typeof onProgress === 'function') onProgress(msg); };
  }

  function clamp(v, min, max) { return Math.max(min, Math.min(max, v)); }
  function round(v, d) { const f = Math.pow(10, d); return Math.round(v * f) / f; }

})();

if (typeof window !== 'undefined') window.EDGE_ROSTER_ENRICH = EDGE_ROSTER_ENRICH;