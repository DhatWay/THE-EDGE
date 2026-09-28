// ============================================================
// EDGE — POWER RATINGS ENGINE v4.4
//
// v4.4 changes:
//
//   · Chunk cap is no longer a fixed constant. The v4.3 code
//     stopped at MAX_CHUNKS = 40 windows, which for NFL's
//     30-day windows covered only about three and a half
//     years. Any ATS or trends request for a longer window
//     silently truncated. The cap is now computed from the
//     requested range, and the fetch runs with a concurrency
//     limit so a sixty-chunk request does not fire all at
//     once and trip ESPN's rate limiter.
//
//   · Preseason and postseason are separated. The old
//     isRatableEvent dropped both. ATS and trends need the
//     playoff games written to historical_odds even though
//     they should not count toward team ratings, and a single
//     filter served both callers. Two filters now:
//     isCompletedEvent (drops preseason, keeps playoff) and
//     isRegularSeason (drops both). fetchGamesBetween takes
//     a regularOnly option. Default is true so the backfill
//     and power ratings paths behave as before; ats-tracker
//     passes false to capture the full schedule.
//
//   · Early-season ratings. MIN_GAMES_FOR_RATING was 3 for
//     every day of the season. In week 1 of the NFL every
//     team has one game, so every team was excluded and the
//     board came back empty. The threshold now scales with
//     days into the season: 1 game in the first week, 2 in
//     the second, 3 from the third week on. The rating
//     certainty signal in the algorithms family already
//     handles the caution — a rating built on one game has
//     a large Glicko RD and the certainty weighting discounts
//     it appropriately.
//
//   · Composite scaling for low-scoring sports. overall was
//     built from composite_points * 2, which maps ±12 to ±24
//     for NFL but only ±2.5 to ±5 for MLB, since the rating
//     core returns composite in the sport's own margin units
//     (a three-point spread in baseball is a big number, in
//     football it is not). MLB, NHL and MLS rankings were
//     therefore still dominated by the pythagorean and
//     offense/defense columns while the model-driven
//     composite barely moved. A per-sport composite scale
//     fixes the mapping so the column the picks run on also
//     drives the ranking the page shows.
//
//   · replaceTable no longer deletes current-sport rows
//     before writing the new ones. A failed insert left the
//     table empty. The new path tries an upsert against a
//     unique (sport, team_name) index — existing rows are
//     updated, new ones inserted, dropped teams cleaned up
//     afterwards — and only falls back to delete-then-insert
//     if the constraint is not present, with a warning
//     written to edge_errors.
// ============================================================

const EDGE_POWER = (() => {

  const BUILD = 'pe-20260927-02';

  const SUPABASE_URL = () => localStorage.getItem('edge_supabase_url');
  const SUPABASE_KEY = () => localStorage.getItem('edge_supabase_key');

  const ESPN_MAP = {
    NFL:   'football/nfl',
    NBA:   'basketball/nba',
    WNBA:  'basketball/wnba',
    MLB:   'baseball/mlb',
    NHL:   'hockey/nhl',
    NCAAF: 'football/college-football',
    NCAAB: 'basketball/mens-college-basketball',
    MLS:   'soccer/usa.1',
  };

  const SEASON_WINDOWS = {
    NFL:   { start: [9, 1],   end: [2, 15]  },
    NBA:   { start: [10, 15], end: [6, 30]  },
    WNBA:  { start: [5, 1],   end: [10, 15] },
    MLB:   { start: [3, 20],  end: [11, 5]  },
    NHL:   { start: [10, 1],  end: [6, 30]  },
    NCAAF: { start: [8, 15],  end: [1, 15]  },
    NCAAB: { start: [11, 1],  end: [4, 10]  },
    MLS:   { start: [2, 20],  end: [12, 15] },
  };

  // Days per chunk. Sized so a full chunk stays under ESPN's
  // 1,000-event response cap even in the sports with the
  // densest schedules. NCAAB at 5 days is the tightest case.
  const CHUNK_DAYS = {
    NFL: 30, NCAAF: 14, MLS: 30,
    MLB: 14, NBA: 14, NHL: 14, WNBA: 14,
    NCAAB: 5,
  };

  // Safety ceiling on how many chunk requests a single sport
  // run will fire. Well above the ~130 chunks a full five-year
  // MLB window needs, so it never triggers in practice.
  const MAX_CHUNKS = 500;

  // Concurrency for chunked fetches. Higher for short windows,
  // lower for long ones so a full five-year ATS pull does not
  // hit ESPN with sixty simultaneous requests.
  const FETCH_CONCURRENCY_SHORT = 8;
  const FETCH_CONCURRENCY_LONG  = 4;
  const FETCH_LONG_THRESHOLD    = 30;

  const SPORT_CONFIG = {
    NFL:   { avgPF: 22,  avgPA: 22,  pyExp: 2.37,  scale: 22,  k: 8,  movCap: 28, eloK: 20, eloHFA: 55  },
    NBA:   { avgPF: 112, avgPA: 112, pyExp: 13.91, scale: 18,  k: 15, movCap: 25, eloK: 20, eloHFA: 100 },
    WNBA:  { avgPF: 82,  avgPA: 82,  pyExp: 11.0,  scale: 18,  k: 12, movCap: 25, eloK: 20, eloHFA: 100 },
    MLB:   { avgPF: 4.5, avgPA: 4.5, pyExp: 1.83,  scale: 3,   k: 20, movCap: 8,  eloK: 6,  eloHFA: 25  },
    NHL:   { avgPF: 3.0, avgPA: 3.0, pyExp: 2.0,   scale: 2,   k: 15, movCap: 4,  eloK: 8,  eloHFA: 35  },
    NCAAF: { avgPF: 27,  avgPA: 27,  pyExp: 2.37,  scale: 32,  k: 6,  movCap: 35, eloK: 25, eloHFA: 65  },
    NCAAB: { avgPF: 72,  avgPA: 72,  pyExp: 10.0,  scale: 20,  k: 10, movCap: 22, eloK: 25, eloHFA: 100 },
    MLS:   { avgPF: 1.5, avgPA: 1.5, pyExp: 2.0,   scale: 1.2, k: 15, movCap: 3,  eloK: 20, eloHFA: 60  },
  };

  // Multiplier that maps composite_points onto the 0-100 scale
  // the app displays. composite_points comes back from the
  // rating core in the sport's own margin units — NFL spreads
  // are measured in tens, MLB spreads in ones — so the raw
  // number is not comparable across sports without this map.
  // ESPN's default page. Its college scoreboards answer a `limit`
  // above their cap with this page instead of the full day — the
  // ratings probe got 25 games back for a Saturday that has 65.
  const ESPN_PAGE_SIZE = 25;

  // Games each team needs before the attack/defense projection
  // carries the model spread on its own. Before that it is blended
  // with the composite rating (Glicko carried over from last season
  // plus this season's results), because two weeks of scoring is
  // mostly noise: in Week 3 the projection alone made the Chargers
  // 4.7-point favorites at Buffalo against a market of Bills -7.
  const PROJECTION_FULL_GAMES = {
    NFL: 8, NCAAF: 6, NBA: 20, WNBA: 12, NCAAB: 12, MLB: 40, NHL: 20, MLS: 10,
  };

  const COMPOSITE_TO_SCALE = {
    NFL: 2.0,
    NCAAF: 1.8,
    NBA: 2.0,
    NCAAB: 2.0,
    WNBA: 2.0,
    MLB: 8.0,
    NHL: 10.0,
    MLS: 12.0,
    DEFAULT: 2.0,
  };

  const DRAWS_POSSIBLE = new Set(['MLS', 'NFL', 'NCAAF']);

  const COACHING_WEIGHTS = {
    NFL:   { halftime: 1.5, close: 0.7, maxAdj: 3.5 },
    NBA:   { halftime: 1.0, close: 0.5, maxAdj: 2.0 },
    WNBA:  { halftime: 1.0, close: 0.5, maxAdj: 2.0 },
    MLB:   { halftime: 0.0, close: 0.4, maxAdj: 1.5 },
    NHL:   { halftime: 0.5, close: 0.5, maxAdj: 1.5 },
    DEFAULT: { halftime: 0.8, close: 0.5, maxAdj: 2.5 },
  };

  const CLOSE_MARGIN = { NFL: 7, NCAAF: 7, NBA: 5, NCAAB: 5, WNBA: 5, MLB: 1, NHL: 1, MLS: 1, DEFAULT: 5 };

  const MAX_LOOKBACK_DAYS = 400;

  // Floor once a season is truly under way. During the first
  // two weeks the effective floor is lower — see
  // effectiveMinGames().
  const MIN_GAMES_FOR_RATING = 3;

  const _espnShape = { chosen: null, dayFallback: false };

  const _calibration = { loaded: false, bySport: {} };

  const ALL_STAR_NAMES = /\b(AFC|NFC|American League|National League|East All-?Stars?|West All-?Stars?|Pro Bowl|All[- ]?Stars?)\b/i;

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
    seasonLabel,
    loadCarryover,
    saveCarryover,
    SPORT_CONFIG,
    ESPN_MAP,
    SEASON_WINDOWS,
    MIN_GAMES_FOR_RATING,
    effectiveMinGames,
    qualifiesForRating,
    composeOverall,
    coachAdjustmentPoints,
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

  function seasonStart(sport, now = new Date()) {
    const w = SEASON_WINDOWS[sport];
    if (!w) return new Date(now.getTime() - MAX_LOOKBACK_DAYS * 86400000);

    const [m, d] = w.start;
    let candidate = new Date(now.getFullYear(), m - 1, d);
    if (candidate > now) candidate = new Date(now.getFullYear() - 1, m - 1, d);

    const floor = new Date(now.getTime() - MAX_LOOKBACK_DAYS * 86400000);
    return candidate < floor ? floor : candidate;
  }

  // Matches ats-tracker v3.0 and the rest of the pipeline.
  // Cross-year sports carry the year they started. Single-year
  // sports carry the calendar year.
  function seasonLabel(sport, date = new Date()) {
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

  // The rating floor follows games played, not days on the
  // calendar. Until the league's median team has played
  // MIN_GAMES_FOR_RATING games, a team needs half the median (at
  // least one). Counting days broke weekly sports: the NFL opens on
  // a Thursday, so on the Friday and Saturday of week 3 (day 15-16)
  // only the two Thursday teams had three games, and a ratings run
  // then kept 2 teams and deleted 30.
  // overall — the number the power page ranks on. Exported so the
  // slate backtest builds the identical number.
  function composeOverall(sport, parts = {}) {
    const { compositePoints = null, pyth = 0.5, offense = 50, defense = 50, mov = 50 } = parts;
    let overall;
    if (compositePoints != null && isFinite(compositePoints)) {
      const scale = COMPOSITE_TO_SCALE[sport] ?? COMPOSITE_TO_SCALE.DEFAULT;
      const compositeScaled = clamp(50 + compositePoints * scale, 0, 100);
      overall = (compositeScaled * 0.55) + (offense * 0.20) + (defense * 0.20) + (mov * 0.05);
    } else {
      // rating-core absent: the pythagorean-heavy shape.
      overall = (pyth * 100 * 0.45) + (offense * 0.20) + (defense * 0.20) + (mov * 0.15);
    }
    return round(overall, 1);
  }

  function effectiveMinGames(medianGames) {
    if (medianGames >= MIN_GAMES_FOR_RATING) return MIN_GAMES_FOR_RATING;
    return Math.max(1, Math.floor(medianGames / 2));
  }

  function qualifiesForRating(games, medianGames) {
    return games >= effectiveMinGames(medianGames);
  }

  // ============================================================
  // ── MAIN ──
  // ============================================================

  async function computeAllTeamRatings(options = {}) {
    // `sports` limits the run to those sports (Admin's sport picker).
    // Only their rows are replaced; every other sport's ratings stay.
    const { scopeTeams = null, onProgress = null, sports = null } = options;
    const only = Array.isArray(sports) && sports.length ? new Set(sports) : null;
    const emit = (m) => { if (typeof onProgress === 'function') onProgress(m); };

    _espnShape.chosen = null;
    _espnShape.dayFallback = false;

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
      if (only && !only.has(sport)) continue;
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
        const events = await fetchSeasonEvents(sport, path, start, now, true);
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

        // Floor from the league's median games played.
        const gameCounts = Array.from(teamMap.values()).map(s => s.games).sort((a, b) => a - b);
        const median = gameCounts[Math.floor(gameCounts.length / 2)] || 1;
        const minGames = effectiveMinGames(median);

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

        // SRS and Elo are always computed here, not just when
        // rating-core is absent. The columns carry the real
        // numbers now rather than Massey and Glicko.
        const srsMap = computeSRS(sport, teamMap);
        const eloMap = computeElo(sport, chronological);

        for (const [teamName, state] of teamMap) {
          if (state.games < minGames) continue;
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
          if (scope && !scope.has(teamName)) continue;

          if (rating) {
            results.teams[`${sport}:${teamName}`] = rating;
            teamCount++;
          }
          const coach = buildCoaching(sport, teamName, state);
          if (coach) results.coaching[`${sport}:${teamName}`] = coach;
        }

        // Set _coach_adj on every team now that coaching is
        // built. computeGamePrior reads it to shift the model
        // spread. Without this, coaching never moved the line.
        Object.entries(results.coaching).forEach(([key, coach]) => {
          if (!key.startsWith(sport + ':')) return;
          const team = results.teams[key];
          if (!team) return;
          team._coach_adj = coachAdjustmentPoints(sport, coach);
        });

        if (minGames < MIN_GAMES_FOR_RATING) {
          emit(`${sport}: median team has ${median} game(s) — using a ${minGames}-game floor`);
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
  // ============================================================

  async function fetchSeasonEvents(sport, path, start, end, regularOnly = true) {
    const chunkDays = CHUNK_DAYS[sport] || 21;

    const rangeDays = Math.ceil((end.getTime() - start.getTime()) / 86400000);
    const requiredChunks = Math.ceil(rangeDays / chunkDays) + 2;
    const maxChunks = Math.min(requiredChunks, MAX_CHUNKS);

    const windows = [];
    let cursor = new Date(start);
    let guard = 0;
    while (cursor < end && guard < maxChunks) {
      const chunkEnd = new Date(Math.min(cursor.getTime() + chunkDays * 86400000, end.getTime()));
      windows.push([new Date(cursor), chunkEnd]);
      cursor = new Date(chunkEnd.getTime() + 86400000);
      guard++;
    }

    // Long windows run a lower concurrency so we do not trip
    // ESPN's rate limiter halfway through.
    const concurrency = windows.length > FETCH_LONG_THRESHOLD
      ? FETCH_CONCURRENCY_LONG
      : FETCH_CONCURRENCY_SHORT;

    const batches = [];
    const queue = [...windows];
    await Promise.all(Array.from({ length: concurrency }, async () => {
      while (queue.length) {
        const [a, b] = queue.shift();
        if (!a) break;
        try {
          const ev = await fetchGamesInRange(path, fmtDate(a), fmtDate(b));
          batches.push(ev);
        } catch { batches.push([]); }
      }
    }));

    const filterFn = regularOnly ? isRegularSeason : isCompletedEvent;
    const byId = new Map();
    batches.flat().forEach(e => {
      if (!e || !e.id) return;
      if (!filterFn(e)) return;
      if (!byId.has(e.id)) byId.set(e.id, e);
    });

    return Array.from(byId.values())
      .sort((a, b) => new Date(a.date) - new Date(b.date));
  }

  // Preseason (type 1) is never useful. Postseason (type 3) is
  // kept by isCompletedEvent so historical_odds has a row for
  // the playoff games ATS and trends need, and dropped by
  // isRegularSeason so team ratings are built only from the
  // regular season.
  function isCompletedEvent(e) {
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

  function isRegularSeason(e) {
    if (!isCompletedEvent(e)) return false;
    const type = e.season?.type ?? e.competitions?.[0]?.season?.type;
    return type !== 3;
  }

  // Kept for callers that still reference the old name.
  function isRatableEvent(e) {
    return isRegularSeason(e);
  }

  async function fetchGamesInRange(path, start, end) {
    const base = `https://site.api.espn.com/apis/site/v2/sports/${path}/scoreboard`;
    const group = collegeGroup(path);

    const shapes = [
      (s, e) => `${base}?dates=${s}-${e}&limit=1000`,
      (s, e) => `${base}?limit=1000&dates=${s}-${e}`,
      (s, e) => `${base}?dates=${s}-${e}`,
    ];
    if (group) shapes.unshift((s, e) => `${base}?dates=${s}-${e}&groups=${group}&limit=900`);

    const order = _espnShape.chosen != null
      ? [shapes[_espnShape.chosen], ...shapes.filter((_, i) => i !== _espnShape.chosen)]
      : shapes;

    if (!_espnShape.dayFallback) {
      for (let i = 0; i < order.length; i++) {
        try {
          const res = await fetch(order[i](start, end), { cache: 'no-store' });

          // The service worker returns a 200 with an offline
          // header on a failed fetch. A body of [] from that
          // path is not "no games today" — it is a fetch that
          // did not reach ESPN. Discard it so the day-by-day
          // fallback runs and the caller sees a real answer.
          if (res.headers.get('x-edge-offline') === '1') {
            throw new Error('service worker offline response');
          }
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

    _espnShape.dayFallback = true;
    return fetchDayByDay(base, start, end, group);
  }

  function isAllStarSide(name, games, medianGames) {
    if (ALL_STAR_NAMES.test(name)) return true;
    // Very-few-games exclusions only when the league is settled
    // enough that a median exists. The min-games floor already
    // handles the rest.
    return medianGames >= 8 && games <= Math.max(2, medianGames * 0.15);
  }

  function collegeGroup(path) {
    if (/college-football/.test(path)) return 80;
    if (/college-basketball/.test(path)) return 50;
    return null;
  }

  async function fetchDayByDay(base, start, end, group) {
    const days = [];
    const from = parseYmd(start), to = parseYmd(end);
    if (!from || !to) return [];

    for (let d = new Date(from); d <= to; d.setDate(d.getDate() + 1)) {
      days.push(`${d.getFullYear()}${String(d.getMonth() + 1).padStart(2, '0')}${String(d.getDate()).padStart(2, '0')}`);
    }
    if (days.length > 400) {
      console.warn(`[EDGE_POWER] day-by-day fetch skipped: ${days.length} days exceeds the 400-day cap`);
      return [];
    }

    const seen = new Map();

    await parallelDays(days, 6, async (day) => {
      const events = await fetchScoreboardDay(base, day, group);
      (events || []).forEach(e => { if (e?.id && !seen.has(e.id)) seen.set(e.id, e); });
    });

    return Array.from(seen.values());
  }

  // One day's scoreboard. College asks without a limit first — a
  // limit above ESPN's cap returned only the default 25 games. When
  // the answer is a whole number of pages (25, 50…) it may still be
  // cut off, so the day is asked again in other shapes and the
  // results are merged by event id. Returns null when every request
  // failed, so a failed day is not mistaken for a day without games.
  async function fetchScoreboardDay(base, day, group) {
    const shapes = group
      ? [`&groups=${group}`, '', `&groups=${group}&limit=300`, `&groups=${group}&limit=500`]
      : ['&limit=1000'];
    const seen = new Map();
    let answered = false;

    for (let i = 0; i < shapes.length; i++) {
      try {
        const res = await fetch(`${base}?dates=${day}${shapes[i]}`, { cache: 'no-store' });
        if (res.headers.get('x-edge-offline') === '1' || !res.ok) continue;
        answered = true;
        const data = await res.json();
        const events = data.events || [];
        events.forEach(e => {
          const k = e?.id ?? `noid:${seen.size}`;
          if (!seen.has(k)) seen.set(k, e);
        });
        if (i === 0 && events.length % ESPN_PAGE_SIZE !== 0) break;
      } catch {}
    }
    return answered ? Array.from(seen.values()) : null;
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
  // ── SRS ──
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

    const mean = names.length
      ? names.reduce((acc, n) => acc + rating[n], 0) / names.length
      : 0;
    const out = {};
    names.forEach(n => { out[n] = round(rating[n] - mean, 2); });
    return out;
  }

  // ============================================================
  // ── ELO ──
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

    // Composite points from rating-core are in the sport's own
    // margin units. The per-sport multiplier maps that onto the
    // 0-100 display scale so a top MLB team and a top NFL team
    // end up in the same numeric range.
    const compositePoints = adjusted.blended?.composite_points;
    const overall = composeOverall(sport, { compositePoints, pyth, offense, defense, mov });

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

      srs: adjusted.srs ?? round(avgMOV, 2),
      elo: adjusted.elo ?? 1500,

      massey: adjusted.massey ?? null,
      glicko_rating: adjusted.glicko ? adjusted.glicko.rating : null,
      glicko_rd: adjusted.glicko ? adjusted.glicko.rd : null,
      glicko_vol: adjusted.glicko ? adjusted.glicko.vol : null,
      glicko_conservative: adjusted.glicko ? adjusted.glicko.conservative : null,
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
      _coach_adj: 0,
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

  // Coach adjustment in points. A coach at 75 with maxAdj 3.5
  // shifts the model by +1.75. A coach at 25 shifts by -1.75.
  // Average coach, zero shift.
  function coachAdjustmentPoints(sport, coach) {
    if (!coach || coach.overall == null) return 0;
    const cfg = COACHING_WEIGHTS[sport] || COACHING_WEIGHTS.DEFAULT;
    const max = coach.max_adjustment ?? cfg.maxAdj;
    const deviation = (coach.overall - 50) / 50;
    return round(deviation * max, 2);
  }

  async function computeTeamRating(sport, teamName, teamId, espnEvents) {
    const usable = (espnEvents || []).filter(isRegularSeason);
    const { teamMap, chronological } = buildTeamStates(sport, usable);
    const state = teamMap.get(teamName);
    if (!state) return null;
    const srsMap = computeSRS(sport, teamMap);
    const eloMap = computeElo(sport, chronological);
    return buildRating(sport, teamName, state, { srs: srsMap[teamName], elo: eloMap[teamName] });
  }

  async function computeCoachingRating(sport, teamName, teamId, espnEvents) {
    const usable = (espnEvents || []).filter(isRegularSeason);
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
      NFL: 0.06, NBA: 0.08, WNBA: 0.08, MLB: 0.02, NHL: 0.015,
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
        homeAdvantage: calib?.home_advantage ?? null,
      });
      if (projection) modelSpread = projection.model_spread;
    }

    const projectionSpread = modelSpread;
    const homePts = homeStats.composite_points;
    const awayPts = awayStats.composite_points;
    const compositeSpread = (homePts != null && awayPts != null)
      ? round(-((homePts - awayPts) + (core?.HOME_POINTS?.[sport] ?? 2)), 2)
      : null;

    // Early in a season the projection rests on a handful of games.
    // It is blended with the composite spread in proportion to the
    // fewer games either team has played, reaching the projection
    // alone at PROJECTION_FULL_GAMES.
    let projectionWeight = null;
    if (projectionSpread != null && compositeSpread != null) {
      const gH = Number(homeStats.games_played);
      const gA = Number(awayStats.games_played);
      if (isFinite(gH) && isFinite(gA)) {
        projectionWeight = clamp(Math.min(gH, gA) / (PROJECTION_FULL_GAMES[sport] ?? 10), 0, 1);
        modelSpread = round(projectionWeight * projectionSpread + (1 - projectionWeight) * compositeSpread, 2);
      }
    }

    if (modelSpread === null) {
      if (compositeSpread != null) {
        modelSpread = compositeSpread;
      } else {
        const ratingDelta = homeStats.overall - awayStats.overall;
        const spreadConv = {
          NFL: -0.28, NBA: -0.28, WNBA: -0.28, MLB: -0.08, NHL: -0.05,
          NCAAF: -0.30, NCAAB: -0.28, MLS: -0.05,
        }[sport] || -0.28;
        modelSpread = round(ratingDelta * spreadConv, 2);
      }
    }

    const coachAdj = homeStats._coach_adj ?? (
      homeStats._coach ? coachAdjustmentPoints(sport, homeStats._coach) : 0
    );
    const coachAdjAway = awayStats._coach_adj ?? (
      awayStats._coach ? coachAdjustmentPoints(sport, awayStats._coach) : 0
    );
    const coachDelta = coachAdj - coachAdjAway;

    const totalModelSpread = round(
      modelSpread + (coachDelta * -1) + (defenseMatchup.adjustment_points * -1),
      2
    );

    const rawEdge = marketSpread !== null ? round(marketSpread - totalModelSpread, 2) : 0;

    const probShiftPerPoint = {
      NFL: 0.028, NBA: 0.032, WNBA: 0.032, MLB: 0.040, NHL: 0.035,
      NCAAF: 0.028, NCAAB: 0.032, MLS: 0.040,
    }[sport] || 0.030;

    let priorHomeProb = clamp(0.5 + (rawEdge * probShiftPerPoint), 0.05, 0.95);

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
      coaching: {
        home_adjustment: coachAdj,
        away_adjustment: coachAdjAway,
        delta: round(coachDelta, 2),
      },
      model_spread: totalModelSpread,
      projection,

      projection_spread: projectionSpread,
      composite_spread: compositeSpread,
      projection_weight: projectionWeight != null ? round(projectionWeight, 2) : null,

      // Cover chance from the same blended margin as model_spread.
      cover: (core && projection && marketSpread !== null)
        ? core.coverProbability(-modelSpread, marketSpread,
            calib?.sigma_settled ?? calib?.projection_sigma ?? null,
            {
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
  // ============================================================

  // regularOnly defaults to true. ats-tracker passes false to
  // capture playoff games into historical_odds without
  // inflating team ratings.
  async function fetchGamesBetween(sport, startDate, endDate, options = {}) {
    const path = ESPN_MAP[sport];
    if (!path) return [];
    const { raw = false, regularOnly = true } = options;
    const events = await fetchSeasonEvents(sport, path, new Date(startDate), new Date(endDate), regularOnly);
    return raw ? events : parseEvents(sport, events);
  }

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

  function importanceOf(e, comp) {
    const type = e.season?.type ?? comp?.season?.type;
    if (type === 3) return 'playoff';
    if (type === 1) return 'preseason';
    return 'regular';
  }

  // ============================================================
  // ── SEASON CARRY-OVER ──
  // ============================================================

  async function loadCarryover(sport) {
    const url = SUPABASE_URL(), key = SUPABASE_KEY();
    if (!url || !key) return null;

    const season = seasonLabel(sport, new Date());
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

  async function saveCarryover(sport, glickoState, options = {}) {
    const url = SUPABASE_URL(), key = SUPABASE_KEY();
    if (!url || !key) return { ok: false, error: 'Supabase not connected' };
    if (!window.EDGE_RATING) return { ok: false, error: 'rating-core.js not loaded' };

    const { adjustments = {}, forSeason = null } = options;
    const next = forSeason || String(parseInt(seasonLabel(sport, new Date()), 10) + 1);
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

  // ============================================================
  // ── PERSIST ──
  //
  // Two changes from v4.3:
  //
  //   1. Upsert instead of pre-delete. Rows are POSTed with
  //      on_conflict=sport,team_name and merge-duplicates, so
  //      existing rows are updated in place and new ones are
  //      inserted. A failed write no longer leaves the table
  //      empty.
  //
  //   2. Fallback to delete-then-insert when the unique index
  //      is not present. The fallback writes a note to
  //      edge_errors so the operator knows the safe path is
  //      not available yet.
  //
  // The stale-row cleanup still runs at the end, but only for
  // the sports this run touched, so other sports are never
  // wiped.
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

    if (!teamRows.length) {
      report.errors.push('No ratings computed — table left untouched');
      return report;
    }

    const runStamp = new Date().toISOString();
    teamRows.forEach(r => { r.updated_at = runStamp; });
    coachRows.forEach(r => { r.updated_at = runStamp; });

    const sports = Array.from(new Set(teamRows.map(r => r.sport).filter(Boolean)));

    report.teams_written = await replaceTable(
      url, key, 'power_ratings', teamRows, runStamp, sports, report, emit);
    if (coachRows.length) {
      report.coaching_written = await replaceTable(
        url, key, 'coaching_ratings', coachRows, runStamp, sports, report, emit);
    }
    return report;
  }

  async function replaceTable(url, key, table, rows, runStamp, sports, report, emit) {
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

    const sportsFilter = sports.length
      ? `sport=in.(${sports.map(s => `"${s}"`).join(',')})`
      : 'sport=not.is.null';

    // Try the safe upsert path first.
    const upsertResult = await upsertRows(url, key, table, payload, emit);
    let written = 0;

    if (upsertResult.ok) {
      written = upsertResult.written;
      emit(`${table}: ${written} rows upserted`);
    } else if (upsertResult.needsConstraint) {
      // No unique constraint on the table. Fall back to the
      // legacy delete-then-insert pattern so the app still
      // works. Log once so it is easy to find in edge_errors.
      emit(`${table}: no unique (sport, team_name) index — falling back to delete+insert`);
      logEdgeError('powerEngine.replaceTable.noConstraint',
        new Error(`${table}: add a unique index on (sport, team_name) to enable safe writes`));

      // Back up the rows being replaced, so a failed insert puts
      // them back instead of leaving these sports empty.
      let backup = [];
      try {
        const r = await fetch(`${url}/rest/v1/${table}?${sportsFilter}&select=*&limit=1000`, {
          headers: { apikey: key, Authorization: `Bearer ${key}` },
        });
        if (r.ok) backup = await r.json();
      } catch {}

      try {
        await fetch(`${url}/rest/v1/${table}?${sportsFilter}`, {
          method: 'DELETE',
          headers: { apikey: key, Authorization: `Bearer ${key}` },
        });
      } catch {}

      written = await insertRows(url, key, table, payload, report, emit);
      emit(`${table}: ${written} rows written (delete+insert)`);

      if (written < payload.length && backup.length) {
        await fetch(`${url}/rest/v1/${table}?${sportsFilter}`, {
          method: 'DELETE', headers: { apikey: key, Authorization: `Bearer ${key}` },
        }).catch(() => {});
        const restoreRows = backup.map(({ id, ...rest }) => rest);
        const restored = await insertRows(url, key, table, restoreRows, report, emit);
        report.errors.push(`${table}: insert incomplete — restored ${restored} previous rows`);
        emit(`${table}: insert incomplete — previous rows restored`);
        return 0;
      }
    } else {
      report.errors.push(`${table}: ${upsertResult.error}`);
      emit(`${table}: write rejected — existing rows left in place`);
      return 0;
    }

    // Drop anything for the current sports that this run did
    // not touch. Only current sports are affected — other
    // sports' rows are never in the filter.
    // Clear rows this run did not write, only when every row landed.
    if (written < payload.length) {
      emit(`${table}: ${payload.length - written} rows not written — previous rows kept`);
      return written;
    }

    try {
      await fetch(
        `${url}/rest/v1/${table}?${sportsFilter}&updated_at=neq.${encodeURIComponent(runStamp)}`,
        {
          method: 'DELETE',
          headers: { apikey: key, Authorization: `Bearer ${key}` },
        }
      );
    } catch (e) {
      report.errors.push(`${table}: stale rows not cleared for current sports (${e.message})`);
    }

    return written;
  }

  async function upsertRows(url, key, table, payload, emit) {
    const headers = {
      apikey: key, Authorization: `Bearer ${key}`,
      'Content-Type': 'application/json',
      Prefer: 'resolution=merge-duplicates,return=minimal',
    };

    const chunkSize = 200;
    let written = 0;

    for (let i = 0; i < payload.length; i += chunkSize) {
      const slice = payload.slice(i, i + chunkSize);
      let attempt = 0;
      let ok = false;
      let lastStatus = 0;
      let lastBody = '';

      while (attempt < 3 && !ok) {
        try {
          const res = await fetch(
            `${url}/rest/v1/${table}?on_conflict=sport,team_name`,
            { method: 'POST', headers, body: JSON.stringify(slice) }
          );
          lastStatus = res.status;

          if (res.ok) { written += slice.length; ok = true; break; }

          const txt = await res.text().catch(() => '');
          lastBody = txt;

          // Postgres says the ON CONFLICT clause cannot be
          // satisfied. Means there is no matching unique index.
          if (res.status === 400 && /there is no unique or exclusion constraint/i.test(txt)) {
            return { ok: false, needsConstraint: true };
          }

          // Postgres says a column is missing. Emit a
          // suggestion and stop so the operator sees it.
          if (res.status === 400 && /column .* does not exist/i.test(txt)) {
            return { ok: false, error: `${table}: HTTP 400 ${txt.slice(0, 160)}` };
          }
        } catch (e) {
          lastBody = e.message;
        }
        attempt++;
        if (!ok) await new Promise(r => setTimeout(r, 400 * attempt));
      }

      if (!ok) {
        return {
          ok: false,
          error: `${table}: chunk ${i} HTTP ${lastStatus} ${String(lastBody).slice(0, 160)}`,
        };
      }
    }

    return { ok: true, written };
  }

  async function insertRows(url, key, table, payload, report, emit) {
    const headers = {
      apikey: key, Authorization: `Bearer ${key}`,
      'Content-Type': 'application/json',
      Prefer: 'return=minimal',
    };

    const chunkSize = 200;
    let written = 0;

    for (let i = 0; i < payload.length; i += chunkSize) {
      const slice = payload.slice(i, i + chunkSize);
      let ok = false;
      let attempt = 0;

      while (attempt < 3 && !ok) {
        try {
          const res = await fetch(`${url}/rest/v1/${table}`, {
            method: 'POST', headers, body: JSON.stringify(slice),
          });
          if (res.ok) { written += slice.length; ok = true; break; }
          const txt = await res.text().catch(() => '');
          emit(`${table}: insert chunk ${i} attempt ${attempt + 1}: HTTP ${res.status} ${txt.slice(0, 140)}`);
        } catch (e) {
          emit(`${table}: insert chunk ${i} attempt ${attempt + 1}: ${e.message}`);
        }
        attempt++;
        if (!ok) await new Promise(r => setTimeout(r, 400 * attempt));
      }
    }

    return written;
  }

  async function discoverColumns(url, key, table) {
    const headers = { apikey: key, Authorization: `Bearer ${key}` };

    try {
      const res = await fetch(`${url}/rest/v1/`, { headers });
      if (res.ok) {
        const spec = await res.json();
        const def = spec?.definitions?.[table] || spec?.components?.schemas?.[table];
        const props = def?.properties;
        if (props && Object.keys(props).length) return new Set(Object.keys(props));
      }
    } catch {}

    try {
      const res = await fetch(`${url}/rest/v1/${table}?select=*&limit=1`, { headers });
      if (res.ok) {
        const rows = await res.json();
        if (rows.length) return new Set(Object.keys(rows[0]));
      }
    } catch {}

    return null;
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

  function logEdgeError(where, err) {
    try {
      const list = JSON.parse(localStorage.getItem('edge_errors') || '[]');
      list.unshift({ t: Date.now(), where, msg: err && err.message ? err.message : String(err) });
      localStorage.setItem('edge_errors', JSON.stringify(list.slice(0, 50)));
    } catch {}
  }

  function clamp(v, min, max) { return Math.max(min, Math.min(max, v)); }
  function round(v, d) { const f = Math.pow(10, d); return Math.round(v * f) / f; }
  // ESPN's ?dates= is the US Eastern date. The phone's local date
  // is a day off near midnight anywhere outside Eastern time.
  function fmtDate(d) {
    if (window.EDGE_TIME) return window.EDGE_TIME.espnDate(d);
    try {
      return new Intl.DateTimeFormat('en-CA', {
        timeZone: 'America/New_York', year: 'numeric', month: '2-digit', day: '2-digit',
      }).format(d).replace(/-/g, '');
    } catch {
      const y = d.getFullYear();
      const m = String(d.getMonth() + 1).padStart(2, '0');
      const day = String(d.getDate()).padStart(2, '0');
      return `${y}${m}${day}`;
    }
  }

})();

if (typeof window !== 'undefined') window.EDGE_POWER = EDGE_POWER;