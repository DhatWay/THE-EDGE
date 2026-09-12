// ============================================================
// EDGE — POWER RATINGS ENGINE v2.0
// Uses ESPN standings endpoint for reliable season-long stats
// Fallback to scoreboard when standings unavailable
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

  const SPORT_CONFIG = {
    NFL:   { avgPF: 24,  avgPA: 24,  pyExp: 2.37,  scale: 35 },
    NBA:   { avgPF: 113, avgPA: 113, pyExp: 13.91, scale: 20 },
    MLB:   { avgPF: 4.5, avgPA: 4.5, pyExp: 1.83,  scale: 8  },
    NHL:   { avgPF: 3.0, avgPA: 3.0, pyExp: 2.0,   scale: 5  },
    NCAAF: { avgPF: 28,  avgPA: 28,  pyExp: 2.37,  scale: 40 },
    NCAAB: { avgPF: 72,  avgPA: 72,  pyExp: 10.0,  scale: 20 },
    MLS:   { avgPF: 1.5, avgPA: 1.5, pyExp: 2.0,   scale: 4  },
  };

  const COACHING_WEIGHTS = {
    NFL:   { halftime: 1.5, close: 0.7, maxAdj: 3.5 },
    NBA:   { halftime: 1.0, close: 0.5, maxAdj: 2.0 },
    MLB:   { halftime: 0.0, close: 0.4, maxAdj: 1.5 },
    NHL:   { halftime: 0.5, close: 0.5, maxAdj: 1.5 },
    DEFAULT: { halftime: 0.8, close: 0.5, maxAdj: 2.5 },
  };

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
    SPORT_CONFIG,
    ESPN_MAP,
  };

  // ============================================================
  // ── MAIN: Fetch ratings from standings endpoint ──
  // ============================================================

  async function computeAllTeamRatings() {
    const results = { teams: {}, coaching: {}, errors: [], counts: {} };

    for (const [sport, path] of Object.entries(ESPN_MAP)) {
      let teamCount = 0;
      try {
        // 1. Standings — primary source (season aggregate stats)
        const standings = await fetchStandings(path);
        if (standings) {
          const teams = extractTeamsFromStandings(standings, sport);
          teams.forEach(t => {
            if (t && t.team_name) {
              results.teams[`${sport}:${t.team_name}`] = t;
              teamCount++;
            }
          });
        }

        // 2. Scoreboard — for coaching data (halftime adjustments, close games)
        try {
          const scoreboard = await fetchScoreboard(path);
          if (scoreboard) {
            const events = scoreboard.events || [];
            const teamNames = new Set();
            events.forEach(e => {
              e.competitions?.[0]?.competitors?.forEach(c => {
                if (c.team?.displayName) teamNames.add(c.team.displayName);
              });
            });

            for (const name of teamNames) {
              const coach = await computeCoachingRating(sport, name, null, events);
              if (coach) results.coaching[`${sport}:${name}`] = coach;
            }
          }
        } catch (_) { /* coaching is optional */ }

      } catch (err) {
        results.errors.push({ sport, error: err.message });
      }
      results.counts[sport] = teamCount;
    }

    persistRatings(results).catch(() => {});
    return results;
  }

  // ============================================================
  // ── ESPN FETCHERS ──
  // ============================================================

  async function fetchStandings(path) {
    try {
      const res = await fetch(`https://site.api.espn.com/apis/v2/sports/${path}/standings`);
      if (!res.ok) return null;
      return await res.json();
    } catch { return null; }
  }

  async function fetchScoreboard(path) {
    try {
      const res = await fetch(`https://site.api.espn.com/apis/site/v2/sports/${path}/scoreboard`);
      if (!res.ok) return null;
      return await res.json();
    } catch { return null; }
  }

  async function fetchTeamStats(sport) {
    const path = ESPN_MAP[sport];
    if (!path) return null;
    return fetchScoreboard(path);
  }

  // ============================================================
  // ── STANDINGS EXTRACTION ──
  // ============================================================

  function extractTeamsFromStandings(standings, sport) {
    const cfg = SPORT_CONFIG[sport] || SPORT_CONFIG.NFL;
    const teams = [];
    const seen = new Set();

    function walk(node) {
      if (!node) return;
      if (Array.isArray(node.standings?.entries)) {
        node.standings.entries.forEach(entry => {
          const t = extractTeamFromEntry(entry, sport, cfg);
          if (t && !seen.has(t.team_id)) {
            seen.add(t.team_id);
            teams.push(t);
          }
        });
      }
      if (Array.isArray(node.children)) {
        node.children.forEach(walk);
      }
    }

    walk(standings);
    return teams;
  }

  function extractTeamFromEntry(entry, sport, cfg) {
    const team = entry.team;
    if (!team) return null;

    const stats = entry.stats || [];
    const getStat = names => {
      if (!Array.isArray(names)) names = [names];
      for (const n of names) {
        const s = stats.find(x => x.name === n);
        if (s && (s.value != null || s.displayValue != null)) {
          const v = parseFloat(s.value ?? s.displayValue);
          if (isFinite(v)) return v;
        }
      }
      return null;
    };

    const wins = getStat(['wins']) ?? 0;
    const losses = getStat(['losses']) ?? 0;
    const games = wins + losses;

    // Handle both total points and per-game averages
    const pfRaw = getStat(['pointsFor', 'avgPointsFor', 'pointsPerGame']);
    const paRaw = getStat(['pointsAgainst', 'avgPointsAgainst', 'pointsAllowedPerGame']);

    let avgPF, avgPA;

    if (pfRaw == null || paRaw == null) {
      // No scoring stats available — use league average
      avgPF = cfg.avgPF;
      avgPA = cfg.avgPA;
    } else if (pfRaw > cfg.avgPF * 5 && games > 0) {
      // Values are totals, not averages
      avgPF = pfRaw / games;
      avgPA = paRaw / games;
    } else {
      // Values are already per-game averages
      avgPF = pfRaw;
      avgPA = paRaw;
    }

    // Sanity clamp — averages should be within reason
    avgPF = clamp(avgPF, cfg.avgPF * 0.4, cfg.avgPF * 1.8);
    avgPA = clamp(avgPA, cfg.avgPA * 0.4, cfg.avgPA * 1.8);

    const avgMOV = avgPF - avgPA;

    const pyth = avgPA > 0
      ? Math.pow(avgPF, cfg.pyExp) / (Math.pow(avgPF, cfg.pyExp) + Math.pow(avgPA, cfg.pyExp))
      : 0.5;

    const offense = clamp(50 + ((avgPF - cfg.avgPF) / cfg.scale) * 50, 0, 100);
    const defense = clamp(50 - ((avgPA - cfg.avgPA) / cfg.scale) * 50, 0, 100);
    const srs = round(avgMOV, 2);
    const winPct = games > 0 ? wins / games : 0.5;
    const elo = 1500 + (winPct - 0.5) * 400 + avgMOV * 10;

    const overall = round(
      (pyth * 100 * 0.40) +
      (offense * 0.25) +
      (defense * 0.25) +
      (clamp(50 + (avgMOV / cfg.scale) * 50, 0, 100) * 0.10),
      1
    );

    return {
      team_id: String(team.id || team.abbreviation || team.displayName),
      team_name: team.displayName,
      abbr: team.abbreviation || (team.displayName || '').slice(0, 3).toUpperCase(),
      sport,
      overall: clamp(overall, 0, 100),
      offense: round(offense, 1),
      defense: round(defense, 1),
      pythagorean: round(pyth, 4),
      srs,
      elo: Math.round(elo),
      pace: round(avgPF, 1),
      record: `${wins}-${losses}`,
      home_record: '0-0',
      away_record: '0-0',
      last5_form: 0,
      games_played: games,
      raw_stats: {
        avgPF: round(avgPF, 2),
        avgPA: round(avgPA, 2),
        avgMOV: round(avgMOV, 2),
      },
    };
  }

  // ============================================================
  // ── TEAM RATING (from scoreboard events — kept as fallback) ──
  // ============================================================

  async function computeTeamRating(sport, teamName, teamId, espnEvents) {
    const cfg = SPORT_CONFIG[sport] || SPORT_CONFIG.NFL;

    let pf = 0, pa = 0, games = 0, movTotal = 0;
    let wins = 0, losses = 0, homeW = 0, homeL = 0, awayW = 0, awayL = 0;

    (espnEvents || []).forEach(e => {
      const comp = e.competitions?.[0];
      if (!comp) return;
      const us = comp.competitors?.find(c => c.team?.displayName === teamName);
      const opp = comp.competitors?.find(c => c.team?.displayName !== teamName);
      if (!us || !opp) return;
      const score = parseInt(us.score || 0);
      const oppScore = parseInt(opp.score || 0);
      if (score === 0 && oppScore === 0) return;

      pf += score; pa += oppScore; games++; movTotal += (score - oppScore);
      const won = score > oppScore;
      if (won) wins++; else losses++;
      if (us.homeAway === 'home') { won ? homeW++ : homeL++; }
      else { won ? awayW++ : awayL++; }
    });

    if (games === 0) {
      return {
        team_id: teamId, team_name: teamName, sport,
        overall: 50, offense: 50, defense: 50,
        pythagorean: 0.5, srs: 0, elo: 1500, pace: cfg.avgPF,
        record: '0-0', home_record: '0-0', away_record: '0-0',
        last5_form: 0, games_played: 0,
        raw_stats: { avgPF: cfg.avgPF, avgPA: cfg.avgPA, avgMOV: 0 },
      };
    }

    const avgPF = pf / games, avgPA = pa / games, avgMOV = movTotal / games;
    const pyth = avgPA > 0
      ? Math.pow(avgPF, cfg.pyExp) / (Math.pow(avgPF, cfg.pyExp) + Math.pow(avgPA, cfg.pyExp))
      : 0.5;

    const offense = clamp(50 + ((avgPF - cfg.avgPF) / cfg.scale) * 50, 0, 100);
    const defense = clamp(50 - ((avgPA - cfg.avgPA) / cfg.scale) * 50, 0, 100);
    const winPct = wins / games;
    const elo = 1500 + (winPct - 0.5) * 400 + avgMOV * 10;

    const overall = round(
      (pyth * 100 * 0.40) + (offense * 0.25) + (defense * 0.25) +
      (clamp(50 + (avgMOV / cfg.scale) * 50, 0, 100) * 0.10),
      1
    );

    return {
      team_id: teamId, team_name: teamName, sport,
      overall: clamp(overall, 0, 100),
      offense: round(offense, 1), defense: round(defense, 1),
      pythagorean: round(pyth, 4), srs: round(avgMOV, 2),
      elo: Math.round(elo), pace: round(avgPF, 1),
      record: `${wins}-${losses}`,
      home_record: `${homeW}-${homeL}`,
      away_record: `${awayW}-${awayL}`,
      last5_form: 0, games_played: games,
      raw_stats: { avgPF: round(avgPF, 2), avgPA: round(avgPA, 2), avgMOV: round(avgMOV, 2) },
    };
  }

  // ============================================================
  // ── COACHING ──
  // ============================================================

  async function computeCoachingRating(sport, teamName, teamId, espnEvents) {
    const cfg = COACHING_WEIGHTS[sport] || COACHING_WEIGHTS.DEFAULT;
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
      if (Math.abs(margin) <= 7) {
        closeGames++;
        if (score > oppScore) closeWins++;
      }

      const ourLines = us.linescores || [];
      if (ourLines.length >= 2) {
        const fh = sumFirst(ourLines, 2);
        const sh = sumRest(ourLines, 2);
        const oppLines = opp.linescores || [];
        const oppFh = sumFirst(oppLines, 2);
        const oppSh = sumRest(oppLines, 2);
        firstHalfMargin += (fh - oppFh);
        secondHalfMargin += (sh - oppSh);
        halves++;
      }
    });

    const closeWinPct = closeGames > 0 ? closeWins / closeGames : 0.5;
    const halftimeAdj = halves > 0
      ? round((secondHalfMargin - firstHalfMargin) / halves, 2)
      : 0;

    const closeComponent = closeWinPct * 100 * 0.6;
    const halftimeComponent = clamp(50 + halftimeAdj * 5, 0, 100) * 0.4;
    const overall = round(closeComponent + halftimeComponent, 1);

    return {
      coach_id: null, coach_name: null,
      team_id: teamId, team_name: teamName, sport,
      overall: clamp(overall, 0, 100),
      ats_as_favorite: null, ats_as_underdog: null,
      halftime_adjustment: halftimeAdj,
      close_game_record: round(closeWinPct, 3),
      primetime_record: null,
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
  // ── DEFENSE MATCHUP ──
  // ============================================================

  function computeDefenseMatchup(sport, homePower, awayPower) {
    if (!homePower || !awayPower) {
      return {
        home_defense_score: 50, away_defense_score: 50,
        scheme_advantage: 'neutral', adjustment_points: 0,
        notes: ['Insufficient power rating data'],
      };
    }

    const homeOffVsAwayDef = (homePower.offense + (100 - awayPower.defense)) / 2;
    const awayOffVsHomeDef = (awayPower.offense + (100 - homePower.defense)) / 2;
    const differential = homeOffVsAwayDef - awayOffVsHomeDef;

    const conversion = {
      NFL: 0.06, NBA: 0.08, MLB: 0.03, NHL: 0.02,
      NCAAF: 0.07, NCAAB: 0.08, MLS: 0.02,
    }[sport] || 0.05;

    const adjustment = round(differential * conversion, 2);
    const schemeAdvantage = Math.abs(adjustment) < 0.5 ? 'neutral'
                          : adjustment > 0 ? 'home' : 'away';

    const notes = [];
    if (homeOffVsAwayDef > 70) notes.push('Home offense vs weak away defense');
    if (awayOffVsHomeDef > 70) notes.push('Away offense vs weak home defense');
    if (homePower.defense > 75 && awayPower.defense > 75) notes.push('Defensive battle');

    return {
      home_defense_score: round(homeOffVsAwayDef, 1),
      away_defense_score: round(awayOffVsHomeDef, 1),
      scheme_advantage: schemeAdvantage,
      adjustment_points: adjustment,
      notes,
    };
  }

  // ============================================================
  // ── GAME PRIOR ──
  // ============================================================

  async function computeGamePrior(game, options = {}) {
    const { homeStats, awayStats, market } = options;
    if (!homeStats || !awayStats) throw new Error('computeGamePrior requires homeStats and awayStats');

    const sport = game._sport || game.sport;
    const defenseMatchup = computeDefenseMatchup(sport, homeStats, awayStats);

    const ratingDelta = homeStats.overall - awayStats.overall;
    const spreadConv = {
      NFL: -0.20, NBA: -0.20, MLB: -0.06, NHL: -0.04,
      NCAAF: -0.24, NCAAB: -0.20, MLS: -0.04,
    }[sport] || -0.20;

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

  // ============================================================
  // ── PERSIST ──
  // ============================================================

  async function persistRatings(results) {
    const url = SUPABASE_URL();
    const key = SUPABASE_KEY();
    if (!url || !key) return;

    const teamRows = Object.values(results.teams);
    const coachRows = Object.values(results.coaching);

    try {
      if (teamRows.length) {
        await fetch(`${url}/rest/v1/power_ratings`, {
          method: 'POST',
          headers: {
            apikey: key, Authorization: `Bearer ${key}`,
            'Content-Type': 'application/json',
            Prefer: 'resolution=merge-duplicates',
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
            Prefer: 'resolution=merge-duplicates',
          },
          body: JSON.stringify(coachRows),
        });
      }
    } catch {}
  }

  // ============================================================
  // ── LOOKUPS ──
  // ============================================================

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

})();

if (typeof window !== 'undefined') window.EDGE_POWER = EDGE_POWER;