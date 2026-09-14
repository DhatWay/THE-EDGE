// ============================================================
// EDGE — LEARNING LOOP v1.0
// Weekly self-correction. Reads shadow_picks outcomes,
// updates algorithm_weights so the governor trusts what works.
// Deterministic. No Claude. Pure math.
// ============================================================

const EDGE_LEARNING = (() => {

  const SUPABASE_URL = () => localStorage.getItem('edge_supabase_url');
  const SUPABASE_KEY = () => localStorage.getItem('edge_supabase_key');

  // ── TUNING ──
  const MIN_SAMPLE_SIZE = 20;        // need at least this many graded picks per family/sport before adjusting
  const WEIGHT_MIN = 1.0;
  const WEIGHT_MAX = 10.0;
  const WEIGHT_STEP = 0.15;          // per adjustment cycle
  const ROLLING_WINDOW_DAYS = 60;    // only look at last 60 days of picks
  const MIN_ROI_TO_REWARD = 0.02;    // +2% ROI threshold to bump a weight
  const MAX_ROI_TO_PUNISH = -0.02;   // -2% ROI threshold to drop a weight

  // ── CALIBRATION BUCKETS ──
  const CALIBRATION_BUCKETS = [50, 55, 60, 65, 70, 75, 80, 85, 90, 95];

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

      // ── 1. Per-family performance ──
      log('Computing per-family performance');
      const familyStats = computeFamilyStats(picks);

      // ── 2. Per-sport-family performance ──
      log('Computing per-sport-family performance');
      const sportFamilyStats = computeSportFamilyStats(picks);

      // ── 3. Load current weights ──
      log('Loading current weights');
      const currentWeights = await loadWeights();

      // ── 4. Compute new weights ──
      log('Computing new weights');
      const updates = computeWeightUpdates(sportFamilyStats, currentWeights);

      // ── 5. Calibration table ──
      log('Building calibration table');
      const calibration = buildCalibration(picks);

      // ── 6. Persist ──
      if (!dryRun) {
        log('Persisting weight updates');
        await persistWeights(updates);
        await persistCalibration(calibration);
        await persistShadowCalibration(calibration);
      }

      summary.families_updated = updates.filter(u => u.changed).length;
      summary.families_skipped = updates.filter(u => !u.changed).length;
      summary.calibration_updated = !dryRun;
      summary.updates = updates;
      summary.calibration = calibration;

      // Cache calibration for the governor to read immediately
      localStorage.setItem('edge_governor_calibration', JSON.stringify(calibration));

      summary.duration_ms = Date.now() - startedAt;
      summary.completed_at = new Date().toISOString();
      log(`Done · ${summary.families_updated} families updated · ${summary.duration_ms}ms`);

      return summary;

    } catch (err) {
      summary.errors.push(err.message);
      summary.duration_ms = Date.now() - startedAt;
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
    } catch { return []; }
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
        const won = p.result === 'W';
        const lost = p.result === 'L';
        const push = p.result === 'P';

        if (push) fam.pushes++;
        else if ((familySideMatched && won) || (!familySideMatched && lost)) fam.wins++;
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
    const key = p => `${p.sport}|${p.governor_snapshot?.breakdown ? '' : ''}`;
    const out = {}; // key: `${sport}|${family}`

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
    // Did the family vote agree with the physics pick direction?
    // physics direction is stored as 'home' | 'away'; family vote is 'yes' | 'no' | 'neu'
    // Yes = agreed with home team; No = agreed with away team
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

      // Not enough sample → leave weight alone
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
  // Maps governor's raw confidence → historically observed hit rate.
  // The governor reads this table to shrink overconfidence.
  // ============================================================

  function buildCalibration(picks) {
    const buckets = {};

    CALIBRATION_BUCKETS.forEach(b => { buckets[String(b)] = { picks: 0, wins: 0 }; });

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
      if (data.picks >= 10) {
        // Enough sample: use empirical hit rate
        calibration[bucket] = round((data.wins / data.picks) * 100, 1);
      } else {
        // Fallback: use the bucket value as a conservative prior
        calibration[bucket] = parseInt(bucket) - 3; // 3-point haircut on low sample
      }
    });

    return calibration;
  }

  // ============================================================
  // ── PERSIST ──
  // ============================================================

  async function persistWeights(updates) {
    const url = SUPABASE_URL();
    const key = SUPABASE_KEY();
    if (!url || !key) return;

    const changed = updates.filter(u => u.changed);
    if (!changed.length) return;

    for (const u of changed) {
      try {
        await fetch(
          `${url}/rest/v1/algorithm_weights?family=eq.${encodeURIComponent(u.family)}&sport=eq.${encodeURIComponent(u.sport)}`,
          {
            method: 'PATCH',
            headers: {
              apikey: key,
              Authorization: `Bearer ${key}`,
              'Content-Type': 'application/json',
            },
            body: JSON.stringify({
              dynamic_weight: u.new_weight,
              wins: u.stats.wins,
              losses: u.stats.losses,
              pushes: u.stats.pushes,
              roi: u.stats.roi,
              last_updated: new Date().toISOString(),
            }),
          }
        );
      } catch {}
    }
  }

  async function persistCalibration(calibration) {
    const url = SUPABASE_URL();
    const key = SUPABASE_KEY();
    if (!url || !key) return;

    try {
      await fetch(`${url}/rest/v1/settings?id=eq.1`, {
        method: 'PATCH',
        headers: {
          apikey: key,
          Authorization: `Bearer ${key}`,
          'Content-Type': 'application/json',
        },
        body: JSON.stringify({
          governor_calibration: JSON.stringify(calibration),
          updated_at: new Date().toISOString(),
        }),
      });
    } catch {}
  }

  async function persistShadowCalibration(calibration) {
    // Also cache dynamic weights locally so the governor picks them up next run
    try {
      const url = SUPABASE_URL();
      const key = SUPABASE_KEY();
      if (!url || !key) return;
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
    } catch {}
  }

  // ============================================================
  // ── UTILITIES ──
  // ============================================================

  function makeLogger(onProgress) {
    return (msg) => { if (typeof onProgress === 'function') onProgress(msg); };
  }

  function clamp(v, min, max) { return Math.max(min, Math.min(max, v)); }
  function round(v, d) { const f = Math.pow(10, d); return Math.round(v * f) / f; }

  // ============================================================
  // ── AUTO SCHEDULE ──
  // Runs weekly. Checks last run timestamp; if >6 days, runs now.
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
  // ── PUBLIC API ──

  // ============================================================
  // ── CLOSING LINE VALUE ──
  // The number you bet versus the number the market closed at. It is
  // the earliest honest read on whether the model is finding real
  // value, and it is knowable long before enough results accumulate
  // to judge win rate. Nothing was filling the clv column.
  // ============================================================

  async function captureCLV(options = {}) {
    const { lookbackDays = 14, onProgress = null } = options;
    const log = (m) => { if (typeof onProgress === 'function') onProgress(m); };

    const url = SUPABASE_URL();
    const key = SUPABASE_KEY();
    if (!url || !key) return { ok: false, error: 'Supabase not connected' };

    const since = new Date(Date.now() - lookbackDays * 86400000).toISOString();
    const headers = { apikey: key, Authorization: `Bearer ${key}` };

    // Picks that have a bet number but no closing number yet.
    let picks = [];
    try {
      const res = await fetch(
        `${url}/rest/v1/shadow_picks?select=id,game_id,sport,direction,market_spread,clv,created_at` +
        `&clv=is.null&created_at=gte.${since}&limit=2000`,
        { headers });
      if (!res.ok) return { ok: false, error: `shadow_picks HTTP ${res.status}` };
      picks = await res.json();
    } catch (e) { return { ok: false, error: e.message }; }

    if (!picks.length) return { ok: true, updated: 0, note: 'No picks awaiting CLV' };
    log(`${picks.length} picks awaiting a closing line`);

    // Closing numbers, from the same cache the ATS tracker fills.
    const ids = picks.map(p => p.game_id).filter(Boolean);
    const closing = {};
    try {
      const inList = ids.map(i => `"${i}"`).join(',');
      const res = await fetch(
        `${url}/rest/v1/historical_odds?select=game_id,spread&game_id=in.(${inList})&limit=5000`,
        { headers });
      if (res.ok) (await res.json()).forEach(r => { if (r.spread != null) closing[r.game_id] = r.spread; });
    } catch {}

    // Fall back to the last line_history row for anything still missing.
    const missing = ids.filter(i => closing[i] == null);
    if (missing.length) {
      try {
        const inList = missing.map(i => `"${i}"`).join(',');
        const res = await fetch(
          `${url}/rest/v1/line_history?select=game_id,spread,created_at&game_id=in.(${inList})` +
          `&order=created_at.asc&limit=20000`,
          { headers });
        if (res.ok) (await res.json()).forEach(r => {
          if (r.spread != null) closing[r.game_id] = r.spread;   // last write wins
        });
      } catch {}
    }

    let updated = 0;
    for (const p of picks) {
      const close = closing[p.game_id];
      if (close == null || p.market_spread == null) continue;

      // CLV is positive when the number moved toward the side you took.
      // Backing the home team at -3 and watching it close -4.5 is +1.5.
      const bet = p.direction === 'home' ? p.market_spread : -p.market_spread;
      const closed = p.direction === 'home' ? close : -close;
      const clv = round(bet - closed, 2);

      try {
        const res = await fetch(`${url}/rest/v1/shadow_picks?id=eq.${p.id}`, {
          method: 'PATCH',
          headers: { ...headers, 'Content-Type': 'application/json', Prefer: 'return=minimal' },
          body: JSON.stringify({ clv, closing_spread: close }),
        });
        if (res.ok) updated++;
      } catch {}
    }

    log(`CLV written for ${updated} picks`);

    const withClv = picks.filter(p => closing[p.game_id] != null);
    const beat = withClv.filter(p => {
      const bet = p.direction === 'home' ? p.market_spread : -p.market_spread;
      const closed = p.direction === 'home' ? closing[p.game_id] : -closing[p.game_id];
      return bet - closed > 0;
    }).length;

    return {
      ok: true,
      updated,
      beat_close: beat,
      beat_rate: withClv.length ? round(beat / withClv.length, 4) : null,
    };
  }

  return {
    run,
    captureCLV,
    runIfDue,
    computeFamilyStats,
    computeSportFamilyStats,
    buildCalibration,
    MIN_SAMPLE_SIZE,
    ROLLING_WINDOW_DAYS,
  };

})();

if (typeof window !== 'undefined') window.EDGE_LEARNING = EDGE_LEARNING;