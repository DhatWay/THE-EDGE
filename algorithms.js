// ============================================================
// EDGE — ALGORITHMS ENGINE v1.1
// 9 signal families · Each consumes a GamePrior from EDGE_POWER
// Returns: { family, vote, confidence, edge, reason, subs }
// Deterministic. No Claude. Pure math.
//
// v1.1 — familyInjury now reads exact per-player deductions
// from the roster-based fragmentation engine when available.
// ============================================================

const EDGE_ALGOS = (() => {

  const FAMILIES = [
    'team_quality',
    'offense_defense',
    'coaching',
    'market',
    'line_dynamics',
    'fatigue',
    'environment',
    'trend',
    'injury',
  ];

  const FAMILY_WEIGHTS = {
    NFL: {
      team_quality: 10, offense_defense: 8, coaching: 8,
      market: 10, line_dynamics: 9, fatigue: 8,
      environment: 7, trend: 6, injury: 10,
    },
    NBA: {
      team_quality: 9, offense_defense: 10, coaching: 7,
      market: 9, line_dynamics: 8, fatigue: 10,
      environment: 2, trend: 8, injury: 10,
    },
    MLB: {
      team_quality: 8, offense_defense: 8, coaching: 6,
      market: 9, line_dynamics: 8, fatigue: 7,
      environment: 10, trend: 7, injury: 8,
    },
    NHL: {
      team_quality: 8, offense_defense: 8, coaching: 7,
      market: 9, line_dynamics: 8, fatigue: 8,
      environment: 2, trend: 7, injury: 9,
    },
    NCAAF: {
      team_quality: 9, offense_defense: 8, coaching: 9,
      market: 9, line_dynamics: 8, fatigue: 7,
      environment: 8, trend: 7, injury: 9,
    },
    NCAAB: {
      team_quality: 9, offense_defense: 9, coaching: 8,
      market: 8, line_dynamics: 8, fatigue: 8,
      environment: 3, trend: 7, injury: 8,
    },
    MLS: {
      team_quality: 8, offense_defense: 8, coaching: 7,
      market: 8, line_dynamics: 7, fatigue: 8,
      environment: 10, trend: 8, injury: 8,
    },
    DEFAULT: {
      team_quality: 8, offense_defense: 8, coaching: 7,
      market: 9, line_dynamics: 8, fatigue: 8,
      environment: 6, trend: 7, injury: 8,
    },
  };

  return {
    runAll,
    runFamily,
    FAMILIES,
    FAMILY_WEIGHTS,
    getFamilyWeight,
  };

  // ============================================================
  // ── MAIN ENTRY ──
  // ============================================================

  async function runAll(prior, context = {}) {
    const results = [];
    for (const family of FAMILIES) {
      try {
        const r = await runFamily(family, prior, context);
        if (r) results.push(r);
      } catch (e) {
        results.push({
          family,
          vote: 'neu',
          confidence: 0.5,
          edge: 0,
          reason: `Error: ${e.message}`,
          subs: [],
        });
      }
    }
    return results;
  }

  async function runFamily(family, prior, context) {
    switch (family) {
      case 'team_quality':   return familyTeamQuality(prior);
      case 'offense_defense':return familyOffenseDefense(prior);
      case 'coaching':       return familyCoaching(prior);
      case 'market':         return familyMarket(prior, context);
      case 'line_dynamics':  return familyLineDynamics(prior, context);
      case 'fatigue':        return familyFatigue(prior, context);
      case 'environment':    return familyEnvironment(prior, context);
      case 'trend':          return familyTrend(prior, context);
      case 'injury':         return familyInjury(prior, context);
      default: return null;
    }
  }

  function getFamilyWeight(sport, family) {
    const w = FAMILY_WEIGHTS[sport] || FAMILY_WEIGHTS.DEFAULT;
    return w[family] ?? 7;
  }

  // ============================================================
  // ── FAMILY 1: TEAM QUALITY ──
  // ============================================================

  function familyTeamQuality(prior) {
    const home = prior.home_power;
    const away = prior.away_power;

    const eloDiff = (home.elo || 1500) - (away.elo || 1500);
    const eloSpread = eloDiff / 25;
    const eloVote = signalVote(eloSpread, 3, 8);

    const srsDiff = (home.srs || 0) - (away.srs || 0);
    const srsVote = signalVote(srsDiff, 2, 6);

    const pythDiff = ((home.pythagorean || 0.5) - (away.pythagorean || 0.5)) * 100;
    const pythVote = signalVote(pythDiff, 5, 15);

    return resolveFamily('team_quality', [eloVote, srsVote, pythVote], {
      elo_diff: round(eloDiff, 1),
      srs_diff: round(srsDiff, 2),
      pyth_diff: round(pythDiff, 2),
    });
  }

  // ============================================================
  // ── FAMILY 2: OFFENSE / DEFENSE ──
  // ============================================================

  function familyOffenseDefense(prior) {
    const home = prior.home_power;
    const away = prior.away_power;

    const homeNet = (home.offense || 50) - (100 - (home.defense || 50));
    const awayNet = (away.offense || 50) - (100 - (away.defense || 50));
    const netDiff = homeNet - awayNet;
    const netVote = signalVote(netDiff, 8, 25);

    const dm = prior.defense_matchup || {};
    const dmAdj = dm.adjustment_points || 0;
    const dmVote = signalVote(dmAdj, 1, 4);

    const offDiff = (home.offense || 50) - (away.offense || 50);
    const offVote = signalVote(offDiff, 6, 18);

    return resolveFamily('offense_defense', [netVote, dmVote, offVote], {
      home_net: round(homeNet, 1),
      away_net: round(awayNet, 1),
      matchup_adj: dmAdj,
      scheme: dm.scheme_advantage || 'neutral',
    });
  }

  // ============================================================
  // ── FAMILY 3: COACHING ──
  // ============================================================

  function familyCoaching(prior) {
    const homeC = prior.home_power?._coach || {};
    const awayC = prior.away_power?._coach || {};

    const coachDiff = (homeC.overall || 50) - (awayC.overall || 50);
    const coachVote = signalVote(coachDiff, 10, 30);

    const htDiff = (homeC.halftime_adjustment || 0) - (awayC.halftime_adjustment || 0);
    const htVote = signalVote(htDiff, 1, 3);

    const closeDiff = ((homeC.close_game_record || 0.5) - (awayC.close_game_record || 0.5)) * 100;
    const closeVote = signalVote(closeDiff, 8, 20);

    return resolveFamily('coaching', [coachVote, htVote, closeVote], {
      coach_diff: round(coachDiff, 1),
      halftime_diff: round(htDiff, 2),
      close_diff: round(closeDiff, 1),
    });
  }

  // ============================================================
  // ── FAMILY 4: MARKET INTELLIGENCE ──
  // ============================================================

  function familyMarket(prior, context) {
    const hist = context.lineHistory || {};
    const market = prior.market || {};
    const open = market.open_spread;
    const current = market.current_spread;

    const subs = [];

    if (open !== null && current !== null && open !== current) {
      const move = current - open;
      const clvVote = signalVote(-move, 1, 3);
      subs.push(clvVote);
    } else {
      subs.push(neutral('No line movement data'));
    }

    const sharpPct = hist.sharp_pct;
    if (typeof sharpPct === 'number') {
      const sharpVal = (sharpPct - 50) / 10;
      subs.push(signalVote(sharpVal, 0.5, 2));
    } else {
      subs.push(neutral('No sharp money data'));
    }

    const publicPct = hist.public_pct;
    if (typeof publicPct === 'number' && open !== null && current !== null) {
      const publicOnHome = publicPct > 60;
      const lineAgainstPublic = (publicOnHome && current > open) || (!publicOnHome && current < open);
      if (lineAgainstPublic) {
        subs.push({
          vote: publicOnHome ? 'no' : 'yes',
          confidence: 0.78,
          edge: 0.06,
          reason: `RLM: ${publicPct}% public, line moved opposite`,
        });
      } else {
        subs.push(neutral('No RLM signal'));
      }
    } else {
      subs.push(neutral('No RLM data'));
    }

    return resolveFamily('market', subs, {
      open_spread: open,
      current_spread: current,
      sharp_pct: sharpPct ?? null,
      public_pct: publicPct ?? null,
    });
  }

  // ============================================================
  // ── FAMILY 5: LINE DYNAMICS ──
  // ============================================================

  function familyLineDynamics(prior, context) {
    const market = prior.market || {};
    const hist = context.lineHistory || {};
    const open = market.open_spread;
    const current = market.current_spread;

    const subs = [];

    if (open !== null && current !== null) {
      const diff = Math.abs(current - open);
      const hoursOut = context.hoursToGame ?? 999;
      if (diff >= 2 && hoursOut <= 48) {
        subs.push({
          vote: 'yes',
          confidence: 0.86,
          edge: 0.10,
          reason: `Steam: ${diff.toFixed(1)}pt move ${hoursOut.toFixed(0)}hrs out`,
        });
      } else if (diff >= 1.5 && hoursOut <= 24) {
        subs.push({
          vote: 'yes',
          confidence: 0.78,
          edge: 0.07,
          reason: `Steam: ${diff.toFixed(1)}pt late move`,
        });
      } else {
        subs.push(neutral('No steam'));
      }
    } else {
      subs.push(neutral('No line data'));
    }

    if (open !== null && current !== null) {
      const move = current - open;
      const o2cVote = signalVote(-move, 1.5, 4);
      subs.push(o2cVote);
    } else {
      subs.push(neutral('No O2C data'));
    }

    const publicPct = hist.public_pct;
    if (typeof publicPct === 'number' && publicPct >= 75) {
      subs.push({
        vote: 'no',
        confidence: 0.66,
        edge: 0.04,
        reason: `Public fade: ${publicPct}% on one side`,
      });
    } else {
      subs.push(neutral('No public extreme'));
    }

    return resolveFamily('line_dynamics', subs, {
      open,
      current,
      public_pct: publicPct ?? null,
    });
  }

  // ============================================================
  // ── FAMILY 6: FATIGUE ──
  // ============================================================

  function familyFatigue(prior, context) {
    const homeRest = context.homeRestDays ?? null;
    const awayRest = context.awayRestDays ?? null;
    const travelMiles = context.travelMiles ?? null;
    const timezones = context.timezoneShift ?? null;

    const subs = [];

    if (homeRest !== null && awayRest !== null) {
      const restDiff = homeRest - awayRest;
      const restVote = signalVote(restDiff, 1, 3);
      subs.push(restVote);
    } else {
      subs.push(neutral('No rest data'));
    }

    if (travelMiles !== null) {
      const travelPenalty = travelMiles > 2000 ? -2
                         : travelMiles > 1000 ? -1
                         : 0;
      subs.push(signalVote(-travelPenalty, 1, 3));
    } else {
      subs.push(neutral('No travel data'));
    }

    if (timezones !== null && Math.abs(timezones) >= 2) {
      subs.push({
        vote: 'yes',
        confidence: 0.68,
        edge: 0.04,
        reason: `Timezone: ${Math.abs(timezones)}hr shift for away team`,
      });
    } else {
      subs.push(neutral('No timezone shift'));
    }

    return resolveFamily('fatigue', subs, {
      home_rest: homeRest,
      away_rest: awayRest,
      travel_miles: travelMiles,
      timezone_shift: timezones,
    });
  }

  // ============================================================
  // ── FAMILY 7: ENVIRONMENT ──
  // ============================================================

  function familyEnvironment(prior, context) {
    const weather = context.weather || {};
    const sport = prior.sport;
    const indoor = ['NBA', 'NHL', 'NCAAB'].includes(sport);

    if (indoor) {
      return {
        family: 'environment',
        vote: 'neu',
        confidence: 0.5,
        edge: 0,
        reason: 'Indoor sport — no weather',
        subs: [],
        data: {},
      };
    }

    const subs = [];

    const wind = weather.wind_effect_mph ?? weather.wind_mph;
    if (typeof wind === 'number' && wind >= 15) {
      subs.push({
        vote: 'no',
        confidence: Math.min(0.60 + (wind - 15) * 0.02, 0.85),
        edge: 0.05,
        reason: `Wind ${wind}mph — under lean`,
      });
    } else {
      subs.push(neutral('Wind normal'));
    }

    const temp = weather.temp_f;
    if (typeof temp === 'number' && temp <= 25) {
      subs.push({
        vote: 'no',
        confidence: 0.72,
        edge: 0.06,
        reason: `Temp ${temp}°F — under lean`,
      });
    } else {
      subs.push(neutral('Temp normal'));
    }

    const precip = weather.precip_pct;
    if (typeof precip === 'number' && precip >= 60) {
      const kind = weather.precip_type === 'snow' ? 'snow' : weather.precip_type === 'rain' ? 'rain' : 'precip';
      subs.push({
        vote: 'no',
        confidence: 0.64,
        edge: 0.04,
        reason: `${precip}% ${kind} — under lean`,
      });
    } else {
      subs.push(neutral('No precip'));
    }

    return resolveFamily('environment', subs, {
      wind_effect_mph: wind ?? null,
      temp_f: temp ?? null,
      precip_pct: precip ?? null,
      precip_type: weather.precip_type ?? null,
    });
  }

  // ============================================================
  // ── FAMILY 8: TREND ──
  // ============================================================

  function familyTrend(prior, context) {
    const home = prior.home_power;
    const away = prior.away_power;

    const subs = [];

    const formDiff = (home.last5_form || 0) - (away.last5_form || 0);
    const formVote = signalVote(formDiff, 4, 12);
    subs.push(formVote);

    const homeReg = regressionSignal(home);
    const awayReg = regressionSignal(away);
    const regDiff = awayReg - homeReg;
    const regVote = signalVote(regDiff, 5, 15);
    subs.push(regVote);

    const homeSplit = parseSplit(home.home_record) - parseSplit(home.away_record);
    const awaySplit = parseSplit(away.home_record) - parseSplit(away.away_record);
    const splitSignal = (awaySplit < -0.15) ? 1 : (awaySplit > 0.15) ? -0.5 : 0;
    subs.push(signalVote(splitSignal, 0.3, 1));

    return resolveFamily('trend', subs, {
      form_diff: round(formDiff, 2),
      home_regression: round(homeReg, 3),
      away_regression: round(awayReg, 3),
    });
  }

  function regressionSignal(team) {
    if (!team) return 0;
    const actual = parseSplit(team.record);
    const expected = team.pythagorean || 0.5;
    return actual - expected;
  }

  function parseSplit(record) {
    if (!record || typeof record !== 'string') return 0.5;
    const [w, l] = record.split('-').map(n => parseInt(n || 0));
    const total = w + l;
    return total > 0 ? w / total : 0.5;
  }

  // ============================================================
  // ── FAMILY 9: INJURY ──
  // Uses exact per-player deductions from the roster table via
  // EDGE_INJURY. Falls back to flat estimates when fragmentation
  // data isn't available for this game.
  // ============================================================

  function familyInjury(prior, context) {
    const homeInj = context.homeInjuries || [];
    const awayInj = context.awayInjuries || [];

    const hasFragmentation =
      typeof context.homeOffDeduction === 'number' ||
      typeof context.homeDefDeduction === 'number' ||
      typeof context.awayOffDeduction === 'number' ||
      typeof context.awayDefDeduction === 'number';

    let homeImpact;
    let awayImpact;

    if (hasFragmentation) {
      homeImpact = (context.homeOffDeduction || 0) + (context.homeDefDeduction || 0);
      awayImpact = (context.awayOffDeduction || 0) + (context.awayDefDeduction || 0);
    } else {
      homeImpact = sumInjuryImpactFallback(homeInj);
      awayImpact = sumInjuryImpactFallback(awayInj);
    }

    const diff = awayImpact - homeImpact; // positive favors home

    if (homeInj.length === 0 && awayInj.length === 0) {
      return {
        family: 'injury',
        vote: 'neu',
        confidence: 0.5,
        edge: 0,
        reason: 'No injury data',
        subs: [],
        data: { home_impact: 0, away_impact: 0, source: 'none' },
      };
    }

    const sub = signalVote(diff, 1.5, 5);

    return resolveFamily('injury', [sub], {
      home_impact: round(homeImpact, 2),
      away_impact: round(awayImpact, 2),
      net_impact: round(diff, 2),
      home_count: homeInj.length,
      away_count: awayInj.length,
      source: hasFragmentation ? 'roster' : 'fallback',
    });
  }

  // Fallback path for games where EDGE_INJURY didn't produce
  // fragmentation. Uses coarse positional values.
  function sumInjuryImpactFallback(injuries) {
    const VORP = {
      QB: 7, RB: 1.5, WR: 2, TE: 1,
      LT: 3, C: 1.5, EDGE: 2.5, CB: 2.5,
      STAR: 5, STARTER: 3, ROLE: 1,
    };
    return injuries.reduce((sum, inj) => {
      const base = VORP[inj.position] || 1;
      if (inj.status === 'out' || inj.status === 'doubtful') return sum + base;
      if (inj.status === 'questionable') return sum + base * 0.5;
      return sum;
    }, 0);
  }

  // ============================================================
  // ── FAMILY RESOLVER ──
  // ============================================================

  function resolveFamily(family, subs, data) {
    let yesScore = 0, noScore = 0, totalWeight = 0;
    let edgeSum = 0, reasons = [];

    subs.forEach(s => {
      const w = s.confidence || 0.5;
      totalWeight += w;
      if (s.vote === 'yes') yesScore += w;
      else if (s.vote === 'no') noScore += w;
      edgeSum += s.edge || 0;
      if (s.vote !== 'neu' && s.reason) reasons.push(s.reason);
    });

    if (totalWeight === 0) {
      return { family, vote: 'neu', confidence: 0.5, edge: 0, reason: 'No signals', subs, data };
    }

    const net = (yesScore - noScore) / totalWeight;
    const vote = Math.abs(net) < 0.1 ? 'neu' : net > 0 ? 'yes' : 'no';
    const confidence = clamp(0.5 + Math.abs(net) * 0.5, 0.5, 1.0);
    const edge = edgeSum / subs.length;

    return {
      family,
      vote,
      confidence: round(confidence, 3),
      edge: round(edge, 4),
      reason: reasons.length ? reasons.join(' · ') : 'Neutral',
      subs,
      data,
    };
  }

  function signalVote(signal, lowThreshold, highThreshold) {
    if (!isFinite(signal) || signal === null || signal === undefined) {
      return neutral('No signal');
    }
    if (signal >= highThreshold) {
      return {
        vote: 'yes',
        confidence: clamp(0.60 + (signal - highThreshold) / (highThreshold * 2), 0.6, 0.9),
        edge: Math.min(Math.abs(signal) / 100, 0.10),
        reason: `Signal +${round(signal, 1)}`,
      };
    }
    if (signal <= -highThreshold) {
      return {
        vote: 'no',
        confidence: clamp(0.60 + (Math.abs(signal) - highThreshold) / (highThreshold * 2), 0.6, 0.9),
        edge: Math.min(Math.abs(signal) / 100, 0.10),
        reason: `Signal ${round(signal, 1)}`,
      };
    }
    if (signal >= lowThreshold) {
      return { vote: 'yes', confidence: 0.55, edge: 0.01, reason: `Weak +${round(signal, 1)}` };
    }
    if (signal <= -lowThreshold) {
      return { vote: 'no', confidence: 0.55, edge: 0.01, reason: `Weak ${round(signal, 1)}` };
    }
    return neutral(`Flat ${round(signal, 2)}`);
  }

  function neutral(reason) {
    return { vote: 'neu', confidence: 0.5, edge: 0, reason };
  }

  function clamp(v, min, max) { return Math.max(min, Math.min(max, v)); }
  function round(v, d) { const f = Math.pow(10, d); return Math.round(v * f) / f; }

})();

if (typeof window !== 'undefined') window.EDGE_ALGOS = EDGE_ALGOS;