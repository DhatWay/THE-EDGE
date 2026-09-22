// ============================================================
// EDGE — BOX SCORE FETCHER v1.2
//
// v1.2 — ESPN returns stats as a POSITIONAL array of strings,
// with the field names in a parallel `keys` array on the
// category. The previous version expected an array of
// {name, value} objects, which ESPN does not send — so every
// row was stored with an empty raw {} and all stat columns
// null. Fixed by zipping category.keys against entry.stats.
// ============================================================

const EDGE_BOXSCORE = (() => {

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

  return {
    buildSport,
    buildAll,
  };

  async function buildAll(options = {}) {
    const { sports = ['NFL'], onProgress = null } = options;
    const log = mk(onProgress);
    const summary = { sports: {}, totals: { games: 0, rows: 0 } };

    for (const sport of sports) {
      log(`── ${sport} ──`);
      try {
        const r = await buildSport(sport, { onProgress });
        summary.sports[sport] = r;
        summary.totals.games += r.games_fetched || 0;
        summary.totals.rows += r.rows_written || 0;
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

    log('  checking which already have player stats');
    const haveStats = await loadExistingGameIds(sport, url, key);
    log(`  ${haveStats.size} already fetched`);

    const pending = games.filter(g => !haveStats.has(g.game_id));
    log(`  ${pending.length} to fetch`);

    if (!pending.length) {
      return { games_fetched: 0, rows_written: 0, note: 'All games already fetched' };
    }

    let fetched = 0;
    let written = 0;
    const buffer = [];

    await parallelMap(pending, FETCH_CONCURRENCY, async (game) => {
      const rows = await fetchGameStats(sport, game);
      if (!rows.length) return;
      fetched++;
      buffer.push(...rows);

      if (buffer.length >= WRITE_CHUNK) {
        const chunk = buffer.splice(0, WRITE_CHUNK);
        const n = await writeRows(url, key, chunk, log);
        written += n;
      }

      if (fetched % 50 === 0) log(`    ${fetched}/${pending.length} games · ${written} rows`);
    });

    if (buffer.length) {
      const n = await writeRows(url, key, buffer, log);
      written += n;
    }

    log(`  done · ${fetched} games · ${written} rows written`);
    return { games_fetched: fetched, rows_written: written };
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

  async function loadExistingGameIds(sport, url, key) {
    const out = new Set();
    const pageSize = 1000;
    for (let offset = 0; offset < 500000; offset += pageSize) {
      try {
        const res = await fetch(
          `${url}/rest/v1/player_game_stats?sport=eq.${sport}` +
          `&select=game_id&limit=${pageSize}&offset=${offset}`,
          { headers: { apikey: key, Authorization: `Bearer ${key}` } }
        );
        if (!res.ok) break;
        const rows = await res.json();
        rows.forEach(r => out.add(r.game_id));
        if (rows.length < pageSize) break;
      } catch (e) {
        logEdgeError('boxscore.loadExisting.' + sport, e);
        break;
      }
    }
    return out;
  }

  async function fetchGameStats(sport, game) {
    const path = ESPN_MAP[sport];
    const url = `https://site.api.espn.com/apis/site/v2/sports/${path}/summary?event=${game.game_id}`;

    let data;
    try {
      const res = await fetch(url, { cache: 'no-store' });
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

        // ESPN sends stats positionally. `category.keys` names each
        // position; `entry.stats` is the array of values in the same
        // order. Zipping them is what produces a usable object.
        const keys = category.keys || category.names || category.labels || [];
        if (!Array.isArray(keys) || !keys.length) return;

        (category.athletes || []).forEach(entry => {
          const athlete = entry.athlete;
          if (!athlete?.id) return;

          const playerName = athlete.displayName || athlete.fullName || 'Unknown';

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
  // ── STAT MAPPING ──
  // ============================================================

  function buildStatRow(ctx) {
    const { sport, category, stats } = ctx;

    const row = {
      game_id: ctx.gameId,
      player_id: ctx.playerId,
      player_name: ctx.playerName,
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

  async function writeRows(url, key, rows, log) {
    if (!rows.length) return 0;
    let written = 0;

    for (let i = 0; i < rows.length; i += WRITE_CHUNK) {
      const chunk = rows.slice(i, i + WRITE_CHUNK);
      let ok = false;

      for (let attempt = 0; attempt < 3 && !ok; attempt++) {
        try {
          const res = await fetch(`${url}/rest/v1/player_game_stats`, {
            method: 'POST',
            headers: {
              apikey: key, Authorization: `Bearer ${key}`,
              'Content-Type': 'application/json',
              Prefer: 'return=minimal',
            },
            body: JSON.stringify(chunk),
          });
          if (res.ok) { ok = true; written += chunk.length; break; }
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

  function seasonOf(sport, date) {
    const m = date.getMonth() + 1;
    const y = date.getFullYear();
    const cross = (startMonth) => (m >= startMonth ? y : y - 1);
    switch (sport) {
      case 'NBA':
      case 'NHL':
      case 'NCAAB':
      case 'WNBA':  return cross(9);
      case 'NFL':
      case 'NCAAF': return cross(3);
      default:      return y;
    }
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