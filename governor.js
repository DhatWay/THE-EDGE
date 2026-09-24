// ============================================================
// EDGE — GOVERNOR v3.1
//
// Turns the nine family verdicts into a single confidence score
// and a decision.
//
// Design principles:
//   1. One source of truth. The nine family signals are averaged
//      with their sport-specific weights. That is the consensus.
//   2. One adjustment. Consensus is shrunk toward the market
//      probability. The market is usually right; the model is
//      right only in the spots where its families agree and the
//      market hasn't fully priced them.
//   3. Everything traceable. Each step writes its inputs and
//      outputs into the returned object. The slate test can
//      grade every number.
//   4. No double counting. Previous versions applied coherence,
//      conflict penalty, and calibration as three separate
//      discounts. All three measured overlapping things. This
//      version keeps only the market shrinkage and lets the
//      family signals themselves carry the conviction.
//
// v3.1 changes:
//   · applyCalibration is now a blend, not a replacement. The
//     v3.0 code did `return round(hit, 1)` when the bucket had
//     an empirical hit rate — it substituted the observed rate
//     for the model's confidence. That was wrong twice over:
//     once because the thresholds (bet2u: 68) were calibrated
//     against model confidence, not against observed hit rate,
//     so re-bucketing the observed rate as if it were
//     confidence produced nonsense; once because a 25-sample
//     bucket was given the same weight as a 500-sample bucket.
//     Now confidence moves toward the empirical rate by a
//     sample-weighted factor, and the sample size is stored in
//     the calibration table so the weight is honest.
//   · Calibration reload is available on demand. v3.0 loaded it
//     once at module init, so if the learning loop ran in the
//     same session and wrote a fresh table, the governor kept
//     using the stale one until the page was reloaded. Now
//     `reloadCalibration()` is exported and orchestrator calls
//     it after the learning loop completes.
//   · Calibration table shape is backward compatible. If the
//     stored table is the old `{bucket: rate}` shape, it is
//     still read — just with a default sample weight of 0.25,
//     which treats it as low confidence and blends lightly.
//     New tables written by learning.js should include
//     `{bucket: {rate, samples}}` for the full effect.
//
// Output shape stays compatible with physics.js and the pick
// cards. Fields that are no longer computed are still returned
// as neutral values so nothing downstream breaks.
// ============================================================

const EDGE_GOVERNOR = (() => {

  const BUILD = 'gov-20260924-01';

  // Weights per sport for the nine families. These are the
  // defaults. Learning loop overwrites dynamic weights in
  // localStorage; this table is the fallback when it hasn't run.
  const STATIC_WEIGHTS = {
    NFL:   { team_quality: 10, offense_defense: 8,  coaching: 8, market: 10, line_dynamics: 9, fatigue: 8,  environment: 7,  trend: 6, injury: 10 },
    NBA:   { team_quality: 9,  offense_defense: 10, coaching: 7, market: 9,  line_dynamics: 8, fatigue: 10, environment: 2,  trend: 8, injury: 10 },
    WNBA:  { team_quality: 9,  offense_defense: 10, coaching: 7, market: 9,  line_dynamics: 8, fatigue: 10, environment: 2,  trend: 8, injury: 10 },
    MLB:   { team_quality: 8,  offense_defense: 8,  coaching: 6, market: 9,  line_dynamics: 8, fatigue: 7,  environment: 10, trend: 7, injury: 8  },
    NHL:   { team_quality: 8,  offense_defense: 8,  coaching: 7, market: 9,  line_dynamics: 8, fatigue: 8,  environment: 2,  trend: 7, injury: 9  },
    NCAAF: { team_quality: 9,  offense_defense: 8,  coaching: 9, market: 9,  line_dynamics: 8, fatigue: 7,  environment: 8,  trend: 7, injury: 9  },
    NCAAB: { team_quality: 9,  offense_defense: 9,  coaching: 8, market: 8,  line_dynamics: 8, fatigue: 8,  environment: 3,  trend: 7, injury: 8  },
    MLS:   { team_quality: 8,  offense_defense: 8,  coaching: 7, market: 8,  line_dynamics: 7, fatigue: 8,  environment: 10, trend: 8, injury: 8  },
    DEFAULT: { team_quality: 8, offense_defense: 8, coaching: 7, market: 9, line_dynamics: 8, fatigue: 8, environment: 6, trend: 7, injury: 8 },
  };

  // Decision thresholds. Confidence is a number in [0, 100].
  // edge is |posterior_home_prob - 0.5| * 2 (in probability units).
  const THRESHOLDS = {
    NFL:   { bet2u: 68, bet1u: 60, lean: 50, minEdge2u: 0.030, minEdge1u: 0.020, minEdgeLean: 0.008 },
    NBA:   { bet2u: 66, bet1u: 58, lean: 48, minEdge2u: 0.028, minEdge1u: 0.018, minEdgeLean: 0.008 },
    WNBA:  { bet2u: 66, bet1u: 58, lean: 48, minEdge2u: 0.028, minEdge1u: 0.018, minEdgeLean: 0.008 },
    MLB:   { bet2u: 68, bet1u: 60, lean: 50, minEdge2u: 0.030, minEdge1u: 0.020, minEdgeLean: 0.008 },
    NHL:   { bet2u: 68, bet1u: 60, lean: 50, minEdge2u: 0.030, minEdge1u: 0.020, minEdgeLean: 0.008 },
    NCAAF: { bet2u: 66, bet1u: 58, lean: 48, minEdge2u: 0.028, minEdge1u: 0.018, minEdgeLean: 0.008 },
    NCAAB: { bet2u: 64, bet1u: 56, lean: 46, minEdge2u: 0.026, minEdge1u: 0.016, minEdgeLean: 0.008 },
    MLS:   { bet2u: 68, bet1u: 60, lean: 50, minEdge2u: 0.030, minEdge1u: 0.020, minEdgeLean: 0.008 },
    DEFAULT: { bet2u: 66, bet1u: 58, lean: 48, minEdge2u: 0.028, minEdge1u: 0.018, minEdgeLean: 0.008 },
  };

  // How much of the model's opinion gets through versus the
  // market. A shrink of 0.40 means 60% model, 40% market. Lower
  // shrink = more trust in the model. Set per sport so low-volume
  // markets (MLB, NHL) get less model influence.
  const MARKET_SHRINK = {
    NFL: 0.30, NBA: 0.30, WNBA: 0.30, MLB: 0.45, NHL: 0.45,
    NCAAF: 0.40, NCAAB: 0.40, MLS: 0.50, DEFAULT: 0.40,
  };

  const HOME_BASELINE = {
    NFL: 0.565, NBA: 0.595, WNBA: 0.560, MLB: 0.540, NHL: 0.555,
    NCAAF: 0.605, NCAAB: 0.640, MLS: 0.600, DEFAULT: 0.570,
  };

  // Confidence ceiling. Even a perfect slate of family agreement
  // shouldn't claim 90% certainty — no model is that good.
  const MAX_CONFIDENCE = 82;

  // How strongly an empirical calibration may pull the model's
  // own confidence. 0.75 means the blend can move the number up
  // to 75% of the way to the observed hit rate, weighted down by
  // the sample size in the bucket. Never a full substitution.
  const MAX_CALIBRATION_PULL = 0.75;

  // Sample size at which the calibration pull reaches full
  // strength. Below this, the pull scales linearly. A bucket
  // with 100 samples gets its pull at (100/300) = 33% strength.
  const CALIBRATION_FULL_SAMPLE = 300;

  // Fallback sample weight for the old shape of the calibration
  // table, where only the hit rate was stored. Low enough that
  // the blend stays gentle.
  const LEGACY_SAMPLE_WEIGHT = 0.25;

  let CALIBRATION = {};

  function setCalibration(table) {
    CALIBRATION = table || {};
  }

  // Load the calibration table from storage. Called at module init
  // and again by the orchestrator after the learning loop runs,
  // so a fresh table takes effect in the same session.
  function reloadCalibration() {
    try {
      const stored = localStorage.getItem('edge_governor_calibration');
      if (stored) CALIBRATION = JSON.parse(stored);
    } catch {}
    return CALIBRATION;
  }

  function getDynamicWeights(sport) {
    try {
      const stored = localStorage.getItem('edge_dynamic_weights');
      if (stored) {
        const parsed = JSON.parse(stored);
        if (parsed[sport]) return parsed[sport];
      }
    } catch {}
    return STATIC_WEIGHTS[sport] || STATIC_WEIGHTS.DEFAULT;
  }

  // ============================================================
  // ── MAIN ──
  // ============================================================

  function run(familyOutputs, prior, options = {}) {
    const sport = prior?.sport || 'DEFAULT';
    const weights = options.dynamicWeights || getDynamicWeights(sport);
    const thresholds = THRESHOLDS[sport] || THRESHOLDS.DEFAULT;
    const shrink = options.shrinkage ?? (MARKET_SHRINK[sport] ?? MARKET_SHRINK.DEFAULT);
    const homeBaseline = HOME_BASELINE[sport] ?? HOME_BASELINE.DEFAULT;

    // ── 1. Weighted family signal ──
    // Each family's `signal` field is a number in [-1, +1]. Zero
    // means the family has no opinion. Positive favors home.
    const breakdown = [];
    let weightedSignal = 0;
    let totalWeight = 0;

    (familyOutputs || []).forEach(f => {
      const w = weights[f.family] ?? 7;
      const sig = typeof f.signal === 'number' && isFinite(f.signal) ? f.signal : 0;
      const conf = clamp(f.confidence ?? 0.5, 0, 1);

      // Effective contribution: weight times signal times the
      // family's own confidence. Neutral families contribute
      // nothing to the numerator but still count in the
      // denominator so a slate of neutral families produces a
      // near-zero final signal rather than an overconfident one.
      const contribution = w * sig * conf;
      weightedSignal += contribution;
      totalWeight += w;

      breakdown.push({
        family: f.family,
        vote: f.vote,
        signal: round(sig, 3),
        confidence: round(conf, 3),
        edge: round(f.edge || 0, 4),
        weight: w,
        contribution: round(contribution, 3),
        reason: f.reason || '',
        // The situations family carries per-rule detail here.
        // Other families do not, but the slot is uniform so
        // consumers can iterate breakdown without branching.
        data: f.data || {},
      });
    });

    if (totalWeight === 0) {
      return emptyResult('No family outputs');
    }

    // Normalized signal: weighted average, bounded to [-1, +1].
    // weightSum of confidence-weighted families keeps the scale
    // sane even when some families are neutral.
    const weightSumConf = breakdown.reduce((s, b) => s + b.weight * b.confidence, 0);
    const normalizedSignal = weightSumConf > 0
      ? clamp(weightedSignal / weightSumConf, -1, 1)
      : 0;

    // ── 2. Agreement index ──
    // How much do the families actually agree? Used as a
    // diagnostic and to scale confidence. Not used as a separate
    // penalty — confidence already carries per-family certainty.
    const yesFams = breakdown.filter(b => b.vote === 'yes');
    const noFams  = breakdown.filter(b => b.vote === 'no');
    const neuFams = breakdown.filter(b => b.vote === 'neu');

    const yesWeight = yesFams.reduce((s, b) => s + b.weight, 0);
    const noWeight  = noFams.reduce((s, b) => s + b.weight, 0);
    const denom = yesWeight + noWeight;
    const agreement = denom > 0
      ? Math.abs(yesWeight - noWeight) / denom
      : 0;

    // ── 3. Model probability, then shrink toward the market ──
    // The model's own home win probability, before any market
    // influence. Then the market pulls it back by the shrink
    // factor. The result is the number the app acts on.
    const modelHomeProb = clamp(0.5 + normalizedSignal / 2, 0.02, 0.98);

    const marketInfo = resolveMarket(prior, homeBaseline, sport);
    const marketHomeProb = marketInfo.prob;

    const posteriorHomeProb = (1 - shrink) * modelHomeProb + shrink * marketHomeProb;

    // Raw edge in probability terms.
    const edge = Math.abs(posteriorHomeProb - 0.5);

    // ── 4. Confidence ──
    // Three things produce confidence: how far the posterior
    // moved from a coin flip, how strongly the families agreed
    // on a direction, and how much data they had. All three
    // are already baked into normalizedSignal and agreement,
    // so the formula is short.
    const directional = Math.abs(posteriorHomeProb - 0.5) * 200;  // 0 to 100
    const agreementFactor = 0.6 + agreement * 0.4;                // 0.6 to 1.0
    const rawConfidence = directional * agreementFactor;
    const cappedConfidence = Math.min(rawConfidence, MAX_CONFIDENCE);

    // Calibration is a pull, not a substitution. The blended value
    // moves toward the observed hit rate in the bucket by a
    // sample-weighted factor. See applyCalibration for the shape.
    const calibrated = applyCalibration(cappedConfidence);

    // ── 5. Data-availability caps ──
    // Two hard caps for missing inputs. These are the only caps
    // that aren't coming from the math itself.
    const dataCaps = [];
    let cap = 100;

    if (prior?.market?.current_spread == null) {
      cap = Math.min(cap, 55);
      dataCaps.push('no spread');
    }
    const hasLineMovement = prior?.market?.open_spread != null
      && prior?.market?.current_spread != null
      && prior.market.open_spread !== prior.market.current_spread;
    if (prior?.market?.open_spread == null) {
      cap = Math.min(cap, 78);
      dataCaps.push('no opening line');
    } else if (!hasLineMovement) {
      cap = Math.min(cap, 78);
      dataCaps.push('no line movement');
    }

    const finalConfidence = round(Math.min(calibrated.value, cap, MAX_CONFIDENCE), 1);

    // ── 6. Decision ──
    const direction = posteriorHomeProb > 0.5 ? 'home' : 'away';
    let decision = 'PASS';
    let units = 0;

    if (finalConfidence >= thresholds.bet2u && edge >= thresholds.minEdge2u) {
      decision = 'BET_2U'; units = 2;
    } else if (finalConfidence >= thresholds.bet1u && edge >= thresholds.minEdge1u) {
      decision = 'BET_1U'; units = 1;
    } else if (finalConfidence >= thresholds.lean && edge >= thresholds.minEdgeLean) {
      decision = 'LEAN'; units = 0.5;
    }

    // ── 7. Kelly input for physics ──
    const kellyInput = buildKellyInput({
      posteriorHomeProb,
      marketHomeML: prior?.market?.home_ml,
      spread: prior?.market?.current_spread,
      sport,
      direction,
      units,
    });

    return {
      // Primary outputs
      consensus_score: round(normalizedSignal, 4),
      confidence: finalConfidence,
      edge: round(edge, 4),
      direction,
      decision,
      units,

      // Probability trail — every step the slate test can grade
      model_home_prob: round(modelHomeProb, 4),
      market_home_prob: round(marketHomeProb, 4),
      posterior_home_prob: round(posteriorHomeProb, 4),

      // Diagnostics
      agreement_index: round(agreement, 3),
      shrinkage: round(shrink, 3),
      market_source: marketInfo.source,
      calibrated: calibrated.applied,
      calibration_detail: calibrated.detail,
      data_caps: dataCaps,
      data_cap: cap,

      raw_confidence: round(rawConfidence, 1),
      capped_confidence: round(cappedConfidence, 1),

      // Family vote counts and breakdown
      alignment: {
        yes_count: yesFams.length,
        no_count: noFams.length,
        neu_count: neuFams.length,
        yes_weight: round(yesWeight, 1),
        no_weight: round(noWeight, 1),
      },
      breakdown,

      // Kelly sizing details
      kelly: kellyInput,

      // Thresholds used, for audit
      thresholds_used: thresholds,
      computed_at: new Date().toISOString(),
    };
  }

  // ============================================================
  // ── MARKET RESOLUTION ──
  // Prefer moneyline-implied probability. Fall back to the
  // spread implied probability. Last resort, the sport baseline.
  // ============================================================

  function resolveMarket(prior, homeBaseline, sport) {
    if (prior?.market?.home_ml) {
      return { prob: americanToImplied(prior.market.home_ml), source: 'moneyline' };
    }
    if (typeof prior?.market?.current_spread === 'number') {
      return { prob: spreadToImplied(prior.market.current_spread, sport), source: 'spread' };
    }
    return { prob: homeBaseline, source: 'baseline' };
  }

  function spreadToImplied(homeSpread, sport) {
    // A point of spread moves the implied probability by ~3%.
    // HomeSpread is signed the way a spread is quoted: negative
    // = home is favored.
    const perPoint = {
      NFL: 0.028, NCAAF: 0.028, NBA: 0.032, NCAAB: 0.032, WNBA: 0.032,
      MLB: 0.040, NHL: 0.035, MLS: 0.040,
    }[sport] || 0.030;
    return clamp(0.5 + (-homeSpread * perPoint), 0.10, 0.90);
  }

  // ============================================================
  // ── CALIBRATION ──
  //
  // The learning loop writes a table that maps raw confidence to
  // historically observed hit rate. When it has run, the model's
  // own confidence is pulled toward that observed rate — but only
  // as far as the sample size in the bucket justifies.
  //
  // The table can be one of two shapes:
  //
  //   Old shape: { "65": 58.2, "70": 63.1, ... }
  //     The bucket's observed hit rate. No sample size. Blended
  //     with a fixed low pull weight because we don't know how
  //     many picks the number came from.
  //
  //   New shape: { "65": { rate: 58.2, samples: 340 }, ... }
  //     Rate and sample. The pull weight scales with sample size,
  //     so a bucket backed by 500 picks moves the number a lot
  //     and a bucket backed by 12 picks barely moves it.
  //
  // The v3.0 code substituted the rate for the confidence. That
  // meant a 25-sample bucket had the same authority as a
  // 500-sample bucket, and it meant the number leaving the
  // governor was no longer on the same scale as the thresholds
  // it was about to be compared against.
  // ============================================================

  function applyCalibration(confidence) {
    const keys = Object.keys(CALIBRATION);
    if (!keys.length) {
      return { value: round(confidence, 1), applied: false, detail: null };
    }

    const bucket = Math.round(confidence / 5) * 5;
    const entry = CALIBRATION[String(bucket)];
    if (entry == null) {
      return { value: round(confidence, 1), applied: false, detail: null };
    }

    // Support both table shapes.
    let rate = null;
    let samples = null;
    let shape = 'unknown';

    if (typeof entry === 'number') {
      rate = entry;
      samples = null;
      shape = 'legacy';
    } else if (entry && typeof entry === 'object') {
      if (typeof entry.rate === 'number') rate = entry.rate;
      if (typeof entry.samples === 'number') samples = entry.samples;
      shape = 'structured';
    }

    if (rate == null || !isFinite(rate)) {
      return { value: round(confidence, 1), applied: false, detail: null };
    }

    // Bucket rate is a percent (e.g. 58.2). Confidence is also a
    // percent. Both on the same scale — good.
    const sampleWeight = samples != null
      ? clamp(samples / CALIBRATION_FULL_SAMPLE, 0, 1)
      : LEGACY_SAMPLE_WEIGHT;

    const pull = MAX_CALIBRATION_PULL * sampleWeight;
    const blended = confidence + (rate - confidence) * pull;
    const final = clamp(blended, 0, MAX_CONFIDENCE);

    return {
      value: round(final, 1),
      applied: true,
      detail: {
        bucket,
        bucket_rate: round(rate, 2),
        samples,
        sample_weight: round(sampleWeight, 3),
        pull: round(pull, 3),
        input: round(confidence, 1),
        output: round(final, 1),
        shape,
      },
    };
  }

  // ============================================================
  // ── KELLY ──
  // ============================================================

  function buildKellyInput({ posteriorHomeProb, marketHomeML, spread, sport, direction, units }) {
    const ourProb = direction === 'home' ? posteriorHomeProb : 1 - posteriorHomeProb;

    let marketProb, decimal, source;

    if (marketHomeML) {
      const marketHome = americanToImplied(marketHomeML);
      marketProb = direction === 'home' ? marketHome : 1 - marketHome;
      decimal = direction === 'home' ? americanToDecimal(marketHomeML) : americanToDecimal(-marketHomeML);
      source = 'ml';
    } else if (typeof spread === 'number') {
      const homeImplied = spreadToImplied(spread, sport);
      marketProb = direction === 'home' ? homeImplied : 1 - homeImplied;
      decimal = 1.91;
      source = 'spread';
    } else {
      return { available: false, reason: 'No market data' };
    }

    const b = decimal - 1;
    const edge = ourProb - marketProb;
    const kellyRaw = b > 0 ? (b * ourProb - (1 - ourProb)) / b : 0;
    const kellyFractional = Math.max(kellyRaw * 0.25, 0);
    // kelly_units is a scaled version of fractional Kelly: 1 unit
    // is 20% of bankroll, so a fractional Kelly of 0.10 → 0.5 units.
    // Physics does not use this field; it reads kelly_raw and does
    // its own scaling against the configured unit size. Kept here
    // for consumers that want a quick "approximately N units" read.
    const kellyUnits = kellyFractional * 5;

    return {
      available: true,
      source,
      our_prob: round(ourProb, 4),
      market_prob: round(marketProb, 4),
      edge: round(edge, 4),
      decimal_odds: round(decimal, 3),
      kelly_raw: round(kellyRaw, 4),
      kelly_fractional: round(kellyFractional, 4),
      kelly_units: round(Math.min(kellyUnits, 5), 2),
      governor_units: units,
      final_units: round(Math.min(kellyUnits, units || 5), 2),
    };
  }

  function americanToImplied(ml) {
    if (!ml) return 0.5;
    return ml > 0 ? 100 / (ml + 100) : Math.abs(ml) / (Math.abs(ml) + 100);
  }

  function americanToDecimal(ml) {
    if (!ml) return 2.0;
    return ml > 0 ? (ml / 100) + 1 : (100 / Math.abs(ml)) + 1;
  }

  // ============================================================
  // ── EMPTY / ERROR RESULT ──
  // ============================================================

  function emptyResult(reason) {
    return {
      consensus_score: 0,
      confidence: 0,
      edge: 0,
      direction: 'none',
      decision: 'PASS',
      units: 0,
      model_home_prob: 0.5,
      market_home_prob: 0.5,
      posterior_home_prob: 0.5,
      agreement_index: 0,
      shrinkage: 0,
      market_source: 'none',
      calibrated: false,
      calibration_detail: null,
      data_caps: [],
      data_cap: 100,
      raw_confidence: 0,
      capped_confidence: 0,
      alignment: { yes_count: 0, no_count: 0, neu_count: 0, yes_weight: 0, no_weight: 0 },
      breakdown: [],
      kelly: { available: false, reason },
      thresholds_used: THRESHOLDS.DEFAULT,
      error: reason,
      computed_at: new Date().toISOString(),
    };
  }

  // ============================================================
  // ── UTILITIES ──
  // ============================================================

  function clamp(v, min, max) { return Math.max(min, Math.min(max, v)); }
  function round(v, d) { const f = Math.pow(10, d); return Math.round(v * f) / f; }

  // Load once at module init.
  reloadCalibration();

  return {
    BUILD,
    run,
    setCalibration,
    reloadCalibration,
    getDynamicWeights,
    STATIC_WEIGHTS,
    THRESHOLDS,
    MARKET_SHRINK,
    HOME_BASELINE,
    MAX_CONFIDENCE,
    MAX_CALIBRATION_PULL,
    CALIBRATION_FULL_SAMPLE,
    spreadToImplied,
    americanToImplied,
  };

})();

if (typeof window !== 'undefined') window.EDGE_GOVERNOR = EDGE_GOVERNOR;