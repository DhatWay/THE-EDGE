// ============================================================
// EDGE ENGINE — game model + line model, one pass
// (design: "EDGE — Engine Rebuild Design")
//
// For every game, in one pass:
//   GAME MODEL  the predicted margin (ratings, each sport's drivers and
//               outcome math, fitted weights where the Slate Test saved
//               them), its chance and value NOW, and its chance and value
//               at the PREDICTED CLOSING LINE — the number the market is
//               heading to — so news already moving the line isn't
//               counted twice.
//   LINE MODEL  where the line will close: the sharpest book's lead, the
//               game model's gap to the line, the move so far, the time
//               left, NFL key numbers. Gives the timing: bet now (the line
//               is heading against the side) or wait (heading toward it).
//   COMBINED    what to bet = value at the predicted close (the sport's
//               caps and value bars); when = the line model's timing.
// Every result carries the engine version and labels, so each part is
// graded on its own and together.
// ============================================================

const EDGE_ENGINE = (function () {
  const VERSION = 'engine-1.1.0';
  const clamp = (v, lo, hi) => Math.max(lo, Math.min(hi, v));
  const round = (v, d = 2) => Math.round(v * 10 ** d) / 10 ** d;
  const num = v => (v == null || v === '' || !isFinite(Number(v)) ? null : Number(v));

  // Line-model weights per sport: how much of each gap tends to close by
  // kickoff. Starting values; replaced by learned ones once 150+ graded
  // ratings of a sport carry their inputs and actual close.
  const LINE_W = {
    NFL:   { sharp: 0.55, model: 0.06, momentum: 0.20, gapCap: 6 },
    NCAAF: { sharp: 0.55, model: 0.08, momentum: 0.20, gapCap: 9 },
    NBA:   { sharp: 0.55, model: 0.06, momentum: 0.20, gapCap: 6 },
    WNBA:  { sharp: 0.50, model: 0.06, momentum: 0.20, gapCap: 6 },
    NCAAB: { sharp: 0.55, model: 0.08, momentum: 0.20, gapCap: 7 },
    MLB:   { sharp: 0.50, model: 0.05, momentum: 0.15, gapCap: 1.5 },
    NHL:   { sharp: 0.50, model: 0.05, momentum: 0.15, gapCap: 1.5 },
    MLS:   { sharp: 0.50, model: 0.05, momentum: 0.15, gapCap: 1 },
  };
  const MIN_MOVE = { NFL: 0.5, NCAAF: 0.5, NBA: 0.5, WNBA: 0.5, NCAAB: 0.5, MLB: 0.25, NHL: 0.25, MLS: 0.25 };
  let learned = null;
  function setLearned(w) { learned = w || null; }
  function weightsFor(sport) {
    const base = LINE_W[sport] || LINE_W.NFL;
    const l = learned && learned[sport];
    return l && l.n >= 150 ? { ...base, ...l, source: 'learned' } : { ...base, source: 'starting' };
  }
  const fmtLine = v => (v > 0 ? '+' : '') + v;

  // ── LINE MODEL (home-view lines) ──
  function lineModel(prior, game, opts = {}) {
    const sport = prior.sport;
    const L = num(game.spread ?? game.home_spread ?? (prior.market && prior.market.current_spread));
    if (L == null) return null;
    const O = num(opts.opener ?? (prior.market && (prior.market.open_spread ?? prior.market.opening_spread)));
    const S = num(game.pin_home_spread);
    const M = num(prior.model_spread);
    const start = new Date(game.commence_time || prior.commence_time || 0).getTime();
    const hours = start ? Math.max(0, (start - Date.now()) / 3600000) : 24;
    const w = weightsFor(sport);
    const tf = clamp(hours / 72, 0.15, 1);              // more time left = more of the gap still to close
    const gSharp = S != null ? S - L : 0;
    const gModel = M != null ? clamp(M - L, -w.gapCap, w.gapCap) : 0;
    const mom = O != null ? L - O : 0;
    let close = L + tf * (w.sharp * gSharp + w.model * gModel + w.momentum * mom);
    if (sport === 'NFL') {                              // NFL lines stick to 3 and 7
      for (const k of [3, 7]) {
        if (Math.abs(Math.abs(close) - k) <= 0.5 && Math.abs(L) !== k) { close = Math.sign(close || L) * k; break; }
      }
    }
    close = Math.round(close * 2) / 2;                  // lines trade in half points
    return {
      current: L, opener: O, sharp: S, model_line: M != null ? round(M, 1) : null,
      expected_close: close, move: round(close - L, 2), hours: round(hours, 1),
      inputs: { sharp_gap: round(gSharp, 2), model_gap: round(gModel, 2), momentum: round(mom, 2), time_factor: round(tf, 2) },
      weights: { sharp: w.sharp, model: w.model, momentum: w.momentum, source: w.source },
    };
  }

  // Timing for a side: the home side gets dearer when the line falls
  // (−3 → −4.5), the away side when it rises.
  function timing(sport, sideHome, lm) {
    if (!lm) return { call: 'bet', why: 'no line-model read' };
    const mv = lm.move;
    if (Math.abs(mv) < (MIN_MOVE[sport] || 0.5)) return { call: 'bet', why: `line expected to hold near ${fmtLine(sideHome ? lm.current : -lm.current)}` };
    const worse = sideHome ? mv < 0 : mv > 0;
    const to = fmtLine(sideHome ? lm.expected_close : -lm.expected_close);
    return worse ? { call: 'bet_now', why: `line expected to move to ${to} — against this side; bet before it does` }
                 : { call: 'wait', why: `line expected to move to ${to} — toward this side; a better number should come` };
  }

  // ── ONE GAME, BOTH MODELS ──
  function evaluateGame(prior, game, opts = {}) {
    const G = typeof window !== 'undefined' && window.EDGE_GOVERNOR;
    const SP = typeof window !== 'undefined' && window.EDGE_SPORTS;
    if (!G || !prior || !game) return null;
    const lm = lineModel(prior, game, opts);
    const out = { version: VERSION, game_id: game.id || prior.game_id, sport: prior.sport, line_model: lm, game_model: null, combined: null };
    const nowDec = opts.decision || (() => { try { return G.run([], { ...prior, bet_type: 'SPREAD' }, {}); } catch { return null; } })();
    let atClose = null;
    if (lm && SP && isFinite(prior.model_spread)) {
      try {
        // The cover model's chance moves with the line: its result against
        // the spread shifts point for point.
        const cmod = prior.cover_model;
        const c = cmod ? (() => { const p = clamp(PHI((cmod.resid + (lm.expected_close - cmod.line)) / cmod.sigma), 0.02, 0.98); return { home_cover: p, away_cover: 1 - p, push: 0 }; })()
                       : SP.cover(prior.sport, -prior.model_spread, lm.expected_close, { total: num(game.total) });
        if (c) atClose = G.run([], { ...prior, bet_type: 'SPREAD', cover: c, market_spread: lm.expected_close,
                                     market: { ...(prior.market || {}), current_spread: lm.expected_close } }, {});
      } catch {}
    }
    const gs = nowDec && nowDec.governor_snapshot;
    out.game_model = {
      model_spread: num(prior.model_spread),
      now: nowDec ? { side: nowDec.direction, chance: nowDec.confidence != null ? round(nowDec.confidence / 100, 4) : null,
                      value: nowDec.ev ?? (gs && gs.ev) ?? null, tier: nowDec.decision || null } : null,
      at_close: atClose ? { side: atClose.direction, chance: round(atClose.confidence / 100, 4), value: atClose.ev, tier: atClose.decision, extreme: !!atClose.extreme } : null,
    };
    if (atClose && (atClose.direction === 'home' || atClose.direction === 'away')) {
      const sideHome = atClose.direction === 'home';
      const t = timing(prior.sport, sideHome, lm);
      out.combined = {
        side: atClose.direction, team: sideHome ? (game.home_team || prior.home_team) : (game.away_team || prior.away_team),
        line_now: sideHome ? lm.current : -lm.current, line_close: sideHome ? lm.expected_close : -lm.expected_close,
        chance: round(atClose.confidence / 100, 4), value_at_close: atClose.ev, tier: atClose.decision || 'PASS',
        extreme: !!atClose.extreme, timing: t.call, timing_why: t.why,
      };
    }
    // Moneyline timing follows the spread's direction for the same team;
    // over/under timing comes from the totals line model.
    out.moneyline_timing = (side) => timing(prior.sport, side === 'home', lm);
    const tlm = totalLineModel(prior, game, { openerTotal: opts.openerTotal, modelTotal: opts.modelTotal });
    out.total_line_model = tlm;
    out.total_timing = (side) => totalTiming(prior.sport, side, tlm);
    out.cover_model = prior.cover_model || null;
    return out;
  }

  // ── THE LEARNED GAME MODEL: the cover model ──
  // Predicts each game's result AGAINST THE SPREAD (final margin + the
  // home line, in points) from what's known before it: each team's recent
  // results against the spread (overall, and home/road), their recent
  // scoring margins against the line, the spread's size, rest, and the
  // ranking's gap to the line. Weights are learned per sport by the Slate
  // Test (walk-forward: every input from earlier games only) and used only
  // if they beat "no edge" on held-out games.
  const PHI = z => { const t = 1 / (1 + 0.2316419 * Math.abs(z)); const d = 0.3989423 * Math.exp(-z * z / 2);
    const p = d * t * (0.3193815 + t * (-0.3565638 + t * (1.781478 + t * (-1.821256 + t * 1.330274)))); return z > 0 ? 1 - p : p; };
  const keyOf = (sport, name) => {
    const s = String(name || '');
    try { if (typeof EDGE_TEAMS !== 'undefined' && EDGE_TEAMS.normalize) return String(EDGE_TEAMS.normalize(s, sport)).toLowerCase().replace(/[^a-z0-9]/g, ''); } catch {}
    return s.toLowerCase().replace(/[^a-z0-9]/g, '');
  };
  // rows: { date, home, away, hs, as, line } — past games with scores and
  // the closing home line.
  function historyIndex(sport, rows) {
    const idx = {};
    (rows || []).forEach(r => {
      const hs = num(r.hs), as = num(r.as), L = num(r.line);
      if (hs == null || as == null || L == null || !r.date) return;
      const d = String(r.date).slice(0, 10);
      const h = keyOf(sport, r.home), a = keyOf(sport, r.away);
      (idx[h] = idx[h] || []).push({ d, margin: hs - as, resid: hs - as + L, home: true });
      (idx[a] = idx[a] || []).push({ d, margin: as - hs, resid: as - hs - L, home: false });
    });
    Object.values(idx).forEach(a => a.sort((x, y) => (x.d < y.d ? 1 : -1)));   // newest first
    return idx;
  }
  const meanOf = (a, f) => (a.length ? a.reduce((s, x) => s + f(x), 0) / a.length : 0);
  const FEATURES = ['ats_home', 'ats_away', 'ats_home_at_home', 'ats_away_on_road', 'form_vs_line', 'home_line', 'rest_diff', 'ranking_gap'];
  function coverFeatures(sport, homeName, awayName, beforeDate, L, modelSpread, rest, idx) {
    const before = String(beforeDate || '').slice(0, 10);
    const H = (idx[keyOf(sport, homeName)] || []).filter(g => g.d < before);
    const A = (idx[keyOf(sport, awayName)] || []).filter(g => g.d < before);
    const shrink = (v, n, k = 4) => v * n / (n + k);                 // few games → toward zero
    const h6 = H.slice(0, 6), a6 = A.slice(0, 6), hh = H.filter(g => g.home).slice(0, 4), ar = A.filter(g => !g.home).slice(0, 4);
    const rd = rest && isFinite(rest.home) && isFinite(rest.away) ? clamp(rest.home - rest.away, -7, 7) : 0;
    return {
      x: [
        shrink(meanOf(h6, g => g.resid), h6.length),
        -shrink(meanOf(a6, g => g.resid), a6.length),
        shrink(meanOf(hh, g => g.resid), hh.length),
        -shrink(meanOf(ar, g => g.resid), ar.length),
        (shrink(meanOf(h6, g => g.margin), h6.length) - shrink(meanOf(a6, g => g.margin), a6.length)) / 2 + L,
        L,
        rd,
        isFinite(modelSpread) ? clamp(L - modelSpread, -14, 14) : 0,
      ],
      n: Math.min(h6.length, a6.length),
    };
  }
  function coverModelFor(sport) {
    try {
      const t = (typeof EDGE_GOVERNOR !== 'undefined' && EDGE_GOVERNOR.readCalibrationTable) ? EDGE_GOVERNOR.readCalibrationTable() : null;
      const cm = t && t.cover_model && t.cover_model[sport];
      return cm && cm.beats ? cm : null;
    } catch { return null; }
  }
  // Applies the learned cover model to a prior: its chance to cover becomes
  // the cover model's (the governor then blends it with the market and caps
  // it, as it does every rating). No saved model → nothing changes.
  function applyCoverModel(prior, game, idx) {
    const cm = coverModelFor(prior.sport);
    const L = num(game.spread ?? game.home_spread ?? (prior.market && prior.market.current_spread));
    if (!cm || L == null || !idx) return prior;
    const f = coverFeatures(prior.sport, prior.home_team || game.home_team, prior.away_team || game.away_team,
                            prior.commence_time || game.commence_time, L, num(prior.model_spread), prior.rest_days, idx);
    if (f.n < 2) return prior;
    const resid = cm.intercept + cm.coef.reduce((s, b, i) => s + b * ((f.x[i] - cm.mean[i]) / cm.sd[i]), 0);
    const pHome = clamp(PHI(resid / cm.sigma), 0.02, 0.98);
    prior.cover = { home_cover: pHome, away_cover: 1 - pHome, push: 0, source: 'cover_model', sigma: cm.sigma };
    prior.cover_model = { resid: round(resid, 2), sigma: cm.sigma, line: L, features: Object.fromEntries(FEATURES.map((k, i) => [k, round(f.x[i], 2)])) };
    return prior;
  }
  // Fits the cover model from samples { x:[…], y: actual result vs the
  // line } in date order; tested on the last 30%.
  function fitCoverModel(samples) {
    const S = (samples || []).filter(s => s && s.x && s.x.every(v => isFinite(v)) && isFinite(s.y));
    if (S.length < 150) return { beats: false, n: S.length, reason: `needs 150 games, has ${S.length}` };
    const k = S[0].x.length, cut = Math.floor(S.length * 0.7), train = S.slice(0, cut), test = S.slice(cut);
    const mean = Array(k).fill(0), sd = Array(k).fill(0);
    train.forEach(s => s.x.forEach((v, i) => { mean[i] += v / train.length; }));
    train.forEach(s => s.x.forEach((v, i) => { sd[i] += (v - mean[i]) ** 2 / train.length; }));
    for (let i = 0; i < k; i++) sd[i] = Math.sqrt(sd[i]) || 1;
    const z = s => s.x.map((v, i) => (v - mean[i]) / sd[i]);
    const yMean = train.reduce((t, s) => t + s.y, 0) / train.length;
    const lam = 40;                                                   // strong ridge: noise gets little weight
    const A = Array.from({ length: k }, (_, i) => Array.from({ length: k }, (_, j) => (i === j ? lam : 0))), b = Array(k).fill(0);
    train.forEach(s => { const x = z(s); for (let i = 0; i < k; i++) { b[i] += x[i] * (s.y - yMean); for (let j = 0; j < k; j++) A[i][j] += x[i] * x[j]; } });
    const coef = solveN(A, b) || Array(k).fill(0);
    const pred = s => yMean + coef.reduce((t, c, i) => t + c * z(s)[i], 0);
    const resSd = Math.sqrt(train.reduce((t, s) => t + (s.y - pred(s)) ** 2, 0) / train.length) || 10;
    const ll = (p, y) => { if (y === 0) return null; const q = clamp(p, 0.02, 0.98); return y > 0 ? -Math.log(q) : -Math.log(1 - q); };
    let maeM = 0, maeN = 0, llM = 0, llN = 0, nl = 0;
    test.forEach(s => { const r = pred(s); maeM += Math.abs(s.y - r); maeN += Math.abs(s.y); const a = ll(PHI(r / resSd), s.y), c = ll(0.5, s.y); if (a != null) { llM += a; llN += c; nl++; } });
    const out = { coef: coef.map(c => round(c, 4)), intercept: round(yMean, 3), mean: mean.map(v => round(v, 4)), sd: sd.map(v => round(v, 4)),
                  sigma: round(resSd, 2), n: S.length, features: FEATURES,
                  test: { n: test.length, mae_model: round(maeM / test.length, 3), mae_naive: round(maeN / test.length, 3),
                          logloss_model: round(llM / Math.max(1, nl), 4), logloss_naive: round(llN / Math.max(1, nl), 4) } };
    out.beats = out.test.logloss_model < out.test.logloss_naive;
    out.reason = out.beats ? 'beats no-edge on held-out games' : 'did not beat no-edge on held-out games';
    return out;
  }
  function solveN(A, b) {
    const n = b.length, m = A.map((r, i) => [...r, b[i]]);
    for (let c = 0; c < n; c++) {
      let p = c; for (let r = c + 1; r < n; r++) if (Math.abs(m[r][c]) > Math.abs(m[p][c])) p = r;
      if (Math.abs(m[p][c]) < 1e-12) return null;
      [m[c], m[p]] = [m[p], m[c]];
      for (let r = 0; r < n; r++) if (r !== c) { const f2 = m[r][c] / m[c][c]; for (let q = c; q <= n; q++) m[r][q] -= f2 * m[c][q]; }
    }
    return m.map((r, i) => r[n] / r[i]);
  }

  // ── TOTALS LINE MODEL: where the total is heading ──
  function totalLineModel(prior, game, opts = {}) {
    const T = num(game.total ?? (prior.market && prior.market.total));
    if (T == null) return null;
    const O = num(opts.openerTotal);
    const Mt = num(opts.modelTotal ?? (prior.projection && prior.projection.total));
    const start = new Date(game.commence_time || prior.commence_time || 0).getTime();
    const hours = start ? Math.max(0, (start - Date.now()) / 3600000) : 24;
    const w = weightsFor(prior.sport);
    const tf = clamp(hours / 72, 0.15, 1);
    const cap = w.gapCap * 1.5;
    const gModel = Mt != null ? clamp(Mt - T, -cap, cap) : 0, mom = O != null ? T - O : 0;
    const close = Math.round((T + tf * (w.model * gModel + w.momentum * mom)) * 2) / 2;
    return { current: T, opener: O, model_total: Mt != null ? round(Mt, 1) : null, expected_close: close, move: round(close - T, 2),
             inputs: { model_gap: round(gModel, 2), momentum: round(mom, 2), time_factor: round(tf, 2) } };
  }
  function totalTiming(sport, side, tlm) {
    if (!tlm) return { call: 'bet', why: 'no line-model read' };
    if (Math.abs(tlm.move) < (MIN_MOVE[sport] || 0.5)) return { call: 'bet', why: `total expected to hold near ${tlm.current}` };
    const worse = side === 'over' ? tlm.move > 0 : tlm.move < 0;      // an over gets dearer as the total rises
    return worse ? { call: 'bet_now', why: `total expected to move to ${tlm.expected_close} — against this side; bet before it does` }
                 : { call: 'wait', why: `total expected to move to ${tlm.expected_close} — toward this side; a better number should come` };
  }

  // ── LINE-MODEL LEARNING: ridge least squares per sport ──
  function fitLineModel(rows) {
    const by = {};
    (rows || []).forEach(r => {
      const e = r.engine || (r.model && r.model.engine);
      const lm = e && e.line_model;
      if (!lm || r.close_line == null || lm.current == null) return;
      const tf = lm.inputs.time_factor || 1;
      (by[r.sport] = by[r.sport] || []).push({ x: [tf * lm.inputs.sharp_gap, tf * lm.inputs.model_gap, tf * lm.inputs.momentum], y: Number(r.close_line) - lm.current });
    });
    const out = {};
    Object.entries(by).forEach(([sport, pts]) => {
      if (pts.length < 150) return;
      const A = [[5, 0, 0], [0, 5, 0], [0, 0, 5]], b = [0, 0, 0];
      pts.forEach(({ x, y }) => { for (let i = 0; i < 3; i++) { b[i] += x[i] * y; for (let j = 0; j < 3; j++) A[i][j] += x[i] * x[j]; } });
      const s = solve3(A, b);
      if (s) out[sport] = { sharp: round(clamp(s[0], 0, 1), 3), model: round(clamp(s[1], 0, 0.5), 3), momentum: round(clamp(s[2], -0.5, 1), 3), n: pts.length };
    });
    return out;
  }
  function solve3(A, b) {
    const m = A.map((r, i) => [...r, b[i]]);
    for (let c = 0; c < 3; c++) {
      let p = c; for (let r = c + 1; r < 3; r++) if (Math.abs(m[r][c]) > Math.abs(m[p][c])) p = r;
      if (Math.abs(m[p][c]) < 1e-9) return null;
      [m[c], m[p]] = [m[p], m[c]];
      for (let r = 0; r < 3; r++) if (r !== c) { const f = m[r][c] / m[c][c]; for (let k = c; k < 4; k++) m[r][k] -= f * m[c][k]; }
    }
    return [m[0][3] / m[0][0], m[1][3] / m[1][1], m[2][3] / m[2][2]];
  }

  return { VERSION, LINE_W, FEATURES, lineModel, timing, totalLineModel, totalTiming, evaluateGame, fitLineModel, setLearned, weightsFor,
           historyIndex, coverFeatures, applyCoverModel, fitCoverModel, coverModelFor };
})();

if (typeof window !== 'undefined') window.EDGE_ENGINE = EDGE_ENGINE;
