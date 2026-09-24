// ============================================================
// EDGE — PHYSICS v2.1
//
// Converts a governor verdict into units and a dollar stake.
//
// Design principles:
//   1. Governor decides the pick and its confidence. Physics
//      only decides the size. It never changes the direction
//      or the decision label unless a hard cap forbids the bet.
//   2. One sizing formula. Governor units are the ceiling; a
//      fixed fractional Kelly becomes the floor. Sizing is
//      min(governor, kelly) with the caps applied, not a stack
//      of independent multipliers.
//   3. Every constant is exposed. KELLY_FRACTION, MAX_UNITS,
//      MAX_BANKROLL_PCT. The slate test can override any of them
//      to see how the pipeline responds.
//   4. No silent overrides. The v1.1 fallback that put governor
//      units back on top of Kelly when Kelly returned zero is
//      gone. If Kelly says zero, that is the correct answer.
//
// v2.1 changes:
//   · Double-shrink removed. Governor already returns kelly_raw
//     (the full Kelly fraction, e.g. 0.055 = 5.5% of bankroll)
//     alongside kelly_fractional and kelly_units which are its
//     own pre-scaled variants. Physics was reading kelly_units
//     and applying another sport fraction on top, so the result
//     was fraction × fraction. Now it reads kelly_raw once and
//     applies the sport fraction once. Single shrink.
//   · Floor inflation removed. The line
//     `if (finalUnits < floor && finalUnits > 0) finalUnits = floor`
//     silently promoted a Kelly of 0.05 units to 0.25 units —
//     the exact "silent override" the header claims was removed.
//     Deleting it means roundToQuarter handles small values
//     correctly: 0.22 → 0.25, 0.05 → 0.0, and 0.0 becomes a
//     PASS because a bet that small has no reason to exist.
//   · Sizing math is now expressed in dollars first, then
//     converted to units by the actual unit size. This fixes a
//     latent scale mismatch: the old code assumed 1 unit = 20%
//     of bankroll, while the settings default treats 1 unit as a
//     flat dollar amount. The two definitions disagreed by a
//     factor of about four. Physics now uses whatever unit size
//     the user configured and does not assume.
//
// Output shape stays compatible with orchestrator.js and the
// pick cards.
// ============================================================

const EDGE_PHYSICS = (() => {

  const BUILD = 'phys-20260924-01';

  // Fractional Kelly per sport. Kelly is aggressive; taking a
  // fraction of it is standard practice. These are the default
  // fractions until the learning loop fits them.
  const KELLY_FRACTION = {
    NFL: 0.20, NBA: 0.22, WNBA: 0.22, MLB: 0.18, NHL: 0.18,
    NCAAF: 0.15, NCAAB: 0.18, MLS: 0.15, DEFAULT: 0.20,
  };

  // Unit ceiling by tier. A 90% confidence pick is allowed up to
  // 3 units; a 55% lean is capped at 1. These are the ceilings,
  // not the sizes — actual size comes from Kelly and the
  // governor's own unit number.
  const MAX_UNITS = {
    elite: 3.0,   // 85%+
    high: 2.5,    // 75–84%
    solid: 2.0,   // 65–74%
    lean: 1.0,    // 55–64%
    small: 0.5,   // below 55%
  };

  const MIN_UNITS = 0.25;
  const MAX_BANKROLL_PCT_PER_BET = 0.05;

  const DECISION = {
    BET: 'BET', LEAN: 'LEAN', PASS: 'PASS',
    VETOED: 'VETOED', CAPPED: 'CAPPED',
  };

  // ============================================================
  // ── MAIN ──
  // ============================================================

  function decide(governorOutput, prior, context = {}) {
    const sport = prior?.sport || 'DEFAULT';

    const baseDecision = governorOutput.decision || 'PASS';
    const baseUnits    = governorOutput.units || 0;
    const confidence   = governorOutput.confidence || 0;
    const edge         = governorOutput.edge || 0;
    const direction    = governorOutput.direction || 'none';

    if (baseDecision === 'PASS' || direction === 'none' || baseUnits <= 0) {
      return buildOutput({
        decision: DECISION.PASS,
        units: 0,
        direction,
        confidence,
        edge,
        reasons: ['Governor returned PASS'],
        governor: governorOutput,
        prior,
        sizing: null,
        capCheck: null,
      });
    }

    // ── 1. Bankroll and unit size ──
    const bankroll = getBankroll();
    const unitSize = getUnitSize(bankroll);

    // ── 2. Kelly from the governor's own probability ──
    // The governor already produces a posterior probability and a
    // matching decimal price for the side we're taking. kelly_raw
    // is the full Kelly fraction — e.g. 0.055 means "5.5% of
    // bankroll". Physics applies the sport-specific fraction to
    // that, once. The double-shrink bug was physics reading
    // kelly_units (which the governor had already scaled) and
    // applying a second fraction on top.
    const k = governorOutput.kelly || {};
    const kellyRaw = (k.available && typeof k.kelly_raw === 'number') ? k.kelly_raw : 0;
    const kellyFraction = KELLY_FRACTION[sport] ?? KELLY_FRACTION.DEFAULT;

    // Fractional Kelly in bankroll terms.
    const fractionalKelly = kellyRaw * kellyFraction;

    // Convert bankroll-fraction to dollars, then to units using the
    // actual unit size the user configured. No assumption about
    // what a unit is worth.
    const kellyDollars = fractionalKelly * bankroll;
    const kellyUnits = unitSize > 0 ? (kellyDollars / unitSize) : 0;

    // ── 3. Three ceilings ──
    //   a. What the governor already said (its own units)
    //   b. What tier the confidence permits
    //   c. What the bankroll permits at max exposure per bet
    const tierCap = tierCeiling(confidence);
    const bankrollCap = unitSize > 0
      ? (bankroll * MAX_BANKROLL_PCT_PER_BET) / unitSize
      : Infinity;
    const governorCeiling = baseUnits;

    const ceiling = Math.min(governorCeiling, tierCap, bankrollCap);
    let finalUnits = roundToQuarter(Math.min(ceiling, kellyUnits));

    // If Kelly says zero or negative, that is the answer. No fallback.
    if (kellyUnits <= 0 && governorCeiling > 0) {
      return buildOutput({
        decision: DECISION.PASS,
        units: 0,
        direction,
        confidence,
        edge,
        reasons: ['Kelly says no edge at this price'],
        governor: governorOutput,
        prior,
        sizing: {
          kelly_raw: kellyRaw,
          fractional_kelly: fractionalKelly,
          sport_fraction: kellyFraction,
          kelly_dollars: round(kellyDollars, 2),
          kelly_units: round(kellyUnits, 4),
          tier_cap: tierCap,
          bankroll_cap: round(bankrollCap, 2),
          governor_ceiling: governorCeiling,
        },
        capCheck: null,
      });
    }

    // If rounding produced zero from a genuinely tiny Kelly, that
    // means the correct size is below the minimum meaningful bet.
    // Treat it as PASS rather than inflating to the floor. The
    // v2.0 code promoted 0.05 units to 0.25 — that was the silent
    // override this module's header claims does not exist.
    if (finalUnits <= 0) {
      return buildOutput({
        decision: DECISION.PASS,
        units: 0,
        direction,
        confidence,
        edge,
        reasons: [`Kelly size ${round(kellyUnits, 4)}u below minimum ${MIN_UNITS}u`],
        governor: governorOutput,
        prior,
        sizing: {
          kelly_raw: kellyRaw,
          fractional_kelly: fractionalKelly,
          sport_fraction: kellyFraction,
          kelly_dollars: round(kellyDollars, 2),
          kelly_units: round(kellyUnits, 4),
          tier_cap: tierCap,
          bankroll_cap: round(bankrollCap, 2),
          governor_ceiling: governorCeiling,
        },
        capCheck: null,
      });
    }

    // ── 4. Hard caps from settings ──
    const capCheck = checkCaps(finalUnits, unitSize, context);
    let capStatus = 'ok';

    if (!capCheck.allowed) {
      if (capCheck.partialUnits && capCheck.partialUnits > 0) {
        finalUnits = capCheck.partialUnits;
        capStatus = 'partial';
      } else {
        return buildOutput({
          decision: DECISION.CAPPED,
          units: 0,
          direction,
          confidence,
          edge,
          reasons: [capCheck.reason || 'Cap exceeded'],
          governor: governorOutput,
          prior,
          sizing: {
            kelly_raw: kellyRaw,
            fractional_kelly: fractionalKelly,
            sport_fraction: kellyFraction,
            kelly_dollars: round(kellyDollars, 2),
            kelly_units: round(kellyUnits, 4),
            tier_cap: tierCap,
            bankroll_cap: round(bankrollCap, 2),
            governor_ceiling: governorCeiling,
          },
          capCheck,
        });
      }
    }

    // ── 5. Preserve the governor decision label ──
    // Only downgrade if the sizing cannot support the label.
    let decision = baseDecision;
    if (finalUnits < 1 && decision === 'BET_2U') decision = 'BET_1U';
    if (finalUnits < 0.5 && decision === 'BET_1U') decision = 'LEAN';

    // ── 6. Reasons ──
    const reasons = [];
    reasons.push(`Governor: ${baseDecision} @ ${baseUnits}u`);
    reasons.push(`Kelly: ${round(kellyRaw * 100, 2)}% raw → ${round(fractionalKelly * 100, 2)}% at ${(kellyFraction * 100).toFixed(0)}% fraction → ${round(kellyUnits, 3)}u`);
    if (tierCap < governorCeiling) reasons.push(`Tier cap: ${tierCap}u`);
    if (bankrollCap < tierCap) reasons.push(`Bankroll cap: ${round(bankrollCap, 2)}u`);
    if (capStatus === 'partial') reasons.push(`Settings partial: ${capCheck.reason}`);
    reasons.push(`Final: ${finalUnits}u`);

    return buildOutput({
      decision,
      units: finalUnits,
      direction,
      confidence,
      edge,
      reasons,
      governor: governorOutput,
      prior,
      sizing: {
        kelly_raw: kellyRaw,
        fractional_kelly: round(fractionalKelly, 5),
        sport_fraction: kellyFraction,
        kelly_dollars: round(kellyDollars, 2),
        kelly_units: round(kellyUnits, 4),
        tier_cap: tierCap,
        bankroll_cap: round(bankrollCap, 2),
        governor_ceiling: governorCeiling,
      },
      capCheck,
    });
  }

  // ============================================================
  // ── SETTINGS CAPS ──
  // ============================================================

  function checkCaps(proposedUnits, unitSize, context) {
    const proposedDollars = proposedUnits * unitSize;
    const dailyCap   = parseFloat(localStorage.getItem('edge_daily_cap') || '0');
    const weeklyCap  = parseFloat(localStorage.getItem('edge_weekly_cap') || '0');
    const maxBets    = parseInt(localStorage.getItem('edge_max_bets') || '0');
    const maxUnitBet = parseFloat(localStorage.getItem('edge_max_unit_size') || '0');
    const dailyUsed  = parseFloat(localStorage.getItem('edge_daily_used') || '0');
    const weeklyUsed = parseFloat(localStorage.getItem('edge_weekly_used') || '0');
    const betsUsed   = parseInt(localStorage.getItem('edge_bets_used') || '0');

    if (maxBets > 0 && betsUsed >= maxBets) {
      return { allowed: false, reason: `Max bets/day (${betsUsed}/${maxBets})` };
    }
    if (maxUnitBet > 0 && proposedUnits > maxUnitBet) {
      return { allowed: true, partialUnits: maxUnitBet, reason: `Capped to ${maxUnitBet}u` };
    }
    if (dailyCap > 0) {
      const remaining = dailyCap - dailyUsed;
      if (remaining <= 0) return { allowed: false, reason: 'Daily cap exhausted' };
      if (proposedDollars > remaining) {
        const partialUnits = Math.floor((remaining / unitSize) * 4) / 4;
        if (partialUnits < MIN_UNITS) return { allowed: false, reason: 'Daily cap insufficient' };
        return { allowed: true, partialUnits, reason: `Partial — daily cap ${partialUnits}u` };
      }
    }
    if (weeklyCap > 0) {
      const remaining = weeklyCap - weeklyUsed;
      if (remaining <= 0) return { allowed: false, reason: 'Weekly cap exhausted' };
      if (proposedDollars > remaining) {
        const partialUnits = Math.floor((remaining / unitSize) * 4) / 4;
        if (partialUnits < MIN_UNITS) return { allowed: false, reason: 'Weekly cap insufficient' };
        return { allowed: true, partialUnits, reason: `Partial — weekly cap ${partialUnits}u` };
      }
    }
    return { allowed: true, reason: 'ok' };
  }

  // ============================================================
  // ── CLAUDE ADJUSTMENT ──
  // Kept so the Claude overlay can reduce size or veto without
  // changing the shape of the pipeline. Only ever reduces.
  // ============================================================

  function applyClaudeAdjustment(physicsOutput, claudeOutput) {
    if (!claudeOutput || typeof claudeOutput !== 'object') return physicsOutput;
    const adjustment = clamp(claudeOutput.confidence_adjustment || 0, -0.15, 0);
    const decision = claudeOutput.decision || 'approve';
    const result = { ...physicsOutput };
    result.claude = { decision, adjustment, reason: claudeOutput.reason || '' };

    if (decision === 'veto') {
      result.decision = DECISION.VETOED;
      result.units = 0;
      result.claude_vetoed = true;
      result.reasons = [...result.reasons, `Claude vetoed: ${claudeOutput.reason || ''}`];
      return result;
    }
    if (adjustment < 0) {
      const factor = 1 + adjustment;
      result.units = roundToQuarter(result.units * factor);
      if (result.units < MIN_UNITS) result.units = 0;
      result.adjusted_by_claude = true;
      result.reasons = [
        ...result.reasons,
        `Claude reduced ${(adjustment * 100).toFixed(0)}%: ${claudeOutput.reason || ''}`,
      ];
    }
    return result;
  }

  // ============================================================
  // ── OUTPUT BUILDER ──
  // ============================================================

  function buildOutput({
    decision, units, direction, confidence, edge,
    reasons, governor, prior, sizing, capCheck,
  }) {
    const bankroll = getBankroll();
    const unitSize = getUnitSize(bankroll);
    const stakeDollars = round(units * unitSize, 2);

    return {
      decision,
      units,
      stake_dollars: stakeDollars,
      direction,
      side_label: buildSideLabel(direction, prior),
      confidence,
      edge,
      reasons,

      // Physics does not change the direction. It carries the
      // governor's numbers through so the pick card, the slate
      // test, and the learning loop all see the same values.
      governor_snapshot: {
        consensus_score: governor.consensus_score,
        confidence: governor.confidence,
        decision: governor.decision,
        direction: governor.direction,
        agreement_index: governor.agreement_index,
        model_home_prob: governor.model_home_prob,
        market_home_prob: governor.market_home_prob,
        posterior_home_prob: governor.posterior_home_prob,
        market_source: governor.market_source,
        data_caps: governor.data_caps || [],
        breakdown: governor.breakdown || [],
      },

      // Sizing trail — every number that contributed to units.
      sizing_details: sizing,

      // Cap trail.
      cap_check: capCheck || null,

      // Market snapshot, carried through from the prior.
      market_snapshot: {
        spread: prior?.market?.current_spread ?? null,
        open_spread: prior?.market?.open_spread ?? null,
        total: prior?.market?.total ?? null,
        home_ml: prior?.market?.home_ml ?? null,
        away_ml: prior?.market?.away_ml ?? null,
        home_spread_price: prior?.market?.home_spread_price ?? null,
        away_spread_price: prior?.market?.away_spread_price ?? null,
        over_price: prior?.market?.over_price ?? null,
        under_price: prior?.market?.under_price ?? null,
        book: prior?.market?.book ?? null,
        book_key: prior?.market?.book_key ?? null,
        book_link: prior?.market?.book_link ?? null,
        price_source: prior?.market?.price_source ?? 'consensus',
      },

      bankroll_snapshot: {
        bankroll,
        unit_size: unitSize,
        daily_used: parseFloat(localStorage.getItem('edge_daily_used') || '0'),
        weekly_used: parseFloat(localStorage.getItem('edge_weekly_used') || '0'),
      },

      mode: 'deterministic',
      engine_version: '2.1',
      computed_at: new Date().toISOString(),
    };
  }

  function buildSideLabel(direction, prior) {
    if (direction === 'home') return { team: prior?.home_team || 'Home', side: 'home', action: 'BACK' };
    if (direction === 'away') return { team: prior?.away_team || 'Away', side: 'away', action: 'BACK' };
    return { team: null, side: 'none', action: 'NONE' };
  }

  // ============================================================
  // ── HELPERS ──
  // ============================================================

  function getBankroll() {
    const b = parseFloat(localStorage.getItem('edge_bankroll') || '0');
    return b > 0 ? b : 1000;
  }

  function getUnitSize(bankroll) {
    const unitType = localStorage.getItem('edge_unit_type') || 'flat';
    if (unitType === 'pct') {
      const pct = parseFloat(localStorage.getItem('edge_unit_size') || '1');
      return (bankroll * pct) / 100;
    }
    const flat = parseFloat(localStorage.getItem('edge_unit_size') || '0');
    return flat > 0 ? flat : 50;
  }

  function tierCeiling(confidence) {
    if (confidence >= 85) return MAX_UNITS.elite;
    if (confidence >= 75) return MAX_UNITS.high;
    if (confidence >= 65) return MAX_UNITS.solid;
    if (confidence >= 55) return MAX_UNITS.lean;
    return MAX_UNITS.small;
  }

  function roundToQuarter(v) { return Math.round(v * 4) / 4; }
  function clamp(v, min, max) { return Math.max(min, Math.min(max, v)); }
  function round(v, d) { const f = Math.pow(10, d); return Math.round(v * f) / f; }

  return {
    BUILD,
    decide,
    applyClaudeAdjustment,
    checkCaps,
    DECISION,
    KELLY_FRACTION,
    MAX_UNITS,
    MAX_BANKROLL_PCT_PER_BET,
    MIN_UNITS,
  };

})();

if (typeof window !== 'undefined') window.EDGE_PHYSICS = EDGE_PHYSICS;