// ============================================================
// EDGE — QUARTERBACK RATINGS
//
// A rating for every quarterback from the box scores already on file
// (player_game_stats), so a quarterback change moves the spread by the
// real gap between the two players instead of a flat number.
//
//   Rating  — adjusted yards per attempt:
//             (passing yards + 20 x touchdowns - 45 x interceptions)
//             / attempts, each game corrected for how good the opponent's
//             pass defense was, then pulled toward a starting value by
//             150 attempts (league average for regular starters, 1.2
//             below it for backups — most backups are below average).
//
//   For each team in a game:
//     usual QB    — the one who threw the most this season; the team's
//                   ratings were mostly built on his play
//     expected QB — last game's starter, unless he is listed out or
//                   doubtful, then the next healthy quarterback by attempts
//     change      — (expected - usual) x points per yard (NFL 2.5,
//                   college 2.0); 0 when they are the same player
//
// Covers both cases: the starter hurt, and a backup who has taken over
// while the starter is healthy. Football only.
// ============================================================

const EDGE_QB = (function () {
  const BUILD = 'qb-20261005-01';
  const SPORTS = new Set(['NFL', 'NCAAF']);
  const PTS_PER_YARD = { NFL: 2.5, NCAAF: 2.0 };
  const PRIOR_ATT = 150;
  const BACKUP_DROP = 1.2;
  const OPP_PRIOR_ATT = 300;
  const REGULAR_ATT = 150;          // this many attempts in the window makes a "regular"

  const SB_URL = () => localStorage.getItem('edge_supabase_url');
  const SB_KEY = () => localStorage.getItem('edge_supabase_key');
  const round = (v, d) => { const f = Math.pow(10, d); return Math.round(v * f) / f; };

  function teamKey(name, sport) {
    if (window.EDGE_TEAMS && EDGE_TEAMS.normalize) return EDGE_TEAMS.normalize(name, sport);
    return String(name || '').toLowerCase().replace(/[^a-z0-9 ]/g, '').replace(/\s+/g, ' ').trim();
  }
  const nameKey = n => String(n || '').toLowerCase().normalize('NFD').replace(/[\u0300-\u036f]/g, '')
    .replace(/\b(jr|sr|ii|iii|iv)\b/g, '').replace(/[^a-z ]/g, '').replace(/\s+/g, ' ').trim();

  async function loadRows(sport) {
    const url = SB_URL(), key = SB_KEY();
    if (!url || !key) throw new Error('Supabase not connected');
    const since = new Date(Date.now() - 400 * 86400000).toISOString().slice(0, 10);
    const rows = [];
    for (let off = 0; off < 30000; off += 1000) {
      const res = await fetch(`${url}/rest/v1/player_game_stats?sport=eq.${sport}&pass_attempts=gt.0&game_date=gte.${since}` +
        `&select=game_id,game_date,player_id,player_name,team_name,opponent,pass_attempts,passing_yards,passing_tds,interceptions` +
        `&order=game_date.asc,game_id.asc&limit=1000&offset=${off}`,
        { headers: { apikey: key, Authorization: `Bearer ${key}` } });
      if (!res.ok) throw new Error('player_game_stats HTTP ' + res.status);
      const page = await res.json();
      rows.push(...page);
      if (page.length < 1000) break;
    }
    return rows;
  }

  function build(sport, rows) {
    const val = r => (Number(r.passing_yards) || 0) + 20 * (Number(r.passing_tds) || 0) - 45 * (Number(r.interceptions) || 0);
    let lgNum = 0, lgAtt = 0;
    const opp = {};
    rows.forEach(r => {
      const a = Number(r.pass_attempts) || 0;
      if (!a) return;
      lgNum += val(r); lgAtt += a;
      const k = teamKey(r.opponent, sport);
      const o = opp[k] = opp[k] || { num: 0, att: 0 };
      o.num += val(r); o.att += a;
    });
    const lg = lgAtt ? lgNum / lgAtt : 6.5;
    const oppAdj = team => { const o = opp[teamKey(team, sport)]; return o ? ((o.num + lg * OPP_PRIOR_ATT) / (o.att + OPP_PRIOR_ATT)) - lg : 0; };

    const players = {};
    rows.forEach(r => {
      const a = Number(r.pass_attempts) || 0;
      if (!a) return;
      const p = players[r.player_id] = players[r.player_id] || { id: r.player_id, name: r.player_name, adjNum: 0, att: 0, team: null, lastDate: null };
      p.adjNum += val(r) - oppAdj(r.opponent) * a;
      p.att += a;
      if (!p.lastDate || r.game_date >= p.lastDate) { p.lastDate = r.game_date; p.team = r.team_name; }
    });
    return { lg, players, rows };
  }

  function ratingOf(model, p) {
    if (!p) return null;
    const prior = p.att >= REGULAR_ATT ? model.lg : model.lg - BACKUP_DROP;
    return (p.adjNum + prior * PRIOR_ATT) / (p.att + PRIOR_ATT);
  }

  // One team's quarterback picture for a game.
  function teamView(sport, model, team, injured, seasonStart) {
    const tk = teamKey(team, sport);
    const teamRows = model.rows.filter(r => teamKey(r.team_name, sport) === tk);
    if (!teamRows.length) return null;
    const season = seasonStart ? teamRows.filter(r => new Date(r.game_date) >= seasonStart) : teamRows;
    const pool = season.length ? season : teamRows;
    // Attempts per quarterback for this team (this season when it has games).
    const att = {};
    pool.forEach(r => { att[r.player_id] = (att[r.player_id] || 0) + (Number(r.pass_attempts) || 0); });
    const byAtt = Object.keys(att).sort((a, b) => att[b] - att[a]);
    const usual = model.players[byAtt[0]];
    // Last game's starter: most attempts in the team's latest game.
    const lastDate = pool.reduce((m, r) => r.game_date > m ? r.game_date : m, '');
    const lastGame = pool.filter(r => r.game_date === lastDate).sort((a, b) => (Number(b.pass_attempts) || 0) - (Number(a.pass_attempts) || 0));
    const lastStarter = lastGame[0] ? model.players[lastGame[0].player_id] : usual;
    const out = new Set((injured || []).filter(i => (i.multiplier || 0) >= 0.8).map(i => nameKey(i.name)));
    let expected = lastStarter, reason = 'usual starter';
    if (expected && out.has(nameKey(expected.name))) {
      const next = byAtt.map(id => model.players[id]).find(p => p && !out.has(nameKey(p.name)));
      reason = `${expected.name} listed out or doubtful`;
      expected = next || null;
    } else if (expected && usual && expected.id !== usual.id) {
      reason = `${expected.name} started last game in place of ${usual.name}`;
    }
    if (!usual || !expected) return null;
    const rUsual = ratingOf(model, usual), rExp = ratingOf(model, expected);
    const delta = expected.id === usual.id ? 0 : (rExp - rUsual) * (PTS_PER_YARD[sport] || 2.5);
    return {
      usual: usual.name, usual_rating: round(rUsual, 2), usual_attempts: usual.att,
      expected: expected.name, expected_rating: round(rExp, 2), expected_attempts: expected.att,
      delta: round(delta, 2), reason,
    };
  }

  // { gameId: { home_delta, away_delta, home, away } } for football games.
  async function forGames(games, injuriesByGame = {}, log = () => {}) {
    const out = {};
    const bySport = {};
    (games || []).forEach(g => { const s = g._sport || g.sport; if (SPORTS.has(s)) (bySport[s] = bySport[s] || []).push(g); });
    for (const [sport, list] of Object.entries(bySport)) {
      let model;
      try { model = build(sport, await loadRows(sport)); }
      catch (e) { log(`  quarterbacks (${sport}): ${e.message}`); continue; }
      const seasonStart = (window.EDGE_POWER && EDGE_POWER.seasonStart) ? EDGE_POWER.seasonStart(sport, new Date()) : null;
      let rated = 0, changes = 0;
      list.forEach(g => {
        const inj = injuriesByGame[g.id] || {};
        const home = teamView(sport, model, g.home_team, inj.home, seasonStart);
        const away = teamView(sport, model, g.away_team, inj.away, seasonStart);
        if (!home && !away) return;
        out[g.id] = { home_delta: home ? home.delta : 0, away_delta: away ? away.delta : 0, home, away };
        rated++;
        if ((home && home.delta) || (away && away.delta)) changes++;
      });
      log(`  quarterbacks (${sport}): ${Object.keys(model.players).length} rated · ${rated} games · ${changes} with a quarterback change`);
    }
    return out;
  }

  return { BUILD, forGames, build, teamView, ratingOf };
})();

if (typeof window !== 'undefined') window.EDGE_QB = EDGE_QB;
