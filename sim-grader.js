// ============================================================
// EDGE — SIM GRADER v1.0
//
// The sim engine places paper bets and stores them in bet_log
// with mode='sim' and status='pending'. This module is what
// turns those pending rows into W/L/P.
//
// Workflow:
//   1. Read pending sim bets from bet_log.
//   2. Group them by game_id.
//   3. For each game, load the final score from historical_odds.
//   4. Grade each bet against the side it took.
//   5. PATCH the row with result, pnl, graded_at, status='graded'.
//   6. Update the local sim state so the betting page reflects
//      the same record.
//
// Idempotent. A row already marked graded is skipped, so a run
// twice a day does not double-count.
//
// Requires bet_log to carry result, pnl and graded_at columns.
// The probe() method reports whether each is present before
// attempting a write.
// ============================================================

const EDGE_SIM_GRADER = (() => {

  const BUILD = 'simgrade-20260924-01';

  const SUPABASE_URL = () => localStorage.getItem('edge_supabase_url');
  const SUPABASE_KEY = () => localStorage.getItem('edge_supabase_key');

  function logEdgeError(where, err) {
    try {
      const list = JSON.parse(localStorage.getItem('edge_errors') || '[]');
      list.unshift({ t: Date.now(), where, msg: err && err.message ? err.message : String(err) });
      localStorage.setItem('edge_errors', JSON.stringify(list.slice(0, 50)));
    } catch {}
  }

  const LOOKBACK_DAYS = 30;

  return {
    BUILD,
    run,
    gradeOne,
    probe,
  };

  // ============================================================
  // ── PROBE ──
  // ============================================================

  async function probe() {
    const url = SUPABASE_URL(), key = SUPABASE_KEY();
    const status = {
      connected: !!(url && key),
      bet_log: false,
      result_col: false,
      pnl_col: false,
      graded_at_col: false,
    };
    if (!status.connected) return status;

    const headers = { apikey: key, Authorization: `Bearer ${key}` };

    try {
      const r = await fetch(`${url}/rest/v1/bet_log?select=id&limit=1`, { headers });
      status.bet_log = r.ok;
    } catch {}

    if (status.bet_log) {
      try {
        const r = await fetch(`${url}/rest/v1/bet_log?select=result,pnl,graded_at&limit=1`, { headers });
        status.result_col = r.ok;
        status.pnl_col = r.ok;
        status.graded_at_col = r.ok;
      } catch {}
    }

    return status;
  }

  // ============================================================
  // ── MAIN ──
  // ============================================================

  async function run(options = {}) {
    const {
      mode = 'sim',
      onProgress = null,
      dryRun = false,
    } = options;
    const log = (m) => { if (typeof onProgress === 'function') onProgress(m); };

    const url = SUPABASE_URL(), key = SUPABASE_KEY();
    if (!url || !key) {
      return { ok: false, error: 'Supabase not connected' };
    }

    const schema = await probe();
    if (!schema.bet_log) {
      return { ok: false, error: 'bet_log table not readable' };
    }
    if (!schema.result_col) {
      log('bet_log is missing the result, pnl or graded_at column');
      log('Add them with:');
      log('alter table public.bet_log');
      log('  add column if not exists result text,');
      log('  add column if not exists pnl numeric,');
      log('  add column if not exists graded_at timestamptz;');
      return { ok: false, error: 'columns missing' };
    }

    // ── 1. Load pending bets ──
    const since = new Date(Date.now() - LOOKBACK_DAYS * 86400000).toISOString();
    const pending = await loadPending(mode, since, url, key);
    log(`${pending.length} pending ${mode} bets from the last ${LOOKBACK_DAYS} days`);

    if (!pending.length) {
      return { ok: true, graded: 0, unresolved: 0, pending: 0 };
    }

    // ── 2. Group by game ──
    const byGame = {};
    pending.forEach(b => {
      const gid = b.game_id;
      if (!gid) {
        log(`  ${b.pick_label} — no game_id, cannot grade`);
        return;
      }
      (byGame[gid] = byGame[gid] || []).push(b);
    });

    const gameIds = Object.keys(byGame);
    log(`  ${gameIds.length} unique game${gameIds.length === 1 ? '' : 's'}`);

    // ── 3. Load final scores ──
    const scores = await loadScores(gameIds, url, key);
    log(`  ${Object.keys(scores).length} games have a final score`);

    // ── 4. Grade each bet ──
    let graded = 0, unresolved = 0;
    const updates = [];

    for (const [gid, bets] of Object.entries(byGame)) {
      const score = scores[gid];
      if (!score) { unresolved += bets.length; continue; }

      for (const bet of bets) {
        const outcome = gradeOne(bet, score);
        if (!outcome) { unresolved++; continue; }

        updates.push({
          id: bet.id,
          result: outcome.result,
          pnl: outcome.pnl,
          graded_at: new Date().toISOString(),
          status: 'graded',
        });

        tryUpdateLocalSimState(bet, outcome);

        graded++;
      }
    }

    log(`  ${graded} graded · ${unresolved} unresolved`);

    // ── 5. Persist ──
    if (dryRun) {
      log('Dry run — no rows written');
      return { ok: true, graded, unresolved, pending: pending.length, dryRun: true };
    }

    if (updates.length) {
      const written = await writeGrades(updates, url, key, log);
      log(`  ${written} rows patched in bet_log`);
    }

    return {
      ok: true,
      graded,
      unresolved,
      pending: pending.length,
      written: updates.length,
    };
  }

  // ============================================================
  // ── LOAD PENDING ──
  // ============================================================

  async function loadPending(mode, since, url, key) {
    const out = [];
    const pageSize = 1000;

    for (let offset = 0; offset < 10000; offset += pageSize) {
      try {
        const res = await fetch(
          `${url}/rest/v1/bet_log?mode=eq.${encodeURIComponent(mode)}` +
          `&status=eq.pending&created_at=gte.${since}` +
          `&select=*&order=created_at.desc&limit=${pageSize}&offset=${offset}`,
          { headers: { apikey: key, Authorization: `Bearer ${key}` } }
        );
        if (!res.ok) break;
        const rows = await res.json();
        out.push(...rows);
        if (rows.length < pageSize) break;
      } catch (e) {
        logEdgeError('simGrader.loadPending', e);
        break;
      }
    }

    return out;
  }

  // ============================================================
  // ── LOAD FINAL SCORES ──
  // ============================================================

  async function loadScores(gameIds, url, key) {
    const out = {};
    if (!gameIds.length) return out;

    const chunkSize = 200;
    for (let i = 0; i < gameIds.length; i += chunkSize) {
      const chunk = gameIds.slice(i, i + chunkSize);
      const inList = chunk.map(id => `"${id}"`).join(',');

      try {
        const res = await fetch(
          `${url}/rest/v1/historical_odds?select=game_id,home,away,home_score,away_score,spread,total` +
          `&game_id=in.(${inList})&home_score=not.is.null&away_score=not.is.null&limit=5000`,
          { headers: { apikey: key, Authorization: `Bearer ${key}` } }
        );
        if (!res.ok) continue;
        const rows = await res.json();
        rows.forEach(r => {
          out[r.game_id] = {
            home: r.home,
            away: r.away,
            home_score: r.home_score,
            away_score: r.away_score,
            spread: r.spread,
            total: r.total,
          };
        });
      } catch (e) {
        logEdgeError('simGrader.loadScores', e);
      }
    }

    return out;
  }

  // ============================================================
  // ── GRADE ONE ──
  //
  // pick_label is the team name — physics builds it from
  // side_label.team. Match it against home or away, then apply
  // the pick type.
  //
  //   ATS:   pick team's cover margin against the bet's line.
  //   ML:    pick team won outright.
  //   Total: over/under against combined score.
  // ============================================================

  function gradeOne(bet, score) {
    const type = (bet.pick_type || 'ATS').toUpperCase();
    const label = String(bet.pick_label || '').trim();
    if (!label) return null;

    const home = String(score.home || '');
    const away = String(score.away || '');
    const homeScore = Number(score.home_score);
    const awayScore = Number(score.away_score);

    let side = null;
    if (label === home) side = 'home';
    else if (label === away) side = 'away';
    else {
      const l = label.toLowerCase();
      if (home.toLowerCase().includes(l) || l.includes(home.toLowerCase())) side = 'home';
      else if (away.toLowerCase().includes(l) || l.includes(away.toLowerCase())) side = 'away';
    }

    if (!side) return null;

    const margin = homeScore - awayScore;
    const combined = homeScore + awayScore;
    const odds = Number(bet.odds) || -110;

    const winMultiplier = odds > 0 ? (odds / 100) : (100 / Math.abs(odds));

    if (type === 'ML') {
      if (margin === 0) return { result: 'P', pnl: 0 };
      const pickWon = (side === 'home' && margin > 0) || (side === 'away' && margin < 0);
      const stake = Number(bet.amount) || 0;
      return pickWon
        ? { result: 'W', pnl: round(stake * winMultiplier, 2) }
        : { result: 'L', pnl: round(-stake, 2) };
    }

    if (type === 'TOTAL') {
      const line = Number(bet.line);
      if (!isFinite(line)) return null;
      const overUnder = /over/i.test(label) ? 'over' : /under/i.test(label) ? 'under' : null;
      if (!overUnder) return null;
      if (Math.abs(combined - line) < 0.01) return { result: 'P', pnl: 0 };
      const won = overUnder === 'over' ? combined > line : combined < line;
      const stake = Number(bet.amount) || 0;
      return won
        ? { result: 'W', pnl: round(stake * winMultiplier, 2) }
        : { result: 'L', pnl: round(-stake, 2) };
    }

    // Default: ATS.
    const spread = Number(bet.line);
    if (!isFinite(spread)) return null;

    const pickSpread = side === 'home' ? spread : -spread;
    const pickMargin = side === 'home' ? margin : -margin;
    const coverMargin = pickMargin + pickSpread;

    const stake = Number(bet.amount) || 0;

    if (Math.abs(coverMargin) < 0.01) return { result: 'P', pnl: 0 };
    return coverMargin > 0
      ? { result: 'W', pnl: round(stake * winMultiplier, 2) }
      : { result: 'L', pnl: round(-stake, 2) };
  }

  // ============================================================
  // ── LOCAL SIM STATE MIRROR ──
  //
  // The sim page reads edge_sim_state from localStorage. If a bet
  // placed through the sim engine on this device is graded here,
  // the local record has to reflect that — otherwise the page
  // shows a pending bet while the DB shows a W.
  //
  // The match is game_id + pick_label + date. Local ids are
  // Date.now() + Math.random(), DB ids are bigint, so they cannot
  // be joined directly.
  // ============================================================

  function tryUpdateLocalSimState(dbBet, outcome) {
    try {
      const raw = localStorage.getItem('edge_sim_state');
      if (!raw) return;
      const state = JSON.parse(raw);
      if (!state || !Array.isArray(state.log)) return;

      const target = state.log.find(b =>
        String(b.game_id) === String(dbBet.game_id) &&
        String(b.pick_label || '') === String(dbBet.pick_label || '') &&
        b.date === dbBet.date &&
        !b.result
      );
      if (!target) return;

      target.result = outcome.result;
      target.pnl = outcome.pnl;
      target.status = 'graded';

      const stake = Number(target.amount) || 0;

      if (outcome.result === 'W') {
        state.wins = (state.wins || 0) + 1;
        state.streak = (state.streak || 0) >= 0 ? (state.streak || 0) + 1 : 1;
        if (state.streak > (state.bestStreak || 0)) state.bestStreak = state.streak;
        state.bankroll = (parseFloat(state.bankroll) + stake + outcome.pnl).toFixed(2);
      } else if (outcome.result === 'L') {
        state.losses = (state.losses || 0) + 1;
        state.streak = (state.streak || 0) <= 0 ? (state.streak || 0) - 1 : -1;
        if (state.streak < (state.worstStreak || 0)) state.worstStreak = state.streak;
        state.bankroll = (parseFloat(state.bankroll) + stake).toFixed(2);
      } else if (outcome.result === 'P') {
        state.pushes = (state.pushes || 0) + 1;
        state.bankroll = (parseFloat(state.bankroll) + stake).toFixed(2);
      }

      state.pnl = parseFloat(((state.pnl || 0) + outcome.pnl).toFixed(2));

      const settled = (state.wins || 0) + (state.losses || 0);
      state.roi = settled > 0
        ? parseFloat(((state.pnl / (settled * (state.unitSize || 100))) * 100).toFixed(1))
        : 0;

      localStorage.setItem('edge_sim_state', JSON.stringify(state));
    } catch (e) {
      logEdgeError('simGrader.localMirror', e);
    }
  }

  // ============================================================
  // ── WRITE GRADES ──
  // ============================================================

  async function writeGrades(updates, url, key, log) {
    let written = 0;
    const headers = {
      apikey: key,
      Authorization: `Bearer ${key}`,
      'Content-Type': 'application/json',
      Prefer: 'return=minimal',
    };

    for (const u of updates) {
      try {
        const res = await fetch(`${url}/rest/v1/bet_log?id=eq.${u.id}`, {
          method: 'PATCH',
          headers,
          body: JSON.stringify({
            result: u.result,
            pnl: u.pnl,
            graded_at: u.graded_at,
            status: u.status,
          }),
        });
        if (res.ok) written++;
        else {
          const body = await res.text().catch(() => '');
          log(`    patch ${u.id}: HTTP ${res.status} ${body.slice(0, 120)}`);
        }
      } catch (e) {
        log(`    patch ${u.id}: ${e.message}`);
        logEdgeError('simGrader.writeGrade', e);
      }
    }

    return written;
  }

  // ============================================================
  // ── UTILITIES ──
  // ============================================================

  function round(v, d) { const f = Math.pow(10, d); return Math.round(v * f) / f; }

})();

if (typeof window !== 'undefined') window.EDGE_SIM_GRADER = EDGE_SIM_GRADER;