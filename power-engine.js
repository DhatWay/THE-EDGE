// ============================================================
// EDGE — POWER RATINGS ENGINE v4.0
// Regular season only · chunked fetch (no silent truncation)
// Opponent-adjusted SRS · sequential Elo · draws handled
// ============================================================

const EDGE_POWER = (() => {

  // Build stamp. Printed by the diagnostic so there is never any doubt
  // about which copy of this file the browser is actually running.
  const BUILD = 'pe-20260916-0419';

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

  // ── SEASON WINDOWS (month/day) ──
  // Only sports whose window contains today get computed. The start date is
  // also the earliest date we pull games from, so last season never bleeds in.
  const SEASON_WINDOWS = {
    NFL:   { start: [9, 1],   end: [2, 15]  },
    NBA:   { start: [10, 15], end: [6, 30]  },
    MLB:   { start: [3, 20],  end: [11, 5]  },
    NHL:   { start: [10, 1],  end: [6, 30]  },
    NCAAF: { start: [8, 15],  end: [1, 15]  },
    NCAAB: { start: [11, 1],  end: [4, 10]  },
    MLS:   { start: [2, 20],  end: [12, 15] },
  };

  // Days per ESPN request. ESPN caps a scoreboard response at ~1000 events,
  // so high-volume sports need narrower windows or games vanish silently.
  const CHUNK_DAYS = {
    NFL: 30, NCAAF: 21, MLS: 30,
    MLB: 14, NBA: 14, NHL: 14,
    NCAAB: 5,
  };

  const MAX_CHUNKS = 40; // hard stop so a bad date can't spin forever

  const SPORT_CONFIG = {
    NFL:   { avgPF: 22,  avgPA: 22,  pyExp: 2.37,  scale: 22,  k: 8,  movCap: 28, eloK: 20, eloHFA: 55  },
    NBA:   { avgPF: 112, avgPA: 112, pyExp: 13.91, scale: 18,  k: 15, movCap: 25, eloK: 20, eloHFA: 100 },
    MLB:   { avgPF: 4.5, avgPA: 4.5, pyExp: 1.83,  scale: 3,   k: 20, movCap: 8,  eloK: 6,  eloHFA: 25  },
    NHL:   { avgPF: 3.0, avgPA: 3.0, pyExp: 2.0,   scale: 2,   k: 15, movCap: 4,  eloK: 8,  eloHFA: 35  },
    NCAAF: { avgPF: 27,  avgPA: 27,  pyExp: 2.37,  scale: 32,  k: 6,  movCap: 35, eloK: 25, eloHFA: 65  },
    NCAAB: { avgPF: 72,  avgPA: 72,  pyExp: 10.0,  scale: 20,  k: 10, movCap: 22, eloK: 25, eloHFA: 100 },
    MLS:   { avgPF: 1.5, avgPA: 1.5, pyExp: 2.0,   scale: 1.2, k: 15, movCap: 3,  eloK: 20, eloHFA: 60  },
  };

  // Sports where a regulation draw is a real outcome.
  const DRAWS_POSSIBLE = new Set(['MLS', 'NFL', 'NCAAF']);

  const COACHING_WEIGHTS = {
    NFL:   { halftime: 1.5, close: 0.7, maxAdj: 3.5 },
    NBA:   { halftime: 1.0, close: 0.5, maxAdj: 2.0 },
    MLB:   { halftime: 0.0, close: 0.4, maxAdj: 1.5 },
    NHL:   { halftime: 0.5, close: 0.5, maxAdj: 1.5 },
    DEFAULT: { halftime: 0.8, close: 0.5, maxAdj: 2.5 },
  };

  // Margin that counts as a "close game" for the coaching rating.
  const CLOSE_MARGIN = { NFL: 7, NCAAF: 7, NBA: 5, NCAAB: 5, MLB: 1, NHL: 1, MLS: 1, DEFAULT: 5 };

  const MAX_LOOKBACK_DAYS = 400;

  // Which ESPN query shape works, remembered for the run. Declared up
  // here with the other constants: this module returns its exports
  // near the top, so anything declared below that return is in the
  // temporal dead zone and throws the first time it is touched.
  const _espnShape = { chosen: null, dayFallback: false };

  // Measured constants from the backfill, loaded once per session.
  // Until a backfill has run this stays empty and the compiled
  // defaults apply — which is why a projection is only as honest as
  // the calibration behind it.
  const _calibration = { loaded: false, bySport: {} };

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
    BUILD,
    loadCalibrationOnce,
    getCalibration,
    fetchGamesBetween,
    parseEvents,
    isSportInSeason,
    seasonStart,
    loadCarryover,
    saveCarryover,
    SPORT_CONFIG,
    ESPN_MAP,
    SEASON_WINDOWS,
  };

  // ============================================================
  // ── SEASON HELPERS ──
  // ============================================================

  function isSportInSeason(sport, date = new Date()) {
    const w = SEASON_WINDOWS[sport];
    if (!w) return true;
    const now = (date.getMonth() + 1) * 100 + date.getDate();
    const start = w.start[0] * 100 + w.start[1];
    const end = w.end[0] * 100 + w.end[1];
    if (start <= end) return now >= start && now <= end;
    return now >= start || now <= end;
  }

  // The most recent occurrence of this sport's season start, at or before now.
  function seasonStart(sport, now = new Date()) {
    const w = SEASON_WINDOWS[sport];
    if (!w) return new Date(now.getTime() - MAX_LOOKBACK_DAYS * 86400000);

    const [m, d] = w.start;
    let candidate = new Date(now.getFullYear(), m - 1, d);
    if (candidate > now) candidate = new Date(now.getFullYear() - 1, m - 1, d);

    const floor = new Date(now.getTime() - MAX_LOOKBACK_DAYS * 86400000);
    return candidate < floor ? floor : candidate;
  }

  // ============================================================
  // ── MAIN ──
  // ============================================================

  // scopeTeams: when supplied, only these teams are written to the
  // database. The ratings are still computed across the whole league
  // because SRS and Elo are opponent-adjusted — a rating built from a
  // subset of the schedule is not a rating. The scope applies at the
  // persist step, so the table holds only the teams in play.
  async function computeAllTeamRatings(options = {}) {
    const { scopeTeams = null, onProgress = null } = options;
    const emit = (m) => { if (typeof onProgress === 'function') onProgress(m); };

    const results = {
      teams: {}, coaching: {}, errors: [], counts: {},
      skipped: [], games_used: {}, window: {},
      scoped: !!scopeTeams,
    };

    const scope = scopeTeams
      ? new Set(Array.from(scopeTeams).map(t => String(t).trim()))
      : null;

    const now = new Date();

    for (const [sport, path] of Object.entries(ESPN_MAP)) {
      if (!isSportInSeason(sport, now)) {
        results.skipped.push(sport);
        results.counts[sport] = 0;
        continue;
      }

      const start = seasonStart(sport, now);
      results.window[sport] = { from: fmtDate(start), to: fmtDate(now) };
      emit(`${sport}: fetching ${fmtDate(start)} → ${fmtDate(now)}`);

      let teamCount = 0;
      try {
        const events = await fetchSeasonEvents(sport, path, start, now);
        results.games_used[sport] = events.length;
        if (!events.length) {
          results.counts[sport] = 0;
          const msg = `no completed games returned for ${fmtDate(start)}–${fmtDate(now)}`;
          results.errors.push({ sport, error: msg });
          emit(`${sport}: ${msg}`);
          continue;
        }
        emit(`${sport}: ${events.length} completed games`);

        const { teamMap, chronological } = buildTeamStates(sport, events);
        if (!teamMap.size) { results.counts[sport] = 0; continue; }

        // Glicko-2, Massey and Colley replace the in-file SRS and Elo.
        // The old Elo reset every team to 1500 on each rebuild and the
        // old "SRS" was raw average margin with no opponent adjustment.
        let glickoState = {}, masseyMap = {}, colleyMap = {}, blended = {}, adMap = {};
        const core = window.EDGE_RATING;

        if (core) {
          const seed = await loadCarryover(sport);
          glickoState = core.rateGlicko(sport, chronological, { seed });
          masseyMap = core.massey(sport, chronological);
          colleyMap = core.colley(chronological);
          blended = core.blend(sport, glickoState, masseyMap, colleyMap);
          adMap = core.attackDefense(sport, chronological);
          emit(`${sport}: glicko ${Object.keys(glickoState).length} · massey ${Object.keys(masseyMap).length}` +
               (seed ? ` · carried ${Object.keys(seed).length} from last season` : ' · no carryover on file'));
          results.attack_defense = results.attack_defense || {};
          results.attack_defense[sport] = adMap;
        } else {
          emit(`${sport}: rating-core.js not loaded — falling back to in-file SRS/Elo`);
        }

        const srsMap = core ? {} : computeSRS(sport, teamMap);
        const eloMap = core ? {} : computeElo(sport, chronological);

        // Conference all-star sides appear in the schedule and are not
        // teams. They show up with a handful of games and skew a league.
        const gameCounts = Array.from(teamMap.values()).map(s => s.games).sort((a, b) => a - b);
        const median = gameCounts[Math.floor(gameCounts.length / 2)] || 1;

        for (const [teamName, state] of teamMap) {
          if (state.games < 1) continue;
          if (isAllStarSide(teamName, state.games, median)) {
            emit(`${sport}: excluding ${teamName} (${state.games} games — all-star side)`);
            continue;
          }
          const rating = buildRating(sport, teamName, state, {
            srs: srsMap[teamName],
            elo: eloMap[teamName],
            glicko: glickoState[teamName],
            massey: masseyMap[teamName],
            colley: colleyMap[teamName],
            blended: blended[teamName],
            attackDefense: adMap[teamName],
          });
          // Scope filter is applied here, after the league-wide SRS and
          // Elo passes have already used every team.
          if (scope && !scope.has(teamName)) continue;

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
      if (teamCount === 0) {
        const msg = `${results.games_used[sport] || 0} games fetched but no team met the rating threshold`;
        results.errors.push({ sport, error: msg });
        emit(`${sport}: ${msg}`);
      } else {
        emit(`${sport}: ${teamCount} teams rated`);
      }
    }

    results.persist = await persistRatings(results, emit);
    return results;
  }

  // ============================================================
  // ── FETCH ──
  // Chunked so ESPN's ~1000-event response cap never truncates a
  // season, and filtered to completed regular/post season games so
  // preseason results never reach the ratings.
  // ============================================================

  async function fetchSeasonEvents(sport, path, start, end) {
    const chunkDays = CHUNK_DAYS[sport] || 21;
    const windows = [];

    let cursor = new Date(start);
    let guard = 0;
    while (cursor < end && guard < MAX_CHUNKS) {
      const chunkEnd = new Date(Math.min(cursor.getTime() + chunkDays * 86400000, end.getTime()));
      windows.push([new Date(cursor), chunkEnd]);
      cursor = new Date(chunkEnd.getTime() + 86400000);
      guard++;
    }

    const batches = await Promise.all(
      windows.map(([a, b]) => fetchGamesInRange(path, fmtDate(a), fmtDate(b)))
    );

    const byId = new Map();
    batches.flat().forEach(e => {
      if (!e || !e.id) return;
      if (!isRatableEvent(e)) return;
      if (!byId.has(e.id)) byId.set(e.id, e);
    });

    return Array.from(byId.values())
      .sort((a, b) => new Date(a.date) - new Date(b.date));
  }

  // Preseason is season type 1. Only completed regular (2) and
  // postseason (3) games are allowed to move a rating.
  function isRatableEvent(e) {
    // Football and the US leagues use 1=pre, 2=regular, 3=post. Soccer
    // uses competition ids instead (MLS returns values like 13846), so
    // anything that is not explicitly preseason is allowed through.
    const type = e.season?.type ?? e.competitions?.[0]?.season?.type;
    if (type === 1) return false;

    const comp = e.competitions?.[0];
    if (!comp) return false;
    if (comp.status?.type?.completed !== true) return false;

    const competitors = comp.competitors || [];
    if (competitors.length < 2) return false;
    if (competitors.some(c => c.score === null || c.score === undefined || c.score === '')) return false;

    return true;
  }

  // ESPN's seasontype parameter is designed to pair with dates=YYYY,
  // not with an explicit date range. Sending both returns an empty
  // event list, which silently produced zero teams for every sport.
  // Preseason is filtered in isRatableEvent instead, from the season
  // type on the event itself, which is reliable.
  // ESPN is undocumented and its accepted query shapes drift without
  // notice. A single hard-coded URL returning 400 took the entire
  // ratings build down silently, so this tries the known-good shapes
  // in order and remembers which one worked for the rest of the run.
  async function fetchGamesInRange(path, start, end) {
    const base = `https://site.api.espn.com/apis/site/v2/sports/${path}/scoreboard`;
    const college = /college/.test(path);

    // ESPN truncates college slates unless a group is named, and the
    // group differs by sport: 80 is FBS football, 50 is Division I
    // basketball. Sending 50 to football returns almost nothing, which
    // is why a month of college football produced fifteen games.
    const group = collegeGroup(path);

    const shapes = [
      (s, e) => `${base}?dates=${s}-${e}&limit=1000`,
      (s, e) => `${base}?limit=1000&dates=${s}-${e}`,
      (s, e) => `${base}?dates=${s}-${e}`,
    ];
    if (group) shapes.unshift((s, e) => `${base}?dates=${s}-${e}&groups=${group}&limit=900`);

    // A shape that already worked this run is tried first.
    const order = _espnShape.chosen != null
      ? [shapes[_espnShape.chosen], ...shapes.filter((_, i) => i !== _espnShape.chosen)]
      : shapes;

    if (!_espnShape.dayFallback) {
      for (let i = 0; i < order.length; i++) {
        try {
          const res = await fetch(order[i](start, end), { cache: 'no-store' });
          if (!res.ok) continue;
          const data = await res.json();
          const events = data.events || [];
          if (events.length) {
            _espnShape.chosen = shapes.indexOf(order[i]);
            return events;
          }
        } catch {}
      }
    }

    // Every range shape failed. Ranges are not always honoured, but a
    // single date always is, so walk the window a day at a time.
    _espnShape.dayFallback = true;
    return fetchDayByDay(base, start, end, group);
  }

  // A real team plays a full schedule. An all-star side plays once.
  const ALL_STAR_NAMES = /\b(AFC|NFC|American League|National League|East All-?Stars?|West All-?Stars?|Pro Bowl|All[- ]?Stars?)\b/i;

  function isAllStarSide(name, games, medianGames) {
    if (ALL_STAR_NAMES.test(name)) return true;
    return medianGames >= 8 && games <= Math.max(2, medianGames * 0.15);
  }

  function collegeGroup(path) {
    if (/college-football/.test(path)) return 80;   // FBS
    if (/college-basketball/.test(path)) return 50; // Division I
    return null;
  }

  async function fetchDayByDay(base, start, end, group) {
    const days = [];
    const from = parseYmd(start), to = parseYmd(end);
    if (!from || !to) return [];

    for (let d = new Date(from); d <= to; d.setDate(d.getDate() + 1)) {
      days.push(`${d.getFullYear()}${String(d.getMonth() + 1).padStart(2, '0')}${String(d.getDate()).padStart(2, '0')}`);
    }
    if (days.length > 400) return [];   // guard against a bad window

    const suffix = group ? `&groups=${group}&limit=900` : '&limit=1000';
    const seen = new Map();

    await parallelDays(days, 6, async (day) => {
      try {
        const res = await fetch(`${base}?dates=${day}${suffix}`, { cache: 'no-store' });
        if (!res.ok) return;
        const data = await res.json();
        (data.events || []).forEach(e => { if (e?.id && !seen.has(e.id)) seen.set(e.id, e); });
      } catch {}
    });

    return Array.from(seen.values());
  }

  function parseYmd(s) {
    const m = String(s).match(/^(\d{4})(\d{2})(\d{2})$/);
    if (!m) return null;
    return new Date(Number(m[1]), Number(m[2]) - 1, Number(m[3]));
  }

  async function parallelDays(items, concurrency, fn) {
    const queue = [...items];
    await Promise.all(Array.from({ length: concurrency }, async () => {
      while (queue.length) {
        const item = queue.shift();
        if (item === undefined) break;
        await fn(item);
      }
    }));
  }

  async function fetchTeamStats(sport) {
    const path = ESPN_MAP[sport];
    if (!path) return null;
    try {
      const res = await fetch(`https://site.api.espn.com/apis/site/v2/sports/${path}/scoreboard`);
      return res.ok ? await res.json() : null;
    } catch { return null; }
  }

  // ============================================================
  // ── TEAM STATE ──
  // ============================================================

  function buildTeamStates(sport, events) {
    const teamMap = new Map();
    const chronological = [];

    events.forEach(e => {
      const comp = e.competitions?.[0];
      if (!comp) return;
      const home = comp.competitors?.find(c => c.homeAway === 'home');
      const away = comp.competitors?.find(c => c.homeAway === 'away');
      if (!home || !away) return;

      const homeName = home.team?.displayName;
      const awayName = away.team?.displayName;
      if (!homeName || !awayName) return;

      const homeScore = parseInt(home.score, 10);
      const awayScore = parseInt(away.score, 10);
      if (!isFinite(homeScore) || !isFinite(awayScore)) return;

      // A neutral-site game gets no home edge in the Elo pass.
      const neutral = comp.neutralSite === true;

      pushGame(sport, teamMap, homeName, home.team, homeScore, awayScore, true, awayName);
      pushGame(sport, teamMap, awayName, away.team, awayScore, homeScore, false, homeName);

      chronological.push({
        date: e.date,
        home: homeName, away: awayName,
        homeScore, awayScore, neutral,
      });
    });

    return { teamMap, chronological };
  }

  function pushGame(sport, map, teamName, teamObj, scored, allowed, wasHome, oppName) {
    if (!map.has(teamName)) {
      map.set(teamName, {
        team_id: String(teamObj?.id || teamName),
        abbr: teamObj?.abbreviation || teamName.slice(0, 3).toUpperCase(),
        games: 0, pf: 0, pa: 0,
        wins: 0, losses: 0, draws: 0,
        homeW: 0, homeL: 0, homeD: 0,
        awayW: 0, awayL: 0, awayD: 0,
        margins: [], opponents: [],
        closeGames: 0, closeWins: 0,
      });
    }
    const t = map.get(teamName);
    t.games++;
    t.pf += scored;
    t.pa += allowed;
    t.margins.push(scored - allowed);
    if (oppName) t.opponents.push(oppName);

    if (scored > allowed) {
      t.wins++;
      wasHome ? t.homeW++ : t.awayW++;
    } else if (scored < allowed) {
      t.losses++;
      wasHome ? t.homeL++ : t.awayL++;
    } else {
      t.draws++;
      wasHome ? t.homeD++ : t.awayD++;
    }

    const closeBy = CLOSE_MARGIN[sport] ?? CLOSE_MARGIN.DEFAULT;
    if (Math.abs(scored - allowed) <= closeBy) {
      t.closeGames++;
      if (scored > allowed) t.closeWins++;
    }
  }

  // ============================================================
  // ── SRS (opponent adjusted) ──
  // rating = capped average margin + average opponent rating,
  // solved iteratively then centred on zero.
  // ============================================================

  function computeSRS(sport, teamMap, iterations = 40) {
    const cfg = SPORT_CONFIG[sport] || SPORT_CONFIG.NFL;
    const cap = cfg.movCap;

    const names = Array.from(teamMap.keys());
    const avgMargin = {};
    const opponents = {};

    names.forEach(n => {
      const s = teamMap.get(n);
      const capped = s.margins.map(m => Math.max(-cap, Math.min(cap, m)));
      avgMargin[n] = capped.length ? capped.reduce((a, b) => a + b, 0) / capped.length : 0;
      opponents[n] = s.opponents.filter(o => teamMap.has(o));
    });

    let rating = {};
    names.forEach(n => { rating[n] = avgMargin[n]; });

    for (let i = 0; i < iterations; i++) {
      const next = {};
      names.forEach(n => {
        const opps = opponents[n];
        if (!opps.length) { next[n] = avgMargin[n]; return; }
        const oppSum = opps.reduce((acc, o) => acc + (rating[o] ?? 0), 0);
        next[n] = avgMargin[n] + (oppSum / opps.length);
      });
      rating = next;
    }

    // Centre so the league averages zero.
    const mean = names.length
      ? names.reduce((acc, n) => acc + rating[n], 0) / names.length
      : 0;
    const out = {};
    names.forEach(n => { out[n] = round(rating[n] - mean, 2); });
    return out;
  }

  // ============================================================
  // ── ELO (sequential, margin aware) ──
  // ============================================================

  function computeElo(sport, chronological) {
    const cfg = SPORT_CONFIG[sport] || SPORT_CONFIG.NFL;
    const K = cfg.eloK;
    const HFA = cfg.eloHFA;
    const elo = {};

    const get = t => (elo[t] === undefined ? (elo[t] = 1500) : elo[t]);

    chronological.forEach(g => {
      const hr = get(g.home);
      const ar = get(g.away);
      const hfa = g.neutral ? 0 : HFA;

      const expectedHome = 1 / (1 + Math.pow(10, (ar - (hr + hfa)) / 400));
      const margin = g.homeScore - g.awayScore;
      const actualHome = margin > 0 ? 1 : margin < 0 ? 0 : 0.5;

      const eloDiff = (hr + hfa) - ar;
      const winnerDiff = actualHome === 1 ? eloDiff : -eloDiff;
      const movMult = Math.log(Math.abs(margin) + 1) * (2.2 / (winnerDiff * 0.001 + 2.2));

      const delta = K * movMult * (actualHome - expectedHome);
      elo[g.home] = hr + delta;
      elo[g.away] = ar - delta;
    });

    const out = {};
    Object.keys(elo).forEach(t => { out[t] = Math.round(elo[t]); });
    return out;
  }

  // ============================================================
  // ── RATING ──
  // ============================================================

  function buildRating(sport, teamName, state, adjusted = {}) {
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
    const movRaw     = clamp(50 + (avgMOV / cfg.scale) * 25, 0, 100);

    const realWeight = games / (games + cfg.k);

    const offense = clamp(50 + (offenseRaw - 50) * realWeight, 0, 100);
    const defense = clamp(50 + (defenseRaw - 50) * realWeight, 0, 100);
    const mov     = clamp(50 + (movRaw - 50) * realWeight, 0, 100);
    const pyth    = 0.5 + (pythRaw - 0.5) * realWeight;

    const recent = state.margins.slice(-5);
    const formWeights = [0.10, 0.15, 0.20, 0.25, 0.30];
    const offset = 5 - recent.length;
    let formScore = 0;
    recent.forEach((m, i) => {
      formScore += formWeights[offset + i] * (m / cfg.scale) * 3;
    });
    formScore = clamp(formScore * realWeight, -20, 20);

    const overall = round(
      (pyth * 100 * 0.45) +
      (offense * 0.20) +
      (defense * 0.20) +
      (mov * 0.15),
      1
    );

    const hasDraws = DRAWS_POSSIBLE.has(sport) && state.draws > 0;
    const rec = hasDraws
      ? `${state.wins}-${state.losses}-${state.draws}`
      : `${state.wins}-${state.losses}`;
    const homeRec = hasDraws
      ? `${state.homeW}-${state.homeL}-${state.homeD}`
      : `${state.homeW}-${state.homeL}`;
    const awayRec = hasDraws
      ? `${state.awayW}-${state.awayL}-${state.awayD}`
      : `${state.awayW}-${state.awayL}`;

    return {
      team_id: state.team_id,
      team_name: teamName,
      abbr: state.abbr,
      sport,
      overall: clamp(overall, 0, 100),
      offense: round(offense, 1),
      defense: round(defense, 1),
      pythagorean: round(pyth, 4),
      // srs and elo keep their column names so nothing downstream
      // breaks, but they now carry the opponent-adjusted Massey value
      // and the Glicko-2 rating rather than raw margin and a reset Elo.
      srs: adjusted.massey ?? adjusted.srs ?? round(avgMOV, 2),
      elo: adjusted.glicko ? Math.round(adjusted.glicko.rating) : (adjusted.elo ?? 1500),

      glicko_rating: adjusted.glicko ? adjusted.glicko.rating : null,
      glicko_rd: adjusted.glicko ? adjusted.glicko.rd : null,
      glicko_vol: adjusted.glicko ? adjusted.glicko.vol : null,
      glicko_conservative: adjusted.glicko ? adjusted.glicko.conservative : null,
      massey: adjusted.massey ?? null,
      colley: adjusted.colley ?? null,
      composite_points: adjusted.blended ? adjusted.blended.composite_points : null,
      rating_certainty: adjusted.blended ? adjusted.blended.certainty : null,
      attack: adjusted.attackDefense ? adjusted.attackDefense.attack : null,
      def_rate: adjusted.attackDefense ? adjusted.attackDefense.defense : null,
      attack_index: adjusted.attackDefense ? adjusted.attackDefense.attack_index : null,
      defense_index: adjusted.attackDefense ? adjusted.attackDefense.defense_index : null,
      pace: round(avgPF, 1),
      record: rec,
      home_record: homeRec,
      away_record: awayRec,
      last5_form: round(formScore, 2),
      games_played: games,
      raw_stats: {
        avgPF: round(avgPF, 2),
        avgPA: round(avgPA, 2),
        avgMOV: round(avgMOV, 2),
        realWeight: round(realWeight, 3),
        raw_srs: round(avgMOV, 2),
      },
    };
  }

  function buildCoaching(sport, teamName, state) {
    const cfg = COACHING_WEIGHTS[sport] || COACHING_WEIGHTS.DEFAULT;
    const closeWinPct = state.closeGames > 0 ? state.closeWins / state.closeGames : 0.5;
    const realWeight = state.closeGames / (state.closeGames + 4);
    const closeShrunk = 0.5 + (closeWinPct - 0.5) * realWeight;
    const overall = round(closeShrunk * 100 * 0.6 + 50 * 0.4, 1);

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
    const usable = (espnEvents || []).filter(isRatableEvent);
    const { teamMap, chronological } = buildTeamStates(sport, usable);
    const state = teamMap.get(teamName);
    if (!state) return null;
    const srsMap = computeSRS(sport, teamMap);
    const eloMap = computeElo(sport, chronological);
    return buildRating(sport, teamName, state, { srs: srsMap[teamName], elo: eloMap[teamName] });
  }

  async function computeCoachingRating(sport, teamName, teamId, espnEvents) {
    const usable = (espnEvents || []).filter(isRatableEvent);
    const { teamMap } = buildTeamStates(sport, usable);
    const state = teamMap.get(teamName);
    if (!state) return null;
    return buildCoaching(sport, teamName, state);
  }

  // ============================================================
  // ── MATCHUP + PRIOR ──
  // ============================================================

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

    const marketSpread = market?.current_spread ?? null;

    // ── Projected score ──
    // Attack meets defence, per possession, opponent-adjusted. No
    // betting line is read to produce this number, so the comparison
    // against the market at the end is a genuine disagreement rather
    // than a residual from a model fitted to spreads.
    let projection = null;
    let modelSpread = null;

    const core = window.EDGE_RATING;
    const homeAD = homeStats.attack != null
      ? { attack: homeStats.attack, defense: homeStats.def_rate,
          possessions: homeStats.possessions || (core?.POSSESSIONS?.[sport] ?? 100) }
      : null;
    const awayAD = awayStats.attack != null
      ? { attack: awayStats.attack, defense: awayStats.def_rate,
          possessions: awayStats.possessions || (core?.POSSESSIONS?.[sport] ?? 100) }
      : null;

    const calib = getCalibration(sport);

    if (core && homeAD && awayAD && options.league) {
      projection = core.projectScore(sport, homeAD, awayAD, options.league, {
        neutral: game.neutral === true,
        interactions: options.interactions || null,
        // Measured from real results when a backfill has run.
        homeAdvantage: calib?.home_advantage ?? null,
      });
      if (projection) modelSpread = projection.model_spread;
    }

    // Fall back to the rating gap when the possession model has no
    // data for one of these teams.
    if (modelSpread === null) {
      const homePts = homeStats.composite_points;
      const awayPts = awayStats.composite_points;
      if (homePts != null && awayPts != null) {
        const hfa = core?.HOME_POINTS?.[sport] ?? 2;
        modelSpread = round(-((homePts - awayPts) + hfa), 2);
      } else {
        const ratingDelta = homeStats.overall - awayStats.overall;
        const spreadConv = {
          NFL: -0.28, NBA: -0.28, MLB: -0.08, NHL: -0.05,
          NCAAF: -0.30, NCAAB: -0.28, MLS: -0.05,
        }[sport] || -0.28;
        modelSpread = round(ratingDelta * spreadConv, 2);
      }
    }

    const coachAdj = homeStats._coach_adj ?? 0;
    const coachAdjAway = awayStats._coach_adj ?? 0;
    const coachDelta = coachAdj - coachAdjAway;

    const totalModelSpread = round(
      modelSpread + (coachDelta * -1) + (defenseMatchup.adjustment_points * -1),
      2
    );

    const rawEdge = marketSpread !== null ? round(marketSpread - totalModelSpread, 2) : 0;

    const probShiftPerPoint = {
      NFL: 0.028, NBA: 0.032, MLB: 0.040, NHL: 0.035,
      NCAAF: 0.028, NCAAB: 0.032, MLS: 0.040,
    }[sport] || 0.030;

    let priorHomeProb = clamp(0.5 + (rawEdge * probShiftPerPoint), 0.05, 0.95);

    // When both teams carry a Glicko rating, the win probability comes
    // from the distributions rather than a linear shift — it accounts
    // for how sure the system is of each team.
    let ratingProb = null;
    if (core && homeStats.glicko_rating != null && awayStats.glicko_rating != null) {
      ratingProb = core.glickoWinProbability(
        { rating: homeStats.glicko_rating, rd: homeStats.glicko_rd },
        { rating: awayStats.glicko_rating, rd: awayStats.glicko_rd },
        core.HOME_POINTS?.[sport] ?? 2, sport);
    }

    return {
      game_id: game.id,
      sport,
      home_team: game.home_team || game.home,
      away_team: game.away_team || game.away,
      commence_time: game.commence_time || game.time || null,
      // Pass the market through whole. The caller decides what's on it —
      // spread prices, which book quoted them, the deep link — and
      // whitelisting five fields here silently dropped the rest before
      // physics could stamp them onto the pick.
      market: {
        ...(market || {}),
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
      projection,

      // The only question a spread actually asks: how often does this
      // side beat that number? Answered from the model's own measured
      // error, so it is a probability rather than a direction.
      cover: (core && projection && marketSpread !== null)
        ? core.coverProbability(projection.margin, marketSpread,
            calib?.sigma_settled ?? calib?.projection_sigma ?? null,
            {
              // Once the model has been measured against closing lines,
              // its disagreement is shrunk by the weight that measurement
              // earned. Without this the probability is inflated.
              lambda: calib?.market_lambda ?? null,
              blendSigma: calib?.blend_sigma ?? null,
            })
        : null,
      calibrated: !!calib,
      calibration_note: calib
        ? (calib.market_lambda != null
            ? `lambda ${calib.market_lambda} vs the close · blend sigma ${calib.blend_sigma} on ${calib.market_sample} games`
            : `sigma ${calib.sigma_settled ?? calib.projection_sigma} from ${calib.sample_residuals} unseen games — NOT yet measured against closing lines`)
        : 'no backfill on file — using compiled defaults',
      raw_edge: rawEdge,
      prior_home_prob: round(priorHomeProb, 4),
      rating_home_prob: ratingProb != null ? round(ratingProb, 4) : null,
      rating_certainty: {
        home_rd: homeStats.glicko_rd ?? null,
        away_rd: awayStats.glicko_rd ?? null,
        // Wider deviation means the projection deserves less trust.
        combined: (homeStats.glicko_rd != null && awayStats.glicko_rd != null)
          ? round(Math.sqrt(homeStats.glicko_rd ** 2 + awayStats.glicko_rd ** 2), 1) : null,
      },
      computed_at: new Date().toISOString(),
    };
  }

  // ============================================================
  // ── CALIBRATION ──
  // ============================================================

  async function loadCalibrationOnce(force = false) {
    if (_calibration.loaded && !force) return _calibration.bySport;
    const url = SUPABASE_URL(), key = SUPABASE_KEY();
    if (!url || !key) { _calibration.loaded = true; return _calibration.bySport; }
    try {
      const res = await fetch(`${url}/rest/v1/model_calibration?limit=20`, {
        headers: { apikey: key, Authorization: `Bearer ${key}` },
      });
      if (res.ok) {
        (await res.json()).forEach(r => { _calibration.bySport[r.sport] = r; });
      }
    } catch {}
    _calibration.loaded = true;
    return _calibration.bySport;
  }

  function getCalibration(sport) { return _calibration.bySport[sport] || null; }

  // ============================================================
  // ── PUBLIC FETCH ──
  // The backfill needs history over arbitrary windows and must not
  // reimplement the ESPN quirks solved here.
  // ============================================================

  async function fetchGamesBetween(sport, startDate, endDate, options = {}) {
    const path = ESPN_MAP[sport];
    if (!path) return [];
    const { raw = false } = options;
    const events = await fetchSeasonEvents(sport, path, new Date(startDate), new Date(endDate));
    return raw ? events : parseEvents(sport, events);
  }

  // Flatten ESPN events into the shape the rating core consumes.
  function parseEvents(sport, events) {
    const out = [];
    (events || []).forEach(e => {
      const comp = e.competitions?.[0];
      if (!comp) return;
      const home = comp.competitors?.find(c => c.homeAway === 'home');
      const away = comp.competitors?.find(c => c.homeAway === 'away');
      if (!home || !away) return;
      const hs = parseInt(home.score, 10), as = parseInt(away.score, 10);
      if (!isFinite(hs) || !isFinite(as)) return;
      const hn = home.team?.displayName, an = away.team?.displayName;
      if (!hn || !an) return;

      out.push({
        id: String(e.id),
        date: e.date,
        home: hn, away: an,
        homeScore: hs, awayScore: as,
        neutral: comp.neutralSite === true,
        importance: importanceOf(e, comp),
      });
    });
    return out.sort((a, b) => new Date(a.date) - new Date(b.date));
  }

  // Season type 3 is the postseason; those results carry more weight.
  function importanceOf(e, comp) {
    const type = e.season?.type ?? comp?.season?.type;
    if (type === 3) return 'playoff';
    if (type === 1) return 'preseason';
    return 'regular';
  }

  // ============================================================
  // ── SEASON CARRY-OVER ──
  // Last season's final Glicko state, regressed toward the mean with
  // deviation restored. Without it every rebuild starts the whole
  // league at 1500 and week 1 carries no information at all.
  // ============================================================

  async function loadCarryover(sport) {
    const url = SUPABASE_URL(), key = SUPABASE_KEY();
    if (!url || !key) return null;

    const season = seasonLabelFor(sport, new Date());
    try {
      const res = await fetch(
        `${url}/rest/v1/rating_carryover?sport=eq.${sport}&season=eq.${encodeURIComponent(season)}&limit=500`,
        { headers: { apikey: key, Authorization: `Bearer ${key}` } });
      if (!res.ok) return null;
      const rows = await res.json();
      if (!rows.length) return null;
      const seed = {};
      rows.forEach(r => { seed[r.team_name] = { rating: r.rating, rd: r.rd, vol: r.vol ?? 0.06 }; });
      return seed;
    } catch { return null; }
  }

  // Run once a season has finished, to seed the next one. Offseason
  // adjustments are supplied in points of team strength — a trade, a
  // draft haul, a coaching change — and inflate deviation in proportion,
  // because a team that changed a lot is one we know less about.
  async function saveCarryover(sport, glickoState, options = {}) {
    const url = SUPABASE_URL(), key = SUPABASE_KEY();
    if (!url || !key) return { ok: false, error: 'Supabase not connected' };
    if (!window.EDGE_RATING) return { ok: false, error: 'rating-core.js not loaded' };

    const { adjustments = {}, forSeason = null } = options;
    const next = forSeason || nextSeasonLabel(sport, new Date());
    const carried = window.EDGE_RATING.carryOver(sport, glickoState, { adjustments });

    const rows = Object.entries(carried).map(([team, v]) => ({
      sport, season: next, team_name: team,
      rating: v.rating, rd: v.rd, vol: v.vol,
      carried_from: v.carried_from,
      adjustment: v.adjustment,
      adjustment_reason: v.adjustment_reason,
      updated_at: new Date().toISOString(),
    }));
    if (!rows.length) return { ok: false, error: 'nothing to carry' };

    try {
      const res = await fetch(`${url}/rest/v1/rating_carryover?on_conflict=sport,season,team_name`, {
        method: 'POST',
        headers: {
          apikey: key, Authorization: `Bearer ${key}`,
          'Content-Type': 'application/json',
          Prefer: 'resolution=merge-duplicates,return=minimal',
        },
        body: JSON.stringify(rows),
      });
      if (!res.ok) return { ok: false, error: `HTTP ${res.status} ${await res.text().catch(() => '')}` };
      return { ok: true, written: rows.length, season: next };
    } catch (e) { return { ok: false, error: e.message }; }
  }

  function seasonLabelFor(sport, date) {
    const m = date.getMonth() + 1, y = date.getFullYear();
    const cross = (start) => (m >= start ? y : y - 1);
    if (sport === 'NBA' || sport === 'NHL' || sport === 'NCAAB') return String(cross(9));
    if (sport === 'NFL' || sport === 'NCAAF') return String(cross(3));
    return String(y);
  }

  function nextSeasonLabel(sport, date) {
    return String(parseInt(seasonLabelFor(sport, date), 10) + 1);
  }

  // ============================================================
  // ── PERSIST ──
  // v4.0 emitted wins / losses / draws, which do not exist as columns
  // on the live power_ratings table. PostgREST rejects the whole batch
  // with 400 on an unknown column — and because the old code deleted
  // first and inserted second, a rejected batch left the table empty.
  // That is why ratings "stopped working" after a rebuild.
  //
  // Now: learn the real column set, strip anything the table does not
  // have, prove the insert works on the first chunk, and only then
  // clear the previous run's rows. A failed insert can no longer wipe
  // good data.
  // ============================================================

  async function persistRatings(results, emit = () => {}) {
    const url = SUPABASE_URL();
    const key = SUPABASE_KEY();
    const report = { teams_written: 0, coaching_written: 0, errors: [], dropped_columns: [] };
    if (!url || !key) {
      report.errors.push(
        `Supabase not connected — url ${url ? 'set' : 'MISSING'}, key ${key ? 'set' : 'MISSING'}. ` +
        `Settings › Connections.`);
      return report;
    }

    const teamRows = Object.values(results.teams);
    const coachRows = Object.values(results.coaching);

    // Nothing rated means something upstream failed. Never replace a
    // populated table with nothing.
    if (!teamRows.length) {
      report.errors.push('No ratings computed — table left untouched');
      return report;
    }

    const runStamp = new Date().toISOString();
    teamRows.forEach(r => { r.updated_at = runStamp; });
    coachRows.forEach(r => { r.updated_at = runStamp; });

    report.teams_written = await replaceTable(
      url, key, 'power_ratings', teamRows, runStamp, report, emit);
    if (coachRows.length) {
      report.coaching_written = await replaceTable(
        url, key, 'coaching_ratings', coachRows, runStamp, report, emit);
    }
    return report;
  }

  async function replaceTable(url, key, table, rows, runStamp, report, emit) {
    const headers = {
      apikey: key, Authorization: `Bearer ${key}`,
      'Content-Type': 'application/json', Prefer: 'return=minimal',
    };

    // 1. Learn which columns the table actually has.
    const allowed = await discoverColumns(url, key, table);
    let payload = rows;
    if (allowed) {
      const emitted = new Set(Object.keys(rows[0]));
      const dropped = Array.from(emitted).filter(k => !allowed.has(k));
      if (dropped.length) {
        report.dropped_columns.push(`${table}: ${dropped.join(', ')}`);
        emit(`${table}: ignoring columns not in schema — ${dropped.join(', ')}`);
      }
      payload = rows.map(r => {
        const out = {};
        Object.keys(r).forEach(k => { if (allowed.has(k)) out[k] = r[k]; });
        return out;
      });
    }

    // 2. Prove the insert works before deleting anything.
    const chunkSize = 200;
    const first = payload.slice(0, chunkSize);
    let probe = await postDroppingUnknown(url, table, headers, first, report, emit);

    // A unique constraint is not a schema rejection. Reaching 23505
    // proves the payload is valid and only the previous run is in the
    // way — coaching_ratings has a unique index on (team_id, sport),
    // so inserting before clearing always collided. Clearing first is
    // safe in this one case precisely because the insert got that far.
    if (!probe.ok && probe.status === 409) {
      emit(`${table}: unique constraint — clearing previous run and retrying`);
      try {
        await fetch(`${url}/rest/v1/${table}?sport=not.is.null`, {
          method: 'DELETE', headers: { apikey: key, Authorization: `Bearer ${key}` },
        });
      } catch {}
      probe = await postDroppingUnknown(url, table, headers, first, report, emit);
    }

    if (!probe.ok) {
      report.errors.push(`${table}: insert rejected (HTTP ${probe.status}) ${String(probe.body).slice(0, 200)}`);
      emit(`${table}: insert rejected — existing rows left in place`);
      emit(`${table}: ${String(probe.body).slice(0, 200)}`);
      return 0;
    }

    // Whatever shape got accepted is the shape the rest must use.
    const accepted = new Set(Object.keys(probe.payload[0] || {}));
    payload = payload.map(r => {
      const o = {};
      Object.keys(r).forEach(k => { if (accepted.has(k)) o[k] = r[k]; });
      return o;
    });

    let written = first.length;

    // 3. The insert works, so the rest can follow.
    for (let i = chunkSize; i < payload.length; i += chunkSize) {
      const slice = payload.slice(i, i + chunkSize);
      let res = await post(url, table, headers, slice);
      if (!res.ok && res.status === 409) {
        res = await post(url, table,
          { ...headers, Prefer: 'resolution=merge-duplicates,return=minimal' }, slice);
      }
      if (res.ok) written += slice.length;
      else report.errors.push(`${table}: chunk ${i} HTTP ${res.status} ${String(res.body).slice(0, 140)}`);
    }

    // 4. Only now remove the previous run. Anything not stamped with
    //    this run's timestamp is stale.
    try {
      await fetch(`${url}/rest/v1/${table}?updated_at=neq.${encodeURIComponent(runStamp)}`, {
        method: 'DELETE',
        headers: { apikey: key, Authorization: `Bearer ${key}` },
      });
    } catch (e) {
      report.errors.push(`${table}: stale rows not cleared (${e.message})`);
    }

    emit(`${table}: ${written} rows written`);
    return written;
  }

  // Reading a row only works when the table has one. An empty table
  // could not be learned from, so the full payload went out, got a 400
  // on an unknown column, and nothing was ever written — the table
  // stayed empty forever. PostgREST publishes the schema at the API
  // root, which works whether or not any rows exist.
  async function discoverColumns(url, key, table) {
    const headers = { apikey: key, Authorization: `Bearer ${key}` };

    // 1. OpenAPI definition — authoritative, works on an empty table.
    try {
      const res = await fetch(`${url}/rest/v1/`, { headers });
      if (res.ok) {
        const spec = await res.json();
        const def = spec?.definitions?.[table] || spec?.components?.schemas?.[table];
        const props = def?.properties;
        if (props && Object.keys(props).length) return new Set(Object.keys(props));
      }
    } catch {}

    // 2. Fall back to reading a row, for older PostgREST versions.
    try {
      const res = await fetch(`${url}/rest/v1/${table}?select=*&limit=1`, { headers });
      if (res.ok) {
        const rows = await res.json();
        if (rows.length) return new Set(Object.keys(rows[0]));
      }
    } catch {}

    return null;
  }

  // Last resort: let the database name the column it does not have,
  // drop it, and try again. PostgREST reports one offender per
  // attempt, so this loops.
  async function postDroppingUnknown(url, table, headers, rows, report, emit) {
    let payload = rows;
    for (let attempt = 0; attempt < 12; attempt++) {
      const res = await post(url, table, headers, payload);
      if (res.ok) return { ok: true, payload };

      const offender = (res.body.match(/'([a-zA-Z_][a-zA-Z0-9_]*)' column/) ||
                        res.body.match(/column "([a-zA-Z_][a-zA-Z0-9_]*)"/) ||
                        [])[1];
      if (!offender) return { ok: false, status: res.status, body: res.body };

      emit(`${table}: dropping column the table does not have — ${offender}`);
      report.dropped_columns.push(`${table}: ${offender}`);
      payload = payload.map(r => { const o = { ...r }; delete o[offender]; return o; });
    }
    return { ok: false, status: 400, body: 'Too many unknown columns' };
  }

  async function post(url, table, headers, body) {
    try {
      const res = await fetch(`${url}/rest/v1/${table}`, {
        method: 'POST', headers, body: JSON.stringify(body),
      });
      const text = res.ok ? '' : await res.text().catch(() => '');
      return { ok: res.ok, status: res.status, body: text };
    } catch (e) {
      return { ok: false, status: 0, body: e.message };
    }
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
