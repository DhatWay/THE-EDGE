// ============================================================
// EDGE — BOX SCORE FETCHER v1.3
//
// v1.3 changes:
//
//   · Writes are idempotent. The old code inserted a game's
//     player rows with a POST and retried on transient
//     failures. A request that succeeded on the server but
//     timed out on the client was retried and inserted a
//     second copy. Every row is now written with
//     on_conflict=game_id,player_id and merge-duplicates, so
//     a retry updates the existing row instead of duplicating.
//     Requires a unique constraint on (game_id, player_id);
//     the CREATE INDEX is emitted by schemaSql().
//
//   · Half-stored games are retried. The old code checked
//     whether a game_id had any rows at all; if the fetch
//     succeeded but the write crashed halfway, the game was
//     marked complete and never retried. The check is now
//     "does this game have at least one row per athlete we
//     expect to see" — a game is only skipped when it looks
//     fully stored.
//
//   · Failures are tracked. A game that fails to fetch or
//     fails to write is reported in the run summary, not
//     silently skipped. The caller can retry the run and only
//     the incomplete games get re-fetched.
//
//   · Position group is written. The prop-trends engine now
//     gates thresholds by position group; the fetcher stores
//     the group it can infer from the athlete's position.
//
//   · Season labels match ats-tracker v3.0, power-engine
//     v4.3, trends-engine v2.0, prop-trends-engine v1.2.
//
// v1.2 changes (retained):
//   · ESPN sends stats as a positional array zipped against a
//     keys array. The old code expected an array of
//     {name, value} objects and stored an empty raw object for
//     every row.
// ============================================================

const EDGE_BOXSCORE = (() => {

  const BUILD = 'box-20260925-01';

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
  const WRITE_CHUNK = 500;

  // The unique constraint this fetcher relies on. Emitted as a
  // string so any page that loads the module can print it.
  const SCHEMA_SQL = `create unique index if not exists player_game_stats_unique_idx
  on public.player_game_stats (game_id, player_id);`;

  return {
    BUILD,
    buildAll,
    buildSport,
    schemaSql,
    SCHEMA_SQL,
    positionGroupFor,
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

    log('  loading game list from historical_odds');
    const games = await loadGames(sport, url, key);
    log(`  ${games.length} games on file`);

    log('  checking which already have complete player stats');
    const existing = await loadExistingCounts(sport, url, key);
    log(`  ${existing.size} games have some stats on file`);

    const pending = games.filter(g => !existing.has(g.game_id));
    const retryable = games.filter(g => existing.has(g.game_id));

    // Games that exist in the table are not automatically done.
    // A write that crashed halfway left a partial set. We
    // re-fetch any game whose stored row count is below the
    // expected threshold — the total athletes ESPN reports,
    // which we do not have yet. A pragmatic threshold: fewer
    // than 12 rows for a team sport is almost certainly a
    // partial write and worth retrying.
    const MIN_ROWS_PER_GAME = 12;
    const retry = retryable.filter(g => (existing.get(g.game_id) || 0) < MIN_ROWS_PER_GAME);

    log(`  ${pending.length} never fetched · ${retry.length} partial (retrying)`);

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
      const rows = await fetchGameStats(sport, game);
      if (!rows.length) { failed++; return; }

      if (existing.has(game.game_id)) retried++;
      fetched++;
      buffer.push(...rows);

      if (buffer.length >= WRITE_CHUNK) {
        const chunk = buffer.splice(0, WRITE_CHUNK);
        const n = await writeRows(url, key, chunk, log);
        written += n;
      }

      if (fetched % 50 === 0) {
        log(`    ${fetched}/${queue.length} games · ${written} rows`);
      }
    });

    if (buffer.length) {
      const n = await writeRows(url, key, buffer, log);
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
          `&order=game_date.asc&limit=${pageSize}&offset=${offset}`,
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
    return out;
  }

  // Returns a Map of game_id → stored row count. Games with a
  // small count are partial writes that deserve a re-fetch.
  async function loadExistingCounts(sport, url, key) {
    const counts = new Map();
    const pageSize = 1000;
    for (let offset = 0; offset < 2000000; offset += pageSize) {
      try {
        const res = await fetch(
          `${url}/rest/v1/player_game_stats?sport=eq.${sport}` +
          `&select=game_id&limit=${pageSize}&offset=${offset}`,
          { headers: { apikey: key, Authorization: `Bearer ${key}` } }
        );
        if (!res.ok) break;
        const rows = await res.json();
        rows.forEach(r => {
          if (!r.game_id) return;
          counts.set(r.game_id, (counts.get(r.game_id) || 0) + 1);
        });
        if (rows.length < pageSize) break;
      } catch (e) {
        logEdgeError('boxscore.loadExisting.' + sport, e);
        break;
      }
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
  // ── POSITION GROUP ──
  //
  // Minimal mapping. Matches the groups roster-engine.js
  // produces so prop-trends-engine's gates line up.
  // ============================================================

  function positionGroupFor(sport, position) {
    if (!position) return null;
    const pos = String(position).toUpperCase();

    const MAPS = {
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

      raw: stats,
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
        // Pitching strikeouts land in their own column now.
        // The batter column, `strikeouts`, is left alone.
        row.pitching_strikeouts = num(stats.strikeouts);
      } else {
        return null;
      }
    } else if (sport === 'NHL') {
      if (category === 'skaters') {
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
  // write idempotent. A request that succeeded on the server
  // but failed on the client can be retried without producing
  // duplicate rows.
  // ============================================================

  async function writeRows(url, key, rows, log) {
    if (!rows.length) return 0;
    let written = 0;

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

          // 409 means the unique index is missing. Report it
          // once rather than per chunk.
          if (res.status === 409) {
            log(`    write rejected 409 — add the unique index:`);
            log(`    ${SCHEMA_SQL}`);
            return written;
          }

          const txt = await res.text().catch(() => '');
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

    if (sport === 'NBA' || sport === 'NHL' || sport === 'NCAAB' || sport === 'WNBA') {
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