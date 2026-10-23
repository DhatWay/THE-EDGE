// ============================================================
// EDGE — LINE GUARD
//
// Watches every game you've bet and every game the model has picked,
// works out WHY a line moved, and says what to do about it — in an alert
// bubble on every page. It only looks when you refresh Live Matchups or
// run the pipeline; it never calls anything on its own.
//
// What it records (on this phone):
//   · each refresh of the board — the main line, the sharpest book's line
//     (Pinnacle, else LowVig/BetOnline) and the time, per game
//   · each injury download — who changed status since the last one
//   · each pipeline rating — the model's number and when it was made
//
// How a move is explained (in this order):
//   NEWS      a player's status got worse on the team the line moved
//             against, since your reference point (a quarterback counts
//             most in football)
//   STEAM     a fast move between two refreshes close to kickoff
//   SHARP     a big move with no news — stronger when the sharpest book
//             moved first or further (an inference: the app can't see
//             tickets or public %)
//   KEY       an NFL line crossing 3 or 7 (extra note on any of the above)
//   STALE     news the model hasn't rated yet
//   SPLIT     the market far from the model's number and still moving away
//
// What it suggests depends on the cause and on the model's chance for
// your bet now (at your line) and for the other side at today's number.
// ============================================================

const EDGE_GUARD = (function () {
  const BUILD = 'guard-20261022-01';
  const K_LINES = 'edge_guard_lines', K_NEWS = 'edge_guard_news', K_INJ = 'edge_guard_inj', K_DISMISS = 'edge_guard_dismissed', K_ST = 'edge_guard_starters', K_LOGGED = 'edge_guard_logged';
  const FOOTBALL = new Set(['NFL', 'NCAAF']), ML_SPORTS = new Set(['MLB', 'NHL']);
  // Points of spread that count as a real move, by sport.
  const MOVE = { NFL: 1.5, NCAAF: 2.5, NBA: 2, WNBA: 2, NCAAB: 2.5, MLS: 0.5 };
  // Points beyond which the model and the market are far apart.
  const SPLIT = { NFL: 4, NCAAF: 7, NBA: 5, WNBA: 5, NCAAB: 6, MLS: 1 };
  // Points of total that count as a real move, by sport.
  const TOTAL_MOVE = { NFL: 1.5, NCAAF: 2.5, NBA: 3, WNBA: 2.5, NCAAB: 3, MLB: 0.5, NHL: 0.5, MLS: 0.25 };
  const SIGMA = { NFL: 13.5, NCAAF: 16.5, NBA: 12, WNBA: 11, NCAAB: 11, MLS: 1.8 };
  const BAD = /(out|doubtful|suspend|injured reserve|ir\b|inactive|questionable|day-to-day)/i;
  const WEIGHT = s => /out|doubtful|suspend|reserve|inactive/i.test(s) ? 2 : /questionable|day-to-day/i.test(s) ? 1 : 0;

  const read = (k, d) => { try { return JSON.parse(localStorage.getItem(k) || 'null') ?? d; } catch { return d; } };
  const write = (k, v) => { try { localStorage.setItem(k, JSON.stringify(v)); } catch {} };
  const nm = t => String(t || '').toLowerCase().replace(/[^a-z0-9]/g, '');
  const fmt = v => (v > 0 ? '+' : '') + (Math.round(v * 10) / 10);
  const pct = v => (v * 100).toFixed(1) + '%';
  const esc = s => String(s ?? '').replace(/[<>&]/g, c => ({ '<': '&lt;', '>': '&gt;', '&': '&amp;' }[c]));

  // ── RECORDING ──
  function recordBoard(games) {
    const lines = read(K_LINES, {});
    const now = Date.now();
    (games || []).forEach(g => {
      if (!g || !g.id) return;
      const snap = { t: now, h: num(g.home_spread ?? g.spread), s: num(g.pin_home_spread), ml: [num(g.ml ?? g.home_ml), num(g.away_ml)],
                     tot: num(g.total), n: g.bookmaker_count || null };
      const e = lines[g.id] = lines[g.id] || { sport: g._sport || g.sport, home: g.home_team, away: g.away_team, start: g.commence_time, snaps: [] };
      if (g.bench_book) e.bench = g.bench_book;
      const last = e.snaps[e.snaps.length - 1];
      if (!last || last.h !== snap.h || last.s !== snap.s || last.ml[0] !== snap.ml[0] || last.ml[1] !== snap.ml[1] || last.tot !== snap.tot) e.snaps.push(snap);
      if (e.snaps.length > 40) e.snaps = [e.snaps[0]].concat(e.snaps.slice(-39));   // keep the first (the opener)
    });
    Object.keys(lines).forEach(id => { const st = new Date(lines[id].start || 0).getTime(); if (st && now - st > 2 * 86400000) delete lines[id]; });
    write(K_LINES, lines);
  }
  function num(v) { const n = Number(v); return v == null || v === '' || !isFinite(n) ? null : n; }

  // Injury lists by team; a status that got worse (or better) since the
  // last download is saved as news, with the time it was first seen.
  function recordInjuries(sport, byTeam) {
    const prev = read(K_INJ, {}), news = read(K_NEWS, []), now = Date.now();
    Object.entries(byTeam || {}).forEach(([team, list]) => {
      const key = `${sport}|${nm(team)}`;
      const before = prev[key] || null;
      const cur = {};
      (list || []).forEach(p => { if (p && p.name) cur[p.name] = { s: String(p.status || '').toLowerCase(), pos: String(p.position || '').toUpperCase() }; });
      if (before) {
        Object.entries(cur).forEach(([name, v]) => {
          const was = before[name] ? before[name].s : 'active';
          if (WEIGHT(v.s) !== WEIGHT(was)) news.push({ t: now, sport, team: nm(team), player: name, pos: v.pos, from: was, to: v.s, worse: WEIGHT(v.s) > WEIGHT(was) });
        });
        Object.entries(before).forEach(([name, v]) => {
          if (!cur[name] && WEIGHT(v.s) > 0) news.push({ t: now, sport, team: nm(team), player: name, pos: v.pos, from: v.s, to: 'active', worse: false });
        });
      }
      prev[key] = cur;
    });
    write(K_INJ, prev);
    write(K_NEWS, news.filter(n => now - n.t < 10 * 86400000).slice(-500));
  }

  // ── MATH ──
  function phi(x) {               // standard normal CDF
    const t = 1 / (1 + 0.2316419 * Math.abs(x));
    const d = 0.3989423 * Math.exp(-x * x / 2);
    const p = d * t * (0.3193815 + t * (-0.3565638 + t * (1.781478 + t * (-1.821256 + t * 1.330274))));
    return x > 0 ? 1 - p : p;
  }
  // The model's chance the HOME side covers a home line L, from its last
  // rating: its chance at the line it rated, moved by what the points are
  // worth on its own spread of outcomes.
  function homeCoverAt(ev, L) {
    if (!ev || !isFinite(ev.posterior_home) || !isFinite(ev.total_spread) || !isFinite(L)) return null;
    const m = -ev.total_spread, sd = ev.sigma || SIGMA[ev.sport] || 13;
    const L0 = isFinite(ev.market_spread) ? ev.market_spread : L;
    const p = ev.posterior_home + (phi((m + L) / sd) - phi((m + L0) / sd));
    return Math.min(0.99, Math.max(0.01, p));
  }
  const breakEven = price => { const p = Number(price) || -110; return p > 0 ? 100 / (p + 100) : -p / (-p + 100); };
  const implied = price => (price == null ? null : breakEven(price));

  // ── EVIDENCE ──
  // Real reasons a line moved, checked in order. Each check says what it
  // looked at, so the log shows why a cause was picked and why the others
  // were ruled out.
  const SEVERE = /out|doubtful|suspend|reserve|inactive/i;
  function teamKeyMatch(key, team) {
    const k = nm(key), t = nm(team);
    if (!k || !t) return false;
    if (k === t || t.includes(k) || k.includes(t)) return true;
    try { if (window.EDGE_TEAMS && EDGE_TEAMS.normalize) return nm(EDGE_TEAMS.normalize(team)) === k; } catch {}
    return false;
  }
  function newsFor(game, sinceMs) {
    const news = read(K_NEWS, []);
    const h = nm(game.home), a = nm(game.away);
    return news.filter(n => n.t >= sinceMs && n.sport === game.sport && (n.team === h || n.team === a || teamKeyMatch(n.team, game.home) || teamKeyMatch(n.team, game.away)));
  }
  // The injury report as last downloaded: important players out or
  // doubtful on a team, quarterbacks first, with the date ESPN gives.
  function currentInjuries(sport, team, sinceMs) {
    const cache = read('edge_injury_cache_v4', {});
    const byTeam = (cache[sport] || {}).byTeam || {};
    const key = Object.keys(byTeam).find(k => teamKeyMatch(k, team));
    const list = key ? byTeam[key] : [];
    // Only injuries reported recently — since two days before the line was
    // taken. A player out for weeks was priced in long ago and can't explain
    // a move; one with no date isn't counted.
    const recentFrom = (sinceMs || Date.now() - 4 * 86400000) - 2 * 86400000;
    return (list || []).filter(p => SEVERE.test(String(p.status || '')) && p.date && new Date(p.date).getTime() >= recentFrom)
      .sort((x, y) => (String(y.position).toUpperCase() === 'QB') - (String(x.position).toUpperCase() === 'QB'))
      .map(p => ({ player: p.name, pos: String(p.position || '').toUpperCase(), status: String(p.status || '').toLowerCase(), date: p.date || null }));
  }
  // Starting pitchers (MLB) and goalies (NHL) recorded at each pipeline run.
  function recordStarters(byGame) {
    const st = read(K_ST, {}), now = Date.now();
    Object.entries(byGame || {}).forEach(([id, x]) => {
      const rec = x.mlb ? { h: x.mlb.home?.name || null, a: x.mlb.away?.name || null, k: 'pitcher' }
                : x.nhl ? { h: x.nhl.home?.name || null, a: x.nhl.away?.name || null, k: 'goalie' } : null;
      if (!rec || (!rec.h && !rec.a)) return;
      const hist = st[id] = st[id] || [];
      const last = hist[hist.length - 1];
      if (!last || last.h !== rec.h || last.a !== rec.a) hist.push({ t: now, ...rec });
      if (hist.length > 10) hist.splice(1, hist.length - 10);
    });
    write(K_ST, st);
  }
  function starterChange(game, sinceMs) {
    const hist = read(K_ST, {})[game.id] || [];
    if (hist.length < 2) return null;
    const before = [...hist].reverse().find(r => r.t <= sinceMs) || hist[0];
    const now = hist[hist.length - 1];
    const ch = [];
    if (before.h && now.h && before.h !== now.h) ch.push({ team: game.home, from: before.h, to: now.h, kind: now.k });
    if (before.a && now.a && before.a !== now.a) ch.push({ team: game.away, from: before.a, to: now.a, kind: now.k });
    return ch.length ? ch : null;
  }
  // ESPN headlines for both teams since the reference time — fetched only
  // when you open the panel, cached 30 minutes per sport.
  const NEWS_PATH = { NFL: 'football/nfl', NCAAF: 'football/college-football', NBA: 'basketball/nba', WNBA: 'basketball/wnba',
                      NCAAB: 'basketball/mens-college-basketball', MLB: 'baseball/mlb', NHL: 'hockey/nhl', MLS: 'soccer/usa.1' };
  const NEWS_WORDS = /(injur|out for|ruled out|questionable|doubtful|suspend|starter|starting|quarterback|\bqb\b|benched|traded|trade|weather|wind|illness|personal|concussion|surgery|placed on|activated|return|scratch|lineup)/i;
  const headlineCache = {};
  async function headlinesFor(game, sinceMs) {
    const path = NEWS_PATH[game.sport];
    if (!path) return [];
    let items = headlineCache[game.sport];
    if (!items || Date.now() - items.t > 30 * 60000) {
      try {
        const res = await fetch(`https://site.api.espn.com/apis/site/v2/sports/${path}/news?limit=60`);
        const d = res.ok ? await res.json() : {};
        items = headlineCache[game.sport] = { t: Date.now(), list: (d.articles || []).map(a => ({
          title: a.headline || '', desc: a.description || '', when: a.published || a.lastModified || null,
          link: (a.links && a.links.web && a.links.web.href) || null })) };
      } catch { items = headlineCache[game.sport] = { t: Date.now(), list: [] }; }
    }
    const words = t => { const parts = String(t || '').split(' '); return [parts[parts.length - 1], parts.slice(0, -1).join(' ')].filter(w => w && w.length > 3); };
    const hW = words(game.home), aW = words(game.away);
    return items.list.filter(a => {
      const txt = `${a.title} ${a.desc}`;
      const when = a.when ? new Date(a.when).getTime() : 0;
      const mentions = hW.concat(aW).some(w => txt.toLowerCase().includes(w.toLowerCase()));
      return mentions && when >= sinceMs - 12 * 3600000;
    }).map(a => {
      const txt = `${a.title} ${a.desc}`.toLowerCase();
      // Every team the headline names (a headline about one team's injury
      // usually names the opponent too).
      const teams = [hW.some(w => txt.includes(w.toLowerCase())) ? game.home : null, aW.some(w => txt.includes(w.toLowerCase())) ? game.away : null].filter(Boolean);
      return { ...a, relevant: NEWS_WORDS.test(txt), teams, team: teams.join(' & ') };
    });
  }

  function classify(game, refLine, refTime, curSnap) {
    const sport = game.sport, cur = curSnap.h, move = cur - refLine;   // + = toward the away team
    const out = { move, cause: null, why: [], key: false, checks: [], evidence: { injuries: [], changes: [], starters: null, headlines: [] } };
    const threshold = MOVE[sport] ?? 2;
    if (sport === 'NFL') {
      const crossed = [3, 7].filter(k => (Math.abs(refLine) - k) * (Math.abs(cur) - k) < 0 || (Math.abs(refLine) !== k && Math.abs(cur) === k));
      if (crossed.length) out.key = crossed.join(' and ');
    }
    if (Math.abs(move) < threshold && !out.key) return out;
    const againstTeam = move > 0 ? game.home : game.away;              // the team the line moved against
    // 1. Injury changes since the reference time (this phone's downloads)
    const items = newsFor(game, refTime - 3600000);
    const relevant = items.filter(n => n.worse && teamKeyMatch(n.team, againstTeam));
    out.evidence.changes = items.map(n => ({ team: n.team, player: n.player, pos: n.pos, from: n.from, to: n.to, worse: n.worse }));
    out.checks.push(`Injury changes since then: ${items.length ? items.length + ' found' : 'none recorded'}`);
    // 2. The current injury report for the team the line moved against
    const inj = currentInjuries(sport, againstTeam, refTime);
    out.evidence.injuries = inj.slice(0, 6);
    out.checks.push(`Injury report for ${againstTeam}: ${inj.length ? inj.length + ' newly out or doubtful' : 'no new injuries since then'}`);
    // 3. Starting pitcher / goalie changes
    const sc = starterChange(game, refTime);
    out.evidence.starters = sc;
    if (sport === 'MLB' || sport === 'NHL') out.checks.push(`Starters: ${sc ? 'changed' : 'no change recorded'}`);
    if (relevant.length) {
      out.cause = 'NEWS';
      const qb = relevant.find(n => n.pos === 'QB' && FOOTBALL.has(sport));
      out.why.push(qb ? `Quarterback news: ${qb.player} now ${qb.to}` : `${againstTeam} injury update${relevant.length === 1 ? '' : 's'}: ` +
        relevant.slice(0, 3).map(n => `${n.player}${n.pos ? ' (' + n.pos + ')' : ''} ${n.from} → ${n.to}`).join(', '));
    } else if (sc) {
      out.cause = 'NEWS';
      out.why.push(sc.map(c => `${c.team} ${c.kind} change: ${c.from} → ${c.to}`).join('; '));
    } else if (inj.length && (inj.some(p => p.pos === 'QB' && FOOTBALL.has(sport)) || inj.length >= 1)) {
      out.cause = 'NEWS';
      const qb = inj.find(p => p.pos === 'QB' && FOOTBALL.has(sport));
      out.why.push(qb ? `${againstTeam} quarterback ${qb.player} is listed ${qb.status}${qb.date ? ' (since ' + new Date(qb.date).toLocaleDateString('en-US', { month: 'short', day: 'numeric' }) + ')' : ''}`
        : `${againstTeam} newly listed out or doubtful: ` + inj.slice(0, 3).map(p => `${p.player}${p.pos ? ' (' + p.pos + ')' : ''} ${p.status}${p.date ? ' since ' + new Date(p.date).toLocaleDateString('en-US', { month: 'short', day: 'numeric' }) : ''}`).join(', '));
    }
    // 4. Steam: a fast move between the last two refreshes, near kickoff
    const lines = read(K_LINES, {})[game.id];
    const snaps = lines ? lines.snaps : [];
    if (snaps.length >= 2) {
      const a = snaps[snaps.length - 2], b = snaps[snaps.length - 1];
      const hrsToStart = (new Date(game.start || 0).getTime() - b.t) / 3600000;
      if (a.h != null && b.h != null && Math.abs(b.h - a.h) >= threshold && b.t - a.t <= 3 * 3600000 && hrsToStart <= 24 && hrsToStart > -1) {
        if (!out.cause) out.cause = 'STEAM';
        out.why.push(`Moved ${fmt(b.h - a.h)} in ${Math.max(1, Math.round((b.t - a.t) / 60000))} min, ${Math.max(0, Math.round(hrsToStart))}h before kickoff`);
      }
    }
    // 5. Nothing explains it: sharp money, inferred
    if (!out.cause) {
      const s = curSnap.s;
      const ahead = s != null && Math.sign(s - refLine) === Math.sign(move) && Math.abs(s - refLine) >= Math.abs(move) - 0.25;
      out.cause = 'SHARP';
      out.why.push(`No injury, lineup or starter news found for ${againstTeam} — headlines are checked when you open this panel`);
      if (ahead) out.why.push(`The sharpest book (${game.bench || 'low-margin book'}) moved first or furthest: ${fmt(s)}`);
    }
    if (out.key) out.why.push(`Crossed ${out.key} — the most common NFL winning margins, so these points are worth more than most`);
    out.againstTeam = againstTeam;
    return out;
  }

  // ── ALERTS ──
  async function buildAlerts() {
    const lines = read(K_LINES, {});
    const evals = (read('edge_last_evaluations', {}) || {}).items || [];
    const evById = {}; evals.forEach(e => { evById[e.game_id] = e; });
    const alerts = [];
    const now = Date.now();
    // Your pending bets
    let bets = [];
    try {
      const url = localStorage.getItem('edge_supabase_url'), key = localStorage.getItem('edge_supabase_key');
      if (url && key) {
        const res = await fetch(`${url}/rest/v1/bet_log?status=eq.pending&select=id,game_id,mode,sport,matchup,pick_label,pick_type,line,odds,amount,confidence,created_at&order=created_at.desc&limit=500`,
          { headers: { apikey: key, Authorization: `Bearer ${key}` } });
        if (res.ok) bets = await res.json();
      }
    } catch {}
    const seenGameSide = new Set();
    bets.forEach(b => {
      const L = lines[b.game_id];
      if (!L || !L.snaps.length) return;
      if (new Date(L.start || 0).getTime() <= now) return;           // started — nothing to do now
      const game = { id: b.game_id, sport: L.sport, home: L.home, away: L.away, start: L.start, bench: L.bench || null };
      const cur = L.snaps[L.snaps.length - 1];
      const label = String(b.pick_label || '');
      const homeSide = nm(label).startsWith(nm(L.home)) || (nm(label).includes(nm(L.home)) && !nm(label).includes(nm(L.away)));
      const sideTeam = homeSide ? L.home : L.away;
      const ev = evById[b.game_id];
      const tag = `${b.game_id}|${homeSide ? 'h' : 'a'}|${b.mode}`;
      if (seenGameSide.has(tag)) return; seenGameSide.add(tag);
      // Over/unders you've bet: the total's move since your bet, explained
      // by starter changes (MLB/NHL) or new injuries on either team, else
      // inferred as sharp money.
      if (b.pick_type === 'TOTAL') {
        const refT = Number(b.line), nowT = cur.tot;
        if (!isFinite(refT) || nowT == null) return;
        const over = /^over/i.test(label);
        const mv = nowT - refT;
        if (Math.abs(mv) < (TOTAL_MOVE[L.sport] ?? 2)) return;
        const favorable = over ? mv > 0 : mv < 0;          // you hold the better number
        const refTime = new Date(b.created_at).getTime();
        const sc = starterChange(game, refTime);
        const injH = currentInjuries(L.sport, L.home, refTime), injA = currentInjuries(L.sport, L.away, refTime);
        const checks = [`Starters: ${sc ? 'changed' : 'no change recorded'}`, `New injuries: ${L.home} ${injH.length} · ${L.away} ${injA.length}`];
        let kind = 'SHARP', why = [], rule, suggest;
        if (sc) { kind = 'NEWS'; why.push(sc.map(c => `${c.team} ${c.kind} change: ${c.from} → ${c.to}`).join('; ')); }
        else if (injH.length || injA.length) { kind = 'NEWS'; why.push('Newly out or doubtful: ' + injH.concat(injA).slice(0, 4).map(p => `${p.player}${p.pos ? ' (' + p.pos + ')' : ''}`).join(', ')); }
        else why.push('No starter or injury news found for either team — headlines are checked when you open this panel');
        if (favorable) { kind = 'FAVORABLE'; rule = 'favorable'; suggest = `You beat the market by ${Math.abs(mv).toFixed(1)} (your ${over ? 'Over' : 'Under'} ${refT} vs ${nowT} now). No action needed.`; }
        else if (kind === 'NEWS') { rule = 'edge_gone'; suggest = `The total moved ${fmt(mv)} after news (${why[0]}). Hold what you have; don\u2019t add at the new number.`; }
        else { rule = 'sharp_dont_add'; suggest = `Likely sharp money on the ${mv < 0 ? 'Under' : 'Over'} (an inference — no news explains it). Don\u2019t add.`; }
        alerts.push({
          id: `${b.game_id}|tot|${b.mode}`, sev: favorable ? 1 : (kind === 'NEWS' ? 3 : 2), game, kind,
          title: `${over ? 'Over' : 'Under'} ${refT} → ${nowT} now`, why, suggest, dismissKey: `${nowT}`, bet: b, sideHome: null,
          rule, ref: refT, at: nowT, sharp: null, side: over ? 'Over' : 'Under', mode: b.mode, checks,
          evidence: { market: 'total', starters: sc, injuries: injH.concat(injA).slice(0, 6) }, nums: {},
        });
        return;
      }
      if (b.pick_type === 'ML' || ML_SPORTS.has(L.sport)) {
        // Moneylines: the move is in the price's implied chance.
        const priceThen = Number(b.odds), priceNow = homeSide ? cur.ml[0] : cur.ml[1];
        if (!isFinite(priceThen) || priceNow == null) return;
        const dp = implied(priceNow) - implied(priceThen);
        if (Math.abs(dp) < 0.04) return;
        const favorable = dp > 0;
        alerts.push({
          id: `${tag}|ml`, sev: favorable ? 1 : 2, game, kind: favorable ? 'FAVORABLE' : 'MOVE',
          title: `${sideTeam} ML ${fmt(priceThen)} → ${fmt(priceNow)}`,
          why: [favorable ? `The market now gives ${sideTeam} ${pct(implied(priceNow))} (you bet at ${pct(implied(priceThen))})` : `The market now gives ${sideTeam} ${pct(implied(priceNow))}, down from ${pct(implied(priceThen))}`],
          suggest: favorable ? 'You beat the market. No action needed.' : 'The price moved against you. Check the starter/goalie news before adding; if there is none, treat it as sharp money and don\u2019t add.',
          dismissKey: `${priceNow}`, bet: b, sideHome: homeSide,
          rule: favorable ? 'favorable' : 'ml_moved', ref: priceThen, at: priceNow, sharp: null, side: sideTeam, mode: b.mode,
          checks: [], evidence: { starters: starterChange(game, new Date(b.created_at).getTime()) }, nums: {},
        });
        return;
      }
      const ref = Number(b.line);                                      // your line, home view
      if (!isFinite(ref) || cur.h == null) return;
      const c = classify(game, ref, new Date(b.created_at).getTime(), cur);
      const favorable = homeSide ? cur.h < ref : cur.h > ref;
      if (Math.abs(c.move) < (MOVE[L.sport] ?? 2) && !c.key) return;
      const yourLine = homeSide ? ref : -ref, curLine = homeSide ? cur.h : -cur.h;
      const pYour = ev ? (homeSide ? homeCoverAt(ev, ref) : 1 - homeCoverAt(ev, ref)) : null;
      const pOtherNow = ev ? (homeSide ? 1 - homeCoverAt(ev, cur.h) : homeCoverAt(ev, cur.h)) : null;
      const otherVal = pOtherNow != null ? pOtherNow - breakEven(-110) : null;
      const stale = ev && newsFor(game, new Date(ev.rated_at || 0).getTime()).some(n => n.worse);
      const why = c.why.slice();
      let suggest, rule;
      if (favorable) {
        rule = 'favorable';
        suggest = `You beat the market by ${Math.abs(c.move).toFixed(1)} points (${sideTeam} ${fmt(yourLine)} vs ${fmt(curLine)} now). No action needed.`;
      } else if (stale) {
        rule = 'reevaluate';
        suggest = 'There\u2019s news since the model last rated this game. Re-evaluate before doing anything.';
      } else if (c.cause === 'NEWS') {
        rule = pYour != null && pYour > breakEven(b.odds) ? 'hold' : (otherVal != null && otherVal > 0.02 ? 'other_side' : 'edge_gone');
        suggest = pYour != null && pYour > breakEven(b.odds)
          ? `The news is priced in and the model still gives your bet ${pct(pYour)} at ${fmt(yourLine)}. Hold; don\u2019t add at the new number.`
          : (otherVal != null && otherVal > 0.02
              ? `Your edge is gone after the news (model ${pYour != null ? pct(pYour) : '—'} for your bet). Don\u2019t add. The other side is +${(otherVal * 100).toFixed(1)}% value at ${fmt(-curLine)} — ⇄ Flip if you want to offset.`
              : `Your edge is gone after the news (${c.why[0] || 'see above'}). Hold what you have and don\u2019t add.`);
      } else if (c.cause === 'STEAM') {
        rule = 'steam_wait';
        suggest = 'A fast move this close to kickoff usually means late information. Don\u2019t add until you know why.';
      } else {
        rule = 'sharp_dont_add';
        suggest = `Likely sharp money against your side (an inference — no news explains it). Don\u2019t add${pYour != null ? `; the model gives your bet ${pct(pYour)} at your number` : ''}.`;
      }
      alerts.push({
        id: `${tag}|spread`, sev: favorable ? 1 : (c.cause === 'NEWS' || c.cause === 'STEAM' || stale ? 3 : 2), game,
        kind: favorable ? 'FAVORABLE' : (stale ? 'STALE' : c.cause || 'MOVE'),
        title: `${sideTeam} ${fmt(yourLine)} → ${fmt(curLine)} now`,
        why, suggest, dismissKey: `${cur.h}`, bet: b, sideHome: homeSide,
        model: pYour != null ? `Model: your bet ${pct(pYour)}${otherVal != null ? ` · other side ${otherVal >= 0 ? '+' : ''}${(otherVal * 100).toFixed(1)}% value at ${fmt(-curLine)}` : ''}` : null,
        rule, ref, at: cur.h, sharp: cur.s, side: sideTeam, mode: b.mode, checks: c.checks, evidence: c.evidence, againstTeam: c.againstTeam,
        nums: { your_chance: pYour, other_value: otherVal, model_spread: ev ? ev.total_spread : null, rated_at: ev ? ev.rated_at : null },
      });
    });
    // The model's picks you haven't bet: the line moved since it rated them.
    evals.forEach(ev => {
      if (!ev || !ev.game_id || !['BET_2U', 'BET_1U', 'BET', 'LEAN'].includes(ev.decision)) return;
      const L = lines[ev.game_id];
      if (!L || !L.snaps.length || new Date(L.start || 0).getTime() <= now) return;
      if (bets.some(b => b.game_id === ev.game_id)) return;
      const cur = L.snaps[L.snaps.length - 1];
      const ref = Number(ev.market_spread);
      if (!isFinite(ref) || cur.h == null || ML_SPORTS.has(L.sport)) return;
      const game = { id: ev.game_id, sport: L.sport, home: L.home, away: L.away, start: L.start, bench: L.bench || null };
      const c = classify(game, ref, new Date(ev.rated_at || 0).getTime() || (cur.t - 86400000), cur);
      const sideHome = ev.direction === 'home';
      const team = sideHome ? L.home : L.away;
      const modelMargin = -Number(ev.total_spread);
      // SPLIT: the market far from the model and still moving away from it
      const gap = isFinite(modelMargin) ? Math.abs((-cur.h) - modelMargin) : 0;
      const movingAway = isFinite(modelMargin) && Math.abs((-cur.h) - modelMargin) > Math.abs((-ref) - modelMargin);
      if (Math.abs(c.move) < (MOVE[L.sport] ?? 2) && !c.key && !(gap >= (SPLIT[L.sport] ?? 5) && movingAway)) return;
      const pNow = sideHome ? homeCoverAt(ev, cur.h) : 1 - homeCoverAt(ev, cur.h);
      const val = pNow != null ? pNow - breakEven(-110) : null;
      const against = sideHome ? cur.h > ref : cur.h < ref;
      const why = c.why.slice();
      if (gap >= (SPLIT[L.sport] ?? 5) && movingAway) why.push(`The market (${fmt(cur.h)} home) is ${gap.toFixed(1)} points from the model\u2019s number and moving further away`);
      let suggest, rule;
      if (!against) { rule = 'favorable_pick'; suggest = `The line moved your way — the pick is ${val != null ? `now ${val >= 0 ? '+' : ''}${(val * 100).toFixed(1)}% value` : 'better'} at ${fmt(sideHome ? cur.h : -cur.h)}.`; }
      else if (c.cause === 'NEWS') { rule = 'news_reeval'; suggest = 'News moved this line. Re-evaluate before betting it — the model\u2019s rating is from before the news.'; }
      else if (c.cause === 'STEAM') { rule = 'steam_wait'; suggest = 'Late fast move. Wait or skip.'; }
      else { rule = val != null && val > 0.04 ? 'sharp_strong_value' : 'sharp_skip';
             suggest = `Likely sharp money against this pick (an inference). ${val != null && val > 0.04 ? 'The model still shows strong value — bet only if you trust the rating over the market.' : 'Skip it unless a re-evaluation still shows real value.'}`; }
      alerts.push({
        id: `${ev.game_id}|pick`, sev: against ? 2 : 1, game, kind: against ? (c.cause || 'MOVE') : 'FAVORABLE',
        title: `Model pick ${team}: rated at ${fmt(sideHome ? ref : -ref)}, now ${fmt(sideHome ? cur.h : -cur.h)}`,
        why, suggest, dismissKey: `${cur.h}`, sideHome,
        model: val != null ? `Model now: ${pct(pNow)} · value ${val >= 0 ? '+' : ''}${(val * 100).toFixed(1)}%` : null,
        rule, ref, at: cur.h, sharp: cur.s, side: team, mode: 'model', checks: c.checks, evidence: c.evidence, againstTeam: c.againstTeam,
        nums: { pick_chance: pNow, pick_value: val, model_spread: ev.total_spread, rated_at: ev.rated_at || null },
      });
    });
    const dismissed = read(K_DISMISS, {});
    return alerts.filter(a => dismissed[a.id] !== a.dismissKey).sort((a, b) => b.sev - a.sev);
  }

  // ── UI ──
  function css() {
    if (document.getElementById('guardCss')) return;
    const st = document.createElement('style');
    st.id = 'guardCss';
    st.textContent = `
      .lg-bubble { position: fixed; right: 16px; bottom: 84px; z-index: 9000; min-width: 52px; height: 52px; border-radius: 26px; padding: 0 14px;
        background: var(--gold, #c9a84c); color: #000; border: none; font-family: 'Bebas Neue', sans-serif; font-size: 22px; letter-spacing: 1px;
        box-shadow: 0 6px 20px rgba(0,0,0,.5); cursor: pointer; display: flex; align-items: center; gap: 6px; }
      .lg-bubble.hot { background: #e05252; color: #fff; }
      .lg-veil { position: fixed; inset: 0; background: rgba(0,0,0,.7); z-index: 9001; display: flex; align-items: flex-end; justify-content: center; }
      .lg-panel { width: 100%; max-width: 560px; max-height: 85vh; overflow: auto; background: var(--surface, #111); border: 1px solid var(--gold, #c9a84c); padding: 14px; }
      .lg-head { display: flex; justify-content: space-between; align-items: center; font-family: 'Bebas Neue', sans-serif; letter-spacing: 2px; font-size: 24px; color: var(--gold, #c9a84c); }
      .lg-close { background: none; border: none; color: var(--text-dim, #999); font-size: 22px; cursor: pointer; }
      .lg-item { border: 1px solid var(--border, #333); padding: 10px; margin-top: 10px; }
      .lg-kind { display: inline-block; font-size: 10px; letter-spacing: 1.5px; padding: 1px 6px; border: 1px solid; margin-right: 6px; font-family: 'Barlow Condensed', sans-serif; }
      .lg-kind.NEWS, .lg-kind.STEAM, .lg-kind.STALE { color: #e05252; } .lg-kind.SHARP, .lg-kind.MOVE { color: var(--gold, #c9a84c); } .lg-kind.FAVORABLE { color: #3fbf7f; }
      .lg-title { font-size: 15px; color: var(--text, #eee); margin: 4px 0; font-family: 'Barlow Condensed', sans-serif; letter-spacing: .5px; }
      .lg-meta { font-size: 11px; color: var(--text-dim, #999); }
      .lg-why { font-size: 12px; color: var(--text-dim, #aaa); margin: 6px 0; line-height: 1.5; }
      .lg-model { font-size: 12px; color: var(--text, #ddd); margin: 4px 0; }
      .lg-suggest { font-size: 13px; color: var(--text, #eee); border-left: 2px solid var(--gold, #c9a84c); padding-left: 8px; margin: 8px 0; line-height: 1.5; }
      .lg-acts { display: flex; gap: 6px; flex-wrap: wrap; }
      .lg-acts button { background: none; border: 1px solid var(--border, #444); color: var(--text, #ddd); font-size: 12px; padding: 6px 10px; cursor: pointer; }
      .lg-empty { font-size: 13px; color: var(--text-dim, #999); margin-top: 10px; }
      .lg-tabs { display: flex; gap: 6px; margin-top: 8px; }
      .lg-tabs button { flex: 1; background: none; border: 1px solid var(--border, #444); color: var(--text-dim, #aaa); padding: 7px; font-size: 12px; letter-spacing: 1px; cursor: pointer; }
      .lg-tabs button.on { color: var(--gold, #c9a84c); border-color: var(--gold, #c9a84c); }
      .lg-checks { font-size: 11px; color: var(--text-dim, #999); margin: 6px 0; line-height: 1.6; }
      .lg-checks summary { cursor: pointer; }
      .lg-why a { color: var(--gold, #c9a84c); }
      .lg-tbl { width: 100%; border-collapse: collapse; font-size: 12px; margin-top: 6px; }
      .lg-tbl th { text-align: left; color: var(--text-dim, #999); font-weight: 500; padding: 4px; border-bottom: 1px solid var(--border, #333); }
      .lg-tbl td { padding: 5px 4px; border-bottom: 1px solid var(--border, #333); color: var(--text, #ddd); }`;
    document.head.appendChild(st);
  }
  let current = [];
  async function refresh() {
    try { current = await buildAlerts(); } catch { current = []; }
    css();
    let b = document.getElementById('lgBubble');
    if (!current.length) { if (b) b.remove(); return current; }
    if (!b) {
      b = document.createElement('button');
      b.id = 'lgBubble'; b.className = 'lg-bubble'; b.onclick = () => openPanel('alerts');
      document.body.appendChild(b);
    }
    const hot = current.some(a => a.sev >= 3);
    b.classList.toggle('hot', hot);
    logAlerts();                     // every alert is logged when it appears
    b.textContent = `⚠ ${current.length}`;
    b.title = 'Line Guard — tap to see why lines moved';
    return current;
  }
  function dismiss(id) {
    const a = current.find(x => x.id === id); if (!a) return;
    const d = read(K_DISMISS, {}); d[id] = a.dismissKey; write(K_DISMISS, d);
    document.querySelectorAll('.lg-veil').forEach(v => v.remove());
    refresh().then(() => { if (current.length) openPanel(); });
  }
  function act(id, what) {
    const a = current.find(x => x.id === id); if (!a) return;
    if (what === 'reeval') {
      if (typeof window.reevaluate === 'function') { document.querySelectorAll('.lg-veil').forEach(v => v.remove()); window.reevaluate(a.game.id); }
      else location.href = `picks.html?reeval=${encodeURIComponent(a.game.id)}`;
    } else if (what === 'flip') {
      const side = a.sideHome ? 'away' : 'home';
      if (window.EDGE_MYPICK) { document.querySelectorAll('.lg-veil').forEach(v => v.remove()); EDGE_MYPICK.open(a.game.id, { home_team: a.game.home, away_team: a.game.away, sport: a.game.sport, commence_time: a.game.start, side }); }
      else location.href = 'matchups.html';
    }
  }

  // ── DECISIONS ──
  // What you decide on an alert is saved with the time and the line at
  // that moment, then carried out. After the game both the guard's
  // suggestion and your decision are graded.
  async function decide(id, action) {
    const a = current.find(x => x.id === id); if (!a) return;
    const { url, key } = sb();
    const logId = `${a.id}|${a.dismissKey}`.slice(0, 200);
    await logAlerts();
    const decision = { action, line: isFinite(a.at) ? a.at : null, at: new Date().toISOString(),
                       side: a.side || null, bet_id: a.bet ? a.bet.id : null, amount: a.bet ? Number(a.bet.amount) || null : null };
    if (url && key) {
      fetch(`${url}/rest/v1/guard_alerts?id=eq.${encodeURIComponent(logId)}`, {
        method: 'PATCH',
        headers: { apikey: key, Authorization: `Bearer ${key}`, 'Content-Type': 'application/json', Prefer: 'return=minimal' },
        body: JSON.stringify({ decision, decided_at: decision.at }),
      }).catch(() => {});
    }
    const close = () => document.querySelectorAll('.lg-veil').forEach(v => v.remove());
    const hide = () => { const d = read(K_DISMISS, {}); d[id] = a.dismissKey; write(K_DISMISS, d); };
    if (action === 'remove' && a.bet && url && key) {
      if (new Date(a.game.start || 0).getTime() <= Date.now()) { alert('That game has started — the bet stays.'); return; }
      if (!confirm(`Remove your $${Number(a.bet.amount || 0).toFixed(0)} ${a.bet.mode} bet on ${a.side}?`)) return;
      try {
        const r = await fetch(`${url}/rest/v1/bet_log?id=eq.${a.bet.id}`, { method: 'DELETE', headers: { apikey: key, Authorization: `Bearer ${key}`, Prefer: 'return=minimal' } });
        if (!r.ok) throw new Error('HTTP ' + r.status);
      } catch (e) { alert('Could not remove the bet: ' + e.message); return; }
    }
    hide(); close();
    if (action === 'add' || action === 'other_side') {
      const sameHome = !!a.sideHome;
      const side = action === 'add' ? (sameHome ? 'home' : 'away') : (sameHome ? 'away' : 'home');
      if (window.EDGE_MYPICK) EDGE_MYPICK.open(a.game.id, { home_team: a.game.home, away_team: a.game.away, sport: a.game.sport, commence_time: a.game.start, side });
      else location.href = 'matchups.html';
    }
    refresh();
  }

  // ── HEADLINES ──
  // When the panel opens: ESPN headlines for each alerted game since the
  // reference time. A relevant headline (injury, starter, suspension,
  // weather…) on the team the line moved against turns a "sharp" guess into
  // news, with the headline as the reason.
  async function addHeadlines() {
    for (const a of current) {
      if (!a.game || a.kind === 'FAVORABLE') continue;
      const since = a.bet ? new Date(a.bet.created_at).getTime() : (a.nums && a.nums.rated_at ? new Date(a.nums.rated_at).getTime() : Date.now() - 3 * 86400000);
      let hl = [];
      try { hl = await headlinesFor(a.game, since); } catch {}
      a.evidence = a.evidence || {};
      a.evidence.headlines = hl.slice(0, 5).map(h => ({ title: h.title, when: h.when, link: h.link, team: h.team, relevant: h.relevant }));
      (a.checks = a.checks || []).push(`Headlines since then: ${hl.length ? hl.length + ' about these teams' + (hl.some(h => h.relevant) ? ', ' + hl.filter(h => h.relevant).length + ' about injuries/lineups' : '') : 'none about these teams'}`);
      const hit = hl.find(h => h.relevant && (!a.againstTeam || (h.teams || []).includes(a.againstTeam)));
      if (hit && (a.kind === 'SHARP' || a.kind === 'MOVE')) {
        a.kind = 'NEWS';
        a.why = [`Headline: "${hit.title}"${hit.when ? ' (' + new Date(hit.when).toLocaleString('en-US', { month: 'short', day: 'numeric', hour: 'numeric', minute: '2-digit' }) + ')' : ''}`]
          .concat(a.why.filter(w => !/^No injury, lineup or starter news/.test(w)));
        if (a.rule === 'sharp_dont_add') { a.rule = 'edge_gone'; a.suggest = 'News explains this move (see headline). Don\u2019t add at the new number; re-evaluate to see the model\u2019s view after the news.'; }
        if (a.rule === 'sharp_skip' || a.rule === 'sharp_strong_value') { a.rule = 'news_reeval'; a.suggest = 'News moved this line (see headline). Re-evaluate before betting it.'; }
      }
    }
  }

  // ── LOG ──
  // Every alert is saved once per line (table guard_alerts): the data it
  // rated, the checks it ran, the cause, the rule and the suggestion. After
  // the game, the closing line and score are added and the alert graded.
  const sb = () => ({ url: localStorage.getItem('edge_supabase_url'), key: localStorage.getItem('edge_supabase_key') });
  async function logAlerts() {
    const { url, key } = sb();
    if (!url || !key || localStorage.getItem('edge_guard_log_missing') === 'true') return;
    const logged = read(K_LOGGED, {});
    const sig = a => `${a.kind}|${a.rule}|${(a.evidence && a.evidence.headlines || []).length}`;
    const fresh = current.filter(a => logged[`${a.id}|${a.dismissKey}`] !== sig(a));
    const rows = fresh.map(a => ({
      id: `${a.id}|${a.dismissKey}`.slice(0, 200),
      game_id: a.game.id, sport: a.game.sport, home: a.game.home, away: a.game.away, start_time: a.game.start || null,
      kind: a.kind, rule: a.rule || null, side_team: a.side || null, mode: a.mode || null,
      ref_line: isFinite(a.ref) ? a.ref : null, line_at_alert: isFinite(a.at) ? a.at : null, sharp_line: isFinite(a.sharp) ? a.sharp : null,
      title: a.title, why: a.why, checks: a.checks || [], evidence: a.evidence || {}, model: a.nums || {}, suggestion: a.suggest,
    }));
    if (!rows.length) return;
    try {
      const res = await fetch(`${url}/rest/v1/guard_alerts?on_conflict=id`, {
        method: 'POST',
        headers: { apikey: key, Authorization: `Bearer ${key}`, 'Content-Type': 'application/json', Prefer: 'resolution=merge-duplicates,return=minimal' },
        body: JSON.stringify(rows),
      });
      if (res.status === 404 || res.status === 400) { localStorage.setItem('edge_guard_log_missing', 'true'); return; }
      if (res.ok) { fresh.forEach(a => { logged[`${a.id}|${a.dismissKey}`] = sig(a); }); write(K_LOGGED, logged); }
    } catch {}
  }

  // Grades: did the close confirm the move; did the side the alert warned
  // about lose; was the suggestion right. Lines are the home team's.
  function gradeOne(r, close, hs, as) {
    if (r.evidence && r.evidence.market === 'total') {
      // Over/under alerts: graded on the final total.
      const tot = hs + as, over = /^over/i.test(r.side_team || '');
      const hit = L => { if (!isFinite(L)) return null; const v = tot - L; if (Math.abs(v) < 1e-9) return null; return over ? v > 0 : v < 0; };
      const g = { close, final: `${as}-${hs}`, total: tot };
      const atYour = hit(Number(r.ref_line)), atAlert = hit(Number(r.line_at_alert));
      if (isFinite(r.ref_line) && isFinite(r.line_at_alert) && isFinite(close) && r.rule !== 'favorable') {
        const dir = Math.sign(r.line_at_alert - r.ref_line);
        g.close_confirmed = dir !== 0 ? (close - r.ref_line) * dir >= Math.abs(r.line_at_alert - r.ref_line) - 0.5 : null;
      }
      g.side_covered_your_line = atYour; g.side_covered_alert_line = atAlert;
      g.suggestion_right = r.rule === 'favorable' ? atYour : (atAlert == null ? null : !atAlert);
      return g;
    }
    const margin = hs - as;
    const homeSide = nm(r.side_team) && nm(r.home) && nm(r.side_team).startsWith(nm(r.home));
    const covers = (L, home) => { const v = margin + L; if (Math.abs(v) < 1e-9) return null; return home ? v > 0 : v < 0; };
    const g = { close, final: `${as}-${hs}` };
    if (isFinite(r.ref_line) && isFinite(r.line_at_alert) && isFinite(close) && r.rule !== 'favorable' && r.rule !== 'favorable_pick' && r.rule !== 'ml_moved') {
      const dir = Math.sign(r.line_at_alert - r.ref_line);
      g.close_confirmed = dir !== 0 ? (close - r.ref_line) * dir >= Math.abs(r.line_at_alert - r.ref_line) - 0.5 : null;
    }
    if (isFinite(r.ref_line) && r.rule !== 'ml_moved') {
      const atYour = covers(r.ref_line, homeSide), atAlert = isFinite(r.line_at_alert) ? covers(r.line_at_alert, homeSide) : null;
      g.side_covered_your_line = atYour; g.side_covered_alert_line = atAlert;
      const right = {
        favorable: atYour, favorable_pick: atAlert, hold: atYour,
        edge_gone: atAlert == null ? null : !atAlert, sharp_dont_add: atAlert == null ? null : !atAlert,
        steam_wait: atAlert == null ? null : !atAlert, sharp_skip: atAlert == null ? null : !atAlert,
        sharp_strong_value: atAlert, news_reeval: null, reevaluate: null,
        other_side: atAlert == null ? null : !atAlert,
      };
      g.suggestion_right = r.rule in right ? right[r.rule] : null;
      // Your decision on the alert, if you made one.
      const d = r.decision && r.decision.action;
      if (d) {
        const otherAtAlert = atAlert == null ? null : !atAlert;
        const isBet = r.mode && r.mode !== 'model';
        const dr = {
          hold: isBet ? atYour : null, dismissed: isBet ? atYour : (atAlert == null ? null : !atAlert),
          add: atAlert, other_side: otherAtAlert,
          remove: atYour == null ? null : !atYour,        // removing was right if the bet would have lost
          skip: atAlert == null ? null : !atAlert,
        };
        g.decision = d;
        g.decision_right = d in dr ? dr[d] : null;
        const follows = {
          favorable: ['hold', 'dismissed'], hold: ['hold', 'dismissed'],
          edge_gone: ['hold', 'remove', 'dismissed'], sharp_dont_add: ['hold', 'remove', 'dismissed'], steam_wait: ['hold', 'remove', 'dismissed', 'skip'],
          other_side: ['other_side'], sharp_skip: ['skip', 'dismissed'], sharp_strong_value: ['add'], favorable_pick: ['add'],
          news_reeval: [], reevaluate: [],
        };
        g.followed = r.rule in follows ? follows[r.rule].includes(d) : null;
      }
    }
    return g;
  }
  async function gradeLog() {
    const { url, key } = sb();
    if (!url || !key) return;
    try {
      const cutoff = new Date(Date.now() - 4 * 3600000).toISOString();
      const res = await fetch(`${url}/rest/v1/guard_alerts?graded_at=is.null&start_time=lt.${cutoff}&select=*&limit=200`,
        { headers: { apikey: key, Authorization: `Bearer ${key}` } });
      if (!res.ok) return;
      const rows = await res.json();
      if (!rows.length) return;
      // Finals from your game history, matched by sport, teams and date
      // (the history uses ESPN's game ids, the alerts the odds feed's).
      const finalsFor = {};
      for (const r of rows) {
        const d = new Date(r.start_time);
        const from = new Date(d.getTime() - 36 * 3600000).toISOString().slice(0, 10), to = new Date(d.getTime() + 36 * 3600000).toISOString().slice(0, 10);
        const k = `${r.sport}|${from}|${to}`;
        if (!finalsFor[k]) {
          try {
            const r2 = await fetch(`${url}/rest/v1/historical_odds?sport=eq.${r.sport}&game_date=gte.${from}&game_date=lte.${to}&home_score=not.is.null&select=home_team,away_team,spread,total,home_score,away_score&limit=1000`,
              { headers: { apikey: key, Authorization: `Bearer ${key}` } });
            finalsFor[k] = r2.ok ? await r2.json() : [];
          } catch { finalsFor[k] = []; }
        }
        r._final = finalsFor[k].find(g => teamKeyMatch(g.home_team, r.home) && teamKeyMatch(g.away_team, r.away)) || null;
      }
      for (const r of rows) {
        const fz = r._final;
        if (!fz) continue;
        const closeVal = r.evidence && r.evidence.market === 'total' ? num(fz.total) : num(fz.spread);
        const grade = gradeOne(r, closeVal, Number(fz.home_score), Number(fz.away_score));
        await fetch(`${url}/rest/v1/guard_alerts?id=eq.${encodeURIComponent(r.id)}`, {
          method: 'PATCH',
          headers: { apikey: key, Authorization: `Bearer ${key}`, 'Content-Type': 'application/json', Prefer: 'return=minimal' },
          body: JSON.stringify({ close_line: closeVal, home_score: Number(fz.home_score), away_score: Number(fz.away_score), grade, graded_at: new Date().toISOString() }),
        }).catch(() => {});
      }
    } catch {}
  }
  async function loadLog() {
    const { url, key } = sb();
    if (!url || !key) return { rows: [], missing: false };
    try {
      const res = await fetch(`${url}/rest/v1/guard_alerts?select=*&order=created_at.desc&limit=200`, { headers: { apikey: key, Authorization: `Bearer ${key}` } });
      if (res.status === 404 || res.status === 400) return { rows: [], missing: true };
      return { rows: res.ok ? await res.json() : [], missing: false };
    } catch { return { rows: [], missing: false }; }
  }
  function decisionCard(rows) {
    const out = { followed: { w: 0, l: 0 }, overrode: { w: 0, l: 0 } };
    rows.forEach(r => {
      const g = r.grade || {};
      if (!r.graded_at || g.followed == null || g.decision_right == null) return;
      const k = g.followed ? 'followed' : 'overrode';
      if (g.decision_right) out[k].w++; else out[k].l++;
    });
    return out;
  }
  function scorecard(rows) {
    const by = {};
    rows.filter(r => r.graded_at && r.grade).forEach(r => {
      const k = r.kind === 'FAVORABLE' ? 'IN YOUR FAVOR' : r.kind;
      const s = by[k] = by[k] || { n: 0, cc: 0, ccN: 0, sr: 0, srN: 0 };
      s.n++;
      if (r.grade.close_confirmed != null) { s.ccN++; if (r.grade.close_confirmed) s.cc++; }
      if (r.grade.suggestion_right != null) { s.srN++; if (r.grade.suggestion_right) s.sr++; }
    });
    return by;
  }

  // ── PANEL ──
  async function openPanel(tab = 'alerts') {
    css();
    document.querySelectorAll('.lg-veil').forEach(v => v.remove());
    const veil = document.createElement('div');
    veil.className = 'lg-veil';
    veil.onclick = e => { if (e.target === veil) veil.remove(); };
    veil.innerHTML = `<div class="lg-panel"><div class="lg-head">LINE GUARD <button class="lg-close" onclick="this.closest('.lg-veil').remove()">✕</button></div>
      <div class="lg-tabs"><button class="${tab === 'alerts' ? 'on' : ''}" onclick="EDGE_GUARD.openPanel('alerts')">Alerts</button>
        <button class="${tab === 'log' ? 'on' : ''}" onclick="EDGE_GUARD.openPanel('log')">Log &amp; accuracy</button></div>
      <div id="lgBody"><div class="lg-empty">Checking…</div></div></div>`;
    document.body.appendChild(veil);
    const body = veil.querySelector('#lgBody');
    if (tab === 'log') { await renderLog(body); return; }
    await addHeadlines();
    renderAlerts(body);
    logAlerts();
  }
  function renderAlerts(body) {
    const when = s => s ? new Date(s).toLocaleString('en-US', { weekday: 'short', hour: 'numeric', minute: '2-digit' }) : '';
    const hl = a => (a.evidence && a.evidence.headlines && a.evidence.headlines.length)
      ? `<div class="lg-why"><b>Headlines:</b><br>${a.evidence.headlines.slice(0, 3).map(h => `${h.link ? `<a href="${esc(h.link)}" target="_blank" rel="noopener">` : ''}${esc(h.title)}${h.link ? '</a>' : ''}${h.when ? ' · ' + esc(new Date(h.when).toLocaleString('en-US', { month: 'short', day: 'numeric', hour: 'numeric' })) : ''}`).join('<br>')}</div>` : '';
    body.innerHTML = (current.length ? current.map(a => `
        <div class="lg-item">
          <span class="lg-kind ${a.kind}">${a.kind === 'FAVORABLE' ? 'IN YOUR FAVOR' : a.kind === 'SHARP' ? 'SHARP (INFERRED)' : a.kind}</span>
          <span class="lg-meta">${esc(a.game.sport)} · ${esc(a.game.away)} @ ${esc(a.game.home)} · ${when(a.game.start)}${a.bet ? ` · your ${esc(a.bet.mode)} bet $${Number(a.bet.amount || 0).toFixed(0)}` : ''}</span>
          <div class="lg-title">${esc(a.title)}</div>
          ${a.why.length ? `<div class="lg-why">${a.why.map(esc).join('<br>')}</div>` : ''}
          ${hl(a)}
          ${a.model ? `<div class="lg-model">${esc(a.model)}</div>` : ''}
          <div class="lg-suggest">${esc(a.suggest)}</div>
          ${a.checks && a.checks.length ? `<details class="lg-checks"><summary>What it checked</summary>${a.checks.map(esc).join('<br>')}</details>` : ''}
          <div class="lg-acts">${a.bet ? `
            <button onclick="EDGE_GUARD.decide('${a.id}','hold')">Hold</button>
            <button onclick="EDGE_GUARD.decide('${a.id}','add')">Add</button>
            <button onclick="EDGE_GUARD.decide('${a.id}','other_side')">⇄ Other side</button>
            <button onclick="EDGE_GUARD.decide('${a.id}','remove')">Remove bet</button>
            <button onclick="EDGE_GUARD.decide('${a.id}','dismissed')">Dismiss</button>` : `
            <button onclick="EDGE_GUARD.decide('${a.id}','add')">Bet it</button>
            <button onclick="EDGE_GUARD.decide('${a.id}','other_side')">⇄ Other side</button>
            <button onclick="EDGE_GUARD.decide('${a.id}','skip')">Skip</button>`}
            <button onclick="EDGE_GUARD.act('${a.id}','reeval')">↻ Re-evaluate</button>
          </div>
        </div>`).join('') : '<div class="lg-empty">No alerts. Lines on your bets and the model\u2019s picks haven\u2019t moved enough to matter.</div>') +
      `<div class="lg-empty" style="margin-top:12px">Checked when you refresh Live Matchups or run the pipeline; headlines when you open this panel. "Sharp" is an inference from the books and the absence of news — the app can\u2019t see betting tickets.</div>`;
  }
  async function renderLog(body) {
    await gradeLog();
    const { rows, missing } = await loadLog();
    if (missing) { body.innerHTML = '<div class="lg-empty">The log table isn\u2019t set up yet — run edge-guard-log.sql in Supabase once.</div>'; return; }
    const sc = scorecard(rows);
    const pc = (a, b) => b ? `${Math.round(a / b * 100)}% (${a}/${b})` : '—';
    const card = Object.keys(sc).length
      ? `<table class="lg-tbl"><tr><th>Cause</th><th>Graded</th><th>Close confirmed</th><th>Suggestion right</th></tr>` +
        Object.entries(sc).map(([k, s]) => `<tr><td>${esc(k)}</td><td>${s.n}</td><td>${pc(s.cc, s.ccN)}</td><td>${pc(s.sr, s.srN)}</td></tr>`).join('') + `</table>`
      : '<div class="lg-empty">No graded alerts yet — alerts are graded after their games finish and the scores are in (Quick Update).</div>';
    const yn = v => v == null ? '—' : v ? '✓' : '✗';
    const dc = decisionCard(rows);
    const dline = (dc.followed.w + dc.followed.l + dc.overrode.w + dc.overrode.l)
      ? `<div class="lg-why" style="margin-top:8px"><b>Your decisions</b> · followed the guard ${dc.followed.w}-${dc.followed.l} · overrode it ${dc.overrode.w}-${dc.overrode.l}</div>`
      : `<div class="lg-why" style="margin-top:8px"><b>Your decisions</b> · none graded yet</div>`;
    body.innerHTML = `<div class="lg-why" style="margin-top:8px"><b>Scorecard</b></div>${card}${dline}
      <div class="lg-why" style="margin-top:12px"><b>Every alert</b> (newest first)</div>` +
      (rows.length ? rows.map(r => `
        <div class="lg-item">
          <span class="lg-kind ${esc(r.kind)}">${esc(r.kind)}</span>
          <span class="lg-meta">${new Date(r.created_at).toLocaleString('en-US', { month: 'short', day: 'numeric', hour: 'numeric', minute: '2-digit' })} · ${esc(r.sport)} · ${esc(r.away)} @ ${esc(r.home)} · ${esc(r.mode || '')}</span>
          <div class="lg-title">${esc(r.title || '')}</div>
          <div class="lg-why">${(r.why || []).map(esc).join('<br>')}</div>
          <div class="lg-suggest">${esc(r.suggestion || '')}</div>
          <details class="lg-checks"><summary>Data and checks</summary>
            Lines (home): reference ${r.ref_line ?? '—'} · at alert ${r.line_at_alert ?? '—'} · sharpest book ${r.sharp_line ?? '—'}<br>
            ${(r.checks || []).map(esc).join('<br>')}
            ${r.evidence && r.evidence.injuries && r.evidence.injuries.length ? '<br>Injury report: ' + r.evidence.injuries.map(p => esc(`${p.player} (${p.pos}) ${p.status}`)).join(', ') : ''}
            ${r.evidence && r.evidence.headlines && r.evidence.headlines.length ? '<br>Headlines: ' + r.evidence.headlines.map(h => esc(h.title)).join(' | ') : ''}
            <br>Rule: ${esc(r.rule || '—')}
          </details>
          <div class="lg-meta" style="margin-top:6px">${r.graded_at
            ? `Final ${esc(r.grade && r.grade.final || '')} · close ${r.close_line ?? '—'} · close confirmed ${yn(r.grade && r.grade.close_confirmed)} · suggestion right ${yn(r.grade && r.grade.suggestion_right)}`
            : 'Not graded yet'}${r.decision ? ` · your decision: ${esc(r.decision.action)}${r.grade && r.grade.decision_right != null ? ' ' + yn(r.grade.decision_right) : ''}` : ''}</div>
        </div>`).join('') : '<div class="lg-empty">Nothing logged yet. Alerts are logged when you open them.</div>');
  }

  if (typeof document !== 'undefined') {
    const go = () => { refresh(); };
    if (document.readyState === 'loading') document.addEventListener('DOMContentLoaded', go); else setTimeout(go, 0);
  }

  return { BUILD, recordBoard, recordInjuries, recordStarters, refresh, buildAlerts, openPanel, dismiss, act, decide, _homeCoverAt: homeCoverAt, _classify: classify, _gradeOne: gradeOne, _headlinesFor: headlinesFor };
})();

if (typeof window !== 'undefined') window.EDGE_GUARD = EDGE_GUARD;
