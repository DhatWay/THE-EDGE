// ============================================================
// EDGE — POWER RATINGS ENGINE v1.0
// Inception layer: Team, Coaching, Defense Matchup
// Deterministic. No Claude. No opinions. Pure math.
// Consumed by: engine.js (algorithms), governor.js, physics.js
// ============================================================
//
// ── SUPABASE SCHEMA (run once in SQL editor) ─────────────────
//
// CREATE TABLE power_ratings (
//   id UUID PRIMARY KEY DEFAULT gen_random_uuid(),
//   team_id TEXT NOT NULL,
//   sport TEXT NOT NULL,
//   team_name TEXT,
//   abbr TEXT,
//   overall FLOAT,
//   offense FLOAT,
//   defense FLOAT,
//   pythagorean FLOAT,
//   srs FLOAT,
//   elo FLOAT,
//   pace FLOAT,
//   record TEXT,
//   home_record TEXT,
//   away_record TEXT,
//   last5_form FLOAT,
//   games_played INT,
//   raw_stats JSONB,
//   updated_at TIMESTAMPTZ DEFAULT NOW(),
//   UNIQUE(team_id, sport)
// );
//
// CREATE TABLE coaching_ratings (
//   id UUID PRIMARY KEY DEFAULT gen_random_uuid(),
//   coach_id TEXT,
//   coach_name TEXT,
//   team_id TEXT NOT NULL,
//   sport TEXT NOT NULL,
//   overall FLOAT,
//   ats_as_favorite FLOAT,
//   ats_as_underdog FLOAT,
//   halftime_adjustment FLOAT,
//   close_game_record FLOAT,
//   primetime_record FLOAT,
//   raw_stats JSONB,
//   updated_at TIMESTAMPTZ DEFAULT NOW(),
//   UNIQUE(team_id, sport)
// );
//
// CREATE TABLE game_priors (
//   id UUID PRIMARY KEY DEFAULT gen_random_uuid(),
//   game_id TEXT NOT NULL UNIQUE,
//   sport TEXT NOT NULL,
//   home_team TEXT,
//   away_team TEXT,
//   commence_time TIMESTAMPTZ,
//   market JSONB,
//   home_power JSONB,
//   away_power JSONB,
//   defense_matchup JSONB,
//   raw_edge FLOAT,
//   prior_home_prob FLOAT,
//   computed_at TIMESTAMPTZ DEFAULT NOW()
// );
//
// ============================================================

const EDGE_POWER = (() => {

  const SUPABASE_URL = () => localStorage.getItem('edge_supabase_url');
  const SUPABASE_KEY = () => localStorage.getItem('edge_supabase_key');
  const ODDS_KEY     = () => localStorage.getItem('edge_odds_api_key');

  // ── ESPN SPORT MAP ──
  const ESPN_MAP = {
    NFL:   'football/nfl',
    NBA:   'basketball/nba',
    MLB:   'baseball/mlb',
    NHL:   'hockey/nhl',
    NCAAF: 'football/college-football',
    NCAAB: 'basketball/mens-college-basketball',
    MLS:   'soccer/usa.1',
  };

  // ── SPORT CONFIG (for normalization & Pythagorean exponents) ──
  const SPORT_CONFIG = {
    NFL:   { avgPF: 24,  avgPA: 24,  pyExp: 2.37,  scale: 35, paceMetric: 'plays' },
    NBA:   { avgPF: 113, avgPA: 113, pyExp: 13.91, scale: 20, paceMetric: 'possessions' },
    MLB:   { avgPF: 4.5, avgPA: 4.5, pyExp: 1.83,  scale: 8,  paceMetric: 'innings' },
    NHL:   { avgPF: 3.0, avgPA: 3.0, pyExp: 2.0,   scale: 5,  paceMetric: 'periods' },
    NCAAF: { avgPF: 28,  avgPA: 28,  pyExp: 2.37,  scale: 40, paceMetric: 'plays' },
    NCAAB: { avgPF: 72,  avgPA: 72,  pyExp: 10.0,  scale: 20, paceMetric: 'possessions' },
    MLS:   { avgPF: 1.5, avgPA: 1.5, pyExp: 2.0,   scale: 4,  paceMetric: 'minutes' },
  };

  // ── COACHING ADJUSTMENT WEIGHTS (spread points) ──
  const COACHING_WEIGHTS = {
    NFL:   { atsFav: 0.4, atsDog: 0.4, halftime: 1.5, close: 0.7, primetime: 0.5, maxAdj: 3.5 },
    NBA:   { atsFav: 0.3, atsDog: 0.3, halftime: 1.0, close: 0.5, primetime: 0.3, maxAdj: 2.0 },
    MLB:   { atsFav: 0.2, atsDog: 0.3, halftime: 0.0, close: 0.4, primetime: 0.2, maxAdj: 1.5 },
    NHL:   { atsFav: 0.3, atsDog: 0.3, halftime: 0.5, close: 0.5, primetime: 0.3, maxAdj: 1.5 },
    DEFAULT: { atsFav: 0.3, atsDog: 0.3, halftime: 0.8, close: 0.5, primetime: 0.3, maxAdj: 2.5 },
  };

  // ============================================================
  // ── PUBLIC API ──
  // ============================================================

  return {
    computeGamePrior,
    computeAllTeamRatings,
    computeCoachingRating,
    computeDefenseMatchup,
    fetchTeamStats,
    getPowerRating,
    getCoachingRating,
    getGamePrior,
    SPORT_CONFIG,
    ESPN_MAP,
  };

  // ============================================================
  // ── TEAM POWER RATING ──
  // ============================================================

  async function computeTeamRating(sport, teamName, teamId, espnEvents) {
    const cfg = SPORT_CONFIG[sport] || SPORT_CONFIG.NFL;

    // Aggregate from ESPN events
    let pf = 0, pa = 0, games = 0, movTotal = 0;
    let wins = 0, losses = 0, homeW = 0, homeL = 0, awayW = 0, awayL = 0;
    const last5 = [];

    (espnEvents || []).forEach(e => {
      const comp = e.competitions?.[0];
      if (!comp) return;
      const us = comp.competitors?.find(c => c.team?.displayName === teamName);
      const opp = comp.competitors?.find(c => c.team?.displayName !== teamName);
      if (!us || !opp) return;

      const score = parseInt(us.score || 0);
      const oppScore = parseInt(opp.score || 0);
      if (score === 0 && oppScore === 0) return;

      pf += score;
      pa += oppScore;
      games += 1;
      movTotal += (score - oppScore);
      const won = score > oppScore;
      if (won) wins++; else losses++;
      if (us.homeAway === 'home') { won ? homeW++ : homeL++; }
      else { won ? awayW++ : awayL++; }

      last5.push({ pf: score, pa: oppScore, margin: score - oppScore, won });
    });

    if (games === 0) {
      return {
        team_id: teamId,
        team_name: teamName,
        sport,
        overall: 50,
        offense: 50,
        defense: 50,
        pythagorean: 0.5,
        srs: 0,
        elo: 1500,
        pace: cfg.avgPF,
        record: '0-0',
        home_record: '0-0',
        away_record: '0-0',
        last5_form: 0,
        games_played: 0,
      };
    }

    const avgPF = pf / games;
    const avgPA = pa / games;
    const avgMOV = movTotal / games;

    // 1. Pythagorean expectation
    const pyth = avgPA > 0
      ? Math.pow(avgPF, cfg.pyExp) / (Math.pow(avgPF, cfg.pyExp) + Math.pow(avgPA, cfg.pyExp))
      : 0.5;

    // 2. Offensive rating (0-100, normalized against league avg)
    const offense = clamp(50 + ((avgPF - cfg.avgPF) / cfg.scale) * 50, 0, 100);

    // 3. Defensive rating (0-100, inverted so higher = better defense)
    const defense = clamp(50 - ((avgPA - cfg.avgPA) / cfg.scale) * 50, 0, 100);

    // 4. SRS — margin of victory (as a raw spread proxy)
    const srs = round(avgMOV, 2);

    // 5. Elo — derived from win% and MOV
    const winPct = wins / games;
    const elo = 1500 + (winPct - 0.5) * 400 + avgMOV * 10;

    // 6. Last-5 form: recency-weighted ATS margin (approximate)
    const recent = last5.slice(-5).reverse(); // most recent first
    const formWeights = [0.30, 0.25, 0.20, 0.15, 0.10];
    let formScore = 0;
    recent.forEach((g, i) => {
      formScore += formWeights[i] * (g.margin / cfg.scale) * 20;
    });
    formScore = clamp(formScore, -20, 20);

    // 7. Composite overall rating
    // Pythagorean carries the most weight — it strips luck from records
    const overall = round(
      (pyth * 100 * 0.40) +
      (offense * 0.25) +
      (defense * 0.25) +
      (clamp(50 + (avgMOV / cfg.scale) * 50, 0, 100) * 0.10),
      1
    );

    return {
      team_id: teamId,
      team_name: teamName,
      sport,
      overall: clamp(overall, 0, 100),
      offense: round(offense, 1),
      defense: round(defense, 1),
      pythagorean: round(pyth, 4),
      srs,
      elo: Math.round(elo),
      pace: round(avgPF, 1), // placeholder for true pace; upgraded when possession data available
      record: `${wins}-${losses}`,
      home_record: `${homeW}-${homeL}`,
      away_record: `${awayW}-${awayL}`,
      last5_form: round(formScore, 2),
      games_played: games,
      raw_stats: { avgPF: round(avgPF, 2), avgPA: round(avgPA, 2), avgMOV: round(avgMOV, 2) },
    };
  }

  // ============================================================
  // ── COACHING RATING ──
  // ============================================================

  async function computeCoachingRating(sport, teamName, teamId, espnEvents) {
    const cfg = COACHING_WEIGHTS[sport] || COACHING_WEIGHTS.DEFAULT;

    let favGames = 0, favCovers = 0;
    let dogGames = 0, dogCovers = 0;
    let closeGames = 0, closeWins = 0;
    let firstHalfMargin = 0, secondHalfMargin = 0, halves = 0;

    (espnEvents || []).forEach(e => {
      const comp = e.competitions?.[0];
      if (!comp) return;
      const us = comp.competitors?.find(c => c.team?.displayName === teamName);
      const opp = comp.competitors?.find(c => c.team?.displayName !== teamName);
      if (!us || !opp) return;

      const score = parseInt(us.score || 0);
      const oppScore = parseInt(opp?.score || 0);
      if (score === 0 && oppScore === 0) return;

      const margin = score - oppScore;
      const won = score > oppScore;

      // Close-game record (margin <= 7)
      if (Math.abs(margin) <= 7) {
        closeGames++;
        if (won) closeWins++;
      }

      // Line/ATS data lives in the odds API, not ESPN.
      // We approximate favorite/underdog from ESPN's "favorite" flag when present.
      const wasFav = us?.winner === undefined ? null : null; // ESPN scoreboard doesn't reliably flag; skip ATS here
      // ATS tracking happens in engine.js when Odds API line data is available.
      // Coaching rating here focuses on halftime adjustment + close-game record.

      // Halftime adjustment from linescores if present
      const ourLines = us.linescores || [];
      if (ourLines.length >= 2) {
        const firstHalf = sumFirst(ourLines, 2);
        const secondHalf = sumRest(ourLines, 2);
        const oppLines = opp.linescores || [];
        const oppFirstHalf = sumFirst(oppLines, 2);
        const oppSecondHalf = sumRest(oppLines, 2);
        firstHalfMargin += (firstHalf - oppFirstHalf);
        secondHalfMargin += (secondHalf - oppSecondHalf);
        halves++;
      }
    });

    const closeWinPct = closeGames > 0 ? closeWins / closeGames : 0.5;
    const halftimeAdj = halves > 0
      ? round((secondHalfMargin - firstHalfMargin) / halves, 2)
      : 0;

    // Composite coaching rating (0-100)
    // Close-game record is the strongest signal we have without ATS data.
    const closeComponent = closeWinPct * 100 * 0.6;
    const halftimeComponent = clamp(50 + halftimeAdj * 5, 0, 100) * 0.4;
    const overall = round(closeComponent + halftimeComponent, 1);

    return {
      coach_id: null, // populated when roster endpoint is added
      coach_name: null,
      team_id: teamId,
      team_name: teamName,
      sport,
      overall: clamp(overall, 0, 100),
      ats_as_favorite: null,   // filled by engine.js using Odds API
      ats_as_underdog: null,   // filled by engine.js using Odds API
      halftime_adjustment: halftimeAdj,
      close_game_record: round(closeWinPct, 3),
      primetime_record: null,  // populated when primetime flag is added
      raw_stats: { closeGames, closeWins, halves, firstHalfMargin, secondHalfMargin },
      max_adjustment: cfg.maxAdj,
    };
  }

  function sumFirst(lines, n) {
    return lines.slice(0, n).reduce((s, l) => s + (parseInt(l.value || l.displayValue || 0) || 0), 0);
  }
  function sumRest(lines, n) {
    return lines.slice(n).reduce((s, l) => s + (parseInt(l.value || l.displayValue || 0) || 0), 0);
  }

  // ============================================================
  // ── DEFENSE MATCHUP RATING ──
  // ============================================================
  // Matchup-specific. Returns a spread adjustment that reflects
  // how well each team's defense matches the opponent's offense.

  function computeDefenseMatchup(sport, homePower, awayPower) {
    if (!homePower || !awayPower) {
      return {
        home_defense_score: 50,
        away_defense_score: 50,
        scheme_advantage: 'neutral',
        adjustment_points: 0,
        notes: ['Insufficient power rating data'],
      };
    }

    // Offense vs opposing defense — the classic "can team A score on team B" test.
    // If home offense is elite and away defense is weak, home gets a boost.
    const homeOffVsAwayDef = (homePower.offense + (100 - awayPower.defense)) / 2;
    const awayOffVsHomeDef = (awayPower.offense + (100 - homePower.defense)) / 2;

    // The differential is our raw scheme advantage
    const differential = homeOffVsAwayDef - awayOffVsHomeDef; // range: -100 to +100

    // Convert to spread points (sport-specific conversion)
    const conversion = {
      NFL:   0.06,  // 100-point diff → 6 pts
      NBA:   0.08,  // 100-point diff → 8 pts
      MLB:   0.03,  // 100-point diff → 3 runs
      NHL:   0.02,
      NCAAF: 0.07,
      NCAAB: 0.08,
      MLS:   0.02,
    }[sport] || 0.05;

    const adjustment = round(differential * conversion, 2);
    const schemeAdvantage = Math.abs(adjustment) < 0.5 ? 'neutral'
                          : adjustment > 0 ? 'home' : 'away';

    const notes = [];
    if (homeOffVsAwayDef > 70) notes.push('Home offense vs weak away defense — scoring edge');
    if (awayOffVsHomeDef > 70) notes.push('Away offense vs weak home defense — scoring edge');
    if (homePower.defense > 75 && awayPower.defense > 75) notes.push('Defensive battle — under lean');

    return {
      home_defense_score: round(homeOffVsAwayDef, 1),
      away_defense_score: round(awayOffVsHomeDef, 1),
      scheme_advantage: schemeAdvantage,
      adjustment_points: adjustment,
      notes,
    };
  }

  // ============================================================
  // ── GAME PRIOR (The inception object) ──
  // ============================================================
  // This is what feeds every algorithm and the governor.

  async function computeGamePrior(game, options = {}) {
    const { homeStats, awayStats, market } = options;

    if (!homeStats || !awayStats) {
      throw new Error('computeGamePrior requires homeStats and awayStats');
    }

    const sport = game._sport || game.sport;

    // Compute defense matchup
    const defenseMatchup = computeDefenseMatchup(sport, homeStats, awayStats);

    // Compute raw edge: model spread vs market spread
    // Power rating delta → implied spread (sport conversion)
    const ratingDelta = homeStats.overall - awayStats.overall; // -100 to +100
    const spreadConv = {
      NFL:   -0.20,  // 100 rating pts → 20 pts spread (home positive)
      NBA:   -0.20,
      MLB:   -0.06,
      NHL:   -0.04,
      NCAAF: -0.24,
      NCAAB: -0.20,
      MLS:   -0.04,
    }[sport] || -0.20;

    const modelSpread = round(ratingDelta * spreadConv, 2); // negative = home favored
    const marketSpread = market?.current_spread ?? null;

    // Coaching adjustment
    const coachAdj = homeStats._coach_adj ?? 0;
    const coachAdjAway = awayStats._coach_adj ?? 0;
    const coachDelta = coachAdj - coachAdjAway;

    // Total prior spread (model + coaching + defense matchup)
    const totalModelSpread = round(
      modelSpread + (coachDelta * -1) + (defenseMatchup.adjustment_points * -1),
      2
    );

    // Raw edge: how many points the model disagrees with the market
    const rawEdge = marketSpread !== null
      ? round(marketSpread - totalModelSpread, 2) // positive = model likes home more than market
      : 0;

    // Prior home win probability (used by governor + Bayesian posterior)
    // Logistic conversion: 1 point of spread ≈ 2.5% probability shift for NFL
    const probShiftPerPoint = {
      NFL:   0.028,
      NBA:   0.032,
      MLB:   0.040,
      NHL:   0.035,
      NCAAF: 0.028,
      NCAAB: 0.032,
      MLS:   0.040,
    }[sport] || 0.030;

    const priorHomeProb = clamp(0.5 + (rawEdge * probShiftPerPoint), 0.05, 0.95);

    return {
      game_id: game.id,
      sport,
      home_team: game.home_team,
      away_team: game.away_team,
      commence_time: game.commence_time,
      market: {
        open_spread: market?.open_spread ?? null,
        current_spread: marketSpread,
        total: market?.total ?? null,
        home_ml: market?.home_ml ?? null,
        away_ml: market?.away_ml ?? null,
      },
      home_power: homeStats,
      away_power: awayStats,
      defense_matchup: defenseMatchup,
      model_spread: totalModelSpread,
      raw_edge: rawEdge,
      prior_home_prob: round(priorHomeProb, 4),
      computed_at: new Date().toISOString(),
    };
  }

  // ============================================================
  // ── FULL ENGINE RUN ──
  // ============================================================

  async function computeAllTeamRatings() {
    const results = { teams: {}, coaching: {}, errors: [] };

    for (const [sport, path] of Object.entries(ESPN_MAP)) {
      try {
        const res = await fetch(`https://site.api.espn.com/apis/site/v2/sports/${path}/scoreboard`);
        if (!res.ok) continue;
        const data = await res.json();
        const events = data.events || [];

        // Collect unique teams
        const teams = new Map();
        events.forEach(e => {
          e.competitions?.[0]?.competitors?.forEach(c => {
            const name = c.team?.displayName;
            const id = c.team?.id;
            if (name && !teams.has(name)) teams.set(name, id);
          });
        });

        for (const [teamName, teamId] of teams) {
          const teamRating = await computeTeamRating(sport, teamName, teamId, events);
          results.teams[`${sport}:${teamName}`] = teamRating;

          const coachRating = await computeCoachingRating(sport, teamName, teamId, events);
          results.coaching[`${sport}:${teamName}`] = coachRating;
        }
      } catch (err) {
        results.errors.push({ sport, error: err.message });
      }
    }

    // Persist to Supabase (fire and forget — won't block)
    persistRatings(results).catch(() => {});

    return results;
  }

  async function persistRatings(results) {
    const url = SUPABASE_URL();
    const key = SUPABASE_KEY();
    if (!url || !key) return;

    const teamRows = Object.values(results.teams);
    const coachRows = Object.values(results.coaching);

    try {
      // Upsert teams
      if (teamRows.length) {
        await fetch(`${url}/rest/v1/power_ratings`, {
          method: 'POST',
          headers: {
            'apikey': key,
            'Authorization': `Bearer ${key}`,
            'Content-Type': 'application/json',
            'Prefer': 'resolution=merge-duplicates',
          },
          body: JSON.stringify(teamRows),
        });
      }

      // Upsert coaches
      if (coachRows.length) {
        await fetch(`${url}/rest/v1/coaching_ratings`, {
          method: 'POST',
          headers: {
            'apikey': key,
            'Authorization': `Bearer ${key}`,
            'Content-Type': 'application/json',
            'Prefer': 'resolution=merge-duplicates',
          },
          body: JSON.stringify(coachRows),
        });
      }
    } catch {}
  }

  // ============================================================
  // ── LOOKUP HELPERS ──

  async function getPowerRating(sport, teamName) {
    const url = SUPABASE_URL();
    const key = SUPABASE_KEY();
    if (!url || !key) return null;
    try {
      const res = await fetch(
        `${url}/rest/v1/power_ratings?sport=eq.${sport}&team_name=eq.${encodeURIComponent(teamName)}&limit=1`,
        { headers: { 'apikey': key, 'Authorization': `Bearer ${key}` } }
      );
      const rows = res.ok ? await res.json() : [];
      return rows[0] || null;
    } catch { return null; }
  }

  async function getCoachingRating(sport, teamName) {
    const url = SUPABASE_URL();
    const key = SUPABASE_KEY();
    if (!url || !key) return null;
    try {
      const res = await fetch(
        `${url}/rest/v1/coaching_ratings?sport=eq.${sport}&team_name=eq.${encodeURIComponent(teamName)}&limit=1`,
        { headers: { 'apikey': key, 'Authorization': `Bearer ${key}` } }
      );
      const rows = res.ok ? await res.json() : [];
      return rows[0] || null;
    } catch { return null; }
  }

  async function getGamePrior(gameId) {
    const url = SUPABASE_URL();
    const key = SUPABASE_KEY();
    if (!url || !key) return null;
    try {
      const res = await fetch(
        `${url}/rest/v1/game_priors?game_id=eq.${encodeURIComponent(gameId)}&limit=1`,
        { headers: { 'apikey': key, 'Authorization': `Bearer ${key}` } }
      );
      const rows = res.ok ? await res.json() : [];
      return rows[0] || null;
    } catch { return null; }
  }

  // ============================================================
  // ── UTILITIES ──

  function clamp(v, min, max) { return Math.max(min, Math.min(max, v)); }
  function round(v, decimals) { const f = Math.pow(10, decimals); return Math.round(v * f) / f; }

  // ============================================================
  // ── FETCH TEAM STATS (from ESPN, used by callers) ──

  async function fetchTeamStats(sport) {
    const path = ESPN_MAP[sport];
    if (!path) return null;
    try {
      const res = await fetch(`https://site.api.espn.com/apis/site/v2/sports/${path}/scoreboard`);
      return res.ok ? await res.json() : null;
    } catch { return null; }
  }

})();

// Make available globally
if (typeof window !== 'undefined') window.EDGE_POWER = EDGE_POWER;