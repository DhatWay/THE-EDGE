// ============================================================
// EDGE — SPORT PROFILES
//
// Every sport runs the same steps (the model's margin → its chance at
// the line → value at the price → bet size), but each looks for its own
// information and uses the math that fits how it is scored:
//
//   NFL     points · normal outcomes with the key numbers 3 and 7 ·
//           quarterback ratings · short week / bye · injuries by lineup share
//   NCAAF   points · normal outcomes that widen in big mismatches
//           (garbage time) · SP+ · quarterback · short week / bye · injuries
//   NBA     points · normal outcomes scaled by the game's pace ·
//           back-to-backs · players out by their share of minutes/usage
//   WNBA    as NBA, with its own sizes
//   NCAAB   points · pace-scaled outcomes · back-to-backs · injuries
//   MLB     runs · negative-binomial runs per team (runs bunch together),
//           extra innings broken near 50/50 · starting pitchers ·
//           bullpen workload over the last three days · injuries
//   NHL     goals · Poisson goals per team, overtime/shootout near 50/50 ·
//           starting goalies · back-to-backs · injuries
//   MLS     goals · Poisson goals with the Dixon–Coles correction for the
//           low scores that decide soccer (draws stay draws) ·
//           fixture congestion · injuries
//
// Each factor is counted once, in the model's margin: home field comes
// from each team's own home/road results; rest, injuries, starters and
// bullpens are added here; the governor then compares that one margin to
// the market. Nothing is added again afterwards.
// ============================================================

const EDGE_SPORTS = (function () {
  const BUILD = 'sports-20261014-01';

  const PROFILES = {
    NFL:   { unit: 'pts',   dist: 'normal', sigma: 13.5, tiers: { lean: 0.020, bet1u: 0.050, bet2u: 0.090 }, strength: 0.6,
             rest: { short: 4, shortPts: -1.0, bye: 13, byePts: 1.0 }, injuryPerPct: 0.12 },
    NCAAF: { unit: 'pts',   dist: 'normal', sigma: 16.5, tiers: { lean: 0.018, bet1u: 0.045, bet2u: 0.080 }, strength: 0.6,
             rest: { short: 4, shortPts: -1.0, bye: 13, byePts: 1.0 }, injuryPerPct: 0.12, blowout: true },
    NBA:   { unit: 'pts',   dist: 'normal', sigma: 12.0, tiers: { lean: 0.020, bet1u: 0.050, bet2u: 0.090 }, strength: 0.6,
             rest: { b2b: 1, b2bPts: -1.6, rested: 3, restedPts: 0.4 }, injuryPerPct: 0.22, pace: true },
    WNBA:  { unit: 'pts',   dist: 'normal', sigma: 11.0, tiers: { lean: 0.018, bet1u: 0.045, bet2u: 0.080 }, strength: 0.6,
             rest: { b2b: 1, b2bPts: -1.2, rested: 3, restedPts: 0.3 }, injuryPerPct: 0.20, pace: true },
    NCAAB: { unit: 'pts',   dist: 'normal', sigma: 11.0, tiers: { lean: 0.018, bet1u: 0.045, bet2u: 0.080 }, strength: 0.6,
             rest: { b2b: 1, b2bPts: -1.0 }, injuryPerPct: 0.18, pace: true },
    MLB:   { unit: 'runs',  dist: 'negbin', disp: 4.0, avgTotal: 8.8, tieHome: 0.52, maxN: 30,
             tiers: { lean: 0.022, bet1u: 0.055, bet2u: 0.095 }, strength: 0.6, injuryPerPct: 0.008, bullpen: true },
    NHL:   { unit: 'goals', dist: 'poisson', avgTotal: 6.1, tieHome: 0.52, maxN: 15,
             tiers: { lean: 0.022, bet1u: 0.055, bet2u: 0.095 }, strength: 0.6,
             rest: { b2b: 1, b2bPts: -0.15 }, injuryPerPct: 0.010 },
    MLS:   { unit: 'goals', dist: 'dixoncoles', rho: -0.08, avgTotal: 2.9, maxN: 12,
             tiers: { lean: 0.025, bet1u: 0.060, bet2u: 0.100 }, strength: 0.6,
             rest: { b2b: 3, b2bPts: -0.12 }, injuryPerPct: 0.008 },
  };
  const profile = sport => PROFILES[sport] || null;
  const clamp = (v, lo, hi) => Math.max(lo, Math.min(hi, v));
  const round = (v, d = 3) => Math.round(v * 10 ** d) / 10 ** d;

  // ── DRIVERS: the sport's own factors, as margin for the home team ──
  function drivers(sport, ctx = {}) {
    const p = profile(sport);
    const parts = [];
    if (!p) return { delta: 0, parts };
    const rest = ctx.rest || {};
    const restPts = days => {
      if (!p.rest || !isFinite(days)) return 0;
      if (p.rest.short != null && days <= p.rest.short) return p.rest.shortPts;
      if (p.rest.bye != null && days >= p.rest.bye) return p.rest.byePts;
      if (p.rest.b2b != null && days <= p.rest.b2b) return p.rest.b2bPts;
      if (p.rest.rested != null && days >= p.rest.rested) return p.rest.restedPts;
      return 0;
    };
    // Rest — skipped when the fitted ranking already priced rest.
    if (!ctx.restInFit && isFinite(rest.home) && isFinite(rest.away)) {
      const rh = restPts(rest.home), ra = restPts(rest.away);
      if (rh || ra) parts.push({ name: 'rest', value: round(rh - ra, 2),
        why: `rest: home ${rest.home} days (${rh >= 0 ? '+' : ''}${rh}) vs away ${rest.away} days (${ra >= 0 ? '+' : ''}${ra})` });
    }
    // Injuries — share of each lineup missing (quarterbacks are priced by
    // the quarterback ratings and aren't in this share).
    const inj = ctx.injuries;
    if (inj && p.injuryPerPct) {
      const hm = (Number(inj.home_off_deduction) || 0) + (Number(inj.home_def_deduction) || 0);
      const am = (Number(inj.away_off_deduction) || 0) + (Number(inj.away_def_deduction) || 0);
      const v = (am - hm) * p.injuryPerPct;
      if (Math.abs(v) >= 0.01) parts.push({ name: 'injuries', value: round(v, 2),
        why: `lineup missing: home ${hm.toFixed(1)}% vs away ${am.toFixed(1)}%` });
    }
    // Bullpen (MLB) — relief innings in the last three days; every inning
    // over 9 costs about 0.04 runs the next game.
    if (p.bullpen && ctx.bullpen && isFinite(ctx.bullpen.home) && isFinite(ctx.bullpen.away)) {
      const ex = ip => Math.max(0, ip - 9);
      const v = (ex(ctx.bullpen.away) - ex(ctx.bullpen.home)) * 0.04;
      if (Math.abs(v) >= 0.01) parts.push({ name: 'bullpen', value: round(v, 2),
        why: `bullpen innings, last 3 days: home ${ctx.bullpen.home.toFixed(1)} vs away ${ctx.bullpen.away.toFixed(1)}` });
    }
    return { delta: round(parts.reduce((s, x) => s + x.value, 0), 3), parts };
  }

  // ── SPREAD OF OUTCOMES ──
  // Points sports: the base, widened in college mismatches (garbage time
  // adds noise) and scaled by the game's pace (more possessions, wider).
  function sigmaFor(sport, base, ctx = {}) {
    const p = profile(sport);
    let s = base || (p && p.sigma) || 13;
    const why = [];
    if (p && p.blowout && isFinite(ctx.margin)) {
      const f = clamp(1 + 0.012 * Math.max(0, Math.abs(ctx.margin) - 10), 1, 1.4);
      if (f > 1.001) { s *= f; why.push(`mismatch widens outcomes ×${f.toFixed(2)}`); }
    }
    if (p && p.pace && ctx.homeStats && ctx.awayStats && ctx.league) {
      const hp = Number(ctx.homeStats.possessions), ap = Number(ctx.awayStats.possessions), lp = Number(ctx.league.possessions);
      if (hp > 0 && ap > 0 && lp > 0) {
        const f = clamp(Math.sqrt(((hp + ap) / 2) / lp), 0.85, 1.2);
        if (Math.abs(f - 1) > 0.005) { s *= f; why.push(`pace ×${f.toFixed(2)}`); }
      }
    }
    return { sigma: s, why };
  }

  // ── COUNT SPORTS: exact margin distributions ──
  function poissonPmf(mu, n) {
    const out = new Array(n + 1).fill(0);
    let p = Math.exp(-mu); out[0] = p;
    for (let k = 1; k <= n; k++) { p = p * mu / k; out[k] = p; }
    return out;
  }
  function negbinPmf(mu, r, n) {          // mean mu, variance mu + mu²/r
    const out = new Array(n + 1).fill(0);
    const q = r / (r + mu);
    let p = Math.pow(q, r); out[0] = p;
    for (let k = 1; k <= n; k++) { p = p * ((k - 1 + r) / k) * (1 - q); out[k] = p; }
    return out;
  }
  // P(home margin = m) for m in [-n, n]
  function marginDist(sport, lh, la) {
    const p = profile(sport);
    const n = p.maxN || 15;
    const ph = p.dist === 'negbin' ? negbinPmf(lh, p.disp, n) : poissonPmf(lh, n);
    const pa = p.dist === 'negbin' ? negbinPmf(la, p.disp, n) : poissonPmf(la, n);
    const dist = new Map();
    let total = 0;
    for (let i = 0; i <= n; i++) for (let j = 0; j <= n; j++) {
      let v = ph[i] * pa[j];
      if (p.dist === 'dixoncoles' && i <= 1 && j <= 1) {
        const rho = p.rho;
        const tau = i === 0 && j === 0 ? 1 - lh * la * rho : i === 0 && j === 1 ? 1 + lh * rho : i === 1 && j === 0 ? 1 + la * rho : 1 - rho;
        v *= tau;
      }
      dist.set(i - j, (dist.get(i - j) || 0) + v);
      total += v;
    }
    dist.forEach((v, k) => dist.set(k, v / total));
    // Hockey and baseball can't end tied: overtime/extra innings decide it,
    // by one, close to a coin flip with a small home edge.
    if (p.tieHome != null) {
      const tie = dist.get(0) || 0;
      dist.set(0, 0);
      dist.set(1, (dist.get(1) || 0) + tie * p.tieHome);
      dist.set(-1, (dist.get(-1) || 0) + tie * (1 - p.tieHome));
    }
    return dist;
  }
  // Expected scores for each side from the model's margin and total.
  function rates(sport, margin, total) {
    const p = profile(sport);
    const T = isFinite(total) && total > 0 ? total : p.avgTotal;
    const lh = clamp((T + margin) / 2, 0.15, T), la = clamp((T - margin) / 2, 0.15, T);
    return { lh, la, T };
  }
  function countCover(sport, margin, line, total) {
    const { lh, la } = rates(sport, margin, total);
    const dist = marginDist(sport, lh, la);
    // Quarter lines (soccer): half the stake on each neighbouring line.
    if (Math.abs((line * 4) % 2) === 1) {
      const a = countCover(sport, margin, line - 0.25, total), b = countCover(sport, margin, line + 0.25, total);
      return { home_cover: (a.home_cover + b.home_cover) / 2, away_cover: (a.away_cover + b.away_cover) / 2, push: (a.push + b.push) / 2, lambda_home: lh, lambda_away: la };
    }
    let hc = 0, ac = 0, push = 0;
    dist.forEach((v, m) => { const x = m + line; if (Math.abs(x) < 1e-9) push += v; else if (x > 0) hc += v; else ac += v; });
    return { home_cover: hc, away_cover: ac, push, lambda_home: round(lh, 3), lambda_away: round(la, 3) };
  }

  // The chance each side covers a home line (line 0 = wins outright; in
  // soccer a draw is a push at 0, i.e. neither side wins).
  function cover(sport, margin, line, opts = {}) {
    const p = profile(sport);
    if (!p || !isFinite(margin) || !isFinite(line)) return null;
    if (p.dist !== 'normal') return countCover(sport, margin, line, opts.total);
    const core = (typeof window !== 'undefined' && window.EDGE_RATING) || null;
    const sg = sigmaFor(sport, opts.sigma, { margin, homeStats: opts.homeStats, awayStats: opts.awayStats, league: opts.league });
    if (core && core.coverProbability) {
      const c = core.coverProbability(margin, line, sg.sigma, { sport });
      return c ? { ...c, sigma: round(sg.sigma, 2), sigma_notes: sg.why } : null;
    }
    const z = (margin + line) / sg.sigma;
    const ph = 0.5 * (1 + erf(z / Math.SQRT2));
    return { home_cover: ph, away_cover: 1 - ph, push: 0, sigma: round(sg.sigma, 2), sigma_notes: sg.why };
  }
  function erf(x) { const t = 1 / (1 + 0.3275911 * Math.abs(x)); const y = 1 - (((((1.061405429 * t - 1.453152027) * t) + 1.421413741) * t - 0.284496736) * t + 0.254829592) * t * Math.exp(-x * x); return x >= 0 ? y : -y; }

  function tiers(sport) { return (profile(sport) || {}).tiers || null; }
  function strength(sport) { return (profile(sport) || {}).strength ?? null; }

  return { BUILD, PROFILES, profile, drivers, sigmaFor, cover, tiers, strength, _marginDist: marginDist };
})();

if (typeof window !== 'undefined') window.EDGE_SPORTS = EDGE_SPORTS;
