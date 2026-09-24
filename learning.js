// ============================================================
// EDGE — LEARNING LOOP v2.0
// Weekly self-correction. Reads shadow_picks outcomes,
// updates algorithm_weights so the governor trusts what works.
// Deterministic. No Claude. Pure math.
//
// v2.0 changes:
//
//   · buildCalibration writes the structured shape the governor
//     reads. The old code wrote { "65": 58.2 }, a rate with no
//     sample size. Governor v3.1 treats that as a legacy entry
//     and applies a fixed 0.25 pull. Writing { "65": { rate,
//     samples } } lets the pull scale with how many picks the
//     bucket is actually backed by, so a 500-sample bucket moves
//     confidence a lot and a 12-sample bucket barely moves it.
//
//   · Buckets below MIN_BUCKET_SAMPLES are not written at all.
//     The old code substituted parseInt(bucket) - 3 for a rate
//     when a bucket had fewer than 10 picks — i.e. it fabricated
//     a calibration number from the bucket label. A bucket with
//     insufficient data now produces no entry, and the governor
//     reads "no entry" as "leave the model's confidence alone."
//
//   · persistCalibration writes with merge-duplicates. The old
//     code PATCHed settings?id=eq.1. If row 1 did not exist —
//     which is the case on a fresh project — the PATCH matched
//     zero rows and returned 204, which looks like success but
//     writes nothing. The new code POSTs with
//     resolution=merge-duplicates, so first save inserts,
//     subsequent saves update, and the response actually
//     reflects whether the row landed. If the settings table
//     lacks the governor_calibration column, the write is
//     attempted, fails cleanly, and localStorage still carries
//     the calibration. See the header note in persistCalibration
//     for the SQL to add the column.
//
//   · Removed a dead line in computeSportFamilyStats. It defined
//     a local `key` arrow function that was never called.
//
//   · captureCLV guards on the closing_spread column. It used to
//     PATCH a column that does not exist on every shadow_picks
//     row, and the failures were swallowed. Now each row's write
//     is checked, and the return reports which rows landed. If
//     the column is missing the whole call reports it once
//     rather than 2,000 times.
// ============================================================

const EDGE_LEARNING = (() => {

  const BUILD = 'learn-20260924-01';

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

  // A bucket needs this many graded picks before its observed
  // hit rate is worth reporting. Below this, no entry is written
  // and the governor leaves the model's confidence unchanged for
  // picks that land in that bucket.
  const MIN_BUCKET_SAMPLES = 10;

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
      summary.calibration_buckets = Object.keys(calibration).length;

      // ── 6. Persist ──
      if (!dryRun) {
        log('Persisting weight updates');
        await persistWeights(updates);

        // Write calibration to localStorage first. The governor
        // reads it from there, so this is what actually takes
        // effect on the next pipeline run. The Supabase write is
        // a sync/cross-device copy; it failing does not stop the
        // local calibration from working.
        try {
          localStorage.setItem('edge_governor_calibration', JSON.stringify(calibration));
        } catch (e) { logEdgeError('learning.calibrationLocal', e); }

        const remote = await persistCalibration(calibration);
        if (!remote.ok) {
          log(`Calibration sync failed: ${remote.reason}`);
        } else {
          log(`Calibration synced (${calibration.length || Object.keys(calibration).length} buckets)`);
        }

        await persistShadowCalibration(calibration);
      }

      summary.families_updated = updates.filter(u => u.changed).length;
      summary.families_skipped = updates.filter(u => !u.changed).length;
      summary.calibration_updated = !dryRun;
      summary.updates = updates;
      summary.calibration = calibration;

      // Cache calibration for the governor to read immediately
      // and force a reload so the current session picks it up.
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
  //
  // Maps the governor's raw confidence to the hit rate actually
  // observed for picks in that confidence bucket. Governor v3.1
  // reads this as { "65": { rate: 58.2, samples: 340 } } and
  // applies a sample-weighted pull — a bucket backed by 300 picks
  // moves the model's confidence a lot, one backed by 15 barely
  // moves it.
  //
  // A bucket with fewer than MIN_BUCKET_SAMPLES picks is not
  // written. The old code fabricated a rate from the bucket label
  // in that case. Fabricated calibration is worse than none.
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
      } catch (e) {
        logEdgeError('learning.persistWeights.' + u.sport + '.' + u.family, e);
      }
    }
  }

  // ============================================================
  // ── PERSIST: CALIBRATION ──
  //
  // Writes to localStorage first, which is what the governor
  // reads. Then attempts a Supabase copy for cross-device sync.
  //
  // The sync requires the settings table to have a jsonb column
  // called governor_calibration. If it does not, the write fails
  // cleanly and this returns ok:false with a reason. The local
  // calibration still works.
  //
  // To add the column:
  //   alter table public.settings
  //     add column if not exists governor_calibration jsonb;
  //
  // The old code PATCHed settings?id=eq.1, which matched zero rows
  // when the settings row had never been created — meaning a
  // fresh project's first calibration write silently did nothing
  // while returning HTTP 204, which looks like success.
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

  // Caches dynamic weights into localStorage so the governor
  // reads them without a network round-trip on the next run.
  // Named persistShadowCalibration historically; the name stuck
  // because the function has always done the same thing.
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
  // ── CLOSING LINE VALUE ──
  //
  // The number you bet versus the number the market closed at.
  // It is the earliest honest read on whether the model is
  // finding real value, and it is knowable long before enough
  // results accumulate to judge win rate.
  //
  // v2.0 guards the closing_spread column. The old code wrote it
  // on every pick; if the column did not exist, PostgREST
  // returned 400 on each write and the failures were swallowed.
  // Now the column is probed once and the whole call reports it
  // if missing, rather than 2,000 times.
  // ============================================================

  async function captureCLV(options = {}) {
    const { lookbackDays = 14, onProgress = null } = options;
    const log = (m) => { if (typeof onProgress === 'function') onProgress(m); };

    const url = SUPABASE_URL();
    const key = SUPABASE_KEY();
    if (!url || !key) return { ok: false, error: 'Supabase not connected' };

    const headers = { apikey: key, Authorization: `Bearer ${key}` };

    // Probe the shadow_picks closing_spread column once.
    let hasClosingColumn = false;
    try {
      const probe = await fetch(`${url}/rest/v1/shadow_picks?select=closing_spread&limit=1`, { headers });
      hasClosingColumn = probe.ok;
    } catch {}

    const since = new Date(Date.now() - lookbackDays * 86400000).toISOString();

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
    let failed = 0;

    for (const p of picks) {
      const close = closing[p.game_id];
      if (close == null || p.market_spread == null) continue;

      // CLV is positive when the number moved toward the side you took.
      // Backing the home team at -3 and watching it close -4.5 is +1.5.
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
      failed,
      closing_column: hasClosingColumn,
      beat_close: beat,
      beat_rate: withClv.length ? round(beat / withClv.length, 4) : null,
    };
  }

  // ============================================================
  // ── PUBLIC API ──
  // ============================================================

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

})();

if (typeof window !== 'undefined') window.EDGE_LEARNING = EDGE_LEARNING;