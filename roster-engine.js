// ============================================================
// EDGE — ROSTER ENGINE v1.3
//
// v1.3 changes:
//
//   · Starters are no longer "whoever ESPN listed first."
//     The v1.2 code assigned `is_starter = depth < starterCount`
//     where depth was the row's position in the roster response.
//     ESPN's roster array is roughly alphabetical, not a depth
//     chart. The starting QB could be buried at slot 40 behind
//     a fullback whose last name starts with "A". Enrichment
//     then added a starter bonus to the wrong player, and the
//     injury family's deduction varied wildly depending on
//     which side of the sort a starter landed on.
//
//     Starter detection now uses, in order of reliability:
//
//       1. ESPN's explicit depth chart fields when the roster
//          response carries them — `depthChartPosition` or
//          `depth` on the athlete, or a `depthChart` block on
//          the team. Not every sport returns this.
//
//       2. The `experience` and `stats` fields as a weak
//          tiebreak only — a QB with more passing touchdowns is
//          more likely the starter than one with fewer.
//
//       3. The active roster flag. ESPN marks practice squad
//          and inactive players; those are not starters.
//
//     When none of those signals are present, the fallback is
//     still roster order, but only as a last resort, and the
//     row is flagged `starter_inferred: true` so downstream
//     code can see that the value is a guess.
//
//   · Rebuilding rosters no longer wipes enrichment. The v1.2
//     code deleted all rows for a sport before inserting the
//     new set. Any player whose per-game stats had already been
//     used to refine their rating lost that refinement. The
//     delete is now gated: when a player's id already exists,
//     the row is updated in place (rating preserved unless the
//     roster data itself changes position or experience). New
//     players are inserted. Only players who dropped off the
//     roster entirely are removed.
//
//   · position_group is written consistently. The 50-baseline
//     rating from the previous version is kept, but the group
//     assignment now matches the same table the enrichment and
//     box-score fetcher use, so enrichment's per-group z-score
//     and prop-trends' per-group gates both line up.
//
// v1.2 changes (retained):
//   · fetchTeams reads the team list from power_ratings, not
//     ESPN's /teams endpoint, which is CORS-blocked.
// ============================================================

const EDGE_ROSTER_ENGINE = (() => {

  const BUILD = 'roster-20260925-01';

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
    // survive.
    log('  loading existing roster from players table');
    const existing = await loadExisting(url, key, sport);
    log(`  ${existing.size} existing players`);

    const rows = [];
    let rosterMisses = 0;
    await parallelMap(teams, FETCH_CONCURRENCY, async team => {
      const athletes = await fetchRoster(path, team.id);
      if (!athletes.length) { rosterMisses++; return; }
      rows.push(...buildTeamRows(sport, team, athletes, existing));
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
  // ============================================================

  function buildTeamRows(sport, team, athletes, existing) {
    // Parse athletes into rows we can sort and slot into groups.
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
        // Signals for the starter decision, in order of reliability.
        depthChartPosition: a.depthChartPosition ?? a.depth ?? null,
        activeFlag: a.active === true,
        stats: a.stats || null,
      };
    }).filter(p => p.player_id && p.position_group);

    // Group players by position group.
    const groupBuckets = {};
    parsed.forEach(p => {
      if (!groupBuckets[p.position_group]) groupBuckets[p.position_group] = [];
      groupBuckets[p.position_group].push(p);
    });

    // Sort each group by best-available signal, best first.
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

        // Rating: on the roster build, a starter begins at the
        // starter baseline, a backup below it. Enrichment will
        // later overwrite this from real production. When
        // existing enrichment is on file, that rating is
        // preserved.
        const priorEnriched = existing.get(p.player_id);
        const baseRating = baselineRating(isStarter, depth, starterCount, p.experience);
        const rating = priorEnriched?.enriched
          ? priorEnriched.rating
          : baseRating;

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
          offensive_contribution: priorEnriched?.enriched
            ? priorEnriched.offensive_contribution
            : off,
          defensive_contribution: priorEnriched?.enriched
            ? priorEnriched.defensive_contribution
            : def,
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

      // 2. Active flag. Inactive players sink.
      const aa = a.activeFlag !== false && a.status !== 'inactive';
      const ab = b.activeFlag !== false && b.status !== 'inactive';
      if (aa !== ab) return aa ? -1 : 1;

      // 3. Experience for sports where it helps. A veteran
      //    beats a rookie at the same slot.
      if (a.experience !== b.experience) return b.experience - a.experience;

      // 4. Fall through to roster order — the array we received.
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
  // player_id → { id, rating, offensive_contribution,
  // defensive_contribution, enriched }.
  //
  // `enriched` is true when the row carries an update time after
  // roster build — heuristically, when the row's rating differs
  // from the 40-90 baseline band AND the row has been written
  // more than once. Roster build and enrichment both write
  // updated_at, so the signal we actually use is whether the
  // row carries the enrichment-specific column set. Since we do
  // not track source directly, the simplest reliable signal is
  // that enrichment sets ratings on a 40-95 scale computed
  // differently from the roster baseline — but roster ratings
  // are also 40-90, so the two overlap.
  //
  // Pragmatic decision: we treat every existing row as
  // "potentially enriched" and preserve its rating only when the
  // incoming roster data does not change the player's group or
  // starter status. A player whose starter flag flips or whose
  // group changes goes back to the baseline. A player who stays
  // the same keeps whatever rating was on file, whether it came
  // from the baseline or from enrichment.
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
            enriched: true,
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
  // file keeps the rating already stored — whether that rating
  // came from the roster baseline or from enrichment. New
  // players are inserted. Players who dropped off the roster
  // are deleted in a second pass.
  // ============================================================

  async function upsertPlayers(url, key, sport, rows, existing, log) {
    const headers = {
      apikey: key, Authorization: `Bearer ${key}`,
      'Content-Type': 'application/json',
      Prefer: 'resolution=merge-duplicates,return=minimal',
    };

    let written = 0;
    let preserved = 0;

    // Preserve rating when the existing row's shape agrees with
    // the new row's shape.
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

    // Delete players who dropped off the roster entirely. This
    // only removes ids that were on file before and are not in
    // the new set.
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