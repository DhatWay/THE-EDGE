// ============================================================
// EDGE — PHYSICS v1.0
// Deterministic final decision layer
// Runs in BOTH modes. Claude can only veto or reduce.
// Fractional Kelly · Cap enforcement · Shadow logging
// ============================================================

const EDGE_PHYSICS = (() => {

  // ── KELLY FRACTIONS BY SPORT ──
  // Higher variance sports get lower fractions (safer).
  // NFL/NBA are more efficient markets → lower edge → lower fraction.
  const KELLY_FRACTION = {
    NFL:   0.20,
    NBA:   0.22,
    MLB:   0.18,
    NHL:   0.18,
    NCAAF: 0.15,
    NCAAB: 0.18,
    MLS:   0.15,
    DEFAULT: 0.20,
  };

  // ── MAX UNITS PER BET BY CONFIDENCE TIER ──
  const MAX_UNITS = {
    elite: 3.0,   // ≥ 85% confidence
    high:  2.5,   // ≥ 75%
    solid: 2.0,   // ≥ 65%
    lean:  1.0,   // ≥ 55%
    small: 0.5,   // < 55%
  };

  // ── GLOBAL SAFETY FLOOR ──
  const MIN_UNITS = 0.25;
  const MAX_BANKROLL_PCT_PER_BET = 0.05; // never risk more than 5% of bankroll

  // ── DECISION STATES ──
  const DECISION = {
    BET: 'BET',
    LEAN: 'LEAN',
    PASS: 'PASS',
    VETOED: 'VETOED',
    CAPPED: 'CAPPED',
  };

  // ============================================================
  // ── MAIN ENTRY ──
  // ============================================================

  function decide(governorOutput, prior, context = {}) {
    const sport = prior?.sport || 'DEFAULT';
    const thresholds = governorOutput.thresholds_used || {};

    // ── STEP 1: Base decision from governor ──
    const baseDecision = governorOutput.decision || 'PASS';
    const baseUnits = governorOutput.units || 0;
    const confidence = governorOutput.confidence || 0;
    const edge = governorOutput.edge || 0;
    const direction = governorOutput.direction || 'none';

    if (baseDecision === 'PASS' || direction === 'none') {
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

    // ── STEP 2: Kelly sizing ──
    const bankroll = getBankroll();
    const unitSize = getUnitSize(bankroll);
    const kellyInput = governorOutput.kelly || {};
// Fall back to governor units when Kelly is unavailable OR returns 0
// (Kelly returns 0 when market ML is missing, common in NCAAF/NCAAB)
const kellyUnits = (kellyInput.available && kellyInput.kelly_units > 0)
  ? kellyInput.kelly_units
  : baseUnits;

    // ── STEP 3: Confidence tier cap ──
    const tierCap = getConfidenceTierCap(confidence);

    // ── STEP 4: Sport-specific Kelly fraction ──
    const kf = KELLY_FRACTION[sport] || KELLY_FRACTION.DEFAULT;
    const fractionalKellyUnits = kellyUnits * (kf / 0.25); // normalize to sport-specific

    // ── STEP 5: Governor cap (never exceed what governor said) ──
    const governorCapped = Math.min(fractionalKellyUnits, baseUnits);

    // ── STEP 6: Tier cap ──
    const tierCapped = Math.min(governorCapped, tierCap);

    // ── STEP 7: Bankroll cap ──
    const maxBankrollUnits = (bankroll * MAX_BANKROLL_PCT_PER_BET) / unitSize;
    const bankrollCapped = Math.min(tierCapped, maxBankrollUnits);

    // ── STEP 8: Round to nearest 0.25 ──
    let finalUnits = roundToQuarter(bankrollCapped);

    // ── STEP 9: Enforce minimum ──
    if (finalUnits < MIN_UNITS && finalUnits > 0) finalUnits = MIN_UNITS;

    // ── STEP 10: Cap enforcement ──
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

    // ── STEP 11: Final decision tier ──
    let decision = DECISION.BET;
    if (finalUnits < 1) decision = DECISION.LEAN;

    // ── STEP 12: Build reasons chain ──
    const reasons = [];
    reasons.push(`Governor: ${baseDecision} @ ${baseUnits}u`);
    reasons.push(`Kelly: ${round(kellyUnits, 2)}u (raw) → ${round(fractionalKellyUnits, 2)}u (${sport} fraction)`);
    if (tierCap < governorCapped) reasons.push(`Tier cap: ${tierCap}u (${getTierLabel(confidence)})`);
    if (maxBankrollUnits < tierCapped) reasons.push(`Bankroll cap: ${round(maxBankrollUnits, 2)}u`);
    if (capStatus === 'partial') reasons.push(`Cap partial: ${capCheck.reason}`);
    reasons.push(`Final: ${finalUnits}u`);

    // ── STEP 13: Build deterministic output ──
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

  // ============================================================
  // ── CAPS ──
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

    // Max bets per day
    if (maxBets > 0 && betsUsed >= maxBets) {
      return { allowed: false, reason: `Max bets/day reached (${betsUsed}/${maxBets})` };
    }

    // Max units per bet
    if (maxUnitBet > 0 && proposedUnits > maxUnitBet) {
      return {
        allowed: true,
        partialUnits: maxUnitBet,
        reason: `Capped to max ${maxUnitBet}u per bet`,
      };
    }

    // Daily cap
    if (dailyCap > 0) {
      const remaining = dailyCap - dailyUsed;
      if (remaining <= 0) {
        return { allowed: false, reason: `Daily cap exhausted ($${dailyUsed}/$${dailyCap})` };
      }
      if (proposedDollars > remaining) {
        const partialUnits = Math.floor((remaining / unitSize) * 4) / 4;
        if (partialUnits < MIN_UNITS) {
          return { allowed: false, reason: `Daily cap insufficient ($${remaining.toFixed(0)} remaining)` };
        }
        return {
          allowed: true,
          partialUnits,
          reason: `Partial — daily cap allows ${partialUnits}u`,
        };
      }
    }

    // Weekly cap
    if (weeklyCap > 0) {
      const remaining = weeklyCap - weeklyUsed;
      if (remaining <= 0) {
        return { allowed: false, reason: `Weekly cap exhausted ($${weeklyUsed}/$${weeklyCap})` };
      }
      if (proposedDollars > remaining) {
        const partialUnits = Math.floor((remaining / unitSize) * 4) / 4;
        if (partialUnits < MIN_UNITS) {
          return { allowed: false, reason: `Weekly cap insufficient ($${remaining.toFixed(0)} remaining)` };
        }
        return {
          allowed: true,
          partialUnits,
          reason: `Partial — weekly cap allows ${partialUnits}u`,
        };
      }
    }

    return { allowed: true, reason: 'ok' };
  }

  // ============================================================
  // ── CLAUDE ADJUSTMENT ──
  // Applied only in AI-assisted mode.
  // Claude cannot increase units or flip direction.
  // ============================================================

  function applyClaudeAdjustment(physicsOutput, claudeOutput) {
    if (!claudeOutput || typeof claudeOutput !== 'object') return physicsOutput;

    const adjustment = clamp(claudeOutput.confidence_adjustment || 0, -0.15, 0);
    const decision = claudeOutput.decision || 'approve';

    const result = { ...physicsOutput };
    result.claude = {
      decision,
      adjustment,
      reason: claudeOutput.reason || '',
    };

    // Veto → zero out
    if (decision === 'veto') {
      result.decision = DECISION.VETOED;
      result.units = 0;
      result.claude_vetoed = true;
      result.reasons = [...result.reasons, `Claude vetoed: ${claudeOutput.reason || ''}`];
      return result;
    }

    // Approve with adjustment → reduce units proportionally
    if (adjustment < 0) {
      const factor = 1 + adjustment; // e.g. -0.10 → 0.90
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
  // ── BUILD OUTPUT ──
  // ============================================================

  function buildOutput({
    decision, units, direction, confidence, edge,
    reasons, governor, prior, capCheck, kellyDetails,
  }) {
    const bankroll = getBankroll();
    const unitSize = getUnitSize(bankroll);
    const stakeDollars = round(units * unitSize, 2);

    return {
      // Final pick
      decision,
      units,
      stake_dollars: stakeDollars,
      direction,
      side_label: buildSideLabel(direction, prior),

      // Metrics
      confidence,
      edge,
      expected_value: round(units * edge * unitSize, 2),

      // Provenance
      reasons,
      governor_snapshot: {
        consensus_score: governor.consensus_score,
        confidence: governor.confidence,
        decision: governor.decision,
        agreement_index: governor.agreement_index,
        posterior_home_prob: governor.posterior_home_prob,
      },
      kelly_details: kellyDetails || null,
      cap_check: capCheck || null,

      // Market snapshot at time of pick
      market_snapshot: {
        spread: prior?.market?.current_spread ?? null,
        total: prior?.market?.total ?? null,
        home_ml: prior?.market?.home_ml ?? null,
        away_ml: prior?.market?.away_ml ?? null,
      },

      // Bankroll snapshot
      bankroll_snapshot: {
        bankroll,
        unit_size: unitSize,
        daily_used: parseFloat(localStorage.getItem('edge_daily_used') || '0'),
        weekly_used: parseFloat(localStorage.getItem('edge_weekly_used') || '0'),
      },

      // Meta
      mode: 'deterministic',
      engine_version: '1.0',
      computed_at: new Date().toISOString(),
    };
  }

  function buildSideLabel(direction, prior) {
    if (direction === 'home') {
      return {
        team: prior?.home_team || 'Home',
        side: 'home',
        action: 'BACK',
      };
    }
    if (direction === 'away') {
      return {
        team: prior?.away_team || 'Away',
        side: 'away',
        action: 'BACK',
      };
    }
    return { team: null, side: 'none', action: 'NONE' };
  }

  // ============================================================
  // ── HELPERS ──
  // ============================================================

  function getBankroll() {
    const b = parseFloat(localStorage.getItem('edge_bankroll') || '0');
    return b > 0 ? b : 1000; // fallback for simulation
  }

  function getUnitSize(bankroll) {
    const unitType = localStorage.getItem('edge_unit_type') || 'flat';
    if (unitType === 'pct') {
      const pct = parseFloat(localStorage.getItem('edge_unit_size') || '1');
      return (bankroll * pct) / 100;
    }
    const flat = parseFloat(localStorage.getItem('edge_unit_size') || '0');
    return flat > 0 ? flat : 50; // fallback
  }

  function getConfidenceTierCap(confidence) {
    if (confidence >= 85) return MAX_UNITS.elite;
    if (confidence >= 75) return MAX_UNITS.high;
    if (confidence >= 65) return MAX_UNITS.solid;
    if (confidence >= 55) return MAX_UNITS.lean;
    return MAX_UNITS.small;
  }

  function getTierLabel(confidence) {
    if (confidence >= 85) return 'elite';
    if (confidence >= 75) return 'high';
    if (confidence >= 65) return 'solid';
    if (confidence >= 55) return 'lean';
    return 'small';
  }

  function roundToQuarter(v) {
    return Math.round(v * 4) / 4;
  }

  function clamp(v, min, max) { return Math.max(min, Math.min(max, v)); }
  function round(v, d) { const f = Math.pow(10, d); return Math.round(v * f) / f; }

  // ============================================================
  // ── PUBLIC API ──

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