// ============================================================
// EDGE — SIM GRADER v2.0
//
// The sim engine places paper bets and stores them in bet_log
// with mode='sim' and status='pending'. This module is what
// turns those pending rows into W/L/P.
//
// v2.0 changes:
//
//   · Resolves the game id. bet_log.game_id is The Odds API's
//     event id. historical_odds.game_id is ESPN's event id.
//     They are unrelated strings. The old code queried
//     historical_odds by the bet's id and always found nothing,
//     so no sim bet ever graded. The lookup now goes through
//     EDGE_GAME_ID_MAP.resolveFromOddsId() first.
//
//   · Handles the old empty-line rows. Auto-placed bets before
//     the orchestrator v3.2 change wrote line: '' and used the
//     moneyline as the price for either side. Number('') is 0,
//     so an old row would have graded as pick'em. Those rows
//     are now reported as legacy_format and skipped rather than
//     mis-graded.
//
//   · Reports every unresolved id per run rather than swallowing
//     it. If a game_id has no link in game_id_map yet, the row
//     stays pending and the count shows up in the summary.
//
// Workflow:
//   1. Read pending sim bets from bet_log.
//   2. Resolve each game_id via game-id-map.js.
//   3. Load final scores from historical_odds by the ESPN id.
//   4. Grade each bet against the side it took.
//   5. PATCH the row with result, pnl, graded_at, status='graded'.
//   6. Update the local sim state so the betting page reflects
//      the same record.
//
// Idempotent. A row already marked graded is skipped, so a run
// twice a day does not double-count.
// ============================================================

const EDGE_SIM_GRADER = (() => {

  const BUILD = 'simgrade-20260925-01';

  const SUPABASE_URL = () => localStorage.getItem('edge_supabase_url');
  const SUPABASE_KEY = () => localStorage.getItem('edge_supabase_key');

  function logEdgeError(where, err) {
    try {
      const list = JSON.parse(localStorage.getItem('edge_errors') || '[]');
      list.unshift({ t: Date.now(), where, msg: err && err.message ? err.message : String(err) });
      localStorage.setItem('edge_errors', JSON.stringify(list.slice(0, 50)));
    } catch {}
  }

  // How far back to look for pending bets. Older than a month and
  // they are stale — either the game was never scheduled, or the
  // score was never written. Reported as unresolved rather than
  // left silently in the pending queue forever.
  const LOOKBACK_DAYS = 30;

  const DEFAULT_SPREAD_PRICE = -110;

  return {
    BUILD,
    run,
    gradeOne,
    probe,
    SCHEMA_SQL: `alter table public.bet_log
  add column if not exists result text,
  add column if not exists pnl numeric,
  add column if not exists graded_at timestamptz;`,
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
      game_id_map: false,
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

    try {
      const r = await fetch(`${url}/rest/v1/game_id_map?select=id&limit=1`, { headers });
      status.game_id_map = r.ok;
    } catch {}

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
      log('bet_log is missing the result/pnl/graded_at columns');
      log('Add them with:');
      log(SCHEMA_SQL);
      return { ok: false, error: 'columns missing', sql: SCHEMA_SQL };
    }
    if (!schema.game_id_map) {
      log('game_id_map table is missing — sim bets cannot resolve their score');
      log('Run EDGE_GAME_ID_MAP.schemaSql() output in the Supabase editor');
      return { ok: false, error: 'game_id_map missing' };
    }
    if (typeof window.EDGE_GAME_ID_MAP === 'undefined') {
      log('game-id-map.js module not loaded');
      return { ok: false, error: 'EDGE_GAME_ID_MAP not loaded' };
    }

    // ── 1. Load pending bets ──
    const since = new Date(Date.now() - LOOKBACK_DAYS * 86400000).toISOString();
    const pending = await loadPending(mode, since, url, key);
    log(`${pending.length} pending ${mode} bets from the last ${LOOKBACK_DAYS} days`);

    if (!pending.length) {
      return { ok: true, graded: 0, unresolved: 0, legacy: 0, pending: 0 };
    }

    // ── 2. Filter legacy-format rows ──
    // Rows written before orchestrator v3.2 carry pick_type 'HOME'
    // or an empty line. They cannot be graded correctly.
    const gradable = [];
    let legacy = 0;
    for (const b of pending) {
      if (isLegacyFormat(b)) { legacy++; continue; }
      gradable.push(b);
    }
    if (legacy) {
      log(`  ${legacy} legacy-format rows skipped (written before v3.2 shape)`);
    }

    // ── 3. Group by game ──
    const byGame = {};
    for (const b of gradable) {
      const gid = b.game_id;
      if (!gid) {
        log(`  ${b.pick_label} — no game_id, cannot grade`);
        continue;
      }
      (byGame[gid] = byGame[gid] || []).push(b);
    }

    const uniqueGameIds = Object.keys(byGame);
    log(`  ${uniqueGameIds.length} unique game${uniqueGameIds.length === 1 ? '' : 's'}`);

    // ── 4. Resolve Odds API ids to ESPN ids ──
    const idMap = {};
    let resolvedCount = 0;
    for (const gid of uniqueGameIds) {
      try {
        const espnId = await window.EDGE_GAME_ID_MAP.resolveFromOddsId(gid);
        if (espnId) { idMap[gid] = espnId; resolvedCount++; }
      } catch (e) {
        logEdgeError('simGrader.resolveId', e);
      }
    }
    log(`  ${resolvedCount}/${uniqueGameIds.length} game ids resolved to ESPN`);

    // ── 5. Load final scores ──
    const espnIds = Object.values(idMap);
    const scores = await loadScores(espnIds, url, key);
    log(`  ${Object.keys(scores).length} games have a final score`);

    // ── 6. Grade each bet ──
    let graded = 0;
    let unresolved = 0;
    let pendingScore = 0;
    const updates = [];

    for (const [gid, bets] of Object.entries(byGame)) {
      const espnId = idMap[gid];
      if (!espnId) { unresolved += bets.length; continue; }

      const score = scores[espnId];
      if (!score) { pendingScore += bets.length; continue; }

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

    log(`  ${graded} graded · ${unresolved} unresolved · ${pendingScore} awaiting score`);

    // ── 7. Persist ──
    if (dryRun) {
      log('Dry run — no rows written');
      return {
        ok: true, graded, unresolved, legacy,
        pending_score: pendingScore, pending: pending.length, dryRun: true,
      };
    }

    if (updates.length) {
      const written = await writeGrades(updates, url, key, log);
      log(`  ${written} rows patched in bet_log`);
    }

    return {
      ok: true,
      graded,
      unresolved,
      legacy,
      pending_score: pendingScore,
      pending: pending.length,
      written: updates.length,
    };
  }

  // ============================================================
  // ── LEGACY FORMAT ──
  //
  // Auto-placed bets before orchestrator v3.2 wrote:
  //   pick_type: 'HOME'
  //   line: ''
  //   odds: the home moneyline for either side
  //
  // Number('') is 0, so an ATS grade would compute against a
  // spread of zero. Those rows cannot be graded correctly and
  // are skipped rather than corrupted.
  // ============================================================

  function isLegacyFormat(bet) {
    if (bet.pick_type === 'HOME' || bet.pick_type === 'AWAY') return true;
    if (bet.pick_type == null) return true;

    // ATS / ML / TOTAL with an empty line, when the pick_type
    // requires one, is also legacy.
    if (bet.pick_type === 'ATS' || bet.pick_type === 'TOTAL') {
      if (bet.line == null) return true;
      const lineStr = String(bet.line).trim();
      if (lineStr === '') return true;
    }
    return false;
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

  async function loadScores(espnIds, url, key) {
    const out = {};
    if (!espnIds.length) return out;

    const chunkSize = 200;
    for (let i = 0; i < espnIds.length; i += chunkSize) {
      const chunk = espnIds.slice(i, i + chunkSize);
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
          out[String(r.game_id)] = {
            home: r.home,
            away: r.away,
            home_score: Number(r.home_score),
            away_score: Number(r.away_score),
            spread: r.spread != null ? Number(r.spread) : null,
            total: r.total != null ? Number(r.total) : null,
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
  // pick_label is the team name (physics builds it from
  // side_label.team). To grade, match it against home or away,
  // then apply the pick_type.
  //
  //   ATS: pick team's cover margin against the bet's line.
  //   ML:  pick team won outright.
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
    if (!isFinite(homeScore) || !isFinite(awayScore)) return null;

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
    const odds = Number(bet.odds) || DEFAULT_SPREAD_PRICE;
    const winMultiplier = odds > 0 ? (odds / 100) : (100 / Math.abs(odds));
    const stake = Number(bet.amount) || 0;

    if (type === 'ML') {
      if (margin === 0) return { result: 'P', pnl: 0 };
      const pickWon = (side === 'home' && margin > 0) || (side === 'away' && margin < 0);
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
      return won
        ? { result: 'W', pnl: round(stake * winMultiplier, 2) }
        : { result: 'L', pnl: round(-stake, 2) };
    }

    // ATS
    const spread = Number(bet.line);
    if (!isFinite(spread)) return null;

    const pickSpread = side === 'home' ? spread : -spread;
    const pickMargin = side === 'home' ? margin : -margin;
    const coverMargin = pickMargin + pickSpread;

    if (Math.abs(coverMargin) < 0.01) return { result: 'P', pnl: 0 };
    return coverMargin > 0
      ? { result: 'W', pnl: round(stake * winMultiplier, 2) }
      : { result: 'L', pnl: round(-stake, 2) };
  }

  // ============================================================
  // ── LOCAL SIM STATE MIRROR ──
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