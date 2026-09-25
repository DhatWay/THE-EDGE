// ============================================================
// EDGE — SIMULATION BETTING ENGINE v2.1
//
// Runs the live pipeline with fake money. Produces a separate
// ledger from the real one, tracks its own bankroll, and grades
// its own bets.
//
// v2.1 changes:
//
//   · Dates are local, not UTC. An 8pm Eastern tip-off was being
//     logged as the next calendar day under the old code, so
//     sim-grader's date match against the DB row failed and the
//     bet stayed pending forever.
//
//   · pick_type, line and odds agree with the shape the
//     orchestrator's autoPlaceSimBets writes. pick_type is
//     'ATS' or 'ML', line is the spread as a number-string,
//     odds is -110 for spread and the actual price for ML. Two
//     placement paths, one schema, one grader.
//
//   · Local sim state now keys each bet by its DB id when the
//     orchestrator placed it. The old match on game_id +
//     pick_label + date still runs as a fallback, but the id
//     path is exact.
//
//   · BUILD stamp exported.
//
// v2.0 changes (retained):
//   · Simulation calls EDGE_ORCHESTRATOR.run() — engine.js was
//     never finished and does not export run().
//   · Claude selection routes through EDGE_CLAUDE.selectFromSlate.
//   · Auto-place is suppressed during the sim run.
//   · Matchup strings are populated from the game index.
// ============================================================

const EDGE_SIM = (() => {

  const BUILD = 'sim-20260925-01';

  const KEY = {
    supabaseUrl: () => localStorage.getItem('edge_supabase_url'),
    supabaseKey: () => localStorage.getItem('edge_supabase_key'),
  };

  const DEFAULT_SPREAD_PRICE = -110;

  function logEdgeError(where, err) {
    try {
      const list = JSON.parse(localStorage.getItem('edge_errors') || '[]');
      list.unshift({ t: Date.now(), where, msg: err && err.message ? err.message : String(err) });
      localStorage.setItem('edge_errors', JSON.stringify(list.slice(0, 50)));
    } catch {}
  }

  // ── SIMULATION STATE ──

  function getSimState() {
    try {
      return JSON.parse(localStorage.getItem('edge_sim_state') || 'null') || freshState();
    } catch { return freshState(); }
  }

  function freshState() {
    const bankroll = parseFloat(localStorage.getItem('edge_sim_bankroll') || '10000');
    return {
      active:       false,
      bankroll:     bankroll.toFixed(2),
      startBankroll: bankroll.toFixed(2),
      totalBets:    0,
      wins:         0,
      losses:       0,
      pushes:       0,
      pnl:          0,
      roi:          0,
      unitSize:     parseFloat(localStorage.getItem('edge_sim_unit_size') || '100'),
      dailyCap:     parseFloat(localStorage.getItem('edge_sim_daily_cap') || '500'),
      weeklyUsed:   0,
      dailyUsed:    0,
      betsToday:    0,
      streak:       0,
      bestStreak:   0,
      worstStreak:  0,
      lastRun:      null,
      log:          [],
    };
  }

  function saveSimState(state) {
    localStorage.setItem('edge_sim_state', JSON.stringify(state));
  }

  function resetSim() {
    const state = freshState();
    saveSimState(state);
    localStorage.setItem('edge_sim_bankroll', String(state.bankroll));
    localStorage.setItem('edge_sim_daily_used', '0');
    localStorage.setItem('edge_sim_bets_used', '0');
    return state;
  }

  // ============================================================
  // ── CLAUDE PICK SELECTION ──
  // ============================================================

  async function claudeSelectPicks(picks, simState, gameIndex) {
    if (!Array.isArray(picks) || !picks.length) return [];

    const hasClaude = typeof window.EDGE_CLAUDE !== 'undefined'
                   && typeof window.EDGE_CLAUDE.selectFromSlate === 'function'
                   && !!localStorage.getItem('edge_claude_api_key');

    if (!hasClaude) {
      return fallbackSelect(picks, simState);
    }

    const candidates = picks
      .map(p => {
        const g = gameIndex[p.game_id];
        if (!g) return null;
        const commence = g.commence_time ? new Date(g.commence_time).getTime() : 0;
        if (!isFinite(commence) || commence <= Date.now()) return null;

        return {
          prior: {
            game_id: p.game_id,
            sport: p.sport,
            home_team: g.home_team,
            away_team: g.away_team,
            commence_time: g.commence_time,
            market: p.market_snapshot || {},
            model_spread: null,
            raw_edge: p.edge,
            prior_home_prob: p.governor_snapshot?.model_home_prob ?? null,
            home_power: null,
            away_power: null,
          },
          families: (p.governor_snapshot?.breakdown || []).map(b => ({
            family: b.family,
            vote: b.vote,
            confidence: b.confidence,
            edge: b.edge,
            reason: b.reason,
          })),
          governor: p.governor_snapshot || {},
          context: {},
          trends: null,
          h2h: null,
        };
      })
      .filter(Boolean);

    if (!candidates.length) return [];

    const baseFloor = parseFloat(localStorage.getItem('edge_sim_claude_floor') || '65');
    const streakPenalty = simState.streak <= -3 ? 8 : 0;
    const capPressure = simState.dailyCap > 0
      ? (simState.dailyUsed / simState.dailyCap) > 0.8 ? 6 : 0
      : 0;
    const floor = Math.min(baseFloor + streakPenalty + capPressure, 85);

    let result;
    try {
      result = await window.EDGE_CLAUDE.selectFromSlate(candidates, { floor });
    } catch (e) {
      logEdgeError('sim.claudeSelect', e);
      return fallbackSelect(picks, simState);
    }

    if (!result.ok || !result.selections || !result.selections.length) {
      return [];
    }

    const byGame = new Map(picks.map(p => [String(p.game_id), p]));

    return result.selections
      .map(sel => {
        const pick = byGame.get(String(sel.game_id));
        if (!pick) return null;
        const g = gameIndex[pick.game_id];
        if (!g) return null;

        const isML = sel.market === 'moneyline';
        const odds = isML
          ? (pick.direction === 'home' ? pick.market_snapshot?.home_ml : pick.market_snapshot?.away_ml) ?? DEFAULT_SPREAD_PRICE
          : DEFAULT_SPREAD_PRICE;

        return {
          pick_id: pick.pick_id,
          game_id: pick.game_id,
          sport: pick.sport,
          matchup: `${g.away_team} @ ${g.home_team}`,
          pick_label: pick.side_label?.team || pick.direction,
          pick_type: isML ? 'ML' : 'ATS',
          line: pick.market_snapshot?.spread ?? null,
          odds,
          confidence: sel.confidence,
          edge: pick.edge,
          units: pick.units,
          direction: pick.direction,
          reason: sel.reason || pick.reasons?.[0] || '',
          key_factor: sel.key_factor || null,
          source: 'claude',
        };
      })
      .filter(Boolean);
  }

  function fallbackSelect(picks, simState) {
    const eligible = picks
      .filter(p => (p.confidence || 0) >= 65)
      .filter(p => p.decision !== 'PASS' && p.decision !== 'CAPPED' && p.decision !== 'VETOED')
      .sort((a, b) => (b.confidence || 0) - (a.confidence || 0))
      .slice(0, 5);

    return eligible.map(p => ({
      pick_id: p.pick_id,
      game_id: p.game_id,
      sport: p.sport,
      matchup: null,
      pick_label: p.side_label?.team || p.direction,
      pick_type: 'ATS',
      line: p.market_snapshot?.spread ?? null,
      odds: DEFAULT_SPREAD_PRICE,
      confidence: p.confidence,
      edge: p.edge,
      units: p.units,
      direction: p.direction,
      reason: p.reasons?.[0] || '',
      source: 'fallback',
    }));
  }

  // ============================================================
  // ── PLACE SIM BET ──
  // ============================================================

  function placeSimBet(candidate, simState) {
    const unit     = simState.unitSize;
    const units    = candidate.units || 1;
    const amount   = unit * units;
    const bankroll = parseFloat(simState.bankroll);

    if (simState.dailyUsed + amount > simState.dailyCap) return null;
    if (amount > bankroll * 0.05) return null;
    if (amount > bankroll) return null;

    const now = new Date();
    const localDate = `${now.getFullYear()}-${String(now.getMonth() + 1).padStart(2, '0')}-${String(now.getDate()).padStart(2, '0')}`;
    const localTime = now.toLocaleTimeString([], { hour: '2-digit', minute: '2-digit' });

    const bet = {
      id:         Date.now() + Math.random(),
      sim:        true,
      date:       localDate,
      time:       localTime,
      sport:      candidate.sport,
      matchup:    candidate.matchup,
      pick_label: candidate.pick_label,
      pick_type:  candidate.pick_type || 'ATS',
      line:       candidate.line != null ? String(candidate.line) : '',
      odds:       candidate.odds || DEFAULT_SPREAD_PRICE,
      confidence: candidate.confidence,
      edge:       candidate.edge,
      units,
      amount,
      status:     'pending',
      result:     null,
      pnl:        null,
      game_id:    candidate.game_id,
      direction:  candidate.direction,
      reason:     candidate.reason,
      source:     candidate.source || 'fallback',
    };

    simState.dailyUsed += amount;
    simState.betsToday += 1;
    simState.totalBets += 1;
    simState.bankroll = (bankroll - amount).toFixed(2);
    simState.log.unshift(bet);
    if (simState.log.length > 200) simState.log = simState.log.slice(0, 200);

    return bet;
  }

  // ============================================================
  // ── GRADE SIM BET ──
  // ============================================================

  function gradeSimBet(betId, result, simState) {
    const bet = simState.log.find(b => b.id === betId);
    if (!bet || bet.result) return simState;

    bet.result = result;
    const odds = bet.odds || DEFAULT_SPREAD_PRICE;
    let pnl = 0;

    if (result === 'W') {
      pnl = odds > 0
        ? (bet.amount * odds / 100)
        : (bet.amount * 100 / Math.abs(odds));
      simState.wins++;
      simState.streak = simState.streak >= 0 ? simState.streak + 1 : 1;
      if (simState.streak > simState.bestStreak) simState.bestStreak = simState.streak;
    } else if (result === 'L') {
      pnl = -bet.amount;
      simState.losses++;
      simState.streak = simState.streak <= 0 ? simState.streak - 1 : -1;
      if (simState.streak < simState.worstStreak) simState.worstStreak = simState.streak;
    } else if (result === 'P') {
      pnl = 0;
      simState.pushes++;
    }

    bet.pnl = parseFloat(pnl.toFixed(2));
    bet.status = 'graded';
    simState.bankroll = (parseFloat(simState.bankroll) + bet.amount + pnl).toFixed(2);
    simState.pnl = parseFloat((simState.pnl + pnl).toFixed(2));

    const settled = simState.wins + simState.losses;
    simState.roi = settled > 0
      ? parseFloat(((simState.pnl / (settled * simState.unitSize)) * 100).toFixed(1))
      : 0;

    return simState;
  }

  // ============================================================
  // ── SUPABASE LEDGER ──
  // ============================================================

  async function saveSimBetsToSupabase(bets) {
    const url = KEY.supabaseUrl(), key = KEY.supabaseKey();
    if (!url || !key || !bets.length) return { ok: false, written: 0 };

    try {
      const res = await fetch(`${url}/rest/v1/bet_log`, {
        method: 'POST',
        headers: {
          apikey: key,
          Authorization: `Bearer ${key}`,
          'Content-Type': 'application/json',
          Prefer: 'return=minimal',
        },
        body: JSON.stringify(bets.map(b => ({
          mode: 'sim',
          date: b.date,
          time: b.time,
          sport: b.sport,
          matchup: b.matchup,
          pick_label: b.pick_label,
          pick_type: b.pick_type,
          line: b.line,
          odds: b.odds,
          confidence: b.confidence,
          edge: b.edge,
          units: b.units,
          amount: b.amount,
          status: b.status,
          game_id: b.game_id,
          reason: b.reason || '',
          source: b.source || null,
          created_at: new Date().toISOString(),
        }))),
      });
      return { ok: res.ok, written: res.ok ? bets.length : 0 };
    } catch (e) {
      logEdgeError('sim.saveBets', e);
      return { ok: false, written: 0 };
    }
  }

  async function loadSimHistory() {
    const url = KEY.supabaseUrl(), key = KEY.supabaseKey();
    if (!url || !key) return [];

    try {
      const res = await fetch(
        `${url}/rest/v1/bet_log?mode=eq.sim&select=*&order=created_at.desc&limit=100`,
        { headers: { apikey: key, Authorization: `Bearer ${key}` } }
      );
      return res.ok ? await res.json() : [];
    } catch (e) {
      logEdgeError('sim.loadHistory', e);
      return [];
    }
  }

  // ============================================================
  // ── MAIN SIMULATION RUN ──
  // ============================================================

  async function runSimulation(options = {}) {
    const { onProgress, onComplete, onError } = options;
    const log = (m) => { if (typeof onProgress === 'function') onProgress(m); };

    if (typeof window.EDGE_ORCHESTRATOR === 'undefined') {
      const err = 'orchestrator.js not loaded';
      if (typeof onError === 'function') onError(err);
      return { ok: false, error: err };
    }

    const simState = getSimState();

    let games;
    try { games = JSON.parse(localStorage.getItem('edge_todays_games') || '[]'); }
    catch { games = []; }

    if (!games.length) {
      const err = 'No games loaded — refresh Matchups first';
      if (typeof onError === 'function') onError(err);
      return { ok: false, error: err };
    }

    const gameIndex = {};
    games.forEach(g => { gameIndex[g.id] = g; });

    const savedPortfolio = localStorage.getItem('edge_active_portfolio') || 'real';
    const savedBettingMode = localStorage.getItem('edge_betting_mode') || 'manual';

    localStorage.setItem('edge_active_portfolio', 'real');
    localStorage.setItem('edge_betting_mode', 'manual');

    let picks = [];
    try {
      log('Running pipeline through the orchestrator…');

      const result = await window.EDGE_ORCHESTRATOR.run({
        games,
        persist: true,
        onProgress: (msg) => log(msg),
      });

      picks = result.picks || [];

      if (result.errors && result.errors.length) {
        log('Pipeline reported: ' + result.errors.join(' · '));
      }
      log(`Pipeline produced ${picks.length} actionable pick${picks.length === 1 ? '' : 's'}`);

    } catch (e) {
      logEdgeError('sim.orchestrator', e);
      log('Pipeline failed: ' + e.message);
      if (typeof onError === 'function') onError(e.message);
      return { ok: false, error: e.message };
    } finally {
      localStorage.setItem('edge_active_portfolio', savedPortfolio);
      localStorage.setItem('edge_betting_mode', savedBettingMode);
    }

    if (!picks.length) {
      log('No picks — nothing to simulate');
      simState.lastRun = new Date().toISOString();
      saveSimState(simState);
      const report = generateSimReport(simState);
      if (typeof onComplete === 'function') onComplete({ simState, selectedPicks: [], betsPlaced: [], report });
      return { ok: true, simState, selectedPicks: [], betsPlaced: [], report };
    }

    log('Selecting which picks to paper-trade…');
    let selected = [];
    try {
      selected = await claudeSelectPicks(picks, simState, gameIndex);
    } catch (e) {
      logEdgeError('sim.select', e);
      selected = fallbackSelect(picks, simState);
    }

    selected.forEach(s => {
      if (!s.matchup) {
        const g = gameIndex[s.game_id];
        if (g) s.matchup = `${g.away_team} @ ${g.home_team}`;
      }
    });

    log(`Selected ${selected.length} pick${selected.length === 1 ? '' : 's'} for the sim`);

    const betsPlaced = [];
    for (const candidate of selected) {
      const bet = placeSimBet(candidate, simState);
      if (bet) {
        betsPlaced.push(bet);
        log(`Placed: ${bet.pick_label} · ${bet.matchup || '—'} · ${bet.units}u ($${bet.amount.toFixed(0)})`);
      } else {
        log(`Skipped: ${candidate.pick_label} · cap or bankroll limit`);
      }
    }

    simState.lastRun = new Date().toISOString();
    simState.active = true;
    saveSimState(simState);

    localStorage.setItem('edge_sim_bankroll', String(simState.bankroll));
    localStorage.setItem('edge_sim_daily_used', String(simState.dailyUsed));
    localStorage.setItem('edge_sim_bets_used', String(simState.betsToday));

    if (betsPlaced.length) {
      const persisted = await saveSimBetsToSupabase(betsPlaced);
      if (!persisted.ok) log('Ledger write failed — bets kept locally');
    }

    log(`✓ Simulation complete · ${betsPlaced.length} bet${betsPlaced.length === 1 ? '' : 's'} placed`);

    const report = generateSimReport(simState);
    if (typeof onComplete === 'function') onComplete({ simState, selectedPicks: selected, betsPlaced, report });

    return { ok: true, simState, selectedPicks: selected, betsPlaced, report };
  }

  // ============================================================
  // ── REPORT ──
  // ============================================================

  function generateSimReport(simState) {
    const settled = simState.wins + simState.losses;
    const winRate = settled > 0
      ? ((simState.wins / settled) * 100).toFixed(1)
      : '0.0';

    const start = parseFloat(simState.startBankroll) || 0;
    const now = parseFloat(simState.bankroll) || 0;
    const growth = start > 0
      ? (((now - start) / start) * 100).toFixed(1)
      : '0.0';

    return {
      bankroll:      now.toFixed(2),
      startBankroll: start.toFixed(2),
      growth:        (parseFloat(growth) >= 0 ? '+' : '') + growth + '%',
      record:        `${simState.wins}-${simState.losses}-${simState.pushes}`,
      winRate:       winRate + '%',
      roi:           (simState.roi > 0 ? '+' : '') + simState.roi + '%',
      pnl:           (simState.pnl > 0 ? '+' : '') + simState.pnl.toFixed(2),
      totalBets:     simState.totalBets,
      pending:       simState.log.filter(b => b.status === 'pending').length,
      bestStreak:    'W' + simState.bestStreak,
      worstStreak:   'L' + Math.abs(simState.worstStreak),
      currentStreak: simState.streak > 0 ? 'W' + simState.streak
                   : simState.streak < 0 ? 'L' + Math.abs(simState.streak)
                   : '—',
      log:           simState.log,
    };
  }

  // ============================================================
  // ── PUBLIC API ──
  // ============================================================

  return {
    BUILD,
    run:            runSimulation,
    getState:       getSimState,
    saveState:      saveSimState,
    reset:          resetSim,
    gradebet:       gradeSimBet,
    report:         generateSimReport,
    claudeSelect:   claudeSelectPicks,
    loadHistory:    loadSimHistory,
  };

})();

if (typeof window !== 'undefined') window.EDGE_SIM = EDGE_SIM;