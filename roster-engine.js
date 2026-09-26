// ============================================================
// EDGE — ROSTER ENGINE v1.4
//
// v1.4 changes:
//
//   · The `enriched` flag is gone. The v1.3 loader read every
//     existing player row and stamped `enriched: true` on all
//     of them, so the roster builder always treated a stored
//     rating as authoritative — even for a player who had
//     never been enriched, and even when the player's
//     position group or starter flag had changed since the
//     rating was written. The shape check that was supposed
//     to prevent this ran after the fact and had no effect,
//     because the builder had already overwritten the
//     baseline with the stored value.
//
//     buildTeamRows now always emits a baseline computed from
//     the current roster data. The preservation decision
//     lives in upsertPlayers, which keeps the stored rating
//     only when the incoming position_group and starter flag
//     match what is on file. When either has changed, the
//     baseline is used. This is the same shape the enrichment
//     engine expects: enriched ratings survive a rebuild that
//     does not change a player's role, and stale ratings are
//     replaced when the role changes.
//
//   · Missing active flag is treated as unknown, not as
//     inactive. ESPN roster responses do not always carry an
//     `active` field. The v1.3 comparator read
//     `a.active === true`, so a missing field was coerced to
//     false and every player without the flag was sorted to
//     the bottom as if inactive — often the entire roster.
//     The flag is now nullable and the comparator only sorts
//     a player down when the flag is explicitly false.
//
//   · Starter inference is signaled clearly. Roster order is
//     still the fallback signal when ESPN does not return a
//     depth chart, but the row now records starter_inferred
//     = true in that case so downstream code can see the
//     value is a guess rather than a fact.
//
// v1.3 changes (retained):
//   · ESPN depth chart fields preferred when present.
//   · Rebuild does not wipe enrichment.
// ============================================================

const EDGE_ROSTER_ENGINE = (() => {

  const BUILD = 'roster-20260926-01';

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
    BUILD,
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
    const summary = { sports: {}, totals: { teams: 0, players: 0, preserved: 0 } };

    for (const sport of sports) {
      log(`── ${sport} ──`);
      try {
        const result = await buildSport(sport, { onProgress });
        summary.sports[sport] = result;
        summary.totals.teams += result.teams;
        summary.totals.players += result.players_written;
        summary.totals.preserved += result.enrichment_preserved || 0;
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

    log('  loading teams from power_ratings');
    const teams = await fetchTeams(sport, log);
    if (!teams.length) {
      log('  no teams found in power_ratings — run Recompute Ratings first');
      return { teams: 0, players_written: 0, enrichment_preserved: 0, note: 'No teams' };
    }
    log(`  ${teams.length} teams`);

    // Load existing players for this sport, keyed by player_id.
    // This is what makes the write an update rather than a
    // wipe-and-replace. Ratings already refined by enrichment
    // survive when the player's role has not changed.
    log('  loading existing roster from players table');
    const existing = await loadExisting(url, key, sport);
    log(`  ${existing.size} existing players`);

    const rows = [];
    let rosterMisses = 0;
    await parallelMap(teams, FETCH_CONCURRENCY, async team => {
      const athletes = await fetchRoster(path, team.id);
      if (!athletes.length) { rosterMisses++; return; }
      rows.push(...buildTeamRows(sport, team, athletes));
    });

    log(`  ${rows.length} players built`);
    if (rosterMisses) log(`  ${rosterMisses} teams returned empty rosters`);
    if (!rows.length) return { teams: teams.length, players_written: 0, enrichment_preserved: 0 };

    const result = await upsertPlayers(url, key, sport, rows, existing, log);
    log(`  wrote ${result.written} players · ${result.preserved} ratings preserved`);

    return {
      teams: teams.length,
      players_written: result.written,
      enrichment_preserved: result.preserved,
    };
  }

  // ============================================================
  // ── TEAMS ──
  // ============================================================

  async function fetchTeams(sport, log = () => {}) {
    const url = SUPABASE_URL();
    const key = SUPABASE_KEY();
    if (!url || !key) {
      log('    no Supabase connection');
      return [];
    }

    try {
      const res = await fetch(
        `${url}/rest/v1/power_ratings?sport=eq.${sport}&select=team_id,team_name&order=team_name.asc&limit=500`,
        { headers: { apikey: key, Authorization: `Bearer ${key}` } }
      );
      if (!res.ok) {
        log(`    power_ratings HTTP ${res.status}`);
        return [];
      }
      const rows = await res.json();
      log(`    ${rows.length} rows in power_ratings`);

      const teams = rows
        .filter(r => r.team_id && r.team_name && /^\d+$/.test(String(r.team_id)))
        .map(r => ({
          id: String(r.team_id),
          name: r.team_name,
          abbr: '',
        }));

      if (teams.length < rows.length) {
        log(`    ${rows.length - teams.length} rows had a non-numeric team_id`);
      }

      return teams;
    } catch (e) {
      log(`    power_ratings read failed: ${e.message}`);
      return [];
    }
  }

  // ============================================================
  // ── ROSTER ──
  // ============================================================

  async function fetchRoster(path, teamId) {
    const urls = [
      `https://site.api.espn.com/apis/site/v2/sports/${path}/teams/${teamId}/roster`,
      `https://site.api.espn.com/apis/site/v2/sports/${path}/teams/${teamId}?enable=roster`,
    ];

    for (const url of urls) {
      try {
        const res = await fetch(url, { cache: 'no-store' });
        if (res.headers.get('x-edge-offline') === '1') continue;
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
  //
  // Always emits a baseline rating computed from the current
  // roster data. Preservation of an enriched rating happens in
  // upsertPlayers, based on whether the player's role has
  // changed.
  // ============================================================

  function buildTeamRows(sport, team, athletes) {
    const parsed = athletes.map(a => {
      const posAbbr =
        a.position?.abbreviation ||
        a.position?.name ||
        a.defaultPosition?.abbreviation || '';
      const group = positionGroup(sport, posAbbr);

      // active is nullable. ESPN does not always return it. A
      // missing field means we do not know, not that the
      // player is inactive.
      const activeFlag =
        a.active === true ? true :
        a.active === false ? false :
        null;

      return {
        player_id: String(a.id || ''),
        name: a.displayName || a.fullName || a.shortName || 'Unknown',
        position: posAbbr || '—',
        position_group: group,
        jersey: a.jersey ? String(a.jersey) : null,
        experience: parseInt(a.experience?.years ?? a.experience ?? 0, 10) || 0,
        status: (a.status?.type || a.status?.name || 'active').toLowerCase(),
        depthChartPosition: a.depthChartPosition ?? a.depth ?? null,
        activeFlag,
      };
    }).filter(p => p.player_id && p.position_group);

    const groupBuckets = {};
    parsed.forEach(p => {
      if (!groupBuckets[p.position_group]) groupBuckets[p.position_group] = [];
      groupBuckets[p.position_group].push(p);
    });

    Object.values(groupBuckets).forEach(bucket => {
      bucket.sort(starterComparator(sport));
    });

    const rows = [];
    Object.entries(groupBuckets).forEach(([group, players]) => {
      const starterCount = STARTER_COUNTS[group] ?? 2;

      players.forEach((p, depth) => {
        const activeOK = p.activeFlag !== false && p.status !== 'inactive';
        const depthOK = p.depthChartPosition == null || p.depthChartPosition <= starterCount;
        const isStarter = depthOK && activeOK && depth < starterCount;
        const starterInferred = p.depthChartPosition == null;

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
          starter_inferred: starterInferred,
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

  // Comparator for slotting a position group. Depth chart field
  // first when ESPN supplies it, then active status, then
  // experience, then roster order.
  function starterComparator(sport) {
    return (a, b) => {
      // 1. Explicit depth chart.
      const da = a.depthChartPosition;
      const db = b.depthChartPosition;
      if (da != null && db != null && da !== db) return da - db;
      if (da != null && db == null) return -1;
      if (da == null && db != null) return 1;

      // 2. Active flag. Only players explicitly marked
      //    inactive sink. Unknown stays in place.
      const aa = a.activeFlag === false || a.status === 'inactive' ? false : true;
      const ab = b.activeFlag === false || b.status === 'inactive' ? false : true;
      if (aa !== ab) return aa ? -1 : 1;

      // 3. Experience, as a weak tiebreak.
      if (a.experience !== b.experience) return b.experience - a.experience;

      // 4. Fall through to received order.
      return 0;
    };
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
  // ── LOAD EXISTING ──
  //
  // Reads the players table for the sport and returns a map of
  // player_id → the fields used for the preservation check.
  // No enriched flag. Preservation is decided by comparing the
  // incoming row's role against what is stored.
  // ============================================================

  async function loadExisting(url, key, sport) {
    const out = new Map();
    const pageSize = 1000;
    for (let offset = 0; offset < 200000; offset += pageSize) {
      try {
        const res = await fetch(
          `${url}/rest/v1/players?sport=eq.${sport}` +
          `&select=id,player_id,rating,position_group,is_starter,offensive_contribution,defensive_contribution` +
          `&order=id.asc&limit=${pageSize}&offset=${offset}`,
          { headers: { apikey: key, Authorization: `Bearer ${key}` } }
        );
        if (!res.ok) break;
        const rows = await res.json();
        rows.forEach(r => {
          out.set(String(r.player_id), {
            id: r.id,
            rating: r.rating,
            position_group: r.position_group,
            is_starter: r.is_starter,
            offensive_contribution: r.offensive_contribution,
            defensive_contribution: r.defensive_contribution,
          });
        });
        if (rows.length < pageSize) break;
      } catch (e) {
        logEdgeError('roster.loadExisting.' + sport, e);
        break;
      }
    }
    return out;
  }

  // ============================================================
  // ── PERSIST ──
  //
  // Upsert, not delete-and-insert. A player whose incoming
  // position_group and starter flag match what is already on
  // file keeps the stored rating — whether that rating came
  // from the roster baseline or from enrichment. A player whose
  // role changed gets the new baseline. New players are
  // inserted. Players who dropped off the roster are deleted.
  // ============================================================

  async function upsertPlayers(url, key, sport, rows, existing, log) {
    const headers = {
      apikey: key, Authorization: `Bearer ${key}`,
      'Content-Type': 'application/json',
      Prefer: 'resolution=merge-duplicates,return=minimal',
    };

    let written = 0;
    let preserved = 0;

    const payload = rows.map(r => {
      const prev = existing.get(r.player_id);
      if (!prev) return r;

      const shapeMatches =
        prev.position_group === r.position_group &&
        prev.is_starter === r.is_starter;

      if (shapeMatches && prev.rating != null) {
        preserved++;
        return {
          ...r,
          rating: prev.rating,
          offensive_contribution: prev.offensive_contribution,
          defensive_contribution: prev.defensive_contribution,
        };
      }
      return r;
    });

    const chunkSize = 400;
    for (let i = 0; i < payload.length; i += chunkSize) {
      const chunk = payload.slice(i, i + chunkSize);
      try {
        const res = await fetch(`${url}/rest/v1/players?on_conflict=player_id`, {
          method: 'POST', headers, body: JSON.stringify(chunk),
        });
        if (res.ok || res.status === 409) {
          written += chunk.length;
        } else {
          const txt = await res.text().catch(() => '');
          log(`  players chunk ${i}: HTTP ${res.status} ${txt.slice(0, 120)}`);
        }
      } catch (e) {
        log(`  players chunk ${i}: ${e.message}`);
      }
    }

    // Delete players who dropped off the roster entirely.
    const incoming = new Set(rows.map(r => r.player_id));
    const dropped = Array.from(existing.keys()).filter(id => !incoming.has(id));
    if (dropped.length) {
      log(`  ${dropped.length} players dropped off the roster`);
      const delChunk = 200;
      for (let i = 0; i < dropped.length; i += delChunk) {
        const chunk = dropped.slice(i, i + delChunk);
        const inList = chunk.map(id => `"${id}"`).join(',');
        try {
          await fetch(`${url}/rest/v1/players?sport=eq.${sport}&player_id=in.(${inList})`, {
            method: 'DELETE',
            headers: { apikey: key, Authorization: `Bearer ${key}` },
          });
        } catch (e) {
          logEdgeError('roster.deleteDropped', e);
        }
      }
    }

    return { written, preserved, dropped: dropped.length };
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

  function logEdgeError(where, err) {
    try {
      const list = JSON.parse(localStorage.getItem('edge_errors') || '[]');
      list.unshift({ t: Date.now(), where, msg: err && err.message ? err.message : String(err) });
      localStorage.setItem('edge_errors', JSON.stringify(list.slice(0, 50)));
    } catch {}
  }

  function clamp(v, min, max) { return Math.max(min, Math.min(max, v)); }
  function round(v, d) { const f = Math.pow(10, d); return Math.round(v * f) / f; }

})();

if (typeof window !== 'undefined') {
  window.EDGE_ROSTER_ENGINE = EDGE_ROSTER_ENGINE;
  window.EDGE_ROSTER = EDGE_ROSTER_ENGINE;
}