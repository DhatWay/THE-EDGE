// ============================================================
// EDGE — POWER RATINGS ENGINE v3.2
// Season-aware: skips out-of-season sports entirely
// ============================================================

const EDGE_POWER = (() => {

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

  // ── SEASON WINDOWS (month/day ranges) ──
  // Only sports whose window contains today get computed.
  const SEASON_WINDOWS = {
    NFL:   { start: [9, 1],   end: [2, 15]  },   // Sep 1 → Feb 15
    NBA:   { start: [10, 15], end: [6, 30]  },   // Oct 15 → Jun 30
    MLB:   { start: [3, 20],  end: [11, 5]  },   // Mar 20 → Nov 5
    NHL:   { start: [10, 1],  end: [6, 30]  },   // Oct 1 → Jun 30
    NCAAF: { start: [8, 15],  end: [1, 15]  },   // Aug 15 → Jan 15
    NCAAB: { start: [11, 1],  end: [4, 10]  },   // Nov 1 → Apr 10
    MLS:   { start: [2, 20],  end: [12, 15] },   // Feb 20 → Dec 15
  };

  const SPORT_CONFIG = {
    NFL:   { avgPF: 22,  avgPA: 22,  pyExp: 2.37,  scale: 22, k: 8  },
    NBA:   { avgPF: 112, avgPA: 112, pyExp: 13.91, scale: 18, k: 15 },
    MLB:   { avgPF: 4.5, avgPA: 4.5, pyExp: 1.83,  scale: 3,  k: 20 },
    NHL:   { avgPF: 3.0, avgPA: 3.0, pyExp: 2.0,   scale: 2,  k: 15 },
    NCAAF: { avgPF: 27,  avgPA: 27,  pyExp: 2.37,  scale: 32, k: 6  },
    NCAAB: { avgPF: 72,  avgPA: 72,  pyExp: 10.0,  scale: 20, k: 10 },
    MLS:   { avgPF: 1.5, avgPA: 1.5, pyExp: 2.0,   scale: 1.2, k: 15 },
  };

  const COACHING_WEIGHTS = {
    NFL:   { halftime: 1.5, close: 0.7, maxAdj: 3.5 },
    NBA:   { halftime: 1.0, close: 0.5, maxAdj: 2.0 },
    MLB:   { halftime: 0.0, close: 0.4, maxAdj: 1.5 },
    NHL:   { halftime: 0.5, close: 0.5, maxAdj: 1.5 },
    DEFAULT: { halftime: 0.8, close: 0.5, maxAdj: 2.5 },
  };

  const LOOKBACK_DAYS = 150;

  return {
    computeGamePrior,
    computeAllTeamRatings,
    computeTeamRating,
    computeCoachingRating,
    computeDefenseMatchup,
    fetchTeamStats,
    getPowerRating,
    getCoachingRating,
    getGamePrior,
    isSportInSeason,
    SPORT_CONFIG,
    ESPN_MAP,
    SEASON_WINDOWS,
  };

  // ── Season check ──
  function isSportInSeason(sport, date = new Date()) {
    const w = SEASON_WINDOWS[sport];
    if (!w) return true;
    const m = date.getMonth() + 1;
    const d = date.getDate();
    const now = m * 100 + d;
    const start = w.start[0] * 100 + w.start[1];
    const end = w.end[0] * 100 + w.end[1];

    // Handle wrap-around seasons (e.g. NFL Sep→Feb, NHL Oct→Jun)
    if (start <= end) {
      return now >= start && now <= end;
    }
    return now >= start || now <= end;
  }

  async function computeAllTeamRatings() {
    const results = { teams: {}, coaching: {}, errors: [], counts: {}, skipped: [] };

    const end = new Date();
    const start = new Date(end.getTime() - LOOKBACK_DAYS * 86400000);
    const startStr = fmtDate(start);
    const endStr = fmtDate(end);

    for (const [sport, path] of Object.entries(ESPN_MAP)) {
      // Skip out-of-season sports
      if (!isSportInSeason(sport)) {
        results.skipped.push(sport);
        results.counts[sport] = 0;
        continue;
      }

      let teamCount = 0;
      try {
        const events = await fetchGamesInRange(path, startStr, endStr);
        if (!events.length) { results.counts[sport] = 0; continue; }

        const teamMap = new Map();

        events.forEach(e => {
          const comp = e.competitions?.[0];
          if (!comp) return;
          const home = comp.competitors?.find(c => c.homeAway === 'home');
          const away = comp.competitors?.find(c => c.homeAway === 'away');
          if (!home || !away) return;

          const homeName = home.team?.displayName;
          const awayName = away.team?.displayName;
          if (!homeName || !awayName) return;

          const homeScore = parseInt(home.score || '0');
          const awayScore = parseInt(away.score || '0');
          if (homeScore === 0 && awayScore === 0) return;

          pushGame(teamMap, homeName, home.team, homeScore, awayScore, true);
          pushGame(teamMap, awayName, away.team, awayScore, homeScore, false);
        });

        for (const [teamName, state] of teamMap) {
          if (state.games < 1) continue;
          const rating = buildRating(sport, teamName, state);
          if (rating) {
            results.teams[`${sport}:${teamName}`] = rating;
            teamCount++;
          }
          const coach = buildCoaching(sport, teamName, state);
          if (coach) results.coaching[`${sport}:${teamName}`] = coach;
        }
      } catch (err) {
        results.errors.push({ sport, error: err.message });
      }
      results.counts[sport] = teamCount;
    }

    persistRatings(results).catch(() => {});
    return results;
  }

  function pushGame(map, teamName, teamObj, scored, allowed, wasHome) {
    if (!map.has(teamName)) {
      map.set(teamName, {
        team_id: String(teamObj?.id || teamName),
        abbr: teamObj?.abbreviation || teamName.slice(0, 3).toUpperCase(),
        games: 0, pf: 0, pa: 0, wins: 0, losses: 0,
        homeW: 0, homeL: 0, awayW: 0, awayL: 0,
        margins: [], closeGames: 0, closeWins: 0,
      });
    }
    const t = map.get(teamName);
    t.games++;
    t.pf += scored;
    t.pa += allowed;
    t.margins.push(scored - allowed);
    const won = scored > allowed;
    if (won) t.wins++; else t.losses++;
    if (wasHome) { won ? t.homeW++ : t.homeL++; }
    else { won ? t.awayW++ : t.awayL++; }
    if (Math.abs(scored - allowed) <= 7) {
      t.closeGames++;
      if (won) t.closeWins++;
    }
  }

  function buildRating(sport, teamName, state) {
    const cfg = SPORT_CONFIG[sport] || SPORT_CONFIG.NFL;
    const games = state.games;
    if (games === 0) return null;

    const avgPF = state.pf / games;
    const avgPA = state.pa / games;
    const avgMOV = (state.pf - state.pa) / games;

    const pythRaw = avgPA > 0
      ? Math.pow(avgPF, cfg.pyExp) / (Math.pow(avgPF, cfg.pyExp) + Math.pow(avgPA, cfg.pyExp))
      : 0.5;

    const offenseRaw = clamp(50 + ((avgPF - cfg.avgPF) / cfg.scale) * 25, 0, 100);
    const defenseRaw = clamp(50 - ((avgPA - cfg.avgPA) / cfg.scale) * 25, 0, 100);
    const movRaw = clamp(50 + (avgMOV / cfg.scale) * 25, 0, 100);

    const realWeight = games / (games + cfg.k);

    const offense = clamp(50 + (offenseRaw - 50) * realWeight, 0, 100);
    const defense = clamp(50 + (defenseRaw - 50) * realWeight, 0, 100);
    const mov = clamp(50 + (movRaw - 50) * realWeight, 0, 100);
    const pyth = 0.5 + (pythRaw - 0.5) * realWeight;

    const winPct = state.wins / games;
    const elo = 1500 + (winPct - 0.5) * 200 + avgMOV * 4;

    const recent = state.margins.slice(-5);
    const formWeights = [0.10, 0.15, 0.20, 0.25, 0.30];
    let formScore = 0;
    recent.forEach((m, i) => {
      formScore += formWeights[i] * (m / cfg.scale) * 3;
    });
    formScore = clamp(formScore * realWeight, -20, 20);

    const overall = round(
      (pyth * 100 * 0.45) +
      (offense * 0.20) +
      (defense * 0.20) +
      (mov * 0.15),
      1
    );

    return {
      team_id: state.team_id,
      team_name: teamName,
      abbr: state.abbr,
      sport,
      overall: clamp(overall, 0, 100),
      offense: round(offense, 1),
      defense: round(defense, 1),
      pythagorean: round(pyth, 4),
      srs: round(avgMOV, 2),
      elo: Math.round(elo),
      pace: round(avgPF, 1),
      record: `${state.wins}-${state.losses}`,
      home_record: `${state.homeW}-${state.homeL}`,
      away_record: `${state.awayW}-${state.awayL}`,
      last5_form: round(formScore, 2),
      games_played: games,
      raw_stats: {
        avgPF: round(avgPF, 2),
        avgPA: round(avgPA, 2),
        avgMOV: round(avgMOV, 2),
        realWeight: round(realWeight, 3),
      },
    };
  }

  function buildCoaching(sport, teamName, state) {
    const cfg = COACHING_WEIGHTS[sport] || COACHING_WEIGHTS.DEFAULT;
    const closeWinPct = state.closeGames > 0 ? state.closeWins / state.closeGames : 0.5;
    const realWeight = state.closeGames / (state.closeGames + 4);
    const closeShrunk = 0.5 + (closeWinPct - 0.5) * realWeight;
    const closeComponent = closeShrunk * 100 * 0.6;
    const halftimeComponent = 50 * 0.4;
    const overall = round(closeComponent + halftimeComponent, 1);

    return {
      coach_id: null,
      coach_name: null,
      team_id: state.team_id,
      team_name: teamName,
      sport,
      overall: clamp(overall, 0, 100),
      ats_as_favorite: null,
      ats_as_underdog: null,
      halftime_adjustment: 0,
      close_game_record: round(closeShrunk, 3),
      primetime_record: null,
      raw_stats: { closeGames: state.closeGames, closeWins: state.closeWins, halves: 0 },
      max_adjustment: cfg.maxAdj,
    };
  }

  async function computeTeamRating(sport, teamName, teamId, espnEvents) {
    const teamMap = new Map();
    (espnEvents || []).forEach(e => {
      const comp = e.competitions?.[0];
      if (!comp) return;
      const us = comp.competitors?.find(c => c.team?.displayName === teamName);
      const opp = comp.competitors?.find(c => c.team?.displayName !== teamName);
      if (!us || !opp) return;
      const score = parseInt(us.score || 0);
      const oppScore = parseInt(opp.score || 0);
      if (score === 0 && oppScore === 0) return;
      pushGame(teamMap, teamName, us.team, score, oppScore, us.homeAway === 'home');
    });
    const state = teamMap.get(teamName);
    if (!state) return null;
    return buildRating(sport, teamName, state);
  }

  async function computeCoachingRating(sport, teamName, teamId, espnEvents) {
    const teamMap = new Map();
    (espnEvents || []).forEach(e => {
      const comp = e.competitions?.[0];
      if (!comp) return;
      const us = comp.competitors?.find(c => c.team?.displayName === teamName);
      const opp = comp.competitors?.find(c => c.team?.displayName !== teamName);
      if (!us || !opp) return;
      const score = parseInt(us.score || 0);
      const oppScore = parseInt(opp.score || 0);
      if (score === 0 && oppScore === 0) return;
      pushGame(teamMap, teamName, us.team, score, oppScore, us.homeAway === 'home');
    });
    const state = teamMap.get(teamName);
    if (!state) return null;
    return buildCoaching(sport, teamName, state);
  }

  async function fetchGamesInRange(path, start, end) {
    const url = `https://site.api.espn.com/apis/site/v2/sports/${path}/scoreboard?dates=${start}-${end}&limit=1000`;
    try {
      const res = await fetch(url);
      if (!res.ok) return [];
      const data = await res.json();
      return data.events || [];
    } catch { return []; }
  }

  async function fetchTeamStats(sport) {
    const path = ESPN_MAP[sport];
    if (!path) return null;
    try {
      const res = await fetch(`https://site.api.espn.com/apis/site/v2/sports/${path}/scoreboard`);
      return res.ok ? await res.json() : null;
    } catch { return null; }
  }

  function computeDefenseMatchup(sport, homePower, awayPower) {
    if (!homePower || !awayPower) {
      return {
        home_defense_score: 50, away_defense_score: 50,
        scheme_advantage: 'neutral', adjustment_points: 0,
        notes: ['Insufficient data'],
      };
    }
    const homeOffVsAwayDef = (homePower.offense + (100 - awayPower.defense)) / 2;
    const awayOffVsHomeDef = (awayPower.offense + (100 - homePower.defense)) / 2;
    const differential = homeOffVsAwayDef - awayOffVsHomeDef;

    const conversion = {
      NFL: 0.06, NBA: 0.08, MLB: 0.02, NHL: 0.015,
      NCAAF: 0.07, NCAAB: 0.08, MLS: 0.02,
    }[sport] || 0.05;

    const adjustment = round(differential * conversion, 2);
    const schemeAdvantage = Math.abs(adjustment) < 0.5 ? 'neutral'
                          : adjustment > 0 ? 'home' : 'away';
    return {
      home_defense_score: round(homeOffVsAwayDef, 1),
      away_defense_score: round(awayOffVsHomeDef, 1),
      scheme_advantage: schemeAdvantage,
      adjustment_points: adjustment,
      notes: [],
    };
  }

  async function computeGamePrior(game, options = {}) {
    const { homeStats, awayStats, market } = options;
    if (!homeStats || !awayStats) throw new Error('computeGamePrior requires homeStats and awayStats');

    const sport = game._sport || game.sport;
    const defenseMatchup = computeDefenseMatchup(sport, homeStats, awayStats);

    const ratingDelta = homeStats.overall - awayStats.overall;
    const spreadConv = {
      NFL: -0.28, NBA: -0.28, MLB: -0.08, NHL: -0.05,
      NCAAF: -0.30, NCAAB: -0.28, MLS: -0.05,
    }[sport] || -0.28;

    const modelSpread = round(ratingDelta * spreadConv, 2);
    const marketSpread = market?.current_spread ?? null;

    const coachAdj = homeStats._coach_adj ?? 0;
    const coachAdjAway = awayStats._coach_adj ?? 0;
    const coachDelta = coachAdj - coachAdjAway;

    const totalModelSpread = round(
      modelSpread + (coachDelta * -1) + (defenseMatchup.adjustment_points * -1),
      2
    );

    const rawEdge = marketSpread !== null
      ? round(marketSpread - totalModelSpread, 2)
      : 0;

    const probShiftPerPoint = {
      NFL: 0.028, NBA: 0.032, MLB: 0.040, NHL: 0.035,
      NCAAF: 0.028, NCAAB: 0.032, MLS: 0.040,
    }[sport] || 0.030;

    const priorHomeProb = clamp(0.5 + (rawEdge * probShiftPerPoint), 0.05, 0.95);

    return {
      game_id: game.id, sport,
      home_team: game.home_team, away_team: game.away_team,
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

  async function persistRatings(results) {
    const url = SUPABASE_URL();
    const key = SUPABASE_KEY();
    if (!url || !key) return;

    const teamRows = Object.values(results.teams);
    const coachRows = Object.values(results.coaching);

    try {
      // Wipe the table and reinsert fresh — removes off-season sports
      await fetch(`${url}/rest/v1/power_ratings?sport=not.is.null`, {
        method: 'DELETE',
        headers: { apikey: key, Authorization: `Bearer ${key}` },
      });
      await fetch(`${url}/rest/v1/coaching_ratings?sport=not.is.null`, {
        method: 'DELETE',
        headers: { apikey: key, Authorization: `Bearer ${key}` },
      });

      if (teamRows.length) {
        await fetch(`${url}/rest/v1/power_ratings`, {
          method: 'POST',
          headers: {
            apikey: key, Authorization: `Bearer ${key}`,
            'Content-Type': 'application/json',
            Prefer: 'return=minimal',
          },
          body: JSON.stringify(teamRows),
        });
      }
      if (coachRows.length) {
        await fetch(`${url}/rest/v1/coaching_ratings`, {
          method: 'POST',
          headers: {
            apikey: key, Authorization: `Bearer ${key}`,
            'Content-Type': 'application/json',
            Prefer: 'return=minimal',
          },
          body: JSON.stringify(coachRows),
        });
      }
    } catch {}
  }

  async function getPowerRating(sport, teamName) {
    const url = SUPABASE_URL(), key = SUPABASE_KEY();
    if (!url || !key) return null;
    try {
      const res = await fetch(
        `${url}/rest/v1/power_ratings?sport=eq.${sport}&team_name=eq.${encodeURIComponent(teamName)}&limit=1`,
        { headers: { apikey: key, Authorization: `Bearer ${key}` } }
      );
      const rows = res.ok ? await res.json() : [];
      return rows[0] || null;
    } catch { return null; }
  }

  async function getCoachingRating(sport, teamName) {
    const url = SUPABASE_URL(), key = SUPABASE_KEY();
    if (!url || !key) return null;
    try {
      const res = await fetch(
        `${url}/rest/v1/coaching_ratings?sport=eq.${sport}&team_name=eq.${encodeURIComponent(teamName)}&limit=1`,
        { headers: { apikey: key, Authorization: `Bearer ${key}` } }
      );
      const rows = res.ok ? await res.json() : [];
      return rows[0] || null;
    } catch { return null; }
  }

  async function getGamePrior(gameId) {
    const url = SUPABASE_URL(), key = SUPABASE_KEY();
    if (!url || !key) return null;
    try {
      const res = await fetch(
        `${url}/rest/v1/game_priors?game_id=eq.${encodeURIComponent(gameId)}&limit=1`,
        { headers: { apikey: key, Authorization: `Bearer ${key}` } }
      );
      const rows = res.ok ? await res.json() : [];
      return rows[0] || null;
    } catch { return null; }
  }

  function clamp(v, min, max) { return Math.max(min, Math.min(max, v)); }
  function round(v, d) { const f = Math.pow(10, d); return Math.round(v * f) / f; }
  function fmtDate(d) {
    const y = d.getFullYear();
    const m = String(d.getMonth() + 1).padStart(2, '0');
    const day = String(d.getDate()).padStart(2, '0');
    return `${y}${m}${day}`;
  }

})();

if (typeof window !== 'undefined') window.EDGE_POWER = EDGE_POWER;