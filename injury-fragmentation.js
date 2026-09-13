// ============================================================
// EDGE — INJURY FRAGMENTATION v1.0
// Reads ESPN injuries for today's slate, looks up each injured
// player in the roster table, subtracts their offensive and
// defensive contribution from the team's power rating.
//
// Replaces the flat positional VORP guess in context-builder.js
// with exact per-player deductions sourced from the roster table.
// ============================================================

const EDGE_INJURY = (() => {

  const SUPABASE_URL = () => localStorage.getItem('edge_supabase_url');
  const SUPABASE_KEY = () => localStorage.getItem('edge_supabase_key');

  const ESPN_MAP = {
    NFL:   'football/nfl',
    NBA:   'basketball/nba',
    MLB:   'baseball/mlb',
    NHL:   'hockey/nhl',
    NCAAF: 'football/college-football',
    NCAAB: 'basketball/mens-college-basketball',
    MLS:   'soccer/usa.1',
  };

  // Cache TTL — injuries refresh slowly.
  const CACHE_KEY = 'edge_injury_cache_v2';
  const CACHE_TTL_MS = 30 * 60 * 1000; // 30 min

  // A player marked with one of these statuses reduces team power by
  // the fraction listed, multiplied by their exact contribution.
  const STATUS_MULTIPLIER = {
    'out': 1.0,
    'out for season': 1.0,
    'injured reserve': 1.0,
    'ir': 1.0,
    'suspended': 1.0,
    'doubtful': 0.80,
    'questionable': 0.35,
    'day-to-day': 0.20,
    'game-time decision': 0.40,
    'probable': 0.05,
  };

  return {
    fragment,
    getInjuriesForGame,
    getTeamFragmentation,
    invalidateCache,
    STATUS_MULTIPLIER,
  };

  // ============================================================
  // ── MAIN ──
  // Fragments an entire slate in one pass. Returns a map keyed
  // by game_id, each entry with home and away adjustments.
  // ============================================================

  async function fragment(games) {
    const out = {};
    if (!Array.isArray(games) || !games.length) return out;

    const url = SUPABASE_URL();
    const key = SUPABASE_KEY();
    if (!url || !key) return out;

    // Fetch ESPN injuries once per sport, cache in localStorage.
    const sports = Array.from(new Set(
      games.map(g => g._sport || g.sport).filter(s => s && ESPN_MAP[s])
    ));
    const injuriesBySport = {};
    for (const sport of sports) {
      injuriesBySport[sport] = await getCachedInjuries(sport);
    }

    // Collect every team on today's slate so we can pull their rosters
    // in a single round trip per sport instead of per team.
    const teamsBySport = {};
    games.forEach(g => {
      const sport = g._sport || g.sport;
      if (!ESPN_MAP[sport]) return;
      if (!teamsBySport[sport]) teamsBySport[sport] = new Set();
      teamsBySport[sport].add(g.home_team || g.home);
      teamsBySport[sport].add(g.away_team || g.away);
    });

    // Load players for those teams in one query per sport.
    const rosterBySport = {};
    for (const sport of Object.keys(teamsBySport)) {
      rosterBySport[sport] = await loadRosterForTeams(sport, Array.from(teamsBySport[sport]));
    }

    // Build the fragmentation for each game.
    for (const g of games) {
      const sport = g._sport || g.sport;
      const home = g.home_team || g.home;
      const away = g.away_team || g.away;
      if (!home || !away || !ESPN_MAP[sport]) continue;

      const rawInjuries = injuriesBySport[sport] || {};
      const roster = rosterBySport[sport] || {};

      const homeInjuries = matchInjuriesToRoster(
        rawInjuries[home] || [],
        roster[home] || []
      );
      const awayInjuries = matchInjuriesToRoster(
        rawInjuries[away] || [],
        roster[away] || []
      );

      out[g.id] = {
        home: homeInjuries,
        away: awayInjuries,
        home_off_deduction: sumDeduction(homeInjuries, 'offensive_contribution'),
        home_def_deduction: sumDeduction(homeInjuries, 'defensive_contribution'),
        away_off_deduction: sumDeduction(awayInjuries, 'offensive_contribution'),
        away_def_deduction: sumDeduction(awayInjuries, 'defensive_contribution'),
        net_off_edge: round(
          sumDeduction(awayInjuries, 'offensive_contribution') -
          sumDeduction(homeInjuries, 'offensive_contribution'), 2
        ),
        net_def_edge: round(
          sumDeduction(awayInjuries, 'defensive_contribution') -
          sumDeduction(homeInjuries, 'defensive_contribution'), 2
        ),
        fetched_at: new Date().toISOString(),
      };
    }

    return out;
  }

  // ============================================================
  // ── SINGLE GAME LOOKUP ──
  // ============================================================

  async function getInjuriesForGame(sport, homeTeam, awayTeam, gameId) {
    const result = await fragment([{
      id: gameId || `${homeTeam}_${awayTeam}`,
      _sport: sport, sport,
      home_team: homeTeam, home: homeTeam,
      away_team: awayTeam, away: awayTeam,
    }]);
    return result[gameId] || null;
  }

  async function getTeamFragmentation(sport, teamName, injuries) {
    const url = SUPABASE_URL();
    const key = SUPABASE_KEY();
    if (!url || !key) return null;

    const rosterRes = await fetch(
      `${url}/rest/v1/players?sport=eq.${sport}&team_name=eq.${encodeURIComponent(teamName)}&select=player_id,name,position,position_group,rating,offensive_contribution,defensive_contribution,is_starter`,
      { headers: { apikey: key, Authorization: `Bearer ${key}` } }
    );
    if (!rosterRes.ok) return null;
    const roster = await rosterRes.json();

    const matched = matchInjuriesToRoster(injuries || [], roster);

    return {
      players_out: matched,
      offensive_deduction: sumDeduction(matched, 'offensive_contribution'),
      defensive_deduction: sumDeduction(matched, 'defensive_contribution'),
    };
  }

  // ============================================================
  // ── ROSTER LOADING (batch per sport) ──
  // ============================================================

  async function loadRosterForTeams(sport, teamNames) {
    const url = SUPABASE_URL();
    const key = SUPABASE_KEY();
    if (!url || !key || !teamNames.length) return {};

    const inList = teamNames.map(n => `"${n}"`).join(',');
    try {
      const res = await fetch(
        `${url}/rest/v1/players?sport=eq.${sport}&team_name=in.(${inList})&select=player_id,name,position,position_group,rating,offensive_contribution,defensive_contribution,is_starter`,
        { headers: { apikey: key, Authorization: `Bearer ${key}` } }
      );
      if (!res.ok) return {};
      const rows = await res.json();

      const byTeam = {};
      rows.forEach(p => {
        if (!byTeam[p.team_name]) byTeam[p.team_name] = [];
        byTeam[p.team_name].push(p);
      });
      return byTeam;
    } catch { return {}; }
  }

  // ============================================================
  // ── MATCH INJURED PLAYERS TO ROSTER ENTRIES ──
  // ESPN injury feeds use display names. Roster uses the same.
  // Fallback to last-name match when full names differ slightly.
  // ============================================================

  function matchInjuriesToRoster(injuries, roster) {
    if (!injuries.length || !roster.length) return [];

    const byName = new Map();
    const byLastName = new Map();
    roster.forEach(p => {
      if (p.name) {
        byName.set(normalizeName(p.name), p);
        const parts = p.name.split(' ');
        if (parts.length) {
          const last = parts[parts.length - 1].toLowerCase();
          if (!byLastName.has(last)) byLastName.set(last, []);
          byLastName.get(last).push(p);
        }
      }
    });

    const matched = [];
    injuries.forEach(inj => {
      const name = normalizeName(inj.name || '');
      if (!name) return;

      let player = byName.get(name);

      if (!player) {
        const parts = name.split(' ');
        const last = parts[parts.length - 1];
        const candidates = byLastName.get(last) || [];
        if (candidates.length === 1) player = candidates[0];
      }

      if (!player) return;

      const status = (inj.status || '').toLowerCase().trim();
      const multiplier = STATUS_MULTIPLIER[status] ?? 0.25;

      matched.push({
        name: player.name,
        position: player.position,
        position_group: player.position_group,
        rating: player.rating,
        is_starter: player.is_starter,
        status: inj.status,
        multiplier,
        offensive_contribution: round((player.offensive_contribution || 0) * multiplier, 2),
        defensive_contribution: round((player.defensive_contribution || 0) * multiplier, 2),
      });
    });

    return matched;
  }

  function normalizeName(s) {
    return String(s || '')
      .toLowerCase()
      .replace(/[.'`\-]/g, '')
      .replace(/\s+/g, ' ')
      .trim();
  }

  function sumDeduction(injuries, field) {
    return round(injuries.reduce((s, i) => s + (i[field] || 0), 0), 2);
  }

  // ============================================================
  // ── ESPN INJURY FETCH ──
  // ============================================================

  async function getCachedInjuries(sport) {
    let cache = {};
    try { cache = JSON.parse(localStorage.getItem(CACHE_KEY) || '{}'); } catch {}

    const entry = cache[sport];
    if (entry && (Date.now() - entry.fetchedAt) < CACHE_TTL_MS) {
      return entry.byTeam;
    }

    const fresh = await fetchEspnInjuries(sport);
    cache[sport] = { fetchedAt: Date.now(), byTeam: fresh };
    try { localStorage.setItem(CACHE_KEY, JSON.stringify(cache)); } catch {}
    return fresh;
  }

  async function fetchEspnInjuries(sport) {
    const path = ESPN_MAP[sport];
    if (!path) return {};

    const urls = [
      `https://site.api.espn.com/apis/site/v2/sports/${path}/injuries`,
      `https://site.api.espn.com/apis/site/v2/sports/${path}/injuries?limit=500`,
    ];

    for (const url of urls) {
      try {
        const res = await fetch(url, { cache: 'no-store' });
        if (!res.ok) continue;
        const data = await res.json();
        const byTeam = parseEspnInjuries(data);
        if (Object.keys(byTeam).length) return byTeam;
      } catch {}
    }

    return {};
  }

  function parseEspnInjuries(data) {
    const byTeam = {};
    if (!data) return byTeam;

    const list =
      Array.isArray(data.injuries) ? data.injuries :
      Array.isArray(data.items)    ? data.items    :
      Array.isArray(data.athletes) ? data.athletes : [];

    list.forEach(entry => {
      const teamName =
        entry.team?.displayName ||
        entry.team?.name ||
        entry.teamName ||
        null;
      if (!teamName) return;

      const injuries = Array.isArray(entry.injuries) ? entry.injuries : [entry];

      if (!byTeam[teamName]) byTeam[teamName] = [];

      injuries.forEach(inj => {
        const athlete = inj.athlete || entry.athlete;
        const name = athlete?.displayName || athlete?.fullName || null;
        const position =
          athlete?.position?.abbreviation ||
          athlete?.position?.name ||
          inj.position?.abbreviation ||
          null;
        const status =
          (inj.status || entry.status || '').toString().toLowerCase().trim();

        if (!name) return;
        if (!status) return;

        byTeam[teamName].push({ name, position, status });
      });
    });

    return byTeam;
  }

  function invalidateCache(sport) {
    if (!sport) {
      localStorage.removeItem(CACHE_KEY);
      return;
    }
    try {
      const cache = JSON.parse(localStorage.getItem(CACHE_KEY) || '{}');
      delete cache[sport];
      localStorage.setItem(CACHE_KEY, JSON.stringify(cache));
    } catch {}
  }

  // ============================================================
  // ── UTILITIES ──
  // ============================================================

  function round(v, d) { const f = Math.pow(10, d); return Math.round(v * f) / f; }

})();

if (typeof window !== 'undefined') window.EDGE_INJURY = EDGE_INJURY;