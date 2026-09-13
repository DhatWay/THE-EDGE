// ============================================================
// EDGE — ATS + H2H TRACKER v1.0
// Builds two trend tables from historical results:
//
//   team_ats       — per team, per sport: season-to-date ATS record,
//                    last-10 ATS, home/away ATS, streak, cover rate,
//                    average margin vs spread.
//
//   matchup_ats    — per unordered pair of teams: ATS record in the
//                    last 5 seasons of meetings, average margin,
//                    cover rate for the home side, streak.
//
// Both tables are read by the trend family and by the analysis page.
// Trend data does NOT modify power ratings — it's a separate signal
// layered on top of them.
// ============================================================

const EDGE_ATS = (() => {

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

  // How far back to look for ATS form. Two seasons is enough for
  // teams to accrue meaningful trend data without dragging in
  // rosters that no longer exist.
  const HISTORY_DAYS = 730;

  // Recent window for form metrics.
  const FORM_WINDOW = 10;

  // Head-to-head window in seasons.
  const H2H_SEASONS = 5;

  // Fetch in 45-day chunks; ESPN caps at 1000 events per call.
  const CHUNK_DAYS = 45;
  const FETCH_CONCURRENCY = 3;

  return {
    buildAll,
    buildSport,
    TREND_FAMILY_SIGNAL,
  };

  // ============================================================
  // ── MAIN ──
  // ============================================================

  async function buildAll(options = {}) {
    const { sports = Object.keys(ESPN_MAP), onProgress = null } = options;
    const log = makeLogger(onProgress);
    const summary = { sports: {}, totals: { teams: 0, matchups: 0 } };

    for (const sport of sports) {
      log(`── ${sport} ──`);
      try {
        const result = await buildSport(sport, { onProgress });
        summary.sports[sport] = result;
        summary.totals.teams += result.teams_written;
        summary.totals.matchups += result.matchups_written;
      } catch (e) {
        log(`${sport} failed: ${e.message}`);
        summary.sports[sport] = { error: e.message };
      }
    }

    return summary;
  }

  async function buildSport(sport, options = {}) {
    const log = makeLogger(options.onProgress);
    const url = SUPABASE_URL();
    const key = SUPABASE_KEY();
    if (!url || !key) throw new Error('Supabase not connected');

    const path = ESPN_MAP[sport];
    if (!path) throw new Error(`Unknown sport: ${sport}`);

    // ── 1. Load historical odds ──
    // Prefer historical_odds if present. Otherwise fall back to
    // line_history which is only populated for games we've actually
    // seen live. When neither exists the ATS record can't be built
    // and we exit clean for the sport.
    log(`  loading odds`);
    const oddsIndex = await loadOdds(sport, url, key);
    const oddsCount = Object.keys(oddsIndex).length;
    log(`  ${oddsCount} games with odds`);

    if (!oddsCount) {
      return { teams_written: 0, matchups_written: 0, note: 'No odds for this sport' };
    }

    // ── 2. Fetch game results ──
    const now = new Date();
    const start = new Date(now.getTime() - HISTORY_DAYS * 86400000);
    log(`  fetching results ${start.toISOString().slice(0,10)} → now`);
    const events = await fetchRangeChunked(path, start, now, log);
    log(`  ${events.length} events fetched`);

    // Sort chronologically
    events.sort((a, b) => new Date(a.date) - new Date(b.date));

    // ── 3. Build per-team and per-matchup state ──
    const teamState = {};
    const matchupState = {};

    for (const e of events) {
      const comp = e.competitions?.[0];
      if (!comp) continue;
      if (comp.status?.type?.completed !== true) continue;

      const home = comp.competitors?.find(c => c.homeAway === 'home');
      const away = comp.competitors?.find(c => c.homeAway === 'away');
      if (!home || !away) continue;

      const homeName = home.team?.displayName;
      const awayName = away.team?.displayName;
      if (!homeName || !awayName) continue;

      const homeScore = parseInt(home.score || '0');
      const awayScore = parseInt(away.score || '0');
      if (homeScore === 0 && awayScore === 0) continue;

      const odds = oddsIndex[e.id];
      if (!odds || odds.spread == null) continue;

      // Closing spread from the home team's perspective.
      // Home spread negative = home favored.
      const closeSpread = odds.spread;
      const margin = homeScore - awayScore;

      // ATS result for the home team:
      // Home covers if (margin + spread) > 0 when spread is negative.
      // General form: home covers if margin > -spread.
      // We'll compute cover margin as margin + spread.
      const homeCoverMargin = margin + closeSpread;

      let homeResult; // from home's perspective
      if (Math.abs(homeCoverMargin) < 0.01) homeResult = 'P';
      else if (homeCoverMargin > 0) homeResult = 'W';
      else homeResult = 'L';

      // Total: not tracked here — different algorithm.

      const when = new Date(e.date);
      const seasonKey = seasonLabel(sport, when);

      applyTeamGame(teamState, homeName, sport, {
        when, wasHome: true, result: homeResult,
        coverMargin: homeCoverMargin, margin,
        opp: awayName, seasonKey,
      });
      applyTeamGame(teamState, awayName, sport, {
        when, wasHome: false,
        result: invertResult(homeResult),
        coverMargin: -homeCoverMargin,
        margin: -margin,
        opp: homeName, seasonKey,
      });

      applyMatchupGame(matchupState, homeName, awayName, sport, {
        when, homeResult, homeCoverMargin,
        margin, seasonKey,
        homeScore, awayScore,
      });
    }

    // ── 4. Flatten to rows ──
    const teamRows = Object.values(teamState).map(computeTeamSummary).filter(Boolean);
    const matchupRows = Object.values(matchupState).map(computeMatchupSummary).filter(Boolean);

    log(`  ${teamRows.length} team rows · ${matchupRows.length} matchup rows`);

    // ── 5. Upsert ──
    await upsertInChunks(`${url}/rest/v1/team_ats`, teamRows, key, log, 'team_ats');
    await upsertInChunks(`${url}/rest/v1/matchup_ats`, matchupRows, key, log, 'matchup_ats');

    return {
      teams_written: teamRows.length,
      matchups_written: matchupRows.length,
    };
  }

  // ============================================================
  // ── STATE ACCUMULATION ──
  // ============================================================

  function applyTeamGame(state, team, sport, ctx) {
    if (!state[team]) {
      state[team] = {
        team, sport,
        games: [],
      };
    }
    state[team].games.push({
      date: ctx.when.toISOString(),
      wasHome: ctx.wasHome,
      result: ctx.result,
      coverMargin: ctx.coverMargin,
      margin: ctx.margin,
      opp: ctx.opp,
      season: ctx.seasonKey,
    });
  }

  function applyMatchupGame(state, home, away, sport, ctx) {
    const [a, b] = [home, away].sort();
    const key = `${sport}:${a}|${b}`;
    if (!state[key]) {
      state[key] = {
        sport,
        team_a: a,
        team_b: b,
        games: [],
      };
    }
    state[key].games.push({
      date: ctx.when.toISOString(),
      home, away,
      home_result: ctx.homeResult,
      home_cover_margin: ctx.homeCoverMargin,
      margin: ctx.margin,
      home_score: ctx.homeScore,
      away_score: ctx.awayScore,
      season: ctx.seasonKey,
    });
  }

  // ============================================================
  // ── SUMMARIES ──
  // ============================================================

  function computeTeamSummary(t) {
    if (!t.games.length) return null;

    // Sort chronologically ascending
    t.games.sort((a, b) => new Date(a.date) - new Date(b.date));

    // Current season slice
    const latestSeason = t.games[t.games.length - 1].season;
    const seasonGames = t.games.filter(g => g.season === latestSeason);
    const seasonStats = recordSplit(seasonGames);

    // Last N form
    const formGames = t.games.slice(-FORM_WINDOW);
    const formStats = recordSplit(formGames);

    // Home / away splits for latest season
    const homeSplit = recordSplit(seasonGames.filter(g => g.wasHome));
    const awaySplit = recordSplit(seasonGames.filter(g => !g.wasHome));

    // Streak: current cover streak in latest season, signed.
    const streak = currentStreak(seasonGames);

    // Average cover margin (positive = covering by more)
    const avgCoverMargin = seasonGames.length
      ? round(seasonGames.reduce((s, g) => s + g.coverMargin, 0) / seasonGames.length, 2)
      : 0;

    // Average straight margin
    const avgMargin = seasonGames.length
      ? round(seasonGames.reduce((s, g) => s + g.margin, 0) / seasonGames.length, 2)
      : 0;

    // Trend label — is the team covering more or less in recent form
    // than their season baseline?
    const formRate = formStats.total > 0 ? formStats.wins / formStats.total : 0.5;
    const seasonRate = seasonStats.total > 0 ? seasonStats.wins / seasonStats.total : 0.5;
    const trendDelta = round(formRate - seasonRate, 4);
    const trendLabel =
      trendDelta >= 0.15 ? 'heating_up'
    : trendDelta <= -0.15 ? 'cooling_off'
    : 'stable';

    return {
      sport: t.sport,
      team_name: t.team,
      season_label: latestSeason,
      season_wins: seasonStats.wins,
      season_losses: seasonStats.losses,
      season_pushes: seasonStats.pushes,
      season_cover_pct: seasonStats.total > 0
        ? round(seasonStats.wins / seasonStats.total, 4)
        : null,
      last10_wins: formStats.wins,
      last10_losses: formStats.losses,
      last10_pushes: formStats.pushes,
      last10_cover_pct: formStats.total > 0
        ? round(formStats.wins / formStats.total, 4)
        : null,
      home_wins: homeSplit.wins,
      home_losses: homeSplit.losses,
      home_cover_pct: homeSplit.total > 0
        ? round(homeSplit.wins / homeSplit.total, 4)
        : null,
      away_wins: awaySplit.wins,
      away_losses: awaySplit.losses,
      away_cover_pct: awaySplit.total > 0
        ? round(awaySplit.wins / awaySplit.total, 4)
        : null,
      current_streak: streak,
      avg_cover_margin: avgCoverMargin,
      avg_margin: avgMargin,
      trend_delta: trendDelta,
      trend_label: trendLabel,
      total_games_tracked: t.games.length,
      updated_at: new Date().toISOString(),
    };
  }

  function computeMatchupSummary(m) {
    if (!m.games.length) return null;

    m.games.sort((a, b) => new Date(a.date) - new Date(b.date));

    // Restrict to last H2H_SEASONS seasons
    const cutoff = Date.now() - H2H_SEASONS * 365 * 86400000;
    const recent = m.games.filter(g => new Date(g.date).getTime() >= cutoff);
    if (!recent.length) return null;

    let teamAWins = 0, teamALosses = 0, teamAPushes = 0;
    let teamBWins = 0, teamBLosses = 0, teamBPushes = 0;

    recent.forEach(g => {
      // Determine which team is A/B
      const teamAIsHome = g.home === m.team_a;
      let aResult, bResult;
      if (teamAIsHome) {
        aResult = g.home_result;
        bResult = invertResult(g.home_result);
      } else {
        aResult = invertResult(g.home_result);
        bResult = g.home_result;
      }
      if (aResult === 'W') teamAWins++;
      else if (aResult === 'L') teamALosses++;
      else if (aResult === 'P') teamAPushes++;
      if (bResult === 'W') teamBWins++;
      else if (bResult === 'L') teamBLosses++;
      else if (bResult === 'P') teamBPushes++;
    });

    const totalAWins = teamAWins + teamALosses;
    const totalBWins = teamBWins + teamBLosses;

    const avgMargin = round(
      recent.reduce((s, g) => s + g.margin, 0) / recent.length,
      2
    );
    const avgHomeCoverMargin = round(
      recent.reduce((s, g) => s + g.home_cover_margin, 0) / recent.length,
      2
    );

    return {
      sport: m.sport,
      team_a: m.team_a,
      team_b: m.team_b,
      meetings: recent.length,
      team_a_wins: teamAWins,
      team_a_losses: teamALosses,
      team_a_pushes: teamAPushes,
      team_a_cover_pct: totalAWins > 0
        ? round(teamAWins / totalAWins, 4)
        : null,
      team_b_wins: teamBWins,
      team_b_losses: teamBLosses,
      team_b_pushes: teamBPushes,
      team_b_cover_pct: totalBWins > 0
        ? round(teamBWins / totalBWins, 4)
        : null,
      avg_margin: avgMargin,
      avg_home_cover_margin: avgHomeCoverMargin,
      last_meeting_date: recent[recent.length - 1].date,
      updated_at: new Date().toISOString(),
    };
  }

  function recordSplit(games) {
    let wins = 0, losses = 0, pushes = 0;
    games.forEach(g => {
      if (g.result === 'W') wins++;
      else if (g.result === 'L') losses++;
      else if (g.result === 'P') pushes++;
    });
    return { wins, losses, pushes, total: wins + losses };
  }

  function currentStreak(games) {
    if (!games.length) return 0;
    // games are chronological ascending; scan backwards
    let count = 0;
    let lastResult = null;
    for (let i = games.length - 1; i >= 0; i--) {
      const r = games[i].result;
      if (r === 'P') continue;
      if (lastResult === null) {
        lastResult = r;
        count = 1;
      } else if (r === lastResult) {
        count++;
      } else {
        break;
      }
    }
    if (lastResult === 'L') count = -count;
    return count;
  }

  function invertResult(r) {
    if (r === 'W') return 'L';
    if (r === 'L') return 'W';
    return r;
  }

  // ============================================================
  // ── ODDS LOADING ──
  // ============================================================

  async function loadOdds(sport, url, key) {
    const out = {};
    const headers = { apikey: key, Authorization: `Bearer ${key}` };

    // Try historical_odds first
    try {
      const res = await fetch(
        `${url}/rest/v1/historical_odds?sport=eq.${sport}&select=*`,
        { headers }
      );
      if (res.ok) {
        const rows = await res.json();
        rows.forEach(r => { out[r.game_id] = r; });
        return out;
      }
    } catch {}

    // Fallback to line_history — only has games we've seen live
    try {
      const res = await fetch(
        `${url}/rest/v1/line_history?sport=eq.${sport}&select=game_id,spread,created_at&order=created_at.asc`,
        { headers }
      );
      if (res.ok) {
        const rows = await res.json();
        // Keep the last (closing) spread per game
        rows.forEach(r => {
          if (!out[r.game_id]) out[r.game_id] = { spread: r.spread };
          else out[r.game_id].spread = r.spread;
        });
      }
    } catch {}

    return out;
  }

  // ============================================================
  // ── ESPN FETCH ──
  // ============================================================

  async function fetchRangeChunked(path, start, end, log) {
    const chunks = [];
    let cur = new Date(start);
    while (cur <= end) {
      const chunkEnd = new Date(cur);
      chunkEnd.setDate(chunkEnd.getDate() + CHUNK_DAYS);
      if (chunkEnd > end) chunkEnd.setTime(end.getTime());
      chunks.push([new Date(cur), new Date(chunkEnd)]);
      cur = new Date(chunkEnd);
      cur.setDate(cur.getDate() + 1);
    }

    const results = [];
    const queue = [...chunks];
    const workers = Array.from({ length: FETCH_CONCURRENCY }, async () => {
      while (queue.length) {
        const [a, b] = queue.shift();
        const events = await fetchEspnRange(path, a, b);
        results.push(...events);
      }
    });
    await Promise.all(workers);
    return results;
  }

  async function fetchEspnRange(path, start, end) {
    const fmt = d => `${d.getFullYear()}${String(d.getMonth() + 1).padStart(2, '0')}${String(d.getDate()).padStart(2, '0')}`;
    const url = `https://site.api.espn.com/apis/site/v2/sports/${path}/scoreboard?dates=${fmt(start)}-${fmt(end)}&limit=1000`;
    try {
      const res = await fetch(url, { cache: 'no-store' });
      if (!res.ok) return [];
      const data = await res.json();
      return data.events || [];
    } catch { return []; }
  }

  // ============================================================
  // ── UPSERT ──
  // ============================================================

  async function upsertInChunks(endpoint, rows, key, log, tableName) {
    if (!rows.length) return;
    const chunkSize = 500;
    for (let i = 0; i < rows.length; i += chunkSize) {
      const chunk = rows.slice(i, i + chunkSize);
      try {
        const res = await fetch(endpoint, {
          method: 'POST',
          headers: {
            apikey: key, Authorization: `Bearer ${key}`,
            'Content-Type': 'application/json',
            Prefer: 'resolution=merge-duplicates,return=minimal',
          },
          body: JSON.stringify(chunk),
        });
        if (!res.ok) {
          const txt = await res.text().catch(() => '');
          log(`  ${tableName} chunk ${i}: HTTP ${res.status} ${txt.slice(0, 100)}`);
        }
      } catch (e) {
        log(`  ${tableName} chunk ${i}: ${e.message}`);
      }
    }
  }

  // ============================================================
  // ── SEASON LABEL ──
  // Format: "2025" for single-year seasons, "2025-26" for cross-year
  // ones (NBA, NHL). Keeps ATS records separated by year.
  // ============================================================

  function seasonLabel(sport, date) {
    const m = date.getMonth() + 1;
    const y = date.getFullYear();
    if (['NBA', 'NHL'].includes(sport)) {
      // Season runs Oct → Jun. Anything before July belongs to the
      // season that started the previous October.
      if (m <= 6) return `${y - 1}-${String(y).slice(2)}`;
      return `${y}-${String(y + 1).slice(2)}`;
    }
    return String(y);
  }

  // ============================================================
  // ── TREND FAMILY SIGNAL ──
  // Look up the ATS + H2H context for a single game. Used by the
  // trend family in algorithms.js. Returns a compact structure
  // with everything needed to vote.
  // ============================================================

  const TREND_FAMILY_SIGNAL = {
    async build(prior) {
      const url = SUPABASE_URL();
      const key = SUPABASE_KEY();
      if (!url || !key) return null;

      const home = prior.home_team;
      const away = prior.away_team;
      const sport = prior.sport;

      try {
        const [aRes, bRes, h2hRes] = await Promise.all([
          fetch(`${url}/rest/v1/team_ats?sport=eq.${sport}&team_name=eq.${encodeURIComponent(home)}&limit=1`,
            { headers: { apikey: key, Authorization: `Bearer ${key}` } }),
          fetch(`${url}/rest/v1/team_ats?sport=eq.${sport}&team_name=eq.${encodeURIComponent(away)}&limit=1`,
            { headers: { apikey: key, Authorization: `Bearer ${key}` } }),
          fetch(`${url}/rest/v1/matchup_ats?sport=eq.${sport}&or=(and(team_a.eq.${encodeURIComponent(home)},team_b.eq.${encodeURIComponent(away)}),and(team_a.eq.${encodeURIComponent(away)},team_b.eq.${encodeURIComponent(home)}))&limit=1`,
            { headers: { apikey: key, Authorization: `Bearer ${key}` } }),
        ]);

        const homeAts = aRes.ok ? (await aRes.json())[0] : null;
        const awayAts = bRes.ok ? (await bRes.json())[0] : null;
        const h2h = h2hRes.ok ? (await h2hRes.json())[0] : null;

        return { home_ats: homeAts, away_ats: awayAts, h2h };
      } catch {
        return null;
      }
    },
  };

  // ============================================================
  // ── UTILITIES ──
  // ============================================================

  function makeLogger(onProgress) {
    return (msg) => { if (typeof onProgress === 'function') onProgress(msg); };
  }

  function round(v, d) { const f = Math.pow(10, d); return Math.round(v * f) / f; }

})();

if (typeof window !== 'undefined') window.EDGE_ATS = EDGE_ATS;