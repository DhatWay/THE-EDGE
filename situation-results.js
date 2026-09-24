// ============================================================
// EDGE — SITUATION RESULTS MODULE v1.0
//
// Owns the three operations that make situational handicapping
// a learning system rather than a static rule list:
//
//   1. PERSIST   Write one row per (game × situation × side) that
//                fired. The engine resolves a rule's side at
//                runtime — a "rating gap" rule can point at the
//                dog as easily as the favourite — so the side
//                that actually fired is what gets stored, not the
//                rule's nominal side.
//
//   2. AGGREGATE Roll those rows up per (sport, situation, season)
//                into hit rate, sample size, and a qualification
//                flag. This is what the diagnostic and the
//                learning loop read.
//
//   3. WEIGHT    Return per-situation weights the pipeline can
//                feed the situations engine so a rule that hits
//                55%+ carries more of the vote than one that is
//                scraping 50%.
//
// The three callers today are slate.html (writes), orchestrator.js
// (reads weights), and diagnostic.html (probes).
//
// SCHEMA
// Run the SQL once in the Supabase SQL editor. If RLS is locked
// to authenticated rather than anon, adjust the policy block.
// The module's probe() reports which of the three items exist.
//
//   create table if not exists public.situation_results (
//     id bigint generated always as identity primary key,
//     run_id text not null,
//     game_id text not null,
//     sport text not null,
//     game_date timestamptz,
//     season text,
//     home text,
//     away text,
//     spread numeric,
//     open_spread numeric,
//     total numeric,
//     home_score integer,
//     away_score integer,
//     margin integer,
//     combined_score integer,
//     situation_id text not null,
//     situation_side text not null,
//     side_source text,
//     won boolean,
//     push boolean default false,
//     weight numeric default 1,
//     created_at timestamptz default now()
//   );
//
//   create index if not exists situation_results_sport_idx
//     on public.situation_results (sport, situation_id);
//   create index if not exists situation_results_run_idx
//     on public.situation_results (run_id);
//
//   create table if not exists public.situation_performance (
//     id bigint generated always as identity primary key,
//     sport text not null,
//     situation_id text not null,
//     situation_label text,
//     season text not null,
//     samples integer default 0,
//     wins integer default 0,
//     losses integer default 0,
//     pushes integer default 0,
//     hit_rate numeric,
//     roi numeric,
//     current_streak integer default 0,
//     longest_streak integer default 0,
//     qualified boolean default false,
//     updated_at timestamptz default now(),
//     unique (sport, situation_id, season)
//   );
//
//   alter table public.situation_results enable row level security;
//   alter table public.situation_performance enable row level security;
//
//   drop policy if exists situation_results_anon_all on public.situation_results;
//   drop policy if exists situation_performance_anon_all on public.situation_performance;
//
//   create policy situation_results_anon_all on public.situation_results
//     for all to anon using (true) with check (true);
//   create policy situation_performance_anon_all on public.situation_performance
//     for all to anon using (true) with check (true);
//
// ============================================================

const EDGE_SITUATION_RESULTS = (() => {

  const BUILD = 'sr-20260923-01';

  const SUPABASE_URL = () => localStorage.getItem('edge_supabase_url');
  const SUPABASE_KEY = () => localStorage.getItem('edge_supabase_key');

  function logEdgeError(where, err) {
    try {
      const list = JSON.parse(localStorage.getItem('edge_errors') || '[]');
      list.unshift({ t: Date.now(), where, msg: err && err.message ? err.message : String(err) });
      localStorage.setItem('edge_errors', JSON.stringify(list.slice(0, 50)));
    } catch {}
  }

  // ============================================================
  // ── WEIGHTING RULES ──
  //
  // Below MIN_SAMPLES a situation carries neutral weight. Above it,
  // weight follows the measured hit rate. The three levels are
  // deliberately coarse — a rule at 54.9% and a rule at 55.1% do
  // not deserve different treatment on 30 samples.
  //
  // W_WEAK is 0.3, not 0. A rule that sits at 48% over 200 samples
  // is telling you something, but the honest read is "this rule is
  // unreliable" not "this rule is inverted". Inversion is a
  // separate decision and should be a separate rule.
  // ============================================================

  const MIN_SAMPLES = 20;
  const STRONG_HIT = 0.55;
  const NEUTRAL_HIT = 0.52;

  const W_STRONG = 1.5;
  const W_NEUTRAL = 1.0;
  const W_WEAK = 0.3;

  const SCHEMA_SQL = `create table if not exists public.situation_results (
  id bigint generated always as identity primary key,
  run_id text not null,
  game_id text not null,
  sport text not null,
  game_date timestamptz,
  season text,
  home text,
  away text,
  spread numeric,
  open_spread numeric,
  total numeric,
  home_score integer,
  away_score integer,
  margin integer,
  combined_score integer,
  situation_id text not null,
  situation_side text not null,
  side_source text,
  won boolean,
  push boolean default false,
  weight numeric default 1,
  created_at timestamptz default now()
);

create index if not exists situation_results_sport_idx
  on public.situation_results (sport, situation_id);
create index if not exists situation_results_run_idx
  on public.situation_results (run_id);

create table if not exists public.situation_performance (
  id bigint generated always as identity primary key,
  sport text not null,
  situation_id text not null,
  situation_label text,
  season text not null,
  samples integer default 0,
  wins integer default 0,
  losses integer default 0,
  pushes integer default 0,
  hit_rate numeric,
  roi numeric,
  current_streak integer default 0,
  longest_streak integer default 0,
  qualified boolean default false,
  updated_at timestamptz default now(),
  unique (sport, situation_id, season)
);

alter table public.situation_results enable row level security;
alter table public.situation_performance enable row level security;

drop policy if exists situation_results_anon_all on public.situation_results;
drop policy if exists situation_performance_anon_all on public.situation_performance;

create policy situation_results_anon_all on public.situation_results
  for all to anon using (true) with check (true);
create policy situation_performance_anon_all on public.situation_performance
  for all to anon using (true) with check (true);`;

  return {
    BUILD,
    probe,
    schemaSql,
    clearForSport,
    writeResults,
    loadResults,
    aggregate,
    loadWeights,
    loadPerformance,
    summarise,
    MIN_SAMPLES,
    STRONG_HIT,
    NEUTRAL_HIT,
    W_STRONG,
    W_NEUTRAL,
    W_WEAK,
  };

  // ============================================================
  // ── PROBE ──
  // Which of the three prerequisites exist. Callers can gate
  // expensive work behind this so a missing table is reported
  // before a backtest runs, not after.
  // ============================================================

  async function probe() {
    const url = SUPABASE_URL(), key = SUPABASE_KEY();
    const status = {
      connected: !!(url && key),
      open_spread: false,
      situation_results: false,
      situation_performance: false,
    };
    if (!status.connected) return status;

    const headers = { apikey: key, Authorization: `Bearer ${key}` };

    try {
      const r = await fetch(`${url}/rest/v1/historical_odds?select=open_spread&limit=1`, { headers });
      status.open_spread = r.ok;
    } catch {}

    try {
      const [a, b] = await Promise.all([
        fetch(`${url}/rest/v1/situation_results?select=id&limit=1`, { headers }),
        fetch(`${url}/rest/v1/situation_performance?select=id&limit=1`, { headers }),
      ]);
      status.situation_results = a.ok;
      status.situation_performance = b.ok;
    } catch {}

    return status;
  }

  function schemaSql() { return SCHEMA_SQL; }

  // ============================================================
  // ── CLEAR ──
  // Delete every row for a sport from both tables. Re-running a
  // walk-forward for the same window is the common case, and
  // double-counting would poison the weights.
  // ============================================================

  async function clearForSport(sport) {
    const url = SUPABASE_URL(), key = SUPABASE_KEY();
    if (!url || !key) return { ok: false, error: 'Supabase not connected' };

    const headers = { apikey: key, Authorization: `Bearer ${key}` };
    const out = { ok: true };

    try {
      const r1 = await fetch(`${url}/rest/v1/situation_results?sport=eq.${encodeURIComponent(sport)}`, {
        method: 'DELETE', headers,
      });
      out.results_deleted = r1.ok;
      if (!r1.ok) out.results_status = r1.status;
    } catch (e) {
      out.ok = false;
      out.results_error = e.message;
      logEdgeError('situationResults.clearResults.' + sport, e);
    }

    try {
      const r2 = await fetch(`${url}/rest/v1/situation_performance?sport=eq.${encodeURIComponent(sport)}`, {
        method: 'DELETE', headers,
      });
      out.performance_deleted = r2.ok;
      if (!r2.ok) out.performance_status = r2.status;
    } catch (e) {
      out.ok = false;
      out.performance_error = e.message;
      logEdgeError('situationResults.clearPerformance.' + sport, e);
    }

    return out;
  }

  // ============================================================
  // ── WRITE ──
  // rows: [{ run_id, game_id, sport, game_date, season, home, away,
  //          spread, open_spread, total, home_score, away_score,
  //          margin, combined_score, situation_id, situation_side,
  //          side_source, won, push, weight }]
  //
  // Any extra key is dropped. That lets callers carry a `label`
  // for display without it reaching the schema.
  // ============================================================

  const ALLOWED_COLUMNS = new Set([
    'run_id', 'game_id', 'sport', 'game_date', 'season',
    'home', 'away', 'spread', 'open_spread', 'total',
    'home_score', 'away_score', 'margin', 'combined_score',
    'situation_id', 'situation_side', 'side_source',
    'won', 'push', 'weight',
  ]);

  async function writeResults(rows) {
    const url = SUPABASE_URL(), key = SUPABASE_KEY();
    if (!url || !key) return { ok: false, error: 'Supabase not connected', written: 0 };
    if (!Array.isArray(rows) || !rows.length) return { ok: true, written: 0 };

    const chunkSize = 500;
    let written = 0;
    const errors = [];

    for (let i = 0; i < rows.length; i += chunkSize) {
      const chunk = rows.slice(i, i + chunkSize).map(cleanRow);

      let ok = false;
      for (let attempt = 0; attempt < 3 && !ok; attempt++) {
        try {
          const res = await fetch(`${url}/rest/v1/situation_results`, {
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
          errors.push(`chunk ${i} attempt ${attempt + 1}: HTTP ${res.status} ${txt.slice(0, 140)}`);
        } catch (e) {
          errors.push(`chunk ${i} attempt ${attempt + 1}: ${e.message}`);
          logEdgeError('situationResults.write', e);
        }
        if (!ok) await new Promise(r => setTimeout(r, 500 * (attempt + 1)));
      }
    }

    return { ok: errors.length === 0, written, errors };
  }

  function cleanRow(row) {
    const out = {};
    Object.keys(row).forEach(k => {
      if (ALLOWED_COLUMNS.has(k)) out[k] = row[k];
    });
    return out;
  }

  // ============================================================
  // ── LOAD ──
  // Paginated read of every situation_results row for a sport.
  // Used by aggregate (to compute performance) and by diagnostic
  // pages that want raw rows.
  // ============================================================

  async function loadResults(sport, options = {}) {
    const { season = null, situationId = null } = options;
    const url = SUPABASE_URL(), key = SUPABASE_KEY();
    if (!url || !key) return [];

    const out = [];
    const pageSize = 1000;
    const filters = [`sport=eq.${encodeURIComponent(sport)}`];
    if (season) filters.push(`season=eq.${encodeURIComponent(season)}`);
    if (situationId) filters.push(`situation_id=eq.${encodeURIComponent(situationId)}`);

    for (let offset = 0; offset < 500000; offset += pageSize) {
      try {
        const res = await fetch(
          `${url}/rest/v1/situation_results?${filters.join('&')}` +
          `&select=*&order=game_date.asc&limit=${pageSize}&offset=${offset}`,
          { headers: { apikey: key, Authorization: `Bearer ${key}` } }
        );
        if (!res.ok) break;
        const batch = await res.json();
        out.push(...batch);
        if (batch.length < pageSize) break;
      } catch (e) {
        logEdgeError('situationResults.loadResults.' + sport, e);
        break;
      }
    }

    return out;
  }

  // ============================================================
  // ── AGGREGATE ──
  // Read situation_results for a sport, group by (situation_id,
  // season), and upsert into situation_performance.
  //
  // Streaks are computed within each season bucket so a rule
  // that ran hot in 2023 and cold in 2024 shows two separate
  // streak records rather than one blended number.
  // ============================================================

  async function aggregate(sport, options = {}) {
    const { labelMap = null } = options;

    const rows = await loadResults(sport);
    if (!rows.length) return { ok: true, groups: 0, rows_upserted: 0 };

    // Sort by game date per situation+season so streak counting is
    // chronological.
    rows.sort((a, b) => new Date(a.game_date) - new Date(b.game_date));

    const groups = {};

    rows.forEach(r => {
      const key = `${r.situation_id}|${r.season}`;
      if (!groups[key]) {
        groups[key] = {
          sport,
          situation_id: r.situation_id,
          situation_label: labelMap ? (labelMap[r.situation_id] || null) : null,
          season: r.season,
          wins: 0, losses: 0, pushes: 0,
          weightedPnl: 0,
          current_streak: 0,
          longest_streak: 0,
        };
      }
      const g = groups[key];

      if (r.push) {
        g.pushes++;
        g.current_streak = 0;
        return;
      }

      const w = typeof r.weight === 'number' && isFinite(r.weight) ? r.weight : 1;

      if (r.won === true) {
        g.wins++;
        g.weightedPnl += w;
        g.current_streak++;
        if (g.current_streak > g.longest_streak) g.longest_streak = g.current_streak;
      } else if (r.won === false) {
        g.losses++;
        g.weightedPnl -= w;
        g.current_streak = 0;
      }
    });

    const perfRows = Object.values(groups).map(g => {
      const total = g.wins + g.losses;
      const hit = total > 0 ? g.wins / total : 0;
      const roi = total > 0 ? g.weightedPnl / total : 0;
      const qualified = total >= MIN_SAMPLES && hit >= STRONG_HIT;

      return {
        sport: g.sport,
        situation_id: g.situation_id,
        situation_label: g.situation_label,
        season: g.season,
        samples: total,
        wins: g.wins,
        losses: g.losses,
        pushes: g.pushes,
        hit_rate: round(hit, 4),
        roi: round(roi, 4),
        current_streak: g.current_streak,
        longest_streak: g.longest_streak,
        qualified,
        updated_at: new Date().toISOString(),
      };
    });

    const url = SUPABASE_URL(), key = SUPABASE_KEY();
    if (!url || !key) return { ok: false, error: 'Supabase not connected' };

    try {
      const res = await fetch(`${url}/rest/v1/situation_performance?on_conflict=sport,situation_id,season`, {
        method: 'POST',
        headers: {
          apikey: key, Authorization: `Bearer ${key}`,
          'Content-Type': 'application/json',
          Prefer: 'resolution=merge-duplicates,return=minimal',
        },
        body: JSON.stringify(perfRows),
      });
      if (!res.ok) {
        const txt = await res.text().catch(() => '');
        logEdgeError('situationResults.aggregate.upsert', new Error('HTTP ' + res.status));
        return { ok: false, error: `HTTP ${res.status} ${txt.slice(0, 160)}`, groups: perfRows.length };
      }
    } catch (e) {
      logEdgeError('situationResults.aggregate.upsert', e);
      return { ok: false, error: e.message, groups: perfRows.length };
    }

    return { ok: true, groups: perfRows.length, rows_upserted: perfRows.length };
  }

  // ============================================================
  // ── LOAD WEIGHTS ──
  // The pipeline calls this before running the situations engine.
  // Return shape is { situationId: weight } for every situation
  // that has enough history. Situations not present are implicit
  // weight 1.0.
  //
  // Multiple seasons of the same rule are pooled by sample count
  // so a rule with 500 samples in one season and 30 in another
  // does not get pulled to the mean by the smaller season.
  // ============================================================

  async function loadWeights(sport) {
    const url = SUPABASE_URL(), key = SUPABASE_KEY();
    if (!url || !key) return {};

    let rows = [];
    try {
      const res = await fetch(
        `${url}/rest/v1/situation_performance?sport=eq.${encodeURIComponent(sport)}` +
        `&select=situation_id,season,samples,hit_rate`,
        { headers: { apikey: key, Authorization: `Bearer ${key}` } }
      );
      if (!res.ok) return {};
      rows = await res.json();
    } catch (e) {
      logEdgeError('situationResults.loadWeights.' + sport, e);
      return {};
    }

    // Pool by (situation_id, season) already being the row grain,
    // so multiply hit_rate by samples and divide by total samples.
    const agg = {};
    rows.forEach(r => {
      const id = r.situation_id;
      if (!id) return;
      if (!agg[id]) agg[id] = { samples: 0, weightedSum: 0 };
      const s = r.samples || 0;
      agg[id].samples += s;
      agg[id].weightedSum += (r.hit_rate || 0) * s;
    });

    const out = {};
    Object.entries(agg).forEach(([id, s]) => {
      if (s.samples < MIN_SAMPLES) { out[id] = W_NEUTRAL; return; }
      const hr = s.weightedSum / s.samples;
      if (hr >= STRONG_HIT) out[id] = W_STRONG;
      else if (hr >= NEUTRAL_HIT) out[id] = W_NEUTRAL;
      else out[id] = W_WEAK;
    });

    return out;
  }

  // ============================================================
  // ── LOAD PERFORMANCE ──
  // Raw rows from situation_performance, for report rendering.
  // Returns one entry per (situation, season). Callers pool or
  // pick seasons as they like.
  // ============================================================

  async function loadPerformance(sport) {
    const url = SUPABASE_URL(), key = SUPABASE_KEY();
    if (!url || !key) return [];

    try {
      const res = await fetch(
        `${url}/rest/v1/situation_performance?sport=eq.${encodeURIComponent(sport)}` +
        `&select=*&order=hit_rate.desc`,
        { headers: { apikey: key, Authorization: `Bearer ${key}` } }
      );
      return res.ok ? await res.json() : [];
    } catch (e) {
      logEdgeError('situationResults.loadPerformance.' + sport, e);
      return [];
    }
  }

  // ============================================================
  // ── SUMMARISE ──
  // Convenience: pool situation_performance across seasons and
  // return one row per situation with a weight tag attached.
  // This is what the slate report and the diagnostic page both
  // want to display.
  // ============================================================

  async function summarise(sport) {
    const rows = await loadPerformance(sport);
    if (!rows.length) return [];

    const agg = {};
    rows.forEach(r => {
      const id = r.situation_id;
      if (!agg[id]) {
        agg[id] = {
          id,
          label: r.situation_label || id,
          wins: 0, losses: 0, pushes: 0,
          samples: 0, weightedSum: 0,
          weightedPnl: 0,
          seasons: new Set(),
          current_streak: r.current_streak || 0,
          longest_streak: 0,
        };
      }
      const a = agg[id];
      a.wins += r.wins || 0;
      a.losses += r.losses || 0;
      a.pushes += r.pushes || 0;
      a.samples += r.samples || 0;
      a.weightedSum += (r.hit_rate || 0) * (r.samples || 0);
      a.weightedPnl += (r.roi || 0) * (r.samples || 0);
      if (r.season) a.seasons.add(r.season);
      if ((r.longest_streak || 0) > a.longest_streak) a.longest_streak = r.longest_streak;
    });

    return Object.values(agg).map(a => {
      const total = a.wins + a.losses;
      const hit = total > 0 ? a.wins / total : 0;
      const roi = total > 0 ? a.weightedPnl / total : 0;

      let weight, tag;
      if (total < MIN_SAMPLES) {
        weight = W_NEUTRAL; tag = '—';
      } else if (hit >= STRONG_HIT) {
        weight = W_STRONG; tag = 'KEEP';
      } else if (hit >= NEUTRAL_HIT) {
        weight = W_NEUTRAL; tag = 'HOLD';
      } else {
        weight = W_WEAK; tag = 'DROP';
      }

      return {
        id: a.id,
        label: a.label,
        wins: a.wins,
        losses: a.losses,
        pushes: a.pushes,
        samples: total,
        hit_rate: hit,
        roi: round(roi, 4),
        current_streak: a.current_streak,
        longest_streak: a.longest_streak,
        seasons: Array.from(a.seasons).sort(),
        weight,
        tag,
        edge_over_break_even: hit - 0.524,
      };
    }).sort((a, b) => b.hit_rate - a.hit_rate);
  }

  // ============================================================
  // ── UTILITIES ──
  // ============================================================

  function round(v, d) { const f = Math.pow(10, d); return Math.round(v * f) / f; }

})();

if (typeof window !== 'undefined') window.EDGE_SITUATION_RESULTS = EDGE_SITUATION_RESULTS;