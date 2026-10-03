// ============================================================
// THE EDGE — external-data.js
// Outside data for the strength step, per game on the slate:
//   MLB    — probable starting pitchers (MLB Stats API, direct)
//   NCAAF  — SP+ ratings (CollegeFootballData, free key in Admin)
//   NHL    — likely starting goalies (NHL API, through the relay)
//   NFL    — offense/defense efficiency, EPA per play (nflverse,
//            through the relay)
// The NHL and nflverse sites block requests from a browser, so they
// go through the edge-relay Supabase function. Every source is
// optional: a source that fails is reported and skipped, and the
// ranking carries on without it.
// ============================================================

const EDGE_EXTERNAL = (function () {
  'use strict';

  const BUILD = 'ext-20261003-02';

  const SB_URL = () => localStorage.getItem('edge_supabase_url');
  const SB_KEY = () => localStorage.getItem('edge_supabase_key');
  const CFBD_KEY = () => (localStorage.getItem('edge_cfbd_api_key') || '').trim();

  // League levels the starters are measured against.
  const LG_FIP = 4.15;          // MLB league FIP (≈ league ERA)
  const FIP_CONST = 3.15;
  const STARTER_IP = 5.3;       // innings a starter usually covers
  const LG_SV = 0.902;          // NHL league save percentage
  const SHOTS_PER_GAME = 29;
  // The team ratings already hold the team's usual pitching and
  // goaltending, so a starter counts at 60% of his full difference.
  const STARTER_SHARE = 0.6;
  const NFL_PLAYS = 60;         // offensive plays per team per game

  // nflverse team codes → full names used by the odds feed.
  const NFL_TEAMS = {
    ARI: 'Arizona Cardinals', ATL: 'Atlanta Falcons', BAL: 'Baltimore Ravens', BUF: 'Buffalo Bills',
    CAR: 'Carolina Panthers', CHI: 'Chicago Bears', CIN: 'Cincinnati Bengals', CLE: 'Cleveland Browns',
    DAL: 'Dallas Cowboys', DEN: 'Denver Broncos', DET: 'Detroit Lions', GB: 'Green Bay Packers',
    HOU: 'Houston Texans', IND: 'Indianapolis Colts', JAX: 'Jacksonville Jaguars', KC: 'Kansas City Chiefs',
    LA: 'Los Angeles Rams', LAR: 'Los Angeles Rams', LAC: 'Los Angeles Chargers', LV: 'Las Vegas Raiders',
    MIA: 'Miami Dolphins', MIN: 'Minnesota Vikings', NE: 'New England Patriots', NO: 'New Orleans Saints',
    NYG: 'New York Giants', NYJ: 'New York Jets', PHI: 'Philadelphia Eagles', PIT: 'Pittsburgh Steelers',
    SEA: 'Seattle Seahawks', SF: 'San Francisco 49ers', TB: 'Tampa Bay Buccaneers', TEN: 'Tennessee Titans',
    WAS: 'Washington Commanders', WSH: 'Washington Commanders',
  };

  // ── helpers ──
  function round(v, d) { const f = Math.pow(10, d); return Math.round(v * f) / f; }
  function clamp(v, a, b) { return Math.max(a, Math.min(b, v)); }

  function norm(name, sport) {
    const plain = String(name || '').normalize('NFD').replace(/[\u0300-\u036f]/g, '');
    if (window.EDGE_TEAMS && EDGE_TEAMS.normalize) return EDGE_TEAMS.normalize(plain, sport);
    return plain.toLowerCase().replace(/[^a-z0-9 ]/g, '').replace(/\s+/g, ' ').trim();
  }

  function localDay(iso) {
    if (window.EDGE_TIME && EDGE_TIME.gameDay) return EDGE_TIME.gameDay(iso);
    const d = new Date(new Date(iso).toLocaleString('en-US', { timeZone: 'America/New_York' }));
    return `${d.getFullYear()}-${String(d.getMonth() + 1).padStart(2, '0')}-${String(d.getDate()).padStart(2, '0')}`;
  }

  // Football seasons are named for the year they start (Aug–Feb).
  function footballSeason(iso) {
    const d = new Date(iso);
    return d.getMonth() <= 1 ? d.getFullYear() - 1 : d.getFullYear();
  }

  function cacheGet(k, maxAgeMin) {
    try {
      const v = JSON.parse(localStorage.getItem(k) || 'null');
      if (v && Date.now() - v.at < maxAgeMin * 60000) return v.data;
    } catch {}
    return null;
  }
  function cacheSet(k, data) {
    try { localStorage.setItem(k, JSON.stringify({ at: Date.now(), data })); } catch {}
  }

  function relayBase() {
    const u = SB_URL();
    return u ? `${u.replace(/\/+$/, '')}/functions/v1/edge-relay` : null;
  }

  async function relayFetch(url, asText) {
    const base = relayBase();
    if (!base) throw new Error('Supabase URL not set');
    const key = SB_KEY();
    const res = await fetch(`${base}?url=${encodeURIComponent(url)}`, {
      headers: key ? { apikey: key, Authorization: `Bearer ${key}` } : {},
    });
    if (res.status === 404) throw new Error('relay not deployed (edge-relay function missing)');
    if (!res.ok) throw new Error(`relay HTTP ${res.status}`);
    return asText ? res.text() : res.json();
  }

  // Small CSV reader (quoted fields allowed).
  function parseCsv(text) {
    const rows = [];
    let row = [], field = '', q = false;
    for (let i = 0; i < text.length; i++) {
      const ch = text[i];
      if (q) {
        if (ch === '"' && text[i + 1] === '"') { field += '"'; i++; }
        else if (ch === '"') q = false;
        else field += ch;
      } else if (ch === '"') q = true;
      else if (ch === ',') { row.push(field); field = ''; }
      else if (ch === '\n') { row.push(field); rows.push(row); row = []; field = ''; }
      else if (ch !== '\r') field += ch;
    }
    if (field.length || row.length) { row.push(field); rows.push(row); }
    if (!rows.length) return [];
    const head = rows[0];
    return rows.slice(1).filter(r => r.length === head.length).map(r => {
      const o = {}; head.forEach((h, i) => { o[h] = r[i]; }); return o;
    });
  }

  // ============================================================
  // MLB — probable starters
  // ============================================================

  function ipToNum(ip) {
    const [w, f] = String(ip ?? '').split('.');
    return (Number(w) || 0) + (f === '1' ? 1 / 3 : f === '2' ? 2 / 3 : 0);
  }

  // Fielding-independent pitching, pulled toward the league by 40
  // innings so a few starts can't make a pitcher look elite.
  function pitcherImpact(st, person) {
    if (!st) return null;
    const ip = ipToNum(st.inningsPitched);
    if (!(ip > 0)) return null;
    const hr = +st.homeRuns || 0, bb = (+st.baseOnBalls || 0) + (+st.hitByPitch || 0), k = +st.strikeOuts || 0;
    const fip = (13 * hr + 3 * bb - 2 * k) / ip + FIP_CONST;
    const reg = (fip * ip + LG_FIP * 40) / (ip + 40);
    return {
      name: person?.fullName || null,
      fip: round(fip, 2), fip_reg: round(reg, 2), ip: round(ip, 1),
      runs_saved: round((LG_FIP - reg) * STARTER_IP / 9, 3),
    };
  }

  async function mlbDay(day) {
    const ck = `edge_ext_mlb_${day}`;
    const cached = cacheGet(ck, 60);
    if (cached) return cached;
    const res = await fetch(`https://statsapi.mlb.com/api/v1/schedule?sportId=1&date=${day}&hydrate=probablePitcher`);
    if (!res.ok) throw new Error('MLB schedule HTTP ' + res.status);
    const j = await res.json();
    const games = [];
    (j.dates || []).forEach(d => (d.games || []).forEach(g => games.push({
      home: g.teams?.home?.team?.name || '', away: g.teams?.away?.team?.name || '',
      hp: g.teams?.home?.probablePitcher || null, ap: g.teams?.away?.probablePitcher || null,
    })));
    const ids = [...new Set(games.flatMap(g => [g.hp?.id, g.ap?.id]).filter(Boolean))];
    const stats = {};
    if (ids.length) {
      const season = day.slice(0, 4);
      try {
        const r = await fetch(`https://statsapi.mlb.com/api/v1/people?personIds=${ids.join(',')}` +
          `&hydrate=stats(group=[pitching],type=[season],season=${season})`);
        if (r.ok) {
          ((await r.json()).people || []).forEach(p => {
            const st = p.stats?.[0]?.splits?.[0]?.stat;
            if (st) stats[p.id] = { st, person: p };
          });
        }
      } catch {}
    }
    const out = games.map(g => ({
      home: g.home, away: g.away,
      hp: g.hp ? (pitcherImpact(stats[g.hp.id]?.st, g.hp) || { name: g.hp.fullName, runs_saved: 0, fip: null }) : null,
      ap: g.ap ? (pitcherImpact(stats[g.ap.id]?.st, g.ap) || { name: g.ap.fullName, runs_saved: 0, fip: null }) : null,
    }));
    cacheSet(ck, out);
    return out;
  }

  // ============================================================
  // NCAAF — SP+ (opponent-adjusted, with preseason priors)
  // ============================================================

  async function cfbdRatings(year) {
    const key = CFBD_KEY();
    if (!key) throw new Error('no CollegeFootballData key (Admin)');
    const ck = `edge_ext_cfbd_${year}`;
    const cached = cacheGet(ck, 12 * 60);
    if (cached) return cached;
    const h = { Authorization: `Bearer ${key}`, Accept: 'application/json' };
    const spRes = await fetch(`https://api.collegefootballdata.com/ratings/sp?year=${year}`, { headers: h });
    if (spRes.status === 401) throw new Error('CollegeFootballData key rejected');
    if (!spRes.ok) throw new Error('SP+ HTTP ' + spRes.status);
    const sp = await spRes.json();
    let teams = [];
    try {
      const tRes = await fetch(`https://api.collegefootballdata.com/teams?year=${year}`, { headers: h });
      if (tRes.ok) teams = await tRes.json();
    } catch {}
    const bySchool = {};
    (Array.isArray(sp) ? sp : []).forEach(t => {
      if (!t || !t.team || t.team === 'nationalAverages' || !isFinite(t.rating)) return;
      bySchool[t.team] = { rating: +t.rating, off: t.offense?.rating ?? null, def: t.defense?.rating ?? null };
    });
    // Odds-feed names are "School Mascot" ("Ohio State Buckeyes").
    const lookup = {};
    (Array.isArray(teams) ? teams : []).forEach(t => {
      const r = bySchool[t.school];
      if (!r) return;
      lookup[norm(`${t.school} ${t.mascot || ''}`, 'NCAAF')] = { school: t.school, ...r };
      (t.alternateNames || []).forEach(a => { lookup[norm(a, 'NCAAF')] = lookup[norm(a, 'NCAAF')] || { school: t.school, ...r }; });
    });
    Object.entries(bySchool).forEach(([s, r]) => {
      const k2 = norm(s, 'NCAAF');
      if (!lookup[k2]) lookup[k2] = { school: s, ...r };
    });
    const out = { lookup, count: Object.keys(bySchool).length };
    cacheSet(ck, out);
    return out;
  }

  function findCfb(lookup, name) {
    const n = norm(name, 'NCAAF');
    if (lookup[n]) return lookup[n];
    // "School Mascot" with a mascot the teams list lacked: drop words
    // from the end until a school matches.
    const parts = n.split(' ');
    for (let k = parts.length - 1; k >= 1; k--) {
      const s = parts.slice(0, k).join(' ');
      if (lookup[s]) return lookup[s];
    }
    return null;
  }

  // ============================================================
  // NHL — likely starting goalies (relay)
  // ============================================================

  async function nhlSchedule(day) {
    const ck = `edge_ext_nhlsched_${day}`;
    const cached = cacheGet(ck, 120);
    if (cached) return cached;
    const j = await relayFetch(`https://api-web.nhle.com/v1/schedule/${day}`);
    const games = [];
    (j.gameWeek || []).forEach(d => (d.games || []).forEach(g => {
      const nm = t => `${t?.placeName?.default || ''} ${t?.commonName?.default || ''}`.trim();
      games.push({ date: d.date, home: nm(g.homeTeam), away: nm(g.awayTeam),
                   home_abbrev: g.homeTeam?.abbrev, away_abbrev: g.awayTeam?.abbrev });
    }));
    cacheSet(ck, games);
    return games;
  }

  function seasonCode(day) {
    const y = Number(day.slice(0, 4)), m = Number(day.slice(5, 7));
    const start = m >= 9 ? y : y - 1;
    return `${start}${start + 1}`;
  }

  async function nhlGoalies(abbrev, day) {
    const ck = `edge_ext_nhlg_${abbrev}_${day}`;
    const cached = cacheGet(ck, 6 * 60);
    if (cached) return cached;
    const read = async (url) => {
      const j = await relayFetch(url);
      return (j.goalies || []).map(g => ({
        name: `${g.firstName?.default || ''} ${g.lastName?.default || ''}`.trim(),
        gp: +g.gamesPlayed || 0, gs: +g.gamesStarted || 0,
        sv: isFinite(+g.savePercentage) ? +g.savePercentage : null,
        sa: +g.shotsAgainst || null,
      })).filter(g => g.sv != null);
    };
    let list = await read(`https://api-web.nhle.com/v1/club-stats/${abbrev}/now`);
    // Early in a season: last season's regular season decides who starts.
    if (list.reduce((s, g) => s + g.gs, 0) < 5) {
      const cur = seasonCode(day);
      const prev = `${Number(cur.slice(0, 4)) - 1}${cur.slice(0, 4)}`;
      try { const older = await read(`https://api-web.nhle.com/v1/club-stats/${abbrev}/${prev}/2`); if (older.length) list = older; } catch {}
    }
    list.sort((a, b) => b.gs - a.gs || b.gp - a.gp);
    cacheSet(ck, list);
    return list;
  }

  // Save percentage pulled toward the league by 600 shots.
  function goalieImpact(g) {
    if (!g) return null;
    const sa = g.sa || g.gp * 28;
    const reg = (g.sv * sa + LG_SV * 600) / (sa + 600);
    return { name: g.name, sv: round(g.sv, 3), sv_reg: round(reg, 4), goals_saved: round((reg - LG_SV) * SHOTS_PER_GAME, 3) };
  }

  // ============================================================
  // NFL — efficiency (relay)
  // ============================================================

  async function nflEfficiency(season) {
    const ck = `edge_ext_nfleff_${season}`;
    const cached = cacheGet(ck, 6 * 60);
    if (cached) return cached;
    // The team file first; the older per-player file (summed by team
    // and week) if nflverse hasn't published the team one.
    const files = [
      `https://github.com/nflverse/nflverse-data/releases/download/stats_team/stats_team_week_${season}.csv`,
      `https://github.com/nflverse/nflverse-data/releases/download/player_stats/player_stats_${season}.csv`,
    ];
    let rows = [], lastErr = null;
    for (const f of files) {
      try {
        rows = parseCsv(await relayFetch(f, true));
        if (rows.length && ('passing_epa' in rows[0])) break;
        rows = [];
      } catch (e) { lastErr = e; }
    }
    if (!rows.length) throw new Error(lastErr ? lastErr.message : 'nflverse file empty');
    const teamCol = 'team' in rows[0] ? 'team' : ('recent_team' in rows[0] ? 'recent_team' : null);
    const need = ['opponent_team', 'passing_epa', 'rushing_epa', 'attempts', 'carries'];
    const missing = need.filter(c => !(c in rows[0]));
    if (!teamCol || missing.length) throw new Error('nflverse columns changed (missing ' + (teamCol ? missing : ['team', ...missing]).join(', ') + ')');
    const sackCol = 'sacks_suffered' in rows[0] ? 'sacks_suffered' : ('sacks' in rows[0] ? 'sacks' : null);
    const t = {};
    const T = code => t[code] = t[code] || { off: 0, offPlays: 0, def: 0, defPlays: 0, weeks: new Set() };
    rows.forEach(r => {
      if (r.season_type && r.season_type !== 'REG') return;
      const epa = (+r.passing_epa || 0) + (+r.rushing_epa || 0);
      const plays = (+r.attempts || 0) + (+r.carries || 0) + (sackCol ? (+r[sackCol] || 0) : 0);
      if (!plays || !r[teamCol] || !r.opponent_team) return;
      const a = T(r[teamCol]), d = T(r.opponent_team);
      a.off += epa; a.offPlays += plays; a.weeks.add(r.week);
      d.def += epa; d.defPlays += plays;
    });
    const teams = {};
    Object.entries(t).forEach(([code, v]) => {
      const full = NFL_TEAMS[code];
      if (!full || !v.offPlays || !v.defPlays) return;
      teams[norm(full, 'NFL')] = {
        code, games: v.weeks.size,
        off_epa: round(v.off / v.offPlays, 4),     // EPA per play gained
        def_epa: round(v.def / v.defPlays, 4),     // EPA per play allowed
      };
    });
    const out = { teams, count: Object.keys(teams).length };
    cacheSet(ck, out);
    return out;
  }

  // ============================================================
  // Per-slate loader
  // ============================================================

  // Cached days older than two days are cleared out.
  function prune() {
    try {
      const old = Date.now() - 2 * 86400000;
      for (let i = localStorage.length - 1; i >= 0; i--) {
        const k = localStorage.key(i);
        if (!k || !k.startsWith('edge_ext_')) continue;
        try { const v = JSON.parse(localStorage.getItem(k) || 'null'); if (!v || v.at < old) localStorage.removeItem(k); } catch { localStorage.removeItem(k); }
      }
    } catch {}
  }

  async function loadForSlate(games, context, log = () => {}) {
    prune();
    const byGame = {};
    const status = {};
    const sportOf = g => g._sport || g.sport;
    const list = games || [];
    const put = (id, k, v) => { (byGame[id] = byGame[id] || {})[k] = v; };

    // ── MLB ──
    const mlb = list.filter(g => sportOf(g) === 'MLB');
    if (mlb.length) {
      let hit = 0, err = null;
      const days = [...new Set(mlb.map(g => localDay(g.commence_time)))];
      const sched = {};
      for (const d of days) { try { sched[d] = await mlbDay(d); } catch (e) { err = e.message; } }
      mlb.forEach(g => {
        const day = sched[localDay(g.commence_time)] || [];
        const m = day.find(x => norm(x.home, 'MLB') === norm(g.home_team, 'MLB') && norm(x.away, 'MLB') === norm(g.away_team, 'MLB'));
        if (!m || (!m.hp && !m.ap)) return;
        const h = m.hp?.runs_saved || 0, a = m.ap?.runs_saved || 0;
        put(g.id, 'mlb', { home: m.hp, away: m.ap, runs_home: round(STARTER_SHARE * (h - a), 3) });
        hit++;
      });
      status.mlb = { games: mlb.length, matched: hit, error: err };
      log(`  starting pitchers: ${hit}/${mlb.length} games${err ? ' · ' + err : ''}`);
    }

    // ── NCAAF ──
    const cfb = list.filter(g => sportOf(g) === 'NCAAF');
    if (cfb.length) {
      let hit = 0, err = null;
      try {
        const years = [...new Set(cfb.map(g => footballSeason(g.commence_time)))];
        const byYear = {};
        for (const y of years) byYear[y] = await cfbdRatings(y);
        cfb.forEach(g => {
          const r = byYear[footballSeason(g.commence_time)];
          const h = r && findCfb(r.lookup, g.home_team), a = r && findCfb(r.lookup, g.away_team);
          if (!h || !a) return;
          put(g.id, 'sp', { home: { school: h.school, rating: h.rating }, away: { school: a.school, rating: a.rating } });
          hit++;
        });
      } catch (e) { err = e.message; }
      status.sp = { games: cfb.length, matched: hit, error: err };
      log(`  college SP+ ratings: ${hit}/${cfb.length} games${err ? ' · ' + err : ''}`);
    }

    // ── NHL ──
    const nhl = list.filter(g => sportOf(g) === 'NHL');
    if (nhl.length) {
      let hit = 0, err = null;
      try {
        const days = [...new Set(nhl.map(g => localDay(g.commence_time)))];
        const sched = {};
        for (const d of days) sched[d] = await nhlSchedule(d);
        for (const g of nhl) {
          const day = localDay(g.commence_time);
          const m = (sched[day] || []).find(x => norm(x.home, 'NHL') === norm(g.home_team, 'NHL') && norm(x.away, 'NHL') === norm(g.away_team, 'NHL'));
          if (!m || !m.home_abbrev || !m.away_abbrev) continue;
          const [hl, al] = await Promise.all([nhlGoalies(m.home_abbrev, day), nhlGoalies(m.away_abbrev, day)]);
          // On the second night of a back-to-back the backup usually starts.
          const rest = t => context?.restByTeam?.[`NHL:${t}`];
          const pick = (l, team) => (rest(team) != null && rest(team) <= 1 && l[1]) ? { ...l[1], backup: true } : (l[0] || null);
          const hg = goalieImpact(pick(hl, g.home_team)), ag = goalieImpact(pick(al, g.away_team));
          if (!hg && !ag) continue;
          const hb = !!(rest(g.home_team) != null && rest(g.home_team) <= 1 && hl[1]);
          const ab = !!(rest(g.away_team) != null && rest(g.away_team) <= 1 && al[1]);
          put(g.id, 'nhl', {
            home: hg ? { ...hg, backup: hb } : null, away: ag ? { ...ag, backup: ab } : null,
            goals_home: round(STARTER_SHARE * ((hg?.goals_saved || 0) - (ag?.goals_saved || 0)), 3),
          });
          hit++;
        }
      } catch (e) { err = e.message; }
      status.nhl = { games: nhl.length, matched: hit, error: err };
      log(`  goalies: ${hit}/${nhl.length} games${err ? ' · ' + err : ''}`);
    }

    // ── NFL ──
    const nfl = list.filter(g => sportOf(g) === 'NFL');
    if (nfl.length) {
      let hit = 0, err = null;
      try {
        const seasons = [...new Set(nfl.map(g => footballSeason(g.commence_time)))];
        const bySeason = {};
        for (const s of seasons) bySeason[s] = await nflEfficiency(s);
        nfl.forEach(g => {
          const e = bySeason[footballSeason(g.commence_time)];
          const h = e?.teams?.[norm(g.home_team, 'NFL')], a = e?.teams?.[norm(g.away_team, 'NFL')];
          if (!h || !a) return;
          // Expected EPA per play for each offense against that defense,
          // over a game's plays; pulled toward zero early in the season.
          const games = Math.min(h.games, a.games);
          const shrink = games / (games + 4);
          const margin = NFL_PLAYS * ((h.off_epa + a.def_epa) - (a.off_epa + h.def_epa)) * shrink;
          put(g.id, 'eff', { home: h, away: a, margin: round(margin, 2), games, shrink: round(shrink, 2) });
          hit++;
        });
      } catch (e) { err = e.message; }
      status.eff = { games: nfl.length, matched: hit, error: err };
      log(`  NFL efficiency: ${hit}/${nfl.length} games${err ? ' · ' + err : ''}`);
    }

    return { byGame, status };
  }

  // ── Source check (Admin) ──
  async function checkSources() {
    const out = [];
    const day = localDay(new Date().toISOString());
    const tryIt = async (label, fn) => {
      try { const msg = await fn(); out.push(`✓ ${label}: ${msg}`); }
      catch (e) { out.push(`✗ ${label}: ${e.message}`); }
    };
    await tryIt('MLB probable pitchers', async () => { const g = await mlbDay(day); return `${g.length} games today`; });
    await tryIt('College SP+ (CollegeFootballData)', async () => { const r = await cfbdRatings(footballSeason(new Date().toISOString())); return `${r.count} teams rated`; });
    await tryIt('NHL schedule via relay', async () => { const g = await nhlSchedule(day); return `${g.length} games this week`; });
    await tryIt('NFL efficiency via relay', async () => { const e = await nflEfficiency(footballSeason(new Date().toISOString())); return `${e.count} teams`; });
    return out;
  }

  return { BUILD, loadForSlate, checkSources, parseCsv, pitcherImpact, goalieImpact };
})();

if (typeof window !== 'undefined') window.EDGE_EXTERNAL = EDGE_EXTERNAL;
