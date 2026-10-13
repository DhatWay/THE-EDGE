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
  const BUILD = 'guard-20261012-01';
  const K_LINES = 'edge_guard_lines', K_NEWS = 'edge_guard_news', K_INJ = 'edge_guard_inj', K_DISMISS = 'edge_guard_dismissed';
  const FOOTBALL = new Set(['NFL', 'NCAAF']), ML_SPORTS = new Set(['MLB', 'NHL']);
  // Points of spread that count as a real move, by sport.
  const MOVE = { NFL: 1.5, NCAAF: 2.5, NBA: 2, WNBA: 2, NCAAB: 2.5, MLS: 0.5 };
  // Points beyond which the model and the market are far apart.
  const SPLIT = { NFL: 4, NCAAF: 7, NBA: 5, WNBA: 5, NCAAB: 6, MLS: 1 };
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
      if (!last || last.h !== snap.h || last.s !== snap.s || last.ml[0] !== snap.ml[0]) e.snaps.push(snap);
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

  // ── ANALYSIS ──
  function newsFor(game, sinceMs) {
    const news = read(K_NEWS, []);
    const h = nm(game.home), a = nm(game.away);
    return news.filter(n => n.t >= sinceMs && n.sport === game.sport && (n.team === h || n.team === a));
  }
  function classify(game, refLine, refTime, curSnap) {
    const sport = game.sport, cur = curSnap.h, move = cur - refLine;   // + = toward the away team
    const out = { move, cause: null, why: [], key: false };
    const threshold = MOVE[sport] ?? 2;
    // KEY: an NFL line crossing 3 or 7
    if (sport === 'NFL') {
      const crossed = [3, 7].filter(k => (Math.abs(refLine) - k) * (Math.abs(cur) - k) < 0 || (Math.abs(refLine) !== k && Math.abs(cur) === k));
      if (crossed.length) out.key = crossed.join(' and ');
    }
    if (Math.abs(move) < threshold && !out.key) return out;
    // NEWS: worse status on the team the line moved against
    const against = move > 0 ? nm(game.home) : nm(game.away);      // line moving toward away = against home
    const items = newsFor(game, refTime - 3600000);
    const relevant = items.filter(n => n.worse && n.team === against);
    const contrary = items.filter(n => n.worse && n.team !== against);
    if (relevant.length) {
      out.cause = 'NEWS';
      const qb = relevant.find(n => n.pos === 'QB' && FOOTBALL.has(sport));
      out.why.push(qb ? `Quarterback news: ${qb.player} now ${qb.to}` : `${relevant.length} injury update${relevant.length === 1 ? '' : 's'} on ${move > 0 ? game.home : game.away}: ` +
        relevant.slice(0, 3).map(n => `${n.player}${n.pos ? ' (' + n.pos + ')' : ''} ${n.to}`).join(', '));
    }
    // STEAM: fast move between the last two refreshes, close to kickoff
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
    // SHARP (inferred): no news, and the sharpest book is ahead of the main line
    if (!out.cause) {
      const s = curSnap.s;
      const ahead = s != null && Math.sign(s - refLine) === Math.sign(move) && Math.abs(s - refLine) >= Math.abs(move) - 0.25;
      out.cause = 'SHARP';
      out.why.push(contrary.length
        ? `No news on ${move > 0 ? game.home : game.away}; the only injury news is on the other team, which should have moved it the other way`
        : 'No injury or lineup news found to explain it');
      if (ahead) out.why.push(`The sharpest book (${esc(game.bench || 'low-margin book')}) moved first or furthest: ${fmt(s)}`);
    }
    if (out.key) out.why.push(`Crossed ${out.key} — the most common NFL winning margins, so these points are worth more than most`);
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
      let suggest;
      if (favorable) {
        suggest = `You beat the market by ${Math.abs(c.move).toFixed(1)} points (${sideTeam} ${fmt(yourLine)} vs ${fmt(curLine)} now). No action needed.`;
      } else if (stale) {
        suggest = 'There\u2019s news since the model last rated this game. Re-evaluate before doing anything.';
      } else if (c.cause === 'NEWS') {
        suggest = pYour != null && pYour > breakEven(b.odds)
          ? `The news is priced in and the model still gives your bet ${pct(pYour)} at ${fmt(yourLine)}. Hold; don\u2019t add at the new number.`
          : (otherVal != null && otherVal > 0.02
              ? `Your edge is gone after the news (model ${pYour != null ? pct(pYour) : '—'} for your bet). Don\u2019t add. The other side is +${(otherVal * 100).toFixed(1)}% value at ${fmt(-curLine)} — ⇄ Flip if you want to offset.`
              : `Your edge is gone after the news. Hold what you have and don\u2019t add.`);
      } else if (c.cause === 'STEAM') {
        suggest = 'A fast move this close to kickoff usually means late information. Don\u2019t add until you know why.';
      } else {
        suggest = `Likely sharp money against your side (an inference — no news explains it). Don\u2019t add${pYour != null ? `; the model gives your bet ${pct(pYour)} at your number` : ''}.`;
      }
      alerts.push({
        id: `${tag}|spread`, sev: favorable ? 1 : (c.cause === 'NEWS' || c.cause === 'STEAM' || stale ? 3 : 2), game,
        kind: favorable ? 'FAVORABLE' : (stale ? 'STALE' : c.cause || 'MOVE'),
        title: `${sideTeam} ${fmt(yourLine)} → ${fmt(curLine)} now`,
        why, suggest, dismissKey: `${cur.h}`, bet: b, sideHome: homeSide,
        model: pYour != null ? `Model: your bet ${pct(pYour)}${otherVal != null ? ` · other side ${otherVal >= 0 ? '+' : ''}${(otherVal * 100).toFixed(1)}% value at ${fmt(-curLine)}` : ''}` : null,
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
      let suggest;
      if (!against) suggest = `The line moved your way — the pick is ${val != null ? `now ${val >= 0 ? '+' : ''}${(val * 100).toFixed(1)}% value` : 'better'} at ${fmt(sideHome ? cur.h : -cur.h)}.`;
      else if (c.cause === 'NEWS') suggest = 'News moved this line. Re-evaluate before betting it — the model\u2019s rating is from before the news.';
      else if (c.cause === 'STEAM') suggest = 'Late fast move. Wait or skip.';
      else suggest = `Likely sharp money against this pick (an inference). ${val != null && val > 0.04 ? 'The model still shows strong value — bet only if you trust the rating over the market.' : 'Skip it unless a re-evaluation still shows real value.'}`;
      alerts.push({
        id: `${ev.game_id}|pick`, sev: against ? 2 : 1, game, kind: against ? (c.cause || 'MOVE') : 'FAVORABLE',
        title: `Model pick ${team}: rated at ${fmt(sideHome ? ref : -ref)}, now ${fmt(sideHome ? cur.h : -cur.h)}`,
        why, suggest, dismissKey: `${cur.h}`, sideHome,
        model: val != null ? `Model now: ${pct(pNow)} · value ${val >= 0 ? '+' : ''}${(val * 100).toFixed(1)}%` : null,
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
      .lg-empty { font-size: 13px; color: var(--text-dim, #999); margin-top: 10px; }`;
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
      b.id = 'lgBubble'; b.className = 'lg-bubble'; b.onclick = openPanel;
      document.body.appendChild(b);
    }
    const hot = current.some(a => a.sev >= 3);
    b.classList.toggle('hot', hot);
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
  function openPanel() {
    css();
    const veil = document.createElement('div');
    veil.className = 'lg-veil';
    veil.onclick = e => { if (e.target === veil) veil.remove(); };
    const when = s => s ? new Date(s).toLocaleString('en-US', { weekday: 'short', hour: 'numeric', minute: '2-digit' }) : '';
    veil.innerHTML = `<div class="lg-panel"><div class="lg-head">LINE GUARD <button class="lg-close" onclick="this.closest('.lg-veil').remove()">✕</button></div>` +
      (current.length ? current.map(a => `
        <div class="lg-item">
          <span class="lg-kind ${a.kind}">${a.kind === 'FAVORABLE' ? 'IN YOUR FAVOR' : a.kind === 'SHARP' ? 'SHARP (INFERRED)' : a.kind}</span>
          <span class="lg-meta">${esc(a.game.sport)} · ${esc(a.game.away)} @ ${esc(a.game.home)} · ${when(a.game.start)}${a.bet ? ` · your ${esc(a.bet.mode)} bet $${Number(a.bet.amount || 0).toFixed(0)}` : ''}</span>
          <div class="lg-title">${esc(a.title)}</div>
          ${a.why.length ? `<div class="lg-why">${a.why.map(esc).join('<br>')}</div>` : ''}
          ${a.model ? `<div class="lg-model">${esc(a.model)}</div>` : ''}
          <div class="lg-suggest">${esc(a.suggest)}</div>
          <div class="lg-acts">
            <button onclick="EDGE_GUARD.act('${a.id}','reeval')">↻ Re-evaluate</button>
            ${a.kind !== 'FAVORABLE' ? `<button onclick="EDGE_GUARD.act('${a.id}','flip')">⇄ Other side</button>` : ''}
            <button onclick="EDGE_GUARD.dismiss('${a.id}')">Dismiss</button>
          </div>
        </div>`).join('') : '<div class="lg-empty">No alerts. Lines on your bets and the model\u2019s picks haven\u2019t moved enough to matter.</div>') +
      `<div class="lg-empty" style="margin-top:12px">Checked when you refresh Live Matchups or run the pipeline. "Sharp" is inferred from the books and the lack of news; the app can\u2019t see betting tickets.</div></div>`;
    document.body.appendChild(veil);
  }

  if (typeof document !== 'undefined') {
    const go = () => { refresh(); };
    if (document.readyState === 'loading') document.addEventListener('DOMContentLoaded', go); else setTimeout(go, 0);
  }

  return { BUILD, recordBoard, recordInjuries, refresh, buildAlerts, openPanel, dismiss, act, _homeCoverAt: homeCoverAt, _classify: classify };
})();

if (typeof window !== 'undefined') window.EDGE_GUARD = EDGE_GUARD;
