// ============================================================
// EDGE — MATCHUP MODE                                (matchup-mode.js)
// ============================================================
// Every game rated from the comparison of the two teams alone. It runs
// beside the regular picks on every pipeline run and keeps its own
// record; nothing in the regular pipeline reads it.
//
// The order, for each game:
//   1. Starting point — the ranking's ratings: last season carried into
//      this one, then this season's games oldest to newest, with the
//      home edge worked out for this pairing. Always the hand-set blend,
//      never a fitted model saved by a Slate Test.
//   2. Recent form — each team's last five games against the spread,
//      the newest counting most.
//   3. The matchup — coaching, and offense against defense.
//   4. Game day — key players (quarterback, starting pitcher, goalie),
//      rest, injuries, bullpen, travel, and weather for football.
//   5. ATS and spots — each team's cover record in today's roles
//      (home or road, favorite or underdog), the situational spots that
//      fire, and schedule spots (back-to-back, letdown, lookahead,
//      revenge).
//   6. Physics — the margin against the posted spread, with the two
//      teams' own spread of results, by the sport's own math. The side
//      more likely to cover is the pick.
//
// The only outside number is the posted spread. No market chance, no
// calibration, no caps, no value bar: every game with a spread gets a
// pick. Every sport has its own table of settings below.
// ============================================================

const EDGE_MATCHUP = (() => {
  const VERSION = 'matchup-1.0';
  const STORE = 'edge_matchup_picks';
  const DB_FLAG = 'edge_matchup_db';
  const TABLE = 'matchup_picks';

  // A typical miss in each sport's own units (points, runs, goals).
  const SIGMA = { NFL: 13.5, NCAAF: 16, NBA: 12, WNBA: 11, NCAAB: 11, MLB: 4.4, NHL: 2.4, MLS: 1.8 };
  // Count-based sports run on goal/run distributions in step 6.
  const COUNT = new Set(['MLB', 'NHL', 'MLS']);
  // Weather moves the margin only where it changes how points are scored.
  const WEATHER = new Set(['NFL', 'NCAAF']);
  // When each season starts [month, day].
  const SEASON_START = { NFL: [8, 1], NCAAF: [8, 15], NBA: [10, 1], WNBA: [5, 1], NCAAB: [11, 1], MLB: [3, 15], NHL: [10, 1], MLS: [2, 15] };

  // Each sport's own settings, as fractions of its typical miss.
  //   b2b        second game on consecutive days (only when the ranking
  //              doesn't already count rest)
  //   letdown    the game after a big win, against a weaker team
  //   lookahead  a much tougher game next, while favored today
  //   revenge    lost the last meeting this season
  //   tz / miles road team's time-zone change, and a long trip
  //   spot       each situational spot that fires; spotCap all of them
  //   form       how much last five games against the spread carry
  //   ats        how much today's-role cover records carry
  //   bigWin     what counts as a big win, in the sport's units
  //   lookDays   how far ahead a lookahead game can be
  const S = {
    NFL:   { b2b: 0,    letdown: 0.08, lookahead: 0.06, revenge: 0.04, tz: 0.02, miles: 0.015, spot: 0.03, spotCap: 0.15, form: 0.25, ats: 0.5, bigWin: 17, lookDays: 8 },
    NCAAF: { b2b: 0,    letdown: 0.08, lookahead: 0.06, revenge: 0.04, tz: 0.02, miles: 0.015, spot: 0.03, spotCap: 0.15, form: 0.25, ats: 0.5, bigWin: 21, lookDays: 8 },
    NBA:   { b2b: 0.12, letdown: 0.06, lookahead: 0.04, revenge: 0.03, tz: 0.03, miles: 0.02,  spot: 0.03, spotCap: 0.15, form: 0.25, ats: 0.5, bigWin: 15, lookDays: 3 },
    WNBA:  { b2b: 0.12, letdown: 0.06, lookahead: 0.04, revenge: 0.03, tz: 0.03, miles: 0.02,  spot: 0.03, spotCap: 0.15, form: 0.25, ats: 0.5, bigWin: 15, lookDays: 3 },
    NCAAB: { b2b: 0.08, letdown: 0.07, lookahead: 0.05, revenge: 0.04, tz: 0.03, miles: 0.02,  spot: 0.03, spotCap: 0.15, form: 0.25, ats: 0.5, bigWin: 18, lookDays: 4 },
    MLB:   { b2b: 0,    letdown: 0.03, lookahead: 0.02, revenge: 0.02, tz: 0.02, miles: 0.01,  spot: 0.02, spotCap: 0.10, form: 0.20, ats: 0.4, bigWin: 6,  lookDays: 2 },
    NHL:   { b2b: 0.12, letdown: 0.05, lookahead: 0.04, revenge: 0.03, tz: 0.03, miles: 0.02,  spot: 0.02, spotCap: 0.10, form: 0.20, ats: 0.4, bigWin: 3,  lookDays: 3 },
    MLS:   { b2b: 0.06, letdown: 0.05, lookahead: 0.04, revenge: 0.03, tz: 0.02, miles: 0.02,  spot: 0.02, spotCap: 0.10, form: 0.20, ats: 0.4, bigWin: 3,  lookDays: 5 },
  };
  // Spots built from line movement are market readings, so they're left out.
  const MARKET_SPOT = /^line_moved|steam|reverse_line|line_move/i;
  const SQRT_2PI = Math.sqrt(2 * Math.PI);

  const num = v => (v == null || v === '' ? NaN : Number(v));
  const fin = v => isFinite(num(v));
  const clamp = (v, lo, hi) => Math.max(lo, Math.min(hi, v));
  const round = (v, d = 2) => { const f = Math.pow(10, d); return Math.round(v * f) / f; };
  const sigmaOf = sport => SIGMA[sport] || 12;
  const setOf = sport => S[sport] || S.NBA;

  function teamKey(name, sport) {
    try { if (window.EDGE_TEAMS && EDGE_TEAMS.normalize) return EDGE_TEAMS.normalize(name, sport); } catch {}
    return String(name || '').toLowerCase().replace(/[.'’`]/g, '').replace(/\s+/g, ' ').trim();
  }
  function pickKey(g) {
    const d = String(g.commence_time || '').slice(0, 10);
    return `${g.sport}|${d}|${teamKey(g.away_team, g.sport)}|${teamKey(g.home_team, g.sport)}`;
  }
  function seasonStart(sport, now = new Date()) {
    const [m, d] = SEASON_START[sport] || [1, 1];
    let y = now.getUTCFullYear();
    if (Date.UTC(y, m - 1, d) > now.getTime()) y -= 1;
    return new Date(Date.UTC(y, m - 1, d)).toISOString().slice(0, 10);
  }

  // ── This season's finished games, per sport, from historical_odds ──
  async function loadLogs(sports, url, key, log) {
    const out = {};
    if (!url || !key) return out;
    const headers = { apikey: key, Authorization: `Bearer ${key}` };
    for (const sport of sports) {
      const since = seasonStart(sport);
      const rows = [];
      try {
        for (let offset = 0; offset < 20000; offset += 1000) {
          const res = await fetch(`${url}/rest/v1/historical_odds?select=home,away,game_date,spread,home_score,away_score` +
            `&sport=eq.${sport}&game_date=gte.${since}&home_score=not.is.null&away_score=not.is.null` +
            `&order=game_date.asc&limit=1000&offset=${offset}`, { headers });
          if (!res.ok) break;
          const page = await res.json();
          rows.push(...page);
          if (page.length < 1000) break;
        }
      } catch (e) { if (log) log(`  matchup mode: ${sport} results unavailable (${e.message})`); }
      const byTeam = new Map();
      const add = (t, g) => { if (!byTeam.has(t)) byTeam.set(t, []); byTeam.get(t).push(g); };
      rows.forEach(r => {
        const hs = num(r.home_score), as = num(r.away_score);
        if (!isFinite(hs) || !isFinite(as) || !r.home || !r.away) return;
        const g = { date: String(r.game_date).slice(0, 10), home: teamKey(r.home, sport), away: teamKey(r.away, sport),
                    spread: fin(r.spread) ? num(r.spread) : null, hs, as };
        add(g.home, g); add(g.away, g);
      });
      out[sport] = byTeam;
    }
    return out;
  }

  // One team's view of a finished game: its margin, its line, how it covered.
  function teamView(g, team) {
    const home = g.home === team;
    const margin = home ? g.hs - g.as : g.as - g.hs;
    const line = g.spread == null ? null : (home ? g.spread : -g.spread);
    return { home, margin, line, cover: line == null ? null : margin + line, opp: home ? g.away : g.home, date: g.date };
  }

  // ── Step 1 & 3 & 4 (ranking parts): the ranking's margin, home view ──
  // Rebuilt from its hand-set blend when a fitted model replaced it, so
  // nothing a Slate Test saved shapes it.
  function rankingParts(prior) {
    const ext = prior.external_effect || {};
    const coaching = num(prior.coaching?.delta) || 0;
    const defense = num(prior.defense_matchup?.adjustment_points) || 0;
    const players = (num(prior.qb?.points) || 0) + (num(ext.pitchers) || 0) + (num(ext.goalies) || 0);
    const drivers = num(ext.sport_drivers) || 0;
    let ratings;
    if (prior.model_source === 'fitted') {
      const pw = fin(prior.projection_weight) ? num(prior.projection_weight) : 0.5;
      const ps = num(prior.projection_spread), cs = num(prior.composite_spread);
      let spread = isFinite(ps) && isFinite(cs) ? pw * ps + (1 - pw) * cs : (isFinite(cs) ? cs : ps);
      if (!isFinite(spread)) return null;
      const x = prior.external || {};
      if (x.sp && fin(x.sp.spread) && fin(x.sp.weight)) spread = (1 - x.sp.weight) * spread + x.sp.weight * x.sp.spread;
      if (x.eff && fin(x.eff.spread) && fin(x.eff.weight)) spread = (1 - x.eff.weight) * spread + x.eff.weight * x.eff.spread;
      ratings = -spread;
    } else {
      if (!fin(prior.model_spread)) return null;
      ratings = -num(prior.model_spread) - coaching - defense - players - drivers;
    }
    const restCounted = Array.isArray(prior.sport_drivers) && prior.sport_drivers.some(p => p && p.name === 'rest');
    const driverNames = Array.isArray(prior.sport_drivers) ? prior.sport_drivers.map(p => p && p.name).filter(Boolean) : [];
    return { ratings, coaching, defense, players, drivers, restCounted, driverNames };
  }

  // ── Step 2: recent form, last five against the spread ──
  function formPoints(games, sport) {
    const covers = games.map(v => v.cover).filter(v => v != null && isFinite(v)).slice(-5);
    if (!covers.length) return { pts: 0, n: 0 };
    let ws = 0, s = 0;
    covers.forEach((c, i) => { const w = i + 1; ws += w; s += w * c; });
    const avg = s / ws, n = covers.length;
    const pts = clamp(avg * setOf(sport).form * (n / (n + 4)), -0.15 * sigmaOf(sport), 0.15 * sigmaOf(sport));
    return { pts, n, avg };
  }

  // ── Step 5a: cover records in today's roles ──
  function roleRecord(games, pred) {
    let w = 0, l = 0;
    games.forEach(v => { if (v.cover == null || !pred(v)) return; if (v.cover > 0) w++; else if (v.cover < 0) l++; });
    return { w, l, n: w + l, rate: (w + l) ? w / (w + l) : null };
  }
  function atsPoints(games, sport, atHome, favored) {
    const sg = sigmaOf(sport), k = 20, weight = setOf(sport).ats * 0.5;
    const place = roleRecord(games, v => v.home === atHome);
    const role = roleRecord(games, v => v.line != null && (favored ? v.line < 0 : v.line > 0));
    const conv = r => r.n ? (r.rate - 0.5) * SQRT_2PI * sg * (r.n / (r.n + k)) * weight : 0;
    const pts = clamp(conv(place) + conv(role), -0.12 * sg, 0.12 * sg);
    return { pts, place, role };
  }

  // ── Step 5c: schedule spots ──
  function schedulePoints(sport, team, games, restDays, restCounted, favoredBy, nextMargin, lostLastMeeting) {
    const st = setOf(sport), sg = sigmaOf(sport), out = [];
    if (st.b2b && !restCounted && restDays === 1) out.push({ name: 'back-to-back', pts: -st.b2b * sg });
    const last = games[games.length - 1];
    if (last && last.margin >= st.bigWin && favoredBy > 0) out.push({ name: 'letdown after a big win', pts: -st.letdown * sg });
    if (nextMargin != null && favoredBy > 0 && nextMargin <= -0.25 * sg) out.push({ name: 'lookahead to a tougher game', pts: -st.lookahead * sg });
    if (lostLastMeeting) out.push({ name: 'revenge for the last meeting', pts: st.revenge * sg });
    const pts = clamp(out.reduce((s, x) => s + x.pts, 0), -0.15 * sg, 0.15 * sg);
    return { pts, list: out };
  }

  // ── Step 6: the chance to cover, by the sport's own math ──
  function teamSigma(games, sport) {
    const sg = sigmaOf(sport);
    const covers = games.map(v => v.cover).filter(v => v != null && isFinite(v));
    const n = covers.length;
    if (n < 3) return sg;
    const mean = covers.reduce((s, v) => s + v, 0) / n;
    const sd = Math.sqrt(covers.reduce((s, v) => s + (v - mean) * (v - mean), 0) / (n - 1));
    const k = 10;
    return Math.sqrt((n * sd * sd + k * sg * sg) / (n + k));
  }
  function coverChance(sport, margin, line, sigma, prior) {
    const SP = window.EDGE_SPORTS || null, core = window.EDGE_RATING || null;
    try {
      if (COUNT.has(sport) && SP && SP.cover) {
        const p = prior.projection || {};
        const total = fin(p.total) ? num(p.total) : (SP.profile && SP.profile(sport) ? SP.profile(sport).avgTotal : null);
        const c = SP.cover(sport, margin, line, { total });
        if (c && isFinite(c.home_cover)) return c;
      }
      if (!COUNT.has(sport) && SP && SP.cover) {
        const c = SP.cover(sport, margin, line, { sigma, homeStats: prior.home_power, awayStats: prior.away_power });
        if (c && isFinite(c.home_cover)) return c;
      }
      if (core && core.coverProbability) {
        const c = core.coverProbability(margin, line, sigma, { sport });
        if (c && isFinite(c.home_cover)) return c;
      }
    } catch {}
    const z = (margin + line) / sigma;
    const ph = 0.5 * (1 + erf(z / Math.SQRT2));
    return { home_cover: ph, away_cover: 1 - ph, push: 0 };
  }
  function erf(x) {
    const t = 1 / (1 + 0.3275911 * Math.abs(x));
    const y = 1 - (((((1.061405429 * t - 1.453152027) * t) + 1.421413741) * t - 0.284496736) * t + 0.254829592) * t * Math.exp(-x * x);
    return x >= 0 ? y : -y;
  }

  // ── One game, all six steps ──
  function rateGame(prior, ctx, logs, nextMarginFor) {
    const sport = prior.sport;
    const line = num(prior.market?.current_spread);
    if (!isFinite(line)) return { skip: 'no posted spread' };
    const parts = rankingParts(prior);
    if (!parts) return { skip: 'no rating for one of the teams' };
    const sg = sigmaOf(sport), st = setOf(sport);
    const hKey = teamKey(prior.home_team, sport), aKey = teamKey(prior.away_team, sport);
    const byTeam = (logs && logs[sport]) || new Map();
    const hGames = (byTeam.get(hKey) || []).map(g => teamView(g, hKey));
    const aGames = (byTeam.get(aKey) || []).map(g => teamView(g, aKey));

    // 2 · form
    const fH = formPoints(hGames, sport), fA = formPoints(aGames, sport);
    const form = fH.pts - fA.pts;

    // 4 · travel (the road team) and weather
    let travel = 0;
    const tr = ctx?.travelByGame?.[prior.game_id];
    if (tr && prior.home_split?.matchup_hfa !== 0) {
      const tz = Math.min(Math.abs(num(tr.timezones) || 0), 3);
      travel = (tz * st.tz + ((num(tr.miles) || 0) >= 1500 ? st.miles : 0)) * sg;
    }

    // 5 · ATS in today's roles, spots, schedule spots
    const homeFavored = line < 0;
    const atsH = atsPoints(hGames, sport, true, homeFavored);
    const atsA = atsPoints(aGames, sport, false, !homeFavored);
    const ats = atsH.pts - atsA.pts;

    const fired = (prior.spots || []).filter(s => s && (s.side === 'home' || s.side === 'away') && !MARKET_SPOT.test(String(s.id || '')));
    const spotsRaw = fired.reduce((s, x) => s + (x.side === 'home' ? 1 : -1) * st.spot * sg, 0);
    const spots = clamp(spotsRaw, -st.spotCap * sg, st.spotCap * sg);

    // The road team's trip counts against it, so it adds to the home side.
    const preMargin = parts.ratings + form + parts.coaching + parts.defense + parts.players + parts.drivers + travel + ats + spots;
    const lastMeeting = hGames.filter(v => v.opp === aKey).slice(-1)[0];
    const schH = schedulePoints(sport, hKey, hGames, num(prior.rest_days?.home), parts.restCounted, preMargin,
      nextMarginFor(hKey, sport, prior.commence_time, st.lookDays), !!(lastMeeting && lastMeeting.margin < 0));
    const schA = schedulePoints(sport, aKey, aGames, num(prior.rest_days?.away), parts.restCounted, -preMargin,
      nextMarginFor(aKey, sport, prior.commence_time, st.lookDays), !!(lastMeeting && lastMeeting.margin > 0));
    const schedule = schH.pts - schA.pts;

    let margin = preMargin + schedule;
    let weatherMult = 1, weatherNote = null;
    const w = ctx?.weatherByGame?.[prior.game_id];
    if (WEATHER.has(sport) && w) {
      const wind = Math.max(num(w.wind_effect_mph) || 0, num(w.wind_mph) || 0);
      const wet = (num(w.rain_in) || 0) >= 0.1 || (num(w.snow_cm) || 0) >= 0.5;
      weatherMult = clamp(1 - (wind >= 20 ? 0.12 : wind >= 15 ? 0.06 : 0) - (wet ? 0.06 : 0), 0.8, 1);
      if (weatherMult < 1) weatherNote = `${wind >= 15 ? Math.round(wind) + ' mph wind' : ''}${wind >= 15 && wet ? ', ' : ''}${wet ? 'rain or snow' : ''}`;
      margin *= weatherMult;
    }

    // 6 · physics
    const sigma = Math.sqrt((Math.pow(teamSigma(hGames, sport), 2) + Math.pow(teamSigma(aGames, sport), 2)) / 2);
    const c = coverChance(sport, margin, line, sigma, prior);
    const side = c.home_cover >= c.away_cover ? 'home' : 'away';
    const chance = side === 'home' ? c.home_cover : c.away_cover;
    const sgn = side === 'home' ? 1 : -1;
    const v = x => round(sgn * x, 2);

    const steps = [
      { n: 1, label: 'Ratings (preseason carried in, this season so far, home edge for this pairing)', pts: v(parts.ratings) },
      { n: 2, label: Math.max(fH.n, fA.n) ? `Recent form (last ${Math.max(fH.n, fA.n)} against the spread)` : 'Recent form (no games against the spread yet)', pts: v(form) },
      { n: 3, label: 'Matchup: coaching, offense against defense', pts: v(parts.coaching + parts.defense) },
      { n: 4, label: `Game day: key players, ${parts.driverNames.length ? parts.driverNames.join(', ') + ', ' : ''}travel${weatherNote ? ', weather (' + weatherNote + ')' : ''}`,
        pts: v(parts.players + parts.drivers + travel), mult: weatherMult < 1 ? round(weatherMult, 2) : undefined },
      { n: 5, label: `ATS in today's roles, ${fired.length} spot${fired.length === 1 ? '' : 's'}` +
          `${schH.list.length || schA.list.length ? ', ' + [...schH.list.map(x => prior.home_team + ': ' + x.name), ...schA.list.map(x => prior.away_team + ': ' + x.name)].join(', ') : ''}`,
        pts: v(ats + spots + schedule) },
      { n: 6, label: `Physics: margin ${round(margin, 1)} against the line ${line > 0 ? '+' : ''}${line}, spread of results ±${round(sigma, 1)}`, pts: null },
    ];
    return {
      pick_key: pickKey(prior), sport, game_id: prior.game_id || null,
      home_team: prior.home_team, away_team: prior.away_team, commence_time: prior.commence_time || null,
      line, pick_side: side, pick_team: side === 'home' ? prior.home_team : prior.away_team,
      pick_line: side === 'home' ? line : -line, chance: round(chance * 100, 1), push: round((c.push || 0) * 100, 1),
      model_margin: round(margin, 2), sigma: round(sigma, 2), steps, version: VERSION, rated_at: new Date().toISOString(),
    };
  }

  // ── Local record ──
  function readStore() { try { return JSON.parse(localStorage.getItem(STORE) || '{}') || {}; } catch { return {}; } }
  function writeStore(s) { try { localStorage.setItem(STORE, JSON.stringify(s)); } catch {} }
  function started(row) { return row.commence_time && new Date(row.commence_time).getTime() <= Date.now(); }

  // ── Database copy (matchup_picks), when the table exists ──
  function dbConf() {
    const url = localStorage.getItem('edge_supabase_url'), key = localStorage.getItem('edge_supabase_key');
    if (!url || !key || localStorage.getItem(DB_FLAG) === 'missing') return null;
    return { url, key, headers: { apikey: key, Authorization: `Bearer ${key}`, 'Content-Type': 'application/json' } };
  }
  async function dbCheck(res) {
    if (res.ok) return true;
    const t = await res.text().catch(() => '');
    if (/matchup_picks/.test(t) && /(does not exist|Could not find|42P01|PGRST205)/i.test(t)) localStorage.setItem(DB_FLAG, 'missing');
    return false;
  }
  const DB_COLS = ['pick_key', 'sport', 'game_id', 'home_team', 'away_team', 'commence_time', 'line', 'pick_side', 'pick_team',
    'pick_line', 'chance', 'push', 'model_margin', 'sigma', 'steps', 'version', 'rated_at', 'result', 'home_score', 'away_score', 'pnl', 'graded_at'];
  const toDb = r => Object.fromEntries(DB_COLS.map(k => [k, r[k] === undefined ? null : r[k]]));
  async function dbUpsert(rows) {
    const db = dbConf();
    if (!db || !rows.length) return { ok: !!db, n: 0 };
    let n = 0;
    for (let i = 0; i < rows.length; i += 200) {
      const res = await fetch(`${db.url}/rest/v1/${TABLE}?on_conflict=pick_key`, {
        method: 'POST', headers: { ...db.headers, Prefer: 'resolution=merge-duplicates,return=minimal' },
        body: JSON.stringify(rows.slice(i, i + 200).map(toDb)),
      });
      if (!(await dbCheck(res))) return { ok: false, n };
      n += Math.min(200, rows.length - i);
    }
    return { ok: true, n };
  }
  async function dbLoad() {
    const db = dbConf();
    if (!db) return null;
    const res = await fetch(`${db.url}/rest/v1/${TABLE}?select=*&order=commence_time.desc&limit=5000`, { headers: db.headers });
    if (!(await dbCheck(res))) return null;
    return res.json();
  }

  // ── The pipeline step ──
  async function runAll(priors, gameList, ctx, opts = {}) {
    const log = opts.log || (() => {});
    localStorage.removeItem(DB_FLAG);   // try the database copy again on every run
    const list = (priors || []).filter(p => p && p.sport && p.home_team && p.away_team && !started(p));
    const sports = Array.from(new Set(list.map(p => p.sport)));
    log(`Matchup mode · rating ${list.length} game${list.length === 1 ? '' : 's'} from the team comparison`);
    const logs = await loadLogs(sports, opts.url, opts.key, log);

    // Each team's next game in this run, for lookahead.
    const upcoming = new Map();
    list.forEach(p => {
      const t = new Date(p.commence_time || 0).getTime();
      [[teamKey(p.home_team, p.sport), -num(p.model_spread)], [teamKey(p.away_team, p.sport), num(p.model_spread)]].forEach(([k, m]) => {
        const id = `${p.sport}|${k}`;
        if (!upcoming.has(id)) upcoming.set(id, []);
        upcoming.get(id).push({ t, margin: m });
      });
    });
    const nextMarginFor = (team, sport, when, days) => {
      const t0 = new Date(when || 0).getTime();
      const next = (upcoming.get(`${sport}|${team}`) || []).filter(x => x.t > t0 && x.t - t0 <= days * 86400000).sort((a, b) => a.t - b.t)[0];
      return next && isFinite(next.margin) ? next.margin : null;
    };

    const store = readStore();
    const rows = [], skipped = {};
    for (const p of list) {
      let r;
      try { r = rateGame(p, ctx || {}, logs, nextMarginFor); } catch (e) { r = { skip: 'error: ' + e.message }; }
      if (!r || r.skip) { const k = (r && r.skip) || 'unknown'; skipped[k] = (skipped[k] || 0) + 1; continue; }
      const prev = store[r.pick_key];
      if (prev && (prev.result || started(prev))) continue;   // locked once it starts
      store[r.pick_key] = r;
      rows.push(r);
    }
    writeStore(store);
    const unrated = Math.max(0, (gameList || []).length - (priors || []).length);
    const skipText = Object.entries(skipped).map(([k, n]) => `${n} ${k}`).join(' · ');
    log(`  ${rows.length} picks${skipText ? ' · skipped ' + skipText : ''}${unrated ? ` · ${unrated} game(s) without ratings yet` : ''}`);
    let db = { ok: false, n: 0 };
    try { db = await dbUpsert(rows); } catch (e) { log('  matchup mode: database copy failed — ' + e.message); }
    if (localStorage.getItem(DB_FLAG) === 'missing') log('  matchup mode: record kept on this phone (run matchup-picks.sql to keep a copy in the database)');
    return { rated: rows.length, skipped, unrated, saved_to_db: db.n };
  }

  // ── Grading: one sport at a time, from ESPN finals ──
  async function grade(sport, onProgress) {
    const say = onProgress || (() => {});
    if (!sport || sport === 'ALL') return { ok: false, error: 'Pick a sport to grade' };
    const finder = window.EDGE_SHADOW_GRADER && EDGE_SHADOW_GRADER.findFinal;
    if (!finder) return { ok: false, error: 'Grader not loaded on this page' };
    const store = readStore();
    const due = Object.values(store).filter(r => r.sport === sport && !r.result && r.commence_time &&
      new Date(r.commence_time).getTime() < Date.now() - 3 * 3600000);
    let graded = 0, waiting = 0;
    const changed = [];
    for (let i = 0; i < due.length; i++) {
      const r = due[i];
      say(`Grading ${sport} · ${i + 1} of ${due.length}`);
      let f = null;
      try { f = await finder({ sport: r.sport, commence_time: r.commence_time, home_team: r.home_team, away_team: r.away_team }); } catch {}
      if (!f) { waiting++; continue; }
      if (f.void) { Object.assign(r, { result: 'V', pnl: 0, graded_at: new Date().toISOString() }); changed.push(r); graded++; continue; }
      if (!f.completed || !isFinite(f.home_score) || !isFinite(f.away_score)) { waiting++; continue; }
      const homeMargin = f.home_score - f.away_score;
      const cover = r.pick_side === 'home' ? homeMargin + r.line : -homeMargin - r.line;
      const result = Math.abs(cover) < 0.01 ? 'P' : cover > 0 ? 'W' : 'L';
      Object.assign(r, { result, home_score: f.home_score, away_score: f.away_score,
        pnl: result === 'W' ? round(50 * 100 / 110, 2) : result === 'L' ? -50 : 0, graded_at: new Date().toISOString() });
      changed.push(r); graded++;
    }
    writeStore(store);
    try { await dbUpsert(changed); } catch {}
    return { ok: true, graded, waiting, due: due.length };
  }

  function record(sport) {
    const rows = Object.values(readStore()).filter(r => (!sport || sport === 'ALL' || r.sport === sport) && r.result && r.result !== 'V');
    const w = rows.filter(r => r.result === 'W').length, l = rows.filter(r => r.result === 'L').length, p = rows.filter(r => r.result === 'P').length;
    const pnl = rows.reduce((s, r) => s + (num(r.pnl) || 0), 0);
    return { w, l, p, n: rows.length, rate: (w + l) ? w / (w + l) : null, pnl: round(pnl, 2) };
  }

  // ── Today's Picks › Matchup ──
  let viewSport = 'ALL', busy = false, note = '';
  function css() {
    if (document.getElementById('mmStyle')) return;
    const s = document.createElement('style');
    s.id = 'mmStyle';
    s.textContent = `
      .mm-bar{display:flex;flex-wrap:wrap;gap:6px;margin:4px 0 10px}
      .mm-chip{padding:6px 10px;border:1px solid #3a3528;background:transparent;color:#bdb49c;font-size:12px;letter-spacing:.08em;cursor:pointer}
      .mm-chip.on{border-color:#c9a54a;color:#c9a54a}
      .mm-rec{border:1px solid #3a3528;padding:10px 12px;margin-bottom:10px;color:#e8e2d0;font-size:13px;line-height:1.5}
      .mm-rec b{color:#c9a54a}
      .mm-btn{margin-top:8px;padding:7px 12px;border:1px solid #c9a54a;background:transparent;color:#c9a54a;font-size:12px;letter-spacing:.08em;cursor:pointer}
      .mm-card{border:1px solid #2c2a24;padding:10px 12px;margin-bottom:8px;color:#e8e2d0}
      .mm-meta{font-size:11px;color:#8a857a;letter-spacing:.06em}
      .mm-game{font-size:14px;margin:3px 0}
      .mm-pick{font-size:15px;color:#c9a54a;margin:4px 0}
      .mm-sub{font-size:12px;color:#bdb49c}
      .mm-steps{margin-top:6px;font-size:12px;color:#bdb49c}
      .mm-steps summary{cursor:pointer;color:#8a857a}
      .mm-step{display:flex;justify-content:space-between;gap:10px;padding:2px 0;border-top:1px dashed #2c2a24}
      .mm-res{font-weight:bold}.mm-W{color:#6fbf73}.mm-L{color:#d8695f}.mm-P,.mm-V{color:#bdb49c}`;
    document.head.appendChild(s);
  }
  const esc = t => String(t == null ? '' : t).replace(/[&<>"]/g, ch => ({ '&': '&amp;', '<': '&lt;', '>': '&gt;', '"': '&quot;' }[ch]));
  const sgnTxt = v => (v > 0 ? '+' : '') + v;

  async function render(container) {
    if (!container) return;
    css();
    let store = readStore();
    if (!Object.keys(store).length && !render._loaded) {
      render._loaded = true;
      try {
        const rows = await dbLoad();
        if (rows && rows.length) { rows.forEach(r => { store[r.pick_key] = r; }); writeStore(store); }
      } catch {}
      store = readStore();
    }
    const all = Object.values(store);
    const sports = Array.from(new Set(all.map(r => r.sport))).sort();
    if (viewSport !== 'ALL' && !sports.includes(viewSport)) viewSport = 'ALL';
    const inSport = all.filter(r => viewSport === 'ALL' || r.sport === viewSport);
    const upcoming = inSport.filter(r => !started(r)).sort((a, b) => b.chance - a.chance);
    const done = inSport.filter(r => started(r)).sort((a, b) => new Date(b.commence_time) - new Date(a.commence_time)).slice(0, 40);
    const rec = record(viewSport);
    const chips = ['ALL', ...sports].map(s => `<button class="mm-chip${s === viewSport ? ' on' : ''}" data-mm-sport="${s}">${s === 'ALL' ? 'All' : s}</button>`).join('');
    const recLine = rec.n
      ? `<b>${rec.w}-${rec.l}-${rec.p}</b> · ${rec.rate != null ? (rec.rate * 100).toFixed(1) + '%' : '—'} · ${rec.pnl >= 0 ? '+' : '−'}$${Math.abs(rec.pnl).toFixed(2)} at $50 a pick`
      : 'No graded picks yet';
    const card = r => {
      const when = r.commence_time ? new Date(r.commence_time).toLocaleString([], { weekday: 'short', hour: 'numeric', minute: '2-digit' }) : '';
      const res = r.result ? ` · <span class="mm-res mm-${r.result}">${r.result === 'V' ? 'NO ACTION' : r.result}${r.home_score != null ? ` (${r.away_score}-${r.home_score})` : ''}</span>` : '';
      const steps = (r.steps || []).map(s => `<div class="mm-step"><span>${s.n}. ${esc(s.label)}</span><span>${s.pts == null ? '' : sgnTxt(s.pts)}${s.mult ? ' ×' + s.mult : ''}</span></div>`).join('');
      const pickWins = r.pick_side === 'home' ? r.model_margin : -r.model_margin;
      return `<div class="mm-card">
        <div class="mm-meta">${esc(r.sport)} · ${esc(when)}${res}</div>
        <div class="mm-game">${esc(r.away_team)} @ ${esc(r.home_team)}</div>
        <div class="mm-pick">${esc(r.pick_team)} ${sgnTxt(r.pick_line)} · ${r.chance}% to cover</div>
        <div class="mm-sub">Model: ${esc(r.pick_team)} ${pickWins >= 0 ? 'by ' + Math.abs(pickWins).toFixed(1) : 'loses by ' + Math.abs(pickWins).toFixed(1)} · covers by ${(pickWins + r.pick_line).toFixed(1)}</div>
        <details class="mm-steps"><summary>How it got there</summary>${steps}</details>
      </div>`;
    };
    container.innerHTML = `
      <div class="mm-bar">${chips}</div>
      <div class="mm-rec">MATCHUP MODE · ${viewSport === 'ALL' ? 'all sports' : viewSport}: ${recLine}<br>
        <span class="mm-sub">Every game rated from the team comparison alone · its own record, separate from your regular picks.${note ? ' ' + esc(note) : ''}</span><br>
        <button class="mm-btn" id="mmGrade"${busy ? ' disabled' : ''}>${viewSport === 'ALL' ? 'Pick a sport to grade' : `Grade finished ${viewSport} games`}</button>
      </div>
      ${upcoming.length ? upcoming.map(card).join('') : '<div class="mm-card mm-sub">No upcoming games rated yet — run the pipeline.</div>'}
      ${done.length ? `<div class="mm-meta" style="margin:12px 0 6px">STARTED OR FINISHED</div>${done.map(card).join('')}` : ''}`;
    container.querySelectorAll('[data-mm-sport]').forEach(b => b.onclick = () => { viewSport = b.dataset.mmSport; note = ''; render(container); });
    const g = container.querySelector('#mmGrade');
    if (g) g.onclick = async () => {
      if (viewSport === 'ALL' || busy) return;
      busy = true; note = '';
      const r = await grade(viewSport, t => { g.textContent = t; });
      busy = false;
      note = r.ok ? `Graded ${r.graded}${r.waiting ? ` · ${r.waiting} waiting on a final score` : ''}.` : r.error;
      render(container);
    };
  }

  return { VERSION, runAll, rateGame, grade, record, render, pickKey, seasonStart };
})();

if (typeof window !== 'undefined') window.EDGE_MATCHUP = EDGE_MATCHUP;
