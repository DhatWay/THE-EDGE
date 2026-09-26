// ============================================================
// EDGE — TRENDS ENGINE v2.0
//
// A trend is a repeatable situation with a track record — not
// a pattern in your own pick history.
//
// v2.0 changes:
//
//   · Fetch uses power-engine's chunked fetch when available.
//     The v1.x code requested a whole year with limit=1000.
//     MLB is 2,430 games a year, the NBA and NHL about 1,300
//     each, D-I basketball several thousand. Trends were built
//     from less than half the schedule in those sports. The
//     fallback below the power-engine path chunks by month so
//     the limit is under even a full month of NCAAB.
//
//   · Rest and previous result no longer cross season
//     boundaries. The old code looked at the prior game in the
//     list regardless of season, so a season opener counted as
//     "off a bye" against the summer break and "after a loss"
//     against last season's final game. Both reset when the
//     season key changes.
//
//   · A hot streak no longer qualifies a losing record. The
//     old rule was `rate >= MIN_HIT_RATE OR streak >= MIN_STREAK`.
//     A team sitting at 6-20 with a four-game cover streak
//     qualified. A streak now needs the sample to be there
//     first, and the rate to at least be above a floor.
//
//   · Season labels match ats-tracker v3.0 and the rest of the
//     pipeline. Cross-year sports carry the year the season
//     started. Single-year sports carry the calendar year.
//
//   · trendsForGame builds context itself when the caller has
//     none. parlay.js passed no context, so rest, opener,
//     revenge and late-season situations never applied to
//     today's games. The engine can now build a minimal context
//     from the game object and the rest-by-team index if one is
//     passed in, without requiring the caller to know the shape.
// ============================================================

const EDGE_TRENDS = (() => {

  const BUILD = 'trends-20260925-01';

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
    NFL:   'football/nfl',
    NBA:   'basketball/nba',
    MLB:   'baseball/mlb',
    NHL:   'hockey/nhl',
    NCAAF: 'football/college-football',
    NCAAB: 'basketball/mens-college-basketball',
    MLS:   'soccer/usa.1',
  };

  const QB_SPORTS = new Set(['NFL', 'NCAAF']);

  const HISTORY_YEARS = { NFL: 6, NCAAF: 6, NBA: 4, NHL: 4, MLB: 4, NCAAB: 4, MLS: 5 };

  const MIN_SAMPLE = 5;
  const MIN_HIT_RATE = 0.70;
  const MIN_STREAK = 4;

  // A hot streak qualifies only when the underlying sample is
  // non-trivial AND the hit rate is at least at this floor.
  // Without the floor, a 6-20 record qualifies on a four-game
  // run.
  const STREAK_RATE_FLOOR = 0.50;

  const FETCH_CONCURRENCY = 4;

  const LONG_REST = { NFL: 10, NCAAF: 10, NBA: 3, NHL: 3, MLB: 2, NCAAB: 5, MLS: 7 };
  const SHORT_REST = { NFL: 5, NCAAF: 5, NBA: 1, NHL: 1, MLB: 1, NCAAB: 2, MLS: 3 };
  const BLOWOUT = { NFL: 14, NCAAF: 21, NBA: 15, NCAAB: 15, NHL: 3, MLB: 5, MLS: 2 };

  const SITUATIONS = [
    { id: 'season_opener',    label: 'in season openers',
      test: g => g.gameOfSeason === 1 },
    { id: 'home_opener',      label: 'in home openers',
      test: g => g.isHome && g.homeGameOfSeason === 1 },
    { id: 'first_home_start', label: 'in his first home game of the season',
      test: g => g.isHome && g.homeGameOfSeason === 1, qbOnly: true },
    { id: 'off_bye',          label: 'off extended rest',
      test: g => g.restDays != null && g.restDays >= (LONG_REST[g.sport] ?? 7) },
    { id: 'short_rest',       label: 'on short rest',
      test: g => g.restDays != null && g.restDays <= (SHORT_REST[g.sport] ?? 2) },
    { id: 'off_loss',         label: 'after a loss',
      test: g => g.prevResult === 'L' },
    { id: 'off_win',          label: 'after a win',
      test: g => g.prevResult === 'W' },
    { id: 'off_blowout_loss', label: 'after a blowout loss',
      test: g => g.prevMargin != null && g.prevMargin <= -(BLOWOUT[g.sport] ?? 14) },
    { id: 'off_big_win',      label: 'after a blowout win',
      test: g => g.prevMargin != null && g.prevMargin >= (BLOWOUT[g.sport] ?? 14) },
    { id: 'home_favorite',    label: 'as a home favourite',
      test: g => g.isHome && g.spread != null && g.spread < 0 },
    { id: 'home_underdog',    label: 'as a home underdog',
      test: g => g.isHome && g.spread != null && g.spread > 0 },
    { id: 'road_favorite',    label: 'as a road favourite',
      test: g => !g.isHome && g.spread != null && g.spread < 0 },
    { id: 'road_underdog',    label: 'as a road underdog',
      test: g => !g.isHome && g.spread != null && g.spread > 0 },
    { id: 'big_favorite',     label: 'laying a touchdown or more',
      test: g => g.spread != null && g.spread <= -7 && (g.sport === 'NFL' || g.sport === 'NCAAF') },
    { id: 'primetime',        label: 'in primetime',
      test: g => g.hour != null && g.hour >= 20 },
    { id: 'afternoon',        label: 'in afternoon games',
      test: g => g.hour != null && g.hour < 16 },
    { id: 'revenge',          label: 'in revenge spots',
      test: g => g.lostLastMeeting === true },
    { id: 'rematch',          label: 'in rematches',
      test: g => g.playedBefore === true },
    { id: 'late_season',      label: 'late in the season',
      test: g => g.seasonProgress != null && g.seasonProgress >= 0.7 },
    { id: 'home',             label: 'at home',
      test: g => g.isHome },
    { id: 'road',             label: 'on the road',
      test: g => !g.isHome },
  ];

  return {
    BUILD,
    buildAll,
    buildSport,
    trendsForGame,
    trendsForSlate,
    getTeamTrends,
    SITUATIONS,
    MIN_SAMPLE,
    MIN_HIT_RATE,
    MIN_STREAK,
    STREAK_RATE_FLOOR,
  };

  // ============================================================
  // ── BUILD ──
  // ============================================================

  async function buildAll(options = {}) {
    const { sports = Object.keys(ESPN_MAP), onProgress = null } = options;
    const log = mk(onProgress);
    const summary = { sports: {}, totals: { trends: 0, qualifying: 0, games: 0 } };

    for (const sport of sports) {
      log(`── ${sport} ──`);
      try {
        const r = await buildSport(sport, { onProgress });
        summary.sports[sport] = r;
        summary.totals.trends += r.trends_written || 0;
        summary.totals.qualifying += r.qualifying || 0;
        summary.totals.games += r.games || 0;
      } catch (e) {
        log(`${sport} failed: ${e.message}`);
        summary.sports[sport] = { error: e.message };
      }
    }
    return summary;
  }

  async function buildSport(sport, options = {}) {
    const log = mk(options.onProgress);
    const url = SUPABASE_URL();
    const key = SUPABASE_KEY();
    if (!url || !key) throw new Error('Supabase not connected');
    if (!ESPN_MAP[sport]) throw new Error(`Unknown sport: ${sport}`);

    const years = HISTORY_YEARS[sport] || 4;
    const end = new Date();
    const start = new Date(end.getTime() - years * 365 * 86400000);
    log(`  results ${start.toISOString().slice(0, 10)} → now`);

    const events = await fetchRange(sport, start, end, log);
    log(`  ${events.length} completed games`);
    if (!events.length) return { games: 0, trends_written: 0, qualifying: 0 };

    const odds = await loadClosingLines(sport, url, key);
    log(`  ${Object.keys(odds).length} closing lines available`);

    const logs = buildTeamLogs(sport, events, odds);
    log(`  ${Object.keys(logs).length} teams`);

    if (QB_SPORTS.has(sport)) {
      let qbGames = 0, totalGames = 0;
      Object.values(logs).forEach(games => {
        games.forEach(g => { totalGames++; if (g.qb) qbGames++; });
      });
      log(`  ${qbGames}/${totalGames} team-game entries with an identified starting QB`);
    }

    const rows = [];
    Object.entries(logs).forEach(([team, games]) => {
      rows.push(...evaluateTeam(sport, team, games));
    });

    const qualifying = rows.filter(r => r.qualified).length;
    log(`  ${rows.length} trends · ${qualifying} qualifying`);

    const written = await writeTrends(url, key, sport, rows, log);
    return { games: events.length, trends_written: written, qualifying };
  }

  // ============================================================
  // ── GAME LOG ──
  // ============================================================

  function buildTeamLogs(sport, events, odds) {
    const logs = {};

    events.forEach(e => {
      const comp = e.competitions?.[0];
      if (!comp) return;
      const home = comp.competitors?.find(c => c.homeAway === 'home');
      const away = comp.competitors?.find(c => c.homeAway === 'away');
      if (!home || !away) return;

      const homeName = home.team?.displayName;
      const awayName = away.team?.displayName;
      if (!homeName || !awayName) return;

      const hs = parseInt(home.score, 10);
      const as = parseInt(away.score, 10);
      if (!isFinite(hs) || !isFinite(as)) return;

      const when = new Date(e.date);
      if (isNaN(when)) return;

      const line = odds[String(e.id)];
      const homeSpread = line?.spread ?? null;
      const total = line?.total ?? null;

      push(logs, homeName, {
        sport, date: when, gameId: String(e.id),
        isHome: true, opponent: awayName,
        pf: hs, pa: as, margin: hs - as,
        spread: homeSpread,
        coverMargin: homeSpread != null ? (hs - as) + homeSpread : null,
        total, combined: hs + as,
        hour: when.getHours(),
        season: seasonOf(sport, when),
        qb: QB_SPORTS.has(sport) ? startingQb(home) : null,
      });

      push(logs, awayName, {
        sport, date: when, gameId: String(e.id),
        isHome: false, opponent: homeName,
        pf: as, pa: hs, margin: as - hs,
        spread: homeSpread != null ? -homeSpread : null,
        coverMargin: homeSpread != null ? (as - hs) - homeSpread : null,
        total, combined: hs + as,
        hour: when.getHours(),
        season: seasonOf(sport, when),
        qb: QB_SPORTS.has(sport) ? startingQb(away) : null,
      });
    });

    Object.values(logs).forEach(games => {
      games.sort((a, b) => a.date - b.date);

      const perSeason = {};
      const metBefore = {};

      games.forEach((g, i) => {
        const prev = i > 0 ? games[i - 1] : null;

        // Rest and prior result only carry within a season.
        // Across a season boundary, the summer break is not
        // rest, and last season's final game is not "the
        // previous game". Without this check, every season
        // opener read as off-a-bye and after-a-loss.
        const sameSeason = prev && prev.season === g.season;

        g.restDays = sameSeason ? Math.round((g.date - prev.date) / 86400000) : null;
        g.prevResult = sameSeason
          ? (prev.margin > 0 ? 'W' : prev.margin < 0 ? 'L' : 'T')
          : null;
        g.prevMargin = sameSeason ? prev.margin : null;

        if (!perSeason[g.season]) perSeason[g.season] = { all: 0, home: 0 };
        perSeason[g.season].all++;
        g.gameOfSeason = perSeason[g.season].all;
        if (g.isHome) {
          perSeason[g.season].home++;
          g.homeGameOfSeason = perSeason[g.season].home;
        }

        // Head-to-head history persists across seasons. A
        // rivalry spans years; only the rest/result chain
        // resets.
        const key = g.opponent;
        g.playedBefore = !!metBefore[key];
        g.lostLastMeeting = metBefore[key] ? metBefore[key].margin < 0 : false;
        metBefore[key] = g;

        g.result = g.margin > 0 ? 'W' : g.margin < 0 ? 'L' : 'T';
        g.atsResult = g.coverMargin == null ? null
                    : Math.abs(g.coverMargin) < 0.01 ? 'P'
                    : g.coverMargin > 0 ? 'W' : 'L';
        g.ouResult = (g.total == null) ? null
                   : g.combined > g.total ? 'O'
                   : g.combined < g.total ? 'U' : 'P';
      });

      const counts = {};
      games.forEach(g => { counts[g.season] = (counts[g.season] || 0) + 1; });
      games.forEach(g => { g.seasonProgress = g.gameOfSeason / (counts[g.season] || 1); });
    });

    return logs;
  }

  function startingQb(competitor) {
    const leaders = competitor.leaders || [];
    const passing = leaders.find(l =>
      /passingyards|passingleader|passing/i.test(l.name || l.shortDisplayName || ''));
    const athlete = passing?.leaders?.[0]?.athlete;
    return athlete?.displayName || athlete?.fullName || null;
  }

  function push(logs, team, row) {
    if (!logs[team]) logs[team] = [];
    logs[team].push(row);
  }

  // ============================================================
  // ── EVALUATION ──
  // ============================================================

  function evaluateTeam(sport, team, games) {
    const rows = [];

    SITUATIONS.forEach(sit => {
      if (sit.qbOnly) return;
      const hits = games.filter(g => safeTest(sit, g));
      if (hits.length < MIN_SAMPLE) return;
      rows.push(...recordsFor(sport, team, sit, hits, { scope: 'team' }));
    });

    const byOpp = {};
    games.forEach(g => { (byOpp[g.opponent] = byOpp[g.opponent] || []).push(g); });
    Object.entries(byOpp).forEach(([opp, hits]) => {
      if (hits.length < MIN_SAMPLE) return;
      rows.push(...recordsFor(sport, team,
        { id: 'vs_opponent', label: `against ${opp}` },
        hits, { scope: 'rivalry', opponent: opp }));
    });

    if (QB_SPORTS.has(sport)) {
      const byQb = {};
      games.forEach(g => { if (g.qb) (byQb[g.qb] = byQb[g.qb] || []).push(g); });

      Object.entries(byQb).forEach(([qb, qbGames]) => {
        if (qbGames.length < MIN_SAMPLE) return;

        SITUATIONS.forEach(sit => {
          const hits = qbGames.filter(g => safeTest(sit, g));
          if (hits.length < Math.max(3, MIN_SAMPLE - 2)) return;
          rows.push(...recordsFor(sport, team, sit, hits, { scope: 'player', player: qb }));
        });
      });
    }

    return rows;
  }

  function recordsFor(sport, team, sit, hits, meta) {
    const out = [];

    const su = tally(hits, g => g.result, 'W', 'L');
    if (su.total >= MIN_SAMPLE) {
      out.push(makeRow(sport, team, sit, meta, 'SU', su, hits,
        g => g.result === 'W'));
    }

    const ats = tally(hits.filter(g => g.atsResult), g => g.atsResult, 'W', 'L');
    if (ats.total >= Math.max(3, MIN_SAMPLE - 2)) {
      out.push(makeRow(sport, team, sit, meta, 'ATS', ats, hits.filter(g => g.atsResult),
        g => g.atsResult === 'W'));
    }

    const ou = tally(hits.filter(g => g.ouResult), g => g.ouResult, 'O', 'U');
    if (ou.total >= Math.max(3, MIN_SAMPLE - 2)) {
      out.push(makeRow(sport, team, sit, meta, 'OU', ou, hits.filter(g => g.ouResult),
        g => g.ouResult === 'O'));
    }

    return out;
  }

  // A trend qualifies on a strong hit rate, or on a hot streak
  // — but a hot streak only counts if the sample is there and
  // the underlying rate is at least at the floor. The old rule
  // let a 6-20 record qualify on four straight covers.
  function makeRow(sport, team, sit, meta, market, rec, hits, isHit) {
    const rate = rec.total > 0 ? rec.wins / rec.total : 0;
    const streaks = streakOf(hits, isHit);
    const seasons = Array.from(new Set(hits.map(g => g.season))).sort();

    const qualifiedByRate = rec.total >= MIN_SAMPLE && rate >= MIN_HIT_RATE;
    const qualifiedByStreak =
      rec.total >= MIN_SAMPLE &&
      streaks.current >= MIN_STREAK &&
      rate >= STREAK_RATE_FLOOR;
    const qualified = qualifiedByRate || qualifiedByStreak;

    const subject = meta.scope === 'player' ? meta.player : team;
    const verb = market === 'SU' ? 'is' : market === 'ATS' ? 'is' : 'has gone';
    const tail = market === 'OU'
      ? `${rec.wins}-${rec.losses} to the over`
      : `${rec.wins}-${rec.losses}${rec.pushes ? '-' + rec.pushes : ''} ${market === 'ATS' ? 'ATS' : 'straight up'}`;

    return {
      sport,
      team_name: team,
      scope: meta.scope,
      player_name: meta.player || null,
      opponent: meta.opponent || null,
      situation_id: sit.id,
      situation_label: sit.label,
      market,
      wins: rec.wins,
      losses: rec.losses,
      pushes: rec.pushes,
      sample: rec.total,
      hit_rate: round(rate, 4),
      current_streak: streaks.current,
      longest_streak: streaks.longest,
      seasons_covered: seasons.length,
      first_season: seasons[0] || null,
      last_season: seasons[seasons.length - 1] || null,
      last_occurrence: hits.length ? hits[hits.length - 1].date.toISOString() : null,
      qualified,
      qualified_by: qualifiedByRate ? 'rate' : qualifiedByStreak ? 'streak' : 'none',
      headline: `${subject} ${verb} ${tail} ${sit.label}`,
      updated_at: new Date().toISOString(),
    };
  }

  function tally(games, get, winVal, lossVal) {
    let wins = 0, losses = 0, pushes = 0;
    games.forEach(g => {
      const v = get(g);
      if (v === winVal) wins++;
      else if (v === lossVal) losses++;
      else if (v) pushes++;
    });
    return { wins, losses, pushes, total: wins + losses };
  }

  function streakOf(games, isHit) {
    let current = 0, longest = 0, run = 0;
    games.forEach(g => {
      if (isHit(g)) { run++; longest = Math.max(longest, run); }
      else run = 0;
    });
    for (let i = games.length - 1; i >= 0; i--) {
      if (isHit(games[i])) current++;
      else break;
    }
    return { current, longest };
  }

  function safeTest(sit, g) {
    try { return !!sit.test(g); } catch { return false; }
  }

  // ============================================================
  // ── APPLY TO TODAY ──
  //
  // trendsForGame accepts a context object. When the caller has
  // none, the game object itself is used as the source of truth
  // for anything it carries — rest days, previous result,
  // previous margin, home game of season. parlay.js used to
  // pass nothing, so rest, opener, revenge and late-season
  // situations never matched today's games.
  // ============================================================

  async function trendsForGame(game, options = {}) {
    const { qualifiedOnly = true, context = null } = options;
    const sport = game._sport || game.sport;
    const home = game.home_team || game.home;
    const away = game.away_team || game.away;

    const [homeRows, awayRows] = await Promise.all([
      getTeamTrends(sport, home, qualifiedOnly),
      getTeamTrends(sport, away, qualifiedOnly),
    ]);

    const homeCtx = situationContext(game, true, context);
    const awayCtx = situationContext(game, false, context);

    const applies = (row, ctx, oppName) => {
      if (row.situation_id === 'vs_opponent') return row.opponent === oppName;
      const sit = SITUATIONS.find(s => s.id === row.situation_id);
      if (!sit) return false;
      return safeTest(sit, ctx);
    };

    return {
      home: {
        team: home,
        trends: homeRows.filter(r => applies(r, homeCtx, away)),
      },
      away: {
        team: away,
        trends: awayRows.filter(r => applies(r, awayCtx, home)),
      },
    };
  }

  async function trendsForSlate(games, options = {}) {
    const out = {};
    await parallelMap(games, 4, async g => {
      try { out[g.id] = await trendsForGame(g, options); } catch {}
    });
    return out;
  }

  function situationContext(game, isHome, ctx) {
    const sport = game._sport || game.sport;
    const home = game.home_team || game.home;
    const away = game.away_team || game.away;
    const team = isHome ? home : away;
    const teamKey = `${sport}:${team}`;
    const when = new Date(game.commence_time || game.time);

    const spread = isHome ? (game.spread ?? null)
                          : (game.spread != null ? -game.spread : null);

    // Read the game object first, then fall back to the passed
    // context. The game object is what parlay.js hands over and
    // it now carries the fields the rest situations look for.
    const restDays = isHome
      ? (game.home_rest_days ?? ctx?.restByTeam?.[teamKey] ?? null)
      : (game.away_rest_days ?? ctx?.restByTeam?.[teamKey] ?? null);

    const prevResult = isHome
      ? (game.home_prev_result ?? ctx?.prevResultByTeam?.[teamKey] ?? null)
      : (game.away_prev_result ?? ctx?.prevResultByTeam?.[teamKey] ?? null);

    const prevMargin = isHome
      ? (game.home_prev_margin ?? ctx?.prevMarginByTeam?.[teamKey] ?? null)
      : (game.away_prev_margin ?? ctx?.prevMarginByTeam?.[teamKey] ?? null);

    const gameOfSeason = isHome
      ? (game.home_game_of_season ?? ctx?.gameOfSeasonByTeam?.[teamKey] ?? null)
      : (game.away_game_of_season ?? ctx?.gameOfSeasonByTeam?.[teamKey] ?? null);

    const homeGameOfSeason = isHome
      ? (game.home_home_game_of_season ?? ctx?.homeGameOfSeasonByTeam?.[teamKey] ?? null)
      : null;

    const playedBefore = game.played_before
      ?? ctx?.playedBeforeByTeam?.[teamKey] ?? null;

    const lostLastMeeting = isHome
      ? (game.home_lost_last_meeting ?? ctx?.lostLastMeetingByTeam?.[teamKey] ?? null)
      : (game.away_lost_last_meeting ?? ctx?.lostLastMeetingByTeam?.[teamKey] ?? null);

    const seasonProgress = game.season_progress
      ?? ctx?.seasonProgressByGame?.[game.id] ?? null;

    return {
      sport,
      isHome,
      spread,
      hour: isNaN(when) ? null : when.getHours(),
      restDays,
      prevResult,
      prevMargin,
      gameOfSeason,
      homeGameOfSeason,
      seasonProgress,
      playedBefore,
      lostLastMeeting,
    };
  }

  async function getTeamTrends(sport, team, qualifiedOnly = true) {
    const url = SUPABASE_URL();
    const key = SUPABASE_KEY();
    if (!url || !team) return [];
    try {
      const q = `${url}/rest/v1/trends?sport=eq.${sport}` +
                `&team_name=eq.${encodeURIComponent(team)}` +
                (qualifiedOnly ? '&qualified=is.true' : '') +
                `&order=hit_rate.desc&limit=400`;
      const res = await fetch(q, { headers: { apikey: key, Authorization: `Bearer ${key}` } });
      return res.ok ? await res.json() : [];
    } catch { return []; }
  }

  // ============================================================
  // ── FETCH ──
  //
  // Prefers power-engine's chunked fetch. That function walks
  // the window in day-sized chunks and has a day-by-day
  // fallback, which is what sidesteps the 1,000-event cap on a
  // single ESPN year response. The fallback below the
  // power-engine path chunks by month, so even a heavy NCAAB
  // month lands under the cap.
  // ============================================================

  async function fetchRange(sport, start, end, log) {
    const path = ESPN_MAP[sport];
    if (!path) return [];

    if (window.EDGE_POWER && typeof window.EDGE_POWER.fetchGamesBetween === 'function') {
      try {
        const events = await window.EDGE_POWER.fetchGamesBetween(sport, start, end, { raw: true });
        if (log) log(`  fetched ${events.length} events via power-engine`);
        return filterRange(events, start, end);
      } catch (e) {
        logEdgeError('trends.fetchRange.powerEngine.' + sport, e);
      }
    }

    // Fallback: month-by-month. A single month of any sport is
    // under 1,000 events.
    const months = monthsBetween(start, end);
    if (log) log(`  fallback: fetching ${months.length} month${months.length === 1 ? '' : 's'}`);

    const seen = new Map();
    await parallelMap(months, FETCH_CONCURRENCY, async (m) => {
      const events = await fetchEspnRange(path, m.start, m.end, sport);
      if (log && events.length) log(`    ${fmtMonth(m.start)}: ${events.length} events`);
      events.forEach(e => { if (e?.id && !seen.has(e.id)) seen.set(e.id, e); });
    });

    return filterRange(Array.from(seen.values()), start, end);
  }

  function filterRange(events, start, end) {
    const startMs = start.getTime();
    const endMs = end.getTime();
    return events
      .filter(e => {
        const comp = e?.competitions?.[0];
        if (!comp) return false;
        if ((e.season?.type ?? comp.season?.type) === 1) return false;
        if (comp.status?.type?.completed !== true) return false;
        const t = new Date(e.date).getTime();
        return isFinite(t) && t >= startMs && t <= endMs;
      })
      .sort((a, b) => new Date(a.date) - new Date(b.date));
  }

  function monthsBetween(start, end) {
    const out = [];
    let cur = new Date(start.getFullYear(), start.getMonth(), 1);
    while (cur <= end) {
      const mStart = new Date(cur);
      const mEnd = new Date(cur.getFullYear(), cur.getMonth() + 1, 0);
      out.push({
        start: mStart < start ? start : mStart,
        end: mEnd > end ? end : mEnd,
      });
      cur = new Date(cur.getFullYear(), cur.getMonth() + 1, 1);
    }
    return out;
  }

  async function fetchEspnRange(path, start, end, sport) {
    const group = sport === 'NCAAF' ? 80
                : sport === 'NCAAB' ? 50
                : null;

    const s = fmtDate(start);
    const e = fmtDate(end);
    let url = `https://site.api.espn.com/apis/site/v2/sports/${path}/scoreboard?dates=${s}-${e}&limit=1000`;
    if (group) url += `&groups=${group}`;

    try {
      const res = await fetch(url, { cache: 'no-store' });
      if (res.headers.get('x-edge-offline') === '1') return [];
      if (!res.ok) return [];
      const data = await res.json();
      return data.events || [];
    } catch (err) {
      logEdgeError('trends.fetchEspnRange.' + path + '.' + s, err);
      return [];
    }
  }

  async function loadClosingLines(sport, url, key) {
    const out = {};
    try {
      const res = await fetch(
        `${url}/rest/v1/historical_odds?sport=eq.${sport}&select=game_id,spread,total&limit=50000`,
        { headers: { apikey: key, Authorization: `Bearer ${key}` } }
      );
      if (res.ok) {
        (await res.json()).forEach(r => {
          if (r.spread != null) out[r.game_id] = r;
        });
      }
    } catch (e) { logEdgeError('trends.loadClosingLines.' + sport, e); }
    return out;
  }

  // ============================================================
  // ── WRITE ──
  // ============================================================

  async function writeTrends(url, key, sport, rows, log) {
    if (!rows.length) return 0;

    const headers = {
      apikey: key, Authorization: `Bearer ${key}`,
      'Content-Type': 'application/json', Prefer: 'return=minimal',
    };

    const stamp = new Date().toISOString();
    rows.forEach(r => { r.updated_at = stamp; });

    const size = 400;
    let probe = await postRows(url, headers, rows.slice(0, size));

    if (!probe.ok && probe.status === 409) {
      log(`  trends: unique constraint — clearing previous run and retrying`);
      try {
        await fetch(`${url}/rest/v1/trends?sport=eq.${sport}`, {
          method: 'DELETE', headers: { apikey: key, Authorization: `Bearer ${key}` },
        });
      } catch {}
      probe = await postRows(url, headers, rows.slice(0, size));
    }

    if (!probe.ok) {
      log(`  trends: insert rejected HTTP ${probe.status} ${probe.body.slice(0, 160)}`);
      return 0;
    }

    let written = Math.min(size, rows.length);

    for (let i = size; i < rows.length; i += size) {
      let res = await postRows(url, headers, rows.slice(i, i + size));
      if (!res.ok && res.status === 409) {
        res = await postRows(url,
          { ...headers, Prefer: 'resolution=merge-duplicates,return=minimal' },
          rows.slice(i, i + size));
      }
      if (res.ok) written += Math.min(size, rows.length - i);
    }

    try {
      await fetch(`${url}/rest/v1/trends?sport=eq.${sport}&updated_at=neq.${encodeURIComponent(stamp)}`, {
        method: 'DELETE', headers: { apikey: key, Authorization: `Bearer ${key}` },
      });
    } catch (e) { logEdgeError('trends.writeTrends.cleanup', e); }

    return written;
  }

  async function postRows(url, headers, body) {
    try {
      const res = await fetch(`${url}/rest/v1/trends`, {
        method: 'POST', headers, body: JSON.stringify(body),
      });
      return { ok: res.ok, status: res.status, body: res.ok ? '' : await res.text().catch(() => '') };
    } catch (e) { return { ok: false, status: 0, body: e.message }; }
  }

  // ============================================================
  // ── SEASON LABEL ──
  //
  // Matches ats-tracker v3.0, power-engine v4.3, and the rest
  // of the pipeline. Cross-year sports carry the year the
  // season started. Single-year sports carry the calendar year.
  // ============================================================

  function seasonOf(sport, date) {
    const m = date.getMonth() + 1;
    const y = date.getFullYear();

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

  function fmtDate(d) {
    const y = d.getFullYear();
    const m = String(d.getMonth() + 1).padStart(2, '0');
    const day = String(d.getDate()).padStart(2, '0');
    return `${y}${m}${day}`;
  }

  function fmtMonth(d) {
    return d.toLocaleDateString('en-US', { month: 'short', year: 'numeric' });
  }

  function round(v, d) { const f = Math.pow(10, d); return Math.round(v * f) / f; }

})();

if (typeof window !== 'undefined') window.EDGE_TRENDS = EDGE_TRENDS;