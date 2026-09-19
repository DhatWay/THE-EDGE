// ============================================================
// EDGE — ALGORITHMS ENGINE v1.3
// 9 signal families · Each consumes a GamePrior from EDGE_POWER
// Returns: { family, vote, confidence, edge, reason, subs }
// Deterministic. No Claude. Pure math.
//
// v1.3 — coaching: drop the always-zero halftime sub-signal, it
// was voting neutral on every game and diluting the family's two
// real signals. environment: drop the calendar-based cold-month
// early returns, which exited before resolveFamily() and threw
// away the actual wind/temp/precip subs.
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

  const MIN_ATS_SAMPLE = 6;
  const MIN_H2H_SAMPLE = 3;

  return {
    runAll,
    runFamily,
    FAMILIES,
    FAMILY_WEIGHTS,
    getFamilyWeight,
  };

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

    const homeRd = home.glicko_rd ?? null;
    const awayRd = away.glicko_rd ?? null;
    const certainty = (homeRd != null && awayRd != null)
      ? clamp(1 - (((homeRd + awayRd) / 2) - 40) / 260, 0, 1)
      : null;

    const eloDiff = (home.elo || 1500) - (away.elo || 1500);
    const eloSpread = eloDiff / 25;
    const eloVote = signalVote(eloSpread, 3, 8);

    const srsDiff = (home.srs || 0) - (away.srs || 0);
    const srsVote = signalVote(srsDiff, 2, 6);

    const pythDiff = ((home.pythagorean || 0.5) - (away.pythagorean || 0.5)) * 100;
    const pythVote = signalVote(pythDiff, 5, 15);

    const subs = [eloVote, srsVote, pythVote];

    if (home.massey != null && away.massey != null &&
        home.colley != null && away.colley != null) {
      const glickoSide = Math.sign((home.glicko_rating ?? home.elo ?? 1500) - (away.glicko_rating ?? away.elo ?? 1500));
      const masseySide = Math.sign(home.massey - away.massey);
      const colleySide = Math.sign(home.colley - away.colley);
      const agree = (glickoSide === masseySide) && (masseySide === colleySide) && glickoSide !== 0;
      subs.push({
        vote: agree ? (glickoSide > 0 ? 'yes' : 'no') : 'neu',
        confidence: agree ? 0.72 : 0.5,
        edge: agree ? round(Math.abs(home.massey - away.massey) / 100, 4) : 0,
        reason: agree
          ? 'Glicko, Massey and Colley all favour the same side'
          : 'Rating engines disagree on this pairing',
      });
    }

    const family = resolveFamily('team_quality', subs, {
      elo_diff: round(eloDiff, 1),
      srs_diff: round(srsDiff, 2),
      pyth_diff: round(pythDiff, 2),
      home_rd: homeRd,
      away_rd: awayRd,
      certainty: certainty != null ? round(certainty, 3) : null,
    });

    if (certainty != null && family.vote !== 'neu') {
      const scaled = 0.5 + (family.confidence - 0.5) * (0.55 + 0.45 * certainty);
      family.confidence = round(scaled, 3);
      if (certainty < 0.35) {
        family.reason = `${family.reason} · ratings still unsettled (RD ${Math.round((homeRd + awayRd) / 2)})`;
      }
    }

    return family;
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

    const closeDiff = ((homeC.close_game_record || 0.5) - (awayC.close_game_record || 0.5)) * 100;
    const closeVote = signalVote(closeDiff, 8, 20);

    return resolveFamily('coaching', [coachVote, closeVote], {
      coach_diff: round(coachDiff, 1),
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
    const homeAts = context.homeAts || null;
    const awayAts = context.awayAts || null;
    const h2h = context.h2h || null;

    const subs = [];

    const homeTrends = context.homeTrends || [];
    const awayTrends = context.awayTrends || [];
    if (homeTrends.length || awayTrends.length) {
      const score = (list) => {
        let total = 0, weight = 0;
        list.filter(t => t.market === 'SU' || t.market === 'ATS').forEach(t => {
          const n = t.sample || 0;
          if (n < 3) return;
          const shrunk = ((t.hit_rate || 0.5) * n + 0.5 * 8) / (n + 8);
          const w = Math.min(n / 20, 1) * (t.market === 'ATS' ? 1 : 0.7);
          total += (shrunk - 0.5) * w;
          weight += w;
        });
        return weight > 0 ? { edge: total / weight, weight } : null;
      };

      const h = score(homeTrends);
      const a2 = score(awayTrends);
      if (h || a2) {
        const diff = (h ? h.edge : 0) - (a2 ? a2.edge : 0);
        const strength = Math.min(Math.abs(diff) * 4, 1);
        const best = [...homeTrends, ...awayTrends]
          .sort((x, y) => (y.current_streak || 0) - (x.current_streak || 0))[0];
        subs.push({
          name: 'live_trends',
          vote: Math.abs(diff) < 0.02 ? 'neu' : diff > 0 ? 'yes' : 'no',
          confidence: 0.5 + strength * 0.4,
          edge: round(diff, 4),
          reason: best
            ? `${best.headline} (${best.wins}-${best.losses}, n=${best.sample})`
            : `${homeTrends.length + awayTrends.length} live trends`,
        });
      }
    }

    if (homeAts && awayAts &&
        homeAts.last10_wins != null && homeAts.last10_losses != null &&
        awayAts.last10_wins != null && awayAts.last10_losses != null) {
      const homeTotal = homeAts.last10_wins + homeAts.last10_losses;
      const awayTotal = awayAts.last10_wins + awayAts.last10_losses;

      if (homeTotal >= MIN_ATS_SAMPLE && awayTotal >= MIN_ATS_SAMPLE) {
        const homeRate = homeAts.last10_wins / homeTotal;
        const awayRate = awayAts.last10_wins / awayTotal;
        const rateDiff = (homeRate - awayRate) * 100;
        subs.push(signalVote(rateDiff, 8, 20));
      } else {
        subs.push(neutral('Last-10 sample too small'));
      }
    } else {
      subs.push(neutral('No ATS form data'));
    }

    const homeMomentum = momentumSignal(homeAts);
    const awayMomentum = momentumSignal(awayAts);
    const momDiff = homeMomentum - awayMomentum;
    subs.push(signalVote(momDiff, 0.08, 0.20));

    if (homeAts && homeAts.home_cover_pct != null &&
        awayAts && awayAts.away_cover_pct != null) {
      const homeHome = homeAts.home_cover_pct;
      const awayRoad = awayAts.away_cover_pct;
      const splitDiff = (homeHome - awayRoad) * 100;
      subs.push(signalVote(splitDiff, 10, 25));
    } else {
      subs.push(neutral('No H/A split data'));
    }

    if (h2h && h2h.meetings >= MIN_H2H_SAMPLE) {
      const homeIsA = h2h.team_a === prior.home_team;
      const teamACover = h2h.team_a_cover_pct;
      const teamBCover = h2h.team_b_cover_pct;

      if (teamACover != null && teamBCover != null) {
        const homeCover = homeIsA ? teamACover : teamBCover;
        const awayCover = homeIsA ? teamBCover : teamACover;
        const h2hDiff = (homeCover - awayCover) * 100;
        subs.push(signalVote(h2hDiff, 12, 28));
      } else {
        subs.push(neutral('H2H cover data incomplete'));
      }
    } else {
      subs.push(neutral('Not enough H2H meetings'));
    }

    const homeReg = regressionSignal(home);
    const awayReg = regressionSignal(away);
    const regDiff = awayReg - homeReg;
    subs.push(signalVote(regDiff, 5, 15));

    return resolveFamily('trend', subs, {
      home_form_last10: homeAts?.last10_cover_pct ?? null,
      away_form_last10: awayAts?.last10_cover_pct ?? null,
      home_momentum: round(homeMomentum, 3),
      away_momentum: round(awayMomentum, 3),
      h2h_meetings: h2h?.meetings ?? 0,
      home_regression: round(homeReg, 3),
      away_regression: round(awayReg, 3),
    });
  }

  function momentumSignal(ats) {
    if (!ats) return 0;
    if (typeof ats.trend_delta === 'number' && ats.trend_delta !== 0) {
      return ats.trend_delta;
    }
    if (ats.last10_cover_pct != null && ats.season_cover_pct != null) {
      return (ats.last10_cover_pct - ats.season_cover_pct) * 0.75;
    }
    return 0;
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

    const diff = awayImpact - homeImpact;

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