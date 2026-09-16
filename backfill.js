// ============================================================
// EDGE — BACKFILL & CALIBRATION v1.0
//
// One historical pull, three jobs that all depend on it:
//
//   1. CARRY-OVER    Rate each completed prior season in order,
//                    carrying the end state forward. Without this
//                    every season opens with the whole league at
//                    1500 and a week-1 rating rests on one game.
//
//   2. ERROR         Walk each season forward a period at a time —
//                    rate on what came before, project the next
//                    period, record how far off it was. Those
//                    residuals are the model's standard error, and
//                    without them a spread cannot be turned into a
//                    probability.
//
//   3. CONSTANTS     Home advantage, scoring rate and margin scale
//                    are defaults until measured. Every projection
//                    rests on them, so they get fitted to real
//                    results rather than assumed.
//
// The walk-forward in step 2 matters. Measuring error on games the
// ratings were built from would flatter the model badly — it would
// be scoring its own homework. Every residual here comes from a
// game the ratings had not yet seen.
// ============================================================

const EDGE_BACKFILL = (() => {

  const BUILD = 'bf-20260916';

  const SUPABASE_URL = () => localStorage.getItem('edge_supabase_url');
  const SUPABASE_KEY = () => localStorage.getItem('edge_supabase_key');

  // How many completed seasons to walk. More is better for the error
  // estimate; each one is a full historical fetch, so this is the
  // dial between accuracy and how long the run takes.
  const DEFAULT_SEASONS = 3;

  // Season boundaries, by month and day.
  const SEASON_BOUNDS = {
    NFL:   { start: [9, 1],   end: [2, 15]  },
    NCAAF: { start: [8, 15],  end: [1, 15]  },
    NBA:   { start: [10, 15], end: [6, 30]  },
    NCAAB: { start: [11, 1],  end: [4, 10]  },
    NHL:   { start: [10, 1],  end: [6, 30]  },
    MLB:   { start: [3, 20],  end: [11, 5]  },
    MLS:   { start: [2, 20],  end: [12, 15] },
  };

  // Games per evaluation step when walking a season forward.
  const STEP_DAYS = { NFL: 7, NCAAF: 7, NBA: 7, NCAAB: 7, NHL: 7, MLB: 7, MLS: 14 };

  // Enough games must precede a step for its projections to mean
  // anything. Below this the ratings are still noise.
  const MIN_PRIOR_GAMES = { NFL: 48, NCAAF: 150, NBA: 120, NCAAB: 200, NHL: 120, MLB: 300, MLS: 60 };

  return {
    BUILD,
    run,
    runSport,
    seasonWindow,
    loadCalibration,
    DEFAULT_SEASONS,
  };

  // ============================================================
  // ── MAIN ──
  // ============================================================

  async function run(options = {}) {
    const {
      sports = ['NFL', 'NCAAF', 'NBA', 'NHL', 'MLB', 'MLS'],
      seasons = DEFAULT_SEASONS,
      onProgress = null,
    } = options;
    const log = mk(onProgress);

    if (!window.EDGE_POWER || !window.EDGE_RATING) {
      return { ok: false, error: 'rating-core.js and power-engine.js must both be loaded' };
    }
    if (!SUPABASE_URL() || !SUPABASE_KEY()) {
      return { ok: false, error: 'Supabase not connected — Settings › Connections' };
    }

    const summary = { ok: true, sports: {}, started: new Date().toISOString() };

    for (const sport of sports) {
      log(`\n══ ${sport} ══`);
      try {
        summary.sports[sport] = await runSport(sport, { seasons, onProgress });
      } catch (e) {
        log(`  failed: ${e.message}`);
        summary.sports[sport] = { ok: false, error: e.message };
      }
    }

    summary.finished = new Date().toISOString();
    return summary;
  }

  async function runSport(sport, options = {}) {
    const { seasons = DEFAULT_SEASONS, onProgress = null } = options;
    const log = mk(onProgress);
    const R = window.EDGE_RATING;
    const P = window.EDGE_POWER;

    const windows = [];
    for (let back = seasons; back >= 1; back--) {
      const w = seasonWindow(sport, back);
      if (w) windows.push(w);
    }
    if (!windows.length) return { ok: false, error: 'no season windows' };

    let seed = null;
    const allGames = [];
    const residuals = [];
    const perSeason = [];

    for (const w of windows) {
      log(`  ${w.label}: fetching ${fmt(w.from)} → ${fmt(w.to)}`);
      const games = await P.fetchGamesBetween(sport, w.from, w.to);
      const closing = await loadClosingLines(sport, w.from, w.to);
      if (Object.keys(closing).length) {
        log(`  ${w.label}: ${Object.keys(closing).length} closing lines on file`);
      }
      const regular = games.filter(g => g.importance !== 'preseason');
      log(`  ${w.label}: ${regular.length} games`);

      if (regular.length < 30) {
        log(`  ${w.label}: too few to rate, skipping`);
        perSeason.push({ season: w.label, games: regular.length, skipped: true });
        continue;
      }

      allGames.push(...regular);

      // ── Walk forward, measuring error on unseen games ──
      const seasonResiduals = walkForward(sport, regular, seed, R, log, closing);
      residuals.push(...seasonResiduals);

      // ── Final state of this season seeds the next ──
      const finalState = R.rateGlicko(sport, regular, { seed });
      seed = R.carryOver(sport, finalState, {});
      log(`  ${w.label}: rated ${Object.keys(finalState).length} teams · ${seasonResiduals.length} residuals`);

      perSeason.push({
        season: w.label,
        games: regular.length,
        teams: Object.keys(finalState).length,
        residuals: seasonResiduals.length,
      });

      // Persist this season's carry-over for the season that follows.
      const written = await saveCarryover(sport, String(Number(w.label) + 1), seed, log);
      if (written) log(`  ${w.label}: carried ${written} teams into ${Number(w.label) + 1}`);
    }

    if (!allGames.length) return { ok: false, error: 'no games fetched' };

    // ── Constants, fitted to everything pulled ──
    const constants = R.fitConstants(sport, allGames);

    // ── Error, from the walk-forward residuals only ──
    const error = summariseResiduals(residuals);

    // ── Information beyond the closing line ──
    // Error against the final margin says how accurate the model is.
    // It says nothing about whether it beats the market, because the
    // market is accurate too. This is the measure that matters.
    const paired = residuals
      .filter(x => x.market != null)
      .map(x => ({ model: x.projected, market: x.market, actual: x.actual }));

    const blend = paired.length >= 100
      ? R.fitMarketBlend(paired)
      : { ok: false, reason: `only ${paired.length} games have a closing line — run Build ATS first` };

    if (blend.ok) {
      log(`  vs market: model sigma ${blend.model_sigma} · market sigma ${blend.market_sigma}`);
      log(`  lambda ${blend.lambda} — ${blend.verdict}`);
    } else {
      log(`  vs market: ${blend.reason}`);
    }

    log(`  constants: home edge ${constants.home_advantage} (default ${constants.default_home_advantage})` +
        ` · margin sd ${constants.margin_sd}`);
    log(`  projection error: sigma ${error.sigma ?? 'n/a'} on ${error.n} unseen games`);

    await saveCalibration(sport, constants, error, perSeason, log, blend);

    return { ok: true, seasons: perSeason, constants, error, blend, total_games: allGames.length };
  }

  // ============================================================
  // ── WALK-FORWARD ──
  // Rate on everything before a cutoff, project the games after it,
  // record the miss. Repeat across the season. Nothing is projected
  // from a game the ratings have already absorbed.
  // ============================================================

  function walkForward(sport, games, seed, R, log, closing = {}) {
    const step = STEP_DAYS[sport] ?? 7;
    const minPrior = MIN_PRIOR_GAMES[sport] ?? 50;
    const out = [];

    const sorted = [...games].sort((a, b) => new Date(a.date) - new Date(b.date));
    if (sorted.length < minPrior + 10) return out;

    const first = new Date(sorted[0].date);
    const last = new Date(sorted[sorted.length - 1].date);

    let cutoff = new Date(first.getTime() + minPrior * 0 + step * 86400000);
    // Advance the cutoff until enough games precede it.
    while (sorted.filter(g => new Date(g.date) < cutoff).length < minPrior && cutoff < last) {
      cutoff = new Date(cutoff.getTime() + step * 86400000);
    }

    while (cutoff < last) {
      const nextCut = new Date(cutoff.getTime() + step * 86400000);
      const prior = sorted.filter(g => new Date(g.date) < cutoff);
      const upcoming = sorted.filter(g => {
        const d = new Date(g.date);
        return d >= cutoff && d < nextCut;
      });

      if (upcoming.length && prior.length >= minPrior) {
        // Ratings as they would have stood before these games.
        const state = R.rateGlicko(sport, prior, { seed });
        const ad = R.attackDefense(sport, prior);
        const league = ad._league;

        upcoming.forEach(g => {
          const h = ad[g.home], a = ad[g.away];
          if (!h || !a || !league) return;
          const proj = R.projectScore(sport, h, a, league, { neutral: g.neutral });
          if (!proj) return;
          const actual = g.homeScore - g.awayScore;
          // Market margin from the home side: a -3 spread is +3.
          const close = closing[g.id];
          const marketMargin = (close != null && isFinite(close)) ? -close : null;

          out.push({
            projected: proj.margin,
            actual,
            residual: actual - proj.margin,
            market: marketMargin,
            market_residual: marketMargin != null ? actual - marketMargin : null,
            projected_total: proj.total,
            actual_total: g.homeScore + g.awayScore,
            home_rd: state[g.home]?.rd ?? null,
            away_rd: state[g.away]?.rd ?? null,
            date: g.date,
          });
        });
      }

      cutoff = nextCut;
    }

    return out;
  }

  // ============================================================
  // ── ERROR SUMMARY ──
  // ============================================================

  function summariseResiduals(residuals) {
    if (!residuals.length) return { n: 0, sigma: null };

    const r = residuals.map(x => x.residual);
    const m = mean(r);
    const sigma = Math.sqrt(r.reduce((s, v) => s + (v - m) ** 2, 0) / r.length);
    const mae = mean(r.map(Math.abs));

    // Bias matters separately from spread. A model that is off by the
    // same amount every time is fixable; noise is not.
    const totalResiduals = residuals
      .filter(x => x.projected_total != null)
      .map(x => x.actual_total - x.projected_total);

    // Error should fall as the ratings settle. If it does not, the
    // rating deviation is not carrying real information.
    const settled = residuals.filter(x => (x.home_rd ?? 999) < 120 && (x.away_rd ?? 999) < 120);
    const unsettled = residuals.filter(x => (x.home_rd ?? 0) >= 180 || (x.away_rd ?? 0) >= 180);

    return {
      n: residuals.length,
      sigma: round(sigma, 3),
      mae: round(mae, 3),
      bias: round(m, 3),
      total_sigma: totalResiduals.length ? round(stdev(totalResiduals), 3) : null,
      sigma_settled: settled.length > 30 ? round(stdev(settled.map(x => x.residual)), 3) : null,
      sigma_unsettled: unsettled.length > 30 ? round(stdev(unsettled.map(x => x.residual)), 3) : null,
      settled_n: settled.length,
      unsettled_n: unsettled.length,
    };
  }

  // ============================================================
  // ── SEASON WINDOWS ──
  // ============================================================

  // seasonsBack = 1 is the most recently completed season.
  function seasonWindow(sport, seasonsBack, now = new Date()) {
    const b = SEASON_BOUNDS[sport];
    if (!b) return null;

    const crossesYear = (b.start[0] > b.end[0]);
    const y = now.getFullYear();
    const m = now.getMonth() + 1;

    // Which season year is currently under way.
    let currentSeasonYear;
    if (crossesYear) currentSeasonYear = (m >= b.start[0]) ? y : y - 1;
    else currentSeasonYear = (m >= b.start[0]) ? y : y - 1;

    const seasonYear = currentSeasonYear - seasonsBack;
    const from = new Date(seasonYear, b.start[0] - 1, b.start[1]);
    const to = crossesYear
      ? new Date(seasonYear + 1, b.end[0] - 1, b.end[1])
      : new Date(seasonYear, b.end[0] - 1, b.end[1]);

    if (to > now) return null;   // not finished yet
    return { label: String(seasonYear), from, to };
  }

  // ============================================================
  // ── PERSIST ──
  // ============================================================

  async function saveCarryover(sport, season, carried, log) {
    const url = SUPABASE_URL(), key = SUPABASE_KEY();
    if (!url || !key) return 0;

    const rows = Object.entries(carried).map(([team, v]) => ({
      sport, season, team_name: team,
      rating: v.rating, rd: v.rd, vol: v.vol,
      carried_from: v.carried_from,
      adjustment: v.adjustment ?? 0,
      adjustment_reason: v.adjustment_reason ?? null,
      updated_at: new Date().toISOString(),
    }));
    if (!rows.length) return 0;

    try {
      const res = await fetch(`${url}/rest/v1/rating_carryover?on_conflict=sport,season,team_name`, {
        method: 'POST',
        headers: {
          apikey: key, Authorization: `Bearer ${key}`,
          'Content-Type': 'application/json',
          Prefer: 'resolution=merge-duplicates,return=minimal',
        },
        body: JSON.stringify(rows),
      });
      if (!res.ok) {
        log(`  carryover write failed: HTTP ${res.status} ${(await res.text().catch(() => '')).slice(0, 140)}`);
        return 0;
      }
      return rows.length;
    } catch (e) {
      log(`  carryover write failed: ${e.message}`);
      return 0;
    }
  }

  // Closing lines for a window, keyed by game id.
  async function loadClosingLines(sport, from, to) {
    const url = SUPABASE_URL(), key = SUPABASE_KEY();
    const out = {};
    if (!url || !key) return out;
    try {
      const res = await fetch(
        `${url}/rest/v1/historical_odds?sport=eq.${sport}&select=game_id,spread` +
        `&game_date=gte.${from.toISOString()}&game_date=lte.${to.toISOString()}&limit=20000`,
        { headers: { apikey: key, Authorization: `Bearer ${key}` } });
      if (res.ok) {
        (await res.json()).forEach(r => { if (r.spread != null) out[r.game_id] = r.spread; });
      }
    } catch {}
    return out;
  }

  async function saveCalibration(sport, constants, error, perSeason, log, blend = null) {
    const url = SUPABASE_URL(), key = SUPABASE_KEY();
    if (!url || !key) return false;

    const row = {
      sport,
      home_advantage: constants.home_advantage ?? null,
      avg_total: constants.avg_total ?? null,
      points_per_possession: constants.points_per_possession ?? null,
      margin_sd: constants.margin_sd ?? null,
      margin_scale: constants.margin_scale ?? null,
      projection_sigma: error.sigma ?? null,
      projection_mae: error.mae ?? null,
      projection_bias: error.bias ?? null,
      total_sigma: error.total_sigma ?? null,
      sigma_settled: error.sigma_settled ?? null,
      sigma_unsettled: error.sigma_unsettled ?? null,
      sample_games: constants.games ?? null,
      sample_residuals: error.n ?? null,
      seasons_used: perSeason.map(s => s.season).join(','),

      // Market comparison. Until these are populated a cover
      // probability is the model marking its own homework.
      market_lambda: blend?.ok ? blend.lambda : null,
      market_sigma: blend?.ok ? blend.market_sigma : null,
      blend_sigma: blend?.ok ? blend.blend_sigma : null,
      beats_market: blend?.ok ? blend.beats_market : null,
      market_sample: blend?.ok ? blend.n : null,
      market_verdict: blend?.ok ? blend.verdict : (blend?.reason || null),

      updated_at: new Date().toISOString(),
    };

    try {
      const res = await fetch(`${url}/rest/v1/model_calibration?on_conflict=sport`, {
        method: 'POST',
        headers: {
          apikey: key, Authorization: `Bearer ${key}`,
          'Content-Type': 'application/json',
          Prefer: 'resolution=merge-duplicates,return=minimal',
        },
        body: JSON.stringify([row]),
      });
      if (!res.ok) {
        log(`  calibration write failed: HTTP ${res.status} ${(await res.text().catch(() => '')).slice(0, 140)}`);
        return false;
      }
      log(`  calibration saved`);
      return true;
    } catch (e) {
      log(`  calibration write failed: ${e.message}`);
      return false;
    }
  }

  // Read back by the pipeline, so projections use measured numbers
  // rather than the defaults compiled into the rating core.
  async function loadCalibration(sport = null) {
    const url = SUPABASE_URL(), key = SUPABASE_KEY();
    if (!url || !key) return null;
    try {
      const q = sport ? `?sport=eq.${sport}&limit=1` : '?limit=20';
      const res = await fetch(`${url}/rest/v1/model_calibration${q}`, {
        headers: { apikey: key, Authorization: `Bearer ${key}` },
      });
      if (!res.ok) return null;
      const rows = await res.json();
      if (sport) return rows[0] || null;
      const out = {};
      rows.forEach(r => { out[r.sport] = r; });
      return out;
    } catch { return null; }
  }

  // ============================================================
  // ── UTILITIES ──
  // ============================================================

  function fmt(d) {
    return `${d.getFullYear()}-${String(d.getMonth() + 1).padStart(2, '0')}-${String(d.getDate()).padStart(2, '0')}`;
  }
  function mean(a) { return a.reduce((x, y) => x + y, 0) / a.length; }
  function stdev(a) {
    const m = mean(a);
    return Math.sqrt(a.reduce((s, v) => s + (v - m) ** 2, 0) / a.length);
  }
  function mk(onProgress) { return (m) => { if (typeof onProgress === 'function') onProgress(m); }; }
  function round(v, d) { const f = Math.pow(10, d); return Math.round(v * f) / f; }

})();

if (typeof window !== 'undefined') window.EDGE_BACKFILL = EDGE_BACKFILL;
