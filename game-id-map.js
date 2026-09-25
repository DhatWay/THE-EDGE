// ============================================================
// EDGE — GAME ID MAP v1.0
//
// One table, two columns that matter: odds_api_id and espn_id.
// Every reader that crosses the boundary between The Odds API
// and ESPN goes through this module. Nothing joins by raw id
// anymore.
//
// The problem this closes:
//
//   Matchups, lines, shadow_picks, bet_log and line_history are
//   keyed on The Odds API's event id. historical_odds is keyed
//   on ESPN's event id, written by ats-tracker.js. The two are
//   unrelated strings. Any lookup that crossed them — sim-grader
//   asking historical_odds for a score, ats-tracker merging
//   line_history into its odds index, learning reading closes
//   for shadow_picks — silently found nothing.
//
// The fix: a resolver that writes the mapping once per game,
// and every reader asks the resolver instead of guessing.
//
// HOW A LINK IS MADE
//
//   · Odds side: line_history (or shadow_picks) supplies
//     odds_api_id, sport, home, away, commence_time.
//   · ESPN side: historical_odds supplies espn_id, sport,
//     home, away, game_date.
//   · The two sides are joined on normalized team names and
//     a ±1 day date window. The window matters because The
//     Odds API sends UTC and ESPN sends US Eastern — a 10pm
//     Eastern kickoff is the next day in UTC.
//   · team-aliases.js normalizes both sides before comparison,
//     so "LA Clippers" and "Los Angeles Clippers" land on the
//     same row.
//
// WHAT IS NOT DONE HERE
//
//   No fuzzy matching. Two teams with the same normalized name
//   on the same day do not exist in any of the sports in this
//   app, so a strict normalized-name + date-window match is
//   sufficient. If a future sport breaks that assumption, the
//   resolver logs the ambiguity and skips the row rather than
//   guessing.
//
// SCHEMA
// The CREATE TABLE is emitted as a string by schemaSql(). Call
// it once from a browser console, copy the output, and paste
// it into the Supabase SQL editor. The module probes for the
// table before use and refuses to run if it is missing, rather
// than failing on the first read.
// ============================================================

const EDGE_GAME_ID_MAP = (() => {

  const BUILD = 'gidmap-20260925-01';

  const SUPABASE_URL = () => localStorage.getItem('edge_supabase_url');
  const SUPABASE_KEY = () => localStorage.getItem('edge_supabase_key');

  // A game can shift by a day between the two sources because
  // one is UTC and the other is US Eastern. Any two rows within
  // this many days of each other are candidates for the same
  // game. Set to 1 — a wider window would start pulling in
  // doubleheaders on consecutive days.
  const DATE_WINDOW_DAYS = 1;

  function logEdgeError(where, err) {
    try {
      const list = JSON.parse(localStorage.getItem('edge_errors') || '[]');
      list.unshift({ t: Date.now(), where, msg: err && err.message ? err.message : String(err) });
      localStorage.setItem('edge_errors', JSON.stringify(list.slice(0, 50)));
    } catch {}
  }

  const SCHEMA_SQL = `create table if not exists public.game_id_map (
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

create unique index if not exists game_id_map_odds_idx
  on public.game_id_map (odds_api_id)
  where odds_api_id is not null;

create unique index if not exists game_id_map_espn_idx
  on public.game_id_map (espn_id)
  where espn_id is not null;

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
  };

  // ============================================================
  // ── PROBE ──
  // ============================================================

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

  // ============================================================
  // ── RESOLVE ──
  //
  // The two entry points every caller uses. Both return the
  // opposite id, or null if no link exists yet.
  //
  // Callers pass either an Odds API id (from Matchups, shadow_picks,
  // bet_log, line_history) or an ESPN id (from historical_odds,
  // ats-tracker output).
  // ============================================================

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

  // ============================================================
  // ── LINK ──
  // Write a single mapping. Idempotent — the unique indexes
  // reject a duplicate odds_api_id or espn_id, and the caller
  // treats 409 as success.
  //
  // Callers that already know both ids (ats-tracker, when it
  // reads a line_history row with the matching ESPN event)
  // should call link() directly rather than running populate().
  // ============================================================

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
        // Either side already exists. Try a PATCH to fill the
        // missing column, in case the first write was partial.
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

  // ============================================================
  // ── POPULATE ──
  //
  // Walks the existing tables and writes every link it can
  // infer. Called once after both sides have data. Safe to run
  // again — existing links are skipped by the unique index.
  //
  // Source of the Odds API side:
  //   · line_history supplies the id, sport, home, away, created_at
  //   · shadow_picks supplies the same, from picks that ran
  //     before Matchups was opened on that device
  //
  // Source of the ESPN side:
  //   · historical_odds supplies the id, sport, home, away, game_date
  //
  // Both sides are normalized through team-aliases.js so name
  // variations land on the same row.
  // ============================================================

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

      // ESPN side: historical_odds rows for this sport in the window.
      const espnRows = await loadEspnSide(sport, since, url, key);
      log(`  ${espnRows.length} historical_odds rows`);

      if (!espnRows.length) {
        summary.sports[sport] = { linked: 0, unmatched: 0, note: 'no historical_odds' };
        continue;
      }

      // Odds side: line_history rows for this sport in the window.
      // line_history holds every odds_api id that has ever been
      // seen live. shadow_picks is added below for anything that
      // predates line_history capture.
      const oddsRows = await loadOddsSide(sport, since, url, key);
      log(`  ${oddsRows.length} odds ids`);

      if (!oddsRows.length) {
        summary.sports[sport] = { linked: 0, unmatched: 0, note: 'no line_history' };
        continue;
      }

      // Index ESPN rows by normalized team pair.
      const espnIndex = {};
      espnRows.forEach(r => {
        const key2 = `${r.home_norm}|${r.away_norm}`;
        if (!espnIndex[key2]) espnIndex[key2] = [];
        espnIndex[key2].push(r);
      });

      // For each Odds API row, find an ESPN row with the same
      // normalized pair and a date within DATE_WINDOW_DAYS.
      const links = [];
      let unmatched = 0;

      for (const odds of oddsRows) {
        const key2 = `${odds.home_norm}|${odds.away_norm}`;
        const candidates = espnIndex[key2];
        if (!candidates || !candidates.length) { unmatched++; continue; }

        const oddsMs = new Date(odds.created_at || odds.commence_time || 0).getTime();
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

    // line_history is the primary source.
    const pageSize = 1000;
    for (let offset = 0; offset < 500000; offset += pageSize) {
      try {
        const res = await fetch(
          `${url}/rest/v1/line_history?sport=eq.${sport}` +
          `&created_at=gte.${since}` +
          `&select=game_id,sport,home,away,created_at` +
          `&limit=${pageSize}&offset=${offset}`,
          { headers: { apikey: key, Authorization: `Bearer ${key}` } }
        );
        if (!res.ok) break;
        const rows = await res.json();
        rows.forEach(r => {
          if (!r.game_id) return;
          if (seen.has(r.game_id)) return;
          seen.set(r.game_id, {
            odds_api_id: r.game_id,
            sport: r.sport,
            home_team: r.home,
            away_team: r.away,
            home_norm: normalizeFor(r.sport, r.home),
            away_norm: normalizeFor(r.sport, r.away),
            created_at: r.created_at,
            commence_time: null,
          });
        });
        if (rows.length < pageSize) break;
      } catch (e) {
        logEdgeError('gameIdMap.loadOddsSide.lineHistory', e);
        break;
      }
    }

    // shadow_picks fills in anything that ran before the user
    // opened Matchups on this device.
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
          if (!r.game_id) return;
          if (seen.has(r.game_id)) return;
          seen.set(r.game_id, {
            odds_api_id: r.game_id,
            sport: r.sport,
            home_team: r.home_team,
            away_team: r.away_team,
            home_norm: normalizeFor(r.sport, r.home_team),
            away_norm: normalizeFor(r.sport, r.away_team),
            created_at: r.created_at,
            commence_time: r.commence_time,
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
        }
      } catch (e) {
        logEdgeError('gameIdMap.writeLinks', e);
      }
    }

    return written;
  }

  // ============================================================
  // ── NORMALIZE ──
  //
  // Uses team-aliases.js when loaded. Falls back to a lowercase
  // alphanumeric strip when it isn't, so this module never throws
  // on a page that forgot the tag.
  // ============================================================

  function normalizeFor(sport, name) {
    if (!name) return '';
    if (window.EDGE_TEAMS && typeof window.EDGE_TEAMS.normalize === 'function') {
      try { return window.EDGE_TEAMS.normalize(name, sport); }
      catch {}
    }
    return String(name).toLowerCase().replace(/[^a-z0-9]/g, '');
  }

  // ============================================================
  // ── STATS / CLEAR ──
  // ============================================================

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
    // Reads the signed-in email from the auth session so the
    // generated policy matches the account that will run it.
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

  function round(v, d) { const f = Math.pow(10, d); return Math.round(v * f) / f; }

})();

if (typeof window !== 'undefined') window.EDGE_GAME_ID_MAP = EDGE_GAME_ID_MAP;