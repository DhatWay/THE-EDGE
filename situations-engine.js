// ============================================================
// EDGE — SITUATIONS ENGINE v1.0
//
// Encodes high-probability spots as testable rules. A situation
// is a specific condition that historically produces a winning
// side more often than the spread implies.
//
// Every rule here is:
//   1. Specific (fires or doesn't)
//   2. Testable (win/loss can be graded against historical games)
//   3. Justifiable (there is a reason the spot produces an edge)
//
// The engine scores each game by counting how many situations
// fire and on which side. High count = strong lean. Zero = pass.
//
// This is the deterministic core. Claude sits on top as an
// overlay, never as the source of the pick.
// ============================================================

const EDGE_SITUATIONS = (() => {

  const SUPABASE_URL = () => localStorage.getItem('edge_supabase_url');
  const SUPABASE_KEY = () => localStorage.getItem('edge_supabase_key');

  // ============================================================
  // ── SITUATIONS LIBRARY ──
  // Each situation has:
  //   id          — short name for storage
  //   label       — human-readable
  //   side        — 'home' | 'away' | 'underdog' | 'favorite' | 'over' | 'under'
  //   test(game, ctx) → true if the situation fires
  //   requires    — which data sources the test needs
  // ============================================================

  const SITUATIONS = [

    // ── POWER RATING SPOTS ──

    {
      id: 'elite_home_small_fav',
      label: 'Elite home team laying less than a touchdown',
      side: 'home',
      requires: ['power', 'line'],
      test: (g, c) => {
        const p = c.homePower;
        if (!p) return false;
        if (p.overall < 70) return false;
        if (g.spread == null) return false;
        return g.spread <= 0 && g.spread >= -6.5;
      },
    },
    {
      id: 'elite_away_small_fav',
      label: 'Elite road team laying less than a touchdown',
      side: 'away',
      requires: ['power', 'line'],
      test: (g, c) => {
        const p = c.awayPower;
        if (!p) return false;
        if (p.overall < 70) return false;
        if (g.spread == null) return false;
        return g.spread >= 0 && g.spread <= 6.5;
      },
    },
    {
      id: 'weak_home_big_fav',
      label: 'Weak home team laying a touchdown or more — fade spot',
      side: 'away',
      requires: ['power', 'line'],
      test: (g, c) => {
        const p = c.homePower;
        if (!p) return false;
        if (p.overall > 55) return false;
        if (g.spread == null) return false;
        return g.spread <= -7;
      },
    },
    {
      id: 'weak_away_big_fav',
      label: 'Weak road team laying a touchdown or more — fade spot',
      side: 'home',
      requires: ['power', 'line'],
      test: (g, c) => {
        const p = c.awayPower;
        if (!p) return false;
        if (p.overall > 55) return false;
        if (g.spread == null) return false;
        return g.spread >= 7;
      },
    },
    {
      id: 'elite_home_dog',
      label: 'Elite home team getting points — rare value',
      side: 'home',
      requires: ['power', 'line'],
      test: (g, c) => {
        const p = c.homePower;
        if (!p) return false;
        if (p.overall < 68) return false;
        if (g.spread == null) return false;
        return g.spread > 0;
      },
    },
    {
      id: 'elite_away_dog',
      label: 'Elite road team getting points — rare value',
      side: 'away',
      requires: ['power', 'line'],
      test: (g, c) => {
        const p = c.awayPower;
        if (!p) return false;
        if (p.overall < 68) return false;
        if (g.spread == null) return false;
        return g.spread < 0;
      },
    },
    {
      id: 'power_gap_high',
      label: 'Power gap 15+ but line under 10 — mispriced',
      side: 'favorite',
      requires: ['power', 'line'],
      test: (g, c) => {
        if (!c.homePower || !c.awayPower) return false;
        if (g.spread == null) return false;
        const gap = Math.abs(c.homePower.overall - c.awayPower.overall);
        if (gap < 15) return false;
        return Math.abs(g.spread) < 10;
      },
    },

    // ── OFFENSE VS DEFENSE ──

    {
      id: 'top_off_vs_bottom_def_small_line',
      label: 'Top-5 offense vs bottom-5 defense with line under 7',
      side: 'favorite',
      requires: ['power', 'line'],
      test: (g, c) => {
        if (!c.homePower || !c.awayPower) return false;
        if (g.spread == null) return false;
        if (Math.abs(g.spread) > 7) return false;
        const homeHighOff = c.homePower.offense >= 70;
        const awayHighOff = c.awayPower.offense >= 70;
        const homeWeakDef = c.homePower.defense <= 40;
        const awayWeakDef = c.awayPower.defense <= 40;
        return (homeHighOff && awayWeakDef) || (awayHighOff && homeWeakDef);
      },
    },
    {
      id: 'elite_defense_home_dog',
      label: 'Elite defense as a home dog — low-scoring spot',
      side: 'home',
      requires: ['power', 'line'],
      test: (g, c) => {
        if (!c.homePower) return false;
        if (c.homePower.defense < 72) return false;
        if (g.spread == null) return false;
        return g.spread > 0 && g.spread <= 10;
      },
    },

    // ── ATS FORM ──

    {
      id: 'hot_ats_team',
      label: 'Team on 4+ game ATS cover streak',
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
      label: 'Team on 4+ game ATS losing streak — fade',
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

    // ── SITUATIONAL / REST ──

    {
      id: 'home_off_bye',
      label: 'Home team off a bye week',
      side: 'home',
      requires: ['rest'],
      test: (g, c) => {
        return c.homeRestDays != null && c.homeRestDays >= 13;
      },
    },
    {
      id: 'away_short_week',
      label: 'Away team on short rest (Thursday)',
      side: 'home',
      requires: ['rest'],
      test: (g, c) => {
        return c.awayRestDays != null && c.awayRestDays <= 4;
      },
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
    {
      id: 'cross_country_travel',
      label: 'Away team cross-country (>2500 miles)',
      side: 'home',
      requires: ['travel'],
      test: (g, c) => {
        return c.travelMiles != null && c.travelMiles > 2500;
      },
    },
    {
      id: 'timezone_shift_3plus',
      label: 'Away team 3+ timezone shift',
      side: 'home',
      requires: ['travel'],
      test: (g, c) => {
        return c.timezoneShift != null && Math.abs(c.timezoneShift) >= 3;
      },
    },

    // ── MARKET ──

    {
      id: 'rlm_against_home',
      label: 'Public on home but line moved away — RLM',
      side: 'away',
      requires: ['line_history'],
      test: (g, c) => {
        if (!c.lineHistory) return false;
        if (g.spread == null || g.open_spread == null) return false;
        const move = g.spread - g.open_spread;
        const publicPct = c.lineHistory.public_pct;
        if (publicPct == null) return false;
        return publicPct > 60 && move > 0.5;
      },
    },
    {
      id: 'rlm_against_away',
      label: 'Public on away but line moved away — RLM',
      side: 'home',
      requires: ['line_history'],
      test: (g, c) => {
        if (!c.lineHistory) return false;
        if (g.spread == null || g.open_spread == null) return false;
        const move = g.spread - g.open_spread;
        const publicPct = c.lineHistory.public_pct;
        if (publicPct == null) return false;
        return publicPct < 40 && move < -0.5;
      },
    },
    {
      id: 'line_moved_2plus_toward_home',
      label: 'Line moved 2+ points toward home',
      side: 'home',
      requires: ['line_history'],
      test: (g, c) => {
        if (g.spread == null || g.open_spread == null) return false;
        return (g.open_spread - g.spread) >= 2;
      },
    },
    {
      id: 'line_moved_2plus_toward_away',
      label: 'Line moved 2+ points toward away',
      side: 'away',
      requires: ['line_history'],
      test: (g, c) => {
        if (g.spread == null || g.open_spread == null) return false;
        return (g.spread - g.open_spread) >= 2;
      },
    },

    // ── INJURY / PLAYER SIGNAL ──

    {
      id: 'home_qb_out',
      label: 'Home starting QB out',
      side: 'away',
      requires: ['injuries'],
      test: (g, c) => {
        return (c.homeInjuries || []).some(i =>
          i.status === 'out' && /QB|quarterback/i.test(i.position || ''));
      },
    },
    {
      id: 'away_qb_out',
      label: 'Away starting QB out',
      side: 'home',
      requires: ['injuries'],
      test: (g, c) => {
        return (c.awayInjuries || []).some(i =>
          i.status === 'out' && /QB|quarterback/i.test(i.position || ''));
      },
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

    // ── ENVIRONMENT ──

    {
      id: 'cold_weather_under',
      label: 'Cold weather under spot (temp ≤ 25°F)',
      side: 'under',
      requires: ['weather'],
      test: (g, c) => {
        if (!c.weather) return false;
        return c.weather.temp_f != null && c.weather.temp_f <= 25;
      },
    },
    {
      id: 'high_wind_under',
      label: 'High wind under spot (wind effect ≥ 18mph)',
      side: 'under',
      requires: ['weather'],
      test: (g, c) => {
        if (!c.weather) return false;
        return c.weather.wind_effect_mph != null && c.weather.wind_effect_mph >= 18;
      },
    },

  ];

  return {
    evaluateSlate,
    SITUATIONS,
  };

  // ============================================================
  // ── EVALUATE SLATE ──
  // For each game, run every situation and collect what fired.
  // Returns per-game results with a lean side and strength.
  // ============================================================

  async function evaluateSlate(games, context) {
    const url = SUPABASE_URL();
    const key = SUPABASE_KEY();
    if (!url || !key) throw new Error('Supabase not connected');

    // Preload what each game needs
    const power = await loadPower(url, key);
    const ats = await loadAts(url, key);
    const h2h = await loadH2H(url, key);
    const lineHist = context?.lineHistoryByGame || {};

    const out = [];

    for (const g of games) {
      const sport = g._sport || g.sport;
      const home = g.home_team || g.home;
      const away = g.away_team || g.away;
      const hk = `${sport}:${home}`;
      const ak = `${sport}:${away}`;

      const c = {
        homePower: power[hk] || null,
        awayPower: power[ak] || null,
        homeAts: ats[hk] || null,
        awayAts: ats[ak] || null,
        h2h: h2h[g.id] || findH2H(h2h, sport, home, away),
        lineHistory: lineHist[g.id] || null,
        homeRestDays: context?.restByTeam?.[hk] ?? null,
        awayRestDays: context?.restByTeam?.[ak] ?? null,
        travelMiles: context?.travelByGame?.[g.id]?.miles ?? null,
        timezoneShift: context?.travelByGame?.[g.id]?.timezones ?? null,
        weather: context?.weatherByGame?.[g.id] || null,
        homeInjuries: context?.injuriesByGame?.[g.id]?.home || [],
        awayInjuries: context?.injuriesByGame?.[g.id]?.away || [],
        homeOffDeduction: context?.injuriesByGame?.[g.id]?.home_off_deduction || 0,
        homeDefDeduction: context?.injuriesByGame?.[g.id]?.home_def_deduction || 0,
        awayOffDeduction: context?.injuriesByGame?.[g.id]?.away_off_deduction || 0,
        awayDefDeduction: context?.injuriesByGame?.[g.id]?.away_def_deduction || 0,
        homeName: home,
        awayName: away,
        // scratch fields for situations that need to report which side fired
        _selfSide: null,
        _coldSide: null,
        _restedSide: null,
        _healthySide: null,
      };

      const fired = [];
      for (const sit of SITUATIONS) {
        let hit = false;
        try { hit = !!sit.test(g, c); }
        catch { hit = false; }
        if (!hit) continue;

        // Resolve the side
        let side = sit.side;
        if (side === 'self') side = c._selfSide || 'home';
        else if (side === 'opponent_of_cold') side = c._coldSide === 'home' ? 'away' : 'home';
        else if (side === 'rested') side = c._restedSide || 'home';
        else if (side === 'healthy') side = c._healthySide || 'home';
        else if (side === 'favorite') {
          if (g.spread == null) side = 'home';
          else side = g.spread < 0 ? 'home' : 'away';
        }
        else if (side === 'underdog') {
          if (g.spread == null) side = 'home';
          else side = g.spread < 0 ? 'away' : 'home';
        }
        else if (side === 'pass') side = 'pass';

        fired.push({ id: sit.id, label: sit.label, side });

        // Clear scratch so the next situation doesn't inherit
        c._selfSide = null;
        c._coldSide = null;
        c._restedSide = null;
        c._healthySide = null;
      }

      // Tally by side
      const tally = { home: 0, away: 0, under: 0, over: 0, pass: 0 };
      fired.forEach(f => { if (tally[f.side] != null) tally[f.side]++; });

      // The lean is the side with the most fires, provided it's at
      // least 2 ahead of the next. Below that it's a pass.
      const sorted = Object.entries(tally).sort((a, b) => b[1] - a[1]);
      const top = sorted[0];
      const second = sorted[1];
      const lean = top[1] >= 2 && (top[1] - second[1]) >= 2 ? top[0] : 'pass';

      out.push({
        game_id: g.id,
        sport,
        home,
        away,
        spread: g.spread,
        total: g.total,
        situations: fired,
        tally,
        lean,
        strength: top[1],
      });
    }

    return out;
  }

  // ============================================================
  // ── DATA LOADERS ──
  // ============================================================

  async function loadPower(url, key) {
    const out = {};
    try {
      const res = await fetch(`${url}/rest/v1/power_ratings?select=*&limit=5000`,
        { headers: { apikey: key, Authorization: `Bearer ${key}` } });
      if (res.ok) {
        (await res.json()).forEach(r => {
          out[`${r.sport}:${r.team_name}`] = r;
        });
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
        (await res.json()).forEach(r => {
          out[`${r.sport}:${r.team_name}`] = r;
        });
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

  function findH2H(index, sport, home, away) {
    const k = `${sport}:${[home, away].sort().join('|')}`;
    return index[k] || null;
  }

})();

if (typeof window !== 'undefined') window.EDGE_SITUATIONS = EDGE_SITUATIONS;