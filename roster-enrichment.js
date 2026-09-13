// ============================================================
// EDGE — ROSTER ENRICHMENT v2.0
//
// Replaces the depth-chart baselines that roster-engine.js writes
// with ratings derived from actual production.
//
// What v1 got wrong:
//   · it had no upstream — roster-engine.js was referenced but
//     missing, so the players table was always empty
//   · it summed raw stat values, so passing yards (thousands)
//     drowned out touchdowns (tens); the comment said "z-score"
//     but nothing was normalised
//   · rank-in-group was mapped straight onto 42-95, so the worst
//     player in any group scored exactly 42 no matter how good he
//     was, and a two-man group always produced a 42 and a 95
//   · the MLB gate tested playerGroup against 'HITTER'/'PITCHER'
//     and then re-tested it against position codes that could
//     never match, so no MLB player was ever scored
//   · a bodyless PATCH ran against every player before the real
//     write, doing nothing but burning requests
//
// v2 z-scores each metric across the league, weights the z-scores,
// then maps to a rating on a fixed scale so ratings are comparable
// between runs. Players with no production keep their baseline.
// ============================================================

const EDGE_ROSTER_ENRICH = (() => {

  const SUPABASE_URL = () => localStorage.getItem('edge_supabase_url');
  const SUPABASE_KEY = () => localStorage.getItem('edge_supabase_key');

  const ESPN_MAP = {
    NFL:   'football/nfl',
    NBA:   'basketball/nba',
    MLB:   'baseball/mlb',
    NHL:   'hockey/nhl',
    NCAAF: 'football/college-football',
    NCAAB: 'basketball/mens-college-basketball',
    MLS:   'soccer/usa.1',
  };

  // Which position groups a metric is allowed to score. A metric
  // that lists no groups applies to everyone in the sport.
  const METRIC_CONFIG = {
    NFL: [
      { name: 'passingYards',       weight: 0.8, groups: ['OFFENSE_SKILL'] },
      { name: 'passingTouchdowns',  weight: 1.0, groups: ['OFFENSE_SKILL'] },
      { name: 'rushingYards',       weight: 0.7, groups: ['OFFENSE_SKILL'] },
      { name: 'rushingTouchdowns',  weight: 0.8, groups: ['OFFENSE_SKILL'] },
      { name: 'receivingYards',     weight: 0.7, groups: ['OFFENSE_SKILL'] },
      { name: 'receivingTouchdowns',weight: 0.8, groups: ['OFFENSE_SKILL'] },
      { name: 'sacks',              weight: 1.0, groups: ['DEFENSE_EDGE', 'DEFENSE_FRONT'] },
      { name: 'totalTackles',       weight: 0.6, groups: ['DEFENSE_MID', 'DEFENSE_FRONT', 'DEFENSE_SECONDARY'] },
      { name: 'tackles',            weight: 0.6, groups: ['DEFENSE_MID', 'DEFENSE_FRONT', 'DEFENSE_SECONDARY'] },
      { name: 'interceptions',      weight: 0.9, groups: ['DEFENSE_SECONDARY', 'DEFENSE_MID'] },
      { name: 'passesDefended',     weight: 0.6, groups: ['DEFENSE_SECONDARY'] },
    ],
    NBA: [
      { name: 'pointsPerGame',      weight: 1.0, groups: [] },
      { name: 'assistsPerGame',     weight: 0.6, groups: [] },
      { name: 'reboundsPerGame',    weight: 0.5, groups: [] },
      { name: 'stealsPerGame',      weight: 0.4, groups: [] },
      { name: 'blocksPerGame',      weight: 0.4, groups: [] },
      { name: 'fieldGoalPct',       weight: 0.5, groups: [] },
    ],
    MLB: [
      { name: 'battingAverage',     weight: 0.7, groups: ['CATCHER', 'INFIELD', 'OUTFIELD', 'DH', 'HITTER'] },
      { name: 'homeRuns',           weight: 0.9, groups: ['CATCHER', 'INFIELD', 'OUTFIELD', 'DH', 'HITTER'] },
      { name: 'RBIs',               weight: 0.7, groups: ['CATCHER', 'INFIELD', 'OUTFIELD', 'DH', 'HITTER'] },
      { name: 'onBasePlusSlugging', weight: 0.9, groups: ['CATCHER', 'INFIELD', 'OUTFIELD', 'DH', 'HITTER'] },
      { name: 'ERA',                weight: 1.0, groups: ['PITCHER_START', 'PITCHER_RELIEF', 'PITCHER'], inverted: true },
      { name: 'WHIP',               weight: 0.8, groups: ['PITCHER_START', 'PITCHER_RELIEF', 'PITCHER'], inverted: true },
      { name: 'strikeouts',         weight: 0.8, groups: ['PITCHER_START', 'PITCHER_RELIEF', 'PITCHER'] },
      { name: 'wins',               weight: 0.4, groups: ['PITCHER_START', 'PITCHER'] },
      { name: 'saves',              weight: 0.7, groups: ['PITCHER_RELIEF'] },
    ],
    NHL: [
      { name: 'goals',              weight: 0.9, groups: ['FORWARD', 'DEFENSE'] },
      { name: 'assists',            weight: 0.8, groups: ['FORWARD', 'DEFENSE'] },
      { name: 'points',             weight: 1.0, groups: ['FORWARD', 'DEFENSE'] },
      { name: 'plusMinus',          weight: 0.5, groups: ['FORWARD', 'DEFENSE'] },
      { name: 'goalsAgainstAverage',weight: 1.0, groups: ['GOALIE'], inverted: true },
      { name: 'savePct',            weight: 1.0, groups: ['GOALIE'] },
      { name: 'wins',               weight: 0.5, groups: ['GOALIE'] },
    ],
    MLS: [
      { name: 'goals',              weight: 1.0, groups: ['FORWARD', 'MIDFIELD', 'DEFENSE'] },
      { name: 'assists',            weight: 0.7, groups: ['FORWARD', 'MIDFIELD', 'DEFENSE'] },
      { name: 'shotsOnTarget',      weight: 0.4, groups: ['FORWARD', 'MIDFIELD'] },
      { name: 'saves',              weight: 1.0, groups: ['GOALKEEPER'] },
      { name: 'goalsAgainst',       weight: 0.8, groups: ['GOALKEEPER'], inverted: true },
    ],
  };
  METRIC_CONFIG.NCAAF = METRIC_CONFIG.NFL;
  METRIC_CONFIG.NCAAB = METRIC_CONFIG.NBA;

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

  // A z of 0 maps to CENTER; each standard deviation moves the
  // rating by SPREAD. Fixed scale, so ratings mean the same thing
  // from one run to the next.
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
    const log = makeLogger(onProgress);
    const summary = { sports: {}, totals: { enriched: 0, unmatched: 0 } };

    for (const sport of sports) {
      log(`── ${sport} ──`);
      try {
        const result = await enrichSport(sport, { onProgress });
        summary.sports[sport] = result;
        summary.totals.enriched += result.enriched || 0;
        summary.totals.unmatched += result.unmatched || 0;
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

    const metrics = METRIC_CONFIG[sport];
    if (!metrics) throw new Error(`No metric config for ${sport}`);

    // ── 1. Roster ──
    log('  loading roster rows');
    const players = await loadPlayers(url, key, sport);
    log(`  ${players.length} players in table`);
    if (!players.length) {
      return {
        enriched: 0, unmatched: 0,
        note: 'players table empty for this sport — run Build Rosters first',
      };
    }

    // ── 2. Production ──
    log('  fetching production stats');
    const statsById = await fetchProduction(sport, metrics);
    const statCount = Object.keys(statsById).length;
    log(`  ${statCount} players with stats`);
    if (!statCount) {
      return { enriched: 0, unmatched: players.length, note: 'ESPN returned no stats' };
    }

    // ── 3. Normalise every metric across the league ──
    const norms = buildNormalisers(metrics, statsById);

    // ── 4. Score each player ──
    const updates = [];
    let matched = 0;

    players.forEach(p => {
      const stats = statsById[String(p.player_id)];
      if (!stats) return;

      const z = weightedZ(stats, metrics, p.position_group, norms);
      if (z === null) return;

      matched++;

      // Starters carry a small premium: being on the field is itself
      // information the box score does not fully capture.
      const starterBonus = p.is_starter ? 1.5 : 0;
      const rating = clamp(
        round(CENTER + z * SPREAD + starterBonus, 1),
        RATING_MIN, RATING_MAX
      );

      const { off, def } = contributionFromRating(p.position_group, rating);
      updates.push({
        id: p.id,
        rating,
        offensive_contribution: off,
        defensive_contribution: def,
      });
    });

    log(`  ${updates.length} players to enrich`);
    if (!updates.length) {
      return { enriched: 0, unmatched: players.length, note: 'No id overlap between roster and stats' };
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
      stats_available: statCount,
    };
  }

  // ============================================================
  // ── ROSTER ──
  // ============================================================

  async function loadPlayers(url, key, sport) {
    const out = [];
    const pageSize = 1000;
    for (let offset = 0; offset < 20000; offset += pageSize) {
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
  // ── PRODUCTION STATS ──
  // The v1 code hit /leaders, which returns the top handful per
  // category — a few dozen players league-wide. v3 leaders accepts
  // a limit, which brings back the whole contributing population.
  // ============================================================

  async function fetchProduction(sport, metrics) {
    const path = ESPN_MAP[sport];
    if (!path) return {};

    const year = new Date().getFullYear();
    const candidates = [
      `https://site.api.espn.com/apis/site/v3/sports/${path}/leaders?season=${year}&seasontype=2&limit=500`,
      `https://site.api.espn.com/apis/site/v3/sports/${path}/leaders?limit=500`,
      `https://site.api.espn.com/apis/site/v2/sports/${path}/leaders?season=${year}`,
      `https://site.api.espn.com/apis/site/v2/sports/${path}/leaders`,
    ];

    const wanted = new Set(metrics.map(m => m.name.toLowerCase()));
    const merged = {};

    for (const url of candidates) {
      try {
        const res = await fetch(url, { cache: 'no-store' });
        if (!res.ok) continue;
        const data = await res.json();
        absorbLeaders(data, wanted, merged);
      } catch {}
      // Stop once we have a usable population.
      if (Object.keys(merged).length >= 200) break;
    }

    return merged;
  }

  // ESPN nests leaders differently between v2 and v3. Walk whatever
  // shape came back and pick up every {athlete, value} pair under a
  // category name we care about.
  function absorbLeaders(data, wanted, out) {
    const buckets = [];

    const collect = (node) => {
      if (!node || typeof node !== 'object') return;
      if (Array.isArray(node)) { node.forEach(collect); return; }
      if (Array.isArray(node.categories)) node.categories.forEach(c => buckets.push(c));
      if (Array.isArray(node.leaders) && node.name) buckets.push(node);
      if (node.sports) collect(node.sports);
      if (node.leagues) collect(node.leagues);
      if (node.leaders && !Array.isArray(node.leaders)) collect(node.leaders);
    };
    collect(data);

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
        // First source wins — earlier URLs are the more specific ones.
        if (out[k][name] === undefined) out[k][name] = value;
      });
    });
  }

  // ============================================================
  // ── NORMALISATION ──
  // Mean and standard deviation per metric across everyone who
  // recorded it, so a 4,000-yard passing season and a 14-sack
  // season land on the same scale.
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
    let sum = 0;
    let weightSum = 0;
    let found = 0;

    metrics.forEach(m => {
      const key = m.name.toLowerCase();

      // A metric with no group list applies to the whole sport.
      // Otherwise the player's group must be listed. v1's two-stage
      // test could never pass for MLB.
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

  function contributionFromRating(group, rating) {
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
    const workers = Array.from({ length: concurrency }, async () => {
      while (queue.length) {
        const item = queue.shift();
        if (item === undefined) break;
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