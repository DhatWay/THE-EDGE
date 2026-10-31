// ============================================================
// GAME SEARCH — one helper for Live Matchups, Today's Picks and
// Pick History. Matches any part of a team name, a nickname, a city,
// or initials ("KC" → Kansas City Chiefs, "SAS" → San Antonio Spurs),
// and sport names ("nba"). Several words must all match ("chiefs bills").
// ============================================================
const EDGE_SEARCH = (function () {
  const BUILD = 'search-20261031-01';
  const norm = s => String(s || '').toLowerCase().replace(/[^a-z0-9 ]/g, ' ').replace(/\s+/g, ' ').trim();
  const flat = s => norm(s).replace(/ /g, '');
  const SPORTS = ['nfl', 'ncaaf', 'nba', 'ncaab', 'wnba', 'mlb', 'nhl', 'mls'];
  // Everything a text could be searched by: the words, the whole name run
  // together, and its initials (all words, and all but the last).
  function keysFor(text) {
    const words = norm(text).split(' ').filter(Boolean);
    if (!words.length) return [];
    const init = words.map(w => w[0]).join('');
    const keys = [flat(text), init, ...words];
    if (words.length > 1) keys.push(words.slice(0, -1).map(w => w[0]).join(''));   // city initials: "KC", "LA", "NY"
    return keys;
  }
  // query: what was typed; fields: team names and any other text on the row.
  function matches(query, fields, sport) {
    const q = norm(query);
    if (!q) return true;
    const keys = [];
    (fields || []).forEach(f => keys.push(...keysFor(f)));
    if (sport) keys.push(String(sport).toLowerCase());
    return q.split(' ').every(term => {
      if (SPORTS.includes(term) && sport) return String(sport).toLowerCase() === term;
      return keys.some(k => k === term || k.includes(term) || (term.length >= 2 && k.startsWith(term)));
    });
  }
  // A search box with a clear button and a match count, wired to onChange.
  function mount(el, { placeholder = 'Search teams…', onChange } = {}) {
    if (!el) return null;
    el.innerHTML = `<div style="display:flex;gap:6px;align-items:center;margin:8px 0">
        <input type="search" class="edge-search" placeholder="${placeholder}" autocomplete="off"
          style="flex:1;padding:9px 12px;background:var(--bg2,#111);border:1px solid var(--border,#333);color:var(--text,#eee);border-radius:4px;font-size:14px">
        <button type="button" class="edge-search-clear" style="padding:8px 12px;background:none;border:1px solid var(--border,#333);color:var(--text-dim,#999);border-radius:4px" title="Clear">✕</button>
      </div><div class="edge-search-count" style="font-size:11px;color:var(--text-dim,#999);margin:-2px 0 6px"></div>`;
    const input = el.querySelector('input'), clear = el.querySelector('button'), count = el.querySelector('.edge-search-count');
    let t = null;
    input.addEventListener('input', () => { clearTimeout(t); t = setTimeout(() => onChange && onChange(input.value), 120); });
    clear.addEventListener('click', () => { input.value = ''; onChange && onChange(''); input.focus(); });
    return {
      get value() { return input.value; },
      setCount(shown, total) { count.textContent = input.value.trim() ? `${shown} of ${total} match "${input.value.trim()}"` : ''; },
    };
  }
  return { BUILD, matches, mount, keysFor };
})();
if (typeof window !== 'undefined') window.EDGE_SEARCH = EDGE_SEARCH;
