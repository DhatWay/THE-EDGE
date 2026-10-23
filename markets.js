// ============================================================
// EDGE — FOUR MARKETS
//
// Every game rated in every market, each by its own logic, each sport
// by its own data:
//
//   SPREAD     the governor on the spread (the ranking's margin vs the
//              line, the sport's own outcome math and value bars)
//   MONEYLINE  the governor on the moneyline (win chance vs the price,
//              with the sport's moneyline de-bias)
//   TOTAL      the over/under model, adjusted by what moves scoring in
//              that sport:
//                MLB    ballpark, both starting pitchers, both bullpens
//                NHL    both starting goalies
//                NBA / WNBA / NCAAB   teams on a back-to-back score less
//                NFL / NCAAF          weather (wind, rain, snow, cold)
//   PROPS      player projections from box scores (prop-engine.js),
//              against a line you enter or one looked up for a game
//
// And the pick builder: the N best options across all four markets,
// one per game, nothing below a sport's value bar.
// ============================================================

const EDGE_MARKETS = (function () {
  const BUILD = 'markets-20261023-01';
  const round = (v, d = 2) => Math.round(v * 10 ** d) / 10 ** d;
  const nm = t => String(t || '').toLowerCase().replace(/[^a-z0-9]/g, '');
  const fmt = v => (v > 0 ? '+' : '') + round(v, 2);

  // MLB ballpark run factors (multi-year), by home team.
  const PARK = {
    coloradorockies: 1.13, cincinnatireds: 1.06, bostonredsox: 1.05, kansascityroyals: 1.03, philadelphiaphillies: 1.03,
    chicagocubs: 1.02, arizonadiamondbacks: 1.02, texasrangers: 1.01, atlantabraves: 1.01, losangelesangels: 1.01,
    minnesotatwins: 1.01, washingtonnationals: 1.00, torontobluejays: 1.00, baltimoreorioles: 0.99, houstonastros: 0.99,
    milwaukeebrewers: 0.99, newyorkyankees: 0.99, chicagowhitesox: 0.99, losangelesdodgers: 0.98, pittsburghpirates: 0.98,
    stlouiscardinals: 0.98, athletics: 0.98, oaklandathletics: 0.98, clevelandguardians: 0.97, detroittigers: 0.97,
    newyorkmets: 0.96, miamimarlins: 0.96, tampabayrays: 0.96, sanfranciscogiants: 0.95, sandiegopadres: 0.95, seattlemariners: 0.93,
  };
  const STARTER_SHARE = 0.55;            // share of a game a starter pitches / a goalie's effect carried
  const FULL_GAMES = { NFL: 8, NCAAF: 8, NBA: 20, WNBA: 12, NCAAB: 12, MLB: 40, NHL: 20, MLS: 10 };

  // ── TOTALS: the projection, moved by what scores (or stops) points in
  //    this sport. Each part is listed so the card can show it. ──
  function totalFor(prior, ctx = {}) {
    const sport = prior && prior.sport;
    const base = Number(prior && prior.projection && prior.projection.total);
    if (!sport || !isFinite(base) || base <= 0) return null;
    const parts = [];
    const ext = prior.external || {};
    if (sport === 'MLB') {
      // Half weight: each team's own ratings already carry half its games
      // at its home park, so the full factor would count the park twice.
      const pf = PARK[nm(prior.home_team)];
      if (pf && pf !== 1) parts.push({ name: 'park', value: round(base * (pf - 1) * 0.5), why: `${prior.home_team} ballpark ×${pf} (half weight)` });
      if (ext.mlb) {
        const h = Number(ext.mlb.home && ext.mlb.home.runs_saved) || 0, a = Number(ext.mlb.away && ext.mlb.away.runs_saved) || 0;
        const v = -STARTER_SHARE * (h + a);
        if (Math.abs(v) >= 0.05) parts.push({ name: 'starters', value: round(v), why: `starters: ${(ext.mlb.home && ext.mlb.home.name) || '?'} ${fmt(h)} and ${(ext.mlb.away && ext.mlb.away.name) || '?'} ${fmt(a)} runs saved` });
      }
      const bp = prior.bullpen;
      if (bp && isFinite(bp.home) && isFinite(bp.away)) {
        const ex = ip => Math.max(0, ip - 9);
        const v = (ex(bp.home) + ex(bp.away)) * 0.04;
        if (v >= 0.05) parts.push({ name: 'bullpens', value: round(v), why: `tired bullpens: ${round(bp.home, 1)} and ${round(bp.away, 1)} relief innings in 3 days` });
      }
    }
    if (sport === 'NHL' && ext.nhl) {
      const h = Number(ext.nhl.home && ext.nhl.home.goals_saved) || 0, a = Number(ext.nhl.away && ext.nhl.away.goals_saved) || 0;
      const v = -STARTER_SHARE * (h + a);
      if (Math.abs(v) >= 0.05) parts.push({ name: 'goalies', value: round(v), why: `goalies: ${(ext.nhl.home && ext.nhl.home.name) || '?'} ${fmt(h)} and ${(ext.nhl.away && ext.nhl.away.name) || '?'} ${fmt(a)} goals saved` });
    }
    if (sport === 'NBA' || sport === 'WNBA' || sport === 'NCAAB') {
      const r = prior.rest_days || {};
      const tired = ['home', 'away'].filter(s => isFinite(r[s]) && r[s] <= 1);
      if (tired.length) parts.push({ name: 'back-to-back', value: -1.2 * tired.length, why: `${tired.length === 2 ? 'both teams' : (tired[0] === 'home' ? prior.home_team : prior.away_team)} on a back-to-back` });
    }
    if ((sport === 'NFL' || sport === 'NCAAF') && isFinite(ctx.weatherAdj) && ctx.weatherAdj < 0) {
      parts.push({ name: 'weather', value: round(ctx.weatherAdj), why: 'weather (wind, rain, snow or cold)' });
    }
    const total = base + parts.filter(p => p.name !== 'weather').reduce((s, p) => s + p.value, 0);
    return { base: round(base), total: round(total), parts, weatherAdj: isFinite(ctx.weatherAdj) ? ctx.weatherAdj : 0 };
  }
  function certaintyFor(prior) {
    const gh = Number(prior.home_power && prior.home_power.games_played), ga = Number(prior.away_power && prior.away_power.games_played);
    const full = FULL_GAMES[prior.sport] || 10;
    return (isFinite(gh) && isFinite(ga)) ? Math.max(0.25, Math.min(1, Math.min(gh, ga) / full)) : 1;
  }
  function rateTotal(prior, game, ctx = {}) {
    const G = typeof window !== 'undefined' && window.EDGE_GOVERNOR;
    const mt = Number(game.total);
    const tf = totalFor(prior, ctx);
    if (!G || !G.rateTotal || !tf || !isFinite(mt)) return null;
    const certainty = certaintyFor(prior);
    const r = G.rateTotal({ sport: prior.sport, modelTotal: tf.total, marketTotal: mt,
      overPrice: Number(game.over_price) || -110, underPrice: Number(game.under_price) || -110, weatherAdj: tf.weatherAdj, certainty });
    return r ? { ...r, model_base: tf.base, model_adjusted: tf.total, parts: tf.parts, certainty: round(certainty) } : null;
  }

  // ── ONE GAME, ALL MARKETS ──
  // decision: the pipeline's own decision for this game (its bet type is
  // used as-is, so the card and the pick always agree).
  function pack(market, g, game, extra = {}) {
    if (!g || !(g.direction === 'home' || g.direction === 'away')) return null;
    const home = g.direction === 'home';
    const line = market === 'spread' ? (home ? Number(game.spread) : -Number(game.spread)) : null;
    return {
      market, side: g.direction, team: home ? game.home_team : game.away_team,
      line: market === 'spread' && isFinite(line) ? line : null,
      home_line: market === 'spread' ? Number(game.spread) : null,
      price: g.price ?? null, chance: g.confidence != null ? round(g.confidence / 100, 4) : null,
      value: g.ev ?? null, tier: g.decision || 'PASS',
      extreme: !!(g.extreme || (g.components && g.components.extreme)), ...extra,
    };
  }
  function rateGame(prior, game, opts = {}) {
    const G = typeof window !== 'undefined' && window.EDGE_GOVERNOR;
    if (!G || !prior || !game) return null;
    const out = { game_id: game.id, sport: prior.sport, home: game.home_team, away: game.away_team, start: game.commence_time,
                  spread: null, moneyline: null, total: null, rated_at: new Date().toISOString() };
    const dec = opts.decision || null;
    const decType = dec && dec.governor_snapshot ? dec.governor_snapshot.bet_type : (dec && dec.bet_type) || null;
    try {
      if (game.spread != null && isFinite(Number(game.spread))) {
        const g = decType === 'SPREAD' ? { direction: dec.direction, decision: dec.decision, confidence: dec.confidence, ev: dec.governor_snapshot && dec.governor_snapshot.ev, price: dec.governor_snapshot && dec.governor_snapshot.price, extreme: dec.governor_snapshot && dec.governor_snapshot.extreme }
                                       : G.run([], { ...prior, bet_type: 'SPREAD' }, {});
        out.spread = pack('spread', g, game);
      }
    } catch {}
    try {
      if (game.ml != null && game.away_ml != null && prior.win) {
        const g = decType === 'ML' ? { direction: dec.direction, decision: dec.decision, confidence: dec.confidence, ev: dec.governor_snapshot && dec.governor_snapshot.ev, price: dec.governor_snapshot && dec.governor_snapshot.price, extreme: dec.governor_snapshot && dec.governor_snapshot.extreme }
                                   : G.run([], { ...prior, bet_type: 'ML' }, {});
        out.moneyline = pack('moneyline', g, game);
      }
    } catch {}
    try {
      const t = opts.total || rateTotal(prior, game, { weatherAdj: opts.weatherAdj });
      if (t && t.side) out.total = { market: 'total', side: t.side, team: t.side === 'over' ? 'Over' : 'Under', line: Number(game.total),
        price: t.price ?? null, chance: t.p != null ? round(t.p, 4) : null, value: t.ev ?? null, tier: t.tier && t.tier !== 'PASS' ? (t.tier === 'LEAN' ? 'LEAN' : 'BET_' + t.tier) : 'PASS',
        model_total: t.model_adjusted ?? t.model_total ?? null, parts: t.parts || [], extreme: !!t.extreme };
    } catch {}
    return out;
  }

  // ── PICK BUILDER ──
  // The N best options across the markets you allow: highest value at the
  // price first, one per game (one result can't sink several picks),
  // nothing below the sport's value bar. Fewer than N qualify → fewer.
  const LABEL = { spread: 'Spread', moneyline: 'Moneyline', total: 'Over/Under', prop: 'Prop' };
  function candidatesFrom(gamesMarkets, props = [], opts = {}) {
    const allow = opts.markets || ['spread', 'moneyline', 'total', 'prop'];
    const sports = opts.sports || null;
    const now = Date.now();
    const out = [];
    (gamesMarkets || []).forEach(gm => {
      if (!gm || (sports && !sports.includes(gm.sport))) return;
      if (gm.start && new Date(gm.start).getTime() <= now) return;
      ['spread', 'moneyline', 'total'].forEach(m => {
        const x = gm[m];
        if (!allow.includes(m) || !x || !x.tier || x.tier === 'PASS' || !(x.value > 0)) return;
        out.push({ ...x, game_id: gm.game_id, sport: gm.sport, home: gm.home, away: gm.away, start: gm.start });
      });
    });
    if (allow.includes('prop')) (props || []).forEach(p => {
      if (!p || (sports && !sports.includes(p.sport))) return;
      if (p.start && new Date(p.start).getTime() <= now) return;
      if (!p.tier || p.tier === 'PASS' || !(p.value > 0)) return;
      out.push({ ...p, market: 'prop' });
    });
    return out;
  }
  function buildPicks(candidates, n) {
    const want = Math.max(1, Math.min(10, Number(n) || 3));
    // Believable edges first; extreme disagreements (held at the cap) only
    // after them, so they can't crowd the top of the list.
    const sorted = candidates.slice().sort((a, b) => ((a.extreme ? 1 : 0) - (b.extreme ? 1 : 0)) || (b.value - a.value) || ((b.chance || 0) - (a.chance || 0)));
    const usedGames = new Set(), picks = [];
    for (const c of sorted) {
      if (picks.length >= want) break;
      if (usedGames.has(c.game_id)) continue;
      usedGames.add(c.game_id);
      picks.push(c);
    }
    return { picks, asked: want, short: want - picks.length, considered: candidates.length };
  }
  function describe(c) {
    if (c.market === 'spread') return `${c.team} ${c.line > 0 ? '+' : ''}${c.line}`;
    if (c.market === 'moneyline') return `${c.team} ML`;
    if (c.market === 'total') return `${c.team} ${c.line}`;
    if (c.market === 'prop') return `${c.player} ${String(c.side || '').toUpperCase()} ${c.line} ${c.stat_label || c.stat || ''}`.trim();
    return '';
  }

  return { BUILD, PARK, totalFor, rateTotal, rateGame, candidatesFrom, buildPicks, describe, LABEL };
})();

if (typeof window !== 'undefined') window.EDGE_MARKETS = EDGE_MARKETS;
