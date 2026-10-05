// ============================================================
// EDGE — BANKROLL
//
// One money calculation for every page (Today's Picks, Betting,
// Pick History), from your logged bets:
//   balance = starting bankroll (Settings)
//           + profit on bets that have settled
//           − stakes on bets still open
// Each portfolio (real, sim) is computed on its own.
// ============================================================

const EDGE_BANKROLL = (function () {
  const BUILD = 'bankroll-20261005-01';

  function starts() {
    return {
      real: parseFloat(localStorage.getItem('edge_bankroll') || '0') || 0,
      sim: parseFloat(localStorage.getItem('edge_sim_bankroll') || '10000') || 0,
    };
  }

  // { real: { start, wagered, profit, riding, balance, bets }, sim: {...}, ok }
  async function compute() {
    const s = starts();
    const out = {
      real: { start: s.real, wagered: 0, profit: 0, riding: 0, balance: s.real, bets: 0 },
      sim: { start: s.sim, wagered: 0, profit: 0, riding: 0, balance: s.sim, bets: 0 },
      ok: false,
    };
    const url = localStorage.getItem('edge_supabase_url'), key = localStorage.getItem('edge_supabase_key');
    if (!url || !key) return out;
    try {
      for (let off = 0; off < 50000; off += 1000) {
        const res = await fetch(`${url}/rest/v1/bet_log?select=mode,amount,pnl,status,result&order=id.asc&limit=1000&offset=${off}`,
          { headers: { apikey: key, Authorization: `Bearer ${key}` } });
        if (!res.ok) return out;
        const rows = await res.json();
        rows.forEach(b => {
          const p = (b.mode || 'sim') === 'real' ? out.real : out.sim;
          const amt = Number(b.amount) || 0;
          const settled = !!b.result || b.status === 'graded';
          p.bets++;
          p.wagered += amt;
          if (settled) p.profit += Number(b.pnl) || 0;
          else p.riding += amt;
        });
        if (rows.length < 1000) break;
      }
      ['real', 'sim'].forEach(k => { const p = out[k]; p.balance = p.start + p.profit - p.riding; });
      out.ok = true;
    } catch {}
    return out;
  }

  const money = v => (v < 0 ? '-$' : '$') + Math.abs(Math.round(v)).toLocaleString();

  // One-line breakdown for under a balance.
  function breakdown(p) {
    return `start ${money(p.start)} · profit ${p.profit >= 0 ? '+' : ''}${money(p.profit)} · riding ${money(p.riding)}`;
  }

  return { BUILD, compute, breakdown, money };
})();

if (typeof window !== 'undefined') window.EDGE_BANKROLL = EDGE_BANKROLL;
