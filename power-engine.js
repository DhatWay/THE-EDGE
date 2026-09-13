// ============================================================
// EDGE — ROSTER ENGINE v1.0
// Fetches every team's roster from ESPN, assigns a rating 0-100
// per player, computes offensive/defensive contribution, persists
// to the `players` table. Team power can then be fragmented by
// subtracting injured players' contributions from the base rating.
// ============================================================

const EDGE_ROSTER = (() => {

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

  // Position group normalization so we can roll up cleanly.
  const POSITION_GROUPS = {
    NFL: {
      QB: 'OFFENSE_SKILL', RB: 'OFFENSE_SKILL', WR: 'OFFENSE_SKILL', TE: 'OFFENSE_SKILL',
      FB: 'OFFENSE_SKILL', HB: 'OFFENSE_SKILL',
      LT: 'OFFENSE_LINE', LG: 'OFFENSE_LINE', C: 'OFFENSE_LINE', RG: 'OFFENSE_LINE',
      RT: 'OFFENSE_LINE', OT: 'OFFENSE_LINE', OG: 'OFFENSE_LINE',
      T: 'OFFENSE_LINE', G: 'OFFENSE_LINE', OL: 'OFFENSE_LINE',
      DE: 'DEFENSE_FRONT', DT: 'DEFENSE_FRONT', NT: 'DEFENSE_FRONT', DL: 'DEFENSE_FRONT',
      EDGE: 'DEFENSE_EDGE', OLB: 'DEFENSE_EDGE',
      ILB: 'DEFENSE_MID', MLB: 'DEFENSE_MID', LB: 'DEFENSE_MID',
      CB: 'DEFENSE_SECONDARY', S: 'DEFENSE_SECONDARY',
      FS: 'DEFENSE_SECONDARY', SS: 'DEFENSE_SECONDARY', DB: 'DEFENSE_SECONDARY',
      K: 'SPECIAL', P: 'SPECIAL', LS: 'SPECIAL',
    },
    NBA: { PG: 'GUARD', SG: 'GUARD', G: 'GUARD', SF: 'WING', F: 'WING', PF: 'BIG', C: 'BIG' },
    MLB: {
      SP: 'PITCHER_START', RP: 'PITCHER_RELIEF', CP: 'PITCHER_RELIEF',
      P: 'PITCHER_START',
      C: 'CATCHER',
      '1B': 'INFIELD', '2B': 'INFIELD', '3B': 'INFIELD',
      SS: 'INFIELD', IF: 'INFIELD', INF: 'INFIELD',
      LF: 'OUTFIELD', CF: 'OUTFIELD', RF: 'OUTFIELD', OF: 'OUTFIELD',
      DH: 'DH',
    },
    NHL: {
      G: 'GOALIE', D: 'DEFENSE',
      LW: 'FORWARD', RW: 'FORWARD', C: 'FORWARD', F: 'FORWARD',
    },
    NCAAF: {
      QB: 'OFFENSE_SKILL', RB: 'OFFENSE_SKILL', WR: 'OFFENSE_SKILL', TE: 'OFFENSE_SKILL',
      LT: 'OFFENSE_LINE', LG: 'OFFENSE_LINE', C: 'OFFENSE_LINE', RG: 'OFFENSE_LINE',
      RT: 'OFFENSE_LINE', OT: 'OFFENSE_LINE', OG: 'OFFENSE_LINE',
      DE: 'DEFENSE_FRONT', DT: 'DEFENSE_FRONT', NT: 'DEFENSE_FRONT',
      EDGE: 'DEFENSE_EDGE', OLB: 'DEFENSE_EDGE',
      ILB: 'DEFENSE_MID', MLB: 'DEFENSE_MID', LB: 'DEFENSE_MID',
      CB: 'DEFENSE_SECONDARY', S: 'DEFENSE_SECONDARY',
      FS: 'DEFENSE_SECONDARY', SS: 'DEFENSE_SECONDARY',
      K: 'SPECIAL', P: 'SPECIAL',
    },
    NCAAB: { PG: 'GUARD', SG: 'GUARD', G: 'GUARD', SF: 'WING', F: 'WING', PF: 'BIG', C: 'BIG' },
    MLS: {
      GK: 'GOALKEEPER', G: 'GOALKEEPER',
      D: 'DEFENSE', CB: 'DEFENSE', LB: 'DEFENSE', RB: 'DEFENSE',
      M: 'MIDFIELD', DM: 'MIDFIELD', CM: 'MIDFIELD', AM: 'MIDFIELD',
      F: 'FORWARD', ST: 'FORWARD', CF: 'FORWARD', W: 'FORWARD',
    },
  };

  // Multiplier that converts a player rating into team-power points.
  // QB = 1.0 because a single elite QB transforms the whole offense.
  // LB = 0.40 because one linebacker is one of eleven.
  const POSITION_WEIGHTS = {
    NFL: {
      QB: 1.00, RB: 0.35, WR: 0.45, TE: 0.35, FB: 0.10,
      LT: 0.55, RT: 0.45, LG: 0.35, RG: 0.35, C: 0.40,
      OT: 0.50, OG: 0.35, T: 0.50, G: 0.35,
      DE: 0.45, DT: 0.35, NT: 0.30, EDGE: 0.55, OLB: 0.50,
      ILB: 0.40, MLB: 0.40, LB: 0.40,
      CB: 0.60, FS: 0.45, SS: 0.40, S: 0.45, DB: 0.50,
      K: 0.15, P: 0.10, LS: 0.05,
    },
    NBA: { PG: 1.00, SG: 0.90, SF: 0.90, PF: 0.85, C: 0.85, G: 0.95, F: 0.90 },
    MLB: {
      SP: 1.00, RP: 0.40, CP: 0.55, P: 1.00,
      C: 0.55,
      '1B': 0.55, '2B': 0.55, '3B': 0.55, SS: 0.65, IF: 0.55, INF: 0.55,
      LF: 0.50, CF: 0.60, RF: 0.50, OF: 0.55,
      DH: 0.50,
    },
    NHL: { G: 1.00, D: 0.75, LW: 0.70, RW: 0.70, C: 0.80, F: 0.75 },
    NCAAF: {
      QB: 1.00, RB: 0.35, WR: 0.45, TE: 0.35,
      LT: 0.55, RT: 0.45, LG: 0.35, RG: 0.35, C: 0.40,
      OT: 0.50, OG: 0.35,
      DE: 0.45, DT: 0.35, NT: 0.30, EDGE: 0.55, OLB: 0.50,
      ILB: 0.40, MLB: 0.40, LB: 0.40,
      CB: 0.60, FS: 0.45, SS: 0.40, S: 0.45,
      K: 0.15, P: 0.10,
    },
    NCAAB: { PG: 1.00, SG: 0.90, SF: 0.90, PF: 0.85, C: 0.85, G: 0.95, F: 0.90 },
    MLS: {
      GK: 1.00, G: 1.00,
      D: 0.75, CB: 0.80, LB: 0.70, RB: 0.70,
      M: 0.80, DM: 0.70, CM: 0.80, AM: 0.95,
      F: 1.00, ST: 1.00, CF: 1.00, W: 0.85,
    },
  };

  // Rating envelope
  const BASE_RATING = 50;
  const ROOKIE_CEILING = 68;
  const VETERAN_CEILING = 90;

  return {
    buildAll,
    buildTeam,
    refreshRatings,
    getTeamRoster,
    POSITION_GROUPS,
    POSITION_WEIGHTS,
  };

  // ============================================================
  // ── MAIN ──
  // ============================================================

  async function buildAll(options = {}) {
    const { sports = Object.keys(ESPN_MAP), onProgress = null } = options;
    const log = makeLogger(onProgress);

    const url = SUPABASE_URL();
    const key = SUPABASE_KEY();
    if (!url || !key) throw new Error('Supabase not connected');

    const summary = { sports: {}, teams_processed: 0, players_processed: 0, errors: [] };

    // Pull teams from power_ratings — this is our source of truth for
    // which teams exist, their ids, and their canonical names.
    let allTeams = [];
    try {
      const res = await fetch(
        `${url}/rest/v1/power_ratings?select=sport,team_name,team_id&limit=1000`,
        { headers: { apikey: key, Authorization: `Bearer ${key}` } }
      );
      if (!res.ok) throw new Error('Failed to load teams');
      allTeams = await res.json();
    } catch (e) {
      throw new Error('Cannot load teams: ' + e.message);
    }

    for (const sport of sports) {
      if (!ESPN_MAP[sport]) continue;
      const teams = allTeams.filter(t => t.sport === sport);
      if (!teams.length) {
        log(`${sport}: no teams in power_ratings`);
        continue;
      }
      log(`${sport}: ${teams.length} teams`);

      const rows = [];
      for (const team of teams) {
        try {
          const roster = await fetchTeamRoster(sport, team.team_id);
          if (!roster.players.length) continue;

          const players = computeRoster(sport, team.team_name, roster);
          rows.push(...players);
          summary.teams_processed += 1;
          summary.players_processed += players.length;
        } catch (e) {
          summary.errors.push({ sport, team: team.team_name, error: e.message });
        }
      }

      // Chunked upsert
      const chunkSize = 500;
      for (let i = 0; i < rows.length; i += chunkSize) {
        const chunk = rows.slice(i, i + chunkSize);
        try {
          await fetch(`${url}/rest/v1/players`, {
            method: 'POST',
            headers: {
              apikey: key,
              Authorization: `Bearer ${key}`,
              'Content-Type': 'application/json',
              Prefer: 'resolution=merge-duplicates,return=minimal',
            },
            body: JSON.stringify(chunk),
          });
        } catch (e) {
          summary.errors.push({ sport, chunk: i, error: e.message });
        }
      }

      summary.sports[sport] = { teams: teams.length, players: rows.length };
      log(`${sport}: wrote ${rows.length} players`);
    }

    return summary;
  }

  // ============================================================
  // ── BUILD ONE TEAM ──
  // ============================================================

  async function buildTeam(sport, teamId, teamName) {
    const url = SUPABASE_URL();
    const key = SUPABASE_KEY();
    if (!url || !key) throw new Error('Supabase not connected');

    const roster = await fetchTeamRoster(sport, teamId);
    if (!roster.players.length) return [];

    const rows = computeRoster(sport, teamName, roster);

    await fetch(`${url}/rest/v1/players`, {
      method: 'POST',
      headers: {
        apikey: key,
        Authorization: `Bearer ${key}`,
        'Content-Type': 'application/json',
        Prefer: 'resolution=merge-duplicates,return=minimal',
      },
      body: JSON.stringify(rows),
    });

    return rows;
  }

  // ============================================================
  // ── FETCH ROSTER FROM ESPN ──
  // ============================================================

  async function fetchTeamRoster(sport, teamId) {
    const path = ESPN_MAP[sport];
    if (!path || !teamId) return { players: [] };

    const urls = [
      `https://site.api.espn.com/apis/site/v2/sports/${path}/teams/${teamId}/roster`,
      `https://site.api.espn.com/apis/site/v2/sports/${path}/teams/${teamId}?enable=roster`,
    ];

    for (const url of urls) {
      try {
        const res = await fetch(url);
        if (!res.ok) continue;
        const data = await res.json();
        const players = extractAthletes(data);
        if (players.length) return { players };
      } catch {}
    }

    return { players: [] };
  }

  function extractAthletes(data) {
    if (!data) return [];

    // ESPN returns a few shapes:
    // 1) { athletes: [ { fullName, position, ... }, ... ] }
    // 2) { athletes: [ { position: 'QB', items: [ ... ] }, ... ] }
    // 3) { team: { athletes: [ ... ] } }

    let list = null;
    if (Array.isArray(data.athletes)) list = data.athletes;
    else if (Array.isArray(data.team?.athletes)) list = data.team.athletes;
    else return [];

    // Grouped form
    if (list.length && list[0].items) {
      return list.flatMap(g => g.items || []);
    }

    return list;
  }

  // ============================================================
  // ── COMPUTE PLAYER RATINGS + CONTRIBUTIONS ──
  // ============================================================

  function computeRoster(sport, teamName, roster) {
    const groups = POSITION_GROUPS[sport] || {};
    const weights = POSITION_WEIGHTS[sport] || {};
    const rows = [];

    // Determine starters: if ESPN provides an explicit starter flag,
    // use it. Otherwise treat the first player at each position as
    // the starter, and any player with a non-zero depth chart order
    // less than 2 as a starter.
    const startersByPosition = {};
    roster.players.forEach(p => {
      const pos = positionAbbrev(p);
      if (!pos) return;
      const depth = parseInt(p.depthChartOrder || p.depth || '0', 10);
      if (!startersByPosition[pos]) startersByPosition[pos] = [];
      startersByPosition[pos].push({ player: p, depth });
    });

    Object.keys(startersByPosition).forEach(pos => {
      startersByPosition[pos].sort((a, b) => {
        // Explicit starter flag wins
        const sa = a.player.starter === true ? 0 : 1;
        const sb = b.player.starter === true ? 0 : 1;
        if (sa !== sb) return sa - sb;
        // Otherwise sort by depth chart order
        return (a.depth || 99) - (b.depth || 99);
      });
    });

    roster.players.forEach(p => {
      const name = p.fullName || p.displayName || p.name;
      const playerId = String(p.id || '');
      if (!name || !playerId) return;

      const pos = positionAbbrev(p);
      const group = groups[pos] || 'UNKNOWN';
      const weight = weights[pos] || 0.25;
      const experience = parseInt(p.experience?.years ?? p.experience ?? '0', 10) || 0;

      // Starter determination
      const isStarter = determineStarter(p, pos, startersByPosition);

      // Base rating from available metadata. This is our seed. It will
      // be refined when per-player stat enrichment is wired.
      const rating = estimateRating({
        experience,
        isStarter,
        position: pos,
        group,
        sport,
      });

      // Contribution splits: a player contributes to offense and/or
      // defense based on their position group.
      const { off, def } = contributionSplit(group, rating, weight);

      rows.push({
        sport,
        team_name: teamName,
        player_id: playerId,
        name,
        position: pos || null,
        position_group: group,
        jersey: p.jersey || null,
        rating,
        offensive_contribution: off,
        defensive_contribution: def,
        status: 'active',
        is_starter: isStarter,
        updated_at: new Date().toISOString(),
      });
    });

    return rows;
  }

  function positionAbbrev(player) {
    return (
      player.position?.abbreviation ||
      player.position?.name ||
      player.position ||
      null
    );
  }

  function determineStarter(player, pos, startersByPosition) {
    if (player.starter === true) return true;
    if (!pos) return false;
    const list = startersByPosition[pos] || [];
    if (!list.length) return false;
    const idx = list.findIndex(e => e.player === player);
    if (idx === -1) return false;
    // First or second on the depth chart counts as a starter for
    // positions that rotate heavily (NBA, MLB, NHL).
    const starterDepth = ['NBA', 'NCAAB', 'MLB', 'NHL', 'MLS'].includes(player.sport) ? 5 : 2;
    return idx < starterDepth;
  }

  // Simple seed rating. 50 = average. Rookies cap lower.
  function estimateRating({ experience, isStarter, position, group, sport }) {
    let rating = BASE_RATING;

    if (isStarter) rating += 10;

    // Experience curve
    if (experience === 0) rating += 0;
    else if (experience <= 2) rating += 3;
    else if (experience <= 4) rating += 6;
    else if (experience <= 7) rating += 8;
    else if (experience <= 10) rating += 9;
    else rating += 8; // slight decline beyond a decade

    // Positional scarcity bonus
    if (['QB', 'PG', 'SP', 'G', 'GK'].includes(position)) rating += 4;
    else if (['WR', 'CB', 'EDGE', 'SS', 'AM', 'ST'].includes(position)) rating += 2;

    // Rookies cap lower than veterans regardless of the metrics above
    if (experience === 0) return Math.min(rating, ROOKIE_CEILING);

    return Math.min(rating, VETERAN_CEILING);
  }

  function contributionSplit(group, rating, weight) {
    // Offensive groups add to offense. Defensive groups add to defense.
    // Two-way groups (rare) split evenly.
    const offenseGroups = new Set([
      'OFFENSE_SKILL', 'OFFENSE_LINE',
      'GUARD', 'WING', 'BIG',
      'PITCHER_START', 'PITCHER_RELIEF',
      'CATCHER', 'INFIELD', 'OUTFIELD', 'DH',
      'FORWARD', 'MIDFIELD',
    ]);
    const defenseGroups = new Set([
      'DEFENSE_FRONT', 'DEFENSE_EDGE', 'DEFENSE_MID', 'DEFENSE_SECONDARY',
      'GOALIE', 'GOALKEEPER', 'DEFENSE',
    ]);

    const contribution = rating * weight;

    if (offenseGroups.has(group) && defenseGroups.has(group)) {
      return { off: round(contribution / 2, 2), def: round(contribution / 2, 2) };
    }
    if (offenseGroups.has(group)) return { off: round(contribution, 2), def: 0 };
    if (defenseGroups.has(group)) return { off: 0, def: round(contribution, 2) };
    // Unknown group — split evenly so we never lose a player entirely
    return { off: round(contribution / 2, 2), def: round(contribution / 2, 2) };
  }

  // ============================================================
  // ── REFRESH (used by the pipeline to keep ratings current) ──
  // ============================================================

  async function refreshRatings(sport) {
    const url = SUPABASE_URL();
    const key = SUPABASE_KEY();
    if (!url || !key) return { refreshed: 0 };

    const res = await fetch(
      `${url}/rest/v1/power_ratings?select=team_name,team_id&sport=eq.${sport}`,
      { headers: { apikey: key, Authorization: `Bearer ${key}` } }
    );
    if (!res.ok) return { refreshed: 0 };
    const teams = await res.json();

    let count = 0;
    for (const team of teams) {
      try {
        const rows = await buildTeam(sport, team.team_id, team.team_name);
        count += rows.length;
      } catch {}
    }
    return { refreshed: count };
  }

  // ============================================================
  // ── LOOKUP (used by injury fragmentation) ──
  // ============================================================

  async function getTeamRoster(sport, teamName) {
    const url = SUPABASE_URL();
    const key = SUPABASE_KEY();
    if (!url || !key) return [];

    try {
      const res = await fetch(
        `${url}/rest/v1/players?sport=eq.${sport}&team_name=eq.${encodeURIComponent(teamName)}&select=*`,
        { headers: { apikey: key, Authorization: `Bearer ${key}` } }
      );
      return res.ok ? await res.json() : [];
    } catch { return []; }
  }

  // ============================================================
  // ── UTILITIES ──
  // ============================================================

  function makeLogger(onProgress) {
    return (msg) => { if (typeof onProgress === 'function') onProgress(msg); };
  }

  function round(v, d) { const f = Math.pow(10, d); return Math.round(v * f) / f; }

})();

if (typeof window !== 'undefined') window.EDGE_ROSTER = EDGE_ROSTER;