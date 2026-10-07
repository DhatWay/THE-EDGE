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

  const BUILD = 'gov-20261007-01';

  // Bets are decided on expected value at the real price, so a side
  // at -120 needs a bigger edge than one at -105, and a moneyline
  // underdog can be a bet below 50%. The tiers equal the old 53 / 55 /
  // 57% chance-to-cover tiers at -110, so spread picks at -110 are
  // decided exactly as before.
  const EV_TIERS = { lean: 0.018, bet1u: 0.05, bet2u: 0.088 };

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

  // ============================================================
  // ── RUN: ONE PROBABILITY ──
  //
  // Every input feeds a single chance for each side, built in
  // log-odds (where independent evidence adds):
  //
  //   start   the market's chance (benchmark book, or consensus)
  //   +       strength: the ranking's disagreement with the market,
  //           times w_strength — how much of that disagreement has
  //           historically turned out real (Slate Test, per sport)
  //   +       spots: each situation that fired, by its tested record
  //           (shrunk toward 50% until it has a sample), times w_spots
  //   +       context: rest and injuries, a small capped nudge
  //
  // Then: calibration once (spreads), expected value at the real
  // price, Kelly-sized by physics. Nothing here can veto a bet;
  // weak evidence produces a small probability edge and so a small
  // bet. The family votes are shown for reading, and the three that
  // measure team strength are already inside the ranking.
  // ============================================================

  // Until a sport's Slate Test sets it: tests so far show most of the
  // ranking's disagreement with the line is noise, so it starts low.
  const DEFAULT_BLEND = { w_strength: 0.6, w_spots: 1.0 };
  const SPOT_PRIOR_GAMES = 60;      // a spot's record is blended with 60 games at the prior rate
  // The belief a spot starts with before it has a record: a modest
  // 53%, so a situation you encoded counts a little from day one, and
  // its own results take over as they come in (a spot that keeps
  // failing turns negative).
  const SPOT_PRIOR_RATE = 0.53;
  // A spot only counts beyond that small belief when its record clears
  // luck: at least this many games, and a 95% range that excludes what
  // the market already expected. A fade needs the same proof.
  const SPOT_MIN_GAMES = 30;
  // 99%, not 95%: about 30 situations are tested at once, so at 95% one
  // or two would look "proven" by luck alone.
  const SPOT_PROOF_Z = 2.576;
  // No single spot can move the chance more than this (≈ 3.7 points).
  const SPOT_EACH_CAP = 0.15;
  // Groups already priced in the rest/injury step, or about totals.
  const CONTEXT_GROUPS = new Set(['rest', 'travel', 'injury', 'weather']);
  // Strength's pull: scaled by how many games the ratings rest on, and
  // capped (log-odds 0.42 ≈ 10 points at 50%).
  const STRENGTH_CAP = 0.42;
  const STRENGTH_FULL_GAMES = { NFL: 8, NCAAF: 8, NBA: 20, WNBA: 12, NCAAB: 12, MLB: 40, NHL: 20, MLS: 10 };


  const SPOT_CAP = 0.35;            // spots together move log-odds at most this much (~±8.7 pts at 50%)
  const CONTEXT_CAP = 0.16;         // rest + injuries, at most ~±4 pts
  const STRENGTH_FAMILIES = new Set(['team_quality', 'offense_defense', 'coaching']);

  function logit(p) { const q = clamp(p, 0.001, 0.999); return Math.log(q / (1 - q)); }
  function sigmoid(x) { return 1 / (1 + Math.exp(-x)); }

  // Blend weights for a sport (and bet type), from the Slate Test.
  function blendFor(sport, betType) {
    try {
      const t = readCalibrationTable();
      const key = betType === 'ML' ? `${sport}_ML` : sport;
      const b = t?.blend?.[key];
      if (b && isFinite(b.w_strength) && isFinite(b.w_spots)) return { ...b, source: 'fitted' };
    } catch {}
    return { ...DEFAULT_BLEND, source: 'default' };
  }

  // Spots: the situations that fired for this game, each with its
  // tested record { id, label, side: 'home'|'away', wins, losses }.
  // A spot's edge is its record blended toward 50% by sample size,
  // in log-odds; overlapping spots are damped by the square root of
  // how many fired, then capped.
  // ── TOTALS (over / under) ──
  // The market's total, moved toward the model's projected total by a
  // weight (0.3 until the Slate Test learns one for the sport), scaled
  // by how many games the ratings rest on and capped. Weather (outdoor
  // football) can only lower it. Then the same value tiers as sides.
  const TOTAL_DEFAULT_WEIGHT = 0.3;
  const TOTAL_SHIFT_CAP = { NFL: 4, NCAAF: 5, NBA: 5, WNBA: 4, NCAAB: 4.5, MLB: 0.8, NHL: 0.5, MLS: 0.4 };

  function totalWeightFor(sport) {
    try {
      const t = readCalibrationTable();
      const w = t?.total_weight?.[sport]?.w;
      if (isFinite(w)) return { w, source: 'fitted' };
    } catch {}
    return { w: TOTAL_DEFAULT_WEIGHT, source: 'default' };
  }

  function rateTotal({ sport, modelTotal, marketTotal, overPrice, underPrice, weatherAdj = 0, certainty = 1, weight = null }) {
    const core = window.EDGE_RATING;
    if (!core || !core.totalProbability || !isFinite(modelTotal) || !isFinite(marketTotal)) return null;
    const sd = core.TOTAL_SD?.[sport] || 14;
    const wInfo = weight != null ? { w: weight, source: 'given' } : totalWeightFor(sport);
    const cap = TOTAL_SHIFT_CAP[sport] ?? 4;
    const shift = clamp(wInfo.w * clamp(certainty, 0.25, 1) * ((modelTotal + Math.min(0, weatherAdj)) - marketTotal), -cap, cap);
    const mu = marketTotal + shift;
    const prob = core.totalProbability(mu, marketTotal, sd);
    if (!prob) return null;
    const op = isFinite(overPrice) && overPrice !== 0 ? overPrice : -110;
    const up = isFinite(underPrice) && underPrice !== 0 ? underPrice : -110;
    const evOver = prob.over * (americanToDecimal(op) - 1) - prob.under;
    const evUnder = prob.under * (americanToDecimal(up) - 1) - prob.over;
    const side = evOver >= evUnder ? 'over' : 'under';
    const p = side === 'over' ? prob.over : prob.under;
    const price = side === 'over' ? op : up;
    const ev = side === 'over' ? evOver : evUnder;
    const tier = ev >= EV_TIERS.bet2u ? '2U' : ev >= EV_TIERS.bet1u ? '1U' : ev >= EV_TIERS.lean ? 'LEAN' : 'PASS';
    return {
      side, p: round(p, 4), price, ev: round(ev, 4), break_even: round(1 / americanToDecimal(price), 4), tier,
      mu: round(mu, 2), sd, shift: round(shift, 2), weight: wInfo.w, weight_source: wInfo.source,
      model_total: round(modelTotal, 2), market_total: marketTotal, weather_adj: round(Math.min(0, weatherAdj), 2),
      push: prob.push,
    };
  }

  function wilson(w, n) {
    if (!n) return [0, 1];
    const z = SPOT_PROOF_Z, p = w / n, d = 1 + z * z / n;
    const c = p + z * z / (2 * n), r = z * Math.sqrt(p * (1 - p) / n + z * z / (4 * n * n));
    return [(c - r) / d, (c + r) / d];
  }

  function spotEvidence(spots) {
    const list = (spots || []).filter(x => x && (x.side === 'home' || x.side === 'away'));
    if (!list.length) return { logit: 0, detail: [] };
    const detail = list.map(x => {
      const w = Number(x.wins) || 0, l = Number(x.losses) || 0;
      // Measured against what the market already gave its side in the
      // games it fired (base) — spreads sit near 50%.
      const base = isFinite(x.base) ? clamp(x.base, 0.05, 0.95) : 0.5;
      const priorRate = sigmoid(logit(base) + logit(SPOT_PRIOR_RATE));
      const rate = (w + priorRate * SPOT_PRIOR_GAMES) / (w + l + SPOT_PRIOR_GAMES);
      const edge = logit(rate) - logit(base);
      return { id: x.id, label: x.label || x.id, side: x.side, group: x.group || x.id, record: `${w}-${l}`,
               rate: round(rate, 4), base: round(base, 4), edge: round(x.side === 'home' ? edge : -edge, 4) };
    });
    const sum = detail.reduce((s, d) => s + d.edge, 0) / Math.sqrt(detail.length);
    return { logit: clamp(sum, -SPOT_CAP, SPOT_CAP), detail };
  }

  function run(familyOutputs, prior, options = {}) {
    const sport = prior?.sport || 'DEFAULT';
    const thresholds = THRESHOLDS[sport] || THRESHOLDS.DEFAULT;
    const homeBaseline = HOME_BASELINE[sport] ?? HOME_BASELINE.DEFAULT;
    const betType = prior?.bet_type === 'ML' ? 'ML' : 'SPREAD';

    // ── Family votes: read, and two of them nudge ──
    const breakdown = (familyOutputs || []).map(f => {
      const sig = typeof f.signal === 'number' && isFinite(f.signal) ? f.signal : 0;
      const conf = clamp(f.confidence ?? 0.5, 0, 1);
      const role = ADJUSTMENT_FAMILIES.has(f.family) ? 'context'
        : STRENGTH_FAMILIES.has(f.family) ? 'in strength' : 'not used';
      return {
        family: f.family, vote: f.vote, signal: round(sig, 3), confidence: round(conf, 3),
        edge: round(f.edge || 0, 4), weight: role === 'context' ? 1 : 0, role,
        contribution: 0, reason: f.reason || '', data: f.data || {},
      };
    });
    let cNum = 0, cDen = 0;
    breakdown.forEach(b => { if (b.role === 'context') { cNum += b.signal * b.confidence; cDen += b.confidence; } });
    const contextLogit = cDen > 0 ? clamp(cNum / cDen, -1, 1) * CONTEXT_CAP : 0;

    // ── Market ──
    const marketInfo = betType === 'ML' ? resolveMoneyline(prior) : resolveMarket(prior, homeBaseline, sport);
    const marketHomeProb = marketInfo.prob;

    // ── Strength ──
    const rankingSource = betType === 'ML' ? prior?.win : prior?.cover;
    const strengthHomeProb = rankingSource && isFinite(rankingSource.home_cover) ? rankingSource.home_cover : null;

    // ── Spots ──
    const spots = spotEvidence(prior?.spots);

    // ── One probability ──
    // The Slate Test passes its own blend (the defaults) so a backtest
    // is never scored with weights learned from the same games.
    const blend = options.blend ? { ...options.blend, source: options.blend.source || 'given' } : blendFor(sport, betType);
    const strengthCertainty = 1;
    const strengthTerm = strengthHomeProb != null
      ? blend.w_strength * (logit(strengthHomeProb) - logit(marketHomeProb)) : 0;
    const spotTerm = blend.w_spots * spots.logit;
    const posteriorHomeProb = sigmoid(logit(marketHomeProb) + strengthTerm + spotTerm + contextLogit);

    // ── Prices ──
    const priceFor = side => {
      const m = prior?.market || {};
      const v = betType === 'ML'
        ? (side === 'home' ? m.home_ml : m.away_ml)
        : (side === 'home' ? m.home_spread_price : m.away_spread_price);
      return isFinite(Number(v)) && Number(v) !== 0 ? Number(v) : (betType === 'ML' ? null : -110);
    };
    const homePrice = priceFor('home'), awayPrice = priceFor('away');
    const evAt = (p, price) => price == null ? -1 : p * (americanToDecimal(price) - 1) - (1 - p);

    // ── Side: worth more at its price ──
    const sideIsHome = evAt(posteriorHomeProb, homePrice) >= evAt(1 - posteriorHomeProb, awayPrice);
    const sideProb = sideIsHome ? posteriorHomeProb : 1 - posteriorHomeProb;

    // ── Calibration, once (spreads) ──
    const rawConfidence = sideProb * 100;
    const cappedConfidence = Math.min(rawConfidence, MAX_CONFIDENCE);
    // Spreads calibrate on the chance to cover; moneylines on the chance
    // to win, in their own 4-point bands (underdogs sit below 50%).
    const calibrated = betType === 'ML'
      ? applyCalibration(cappedConfidence, `${sport}_ML`)
      : applyCalibration(cappedConfidence, sport);

    // ── Nothing to bet against ──
    const dataCaps = [];
    let blocked = false;
    if (betType === 'SPREAD' && prior?.market?.current_spread == null) { dataCaps.push('no spread'); blocked = true; }
    if (betType === 'ML' && (homePrice == null || awayPrice == null)) { dataCaps.push('no moneyline'); blocked = true; }

    const finalConfidence = round(Math.min(calibrated.value, MAX_CONFIDENCE), 1);

    // ── Decision: expected value at the real price ──
    const direction = sideIsHome ? 'home' : 'away';
    const sidePrice = sideIsHome ? homePrice : awayPrice;
    const otherPrice = sideIsHome ? awayPrice : homePrice;
    const pDecide = finalConfidence / 100;
    const ev = blocked ? -1 : evAt(pDecide, sidePrice);
    const breakEven = sidePrice != null ? 1 / americanToDecimal(sidePrice) : 0.5238;
    const edge = round(pDecide - breakEven, 4);

    let decision = 'PASS', units = 0;
    if (ev >= EV_TIERS.bet2u)      { decision = 'BET_2U'; units = 2; }
    else if (ev >= EV_TIERS.bet1u) { decision = 'BET_1U'; units = 1; }
    else if (ev >= EV_TIERS.lean)  { decision = 'LEAN';   units = 0.5; }

    const kellyInput = buildKellyInput({ sideProb: pDecide, sidePrice, otherPrice, betType, units });

    // Votes for reading (agreement among the families shown).
    const yes = breakdown.filter(b => b.vote === 'yes').length;
    const no = breakdown.filter(b => b.vote === 'no').length;
    const agreement = (yes + no) > 0 ? Math.abs(yes - no) / (yes + no) : 0;
    const signed = (yes - no) / Math.max(1, breakdown.length);

    return {
      consensus_score: round(signed, 4),
      confidence: finalConfidence,
      edge,
      direction,
      decision,
      units,

      bet_type: betType,
      price: sidePrice,
      ev: round(ev, 4),
      break_even: round(breakEven, 4),

      // The probability, piece by piece (home view, log-odds terms)
      decision_source: strengthHomeProb != null ? 'blend' : 'market + spots',
      components: {
        market_home: round(marketHomeProb, 4),
        strength_home: strengthHomeProb != null ? round(strengthHomeProb, 4) : null,
        strength_term: round(strengthTerm, 4),
        strength_certainty: round(strengthCertainty, 3),
        spots_term: round(spotTerm, 4),
        context_term: round(contextLogit, 4),
        w_strength: round(blend.w_strength, 3),
        w_spots: round(blend.w_spots, 3),
        blend_source: blend.source,
        spots: spots.detail,
      },
      ranking_home_cover: strengthHomeProb != null ? round(strengthHomeProb, 4) : null,
      adjustment: round(contextLogit, 4),
      model_home_prob: strengthHomeProb != null ? round(strengthHomeProb, 4) : round(marketHomeProb, 4),
      market_home_prob: round(marketHomeProb, 4),
      posterior_home_prob: round(posteriorHomeProb, 4),

      agreement_index: round(agreement, 3),
      shrinkage: 0,
      market_source: marketInfo.source,
      calibrated: calibrated.applied,
      calibration_detail: calibrated.detail,
      data_caps: dataCaps,
      data_cap: MAX_CONFIDENCE,

      raw_confidence: round(rawConfidence, 1),
      capped_confidence: round(cappedConfidence, 1),

      alignment: { yes_count: yes, no_count: no, neu_count: breakdown.length - yes - no },
      breakdown,

      kelly: kellyInput,
      thresholds_used: thresholds,
      computed_at: new Date().toISOString(),
    };
  }

  // Moneyline market: each side's implied chance, vig removed.
  function resolveMoneyline(prior) {
    const pm = prior?.market || {};
    if (pm.pin_home_ml && pm.pin_away_ml) {
      const ih = americanToImplied(pm.pin_home_ml), ia = americanToImplied(pm.pin_away_ml);
      return { prob: ih / (ih + ia), source: pm.bench_book || 'benchmark' };
    }
    const h = prior?.market?.home_ml, a = prior?.market?.away_ml;
    if (!h || !a) return { prob: 0.5, source: 'none' };
    const ih = americanToImplied(h), ia = americanToImplied(a);
    return { prob: ih / (ih + ia), source: 'moneyline' };
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

    // Same expected-value tiers as spreads, at the price entered when
    // the pick is that side, else a standard -110.
    const direction = posteriorOver > 0.5 ? 'over' : 'under';
    const sidePrice = (propPrior.price && direction === propPrior.side) ? Number(propPrior.price) : -110;
    const pSide = finalConfidence / 100;
    const ev = pSide * (americanToDecimal(sidePrice) - 1) - (1 - pSide);
    let decision = 'PASS', units = 0;
    if (ev >= EV_TIERS.bet2u)      { decision = 'BET_2U'; units = 2; }
    else if (ev >= EV_TIERS.bet1u) { decision = 'BET_1U'; units = 1; }
    else if (ev >= EV_TIERS.lean)  { decision = 'LEAN';   units = 0.5; }

    return {
      decision_source: 'prop',
      price: sidePrice,
      ev: round(ev, 4),
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
      // With Pinnacle's line and prices: the sharp market's chance the
      // home side covers the line being bet — 50% at Pinnacle's own
      // number (vig removed), moved for the half-points between its
      // line and this one at about 3% a point.
      const m = prior.market;
      if (isFinite(m.pin_home_spread) && m.pin_home_price && m.pin_away_price) {
        const ih = americanToImplied(m.pin_home_price), ia = americanToImplied(m.pin_away_price);
        const atPin = ih / (ih + ia);
        const shift = (m.current_spread - m.pin_home_spread) * 0.03;
        return { prob: clamp(atPin + shift, 0.05, 0.95), source: m.bench_book || 'benchmark' };
      }
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

  function calibrationBucket(confidence, kind) {
    if (String(kind || '').endsWith('_ML')) {
      return String(Math.max(20, Math.min(76, Math.floor(confidence / 4) * 4)));
    }
    return String(Math.max(50, Math.min(64, Math.floor(confidence / 2) * 2)));
  }

  function emptyCalibrationTable() {
    return { version: 3, bucket_width: 2, backtest_runs: {}, live: {}, sports: {}, updated_at: null };
  }

  function readCalibrationTable() {
    try {
      const t = JSON.parse(localStorage.getItem('edge_governor_calibration') || 'null');
      if (t && t.version === 3) return t;
    } catch {}
    return emptyCalibrationTable();
  }

  function poolCalibration(table) {
    const t = table && table.version === 3 ? table : emptyCalibrationTable();
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
      // Isotonic: a higher said-chance can't have a lower cover rate.
      // Adjacent buckets that break that are pooled (weighted by
      // games) until the rates rise — noise in a thin bucket no longer
      // flips a 58% below a 56%.
      const keys = Object.keys(counts).filter(b => counts[b].n > 0).sort((a, b) => Number(a) - Number(b));
      const blocks = keys.map(b => ({ keys: [b], n: counts[b].n, wins: counts[b].wins }));
      for (let i = 0; i < blocks.length - 1;) {
        const a = blocks[i], c = blocks[i + 1];
        if (a.wins / a.n > c.wins / c.n) {
          blocks.splice(i, 2, { keys: a.keys.concat(c.keys), n: a.n + c.n, wins: a.wins + c.wins });
          if (i > 0) i--;
        } else i++;
      }
      t.sports[sport] = {};
      blocks.forEach(bl => bl.keys.forEach(b => {
        t.sports[sport][b] = {
          rate: round((bl.wins / bl.n) * 100, 1),
          rate_raw: round((counts[b].wins / counts[b].n) * 100, 1),
          samples: counts[b].n,
        };
      }));
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
    // This sport's bucket, 2 points wide (table version 3).
    if (CALIBRATION && CALIBRATION.version === 3) {
      const bucket = calibrationBucket(confidence, sport);
      const entry = CALIBRATION.sports?.[sport]?.[bucket];
      if (!entry || !isFinite(entry.rate) || (entry.samples || 0) < CALIBRATION_MIN_SAMPLES) {
        return { value: round(confidence, 1), applied: false, detail: null };
      }
      const pull = MAX_CALIBRATION_PULL * clamp(entry.samples / CALIBRATION_FULL_SAMPLE, 0, 1);
      const final = clamp(confidence + (entry.rate - confidence) * pull, 0, MAX_CONFIDENCE);
      return {
        value: round(final, 1),
        applied: true,
        detail: { bucket, sport, rate: entry.rate, samples: entry.samples, pull: round(pull, 3), shape: 'v3' },
      };
    }

    // Older tables (learned before the one-probability governor) are
    // not applied; rerun the Slate Test to build a current one.
    return { value: round(confidence, 1), applied: false, detail: null };
  }

  // ============================================================
  // ── KELLY ──
  // ============================================================

  // Sized as what it is: a spread bet at the standard -110 when a
  // spread is posted (market cover probability 0.5). The moneyline
  // is used only when there is no spread, and then each side at its
  // own price — the away price used to be the home price negated,
  // which ignores the vig and overstated underdog payouts.
  // Kelly at the side's own price. The market's chance is the price's
  // implied chance with the vig removed using the other side's price.
  function buildKellyInput({ sideProb, sidePrice, otherPrice, betType, units }) {
    const ourProb = sideProb;
    if (sidePrice == null) return { available: false, reason: 'No price' };
    const impSide = americanToImplied(sidePrice);
    const impOther = otherPrice != null ? americanToImplied(otherPrice) : 1 - impSide;
    const marketProb = (impSide + impOther) > 0 ? impSide / (impSide + impOther) : impSide;
    const decimal = americanToDecimal(sidePrice);
    const source = betType === 'ML' ? 'ml' : 'spread';

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
    rateTotal,
    DEFAULT_BLEND,
    SPOT_PRIOR_RATE,
    SPOT_PRIOR_GAMES,
    spotEvidence,
    blendFor,
    DEFAULT_BLEND,
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