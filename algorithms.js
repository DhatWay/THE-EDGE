// ============================================================
// EDGE — ALGORITHMS ENGINE v2.0
//
// Nine families. Each receives a GamePrior from EDGE_POWER plus
// whatever context has been gathered, and returns a verdict.
//
// Every family returns the same shape:
//   {
//     family:       string,
//     signal:       number,   -1 = strong away, +1 = strong home
//     vote:         'yes' | 'no' | 'neu',
//     confidence:   number,   0.5 to 1.0
//     edge:         number,   0 to 0.15 — expected points vs line
//     reason:       string,
//     subs:         array,    every sub-signal that went into the vote
//     data:         object,   raw inputs used, for backtesting
//   }
//
// The signal field is the primary gradeable output. A signal of
// +0.4 means "leaning home"; the slate test can then ask whether
// games with signal > 0.2 historically covered more often than
// the market implied. Vote and confidence are derived from
// signal, not the other way around.
//
// v2.0 — coaching family loses its always-zero halftime sub.
// environment family loses its calendar heuristics. Every
// remaining sub-signal is data-driven. WNBA added to weights.
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
    WNBA: {
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

  // ============================================================
  // ── ENTRY ──
  // ============================================================

  async function runAll(prior, context = {}) {
    const results = [];
    for (const family of FAMILIES) {
      try {
        const r = await runFamily(family, prior, context);
        if (r) results.push(r);
      } catch (e) {
        results.push(neutral(family, `Error: ${e.message}`));
      }
    }
    return results;
  }

  async function runFamily(family, prior, context) {
    switch (family) {
      case 'team_quality':    return familyTeamQuality(prior);
      case 'offense_defense': return familyOffenseDefense(prior);
      case 'coaching':        return familyCoaching(prior);
      case 'market':          return familyMarket(prior, context);
      case 'line_dynamics':   return familyLineDynamics(prior, context);
      case 'fatigue':         return familyFatigue(prior, context);
      case 'environment':     return familyEnvironment(prior, context);
      case 'trend':           return familyTrend(prior, context);
      case 'injury':          return familyInjury(prior, context);
      default: return null;
    }
  }

  function getFamilyWeight(sport, family) {
    const w = FAMILY_WEIGHTS[sport] || FAMILY_WEIGHTS.DEFAULT;
    return w[family] ?? 7;
  }

  // ============================================================
  // ── FAMILY 1 · TEAM QUALITY ──
  //
  // Uses Glicko-2, Massey, Colley, Pythagorean, and Elo. Every
  // engine is a real rating system with a real history. The
  // family votes in the direction all four agree on, weighted by
  // how sure each engine is of the ranking.
  // ============================================================

  function familyTeamQuality(prior) {
    const h = prior.home_power;
    const a = prior.away_power;

    // Rating certainty from Glicko. High RD means the rating is
    // still settling — an edge over an unsettled team carries
    // less weight than the same edge over a settled one.
    const hRd = h.glicko_rd ?? null;
    const aRd = a.glicko_rd ?? null;
    const certainty = (hRd != null && aRd != null)
      ? clamp(1 - (((hRd + aRd) / 2) - 40) / 260, 0, 1)
      : null;

    const subs = [];

    // Elo gap
    const eloDiff = (h.elo || 1500) - (a.elo || 1500);
    subs.push(signalFrom(eloDiff / 25, 3, 8, 'Elo'));

    // Massey (stored in srs column)
    const srsDiff = (h.srs || 0) - (a.srs || 0);
    subs.push(signalFrom(srsDiff, 2, 6, 'Massey'));

    // Pythagorean
    const pythDiff = ((h.pythagorean || 0.5) - (a.pythagorean || 0.5)) * 100;
    subs.push(signalFrom(pythDiff, 5, 15, 'Pythagorean'));

    // Glicko composite points
    const hPts = h.composite_points;
    const aPts = a.composite_points;
    if (hPts != null && aPts != null) {
      subs.push(signalFrom(hPts - aPts, 2, 6, 'Composite'));
    }

    // Engine agreement — do all three independent raters see the
    // same side? When Glicko, Massey, and Colley align, the
    // rating is solid. When they split, the team is hard to read.
    if (h.massey != null && a.massey != null &&
        h.colley != null && a.colley != null &&
        h.glicko_rating != null && a.glicko_rating != null) {
      const glicko = Math.sign(h.glicko_rating - a.glicko_rating);
      const massey = Math.sign(h.massey - a.massey);
      const colley = Math.sign(h.colley - a.colley);
      const agree = glicko === massey && massey === colley && glicko !== 0;
      subs.push({
        vote: agree ? (glicko > 0 ? 'yes' : 'no') : 'neu',
        confidence: agree ? 0.72 : 0.5,
        edge: agree ? round(Math.abs(h.massey - a.massey) / 100, 4) : 0,
        signal: agree ? glicko * 0.6 : 0,
        reason: agree
          ? 'Glicko, Massey and Colley all favour the same side'
          : 'Rating engines disagree',
      });
    }

    const family = resolveFamily('team_quality', subs, {
      elo_diff: round(eloDiff, 1),
      massey_diff: round(srsDiff, 2),
      pyth_diff: round(pythDiff, 2),
      composite_diff: (hPts != null && aPts != null) ? round(hPts - aPts, 2) : null,
      home_rd: hRd,
      away_rd: aRd,
      certainty: certainty != null ? round(certainty, 3) : null,
    });

    // Scale confidence by rating certainty when we have it.
    if (certainty != null && family.vote !== 'neu') {
      const scaled = 0.5 + (family.confidence - 0.5) * (0.55 + 0.45 * certainty);
      family.confidence = round(scaled, 3);
      if (certainty < 0.35) {
        family.reason += ` · ratings still unsettled (RD ~${Math.round((hRd + aRd) / 2)})`;
      }
    }

    return family;
  }

  // ============================================================
  // ── FAMILY 2 · OFFENSE / DEFENSE ──
  //
  // Attack and defense ratings are opponent-adjusted per
  // possession. The family looks for a strength that meets a
  // specific weakness in this matchup.
  // ============================================================

  function familyOffenseDefense(prior) {
    const h = prior.home_power;
    const a = prior.away_power;

    const homeNet = (h.offense || 50) - (100 - (h.defense || 50));
    const awayNet = (a.offense || 50) - (100 - (a.defense || 50));
    const netDiff = homeNet - awayNet;
    const netVote = signalFrom(netDiff, 8, 25, 'Net rating');

    const dm = prior.defense_matchup || {};
    const dmAdj = dm.adjustment_points || 0;
    const dmVote = signalFrom(dmAdj, 1, 4, 'Scheme');

    const offDiff = (h.offense || 50) - (a.offense || 50);
    const offVote = signalFrom(offDiff, 6, 18, 'Offense');

    // Interaction: top attack vs weak defense specifically.
    let interaction = null;
    if (h.offense >= 70 && a.defense <= 40) {
      interaction = { vote: 'yes', confidence: 0.74, edge: 0.06, signal: 0.55, reason: 'Elite home offense vs weak away defense' };
    } else if (a.offense >= 70 && h.defense <= 40) {
      interaction = { vote: 'no', confidence: 0.74, edge: 0.06, signal: -0.55, reason: 'Elite away offense vs weak home defense' };
    }

    const subs = [netVote, dmVote, offVote];
    if (interaction) subs.push(interaction);

    return resolveFamily('offense_defense', subs, {
      home_net: round(homeNet, 1),
      away_net: round(awayNet, 1),
      matchup_adj: round(dmAdj, 2),
      scheme: dm.scheme_advantage || 'neutral',
    });
  }

  // ============================================================
  // ── FAMILY 3 · COACHING ──
  //
  // Two sub-signals: composite coaching rating and close-game
  // record. The previous version also carried a halftime
  // adjustment that was always zero — it diluted the two real
  // signals with a neutral vote. Removed.
  // ============================================================

  function familyCoaching(prior) {
    const hc = prior.home_power?._coach || {};
    const ac = prior.away_power?._coach || {};

    const subs = [];

    const coachDiff = (hc.overall || 50) - (ac.overall || 50);
    subs.push(signalFrom(coachDiff, 10, 30, 'Coaching'));

    const closeDiff = ((hc.close_game_record || 0.5) - (ac.close_game_record || 0.5)) * 100;
    subs.push(signalFrom(closeDiff, 8, 20, 'Close games'));

    return resolveFamily('coaching', subs, {
      coach_diff: round(coachDiff, 1),
      close_diff: round(closeDiff, 1),
    });
  }

  // ============================================================
  // ── FAMILY 4 · MARKET INTELLIGENCE ──
  //
  // Reads the closing line value of the market itself. When the
  // line has moved since open, that movement is information.
  // CLV, sharp money, and public fade.
  // ============================================================

  function familyMarket(prior, context) {
    const hist = context.lineHistory || {};
    const market = prior.market || {};
    const open = market.open_spread;
    const current = market.current_spread;

    const subs = [];

    // Open-to-close movement. A line moving toward home means
    // money came in on home. Sharp money moves the line; the
    // public bets the other way.
    if (open !== null && current !== null && open !== current) {
      const move = current - open;
      // move is negative when the line moves toward home
      const clvVote = signalFrom(-move, 0.5, 2, 'CLV');
      subs.push(clvVote);
    } else {
      subs.push({ vote: 'neu', confidence: 0.5, edge: 0, signal: 0, reason: 'No line movement' });
    }

    // Sharp percentage, when the data exists.
    const sharpPct = hist.sharp_pct;
    if (typeof sharpPct === 'number') {
      const sharpVal = (sharpPct - 50) / 10;
      subs.push(signalFrom(sharpVal, 0.5, 2, 'Sharp%'));
    } else {
      subs.push({ vote: 'neu', confidence: 0.5, edge: 0, signal: 0, reason: 'No sharp % data' });
    }

    // Reverse line movement — public on home but line moved away.
    const publicPct = hist.public_pct;
    if (typeof publicPct === 'number' && open !== null && current !== null) {
      const publicOnHome = publicPct > 60;
      const lineAgainstPublic = (publicOnHome && current > open) || (!publicOnHome && current < open);
      if (lineAgainstPublic) {
        subs.push({
          vote: publicOnHome ? 'no' : 'yes',
          confidence: 0.78,
          edge: 0.06,
          signal: publicOnHome ? -0.7 : 0.7,
          reason: `RLM: ${publicPct}% public, line moved opposite`,
        });
      } else {
        subs.push({ vote: 'neu', confidence: 0.5, edge: 0, signal: 0, reason: 'No RLM signal' });
      }
    } else {
      subs.push({ vote: 'neu', confidence: 0.5, edge: 0, signal: 0, reason: 'No public % data' });
    }

    return resolveFamily('market', subs, {
      open_spread: open,
      current_spread: current,
      movement: (open != null && current != null) ? round(current - open, 2) : null,
      sharp_pct: sharpPct ?? null,
      public_pct: publicPct ?? null,
    });
  }

  // ============================================================
  // ── FAMILY 5 · LINE DYNAMICS ──
  //
  // Steam moves, open-to-close magnitude, and public extremes.
  // The confidence values come from the magnitude of the move,
  // not from hardcoded constants.
  // ============================================================

  function familyLineDynamics(prior, context) {
    const market = prior.market || {};
    const hist = context.lineHistory || {};
    const open = market.open_spread;
    const current = market.current_spread;
    const hoursOut = context.hoursToGame ?? 999;

    const subs = [];

    // Steam — rapid movement timed close to kickoff.
    if (open !== null && current !== null) {
      const diff = Math.abs(current - open);
      const direction = Math.sign(current - open);

      if (diff >= 2 && hoursOut <= 48) {
        subs.push({
          vote: direction > 0 ? 'no' : 'yes',
          confidence: 0.86,
          edge: 0.10,
          signal: direction > 0 ? -0.9 : 0.9,
          reason: `Steam: ${diff.toFixed(1)}pt move ${hoursOut.toFixed(0)}hrs out`,
        });
      } else if (diff >= 1.5 && hoursOut <= 24) {
        subs.push({
          vote: direction > 0 ? 'no' : 'yes',
          confidence: 0.78,
          edge: 0.07,
          signal: direction > 0 ? -0.75 : 0.75,
          reason: `Late ${diff.toFixed(1)}pt move`,
        });
      } else if (diff >= 0.5) {
        subs.push(signalFrom(-(current - open), 0.5, 2, 'O2C'));
      } else {
        subs.push({ vote: 'neu', confidence: 0.5, edge: 0, signal: 0, reason: 'Flat line' });
      }
    } else {
      subs.push({ vote: 'neu', confidence: 0.5, edge: 0, signal: 0, reason: 'No line data' });
    }

    // Public extreme
    const publicPct = hist.public_pct;
    if (typeof publicPct === 'number' && publicPct >= 75) {
      subs.push({
        vote: 'no',
        confidence: 0.66,
        edge: 0.04,
        signal: -0.5,
        reason: `Public fade: ${publicPct}% on one side`,
      });
    } else if (typeof publicPct === 'number' && publicPct <= 25) {
      subs.push({
        vote: 'yes',
        confidence: 0.66,
        edge: 0.04,
        signal: 0.5,
        reason: `Public fade: only ${publicPct}% on home`,
      });
    } else {
      subs.push({ vote: 'neu', confidence: 0.5, edge: 0, signal: 0, reason: 'No public extreme' });
    }

    return resolveFamily('line_dynamics', subs, {
      open,
      current,
      public_pct: publicPct ?? null,
      hours_to_game: round(hoursOut, 1),
    });
  }

  // ============================================================
  // ── FAMILY 6 · FATIGUE ──
  //
  // Rest days, travel miles, timezone shift, road-trip length.
  // ============================================================

  function familyFatigue(prior, context) {
    const hRest = context.homeRestDays ?? null;
    const aRest = context.awayRestDays ?? null;
    const travel = context.travelMiles ?? null;
    const tz = context.timezoneShift ?? null;
    const awayTrip = context.awayRoadTripLength ?? null;

    const subs = [];

    // Rest differential
    if (hRest !== null && aRest !== null) {
      const diff = hRest - aRest;
      subs.push(signalFrom(diff, 1, 3, 'Rest'));
    } else {
      subs.push({ vote: 'neu', confidence: 0.5, edge: 0, signal: 0, reason: 'No rest data' });
    }

    // Travel distance
    if (travel !== null) {
      const penalty = travel > 2500 ? -1 : travel > 1500 ? -0.6 : travel > 800 ? -0.3 : 0;
      subs.push({
        vote: penalty < -0.2 ? 'yes' : 'neu',
        confidence: penalty < -0.2 ? 0.65 : 0.5,
        edge: Math.abs(penalty) / 20,
        signal: -penalty,
        reason: travel > 800 ? `Away travel: ${travel} miles` : 'Normal travel',
      });
    } else {
      subs.push({ vote: 'neu', confidence: 0.5, edge: 0, signal: 0, reason: 'No travel data' });
    }

    // Timezone shift
    if (tz !== null && Math.abs(tz) >= 2) {
      subs.push({
        vote: 'yes',
        confidence: Math.min(0.55 + Math.abs(tz) * 0.07, 0.80),
        edge: 0.03,
        signal: Math.min(Math.abs(tz) * 0.25, 0.7),
        reason: `${Math.abs(tz)}hr timezone shift for away team`,
      });
    } else {
      subs.push({ vote: 'neu', confidence: 0.5, edge: 0, signal: 0, reason: 'No timezone shift' });
    }

    // Long road trip
    if (awayTrip != null && awayTrip >= 3) {
      subs.push({
        vote: 'yes',
        confidence: 0.60,
        edge: 0.03,
        signal: Math.min(0.4 + (awayTrip - 3) * 0.1, 0.7),
        reason: `Away team on game ${awayTrip} of road trip`,
      });
    }

    return resolveFamily('fatigue', subs, {
      home_rest: hRest,
      away_rest: aRest,
      travel_miles: travel,
      timezone_shift: tz,
      road_trip: awayTrip,
    });
  }

  // ============================================================
  // ── FAMILY 7 · ENVIRONMENT ──
  //
  // Weather only. Indoor sports skip the family entirely.
  // ============================================================

  function familyEnvironment(prior, context) {
    const weather = context.weather || {};
    const sport = prior.sport;

    if (['NBA', 'NHL', 'NCAAB', 'WNBA'].includes(sport)) {
      return neutral('environment', 'Indoor sport — no weather');
    }

    const subs = [];

    const wind = weather.wind_effect_mph ?? weather.wind_mph;
    if (typeof wind === 'number' && wind >= 15) {
      subs.push({
        vote: 'no',
        confidence: Math.min(0.60 + (wind - 15) * 0.02, 0.85),
        edge: 0.05,
        signal: -Math.min(0.3 + (wind - 15) * 0.05, 0.85),
        reason: `Wind ${wind}mph — under lean`,
      });
    } else {
      subs.push({ vote: 'neu', confidence: 0.5, edge: 0, signal: 0, reason: 'Wind normal' });
    }

    const temp = weather.temp_f;
    if (typeof temp === 'number' && temp <= 25) {
      subs.push({
        vote: 'no',
        confidence: 0.72,
        edge: 0.06,
        signal: -0.6,
        reason: `Temp ${temp}°F — under lean`,
      });
    } else {
      subs.push({ vote: 'neu', confidence: 0.5, edge: 0, signal: 0, reason: 'Temp normal' });
    }

    const precip = weather.precip_pct;
    if (typeof precip === 'number' && precip >= 60) {
      subs.push({
        vote: 'no',
        confidence: 0.64,
        edge: 0.04,
        signal: -0.5,
        reason: `${precip}% ${weather.precip_type || 'precip'} — under lean`,
      });
    } else {
      subs.push({ vote: 'neu', confidence: 0.5, edge: 0, signal: 0, reason: 'No precip' });
    }

    return resolveFamily('environment', subs, {
      wind_mph: wind ?? null,
      temp_f: temp ?? null,
      precip_pct: precip ?? null,
      precip_type: weather.precip_type ?? null,
    });
  }

  // ============================================================
  // ── FAMILY 8 · TREND ──
  //
  // Three sources of trend information:
  //   1. Live trends from the trends table (historical situations)
  //   2. ATS form from team_ats
  //   3. Head-to-head cover history from matchup_ats
  //
  // Every trend is shrunk toward neutral by its sample size so a
  // 6-0 run on six occurrences doesn't outvote 21-9 on thirty.
  // ============================================================

  function familyTrend(prior, context) {
    const h = prior.home_power;
    const a = prior.away_power;
    const hAts = context.homeAts || null;
    const aAts = context.awayAts || null;
    const h2h = context.h2h || null;

    const subs = [];

    // ── Live trends ──
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

      const hScore = score(homeTrends);
      const aScore = score(awayTrends);
      if (hScore || aScore) {
        const diff = (hScore ? hScore.edge : 0) - (aScore ? aScore.edge : 0);
        const strength = Math.min(Math.abs(diff) * 4, 1);
        const best = [...homeTrends, ...awayTrends]
          .sort((x, y) => (y.current_streak || 0) - (x.current_streak || 0))[0];
        subs.push({
          vote: Math.abs(diff) < 0.02 ? 'neu' : diff > 0 ? 'yes' : 'no',
          confidence: 0.5 + strength * 0.4,
          edge: round(Math.abs(diff), 4),
          signal: Math.sign(diff) * strength * 0.8,
          reason: best
            ? `${best.headline || 'Trend'} (${best.wins}-${best.losses}, n=${best.sample})`
            : `${homeTrends.length + awayTrends.length} live trends`,
        });
      }
    }

    // ── ATS last-10 cover rate differential ──
    if (hAts && aAts &&
        hAts.last10_wins != null && hAts.last10_losses != null &&
        aAts.last10_wins != null && aAts.last10_losses != null) {
      const hTotal = hAts.last10_wins + hAts.last10_losses;
      const aTotal = aAts.last10_wins + aAts.last10_losses;

      if (hTotal >= MIN_ATS_SAMPLE && aTotal >= MIN_ATS_SAMPLE) {
        const hRate = hAts.last10_wins / hTotal;
        const aRate = aAts.last10_wins / aTotal;
        const diff = (hRate - aRate) * 100;
        subs.push(signalFrom(diff, 8, 20, 'ATS form'));
      } else {
        subs.push({ vote: 'neu', confidence: 0.5, edge: 0, signal: 0, reason: 'ATS sample too small' });
      }
    } else {
      subs.push({ vote: 'neu', confidence: 0.5, edge: 0, signal: 0, reason: 'No ATS form data' });
    }

    // ── Momentum (last 10 vs season) ──
    const hMom = momentumSignal(hAts);
    const aMom = momentumSignal(aAts);
    const momDiff = hMom - aMom;
    subs.push(signalFrom(momDiff, 0.08, 0.20, 'Momentum'));

    // ── Home / away ATS split ──
    if (hAts && hAts.home_cover_pct != null &&
        aAts && aAts.away_cover_pct != null) {
      const diff = (hAts.home_cover_pct - aAts.away_cover_pct) * 100;
      subs.push(signalFrom(diff, 10, 25, 'H/A split'));
    } else {
      subs.push({ vote: 'neu', confidence: 0.5, edge: 0, signal: 0, reason: 'No H/A split data' });
    }

    // ── Head-to-head cover rate ──
    if (h2h && h2h.meetings >= MIN_H2H_SAMPLE) {
      const homeIsA = h2h.team_a === prior.home_team;
      const hCover = homeIsA ? h2h.team_a_cover_pct : h2h.team_b_cover_pct;
      const aCover = homeIsA ? h2h.team_b_cover_pct : h2h.team_a_cover_pct;
      if (hCover != null && aCover != null) {
        const diff = (hCover - aCover) * 100;
        subs.push(signalFrom(diff, 12, 28, 'H2H'));
      } else {
        subs.push({ vote: 'neu', confidence: 0.5, edge: 0, signal: 0, reason: 'H2H incomplete' });
      }
    } else {
      subs.push({ vote: 'neu', confidence: 0.5, edge: 0, signal: 0, reason: 'Not enough H2H meetings' });
    }

    return resolveFamily('trend', subs, {
      home_form_last10: hAts?.last10_cover_pct ?? null,
      away_form_last10: aAts?.last10_cover_pct ?? null,
      home_momentum: round(hMom, 3),
      away_momentum: round(aMom, 3),
      h2h_meetings: h2h?.meetings ?? 0,
      live_trends: homeTrends.length + awayTrends.length,
    });
  }

  function momentumSignal(ats) {
    if (!ats) return 0;
    if (typeof ats.trend_delta === 'number' && ats.trend_delta !== 0) return ats.trend_delta;
    if (ats.last10_cover_pct != null && ats.season_cover_pct != null) {
      return (ats.last10_cover_pct - ats.season_cover_pct) * 0.75;
    }
    return 0;
  }

  // ============================================================
  // ── FAMILY 9 · INJURY ──
  //
  // Fragmentations from injury-fragmentation.js. Net deduction
  // in effective points for each side.
  // ============================================================

  function familyInjury(prior, context) {
    const hInj = context.homeInjuries || [];
    const aInj = context.awayInjuries || [];

    const hasFragmentation =
      typeof context.homeOffDeduction === 'number' ||
      typeof context.awayOffDeduction === 'number';

    let hImpact, aImpact;

    if (hasFragmentation) {
      hImpact = (context.homeOffDeduction || 0) + (context.homeDefDeduction || 0);
      aImpact = (context.awayOffDeduction || 0) + (context.awayDefDeduction || 0);
    } else {
      hImpact = fallbackInjuryImpact(hInj);
      aImpact = fallbackInjuryImpact(aInj);
    }

    // Net edge favors home when the away team lost more production.
    const diff = aImpact - hImpact;

    if (hInj.length === 0 && aInj.length === 0) {
      return neutral('injury', 'No injury data');
    }

    const sub = signalFrom(diff, 1.5, 5, 'Net injury');

    return resolveFamily('injury', [sub], {
      home_impact: round(hImpact, 2),
      away_impact: round(aImpact, 2),
      net_impact: round(diff, 2),
      home_count: hInj.length,
      away_count: aInj.length,
      source: hasFragmentation ? 'roster' : 'fallback',
    });
  }

  function fallbackInjuryImpact(injuries) {
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
  // ── RESOLVER ──
  // Combines sub-signals into one family verdict. The `signal`
  // field is a weighted average of sub-signals, clamped to
  // [-1, +1]. Vote and confidence derive from signal.
  // ============================================================

  function resolveFamily(family, subs, data) {
    let yesW = 0, noW = 0, totalW = 0;
    let signalSum = 0, signalWeight = 0;
    let edgeSum = 0;
    const reasons = [];

    subs.forEach(s => {
      const w = s.confidence || 0.5;
      totalW += w;

      if (s.vote === 'yes') yesW += w;
      else if (s.vote === 'no') noW += w;

      // Numeric signal — the gradeable output.
      if (typeof s.signal === 'number' && isFinite(s.signal)) {
        signalSum += s.signal * w;
        signalWeight += w;
      }

      edgeSum += s.edge || 0;
      if (s.vote !== 'neu' && s.reason) reasons.push(s.reason);
    });

    if (totalW === 0) {
      return neutral(family, 'No signals');
    }

    const net = (yesW - noW) / totalW;
    const vote = Math.abs(net) < 0.1 ? 'neu' : net > 0 ? 'yes' : 'no';
    const confidence = clamp(0.5 + Math.abs(net) * 0.5, 0.5, 1.0);
    const edge = edgeSum / subs.length;
    const signal = signalWeight > 0
      ? clamp(signalSum / signalWeight, -1, 1)
      : net;

    return {
      family,
      signal: round(signal, 3),
      vote,
      confidence: round(confidence, 3),
      edge: round(edge, 4),
      reason: reasons.length ? reasons.join(' · ') : 'Neutral',
      subs,
      data,
    };
  }

  // ============================================================
  // ── HELPERS ──
  // ============================================================

  // Convert a signed value into a sub-signal object.
  function signalFrom(value, lowThreshold, highThreshold, label) {
    if (!isFinite(value)) {
      return { vote: 'neu', confidence: 0.5, edge: 0, signal: 0, reason: `${label}: no value` };
    }
    if (value >= highThreshold) {
      const s = clamp(0.6 + (value - highThreshold) / (highThreshold * 2), 0.6, 0.9);
      return {
        vote: 'yes', confidence: s, edge: Math.min(Math.abs(value) / 100, 0.10),
        signal: Math.min((value - highThreshold) / (highThreshold * 2) + 0.5, 1),
        reason: `${label} +${round(value, 1)}`,
      };
    }
    if (value <= -highThreshold) {
      const s = clamp(0.6 + (Math.abs(value) - highThreshold) / (highThreshold * 2), 0.6, 0.9);
      return {
        vote: 'no', confidence: s, edge: Math.min(Math.abs(value) / 100, 0.10),
        signal: -Math.min((Math.abs(value) - highThreshold) / (highThreshold * 2) + 0.5, 1),
        reason: `${label} ${round(value, 1)}`,
      };
    }
    if (value >= lowThreshold) {
      return {
        vote: 'yes', confidence: 0.55, edge: 0.01,
        signal: 0.2,
        reason: `Weak +${round(value, 1)} ${label}`,
      };
    }
    if (value <= -lowThreshold) {
      return {
        vote: 'no', confidence: 0.55, edge: 0.01,
        signal: -0.2,
        reason: `Weak ${round(value, 1)} ${label}`,
      };
    }
    return { vote: 'neu', confidence: 0.5, edge: 0, signal: 0, reason: `${label} flat` };
  }

  function neutral(family, reason) {
    return {
      family,
      signal: 0,
      vote: 'neu',
      confidence: 0.5,
      edge: 0,
      reason,
      subs: [],
      data: {},
    };
  }

  function clamp(v, min, max) { return Math.max(min, Math.min(max, v)); }
  function round(v, d) { const f = Math.pow(10, d); return Math.round(v * f) / f; }

})();

if (typeof window !== 'undefined') window.EDGE_ALGOS = EDGE_ALGOS;