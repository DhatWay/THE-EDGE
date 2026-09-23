// ============================================================
// EDGE — SITUATIONS ENGINE v2.0
//
// Encodes high-probability spots as testable rules. A situation
// is a specific condition that historically produces a winning
// side more often than the spread implies.
//
// Every rule is:
//   1. Specific (fires or doesn't)
//   2. Testable (win/loss can be graded against historical games)
//   3. Justifiable (there is a reason the spot produces an edge)
//
// The engine scores each game by counting which situations fire
// and on which side. High count = strong lean. Zero = pass.
//
// v2.0
//   · Rank-based thresholds. Absolute "overall >= 70" gates are
//     replaced with per-sport rank checks. The rating scale is
//     compressed by shrinkage — a raw threshold means a different
//     thing in every sport and fires for a different share of the
//     league in each. Rank is scale-free.
//   · Resolver injection. Slate can pass precomputed indexes and
//     a team-name resolver so names from the Odds API resolve to
//     the right row.
//   · Testability gate. Rules whose inputs are missing from the
//     context are reported as untestable, not as a silent zero.
//   · Per-rule weights. Backtest-measured weights flow in via
//     options.situationWeights and produce weighted_tally.
//   · New rules: away_off_bye, lost_last_week_by_14plus.
//   · Blocked rules declared explicitly: divisional_home_dog,
//     public_road_fav, public_road_dog — flagged, not dead.
// ============================================================

const EDGE_SITUATIONS = (() => {

  const BUILD = 'se-20260923-01';

  const SUPABASE_URL = () => localStorage.getItem('edge_supabase_url');
  const SUPABASE_KEY = () => localStorage.getItem('edge_supabase_key');

  // ============================================================
  // ── SITUATIONS LIBRARY ──
  //
  // Each situation has:
  //   id         — short name for storage
  //   label      — human-readable
  //   side       — 'home' | 'away' | 'underdog' | 'favorite'
  //                | 'under' | 'over' | 'self' | 'dynamic'
  //                | 'opponent_of_cold' | 'rested' | 'healthy'
  //   requires   — data sources the test needs. If any are missing
  //                from the context, the rule is untestable, not a
  //                silent zero.
  //   test       — fires or doesn't
  //   note       — optional, flags rules whose inputs are not yet
  //                collected. They still evaluate; they just never
  //                have a testable context today.
  // ============================================================

  const SITUATIONS = [

    // ── POWER RATING SPOTS ──
    // Rank-based. "Top 10" means top 10 teams by that field in
    // that sport's power_ratings table, not an absolute score.

    {
      id: 'elite_home_small_fav',
      label: 'Top-10 team at home laying less than a touchdown',
      side: 'home',
      requires: ['power', 'line'],
      test: (g, c) => {
        if (g.spread == null) return false;
        if (!c.isTop(c.sport, 'overall', c.homeName, 10)) return false;
        return g.spread <= 0 && g.spread >= -6.5;
      },
    },
    {
      id: 'elite_away_small_fav',
      label: 'Top-10 team on the road laying less than a touchdown',
      side: 'away',
      requires: ['power', 'line'],
      test: (g, c) => {
        if (g.spread == null) return false;
        if (!c.isTop(c.sport, 'overall', c.awayName, 10)) return false;
        return g.spread >= 0 && g.spread <= 6.5;
      },
    },
    {
      id: 'weak_home_big_fav',
      label: 'Bottom-10 team at home laying a touchdown or more — fade',
      side: 'away',
      requires: ['power', 'line'],
      test: (g, c) => {
        if (g.spread == null) return false;
        if (!c.isBottom(c.sport, 'overall', c.homeName, 10)) return false;
        return g.spread <= -7;
      },
    },
    {
      id: 'weak_away_big_fav',
      label: 'Bottom-10 team on the road laying a touchdown or more — fade',
      side: 'home',
      requires: ['power', 'line'],
      test: (g, c) => {
        if (g.spread == null) return false;
        if (!c.isBottom(c.sport, 'overall', c.awayName, 10)) return false;
        return g.spread >= 7;
      },
    },
    {
      id: 'elite_home_dog',
      label: 'Top-10 team at home getting points — rare value',
      side: 'home',
      requires: ['power', 'line'],
      test: (g, c) => {
        if (g.spread == null) return false;
        if (!c.isTop(c.sport, 'overall', c.homeName, 10)) return false;
        return g.spread > 0;
      },
    },
    {
      id: 'elite_away_dog',
      label: 'Top-10 team on the road getting points — rare value',
      side: 'away',
      requires: ['power', 'line'],
      test: (g, c) => {
        if (g.spread == null) return false;
        if (!c.isTop(c.sport, 'overall', c.awayName, 10)) return false;
        return g.spread < 0;
      },
    },
    {
      // Side resolved from which team is rated higher, not from
      // the spread. If the spread has the higher-rated team as
      // the underdog, this points at that team, not at the
      // nominal favourite.
      id: 'power_gap_high',
      label: 'Rating gap 15+ but line under 10 — mispriced',
      side: 'dynamic',
      requires: ['power', 'line'],
      test: (g, c) => {
        if (g.spread == null) return false;
        if (!c.homePower || !c.awayPower) return false;
        const homeR = c.homePower.composite_points ?? c.homePower.overall ?? null;
        const awayR = c.awayPower.composite_points ?? c.awayPower.overall ?? null;
        if (homeR == null || awayR == null) return false;

        const gap = Math.abs(homeR - awayR);
        if (gap < 15) return false;
        if (Math.abs(g.spread) >= 10) return false;

        c._dynamicSide = homeR > awayR ? 'home' : 'away';
        return true;
      },
    },

    // ── OFFENSE vs DEFENSE ──

    {
      id: 'top_off_vs_bottom_def_small_line',
      label: 'Top-5 offense vs bottom-10 defense with line under 7',
      side: 'dynamic',
      requires: ['power', 'line'],
      test: (g, c) => {
        if (g.spread == null) return false;
        if (Math.abs(g.spread) > 7) return false;

        const homeTopOff = c.isTop(c.sport, 'offense', c.homeName, 5);
        const awayTopOff = c.isTop(c.sport, 'offense', c.awayName, 5);
        const homeWeakDef = c.isBottom(c.sport, 'defense', c.homeName, 10);
        const awayWeakDef = c.isBottom(c.sport, 'defense', c.awayName, 10);

        if (homeTopOff && awayWeakDef) { c._dynamicSide = 'home'; return true; }
        if (awayTopOff && homeWeakDef) { c._dynamicSide = 'away'; return true; }
        return false;
      },
    },
    {
      id: 'elite_defense_home_dog',
      label: 'Top-10 defense as a home dog — low-scoring spot',
      side: 'home',
      requires: ['power', 'line'],
      test: (g, c) => {
        if (g.spread == null) return false;
        if (!c.isTop(c.sport, 'defense', c.homeName, 10)) return false;
        return g.spread > 0 && g.spread <= 10;
      },
    },

    // ── ATS FORM ──

    {
      id: 'hot_ats_team',
      label: 'Team on a 4+ game ATS cover streak',
      side: 'self',
      requires: ['ats'],
      test: (g, c) => {
        const h = c.homeAts, a = c.awayAts;
        if (h && h.current_streak >= 4) { c._selfSide = 'home'; return true; }
        if (a && a.current_streak >= 4) { c._selfSide = 'away'; return true; }
        return false;
      },
    },
    {
      id: 'cold_ats_team_fade',
      label: 'Team on a 4+ game ATS losing streak — fade',
      side: 'opponent_of_cold',
      requires: ['ats'],
      test: (g, c) => {
        const h = c.homeAts, a = c.awayAts;
        if (h && h.current_streak <= -4) { c._coldSide = 'home'; return true; }
        if (a && a.current_streak <= -4) { c._coldSide = 'away'; return true; }
        return false;
      },
    },
    {
      id: 'both_teams_hot_ats',
      label: 'Both teams 60%+ ATS last 10 — sharp market',
      side: 'pass',
      requires: ['ats'],
      test: (g, c) => {
        const h = c.homeAts, a = c.awayAts;
        if (!h || !a) return false;
        return (h.last10_cover_pct >= 0.60) && (a.last10_cover_pct >= 0.60);
      },
    },
    {
      id: 'home_strong_home_ats',
      label: 'Home team 70%+ ATS at home this season',
      side: 'home',
      requires: ['ats'],
      test: (g, c) => {
        const h = c.homeAts;
        if (!h) return false;
        return h.home_cover_pct >= 0.70 && (h.home_wins || 0) >= 3;
      },
    },
    {
      id: 'away_strong_road_ats',
      label: 'Away team 70%+ ATS on the road this season',
      side: 'away',
      requires: ['ats'],
      test: (g, c) => {
        const a = c.awayAts;
        if (!a) return false;
        return a.away_cover_pct >= 0.70 && (a.away_wins || 0) >= 3;
      },
    },

    // ── HEAD TO HEAD ──

    {
      id: 'h2h_home_owns_series',
      label: 'Home team has covered 70%+ in this series',
      side: 'home',
      requires: ['h2h'],
      test: (g, c) => {
        if (!c.h2h) return false;
        if ((c.h2h.meetings || 0) < 5) return false;
        const homeIsA = c.h2h.team_a === c.homeName;
        const homeCover = homeIsA ? c.h2h.team_a_cover_pct : c.h2h.team_b_cover_pct;
        return homeCover != null && homeCover >= 0.70;
      },
    },
    {
      id: 'h2h_away_owns_series',
      label: 'Away team has covered 70%+ in this series',
      side: 'away',
      requires: ['h2h'],
      test: (g, c) => {
        if (!c.h2h) return false;
        if ((c.h2h.meetings || 0) < 5) return false;
        const homeIsA = c.h2h.team_a === c.homeName;
        const awayCover = homeIsA ? c.h2h.team_b_cover_pct : c.h2h.team_a_cover_pct;
        return awayCover != null && awayCover >= 0.70;
      },
    },
    {
      id: 'h2h_series_close',
      label: 'This series stays inside the number (avg < 3 pts)',
      side: 'underdog',
      requires: ['h2h'],
      test: (g, c) => {
        if (!c.h2h) return false;
        if ((c.h2h.meetings || 0) < 5) return false;
        return Math.abs(c.h2h.avg_home_cover_margin || 0) <= 3;
      },
    },

    // ── REST ──

    {
      id: 'home_off_bye',
      label: 'Home team off a bye week',
      side: 'home',
      requires: ['rest'],
      test: (g, c) => c.homeRestDays != null && c.homeRestDays >= 13,
    },
    {
      id: 'away_off_bye',
      label: 'Away team off a bye week',
      side: 'away',
      requires: ['rest'],
      test: (g, c) => c.awayRestDays != null && c.awayRestDays >= 13,
    },
    {
      id: 'away_short_week',
      label: 'Away team on short rest (Thursday)',
      side: 'home',
      requires: ['rest'],
      test: (g, c) => c.awayRestDays != null && c.awayRestDays <= 4,
    },
    {
      id: 'rest_disparity_4plus',
      label: 'Rest advantage of 4+ days',
      side: 'rested',
      requires: ['rest'],
      test: (g, c) => {
        if (c.homeRestDays == null || c.awayRestDays == null) return false;
        const diff = c.homeRestDays - c.awayRestDays;
        if (Math.abs(diff) < 4) return false;
        c._restedSide = diff > 0 ? 'home' : 'away';
        return true;
      },
    },

    // ── TRAVEL ──

    {
      id: 'cross_country_travel',
      label: 'Away team cross-country (>2500 miles)',
      side: 'home',
      requires: ['travel'],
      test: (g, c) => c.travelMiles != null && c.travelMiles > 2500,
    },
    {
      id: 'timezone_shift_3plus',
      label: 'Away team 3+ timezone shift',
      side: 'home',
      requires: ['travel'],
      test: (g, c) => c.timezoneShift != null && Math.abs(c.timezoneShift) >= 3,
    },

    // ── MARKET ──
    // These depend on line movement captured before kickoff.
    // historical_odds does not store open_spread yet, so during a
    // backtest these are untestable unless open_spread is present
    // on the game row. Live slate has it via line_history.

    {
      id: 'rlm_against_home',
      label: 'Public on home but line moved away — RLM',
      side: 'away',
      requires: ['line_open', 'line_public'],
      test: (g, c) => {
        if (g.spread == null || g.open_spread == null) return false;
        const move = g.spread - g.open_spread;
        const publicPct = c.lineHistory?.public_pct;
        if (publicPct == null) return false;
        return publicPct > 60 && move > 0.5;
      },
    },
    {
      id: 'rlm_against_away',
      label: 'Public on away but line moved away — RLM',
      side: 'home',
      requires: ['line_open', 'line_public'],
      test: (g, c) => {
        if (g.spread == null || g.open_spread == null) return false;
        const move = g.spread - g.open_spread;
        const publicPct = c.lineHistory?.public_pct;
        if (publicPct == null) return false;
        return publicPct < 40 && move < -0.5;
      },
    },
    {
      id: 'line_moved_2plus_toward_home',
      label: 'Line moved 2+ points toward home',
      side: 'home',
      requires: ['line_open'],
      test: (g, c) => {
        if (g.spread == null || g.open_spread == null) return false;
        return (g.open_spread - g.spread) >= 2;
      },
    },
    {
      id: 'line_moved_2plus_toward_away',
      label: 'Line moved 2+ points toward away',
      side: 'away',
      requires: ['line_open'],
      test: (g, c) => {
        if (g.spread == null || g.open_spread == null) return false;
        return (g.spread - g.open_spread) >= 2;
      },
    },

    // ── INJURY ──

    {
      id: 'home_qb_out',
      label: 'Home starting QB out',
      side: 'away',
      requires: ['injuries'],
      test: (g, c) => (c.homeInjuries || []).some(i =>
        i.status === 'out' && /QB|quarterback/i.test(i.position || '')),
    },
    {
      id: 'away_qb_out',
      label: 'Away starting QB out',
      side: 'home',
      requires: ['injuries'],
      test: (g, c) => (c.awayInjuries || []).some(i =>
        i.status === 'out' && /QB|quarterback/i.test(i.position || '')),
    },
    {
      id: 'net_injury_edge_3plus',
      label: 'Net injury advantage of 3+ rating points',
      side: 'healthy',
      requires: ['injuries'],
      test: (g, c) => {
        const home = (c.homeOffDeduction || 0) + (c.homeDefDeduction || 0);
        const away = (c.awayOffDeduction || 0) + (c.awayDefDeduction || 0);
        const diff = away - home;
        if (Math.abs(diff) < 3) return false;
        c._healthySide = diff > 0 ? 'home' : 'away';
        return true;
      },
    },

    // ── WEATHER ──

    {
      id: 'cold_weather_under',
      label: 'Cold weather under spot (temp ≤ 25°F)',
      side: 'under',
      requires: ['weather'],
      test: (g, c) => c.weather?.temp_f != null && c.weather.temp_f <= 25,
    },
    {
      id: 'high_wind_under',
      label: 'High wind under spot (wind effect ≥ 18mph)',
      side: 'under',
      requires: ['weather'],
      test: (g, c) => c.weather?.wind_effect_mph != null && c.weather.wind_effect_mph >= 18,
    },

    // ── PREVIOUS GAME (needs schedule history in context) ──

    {
      id: 'lost_last_week_by_14plus',
      label: 'Team off a 14+ point loss last week',
      side: 'self',
      requires: ['prev_game'],
      test: (g, c) => {
        const hm = c.homePrevMargin;
        const am = c.awayPrevMargin;
        if (hm != null && hm <= -14) { c._selfSide = 'home'; return true; }
        if (am != null && am <= -14) { c._selfSide = 'away'; return true; }
        return false;
      },
      note: 'requires prev_game context — not yet wired from context-builder',
    },
    {
      id: 'won_last_week_by_14plus_fade',
      label: 'Team off a 14+ point win last week — fade spot',
      side: 'opponent_of_self',
      requires: ['prev_game'],
      test: (g, c) => {
        const hm = c.homePrevMargin;
        const am = c.awayPrevMargin;
        if (hm != null && hm >= 14) { c._selfSide = 'home'; return true; }
        if (am != null && am >= 14) { c._selfSide = 'away'; return true; }
        return false;
      },
      note: 'requires prev_game context — not yet wired from context-builder',
    },

    // ── BLOCKED — declared, flagged, not dead ──

    {
      id: 'divisional_home_dog_6plus',
      label: 'Home dog getting 6+ in a divisional game',
      side: 'home',
      requires: ['divisional', 'line'],
      test: (g, c) => {
        if (!c.isDivisional) return false;
        if (g.spread == null) return false;
        return g.spread >= 6;
      },
      note: 'divisional flag not yet supplied by context-builder',
    },
    {
      id: 'public_road_fav',
      label: 'Public team laying -7 or more on the road',
      side: 'home',
      requires: ['line', 'line_public'],
      test: (g, c) => {
        if (g.spread == null) return false;
        if (g.spread > -7) return false;
        const publicPct = c.lineHistory?.public_pct;
        if (publicPct == null) return false;
        // Public siding with the road favourite would put pct on the away side,
        // which this context cannot yet distinguish. Kept for structure.
        return false;
      },
      note: 'per-side public money not yet collected — rule cannot fire until data exists',
    },
  ];

  // ============================================================
  // ── TESTABILITY ──
  // A rule is testable only if the context actually contains the
  // data its test reads. This is separate from "the condition was
  // false" — an untestable rule contributes no sample, a testable
  // rule that didn't fire contributes a sample of zero.
  // ============================================================

  function isTestable(rule, g, c) {
    if (!rule.requires || !rule.requires.length) return true;
    return rule.requires.every(req => {
      switch (req) {
        case 'power':       return !!(c.homePower && c.awayPower);
        case 'line':        return g.spread != null && g.spread !== undefined;
        case 'ats':         return !!(c.homeAts || c.awayAts);
        case 'h2h':         return !!c.h2h;
        case 'line_open':   return g.open_spread != null;
        case 'line_public': return c.lineHistory?.public_pct != null;
        case 'rest':        return c.homeRestDays != null && c.awayRestDays != null;
        case 'travel':      return c.travelMiles != null || c.timezoneShift != null;
        case 'weather':     return !!c.weather;
        case 'injuries':    return (c.homeInjuries?.length || 0) + (c.awayInjuries?.length || 0) > 0;
        case 'prev_game':   return c.homePrevMargin != null || c.awayPrevMargin != null;
        case 'divisional':  return c.isDivisional === true || c.isDivisional === false;
        default:            return true;
      }
    });
  }

  // ============================================================
  // ── RANKING ──
  // Built once per evaluateSlate call from the power index. Rank is
  // 1-indexed, 1 = highest value in that field for that sport.
  // ============================================================

  function buildRankings(powerIndex) {
    const bySport = {};

    Object.entries(powerIndex || {}).forEach(([key, row]) => {
      const i = key.indexOf(':');
      if (i < 0) return;
      const sport = key.slice(0, i);
      const name = key.slice(i + 1);
      if (!row) return;

      if (!bySport[sport]) bySport[sport] = { rows: [], fields: {} };
      bySport[sport].rows.push({ name, row });
    });

    Object.entries(bySport).forEach(([sport, bucket]) => {
      const fieldsToRank = ['overall', 'offense', 'defense', 'composite_points'];
      fieldsToRank.forEach(field => {
        const list = bucket.rows
          .filter(({ row }) => row[field] != null)
          .map(({ name, row }) => ({ name, value: Number(row[field]) }))
          .sort((a, b) => b.value - a.value);
        const rankMap = new Map();
        list.forEach((entry, i) => rankMap.set(entry.name, i + 1));
        bucket.fields[field] = { rankMap, count: rankMap.size };
      });
    });

    return bySport;
  }

  function rankOf(rankings, sport, field, name) {
    const b = rankings?.[sport];
    if (!b || !b.fields?.[field]) return null;
    return b.fields[field].rankMap.get(name) ?? null;
  }

  function isTop(rankings, sport, field, name, n) {
    const r = rankOf(rankings, sport, field, name);
    return r != null && r <= n;
  }

  function isBottom(rankings, sport, field, name, n) {
    const b = rankings?.[sport];
    if (!b || !b.fields?.[field]) return false;
    const r = b.fields[field].rankMap.get(name);
    if (r == null) return false;
    const total = b.fields[field].count;
    return r >= total - n + 1;
  }

  // ============================================================
  // ── TEAM RESOLUTION ──
  // Precompute one EDGE_TEAMS index per sport so each lookup does
  // not rebuild it. When EDGE_TEAMS is absent, exact name matching
  // is the only path.
  // ============================================================

  function buildSportResolvers(powerIndex, atsIndex, h2hIndex) {
    const out = {};
    if (!window.EDGE_TEAMS) return out;

    const sports = new Set();
    [powerIndex, atsIndex, h2hIndex].forEach(idx => {
      Object.keys(idx || {}).forEach(k => {
        const i = k.indexOf(':');
        if (i > 0) sports.add(k.slice(0, i));
      });
    });

    sports.forEach(sport => {
      const powerPool = entriesForSport(powerIndex, sport).map(([k, v]) => ({
        team_name: k.slice(sport.length + 1), _row: v,
      }));
      const atsPool = entriesForSport(atsIndex, sport).map(([k, v]) => ({
        team_name: k.slice(sport.length + 1), _row: v,
      }));
      const h2hPool = entriesForSport(h2hIndex, sport).map(([k, v]) => ({
        team_name: k.slice(sport.length + 1), _row: v,
      }));

      out[sport] = {
        power: window.EDGE_TEAMS.buildIndex(powerPool, sport),
        ats:   window.EDGE_TEAMS.buildIndex(atsPool, sport),
        h2h:   window.EDGE_TEAMS.buildIndex(h2hPool, sport),
      };
    });

    return out;
  }

  function entriesForSport(index, sport) {
    if (!index) return [];
    const prefix = sport + ':';
    return Object.entries(index).filter(([k]) => k.startsWith(prefix));
  }

  function lookup(index, sport, name, resolvers, bucket) {
    if (!name) return null;
    const direct = index[`${sport}:${name}`];
    if (direct) return direct;

    const r = resolvers?.[sport]?.[bucket];
    if (!r || !window.EDGE_TEAMS) return null;
    const match = window.EDGE_TEAMS.resolveTeam(name, r, sport);
    return match?._row || null;
  }

  // ============================================================
  // ── SIDE RESOLUTION ──
  // ============================================================

  function resolveSide(sitSide, g, c) {
    switch (sitSide) {
      case 'home':              return 'home';
      case 'away':              return 'away';
      case 'under':             return 'under';
      case 'over':              return 'over';
      case 'pass':              return 'pass';
      case 'dynamic':           return c._dynamicSide || 'pass';
      case 'self':              return c._selfSide || 'home';
      case 'opponent_of_self':  return c._selfSide === 'home' ? 'away'
                                     : c._selfSide === 'away' ? 'home' : 'pass';
      case 'opponent_of_cold':  return c._coldSide === 'home' ? 'away'
                                     : c._coldSide === 'away' ? 'home' : 'pass';
      case 'rested':            return c._restedSide || 'home';
      case 'healthy':           return c._healthySide || 'home';
      case 'favorite': {
        if (g.spread == null) return 'home';
        return g.spread < 0 ? 'home' : 'away';
      }
      case 'underdog': {
        if (g.spread == null) return 'home';
        return g.spread < 0 ? 'away' : 'home';
      }
      default: return 'pass';
    }
  }

  function clearScratch(c) {
    c._dynamicSide = null;
    c._selfSide = null;
    c._coldSide = null;
    c._restedSide = null;
    c._healthySide = null;
  }

  // ============================================================
  // ── EVALUATE SLATE ──
  // ============================================================

  async function evaluateSlate(games, context, options = {}) {
    const {
      powerIndex = null,
      atsIndex = null,
      h2hIndex = null,
      situationWeights = null,
    } = options;

    if (!Array.isArray(games) || !games.length) return [];

    const url = SUPABASE_URL();
    const key = SUPABASE_KEY();

    const power = powerIndex || (url && key ? await loadPower(url, key) : {});
    const ats   = atsIndex   || (url && key ? await loadAts(url, key)   : {});
    const h2h   = h2hIndex   || (url && key ? await loadH2H(url, key)   : {});

    const rankings = buildRankings(power);
    const resolvers = buildSportResolvers(power, ats, h2h);

    const lineHist = context?.lineHistoryByGame || {};

    const out = [];

    for (const g of games) {
      const sport = g._sport || g.sport;
      const homeName = g.home_team || g.home;
      const awayName = g.away_team || g.away;

      if (!sport || !homeName || !awayName) continue;

      const h2hKey = findH2HKey(h2h, sport, homeName, awayName, resolvers);
      const travel = context?.travelByGame?.[g.id] || {};

      const c = {
        sport,
        homeName,
        awayName,

        homePower: lookup(power, sport, homeName, resolvers, 'power'),
        awayPower: lookup(power, sport, awayName, resolvers, 'power'),
        homeAts:   lookup(ats,   sport, homeName, resolvers, 'ats'),
        awayAts:   lookup(ats,   sport, awayName, resolvers, 'ats'),

        h2h: h2hKey ? h2h[h2hKey] : null,

        lineHistory: lineHist[g.id] || null,

        homeRestDays: context?.restByTeam?.[`${sport}:${homeName}`] ?? null,
        awayRestDays: context?.restByTeam?.[`${sport}:${awayName}`] ?? null,
        travelMiles:  travel.miles ?? null,
        timezoneShift: travel.timezones ?? null,
        weather:      context?.weatherByGame?.[g.id] || null,

        homeInjuries:  context?.injuriesByGame?.[g.id]?.home || [],
        awayInjuries:  context?.injuriesByGame?.[g.id]?.away || [],
        homeOffDeduction: context?.injuriesByGame?.[g.id]?.home_off_deduction || 0,
        homeDefDeduction: context?.injuriesByGame?.[g.id]?.home_def_deduction || 0,
        awayOffDeduction: context?.injuriesByGame?.[g.id]?.away_off_deduction || 0,
        awayDefDeduction: context?.injuriesByGame?.[g.id]?.away_def_deduction || 0,

        homePrevMargin: g.home_prev_margin ?? null,
        awayPrevMargin: g.away_prev_margin ?? null,
        isDivisional: g.is_divisional ?? null,

        isTop:    (sp, f, n2, n) => isTop(rankings, sp, f, n2, n),
        isBottom: (sp, f, n2, n) => isBottom(rankings, sp, f, n2, n),
        rankOf:   (sp, f, n2)    => rankOf(rankings, sp, f, n2),

        _dynamicSide: null,
        _selfSide: null,
        _coldSide: null,
        _restedSide: null,
        _healthySide: null,
      };

      const fired = [];
      const untestable = [];

      for (const sit of SITUATIONS) {
        if (!isTestable(sit, g, c)) {
          untestable.push(sit.id);
          continue;
        }

        let hit = false;
        try { hit = !!sit.test(g, c); }
        catch { hit = false; }

        if (!hit) {
          clearScratch(c);
          continue;
        }

        const side = resolveSide(sit.side, g, c);
        const weight = situationWeights?.[sit.id] ?? 1;

        fired.push({
          id: sit.id,
          label: sit.label,
          side,
          weight,
          side_source: sit.side,
          note: sit.note || null,
        });

        clearScratch(c);
      }

      const tally = { home: 0, away: 0, under: 0, over: 0, pass: 0 };
      const weightedTally = { home: 0, away: 0, under: 0, over: 0, pass: 0 };

      fired.forEach(f => {
        if (tally[f.side] != null) tally[f.side]++;
        if (weightedTally[f.side] != null) weightedTally[f.side] += f.weight;
      });

      const { lean, strength } = deriveLean(tally);
      const { lean: weightedLean, strength: weightedStrength } = deriveLean(weightedTally);

      out.push({
        game_id: g.id,
        sport,
        home: homeName,
        away: awayName,
        spread: g.spread ?? null,
        open_spread: g.open_spread ?? null,
        total: g.total ?? null,

        situations: fired,
        untestable,

        tally,
        lean,
        strength,

        weighted_tally: weightedTally,
        weighted_lean: weightedLean,
        weighted_strength: weightedStrength,

        testable_count: SITUATIONS.length - untestable.length,
      });
    }

    return out;
  }

  function deriveLean(tally) {
    const sorted = Object.entries(tally).sort((a, b) => b[1] - a[1]);
    const top = sorted[0];
    const second = sorted[1];
    const lean = top[1] >= 2 && (top[1] - second[1]) >= 2 ? top[0] : 'pass';
    return { lean, strength: top[1] };
  }

  function findH2HKey(h2h, sport, home, away, resolvers) {
    if (!h2h) return null;

    const tryKey = (a, b) => {
      const sorted = [a, b].sort();
      const k = `${sport}:${sorted[0]}|${sorted[1]}`;
      return h2h[k] ? k : null;
    };

    const direct = tryKey(home, away);
    if (direct) return direct;

    if (!window.EDGE_TEAMS) return null;
    const r = resolvers?.[sport]?.h2h;
    if (!r) return null;

    const h = window.EDGE_TEAMS.resolveTeam(home, r, sport);
    const a = window.EDGE_TEAMS.resolveTeam(away, r, sport);
    if (!h || !a) return null;

    return tryKey(h.team_name, a.team_name);
  }

  // ============================================================
  // ── DATA LOADERS ──
  // Only used when the caller did not inject indexes.
  // ============================================================

  async function loadPower(url, key) {
    const out = {};
    try {
      const res = await fetch(`${url}/rest/v1/power_ratings?select=*&limit=5000`,
        { headers: { apikey: key, Authorization: `Bearer ${key}` } });
      if (res.ok) {
        (await res.json()).forEach(r => { out[`${r.sport}:${r.team_name}`] = r; });
      }
    } catch {}
    return out;
  }

  async function loadAts(url, key) {
    const out = {};
    try {
      const res = await fetch(`${url}/rest/v1/team_ats?select=*&limit=5000`,
        { headers: { apikey: key, Authorization: `Bearer ${key}` } });
      if (res.ok) {
        (await res.json()).forEach(r => { out[`${r.sport}:${r.team_name}`] = r; });
      }
    } catch {}
    return out;
  }

  async function loadH2H(url, key) {
    const out = {};
    try {
      const res = await fetch(`${url}/rest/v1/matchup_ats?select=*&limit=5000`,
        { headers: { apikey: key, Authorization: `Bearer ${key}` } });
      if (res.ok) {
        (await res.json()).forEach(r => {
          const k = `${r.sport}:${[r.team_a, r.team_b].sort().join('|')}`;
          out[k] = r;
        });
      }
    } catch {}
    return out;
  }

  // ============================================================
  // ── EXPORTS ──
  // ============================================================

  return {
    BUILD,
    evaluateSlate,
    SITUATIONS,
    isTestable,
    buildRankings,
    rankOf,
    isTop,
    isBottom,
  };

})();

if (typeof window !== 'undefined') window.EDGE_SITUATIONS = EDGE_SITUATIONS;