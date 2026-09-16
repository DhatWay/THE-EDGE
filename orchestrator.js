// ============================================================
// EDGE — ORCHESTRATOR v2.5
// Passes ATS + H2H trend data through to algorithms so the
// trend family can vote on real form and matchup history.
// ============================================================

const EDGE_ORCHESTRATOR = (() => {

  const MODES = {
    DETERMINISTIC: 'math_only',   // governor decides, Claude never runs
    AI_ASSISTED:   'ai_assisted', // Claude can veto or trim the governor
    AI_LEAD:       'ai_lead',     // Claude selects; governor becomes the shadow
  };
  const DEFAULT_MODE = MODES.DETERMINISTIC;
  const SUPABASE_URL = () => localStorage.getItem('edge_supabase_url');
  const SUPABASE_KEY = () => localStorage.getItem('edge_supabase_key');
  const MAX_PARALLEL_GAMES = 6;

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
      persisted: 0,
      auto_placed: 0,
    };

    try {
      // Family weights are learned from graded results. If this never
      // runs, every cycle uses the same static weights no matter how
      // the families have actually performed.
      // Measured constants, if a backfill has produced any.
      if (typeof EDGE_POWER.loadCalibrationOnce === 'function') {
        try { await EDGE_POWER.loadCalibrationOnce(); } catch {}
      }

      if (window.EDGE_LEARNING && typeof EDGE_LEARNING.runIfDue === 'function') {
        try {
          const learned = await EDGE_LEARNING.runIfDue();
          if (learned?.ran) {
            log(`Stage 0 · Learning loop updated ${learned.families_updated ?? 0} weights`);
            summary.stages.learning = learned;
          }
        } catch (e) { log('Stage 0 · Learning loop failed: ' + e.message); }
      }

      log('Stage 1/7 · Loading games');
      const gameList = games || loadTodaysGames();
      if (!gameList.length) {
        summary.errors.push('No games loaded');
        summary.duration_ms = Date.now() - startedAt;
        return summary;
      }
      summary.stages.games_loaded = gameList.length;

      const activeSports = new Set(gameList.map(g => g._sport || g.sport).filter(Boolean));
      summary.stages.active_sports = Array.from(activeSports);

      log('Stage 2/7 · Power ratings');
      const powerIndex = await loadPowerIndex(activeSports);
      summary.stages.teams_rated = Object.keys(powerIndex.teams).length;

      log('Stage 3/7 · Building context');
      let builtContext = context;
      if (window.EDGE_CONTEXT) {
        builtContext = await EDGE_CONTEXT.buildContext(gameList);

        // Historical trends for the slate. These reach both the trend
        // family and the selector; without this the trends table gets
        // built and then never read by the pipeline.
        if (window.EDGE_TRENDS && typeof EDGE_TRENDS.trendsForSlate === 'function') {
          try { builtContext.trendsByGame = await EDGE_TRENDS.trendsForSlate(gameList); }
          catch { builtContext.trendsByGame = {}; }
        }
        summary.stages.context_loaded = {
          line_history: Object.keys(builtContext.lineHistoryByGame || {}).length,
          rest: Object.keys(builtContext.restByTeam || {}).length,
          travel: Object.keys(builtContext.travelByGame || {}).length,
          weather: Object.keys(builtContext.weatherByGame || {}).length,
          injuries: Object.keys(builtContext.injuriesByGame || {}).length,
          ats: Object.keys(builtContext.atsByTeam || {}).length,
          h2h: Object.keys(builtContext.h2hByGame || {}).length,
          trends: Object.keys(builtContext.trendsByGame || {}).length,
        };
        log(`  Line history: ${summary.stages.context_loaded.line_history} games`);
        log(`  Rest: ${summary.stages.context_loaded.rest} teams`);
        log(`  Travel: ${summary.stages.context_loaded.travel} games`);
        log(`  Weather: ${summary.stages.context_loaded.weather} games`);
        log(`  Injuries: ${summary.stages.context_loaded.injuries} games`);
        log(`  ATS teams: ${summary.stages.context_loaded.ats}`);
        log(`  H2H matchups: ${summary.stages.context_loaded.h2h}`);
      } else {
        log('  context-builder.js not loaded — running with empty context');
      }

      log('Stage 3/7 · Computing game priors');
      const priors = await buildPriors(gameList, powerIndex, builtContext);
      summary.stages.priors_built = priors.length;

      if (!priors.length) {
        summary.errors.push('No priors built — power ratings missing for today\'s teams');
        summary.duration_ms = Date.now() - startedAt;
        return summary;
      }

      log('Stage 4/7 · Running algorithms');
      const algoResults = await runAlgorithmsParallel(priors, builtContext, MAX_PARALLEL_GAMES, log);
      summary.stages.algo_runs = algoResults.length;

      log('Stage 5/7 · Governor consensus');
      const governorResults = runGovernor(algoResults);
      summary.stages.governor_runs = governorResults.length;

      // ── Stage 6 · ADJUDICATE ──
      // What gets bet and on which side is settled here, before any
      // money math. Physics is the money manager, not a second opinion,
      // so it must not run until the verdict is final.
      log('Stage 6/7 · Adjudication (' + mode + ')');

      let claudeResult = { ok: true, selections: [] };
      if (mode === MODES.AI_ASSISTED || mode === MODES.AI_LEAD) {
        const candidates = buildSelectorCandidates(priors, algoResults, governorResults, builtContext);
        log(`  handing ${candidates.length} upcoming games to the selector`);
        claudeResult = await EDGE_CLAUDE.selectFromSlate(candidates, { onProgress: log });
        summary.metrics.claude_calls = claudeResult.ok ? 1 : 0;
        if (!claudeResult.ok) {
          log('  selector unavailable: ' + claudeResult.error);
          summary.errors.push('Claude selector: ' + claudeResult.error);
        } else {
          log(`  selector returned ${claudeResult.selections.length} picks`);
          if (claudeResult.note) log('  note: ' + claudeResult.note);
        }
      } else {
        summary.metrics.claude_calls = 0;
      }

      const adjudicated = adjudicate(governorResults, claudeResult, mode);
      summary.stages.adjudicated = adjudicated.filter(a => a.final.decision !== 'PASS').length;

      // ── Stage 7 · PHYSICS ──
      // Runs on the settled verdict. When Claude leads, physics still
      // sizes the governor's verdict in parallel so the two paths can
      // be graded against each other later.
      log('Stage 7/7 · Physics sizing');
      const finalResults = runPhysicsOn(adjudicated, 'final');
      const shadowResults = runPhysicsOn(adjudicated, 'shadow');
      const shadowById = {};
      shadowResults.forEach(s => { shadowById[s.game_id] = s; });

      finalResults.forEach(p => {
        const a = adjudicated.find(x => x.governor.game_id === p.game_id);
        const shadow = shadowById[p.game_id];
        p.decision_path = a ? a.path : mode;
        p.governor_verdict = a ? slimVerdict(a.governor) : null;
        p.claude_verdict = a ? a.claudeVerdict : null;
        p.shadow_units = shadow ? shadow.units : null;
        p.shadow_decision = shadow ? shadow.decision : null;
      });

      summary.stages.physics_picks = finalResults.filter(
        p => p.decision !== 'PASS' && p.decision !== 'CAPPED').length;

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

      if (persist && picks.length) {
        log('Persisting shadow picks');
        const persistResult = await persistShadowPicks(picks, priors, mode, runId);
        if (persistResult.ok) {
          if (persistResult.skipped) {
            log(`  ✓ 0 new rows · ${persistResult.skipped} already persisted today`);
          } else {
            log(`  ✓ ${persistResult.count} rows written`);
          }
          summary.persisted = persistResult.count || 0;
        } else {
          log(`  ✗ Persist failed: ${persistResult.status || ''} ${persistResult.reason || ''}`);
          summary.errors.push('Persist: ' + (persistResult.reason || 'unknown'));
        }

        const portfolio = localStorage.getItem('edge_active_portfolio') || 'real';
        const bettingMode = localStorage.getItem('edge_betting_mode') || 'manual';

        if (portfolio === 'sim' || bettingMode === 'auto') {
          log(`Auto-placing sim bets (portfolio=${portfolio}, mode=${bettingMode})`);
          const placed = autoPlaceSimBets(picks, portfolio);
          log(`  ✓ ${placed} sim bets placed`);
          summary.auto_placed = placed;
        }
      }

      summary.completed_at = new Date().toISOString();
      summary.duration_ms = Date.now() - startedAt;

      try {
        localStorage.setItem('edge_last_run', JSON.stringify({
          run_id: runId,
          mode,
          completed_at: summary.completed_at,
          picks: picks.map(p => ({
            pick_id: p.pick_id,
            game_id: p.game_id,
            sport: p.sport,
            decision: p.decision,
            direction: p.direction,
            side_team: p.side_label?.team || null,
            home_team: priorFor(priors, p.game_id)?.home_team || null,
            away_team: priorFor(priors, p.game_id)?.away_team || null,
            commence_time: priorFor(priors, p.game_id)?.commence_time || null,
            confidence: p.confidence,
            edge: p.edge,
            units: p.units,
            market_spread: p.market_snapshot?.spread ?? null,
            market_home_ml: p.market_snapshot?.home_ml ?? null,
            market_away_ml: p.market_snapshot?.away_ml ?? null,
            governor_snapshot: p.governor_snapshot || null,
            reasons: p.reasons || [],
          })),
        }));
      } catch {}

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

  // League scoring baselines turn attack and defence rates into points.
  // Derived from the rated teams themselves, so they move with the league.
  function buildLeagueBaselines(teams) {
    const bySport = {};
    (Array.isArray(teams) ? teams : Object.values(teams || {})).forEach(t => {
      if (!t || t.attack == null) return;
      (bySport[t.sport] = bySport[t.sport] || []).push(t);
    });
    const out = {};
    Object.entries(bySport).forEach(([sport, list]) => {
      const rates = list.map(t => t.attack).filter(v => v != null);
      if (!rates.length) return;
      const poss = window.EDGE_RATING?.POSSESSIONS?.[sport] ?? 100;
      const per = rates.reduce((a, b) => a + b, 0) / rates.length;
      out[sport] = { per_possession: per, per_game: per * poss, possessions: poss };
    });
    return out;
  }

  async function loadPowerIndex(activeSports = null) {
    const url = SUPABASE_URL();
    const key = SUPABASE_KEY();

    if (url && key) {
      try {
        const sportsList = activeSports ? Array.from(activeSports) : null;
        const sportFilter = sportsList && sportsList.length
          ? '&sport=in.(' + sportsList.map(s => `"${s}"`).join(',') + ')'
          : '';

        const [teamsRes, coachesRes] = await Promise.all([
          fetch(`${url}/rest/v1/power_ratings?select=*${sportFilter}`, {
            headers: { apikey: key, Authorization: `Bearer ${key}` }
          }),
          fetch(`${url}/rest/v1/coaching_ratings?select=*${sportFilter}`, {
            headers: { apikey: key, Authorization: `Bearer ${key}` }
          }),
        ]);

        if (teamsRes.ok && coachesRes.ok) {
          const teams = await teamsRes.json();
          const coaches = await coachesRes.json();
          if (teams.length) {
            const index = { teams: {}, coaching: {}, league: {} };
            teams.forEach(t => { index.teams[`${t.sport}:${t.team_name}`] = t; });
            coaches.forEach(c => { index.coaching[`${c.sport}:${c.team_name}`] = c; });
            index.league = buildLeagueBaselines(teams);
            return index;
          }
        }
      } catch {}
    }

    const fresh = await EDGE_POWER.computeAllTeamRatings();
    return {
      teams: fresh.teams,
      coaching: fresh.coaching,
      league: buildLeagueBaselines(Object.values(fresh.teams)),
    };
  }

  async function buildPriors(games, powerIndex, context = null) {
    const priors = [];
    const skipped = { live: 0, no_rating: 0, no_spread: 0 };

    // Odds API, ESPN and power_ratings spell the same club differently.
    // Build one resolver index per sport instead of relying on an exact
    // string match, which was dropping 13 of 103 games silently.
    const resolvers = {};
    const resolverFor = (sport) => {
      if (!resolvers[sport]) {
        const teams = {};
        const coaching = {};
        Object.entries(powerIndex.teams).forEach(([k, v]) => {
          if (k.startsWith(sport + ':')) teams[k] = v;
        });
        Object.entries(powerIndex.coaching || {}).forEach(([k, v]) => {
          if (k.startsWith(sport + ':')) coaching[k] = v;
        });
        resolvers[sport] = {
          teams: window.EDGE_TEAMS ? window.EDGE_TEAMS.buildIndex(teams, sport) : null,
          coaching: window.EDGE_TEAMS ? window.EDGE_TEAMS.buildIndex(coaching, sport) : null,
        };
      }
      return resolvers[sport];
    };

    for (const game of games) {
      const sport = game._sport || game.sport;

      // A game that has kicked off is not a betting opportunity, and the
      // odds feed serves in-play prices for it.
      if (game.completed === true || game.gradable === false || game.is_live === true) {
        skipped.live++;
        continue;
      }
      const startTs = new Date(game.commence_time || game.time).getTime();
      if (isFinite(startTs) && startTs <= Date.now() - 90000) { skipped.live++; continue; }

      const homeName = game.home_team || game.home;
      const awayName = game.away_team || game.away;
      const homeKey = `${sport}:${homeName}`;
      const awayKey = `${sport}:${awayName}`;

      let homeStats = powerIndex.teams[homeKey];
      let awayStats = powerIndex.teams[awayKey];

      const R = resolverFor(sport);
      if (!homeStats && R.teams) homeStats = window.EDGE_TEAMS.resolveTeam(homeName, R.teams, sport);
      if (!awayStats && R.teams) awayStats = window.EDGE_TEAMS.resolveTeam(awayName, R.teams, sport);

      if (!homeStats || !awayStats) { skipped.no_rating++; continue; }
      if (game.spread === null || game.spread === undefined) { skipped.no_spread++; continue; }

      let homeCoach = powerIndex.coaching[homeKey];
      let awayCoach = powerIndex.coaching[awayKey];
      if (!homeCoach && R.coaching) homeCoach = window.EDGE_TEAMS.resolveTeam(homeName, R.coaching, sport);
      if (!awayCoach && R.coaching) awayCoach = window.EDGE_TEAMS.resolveTeam(awayName, R.coaching, sport);

      const homePower = { ...homeStats, _coach: homeCoach || null };
      const awayPower = { ...awayStats, _coach: awayCoach || null };

      try {
        const prior = await EDGE_POWER.computeGamePrior(game, {
          homeStats: homePower,
          awayStats: awayPower,
          // The possession model scales attack against defence
          // relative to the league.
          league: powerIndex.league?.[sport] || null,
          market: {
            // The opening number decides whether the market and
            // line-dynamics families can vote at all, and whether the
            // governor caps confidence at 78 for "no line movement".
            // The cached board rarely carries it, so fall back to the
            // earliest line_history row for this game.
            open_spread: game.open_spread
                      ?? game.opening_spread
                      ?? context?.lineHistoryByGame?.[game.id]?.open_spread
                      ?? null,
            current_spread: game.spread ?? null,
            total: game.total ?? null,
            home_ml: game.ml ?? null,
            away_ml: game.away_ml ?? null,
            home_spread_price: game.home_spread_price ?? null,
            away_spread_price: game.away_spread_price ?? null,
            over_price: game.over_price ?? null,
            under_price: game.under_price ?? null,
            book: game.bookmaker ?? null,
            book_key: game.book_key ?? null,
            book_link: game.book_link ?? null,
            price_source: game.price_source ?? 'consensus',
          },
        });
        prior._raw_game = game;
        priors.push(prior);
      } catch (e) {}
    }

    if (skipped.live || skipped.no_rating || skipped.no_spread) {
      log(`  skipped ${skipped.live} live/final · ${skipped.no_rating} unrated · ${skipped.no_spread} unpriced`);
    }
    return priors;
  }

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

    if (sharedContext.lineHistoryByGame?.[prior.game_id]) {
      ctx.lineHistory = sharedContext.lineHistoryByGame[prior.game_id];
    }

    if (sharedContext.weatherByGame?.[prior.game_id]) {
      ctx.weather = sharedContext.weatherByGame[prior.game_id];
    }

    if (sharedContext.injuriesByGame?.[prior.game_id]) {
      const inj = sharedContext.injuriesByGame[prior.game_id];
      ctx.homeInjuries = inj.home || [];
      ctx.awayInjuries = inj.away || [];
      ctx.homeOffDeduction = inj.home_off_deduction || 0;
      ctx.homeDefDeduction = inj.home_def_deduction || 0;
      ctx.awayOffDeduction = inj.away_off_deduction || 0;
      ctx.awayDefDeduction = inj.away_def_deduction || 0;
      ctx.injuryNetOffEdge = inj.net_off_edge || 0;
      ctx.injuryNetDefEdge = inj.net_def_edge || 0;
    }

    if (sharedContext.restByTeam) {
      ctx.homeRestDays = sharedContext.restByTeam[`${prior.sport}:${prior.home_team}`] ?? null;
      ctx.awayRestDays = sharedContext.restByTeam[`${prior.sport}:${prior.away_team}`] ?? null;
    }

    if (sharedContext.practiceDaysByTeam) {
      ctx.homePracticeDays = sharedContext.practiceDaysByTeam[`${prior.sport}:${prior.home_team}`] ?? null;
      ctx.awayPracticeDays = sharedContext.practiceDaysByTeam[`${prior.sport}:${prior.away_team}`] ?? null;
    }

    if (sharedContext.roadTripLengthByTeam) {
      ctx.homeRoadTripLength = sharedContext.roadTripLengthByTeam[`${prior.sport}:${prior.home_team}`] ?? null;
      ctx.awayRoadTripLength = sharedContext.roadTripLengthByTeam[`${prior.sport}:${prior.away_team}`] ?? null;
    }
    if (sharedContext.travelTypeByTeam) {
      ctx.homeTravelType = sharedContext.travelTypeByTeam[`${prior.sport}:${prior.home_team}`] ?? null;
      ctx.awayTravelType = sharedContext.travelTypeByTeam[`${prior.sport}:${prior.away_team}`] ?? null;
    }

    if (sharedContext.travelByGame?.[prior.game_id]) {
      ctx.travelMiles = sharedContext.travelByGame[prior.game_id].miles ?? null;
      ctx.timezoneShift = sharedContext.travelByGame[prior.game_id].timezones ?? null;
    }

    // ATS + H2H trends
    if (sharedContext.atsByTeam) {
      ctx.homeAts = sharedContext.atsByTeam[`${prior.sport}:${prior.home_team}`] ?? null;
      ctx.awayAts = sharedContext.atsByTeam[`${prior.sport}:${prior.away_team}`] ?? null;
    }
    if (sharedContext.trendsByGame?.[prior.game_id]) {
      const t = sharedContext.trendsByGame[prior.game_id];
      ctx.homeTrends = t.home?.trends || [];
      ctx.awayTrends = t.away?.trends || [];
    }
    if (sharedContext.h2hByGame?.[prior.game_id]) {
      ctx.h2h = sharedContext.h2hByGame[prior.game_id];
    }

    if (prior.commence_time) {
      ctx.hoursToGame = Math.max(0, (new Date(prior.commence_time) - Date.now()) / 3600000);
    }

    return ctx;
  }

  function runGovernor(algoResults) {
    return algoResults
      .filter(r => r.families && r.families.length)
      .map(r => {
        const gov = EDGE_GOVERNOR.run(r.families, r.prior);
        return { prior: r.prior, families: r.families, governor: gov };
      });
  }

  // ============================================================
  // ── ADJUDICATION ──
  // One place where the verdict is settled. Physics never sees a
  // pick until this has run, because physics is the money manager,
  // not a second opinion.
  // ============================================================

  // Everything the selector needs about one game, in one object.
  function buildSelectorCandidates(priors, algoResults, governorResults, sharedContext) {
    const famByGame = {};
    algoResults.forEach(r => { famByGame[r.prior.game_id] = r.families; });

    const now = Date.now();
    return governorResults
      .filter(g => {
        // The slate is this week's board. A cache can hold games that
        // have already kicked off; those are not selectable.
        const t = new Date(g.prior?.commence_time || 0).getTime();
        return isFinite(t) && t > now;
      })
      .map(g => ({
        prior: g.prior,
        families: famByGame[g.prior.game_id] || [],
        governor: g.governor,
        context: g.context || {},
        trends: sharedContext?.trendsByGame?.[g.prior.game_id] || null,
        h2h: sharedContext?.h2hByGame?.[g.prior.game_id] || null,
      }));
  }

  // Produces, per game, the verdict that will be bet and the verdict
  // that will be shadowed, so the two paths can be graded against
  // each other once results come in.
  function adjudicate(governorResults, claudeResult, mode) {
    const picked = {};
    (claudeResult?.selections || []).forEach(s => { picked[String(s.game_id)] = s; });

    return governorResults.map(g => {
      const gov = g.governor;
      const sel = picked[String(g.prior.game_id)] || null;

      const claudeVerdict = sel ? {
        side: sel.side, market: sel.market, confidence: sel.confidence,
        reason: sel.reason, key_factor: sel.key_factor,
      } : null;

      let final, shadow, path;

      if (mode === MODES.AI_LEAD) {
        // Claude decides. A game it did not pick is a pass, however
        // much the governor liked it.
        path = 'claude';
        final = sel ? mergeVerdict(gov, sel) : passVerdict(gov, 'Not selected');
        shadow = gov;
      } else if (mode === MODES.AI_ASSISTED) {
        // The governor decides; Claude can veto or trim.
        path = 'governor+claude';
        if (gov.decision === 'PASS') final = gov;
        else if (!sel) final = passVerdict(gov, 'Claude declined this game');
        else if (sel.side !== gov.direction) final = passVerdict(gov, 'Claude disagreed on side');
        // Take the lower of the two — agreement must not manufacture
        // confidence that neither side had alone.
        else final = { ...gov, confidence: Math.min(gov.confidence, sel.confidence) };
        shadow = gov;
      } else {
        path = 'governor';
        final = gov;
        shadow = gov;
      }

      return { prior: g.prior, context: g.context, governor: gov, claudeVerdict, final, shadow, path };
    });
  }

  function mergeVerdict(gov, sel) {
    const sized = sel.confidence >= 80 ? 'BET_2U' : sel.confidence >= 70 ? 'BET_1U' : 'LEAN';
    return {
      ...gov,
      direction: sel.side,
      confidence: sel.confidence,
      decision: sized,
      claude_reason: sel.reason,
    };
  }

  function passVerdict(gov, reason) {
    return { ...gov, decision: 'PASS', units: 0, pass_reason: reason || gov.pass_reason || null };
  }

  function slimVerdict(gov) {
    return {
      decision: gov.decision, direction: gov.direction,
      confidence: gov.confidence, edge: gov.edge,
      consensus_score: gov.consensus_score, agreement_index: gov.agreement_index,
    };
  }

  function runPhysicsOn(adjudicated, which) {
    const out = [];
    adjudicated.forEach(a => {
      const verdict = which === 'shadow' ? a.shadow : a.final;
      try {
        const p = EDGE_PHYSICS.decide(verdict, a.prior, a.context || {});
        p.pick_id = makePickId(a.prior);
        p.game_id = a.prior.game_id;
        p.sport = a.prior.sport;
        out.push(p);
      } catch {}
    });
    return out;
  }

  async function persistShadowPicks(picks, priors, mode, runId) {
    const url = SUPABASE_URL();
    const key = SUPABASE_KEY();
    if (!url || !key) return { ok: false, reason: 'Supabase not connected' };

    const gameIds = picks.map(p => p.game_id).filter(Boolean);
    if (!gameIds.length) return { ok: false, reason: 'No game IDs' };

    const todayStart = new Date();
    todayStart.setHours(0, 0, 0, 0);
    const existingGameIds = new Set();

    try {
      const inList = gameIds.map(id => `"${id}"`).join(',');
      const checkRes = await fetch(
        `${url}/rest/v1/shadow_picks?select=game_id&game_id=in.(${inList})&created_at=gte.${todayStart.toISOString()}`,
        { headers: { apikey: key, Authorization: `Bearer ${key}` } }
      );
      if (checkRes.ok) {
        const rows = await checkRes.json();
        rows.forEach(r => existingGameIds.add(r.game_id));
      }
    } catch {}

    const freshPicks = picks.filter(p => !existingGameIds.has(p.game_id));
    if (!freshPicks.length) {
      return { ok: true, count: 0, skipped: picks.length, reason: 'All picks already persisted today' };
    }

    const priorById = new Map(priors.map(p => [p.game_id, p]));

    const rows = freshPicks.map(p => {
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
        decision_path: p.decision_path || null,
        governor_verdict: p.governor_verdict || null,
        claude_verdict: p.claude_verdict || null,
        shadow_units: p.shadow_units ?? null,
        shadow_decision: p.shadow_decision || null,
        physics_output: slimPhysics(p),
        pick_id: p.pick_id || p.game_id || null,
        claude_output: p.claude || null,
        reasons: p.reasons || [],
        market_spread: p.market_snapshot?.spread ?? null,
        market_total: p.market_snapshot?.total ?? null,
        market_home_ml: p.market_snapshot?.home_ml ?? null,
        market_away_ml: p.market_snapshot?.away_ml ?? null,
        result: null, actual_margin: null, clv: null, pnl: null,
        created_at: new Date().toISOString(),
      };
    });

    try {
      const res = await fetch(`${url}/rest/v1/shadow_picks`, {
        method: 'POST',
        headers: {
          apikey: key, Authorization: `Bearer ${key}`,
          'Content-Type': 'application/json',
          Prefer: 'return=minimal',
        },
        body: JSON.stringify(rows),
      });
      if (!res.ok) {
        const txt = await res.text().catch(() => '');
        return { ok: false, status: res.status, reason: txt.slice(0, 200) };
      }
      return { ok: true, count: rows.length };
    } catch (e) {
      return { ok: false, reason: e.message };
    }
  }

  function autoPlaceSimBets(picks, portfolio) {
    if (!picks.length) return 0;
    const isSim = portfolio === 'sim';
    let placed = 0;

    const autoThreshold = parseFloat(localStorage.getItem('edge_auto_threshold') || '0');
    if (autoThreshold > 0) {
      picks = picks.filter(p => (p.confidence || 0) >= autoThreshold);
      if (!picks.length) return 0;
    }

    const maxBets = parseInt(localStorage.getItem('edge_max_bets') || '0');
    let betsUsed = parseInt(localStorage.getItem('edge_bets_used') || '0');

    const bankrollKey = isSim ? 'edge_sim_bankroll' : 'edge_bankroll';
    const unitSizeKey = isSim ? 'edge_sim_unit_size' : 'edge_unit_size';
    let bankroll = parseFloat(localStorage.getItem(bankrollKey) || (isSim ? '10000' : '0'));
    const unitSize = parseFloat(localStorage.getItem(unitSizeKey) || (isSim ? '100' : '50'));

    if (bankroll <= 0 || unitSize <= 0) return 0;

    const dailyCapKey = isSim ? 'edge_sim_daily_cap' : 'edge_daily_cap';
    const dailyUsedKey = isSim ? 'edge_sim_daily_used' : 'edge_daily_used';
    const dailyCap = parseFloat(localStorage.getItem(dailyCapKey) || '0');
    let dailyUsed = parseFloat(localStorage.getItem(dailyUsedKey) || '0');

    const placedBets = [];

    for (const pick of picks) {
      const flagKey = isSim ? `edge_bet_sim_${pick.pick_id}` : `edge_bet_real_${pick.pick_id}`;
      if (localStorage.getItem(flagKey) === 'true') continue;

      const units = pick.units || 1;
      const stake = units * unitSize;

      if (maxBets > 0 && betsUsed >= maxBets) break;
      if (dailyCap > 0 && dailyUsed + stake > dailyCap) continue;
      if (stake > bankroll * 0.05) continue;
      if (stake > bankroll) continue;

      bankroll -= stake;
      dailyUsed += stake;
      betsUsed += 1;
      localStorage.setItem(flagKey, 'true');
      placedBets.push({
        pick_id: pick.pick_id, game_id: pick.game_id, sport: pick.sport,
        matchup: `${pick.market_snapshot?.away || ''} vs ${pick.market_snapshot?.home || ''}`,
        pick_label: pick.side_label?.team || pick.direction,
        units, stake,
        odds: pick.market_snapshot?.home_ml || -110,
        confidence: pick.confidence, edge: pick.edge,
      });
      placed++;
    }

    localStorage.setItem(bankrollKey, String(bankroll));
    localStorage.setItem(dailyUsedKey, String(dailyUsed));
    if (!isSim) localStorage.setItem('edge_bets_used', String(betsUsed));

    try {
      const log = JSON.parse(localStorage.getItem('edge_session_bet_log') || '[]');
      placedBets.forEach(b => {
        log.unshift({
          time: new Date().toLocaleTimeString([], { hour: '2-digit', minute: '2-digit' }),
          matchup: b.matchup, pick: b.pick_label,
          type: b.units + 'u', units: b.units, status: 'pending',
        });
      });
      localStorage.setItem('edge_session_bet_log', JSON.stringify(log.slice(0, 100)));
    } catch {}

    const sbUrl = SUPABASE_URL();
    const sbKey = SUPABASE_KEY();
    if (sbUrl && sbKey && placedBets.length) {
      const rows = placedBets.map(b => ({
        mode: isSim ? 'sim' : 'real',
        date: new Date().toISOString().split('T')[0],
        time: new Date().toLocaleTimeString([], { hour: '2-digit', minute: '2-digit' }),
        sport: b.sport, matchup: b.matchup,
        pick_label: b.pick_label, pick_type: 'HOME', line: '',
        odds: b.odds, confidence: b.confidence, edge: b.edge,
        units: b.units, amount: b.stake, status: 'pending', game_id: b.game_id,
      }));
      fetch(`${sbUrl}/rest/v1/bet_log`, {
        method: 'POST',
        headers: {
          apikey: sbKey, Authorization: `Bearer ${sbKey}`,
          'Content-Type': 'application/json',
          Prefer: 'return=minimal',
        },
        body: JSON.stringify(rows),
      }).catch(() => {});
    }

    return placed;
  }

  function getMode() {
    return localStorage.getItem('edge_decision_mode') || DEFAULT_MODE;
  }

  function setMode(mode) {
    if (mode !== MODES.DETERMINISTIC && mode !== MODES.AI_ASSISTED) return false;
    localStorage.setItem('edge_decision_mode', mode);
    return true;
  }

  function loadTodaysGames() {
    try { return JSON.parse(localStorage.getItem('edge_todays_games') || '[]'); }
    catch { return []; }
  }

  function priorFor(priors, gameId) {
    return priors.find(p => p.game_id === gameId) || null;
  }

  function makePickId(prior) { return prior.game_id; }

  function slimPhysics(p) {
    if (!p || !p.governor_snapshot) return p;
    const { breakdown, ...rest } = p.governor_snapshot;
    return { ...p, governor_snapshot: rest };
  }

  function makeLogger(onProgress) {
    return (msg) => { if (typeof onProgress === 'function') onProgress(msg); };
  }

  return { run, getMode, setMode, MODES, DEFAULT_MODE };

})();

if (typeof window !== 'undefined') window.EDGE_ORCHESTRATOR = EDGE_ORCHESTRATOR;