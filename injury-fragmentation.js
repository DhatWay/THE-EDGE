// ============================================================
// EDGE — INJURY FRAGMENTATION v1.4
//
// Reads ESPN injuries for today's slate, looks up each injured
// player in the players table, subtracts their offensive and
// defensive contribution from the team's effective strength.
//
// v1.4 changes:
//
//   · Team names are normalized on both sides before any
//     lookup. The previous version used the game's own team
//     name — The Odds API spelling — as the key into a table
//     that is written by ESPN and keyed by ESPN's spelling.
//     "LA Clippers" in the game did not match "Los Angeles
//     Clippers" in the roster; "D.C. United" did not match
//     "DC United". Every injury lookup for every team whose
//     two spellings differed returned an empty roster and
//     reported zero deductions. Every team in every sport now
//     goes through EDGE_TEAMS.normalize before matching.
//
//   · loadRosterForTeams loads the sport's full roster once
//     and groups by normalized team name, instead of asking
//     the database for an in-list built from raw game team
//     names. A single query against players table, small
//     enough to run on every pipeline stage.
//
//   · fetchEspnInjuries builds a normalized team filter so
//     the per-team core API fallback still runs against the
//     right team ids. Without it, an Odds-API-spelled team
//     name in the filter would never match the power_ratings
//     row that carries the ESPN id, and the fallback would
//     request every team in the sport.
//
// v1.3 changes (retained):
//   · team_name is loaded in the roster select.
//   · Position group is loaded too.
// ============================================================

const EDGE_INJURY = (() => {

  const BUILD = 'inj-20260930-01';

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

  // v4: injury records carry the date ESPN reported them.
  const CACHE_KEY = 'edge_injury_cache_v4';

  // Long-term absences reported more than this many days ago are
  // already in the team's results — and in the line — so they are
  // not counted again. A player placed on IR this week still counts.
  const LONG_TERM_STATUSES = new Set(['injured reserve', 'ir', 'out for season', 'suspended', 'pup', 'physically unable to perform']);
  const LONG_TERM_RECENT_DAYS = 21;

  // Deductions are expressed as a percent of the team's regular
  // lineup: its top N players by contribution. Raw sums of every
  // listed player ran to -180 to -270 per team, which the injury
  // vote (built for gaps of 1.5 to 5) read as maximum on every game.
  const LINEUP_SIZE = { NFL: 22, NCAAF: 22, NBA: 8, WNBA: 8, NCAAB: 8, MLB: 14, NHL: 19, MLS: 11 };
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

  const PLAYER_COLUMNS =
    'player_id,name,position,position_group,team_name,rating,' +
    'offensive_contribution,defensive_contribution,is_starter';

  function logEdgeError(where, err) {
    try {
      const list = JSON.parse(localStorage.getItem('edge_errors') || '[]');
      list.unshift({ t: Date.now(), where, msg: err && err.message ? err.message : String(err) });
      localStorage.setItem('edge_errors', JSON.stringify(list.slice(0, 50)));
    } catch {}
  }

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

    // Collect the distinct teams in the slate per sport. The
    // set is used both to filter the injury fetch and to build
    // the roster index — normalized so the Odds API spelling
    // and the ESPN spelling land on the same key.
    const teamsBySport = {};
    games.forEach(g => {
      const sport = g._sport || g.sport;
      if (!ESPN_MAP[sport]) return;
      if (!teamsBySport[sport]) teamsBySport[sport] = new Set();
      const home = g.home_team || g.home;
      const away = g.away_team || g.away;
      if (home) teamsBySport[sport].add(home);
      if (away) teamsBySport[sport].add(away);
    });

    const sports = Object.keys(teamsBySport);
    if (!sports.length) return out;

    const injuryResults = {};
    await Promise.all(sports.map(async sport => {
      injuryResults[sport] = await getCachedInjuries(sport, teamsBySport[sport]);
    }));

    const rosterBySport = {};
    await Promise.all(sports.map(async sport => {
      rosterBySport[sport] = await loadRosterIndex(sport, url, key);
    }));

    games.forEach(g => {
      const sport = g._sport || g.sport;
      const home = g.home_team || g.home;
      const away = g.away_team || g.away;
      if (!home || !away || !ESPN_MAP[sport]) return;

      const injuries = injuryResults[sport] || {};
      const roster = rosterBySport[sport] || {};

      const homeNorm = normalizeTeam(sport, home);
      const awayNorm = normalizeTeam(sport, away);

      const homeInjuries = matchInjuriesToRoster(injuries[homeNorm] || [], roster[homeNorm] || []);
      const awayInjuries = matchInjuriesToRoster(injuries[awayNorm] || [], roster[awayNorm] || []);

      // Percent of each team's regular lineup missing.
      const homeScale = lineupScale(sport, roster[homeNorm] || []);
      const awayScale = lineupScale(sport, roster[awayNorm] || []);
      const homeOff = round(sumDeduction(homeInjuries, 'offensive_contribution') * homeScale, 2);
      const homeDef = round(sumDeduction(homeInjuries, 'defensive_contribution') * homeScale, 2);
      const awayOff = round(sumDeduction(awayInjuries, 'offensive_contribution') * awayScale, 2);
      const awayDef = round(sumDeduction(awayInjuries, 'defensive_contribution') * awayScale, 2);

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

    const rosterIndex = await loadRosterIndex(sport, url, key);
    const roster = rosterIndex[normalizeTeam(sport, teamName)] || [];
    const matched = matchInjuriesToRoster(injuries || [], roster);

    return {
      players_out: matched,
      offensive_deduction: sumDeduction(matched, 'offensive_contribution'),
      defensive_deduction: sumDeduction(matched, 'defensive_contribution'),
    };
  }

  // ============================================================
  // ── ROSTER INDEX ──
  //
  // Loads the sport's full roster in one query and groups by
  // normalized team name. This is what makes the injured-player
  // lookup work whether the game carries the Odds API spelling
  // or ESPN's own. The player table for any single sport is a
  // few thousand rows — small enough to fetch on every
  // pipeline stage.
  // ============================================================

  async function loadRosterIndex(sport, url, key) {
    const out = {};
    const pageSize = 1000;

    for (let offset = 0; offset < 200000; offset += pageSize) {
      try {
        const res = await fetch(
          `${url}/rest/v1/players?sport=eq.${sport}` +
          `&select=${PLAYER_COLUMNS}` +
          `&order=id.asc&limit=${pageSize}&offset=${offset}`,
          { headers: { apikey: key, Authorization: `Bearer ${key}` } }
        );
        if (!res.ok) break;
        const rows = await res.json();
        rows.forEach(p => {
          if (!p.team_name) return;
          const k = normalizeTeam(sport, p.team_name);
          if (!k) return;
          if (!out[k]) out[k] = [];
          out[k].push(p);
        });
        if (rows.length < pageSize) break;
      } catch (e) {
        logEdgeError('injury.loadRosterIndex.' + sport, e);
        break;
      }
    }

    return out;
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
      let multiplier = STATUS_MULTIPLIER[status] ?? 0.25;

      if (LONG_TERM_STATUSES.has(status)) {
        const reported = inj.date ? new Date(inj.date).getTime() : NaN;
        const recent = isFinite(reported) && (Date.now() - reported) <= LONG_TERM_RECENT_DAYS * 86400000;
        if (!recent) return;
      }

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

  // 100 / (combined contribution of the team's top N players), so a
  // deduction times this is a percent of the regular lineup.
  function lineupScale(sport, players) {
    const n = LINEUP_SIZE[sport] || 11;
    const top = players
      .map(p => (Number(p.offensive_contribution) || 0) + (Number(p.defensive_contribution) || 0))
      .sort((a, b) => b - a)
      .slice(0, n)
      .reduce((s, v) => s + v, 0);
    return top > 0 ? 100 / top : 0;
  }

  function sumDeduction(injuries, field) {
    return round(injuries.reduce((s, i) => s + (i[field] || 0), 0), 2);
  }

  function normalizeTeam(sport, name) {
    if (!name) return '';
    if (window.EDGE_TEAMS && typeof window.EDGE_TEAMS.normalize === 'function') {
      try { return window.EDGE_TEAMS.normalize(name, sport); }
      catch {}
    }
    return String(name).toLowerCase().replace(/[^a-z0-9]/g, '');
  }

  // ============================================================
  // ── ESPN INJURY FETCH ──
  //
  // Injuries come back keyed by ESPN displayName. They are
  // re-keyed by normalized name so the lookup from the game
  // object, which carries The Odds API spelling, matches.
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

    // Normalize the caller's team filter once. Any lookup below
    // against ESPN display names goes through the same
    // normalization, so an Odds API spelling matches an ESPN
    // spelling.
    const wantedNorm = new Set();
    if (teamFilter && teamFilter.size) {
      teamFilter.forEach(t => wantedNorm.add(normalizeTeam(sport, t)));
    }

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
        const byTeam = parseEspnInjuries(sport, data);
        if (Object.keys(byTeam).length) return byTeam;
      } catch {}
    }

    // Fallback: per-team core API. Uses the power_ratings table
    // for the ESPN team ids, filtered to just the teams in this
    // slate after normalization.
    const teams = await fetchTeamsFromDb(sport);
    if (!teams.length) return {};

    const wanted = wantedNorm.size
      ? teams.filter(t => wantedNorm.has(normalizeTeam(sport, t.name)))
      : teams;

    const [espnSport, espnLeague] = cfg.core;
    const byNorm = {};

    await parallelMap(wanted, 5, async team => {
      const list = await fetchTeamInjuries(espnSport, espnLeague, team.id);
      if (!list.length) return;
      const norm = normalizeTeam(sport, team.name);
      if (!norm) return;
      if (!byNorm[norm]) byNorm[norm] = [];
      byNorm[norm].push(...list);
    });

    return byNorm;
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
  //
  // Re-keys the ESPN response, which is keyed by display name,
  // into a normalized key. This is what makes the game lookup
  // work — the game object carries The Odds API spelling, and
  // the two only line up after both sides are normalized.
  // ============================================================

  function parseEspnInjuries(sport, data) {
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

      const norm = normalizeTeam(sport, teamName);
      if (!norm) return;

      const injuries = Array.isArray(entry.injuries) ? entry.injuries : [entry];

      if (!byTeam[norm]) byTeam[norm] = [];

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

        const date = inj.date || entry.date || null;
        byTeam[norm].push({ name, position, status, date });
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

  function round(v, d) { const f = Math.pow(10, d); return Math.round(v * f) / f; }

})();

if (typeof window !== 'undefined') window.EDGE_INJURY = EDGE_INJURY;