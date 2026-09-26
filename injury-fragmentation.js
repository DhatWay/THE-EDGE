// ============================================================
// EDGE — INJURY FRAGMENTATION v1.3
//
// Reads ESPN injuries for today's slate, looks up each injured
// player in the players table, subtracts their offensive and
// defensive contribution from the team's effective strength.
//
// v1.3 changes:
//
//   · team_name is loaded. The v1.2 code selected a fixed set
//     of columns from the players table and left team_name
//     out — but then grouped the rows by p.team_name. Every
//     player landed under a single undefined key, so the
//     per-team lookup that follows never matched an injury to
//     a roster. Injury deductions were always zero. team_name
//     is now in the select, in both the slate path and the
//     single-team path.
//
//   · Position group is loaded too, so a future matchup panel
//     can show the group alongside the injury.
//
//   · Roster read is resilient to a missing team_name column
//     in the response — the module logs once and returns empty
//     rather than silently grouping everything under
//     undefined.
//
// v1.2 changes (retained):
//   · Team list comes from power_ratings, not ESPN's /teams
//     endpoint.
//   · WNBA added.
//   · League-wide injury endpoints tried first, per-team core
//     API only if those fail.
// ============================================================

const EDGE_INJURY = (() => {

  const BUILD = 'inj-20260925-01';

  const SUPABASE_URL = () => localStorage.getItem('edge_supabase_url');
  const SUPABASE_KEY = () => localStorage.getItem('edge_supabase_key');

  const ESPN_MAP = {
    NFL:   { site: 'football/nfl',                       core: ['football','nfl'] },
    NCAAF: { site: 'football/college-football',          core: ['football','college-football'] },
    NBA:   { site: 'basketball/nba',                     core: ['basketball','nba'] },
    WNBA:  { site: 'basketball/wnba',                    core: ['basketball','wnba'] },
    NCAAB: { site: 'basketball/mens-college-basketball', core: ['basketball','mens-college-basketball'] },
    MLB:   { site: 'baseball/mlb',                       core: ['baseball','mlb'] },
    NHL:   { site: 'hockey/nhl',                         core: ['hockey','nhl'] },
    MLS:   { site: 'soccer/usa.1',                       core: ['soccer','usa.1'] },
  };

  const CACHE_KEY = 'edge_injury_cache_v3';
  const CACHE_TTL_MS = 30 * 60 * 1000;

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
    BUILD,
    fragment,
    getInjuriesForGame,
    getTeamFragmentation,
    invalidateCache,
    STATUS_MULTIPLIER,
  };

  // ============================================================
  // ── MAIN ──
  // ============================================================

  async function fragment(games) {
    const out = {};
    if (!Array.isArray(games) || !games.length) return out;

    const url = SUPABASE_URL();
    const key = SUPABASE_KEY();
    if (!url || !key) return out;

    const teamsBySport = {};
    games.forEach(g => {
      const sport = g._sport || g.sport;
      if (!ESPN_MAP[sport]) return;
      if (!teamsBySport[sport]) teamsBySport[sport] = new Set();
      teamsBySport[sport].add(g.home_team || g.home);
      teamsBySport[sport].add(g.away_team || g.away);
    });

    const sports = Object.keys(teamsBySport);
    if (!sports.length) return out;

    const injuryResults = {};
    await Promise.all(sports.map(async sport => {
      injuryResults[sport] = await getCachedInjuries(sport, teamsBySport[sport]);
    }));

    const rosterBySport = {};
    await Promise.all(sports.map(async sport => {
      rosterBySport[sport] = await loadRosterForTeams(sport, Array.from(teamsBySport[sport]), url, key);
    }));

    games.forEach(g => {
      const sport = g._sport || g.sport;
      const home = g.home_team || g.home;
      const away = g.away_team || g.away;
      if (!home || !away || !ESPN_MAP[sport]) return;

      const rawInjuries = injuryResults[sport] || {};
      const roster = rosterBySport[sport] || {};

      const homeInjuries = matchInjuriesToRoster(rawInjuries[home] || [], roster[home] || []);
      const awayInjuries = matchInjuriesToRoster(rawInjuries[away] || [], roster[away] || []);

      const homeOff = sumDeduction(homeInjuries, 'offensive_contribution');
      const homeDef = sumDeduction(homeInjuries, 'defensive_contribution');
      const awayOff = sumDeduction(awayInjuries, 'offensive_contribution');
      const awayDef = sumDeduction(awayInjuries, 'defensive_contribution');

      out[g.id] = {
        home: homeInjuries,
        away: awayInjuries,
        home_off_deduction: homeOff,
        home_def_deduction: homeDef,
        away_off_deduction: awayOff,
        away_def_deduction: awayDef,
        net_off_edge: round(awayOff - homeOff, 2),
        net_def_edge: round(awayDef - homeDef, 2),
        fetched_at: new Date().toISOString(),
      };
    });

    return out;
  }

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
      `${url}/rest/v1/players?sport=eq.${sport}&team_name=eq.${encodeURIComponent(teamName)}` +
      `&select=player_id,name,position,position_group,team_name,rating,offensive_contribution,defensive_contribution,is_starter`,
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
  // ── ROSTER LOADING ──
  //
  // team_name and position_group are both selected. Without
  // team_name the per-team grouping below collapsed every
  // player under a single undefined key — the injury family
  // was reading an empty roster for every team and reporting
  // zero deductions on every game.
  // ============================================================

  async function loadRosterForTeams(sport, teamNames, url, key) {
    if (!teamNames.length) return {};
    const inList = teamNames.map(n => `"${n}"`).join(',');

    try {
      const res = await fetch(
        `${url}/rest/v1/players?sport=eq.${sport}&team_name=in.(${inList})` +
        `&select=player_id,name,position,position_group,team_name,rating,offensive_contribution,defensive_contribution,is_starter`,
        { headers: { apikey: key, Authorization: `Bearer ${key}` } }
      );
      if (!res.ok) return {};
      const rows = await res.json();

      // Guard against a response where team_name is not
      // present. If every row lacks it, the select shape is
      // wrong and the caller needs to know — grouping under
      // undefined is what the previous version did silently.
      if (rows.length && rows[0].team_name === undefined) {
        logEdgeError('injury.loadRosterForTeams', new Error(
          'players response has no team_name column — check the select'));
        return {};
      }

      const byTeam = {};
      rows.forEach(p => {
        if (!p.team_name) return;
        if (!byTeam[p.team_name]) byTeam[p.team_name] = [];
        byTeam[p.team_name].push(p);
      });
      return byTeam;
    } catch (e) {
      logEdgeError('injury.loadRosterForTeams.fetch', e);
      return {};
    }
  }

  // ============================================================
  // ── MATCH INJURED PLAYERS TO ROSTER ──
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

  async function getCachedInjuries(sport, teamFilter) {
    let cache = {};
    try { cache = JSON.parse(localStorage.getItem(CACHE_KEY) || '{}'); } catch {}

    let entry = cache[sport];
    if (entry && (!entry.byTeam || !Object.keys(entry.byTeam).length)) entry = null;
    if (entry && (Date.now() - entry.fetchedAt) < CACHE_TTL_MS) {
      return entry.byTeam;
    }

    const fresh = await fetchEspnInjuries(sport, teamFilter);
    if (fresh && Object.keys(fresh).length) {
      cache[sport] = { fetchedAt: Date.now(), byTeam: fresh };
      try { localStorage.setItem(CACHE_KEY, JSON.stringify(cache)); } catch {}
    }
    return fresh || {};
  }

  async function fetchEspnInjuries(sport, teamFilter) {
    const cfg = ESPN_MAP[sport];
    if (!cfg) return {};

    const leagueUrls = [
      `https://site.web.api.espn.com/apis/site/v2/sports/${cfg.site}/injuries`,
      `https://site.api.espn.com/apis/site/v2/sports/${cfg.site}/injuries`,
    ];

    for (const url of leagueUrls) {
      try {
        const res = await fetch(url, { cache: 'no-store' });
        if (res.headers.get('x-edge-offline') === '1') continue;
        if (!res.ok) continue;
        const data = await res.json();
        const byTeam = parseEspnInjuries(data);
        if (Object.keys(byTeam).length) return byTeam;
      } catch {}
    }

    const teams = await fetchTeamsFromDb(sport);
    if (!teams.length) return {};

    const wanted = teamFilter && teamFilter.size
      ? teams.filter(t => teamFilter.has(t.name))
      : teams;

    const [espnSport, espnLeague] = cfg.core;
    const byTeam = {};

    await parallelMap(wanted, 5, async team => {
      const list = await fetchTeamInjuries(espnSport, espnLeague, team.id);
      if (list.length) byTeam[team.name] = list;
    });

    return byTeam;
  }

  async function fetchTeamsFromDb(sport) {
    const url = SUPABASE_URL();
    const key = SUPABASE_KEY();
    if (!url || !key) return [];

    try {
      const res = await fetch(
        `${url}/rest/v1/power_ratings?sport=eq.${sport}&select=team_id,team_name&order=team_name.asc&limit=500`,
        { headers: { apikey: key, Authorization: `Bearer ${key}` } }
      );
      if (!res.ok) return [];
      const rows = await res.json();
      return rows
        .filter(r => r.team_id && /^\d+$/.test(String(r.team_id)))
        .map(r => ({ id: String(r.team_id), name: r.team_name }));
    } catch { return []; }
  }

  async function fetchTeamInjuries(espnSport, espnLeague, teamId) {
    const base = `https://sports.core.api.espn.com/v2/sports/${espnSport}/leagues/${espnLeague}/teams/${teamId}/injuries?limit=100`;
    let items = [];
    try {
      const res = await fetch(base, { cache: 'no-store' });
      if (res.headers.get('x-edge-offline') === '1') return [];
      if (!res.ok) return [];
      const data = await res.json();
      items = data.items || [];
    } catch { return []; }
    if (!items.length) return [];

    const out = [];
    await parallelMap(items, 6, async item => {
      const url = refUrl(item.$ref);
      if (!url) return;
      try {
        const res = await fetch(url, { cache: 'no-store' });
        if (!res.ok) return;
        const inj = await res.json();

        const status = String(inj.status || inj.type?.description || '').toLowerCase().trim();
        if (!status) return;

        let name = inj.athlete?.displayName || null;
        let position = inj.athlete?.position?.abbreviation || null;

        if (!name && inj.athlete?.$ref) {
          const aUrl = refUrl(inj.athlete.$ref);
          if (aUrl) {
            try {
              const aRes = await fetch(aUrl, { cache: 'no-store' });
              if (aRes.ok) {
                const a = await aRes.json();
                name = a.displayName || a.fullName || null;
                position = a.position?.abbreviation || position;
              }
            } catch {}
          }
        }
        if (!name) return;
        out.push({ name, position, status });
      } catch {}
    });
    return out;
  }

  function refUrl(ref) {
    if (!ref) return null;
    return String(ref).replace('.pvt', '.com').replace(/^http:/, 'https:');
  }

  // ============================================================
  // ── PARSE LEAGUE-WIDE RESPONSE ──
  // ============================================================

  function parseEspnInjuries(data) {
    const byTeam = {};
    if (!data) return byTeam;

    const list =
      Array.isArray(data.injuries) ? data.injuries :
      Array.isArray(data.items)    ? data.items    :
      Array.isArray(data.athletes) ? data.athletes : [];

    list.forEach(entry => {
      const teamName =
        entry.displayName ||
        entry.team?.displayName ||
        entry.team?.name ||
        entry.teamName ||
        entry.name ||
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
    if (!sport) { localStorage.removeItem(CACHE_KEY); return; }
    try {
      const cache = JSON.parse(localStorage.getItem(CACHE_KEY) || '{}');
      delete cache[sport];
      localStorage.setItem(CACHE_KEY, JSON.stringify(cache));
    } catch {}
  }

  // ============================================================
  // ── UTILITIES ──
  // ============================================================

  async function parallelMap(items, concurrency, fn) {
    const queue = [...items];
    await Promise.all(Array.from({ length: concurrency }, async () => {
      while (queue.length) {
        const item = queue.shift();
        if (item === undefined) break;
        await fn(item);
      }
    }));
  }

  function logEdgeError(where, err) {
    try {
      const list = JSON.parse(localStorage.getItem('edge_errors') || '[]');
      list.unshift({ t: Date.now(), where, msg: err && err.message ? err.message : String(err) });
      localStorage.setItem('edge_errors', JSON.stringify(list.slice(0, 50)));
    } catch {}
  }

  function round(v, d) { const f = Math.pow(10, d); return Math.round(v * f) / f; }

})();

if (typeof window !== 'undefined') window.EDGE_INJURY = EDGE_INJURY;