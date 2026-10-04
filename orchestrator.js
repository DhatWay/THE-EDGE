// ============================================================
// EDGE — ORCHESTRATOR v3.2
//
// Runs the full pipeline: games → ratings → context → priors →
// algorithms → situations → governor → physics → persist.
//
// v3.2 changes:
//
//   · Dedup is no longer "today only." A game that appears on
//     the slate every day of the week was getting written every
//     day, possibly on the other side once the line moved. The
//     dedup now checks a 14-day window per game_id and skips if
//     any pick for that game already exists. A game is picked
//     once, not once per calendar page.
//
//   · Auto-placed bets write the same shape simulation.js writes.
//     The old code stored pick_type: 'HOME', line: '' and used
//     the home moneyline as the price for either side.
//     sim-grader.js reads Number('') as 0 and would grade an
//     auto-placed bet as pick'em at even money. Now the bet
//     carries pick_type 'ATS', the spread as a real number,
//     and the standard -110 spread price. The line string
//     round-trips through the DB cleanly.
//
//   · Auto-placed bets use the local date, not the UTC date.
//     An 8pm Eastern tip-off was being logged as the next
//     calendar day.
//
//   · Optional shadow grading at the end of a run. When
//     options.grade is true, the pipeline calls
//     EDGE_SHADOW_GRADER.run() so yesterday's ungraded picks
//     close their loop in the same pass. Off by default.
//
// v3.1 changes (retained):
//   · Situations carry per-rule weights through to the governor.
//   · Live/final games excluded at the prior-build step.
//   · Team resolution uses EDGE_TEAMS when present.
// ============================================================

const EDGE_ORCHESTRATOR = (() => {

  const BUILD = 'orch-20261004-03';

  const MODES = {
    DETERMINISTIC: 'math_only',
    AI_ASSISTED:   'ai_assisted',
    AI_LEAD:       'ai_lead',
  };
  const DEFAULT_MODE = MODES.DETERMINISTIC;

  const SUPABASE_URL = () => localStorage.getItem('edge_supabase_url');
  const SUPABASE_KEY = () => localStorage.getItem('edge_supabase_key');
  const MAX_PARALLEL_GAMES = 6;

  const SITUATIONS_FAMILY_WEIGHT = 12;

  // Situations (historical ATS spots) are not part of the decision:
  // the ranking decides. The engine is not run and its weights are
  // not loaded, which also saves the three table reads per run.
  // Situations are evaluated every run and handed to the governor as
  // spots — each with its tested record — not as a voting family.
  const SITUATIONS_IN_DECISION = true;

  const ML_SPORTS = new Set(['MLB', 'NHL']);

  // A pick is skipped if any pick for the same game_id was
  // written inside this window. Wide enough to cover a full
  // scheduling cycle for every sport. Narrow enough that a
  // genuinely new meeting weeks later gets a fresh pick.
  const DEDUP_WINDOW_DAYS = 14;

  const DEFAULT_SPREAD_PRICE = -110;

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
      maxPicks = 25,
      minConfidence = 0,
      grade = true,
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
      graded: 0,
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
      const situationWeightsBySport = {};
      if (false && window.EDGE_SITUATION_RESULTS) {
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
          log(`  ${totalWeighted} situation weight${totalWeighted === 1 ? '' : 's'} loaded`);
        } else {
          log('  situations running at neutral weight — no learned weights on file yet');
        }
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
      // ── Stage 3b · Outside data: starting pitchers, goalies, college
      // SP+ and NFL efficiency. Each source is optional.
      if (window.EDGE_EXTERNAL) {
        log('Stage 3b · Outside data');
        try {
          const ext = await EDGE_EXTERNAL.loadForSlate(gameList, builtContext, log);
          builtContext = builtContext || {};
          builtContext.externalByGame = ext.byGame;
          summary.stages.external = ext.status;
        } catch (e) { log('  outside data failed: ' + e.message); }
      }

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
      const situationsByGame = SITUATIONS_IN_DECISION
        ? await (async () => {
            log('Stage 5b · Evaluating situations');
            return evaluateSituations(priors, builtContext, log, situationWeightsBySport);
          })()
        : {};
      summary.stages.situations_evaluated = Object.keys(situationsByGame).length;
      const firedTotal = Object.values(situationsByGame)
        .reduce((s, r) => s + ((r.situations && r.situations.length) || 0), 0);
      if (SITUATIONS_IN_DECISION) {
        log(`  ${summary.stages.situations_evaluated} games · ${firedTotal} rule firings`);
      }
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
        // A moneyline underdog can be a bet below 50%: its value, not its
        // chance, decided it, so the confidence floor applies to spreads.
        // Expected value decided these; no confidence floor on top.
        .filter(p => minConfidence <= 0 || p.governor_snapshot?.bet_type === 'ML' || p.confidence >= minConfidence)
        .sort((a, b) => {
          if (b.confidence !== a.confidence) return b.confidence - a.confidence;
          return Math.abs(b.edge) - Math.abs(a.edge);
        })
        .slice(0, maxPicks);

      // What each game's inputs were, so a pick's analytics can say
      // whether anything that feeds the decision was missing.
      finalResults.forEach(p => {
        const prior = priors.find(x => x.game_id === p.game_id) || {};
        const sp = prior.sport || p.sport;
        const hs = prior.home_power || {}, as = prior.away_power || {};
        const ctx = builtContext || {};
        const inputs = {
          ratings_games: Math.min(Number(hs.games_played) || 0, Number(as.games_played) || 0),
          projection: prior.projection_spread != null,
          composite: prior.composite_spread != null,
          cover: !!prior.cover,
          rest: ctx.restByTeam?.[`${sp}:${prior.home_team}`] != null && ctx.restByTeam?.[`${sp}:${prior.away_team}`] != null,
          injuries: !!ctx.injuriesByGame?.[p.game_id],
          calibrated: !!(p.governor_snapshot?.calibration?.applied),
          // Outside data, where the sport uses it (null = not this sport).
          pitchers: sp === 'MLB' ? !!prior.external?.pitchers : null,
          goalies: sp === 'NHL' ? !!prior.external?.goalies : null,
          college_sp: sp === 'NCAAF' ? !!prior.external?.sp : null,
          nfl_efficiency: sp === 'NFL' ? !!prior.external?.eff : null,
        };
        if (p.governor_snapshot) p.governor_snapshot.inputs = inputs;
        p.inputs = inputs;
      });

      // Best available number for the side picked, across the books
      // Matchups downloaded (consensus mode). The decision stays the
      // one made at the consensus line; this is where to bet it.
      finalResults.forEach(p => {
        if (!p.direction || p.direction === 'none') return;
        const prior = priors.find(x => x.game_id === p.game_id) || {};
        if (prior.bet_type === 'ML') return;
        const g = prior._raw_game || {};
        const isHome = p.direction === 'home';
        const point = isHome ? g.best_home_spread : g.best_away_spread;
        if (point == null || !isFinite(point)) return;
        const homeLine = isHome ? point : -point;
        let cover = null;
        const core = window.EDGE_RATING;
        const total = prior.total_model_spread ?? prior.model_spread;
        // The model's own chance, moved by what the half-points between
        // the consensus line and this one are worth (from the ranking's
        // spread of outcomes) — not the ranking's chance alone.
        if (core && isFinite(total)) {
          const consensusHome = isHome ? (g.home_spread ?? g.spread) : (g.away_spread != null ? -g.away_spread : g.spread);
          const at = line => {
            const c = core.coverProbability(-total, line, prior.cover?.sigma ?? null, { sport: prior.sport });
            return c ? (isHome ? c.home_cover : c.away_cover) : null;
          };
          const cBest = at(homeLine), cCons = consensusHome != null ? at(consensusHome) : null;
          const modelSide = isFinite(p.confidence) ? p.confidence / 100 : null;
          if (modelSide != null && cBest != null && cCons != null) {
            cover = Math.max(0.01, Math.min(0.99, modelSide + (cBest - cCons)));
          }
        }
        const best = {
          point, home_line: homeLine,
          book: isHome ? g.best_home_book : g.best_away_book,
          price: isHome ? g.best_home_price : g.best_away_price,
          consensus: isHome ? g.home_spread ?? g.spread : g.away_spread,
          cover,
        };
        p.best = best;
        if (p.governor_snapshot) p.governor_snapshot.best = best;
      });

      // Sport gate: a sport whose Slate Test scored worse than a coin
      // flip makes no picks (its line still shows). Untested sports
      // pass through, marked untested.
      {
        // The sport's backtest standing is recorded with each game for
        // reading. It sizes bets (physics) but never blocks one.
        let metrics = {};
        try { metrics = JSON.parse(localStorage.getItem('edge_governor_calibration') || '{}').sport_metrics || {}; } catch {}
        finalResults.forEach(p => {
          const prior = priors.find(x => x.game_id === p.game_id) || {};
          const kind = prior.bet_type === 'ML' ? `${prior.sport}_ML` : prior.sport;
          const m = metrics[kind] || metrics[prior.sport];
          p.gate = m ? { tested: true, skill: m.skill, games: m.games } : { tested: false };
          if (p.governor_snapshot) p.governor_snapshot.gate = p.gate;
        });
      }

      // Why each passed game passed — so a run with no picks still says
      // where every game stopped.
      const reasonFor = (p) => {
        if (p.decision && p.decision !== 'PASS' && p.decision !== 'CAPPED' && p.decision !== 'VETOED') return null;
        const gs = p.governor_snapshot || {};
        if ((gs.data_caps || []).some(c => /no spread|no moneyline/.test(c))) return 'no line to bet';
        if (p.decision === 'VETOED') return 'vetoed by Claude';
        if (p.decision === 'CAPPED') return 'over a daily or bankroll cap';
        if (gs.decision && gs.decision !== 'PASS') return 'governor liked it; bet size came out to zero';
        const ev = gs.ev;
        const cal = gs.calibration;
        const calNote = cal && cal.applied && gs.capped_confidence != null
          ? ` (calibration moved ${Number(gs.capped_confidence).toFixed(1)}% to ${Number(gs.confidence).toFixed(1)}%)` : '';
        return ev != null ? `value too small: ${(ev * 100).toFixed(1)}% per bet, lean starts at 1.8%${calNote}` : 'no edge';
      };

      // Every game's result, picked or passed, for the board.
      summary.evaluations = finalResults.map(p => {
        const prior = priors.find(x => x.game_id === p.game_id) || {};
        return {
          reason: reasonFor(p),
          sport: prior.sport || p.sport || null,
          home_team: prior.home_team || null,
          away_team: prior.away_team || null,
          commence_time: prior.commence_time || null,
          bet_type: prior.bet_type || 'SPREAD',
          posterior_home: p.governor_snapshot?.posterior_home_prob ?? null,
          market_home: p.governor_snapshot?.components?.market_home ?? null,
          sigma: prior.cover?.sigma ?? null,
          total_spread: prior.model_spread ?? null,
          home_ml: prior.market?.home_ml ?? null,
          away_ml: prior.market?.away_ml ?? null,
          total: totalsByGame[p.game_id] ? {
            mu: totalsByGame[p.game_id].mu, sd: totalsByGame[p.game_id].sd,
            market_total: totalsByGame[p.game_id].market_total, model_total: totalsByGame[p.game_id].model_total,
            side: totalsByGame[p.game_id].side, p: totalsByGame[p.game_id].p, tier: totalsByGame[p.game_id].tier,
          } : null,
          game_id: p.game_id,
          decision: p.decision,
          direction: p.direction,
          side_team: p.side_label?.team || null,
          confidence: p.confidence,
          model_spread: prior.model_spread ?? null,
          market_spread: prior.market?.current_spread ?? null,
          home_cover: prior.cover?.home_cover ?? null,
          inputs: p.inputs || null,
        };
      });
      try {
        localStorage.setItem('edge_last_evaluations', JSON.stringify({ at: new Date().toISOString(), items: summary.evaluations }));
      } catch {}

      // ── Totals (over / under) for every game with a posted total ──
      const totalsByGame = {};
      priors.forEach(prior => {
        const g = prior._raw_game || {};
        const mt = Number(prior.market?.total ?? g.total);
        const model = Number(prior.projection?.total);
        if (!isFinite(mt) || !isFinite(model) || !window.EDGE_GOVERNOR?.rateTotal) return;
        const sp = prior.sport;
        // Weather can only lower an outdoor football total.
        let weatherAdj = 0;
        if (sp === 'NFL' || sp === 'NCAAF') {
          const env = (algoResults.find(r => r.prior?.game_id === prior.game_id)?.families || []).find(f => f.family === 'environment');
          if (env && Number(env.signal) < 0) weatherAdj = Number(env.signal) * 4;
        }
        const gh = Number(prior.home_power?.games_played), ga = Number(prior.away_power?.games_played);
        const full = { NFL: 8, NCAAF: 8, NBA: 20, WNBA: 12, NCAAB: 12, MLB: 40, NHL: 20, MLS: 10 }[sp] || 10;
        const certainty = (isFinite(gh) && isFinite(ga)) ? Math.max(0.25, Math.min(1, Math.min(gh, ga) / full)) : 1;
        const r = EDGE_GOVERNOR.rateTotal({ sport: sp, modelTotal: model, marketTotal: mt,
          overPrice: Number(g.over_price), underPrice: Number(g.under_price), weatherAdj, certainty });
        if (r) totalsByGame[prior.game_id] = { ...r, certainty: Math.round(certainty * 100) / 100 };
      });
      summary.totals = Object.keys(totalsByGame).length;

      // Where the passed games stopped, in one line.
      const tally = {};
      summary.evaluations.forEach(e => {
        if (!e.reason) return;
        const k = e.reason.startsWith('value too small') ? 'value too small'
          : e.reason.startsWith('held back') ? 'held back by the sport gate' : e.reason;
        tally[k] = (tally[k] || 0) + 1;
      });
      summary.pass_reasons = tally;
      if (Object.keys(tally).length) log('  passed: ' + Object.entries(tally).map(([k, n]) => `${n} ${k}`).join(' · '));

      summary.picks = picks;
      summary.stages.final_picks = picks.length;
      log(`  ${picks.length} actionable picks`);

      // ── Persist ──
      if (persist && (picks.length || finalResults.length)) {
        log('Persisting picks');
        const evaluatedIds = finalResults.map(p => p.game_id).filter(Boolean);
        // Every rated game is kept — passes included — so the Full Slate
        // view and the all-games record have them. Picks are the rows
        // whose decision is a bet tier.
        const rated = finalResults.filter(p => p.game_id && (p.direction === 'home' || p.direction === 'away'));
        const persistResult = await persistShadowPicks(rated, priors, mode, runId, evaluatedIds);
        if (persistResult.ok) {
          log(`  ${persistResult.count || 0} new · ${persistResult.updated || 0} refreshed · ` +
              `${persistResult.withdrawn || 0} withdrawn · ${persistResult.locked || 0} locked (bet placed or started)`);
          summary.persisted = persistResult.count || 0;
          summary.persist = { saved: persistResult.count || 0, refreshed: persistResult.updated || 0,
                              locked: persistResult.locked || 0, failed: persistResult.failed || 0,
                              error: (persistResult.errors || [])[0] || null };
        } else {
          log(`  persist failed: ${persistResult.status || ''} ${persistResult.reason || ''}`);
          summary.errors.push('Persist: ' + (persistResult.reason || 'unknown'));
        }

        if (Object.keys(totalsByGame).length) {
          const tr = await persistTotals(totalsByGame, priors, mode, runId);
          log(`  totals: ${tr.saved} new · ${tr.refreshed} refreshed${tr.failed ? ` · ${tr.failed} not saved (${tr.error})` : ''}`);
          if (summary.persist) summary.persist.totals = tr;
        }

        const portfolio = localStorage.getItem('edge_active_portfolio') || 'real';
        const bettingMode = localStorage.getItem('edge_betting_mode') || 'manual';
        if (portfolio === 'sim' || bettingMode === 'auto' || localStorage.getItem('edge_lock_on_first') === 'true') {
          log(`Auto-placing sim bets (portfolio=${portfolio}, mode=${bettingMode})`);
          const placed = autoPlaceSimBets(picks, priors, portfolio);
          log(`  ${placed} sim bets placed`);
          summary.auto_placed = placed;
        }
      }

      // ── Optional grading pass ──
      if (grade && window.EDGE_SHADOW_GRADER) {
        log('Grading ungraded picks');
        try {
          const g = await window.EDGE_SHADOW_GRADER.run({ onProgress: log });
          if (g.ok) {
            log(`  ${g.graded} graded · ${g.unresolved} unresolved · ${g.pending_no_score} awaiting score`);
            summary.graded = g.graded || 0;
          } else {
            log(`  grader: ${g.error || 'unknown'}`);
          }
          // Placed bets too, unless switched off in Settings.
          if (window.EDGE_SIM_GRADER && localStorage.getItem('edge_sim_auto_grade') !== 'false') {
            summary.bets_graded = 0;
            for (const m of ['sim', 'real']) {
              const b = await window.EDGE_SIM_GRADER.run({ mode: m, onProgress: log });
              if (b && b.ok) summary.bets_graded += b.graded || 0;
            }
          }
        } catch (e) {
          log('  grader threw: ' + e.message);
          logEdgeError('orch.grade', e);
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

  // Paged read. Supabase returns at most 1,000 rows per request no
  // matter what limit is asked for.
  async function fetchAllRows(base, key, maxRows = 200000) {
    const out = [];
    const pageSize = 1000;
    for (let offset = 0; offset < maxRows; offset += pageSize) {
      const res = await fetch(`${base}&limit=${pageSize}&offset=${offset}`,
        { headers: { apikey: key, Authorization: `Bearer ${key}` } });
      if (!res.ok) { if (offset === 0) throw new Error('HTTP ' + res.status); break; }
      const rows = await res.json();
      out.push(...rows);
      if (rows.length < pageSize) break;
    }
    return out;
  }

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

        // Paged: in winter the slate's sports hold more than the
        // 1,000 rows Supabase returns per request.
        const [teams, coaches] = await Promise.all([
          fetchAllRows(`${url}/rest/v1/power_ratings?select=*${sportFilter}&order=sport.asc,team_name.asc`, key)
            .catch(() => null),
          fetchAllRows(`${url}/rest/v1/coaching_ratings?select=*${sportFilter}&order=sport.asc,team_name.asc`, key)
            .catch(() => []),
        ]);

        if (teams) {
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
        const inj = context?.injuriesByGame?.[game.id] || null;
        const prior = await EDGE_POWER.computeGamePrior(game, {
          homeStats: homePower,
          awayStats: awayPower,
          league: powerIndex.league?.[sport] || null,
          adjustments: { qb_home_out: !!inj?.home_qb_out, qb_away_out: !!inj?.away_qb_out },
          external: context?.externalByGame?.[game.id] || null,
          rest: {
            home: context?.restByTeam?.[`${sport}:${game.home_team}`] ?? null,
            away: context?.restByTeam?.[`${sport}:${game.away_team}`] ?? null,
          },
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
            pin_home_spread: game.pin_home_spread ?? null,
            pin_home_price: game.pin_home_price ?? null,
            pin_away_price: game.pin_away_price ?? null,
            pin_home_ml: game.pin_home_ml ?? null,
            pin_away_ml: game.pin_away_ml ?? null,
            bench_book: game.bench_book ?? null,
            over_price: game.over_price ?? null,
            under_price: game.under_price ?? null,
            book: game.bookmaker ?? null,
            book_key: game.book_key ?? null,
            book_link: game.book_link ?? null,
            price_source: game.price_source ?? 'consensus',
          },
        });
        // MLB and NHL are bet on the moneyline at its real price (Settings
        // can turn this off). Their ±1.5 run and puck lines are priced
        // far from -110, so grading them at -110 was not a real bet.
        if (ML_SPORTS.has(sport) && localStorage.getItem('edge_ml_sports') !== 'false'
            && game.ml != null && game.away_ml != null) {
          prior.bet_type = 'ML';
        }
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

    const confidence = weightedStrength > 0
      ? Math.min(0.5 + weightedStrength * 0.06, 0.9)
      : 0.5;

    const fired = sitResult.situations || [];
    const reasons = fired.slice(0, 4).map(s => s.label).join(' · ');

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

  // The situations that fired for a game, each with the record the
  // Slate Test measured for it in this sport (none yet: an empty
  // record, which the governor reads as the default belief).
  function spotsFor(prior, sitResult) {
    const fired = (sitResult?.situations || []).filter(s => s.side === 'home' || s.side === 'away');
    if (!fired.length) return [];
    let records = {};
    try {
      const t = JSON.parse(localStorage.getItem('edge_governor_calibration') || '{}');
      const key = prior.bet_type === 'ML' ? `${prior.sport}_ML` : prior.sport;
      records = t?.spot_records?.[key] || {};
    } catch {}
    return fired.map(s => {
      // Only records rebuilt one-game-once by the current Slate Test;
      // older ones counted overlapping tests twice and are ignored
      // until that sport is tested again.
      const r = (records[s.id] && records[s.id].deduped) ? records[s.id] : {};
      const n = (r.wins || 0) + (r.losses || 0);
      return { id: s.id, label: s.label, side: s.side, group: s.group || r.group || null, wins: r.wins || 0, losses: r.losses || 0,
               base: (n && r.mkt_sum) ? r.mkt_sum / n : undefined };
    });
  }

  function runGovernor(algoResults, situationsByGame) {
    return algoResults
      .filter(r => r.families && r.families.length)
      .map(r => {
        const allFamilies = r.families;
        r.prior.spots = spotsFor(r.prior, situationsByGame[r.prior.game_id]);
        const dynamic = EDGE_GOVERNOR.getDynamicWeights(r.prior.sport);
        const gov = EDGE_GOVERNOR.run(allFamilies, r.prior, { dynamicWeights: dynamic });
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

  // Claude's confidence is its chance the side covers — the same
  // scale as the governor's — so it is sized on the governor's tiers.
  function mergeVerdict(gov, sel) {
    const t = window.EDGE_GOVERNOR?.THRESHOLDS?.DEFAULT || { bet2u: 57, bet1u: 55, lean: 53 };
    const c = sel.confidence;
    const [sized, units] = c >= t.bet2u ? ['BET_2U', 2] : c >= t.bet1u ? ['BET_1U', 1] : c >= t.lean ? ['LEAN', 0.5] : ['PASS', 0];
    return { ...gov, direction: sel.side, confidence: c, decision: sized, units, claude_reason: sel.reason };
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
  //
  // Dedup window is per game_id. A game that appears on the slate
  // for a full week was being written every day; now a single
  // pick survives, from whichever run saw it first.
  // ============================================================

  // A game has one pick row. Each run refreshes it until it is
  // locked: a bet has been logged on it, or the game has started.
  //   · no row yet, pick now      → insert
  //   · unlocked row, pick now    → update in place with this run's
  //                                 evaluation (line, numbers, side)
  //   · unlocked row, pass now    → withdrawn (deleted): the model no
  //                                 longer likes it, and nothing was bet
  // A pick made days ahead used to be frozen at its first evaluation,
  // blind to later injuries and line moves.
  // One row per game for its total, kept apart from the side rating
  // (decision TOTAL_2U / TOTAL_1U / TOTAL_LEAN / TOTAL_PASS). Graded
  // on the combined score at the posted total and price.
  async function persistTotals(totalsByGame, priors, mode, runId) {
    const url = SUPABASE_URL(), key = SUPABASE_KEY();
    const out = { saved: 0, refreshed: 0, failed: 0, error: null };
    if (!url || !key) return out;
    const headers = { apikey: key, Authorization: `Bearer ${key}` };
    const ids = Object.keys(totalsByGame);
    const existing = new Map();
    const since = new Date(Date.now() - 14 * 86400000).toISOString();
    for (let i = 0; i < ids.length; i += 100) {
      const inList = ids.slice(i, i + 100).map(id => `"${id}"`).join(',');
      try {
        const res = await fetch(`${url}/rest/v1/shadow_picks?select=id,game_id,decision&game_id=in.(${inList})&decision=like.TOTAL_*&created_at=gte.${since}`, { headers });
        if (res.ok) (await res.json()).forEach(r => { if (!existing.has(r.game_id)) existing.set(r.game_id, r.id); });
      } catch {}
    }
    const now = Date.now();
    const unitsFor = (t) => {
      const base = { '2U': 2, '1U': 1, LEAN: 0.5 }[t.tier] || 0;
      if (!base) return 0;
      // Untested totals bet small: tier × how settled the ratings are × 0.6.
      return Math.max(0.25, Math.round(base * (t.certainty || 1) * 0.6 * 4) / 4);
    };
    const rows = [];
    Object.entries(totalsByGame).forEach(([gid, t]) => {
      const prior = priors.find(x => x.game_id === gid) || {};
      if (prior.commence_time && new Date(prior.commence_time).getTime() <= now) return;   // started: locked
      rows.push({
        ...(existing.has(gid) ? { id: existing.get(gid) } : {}),
        run_id: runId, game_id: gid, pick_id: `${gid}:total`, sport: prior.sport,
        home_team: prior.home_team, away_team: prior.away_team, commence_time: prior.commence_time,
        decision_mode: mode, decision: 'TOTAL_' + t.tier, direction: t.side,
        side_team: `${t.side === 'over' ? 'Over' : 'Under'} ${t.market_total}`,
        confidence: Math.round(t.p * 1000) / 10, edge: Math.round((t.p - t.break_even) * 10000) / 10000,
        units: unitsFor(t), market_total: t.market_total,
        governor_snapshot: { bet_type: 'TOTAL', line: t.market_total, price: t.price, ev: t.ev, break_even: t.break_even,
          model_total: t.model_total, market_total: t.market_total, mu: t.mu, sd: t.sd, shift: t.shift,
          weight: t.weight, weight_source: t.weight_source, certainty: t.certainty, weather_adj: t.weather_adj, push: t.push },
      });
    });
    const send = async (list, query, prefer) => fetch(`${url}/rest/v1/shadow_picks${query}`, {
      method: 'POST', headers: { ...headers, 'Content-Type': 'application/json', Prefer: prefer }, body: JSON.stringify(list) });
    const post = async (list, query, prefer) => {
      let ok = 0;
      if (!list.length) return 0;
      try { const r = await send(list, query, prefer); if (r.ok) return list.length; out.error = `HTTP ${r.status} ${(await r.text().catch(() => '')).slice(0, 160)}`; } catch (e) { out.error = e.message; }
      for (const row of list) {
        try { const r1 = await send([row], query, prefer); if (r1.ok) ok++; else { out.failed++; if (!out.error) out.error = `HTTP ${r1.status}`; } } catch { out.failed++; }
      }
      return ok;
    };
    const updates = rows.filter(r => r.id), inserts = rows.filter(r => !r.id).map(r => ({ ...r, created_at: new Date().toISOString() }));
    out.refreshed = await post(updates, '?on_conflict=id', 'resolution=merge-duplicates,return=minimal');
    out.saved = await post(inserts, '', 'return=minimal');
    if (!out.failed) out.error = null;
    return out;
  }

  async function persistShadowPicks(picks, priors, mode, runId, evaluatedIds = []) {
    const url = SUPABASE_URL();
    const key = SUPABASE_KEY();
    if (!url || !key) return { ok: false, reason: 'Supabase not connected' };
    const headers = { apikey: key, Authorization: `Bearer ${key}` };

    const allIds = Array.from(new Set([...picks.map(p => p.game_id), ...evaluatedIds].filter(Boolean)));
    if (!allIds.length) return { ok: true, count: 0 };

    const windowStart = new Date(Date.now() - DEDUP_WINDOW_DAYS * 86400000);
    const existing = new Map();   // game_id → row id
    const betGames = new Set();
    const removedGames = new Set();   // picks you removed on the Picks page
    let betsReadable = true;

    for (let i = 0; i < allIds.length; i += 150) {
      const inList = allIds.slice(i, i + 150).map(id => `"${id}"`).join(',');
      try {
        const res = await fetch(
          `${url}/rest/v1/shadow_picks?select=id,game_id,decision&game_id=in.(${inList})&created_at=gte.${windowStart.toISOString()}`,
          { headers });
        if (res.ok) (await res.json()).forEach(r => {
          if (/^(LINE|TOTAL)_/.test(String(r.decision || ''))) return;
          if (!existing.has(r.game_id)) existing.set(r.game_id, r.id);
          if (r.decision === 'REMOVED') removedGames.add(r.game_id);
        });
      } catch (e) { logEdgeError('orch.persistCheck', e); }
      try {
        const res = await fetch(`${url}/rest/v1/bet_log?select=game_id&game_id=in.(${inList})`, { headers });
        if (res.ok) (await res.json()).forEach(r => betGames.add(r.game_id));
        else betsReadable = false;
      } catch { betsReadable = false; }
    }

    const priorByIdAll = new Map(priors.map(p => [p.game_id, p]));
    const started = (gid) => {
      const t = new Date(priorByIdAll.get(gid)?.commence_time || 0).getTime();
      return isFinite(t) && t > 0 && t <= Date.now();
    };
    // Without a readable bet_log, nothing already on file is touched.
    const locked = (gid) => !betsReadable || betGames.has(gid) || removedGames.has(gid) || started(gid);

    const pickIds = new Set(picks.map(p => p.game_id));
    const freshPicks = picks.filter(p => !existing.has(p.game_id));
    const refreshPicks = picks.filter(p => existing.has(p.game_id) && !locked(p.game_id));
    const withdrawIds = Array.from(existing.keys())
      .filter(gid => !pickIds.has(gid) && evaluatedIds.includes(gid) && !locked(gid))
      .map(gid => existing.get(gid));
    const lockedCount = picks.filter(p => existing.has(p.game_id) && locked(p.game_id)).length;

    const priorById = new Map(priors.map(p => [p.game_id, p]));

    const rows = [...freshPicks, ...refreshPicks].map(p => {
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

    const insertRows = rows.slice(0, freshPicks.length);
    const updateRows = rows.slice(freshPicks.length);
    let inserted = 0, updated = 0, withdrawn = 0;
    const errors = [];

    // One bad row used to sink the whole batch, silently: nothing was
    // saved and the Picks page stayed empty. A failed batch is now
    // retried row by row, so the good rows save and the first reason a
    // row was refused is reported on the Matchups status line.
    let failed = 0;
    const postRows = async (list, preferExtra = '', query = '') => {
      const send = async (chunk) => fetch(`${url}/rest/v1/shadow_picks${query}`, {
        method: 'POST',
        headers: { ...headers, 'Content-Type': 'application/json', Prefer: `${preferExtra}return=minimal` },
        body: JSON.stringify(chunk),
      });
      let ok = 0;
      for (let i = 0; i < list.length; i += 200) {
        const chunk = list.slice(i, i + 200);
        try {
          const res = await send(chunk);
          if (res.ok) { ok += chunk.length; continue; }
          errors.push(`HTTP ${res.status} ${(await res.text().catch(() => '')).slice(0, 200)}`);
        } catch (e) { errors.push(e.message); }
        for (const row of chunk) {
          try {
            const r1 = await send([row]);
            if (r1.ok) ok++;
            else { failed++; if (errors.length < 3) errors.push(`row ${row.game_id}: HTTP ${r1.status} ${(await r1.text().catch(() => '')).slice(0, 200)}`); }
          } catch (e) { failed++; }
        }
      }
      return ok;
    };

    if (insertRows.length) inserted = await postRows(insertRows);

    if (updateRows.length) {
      const batch = updateRows.map(row => { const { created_at, ...patch } = row; return { id: existing.get(row.game_id), ...patch }; });
      updated = await postRows(batch, 'resolution=merge-duplicates,', '?on_conflict=id');
    }

    if (withdrawIds.length) {
      try {
        const res = await fetch(`${url}/rest/v1/shadow_picks?id=in.(${withdrawIds.join(',')})`,
          { method: 'DELETE', headers });
        if (res.ok) withdrawn = withdrawIds.length;
        else errors.push(`withdraw HTTP ${res.status}`);
      } catch (e) { errors.push(e.message); }
    }

    if (errors.length && !inserted && !updated && !withdrawn) {
      return { ok: false, reason: errors[0] };
    }
    return { ok: true, count: inserted, updated, withdrawn, locked: lockedCount, failed, errors };
  }

  // ============================================================
  // ── AUTO SIM PLACEMENT ──
  //
  // Writes the same shape simulation.js writes. pick_type is
  // 'ATS', line is the actual spread as a number, odds is the
  // standard spread price. sim-grader.js reads all three
  // directly.
  // ============================================================

  function autoPlaceSimBets(picks, priors, portfolio) {
    if (!picks.length) return 0;
    const isSim = portfolio === 'sim';
    let placed = 0;

    // Lock the early number: every pick is placed the first time it
    // appears, whatever its confidence, so its line is kept.
    const lockFirst = localStorage.getItem('edge_lock_on_first') === 'true';
    const autoThreshold = lockFirst ? 0 : parseFloat(localStorage.getItem('edge_auto_threshold') || '0');
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

    const priorById = new Map((priors || []).map(p => [p.game_id, p]));
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

      const prior = priorById.get(pick.game_id);
      const matchup = prior
        ? `${prior.away_team} @ ${prior.home_team}`
        : '—';

      const gsnap = pick.governor_snapshot || {};
      const isMl = gsnap.bet_type === 'ML';
      const spread = gsnap.best?.home_line ?? pick.market_snapshot?.spread ?? null;

      placedBets.push({
        pick_id: pick.pick_id,
        game_id: pick.game_id,
        sport: pick.sport,
        matchup,
        pick_label: pick.side_label?.team || pick.direction,
        pick_type: isMl ? 'ML' : 'ATS',
        line: isMl ? '' : (spread != null ? String(spread) : ''),
        odds: isMl ? (gsnap.price ?? null) : (gsnap.best?.price ?? gsnap.price ?? DEFAULT_SPREAD_PRICE),
        units,
        stake,
        confidence: pick.confidence,
        edge: pick.edge,
        direction: pick.direction,
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
      // Local date, not UTC. An 8pm Eastern tip-off was being
      // logged as the next calendar day under the old code.
      const now = new Date();
      const localDate = `${now.getFullYear()}-${String(now.getMonth() + 1).padStart(2, '0')}-${String(now.getDate()).padStart(2, '0')}`;
      const localTime = now.toLocaleTimeString([], { hour: '2-digit', minute: '2-digit' });

      const rows = placedBets.map(b => ({
        mode: isSim ? 'sim' : 'real',
        date: localDate,
        time: localTime,
        sport: b.sport,
        matchup: b.matchup,
        pick_label: b.pick_label,
        pick_type: b.pick_type,
        line: b.line,
        odds: b.odds,
        confidence: b.confidence,
        edge: b.edge,
        units: b.units,
        amount: b.stake,
        status: 'pending',
        game_id: b.game_id,
        created_at: now.toISOString(),
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
    DEDUP_WINDOW_DAYS,
  };

})();

if (typeof window !== 'undefined') window.EDGE_ORCHESTRATOR = EDGE_ORCHESTRATOR;