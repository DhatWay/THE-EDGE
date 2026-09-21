// ============================================================
// EDGE — ROSTER ENGINE v1.1
// The missing upstream for roster enrichment and injury
// fragmentation. Pulls every team's roster from ESPN, assigns a
// position group, flags likely starters, writes baseline ratings
// to the players table.
//
// v1.1 — fetchTeams now logs failures instead of swallowing them,
// and accepts both ESPN response shapes. WNBA added.
// ============================================================

const EDGE_ROSTER_ENGINE = (() => {

  const SUPABASE_URL = () => localStorage.getItem('edge_supabase_url');
  const SUPABASE_KEY = () => localStorage.getItem('edge_supabase_key');

  const ESPN_MAP = {
    NFL:   'football/nfl',
    NBA:   'basketball/nba',
    WNBA:  'basketball/wnba',
    MLB:   'baseball/mlb',
    NHL:   'hockey/nhl',
    NCAAF: 'football/college-football',
    NCAAB: 'basketball/mens-college-basketball',
    MLS:   'soccer/usa.1',
  };

  const POSITION_GROUPS = {
    NFL: {
      QB: 'OFFENSE_SKILL', RB: 'OFFENSE_SKILL', FB: 'OFFENSE_SKILL',
      WR: 'OFFENSE_SKILL', TE: 'OFFENSE_SKILL',
      OT: 'OFFENSE_LINE', OG: 'OFFENSE_LINE', C: 'OFFENSE_LINE',
      G: 'OFFENSE_LINE', T: 'OFFENSE_LINE', OL: 'OFFENSE_LINE',
      DT: 'DEFENSE_FRONT', NT: 'DEFENSE_FRONT', DL: 'DEFENSE_FRONT',
      DE: 'DEFENSE_EDGE', EDGE: 'DEFENSE_EDGE', OLB: 'DEFENSE_EDGE',
      LB: 'DEFENSE_MID', ILB: 'DEFENSE_MID', MLB: 'DEFENSE_MID',
      CB: 'DEFENSE_SECONDARY', S: 'DEFENSE_SECONDARY',
      FS: 'DEFENSE_SECONDARY', SS: 'DEFENSE_SECONDARY', DB: 'DEFENSE_SECONDARY',
      K: 'SPECIAL', P: 'SPECIAL', LS: 'SPECIAL',
    },
    NBA: {
      PG: 'GUARD', SG: 'GUARD', G: 'GUARD',
      SF: 'WING', GF: 'WING', F: 'WING',
      PF: 'BIG', C: 'BIG', FC: 'BIG',
    },
    MLB: {
      SP: 'PITCHER_START', P: 'PITCHER_START',
      RP: 'PITCHER_RELIEF', CP: 'PITCHER_RELIEF',
      C: 'CATCHER',
      '1B': 'INFIELD', '2B': 'INFIELD', '3B': 'INFIELD', SS: 'INFIELD', IF: 'INFIELD',
      LF: 'OUTFIELD', CF: 'OUTFIELD', RF: 'OUTFIELD', OF: 'OUTFIELD',
      DH: 'DH',
    },
    NHL: {
      C: 'FORWARD', LW: 'FORWARD', RW: 'FORWARD', W: 'FORWARD', F: 'FORWARD',
      D: 'DEFENSE', LD: 'DEFENSE', RD: 'DEFENSE',
      G: 'GOALIE',
    },
    MLS: {
      G: 'GOALKEEPER', GK: 'GOALKEEPER',
      D: 'DEFENSE', CB: 'DEFENSE', LB: 'DEFENSE', RB: 'DEFENSE', DF: 'DEFENSE',
      M: 'MIDFIELD', CM: 'MIDFIELD', DM: 'MIDFIELD', AM: 'MIDFIELD', MF: 'MIDFIELD',
      F: 'FORWARD', ST: 'FORWARD', CF: 'FORWARD', LW: 'FORWARD', RW: 'FORWARD', FW: 'FORWARD',
    },
  };
  POSITION_GROUPS.NCAAF = POSITION_GROUPS.NFL;
  POSITION_GROUPS.NCAAB = POSITION_GROUPS.NBA;
  POSITION_GROUPS.WNBA  = POSITION_GROUPS.NBA;

  const STARTER_COUNTS = {
    OFFENSE_SKILL: 6, OFFENSE_LINE: 5,
    DEFENSE_FRONT: 2, DEFENSE_EDGE: 2, DEFENSE_MID: 3, DEFENSE_SECONDARY: 4,
    SPECIAL: 3,
    GUARD: 2, WING: 2, BIG: 2,
    PITCHER_START: 5, PITCHER_RELIEF: 3, CATCHER: 1,
    INFIELD: 4, OUTFIELD: 3, DH: 1,
    FORWARD: 12, DEFENSE: 6, GOALIE: 1,
    GOALKEEPER: 1, MIDFIELD: 4,
  };

  const POSITION_WEIGHTS = {
    OFFENSE_SKILL: 0.55, OFFENSE_LINE: 0.45,
    DEFENSE_FRONT: 0.40, DEFENSE_EDGE: 0.55,
    DEFENSE_MID: 0.40, DEFENSE_SECONDARY: 0.50,
    SPECIAL: 0.15,
    GUARD: 0.95, WING: 0.90, BIG: 0.85,
    PITCHER_START: 1.00, PITCHER_RELIEF: 0.40, PITCHER: 0.70,
    CATCHER: 0.55, INFIELD: 0.55, OUTFIELD: 0.55, DH: 0.50, HITTER: 0.55,
    GOALIE: 1.00, FORWARD: 0.75, MIDFIELD: 0.80,
    DEFENSE: 0.75, GOALKEEPER: 1.00,
  };

  const OFFENSE_GROUPS = new Set([
    'OFFENSE_SKILL', 'OFFENSE_LINE', 'GUARD', 'WING', 'BIG',
    'PITCHER_START', 'PITCHER_RELIEF', 'CATCHER', 'INFIELD', 'OUTFIELD', 'DH',
    'FORWARD', 'MIDFIELD', 'HITTER',
  ]);
  const DEFENSE_GROUPS = new Set([
    'DEFENSE_FRONT', 'DEFENSE_EDGE', 'DEFENSE_MID', 'DEFENSE_SECONDARY',
    'GOALIE', 'GOALKEEPER', 'DEFENSE', 'PITCHER',
  ]);

  const BASE_STARTER = 68;
  const BASE_BACKUP = 52;
  const FETCH_CONCURRENCY = 4;

  return {
    buildAll,
    buildSport,
    fetchTeams,
    fetchRoster,
    positionGroup,
    contributionFor,
    POSITION_GROUPS,
    POSITION_WEIGHTS,
  };

  // ============================================================
  // ── MAIN ──
  // ============================================================

  async function buildAll(options = {}) {
    const { sports = Object.keys(ESPN_MAP), onProgress = null } = options;
    const log = makeLogger(onProgress);
    const summary = { sports: {}, totals: { teams: 0, players: 0 } };

    for (const sport of sports) {
      log(`── ${sport} ──`);
      try {
        const result = await buildSport(sport, { onProgress });
        summary.sports[sport] = result;
        summary.totals.teams += result.teams;
        summary.totals.players += result.players_written;
      } catch (e) {
        log(`${sport} failed: ${e.message}`);
        summary.sports[sport] = { error: e.message };
      }
    }
    summary.teams_processed = summary.totals.teams;
    summary.players_processed = summary.totals.players;
    return summary;
  }

  async function buildSport(sport, options = {}) {
    const log = makeLogger(options.onProgress);
    const url = SUPABASE_URL();
    const key = SUPABASE_KEY();
    if (!url || !key) throw new Error('Supabase not connected');

    const path = ESPN_MAP[sport];
    if (!path) throw new Error(`Unknown sport: ${sport}`);

    log('  fetching teams');
    const teams = await fetchTeams(path, log);
    if (!teams.length) {
      log('  no teams returned');
      return { teams: 0, players_written: 0, note: 'No teams returned' };
    }
    log(`  ${teams.length} teams`);

    const rows = [];
    await parallelMap(teams, FETCH_CONCURRENCY, async team => {
      const athletes = await fetchRoster(path, team.id);
      if (!athletes.length) return;
      rows.push(...buildTeamRows(sport, team, athletes));
    });

    log(`  ${rows.length} players built`);
    if (!rows.length) return { teams: teams.length, players_written: 0 };

    const written = await replaceSportRows(url, key, sport, rows, log);
    log(`  wrote ${written} players`);

    return { teams: teams.length, players_written: written };
  }

  // ============================================================
  // ── ESPN ──
  //
  // Every step logs so a silent failure never hides again. The
  // previous version swallowed every error, so "0 teams" meant
  // anything from a 404 to a JSON shape change with no way to
  // tell which.
  // ============================================================

  async function fetchTeams(path, log = () => {}) {
    const urls = [
      `https://site.api.espn.com/apis/site/v2/sports/${path}/teams?limit=1000`,
      `https://site.api.espn.com/apis/site/v2/sports/${path}/teams`,
    ];

    for (const url of urls) {
      let res;
      try {
        res = await fetch(url, { cache: 'no-store' });
      } catch (e) {
        log(`    teams fetch failed: ${e.message}`);
        continue;
      }
      if (!res.ok) {
        log(`    teams HTTP ${res.status}`);
        continue;
      }

      let data;
      try { data = await res.json(); }
      catch (e) { log(`    teams JSON failed: ${e.message}`); continue; }

      if (!data || typeof data !== 'object' || Array.isArray(data)) {
        log(`    teams returned non-object (len ${JSON.stringify(data).length})`);
        continue;
      }

      // ESPN wraps teams under sports[0].leagues[0].teams, with
      // each entry as { team: {...} }. A few endpoints return them
      // flat, and some return sports[0].teams directly.
      const raw =
        data?.sports?.[0]?.leagues?.[0]?.teams ||
        data?.sports?.[0]?.teams ||
        [];

      log(`    teams raw: ${raw.length}`);

      const teams = raw
        .map(e => e && (e.team || e))
        .filter(t => t && t.id)
        .map(t => ({
          id: String(t.id),
          name: t.displayName || t.name || '',
          abbr: t.abbreviation || '',
        }))
        .filter(t => t.name);

      if (teams.length) return teams;
    }

    return [];
  }

  async function fetchRoster(path, teamId) {
    const urls = [
      `https://site.api.espn.com/apis/site/v2/sports/${path}/teams/${teamId}/roster`,
      `https://site.api.espn.com/apis/site/v2/sports/${path}/teams/${teamId}?enable=roster`,
    ];

    for (const url of urls) {
      try {
        const res = await fetch(url, { cache: 'no-store' });
        if (!res.ok) continue;
        const data = await res.json();

        let raw = data.athletes || data?.team?.athletes || [];
        let flat = [];

        if (Array.isArray(raw) && raw.length && Array.isArray(raw[0]?.items)) {
          raw.forEach(bucket => {
            (bucket.items || []).forEach(a => flat.push(a));
          });
        } else if (Array.isArray(raw)) {
          flat = raw.filter(a => a && (a.id || a.athlete));
          flat = flat.map(a => a.athlete || a);
        }

        if (flat.length) return flat;
      } catch {}
    }
    return [];
  }

  // ============================================================
  // ── ROW BUILDING ──
  // ============================================================

  function buildTeamRows(sport, team, athletes) {
    const groupBuckets = {};

    const parsed = athletes.map(a => {
      const posAbbr =
        a.position?.abbreviation ||
        a.position?.name ||
        a.defaultPosition?.abbreviation || '';
      const group = positionGroup(sport, posAbbr);

      return {
        player_id: String(a.id || ''),
        name: a.displayName || a.fullName || a.shortName || 'Unknown',
        position: posAbbr || '—',
        position_group: group,
        jersey: a.jersey ? String(a.jersey) : null,
        experience: parseInt(a.experience?.years ?? a.experience ?? 0, 10) || 0,
        status: (a.status?.type || a.status?.name || 'active').toLowerCase(),
      };
    }).filter(p => p.player_id && p.position_group);

    parsed.forEach(p => {
      if (!groupBuckets[p.position_group]) groupBuckets[p.position_group] = [];
      groupBuckets[p.position_group].push(p);
    });

    const rows = [];
    Object.entries(groupBuckets).forEach(([group, players]) => {
      const starterCount = STARTER_COUNTS[group] ?? 2;

      players.forEach((p, depth) => {
        const isStarter = depth < starterCount && p.status !== 'inactive';
        const rating = baselineRating(isStarter, depth, starterCount, p.experience);
        const { off, def } = contributionFor(group, rating);

        rows.push({
          player_id: p.player_id,
          sport,
          team_id: team.id,
          team_name: team.name,
          name: p.name,
          position: p.position,
          position_group: group,
          jersey: p.jersey,
          depth_order: depth,
          is_starter: isStarter,
          rating,
          offensive_contribution: off,
          defensive_contribution: def,
          status: p.status,
          updated_at: new Date().toISOString(),
        });
      });
    });

    return rows;
  }

  function baselineRating(isStarter, depth, starterCount, experience) {
    const base = isStarter ? BASE_STARTER : BASE_BACKUP;
    const depthPenalty = isStarter
      ? depth * 1.5
      : Math.min((depth - starterCount + 1) * 1.2, 8);
    const expBonus = Math.min(experience, 8) * 0.6;
    return clamp(round(base - depthPenalty + expBonus, 1), 40, 90);
  }

  function contributionFor(group, rating) {
    const weight = POSITION_WEIGHTS[group] ?? 0.40;
    const base = rating * weight;
    if (OFFENSE_GROUPS.has(group)) return { off: round(base, 2), def: 0 };
    if (DEFENSE_GROUPS.has(group)) return { off: 0, def: round(base, 2) };
    return { off: round(base / 2, 2), def: round(base / 2, 2) };
  }

  function positionGroup(sport, posAbbr) {
    if (!posAbbr) return null;
    const table = POSITION_GROUPS[sport];
    if (!table) return null;
    const key = String(posAbbr).toUpperCase().trim();
    if (table[key]) return table[key];
    const head = key.split(/[\/\-\s]/)[0];
    return table[head] || null;
  }

  // ============================================================
  // ── PERSIST ──
  // ============================================================

  async function replaceSportRows(url, key, sport, rows, log) {
    const headers = {
      apikey: key, Authorization: `Bearer ${key}`,
      'Content-Type': 'application/json', Prefer: 'return=minimal',
    };

    try {
      await fetch(`${url}/rest/v1/players?sport=eq.${sport}`, {
        method: 'DELETE',
        headers: { apikey: key, Authorization: `Bearer ${key}` },
      });
    } catch {}

    let written = 0;
    const chunkSize = 400;
    for (let i = 0; i < rows.length; i += chunkSize) {
      const chunk = rows.slice(i, i + chunkSize);
      try {
        const res = await fetch(`${url}/rest/v1/players`, {
          method: 'POST', headers, body: JSON.stringify(chunk),
        });
        if (res.ok) written += chunk.length;
        else {
          const txt = await res.text().catch(() => '');
          log(`  players chunk ${i}: HTTP ${res.status} ${txt.slice(0, 120)}`);
        }
      } catch (e) {
        log(`  players chunk ${i}: ${e.message}`);
      }
    }
    return written;
  }

  // ============================================================
  // ── UTILITIES ──
  // ============================================================

  async function parallelMap(items, concurrency, fn) {
    const queue = [...items];
    const workers = Array.from({ length: concurrency }, async () => {
      while (queue.length) {
        const item = queue.shift();
        if (item === undefined) break;
        await fn(item);
      }
    });
    await Promise.all(workers);
  }

  function makeLogger(onProgress) {
    return (msg) => { if (typeof onProgress === 'function') onProgress(msg); };
  }

  function clamp(v, min, max) { return Math.max(min, Math.min(max, v)); }
  function round(v, d) { const f = Math.pow(10, d); return Math.round(v * f) / f; }

})();

if (typeof window !== 'undefined') {
  window.EDGE_ROSTER_ENGINE = EDGE_ROSTER_ENGINE;
  window.EDGE_ROSTER = EDGE_ROSTER_ENGINE;
}