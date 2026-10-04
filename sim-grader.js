// ============================================================
// EDGE — SIM GRADER v2.1
//
// The sim engine places paper bets and stores them in bet_log
// with mode='sim' and status='pending'. This module is what
// turns those pending rows into W/L/P.
//
// v2.1 changes:
//
//   · The result, pnl and graded_at columns are probed once
//     per run instead of assumed. If any of them is missing
//     on bet_log, the PATCH would 400 with no grade written
//     and no clear error. The run now reports the missing
//     column and stops before touching any row.
//
//   · Every unresolved id is counted and reported. The old
//     code's summary collapsed unresolved ids, legacy rows,
//     and awaiting-score rows into a single number. The
//     caller now sees three separate counts.
//
// v2.0 changes (retained):
//   · Resolves the game id through game-id-map.js.
//   · Handles old empty-line rows (written before
//     orchestrator v3.2) by skipping them.
// ============================================================

const EDGE_SIM_GRADER = (() => {

  const BUILD = 'simgrade-20261005-02';

  const SUPABASE_URL = () => localStorage.getItem('edge_supabase_url');
  const SUPABASE_KEY = () => localStorage.getItem('edge_supabase_key');

  function logEdgeError(where, err) {
    try {
      const list = JSON.parse(localStorage.getItem('edge_errors') || '[]');
      list.unshift({ t: Date.now(), where, msg: err && err.message ? err.message : String(err) });
      localStorage.setItem('edge_errors', JSON.stringify(list.slice(0, 50)));
    } catch {}
  }

  // How far back to look for pending bets.
  const LOOKBACK_DAYS = 30;

  const DEFAULT_SPREAD_PRICE = -110;

  const SCHEMA_SQL = `alter table public.bet_log
  add column if not exists result text,
  add column if not exists pnl numeric,
  add column if not exists graded_at timestamptz;`;

  return {
    BUILD,
    run,
    gradeOne,
    probe,
    SCHEMA_SQL,
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
    if (!schema.result_col || !schema.pnl_col || !schema.graded_at_col) {
      log('bet_log is missing one or more of the grading columns:');
      if (!schema.result_col)    log('  result');
      if (!schema.pnl_col)       log('  pnl');
      if (!schema.graded_at_col) log('  graded_at');
      log('Add them with:');
      log(SCHEMA_SQL);
      return { ok: false, error: 'columns missing', sql: SCHEMA_SQL };
    }
    if (!schema.game_id_map) {
      log('game_id_map table is missing — sim bets cannot resolve their score');
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
      return { ok: true, graded: 0, unresolved: 0, legacy: 0, pending_score: 0, pending: 0 };
    }

    // ── 2. Filter legacy-format rows ──
    // Rows written before orchestrator v3.2 carry pick_type
    // 'HOME' or 'AWAY' or an empty line. They cannot be
    // graded correctly.
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

    // ── 5b. Straight from ESPN for games still without a score ──
    // Bets waited on the id link and on Build ATS for their final
    // score. Each still-missing game is now looked up on ESPN, using
    // the pick's teams and start time.
    const missing = uniqueGameIds.filter(gid => !(idMap[gid] && scores[idMap[gid]]));
    if (missing.length && !(window.EDGE_SHADOW_GRADER && EDGE_SHADOW_GRADER.findFinal)) {
      log('  still ungraded: the ESPN lookup (shadow-grader.js) is not loaded on this page');
    }
    if (missing.length && window.EDGE_SHADOW_GRADER && EDGE_SHADOW_GRADER.findFinal) {
      const info = await loadPickInfo(missing, url, key);
      let direct = 0;
      const why = {};
      const note = (k, b) => { (why[k] = why[k] || []).push(b); };
      for (const gid of missing) {
        const b0 = byGame[gid][0];
        let p = info[gid];
        const sport = b0.sport || p?.sport;
        // No pick on file for this bet's game (a bet placed from another
        // page): its teams come from the bet's matchup ("Away vs Home"),
        // and ESPN is searched from the day it was placed to a week later.
        if (!p) {
          const m = String(b0.matchup || '').split(/\s+(?:vs\.?|@|at)\s+/i);
          if (m.length === 2 && b0.created_at) {
            p = { sport, away_team: m[0].trim(), home_team: m[1].trim(), _search_from: b0.created_at };
          }
        }
        if (!p) { note('no game details on the bet', b0); continue; }
        if (p.commence_time && Date.now() - new Date(p.commence_time).getTime() < 4 * 3600000) { note('not finished yet', b0); continue; }
        let fin = idMap[gid] ? await EDGE_SHADOW_GRADER.finalById(sport, idMap[gid]) : null;
        if (!fin && p.commence_time) fin = await EDGE_SHADOW_GRADER.findFinal({ ...p, sport });
        if (!fin && p._search_from) {
          for (let d = 0; d <= 8 && !fin; d++) {
            const day = new Date(new Date(p._search_from).getTime() + d * 86400000);
            if (day.getTime() > Date.now()) break;
            fin = await EDGE_SHADOW_GRADER.findFinal({ ...p, sport, commence_time: day.toISOString() });
          }
        }
        if (!fin) { note('no matching game on ESPN', b0); continue; }
        if (!fin.completed || !isFinite(fin.home_score) || !isFinite(fin.away_score)) { note('ESPN does not show it as final yet', b0); continue; }
        const eid = idMap[gid] || fin.espn_id;
        idMap[gid] = eid;
        scores[eid] = { home: p.home_team, away: p.away_team, home_score: fin.home_score, away_score: fin.away_score,
                        spread: null, total: null };
        direct++;
        try { if (!info[gid]._linked && window.EDGE_GAME_ID_MAP?.link) await EDGE_GAME_ID_MAP.link(gid, fin.espn_id, { sport, home_team: p.home_team, away_team: p.away_team, commence_time: p.commence_time, confidence: 'grader' }); } catch {}
      }
      if (direct) log(`  ${direct} game${direct === 1 ? '' : 's'} scored straight from ESPN`);
      Object.entries(why).forEach(([k, list]) => {
        log(`  still ungraded: ${list.length} bet${list.length === 1 ? '' : 's'} — ${k}` +
            ` (e.g. ${list.slice(0, 2).map(b => `${b.pick_label || ''} · ${b.matchup || b.game_id}`).join('; ')})`);
      });
    }

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
  // ============================================================

  // "Away @ Home" or "Away vs Home" — the order every writer uses.
  function sideFromMatchup(label, matchup) {
    const parts = String(matchup || '').split(/\s+(?:@|vs\.?|at)\s+/i);
    if (parts.length !== 2) return null;
    const [awayName, homeName] = parts.map(x => x.trim());
    if (sameTeam(label, homeName)) return 'home';
    if (sameTeam(label, awayName)) return 'away';
    return null;
  }

  function sameTeam(a, b) {
    if (!a || !b) return false;
    const norm = (s) => (window.EDGE_TEAMS && typeof window.EDGE_TEAMS.normalize === 'function')
      ? window.EDGE_TEAMS.normalize(s)
      : String(s).toLowerCase().replace(/[^a-z0-9]/g, '');
    try { return norm(a) === norm(b); } catch { return false; }
  }

  // Older Picks-page rows are HOME / AWAY spread bets with the home
  // spread in `line`; they grade when the line is a number. Only an
  // empty line (old auto-placed rows) cannot be graded.
  function isLegacyFormat(bet) {
    if (bet.pick_type === 'HOME' || bet.pick_type === 'AWAY') {
      const line = String(bet.line ?? '').trim();
      return line === '' || !isFinite(Number(line));
    }
    if (bet.pick_type == null) return true;

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

  // Teams and start time for each game, from the pick it came from.
  async function loadPickInfo(gameIds, url, key) {
    const out = {};
    for (let i = 0; i < gameIds.length; i += 100) {
      const chunk = gameIds.slice(i, i + 100).map(id => `"${id}"`).join(',');
      try {
        const res = await fetch(`${url}/rest/v1/shadow_picks?game_id=in.(${chunk})&select=game_id,sport,home_team,away_team,commence_time`,
          { headers: { apikey: key, Authorization: `Bearer ${key}` } });
        if (!res.ok) continue;
        (await res.json()).forEach(r => { if (!out[r.game_id]) out[r.game_id] = r; });
      } catch {}
    }
    return out;
  }

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

    // Totals first: an "Over 47.5" label names no team, so the side
    // check below used to stop these before they could be graded.
    if (type === 'TOTAL') {
      const line = Number(bet.line);
      const ou = /over/i.test(label) ? 'over' : /under/i.test(label) ? 'under' : null;
      if (!isFinite(line) || !ou) return null;
      const combined0 = homeScore + awayScore;
      const odds0 = Number(bet.odds) || DEFAULT_SPREAD_PRICE;
      const win0 = odds0 > 0 ? (odds0 / 100) : (100 / Math.abs(odds0));
      const stake0 = Number(bet.amount) || 0;
      if (Math.abs(combined0 - line) < 0.01) return { result: 'P', pnl: 0 };
      const won0 = ou === 'over' ? combined0 > line : combined0 < line;
      return won0 ? { result: 'W', pnl: round(stake0 * win0, 2) } : { result: 'L', pnl: round(-stake0, 2) };
    }

    // Side. HOME / AWAY rows state it. Otherwise the label is
    // matched against the bet's own matchup string first — both
    // come from The Odds API, so the spelling agrees — then against
    // the ESPN names on the score row, normalized.
    let side = null;
    if (type === 'HOME' || type === 'AWAY') side = type.toLowerCase();
    if (!side) side = sideFromMatchup(label, bet.matchup);
    if (!side) {
      if (sameTeam(label, home)) side = 'home';
      else if (sameTeam(label, away)) side = 'away';
      else {
        const l = label.toLowerCase();
        if (home.toLowerCase().includes(l) || l.includes(home.toLowerCase())) side = 'home';
        else if (away.toLowerCase().includes(l) || l.includes(away.toLowerCase())) side = 'away';
      }
    }

    if (!side) return null;

    const margin = homeScore - awayScore;
    const combined = homeScore + awayScore;
    // Older HOME / AWAY rows stored the home moneyline as the price
    // of a spread bet; those settle at the standard spread price.
    const odds = (type === 'HOME' || type === 'AWAY')
      ? DEFAULT_SPREAD_PRICE
      : (Number(bet.odds) || DEFAULT_SPREAD_PRICE);
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