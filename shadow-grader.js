// ============================================================
// EDGE — SHADOW GRADER v1.1
//
// Nothing writes shadow_picks.result. History, Performance,
// the learning loop and parlay trends all read it. This file
// is what closes that loop.
//
// Workflow:
//   1. Read shadow_picks rows with result IS NULL.
//   2. Resolve the Odds API game_id to an ESPN game_id via
//      game-id-map.js.
//   3. Load the final score from historical_odds.
//   4. Grade direction (home/away) against market_spread.
//   5. Write result, pnl and actual_margin back.
//
// Idempotent. A row that already has a result is skipped, so
// running this twice a day does not double-count.
//
// v1.1 changes:
//
//   · actual_margin is written only when the column exists on
//     shadow_picks. The v1.0 code always included it in the
//     PATCH body. On a database where that column is missing,
//     PostgREST rejects the whole PATCH with 400 and no grade
//     is written. The file now probes once at the start of a
//     run and includes the field only when the column is
//     present.
//
//   · Every unresolved id is counted, not swallowed. The old
//     code counted unresolved silently; the operator saw
//     "N graded" with no indication of how many picks could
//     not find a score. The summary now reports graded,
//     unresolved, and pending separately.
// ============================================================

const EDGE_SHADOW_GRADER = (() => {

  const BUILD = 'shadowgrade-20260929-01';

  const SUPABASE_URL = () => localStorage.getItem('edge_supabase_url');
  const SUPABASE_KEY = () => localStorage.getItem('edge_supabase_key');

  function logEdgeError(where, err) {
    try {
      const list = JSON.parse(localStorage.getItem('edge_errors') || '[]');
      list.unshift({ t: Date.now(), where, msg: err && err.message ? err.message : String(err) });
      localStorage.setItem('edge_errors', JSON.stringify(list.slice(0, 50)));
    } catch {}
  }

  // Older than this and the pick is stale — either the game
  // was never played, or the score was never backfilled.
  const LOOKBACK_DAYS = 30;

  // P&L is settled at standard juice. shadow_picks does not
  // store the price each pick was taken at — when it does, this
  // becomes a per-row read.
  const DEFAULT_JUICE = -110;

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
      shadow_picks: false,
      game_id_map: false,
      actual_margin: false,
    };
    if (!status.connected) return status;

    const headers = { apikey: key, Authorization: `Bearer ${key}` };

    try {
      const r = await fetch(`${url}/rest/v1/shadow_picks?select=id&limit=1`, { headers });
      status.shadow_picks = r.ok;
    } catch {}

    try {
      const r = await fetch(`${url}/rest/v1/game_id_map?select=id&limit=1`, { headers });
      status.game_id_map = r.ok;
    } catch {}

    // Probe for the actual_margin column specifically. It is
    // optional — the grader skips writing it when absent.
    try {
      const r = await fetch(`${url}/rest/v1/shadow_picks?select=actual_margin&limit=1`, { headers });
      status.actual_margin = r.ok;
    } catch {}

    return status;
  }

  // ============================================================
  // ── MAIN ──
  // ============================================================

  async function run(options = {}) {
    const {
      onProgress = null,
      dryRun = false,
      maxRows = 5000,
    } = options;
    const log = (m) => { if (typeof onProgress === 'function') onProgress(m); };

    const url = SUPABASE_URL(), key = SUPABASE_KEY();
    if (!url || !key) return { ok: false, error: 'Supabase not connected' };

    // Props first — they need only box scores, not the id map.
    const props = await gradeProps(url, key, log, dryRun);

    const schema = await probe();
    if (!schema.shadow_picks) {
      return { ok: false, error: 'shadow_picks table not readable', props };
    }

    if (!schema.game_id_map) {
      log('game-id-map.js table is missing — no ids can be resolved');
      log('Run EDGE_GAME_ID_MAP.schemaSql() output in the Supabase editor');
      return { ok: false, error: 'game_id_map missing', props };
    }

    if (typeof window.EDGE_GAME_ID_MAP === 'undefined') {
      log('game-id-map.js module not loaded');
      return { ok: false, error: 'EDGE_GAME_ID_MAP not loaded', props };
    }

    if (!schema.actual_margin) {
      log('note: shadow_picks has no actual_margin column — scores are graded but not stored');
    }

    // ── 1. Load ungraded picks ──
    const since = new Date(Date.now() - LOOKBACK_DAYS * 86400000).toISOString();
    const pending = await loadPending(since, maxRows, url, key);
    log(`${pending.length} ungraded picks from the last ${LOOKBACK_DAYS} days`);

    if (!pending.length) {
      return { ok: true, graded: 0, unresolved: 0, pending_no_score: 0, pending: 0, props };
    }

    // ── 2. Resolve Odds API ids to ESPN ids ──
    const uniqueGameIds = Array.from(new Set(pending.map(p => p.game_id).filter(Boolean)));
    log(`  ${uniqueGameIds.length} unique game${uniqueGameIds.length === 1 ? '' : 's'}`);

    const idMap = {};
    let resolved = 0, unresolvedIds = 0;
    for (const gid of uniqueGameIds) {
      try {
        const espnId = await EDGE_GAME_ID_MAP.resolveFromOddsId(gid);
        if (espnId) { idMap[gid] = espnId; resolved++; }
        else unresolvedIds++;
      } catch (e) {
        logEdgeError('shadowGrader.resolveId', e);
        unresolvedIds++;
      }
    }
    log(`  ${resolved} resolved · ${unresolvedIds} unresolved in game_id_map`);

    // ── 3. Load final scores ──
    const espnIds = Object.values(idMap);
    const scores = await loadScores(espnIds, url, key);
    log(`  ${Object.keys(scores).length} games have a final score`);

    // ── 4. Grade each pick ──
    const updates = [];
    let graded = 0, unresolved = 0, pendingNoScore = 0;

    for (const pick of pending) {
      const espnId = idMap[pick.game_id];
      if (!espnId) { unresolved++; continue; }

      const score = scores[espnId];
      if (!score) { pendingNoScore++; continue; }

      const outcome = gradeOne(pick, score);
      if (!outcome) { unresolved++; continue; }

      const row = {
        id: pick.id,
        result: outcome.result,
        pnl: outcome.pnl,
      };
      if (schema.actual_margin) row.actual_margin = outcome.actual_margin;

      updates.push(row);
      graded++;
    }

    log(`  ${graded} graded · ${unresolved} unresolved · ${pendingNoScore} awaiting score`);

    // ── 5. Persist ──
    if (dryRun) {
      log('Dry run — no rows written');
      return { ok: true, graded, unresolved, pending_no_score: pendingNoScore, pending: pending.length, dryRun: true };
    }

    if (updates.length) {
      const written = await writeGrades(updates, url, key, log);
      log(`  ${written} rows patched in shadow_picks`);
    }

    return {
      ok: true,
      graded,
      unresolved,
      pending_no_score: pendingNoScore,
      pending: pending.length,
      written: updates.length,
      props,
    };
  }

  // ============================================================
  // ── PROPS ──
  // A prop is graded from the player's box score for that game: the
  // stat's columns (stored with the prop) summed, compared with the
  // line on the side the model picked — or the side entered, when it
  // passed. Units and P&L count only for props that were bets.
  // A prop whose box score is not in yet stays open; run Fetch Box
  // Scores for the sport first.
  // ============================================================

  async function gradeProps(url, key, log, dryRun) {
    const headers = { apikey: key, Authorization: `Bearer ${key}` };
    const cutoff = new Date(Date.now() - 6 * 3600000).toISOString();
    let open = [];
    try {
      const res = await fetch(
        `${url}/rest/v1/prop_picks?result=is.null&commence_time=lt.${encodeURIComponent(cutoff)}` +
        `&select=id,sport,player_id,commence_time,stat,line,side,price,pick_side,decision,units,detail` +
        `&order=commence_time.asc&limit=500`, { headers });
      if (!res.ok) return { ok: false, error: `prop_picks not readable (HTTP ${res.status})` };
      open = await res.json();
    } catch (e) {
      return { ok: false, error: e.message };
    }
    if (!open.length) { log('Props: none waiting to be graded'); return { ok: true, graded: 0, waiting: 0 }; }

    let graded = 0, waiting = 0;
    for (const p of open) {
      const cols = Array.isArray(p.detail?.cols) && p.detail.cols.length ? p.detail.cols : [p.stat];
      const t = new Date(p.commence_time).getTime();
      const from = new Date(t - 36 * 3600000).toISOString();
      const to = new Date(t + 36 * 3600000).toISOString();
      let rows = [];
      try {
        const res = await fetch(
          `${url}/rest/v1/player_game_stats?sport=eq.${p.sport}&player_id=eq.${encodeURIComponent(p.player_id)}` +
          `&game_date=gte.${encodeURIComponent(from)}&game_date=lte.${encodeURIComponent(to)}` +
          `&select=game_id,game_date,${cols.join(',')}&limit=5`, { headers });
        if (res.ok) rows = await res.json();
      } catch {}
      const row = rows
        .filter(r => cols.some(c => r[c] != null))
        .sort((a, b) => Math.abs(new Date(a.game_date) - t) - Math.abs(new Date(b.game_date) - t))[0];
      if (!row) { waiting++; continue; }

      const actual = cols.reduce((s, c) => s + (Number(row[c]) || 0), 0);
      const side = p.pick_side || p.side;
      const line = Number(p.line);
      const result = actual === line ? 'P'
        : (side === 'over' ? actual > line : actual < line) ? 'W' : 'L';

      let pnl = 0;
      const units = Number(p.units) || 0;
      if (p.decision && p.decision !== 'PASS' && units > 0) {
        const price = (p.price && side === p.side) ? Number(p.price) : -110;
        const payout = price > 0 ? price / 100 : 100 / Math.abs(price);
        pnl = result === 'W' ? round(units * payout, 2) : result === 'L' ? -units : 0;
      }

      if (dryRun) { graded++; continue; }
      try {
        const res = await fetch(`${url}/rest/v1/prop_picks?id=eq.${p.id}`, {
          method: 'PATCH',
          headers: { ...headers, 'Content-Type': 'application/json', Prefer: 'return=minimal' },
          body: JSON.stringify({ actual, result, pnl, graded_at: new Date().toISOString() }),
        });
        if (res.ok) graded++;
      } catch (e) { logEdgeError('shadowGrader.gradeProps', e); }
    }
    log(`Props: ${graded} graded · ${waiting} waiting for a box score`);
    return { ok: true, graded, waiting };
  }

  // ============================================================
  // ── LOAD PENDING ──
  // ============================================================

  async function loadPending(since, maxRows, url, key) {
    const out = [];
    const pageSize = 1000;

    for (let offset = 0; offset < maxRows; offset += pageSize) {
      try {
        const res = await fetch(
          `${url}/rest/v1/shadow_picks?result=is.null` +
          `&created_at=gte.${since}` +
          `&select=id,game_id,sport,direction,market_spread,units,decision,created_at` +
          `&order=created_at.asc&limit=${pageSize}&offset=${offset}`,
          { headers: { apikey: key, Authorization: `Bearer ${key}` } }
        );
        if (!res.ok) break;
        const rows = await res.json();
        out.push(...rows);
        if (rows.length < pageSize) break;
      } catch (e) {
        logEdgeError('shadowGrader.loadPending', e);
        break;
      }
    }

    return out;
  }

  // ============================================================
  // ── LOAD SCORES ──
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
          `${url}/rest/v1/historical_odds?select=game_id,home,away,home_score,away_score,spread` +
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
          };
        });
      } catch (e) {
        logEdgeError('shadowGrader.loadScores', e);
      }
    }

    return out;
  }

  // ============================================================
  // ── GRADE ONE ──
  //
  // shadow_picks stores direction ('home' or 'away') and
  // market_spread from the home perspective, the way the
  // pipeline sees the board.
  //
  //   homeMargin  = home_score - away_score
  //   homeCover   = homeMargin + market_spread
  //   pickMargin  = direction === 'home' ? homeCover : -homeCover
  //
  //   pickMargin > 0 → W
  //   pickMargin < 0 → L
  //   pickMargin = 0 → P
  // ============================================================

  function gradeOne(pick, score) {
    const direction = String(pick.direction || '').toLowerCase();
    if (direction !== 'home' && direction !== 'away') return null;

    const spread = Number(pick.market_spread);
    if (!isFinite(spread)) return null;

    const homeMargin = score.home_score - score.away_score;
    const homeCover = homeMargin + spread;
    const pickMargin = direction === 'home' ? homeCover : -homeCover;

    const units = Number(pick.units) || 0;
    const winMultiplier = 100 / Math.abs(DEFAULT_JUICE);

    let result, pnl;
    if (Math.abs(pickMargin) < 0.01) {
      result = 'P';
      pnl = 0;
    } else if (pickMargin > 0) {
      result = 'W';
      pnl = round(units * winMultiplier, 2);
    } else {
      result = 'L';
      pnl = round(-units, 2);
    }

    return {
      result,
      pnl,
      actual_margin: homeMargin,
    };
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
        const body = { result: u.result, pnl: u.pnl };
        if (u.actual_margin !== undefined) body.actual_margin = u.actual_margin;

        const res = await fetch(`${url}/rest/v1/shadow_picks?id=eq.${u.id}`, {
          method: 'PATCH',
          headers,
          body: JSON.stringify(body),
        });
        if (res.ok) written++;
        else {
          const body = await res.text().catch(() => '');
          log(`    patch ${u.id}: HTTP ${res.status} ${body.slice(0, 120)}`);
        }
      } catch (e) {
        log(`    patch ${u.id}: ${e.message}`);
        logEdgeError('shadowGrader.writeGrade', e);
      }
    }

    return written;
  }

  // ============================================================
  // ── UTILITIES ──
  // ============================================================

  function round(v, d) { const f = Math.pow(10, d); return Math.round(v * f) / f; }

})();

if (typeof window !== 'undefined') window.EDGE_SHADOW_GRADER = EDGE_SHADOW_GRADER;