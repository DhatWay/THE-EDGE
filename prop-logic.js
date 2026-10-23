// ============================================================
// EDGE — PROP LOGIC BY SPORT
//
// A player's line is decided by how much he plays, how much he does
// with it, who he faces and how the game is expected to go. Each sport
// builds its projection from its own drivers:
//
//   NBA / WNBA / NCAAB  minutes × production per minute (recent role,
//                       not the season's); the game's pace (its total);
//                       blowout risk (a big spread cuts starters'
//                       minutes); back-to-backs; what this opponent
//                       allows in this stat
//   NFL / NCAAF         role × efficiency — targets × yards per target,
//                       carries × yards per carry, attempts × yards per
//                       attempt; game script (the underdog throws more,
//                       the favorite runs more; the team's implied
//                       points); what this opponent allows in this stat
//   NHL                 shots and points scale with the team's implied
//                       goals; what this opponent allows
//   MLB                 pitcher strikeouts = strikeouts per inning ×
//                       expected innings, against how often this
//                       opponent's lineup strikes out; batters' hits by
//                       at-bats × hits per at-bat against the opponent
//
// Then calibration: once 100+ props of a sport are graded, its chances
// are pulled toward how often its props have actually hit.
// ============================================================

const EDGE_PROP_LOGIC = (function () {
  const BUILD = 'proplogic-20261022-01';
  const clamp = (v, lo, hi) => Math.max(lo, Math.min(hi, v));
  const round = (v, d = 2) => Math.round(v * 10 ** d) / 10 ** d;
  const mean = a => { const x = a.filter(v => v != null && isFinite(v)); return x.length ? x.reduce((s, v) => s + v, 0) / x.length : null; };
  const BASKETBALL = new Set(['NBA', 'WNBA', 'NCAAB']), FOOTBALL = new Set(['NFL', 'NCAAF']);
  const LEAGUE_TOTAL = { NBA: 226, WNBA: 164, NCAAB: 143, NFL: 44.5, NCAAF: 55, NHL: 6.1, MLB: 8.8 };

  // Role columns loaded alongside the stat, by sport and stat.
  function roleCols(sport, statKey) {
    if (BASKETBALL.has(sport)) return ['minutes'];
    if (FOOTBALL.has(sport)) {
      if (/^pass|completions|interceptions/.test(statKey)) return ['pass_attempts'];
      if (/^rush/.test(statKey)) return ['rush_attempts'];
      if (/receiv|receptions|targets|rush_rec/.test(statKey)) return ['targets', 'rush_attempts'];
      return [];
    }
    if (sport === 'MLB') return /pitching|earned|hits_allowed|walks_allowed/.test(statKey) ? ['innings_pitched'] : ['at_bats'];
    if (sport === 'NHL') return ['shots'];
    return [];
  }
  const ipToInnings = ip => { const w = Math.floor(ip), o = Math.round((ip - w) * 10); return w + o / 3; };

  // Role: the volume he gets (recent 5 weigh more than the last 10), and
  // what he does per unit of it. Returns null when the log lacks it.
  function rolePart(sport, statKey, rows) {
    const cols = roleCols(sport, statKey);
    if (!cols.length) return null;
    const role = r => cols.reduce((s, c) => s + (c === 'innings_pitched' ? ipToInnings(Number(r[c]) || 0) : (Number(r[c]) || 0)), 0);
    const withRole = rows.filter(r => role(r) > 0);
    if (withRole.length < 3) return null;
    const last5 = withRole.slice(0, 5), last15 = withRole.slice(0, 15);
    const roleProj = 0.6 * mean(last5.map(role)) + 0.4 * mean(last15.map(role));
    const rate = last15.reduce((s, r) => s + r.value, 0) / Math.max(1e-9, last15.reduce((s, r) => s + role(r), 0));
    const unit = cols.includes('minutes') ? 'minutes' : cols.includes('innings_pitched') ? 'innings' : cols.includes('at_bats') ? 'at-bats' : cols.includes('shots') ? 'shots' : cols.join('+');
    return { mu: roleProj * rate, roleProj, rate, unit };
  }

  // Game script and pace, from the game's own market numbers.
  function gamePart(sport, statKey, ctx) {
    const parts = [];
    let f = 1;
    const total = Number(ctx.total), spread = Number(ctx.homeSpread);
    const lg = LEAGUE_TOTAL[sport];
    const teamSpread = isFinite(spread) ? (ctx.playerIsHome ? spread : -spread) : null;   // negative = his team favored
    if (BASKETBALL.has(sport)) {
      if (isFinite(total) && lg) {
        const p = clamp(Math.pow(total / lg, 0.85), 0.88, 1.12);
        if (Math.abs(p - 1) > 0.005) { f *= p; parts.push(`pace: game total ${total} vs ${lg} league → ×${round(p, 3)}`); }
      }
      if (teamSpread != null && Math.abs(teamSpread) > 9 && ctx.starter) {
        const b = clamp(1 - 0.006 * (Math.abs(teamSpread) - 9), 0.9, 1);
        f *= b; parts.push(`blowout risk at ${teamSpread > 0 ? '+' : ''}${teamSpread} → starter's minutes ×${round(b, 3)}`);
      }
      if (isFinite(ctx.restDays) && ctx.restDays <= 1) { f *= 0.97; parts.push('back-to-back → ×0.97'); }
    }
    if (FOOTBALL.has(sport) && isFinite(total) && teamSpread != null) {
      const implied = total / 2 - teamSpread / 2;                       // his team's expected points
      const half = lg / 2;
      if (/pass|receiv|receptions|targets|completions/.test(statKey)) {
        const p = clamp(Math.pow(implied / half, 0.5) * (1 + 0.008 * teamSpread), 0.85, 1.15);  // trailing teams throw more
        if (Math.abs(p - 1) > 0.005) { f *= p; parts.push(`game script: team expected ${round(implied, 1)} pts, ${teamSpread > 0 ? 'underdog' : 'favorite'} by ${Math.abs(teamSpread)} → ×${round(p, 3)}`); }
      } else if (/rush/.test(statKey)) {
        const p = clamp(Math.pow(implied / half, 0.5) * (1 - 0.008 * teamSpread), 0.85, 1.15);  // leading teams run more
        if (Math.abs(p - 1) > 0.005) { f *= p; parts.push(`game script: team expected ${round(implied, 1)} pts, ${teamSpread > 0 ? 'underdog' : 'favorite'} by ${Math.abs(teamSpread)} → ×${round(p, 3)}`); }
      } else if (/td/.test(statKey)) {
        const p = clamp(implied / half, 0.75, 1.3);
        if (Math.abs(p - 1) > 0.005) { f *= p; parts.push(`team expected ${round(implied, 1)} pts → touchdowns ×${round(p, 3)}`); }
      }
    }
    if (sport === 'NHL' && isFinite(total) && teamSpread != null) {
      const implied = total / 2 - teamSpread / 4;
      const p = clamp(Math.pow(implied / (lg / 2), 0.7), 0.85, 1.15);
      if (Math.abs(p - 1) > 0.005) { f *= p; parts.push(`team expected ${round(implied, 2)} goals → ×${round(p, 3)}`); }
    }
    return { factor: f, parts };
  }

  // What this opponent allows in this stat, against the league: built
  // from the box scores of players who faced it (last 60 rows). Limited
  // to ±15%.
  async function opponentPart(sport, stat, opponent, url, key) {
    if (!opponent || !url || !key) return null;
    try {
      const cols = Array.from(new Set(stat.cols));
      const sel = `select=game_id,${cols.join(',')}`;
      const h = { headers: { apikey: key, Authorization: `Bearer ${key}` } };
      const [vs, lg] = await Promise.all([
        fetch(`${url}/rest/v1/player_game_stats?sport=eq.${sport}&opponent=eq.${encodeURIComponent(opponent)}&${sel}&order=game_date.desc&limit=600`, h).then(r => r.ok ? r.json() : []),
        fetch(`${url}/rest/v1/player_game_stats?sport=eq.${sport}&${sel}&order=game_date.desc&limit=3000`, h).then(r => r.ok ? r.json() : []),
      ]);
      const perGame = rows => { const by = {}; rows.forEach(r => { const v = cols.reduce((s, c) => s + (Number(r[c]) || 0), 0); by[r.game_id] = (by[r.game_id] || 0) + v; }); const v = Object.values(by); return v.length >= 4 ? mean(v) : null; };
      const a = perGame(vs), b = perGame(lg) != null ? perGame(lg) / 2 : null;   // league rows hold both teams' players
      if (a == null || b == null || b <= 0) return null;
      const f = clamp(a / b, 0.85, 1.15);
      return { factor: f, why: `${opponent} allow ${round(a, 1)} ${stat.label.toLowerCase()} a game vs ${round(b, 1)} league average → ×${round(f, 3)}` };
    } catch { return null; }
  }

  // MLB pitcher strikeouts: also how often the opposing lineup strikes out.
  async function lineupKPart(sport, statKey, opponent, url, key) {
    if (sport !== 'MLB' || statKey !== 'pitching_strikeouts' || !opponent) return null;
    try {
      const h = { headers: { apikey: key, Authorization: `Bearer ${key}` } };
      const [opp, lg] = await Promise.all([
        fetch(`${url}/rest/v1/player_game_stats?sport=eq.MLB&team_name=eq.${encodeURIComponent(opponent)}&at_bats=gt.0&select=strikeouts,at_bats&order=game_date.desc&limit=400`, h).then(r => r.ok ? r.json() : []),
        fetch(`${url}/rest/v1/player_game_stats?sport=eq.MLB&at_bats=gt.0&select=strikeouts,at_bats&order=game_date.desc&limit=3000`, h).then(r => r.ok ? r.json() : []),
      ]);
      const rate = rows => { const ab = rows.reduce((s, r) => s + (Number(r.at_bats) || 0), 0); return ab > 50 ? rows.reduce((s, r) => s + (Number(r.strikeouts) || 0), 0) / ab : null; };
      const a = rate(opp), b = rate(lg);
      if (a == null || b == null) return null;
      const f = clamp(a / b, 0.8, 1.2);
      return { factor: f, why: `${opponent} strike out in ${round(a * 100, 1)}% of at-bats vs ${round(b * 100, 1)}% league → ×${round(f, 3)}` };
    } catch { return null; }
  }

  // Calibration from your graded props: once a sport has 100+, its
  // chances are pulled toward how often its props actually hit (one
  // shrink factor per sport, fitted to the graded results).
  const calCache = {};
  async function calibration(sport, url, key) {
    if (calCache[sport] && Date.now() - calCache[sport].t < 6 * 3600000) return calCache[sport];
    let out = { k: 1, n: 0, t: Date.now() };
    try {
      const r = await fetch(`${url}/rest/v1/prop_picks?sport=eq.${sport}&result=in.(W,L)&prob_over=not.is.null&select=prob_over,pick_side,result&limit=5000`,
        { headers: { apikey: key, Authorization: `Bearer ${key}` } });
      const rows = r.ok ? await r.json() : [];
      if (rows.length >= 100) {
        // Best k on a grid: chance of the picked side = 0.5 + k (p − 0.5).
        const pts = rows.map(x => ({ p: x.pick_side === 'under' ? 1 - Number(x.prob_over) : Number(x.prob_over), y: x.result === 'W' ? 1 : 0 }));
        let best = { k: 1, ll: Infinity };
        for (let k = 0.2; k <= 1.2001; k += 0.05) {
          let ll = 0; pts.forEach(({ p, y }) => { const q = clamp(0.5 + k * (p - 0.5), 0.02, 0.98); ll -= y ? Math.log(q) : Math.log(1 - q); });
          if (ll < best.ll) best = { k, ll };
        }
        out = { k: round(best.k, 2), n: rows.length, t: Date.now() };
      } else out.n = rows.length;
    } catch {}
    calCache[sport] = out;
    return out;
  }
  const applyCal = (pOver, k) => (pOver == null ? null : clamp(0.5 + k * (pOver - 0.5), 0.02, 0.98));

  return { BUILD, roleCols, rolePart, gamePart, opponentPart, lineupKPart, calibration, applyCal };
})();

if (typeof window !== 'undefined') window.EDGE_PROP_LOGIC = EDGE_PROP_LOGIC;
