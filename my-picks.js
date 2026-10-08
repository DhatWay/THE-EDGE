// ============================================================
// EDGE — MY PICK
//
// Add a game to your own selection from Live Matchups, Line Movement
// or Analysis when you decide from the analytics that it's a good bet.
// The pick is saved to your picks (decision MINE), shown on Today's
// Picks with a MY PICK tag, graded like every other pick at the line
// and price you saved, and kept out of the model's own record.
// ============================================================

const EDGE_MYPICK = (function () {
  const BUILD = 'mypick-20261007-01';
  const esc = s => String(s ?? '').replace(/[<>&"]/g, c => ({ '<': '&lt;', '>': '&gt;', '&': '&amp;', '"': '&quot;' }[c]));
  const fmt = v => (v > 0 ? '+' : '') + v;

  function boardGame(gameId) {
    try { return (JSON.parse(localStorage.getItem('edge_todays_games') || '[]')).find(g => g.id === gameId) || null; }
    catch { return null; }
  }
  function lastRating(gameId) {
    try { return (JSON.parse(localStorage.getItem('edge_last_evaluations') || 'null')?.items || []).find(e => e.game_id === gameId) || null; }
    catch { return null; }
  }

  function css() {
    if (document.getElementById('mypickCss')) return;
    const st = document.createElement('style');
    st.id = 'mypickCss';
    st.textContent = `
      .mp-veil { position: fixed; inset: 0; background: rgba(0,0,0,.7); z-index: 9998; display: flex; align-items: flex-end; justify-content: center; }
      .mp-box { width: 100%; max-width: 520px; background: var(--surface, #111); border: 1px solid var(--gold, #c9a84c); padding: 16px; z-index: 9999; max-height: 90vh; overflow: auto; }
      .mp-box h4 { margin: 0 0 4px; font-family: 'Bebas Neue', sans-serif; letter-spacing: 2px; font-size: 24px; color: var(--gold, #c9a84c); }
      .mp-box .mp-sub { font-size: 12px; color: var(--text-dim, #999); margin-bottom: 10px; }
      .mp-row { display: flex; gap: 8px; align-items: center; margin: 8px 0; }
      .mp-row label { flex: 0 0 36%; font-size: 12px; color: var(--text-dim, #999); }
      .mp-row select, .mp-row input { flex: 1; min-width: 0; padding: 9px 8px; background: transparent; border: 1px solid var(--border, #333); color: var(--text, #eee); font-size: 14px; }
      .mp-note { font-size: 12px; color: var(--text-dim, #999); line-height: 1.5; margin: 8px 0; }
      .mp-btns { display: flex; gap: 8px; margin-top: 12px; }
      .mp-btns button { flex: 1; padding: 11px; font-family: 'Barlow Condensed', sans-serif; letter-spacing: 2px; text-transform: uppercase; font-size: 14px; cursor: pointer; }
      .mp-save { background: var(--gold, #c9a84c); color: #000; border: none; font-weight: 700; }
      .mp-cancel { background: transparent; color: var(--text-dim, #999); border: 1px solid var(--border, #333); }`;
    document.head.appendChild(st);
  }

  // Line and price for a side, from the saved board.
  function marketFor(g, side) {
    if (!g) return { line: null, price: -110 };
    if (side === 'home') return { line: g.home_spread ?? g.spread ?? null, price: g.home_spread_price ?? -110 };
    if (side === 'away') return { line: g.away_spread ?? (g.spread != null ? -g.spread : null), price: g.away_spread_price ?? -110 };
    if (side === 'over') return { line: g.total ?? null, price: g.over_price ?? -110 };
    if (side === 'under') return { line: g.total ?? null, price: g.under_price ?? -110 };
    if (side === 'home_ml') return { line: null, price: g.ml ?? null };
    if (side === 'away_ml') return { line: null, price: g.away_ml ?? null };
    return { line: null, price: -110 };
  }

  function open(gameId, hint = {}) {
    css();
    const g = boardGame(gameId) || null;
    const home = g?.home_team || hint.home_team || hint.home || 'Home';
    const away = g?.away_team || hint.away_team || hint.away || 'Away';
    const sport = g?._sport || g?.sport || hint.sport || '';
    const when = g?.commence_time || hint.commence_time || hint.time || null;
    const ev = lastRating(gameId);
    const veil = document.createElement('div');
    veil.className = 'mp-veil';
    veil.innerHTML = `
      <div class="mp-box">
        <h4>★ MY PICK</h4>
        <div class="mp-sub">${esc(sport)} · ${esc(away)} @ ${esc(home)}${when ? ' · ' + esc(new Date(when).toLocaleString('en-US', { month: 'short', day: 'numeric', hour: 'numeric', minute: '2-digit' })) : ''}</div>
        <div class="mp-row"><label>Bet</label><select id="mpSide">
          <option value="home">${esc(home)} (spread)</option>
          <option value="away">${esc(away)} (spread)</option>
          <option value="over">Over (total)</option>
          <option value="under">Under (total)</option>
          <option value="home_ml">${esc(home)} (moneyline)</option>
          <option value="away_ml">${esc(away)} (moneyline)</option>
        </select></div>
        <div class="mp-row" id="mpLineRow"><label>Line</label><input id="mpLine" type="number" step="0.5" inputmode="decimal" /></div>
        <div class="mp-row"><label>Price</label><input id="mpPrice" type="number" step="1" inputmode="numeric" /></div>
        <div class="mp-row"><label>Units</label><input id="mpUnits" type="number" step="0.25" min="0.25" value="1" inputmode="decimal" /></div>
        <div class="mp-note" id="mpModel"></div>
        <div class="mp-btns"><button class="mp-cancel" id="mpCancel">Cancel</button><button class="mp-save" id="mpSave">Save pick</button></div>
        <div class="mp-note" id="mpMsg"></div>
      </div>`;
    document.body.appendChild(veil);
    const $ = id => veil.querySelector('#' + id);
    const fill = () => {
      const side = $('mpSide').value;
      const m = marketFor(g, side);
      const isMl = side.endsWith('_ml');
      $('mpLineRow').hidden = isMl;
      $('mpLine').value = m.line ?? '';
      $('mpPrice').value = m.price ?? '';
      // What the model said about this game on its last run, for reference.
      let note = 'The model has no rating for this game yet (run the pipeline to get one).';
      if (ev && ev.confidence != null) {
        const modelSide = ev.direction === 'home' ? home : ev.direction === 'away' ? away : '—';
        note = `Model's last rating: ${modelSide} ${Number(ev.confidence).toFixed(1)}% · ${String(ev.decision || '').replace('_', ' ')}` +
          (ev.total ? ` · total: ${ev.total.side} ${ev.total.market_total} at ${(ev.total.p * 100).toFixed(1)}%` : '');
      }
      $('mpModel').textContent = note;
    };
    $('mpSide').addEventListener('change', fill);
    if (hint.side && $('mpSide').querySelector(`option[value="${hint.side}"]`)) $('mpSide').value = hint.side;
    fill();
    $('mpCancel').onclick = () => veil.remove();
    veil.addEventListener('click', e => { if (e.target === veil) veil.remove(); });
    $('mpSave').onclick = async () => {
      const side = $('mpSide').value;
      const isMl = side.endsWith('_ml'), isTotal = side === 'over' || side === 'under';
      const line = parseFloat($('mpLine').value), price = parseFloat($('mpPrice').value), units = parseFloat($('mpUnits').value);
      if (!isMl && !isFinite(line)) { $('mpMsg').textContent = 'Enter the line.'; return; }
      if (!isFinite(price) || Math.abs(price) < 100) { $('mpMsg').textContent = 'Enter an American price, like -110 or +135.'; return; }
      if (!isFinite(units) || units <= 0) { $('mpMsg').textContent = 'Enter how many units.'; return; }
      const url = localStorage.getItem('edge_supabase_url'), key = localStorage.getItem('edge_supabase_key');
      if (!url || !key) { $('mpMsg').textContent = 'Connect Supabase in Settings first.'; return; }
      const dir = isMl ? side.replace('_ml', '') : side;
      const team = dir === 'home' ? home : dir === 'away' ? away : (dir === 'over' ? 'Over' : 'Under');
      const homeLine = isTotal || isMl ? null : (dir === 'home' ? line : -line);
      const dec = price > 0 ? 1 + price / 100 : 1 + 100 / Math.abs(price);
      // The model's chance for this side at the posted line, when it has
      // rated the game (50 when it hasn't) — for reference only.
      let chance = 50;
      if (ev && isTotal && ev.total && isFinite(ev.total.p)) chance = (dir === ev.total.side ? ev.total.p : 1 - ev.total.p) * 100;
      else if (ev && !isTotal && !isMl && isFinite(ev.confidence) && (ev.direction === 'home' || ev.direction === 'away'))
        chance = dir === ev.direction ? Number(ev.confidence) : 100 - Number(ev.confidence);
      const row = {
        game_id: gameId,
        pick_id: `${gameId}:mine:${side}`,
        sport, home_team: home, away_team: away, commence_time: when,
        decision_mode: 'manual', decision: 'MINE', direction: dir,
        side_team: isTotal ? `${team} ${line}` : isMl ? `${team} ML` : `${team} ${fmt(line)}`,
        confidence: Math.round(chance * 10) / 10, edge: Math.round((chance / 100 - 1 / dec) * 10000) / 10000, units,
        market_spread: homeLine,
        ...(isTotal ? { market_total: line } : {}),
        governor_snapshot: {
          bet_type: isTotal ? 'TOTAL' : isMl ? 'ML' : 'SPREAD',
          ...(isTotal ? { line, market_total: line } : {}),
          price, break_even: Math.round((1 / dec) * 10000) / 10000,
          mine: true, model_rating: ev ? { side: ev.direction, chance: ev.confidence, decision: ev.decision } : null,
        },
        created_at: new Date().toISOString(),
      };
      $('mpSave').disabled = true;
      try {
        const res = await fetch(`${url}/rest/v1/shadow_picks`, {
          method: 'POST',
          headers: { apikey: key, Authorization: `Bearer ${key}`, 'Content-Type': 'application/json', Prefer: 'return=minimal' },
          body: JSON.stringify(row),
        });
        if (!res.ok) throw new Error('HTTP ' + res.status + ' ' + (await res.text().catch(() => '')).slice(0, 120));
        $('mpMsg').textContent = 'Saved — it\u2019s on Today\u2019s Picks with a MY PICK tag.';
        setTimeout(() => veil.remove(), 1200);
      } catch (e) {
        $('mpMsg').textContent = 'Not saved: ' + e.message;
        $('mpSave').disabled = false;
      }
    };
  }

  return { BUILD, open };
})();

if (typeof window !== 'undefined') window.EDGE_MYPICK = EDGE_MYPICK;
