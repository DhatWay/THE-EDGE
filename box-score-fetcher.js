// ============================================================
// EDGE — BOX SCORE FETCHER v1.4
//
// v1.4 changes:
//
//   · Per-player-per-game rows are merged before the write.
//     ESPN returns one row per stat category. A quarterback
//     appears in a passing row and a rushing row for the same
//     game; a two-way player can appear in three. The v1.3
//     fetcher pushed all of them to player_game_stats and
//     asked the database to upsert on (game_id, player_id),
//     which the unique index could not do — the rows within a
//     single POST batch carried the same key, so Postgres
//     rejected the whole chunk with ON CONFLICT DO UPDATE
//     command cannot affect row a second time. Every game
//     failed. The merge now collapses the category rows into
//     one row per player-game before the write.
//
//     The merge keeps the identity columns from the first row
//     seen for the player (game_id, player_id, team, position,
//     etc.) and fills every stat column from whichever
//     category row actually carried it. A column that is null
//     in one row and populated in another ends up populated
//     in the merged result. A column that is null everywhere
//     stays null.
//
//   · The unique index is not partial. The v1.3 SCHEMA_SQL
//     emitted `create unique index ... on (game_id,
//     player_id)` which is fine, but the previous writer had
//     already inserted duplicate rows for every player who
//     appeared in two stat categories. Creating the index
//     against that data fails. A companion migration ships
//     with this file that dedupes first. Both need to run.
//
//   · Write chunk is smaller. 500 rows per chunk could hold
//     many duplicate keys before the merge existed. With the
//     merge, 500 is safe, but the chunk is now 400 to keep
//     the request body under 200KB on the widest sports.
//
//   · position_group is written. Same as v1.3.
//
//   · Season labels match ats-tracker, power-engine,
//     trends-engine, prop-trends-engine.
//
// v1.3 changes (retained):
//   · Writes are idempotent via on_conflict + merge-duplicates.
//   · Half-stored games are retried.
//   · Failures are tracked in the run summary.
// ============================================================

const EDGE_BOXSCORE = (() => {

  const BUILD = 'box-20261006-03';

  const SUPABASE_URL = () => localStorage.getItem('edge_supabase_url');
  const SUPABASE_KEY = () => localStorage.getItem('edge_supabase_key');

  const ESPN_MAP = {
    NFL:   'football/nfl',
    NCAAF: 'football/college-football',
    NBA:   'basketball/nba',
    WNBA:  'basketball/wnba',
    NCAAB: 'basketball/mens-college-basketball',
    MLB:   'baseball/mlb',
    NHL:   'hockey/nhl',
    MLS:   'soccer/usa.1',
  };

  const FETCH_CONCURRENCY = 6;
  const WRITE_CHUNK = 400;

  // The unique index this fetcher relies on. Emitted as a
  // string so any page that loads the module can print it.
  // Non-partial on purpose — PostgREST's on_conflict clause
  // cannot target a partial index.
  // The index cannot be built while old one-row-per-category
  // duplicates exist, so those games are deleted first; the next
  // Fetch Box Scores run refetches them as one row per player.
  const SCHEMA_SQL = `alter table public.player_game_stats add column if not exists position text;
alter table public.player_game_stats add column if not exists position_group text;
delete from public.player_game_stats where game_id in (
  select game_id from public.player_game_stats group by game_id, player_id having count(*) > 1
);
create unique index if not exists player_game_stats_unique_idx
  on public.player_game_stats (game_id, player_id);`;

  // Columns added after the table was first created. A missing one
  // is left out of the write instead of failing every insert.
  const OPTIONAL_COLUMNS = ['position', 'position_group'];

  return {
    BUILD,
    buildAll,
    buildSport,
    schemaSql,
    SCHEMA_SQL,
    positionGroupFor,
    mergePlayerRows,
  };

  function schemaSql() { return SCHEMA_SQL; }

  async function buildAll(options = {}) {
    const { sports = ['NFL'], onProgress = null } = options;
    const log = mk(onProgress);
    const summary = {
      sports: {},
      totals: { games: 0, rows: 0, failed: 0, retried: 0 },
    };

    for (const sport of sports) {
      log(`── ${sport} ──`);
      try {
        const r = await buildSport(sport, { onProgress });
        summary.sports[sport] = r;
        summary.totals.games += r.games_fetched || 0;
        summary.totals.rows += r.rows_written || 0;
        summary.totals.failed += r.games_failed || 0;
        summary.totals.retried += r.games_retried || 0;
      } catch (e) {
        log(`${sport} failed: ${e.message}`);
        summary.sports[sport] = { error: e.message };
      }
    }
    return summary;
  }

  async function buildSport(sport, options = {}) {
    const log = mk(options.onProgress);
    const url = SUPABASE_URL();
    const key = SUPABASE_KEY();
    if (!url || !key) throw new Error('Supabase not connected');
    if (!ESPN_MAP[sport]) throw new Error(`Unknown sport: ${sport}`);

    // ESPN's MLS game summaries do not carry the player box this
    // parser reads: all 1,164 came back empty and were re-requested
    // on every run. Skipped until a soccer parser exists.
    if (sport === 'MLS') {
      log('  MLS skipped — ESPN soccer summaries have no player box in this format');
      return { games_fetched: 0, rows_written: 0, games_failed: 0, games_retried: 0, skipped: true };
    }

    log('  loading game list from historical_odds');
    const games = await loadGames(sport, url, key);
    log(`  ${games.length} games on file`);

    log('  checking which already have complete player stats');
    const existing = await loadExistingCounts(sport, url, key, games.map(g => String(g.game_id)));
    log(`  ${existing.size} games have some stats on file`);

    const pending = games.filter(g => !existing.has(g.game_id));
    const retryable = games.filter(g => existing.has(g.game_id));

    // A game with a small stored row count is a partial write
    // and deserves a re-fetch. Twelve rows for a team sport is
    // the floor.
    const MIN_ROWS_PER_GAME = 12;
    const retry = retryable.filter(g => (existing.get(g.game_id) || 0) < MIN_ROWS_PER_GAME);

    log(`  ${pending.length} never fetched · ${retry.length} partial (retrying)`);
    const missingCols = await probeOptionalColumns(url, key, log);

    const queue = [...pending, ...retry];
    if (!queue.length) {
      return { games_fetched: 0, rows_written: 0, games_failed: 0, games_retried: 0,
               note: 'All games already fetched' };
    }

    let fetched = 0;
    let failed = 0;
    let retried = 0;
    let written = 0;
    const buffer = [];

    await parallelMap(queue, FETCH_CONCURRENCY, async (game) => {
      const raw = await fetchGameStats(sport, game);
      if (!raw.length) { failed++; return; }

      // ── Merge ──
      // ESPN returns one row per stat category. Collapse to
      // one row per player before the write so the upsert on
      // (game_id, player_id) works.
      const rows = mergePlayerRows(raw);
      if (!rows.length) { failed++; return; }

      if (existing.has(game.game_id)) retried++;
      fetched++;
      buffer.push(...rows);

      if (buffer.length >= WRITE_CHUNK) {
        const chunk = buffer.splice(0, WRITE_CHUNK);
        const n = await writeRows(url, key, chunk, log, missingCols);
        written += n;
      }

      if (fetched % 50 === 0) {
        log(`    ${fetched}/${queue.length} games · ${written} rows`);
      }
    });

    if (buffer.length) {
      const n = await writeRows(url, key, buffer, log, missingCols);
      written += n;
    }

    log(`  done · ${fetched} games · ${written} rows · ${retried} retried · ${failed} failed`);
    return {
      games_fetched: fetched,
      rows_written: written,
      games_failed: failed,
      games_retried: retried,
    };
  }

  async function loadGames(sport, url, key) {
    const out = [];
    const pageSize = 1000;
    for (let offset = 0; offset < 20000; offset += pageSize) {
      try {
        const res = await fetch(
          `${url}/rest/v1/historical_odds?sport=eq.${sport}` +
          `&select=game_id,home,away,game_date` +
          `&order=game_date.asc,game_id.asc&limit=${pageSize}&offset=${offset}`,
          { headers: { apikey: key, Authorization: `Bearer ${key}` } }
        );
        if (!res.ok) break;
        const rows = await res.json();
        out.push(...rows);
        if (rows.length < pageSize) break;
      } catch (e) {
        logEdgeError('boxscore.loadGames.' + sport, e);
        break;
      }
    }
    // Ordering by game_date alone left ties (NHL games at the same
    // 7pm start) in no fixed order, so a page boundary could return
    // the same game twice. Fetched twice in one run, its rows landed
    // twice in one write — Postgres error 21000. One entry per game.
    const seen = new Set();
    return out.filter(g => {
      const id = String(g.game_id);
      if (seen.has(id)) return false;
      seen.add(id);
      return true;
    });
  }

  // Returns a Map of game_id → stored row count, for the games about to
  // be fetched only. It used to page through every stored row for the
  // sport (80,000+ for NCAAB); a slow page deep in that read ended it
  // early, the rest looked missing, and the run started over. Asking
  // about the candidate games in small batches is fast and complete.
  // (Writes were never duplicated — they upsert on game_id + player_id —
  // but the whole sport was re-downloaded.)
  async function loadExistingCounts(sport, url, key, gameIds = []) {
    const counts = new Map();
    const ids = [...new Set(gameIds.filter(Boolean))];
    for (let i = 0; i < ids.length; i += 40) {
      const chunk = ids.slice(i, i + 40);
      const inList = chunk.map(id => `"${String(id).replace(/"/g, '')}"`).join(',');
      let ok = false;
      for (let attempt = 0; attempt < 3 && !ok; attempt++) {
        try {
          let offset = 0;
          while (true) {
            const res = await fetch(
              `${url}/rest/v1/player_game_stats?game_id=in.(${inList})` +
              `&select=game_id&order=game_id.asc,player_id.asc&limit=1000&offset=${offset}`,
              { headers: { apikey: key, Authorization: `Bearer ${key}` } }
            );
            if (!res.ok) throw new Error('HTTP ' + res.status);
            const rows = await res.json();
            rows.forEach(r => { if (r.game_id) counts.set(r.game_id, (counts.get(r.game_id) || 0) + 1); });
            if (rows.length < 1000) break;
            offset += 1000;
          }
          ok = true;
        } catch (e) {
          if (attempt === 2) logEdgeError('boxscore.loadExisting.' + sport, e);
        }
      }
      // If a batch can't be checked after three tries, its games are
      // treated as already on file rather than re-downloaded blind.
      if (!ok) chunk.forEach(id => { if (!counts.has(id)) counts.set(id, 12); });
    }
    return counts;
  }

  async function fetchGameStats(sport, game) {
    const path = ESPN_MAP[sport];
    const url = `https://site.api.espn.com/apis/site/v2/sports/${path}/summary?event=${game.game_id}`;

    let data;
    try {
      const res = await fetch(url, { cache: 'no-store' });
      if (res.headers.get('x-edge-offline') === '1') return [];
      if (!res.ok) return [];
      data = await res.json();
    } catch (e) {
      logEdgeError('boxscore.fetch.' + game.game_id, e);
      return [];
    }

    const box = data?.boxscore?.players;
    if (!Array.isArray(box) || !box.length) return [];

    const header = data?.header;
    const competitors = header?.competitions?.[0]?.competitors || [];
    const homeComp = competitors.find(c => c.homeAway === 'home');
    const awayComp = competitors.find(c => c.homeAway === 'away');
    const homeName = homeComp?.team?.displayName || game.home;
    const awayName = awayComp?.team?.displayName || game.away;
    const gameDate = header?.competitions?.[0]?.date || game.game_date;
    const season = seasonOf(sport, new Date(gameDate));

    const rows = [];

    box.forEach(teamBlock => {
      const teamName = teamBlock.team?.displayName
                    || teamBlock.team?.shortDisplayName
                    || null;
      if (!teamName) return;

      const isHome = teamName === homeName;
      const opponent = isHome ? awayName : homeName;

      (teamBlock.statistics || []).forEach(category => {
        const catName = String(category.name || category.type || '').toLowerCase();

        const keys = category.keys || category.names || category.labels || [];
        if (!Array.isArray(keys) || !keys.length) return;

        (category.athletes || []).forEach(entry => {
          const athlete = entry.athlete;
          if (!athlete?.id) return;

          const playerName = athlete.displayName || athlete.fullName || 'Unknown';
          const position = athlete.position?.abbreviation
                        || athlete.position?.name
                        || null;
          const positionGroup = positionGroupFor(sport, position);

          const values = entry.stats || [];
          const stats = {};
          keys.forEach((key, i) => {
            if (!key) return;
            stats[key] = values[i] ?? null;
          });

          const row = buildStatRow({
            gameId: game.game_id,
            playerId: String(athlete.id),
            playerName,
            position,
            positionGroup,
            sport,
            teamName,
            opponent,
            gameDate,
            season,
            isHome,
            starter: entry.starter === true,
            category: catName,
            stats,
          });
          if (row) rows.push(row);
        });
      });
    });

    return rows;
  }

  // ============================================================
  // ── MERGE ──
  //
  // ESPN returns one row per (player, stat category). A
  // quarterback has a passing row and a rushing row for the
  // same game; a tight end with a carry has a rushing row on
  // top of a receiving row. The upsert keys on (game_id,
  // player_id), which means two rows with the same key in one
  // POST batch cause Postgres to reject the whole chunk.
  //
  // This collapses them. The first row seen for a player-game
  // supplies the identity columns (position, team, opponent,
  // game_date, starter flag). Every subsequent row fills any
  // stat column that was still null. Columns that are null in
  // every category row stay null.
  // ============================================================

  function mergePlayerRows(rows) {
    if (!rows.length) return rows;

    const byKey = new Map();
    for (const r of rows) {
      const key = `${r.game_id}|${r.player_id}`;
      let target = byKey.get(key);

      if (!target) {
        // First time we have seen this player-game. Take the
        // row as-is and remember it.
        target = { ...r };
        if (r.raw) target.raw = [r.raw];
        else target.raw = [];
        byKey.set(key, target);
        continue;
      }

      // Subsequent row. Fill every stat column that was null
      // on the target. Identity columns are left alone.
      // A start in any category is a start.
      if (r.starter === true) target.starter = true;

      for (const k of Object.keys(r)) {
        if (k === 'game_id' || k === 'player_id') continue;
        if (k === 'raw' || k === 'starter') continue;

        if (r[k] == null) continue;
        if (target[k] == null) {
          target[k] = r[k];
        }
      }

      if (r.raw) target.raw.push(r.raw);
    }

    return Array.from(byKey.values());
  }

  // ============================================================
  // ── POSITION GROUP ──
  // ============================================================

  function positionGroupFor(sport, position) {
    if (!position) return null;
    const pos = String(position).toUpperCase();

    const MAPS = {
      NFL: {
        QB: 'QB', RB: 'RB', FB: 'RB', HB: 'RB',
        WR: 'WR', TE: 'TE',
        OT: 'OFFENSE_LINE', OG: 'OFFENSE_LINE', C: 'OFFENSE_LINE',
        G: 'OFFENSE_LINE', T: 'OFFENSE_LINE', OL: 'OFFENSE_LINE',
        DT: 'DEFENSE_FRONT', NT: 'DEFENSE_FRONT', DL: 'DEFENSE_FRONT',
        DE: 'DEFENSE_EDGE', EDGE: 'DEFENSE_EDGE', OLB: 'DEFENSE_EDGE',
        LB: 'DEFENSE_MID', ILB: 'DEFENSE_MID', MLB: 'DEFENSE_MID',
        CB: 'DEFENSE_SECONDARY', S: 'DEFENSE_SECONDARY',
        FS: 'DEFENSE_SECONDARY', SS: 'DEFENSE_SECONDARY', DB: 'DEFENSE_SECONDARY',
        K: 'SPECIAL', P: 'SPECIAL', LS: 'SPECIAL',
      },
      NBA:   { PG: 'GUARD', SG: 'GUARD', G: 'GUARD', SF: 'WING', GF: 'WING', F: 'WING', PF: 'BIG', C: 'BIG', FC: 'BIG' },
      MLB:   { SP: 'PITCHER_START', P: 'PITCHER_START', RP: 'PITCHER_RELIEF', CP: 'PITCHER_RELIEF',
               C: 'CATCHER', '1B': 'INFIELD', '2B': 'INFIELD', '3B': 'INFIELD', SS: 'INFIELD', IF: 'INFIELD',
               LF: 'OUTFIELD', CF: 'OUTFIELD', RF: 'OUTFIELD', OF: 'OUTFIELD', DH: 'DH' },
      NHL:   { C: 'FORWARD', LW: 'FORWARD', RW: 'FORWARD', W: 'FORWARD', F: 'FORWARD',
               D: 'DEFENSE', LD: 'DEFENSE', RD: 'DEFENSE', G: 'GOALIE' },
      MLS:   { G: 'GOALKEEPER', GK: 'GOALKEEPER',
               D: 'DEFENSE', CB: 'DEFENSE', LB: 'DEFENSE', RB: 'DEFENSE', DF: 'DEFENSE',
               M: 'MIDFIELD', CM: 'MIDFIELD', DM: 'MIDFIELD', AM: 'MIDFIELD', MF: 'MIDFIELD',
               F: 'FORWARD', ST: 'FORWARD', CF: 'FORWARD', LW: 'FORWARD', RW: 'FORWARD', FW: 'FORWARD' },
    };

    MAPS.NCAAF = MAPS.NFL;
    MAPS.NCAAB = MAPS.NBA;
    MAPS.WNBA  = MAPS.NBA;

    const table = MAPS[sport];
    if (!table) return null;
    if (table[pos]) return table[pos];
    const head = pos.split(/[\/\-\s]/)[0];
    return table[head] || null;
  }

  // ============================================================
  // ── STAT MAPPING ──
  // ============================================================

  function buildStatRow(ctx) {
    const { sport, category, stats } = ctx;

    const row = {
      game_id: ctx.gameId,
      player_id: ctx.playerId,
      player_name: ctx.playerName,
      position: ctx.position,
      position_group: ctx.positionGroup,
      sport: ctx.sport,
      team_name: ctx.teamName,
      opponent: ctx.opponent,
      game_date: ctx.gameDate,
      season: ctx.season,
      is_home: ctx.isHome,
      starter: ctx.starter,

      pass_attempts: null,
      pass_completions: null,
      passing_yards: null,
      passing_tds: null,
      interceptions: null,
      rush_attempts: null,
      rushing_yards: null,
      rushing_tds: null,
      targets: null,
      receptions: null,
      receiving_yards: null,
      receiving_tds: null,
      fumbles_lost: null,

      minutes: null,
      points: null,
      rebounds: null,
      assists: null,
      steals: null,
      blocks: null,
      turnovers: null,
      fg_made: null,
      fg_attempted: null,
      three_made: null,
      three_attempted: null,
      ft_made: null,
      ft_attempted: null,

      at_bats: null,
      hits: null,
      runs: null,
      rbis: null,
      home_runs: null,
      walks: null,
      strikeouts: null,

      innings_pitched: null,
      earned_runs: null,
      hits_allowed: null,
      walks_allowed: null,
      pitching_strikeouts: null,

      goals: null,
      shots: null,
      plus_minus: null,
      penalty_minutes: null,

      saves: null,
      goals_against: null,
      shots_against: null,

      shots_on_target: null,

      // The full ESPN stat copy is no longer stored: nothing reads it (the
      // stats used are all in their own columns) and it was the biggest
      // single use of database space.
      raw: null,
    };

    const num = (v) => {
      if (v == null || v === '' || v === '-') return null;
      const n = parseFloat(v);
      return isFinite(n) ? n : null;
    };

    if (sport === 'NFL' || sport === 'NCAAF') {
      if (category === 'passing') {
        row.pass_completions = num(stats.completions);
        row.pass_attempts    = num(stats.attempts);
        row.passing_yards    = num(stats.passingYards);
        row.passing_tds      = num(stats.passingTouchdowns);
        row.interceptions    = num(stats.interceptions);
      } else if (category === 'rushing') {
        row.rush_attempts = num(stats.rushingAttempts);
        row.rushing_yards = num(stats.rushingYards);
        row.rushing_tds   = num(stats.rushingTouchdowns);
      } else if (category === 'receiving') {
        row.targets         = num(stats.receivingTargets);
        row.receptions      = num(stats.receptions);
        row.receiving_yards = num(stats.receivingYards);
        row.receiving_tds   = num(stats.receivingTouchdowns);
      } else if (category === 'fumbles') {
        row.fumbles_lost = num(stats.fumblesLost);
      } else {
        return null;
      }
    } else if (sport === 'NBA' || sport === 'NCAAB' || sport === 'WNBA') {
      row.minutes        = num(stats.minutes);
      row.points         = num(stats.points);
      row.rebounds       = num(stats.rebounds);
      row.assists        = num(stats.assists);
      row.steals         = num(stats.steals);
      row.blocks         = num(stats.blocks);
      row.turnovers      = num(stats.turnovers);
      row.fg_made        = num(stats.fieldGoalsMade);
      row.fg_attempted   = num(stats.fieldGoalsAttempted);
      row.three_made     = num(stats.threePointFieldGoalsMade);
      row.three_attempted= num(stats.threePointFieldGoalsAttempted);
      row.ft_made        = num(stats.freeThrowsMade);
      row.ft_attempted   = num(stats.freeThrowsAttempted);
    } else if (sport === 'MLB') {
      if (category === 'batting') {
        row.at_bats    = num(stats.atBats);
        row.hits       = num(stats.hits);
        row.runs       = num(stats.runs);
        row.rbis       = num(stats.RBIs);
        row.home_runs  = num(stats.homeRuns);
        row.walks      = num(stats.baseOnBalls);
        row.strikeouts = num(stats.strikeouts);
      } else if (category === 'pitching') {
        row.innings_pitched     = num(stats.inningsPitched);
        row.earned_runs         = num(stats.earnedRuns);
        row.hits_allowed        = num(stats.hits);
        row.walks_allowed       = num(stats.walks);
        row.pitching_strikeouts = num(stats.strikeouts);
      } else {
        return null;
      }
    } else if (sport === 'NHL') {
      // ESPN's NHL box splits skaters into groups (forwards,
      // defensemen) rather than one "skaters" group. Only goalies
      // were being stored — two rows a game — so every NHL game
      // looked partial and was refetched on every run.
      if (category !== 'goalies') {
        row.goals           = num(stats.goals);
        row.assists         = num(stats.assists);
        row.shots           = num(stats.shots);
        row.plus_minus      = num(stats.plusMinus);
        row.penalty_minutes = num(stats.penaltyMinutes);
      } else if (category === 'goalies') {
        row.saves          = num(stats.saves);
        row.goals_against  = num(stats.goalsAgainst);
        row.shots_against  = num(stats.shotsAgainst);
      } else {
        return null;
      }
    } else if (sport === 'MLS') {
      row.goals           = num(stats.goals);
      row.assists         = num(stats.assists);
      row.shots           = num(stats.totalShots);
      row.shots_on_target = num(stats.shotsOnTarget);
      row.saves           = num(stats.saves);
      row.goals_against   = num(stats.goalsConceded);
    } else {
      return null;
    }

    return row;
  }

  // ============================================================
  // ── WRITE ──
  //
  // on_conflict=game_id,player_id + merge-duplicates makes the
  // write idempotent. With mergePlayerRows in front, no two
  // rows in a single POST batch share a key, so Postgres never
  // rejects the batch with "cannot affect row a second time."
  // ============================================================

  async function probeOptionalColumns(url, key, log) {
    const missing = new Set();
    for (const col of OPTIONAL_COLUMNS) {
      try {
        const res = await fetch(`${url}/rest/v1/player_game_stats?select=${col}&limit=1`, {
          headers: { apikey: key, Authorization: `Bearer ${key}` },
        });
        if (!res.ok) missing.add(col);
      } catch { missing.add(col); }
    }
    if (missing.size) {
      log(`  player_game_stats has no ${Array.from(missing).join(', ')} column — written without it. Run the migration SQL.`);
    }
    return missing;
  }

  // Keeps the first row for each (game_id, player_id) and fills its
  // empty columns from any repeat. Rows are already merged per game,
  // so this only catches a game that reached the batch twice.
  function dedupeBatch(rows) {
    const byKey = new Map();
    for (const r of rows) {
      const k = `${r.game_id}|${r.player_id}`;
      const t = byKey.get(k);
      if (!t) { byKey.set(k, { ...r }); continue; }
      for (const c of Object.keys(r)) {
        if (t[c] == null && r[c] != null) t[c] = r[c];
      }
    }
    return Array.from(byKey.values());
  }

  async function writeRows(url, key, rowsIn, log, missingCols = null) {
    if (!rowsIn.length) return 0;
    let written = 0;
    // One row per (game_id, player_id) in the batch, whatever
    // produced it — the upsert rejects a batch that holds a key twice.
    const deduped = dedupeBatch(rowsIn);
    // The raw stat copy is never sent — the column can be dropped from
    // the table to free space, and writes keep working either way.
    const rows = deduped.map(r => {
      const o = {};
      Object.keys(r).forEach(k => { if (k !== 'raw' && !(missingCols && missingCols.has(k))) o[k] = r[k]; });
      return o;
    });

    for (let i = 0; i < rows.length; i += WRITE_CHUNK) {
      const chunk = rows.slice(i, i + WRITE_CHUNK);
      let ok = false;

      for (let attempt = 0; attempt < 3 && !ok; attempt++) {
        try {
          const res = await fetch(
            `${url}/rest/v1/player_game_stats?on_conflict=game_id,player_id`,
            {
              method: 'POST',
              headers: {
                apikey: key, Authorization: `Bearer ${key}`,
                'Content-Type': 'application/json',
                Prefer: 'resolution=merge-duplicates,return=minimal',
              },
              body: JSON.stringify(chunk),
            }
          );
          if (res.ok) { ok = true; written += chunk.length; break; }

          // 42P10 means the ON CONFLICT clause cannot be
          // satisfied — the unique index is missing. Report
          // once and stop, since every subsequent chunk will
          // fail the same way.
          const txt = await res.text().catch(() => '');
          if (res.status === 400 && /there is no unique or exclusion constraint/i.test(txt)) {
            log(`    write rejected 400 — the unique index is missing.`);
            log(`    Run this in Supabase:`);
            log(`    ${SCHEMA_SQL}`);
            return written;
          }

          log(`    write attempt ${attempt + 1}: HTTP ${res.status} ${txt.slice(0, 140)}`);
        } catch (e) {
          log(`    write attempt ${attempt + 1}: ${e.message}`);
        }
        if (!ok) await new Promise(r => setTimeout(r, 500 * (attempt + 1)));
      }
    }
    return written;
  }

  // ============================================================
  // ── SEASON LABEL ──
  // ============================================================

  function seasonOf(sport, date) {
    const m = date.getMonth() + 1;
    const y = date.getFullYear();

    // WNBA plays inside a calendar year, like MLB and MLS.
    if (sport === 'NBA' || sport === 'NHL' || sport === 'NCAAB') {
      return String(m >= 9 ? y : y - 1);
    }
    if (sport === 'NFL' || sport === 'NCAAF') {
      return String(m >= 3 ? y : y - 1);
    }
    return String(y);
  }

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

  function mk(onProgress) {
    return (m) => { if (typeof onProgress === 'function') onProgress(m); };
  }

})();

if (typeof window !== 'undefined') window.EDGE_BOXSCORE = EDGE_BOXSCORE;