// ============================================================
// EDGE — TREND BET / PARLAY ENGINE v1.2
// Mines graded shadow_picks for repeatable trends, then builds
// correlation-safe parlays out of today's qualifying picks.
// Deterministic. No Claude. Pure math.
//
// v1.2 — three fixes:
//
//   1. line_moved_with_us. The trend test looked only at the
//      market family's vote in the governor breakdown. On the
//      live board the market family frequently votes neutral
//      because it reads line_history, and line_history does not
//      carry an open until a snapshot has been captured — which
//      for a fresh game is never. The trend now checks the pick's
//      own market_snapshot (spread vs open_spread) first, and
//      only falls back to the family vote when the snapshot is
//      absent. Under the old code this trend almost never fired.
//
//   2. legOdds. Spread picks are what the pipeline produces, and
//      their price is the spread price — normally -110. The old
//      code read market_home_ml / market_away_ml, which are the
//      moneyline prices. For a home spread pick on a heavy
//      favourite, that could be -180 while the spread pays -110.
//      Reading ML as the spread price inflated the payout and
//      made every parlay look better than it was. Spread legs
//      now take the spread price if the pick carries one, else
//      default to -110. The ML price is used for nothing in
//      parlay sizing.
//
//   3. legProbability fallback. When posterior_home_prob was
//      missing, the old code computed 0.5 + confidence/200. A
//      confidence of 65 became 0.825 — a probability the model
//      had never claimed. The fallback now reads confidence/100,
//      which is what the number is: a percent-scale probability.
//
// v1.1 — logEdgeError. Previously a failed Supabase read returned
// an empty array and the page said "no trends" — indistinguishable
// from "the query succeeded and found nothing".
// ============================================================

const EDGE_PARLAY = (() => {

  const BUILD = 'parlay-20260924-01';

  const SUPABASE_URL = () => localStorage.getItem('edge_supabase_url');
  const SUPABASE_KEY = () => localStorage.getItem('edge_supabase_key');

  function logEdgeError(where, err) {
    try {
      const list = JSON.parse(localStorage.getItem('edge_errors') || '[]');
      list.unshift({ t: Date.now(), where, msg: err && err.message ? err.message : String(err) });
      localStorage.setItem('edge_errors', JSON.stringify(list.slice(0, 50)));
    } catch {}
  }

  const TREND_WINDOW_DAYS   = 120;
  const TREND_MIN_SAMPLE    = 15;
  const TREND_MIN_HIT_RATE  = 0.54;
  const MAX_LEGS            = 4;
  const MIN_LEGS            = 2;
  const DEFAULT_LEG_ODDS    = -110;

  const TREND_PRIOR_N = 10;
  const TREND_MAX_PROB = 0.82;
  const TREND_MIN_SAMPLE_LEG = 5;

  const LEG_SHRINK = 0.35;

  const SAME_SPORT_CORRELATION = 0.04;

  const TRENDS = [
    {
      id: 'home_favorite_high_conf',
      label: 'Home favourites at high confidence',
      describe: 'Model backs the home side, spread favours home, confidence 65%+',
      test: p => p.direction === 'home' && num(p.market_spread) < 0 && num(p.confidence) >= 65,
    },
    {
      id: 'road_dog_value',
      label: 'Road underdogs with model edge',
      describe: 'Model backs the away side while the market has them getting points',
      test: p => p.direction === 'away' && num(p.market_spread) < 0 && num(p.edge) > 0.02,
    },
    {
      id: 'two_unit_conviction',
      label: 'Two-unit conviction plays',
      describe: 'Governor sized the play at 2 units',
      test: p => p.decision === 'BET_2U',
    },
    {
      id: 'strong_consensus',
      label: 'High family agreement',
      describe: 'Agreement index 0.6+ across the nine algorithm families',
      test: p => num(p.governor_snapshot?.agreement_index) >= 0.6,
    },
    {
      id: 'line_moved_with_us',
      label: 'Line moved toward our side',
      describe: 'Closing line value confirmed the model before kickoff',
      test: p => {
        // Prefer direct market movement. physics.js carries
        // market_snapshot.open_spread and market_snapshot.spread
        // on every persisted pick, so this check works even when
        // the market family voted neutral for lack of line data.
        if (lineMovedTowardPick(p)) return true;

        // Fall back to the market family vote. Kept so picks
        // persisted before market_snapshot was populated still
        // get a chance to qualify on this rule.
        const bd = p.governor_snapshot?.breakdown || [];
        const market = bd.find(b => b.family === 'market');
        return !!market && market.vote !== 'neu' && num(market.confidence) >= 0.7;
      },
    },
    {
      id: 'rested_home_side',
      label: 'Rest advantage at home',
      describe: 'Fatigue family favours the home team',
      test: p => {
        const bd = p.governor_snapshot?.breakdown || [];
        const fatigue = bd.find(b => b.family === 'fatigue');
        return !!fatigue && fatigue.vote === 'yes' && p.direction === 'home';
      },
    },
    {
      id: 'small_spread_games',
      label: 'Tight spreads',
      describe: 'Games priced inside a field goal / three points',
      test: p => {
        const s = Math.abs(num(p.market_spread));
        return s > 0 && s <= 3;
      },
    },
    {
      id: 'divisional_style_low_total',
      label: 'Low-total matchups',
      describe: 'Totals in the bottom band for the sport',
      test: p => {
        const t = num(p.market_total);
        if (!t) return false;
        if (p.sport === 'NFL' || p.sport === 'NCAAF') return t <= 42;
        if (p.sport === 'NBA' || p.sport === 'NCAAB') return t <= 218;
        if (p.sport === 'MLB') return t <= 8;
        if (p.sport === 'NHL') return t <= 5.5;
        return false;
      },
    },
  ];

  const MIN_H2H_MEETINGS = 4;
  const H2H_EDGE = 0.65;

  const H2H_TRENDS = [
    {
      id: 'h2h_home_owns_series',
      label: 'Home side owns this series ATS',
      test: h => h.home_cover_pct != null && h.home_cover_pct >= H2H_EDGE,
      describe: h => `Home team has covered ${pctText(h.home_cover_pct)} of the last ${h.meetings} meetings`,
      side: 'home',
    },
    {
      id: 'h2h_away_owns_series',
      label: 'Road side owns this series ATS',
      test: h => h.away_cover_pct != null && h.away_cover_pct >= H2H_EDGE,
      describe: h => `Road team has covered ${pctText(h.away_cover_pct)} of the last ${h.meetings} meetings`,
      side: 'away',
    },
    {
      id: 'h2h_series_stays_close',
      label: 'This series stays inside the number',
      test: h => h.avg_home_cover_margin != null && Math.abs(h.avg_home_cover_margin) <= 2.5,
      describe: h => `Average result lands ${Math.abs(h.avg_home_cover_margin)} from the spread`,
      side: 'any',
    },
    {
      id: 'h2h_series_goes_over',
      label: 'This series goes over',
      test: h => h.over_pct != null && h.over_pct >= H2H_EDGE && (h.overs + h.unders) >= MIN_H2H_MEETINGS,
      describe: h => `${h.overs} of the last ${h.overs + h.unders} meetings went over`,
      side: 'any',
    },
    {
      id: 'h2h_series_goes_under',
      label: 'This series goes under',
      test: h => h.over_pct != null && h.over_pct <= (1 - H2H_EDGE) && (h.overs + h.unders) >= MIN_H2H_MEETINGS,
      describe: h => `${h.unders} of the last ${h.overs + h.unders} meetings went under`,
      side: 'any',
    },
    {
      id: 'h2h_su_dominance',
      label: 'One side dominates outright',
      test: h => {
        const total = (h.home_su_wins || 0) + (h.away_su_wins || 0);
        if (total < MIN_H2H_MEETINGS) return false;
        return Math.max(h.home_su_wins || 0, h.away_su_wins || 0) / total >= 0.75;
      },
      describe: h => {
        const total = (h.home_su_wins || 0) + (h.away_su_wins || 0);
        const leader = (h.home_su_wins || 0) >= (h.away_su_wins || 0) ? 'Home' : 'Road';
        return `${leader} side has won ${Math.max(h.home_su_wins || 0, h.away_su_wins || 0)} of ${total} outright`;
      },
      side: 'any',
    },
  ];

  return {
    BUILD,
    scoreTrends,
    matchupTrends,
    attachMatchupTrends,
    historicalTrendsFor,
    supportingTrends,
    buildTrendLegs,
    addLegsToTicket,
    shrinkToMarket,
    buildTrendBets,
    buildParlay,
    parlayOdds,
    parlayProbability,
    TRENDS,
    TREND_MIN_SAMPLE,
    TREND_MIN_HIT_RATE,
    H2H_TRENDS,
    MIN_H2H_MEETINGS,
    DEFAULT_LEG_ODDS,
  };

  // ============================================================
  // ── LINE MOVEMENT HELPER ──
  // Reads the market snapshot physics persists onto every pick.
  // A pick qualifies if the number moved toward the side we took.
  // Market spread is signed from the home perspective, so a move
  // toward home means the number got more negative.
  // ============================================================

  function lineMovedTowardPick(p) {
    const snap = p.physics_output?.market_snapshot || p.market_snapshot || {};
    const open = num(snap.open_spread);
    const current = num(snap.spread);
    if (!open || !current) return false;
    if (open === current) return false;

    const movedTowardHome = current < open;
    if (p.direction === 'home') return movedTowardHome;
    if (p.direction === 'away') return !movedTowardHome;
    return false;
  }

  // ============================================================
  // ── TREND SCORING ──
  // ============================================================

  async function scoreTrends(options = {}) {
    const { days = TREND_WINDOW_DAYS, history = null } = options;

    const picks = history || await loadGradedPicks(days);
    const scored = TRENDS.map(trend => {
      const matches = picks.filter(p => {
        try { return trend.test(p); } catch { return false; }
      });

      const wins = matches.filter(p => p.result === 'W').length;
      const losses = matches.filter(p => p.result === 'L').length;
      const pushes = matches.filter(p => p.result === 'P').length;
      const settled = wins + losses;

      const units = matches.reduce((s, p) => s + (num(p.units) || 0), 0);
      const pnl = matches.reduce((s, p) => s + (num(p.pnl) || 0), 0);

      const hitRate = settled > 0 ? wins / settled : null;
      const roi = units > 0 ? pnl / units : null;

      const qualified = settled >= TREND_MIN_SAMPLE
                     && hitRate !== null
                     && hitRate >= TREND_MIN_HIT_RATE;

      return {
        id: trend.id,
        label: trend.label,
        describe: trend.describe,
        sample: settled,
        wins, losses, pushes,
        hit_rate: hitRate,
        roi,
        units: round(units, 2),
        pnl: round(pnl, 2),
        qualified,
        status: settled < TREND_MIN_SAMPLE
          ? `Needs ${TREND_MIN_SAMPLE - settled} more graded picks`
          : qualified
            ? 'Active'
            : 'Below threshold',
      };
    });

    scored.sort((a, b) => {
      if (a.qualified !== b.qualified) return a.qualified ? -1 : 1;
      return (b.hit_rate ?? 0) - (a.hit_rate ?? 0);
    });

    return scored;
  }

  async function loadGradedPicks(days) {
    const url = SUPABASE_URL();
    const key = SUPABASE_KEY();
    if (!url || !key) return [];

    const since = new Date(Date.now() - days * 86400000).toISOString();
    try {
      const res = await fetch(
        `${url}/rest/v1/shadow_picks?select=*&result=in.(W,L,P)&created_at=gte.${since}&order=created_at.desc&limit=5000`,
        { headers: { apikey: key, Authorization: `Bearer ${key}` } }
      );
      return res.ok ? await res.json() : [];
    } catch (e) {
      logEdgeError('parlay.loadGradedPicks', e);
      return [];
    }
  }

  // ============================================================
  // ── HEAD-TO-HEAD ──
  // ============================================================

  async function matchupTrends(sport, homeTeam, awayTeam) {
    if (!window.EDGE_ATS || typeof window.EDGE_ATS.getMatchupHistory !== 'function') {
      return { available: false, reason: 'ATS tracker not loaded', trends: [], h2h: null };
    }

    const h2h = await window.EDGE_ATS.getMatchupHistory(sport, homeTeam, awayTeam);
    if (!h2h) {
      return { available: false, reason: 'No meeting history on file', trends: [], h2h: null };
    }
    if ((h2h.meetings || 0) < MIN_H2H_MEETINGS) {
      return {
        available: false,
        reason: `Only ${h2h.meetings} meeting${h2h.meetings === 1 ? '' : 's'} on file — needs ${MIN_H2H_MEETINGS}`,
        trends: [], h2h,
      };
    }

    const hit = [];
    H2H_TRENDS.forEach(t => {
      let passes = false;
      try { passes = !!t.test(h2h); } catch { passes = false; }
      if (!passes) return;
      hit.push({
        id: t.id,
        label: t.label,
        detail: safeDescribe(t, h2h),
        side: t.side,
        meetings: h2h.meetings,
      });
    });

    return {
      available: true,
      trends: hit,
      h2h,
      meetings: h2h.meetings,
      last_meeting: h2h.last_meeting_date || null,
      recent_meetings: h2h.recent_meetings || [],
    };
  }

  async function attachMatchupTrends(picks) {
    const unique = new Map();
    picks.forEach(p => {
      const home = p.home_team, away = p.away_team, sport = p.sport;
      if (!home || !away || !sport) return;
      const key = `${sport}:${[home, away].sort().join('|')}`;
      if (!unique.has(key)) unique.set(key, { sport, home, away, picks: [] });
      unique.get(key).picks.push(p);
    });

    const entries = Array.from(unique.values());
    const results = await Promise.all(
      entries.map(e => matchupTrends(e.sport, e.home, e.away).catch(e2 => {
        logEdgeError('parlay.attachMatchupTrends', e2);
        return null;
      }))
    );

    entries.forEach((entry, i) => {
      const res = results[i];
      entry.picks.forEach(p => { p.matchup_trends = res; });
    });

    return picks;
  }

  function safeDescribe(trend, h2h) {
    try {
      return typeof trend.describe === 'function' ? trend.describe(h2h) : String(trend.describe || '');
    } catch { return ''; }
  }

  function pctText(v) {
    return v == null ? '—' : `${Math.round(v * 100)}%`;
  }

  // ============================================================
  // ── TREND LEGS ──
  // ============================================================

  function shrinkToMarket(hitRate, sample, marketProb) {
    const n = Math.max(0, sample || 0);
    const blended = (hitRate * n + marketProb * TREND_PRIOR_N) / (n + TREND_PRIOR_N);
    return clamp(blended, 0.05, TREND_MAX_PROB);
  }

  async function buildTrendLegs(games, options = {}) {
    const { minSample = TREND_MIN_SAMPLE_LEG, minHitRate = 0.65, minStreak = 4 } = options;
    if (!window.EDGE_TRENDS) return [];

    const legs = [];
    for (const game of games) {
      const start = new Date(game.commence_time || game.time).getTime();
      if (!isFinite(start) || start <= Date.now()) continue;

      let t;
      try { t = await window.EDGE_TRENDS.trendsForGame(game); }
      catch (e) { logEdgeError('parlay.buildTrendLegs.trendsForGame', e); continue; }

      [['home', t.home], ['away', t.away]].forEach(([side, block]) => {
        if (!block) return;
        (block.trends || []).forEach(tr => {
          if ((tr.sample || 0) < minSample) return;
          if ((tr.hit_rate || 0) < minHitRate && (tr.current_streak || 0) < minStreak) return;
          if (tr.market !== 'SU' && tr.market !== 'ATS') return;

          const odds = tr.market === 'SU'
            ? (side === 'home' ? game.home_ml ?? game.ml : game.away_ml)
            : (side === 'home' ? game.home_spread_price : game.away_spread_price) ?? DEFAULT_LEG_ODDS;
          if (odds == null) return;

          const marketProb = americanToImplied(odds);
          const modelProb = shrinkToMarket(tr.hit_rate || 0.5, tr.sample, marketProb);

          legs.push({
            pick_id: `${game.id}:${tr.situation_id}:${side}`,
            game_id: game.id,
            sport: game._sport || game.sport,
            matchup: `${game.away_team || game.away} @ ${game.home_team || game.home}`,
            side: side === 'home' ? (game.home_team || game.home) : (game.away_team || game.away),
            direction: side,
            market: tr.market === 'SU' ? 'moneyline' : 'spread',
            spread: tr.market === 'ATS'
              ? (side === 'home' ? game.spread : (game.spread != null ? -game.spread : null))
              : null,
            commence_time: game.commence_time || game.time,
            odds,
            decimal: americanToDecimal(odds),
            model_prob: round(modelProb, 4),
            market_prob: round(marketProb, 4),
            raw_hit_rate: tr.hit_rate,
            confidence: round(modelProb * 100, 1),
            edge: round(modelProb - marketProb, 4),
            source: 'trend',
            trend: {
              headline: tr.headline,
              scope: tr.scope,
              record: `${tr.wins}-${tr.losses}`,
              sample: tr.sample,
              streak: tr.current_streak,
              seasons: tr.seasons_covered,
            },
          });
        });
      });
    }

    legs.sort((a, b) => b.edge - a.edge);
    const seen = new Set();
    return legs.filter(l => {
      if (seen.has(l.game_id)) return false;
      seen.add(l.game_id);
      return true;
    });
  }

  function addLegsToTicket(parlay, extraLegs) {
    const used = new Set((parlay?.legs || []).map(l => l.game_id));
    const additions = (extraLegs || []).filter(l => !used.has(l.game_id));
    if (!additions.length) return parlay;
    const merged = [...(parlay?.legs || []), ...additions];
    const rebuilt = buildParlay(merged, {
      trendId: parlay?.trend_id || 'custom',
      trendLabel: parlay?.trend_label || 'Custom ticket',
    });
    rebuilt.trend = parlay?.trend || null;
    return rebuilt;
  }

  async function historicalTrendsFor(picks) {
    if (!window.EDGE_TRENDS) return {};
    const byGame = {};
    await Promise.all(picks.map(async p => {
      if (!p.game_id || !p.sport) return;
      try {
        const t = await window.EDGE_TRENDS.trendsForGame({
          id: p.game_id, sport: p.sport,
          home_team: p.home_team, away_team: p.away_team,
          spread: p.market_spread,
          commence_time: p.commence_time,
        });
        byGame[p.game_id] = t;
      } catch (e) { logEdgeError('parlay.historicalTrendsFor', e); }
    }));
    return byGame;
  }

  function supportingTrends(pick, gameTrends) {
    if (!gameTrends) return [];
    const side = pick.direction === 'home' ? gameTrends.home : gameTrends.away;
    if (!side) return [];
    return (side.trends || [])
      .filter(t => t.market === 'SU' || t.market === 'ATS')
      .filter(t => t.hit_rate >= 0.6 || t.current_streak >= 4)
      .sort((a, b) => (b.current_streak - a.current_streak) || (b.hit_rate - a.hit_rate))
      .slice(0, 4);
  }

  async function buildTrendBets(todaysPicks, options = {}) {
    const {
      maxLegs = MAX_LEGS,
      minLegs = MIN_LEGS,
      trendScores = null,
      minLegConfidence = 0,
    } = options;

    const scores = trendScores || await scoreTrends();
    const active = scores.filter(t => t.qualified);
    const out = [];

    const playable = todaysPicks.filter(p =>
      p.decision && p.decision !== 'PASS' && p.decision !== 'CAPPED' && p.decision !== 'VETOED');
    try { await attachMatchupTrends(playable); }
    catch (e) { logEdgeError('parlay.buildTrendBets.attachMatchup', e); }

    const histByGame = await historicalTrendsFor(playable);
    playable.forEach(p => {
      p.historical_trends = supportingTrends(p, histByGame[p.game_id]);
    });

    for (const score of active) {
      const trend = TRENDS.find(t => t.id === score.id);
      if (!trend) continue;

      const eligible = playable
        .filter(p => num(p.confidence) >= minLegConfidence)
        .filter(p => { try { return trend.test(p); } catch { return false; } });

      const legs = selectUncorrelatedLegs(eligible, maxLegs);
      if (legs.length < minLegs) continue;

      const parlay = buildParlay(legs, { trendId: score.id, trendLabel: score.label });
      parlay.trend = score;
      out.push(parlay);
    }

    const trendBacked = playable
      .filter(p => num(p.confidence) >= minLegConfidence)
      .filter(p => (p.historical_trends || []).length > 0);

    if (trendBacked.length >= minLegs) {
      const legs = selectUncorrelatedLegs(trendBacked, maxLegs);
      if (legs.length >= minLegs) {
        const parlay = buildParlay(legs, {
          trendId: 'historical_trends',
          trendLabel: 'Every leg carried by a live trend',
        });
        const totalStreak = legs.reduce((s, l) =>
          s + Math.max(0, ...(l.trends || []).map(t => t.streak || 0)), 0);
        parlay.trend = {
          id: 'historical_trends',
          label: 'Every leg carried by a live trend',
          describe: 'Each leg has a situational, streak or rivalry record behind it',
          sample: legs.reduce((s, l) => s + (l.trends || []).length, 0),
          hit_rate: null, roi: null, qualified: true,
          status: `${totalStreak} combined streak games`,
          source: 'trends',
        };
        out.push(parlay);
      }
    }

    const h2hBacked = playable
      .filter(p => num(p.confidence) >= minLegConfidence)
      .filter(p => {
        const mt = p.matchup_trends;
        if (!mt?.available) return false;
        return (mt.trends || []).some(t => t.side === 'any' || t.side === p.direction);
      });

    if (h2hBacked.length >= minLegs) {
      const legs = selectUncorrelatedLegs(h2hBacked, maxLegs);
      if (legs.length >= minLegs) {
        const parlay = buildParlay(legs, {
          trendId: 'h2h_series_backed',
          trendLabel: 'Series history backs every leg',
        });
        parlay.trend = {
          id: 'h2h_series_backed',
          label: 'Series history backs every leg',
          describe: 'Each leg is a matchup whose own head-to-head record points the same way the model does',
          sample: legs.reduce((s, l) => s + (l.h2h_meetings || 0), 0),
          hit_rate: null, roi: null, qualified: true,
          status: 'Head-to-head',
          source: 'h2h',
        };
        out.push(parlay);
      }
    }

    const byLegs = new Map();
    for (const p of out) {
      const key = p.legs.map(l => l.game_id).sort().join('|');
      const existing = byLegs.get(key);
      if (!existing || (p.trend?.hit_rate ?? 0) > (existing.trend?.hit_rate ?? 0)) {
        if (existing) {
          p.also_matches = (existing.also_matches || []).concat(existing.trend_label);
        }
        byLegs.set(key, p);
      } else {
        existing.also_matches = (existing.also_matches || []).concat(p.trend_label);
      }
    }

    const deduped = Array.from(byLegs.values());
    deduped.sort((a, b) => b.expected_value - a.expected_value);
    return deduped;
  }

  function selectUncorrelatedLegs(picks, maxLegs) {
    const seenGames = new Set();
    const sorted = [...picks].sort((a, b) => num(b.confidence) - num(a.confidence));
    const legs = [];

    for (const p of sorted) {
      const gid = p.game_id || p.pick_id;
      if (gid && seenGames.has(gid)) continue;
      if (gid) seenGames.add(gid);
      legs.push(p);
      if (legs.length >= maxLegs) break;
    }
    return legs;
  }

  // ============================================================
  // ── PARLAY MATH ──
  // ============================================================

  function buildParlay(picks, meta = {}) {
    const legs = picks.map(p => {
      const odds = legOdds(p);
      const modelProb = legProbability(p);
      const marketProb = americanToImplied(odds);
      const mt = p.matchup_trends || null;
      const agreeing = (mt?.trends || []).filter(t =>
        t.side === 'any' || t.side === p.direction);
      const movedToward = lineMovedTowardPick(p);

      return {
        pick_id: p.pick_id || p.game_id,
        game_id: p.game_id,
        sport: p.sport,
        h2h_meetings: mt?.meetings ?? 0,
        h2h_trends: (mt?.trends || []).map(t => t.label),
        h2h_supporting: agreeing.map(t => ({ label: t.label, detail: t.detail })),
        h2h_last_meeting: mt?.last_meeting || null,
        h2h_log: mt?.recent_meetings || [],
        h2h_note: mt?.available ? null : (mt?.reason || 'No series history'),
        trends: (p.historical_trends || []).map(t => ({
          headline: t.headline,
          market: t.market,
          record: `${t.wins}-${t.losses}`,
          hit_rate: t.hit_rate,
          streak: t.current_streak,
          seasons: t.seasons_covered,
          scope: t.scope,
        })),
        matchup: `${p.away_team || 'Away'} @ ${p.home_team || 'Home'}`,
        side: p.side_team || (p.direction === 'home' ? p.home_team : p.away_team) || p.direction,
        direction: p.direction,
        commence_time: p.commence_time || null,
        confidence: num(p.confidence),
        edge: num(p.edge),
        spread: p.market_spread ?? null,
        odds,
        odds_source: legOddsSource(p),
        decimal: americanToDecimal(odds),
        model_prob: round(modelProb, 4),
        market_prob: round(marketProb, 4),
        line_moved_toward_us: movedToward,
      };
    });

    const decimal = parlayOdds(legs);
    const modelProb = parlayProbability(legs);
    const marketProb = legs.reduce((acc, l) => acc * l.market_prob, 1);

    const payoutMultiple = decimal - 1;
    const ev = (modelProb * payoutMultiple) - (1 - modelProb);

    const kellyRaw = payoutMultiple > 0
      ? (payoutMultiple * modelProb - (1 - modelProb)) / payoutMultiple
      : 0;
    const kellyFractional = Math.max(kellyRaw * 0.10, 0);

    const bankroll = getBankroll();
    const unitSize = getUnitSize(bankroll);
    const rawUnits = (kellyFractional * bankroll) / unitSize;
    const units = ev > 0 ? clamp(roundToQuarter(rawUnits), 0, 1.5) : 0;

    return {
      trend_id: meta.trendId || null,
      trend_label: meta.trendLabel || null,
      legs,
      leg_count: legs.length,
      american_odds: decimalToAmerican(decimal),
      decimal_odds: round(decimal, 3),
      model_probability: round(modelProb, 4),
      market_probability: round(marketProb, 4),
      expected_value: round(ev, 4),
      kelly_raw: round(kellyRaw, 4),
      units,
      stake_dollars: round(units * unitSize, 2),
      to_win: round(units * unitSize * payoutMultiple, 2),
      verdict: ev > 0.05 ? 'STRONG' : ev > 0 ? 'PLAYABLE' : 'NO VALUE',
      computed_at: new Date().toISOString(),
    };
  }

  function parlayOdds(legs) {
    return legs.reduce((acc, l) => acc * (l.decimal || americanToDecimal(l.odds || DEFAULT_LEG_ODDS)), 1);
  }

  function parlayProbability(legs) {
    if (!legs.length) return 0;

    const shaded = legs.map(l => {
      const model = l.model_prob ?? 0.5;
      const market = l.market_prob ?? 0.5;
      return (1 - LEG_SHRINK) * model + LEG_SHRINK * market;
    });

    let prob = shaded.reduce((acc, p) => acc * p, 1);

    const bySport = {};
    legs.forEach(l => { bySport[l.sport] = (bySport[l.sport] || 0) + 1; });
    const clusters = Object.values(bySport).filter(n => n > 1);
    clusters.forEach(n => { prob *= (1 - SAME_SPORT_CORRELATION * (n - 1)); });

    return clamp(prob, 0, 1);
  }

  // Picks in the pipeline are spread picks. Their price is the
  // spread price — normally -110 — not the moneyline. Reading the
  // ML price as the payout on a spread leg overstates every parlay.
  function legOdds(p) {
    if (p.direction === 'home' && num(p.home_spread_price)) return num(p.home_spread_price);
    if (p.direction === 'away' && num(p.away_spread_price)) return num(p.away_spread_price);
    if (num(p.spread_price)) return num(p.spread_price);
    return DEFAULT_LEG_ODDS;
  }

  function legOddsSource(p) {
    if (p.direction === 'home' && num(p.home_spread_price)) return 'explicit_home';
    if (p.direction === 'away' && num(p.away_spread_price)) return 'explicit_away';
    if (num(p.spread_price)) return 'explicit_spread';
    return 'default_110';
  }

  function legProbability(pick) {
    // Prefer the governor's own posterior — it is the number the
    // pipeline actually bet on. Only use it when it is a genuine
    // probability in (0,1).
    const posterior = num(pick.governor_snapshot?.posterior_home_prob);
    if (posterior > 0 && posterior < 1) {
      return pick.direction === 'home' ? posterior : 1 - posterior;
    }

    // Fall back to confidence. This is a percent-scale number
    // already, so 65 becomes 0.65, not 0.825. The old formula
    // 0.5 + conf/200 treated a moderate pick as a strong one.
    const conf = num(pick.confidence);
    if (conf > 0) {
      const prob = clamp(conf / 100, 0.05, 0.95);
      return pick.direction === 'home' ? prob : 1 - prob;
    }
    return 0.5;
  }

  // ============================================================
  // ── UTILITIES ──
  // ============================================================

  function americanToImplied(ml) {
    if (!ml) return 0.5;
    return ml > 0 ? 100 / (ml + 100) : Math.abs(ml) / (Math.abs(ml) + 100);
  }

  function americanToDecimal(ml) {
    if (!ml) return 1.91;
    return ml > 0 ? (ml / 100) + 1 : (100 / Math.abs(ml)) + 1;
  }

  function decimalToAmerican(dec) {
    if (!dec || dec <= 1) return 0;
    return dec >= 2
      ? Math.round((dec - 1) * 100)
      : Math.round(-100 / (dec - 1));
  }

  function getBankroll() {
    const portfolio = localStorage.getItem('edge_active_portfolio') || 'real';
    const k = portfolio === 'sim' ? 'edge_sim_bankroll' : 'edge_bankroll';
    const b = parseFloat(localStorage.getItem(k) || '0');
    return b > 0 ? b : (portfolio === 'sim' ? 10000 : 1000);
  }

  function getUnitSize(bankroll) {
    const portfolio = localStorage.getItem('edge_active_portfolio') || 'real';
    if (portfolio === 'sim') {
      const s = parseFloat(localStorage.getItem('edge_sim_unit_size') || '100');
      return s > 0 ? s : 100;
    }
    const unitType = localStorage.getItem('edge_unit_type') || 'flat';
    if (unitType === 'pct') {
      const pct = parseFloat(localStorage.getItem('edge_unit_size') || '1');
      return (bankroll * pct) / 100;
    }
    const flat = parseFloat(localStorage.getItem('edge_unit_size') || '0');
    return flat > 0 ? flat : 50;
  }

  function num(v) { const n = parseFloat(v); return isFinite(n) ? n : 0; }
  function clamp(v, min, max) { return Math.max(min, Math.min(max, v)); }
  function round(v, d) { const f = Math.pow(10, d); return Math.round(v * f) / f; }
  function roundToQuarter(v) { return Math.round(v * 4) / 4; }

})();

if (typeof window !== 'undefined') window.EDGE_PARLAY = EDGE_PARLAY;