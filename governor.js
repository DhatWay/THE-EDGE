// ============================================================
// EDGE — GOVERNOR v2.3
// Spread-implied probability fallback when ML missing
// Realistic thresholds · no over-capping
// ============================================================

const EDGE_GOVERNOR = (() => {

  const STATIC_WEIGHTS = {
    NFL:   { team_quality: 10, offense_defense: 8,  coaching: 8, market: 10, line_dynamics: 9, fatigue: 8,  environment: 7,  trend: 6, injury: 10 },
    NBA:   { team_quality: 9,  offense_defense: 10, coaching: 7, market: 9,  line_dynamics: 8, fatigue: 10, environment: 2,  trend: 8, injury: 10 },
    MLB:   { team_quality: 8,  offense_defense: 8,  coaching: 6, market: 9,  line_dynamics: 8, fatigue: 7,  environment: 10, trend: 7, injury: 8  },
    NHL:   { team_quality: 8,  offense_defense: 8,  coaching: 7, market: 9,  line_dynamics: 8, fatigue: 8,  environment: 2,  trend: 7, injury: 9  },
    NCAAF: { team_quality: 9,  offense_defense: 8,  coaching: 9, market: 9,  line_dynamics: 8, fatigue: 7,  environment: 8,  trend: 7, injury: 9  },
    NCAAB: { team_quality: 9,  offense_defense: 9,  coaching: 8, market: 8,  line_dynamics: 8, fatigue: 8,  environment: 3,  trend: 7, injury: 8  },
    MLS:   { team_quality: 8,  offense_defense: 8,  coaching: 7, market: 8,  line_dynamics: 7, fatigue: 8,  environment: 10, trend: 8, injury: 8  },
    DEFAULT: { team_quality: 8, offense_defense: 8, coaching: 7, market: 9, line_dynamics: 8, fatigue: 8, environment: 6, trend: 7, injury: 8 },
  };

  const SPORT_THRESHOLDS = {
    NFL:   { bet2u: 68, bet1u: 60, lean: 50, minEdge2u: 0.030, minEdge1u: 0.020, minEdgeLean: 0.008 },
    NBA:   { bet2u: 66, bet1u: 58, lean: 48, minEdge2u: 0.028, minEdge1u: 0.018, minEdgeLean: 0.008 },
    MLB:   { bet2u: 68, bet1u: 60, lean: 50, minEdge2u: 0.030, minEdge1u: 0.020, minEdgeLean: 0.008 },
    NHL:   { bet2u: 68, bet1u: 60, lean: 50, minEdge2u: 0.030, minEdge1u: 0.020, minEdgeLean: 0.008 },
    NCAAF: { bet2u: 66, bet1u: 58, lean: 48, minEdge2u: 0.028, minEdge1u: 0.018, minEdgeLean: 0.008 },
    NCAAB: { bet2u: 64, bet1u: 56, lean: 46, minEdge2u: 0.026, minEdge1u: 0.016, minEdgeLean: 0.008 },
    MLS:   { bet2u: 68, bet1u: 60, lean: 50, minEdge2u: 0.030, minEdge1u: 0.020, minEdgeLean: 0.008 },
    DEFAULT: { bet2u: 66, bet1u: 58, lean: 48, minEdge2u: 0.028, minEdge1u: 0.018, minEdgeLean: 0.008 },
  };

  const SHRINKAGE = {
    NFL: 0.30, NBA: 0.30, MLB: 0.45, NHL: 0.45,
    NCAAF: 0.40, NCAAB: 0.40, MLS: 0.50, DEFAULT: 0.40,
  };

  const HOME_BASELINE = {
    NFL: 0.565, NBA: 0.595, MLB: 0.540, NHL: 0.555,
    NCAAF: 0.605, NCAAB: 0.640, MLS: 0.600, DEFAULT: 0.570,
  };

  const MAX_CONFIDENCE = 82;

  let CALIBRATION = {};

  function setCalibration(table) { CALIBRATION = table || {}; }
  function loadCalibrationFromStorage() {
    try {
      const stored = localStorage.getItem('edge_governor_calibration');
      if (stored) CALIBRATION = JSON.parse(stored);
    } catch {}
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

  // ── Spread → implied home win prob (fallback when ML missing) ──
  function spreadToImpliedProb(homeSpread, sport) {
    if (typeof homeSpread !== 'number') return null;
    // Home spread negative = home favored. Per point ≈ 2.5-3% shift.
    const perPoint = {
      NFL: 0.028, NCAAF: 0.028, NBA: 0.032, NCAAB: 0.032,
      MLB: 0.040, NHL: 0.035, MLS: 0.040,
    }[sport] || 0.030;
    // homeSpread = -7 means home favored by 7 → prob 0.5 + 7*perPoint
    return clamp(0.5 + (-homeSpread * perPoint), 0.10, 0.90);
  }

  function run(familyOutputs, prior, options = {}) {
    if (!Array.isArray(familyOutputs) || familyOutputs.length === 0) {
      return emptyResult('No family outputs');
    }

    const sport = prior?.sport || 'DEFAULT';
    const weights = options.dynamicWeights || getDynamicWeights(sport);
    const thresholds = SPORT_THRESHOLDS[sport] || SPORT_THRESHOLDS.DEFAULT;
    const shrinkage = options.shrinkage ?? (SHRINKAGE[sport] ?? SHRINKAGE.DEFAULT);
    const homeBaseline = HOME_BASELINE[sport] ?? HOME_BASELINE.DEFAULT;

    const breakdown = [];
    let sumAbsForces = 0;
    let netForce = 0;
    let totalWeight = 0;
    let edgeWeightedSum = 0;
    let weightForEdge = 0;

    familyOutputs.forEach(f => {
      const w = weights[f.family] ?? 7;
      const dir = f.vote === 'yes' ? 1 : f.vote === 'no' ? -1 : 0;
      const conf = clamp(f.confidence ?? 0.5, 0, 1);
      const force = w * conf * dir;

      sumAbsForces += Math.abs(force);
      netForce += force;
      totalWeight += w;

      if (typeof f.edge === 'number' && f.edge !== 0 && dir !== 0) {
        edgeWeightedSum += f.edge * w * conf;
        weightForEdge += w * conf;
      }

      breakdown.push({
        family: f.family,
        vote: f.vote,
        confidence: round(conf, 3),
        edge: round(f.edge || 0, 4),
        weight: w,
        force: round(force, 3),
        reason: f.reason || '',
        data: f.data || {},
      });
    });

    if (totalWeight === 0) return emptyResult('Zero weight');

    const F_norm = clamp(netForce / totalWeight, -1, 1);
    const agreementIndex = sumAbsForces > 0
      ? clamp(Math.abs(netForce) / sumAbsForces, 0, 1)
      : 0;

    const rawConfidence = Math.abs(F_norm) * 100;
    const coherenceAdjusted = rawConfidence * (0.65 + agreementIndex * 0.35);

    const yesFams = breakdown.filter(b => b.vote === 'yes');
    const noFams  = breakdown.filter(b => b.vote === 'no');
    const topYesConf = yesFams.length ? Math.max(...yesFams.map(b => b.confidence)) : 0;
    const topNoConf  = noFams.length  ? Math.max(...noFams.map(b => b.confidence))  : 0;
    const conflictMagnitude = Math.min(topYesConf, topNoConf);
    const conflictPenalty = conflictMagnitude * 15;

    const conflictAdjusted = Math.max(coherenceAdjusted - conflictPenalty, 0);

    // ── Market implied probability (ML preferred, spread fallback) ──
    let marketImpliedHome;
    let marketSource;

    if (prior?.market?.home_ml) {
      marketImpliedHome = americanToImplied(prior.market.home_ml);
      marketSource = 'moneyline';
    } else if (typeof prior?.market?.current_spread === 'number') {
      marketImpliedHome = spreadToImpliedProb(prior.market.current_spread, sport);
      marketSource = 'spread';
    } else {
      marketImpliedHome = homeBaseline;
      marketSource = 'baseline';
    }

    const modelHomeProb = 0.5 + (F_norm / 2);
    const posteriorHomeProb = (1 - shrinkage) * modelHomeProb + shrinkage * marketImpliedHome;
    const posteriorConfidence = Math.abs(posteriorHomeProb - 0.5) * 200;

    const combined = (conflictAdjusted * 0.75) + (posteriorConfidence * 0.25);

    // ── Data-availability caps (soft now) ──
    const dataCaps = [];
    let cap = 100;

    if (prior?.market?.current_spread == null) {
      cap = Math.min(cap, 60);
      dataCaps.push('no spread');
    }
    const hasLineHistory = !!(prior?.market?.open_spread
      && prior?.market?.current_spread
      && prior.market.open_spread !== prior.market.current_spread);
    if (!hasLineHistory) {
      cap = Math.min(cap, 78);
      dataCaps.push('no line movement');
    }

    const capped = Math.min(combined, cap);
    const finalConfidence = round(Math.min(capped, MAX_CONFIDENCE), 1);
    const calibratedConfidence = applyCalibration(finalConfidence);

    const weightedEdge = weightForEdge > 0 ? edgeWeightedSum / weightForEdge : 0;
    const direction = F_norm > 0 ? 'home' : 'away';

    const absEdge = Math.abs(weightedEdge);
    let decision = 'PASS';
    let units = 0;
    let recommendedSide = 'pass';

    if (calibratedConfidence >= thresholds.bet2u && absEdge >= thresholds.minEdge2u) {
      decision = 'BET_2U'; units = 2; recommendedSide = direction;
    } else if (calibratedConfidence >= thresholds.bet1u && absEdge >= thresholds.minEdge1u) {
      decision = 'BET_1U'; units = 1; recommendedSide = direction;
    } else if (calibratedConfidence >= thresholds.lean && absEdge >= thresholds.minEdgeLean) {
      decision = 'LEAN'; units = 0.5; recommendedSide = direction;
    }

    const kellyInput = buildKellyInput({
      posteriorHomeProb,
      marketHomeML: prior?.market?.home_ml,
      spread: prior?.market?.current_spread,
      sport,
      direction,
      units,
    });

    return {
      consensus_score: round(F_norm, 4),
      confidence: calibratedConfidence,
      raw_confidence: round(rawConfidence, 1),
      coherence_adjusted: round(coherenceAdjusted, 1),
      posterior_confidence: round(posteriorConfidence, 1),
      combined_pre_cap: round(combined, 1),
      data_cap: cap,
      data_caps: dataCaps,
      market_source: marketSource,
      calibrated: Object.keys(CALIBRATION).length > 0,

      agreement_index: round(agreementIndex, 3),
      conflict_penalty: round(conflictPenalty, 2),
      shrinkage: round(shrinkage, 3),
      edge: round(weightedEdge, 4),

      direction,
      recommended_side: recommendedSide,
      decision,
      units,

      model_home_prob: round(modelHomeProb, 4),
      market_home_prob: round(marketImpliedHome, 4),
      posterior_home_prob: round(posteriorHomeProb, 4),

      kelly: kellyInput,

      alignment: {
        yes_count: yesFams.length,
        no_count: noFams.length,
        neu_count: breakdown.length - yesFams.length - noFams.length,
        top_yes_confidence: round(topYesConf, 3),
        top_no_confidence: round(topNoConf, 3),
      },
      breakdown,
      thresholds_used: thresholds,
      computed_at: new Date().toISOString(),
    };
  }

  function applyCalibration(confidence) {
    const keys = Object.keys(CALIBRATION);
    if (keys.length === 0) return round(confidence, 1);
    const bucketSize = 5;
    const bucket = Math.round(confidence / bucketSize) * bucketSize;
    const calibrated = CALIBRATION[String(bucket)];
    if (typeof calibrated === 'number') return round(calibrated, 1);
    return round(confidence, 1);
  }

  function buildKellyInput({ posteriorHomeProb, marketHomeML, spread, sport, direction, units }) {
    const ourProb = direction === 'home' ? posteriorHomeProb : (1 - posteriorHomeProb);

    let marketProb;
    let decimal;
    let source;

    if (marketHomeML) {
      const marketHome = americanToImplied(marketHomeML);
      marketProb = direction === 'home' ? marketHome : (1 - marketHome);
      decimal = direction === 'home' ? americanToDecimal(marketHomeML) : americanToDecimal(-marketHomeML);
      source = 'ml';
    } else if (typeof spread === 'number') {
      const homeImplied = spreadToImpliedProb(spread, sport);
      marketProb = direction === 'home' ? homeImplied : (1 - homeImplied);
      decimal = 1.91; // -110 standard
      source = 'spread';
    } else {
      return { available: false, reason: 'No market data' };
    }

    const b = decimal - 1;
    const edge = ourProb - marketProb;
    const kellyRaw = b > 0 ? (b * ourProb - (1 - ourProb)) / b : 0;
    const kellyFractional = Math.max(kellyRaw * 0.25, 0);
    const kellyUnits = Math.min(kellyFractional * 100 / 5, 5);

    return {
      available: true,
      source,
      our_prob: round(ourProb, 4),
      market_prob: round(marketProb, 4),
      edge: round(edge, 4),
      kelly_raw: round(kellyRaw, 4),
      kelly_fractional: round(kellyFractional, 4),
      kelly_units: round(kellyUnits, 2),
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

  function emptyResult(reason) {
    return {
      consensus_score: 0, confidence: 0, raw_confidence: 0, coherence_adjusted: 0,
      posterior_confidence: 0, combined_pre_cap: 0, data_cap: 100, data_caps: [],
      market_source: 'none', calibrated: false, agreement_index: 0, conflict_penalty: 0,
      shrinkage: 0, edge: 0, direction: 'none', recommended_side: 'pass',
      decision: 'PASS', units: 0,
      model_home_prob: 0.5, market_home_prob: 0.5, posterior_home_prob: 0.5,
      kelly: { available: false, reason },
      alignment: { yes_count: 0, no_count: 0, neu_count: 0, top_yes_confidence: 0, top_no_confidence: 0 },
      breakdown: [], error: reason,
      computed_at: new Date().toISOString(),
    };
  }

  function clamp(v, min, max) { return Math.max(min, Math.min(max, v)); }
  function round(v, d) { const f = Math.pow(10, d); return Math.round(v * f) / f; }

  loadCalibrationFromStorage();

  return {
    run, setCalibration, getDynamicWeights,
    STATIC_WEIGHTS, SPORT_THRESHOLDS, SHRINKAGE, HOME_BASELINE, MAX_CONFIDENCE,
    spreadToImpliedProb,
  };

})();

if (typeof window !== 'undefined') window.EDGE_GOVERNOR = EDGE_GOVERNOR;