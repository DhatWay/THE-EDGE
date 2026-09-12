// ============================================================
// EDGE — GOVERNOR v2.1
// Recalibrated confidence formula — reaches realistic ranges
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

  // Lower thresholds so the model can actually fire picks
  const SPORT_THRESHOLDS = {
    NFL:   { bet2u: 68, bet1u: 58, lean: 45, minEdge2u: 0.030, minEdge1u: 0.018, minEdgeLean: 0.008 },
    NBA:   { bet2u: 65, bet1u: 55, lean: 42, minEdge2u: 0.025, minEdge1u: 0.015, minEdgeLean: 0.008 },
    MLB:   { bet2u: 68, bet1u: 58, lean: 45, minEdge2u: 0.030, minEdge1u: 0.018, minEdgeLean: 0.008 },
    NHL:   { bet2u: 68, bet1u: 58, lean: 45, minEdge2u: 0.030, minEdge1u: 0.018, minEdgeLean: 0.008 },
    NCAAF: { bet2u: 68, bet1u: 58, lean: 45, minEdge2u: 0.030, minEdge1u: 0.018, minEdgeLean: 0.008 },
    NCAAB: { bet2u: 65, bet1u: 55, lean: 42, minEdge2u: 0.025, minEdge1u: 0.015, minEdgeLean: 0.008 },
    MLS:   { bet2u: 68, bet1u: 58, lean: 45, minEdge2u: 0.030, minEdge1u: 0.018, minEdgeLean: 0.008 },
    DEFAULT: { bet2u: 68, bet1u: 58, lean: 45, minEdge2u: 0.028, minEdge1u: 0.016, minEdgeLean: 0.008 },
  };

  const SHRINKAGE = {
    NFL: 0.30, NBA: 0.30, MLB: 0.45, NHL: 0.45,
    NCAAF: 0.40, NCAAB: 0.40, MLS: 0.50, DEFAULT: 0.40,
  };

  const HOME_BASELINE = {
    NFL: 0.565, NBA: 0.595, MLB: 0.540, NHL: 0.555,
    NCAAF: 0.605, NCAAB: 0.640, MLS: 0.600, DEFAULT: 0.570,
  };

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

  function run(familyOutputs, prior, options = {}) {
    if (!Array.isArray(familyOutputs) || familyOutputs.length === 0) {
      return emptyResult('No family outputs');
    }

    const sport = prior?.sport || 'DEFAULT';
    const weights = options.dynamicWeights || getDynamicWeights(sport);
    const thresholds = SPORT_THRESHOLDS[sport] || SPORT_THRESHOLDS.DEFAULT;
    const shrinkage = options.shrinkage ?? (SHRINKAGE[sport] ?? SHRINKAGE.DEFAULT);
    const homeBaseline = HOME_BASELINE[sport] ?? HOME_BASELINE.DEFAULT;

    // ── LAYER 1: Force vectors ──
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

    // ── LAYER 2: Normalized consensus ──
    const F_norm = clamp(netForce / totalWeight, -1, 1);

    // ── LAYER 3: Agreement Index ──
    const agreementIndex = sumAbsForces > 0
      ? clamp(Math.abs(netForce) / sumAbsForces, 0, 1)
      : 0;

    // ── LAYER 4: Raw confidence ──
    const rawConfidence = Math.abs(F_norm) * 100;

    // ── LAYER 5: Coherence-adjusted ──
    const coherenceAdjusted = rawConfidence * (0.65 + agreementIndex * 0.35);

    // ── LAYER 6: Conflict penalty ──
    const yesFams = breakdown.filter(b => b.vote === 'yes');
    const noFams  = breakdown.filter(b => b.vote === 'no');
    const topYesConf = yesFams.length ? Math.max(...yesFams.map(b => b.confidence)) : 0;
    const topNoConf  = noFams.length  ? Math.max(...noFams.map(b => b.confidence))  : 0;
    const conflictMagnitude = Math.min(topYesConf, topNoConf);
    const conflictPenalty = conflictMagnitude * 18;

    const conflictAdjusted = Math.max(coherenceAdjusted - conflictPenalty, 0);

    // ── LAYER 7: Bayesian posterior ──
    const marketImpliedHome = prior?.market?.home_ml
      ? americanToImplied(prior.market.home_ml)
      : homeBaseline;

    const modelHomeProb = 0.5 + (F_norm / 2);
    const posteriorHomeProb = (1 - shrinkage) * modelHomeProb + shrinkage * marketImpliedHome;
    const posteriorConfidence = Math.abs(posteriorHomeProb - 0.5) * 200;

    // ── LAYER 8: Combine (FIXED) ──
    // Linear blend of coherence-adjusted + posterior, then amplify.
    // Old formula used sqrt() which collapsed strong signals to ~17%.
    const combined = (conflictAdjusted * 0.70) + (posteriorConfidence * 0.30);
    const amplified = combined * 2.5;
    const finalConfidence = round(Math.min(amplified, 100), 1);

    // ── LAYER 9: Calibration ──
    const calibratedConfidence = applyCalibration(finalConfidence);

    // ── LAYER 10: Weighted edge ──
    const weightedEdge = weightForEdge > 0 ? edgeWeightedSum / weightForEdge : 0;

    // ── LAYER 11: Direction ──
    const direction = F_norm > 0 ? 'home' : 'away';

    // ── LAYER 12: Decision ──
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

    // ── LAYER 13: Kelly ──
    const kellyInput = buildKellyInput({
      posteriorHomeProb, marketHomeML: prior?.market?.home_ml, direction, units,
    });

    return {
      consensus_score: round(F_norm, 4),
      confidence: calibratedConfidence,
      raw_confidence: round(rawConfidence, 1),
      coherence_adjusted: round(coherenceAdjusted, 1),
      posterior_confidence: round(posteriorConfidence, 1),
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

  function buildKellyInput({ posteriorHomeProb, marketHomeML, direction, units }) {
    if (!marketHomeML) return { available: false, reason: 'No market ML' };
    const ourProb = direction === 'home' ? posteriorHomeProb : (1 - posteriorHomeProb);
    const marketProb = direction === 'home'
      ? americanToImplied(marketHomeML)
      : 1 - americanToImplied(marketHomeML);
    const decimal = direction === 'home'
      ? americanToDecimal(marketHomeML)
      : americanToDecimal(-marketHomeML);
    const b = decimal - 1;
    const edge = ourProb - marketProb;
    const kellyRaw = b > 0 ? (b * ourProb - (1 - ourProb)) / b : 0;
    const kellyFractional = Math.max(kellyRaw * 0.25, 0);
    const kellyUnits = Math.min(kellyFractional * 100 / 5, 5);
    return {
      available: true,
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
      posterior_confidence: 0, calibrated: false, agreement_index: 0, conflict_penalty: 0,
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
    STATIC_WEIGHTS, SPORT_THRESHOLDS, SHRINKAGE, HOME_BASELINE,
  };

})();

if (typeof window !== 'undefined') window.EDGE_GOVERNOR = EDGE_GOVERNOR;