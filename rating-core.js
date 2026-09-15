// ============================================================
// EDGE — RATING CORE v1.0
//
// Four engines, each doing one job the others cannot:
//
//   GLICKO-2   Dynamic team strength as a distribution, not a
//              number. Carries a rating deviation (how sure we
//              are) and a volatility (how erratic the team is).
//              Carries over between seasons with RD inflated for
//              off-season uncertainty, so week 1 means something.
//
//   MASSEY     Solves every game in the season at once as a
//              linear system on margin. Schedule strength falls
//              out of the algebra instead of being approximated.
//
//   COLLEY     The same idea on wins and losses only, with
//              Laplace smoothing so an undefeated team cannot
//              run to infinity.
//
//   ATT/DEF    Attack and defence per possession, solved
//              iteratively against opponent quality. This is what
//              turns ratings into a projected score.
//
// Nothing here ever reads a betting line. The market is compared
// against the output at the very end, in the pipeline — a model
// fitted to spreads learns to imitate the market, and a model
// that imitates the market cannot beat it.
// ============================================================

const EDGE_RATING = (() => {

  const BUILD = 'rc-20260915-2325';

  // ── GLICKO-2 CONSTANTS ──
  const SCALE = 173.7178;          // Glicko-1 → Glicko-2 conversion
  const BASE_RATING = 1500;
  const BASE_RD = 350;
  const BASE_VOL = 0.06;
  const CONVERGENCE = 0.000001;
  const MAX_ITER = 100;

  // τ constrains how much volatility can move in one period. Lower
  // is steadier. Sports with long seasons and stable rosters get a
  // tighter value than football, where one injury changes a team.
  const TAU = { NFL: 0.5, NCAAF: 0.6, NBA: 0.3, NCAAB: 0.5, NHL: 0.3, MLB: 0.25, MLS: 0.4 };

  // Not every game should move a rating equally. This is the
  // Glicko equivalent of a K-factor schedule.
  const IMPORTANCE = {
    preseason: 0.25, regular: 1.0, divisional: 1.15,
    playoff: 1.5, championship: 1.75,
  };

  // Season carry-over. A rating regresses toward the league mean
  // because rosters turn over, and its RD inflates because we know
  // less about the team than we did in January.
  const CARRYOVER = {
    NFL:   { regress: 0.33, rdFloor: 180 },
    NCAAF: { regress: 0.40, rdFloor: 200 },   // heaviest roster churn
    NBA:   { regress: 0.25, rdFloor: 140 },
    NCAAB: { regress: 0.40, rdFloor: 200 },
    NHL:   { regress: 0.28, rdFloor: 150 },
    MLB:   { regress: 0.30, rdFloor: 150 },
    MLS:   { regress: 0.30, rdFloor: 160 },
  };

  // Margin scaling. A win is not a win — the score used in the
  // Glicko update is a logistic on margin, so a three-point
  // escape and a thirty-point rout are not the same evidence.
  const MARGIN_SCALE = { NFL: 10, NCAAF: 14, NBA: 11, NCAAB: 10, NHL: 2, MLB: 3, MLS: 1.4 };

  // Typical possessions per team per game, for the attack/defence
  // model. Points alone conflate quality with pace.
  const POSSESSIONS = { NFL: 12, NCAAF: 13, NBA: 100, NCAAB: 68, NHL: 60, MLB: 38, MLS: 100 };

  // Home advantage in points, applied at projection time.
  const HOME_POINTS = { NFL: 2.0, NCAAF: 2.8, NBA: 2.6, NCAAB: 3.3, NHL: 0.25, MLB: 0.20, MLS: 0.38 };

  return {
    BUILD,
    rateGlicko,
    massey,
    colley,
    attackDefense,
    carryOver,
    projectScore,
    blend,
    glickoWinProbability,
    BASE_RATING, BASE_RD, BASE_VOL,
    CARRYOVER, IMPORTANCE, POSSESSIONS, HOME_POINTS,
  };

  // ============================================================
  // ── GLICKO-2 ──
  // ============================================================

  // games: [{ home, away, homeScore, awayScore, date, importance?, neutral? }]
  // seed:  { team: { rating, rd, vol } } from last season, optional.
  // Games are grouped into rating periods; within a period every
  // result is evaluated against the ratings as they stood at the
  // start, which is what makes Glicko-2 order-independent.
  function rateGlicko(sport, games, options = {}) {
    const { seed = null, periodDays = periodFor(sport) } = options;
    const tau = TAU[sport] ?? 0.5;
    const marginScale = MARGIN_SCALE[sport] ?? 10;

    const state = {};
    const ensure = (team) => {
      if (!state[team]) {
        const s = seed && seed[team];
        state[team] = {
          rating: s ? s.rating : BASE_RATING,
          rd: s ? s.rd : BASE_RD,
          vol: s ? s.vol : BASE_VOL,
          games: 0, lastPlayed: null,
        };
      }
      return state[team];
    };

    const sorted = [...games].sort((a, b) => new Date(a.date) - new Date(b.date));
    if (!sorted.length) return {};

    // Split into rating periods.
    const periods = [];
    let current = [];
    let periodStart = new Date(sorted[0].date);
    sorted.forEach(g => {
      const d = new Date(g.date);
      if ((d - periodStart) / 86400000 > periodDays) {
        if (current.length) periods.push(current);
        current = [];
        periodStart = d;
      }
      current.push(g);
    });
    if (current.length) periods.push(current);

    periods.forEach(period => {
      // Snapshot: everyone updates from the same starting point.
      const snapshot = {};
      period.forEach(g => {
        ensure(g.home); ensure(g.away);
        if (!snapshot[g.home]) snapshot[g.home] = { ...state[g.home] };
        if (!snapshot[g.away]) snapshot[g.away] = { ...state[g.away] };
      });

      // Collect each team's results for this period.
      const results = {};
      const add = (team, oppState, score, weight) => {
        if (!results[team]) results[team] = [];
        results[team].push({ opp: oppState, score, weight });
      };

      period.forEach(g => {
        const w = IMPORTANCE[g.importance || 'regular'] ?? 1;
        const margin = g.homeScore - g.awayScore;
        const homeScore = marginToScore(margin, marginScale);
        add(g.home, snapshot[g.away], homeScore, w);
        add(g.away, snapshot[g.home], 1 - homeScore, w);
      });

      // Apply.
      Object.entries(results).forEach(([team, list]) => {
        const updated = glickoUpdate(snapshot[team], list, tau);
        state[team].rating = updated.rating;
        state[team].rd = updated.rd;
        state[team].vol = updated.vol;
        state[team].games += list.length;
        state[team].lastPlayed = period[period.length - 1].date;
      });

      // A team that did not play this period grows less certain.
      Object.keys(state).forEach(team => {
        if (results[team]) return;
        const s = state[team];
        const phi = s.rd / SCALE;
        s.rd = Math.min(BASE_RD, SCALE * Math.sqrt(phi * phi + s.vol * s.vol));
      });
    });

    // Conservative estimate — what you would rank on, since it
    // penalises a high rating the system is unsure about.
    Object.values(state).forEach(s => {
      s.rating = round(s.rating, 1);
      s.rd = round(s.rd, 1);
      s.vol = round(s.vol, 6);
      s.conservative = round(s.rating - 2 * s.rd, 1);
    });

    return state;
  }

  // One team's update for one rating period. Glickman's algorithm.
  function glickoUpdate(prior, results, tau) {
    const mu = (prior.rating - BASE_RATING) / SCALE;
    const phi = prior.rd / SCALE;
    const sigma = prior.vol;

    if (!results.length) {
      const phiStar = Math.sqrt(phi * phi + sigma * sigma);
      return { rating: prior.rating, rd: Math.min(BASE_RD, phiStar * SCALE), vol: sigma };
    }

    let vInv = 0;
    let deltaSum = 0;

    results.forEach(({ opp, score, weight }) => {
      const muJ = (opp.rating - BASE_RATING) / SCALE;
      const phiJ = opp.rd / SCALE;
      const g = gFactor(phiJ);
      const e = expected(mu, muJ, phiJ);
      vInv += weight * g * g * e * (1 - e);
      deltaSum += weight * g * (score - e);
    });

    if (vInv <= 0) {
      return { rating: prior.rating, rd: prior.rd, vol: sigma };
    }

    const v = 1 / vInv;
    const delta = v * deltaSum;

    const sigmaPrime = solveVolatility(phi, v, delta, sigma, tau);
    const phiStar = Math.sqrt(phi * phi + sigmaPrime * sigmaPrime);
    const phiPrime = 1 / Math.sqrt(1 / (phiStar * phiStar) + 1 / v);
    const muPrime = mu + phiPrime * phiPrime * deltaSum;

    return {
      rating: muPrime * SCALE + BASE_RATING,
      rd: clamp(phiPrime * SCALE, 30, BASE_RD),
      vol: sigmaPrime,
    };
  }

  function gFactor(phi) {
    return 1 / Math.sqrt(1 + (3 * phi * phi) / (Math.PI * Math.PI));
  }

  function expected(mu, muJ, phiJ) {
    return 1 / (1 + Math.exp(-gFactor(phiJ) * (mu - muJ)));
  }

  // Illinois variant of regula falsi, as specified by Glickman.
  function solveVolatility(phi, v, delta, sigma, tau) {
    const a = Math.log(sigma * sigma);
    const d2 = delta * delta;
    const phi2 = phi * phi;

    const f = (x) => {
      const ex = Math.exp(x);
      const num = ex * (d2 - phi2 - v - ex);
      const den = 2 * Math.pow(phi2 + v + ex, 2);
      return (num / den) - ((x - a) / (tau * tau));
    };

    let A = a;
    let B;
    if (d2 > phi2 + v) {
      B = Math.log(d2 - phi2 - v);
    } else {
      let k = 1;
      while (f(a - k * tau) < 0 && k < 100) k++;
      B = a - k * tau;
    }

    let fA = f(A);
    let fB = f(B);
    let iter = 0;

    while (Math.abs(B - A) > CONVERGENCE && iter < MAX_ITER) {
      const C = A + ((A - B) * fA) / (fB - fA);
      const fC = f(C);
      if (fC * fB <= 0) { A = B; fA = fB; }
      else { fA = fA / 2; }
      B = C; fB = fC;
      iter++;
    }

    return Math.exp(A / 2);
  }

  // Margin → a score in (0,1). A one-point win is barely evidence;
  // a rout is strong evidence but saturates, so garbage-time points
  // cannot run the rating away.
  function marginToScore(margin, scale) {
    return 1 / (1 + Math.exp(-margin / scale));
  }

  // Win probability between two Glicko-2 teams, uncertainty included.
  function glickoWinProbability(a, b, homeEdgePoints = 0, sport = 'NFL') {
    const scale = MARGIN_SCALE[sport] ?? 10;
    const edgeRating = (homeEdgePoints / scale) * SCALE * 0.4;
    const muA = (a.rating + edgeRating - BASE_RATING) / SCALE;
    const muB = (b.rating - BASE_RATING) / SCALE;
    const phi = Math.sqrt(Math.pow(a.rd / SCALE, 2) + Math.pow(b.rd / SCALE, 2));
    return 1 / (1 + Math.exp(-gFactor(phi) * (muA - muB)));
  }

  function periodFor(sport) {
    // One rating period per typical week of scheduling.
    return { NFL: 7, NCAAF: 7, NBA: 7, NCAAB: 7, NHL: 7, MLB: 7, MLS: 7 }[sport] ?? 7;
  }

  // ============================================================
  // ── SEASON CARRY-OVER ──
  // Last season's end state becomes this season's starting point,
  // regressed toward the mean and with uncertainty restored.
  // ============================================================

  function carryOver(sport, previous, options = {}) {
    const cfg = CARRYOVER[sport] || { regress: 0.33, rdFloor: 180 };
    const { regress = cfg.regress, rdFloor = cfg.rdFloor, adjustments = {} } = options;

    const teams = Object.keys(previous || {});
    if (!teams.length) return {};

    const mean = teams.reduce((s, t) => s + previous[t].rating, 0) / teams.length;

    const out = {};
    teams.forEach(t => {
      const p = previous[t];
      // Pull toward the league mean.
      let rating = p.rating + (mean - p.rating) * regress;

      // Off-season movement: trades, the draft, a coaching change.
      // Supplied in points of team strength; converted to rating.
      const adj = adjustments[t];
      if (adj) {
        const scale = MARGIN_SCALE[sport] ?? 10;
        rating += (adj.points || 0) / scale * SCALE * 0.4;
      }

      // We know less than we did in January, and a team with a big
      // off-season move is less predictable still.
      const uncertaintyBump = adj ? Math.min(Math.abs(adj.points || 0) * 8, 80) : 0;

      out[t] = {
        rating: round(rating, 1),
        rd: round(Math.max(rdFloor + uncertaintyBump, p.rd), 1),
        vol: p.vol || BASE_VOL,
        carried_from: p.rating,
        adjustment: adj ? adj.points : 0,
        adjustment_reason: adj ? adj.reason || null : null,
      };
    });

    return out;
  }

  // ============================================================
  // ── MASSEY ──
  // r_i − r_j = margin, stacked across every game and solved by
  // least squares with a sum-to-zero constraint so the system has
  // a unique solution.
  // ============================================================

  function massey(sport, games, options = {}) {
    const { marginCap = MARGIN_SCALE[sport] ? MARGIN_SCALE[sport] * 3 : 30 } = options;
    const teams = teamList(games);
    const n = teams.length;
    if (n < 2) return {};
    const idx = {};
    teams.forEach((t, i) => { idx[t] = i; });

    const M = zeros(n, n);
    const p = new Array(n).fill(0);

    games.forEach(g => {
      const i = idx[g.home], j = idx[g.away];
      if (i === undefined || j === undefined) return;
      // Capping stops one blowout from dominating the solution.
      const margin = clamp(g.homeScore - g.awayScore, -marginCap, marginCap);
      M[i][i] += 1; M[j][j] += 1;
      M[i][j] -= 1; M[j][i] -= 1;
      p[i] += margin; p[j] -= margin;
    });

    // Replace the last equation with Σr = 0.
    for (let k = 0; k < n; k++) M[n - 1][k] = 1;
    p[n - 1] = 0;

    const r = solve(M, p);
    if (!r) return {};

    const out = {};
    teams.forEach((t, i) => { out[t] = round(r[i], 3); });
    return out;
  }

  // ============================================================
  // ── COLLEY ──
  // Wins and losses only, Laplace-smoothed so every team starts
  // at 0.5 and nobody reaches infinity.
  // ============================================================

  function colley(games) {
    const teams = teamList(games);
    const n = teams.length;
    if (n < 2) return {};
    const idx = {};
    teams.forEach((t, i) => { idx[t] = i; });

    const C = zeros(n, n);
    const b = new Array(n).fill(1);
    const record = teams.map(() => ({ w: 0, l: 0 }));

    for (let i = 0; i < n; i++) C[i][i] = 2;

    games.forEach(g => {
      const i = idx[g.home], j = idx[g.away];
      if (i === undefined || j === undefined) return;
      C[i][i] += 1; C[j][j] += 1;
      C[i][j] -= 1; C[j][i] -= 1;
      const margin = g.homeScore - g.awayScore;
      if (margin > 0) { record[i].w++; record[j].l++; }
      else if (margin < 0) { record[j].w++; record[i].l++; }
      else { record[i].w += 0.5; record[i].l += 0.5; record[j].w += 0.5; record[j].l += 0.5; }
    });

    for (let i = 0; i < n; i++) b[i] = 1 + (record[i].w - record[i].l) / 2;

    const r = solve(C, b);
    if (!r) return {};

    const out = {};
    teams.forEach((t, i) => { out[t] = round(r[i], 4); });
    return out;
  }

  // ============================================================
  // ── ATTACK / DEFENCE PER POSSESSION ──
  // Solved iteratively: a team's attack is what it scores relative
  // to what its opponents usually concede, and vice versa. This is
  // what converts ratings into a projected score.
  // ============================================================

  function attackDefense(sport, games, iterations = 30) {
    const teams = teamList(games);
    if (!teams.length) return {};
    const poss = POSSESSIONS[sport] ?? 100;

    const scored = {}, allowed = {}, played = {}, opps = {};
    teams.forEach(t => { scored[t] = 0; allowed[t] = 0; played[t] = 0; opps[t] = []; });

    games.forEach(g => {
      if (!(g.home in scored) || !(g.away in scored)) return;
      scored[g.home] += g.homeScore; allowed[g.home] += g.awayScore;
      scored[g.away] += g.awayScore; allowed[g.away] += g.homeScore;
      played[g.home]++; played[g.away]++;
      opps[g.home].push(g.away); opps[g.away].push(g.home);
    });

    const active = teams.filter(t => played[t] > 0);
    if (!active.length) return {};

    // Per-possession rates.
    const leagueAvg = active.reduce((s, t) => s + scored[t] / played[t], 0) / active.length;
    const perPoss = {};
    active.forEach(t => {
      perPoss[t] = {
        att: (scored[t] / played[t]) / poss,
        def: (allowed[t] / played[t]) / poss,
      };
    });
    const leaguePerPoss = leagueAvg / poss;

    let att = {}, def = {};
    active.forEach(t => { att[t] = perPoss[t].att; def[t] = perPoss[t].def; });

    for (let k = 0; k < iterations; k++) {
      const nextAtt = {}, nextDef = {};
      active.forEach(t => {
        const oppDef = opps[t].filter(o => def[o] !== undefined);
        const oppAtt = opps[t].filter(o => att[o] !== undefined);

        const avgOppDef = oppDef.length
          ? oppDef.reduce((s, o) => s + def[o], 0) / oppDef.length : leaguePerPoss;
        const avgOppAtt = oppAtt.length
          ? oppAtt.reduce((s, o) => s + att[o], 0) / oppAtt.length : leaguePerPoss;

        // Scored more than these opponents usually concede → stronger attack.
        nextAtt[t] = perPoss[t].att * (leaguePerPoss / Math.max(avgOppDef, 1e-6));
        nextDef[t] = perPoss[t].def * (leaguePerPoss / Math.max(avgOppAtt, 1e-6));
      });
      att = nextAtt; def = nextDef;
    }

    const out = {};
    active.forEach(t => {
      out[t] = {
        attack: round(att[t], 5),
        defense: round(def[t], 5),
        attack_index: round((att[t] / leaguePerPoss) * 100, 1),
        defense_index: round((leaguePerPoss / Math.max(def[t], 1e-6)) * 100, 1),
        possessions: poss,
        games: played[t],
      };
    });
    out._league = { per_possession: round(leaguePerPoss, 5), per_game: round(leagueAvg, 2), possessions: poss };
    return out;
  }

  // ============================================================
  // ── PROJECTED SCORE ──
  // No betting line is consulted. The margin this produces is the
  // number the market gets compared against, not fitted to.
  // ============================================================

  function projectScore(sport, homeAD, awayAD, league, options = {}) {
    const { neutral = false, paceAdjust = true, interactions = null } = options;
    if (!homeAD || !awayAD || !league) return null;

    const hfa = neutral ? 0 : (HOME_POINTS[sport] ?? 2);
    const poss = league.possessions || POSSESSIONS[sport] || 100;
    const lg = league.per_possession;

    // Attack meets defence, both already opponent-adjusted.
    let homeRate = (homeAD.attack * awayAD.defense) / Math.max(lg, 1e-6);
    let awayRate = (awayAD.attack * homeAD.defense) / Math.max(lg, 1e-6);

    // Two fast teams play a faster game; two slow ones do not.
    let gamePoss = poss;
    if (paceAdjust && homeAD.possessions && awayAD.possessions) {
      gamePoss = (homeAD.possessions + awayAD.possessions) / 2;
    }

    let homePts = homeRate * gamePoss;
    let awayPts = awayRate * gamePoss;

    // The grid: a specific strength meeting a specific weakness is
    // worth more than the two ratings imply on their own.
    const applied = [];
    if (interactions && Array.isArray(interactions)) {
      interactions.forEach(ix => {
        const pts = Number(ix.points) || 0;
        if (!pts) return;
        if (ix.side === 'home') homePts += pts;
        else if (ix.side === 'away') awayPts += pts;
        applied.push({ label: ix.label, side: ix.side, points: round(pts, 2) });
      });
    }

    homePts += hfa / 2;
    awayPts -= hfa / 2;

    const margin = homePts - awayPts;

    return {
      home_points: round(homePts, 2),
      away_points: round(awayPts, 2),
      total: round(homePts + awayPts, 2),
      margin: round(margin, 2),
      // Stated the way a spread is quoted: negative favours home.
      model_spread: round(-margin, 2),
      home_field: hfa,
      possessions: round(gamePoss, 1),
      interactions: applied,
    };
  }

  // ============================================================
  // ── BLEND ──
  // Glicko is dynamic but schedule-blind early; Massey and Colley
  // are schedule-aware but static. Weight by how much each knows.
  // ============================================================

  function blend(sport, glickoState, masseyRatings, colleyRatings, options = {}) {
    const { minGames = 4 } = options;
    const out = {};

    Object.entries(glickoState || {}).forEach(([team, g]) => {
      const m = masseyRatings?.[team];
      const c = colleyRatings?.[team];

      // Confidence in Glicko grows as RD falls.
      const certainty = clamp(1 - (g.rd - 30) / (BASE_RD - 30), 0, 1);
      const sampleWeight = clamp((g.games || 0) / minGames, 0, 1);

      // Early in a season the linear solves carry more; later Glicko does.
      const wGlicko = 0.45 + 0.35 * certainty;
      const wMassey = (1 - wGlicko) * 0.65 * sampleWeight;
      const wColley = (1 - wGlicko) * 0.35 * sampleWeight;
      const total = wGlicko + wMassey + wColley;

      // Everything on one scale: points above an average team.
      const scale = MARGIN_SCALE[sport] ?? 10;
      const glickoPts = ((g.rating - BASE_RATING) / SCALE) * scale * 0.4;
      const masseyPts = m ?? 0;
      const colleyPts = c != null ? (c - 0.5) * scale * 4 : 0;

      const composite = (glickoPts * wGlicko + masseyPts * wMassey + colleyPts * wColley) / total;

      out[team] = {
        rating: g.rating,
        rd: g.rd,
        vol: g.vol,
        conservative: g.conservative,
        games: g.games,
        massey: masseyPts,
        colley: c ?? null,
        composite_points: round(composite, 2),
        certainty: round(certainty, 3),
        weights: { glicko: round(wGlicko / total, 3), massey: round(wMassey / total, 3), colley: round(wColley / total, 3) },
      };
    });

    return out;
  }

  // ============================================================
  // ── LINEAR ALGEBRA ──
  // ============================================================

  function zeros(rows, cols) {
    return Array.from({ length: rows }, () => new Array(cols).fill(0));
  }

  // Gaussian elimination with partial pivoting.
  function solve(A, b) {
    const n = A.length;
    const M = A.map((row, i) => [...row, b[i]]);

    for (let col = 0; col < n; col++) {
      let pivot = col;
      for (let r = col + 1; r < n; r++) {
        if (Math.abs(M[r][col]) > Math.abs(M[pivot][col])) pivot = r;
      }
      if (Math.abs(M[pivot][col]) < 1e-10) continue;   // singular column
      if (pivot !== col) { const t = M[pivot]; M[pivot] = M[col]; M[col] = t; }

      const p = M[col][col];
      for (let r = col + 1; r < n; r++) {
        const factor = M[r][col] / p;
        if (!factor) continue;
        for (let c = col; c <= n; c++) M[r][c] -= factor * M[col][c];
      }
    }

    const x = new Array(n).fill(0);
    for (let r = n - 1; r >= 0; r--) {
      let sum = M[r][n];
      for (let c = r + 1; c < n; c++) sum -= M[r][c] * x[c];
      x[r] = Math.abs(M[r][r]) < 1e-10 ? 0 : sum / M[r][r];
    }
    return x.every(v => isFinite(v)) ? x : null;
  }

  function teamList(games) {
    const set = new Set();
    games.forEach(g => { if (g.home) set.add(g.home); if (g.away) set.add(g.away); });
    return Array.from(set).sort();
  }

  function clamp(v, min, max) { return Math.max(min, Math.min(max, v)); }
  function round(v, d) { const f = Math.pow(10, d); return Math.round(v * f) / f; }

})();

if (typeof window !== 'undefined') window.EDGE_RATING = EDGE_RATING;
