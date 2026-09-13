// ============================================================
// EDGE — TREND BET / PARLAY ENGINE v1.0
// Mines graded shadow_picks for repeatable trends, then builds
// correlation-safe parlays out of today's qualifying picks.
// Deterministic. No Claude. Pure math.
// ============================================================

const EDGE_PARLAY = (() => {

  const SUPABASE_URL = () => localStorage.getItem('edge_supabase_url');
  const SUPABASE_KEY = () => localStorage.getItem('edge_supabase_key');

  // ── TUNING ──
  const TREND_WINDOW_DAYS   = 120;  // history considered when scoring a trend
  const TREND_MIN_SAMPLE    = 15;   // graded picks needed before a trend is usable
  const TREND_MIN_HIT_RATE  = 0.54; // below this a trend is not worth stacking
  const MAX_LEGS            = 4;
  const MIN_LEGS            = 2;
  const DEFAULT_LEG_ODDS    = -110;

  // Parlays compound model error, so each leg is shaded toward the market
  // before multiplying. Without this the product of nine optimistic legs
  // produces a fantasy probability.
  const LEG_SHRINK = 0.35;

  // Same-game legs are never combined. Same-sport, same-slate legs carry a
  // mild positive correlation that inflates naive parlay probability.
  const SAME_SPORT_CORRELATION = 0.04;

  // ── TREND DEFINITIONS ──
  // Each is a pure predicate over a stored pick row.
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
      test: p => Math.abs(num(p.market_spread)) > 0 && Math.abs(num(p.market_spread)) <= 3,
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

  // ── HEAD-TO-HEAD TRENDS ──
  // These are evaluated against matchup_ats — the actual meeting
  // history between the two teams on the ticket, not a league-wide
  // pattern. A pairing has to clear MIN_H2H_MEETINGS before any of
  // them count.
  const MIN_H2H_MEETINGS = 4;
  const H2H_EDGE = 0.65;   // cover rate that makes a series trend real

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
    scoreTrends,
    matchupTrends,
    attachMatchupTrends,
    buildTrendBets,
    buildParlay,
    parlayOdds,
    parlayProbability,
    TRENDS,
    TREND_MIN_SAMPLE,
    TREND_MIN_HIT_RATE,
    H2H_TRENDS,
    MIN_H2H_MEETINGS,
  };

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
    } catch { return []; }
  }

  // ============================================================
  // ── TREND BET CONSTRUCTION ──
  // Today's picks, filtered to a qualifying trend, assembled
  // into a correlation-safe parlay.
  // ============================================================

  // ============================================================
  // ── HEAD-TO-HEAD ──
  // Every trend that actually occurred in the historical meetings
  // between these two teams, with the meeting log behind it.
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

  // Attach series history to a list of picks in one pass, so a page
  // can render every ticket's H2H without N round trips of its own.
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
      entries.map(e => matchupTrends(e.sport, e.home, e.away).catch(() => null))
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

    // Load the meeting history for every game on today's board once,
    // up front. Legs then carry the series trends that produced them.
    const playable = todaysPicks.filter(p =>
      p.decision && p.decision !== 'PASS' && p.decision !== 'CAPPED' && p.decision !== 'VETOED');
    try { await attachMatchupTrends(playable); } catch {}

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

    // A ticket built purely from series history: every leg is a game
    // where the two teams' own meeting record points the same way the
    // model does. This is the head-to-head trend bet.
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
        // No league-wide sample behind this one — its evidence is the
        // meeting log on each leg, which is reported per leg.
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

    // Several trends often select the same legs. Keep one copy of each
    // distinct leg set, credited to the trend with the better record.
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

  // One leg per game, then highest confidence first.
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
      // Series trends that point the same way the model does.
      const agreeing = (mt?.trends || []).filter(t =>
        t.side === 'any' || t.side === p.direction);

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
        matchup: `${p.away_team || 'Away'} @ ${p.home_team || 'Home'}`,
        side: p.side_team || (p.direction === 'home' ? p.home_team : p.away_team) || p.direction,
        direction: p.direction,
        commence_time: p.commence_time || null,
        confidence: num(p.confidence),
        edge: num(p.edge),
        spread: p.market_spread ?? null,
        odds,
        decimal: americanToDecimal(odds),
        model_prob: round(modelProb, 4),
        market_prob: round(marketProb, 4),
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
    // Parlays get a harsher Kelly fraction than straight bets.
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

  // Naive independence overstates a parlay. Legs are shaded toward the
  // market first, then a same-sport correlation haircut is applied.
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

  function legProbability(p) {
    const posterior = num(p.governor_snapshot?.posterior_home_prob);
    if (posterior > 0) {
      return p.direction === 'home' ? posterior : 1 - posterior;
    }
    const conf = num(p.confidence);
    if (conf > 0) return clamp(0.5 + (conf / 200), 0.05, 0.95);
    return 0.5;
  }

  function legOdds(p) {
    // A spread pick is priced at standard juice unless the row carries a price.
    if (p.direction === 'home' && num(p.market_home_ml)) return num(p.market_home_ml);
    if (p.direction === 'away' && num(p.market_away_ml)) return num(p.market_away_ml);
    return DEFAULT_LEG_ODDS;
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