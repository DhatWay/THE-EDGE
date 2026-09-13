// ============================================================
// EDGE — PHYSICS v1.1
// Preserves governor decision labels · honest unit sizing
// ============================================================

const EDGE_PHYSICS = (() => {

  const KELLY_FRACTION = {
    NFL: 0.20, NBA: 0.22, MLB: 0.18, NHL: 0.18,
    NCAAF: 0.15, NCAAB: 0.18, MLS: 0.15, DEFAULT: 0.20,
  };

  const MAX_UNITS = {
    elite: 3.0, high: 2.5, solid: 2.0, lean: 1.0, small: 0.5,
  };

  const MIN_UNITS = 0.25;
  const MAX_BANKROLL_PCT_PER_BET = 0.05;

  const DECISION = {
    BET: 'BET', LEAN: 'LEAN', PASS: 'PASS',
    VETOED: 'VETOED', CAPPED: 'CAPPED',
  };

  function decide(governorOutput, prior, context = {}) {
    const sport = prior?.sport || 'DEFAULT';
    const thresholds = governorOutput.thresholds_used || {};

    const baseDecision = governorOutput.decision || 'PASS';
    const baseUnits = governorOutput.units || 0;
    const confidence = governorOutput.confidence || 0;
    const edge = governorOutput.edge || 0;
    const direction = governorOutput.direction || 'none';

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
      });
    }

    const bankroll = getBankroll();
    const unitSize = getUnitSize(bankroll);
    const kellyInput = governorOutput.kelly || {};
    // Fall back to governor units when Kelly is unavailable OR returns 0
    const kellyUnits = (kellyInput.available && kellyInput.kelly_units > 0)
      ? kellyInput.kelly_units
      : baseUnits;

    const tierCap = getConfidenceTierCap(confidence);
    const kf = KELLY_FRACTION[sport] || KELLY_FRACTION.DEFAULT;
    const fractionalKellyUnits = kellyUnits * (kf / 0.25);
    const governorCapped = Math.min(fractionalKellyUnits, baseUnits);
    const tierCapped = Math.min(governorCapped, tierCap);
    const maxBankrollUnits = (bankroll * MAX_BANKROLL_PCT_PER_BET) / unitSize;
    const bankrollCapped = Math.min(tierCapped, maxBankrollUnits);

    let finalUnits = roundToQuarter(bankrollCapped);
    if (finalUnits < MIN_UNITS && finalUnits > 0) finalUnits = MIN_UNITS;

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
          capCheck,
        });
      }
    }

    // ── Preserve governor decision label ──
    // Governor says BET_2U/BET_1U/LEAN. Physics preserves that unless sizing collapses.
    let decision = baseDecision;
    if (finalUnits < 1 && decision === 'BET_2U') decision = 'BET_1U';
    if (finalUnits < 0.5 && decision === 'BET_1U') decision = 'LEAN';

    const reasons = [];
    reasons.push(`Governor: ${baseDecision} @ ${baseUnits}u`);
    reasons.push(`Kelly: ${round(kellyUnits, 2)}u → ${round(fractionalKellyUnits, 2)}u (${sport})`);
    if (tierCap < governorCapped) reasons.push(`Tier cap: ${tierCap}u`);
    if (maxBankrollUnits < tierCapped) reasons.push(`Bankroll cap: ${round(maxBankrollUnits, 2)}u`);
    if (capStatus === 'partial') reasons.push(`Cap partial: ${capCheck.reason}`);
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
      capCheck,
      kellyDetails: {
        kelly_units: kellyUnits,
        fractional_kelly_units: fractionalKellyUnits,
        sport_fraction: kf,
        tier_cap: tierCap,
        bankroll_cap: maxBankrollUnits,
      },
    });
  }

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
      if (remaining <= 0) return { allowed: false, reason: `Daily cap exhausted` };
      if (proposedDollars > remaining) {
        const partialUnits = Math.floor((remaining / unitSize) * 4) / 4;
        if (partialUnits < MIN_UNITS) return { allowed: false, reason: `Daily cap insufficient` };
        return { allowed: true, partialUnits, reason: `Partial — daily cap ${partialUnits}u` };
      }
    }
    if (weeklyCap > 0) {
      const remaining = weeklyCap - weeklyUsed;
      if (remaining <= 0) return { allowed: false, reason: `Weekly cap exhausted` };
      if (proposedDollars > remaining) {
        const partialUnits = Math.floor((remaining / unitSize) * 4) / 4;
        if (partialUnits < MIN_UNITS) return { allowed: false, reason: `Weekly cap insufficient` };
        return { allowed: true, partialUnits, reason: `Partial — weekly cap ${partialUnits}u` };
      }
    }
    return { allowed: true, reason: 'ok' };
  }

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

  function buildOutput({
    decision, units, direction, confidence, edge,
    reasons, governor, prior, capCheck, kellyDetails,
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
      expected_value: round(units * edge * unitSize, 2),
      reasons,
      governor_snapshot: {
        consensus_score: governor.consensus_score,
        confidence: governor.confidence,
        decision: governor.decision,
        agreement_index: governor.agreement_index,
        posterior_home_prob: governor.posterior_home_prob,
        market_source: governor.market_source,
        data_caps: governor.data_caps || [],
        breakdown: governor.breakdown || [],
      },
      kelly_details: kellyDetails || null,
      cap_check: capCheck || null,
      market_snapshot: {
        spread: prior?.market?.current_spread ?? null,
        total: prior?.market?.total ?? null,
        home_ml: prior?.market?.home_ml ?? null,
        away_ml: prior?.market?.away_ml ?? null,
      },
      bankroll_snapshot: {
        bankroll,
        unit_size: unitSize,
        daily_used: parseFloat(localStorage.getItem('edge_daily_used') || '0'),
        weekly_used: parseFloat(localStorage.getItem('edge_weekly_used') || '0'),
      },
      mode: 'deterministic',
      engine_version: '1.1',
      computed_at: new Date().toISOString(),
    };
  }

  function buildSideLabel(direction, prior) {
    if (direction === 'home') return { team: prior?.home_team || 'Home', side: 'home', action: 'BACK' };
    if (direction === 'away') return { team: prior?.away_team || 'Away', side: 'away', action: 'BACK' };
    return { team: null, side: 'none', action: 'NONE' };
  }

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

  function getConfidenceTierCap(confidence) {
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
    decide,
    applyClaudeAdjustment,
    checkCaps,
    DECISION,
    KELLY_FRACTION,
    MAX_UNITS,
  };

})();

if (typeof window !== 'undefined') window.EDGE_PHYSICS = EDGE_PHYSICS;