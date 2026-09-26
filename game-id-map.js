// ============================================================
// EDGE — GAME ID MAP v1.2
//
// The bridge between The Odds API event ids and ESPN event ids.
// Every lookup that crosses the two systems goes through this
// module: shadow grader, sim grader, closing line value, and
// the line_history merge in ats-tracker.
//
// v1.2 changes:
//   · schemaSql() now emits the RLS policy, matching the
//     owner_only pattern used elsewhere in the app.
//
// v1.1 changes:
//   · Non-partial unique indexes. PostgREST cannot target a
//     partial index in its on_conflict clause.
//   · Date matching prefers commence_time over created_at.
//   · loadOddsSide probes for commence_time and falls back
//     gracefully if the column is not yet present.
// ============================================================

const EDGE_GAME_ID_MAP = (() => {

  const BUILD = 'gidmap-20260926-02';

  const SUPABASE_URL = () => localStorage.getItem('edge_supabase_url');
  const SUPABASE_KEY = () => localStorage.getItem('edge_supabase_key');

  const DATE_WINDOW_DAYS = 2;

  function logEdgeError(where, err) {
    try {
      const list = JSON.parse(localStorage.getItem('edge_errors') || '[]');
      list.unshift({ t: Date.now(), where, msg: err && err.message ? err.message : String(err) });
      localStorage.setItem('edge_errors', JSON.stringify(list.slice(0, 50)));
    } catch {}
  }

  const SCHEMA_SQL = `-- EDGE game_id_map. Safe to re-run.
create table if not exists public.game_id_map (
  id bigint generated always as identity primary key,
  odds_api_id text,
  espn_id text,
  sport text not null,
  game_date timestamptz,
  home_team text,
  away_team text,
  home_norm text,
  away_norm text,
  commence_time timestamptz,
  confidence text default 'exact',
  created_at timestamptz default now()
);

drop index if exists public.game_id_map_odds_idx;
drop index if exists public.game_id_map_espn_idx;
create unique index game_id_map_odds_idx on public.game_id_map (odds_api_id);
create unique index game_id_map_espn_idx on public.game_id_map (espn_id);

create index if not exists game_id_map_lookup_idx
  on public.game_id_map (sport, home_norm, away_norm);

alter table public.game_id_map enable row level security;

drop policy if exists owner_only on public.game_id_map;
create policy owner_only on public.game_id_map
  for all to authenticated
  using ((auth.jwt() ->> 'email'::text) = '__OWNER_EMAIL__'::text)
  with check ((auth.jwt() ->> 'email'::text) = '__OWNER_EMAIL__'::text);`;

  return {
    BUILD,
    schemaSql,
    probe,
    resolveFromOddsId,
    resolveFromEspnId,
    link,
    populate,
    stats,
    clear,
    DATE_WINDOW_DAYS,
  };

  async function probe() {
    const url = SUPABASE_URL(), key = SUPABASE_KEY();
    const status = { connected: !!(url && key), table: false, row_count: null };
    if (!status.connected) return status;

    try {
      const res = await fetch(`${url}/rest/v1/game_id_map?select=id&limit=1`, {
        headers: { apikey: key, Authorization: `Bearer ${key}`, Prefer: 'count=exact' },
      });
      status.table = res.ok;
      if (res.ok) {
        const range = res.headers.get('content-range') || '';
        const parsed = parseInt(range.split('/')[1], 10);
        status.row_count = Number.isFinite(parsed) ? parsed : null;
      }
    } catch {}

    return status;
  }

  async function resolveFromOddsId(oddsApiId) {
    if (!oddsApiId) return null;
    const url = SUPABASE_URL(), key = SUPABASE_KEY();
    if (!url || !key) return null;

    try {
      const res = await fetch(
        `${url}/rest/v1/game_id_map?odds_api_id=eq.${encodeURIComponent(String(oddsApiId))}&select=espn_id&limit=1`,
        { headers: { apikey: key, Authorization: `Bearer ${key}` } }
      );
      if (!res.ok) return null;
      const rows = await res.json();
      return rows[0]?.espn_id || null;
    } catch (e) {
      logEdgeError('gameIdMap.resolveFromOddsId', e);
      return null;
    }
  }

  async function resolveFromEspnId(espnId) {
    if (!espnId) return null;
    const url = SUPABASE_URL(), key = SUPABASE_KEY();
    if (!url || !key) return null;

    try {
      const res = await fetch(
        `${url}/rest/v1/game_id_map?espn_id=eq.${encodeURIComponent(String(espnId))}&select=odds_api_id&limit=1`,
        { headers: { apikey: key, Authorization: `Bearer ${key}` } }
      );
      if (!res.ok) return null;
      const rows = await res.json();
      return rows[0]?.odds_api_id || null;
    } catch (e) {
      logEdgeError('gameIdMap.resolveFromEspnId', e);
      return null;
    }
  }

  async function link(oddsApiId, espnId, meta = {}) {
    if (!oddsApiId || !espnId) return { ok: false, error: 'both ids required' };

    const url = SUPABASE_URL(), key = SUPABASE_KEY();
    if (!url || !key) return { ok: false, error: 'Supabase not connected' };

    const row = {
      odds_api_id: String(oddsApiId),
      espn_id: String(espnId),
      sport: meta.sport || null,
      game_date: meta.game_date || null,
      home_team: meta.home_team || null,
      away_team: meta.away_team || null,
      home_norm: meta.home_norm || null,
      away_norm: meta.away_norm || null,
      commence_time: meta.commence_time || null,
      confidence: meta.confidence || 'exact',
      created_at: new Date().toISOString(),
    };

    try {
      const res = await fetch(`${url}/rest/v1/game_id_map?on_conflict=odds_api_id`, {
        method: 'POST',
        headers: {
          apikey: key, Authorization: `Bearer ${key}`,
          'Content-Type': 'application/json',
          Prefer: 'resolution=merge-duplicates,return=minimal',
        },
        body: JSON.stringify(row),
      });

      if (res.ok) return { ok: true };
      if (res.status === 409) {
        const patch = await fetch(
          `${url}/rest/v1/game_id_map?odds_api_id=eq.${encodeURIComponent(row.odds_api_id)}`,
          {
            method: 'PATCH',
            headers: {
              apikey: key, Authorization: `Bearer ${key}`,
              'Content-Type': 'application/json',
              Prefer: 'return=minimal',
            },
            body: JSON.stringify({ espn_id: row.espn_id }),
          }
        );
        return { ok: patch.ok, status: res.status };
      }

      const body = await res.text().catch(() => '');
      return { ok: false, status: res.status, error: body.slice(0, 160) };
    } catch (e) {
      logEdgeError('gameIdMap.link', e);
      return { ok: false, error: e.message };
    }
  }

  async function populate(options = {}) {
    const {
      sports = ['NFL', 'NCAAF', 'NBA', 'NCAAB', 'MLB', 'NHL', 'MLS', 'WNBA'],
      onProgress = null,
      maxDaysBack = 400,
    } = options;
    const log = (m) => { if (typeof onProgress === 'function') onProgress(m); };

    const url = SUPABASE_URL(), key = SUPABASE_KEY();
    if (!url || !key) return { ok: false, error: 'Supabase not connected' };

    const status = await probe();
    if (!status.table) {
      return { ok: false, error: 'game_id_map table missing', sql: schemaSql() };
    }

    const since = new Date(Date.now() - maxDaysBack * 86400000).toISOString();
    const summary = { sports: {}, totals: { linked: 0, skipped: 0, unmatched: 0 } };

    for (const sport of sports) {
      log(`── ${sport} ──`);

      const espnRows = await loadEspnSide(sport, since, url, key);
      log(`  ${espnRows.length} historical_odds rows`);

      if (!espnRows.length) {
        summary.sports[sport] = { linked: 0, unmatched: 0, note: 'no historical_odds' };
        continue;
      }

      const oddsRows = await loadOddsSide(sport, since, url, key);
      log(`  ${oddsRows.length} odds ids`);

      if (!oddsRows.length) {
        summary.sports[sport] = { linked: 0, unmatched: 0, note: 'no line_history' };
        continue;
      }

      const espnIndex = {};
      espnRows.forEach(r => {
        const key2 = `${r.home_norm}|${r.away_norm}`;
        if (!espnIndex[key2]) espnIndex[key2] = [];
        espnIndex[key2].push(r);
      });

      const links = [];
      let unmatched = 0;

      for (const odds of oddsRows) {
        const key2 = `${odds.home_norm}|${odds.away_norm}`;
        const candidates = espnIndex[key2];
        if (!candidates || !candidates.length) { unmatched++; continue; }

        const oddsMs = new Date(odds.commence_time || odds.created_at || 0).getTime();
        if (!isFinite(oddsMs)) { unmatched++; continue; }

        let best = null;
        let bestGap = Infinity;
        for (const c of candidates) {
          const espnMs = new Date(c.game_date).getTime();
          if (!isFinite(espnMs)) continue;
          const gapDays = Math.abs(oddsMs - espnMs) / 86400000;
          if (gapDays <= DATE_WINDOW_DAYS && gapDays < bestGap) {
            best = c;
            bestGap = gapDays;
          }
        }

        if (!best) { unmatched++; continue; }

        links.push({
          odds_api_id: String(odds.odds_api_id),
          espn_id: String(best.espn_id),
          sport,
          game_date: best.game_date,
          home_team: best.home_team,
          away_team: best.away_team,
          home_norm: best.home_norm,
          away_norm: best.away_norm,
          commence_time: odds.commence_time || null,
          confidence: 'exact',
          created_at: new Date().toISOString(),
        });
      }

      log(`  ${links.length} to write · ${unmatched} unmatched`);

      const written = await writeLinks(links, url, key);
      log(`  ${written} rows written`);

      summary.sports[sport] = { linked: written, unmatched };
      summary.totals.linked += written;
      summary.totals.unmatched += unmatched;
    }

    return { ok: true, summary };
  }

  async function loadEspnSide(sport, since, url, key) {
    const out = [];
    const pageSize = 1000;
    for (let offset = 0; offset < 500000; offset += pageSize) {
      try {
        const res = await fetch(
          `${url}/rest/v1/historical_odds?sport=eq.${sport}` +
          `&game_date=gte.${since}` +
          `&select=game_id,sport,home,away,game_date` +
          `&limit=${pageSize}&offset=${offset}`,
          { headers: { apikey: key, Authorization: `Bearer ${key}` } }
        );
        if (!res.ok) break;
        const rows = await res.json();
        rows.forEach(r => {
          out.push({
            espn_id: r.game_id,
            sport: r.sport,
            home_team: r.home,
            away_team: r.away,
            game_date: r.game_date,
            home_norm: normalizeFor(r.sport, r.home),
            away_norm: normalizeFor(r.sport, r.away),
          });
        });
        if (rows.length < pageSize) break;
      } catch (e) {
        logEdgeError('gameIdMap.loadEspnSide', e);
        break;
      }
    }
    return out;
  }

  async function loadOddsSide(sport, since, url, key) {
    const seen = new Map();
    const pageSize = 1000;
    let hasCommence = true;

    for (let offset = 0; offset < 500000; offset += pageSize) {
      const cols = hasCommence
        ? 'game_id,sport,home,away,created_at,commence_time'
        : 'game_id,sport,home,away,created_at';

      try {
        let res = await fetch(
          `${url}/rest/v1/line_history?sport=eq.${sport}` +
          `&created_at=gte.${since}` +
          `&select=${cols}` +
          `&limit=${pageSize}&offset=${offset}`,
          { headers: { apikey: key, Authorization: `Bearer ${key}` } }
        );

        if (!res.ok && hasCommence) {
          hasCommence = false;
          res = await fetch(
            `${url}/rest/v1/line_history?sport=eq.${sport}` +
            `&created_at=gte.${since}` +
            `&select=game_id,sport,home,away,created_at` +
            `&limit=${pageSize}&offset=${offset}`,
            { headers: { apikey: key, Authorization: `Bearer ${key}` } }
          );
        }
        if (!res.ok) break;

        const rows = await res.json();
        rows.forEach(r => {
          if (!r.game_id || seen.has(r.game_id)) return;
          seen.set(r.game_id, {
            odds_api_id: r.game_id,
            sport: r.sport,
            home_team: r.home,
            away_team: r.away,
            home_norm: normalizeFor(r.sport, r.home),
            away_norm: normalizeFor(r.sport, r.away),
            commence_time: r.commence_time || null,
            created_at: r.created_at,
          });
        });
        if (rows.length < pageSize) break;
      } catch (e) {
        logEdgeError('gameIdMap.loadOddsSide.lineHistory', e);
        break;
      }
    }

    for (let offset = 0; offset < 20000; offset += pageSize) {
      try {
        const res = await fetch(
          `${url}/rest/v1/shadow_picks?sport=eq.${sport}` +
          `&created_at=gte.${since}` +
          `&select=game_id,sport,home_team,away_team,commence_time,created_at` +
          `&limit=${pageSize}&offset=${offset}`,
          { headers: { apikey: key, Authorization: `Bearer ${key}` } }
        );
        if (!res.ok) break;
        const rows = await res.json();
        rows.forEach(r => {
          if (!r.game_id || seen.has(r.game_id)) return;
          seen.set(r.game_id, {
            odds_api_id: r.game_id,
            sport: r.sport,
            home_team: r.home_team,
            away_team: r.away_team,
            home_norm: normalizeFor(r.sport, r.home_team),
            away_norm: normalizeFor(r.sport, r.away_team),
            commence_time: r.commence_time || null,
            created_at: r.created_at,
          });
        });
        if (rows.length < pageSize) break;
      } catch (e) {
        logEdgeError('gameIdMap.loadOddsSide.shadowPicks', e);
        break;
      }
    }

    return Array.from(seen.values());
  }

  async function writeLinks(links, url, key) {
    if (!links.length) return 0;

    const chunkSize = 400;
    let written = 0;
    const headers = {
      apikey: key, Authorization: `Bearer ${key}`,
      'Content-Type': 'application/json',
      Prefer: 'resolution=merge-duplicates,return=minimal',
    };

    for (let i = 0; i < links.length; i += chunkSize) {
      const chunk = links.slice(i, i + chunkSize);
      try {
        const res = await fetch(`${url}/rest/v1/game_id_map?on_conflict=odds_api_id`, {
          method: 'POST', headers, body: JSON.stringify(chunk),
        });
        if (res.ok || res.status === 409) {
          written += chunk.length;
        } else {
          logEdgeError('gameIdMap.writeLinks.status', new Error('HTTP ' + res.status));
        }
      } catch (e) {
        logEdgeError('gameIdMap.writeLinks', e);
      }
    }

    return written;
  }

  function normalizeFor(sport, name) {
    if (!name) return '';
    if (window.EDGE_TEAMS && typeof window.EDGE_TEAMS.normalize === 'function') {
      try { return window.EDGE_TEAMS.normalize(name, sport); }
      catch {}
    }
    return String(name).toLowerCase().replace(/[^a-z0-9]/g, '');
  }

  async function stats() {
    const url = SUPABASE_URL(), key = SUPABASE_KEY();
    if (!url || !key) return null;

    try {
      const res = await fetch(`${url}/rest/v1/game_id_map?select=sport`, {
        headers: { apikey: key, Authorization: `Bearer ${key}`, Prefer: 'count=exact' },
      });
      if (!res.ok) return null;
      const rows = await res.json();
      const bySport = {};
      rows.forEach(r => { bySport[r.sport] = (bySport[r.sport] || 0) + 1; });
      return { total: rows.length, by_sport: bySport };
    } catch { return null; }
  }

  async function clear(options = {}) {
    const { sport = null } = options;
    const url = SUPABASE_URL(), key = SUPABASE_KEY();
    if (!url || !key) return { ok: false, error: 'Supabase not connected' };

    const filter = sport ? `?sport=eq.${encodeURIComponent(sport)}` : '?id=gt.0';
    try {
      const res = await fetch(`${url}/rest/v1/game_id_map${filter}`, {
        method: 'DELETE',
        headers: { apikey: key, Authorization: `Bearer ${key}` },
      });
      return { ok: res.ok, status: res.status };
    } catch (e) {
      return { ok: false, error: e.message };
    }
  }

  function schemaSql() {
    let email = '__OWNER_EMAIL__';
    try {
      const raw = localStorage.getItem('edge_auth_session');
      if (raw) {
        const s = JSON.parse(raw);
        if (s?.user?.email) email = s.user.email;
      }
    } catch {}
    return SCHEMA_SQL.replace(/__OWNER_EMAIL__/g, email);
  }

})();

if (typeof window !== 'undefined') window.EDGE_GAME_ID_MAP = EDGE_GAME_ID_MAP;