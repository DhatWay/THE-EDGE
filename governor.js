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

  const BUILD = 'gov-20260930-01';

  // ── The ranking decides ──
  // The pick comes from the ranking: offense/defense and composite
  // blend, coaching and the defense matchup, turned into the chance
  // that each side covers the market spread (power-engine's
  // prior.cover). These families only adjust that chance, by at most
  // ADJUST_MAX, because they describe the day rather than the teams:
  const ADJUSTMENT_FAMILIES = new Set(['fatigue', 'injury']);
  const ADJUST_MAX = 0.04;

  // These carry no weight in any decision. Market and line movement
  // react to the betting line, not the teams; weather is a totals
  // question, and it was voting for the away side on windy days;
  // trends and situations are historical ATS streaks.
  const EXCLUDED_FAMILIES = new Set(['market', 'line_dynamics', 'environment', 'trend', 'situations']);

  // Props: market pull toward the price entered, and the smallest
  // sample of games a projection may rest on before it is capped.
  const PROP_SHRINK = 0.35;
  const PROP_MIN_GAMES = 5;

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

  // Decision thresholds. Confidence is the chance the chosen side
  // covers, in percent — 57 means a 57% cover chance. At -110 the
  // break-even is 52.4%. The previous scale (distance from 50/50
  // times 200, times an agreement factor) needed a 75%+ cover
  // chance to reach a lean, so nothing ever cleared it and no pick
  // was ever saved. Edge is the same number as a margin over 50%.
  const PROB_TIERS = { bet2u: 57, bet1u: 55, lean: 53, minEdge2u: 0.07, minEdge1u: 0.05, minEdgeLean: 0.03 };
  const THRESHOLDS = {
    NFL: PROB_TIERS, NBA: PROB_TIERS, WNBA: PROB_TIERS, MLB: PROB_TIERS, NHL: PROB_TIERS,
    NCAAF: PROB_TIERS, NCAAB: PROB_TIERS, MLS: PROB_TIERS, DEFAULT: PROB_TIERS,
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
      const w = EXCLUDED_FAMILIES.has(f.family) ? 0 : (weights[f.family] ?? 7);
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

    const rankingCover = prior?.cover && isFinite(prior.cover.home_cover) ? prior.cover : null;
    if (totalWeight === 0 && !rankingCover) {
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
    // With a ranking cover chance on hand, it is the model. The
    // adjustment families nudge it; nothing else votes. Without one
    // (no spread posted, no ratings), the weighted family signal is
    // the fallback, excluded families still at zero.
    let modelHomeProb;
    let adjustment = 0;
    let decisionSource = 'families';
    if (rankingCover) {
      let adjNum = 0, adjDen = 0;
      breakdown.forEach(b => {
        if (!ADJUSTMENT_FAMILIES.has(b.family) || !b.weight) return;
        adjNum += b.weight * b.signal * b.confidence;
        adjDen += b.weight * b.confidence;
      });
      adjustment = adjDen > 0 ? clamp(adjNum / adjDen, -1, 1) * ADJUST_MAX : 0;
      modelHomeProb = clamp(rankingCover.home_cover + adjustment, 0.02, 0.98);
      decisionSource = 'ranking';
    } else {
      modelHomeProb = clamp(0.5 + normalizedSignal / 2, 0.02, 0.98);
    }

    const marketInfo = resolveMarket(prior, homeBaseline, sport);
    const marketHomeProb = marketInfo.prob;

    // A cover chance already anchored to the market (a fitted lambda)
    // is not pulled toward it a second time.
    const effectiveShrink = (rankingCover && rankingCover.anchored_to_market) ? 0 : shrink;
    const posteriorHomeProb = (1 - effectiveShrink) * modelHomeProb + effectiveShrink * marketHomeProb;

    // Raw edge in probability terms.
    const edge = Math.abs(posteriorHomeProb - 0.5);

    // ── 4. Confidence ──
    // Three things produce confidence: how far the posterior
    // moved from a coin flip, how strongly the families agreed
    // on a direction, and how much data they had. All three
    // are already baked into normalizedSignal and agreement,
    // so the formula is short.
    // Confidence is the posterior chance the chosen side covers.
    const rawConfidence = Math.max(posteriorHomeProb, 1 - posteriorHomeProb) * 100;
    const cappedConfidence = Math.min(rawConfidence, MAX_CONFIDENCE);

    // Calibration is a pull, not a substitution. The blended value
    // moves toward the observed hit rate in the bucket by a
    // sample-weighted factor. See applyCalibration for the shape.
    const calibrated = applyCalibration(cappedConfidence, sport);

    // ── 5. Data-availability caps ──
    // Two hard caps for missing inputs. These are the only caps
    // that aren't coming from the math itself.
    const dataCaps = [];
    let cap = 100;

    // No spread posted: nothing to bet against the spread.
    if (prior?.market?.current_spread == null) {
      cap = Math.min(cap, 50);
      dataCaps.push('no spread');
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
      marketAwayML: prior?.market?.away_ml,
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
      decision_source: decisionSource,
      ranking_home_cover: rankingCover ? round(rankingCover.home_cover, 4) : null,
      adjustment: round(adjustment, 4),
      model_home_prob: round(modelHomeProb, 4),
      market_home_prob: round(marketHomeProb, 4),
      posterior_home_prob: round(posteriorHomeProb, 4),

      // Diagnostics
      agreement_index: round(agreement, 3),
      shrinkage: round(effectiveShrink, 3),
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
  // ── PROPS ──
  // Same steps as a spread pick, with over in place of home: the
  // prop projection's chance of going over is the model, the prop
  // families adjust it by at most ADJUST_MAX, the price entered is
  // the market, then the same confidence, thresholds and units.
  //
  // propPrior: { sport, prob_over, games, line, price, side }
  //   price is American odds for `side` when entered.
  // ============================================================

  function runProp(familyOutputs, propPrior, options = {}) {
    const sport = propPrior?.sport || 'DEFAULT';
    const thresholds = THRESHOLDS[sport] || THRESHOLDS.DEFAULT;
    if (!propPrior || !isFinite(propPrior.prob_over)) return emptyResult('No projection');

    const breakdown = [];
    let adjNum = 0, adjDen = 0;
    (familyOutputs || []).forEach(f => {
      const sig = typeof f.signal === 'number' && isFinite(f.signal) ? f.signal : 0;
      const conf = clamp(f.confidence ?? 0.5, 0, 1);
      const w = f.weight ?? 1;
      adjNum += w * sig * conf;
      adjDen += w * conf;
      breakdown.push({
        family: f.family, vote: f.vote, signal: round(sig, 3), confidence: round(conf, 3),
        weight: w, contribution: round(w * sig * conf, 3), reason: f.reason || '', data: f.data || {},
      });
    });
    const adjustment = adjDen > 0 ? clamp(adjNum / adjDen, -1, 1) * ADJUST_MAX : 0;
    const modelOverProb = clamp(propPrior.prob_over + adjustment, 0.02, 0.98);

    // Market: the price entered for one side, as that side's implied
    // chance. None entered: a standard two-way line, 50/50.
    let marketOverProb = 0.5;
    if (propPrior.price) {
      const implied = americanToImplied(propPrior.price);
      marketOverProb = propPrior.side === 'under' ? 1 - implied : implied;
    }
    const posteriorOver = (1 - PROP_SHRINK) * modelOverProb + PROP_SHRINK * marketOverProb;
    const edge = Math.abs(posteriorOver - 0.5);

    const yes = breakdown.filter(b => b.vote === 'yes').reduce((s, b) => s + b.weight, 0);
    const no = breakdown.filter(b => b.vote === 'no').reduce((s, b) => s + b.weight, 0);
    const agreement = (yes + no) > 0 ? Math.abs(yes - no) / (yes + no) : 0;

    const rawConfidence = Math.max(posteriorOver, 1 - posteriorOver) * 100;
    let cap = MAX_CONFIDENCE;
    const dataCaps = [];
    if ((propPrior.games || 0) < PROP_MIN_GAMES) {
      cap = Math.min(cap, 50);
      dataCaps.push(`only ${propPrior.games || 0} games on file`);
    }
    const finalConfidence = round(Math.min(rawConfidence, cap), 1);

    const direction = posteriorOver > 0.5 ? 'over' : 'under';
    let decision = 'PASS', units = 0;
    if (finalConfidence >= thresholds.bet2u && edge >= thresholds.minEdge2u) { decision = 'BET_2U'; units = 2; }
    else if (finalConfidence >= thresholds.bet1u && edge >= thresholds.minEdge1u) { decision = 'BET_1U'; units = 1; }
    else if (finalConfidence >= thresholds.lean && edge >= thresholds.minEdgeLean) { decision = 'LEAN'; units = 0.5; }

    return {
      decision_source: 'prop',
      direction,
      decision,
      units,
      confidence: finalConfidence,
      edge: round(edge, 4),
      model_over_prob: round(modelOverProb, 4),
      market_over_prob: round(marketOverProb, 4),
      posterior_over_prob: round(posteriorOver, 4),
      adjustment: round(adjustment, 4),
      agreement_index: round(agreement, 3),
      shrinkage: PROP_SHRINK,
      data_caps: dataCaps,
      breakdown,
      thresholds_used: thresholds,
      computed_at: new Date().toISOString(),
    };
  }

  // ============================================================
  // ── MARKET RESOLUTION ──
  // Prefer moneyline-implied probability. Fall back to the
  // spread implied probability. Last resort, the sport baseline.
  // ============================================================

  // The market's view of the bet actually being made. Picks are
  // spread bets, graded against the spread, and the posted spread is
  // the market's 50/50 point — so with a spread on the board the
  // market's home-cover probability is 0.5.
  //
  // This used to return the moneyline's WIN probability. The
  // families' signal is measured against the spread (centered on
  // 50%), so blending it with a win probability pulled every pick
  // toward the favorite: for a 7-point favorite (about 75% to win)
  // a model leaning 45% on the favorite still came out 54% for it.
  //
  // The moneyline and baseline remain the fallback only when no
  // spread is posted.
  function resolveMarket(prior, homeBaseline, sport) {
    if (typeof prior?.market?.current_spread === 'number') {
      return { prob: 0.5, source: 'spread' };
    }
    if (prior?.market?.home_ml) {
      return { prob: americanToImplied(prior.market.home_ml), source: 'moneyline' };
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

  // ── Calibration table, version 2 ──
  // Per sport, 2-point buckets of the uncalibrated chance to cover
  // (50, 52, … 64 = 64 and above), each holding how often picks in
  // that bucket actually covered. Filled from two sources, kept
  // apart so neither overwrites the other:
  //   backtest_runs[sport][window] — written by the Slate Test
  //   live[sport]                  — written by the learning loop
  // and pooled into sports[sport][bucket] = { rate, samples }.
  const CALIBRATION_MIN_SAMPLES = 20;

  function calibrationBucket(confidence) {
    return String(Math.max(50, Math.min(64, Math.floor(confidence / 2) * 2)));
  }

  function emptyCalibrationTable() {
    return { version: 2, bucket_width: 2, backtest_runs: {}, live: {}, sports: {}, updated_at: null };
  }

  function readCalibrationTable() {
    try {
      const t = JSON.parse(localStorage.getItem('edge_governor_calibration') || 'null');
      if (t && t.version === 2) return t;
    } catch {}
    return emptyCalibrationTable();
  }

  function poolCalibration(table) {
    const t = table && table.version === 2 ? table : emptyCalibrationTable();
    const sports = new Set([...Object.keys(t.backtest_runs || {}), ...Object.keys(t.live || {})]);
    t.sports = {};
    sports.forEach(sport => {
      const counts = {};
      const add = (buckets) => Object.entries(buckets || {}).forEach(([b, v]) => {
        counts[b] = counts[b] || { n: 0, wins: 0 };
        counts[b].n += v.n || 0;
        counts[b].wins += v.wins || 0;
      });
      Object.values((t.backtest_runs || {})[sport] || {}).forEach(run => add(run.buckets));
      add((t.live || {})[sport]);
      t.sports[sport] = {};
      Object.entries(counts).forEach(([b, v]) => {
        if (v.n > 0) t.sports[sport][b] = { rate: round((v.wins / v.n) * 100, 1), samples: v.n };
      });
    });
    t.updated_at = new Date().toISOString();
    return t;
  }

  function saveCalibrationTable(table) {
    const pooled = poolCalibration(table);
    try { localStorage.setItem('edge_governor_calibration', JSON.stringify(pooled)); } catch {}
    CALIBRATION = pooled;
    return pooled;
  }

  function applyCalibration(confidence, sport) {
    // Version 2: this sport's bucket, 2 points wide.
    if (CALIBRATION && CALIBRATION.version === 2) {
      const bucket = calibrationBucket(confidence);
      const entry = CALIBRATION.sports?.[sport]?.[bucket];
      if (!entry || !isFinite(entry.rate) || (entry.samples || 0) < CALIBRATION_MIN_SAMPLES) {
        return { value: round(confidence, 1), applied: false, detail: null };
      }
      const pull = MAX_CALIBRATION_PULL * clamp(entry.samples / CALIBRATION_FULL_SAMPLE, 0, 1);
      const final = clamp(confidence + (entry.rate - confidence) * pull, 0, MAX_CONFIDENCE);
      return {
        value: round(final, 1),
        applied: true,
        detail: { bucket, sport, rate: entry.rate, samples: entry.samples, pull: round(pull, 3), shape: 'v2' },
      };
    }

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

  // Sized as what it is: a spread bet at the standard -110 when a
  // spread is posted (market cover probability 0.5). The moneyline
  // is used only when there is no spread, and then each side at its
  // own price — the away price used to be the home price negated,
  // which ignores the vig and overstated underdog payouts.
  function buildKellyInput({ posteriorHomeProb, marketHomeML, marketAwayML, spread, sport, direction, units }) {
    const ourProb = direction === 'home' ? posteriorHomeProb : 1 - posteriorHomeProb;

    let marketProb, decimal, source;

    if (typeof spread === 'number') {
      marketProb = 0.5;
      decimal = americanToDecimal(-110);
      source = 'spread';
    } else if (marketHomeML) {
      const marketHome = americanToImplied(marketHomeML);
      marketProb = direction === 'home' ? marketHome : 1 - marketHome;
      const sidePrice = direction === 'home'
        ? marketHomeML
        : (marketAwayML || -marketHomeML);
      decimal = americanToDecimal(sidePrice);
      source = 'ml';
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
    runProp,
    calibrationBucket,
    readCalibrationTable,
    poolCalibration,
    saveCalibrationTable,
    EXCLUDED_FAMILIES,
    ADJUSTMENT_FAMILIES,
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