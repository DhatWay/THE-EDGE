// ============================================================
// EDGE — ORCHESTRATOR v1.0
// Wires the full pipeline end to end.
// Physics always runs. Claude is optional overlay.
// Deterministic mode: physics only.
// AI-assisted mode: physics + Claude batch review.
// Logs every pick to shadow_picks for learning loop.
// ============================================================

const EDGE_ORCHESTRATOR = (() => {

  const MODES = {
    DETERMINISTIC: 'math_only',
    AI_ASSISTED:   'ai_assisted',
  };

  const DEFAULT_MODE = MODES.DETERMINISTIC;

  const SUPABASE_URL = () => localStorage.getItem('edge_supabase_url');
  const SUPABASE_KEY = () => localStorage.getItem('edge_supabase_key');

  // ── CONCURRENCY LIMIT ──
  const MAX_PARALLEL_GAMES = 6;

  // ============================================================
  // ── MAIN ENTRY ──
  // ============================================================

  async function run(options = {}) {
    const {
      mode = getMode(),
      games = null,
      context = {},
      onProgress = null,
      persist = true,
      maxPicks = 10,
      minConfidence = 0,
    } = options;

    const startedAt = Date.now();
    const runId = `run_${startedAt}_${Math.random().toString(36).slice(2, 8)}`;
    const log = makeLogger(onProgress);

    const summary = {
      run_id: runId,
      mode,
      started_at: new Date(startedAt).toISOString(),
      stages: {},
      picks: [],
      errors: [],
      metrics: {},
    };

    try {
      // ── STAGE 1: Load games ──
      log('Stage 1/7 · Loading games');
      const gameList = games || loadTodaysGames();
      if (!gameList.length) {
        summary.errors.push('No games loaded');
        summary.duration_ms = Date.now() - startedAt;
        return summary;
      }
      summary.stages.games_loaded = gameList.length;

      // ── STAGE 2: Power ratings (from cache or compute) ──
      log('Stage 2/7 · Power ratings');
      const powerIndex = await loadPowerIndex();
      summary.stages.teams_rated = Object.keys(powerIndex.teams).length;

      // ── STAGE 3: Compute priors ──
      log('Stage 3/7 · Computing game priors');
      const priors = await buildPriors(gameList, powerIndex);
      summary.stages.priors_built = priors.length;

      // ── STAGE 4: Run algorithms per game ──
      log('Stage 4/7 · Running algorithms');
      const algoResults = await runAlgorithmsParallel(priors, context, MAX_PARALLEL_GAMES, log);
      summary.stages.algo_runs = algoResults.length;

      // ── STAGE 5: Governor ──
      log('Stage 5/7 · Governor consensus');
      const governorResults = runGovernor(algoResults);
      summary.stages.governor_runs = governorResults.length;

      // ── STAGE 6: Physics (always runs) ──
      log('Stage 6/7 · Physics decision layer');
      const physicsResults = runPhysics(governorResults);
      summary.stages.physics_picks = physicsResults.filter(p => p.decision !== 'PASS' && p.decision !== 'CAPPED').length;

      // ── STAGE 7: Claude (AI-assisted only) ──
      let finalResults = physicsResults;
      let claudeReviews = [];

      if (mode === MODES.AI_ASSISTED) {
        log('Stage 7/7 · Claude batch review');
        const batch = buildClaudeBatch(physicsResults, priors, context);
        claudeReviews = await EDGE_CLAUDE.reviewBatch(batch, context);
        finalResults = applyClaudeReviews(physicsResults, claudeReviews);

        const cacheRead = claudeReviews.reduce((s, r) => s + (r.usage?.cache_read_input_tokens || 0), 0);
        const cacheWrite = claudeReviews.reduce((s, r) => s + (r.usage?.cache_creation_input_tokens || 0), 0);
        summary.metrics.claude_calls = 1;
        summary.metrics.claude_cache_read_tokens = cacheRead;
        summary.metrics.claude_cache_write_tokens = cacheWrite;
      } else {
        log('Stage 7/7 · Skipped (deterministic mode)');
        summary.metrics.claude_calls = 0;
      }

      // ── FILTER + RANK ──
      const picks = finalResults
        .filter(p => p.decision !== 'PASS' && p.decision !== 'CAPPED' && p.decision !== 'VETOED')
        .filter(p => p.confidence >= minConfidence)
        .sort((a, b) => {
          if (b.confidence !== a.confidence) return b.confidence - a.confidence;
          return Math.abs(b.edge) - Math.abs(a.edge);
        })
        .slice(0, maxPicks);

      summary.picks = picks;
      summary.stages.final_picks = picks.length;

      // ── PERSIST ──
      if (persist && picks.length) {
        log('Persisting shadow picks');
        await persistShadowPicks(picks, priors, mode, runId);
      }

      summary.completed_at = new Date().toISOString();
      summary.duration_ms = Date.now() - startedAt;
      log(`Done · ${picks.length} picks · ${summary.duration_ms}ms`);
      return summary;

    } catch (err) {
      summary.errors.push(err.message);
      summary.completed_at = new Date().toISOString();
      summary.duration_ms = Date.now() - startedAt;
      log(`Error: ${err.message}`);
      return summary;
    }
  }

  // ============================================================
  // ── STAGE 2: POWER INDEX ──
  // ============================================================

  async function loadPowerIndex() {
    // Try Supabase first
    const url = SUPABASE_URL();
    const key = SUPABASE_KEY();
    if (url && key) {
      try {
        const [teamsRes, coachesRes] = await Promise.all([
          fetch(`${url}/rest/v1/power_ratings?select=*`, { headers: { apikey: key, Authorization: `Bearer ${key}` } }),
          fetch(`${url}/rest/v1/coaching_ratings?select=*`, { headers: { apikey: key, Authorization: `Bearer ${key}` } }),
        ]);
        if (teamsRes.ok && coachesRes.ok) {
          const teams = await teamsRes.json();
          const coaches = await coachesRes.json();
          if (teams.length) {
            const index = { teams: {}, coaching: {} };
            teams.forEach(t => { index.teams[`${t.sport}:${t.team_name}`] = t; });
            coaches.forEach(c => { index.coaching[`${c.sport}:${c.team_name}`] = c; });
            return index;
          }
        }
      } catch {}
    }

    // Fallback: compute fresh
    const fresh = await EDGE_POWER.computeAllTeamRatings();
    return { teams: fresh.teams, coaching: fresh.coaching };
  }

  // ============================================================
  // ── STAGE 3: BUILD PRIORS ──
  // ============================================================

  async function buildPriors(games, powerIndex) {
    const priors = [];

    for (const game of games) {
      const sport = game._sport || game.sport;
      const homeKey = `${sport}:${game.home_team || game.home}`;
      const awayKey = `${sport}:${game.away_team || game.away}`;

      const homeStats = powerIndex.teams[homeKey];
      const awayStats = powerIndex.teams[awayKey];

      if (!homeStats || !awayStats) continue;

      // Attach coaching to power object for algorithms
      const homeCoach = powerIndex.coaching[homeKey];
      const awayCoach = powerIndex.coaching[awayKey];

      const homePower = { ...homeStats, _coach: homeCoach || null };
      const awayPower = { ...awayStats, _coach: awayCoach || null };

      try {
        const prior = await EDGE_POWER.computeGamePrior(game, {
          homeStats: homePower,
          awayStats: awayPower,
          market: {
            open_spread: game.open_spread ?? null,
            current_spread: game.spread ?? null,
            total: game.total ?? null,
            home_ml: game.ml ?? null,
            away_ml: game.away_ml ?? null,
          },
        });
        prior._raw_game = game;
        priors.push(prior);
      } catch (e) {
        // Skip malformed games silently
      }
    }

    return priors;
  }

  // ============================================================
  // ── STAGE 4: ALGORITHMS (parallel, throttled) ──
  // ============================================================

  async function runAlgorithmsParallel(priors, context, concurrency, log) {
    const results = [];
    const queue = [...priors];
    let done = 0;

    async function worker() {
      while (queue.length) {
        const prior = queue.shift();
        if (!prior) break;
        try {
          const gameContext = buildGameContext(prior, context);
          const families = await EDGE_ALGOS.runAll(prior, gameContext);
          results.push({ prior, families });
        } catch (e) {
          results.push({ prior, families: [], error: e.message });
        }
        done++;
        if (done % 10 === 0) log(`  Algorithms: ${done}/${priors.length}`);
      }
    }

    const workers = Array.from({ length: Math.min(concurrency, priors.length) }, worker);
    await Promise.all(workers);
    return results;
  }

  function buildGameContext(prior, sharedContext) {
    const ctx = { ...sharedContext };
    const game = prior._raw_game || {};

    // Line history keyed by game id
    if (sharedContext.lineHistoryByGame?.[prior.game_id]) {
      ctx.lineHistory = sharedContext.lineHistoryByGame[prior.game_id];
    }

    // Weather
    if (sharedContext.weatherByGame?.[prior.game_id]) {
      ctx.weather = sharedContext.weatherByGame[prior.game_id];
    }

    // Injuries
    if (sharedContext.injuriesByGame?.[prior.game_id]) {
      const inj = sharedContext.injuriesByGame[prior.game_id];
      ctx.homeInjuries = inj.home || [];
      ctx.awayInjuries = inj.away || [];
    }

    // Rest days
    if (sharedContext.restByTeam) {
      ctx.homeRestDays = sharedContext.restByTeam[`${prior.sport}:${prior.home_team}`] ?? null;
      ctx.awayRestDays = sharedContext.restByTeam[`${prior.sport}:${prior.away_team}`] ?? null;
    }

    // Travel
    if (sharedContext.travelByGame?.[prior.game_id]) {
      ctx.travelMiles = sharedContext.travelByGame[prior.game_id].miles ?? null;
      ctx.timezoneShift = sharedContext.travelByGame[prior.game_id].timezones ?? null;
    }

    // Hours to game (for steam detection)
    if (prior.commence_time) {
      ctx.hoursToGame = Math.max(0, (new Date(prior.commence_time) - Date.now()) / 3600000);
    }

    return ctx;
  }

  // ============================================================
  // ── STAGE 5: GOVERNOR ──
  // ============================================================

  function runGovernor(algoResults) {
    return algoResults
      .filter(r => r.families && r.families.length)
      .map(r => {
        const gov = EDGE_GOVERNOR.run(r.families, r.prior);
        return { prior: r.prior, families: r.families, governor: gov };
      });
  }

  // ============================================================
  // ── STAGE 6: PHYSICS ──
  // ============================================================

  function runPhysics(governorResults) {
    return governorResults.map(r => {
      const physics = EDGE_PHYSICS.decide(r.governor, r.prior, {
        lineHistory: r.prior?._context?.lineHistory,
      });
      physics.pick_id = makePickId(r.prior);
      physics.game_id = r.prior.game_id;
      physics.sport = r.prior.sport;
      return physics;
    });
  }

  // ============================================================
  // ── STAGE 7: CLAUDE ──
  // ============================================================

  function buildClaudeBatch(physicsResults, priors, sharedContext) {
    const priorById = new Map(priors.map(p => [p.game_id, p]));

    return physicsResults
      .filter(p => p.decision !== 'PASS' && p.decision !== 'CAPPED' && p.units > 0)
      .map(p => {
        const prior = priorById.get(p.game_id);
        const ctx = buildGameContext(prior, sharedContext);
        return {
          pick_id: p.pick_id,
          physics: p,
          prior,
          context: {
            lineHistory: ctx.lineHistory || null,
            weather: ctx.weather || null,
            injuries: {
              home: ctx.homeInjuries || [],
              away: ctx.awayInjuries || [],
            },
          },
        };
      });
  }

  function applyClaudeReviews(physicsResults, claudeReviews) {
    const reviewById = new Map(claudeReviews.map(r => [r.pick_id, r]));

    return physicsResults.map(p => {
      const review = reviewById.get(p.pick_id);
      if (!review) return p;
      return EDGE_PHYSICS.applyClaudeAdjustment(p, review);
    });
  }

  // ============================================================
  // ── PERSIST SHADOW PICKS ──
  // ============================================================

  async function persistShadowPicks(picks, priors, mode, runId) {
    const url = SUPABASE_URL();
    const key = SUPABASE_KEY();
    if (!url || !key) return;

    const priorById = new Map(priors.map(p => [p.game_id, p]));

    const rows = picks.map(p => {
      const prior = priorById.get(p.game_id) || {};
      return {
        run_id: runId,
        game_id: p.game_id,
        sport: p.sport,
        home_team: prior.home_team || null,
        away_team: prior.away_team || null,
        commence_time: prior.commence_time || null,

        decision_mode: mode,
        decision: p.decision,
        direction: p.direction,
        side_team: p.side_label?.team || null,

        confidence: p.confidence,
        edge: p.edge,
        units: p.units,
        stake_dollars: p.stake_dollars,

        governor_snapshot: p.governor_snapshot || null,
        physics_output: p,
        claude_output: p.claude || null,
        reasons: p.reasons || [],

        market_spread: p.market_snapshot?.spread ?? null,
        market_total: p.market_snapshot?.total ?? null,
        market_home_ml: p.market_snapshot?.home_ml ?? null,
        market_away_ml: p.market_snapshot?.away_ml ?? null,

        result: null,
        actual_margin: null,
        clv: null,
        pnl: null,

        created_at: new Date().toISOString(),
      };
    });

    try {
      await fetch(`${url}/rest/v1/shadow_picks`, {
        method: 'POST',
        headers: {
          apikey: key,
          Authorization: `Bearer ${key}`,
          'Content-Type': 'application/json',
          Prefer: 'return=minimal',
        },
        body: JSON.stringify(rows),
      });
    } catch {}
  }

  // ============================================================
  // ── HELPERS ──
  // ============================================================

  function getMode() {
    return localStorage.getItem('edge_decision_mode') || DEFAULT_MODE;
  }

  function setMode(mode) {
    if (mode !== MODES.DETERMINISTIC && mode !== MODES.AI_ASSISTED) return false;
    localStorage.setItem('edge_decision_mode', mode);
    return true;
  }

  function loadTodaysGames() {
    try {
      return JSON.parse(localStorage.getItem('edge_todays_games') || '[]');
    } catch { return []; }
  }

  function makePickId(prior) {
    return `${prior.game_id}_${prior.sport}_${Date.now()}`;
  }

  function makeLogger(onProgress) {
    return (msg) => {
      if (typeof onProgress === 'function') onProgress(msg);
    };
  }

  // ============================================================
  // ── PUBLIC API ──

  return {
    run,
    getMode,
    setMode,
    MODES,
    DEFAULT_MODE,
  };

})();

if (typeof window !== 'undefined') window.EDGE_ORCHESTRATOR = EDGE_ORCHESTRATOR;