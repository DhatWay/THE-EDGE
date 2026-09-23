// ============================================================
// EDGE — ATS + H2H TRACKER v2.4
//
// Odds sources, in priority order:
//   1. historical_odds in Supabase       (cached from earlier runs)
//   2. ESPN core API per-event odds      (close → current → open)
//   3. line_history                      (games seen live)
//
// v2.4 — open_spread is now captured. The four line-movement
// situations (rlm_against_home, rlm_against_away,
// line_moved_2plus_toward_home, line_moved_2plus_toward_away)
// depend on knowing where the number opened, and every
// historical_odds row was previously written with only the
// closing spread. ESPN's core API sends the open block on the
// same response the close comes from — parseOddsItem was
// returning on the first phase that had a spread and
// discarding the rest.
//
//   · parseOddsItem now parses every phase independently.
//     close → spread, open → open_spread. No fallback for open;
//     a missing open stays null rather than fabricating a number.
//   · Multi-book: prefers the item that carries both a close
//     and an open over one that only has a close.
//   · Schema probe. historical_odds may not have open_spread
//     yet. If the column is missing the write omits it, the
//     log prints the exact ALTER, and everything else keeps
//     working. Add the column before re-running to populate.
//   · Refetch logic. Games with a cached spread but no cached
//     open are queued on the next run so the column fills in.
//
// v2.3 — fetch uses ?dates=YYYY (single year). College endpoints
// need a groups filter (80 FBS / 50 D-I) or they return nothing.
// Soccer wants a range rather than a year. Writes now retry on
// transient fetch failures instead of dropping the chunk.
// ============================================================

const EDGE_ATS = (() => {

  const BUILD = 'ats-20260923-01';

  const SUPABASE_URL = () => localStorage.getItem('edge_supabase_url');
  const SUPABASE_KEY = () => localStorage.getItem('edge_supabase_key');

  function logEdgeError(where, err) {
    try {
      const list = JSON.parse(localStorage.getItem('edge_errors') || '[]');
      list.unshift({ t: Date.now(), where, msg: err && err.message ? err.message : String(err) });
      localStorage.setItem('edge_errors', JSON.stringify(list.slice(0, 50)));
    } catch {}
  }

  const ESPN_MAP = {
    NFL:   { path: 'football/nfl',                        sport: 'football',   league: 'nfl' },
    NBA:   { path: 'basketball/nba',                      sport: 'basketball', league: 'nba' },
    WNBA:  { path: 'basketball/wnba',                     sport: 'basketball', league: 'wnba' },
    MLB:   { path: 'baseball/mlb',                        sport: 'baseball',   league: 'mlb' },
    NHL:   { path: 'hockey/nhl',                          sport: 'hockey',     league: 'nhl' },
    NCAAF: { path: 'football/college-football',           sport: 'football',   league: 'college-football' },
    NCAAB: { path: 'basketball/mens-college-basketball',  sport: 'basketball', league: 'mens-college-basketball' },
    MLS:   { path: 'soccer/usa.1',                        sport: 'soccer',     league: 'usa.1' },
  };

  const H2H_SEASONS = 5;
  const HISTORY_DAYS = H2H_SEASONS * 365;

  const SPORT_HISTORY_DAYS = {
    NFL: 1825, NCAAF: 1825, MLS: 1460,
    NHL: 1095, NBA: 1095, MLB: 1095, NCAAB: 1095, WNBA: 1095,
  };

  const FORM_WINDOW = 10;
  const FETCH_CONCURRENCY = 4;

  const MAX_ODDS_LOOKUPS_PER_RUN = 1200;
  const ODDS_CONCURRENCY = 6;

  const TREND_FAMILY_SIGNAL = {
    async build(prior) {
      const url = SUPABASE_URL();
      const key = SUPABASE_KEY();
      if (!url || !key) return null;

      const { home_team: home, away_team: away, sport } = prior;
      const headers = { apikey: key, Authorization: `Bearer ${key}` };

      try {
        const [aRes, bRes] = await Promise.all([
          fetch(`${url}/rest/v1/team_ats?sport=eq.${sport}&team_name=eq.${encodeURIComponent(home)}&limit=1`, { headers }),
          fetch(`${url}/rest/v1/team_ats?sport=eq.${sport}&team_name=eq.${encodeURIComponent(away)}&limit=1`, { headers }),
        ]);
        const homeAts = aRes.ok ? (await aRes.json())[0] : null;
        const awayAts = bRes.ok ? (await bRes.json())[0] : null;
        const h2h = await getMatchupHistory(sport, home, away);
        return { home_ats: homeAts, away_ats: awayAts, h2h };
      } catch (e) {
        logEdgeError('ats.trendSignal', e);
        return null;
      }
    },
  };

  return {
    BUILD,
    buildAll,
    buildSport,
    resolveGameOdds,
    getMatchupHistory,
    TREND_FAMILY_SIGNAL,
    H2H_SEASONS,
  };

  // ============================================================
  // ── MAIN ──
  // ============================================================

  async function buildAll(options = {}) {
    const { sports = Object.keys(ESPN_MAP), onProgress = null } = options;
    const log = makeLogger(onProgress);
    const summary = {
      sports: {},
      totals: { teams: 0, matchups: 0, odds_resolved: 0, opens_resolved: 0 },
    };

    for (const sport of sports) {
      log(`── ${sport} ──`);
      try {
        const result = await buildSport(sport, { onProgress });
        summary.sports[sport] = result;
        summary.totals.teams += result.teams_written || 0;
        summary.totals.matchups += result.matchups_written || 0;
        summary.totals.odds_resolved += result.odds_resolved || 0;
        summary.totals.opens_resolved += result.opens_resolved || 0;
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

    const cfg = ESPN_MAP[sport];
    if (!cfg) throw new Error(`Unknown sport: ${sport}`);

    const canStoreOpen = await hasOpenSpreadColumn(url, key);
    if (!canStoreOpen) {
      log('  ⚠ historical_odds has no open_spread column');
      log('    market situations will stay untestable until added:');
      log('    alter table historical_odds add column open_spread numeric;');
    }

    const days = SPORT_HISTORY_DAYS[sport] || HISTORY_DAYS;
    const now = new Date();
    const start = new Date(now.getTime() - days * 86400000);
    log(`  results ${start.toISOString().slice(0, 10)} → now`);

    const events = await fetchRangeChunked(cfg.path, start, now, log, sport);
    const games = events.map(e => parseEvent(sport, e)).filter(Boolean);
    games.sort((a, b) => new Date(a.date) - new Date(b.date));
    log(`  ${games.length} completed games`);

    if (!games.length) {
      return { teams_written: 0, matchups_written: 0, odds_resolved: 0, opens_resolved: 0, note: 'No results' };
    }

    log('  loading cached odds');
    const oddsIndex = await loadCachedOdds(sport, url, key, canStoreOpen);
    const withSpread = Object.values(oddsIndex).filter(r => r.spread != null).length;
    const withOpen   = Object.values(oddsIndex).filter(r => r.open_spread != null).length;
    log(`  ${withSpread} cached spreads · ${withOpen} cached opens`);

    // Games to (re)look-up. Priority:
    //   1. Never cached.
    //   2. Cached without a spread.
    //   3. Cached with a spread but missing an open — only when the
    //      column exists, since there's no point re-fetching a value
    //      we can't store.
    const missing = games.filter(g => {
      const cached = oddsIndex[g.id];
      if (!cached) return true;
      if (cached.spread == null) return true;
      if (canStoreOpen && cached.open_spread == null) return true;
      return false;
    });

    const toLookup = missing.slice(0, MAX_ODDS_LOOKUPS_PER_RUN);
    let resolved = 0;
    let opensResolved = 0;

    if (toLookup.length) {
      log(`  resolving ${toLookup.length} of ${missing.length} from ESPN`);
      const fresh = [];

      await parallelMap(toLookup, ODDS_CONCURRENCY, async g => {
        const odds = await resolveGameOdds(cfg, g.id);
        if (!odds || odds.spread == null) return;

        oddsIndex[g.id] = odds;
        resolved++;
        if (odds.open_spread != null) opensResolved++;

        const row = {
          game_id: g.id,
          sport,
          home: g.home,
          away: g.away,
          game_date: g.date,
          spread: odds.spread,
          total: odds.total ?? null,
          home_ml: odds.home_ml ?? null,
          away_ml: odds.away_ml ?? null,
          provider: odds.provider ?? null,
          updated_at: new Date().toISOString(),
        };
        if (canStoreOpen) row.open_spread = odds.open_spread ?? null;

        fresh.push(row);
      });

      if (fresh.length) {
        await upsert(`${url}/rest/v1/historical_odds?on_conflict=game_id`, fresh, key, log, 'historical_odds');
        log(`  cached ${fresh.length} lines · ${opensResolved} with an open`);
      }
      if (missing.length > toLookup.length) {
        log(`  ${missing.length - toLookup.length} still unresolved — run again to continue`);
      }
    }

    const priced = games.filter(g => oddsIndex[g.id]?.spread != null);
    log(`  ${priced.length} games with a spread`);

    if (!priced.length) {
      return {
        teams_written: 0, matchups_written: 0,
        odds_resolved: resolved, opens_resolved: opensResolved,
        note: 'No spreads resolved',
      };
    }

    const teamState = {};
    const matchupState = {};

    priced.forEach(g => {
      const closeSpread = oddsIndex[g.id].spread;
      const margin = g.homeScore - g.awayScore;
      const homeCoverMargin = round(margin + closeSpread, 2);

      const homeResult = Math.abs(homeCoverMargin) < 0.01 ? 'P'
                       : homeCoverMargin > 0 ? 'W' : 'L';

      const when = new Date(g.date);
      const seasonKey = seasonLabel(sport, when);

      applyTeamGame(teamState, g.home, sport, {
        when, wasHome: true, result: homeResult,
        coverMargin: homeCoverMargin, margin, spread: closeSpread,
        opp: g.away, seasonKey,
      });
      applyTeamGame(teamState, g.away, sport, {
        when, wasHome: false, result: invertResult(homeResult),
        coverMargin: -homeCoverMargin, margin: -margin, spread: -closeSpread,
        opp: g.home, seasonKey,
      });

      applyMatchupGame(matchupState, g.home, g.away, sport, {
        when, homeResult, homeCoverMargin, margin, seasonKey,
        homeScore: g.homeScore, awayScore: g.awayScore,
        spread: closeSpread,
        total: oddsIndex[g.id].total ?? null,
      });
    });

    const teamRows = Object.values(teamState).map(computeTeamSummary).filter(Boolean);
    const matchupRows = Object.values(matchupState).map(computeMatchupSummary).filter(Boolean);
    log(`  ${teamRows.length} team rows · ${matchupRows.length} matchup rows`);

    await upsert(`${url}/rest/v1/team_ats?on_conflict=sport,team_name`, teamRows, key, log, 'team_ats');
    await upsert(`${url}/rest/v1/matchup_ats?on_conflict=sport,team_a,team_b`, matchupRows, key, log, 'matchup_ats');

    return {
      teams_written: teamRows.length,
      matchups_written: matchupRows.length,
      odds_resolved: resolved,
      opens_resolved: opensResolved,
      games_graded: priced.length,
      games_unpriced: games.length - priced.length,
      open_spread_available: canStoreOpen,
    };
  }

  // ============================================================
  // ── SCHEMA PROBE ──
  // open_spread is optional. When it is missing, writes must omit
  // it or PostgREST rejects the entire batch — including the
  // spread, total and ML that were working before.
  // ============================================================

  async function hasOpenSpreadColumn(url, key) {
    try {
      const res = await fetch(`${url}/rest/v1/historical_odds?select=open_spread&limit=1`, {
        headers: { apikey: key, Authorization: `Bearer ${key}` },
      });
      return res.ok;
    } catch { return false; }
  }

  // ============================================================
  // ── EVENT PARSING ──
  // ============================================================

  function parseEvent(sport, e) {
    const comp = e.competitions?.[0];
    if (!comp) return null;

    const type = e.season?.type ?? comp.season?.type;
    if (type === 1) return null;

    if (comp.status?.type?.completed !== true) return null;

    const home = comp.competitors?.find(c => c.homeAway === 'home');
    const away = comp.competitors?.find(c => c.homeAway === 'away');
    if (!home || !away) return null;

    const homeName = home.team?.displayName;
    const awayName = away.team?.displayName;
    if (!homeName || !awayName) return null;

    const homeScore = parseInt(home.score, 10);
    const awayScore = parseInt(away.score, 10);
    if (!isFinite(homeScore) || !isFinite(awayScore)) return null;

    return {
      id: String(e.id),
      date: e.date,
      home: homeName, away: awayName,
      homeScore, awayScore,
      neutral: comp.neutralSite === true,
    };
  }

  // ============================================================
  // ── CORE API ODDS ──
  //
  // ESPN sends one item per provider per event. Each item carries
  // three phase blocks — open, current, close — with the line as
  // it stood at each point. Which blocks are populated varies by
  // sport and by how close to kickoff the fetch happened.
  // ============================================================

  async function resolveGameOdds(cfg, eventId) {
    const url = `https://sports.core.api.espn.com/v2/sports/${cfg.sport}/leagues/${cfg.league}` +
                `/events/${eventId}/competitions/${eventId}/odds`;
    try {
      const res = await fetch(url, { cache: 'no-store' });
      if (!res.ok) return null;
      const data = await res.json();
      const items = data.items || [];
      if (!items.length) return null;

      // Score each item: close is required for grading, open is what
      // this version adds. Prefer an item that carries both.
      let best = null;
      let bestScore = -1;

      for (const item of items) {
        const parsed = parseOddsItem(item);
        if (!parsed) continue;

        const score =
          (parsed.phase === 'close' ? 10 : parsed.phase === 'current' ? 5 : 1) +
          (parsed.open_spread != null ? 8 : 0);

        if (score > bestScore) {
          best = parsed;
          bestScore = score;
        }
        // Early exit: an item that has both a close and an open
        // is as good as it gets.
        if (parsed.phase === 'close' && parsed.open_spread != null) return parsed;
      }

      return best;
    } catch (e) {
      logEdgeError('ats.resolveGameOdds.' + eventId, e);
      return null;
    }
  }

  function parseOddsItem(item) {
    if (!item) return null;

    const phaseBlocks = [
      ['close',   item.close],
      ['current', item.current],
      ['open',    item.open],
    ];

    const parsed = {};
    for (const [phase, block] of phaseBlocks) {
      if (!block) continue;
      const p = parsePhaseBlock(block);
      if (p.spread == null) continue;
      parsed[phase] = p;
    }

    // Flat fields, seen on some events. Only used when no phase
    // block carried a spread.
    if (!parsed.close && !parsed.current && !parsed.open) {
      const flat = numOrNull(item.spread);
      if (flat == null) return null;
      return {
        spread: flat,
        total: numOrNull(item.overUnder),
        home_ml: numOrNull(item.homeTeamOdds?.moneyLine),
        away_ml: numOrNull(item.awayTeamOdds?.moneyLine),
        provider: item.provider?.name || null,
        phase: 'flat',
        open_spread: null,
      };
    }

    // Closing line: prefer close, fall back to current, then open.
    const closeBlock = parsed.close || parsed.current || parsed.open;

    // Opening line: only the open block. No fallback — inventing an
    // open from a close would poison the movement rules silently.
    const openBlock = parsed.open || null;

    return {
      spread: closeBlock.spread,
      total: closeBlock.total,
      home_ml: closeBlock.home_ml ?? parsed.close?.home_ml
            ?? parsed.current?.home_ml ?? parsed.open?.home_ml ?? null,
      away_ml: closeBlock.away_ml ?? parsed.close?.away_ml
            ?? parsed.current?.away_ml ?? parsed.open?.away_ml ?? null,
      provider: item.provider?.name || null,
      phase: parsed.close ? 'close' : parsed.current ? 'current' : 'open',
      open_spread: openBlock?.spread ?? null,
    };
  }

  function parsePhaseBlock(block) {
    let spread =
      numOrNull(block.pointSpread?.alternateDisplayValue) ??
      numOrNull(block.pointSpread?.american) ??
      numOrNull(block.pointSpread?.value) ??
      numOrNull(block.spread?.value) ??
      numOrNull(block.spread);

    if (spread == null && block.home?.pointSpread) {
      spread =
        numOrNull(block.home.pointSpread.alternateDisplayValue) ??
        numOrNull(block.home.pointSpread.american) ??
        numOrNull(block.home.pointSpread.value);
    }

    if (spread == null) return { spread: null, total: null, home_ml: null, away_ml: null };

    const total =
      numOrNull(block.total?.alternateDisplayValue) ??
      numOrNull(block.total?.value) ??
      numOrNull(block.overUnder?.value);

    return {
      spread,
      total,
      home_ml: numOrNull(block.home?.moneyLine?.american),
      away_ml: numOrNull(block.away?.moneyLine?.american),
    };
  }

  // ============================================================
  // ── CACHED ODDS ──
  // ============================================================

  async function loadCachedOdds(sport, url, key, canReadOpen) {
    const out = {};
    const headers = { apikey: key, Authorization: `Bearer ${key}` };

    const cols = canReadOpen
      ? 'game_id,spread,total,home_ml,away_ml,open_spread'
      : 'game_id,spread,total,home_ml,away_ml';

    try {
      const res = await fetch(
        `${url}/rest/v1/historical_odds?sport=eq.${sport}&select=${cols}&limit=50000`,
        { headers }
      );
      if (res.ok) {
        const rows = await res.json();
        rows.forEach(r => {
          if (r.spread != null) out[r.game_id] = r;
        });
      }
    } catch (e) { logEdgeError('ats.loadCachedOdds.historical.' + sport, e); }

    try {
      const res = await fetch(
        `${url}/rest/v1/line_history?sport=eq.${sport}&select=game_id,spread,total,ml,created_at&order=created_at.asc&limit=50000`,
        { headers }
      );
      if (res.ok) {
        const rows = await res.json();
        rows.forEach(r => {
          if (r.spread == null) return;
          if (out[r.game_id]?.spread != null) return;
          out[r.game_id] = {
            spread: r.spread,
            total: r.total ?? null,
            home_ml: r.ml ?? null,
            open_spread: null,
          };
        });
      }
    } catch (e) { logEdgeError('ats.loadCachedOdds.lineHistory.' + sport, e); }

    return out;
  }

  // ============================================================
  // ── STATE ──
  // ============================================================

  function applyTeamGame(state, team, sport, ctx) {
    if (!state[team]) state[team] = { team, sport, games: [] };
    state[team].games.push({
      date: ctx.when.toISOString(),
      wasHome: ctx.wasHome,
      result: ctx.result,
      coverMargin: ctx.coverMargin,
      margin: ctx.margin,
      spread: ctx.spread,
      opp: ctx.opp,
      season: ctx.seasonKey,
    });
  }

  function applyMatchupGame(state, home, away, sport, ctx) {
    const [a, b] = [home, away].sort();
    const key = `${sport}:${a}|${b}`;
    if (!state[key]) state[key] = { sport, team_a: a, team_b: b, games: [] };
    state[key].games.push({
      date: ctx.when.toISOString(),
      home, away,
      home_result: ctx.homeResult,
      home_cover_margin: ctx.homeCoverMargin,
      margin: ctx.margin,
      home_score: ctx.homeScore,
      away_score: ctx.awayScore,
      spread: ctx.spread,
      total: ctx.total,
      season: ctx.seasonKey,
    });
  }

  // ============================================================
  // ── SUMMARIES ──
  // ============================================================

  function computeTeamSummary(t) {
    if (!t.games.length) return null;
    t.games.sort((a, b) => new Date(a.date) - new Date(b.date));

    const latestSeason = t.games[t.games.length - 1].season;
    const seasonGames = t.games.filter(g => g.season === latestSeason);
    const seasonStats = recordSplit(seasonGames);
    const formGames = t.games.slice(-FORM_WINDOW);
    const formStats = recordSplit(formGames);
    const homeSplit = recordSplit(seasonGames.filter(g => g.wasHome));
    const awaySplit = recordSplit(seasonGames.filter(g => !g.wasHome));

    const favSplit = recordSplit(seasonGames.filter(g => g.spread < 0));
    const dogSplit = recordSplit(seasonGames.filter(g => g.spread > 0));

    const streak = currentStreak(seasonGames);
    const avgCoverMargin = mean(seasonGames.map(g => g.coverMargin));
    const avgMargin = mean(seasonGames.map(g => g.margin));

    const formRate = formStats.total > 0 ? formStats.wins / formStats.total : 0.5;
    const seasonRate = seasonStats.total > 0 ? seasonStats.wins / seasonStats.total : 0.5;
    const trendDelta = round(formRate - seasonRate, 4);
    const trendLabel = trendDelta >= 0.15 ? 'heating_up'
                     : trendDelta <= -0.15 ? 'cooling_off'
                     : 'stable';

    return {
      sport: t.sport,
      team_name: t.team,
      season_label: latestSeason,
      season_wins: seasonStats.wins,
      season_losses: seasonStats.losses,
      season_pushes: seasonStats.pushes,
      season_cover_pct: pct(seasonStats),
      last10_wins: formStats.wins,
      last10_losses: formStats.losses,
      last10_pushes: formStats.pushes,
      last10_cover_pct: pct(formStats),
      home_wins: homeSplit.wins,
      home_losses: homeSplit.losses,
      home_cover_pct: pct(homeSplit),
      away_wins: awaySplit.wins,
      away_losses: awaySplit.losses,
      away_cover_pct: pct(awaySplit),
      favorite_wins: favSplit.wins,
      favorite_losses: favSplit.losses,
      favorite_cover_pct: pct(favSplit),
      underdog_wins: dogSplit.wins,
      underdog_losses: dogSplit.losses,
      underdog_cover_pct: pct(dogSplit),
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

    const cutoff = Date.now() - H2H_SEASONS * 365 * 86400000;
    const recent = m.games.filter(g => new Date(g.date).getTime() >= cutoff);
    if (!recent.length) return null;

    let aW = 0, aL = 0, aP = 0, bW = 0, bL = 0, bP = 0;
    let aSU = 0, bSU = 0;
    let overs = 0, unders = 0, totalPush = 0;

    recent.forEach(g => {
      const aIsHome = g.home === m.team_a;
      const aResult = aIsHome ? g.home_result : invertResult(g.home_result);
      const bResult = aIsHome ? invertResult(g.home_result) : g.home_result;

      if (aResult === 'W') aW++; else if (aResult === 'L') aL++; else aP++;
      if (bResult === 'W') bW++; else if (bResult === 'L') bL++; else bP++;

      const aScore = aIsHome ? g.home_score : g.away_score;
      const bScore = aIsHome ? g.away_score : g.home_score;
      if (aScore > bScore) aSU++; else if (bScore > aScore) bSU++;

      if (g.total != null) {
        const combined = g.home_score + g.away_score;
        if (combined > g.total) overs++;
        else if (combined < g.total) unders++;
        else totalPush++;
      }
    });

    const aTotal = aW + aL;
    const bTotal = bW + bL;

    const log = recent.slice(-5).map(g => ({
      date: g.date.slice(0, 10),
      home: g.home,
      away: g.away,
      score: `${g.home_score}-${g.away_score}`,
      spread: g.spread,
      total: g.total,
      home_covered: g.home_result === 'W',
      cover_margin: g.home_cover_margin,
    }));

    return {
      sport: m.sport,
      team_a: m.team_a,
      team_b: m.team_b,
      meetings: recent.length,
      team_a_wins: aW,
      team_a_losses: aL,
      team_a_pushes: aP,
      team_a_cover_pct: aTotal > 0 ? round(aW / aTotal, 4) : null,
      team_b_wins: bW,
      team_b_losses: bL,
      team_b_pushes: bP,
      team_b_cover_pct: bTotal > 0 ? round(bW / bTotal, 4) : null,
      team_a_su_wins: aSU,
      team_b_su_wins: bSU,
      overs,
      unders,
      total_pushes: totalPush,
      over_pct: (overs + unders) > 0 ? round(overs / (overs + unders), 4) : null,
      avg_margin: mean(recent.map(g => g.margin)),
      avg_home_cover_margin: mean(recent.map(g => g.home_cover_margin)),
      avg_total: recent.some(g => g.total != null)
        ? mean(recent.filter(g => g.total != null).map(g => g.home_score + g.away_score))
        : null,
      last_meeting_date: recent[recent.length - 1].date,
      recent_meetings: log,
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

  function pct(split) {
    return split.total > 0 ? round(split.wins / split.total, 4) : null;
  }

  function currentStreak(games) {
    if (!games.length) return 0;
    let count = 0, last = null;
    for (let i = games.length - 1; i >= 0; i--) {
      const r = games[i].result;
      if (r === 'P') continue;
      if (last === null) { last = r; count = 1; }
      else if (r === last) count++;
      else break;
    }
    return last === 'L' ? -count : count;
  }

  function invertResult(r) {
    if (r === 'W') return 'L';
    if (r === 'L') return 'W';
    return r;
  }

  // ============================================================
  // ── MATCHUP HISTORY (read path) ──
  // ============================================================

  async function getMatchupHistory(sport, homeTeam, awayTeam) {
    const url = SUPABASE_URL();
    const key = SUPABASE_KEY();
    if (!url || !key) return null;

    const [a, b] = [homeTeam, awayTeam].sort();
    try {
      const res = await fetch(
        `${url}/rest/v1/matchup_ats?sport=eq.${sport}` +
        `&team_a=eq.${encodeURIComponent(a)}&team_b=eq.${encodeURIComponent(b)}&limit=1`,
        { headers: { apikey: key, Authorization: `Bearer ${key}` } }
      );
      if (!res.ok) return null;
      const rows = await res.json();
      const h2h = rows[0] || null;
      if (!h2h) return null;

      const homeIsA = h2h.team_a === homeTeam;
      return {
        ...h2h,
        home_cover_pct: homeIsA ? h2h.team_a_cover_pct : h2h.team_b_cover_pct,
        away_cover_pct: homeIsA ? h2h.team_b_cover_pct : h2h.team_a_cover_pct,
        home_su_wins: homeIsA ? h2h.team_a_su_wins : h2h.team_b_su_wins,
        away_su_wins: homeIsA ? h2h.team_b_su_wins : h2h.team_a_su_wins,
      };
    } catch (e) {
      logEdgeError('ats.getMatchupHistory', e);
      return null;
    }
  }

  // ============================================================
  // ── FETCH ──
  //
  // ESPN's range format ?dates=YYYYMMDD-YYYYMMDD returns HTTP 400
  // for anything outside the current season. The single-year format
  // ?dates=YYYY works and returns that season's games in one call.
  //
  // College endpoints additionally need a groups filter — 80 is FBS
  // football, 50 is Division I basketball — or they return an empty
  // event list even for a valid year.
  //
  // Soccer does not honour ?dates=YYYY at all; it needs a range, and
  // its season fits inside a calendar year, so a full-year range works.
  // ============================================================

  async function fetchRangeChunked(path, start, end, log, sport) {
    const years = [];
    for (let y = start.getFullYear(); y <= end.getFullYear(); y++) years.push(y);

    if (log) log(`  fetching ${years.length} season${years.length === 1 ? '' : 's'}: ${years.join(', ')}`);

    const seen = new Map();
    await parallelMap(years, FETCH_CONCURRENCY, async (year) => {
      const events = await fetchEspnYear(path, year, sport);
      if (log && events.length) log(`    ${year}: ${events.length} events`);
      events.forEach(e => { if (e?.id && !seen.has(e.id)) seen.set(e.id, e); });
    });

    const startMs = start.getTime();
    const endMs = end.getTime();
    return Array.from(seen.values()).filter(e => {
      const t = new Date(e.date).getTime();
      return isFinite(t) && t >= startMs && t <= endMs;
    });
  }

  async function fetchEspnYear(path, year, sport) {
    const group = sport === 'NCAAF' ? 80
                : sport === 'NCAAB' ? 50
                : null;

    const dateParam = sport === 'MLS'
      ? `${year}0101-${year}1231`
      : String(year);

    const url = `https://site.api.espn.com/apis/site/v2/sports/${path}/scoreboard` +
                `?dates=${dateParam}${group ? '&groups=' + group : ''}&limit=1000`;

    try {
      const res = await fetch(url, { cache: 'no-store' });
      if (!res.ok) return [];
      const data = await res.json();
      return data.events || [];
    } catch (e) {
      logEdgeError('ats.fetchEspnYear.' + path + '.' + year, e);
      return [];
    }
  }

  // ============================================================
  // ── WRITE ──
  //
  // A single failed fetch used to drop an entire chunk of rows. Now
  // each chunk retries with backoff. A 409 gets one more attempt with
  // merge-duplicates set explicitly, in case the first request's
  // Prefer header was lost in transit.
  // ============================================================

  async function upsert(endpoint, rows, key, log, tableName) {
    if (!rows.length) return;
    const chunkSize = 400;

    for (let i = 0; i < rows.length; i += chunkSize) {
      const chunk = rows.slice(i, i + chunkSize);
      let ok = false;

      for (let attempt = 0; attempt < 3 && !ok; attempt++) {
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
          if (res.ok) { ok = true; break; }

          if (res.status === 409) {
            const retry = await fetch(endpoint, {
              method: 'POST',
              headers: {
                apikey: key, Authorization: `Bearer ${key}`,
                'Content-Type': 'application/json',
                Prefer: 'resolution=merge-duplicates,return=minimal',
              },
              body: JSON.stringify(chunk),
            });
            if (retry.ok) { ok = true; break; }
          }

          const txt = await res.text().catch(() => '');
          log(`  ${tableName} chunk ${i} attempt ${attempt + 1}: HTTP ${res.status} ${txt.slice(0, 140)}`);
        } catch (e) {
          log(`  ${tableName} chunk ${i} attempt ${attempt + 1}: ${e.message}`);
        }

        if (!ok) await new Promise(r => setTimeout(r, 500 * (attempt + 1)));
      }

      if (!ok) log(`  ${tableName} chunk ${i}: giving up after 3 attempts`);
    }
  }

  // ============================================================
  // ── SEASON LABEL ──
  // ============================================================

  function seasonLabel(sport, date) {
    const m = date.getMonth() + 1;
    const y = date.getFullYear();
    const cross = (startMonth) => (m >= startMonth
      ? `${y}-${String(y + 1).slice(2)}`
      : `${y - 1}-${String(y).slice(2)}`);

    switch (sport) {
      case 'NBA':
      case 'NHL':   return cross(9);
      case 'NCAAB': return cross(9);
      case 'NFL':   return cross(3);
      case 'NCAAF': return cross(3);
      default:      return String(y);
    }
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

  function numOrNull(v) {
    if (v === null || v === undefined || v === '') return null;
    if (typeof v === 'string' && /^(even|pk|pick)$/i.test(v.trim())) return 0;
    const n = parseFloat(v);
    return isFinite(n) ? n : null;
  }

  function mean(arr) {
    if (!arr.length) return 0;
    return round(arr.reduce((a, b) => a + b, 0) / arr.length, 2);
  }

  function makeLogger(onProgress) {
    return (msg) => { if (typeof onProgress === 'function') onProgress(msg); };
  }

  function round(v, d) { const f = Math.pow(10, d); return Math.round(v * f) / f; }

})();

if (typeof window !== 'undefined') window.EDGE_ATS = EDGE_ATS;