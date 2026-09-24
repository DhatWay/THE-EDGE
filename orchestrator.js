// ============================================================
// EDGE — ORCHESTRATOR v3.1
//
// Runs the full pipeline: games → ratings → context → priors →
// algorithms → situations → governor → physics → persist.
//
// v3.1 changes:
//   · Situations now carry per-rule weights. The engine reads
//     measured hit rates from situation_performance via
//     EDGE_SITUATION_RESULTS.loadWeights(sport), applies them
//     during evaluation, and returns weighted_tally alongside
//     the raw tally. The governor consumes the weighted number.
//   · situationsAsFamily emits the individual fired rules and
//     their weights inside data.fired. The governor already
//     stores family data in its breakdown, so the learning loop
//     and the diagnostic page can now see which specific
//     situations contributed, not just the aggregate family
//     vote. This closes the loop the weight reader opens.
//   · The situations family result carries weighted_lean and
//     weighted_strength. Where the raw lean and the weighted
//     lean disagree — a rule with a heavy weight pulling one
//     way against many thin unweighted rules — the weighted
//     read wins.
//
// v3.0 changes (retained):
//   · Situations engine is a first-class input. Its output
//     becomes a 10th family vote weighted above any single
//     family, since it aggregates rules rather than reading
//     one signal.
//   · Live/final games excluded at the prior-build step.
//   · Team resolution uses EDGE_TEAMS when present.
//   · Persist writes the full verdict trail.
// ============================================================

const EDGE_ORCHESTRATOR = (() => {

  const BUILD = 'orch-20260924-01';

  const MODES = {
    DETERMINISTIC: 'math_only',
    AI_ASSISTED:   'ai_assisted',
    AI_LEAD:       'ai_lead',
  };
  const DEFAULT_MODE = MODES.DETERMINISTIC;

  const SUPABASE_URL = () => localStorage.getItem('edge_supabase_url');
  const SUPABASE_KEY = () => localStorage.getItem('edge_supabase_key');
  const MAX_PARALLEL_GAMES = 6;

  // Situations contribute as one weighted vote. It sits above any
  // single family because it aggregates rules; the weight is 12
  // (top-end of the family weight table) unless the learning loop
  // overrides it.
  const SITUATIONS_FAMILY_WEIGHT = 12;

  function logEdgeError(where, err) {
    try {
      const list = JSON.parse(localStorage.getItem('edge_errors') || '[]');
      list.unshift({ t: Date.now(), where, msg: err && err.message ? err.message : String(err) });
      localStorage.setItem('edge_errors', JSON.stringify(list.slice(0, 50)));
    } catch {}
  }

  // ============================================================
  // ── MAIN ──
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
      persisted: 0,
      auto_placed: 0,
    };

    try {
      // ── Stage 0 · Calibration ──
      if (typeof EDGE_POWER.loadCalibrationOnce === 'function') {
        try { await EDGE_POWER.loadCalibrationOnce(); }
        catch (e) { logEdgeError('orch.calibration', e); }
      }

      // ── Stage 0b · Learning loop if due ──
      if (window.EDGE_LEARNING && typeof EDGE_LEARNING.runIfDue === 'function') {
        try {
          const learned = await EDGE_LEARNING.runIfDue();
          if (learned?.ran) {
            log(`Stage 0 · Learning loop updated ${learned.families_updated ?? 0} weights`);
            summary.stages.learning = learned;
          }
        } catch (e) { log('Stage 0 · Learning loop failed: ' + e.message); }
      }

      // ── Stage 1 · Games ──
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
      log(`  ${gameList.length} games across ${activeSports.size} sport(s)`);

      // ── Stage 1b · Situation weights ──
      // Loaded once per sport. Each weight is a rule's measured
      // reliability — 1.5× for a rule clearing 55%, 0.3× for one
      // scraping below 52%, 1.0× for anything with too thin a
      // sample to decide. Missing table or missing history falls
      // back to 1.0 for every rule.
      const situationWeightsBySport = {};
      if (window.EDGE_SITUATION_RESULTS) {
        for (const sp of activeSports) {
          try {
            situationWeightsBySport[sp] = await EDGE_SITUATION_RESULTS.loadWeights(sp);
          } catch (e) {
            situationWeightsBySport[sp] = {};
            logEdgeError('orch.situationWeights.' + sp, e);
          }
        }
        const totalWeighted = Object.values(situationWeightsBySport)
          .reduce((s, map) => s + Object.values(map).filter(w => w !== 1).length, 0);
        if (totalWeighted) {
          log(`  ${totalWeighted} situation weight${totalWeighted === 1 ? '' : 's'} loaded from situation_performance`);
        } else {
          log('  situations running at neutral weight — no learned weights on file yet');
        }
      } else {
        log('  situation-results.js not loaded — situations run at neutral weight');
      }
      summary.stages.situation_weights_loaded = Object.keys(situationWeightsBySport).length;

      // ── Stage 2 · Power ratings ──
      log('Stage 2/7 · Power ratings');
      const powerIndex = await loadPowerIndex(activeSports, log);
      summary.stages.teams_rated = Object.keys(powerIndex.teams).length;
      summary.stages.coaches_rated = Object.keys(powerIndex.coaching).length;
      log(`  ${summary.stages.teams_rated} teams · ${summary.stages.coaches_rated} coaches`);

      if (!summary.stages.teams_rated) {
        summary.errors.push('No power ratings — run Recompute Ratings first');
        summary.duration_ms = Date.now() - startedAt;
        return summary;
      }

      // ── Stage 3 · Context ──
      log('Stage 3/7 · Building context');
      let builtContext = context;
      if (window.EDGE_CONTEXT) {
        try {
          builtContext = await EDGE_CONTEXT.buildContext(gameList);
          summary.stages.context = {
            line_history: Object.keys(builtContext.lineHistoryByGame || {}).length,
            rest: Object.keys(builtContext.restByTeam || {}).length,
            travel: Object.keys(builtContext.travelByGame || {}).length,
            weather: Object.keys(builtContext.weatherByGame || {}).length,
            injuries: Object.keys(builtContext.injuriesByGame || {}).length,
            ats: Object.keys(builtContext.atsByTeam || {}).length,
            h2h: Object.keys(builtContext.h2hByGame || {}).length,
          };
          log(`  line_history ${summary.stages.context.line_history} · rest ${summary.stages.context.rest} · travel ${summary.stages.context.travel}`);
          log(`  weather ${summary.stages.context.weather} · injuries ${summary.stages.context.injuries} · ats ${summary.stages.context.ats} · h2h ${summary.stages.context.h2h}`);
        } catch (e) {
          log(`  context build failed: ${e.message}`);
          logEdgeError('orch.context', e);
        }
      } else {
        log('  context-builder.js not loaded — running with empty context');
      }

      // ── Stage 4 · Priors ──
      log('Stage 4/7 · Computing game priors');
      const priors = await buildPriors(gameList, powerIndex, builtContext, log);
      summary.stages.priors_built = priors.length;

      if (!priors.length) {
        summary.errors.push('No priors built — power ratings missing for today\'s teams, or all games are live/final');
        summary.duration_ms = Date.now() - startedAt;
        return summary;
      }
      log(`  ${priors.length} priors built`);

      // ── Stage 5 · Family algorithms ──
      log('Stage 5/7 · Running family algorithms');
      const algoResults = await runAlgorithmsParallel(priors, builtContext, MAX_PARALLEL_GAMES, log);
      summary.stages.algo_runs = algoResults.length;
      log(`  ${algoResults.length} games scored by 9 families`);

      // ── Stage 5b · Situations engine ──
      log('Stage 5b · Evaluating situations');
      const situationsByGame = await evaluateSituations(
        priors, builtContext, log, situationWeightsBySport
      );
      summary.stages.situations_evaluated = Object.keys(situationsByGame).length;
      const firedTotal = Object.values(situationsByGame)
        .reduce((s, r) => s + ((r.situations && r.situations.length) || 0), 0);
      log(`  ${summary.stages.situations_evaluated} games · ${firedTotal} rule firings`);
      summary.stages.situation_firings = firedTotal;

      // ── Stage 6 · Governor ──
      log('Stage 6/7 · Governor consensus');
      const governorResults = runGovernor(algoResults, situationsByGame);
      summary.stages.governor_runs = governorResults.length;

      // ── Stage 6b · Claude (optional) ──
      let claudeResult = { ok: true, selections: [] };
      if (mode === MODES.AI_ASSISTED || mode === MODES.AI_LEAD) {
        const candidates = buildSelectorCandidates(priors, algoResults, governorResults, builtContext);
        log(`  handing ${candidates.length} upcoming games to the selector`);
        try {
          claudeResult = await EDGE_CLAUDE.selectFromSlate(candidates, { onProgress: log });
          if (!claudeResult.ok) {
            log('  selector unavailable: ' + claudeResult.error);
            summary.errors.push('Claude selector: ' + claudeResult.error);
          } else {
            log(`  selector returned ${claudeResult.selections.length} picks`);
          }
        } catch (e) {
          log('  selector failed: ' + e.message);
          logEdgeError('orch.claude', e);
        }
      }

      const adjudicated = adjudicate(governorResults, claudeResult, mode);
      summary.stages.adjudicated = adjudicated.filter(a => a.final.decision !== 'PASS').length;

      // ── Stage 7 · Physics ──
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
        const sit = situationsByGame[p.game_id];
        if (sit) p.situations = sit.situations || [];
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
      log(`  ${picks.length} actionable picks`);

      // ── Persist ──
      if (persist && picks.length) {
        log('Persisting picks');
        const persistResult = await persistShadowPicks(picks, priors, mode, runId);
        if (persistResult.ok) {
          if (persistResult.skipped) {
            log(`  0 new rows · ${persistResult.skipped} already persisted today`);
          } else {
            log(`  ${persistResult.count} rows written`);
          }
          summary.persisted = persistResult.count || 0;
        } else {
          log(`  persist failed: ${persistResult.status || ''} ${persistResult.reason || ''}`);
          summary.errors.push('Persist: ' + (persistResult.reason || 'unknown'));
        }

        const portfolio = localStorage.getItem('edge_active_portfolio') || 'real';
        const bettingMode = localStorage.getItem('edge_betting_mode') || 'manual';
        if (portfolio === 'sim' || bettingMode === 'auto') {
          log(`Auto-placing sim bets (portfolio=${portfolio}, mode=${bettingMode})`);
          const placed = autoPlaceSimBets(picks, portfolio);
          log(`  ${placed} sim bets placed`);
          summary.auto_placed = placed;
        }
      }

      summary.completed_at = new Date().toISOString();
      summary.duration_ms = Date.now() - startedAt;

      // Cache the last run for other pages to consume.
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
            situations: p.situations || [],
          })),
        }));
      } catch (e) { logEdgeError('orch.lastRunCache', e); }

      log(`Done · ${picks.length} picks · ${summary.duration_ms}ms`);
      return summary;

    } catch (err) {
      summary.errors.push(err.message);
      summary.completed_at = new Date().toISOString();
      summary.duration_ms = Date.now() - startedAt;
      log(`Error: ${err.message}`);
      logEdgeError('orch.run', err);
      return summary;
    }
  }

  // ============================================================
  // ── POWER INDEX ──
  // ============================================================

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

  async function loadPowerIndex(activeSports = null, log = () => {}) {
    const url = SUPABASE_URL();
    const key = SUPABASE_KEY();

    if (url && key) {
      try {
        const sportsList = activeSports ? Array.from(activeSports) : null;
        const sportFilter = sportsList && sportsList.length
          ? '&sport=in.(' + sportsList.map(s => `"${s}"`).join(',') + ')'
          : '';

        const [teamsRes, coachesRes] = await Promise.all([
          fetch(`${url}/rest/v1/power_ratings?select=*&limit=5000${sportFilter}`,
            { headers: { apikey: key, Authorization: `Bearer ${key}` } }),
          fetch(`${url}/rest/v1/coaching_ratings?select=*&limit=5000${sportFilter}`,
            { headers: { apikey: key, Authorization: `Bearer ${key}` } }),
        ]);

        if (teamsRes.ok) {
          const teams = await teamsRes.json();
          const coaches = coachesRes.ok ? await coachesRes.json() : [];
          if (teams.length) {
            const index = { teams: {}, coaching: {}, league: {} };
            teams.forEach(t => { index.teams[`${t.sport}:${t.team_name}`] = t; });
            coaches.forEach(c => { index.coaching[`${c.sport}:${c.team_name}`] = c; });
            index.league = buildLeagueBaselines(teams);
            return index;
          }
        }
      } catch (e) { logEdgeError('orch.powerIndexRead', e); }
    }

    log('  no power ratings in Supabase — computing fresh (slow)');
    const fresh = await EDGE_POWER.computeAllTeamRatings({ onProgress: log });
    return {
      teams: fresh.teams,
      coaching: fresh.coaching,
      league: buildLeagueBaselines(Object.values(fresh.teams)),
    };
  }

  // ============================================================
  // ── PRIORS ──
  // ============================================================

  async function buildPriors(games, powerIndex, context = null, log = () => {}) {
    const priors = [];
    const skipped = { live: 0, no_rating: 0, no_spread: 0 };

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
          league: powerIndex.league?.[sport] || null,
          market: {
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
      } catch (e) { logEdgeError('orch.priorBuild', e); }
    }

    if (skipped.live || skipped.no_rating || skipped.no_spread) {
      log(`  skipped ${skipped.live} live/final · ${skipped.no_rating} unrated · ${skipped.no_spread} unpriced`);
    }
    return priors;
  }

  // ============================================================
  // ── ALGORITHMS ──
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
          results.push({ prior, families, gameContext });
        } catch (e) {
          logEdgeError('orch.algoRun', e);
          results.push({ prior, families: [], gameContext: {}, error: e.message });
        }
        done++;
        if (done % 10 === 0) log(`  families scored ${done}/${priors.length}`);
      }
    }

    const workers = Array.from({ length: Math.min(concurrency, priors.length) }, worker);
    await Promise.all(workers);
    return results;
  }

  function buildGameContext(prior, sharedContext) {
    const ctx = { ...sharedContext };
    const gid = prior.game_id;

    if (sharedContext.lineHistoryByGame?.[gid]) ctx.lineHistory = sharedContext.lineHistoryByGame[gid];
    if (sharedContext.weatherByGame?.[gid]) ctx.weather = sharedContext.weatherByGame[gid];

    if (sharedContext.injuriesByGame?.[gid]) {
      const inj = sharedContext.injuriesByGame[gid];
      ctx.homeInjuries = inj.home || [];
      ctx.awayInjuries = inj.away || [];
      ctx.homeOffDeduction = inj.home_off_deduction || 0;
      ctx.homeDefDeduction = inj.home_def_deduction || 0;
      ctx.awayOffDeduction = inj.away_off_deduction || 0;
      ctx.awayDefDeduction = inj.away_def_deduction || 0;
    }

    const sport = prior.sport;
    if (sharedContext.restByTeam) {
      ctx.homeRestDays = sharedContext.restByTeam[`${sport}:${prior.home_team}`] ?? null;
      ctx.awayRestDays = sharedContext.restByTeam[`${sport}:${prior.away_team}`] ?? null;
    }
    if (sharedContext.atsByTeam) {
      ctx.homeAts = sharedContext.atsByTeam[`${sport}:${prior.home_team}`] ?? null;
      ctx.awayAts = sharedContext.atsByTeam[`${sport}:${prior.away_team}`] ?? null;
    }
    if (sharedContext.h2hByGame?.[gid]) ctx.h2h = sharedContext.h2hByGame[gid];
    if (sharedContext.travelByGame?.[gid]) {
      ctx.travelMiles = sharedContext.travelByGame[gid].miles ?? null;
      ctx.timezoneShift = sharedContext.travelByGame[gid].timezones ?? null;
    }
    if (sharedContext.roadTripLengthByTeam) {
      ctx.awayRoadTripLength = sharedContext.roadTripLengthByTeam[`${sport}:${prior.away_team}`] ?? null;
    }
    if (prior.commence_time) {
      ctx.hoursToGame = Math.max(0, (new Date(prior.commence_time) - Date.now()) / 3600000);
    }

    return ctx;
  }

  // ============================================================
  // ── SITUATIONS ──
  // Per-sport weights are read once per pipeline run and passed
  // through to the engine. The engine evaluates each rule against
  // its weight and returns both the raw tally and the weighted
  // tally. When the two disagree on lean the weighted read is
  // what the governor consumes.
  // ============================================================

  async function evaluateSituations(priors, context, log, weightsBySport = {}) {
    if (!window.EDGE_SITUATIONS) {
      log('  situations-engine.js not loaded — skipping');
      return {};
    }

    const bySport = {};
    priors.forEach(p => {
      const sp = p.sport;
      if (!bySport[sp]) bySport[sp] = [];
      bySport[sp].push(p);
    });

    const byGame = {};

    for (const [sport, list] of Object.entries(bySport)) {
      const slate = list.map(p => {
        const raw = p._raw_game || {};
        return {
          id: p.game_id,
          _sport: sport,
          sport,
          home_team: p.home_team,
          away_team: p.away_team,
          home: p.home_team,
          away: p.away_team,
          spread: p.market?.current_spread ?? null,
          open_spread: p.market?.open_spread ?? null,
          total: p.market?.total ?? null,
          ml: p.market?.home_ml ?? null,
          away_ml: p.market?.away_ml ?? null,
          commence_time: p.commence_time,
        };
      });

      try {
        const result = await window.EDGE_SITUATIONS.evaluateSlate(
          slate,
          context,
          { situationWeights: weightsBySport[sport] || {} }
        );
        result.forEach(r => { byGame[r.game_id] = r; });
      } catch (e) {
        log(`  situations evaluation failed for ${sport}: ${e.message}`);
        logEdgeError('orch.situations.' + sport, e);
      }
    }

    return byGame;
  }

  // Convert a situations result into a family-shaped output the
  // governor can consume alongside the nine families.
  //
  // The engine has already done the per-rule weighting — a rule
  // carrying 1.5× contributes 1.5 to the tally, a rule carrying
  // 0.3× contributes 0.3. Here we take the weighted read as the
  // family signal and carry the raw tally plus the fired-rule list
  // into `data.fired` so the governor's breakdown preserves it.
  // The learning loop and the diagnostic page read from there.
  function situationsAsFamily(sitResult) {
    if (!sitResult || !sitResult.tally) {
      return {
        family: 'situations',
        signal: 0,
        vote: 'neu',
        confidence: 0.5,
        edge: 0,
        reason: 'No situations fired',
        subs: [],
        data: {},
      };
    }

    // Prefer the weighted read. If the engine did not produce one —
    // older engine version, or every weight at 1.0 — the weighted
    // fields equal the raw fields and either works.
    const weightedLean = sitResult.weighted_lean || sitResult.lean;
    const weightedStrength = sitResult.weighted_strength ?? sitResult.strength ?? 0;

    let signal = 0;
    if (weightedLean === 'home') signal = Math.min(weightedStrength / 6, 1);
    else if (weightedLean === 'away') signal = -Math.min(weightedStrength / 6, 1);
    else if (weightedLean === 'under') signal = -Math.min(weightedStrength / 8, 0.5);
    else if (weightedLean === 'over') signal = Math.min(weightedStrength / 8, 0.5);

    const vote = weightedLean === 'home' ? 'yes'
              : weightedLean === 'away' ? 'no'
              : 'neu';

    // Confidence scales with the weighted strength. The divisor is
    // larger than the raw version because weights above 1.0 push
    // strength past what an unweighted count would produce, and we
    // do not want a single heavy rule to claim 0.9 on its own.
    const confidence = weightedStrength > 0
      ? Math.min(0.5 + weightedStrength * 0.06, 0.9)
      : 0.5;

    const fired = sitResult.situations || [];
    const reasons = fired
      .slice(0, 4)
      .map(s => s.label)
      .join(' · ');

    // The per-rule list travels inside data.fired. governor.js
    // stores family data in the breakdown, so this survives to the
    // shadow_picks row and the learning loop reads it there.
    const firedDetail = fired.map(s => ({
      id: s.id,
      label: s.label,
      side: s.side,
      side_source: s.side_source || null,
      weight: typeof s.weight === 'number' ? s.weight : 1,
      note: s.note || null,
    }));

    return {
      family: 'situations',
      signal: round(signal, 3),
      vote,
      confidence: round(confidence, 3),
      edge: round(Math.abs(signal) * 0.08, 4),
      reason: reasons || 'No situations fired',
      subs: firedDetail,
      data: {
        tally: sitResult.tally || null,
        weighted_tally: sitResult.weighted_tally || null,
        lean: sitResult.lean || null,
        weighted_lean: weightedLean,
        strength: sitResult.strength ?? null,
        weighted_strength: weightedStrength,
        testable_count: sitResult.testable_count ?? null,
        untestable: sitResult.untestable || [],
        fired: firedDetail,
      },
    };
  }

  // ============================================================
  // ── GOVERNOR ──
  // ============================================================

  function runGovernor(algoResults, situationsByGame) {
    return algoResults
      .filter(r => r.families && r.families.length)
      .map(r => {
        const sitResult = situationsByGame[r.prior.game_id];
        const sitFamily = situationsAsFamily(sitResult);
        // Situations vote first so they read at the top of the
        // breakdown. Their weight is set by the governor's static
        // table; SITUATIONS_FAMILY_WEIGHT is written into the
        // governor's dynamic override below.
        const allFamilies = [sitFamily, ...r.families];

        const dynamic = EDGE_GOVERNOR.getDynamicWeights(r.prior.sport);
        const merged = { ...dynamic, situations: SITUATIONS_FAMILY_WEIGHT };

        const gov = EDGE_GOVERNOR.run(allFamilies, r.prior, { dynamicWeights: merged });
        return {
          prior: r.prior,
          families: allFamilies,
          governor: gov,
          gameContext: r.gameContext,
        };
      });
  }

  // ============================================================
  // ── CLAUDE ADJUDICATION ──
  // ============================================================

  function buildSelectorCandidates(priors, algoResults, governorResults, sharedContext) {
    const famByGame = {};
    algoResults.forEach(r => { famByGame[r.prior.game_id] = r.families; });

    const now = Date.now();
    return governorResults
      .filter(g => {
        const t = new Date(g.prior?.commence_time || 0).getTime();
        return isFinite(t) && t > now;
      })
      .map(g => ({
        prior: g.prior,
        families: famByGame[g.prior.game_id] || [],
        governor: g.governor,
        context: g.gameContext || {},
        trends: sharedContext?.trendsByGame?.[g.prior.game_id] || null,
        h2h: sharedContext?.h2hByGame?.[g.prior.game_id] || null,
      }));
  }

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
        path = 'claude';
        final = sel ? mergeVerdict(gov, sel) : passVerdict(gov, 'Not selected');
        shadow = gov;
      } else if (mode === MODES.AI_ASSISTED) {
        path = 'governor+claude';
        if (gov.decision === 'PASS') final = gov;
        else if (!sel) final = passVerdict(gov, 'Claude declined');
        else if (sel.side !== gov.direction) final = passVerdict(gov, 'Claude disagreed on side');
        else final = { ...gov, confidence: Math.min(gov.confidence, sel.confidence) };
        shadow = gov;
      } else {
        path = 'governor';
        final = gov;
        shadow = gov;
      }

      return { prior: g.prior, gameContext: g.gameContext, governor: gov, claudeVerdict, final, shadow, path };
    });
  }

  function mergeVerdict(gov, sel) {
    const sized = sel.confidence >= 80 ? 'BET_2U' : sel.confidence >= 70 ? 'BET_1U' : 'LEAN';
    return { ...gov, direction: sel.side, confidence: sel.confidence, decision: sized, claude_reason: sel.reason };
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

  // ============================================================
  // ── PHYSICS ──
  // ============================================================

  function runPhysicsOn(adjudicated, which) {
    const out = [];
    adjudicated.forEach(a => {
      const verdict = which === 'shadow' ? a.shadow : a.final;
      try {
        const p = EDGE_PHYSICS.decide(verdict, a.prior, a.gameContext || {});
        p.pick_id = a.prior.game_id;
        p.game_id = a.prior.game_id;
        p.sport = a.prior.sport;
        out.push(p);
      } catch (e) { logEdgeError('orch.physics.' + which, e); }
    });
    return out;
  }

  // ============================================================
  // ── PERSIST ──
  // ============================================================

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
        (await checkRes.json()).forEach(r => existingGameIds.add(r.game_id));
      }
    } catch (e) { logEdgeError('orch.persistCheck', e); }

    const freshPicks = picks.filter(p => !existingGameIds.has(p.game_id));
    if (!freshPicks.length) {
      return { ok: true, count: 0, skipped: picks.length };
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
        result: null,
        actual_margin: null,
        clv: null,
        pnl: null,
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

  // ============================================================
  // ── AUTO SIM PLACEMENT ──
  // ============================================================

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
    const counterKey = isSim ? 'edge_sim_bets_used' : 'edge_bets_used';
    let betsUsed = parseInt(localStorage.getItem(counterKey) || '0');

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

      // The matchup string used to read market_snapshot.home/away,
      // which do not exist on that object. physics.js carries the
      // market numbers, not the team names — so the sim ledger was
      // logging " vs ". The prior has them.
      const prior = pick._prior || null;
      const matchup = prior
        ? `${prior.away_team} @ ${prior.home_team}`
        : `${pick.away_team || ''} @ ${pick.home_team || ''}`.trim() || '—';

      placedBets.push({
        pick_id: pick.pick_id,
        game_id: pick.game_id,
        sport: pick.sport,
        matchup,
        pick_label: pick.side_label?.team || pick.direction,
        units,
        stake,
        odds: pick.market_snapshot?.home_ml || -110,
        confidence: pick.confidence,
        edge: pick.edge,
      });
      placed++;
    }

    localStorage.setItem(bankrollKey, String(bankroll));
    localStorage.setItem(dailyUsedKey, String(dailyUsed));
    localStorage.setItem(counterKey, String(betsUsed));

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
    } catch (e) { logEdgeError('orch.sessionLog', e); }

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
      }).catch(e => logEdgeError('orch.betLogWrite', e));
    }

    return placed;
  }

  // ============================================================
  // ── UTILITIES ──
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
    try { return JSON.parse(localStorage.getItem('edge_todays_games') || '[]'); }
    catch { return []; }
  }

  function priorFor(priors, gameId) {
    return priors.find(p => p.game_id === gameId) || null;
  }

  function slimPhysics(p) {
    if (!p || !p.governor_snapshot) return p;
    const { breakdown, ...rest } = p.governor_snapshot;
    return { ...p, governor_snapshot: rest };
  }

  function makeLogger(onProgress) {
    return (msg) => { if (typeof onProgress === 'function') onProgress(msg); };
  }

  function round(v, d) { const f = Math.pow(10, d); return Math.round(v * f) / f; }

  return {
    BUILD,
    run,
    getMode,
    setMode,
    MODES,
    DEFAULT_MODE,
    SITUATIONS_FAMILY_WEIGHT,
  };

})();

if (typeof window !== 'undefined') window.EDGE_ORCHESTRATOR = EDGE_ORCHESTRATOR;