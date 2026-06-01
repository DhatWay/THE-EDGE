// ============================================================
// EDGE — SIMULATION BETTING ENGINE
// Runs full engine on real games with fake money
// Tracks performance separately from real bets
// Claude selects best picks based on confidence + edge + Kelly
// ============================================================

const EDGE_SIM = (() => {

  const KEY = {
    supabaseUrl: () => localStorage.getItem('edge_supabase_url'),
    supabaseKey: () => localStorage.getItem('edge_supabase_key'),
    claude:      () => localStorage.getItem('edge_claude_api_key'),
  };

  // ── SIMULATION STATE ──
  function getSimState() {
    try {
      return JSON.parse(localStorage.getItem('edge_sim_state') || 'null') || {
        active:       false,
        bankroll:     localStorage.getItem('edge_sim_bankroll') || '10000',
        startBankroll:localStorage.getItem('edge_sim_bankroll') || '10000',
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
    } catch { return {}; }
  }

  function saveSimState(state) {
    localStorage.setItem('edge_sim_state', JSON.stringify(state));
  }

  function resetSim() {
    const bankroll = localStorage.getItem('edge_sim_bankroll') || '10000';
    const state = {
      active: false, bankroll, startBankroll: bankroll,
      totalBets: 0, wins: 0, losses: 0, pushes: 0,
      pnl: 0, roi: 0,
      unitSize:  parseFloat(localStorage.getItem('edge_sim_unit_size') || '100'),
      dailyCap:  parseFloat(localStorage.getItem('edge_sim_daily_cap') || '500'),
      weeklyUsed: 0, dailyUsed: 0, betsToday: 0,
      streak: 0, bestStreak: 0, worstStreak: 0,
      lastRun: null, log: [],
    };
    saveSimState(state);
    return state;
  }

  // ── CLAUDE PICK SELECTOR ──
  // Claude reviews all picks and selects the best ones for simulation
  async function claudeSelectPicks(picks, simState) {
    const claudeKey = KEY.claude();
    if (!claudeKey || !picks.length) {
      // Without Claude: auto-select picks above 65% confidence
      return picks.filter(p => p.confidence >= 65).slice(0, 5);
    }

    const pickSummary = picks.map((p, i) =>
      `${i+1}. ${p.matchup} (${p.sport}) — ${p.pick_label} ${p.pick_type} ${p.line||''} | Conf: ${p.confidence}% | Edge: ${p.edge} | Units: ${p.units}u | Algos: ${p.yes_votes}/25 | Reason: ${p.reason?.slice(0,80)}`
    ).join('\n');

    const prompt = `You are EDGE, an elite AI sports betting analyst managing a simulation portfolio. Review these picks and select the BEST ones to bet today. Be highly selective — only pick the strongest edges.

SIMULATION BANKROLL: $${simState.bankroll}
DAILY CAP: $${simState.dailyCap}
UNIT SIZE: $${simState.unitSize}
DAILY USED: $${simState.dailyUsed}
TODAY'S RECORD: ${simState.wins}W-${simState.losses}L
CURRENT STREAK: ${simState.streak > 0 ? 'W' + simState.streak : 'L' + Math.abs(simState.streak)}

TODAY'S PICKS (${picks.length} total):
${pickSummary}

Select the best picks. Return ONLY a JSON array of pick numbers to bet, e.g. [1,3,5]
Rules:
- Max 5 picks per day
- Only picks with confidence >= 62%
- Prioritize: high edge + high consensus + strong CLV signal
- Avoid if: on a losing streak of 3+ (be more conservative)
- Consider daily cap remaining: $${simState.dailyCap - simState.dailyUsed}

Return JSON array only, no other text:`;

    try {
      const res = await fetch('https://api.anthropic.com/v1/messages', {
        method: 'POST',
        headers: { 'Content-Type': 'application/json', 'x-api-key': claudeKey, 'anthropic-version': '2023-06-01' },
        body: JSON.stringify({
          model: 'claude-sonnet-4-20250514',
          max_tokens: 100,
          messages: [{ role: 'user', content: prompt }]
        })
      });
      const data = await res.json();
      const text = data.content?.[0]?.text?.trim() || '[]';
      const selected = JSON.parse(text.replace(/```json|```/g, '').trim());
      return selected.map(i => picks[i - 1]).filter(Boolean);
    } catch {
      // Fallback: top 3 by confidence
      return picks.sort((a, b) => b.confidence - a.confidence).slice(0, 3);
    }
  }

  // ── PLACE SIMULATION BET ──
  function placeSimBet(pick, simState) {
    const unit     = simState.unitSize;
    const units    = pick.units || 1;
    const amount   = unit * units;
    const bankroll = parseFloat(simState.bankroll);

    // Cap enforcement
    if (simState.dailyUsed + amount > simState.dailyCap) return null;
    if (amount > bankroll * 0.05) return null; // never risk > 5% of bankroll on one bet

    const bet = {
      id:         Date.now() + Math.random(),
      sim:        true,
      date:       new Date().toISOString().split('T')[0],
      time:       new Date().toLocaleTimeString([], { hour: '2-digit', minute: '2-digit' }),
      sport:      pick.sport,
      matchup:    pick.matchup,
      pick_label: pick.pick_label,
      pick_type:  pick.pick_type,
      line:       pick.line,
      odds:       pick.odds || -110,
      confidence: pick.confidence,
      edge:       pick.edge,
      units,
      amount,
      status:     'pending',
      result:     null,
      pnl:        null,
      game_id:    pick.game_id,
      reason:     pick.reason,
    };

    simState.dailyUsed  += amount;
    simState.betsToday  += 1;
    simState.totalBets  += 1;
    simState.bankroll    = (bankroll - amount).toFixed(2);
    simState.log.unshift(bet);
    if (simState.log.length > 200) simState.log = simState.log.slice(0, 200);

    return bet;
  }

  // ── GRADE SIMULATION BET ──
  function gradeSimBet(betId, result, simState) {
    const bet = simState.log.find(b => b.id === betId);
    if (!bet || bet.result) return simState;

    bet.result = result;
    const odds  = bet.odds || -110;
    let pnl = 0;

    if (result === 'W') {
      // Calculate winnings from American odds
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
    simState.pnl      = parseFloat((simState.pnl + pnl).toFixed(2));

    const settled = simState.wins + simState.losses;
    simState.roi  = settled > 0
      ? parseFloat(((simState.pnl / (settled * simState.unitSize)) * 100).toFixed(1))
      : 0;

    return simState;
  }

  // ── SAVE SIM BETS TO SUPABASE ──
  async function saveSimBetsToSupabase(bets) {
    const url = KEY.supabaseUrl(), key = KEY.supabaseKey();
    if (!url || !key || !bets.length) return;
    try {
      await fetch(`${url}/rest/v1/bet_log`, {
        method: 'POST',
        headers: { 'apikey': key, 'Authorization': `Bearer ${key}`, 'Content-Type': 'application/json', 'Prefer': 'return=minimal' },
        body: JSON.stringify(bets.map(b => ({ ...b, mode: 'simulation', created_at: new Date().toISOString() })))
      });
    } catch {}
  }

  // ── LOAD SIM HISTORY FROM SUPABASE ──
  async function loadSimHistory() {
    const url = KEY.supabaseUrl(), key = KEY.supabaseKey();
    if (!url || !key) return [];
    try {
      const res = await fetch(`${url}/rest/v1/bet_log?mode=eq.simulation&select=*&order=created_at.desc&limit=100`, {
        headers: { 'apikey': key, 'Authorization': `Bearer ${key}` }
      });
      return res.ok ? await res.json() : [];
    } catch { return []; }
  }

  // ── MAIN SIMULATION RUN ──
  async function runSimulation(options = {}) {
    const { onProgress, onComplete, onError } = options;
    const simState = getSimState();

    try {
      onProgress?.('Starting simulation run...');

      // Run full engine to get today's picks
      onProgress?.('Running algorithm engine on live games...');
      const picks = await EDGE_ENGINE.run({
        onProgress: msg => onProgress?.(`Engine: ${msg}`),
      });

      if (!picks.length) {
        onProgress?.('No picks generated — check API connections');
        onComplete?.({ simState, selectedPicks: [], betsPlaced: [] });
        return;
      }

      onProgress?.(`${picks.length} picks generated — Claude reviewing...`);

      // Claude selects best picks
      const selectedPicks = await claudeSelectPicks(picks, simState);
      onProgress?.(`Claude selected ${selectedPicks.length} picks for simulation`);

      // Place simulation bets
      const betsPlaced = [];
      for (const pick of selectedPicks) {
        const bet = placeSimBet(pick, simState);
        if (bet) {
          betsPlaced.push(bet);
          onProgress?.(`Sim bet placed: ${pick.pick_label} ${pick.pick_type} — $${bet.amount}`);
        }
      }

      simState.lastRun = new Date().toISOString();
      simState.active  = true;
      saveSimState(simState);

      // Save to Supabase
      await saveSimBetsToSupabase(betsPlaced);

      onProgress?.(`✓ Simulation complete — ${betsPlaced.length} bets placed`);
      onComplete?.({ simState, selectedPicks, betsPlaced });

    } catch (e) {
      onError?.(e.message);
    }
  }

  // ── GENERATE SIMULATION REPORT ──
  function generateSimReport(simState) {
    const winRate = simState.wins + simState.losses > 0
      ? ((simState.wins / (simState.wins + simState.losses)) * 100).toFixed(1)
      : 0;
    const growth = simState.startBankroll > 0
      ? (((parseFloat(simState.bankroll) - parseFloat(simState.startBankroll)) / parseFloat(simState.startBankroll)) * 100).toFixed(1)
      : 0;

    return {
      bankroll:     simState.bankroll,
      startBankroll:simState.startBankroll,
      growth:       growth + '%',
      record:       `${simState.wins}-${simState.losses}-${simState.pushes}`,
      winRate:      winRate + '%',
      roi:          (simState.roi > 0 ? '+' : '') + simState.roi + '%',
      pnl:          (simState.pnl > 0 ? '+' : '') + simState.pnl.toFixed(2),
      totalBets:    simState.totalBets,
      bestStreak:   'W' + simState.bestStreak,
      worstStreak:  'L' + Math.abs(simState.worstStreak),
      currentStreak:simState.streak > 0 ? 'W' + simState.streak : 'L' + Math.abs(simState.streak),
      log:          simState.log,
    };
  }

  // ── PUBLIC API ──
  return {
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
