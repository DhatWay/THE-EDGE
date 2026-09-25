// ============================================================
// EDGE — LEARNING LOOP v3.0
// Weekly self-correction. Reads shadow_picks outcomes,
// updates algorithm_weights so the governor trusts what works.
// Deterministic. No Claude. Pure math.
//
// v3.0 changes:
//
//   · persistWeights uses an upsert. The old code PATCHed
//     algorithm_weights filtered on family and sport. If the
//     row did not exist — which is the case on every fresh
//     install, and for any sport that has never been learned
//     before — the PATCH matched nothing and returned 204,
//     which looks like success but writes nothing. Every
//     weight change was silently discarded. Now the code POSTs
//     with on_conflict=sport,family and merge-duplicates, so
//     first write inserts, subsequent writes update.
//
//   · captureCLV resolves the Odds API game_id to an ESPN id
//     via game-id-map.js before reading the closing spread.
//     The two id systems were unrelated, so the closing-line
//     query returned nothing and every pick fell through to
//     the line_history fallback — which stores the line at
//     whenever the user last opened Matchups or Lines, not the
//     actual close.
//
//   · captureCLV only grades picks whose game has started.
//     Before kickoff there is no closing line yet, so an
//     unstarted pick has nothing to grade against. The old
//     code wrote whatever line_history held at the moment the
//     page happened to run, which is why CLV numbers were
//     meaningless and never updated.
//
//   · CLV is a one-shot write. Once a pick has a clv value it
//     is not touched again, so the close is captured exactly
//     once and does not drift.
//
// v2.0 changes (retained):
//   · buildCalibration writes the structured { rate, samples }
//     shape the governor reads.
//   · Buckets below MIN_BUCKET_SAMPLES are omitted rather than
//     fabricated.
//   · persistCalibration writes with merge-duplicates.
// ============================================================

const EDGE_LEARNING = (() => {

  const BUILD = 'learn-20260925-01';

  const SUPABASE_URL = () => localStorage.getItem('edge_supabase_url');
  const SUPABASE_KEY = () => localStorage.getItem('edge_supabase_key');

  // ── TUNING ──
  const MIN_SAMPLE_SIZE = 20;
  const WEIGHT_MIN = 1.0;
  const WEIGHT_MAX = 10.0;
  const WEIGHT_STEP = 0.15;
  const ROLLING_WINDOW_DAYS = 60;
  const MIN_ROI_TO_REWARD = 0.02;
  const MAX_ROI_TO_PUNISH = -0.02;

  const CALIBRATION_BUCKETS = [50, 55, 60, 65, 70, 75, 80, 85, 90, 95];
  const MIN_BUCKET_SAMPLES = 10;

  return {
    BUILD,
    run,
    captureCLV,
    runIfDue,
    computeFamilyStats,
    computeSportFamilyStats,
    buildCalibration,
    MIN_SAMPLE_SIZE,
    MIN_BUCKET_SAMPLES,
    ROLLING_WINDOW_DAYS,
  };

  // ============================================================
  // ── MAIN ENTRY ──
  // ============================================================

  async function run(options = {}) {
    const {
      dryRun = false,
      onProgress = null,
      days = ROLLING_WINDOW_DAYS,
    } = options;

    const log = makeLogger(onProgress);
    const startedAt = Date.now();
    const summary = {
      started_at: new Date(startedAt).toISOString(),
      days,
      dry_run: dryRun,
      families_updated: 0,
      families_skipped: 0,
      calibration_updated: false,
      calibration_buckets: 0,
      picks_analyzed: 0,
      errors: [],
    };

    try {
      log('Loading graded shadow picks');
      const picks = await loadGradedPicks(days);
      summary.picks_analyzed = picks.length;

      if (!picks.length) {
        summary.errors.push('No graded picks in window');
        summary.duration_ms = Date.now() - startedAt;
        return summary;
      }

      log(`Analyzing ${picks.length} picks`);

      log('Computing per-family performance');
      const familyStats = computeFamilyStats(picks);

      log('Computing per-sport-family performance');
      const sportFamilyStats = computeSportFamilyStats(picks);

      log('Loading current weights');
      const currentWeights = await loadWeights();

      log('Computing new weights');
      const updates = computeWeightUpdates(sportFamilyStats, currentWeights);

      log('Building calibration table');
      const calibration = buildCalibration(picks);
      summary.calibration_buckets = Object.keys(calibration).length;

      if (!dryRun) {
        log('Persisting weight updates');
        const w = await persistWeights(updates);
        if (w.inserted || w.updated) {
          log(`  ${w.inserted} inserted · ${w.updated} updated · ${w.failed} failed`);
        }

        try {
          localStorage.setItem('edge_governor_calibration', JSON.stringify(calibration));
        } catch (e) { logEdgeError('learning.calibrationLocal', e); }

        const remote = await persistCalibration(calibration);
        if (!remote.ok) {
          log(`Calibration sync failed: ${remote.reason}`);
        } else {
          log(`Calibration synced (${remote.buckets} buckets)`);
        }

        await persistShadowCalibration(calibration);
      }

      summary.families_updated = updates.filter(u => u.changed).length;
      summary.families_skipped = updates.filter(u => !u.changed).length;
      summary.calibration_updated = !dryRun;
      summary.updates = updates;
      summary.calibration = calibration;

      if (typeof window.EDGE_GOVERNOR !== 'undefined'
          && typeof window.EDGE_GOVERNOR.reloadCalibration === 'function') {
        try { window.EDGE_GOVERNOR.reloadCalibration(); }
        catch (e) { logEdgeError('learning.governorReload', e); }
      }

      summary.duration_ms = Date.now() - startedAt;
      summary.completed_at = new Date().toISOString();
      log(`Done · ${summary.families_updated} families updated · ${summary.duration_ms}ms`);

      return summary;

    } catch (err) {
      summary.errors.push(err.message);
      summary.duration_ms = Date.now() - startedAt;
      logEdgeError('learning.run', err);
      return summary;
    }
  }

  // ============================================================
  // ── LOAD GRADED PICKS ──
  // ============================================================

  async function loadGradedPicks(days) {
    const url = SUPABASE_URL();
    const key = SUPABASE_KEY();
    if (!url || !key) return [];

    const since = new Date(Date.now() - days * 86400000).toISOString();

    try {
      const res = await fetch(
        `${url}/rest/v1/shadow_picks?select=*&result=in.(W,L,P)&created_at=gte.${since}&order=created_at.desc&limit=5000`,
        { headers: { apikey: key, Authorization: `Bearer ${key}` } }
      );
      return res.ok ? await res.json() : [];
    } catch (e) {
      logEdgeError('learning.loadGradedPicks', e);
      return [];
    }
  }

  // ============================================================
  // ── FAMILY STATS ──
  // ============================================================

  function computeFamilyStats(picks) {
    const byFamily = {};

    picks.forEach(p => {
      const breakdown = p.governor_snapshot?.breakdown || [];
      breakdown.forEach(b => {
        if (!byFamily[b.family]) byFamily[b.family] = { wins: 0, losses: 0, pushes: 0, units: 0, pnl: 0 };
        const familySideMatched = familyVotedWithPick(b, p);
        if (familySideMatched === null) return;

        const fam = byFamily[b.family];
        const pnl = familySideMatched ? (p.pnl || 0) : -(p.pnl || 0);

        if (p.result === 'P') fam.pushes++;
        else if ((familySideMatched && p.result === 'W') || (!familySideMatched && p.result === 'L')) fam.wins++;
        else fam.losses++;

        fam.units += p.units || 1;
        fam.pnl += pnl;
      });
    });

    Object.keys(byFamily).forEach(k => {
      const s = byFamily[k];
      const total = s.wins + s.losses;
      s.win_rate = total > 0 ? s.wins / total : 0;
      s.roi = s.units > 0 ? s.pnl / s.units : 0;
    });

    return byFamily;
  }

  function computeSportFamilyStats(picks) {
    const out = {};

    picks.forEach(p => {
      const sport = p.sport || 'UNKNOWN';
      const breakdown = p.governor_snapshot?.breakdown || [];

      breakdown.forEach(b => {
        const compositeKey = `${sport}|${b.family}`;
        if (!out[compositeKey]) {
          out[compositeKey] = { sport, family: b.family, wins: 0, losses: 0, pushes: 0, units: 0, pnl: 0 };
        }

        const familySideMatched = familyVotedWithPick(b, p);
        if (familySideMatched === null) return;

        const fam = out[compositeKey];
        const pnl = familySideMatched ? (p.pnl || 0) : -(p.pnl || 0);

        if (p.result === 'P') fam.pushes++;
        else if ((familySideMatched && p.result === 'W') || (!familySideMatched && p.result === 'L')) fam.wins++;
        else fam.losses++;

        fam.units += p.units || 1;
        fam.pnl += pnl;
      });
    });

    Object.values(out).forEach(s => {
      const total = s.wins + s.losses;
      s.win_rate = total > 0 ? s.wins / total : 0;
      s.roi = s.units > 0 ? s.pnl / s.units : 0;
    });

    return out;
  }

  function familyVotedWithPick(familyEntry, pick) {
    if (familyEntry.vote === 'neu') return null;
    if (!pick.direction) return null;
    if (familyEntry.vote === 'yes') return pick.direction === 'home';
    if (familyEntry.vote === 'no') return pick.direction === 'away';
    return null;
  }

  // ============================================================
  // ── WEIGHT UPDATES ──
  // ============================================================

  async function loadWeights() {
    const url = SUPABASE_URL();
    const key = SUPABASE_KEY();
    if (!url || !key) return {};
    try {
      const res = await fetch(`${url}/rest/v1/algorithm_weights?select=*`, {
        headers: { apikey: key, Authorization: `Bearer ${key}` },
      });
      if (!res.ok) return {};
      const rows = await res.json();
      const map = {};
      rows.forEach(r => { map[`${r.sport}|${r.family}`] = r; });
      return map;
    } catch { return {}; }
  }

  function computeWeightUpdates(sportFamilyStats, currentWeights) {
    const updates = [];

    Object.entries(sportFamilyStats).forEach(([key, stats]) => {
      const { sport, family } = stats;
      const total = stats.wins + stats.losses;

      const current = currentWeights[key];
      const currentDynamic = current?.dynamic_weight ?? current?.base_weight ?? 7.0;
      const currentBase    = current?.base_weight ?? 7.0;

      if (total < MIN_SAMPLE_SIZE) {
        updates.push({
          key, sport, family,
          old_weight: currentDynamic,
          new_weight: currentDynamic,
          changed: false,
          reason: `Insufficient sample (${total} < ${MIN_SAMPLE_SIZE})`,
          stats: sanitizeStats(stats),
        });
        return;
      }

      let newWeight = currentDynamic;
      let reason = 'No change';

      if (stats.roi >= MIN_ROI_TO_REWARD) {
        newWeight = clamp(currentDynamic + WEIGHT_STEP, WEIGHT_MIN, WEIGHT_MAX);
        reason = `Rewarding +${(stats.roi * 100).toFixed(1)}% ROI over ${total} picks`;
      } else if (stats.roi <= MAX_ROI_TO_PUNISH) {
        newWeight = clamp(currentDynamic - WEIGHT_STEP, WEIGHT_MIN, WEIGHT_MAX);
        reason = `Reducing weight after ${(stats.roi * 100).toFixed(1)}% ROI over ${total} picks`;
      } else {
        reason = `ROI within tolerance (${(stats.roi * 100).toFixed(1)}%)`;
      }

      updates.push({
        key, sport, family,
        old_weight: round(currentDynamic, 2),
        new_weight: round(newWeight, 2),
        changed: Math.abs(newWeight - currentDynamic) > 0.001,
        reason,
        base_weight: currentBase,
        stats: sanitizeStats(stats),
      });
    });

    return updates;
  }

  function sanitizeStats(s) {
    return {
      wins: s.wins,
      losses: s.losses,
      pushes: s.pushes,
      win_rate: round(s.win_rate, 3),
      roi: round(s.roi, 4),
      pnl: round(s.pnl, 2),
      units: round(s.units, 2),
    };
  }

  // ============================================================
  // ── CALIBRATION ──
  // ============================================================

  function buildCalibration(picks) {
    const buckets = {};

    CALIBRATION_BUCKETS.forEach(b => {
      buckets[String(b)] = { picks: 0, wins: 0 };
    });

    picks.forEach(p => {
      if (p.result !== 'W' && p.result !== 'L') return;
      const conf = p.confidence || 0;
      const bucket = CALIBRATION_BUCKETS.reduce((closest, b) =>
        Math.abs(b - conf) < Math.abs(closest - conf) ? b : closest
      , CALIBRATION_BUCKETS[0]);

      const key = String(bucket);
      buckets[key].picks++;
      if (p.result === 'W') buckets[key].wins++;
    });

    const calibration = {};
    Object.entries(buckets).forEach(([bucket, data]) => {
      if (data.picks < MIN_BUCKET_SAMPLES) return;
      calibration[bucket] = {
        rate: round((data.wins / data.picks) * 100, 1),
        samples: data.picks,
      };
    });

    return calibration;
  }

  // ============================================================
  // ── PERSIST: WEIGHTS ──
  //
  // Upsert, not PATCH. The old code PATCHed and silently did
  // nothing when the row did not exist — which is every row on
  // a fresh install and any row for a sport the loop has not
  // touched. POST with on_conflict=sport,family and
  // merge-duplicates inserts on first write and updates after.
  // ============================================================

  async function persistWeights(updates) {
    const url = SUPABASE_URL();
    const key = SUPABASE_KEY();
    const result = { inserted: 0, updated: 0, failed: 0 };

    if (!url || !key) return result;

    const changed = updates.filter(u => u.changed);
    if (!changed.length) return result;

    const rows = changed.map(u => ({
      sport: u.sport,
      family: u.family,
      base_weight: u.base_weight,
      dynamic_weight: u.new_weight,
      wins: u.stats.wins,
      losses: u.stats.losses,
      pushes: u.stats.pushes,
      roi: u.stats.roi,
      last_updated: new Date().toISOString(),
    }));

    try {
      const res = await fetch(`${url}/rest/v1/algorithm_weights?on_conflict=sport,family`, {
        method: 'POST',
        headers: {
          apikey: key, Authorization: `Bearer ${key}`,
          'Content-Type': 'application/json',
          Prefer: 'resolution=merge-duplicates,return=representation',
        },
        body: JSON.stringify(rows),
      });

      if (!res.ok) {
        const txt = await res.text().catch(() => '');
        logEdgeError('learning.persistWeights', new Error(`HTTP ${res.status} ${txt.slice(0, 160)}`));
        result.failed = rows.length;
        return result;
      }

      // return=representation tells us which rows landed. The
      // count of rows back is what we credit as written; we do
      // not distinguish insert from update because PostgREST
      // does not report it.
      try {
        const echoed = await res.json();
        result.updated = Array.isArray(echoed) ? echoed.length : rows.length;
      } catch {
        result.updated = rows.length;
      }
    } catch (e) {
      logEdgeError('learning.persistWeights.network', e);
      result.failed = rows.length;
    }

    return result;
  }

  // ============================================================
  // ── PERSIST: CALIBRATION ──
  // ============================================================

  async function persistCalibration(calibration) {
    const url = SUPABASE_URL();
    const key = SUPABASE_KEY();
    if (!url || !key) return { ok: false, reason: 'Supabase not connected' };

    const buckets = Object.keys(calibration).length;

    try {
      const res = await fetch(`${url}/rest/v1/settings?on_conflict=id`, {
        method: 'POST',
        headers: {
          apikey: key,
          Authorization: `Bearer ${key}`,
          'Content-Type': 'application/json',
          Prefer: 'resolution=merge-duplicates,return=minimal',
        },
        body: JSON.stringify({
          id: 1,
          governor_calibration: calibration,
          updated_at: new Date().toISOString(),
        }),
      });

      if (!res.ok) {
        const body = await res.text().catch(() => '');
        const missingColumn = /governor_calibration/.test(body);
        return {
          ok: false,
          reason: missingColumn
            ? 'settings.governor_calibration column missing — run the ALTER in the persistCalibration header'
            : `HTTP ${res.status} ${body.slice(0, 160)}`,
          buckets,
        };
      }

      return { ok: true, buckets };
    } catch (e) {
      logEdgeError('learning.persistCalibration', e);
      return { ok: false, reason: e.message, buckets };
    }
  }

  async function persistShadowCalibration() {
    const url = SUPABASE_URL();
    const key = SUPABASE_KEY();
    if (!url || !key) return;

    try {
      const res = await fetch(`${url}/rest/v1/algorithm_weights?select=sport,family,dynamic_weight`, {
        headers: { apikey: key, Authorization: `Bearer ${key}` },
      });
      if (!res.ok) return;
      const rows = await res.json();
      const bySport = {};
      rows.forEach(r => {
        if (!bySport[r.sport]) bySport[r.sport] = {};
        bySport[r.sport][r.family] = r.dynamic_weight;
      });
      localStorage.setItem('edge_dynamic_weights', JSON.stringify(bySport));
    } catch (e) {
      logEdgeError('learning.persistShadowCalibration', e);
    }
  }

  // ============================================================
  // ── AUTO SCHEDULE ──
  // ============================================================

  async function runIfDue(options = {}) {
    const lastRun = localStorage.getItem('edge_learning_last_run');
    const daysSince = lastRun ? (Date.now() - new Date(lastRun).getTime()) / 86400000 : 999;
    if (daysSince < 6) {
      return { skipped: true, days_since_last_run: round(daysSince, 2) };
    }
    const result = await run(options);
    if (!result.errors.length) {
      localStorage.setItem('edge_learning_last_run', new Date().toISOString());
    }
    return result;
  }

  // ============================================================
  // ── CLOSING LINE VALUE ──
  //
  // The number you bet versus the number the market closed at.
  // It is the earliest honest read on whether the model is
  // finding real value, and it is knowable long before enough
  // results accumulate to judge win rate.
  //
  // The close is what ats-tracker.js wrote to historical_odds
  // when it fetched the ESPN core API odds. parseOddsItem in
  // that file prioritises the close block, so
  // historical_odds.spread is the closing number.
  //
  // shadow_picks.game_id is the Odds API's event id. The ESPN
  // event id is a different string. game-id-map.js is what
  // bridges them.
  // ============================================================

  async function captureCLV(options = {}) {
    const { lookbackDays = 14, onProgress = null } = options;
    const log = (m) => { if (typeof onProgress === 'function') onProgress(m); };

    const url = SUPABASE_URL();
    const key = SUPABASE_KEY();
    if (!url || !key) return { ok: false, error: 'Supabase not connected' };

    if (typeof window.EDGE_GAME_ID_MAP === 'undefined') {
      return { ok: false, error: 'game-id-map.js not loaded — CLV cannot resolve ids' };
    }

    const headers = { apikey: key, Authorization: `Bearer ${key}` };

    let hasClosingColumn = false;
    try {
      const probe = await fetch(`${url}/rest/v1/shadow_picks?select=closing_spread&limit=1`, { headers });
      hasClosingColumn = probe.ok;
    } catch {}

    const since = new Date(Date.now() - lookbackDays * 86400000).toISOString();

    let picks = [];
    try {
      const res = await fetch(
        `${url}/rest/v1/shadow_picks?select=id,game_id,sport,direction,market_spread,clv,commence_time,created_at` +
        `&clv=is.null&created_at=gte.${since}&limit=2000`,
        { headers });
      if (!res.ok) return { ok: false, error: `shadow_picks HTTP ${res.status}` };
      picks = await res.json();
    } catch (e) { return { ok: false, error: e.message }; }

    if (!picks.length) return { ok: true, updated: 0, note: 'No picks awaiting CLV' };

    // Only grade picks whose game has started. Before kickoff
    // there is no closing line to compare against.
    const now = Date.now();
    const started = picks.filter(p => {
      if (!p.commence_time) return false;
      const t = new Date(p.commence_time).getTime();
      return isFinite(t) && t <= now;
    });

    log(`${picks.length} picks awaiting CLV · ${started.length} have started`);

    if (!started.length) {
      return { ok: true, updated: 0, note: 'No started games to grade' };
    }

    // Resolve the Odds API id on each pick to its ESPN id.
    const espnIdByOddsId = {};
    let resolved = 0;
    for (const p of started) {
      try {
        const espnId = await window.EDGE_GAME_ID_MAP.resolveFromOddsId(p.game_id);
        if (espnId) { espnIdByOddsId[p.game_id] = espnId; resolved++; }
      } catch {}
    }

    log(`  ${resolved}/${started.length} game ids resolved to ESPN`);

    if (!resolved) {
      return { ok: true, updated: 0, resolved: 0, note: 'No ids resolved — run game-id-map populate' };
    }

    // Load the closing spread from historical_odds, keyed by
    // the ESPN id.
    const espnIds = Object.values(espnIdByOddsId);
    const closing = {};
    const chunkSize = 200;
    for (let i = 0; i < espnIds.length; i += chunkSize) {
      const chunk = espnIds.slice(i, i + chunkSize);
      const inList = chunk.map(id => `"${id}"`).join(',');
      try {
        const res = await fetch(
          `${url}/rest/v1/historical_odds?select=game_id,spread&game_id=in.(${inList})&spread=not.is.null&limit=5000`,
          { headers });
        if (res.ok) (await res.json()).forEach(r => { closing[String(r.game_id)] = r.spread; });
      } catch {}
    }

    log(`  ${Object.keys(closing).length} closing lines available`);

    let updated = 0;
    let failed = 0;
    let noClose = 0;

    for (const p of started) {
      const espnId = espnIdByOddsId[p.game_id];
      if (!espnId) continue;

      const close = closing[espnId];
      if (close == null || p.market_spread == null) { noClose++; continue; }

      // CLV is positive when the number moved toward the side
      // you took. Backing the home team at -3 and watching it
      // close -4.5 is +1.5.
      const bet = p.direction === 'home' ? p.market_spread : -p.market_spread;
      const closed = p.direction === 'home' ? close : -close;
      const clv = round(bet - closed, 2);

      const body = { clv };
      if (hasClosingColumn) body.closing_spread = close;

      try {
        const res = await fetch(`${url}/rest/v1/shadow_picks?id=eq.${p.id}`, {
          method: 'PATCH',
          headers: { ...headers, 'Content-Type': 'application/json', Prefer: 'return=minimal' },
          body: JSON.stringify(body),
        });
        if (res.ok) updated++;
        else failed++;
      } catch { failed++; }
    }

    log(`  CLV written for ${updated} picks · ${noClose} awaiting a close · ${failed} failed`);

    const beaten = started.filter(p => {
      const espnId = espnIdByOddsId[p.game_id];
      const close = espnId ? closing[espnId] : null;
      if (close == null || p.market_spread == null) return false;
      const bet = p.direction === 'home' ? p.market_spread : -p.market_spread;
      const closed = p.direction === 'home' ? close : -close;
      return bet - closed > 0;
    }).length;

    const gradedCount = started.filter(p => {
      const espnId = espnIdByOddsId[p.game_id];
      return espnId && closing[espnId] != null;
    }).length;

    return {
      ok: true,
      updated,
      failed,
      no_close: noClose,
      resolved: resolved,
      closing_column: hasClosingColumn,
      beat_close: beaten,
      beat_rate: gradedCount > 0 ? round(beaten / gradedCount, 4) : null,
    };
  }

  // ============================================================
  // ── UTILITIES ──
  // ============================================================

  function makeLogger(onProgress) {
    return (msg) => { if (typeof onProgress === 'function') onProgress(msg); };
  }

  function logEdgeError(where, err) {
    try {
      const list = JSON.parse(localStorage.getItem('edge_errors') || '[]');
      list.unshift({ t: Date.now(), where, msg: err && err.message ? err.message : String(err) });
      localStorage.setItem('edge_errors', JSON.stringify(list.slice(0, 50)));
    } catch {}
  }

  function clamp(v, min, max) { return Math.max(min, Math.min(max, v)); }
  function round(v, d) { const f = Math.pow(10, d); return Math.round(v * f) / f; }

})();

if (typeof window !== 'undefined') window.EDGE_LEARNING = EDGE_LEARNING;