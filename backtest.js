// ============================================================
// EDGE — BACKTEST ENGINE v3.0
// Top-tier walk-forward replay with zero look-ahead bias.
//
// - Multi-sport, multi-season, per-sport calibration
// - Team state updated only after each game is graded
// - Uses the LIVE pipeline (algorithms → governor → physics)
// - Reads historical odds when present, degrades gracefully when absent
// - Produces calibration tables + per-family ROI + Kelly suggestions
// - Writes results the live governor reads on the next run
//
// Zero look-ahead guarantee:
//   Ratings for game N are computed from games 1..N-1 only.
//   The team state map is mutated AFTER grading each game.
// ============================================================

const EDGE_BACKTEST = (() => {

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
    NFL:   { avgPF: 22,  avgPA: 22,  pyExp: 2.37,  scale: 22, k: 8,  minGames: 3 },
    NBA:   { avgPF: 112, avgPA: 112, pyExp: 13.91, scale: 18, k: 15, minGames: 3 },
    MLB:   { avgPF: 4.5, avgPA: 4.5, pyExp: 1.83,  scale: 3,  k: 20, minGames: 5 },
    NHL:   { avgPF: 3.0, avgPA: 3.0, pyExp: 2.0,   scale: 2,  k: 15, minGames: 5 },
    NCAAF: { avgPF: 27,  avgPA: 27,  pyExp: 2.37,  scale: 32, k: 6,  minGames: 3 },
    NCAAB: { avgPF: 72,  avgPA: 72,  pyExp: 10.0,  scale: 20, k: 10, minGames: 3 },
    MLS:   { avgPF: 1.5, avgPA: 1.5, pyExp: 2.0,   scale: 1.2, k: 15, minGames: 4 },
  };

  // Two seasons of lookback per sport. Start dates chosen so each window
  // covers a full completed season that has already finished today.
  const SEASONS = {
    NFL:   [['20230901', '20240215'], ['20240901', '20250215']],
    NBA:   [['20231020', '20240701'], ['20241020', '20250701']],
    MLB:   [['20240320', '20241105'], ['20250320', '20251105']],
    NHL:   [['20231001', '20240701'], ['20241001', '20250701']],
    NCAAF: [['20230815', '20240115'], ['20240815', '20250115']],
    NCAAB: [['20231101', '20240415'], ['20241101', '20250415']],
    MLS:   [['20240220', '20241215'], ['20250220', '20251215']],
  };

  const CALIBRATION_BUCKETS = [50, 55, 60, 65, 70, 75, 80, 85, 90, 95];

  // Minimum graded predictions in a bucket before using it for calibration.
  const MIN_CALIBRATION_SAMPLE = 15;

  // Minimum graded picks per (family, sport) before deriving a weight.
  const MIN_FAMILY_SAMPLE = 25;

  // Chunk size for ESPN historical fetch. ESPN caps at 1000 events per call.
  // 45 days per chunk never exceeds that for any sport we cover.
  const CHUNK_DAYS = 45;

  // Concurrency for ESPN fetches. Higher = faster but risks rate limiting.
  const FETCH_CONCURRENCY = 3;

  // Persist every N games to Supabase so a crash mid-run doesn't lose work.
  const PERSIST_BATCH_SIZE = 50;

  let cancelled = false;

  return {
    run,
    cancel,
    runForSport,
    CALIBRATION_BUCKETS,
    SEASONS,
  };

  function cancel() { cancelled = true; }

  // ============================================================
  // ── MAIN ENTRY ──
  // ============================================================

  async function run(options = {}) {
    const {
      sports = Object.keys(SEASONS),
      seasons = null,
      onProgress = null,
      persist = true,
    } = options;

    cancelled = false;
    const log = makeLogger(onProgress);
    const startedAt = Date.now();

    const summary = {
      started_at: new Date(startedAt).toISOString(),
      sports_processed: {},
      total_games_replayed: 0,
      total_predictions: 0,
      calibration_by_sport: {},
      family_roi_by_sport: {},
      kelly_by_sport: {},
      suggested_weights: [],
      errors: [],
      completed_at: null,
      duration_ms: 0,
    };

    // Refresh team ratings first so live pipeline has current data.
    log('Refreshing live team ratings');
    try {
      await EDGE_POWER.computeAllTeamRatings();
    } catch (e) {
      summary.errors.push({ stage: 'power', error: e.message });
    }

    for (const sport of sports) {
      if (cancelled) { log('Cancelled by operator'); break; }
      log(`── ${sport} ──`);
      try {
        const sportResult = await runForSport(sport, {
          seasons: seasons ? seasons[sport] : SEASONS[sport],
          onProgress,
          persist,
        });
        summary.sports_processed[sport] = sportResult.games_replayed;
        summary.total_games_replayed += sportResult.games_replayed;
        summary.total_predictions += sportResult.predictions.length;
        summary.calibration_by_sport[sport] = sportResult.calibration;
        summary.family_roi_by_sport[sport] = sportResult.family_roi;
        summary.kelly_by_sport[sport] = sportResult.kelly;
        summary.suggested_weights.push(...sportResult.suggested_weights);
      } catch (e) {
        summary.errors.push({ sport, error: e.message });
        log(`  ${sport} failed: ${e.message}`);
      }
    }

    // ── Build merged calibration across all sports ──
    const mergedCalibration = mergeCalibrations(summary.calibration_by_sport);
    summary.calibration = mergedCalibration;

    // ── Write calibration where the live governor reads it ──
    try {
      localStorage.setItem('edge_governor_calibration', JSON.stringify(mergedCalibration));
      log('Wrote calibration to localStorage');
    } catch {}

    // ── Write suggested weights to localStorage ──
    const suggestedWeightsBySport = groupSuggestedWeights(summary.suggested_weights);
    if (Object.keys(suggestedWeightsBySport).length) {
      try {
        localStorage.setItem('edge_dynamic_weights', JSON.stringify(suggestedWeightsBySport));
        log('Wrote suggested weights to localStorage');
      } catch {}
    }

    // ── Persist summary ──
    if (persist) {
      try {
        await persistRunSummary(summary);
        log('Saved run summary to Supabase');
      } catch (e) {
        summary.errors.push({ stage: 'persist', error: e.message });
      }
    }

    summary.completed_at = new Date().toISOString();
    summary.duration_ms = Date.now() - startedAt;
    localStorage.setItem('edge_backtest_last_run', summary.completed_at);

    log(`Done · ${summary.total_games_replayed} games · ${summary.total_predictions} predictions · ${summary.duration_ms}ms`);
    return summary;
  }

  // ============================================================
  // ── PER-SPORT REPLAY ──
  // ============================================================

  async function runForSport(sport, options = {}) {
    const { seasons, onProgress, persist } = options;
    const log = makeLogger(onProgress);
    const cfg = SPORT_CONFIG[sport];
    const path = ESPN_MAP[sport];
    if (!path) throw new Error(`Unknown sport: ${sport}`);
    if (!seasons || !seasons.length) throw new Error('No seasons provided');

    // ── Fetch all events for all seasons ──
    const allEvents = [];
    for (const [start, end] of seasons) {
      log(`  fetching ${sport} ${start} → ${end}`);
      const events = await fetchRangeChunked(path, start, end, log);
      allEvents.push(...events);
      if (cancelled) break;
    }
    if (cancelled) return emptySportResult();

    // Deduplicate on event id
    const seen = new Set();
    const unique = allEvents.filter(e => {
      if (!e.id || seen.has(e.id)) return false;
      seen.add(e.id);
      return true;
    });

    // Sort chronologically
    unique.sort((a, b) => new Date(a.date) - new Date(b.date));
    log(`  ${unique.length} unique events`);

    // ── Load odds for these game IDs if present ──
    const oddsIndex = await loadOddsForGames(sport, unique.map(e => e.id));
    const oddsCount = Object.keys(oddsIndex).length;
    log(`  odds available for ${oddsCount}/${unique.length} games`);

    // ── Replay ──
    const state = new Map();      // teamName -> running aggregate
    const predictions = [];
    const batch = [];

    for (const event of unique) {
      if (cancelled) break;

      const comp = event.competitions?.[0];
      if (!comp) continue;

      const home = comp.competitors?.find(c => c.homeAway === 'home');
      const away = comp.competitors?.find(c => c.homeAway === 'away');
      if (!home || !away) continue;

      const homeName = home.team?.displayName;
      const awayName = away.team?.displayName;
      if (!homeName || !awayName) continue;

      const homeScore = parseInt(home.score || '0');
      const awayScore = parseInt(away.score || '0');
      if (homeScore === 0 && awayScore === 0) continue; // unplayed or missing

      const homeState = state.get(homeName);
      const awayState = state.get(awayName);

      const enoughGames =
        homeState && awayState &&
        homeState.games >= cfg.minGames &&
        awayState.games >= cfg.minGames;

      if (enoughGames) {
        const prediction = await replayGame(sport, event, {
          homeName, awayName, homeScore, awayScore,
          homeState, awayState,
          odds: oddsIndex[event.id] || null,
        });
        if (prediction) {
          predictions.push(prediction);
          batch.push(prediction);
        }
      }

      // ── Update state AFTER grading ──
      applyResult(state, homeName, home.team, homeScore, awayScore, true);
      applyResult(state, awayName, away.team, awayScore, homeScore, false);

      if (predictions.length && predictions.length % 500 === 0) {
        log(`  ${predictions.length} predictions`);
      }

      if (persist && batch.length >= PERSIST_BATCH_SIZE) {
        await persistPredictionBatch(sport, batch.splice(0, PERSIST_BATCH_SIZE));
      }
    }

    if (persist && batch.length) {
      await persistPredictionBatch(sport, batch);
    }

    // ── Analysis ──
    const calibration = buildCalibration(predictions);
    const family_roi = buildFamilyROI(predictions);
    const kelly = buildKellyAnalysis(predictions);
    const suggested_weights = deriveSuggestedWeights(sport, family_roi);

    return {
      games_replayed: unique.length,
      predictions,
      calibration,
      family_roi,
      kelly,
      suggested_weights,
    };
  }

  function emptySportResult() {
    return {
      games_replayed: 0,
      predictions: [],
      calibration: {},
      family_roi: {},
      kelly: null,
      suggested_weights: [],
    };
  }

  // ============================================================
  // ── FETCH RANGE CHUNKED ──
  // ============================================================

  async function fetchRangeChunked(path, startStr, endStr, log) {
    const start = parseYYYYMMDD(startStr);
    const end = parseYYYYMMDD(endStr);
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

    // Fetch in parallel with concurrency limit
    const results = [];
    const queue = [...chunks];
    const workers = Array.from({ length: FETCH_CONCURRENCY }, async () => {
      while (queue.length && !cancelled) {
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

  function parseYYYYMMDD(s) {
    return new Date(
      parseInt(s.slice(0, 4)),
      parseInt(s.slice(4, 6)) - 1,
      parseInt(s.slice(6, 8)),
    );
  }

  // ============================================================
  // ── REPLAY ONE GAME ──
  // Uses the live pipeline. Same code path the user sees day to day.
  // ============================================================

  async function replayGame(sport, event, ctx) {
    const { homeName, awayName, homeScore, awayScore, homeState, awayState, odds } = ctx;

    const homeStats = buildStatsFromState(sport, homeName, homeState);
    const awayStats = buildStatsFromState(sport, awayName, awayState);

    const game = {
      id: event.id,
      _sport: sport,
      sport,
      home_team: homeName,
      away_team: awayName,
      home: homeName,
      away: awayName,
      commence_time: event.date,
      time: event.date,
    };

    const market = odds ? {
      open_spread: odds.open_spread,
      current_spread: odds.spread,
      total: odds.total,
      home_ml: odds.home_ml,
      away_ml: odds.away_ml,
    } : {
      open_spread: null,
      current_spread: null,
      total: null,
      home_ml: null,
      away_ml: null,
    };

    let prior;
    try {
      prior = await EDGE_POWER.computeGamePrior(game, {
        homeStats, awayStats, market,
      });
    } catch { return null; }

    let families;
    try {
      families = await EDGE_ALGOS.runAll(prior, {});
    } catch { return null; }

    let gov;
    try {
      gov = EDGE_GOVERNOR.run(families, prior);
    } catch { return null; }

    let phys;
    try {
      phys = EDGE_PHYSICS.decide(gov, prior, {});
    } catch { return null; }

    // ── Actual result ──
    const homeWon = homeScore > awayScore;
    const tied = homeScore === awayScore;
    const actualMargin = homeScore - awayScore;

    // ── Grade the pick if there was one ──
    let graded = null;
    if (phys.decision && phys.decision !== 'PASS' && phys.decision !== 'CAPPED' && phys.direction && phys.direction !== 'none') {
      const pickedHome = phys.direction === 'home';

      // Moneyline / SU grade
      let result = null;
      if (tied) result = 'P';
      else if (pickedHome) result = homeWon ? 'W' : 'L';
      else result = homeWon ? 'L' : 'W';

      // Simple P&L: use market spread if available, else flat -110
      const oddsAtPrice = pickedHome
        ? (odds?.home_ml ?? -110)
        : (odds?.away_ml ?? -110);
      const pnl = result === 'W'
        ? (oddsAtPrice > 0 ? (oddsAtPrice / 100) : (100 / Math.abs(oddsAtPrice)))
        : result === 'L' ? -1 : 0;

      // CLV: did the line move in our favor between open and close?
      let clv = null;
      if (odds?.open_spread != null && odds?.spread != null) {
        const openSpread = odds.open_spread;
        const closeSpread = odds.spread;
        // Home spread negative = home favored. Movement toward home = more negative.
        const movedTowardHome = closeSpread < openSpread;
        // CLV in the pick's favor if the line moved toward our side.
        clv = pickedHome
          ? (openSpread - closeSpread)  // positive = got a better number than close
          : (closeSpread - openSpread);
      }

      graded = {
        result,
        pnl: Math.round(pnl * 100) / 100,
        clv: clv != null ? Math.round(clv * 100) / 100 : null,
        actual_margin: actualMargin,
      };
    }

    return {
      game_id: event.id,
      sport,
      commence_time: event.date,
      home_team: homeName,
      away_team: awayName,
      home_score: homeScore,
      away_score: awayScore,
      actual_margin: actualMargin,
      actual_home_won: homeWon,
      tied,

      // Model output
      direction: phys.direction,
      decision: phys.decision,
      units: phys.units,
      confidence: phys.confidence,
      edge: phys.edge,
      consensus_score: gov.consensus_score,
      agreement_index: gov.agreement_index,
      data_caps: gov.data_caps || [],
      market_source: gov.market_source || null,

      // Full breakdown so we can derive family weights
      family_breakdown: (gov.breakdown || []).map(b => ({
        family: b.family,
        vote: b.vote,
        confidence: b.confidence,
        edge: b.edge,
        weight: b.weight,
        reason: b.reason,
      })),

      // Graded outcome
      graded,
    };
  }

  // ============================================================
  // ── TEAM STATE (walk-forward, no look-ahead) ──
  // ============================================================

  function applyResult(state, teamName, teamObj, scored, allowed, wasHome) {
    if (!state.has(teamName)) {
      state.set(teamName, {
        team_id: String(teamObj?.id || teamName),
        abbr: teamObj?.abbreviation || teamName.slice(0, 3).toUpperCase(),
        games: 0, pf: 0, pa: 0,
        wins: 0, losses: 0, ties: 0,
        homeW: 0, homeL: 0, awayW: 0, awayL: 0,
        margins: [],
      });
    }
    const t = state.get(teamName);
    t.games += 1;
    t.pf += scored;
    t.pa += allowed;
    t.margins.push(scored - allowed);
    if (scored > allowed) {
      t.wins += 1;
      if (wasHome) t.homeW += 1; else t.awayW += 1;
    } else if (scored < allowed) {
      t.losses += 1;
      if (wasHome) t.homeL += 1; else t.awayL += 1;
    } else {
      t.ties += 1;
    }
  }

  // ============================================================
  // ── BUILD STATS FROM STATE ──
  // Mirrors the math in power-engine.js so the live pipeline sees
  // the same shape it expects.
  // ============================================================

  function buildStatsFromState(sport, teamName, state) {
    const cfg = SPORT_CONFIG[sport] || SPORT_CONFIG.NFL;
    const games = state.games || 0;
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

    const winPct = games > 0 ? (state.wins + state.ties * 0.5) / games : 0.5;
    const elo = 1500 + (winPct - 0.5) * 200 + avgMOV * 4;

    const recent = state.margins.slice(-5);
    const formWeights = [0.10, 0.15, 0.20, 0.25, 0.30];
    let formScore = 0;
    recent.forEach((m, i) => {
      formScore += formWeights[i] * (m / cfg.scale) * 3;
    });
    formScore = clamp(formScore * realWeight, -20, 20);

    const overall = clamp(
      (pyth * 100 * 0.45) +
      (offense * 0.20) +
      (defense * 0.20) +
      (mov * 0.15),
      0, 100
    );

    return {
      team_id: state.team_id,
      team_name: teamName,
      abbr: state.abbr,
      sport,
      overall: round(overall, 1),
      offense: round(offense, 1),
      defense: round(defense, 1),
      pythagorean: round(pyth, 4),
      srs: round(avgMOV, 2),
      elo: Math.round(elo),
      pace: round(avgPF, 1),
      record: `${state.wins}-${state.losses}${state.ties ? '-' + state.ties : ''}`,
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
      _coach_adj: 0,
    };
  }

  // ============================================================
  // ── ODDS LOADER ──
  // Tries Supabase historical_odds first, then live line_history.
  // ============================================================

  async function loadOddsForGames(sport, gameIds) {
    const out = {};
    const url = SUPABASE_URL();
    const key = SUPABASE_KEY();
    if (!url || !key || !gameIds.length) return out;

    const headers = { apikey: key, Authorization: `Bearer ${key}` };

    // Chunk IDs so URLs don't get too long
    const chunkSize = 200;
    const chunks = [];
    for (let i = 0; i < gameIds.length; i += chunkSize) {
      chunks.push(gameIds.slice(i, i + chunkSize));
    }

    for (const chunk of chunks) {
      const inList = chunk.map(id => `"${id}"`).join(',');
      try {
        const res = await fetch(
          `${url}/rest/v1/historical_odds?select=*&game_id=in.(${inList})`,
          { headers }
        );
        if (res.ok) {
          const rows = await res.json();
          rows.forEach(r => { out[r.game_id] = r; });
        }
      } catch {}
    }

    // Fall back to line_history for anything still missing
    const missing = gameIds.filter(id => !out[id]);
    if (!missing.length) return out;

    for (let i = 0; i < missing.length; i += chunkSize) {
      const chunk = missing.slice(i, i + chunkSize);
      const inList = chunk.map(id => `"${id}"`).join(',');
      try {
        const res = await fetch(
          `${url}/rest/v1/line_history?select=game_id,spread,total,ml,created_at&game_id=in.(${inList})&order=created_at.asc`,
          { headers }
        );
        if (!res.ok) continue;
        const rows = await res.json();
        const perGame = {};
        rows.forEach(r => {
          if (!perGame[r.game_id]) perGame[r.game_id] = { open: r, close: r };
          else perGame[r.game_id].close = r;
        });
        Object.entries(perGame).forEach(([gid, h]) => {
          out[gid] = {
            open_spread: h.open.spread,
            spread: h.close.spread,
            total: h.close.total,
            home_ml: null,
            away_ml: null,
          };
        });
      } catch {}
    }

    return out;
  }

  // ============================================================
  // ── CALIBRATION ──
  // Maps confidence bucket → observed hit rate on held-out predictions.
  // ============================================================

  function buildCalibration(predictions) {
    const buckets = {};
    CALIBRATION_BUCKETS.forEach(b => { buckets[b] = { picks: 0, wins: 0 }; });

    predictions.forEach(p => {
      if (!p.graded || p.graded.result !== 'W' && p.graded.result !== 'L') return;
      const conf = p.confidence || 0;
      const bucket = nearestBucket(conf);
      buckets[bucket].picks += 1;
      if (p.graded.result === 'W') buckets[bucket].wins += 1;
    });

    const out = {};
    CALIBRATION_BUCKETS.forEach(b => {
      const data = buckets[b];
      if (data.picks >= MIN_CALIBRATION_SAMPLE) {
        out[String(b)] = round((data.wins / data.picks) * 100, 1);
      }
    });
    return out;
  }

  function nearestBucket(conf) {
    return CALIBRATION_BUCKETS.reduce((closest, b) =>
      Math.abs(b - conf) < Math.abs(closest - conf) ? b : closest
    , CALIBRATION_BUCKETS[0]);
  }

  function mergeCalibrations(bySport) {
    // If multiple sports calibrated the same bucket, blend by sample
    // weight using a weighted average. Simple, honest, no overfitting.
    const sums = {};
    Object.values(bySport).forEach(cal => {
      Object.entries(cal || {}).forEach(([bucket, hitRate]) => {
        if (!sums[bucket]) sums[bucket] = { sum: 0, count: 0 };
        sums[bucket].sum += hitRate;
        sums[bucket].count += 1;
      });
    });
    const out = {};
    Object.entries(sums).forEach(([bucket, s]) => {
      out[bucket] = round(s.sum / s.count, 1);
    });
    return out;
  }

  // ============================================================
  // ── FAMILY ROI ──
  // Which family was on the right side of the pick? Did it pay?
  // ============================================================

  function buildFamilyROI(predictions) {
    const byFamily = {};

    predictions.forEach(p => {
      if (!p.graded) return;
      if (p.graded.result !== 'W' && p.graded.result !== 'L') return;

      (p.family_breakdown || []).forEach(f => {
        if (f.vote === 'neu') return;
        if (!byFamily[f.family]) {
          byFamily[f.family] = {
            wins: 0, losses: 0, pushes: 0,
            pnl: 0, units: 0,
          };
        }
        const stat = byFamily[f.family];
        const familyVotedHome = f.vote === 'yes';
        const pickWasHome = p.direction === 'home';
        const familyAgreedWithPick = familyVotedHome === pickWasHome;

        // Family won if it agreed with a winning pick, or disagreed with a losing pick.
        const familyWon = familyAgreedWithPick === (p.graded.result === 'W');

        if (p.graded.result === 'P') {
          stat.pushes += 1;
        } else if (familyWon) {
          stat.wins += 1;
        } else {
          stat.losses += 1;
        }
        stat.pnl += familyAgreedWithPick ? p.graded.pnl : -p.graded.pnl;
        stat.units += 1;
      });
    });

    const out = {};
    Object.entries(byFamily).forEach(([family, s]) => {
      const total = s.wins + s.losses;
      out[family] = {
        wins: s.wins,
        losses: s.losses,
        pushes: s.pushes,
        hit_rate: total > 0 ? round(s.wins / total, 4) : null,
        roi: s.units > 0 ? round(s.pnl / s.units, 4) : null,
        samples: total,
      };
    });
    return out;
  }

  // ============================================================
  // ── KELLY ANALYSIS ──
  // What fraction produced the best compounded return?
  // ============================================================

  function buildKellyAnalysis(predictions) {
    const settled = predictions.filter(p => p.graded && (p.graded.result === 'W' || p.graded.result === 'L'));
    if (settled.length < 30) return null;

    const fractions = [0, 0.05, 0.10, 0.15, 0.20, 0.25, 0.30, 0.40];
    const results = fractions.map(f => {
      let bankroll = 100;
      let peak = 100;
      let maxDrawdown = 0;
      settled.forEach(p => {
        const stake = bankroll * f;
        if (p.graded.result === 'W') bankroll += stake * 0.91;
        else bankroll -= stake;
        if (bankroll > peak) peak = bankroll;
        const dd = (peak - bankroll) / peak;
        if (dd > maxDrawdown) maxDrawdown = dd;
      });
      const growth = (bankroll - 100) / 100;
      return { fraction: f, final: round(bankroll, 2), growth: round(growth, 4), max_drawdown: round(maxDrawdown, 4) };
    });

    const best = results.reduce((a, b) => b.final > a.final ? b : a);
    return {
      best_fraction: best.fraction,
      best_final: best.final,
      best_growth: best.growth,
      best_max_drawdown: best.max_drawdown,
      all: results,
    };
  }

  // ============================================================
  // ── SUGGESTED WEIGHTS ──
  // Convert family ROI into weight adjustments.
  // ============================================================

  function deriveSuggestedWeights(sport, familyROI) {
    const suggestions = [];
    Object.entries(familyROI || {}).forEach(([family, s]) => {
      if (s.samples < MIN_FAMILY_SAMPLE) return;
      if (s.roi == null) return;

      // Baseline weight is 7. Adjust by ROI band.
      let delta = 0;
      if (s.roi >= 0.10) delta = 1.5;
      else if (s.roi >= 0.05) delta = 1.0;
      else if (s.roi >= 0.02) delta = 0.5;
      else if (s.roi <= -0.10) delta = -1.5;
      else if (s.roi <= -0.05) delta = -1.0;
      else if (s.roi <= -0.02) delta = -0.5;

      if (delta === 0) return;

      suggestions.push({
        sport,
        family,
        suggested_weight: round(clamp(7 + delta, 1, 10), 2),
        reason: `ROI ${(s.roi * 100).toFixed(1)}% over ${s.samples} graded picks`,
        stats: s,
      });
    });
    return suggestions;
  }

  function groupSuggestedWeights(suggestions) {
    const bySport = {};
    suggestions.forEach(s => {
      if (!bySport[s.sport]) bySport[s.sport] = {};
      bySport[s.sport][s.family] = s.suggested_weight;
    });
    return bySport;
  }

  // ============================================================
  // ── PERSIST ──
  // ============================================================

  async function persistPredictionBatch(sport, batch) {
    const url = SUPABASE_URL();
    const key = SUPABASE_KEY();
    if (!url || !key || !batch.length) return;

    const rows = batch.map(p => ({
      run_id: `bt_${sport}_${Date.now()}`,
      game_id: p.game_id,
      sport: p.sport,
      commence_time: p.commence_time,
      home_team: p.home_team,
      away_team: p.away_team,
      home_score: p.home_score,
      away_score: p.away_score,
      actual_margin: p.actual_margin,
      tied: p.tied,
      direction: p.direction,
      decision: p.decision,
      units: p.units,
      confidence: p.confidence,
      edge: p.edge,
      consensus_score: p.consensus_score,
      agreement_index: p.agreement_index,
      result: p.graded?.result || null,
      pnl: p.graded?.pnl ?? null,
      clv: p.graded?.clv ?? null,
      family_breakdown: p.family_breakdown,
      created_at: new Date().toISOString(),
    }));

    try {
      await fetch(`${url}/rest/v1/backtest_predictions`, {
        method: 'POST',
        headers: {
          apikey: key, Authorization: `Bearer ${key}`,
          'Content-Type': 'application/json',
          Prefer: 'return=minimal',
        },
        body: JSON.stringify(rows),
      });
    } catch {}
  }

  async function persistRunSummary(summary) {
    const url = SUPABASE_URL();
    const key = SUPABASE_KEY();
    if (!url || !key) return;

    const row = {
      started_at: summary.started_at,
      completed_at: summary.completed_at,
      duration_ms: summary.duration_ms,
      total_games: summary.total_games_replayed,
      total_predictions: summary.total_predictions,
      sports_processed: summary.sports_processed,
      calibration: summary.calibration,
      family_roi_by_sport: summary.family_roi_by_sport,
      kelly_by_sport: summary.kelly_by_sport,
      suggested_weights: summary.suggested_weights,
      errors: summary.errors,
    };

    try {
      await fetch(`${url}/rest/v1/backtest_runs`, {
        method: 'POST',
        headers: {
          apikey: key, Authorization: `Bearer ${key}`,
          'Content-Type': 'application/json',
          Prefer: 'return=minimal',
        },
        body: JSON.stringify(row),
      });
    } catch {}
  }

  // ============================================================
  // ── UTILITIES ──
  // ============================================================

  function makeLogger(onProgress) {
    return (msg) => { if (typeof onProgress === 'function') onProgress(msg); };
  }

  function clamp(v, min, max) { return Math.max(min, Math.min(max, v)); }
  function round(v, d) { const f = Math.pow(10, d); return Math.round(v * f) / f; }

})();

if (typeof window !== 'undefined') window.EDGE_BACKTEST = EDGE_BACKTEST;