// ============================================================
// EDGE — TRENDS ENGINE v1.1
//
// A trend is a repeatable situation with a track record — not a
// pattern in your own pick history.
//
// v1.1 — situationContext now accepts a shared context and falls
// back to it when the game object doesn't carry enriched fields.
// Without this, seven of the twenty situations (rest, prior
// result, prior margin, game-of-season, season progress) could
// never fire on today's board — the historical table held them,
// but nothing matched a current game against them.
// writeTrends now clears previous rows on a 409 unique-constraint
// clash instead of failing the whole batch.
// fetchRange tries multiple ESPN URL shapes.
// ============================================================

const EDGE_TRENDS = (() => {

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

  const QB_SPORTS = new Set(['NFL', 'NCAAF']);

  const HISTORY_YEARS = { NFL: 6, NCAAF: 6, NBA: 4, NHL: 4, MLB: 4, NCAAB: 4, MLS: 5 };
  const CHUNK_DAYS = { NFL: 30, NCAAF: 21, MLS: 30, MLB: 14, NBA: 14, NHL: 14, NCAAB: 5 };

  const MIN_SAMPLE = 5;
  const MIN_HIT_RATE = 0.70;
  const MIN_STREAK = 4;
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
    buildAll,
    buildSport,
    trendsForGame,
    trendsForSlate,
    getTeamTrends,
    SITUATIONS,
    MIN_SAMPLE,
    MIN_HIT_RATE,
    MIN_STREAK,
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

    const events = await fetchRange(sport, start, end);
    log(`  ${events.length} completed games`);
    if (!events.length) return { games: 0, trends_written: 0, qualifying: 0 };

    const odds = await loadClosingLines(sport, url, key);
    log(`  ${Object.keys(odds).length} closing lines available`);

    const logs = buildTeamLogs(sport, events, odds);
    log(`  ${Object.keys(logs).length} teams`);

    // Report QB coverage so a silent gap is visible rather than
    // producing zero QB-anchored trends with no explanation.
    if (QB_SPORTS.has(sport)) {
      let qbGames = 0, totalGames = 0;
      Object.values(logs).forEach(games => {
        games.forEach(g => { totalGames++; if (g.qb) qbGames++; });
      });
      log(`  ${qbGames}/${totalGames} team-game entries with an identified starting QB`);
      if (!qbGames) {
        log(`  no QB-anchored trends will be built — ESPN did not include leaders`);
      }
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

        g.restDays = prev ? Math.round((g.date - prev.date) / 86400000) : null;
        g.prevResult = prev ? (prev.margin > 0 ? 'W' : prev.margin < 0 ? 'L' : 'T') : null;
        g.prevMargin = prev ? prev.margin : null;

        if (!perSeason[g.season]) perSeason[g.season] = { all: 0, home: 0 };
        perSeason[g.season].all++;
        g.gameOfSeason = perSeason[g.season].all;
        if (g.isHome) {
          perSeason[g.season].home++;
          g.homeGameOfSeason = perSeason[g.season].home;
        }

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

  function makeRow(sport, team, sit, meta, market, rec, hits, isHit) {
    const rate = rec.total > 0 ? rec.wins / rec.total : 0;
    const streaks = streakOf(hits, isHit);
    const seasons = Array.from(new Set(hits.map(g => g.season))).sort();

    const qualified = (rec.total >= MIN_SAMPLE && rate >= MIN_HIT_RATE)
                   || streaks.current >= MIN_STREAK;

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
  // context (optional) may carry these team-keyed maps, built by the
  // caller from the same historical pull that produced the trends:
  //
  //   restByTeam            { "NFL:Kansas City Chiefs": 7 }
  //   prevResultByTeam      { "NFL:Kansas City Chiefs": "W" }
  //   prevMarginByTeam      { "NFL:Kansas City Chiefs": 10 }
  //   gameOfSeasonByTeam    { "NFL:Kansas City Chiefs": 4 }
  //   homeGameOfSeasonByTeam{ "NFL:Kansas City Chiefs": 2 }
  //   lostLastMeetingByTeam { "NFL:Kansas City Chiefs": true }
  //   playedBeforeByTeam    { "NFL:Kansas City Chiefs": true }
  //   seasonProgressByGame  { "<gameId>": 0.8 }
  //
  // game fields (home_rest_days, home_prev_result, etc.) take
  // precedence when set, so an orchestrator that has already
  // enriched the board does not need to build the maps.
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

    // Prefer values set directly on the game. Fall back to the shared
    // context when the caller provides one.
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
  // ============================================================

  async function fetchRange(sport, start, end) {
    const path = ESPN_MAP[sport];
    const days = CHUNK_DAYS[sport] || 21;
    const windows = [];
    let cur = new Date(start);
    while (cur < end) {
      const to = new Date(Math.min(cur.getTime() + days * 86400000, end.getTime()));
      windows.push([new Date(cur), to]);
      cur = new Date(to.getTime() + 86400000);
    }

    const seen = new Map();
    await parallelMap(windows, FETCH_CONCURRENCY, async ([a, b]) => {
      const events = await fetchWindow(path, a, b);
      events.forEach(e => {
        if (!e?.id || seen.has(e.id)) return;
        const comp = e.competitions?.[0];
        if (!comp) return;
        if ((e.season?.type ?? comp.season?.type) === 1) return;
        if (comp.status?.type?.completed !== true) return;
        seen.set(e.id, e);
      });
    });

    return Array.from(seen.values()).sort((a, b) => new Date(a.date) - new Date(b.date));
  }

  // ESPN's accepted query shapes drift without notice. Try the known
  // ones in order and return the first that produces events.
  async function fetchWindow(path, a, b) {
    const fmt = d => `${d.getFullYear()}${String(d.getMonth() + 1).padStart(2, '0')}${String(d.getDate()).padStart(2, '0')}`;
    const base = `https://site.api.espn.com/apis/site/v2/sports/${path}/scoreboard`;
    const group = /college-football/.test(path) ? 80
                : /college-basketball/.test(path) ? 50
                : null;

    const urls = [];
    if (group) urls.push(`${base}?dates=${fmt(a)}-${fmt(b)}&groups=${group}&limit=900`);
    urls.push(`${base}?dates=${fmt(a)}-${fmt(b)}&limit=1000`);
    urls.push(`${base}?limit=1000&dates=${fmt(a)}-${fmt(b)}`);
    urls.push(`${base}?dates=${fmt(a)}-${fmt(b)}`);

    for (const url of urls) {
      try {
        const res = await fetch(url, { cache: 'no-store' });
        if (!res.ok) continue;
        const data = await res.json();
        if (data.events && data.events.length) return data.events;
      } catch {}
    }
    return [];
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
    } catch {}
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

    // A unique constraint is not a schema rejection. Reaching 409
    // proves the payload is valid — the previous run's rows are the
    // only thing in the way. Clearing them first is safe precisely
    // because the insert got that far.
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
    } catch {}

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
  // ── UTILITIES ──
  // ============================================================

  function seasonOf(sport, date) {
    const m = date.getMonth() + 1;
    const y = date.getFullYear();
    const cross = (startMonth) => (m >= startMonth ? y : y - 1);
    switch (sport) {
      case 'NBA':
      case 'NHL':
      case 'NCAAB': return cross(9);
      case 'NFL':
      case 'NCAAF': return cross(3);
      default:      return y;
    }
  }

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

  function round(v, d) { const f = Math.pow(10, d); return Math.round(v * f) / f; }

})();

if (typeof window !== 'undefined') window.EDGE_TRENDS = EDGE_TRENDS;