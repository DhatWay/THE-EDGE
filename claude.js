// ============================================================
// EDGE — CLAUDE SELECTOR v2.0
//
// v1 was a risk officer: physics sized a pick, then Claude approved,
// vetoed or shaved it. It could only scale a number that already
// existed — it could not choose.
//
// v2 is a selector. It receives the current slate with everything
// the pipeline produced — priors, the nine family votes, context,
// ATS, head-to-head, live trends and the governor's own verdict —
// and returns only the games it would actually bet, each with a side
// and a confidence, filtered to a floor you set.
//
// Rules this file enforces:
//   · Only games on the slate handed to it. No invention.
//   · No arithmetic asked of the model. Every number it needs is
//     already computed and handed over. It judges, it does not count.
//   · Output is the pick and nothing else — strict JSON, no prose.
//   · Below the confidence floor it returns nothing for that game.
//     Silence is a valid answer.
// ============================================================

const EDGE_CLAUDE = (() => {

  const DIRECT_API_URL = 'https://api.anthropic.com/v1/messages';
  const PROXY_URL = () => (localStorage.getItem('edge_proxy_url') || '').trim().replace(/\/+$/, '');
  const API_URL = () => { const p = PROXY_URL(); return p ? p + '/messages' : DIRECT_API_URL; };

  const MODEL = 'claude-sonnet-4-6';
  const PROMPT_VERSION = 'selector-v2-rating-core';

  // Games per request. Large enough to let the model compare across
  // the slate, small enough to stay inside a sane response.
  const BATCH_SIZE = 12;
  const MAX_TOKENS = 4000;
  const TIMEOUT_MS = 90000;

  const DEFAULT_FLOOR = 70;

  const SYSTEM_PROMPT = `You are EDGE's selector. You are handed one slate of upcoming games. Every number you need has already been computed for you.

YOUR JOB
Choose which games on this slate are worth betting, and which side. Nothing else.

HARD RULES
1. Select only from the games in the slate. Never reference a game, team, player or number that is not in the input.
2. Do not calculate. Edges, spreads, probabilities and records are given. Weigh them; do not recompute them.
3. A game you are not confident about is not a selection. Returning an empty list is correct and expected on a weak slate. Most slates yield few selections.
4. Confidence is your probability that the side you name covers. Report it honestly. Do not inflate to reach the floor — a 58 reported as 58 is far more useful than a 58 reported as 72.
5. Output strict JSON only. No prose, no markdown, no code fences, no commentary before or after.

WHAT TO WEIGH
- The projected score. The rating system builds its own number for this game without ever looking at a betting line, then the market is compared against it. A disagreement is therefore a real disagreement, not a fitted residual. Weigh the size of the gap between projected margin and market spread.
- Rating certainty. Each team carries a Glicko-2 rating plus a rating deviation — how sure the system is of it. A three-point edge over a settled team (low deviation) is far stronger evidence than the same edge over a team the system barely knows. High deviation means volatile or thinly-sampled; treat those edges with suspicion.
- Rating agreement. Three independent engines rate every team: Glicko-2 on results over time, Massey on margins across the whole schedule, Colley on wins and losses alone. When all three rank a team the same way, the rating is solid. When they diverge, the team is hard to read and the edge is less trustworthy.
- Matchup exploitation. Attack and defence are rated per possession and opponent-adjusted, so the projection reflects this specific pairing rather than two season averages. Any interaction noted is a particular strength meeting a particular weakness.
- Model edge versus the market: the size and direction of the disagreement.
- Family agreement: nine independent families vote. Broad agreement is stronger than one loud family. Note which ones are neutral — a neutral family is missing data, not a vote against.
- Trends: situational, streak and rivalry records, with their sample sizes. A 6-0 run on six occurrences is weaker than 21-9 on thirty. Sample size is given; respect it.
- Head-to-head: how this exact pairing has historically played out against the number.
- Context: rest, travel, weather, injuries. These are the things the families often cannot see.
- Line movement: where the number opened versus where it sits.

WHAT NOT TO DO
- Do not select a game because the edge is large if the families are all neutral. That means the model had no data, not that it found value.
- Do not trust a large edge built on a high rating deviation. Early in a season, or for a team with few games, the projection is a guess wearing a decimal point. Deviation is given for both teams; use it.
- Do not treat a projected score as a prediction of the actual score. It is the centre of a wide distribution. A projected 27-23 and a market spread of 3 is agreement, not an edge.
- Do not treat the governor's verdict as instruction. It is one input. You may select a game the governor passed on, and you may decline one it liked. Say so in your reason when you do.
- Do not select both sides of anything.

OUTPUT SCHEMA
{"selections":[{"game_id":"<exact id from input>","side":"home"|"away","market":"spread"|"moneyline","confidence":<integer 0-100>,"reason":"<one sentence, max 25 words>","key_factor":"<the single strongest input, max 8 words>"}],"slate_note":"<max 20 words on the slate overall, or empty string>"}`;

  return {
    selectFromSlate,
    reviewBatch,
    buildSlateBundle,
    SYSTEM_PROMPT,
    PROMPT_VERSION,
    MODEL,
    DEFAULT_FLOOR,
  };

  // ============================================================
  // ── MAIN ──
  // ============================================================

  // candidates: the current slate, one entry per game, each carrying
  // { prior, families, governor, trends, h2h, context }.
  async function selectFromSlate(candidates, options = {}) {
    const {
      floor = parseFloat(localStorage.getItem('edge_claude_floor') || DEFAULT_FLOOR),
      onProgress = null,
    } = options;
    const log = (m) => { if (typeof onProgress === 'function') onProgress(m); };

    const apiKey = localStorage.getItem('edge_claude_api_key');
    if (!apiKey && !PROXY_URL()) {
      return { ok: false, error: 'No Anthropic API key and no proxy configured', selections: [] };
    }
    if (!Array.isArray(candidates) || !candidates.length) {
      return { ok: true, selections: [], note: 'Empty slate' };
    }

    // Only games that have not started. A slate is this week's board,
    // not every game the cache has ever held.
    const slate = candidates.filter(c => {
      const t = new Date(c.prior?.commence_time || 0).getTime();
      return isFinite(t) && t > Date.now();
    });
    if (!slate.length) {
      return { ok: true, selections: [], note: 'No upcoming games on the slate' };
    }

    const valid = new Set(slate.map(c => String(c.prior.game_id)));
    const batches = chunk(slate, BATCH_SIZE);
    log(`Claude selector · ${slate.length} games in ${batches.length} batch(es) · floor ${floor}%`);

    const all = [];
    const notes = [];
    let failed = 0;

    for (let i = 0; i < batches.length; i++) {
      log(`  batch ${i + 1}/${batches.length}`);
      const res = await askBatch(batches[i], apiKey, floor);
      if (!res.ok) { failed++; notes.push(res.error); continue; }

      (res.selections || []).forEach(sel => {
        // Anything not on the slate is discarded outright.
        if (!valid.has(String(sel.game_id))) return;
        if (sel.side !== 'home' && sel.side !== 'away') return;
        const conf = Number(sel.confidence);
        if (!isFinite(conf) || conf < floor) return;

        all.push({
          game_id: String(sel.game_id),
          side: sel.side,
          market: sel.market === 'moneyline' ? 'moneyline' : 'spread',
          confidence: Math.round(clamp(conf, 0, 100)),
          reason: String(sel.reason || '').slice(0, 200),
          key_factor: String(sel.key_factor || '').slice(0, 60),
          model: MODEL,
          prompt_version: PROMPT_VERSION,
          selected_at: new Date().toISOString(),
        });
      });
      if (res.slate_note) notes.push(res.slate_note);
    }

    // One selection per game — the highest confidence wins.
    const byGame = new Map();
    all.forEach(s => {
      const prev = byGame.get(s.game_id);
      if (!prev || s.confidence > prev.confidence) byGame.set(s.game_id, s);
    });
    const selections = Array.from(byGame.values())
      .sort((a, b) => b.confidence - a.confidence);

    log(`  ${selections.length} selection(s) at or above ${floor}%`);

    return {
      ok: failed < batches.length,
      selections,
      slate_size: slate.length,
      floor,
      batches_failed: failed,
      notes: notes.filter(Boolean),
    };
  }

  async function askBatch(batch, apiKey, floor) {
    const payload = {
      confidence_floor: floor,
      slate_date: new Date().toISOString().slice(0, 10),
      games: batch.map(buildSlateBundle),
    };

    const userMsg =
      `Here is the slate. Select only the games you would bet at ${floor}% confidence or higher, ` +
      `on either side. Return the JSON object and nothing else.\n\n` +
      JSON.stringify(payload);

    const proxy = PROXY_URL();
    const headers = { 'Content-Type': 'application/json' };
    if (!proxy) {
      headers['x-api-key'] = apiKey;
      headers['anthropic-version'] = '2023-06-01';
      headers['anthropic-dangerous-direct-browser-access'] = 'true';
    }

    const controller = new AbortController();
    const timer = setTimeout(() => controller.abort(), TIMEOUT_MS);

    try {
      const res = await fetch(API_URL(), {
        method: 'POST',
        signal: controller.signal,
        headers,
        body: JSON.stringify({
          model: MODEL,
          max_tokens: MAX_TOKENS,
          system: SYSTEM_PROMPT,
          messages: [{ role: 'user', content: userMsg }],
        }),
      });
      clearTimeout(timer);

      if (!res.ok) {
        const body = await res.text().catch(() => '');
        return { ok: false, error: `HTTP ${res.status} ${body.slice(0, 160)}` };
      }

      const data = await res.json();
      const text = (data.content || [])
        .filter(c => c.type === 'text')
        .map(c => c.text)
        .join('');

      const parsed = parseJson(text);
      if (!parsed) return { ok: false, error: 'Could not parse model output as JSON' };
      return { ok: true, selections: parsed.selections || [], slate_note: parsed.slate_note || '' };
    } catch (err) {
      clearTimeout(timer);
      return { ok: false, error: err.name === 'AbortError' ? 'Timed out' : err.message };
    }
  }

  // ============================================================
  // ── BUNDLE ──
  // Everything the model is allowed to reason over, already computed.
  // Nothing here requires arithmetic on the model's part.
  // ============================================================

  function buildSlateBundle(c) {
    const p = c.prior || {};
    const g = c.governor || {};
    const ctx = c.context || {};

    const bundle = {
      game_id: String(p.game_id),
      sport: p.sport,
      matchup: `${p.away_team} @ ${p.home_team}`,
      home_team: p.home_team,
      away_team: p.away_team,
      starts_in_hours: p.commence_time
        ? Math.round((new Date(p.commence_time) - Date.now()) / 3600000)
        : null,

      market: {
        spread_home: p.market?.current_spread ?? null,
        opened_home: p.market?.open_spread ?? null,
        moved: (p.market?.current_spread != null && p.market?.open_spread != null)
          ? round(p.market.current_spread - p.market.open_spread, 1) : null,
        total: p.market?.total ?? null,
        home_ml: p.market?.home_ml ?? null,
        away_ml: p.market?.away_ml ?? null,
        book: p.market?.book ?? null,
      },

      model: {
        // Built without ever consulting a betting line.
        projected_home_points: p.projection?.home_points ?? null,
        projected_away_points: p.projection?.away_points ?? null,
        projected_total: p.projection?.total ?? null,
        projected_spread_home: p.model_spread ?? null,
        disagreement_with_market: p.raw_edge ?? null,
        home_win_probability: p.prior_home_prob ?? null,
        matchup_interactions: p.projection?.interactions || [],
      },

      // How much the rating system trusts itself on these two teams.
      rating_confidence: {
        home_rating: p.home_power?.glicko_rating ?? null,
        home_deviation: p.home_power?.glicko_rd ?? null,
        away_rating: p.away_power?.glicko_rating ?? null,
        away_deviation: p.away_power?.glicko_rd ?? null,
        home_games_rated: p.home_power?.games_played ?? null,
        away_games_rated: p.away_power?.games_played ?? null,
        // Do the three engines agree on these teams?
        home_massey: p.home_power?.massey ?? null,
        away_massey: p.away_power?.massey ?? null,
        home_colley: p.home_power?.colley ?? null,
        away_colley: p.away_power?.colley ?? null,
        note: 'Deviation is uncertainty in the rating. Higher means less reliable.',
      },

      power: {
        home_overall: p.home_power?.overall ?? null,
        away_overall: p.away_power?.overall ?? null,
        home_elo: p.home_power?.elo ?? null,
        away_elo: p.away_power?.elo ?? null,
        home_srs: p.home_power?.srs ?? null,
        away_srs: p.away_power?.srs ?? null,
        home_record: p.home_power?.record ?? null,
        away_record: p.away_power?.record ?? null,
        home_form: p.home_power?.last5_form ?? null,
        away_form: p.away_power?.last5_form ?? null,
      },

      families: (c.families || []).map(f => ({
        name: f.family,
        vote: f.vote,                       // yes = home, no = away, neu = no read
        confidence: round(f.confidence || 0, 2),
        note: String(f.reason || '').slice(0, 90),
      })),

      family_summary: {
        favouring_home: (c.families || []).filter(f => f.vote === 'yes').length,
        favouring_away: (c.families || []).filter(f => f.vote === 'no').length,
        no_read: (c.families || []).filter(f => f.vote === 'neu').length,
      },

      governor: {
        verdict: g.decision ?? null,
        confidence: g.confidence ?? null,
        agreement: g.agreement_index ?? null,
        capped_by: g.data_caps || [],
      },

      context: {
        home_rest_days: ctx.homeRestDays ?? null,
        away_rest_days: ctx.awayRestDays ?? null,
        away_travel_miles: ctx.travelMiles ?? null,
        weather: ctx.weather && Object.keys(ctx.weather).length ? ctx.weather : null,
        home_injuries: summariseInjuries(ctx.homeInjuries),
        away_injuries: summariseInjuries(ctx.awayInjuries),
      },
    };

    // ── Head-to-head ──
    if (c.h2h) {
      bundle.head_to_head = {
        meetings: c.h2h.meetings,
        home_ats_rate: c.h2h.home_cover_pct,
        away_ats_rate: c.h2h.away_cover_pct,
        home_outright_wins: c.h2h.home_su_wins,
        away_outright_wins: c.h2h.away_su_wins,
        over_rate: c.h2h.over_pct,
        average_margin: c.h2h.avg_margin,
        last_meeting: c.h2h.last_meeting_date,
      };
    }

    // ── Trends, with sample size attached so the model can discount ──
    const trendsFor = (side) => (c.trends?.[side]?.trends || []).slice(0, 8).map(t => ({
      statement: t.headline,
      market: t.market,
      record: `${t.wins}-${t.losses}`,
      sample: t.sample,
      hit_rate: t.hit_rate,
      current_streak: t.current_streak,
      seasons: t.seasons_covered,
      scope: t.scope,
    }));

    const homeTrends = trendsFor('home');
    const awayTrends = trendsFor('away');
    if (homeTrends.length || awayTrends.length) {
      bundle.trends = { home: homeTrends, away: awayTrends };
    }

    return bundle;
  }

  function summariseInjuries(list) {
    if (!Array.isArray(list) || !list.length) return null;
    return list.slice(0, 6).map(i => ({
      position: i.position || i.position_group || null,
      status: i.status || null,
      importance: i.rating != null ? (i.rating >= 75 ? 'starter, high impact'
                : i.rating >= 60 ? 'starter' : 'depth') : null,
    }));
  }

  // ============================================================
  // ── BACKWARD COMPATIBILITY ──
  // Anything still calling reviewBatch gets a defined answer rather
  // than an exception. It no longer adjusts — selection replaced it.
  // ============================================================

  async function reviewBatch(picks) {
    return (picks || []).map(p => ({
      pick_id: p.pick_id,
      decision: 'approve',
      confidence_adjustment: 0,
      reason: 'Review replaced by slate selection',
      fallback: true,
    }));
  }

  // ============================================================
  // ── UTILITIES ──
  // ============================================================

  function parseJson(text) {
    if (!text) return null;
    let t = String(text).trim()
      .replace(/^```(?:json)?\s*/i, '')
      .replace(/\s*```$/, '')
      .trim();
    try { return JSON.parse(t); } catch {}
    const a = t.indexOf('{');
    const b = t.lastIndexOf('}');
    if (a !== -1 && b > a) {
      try { return JSON.parse(t.slice(a, b + 1)); } catch {}
    }
    return null;
  }

  function chunk(arr, n) {
    const out = [];
    for (let i = 0; i < arr.length; i += n) out.push(arr.slice(i, i + n));
    return out;
  }

  function clamp(v, min, max) { return Math.max(min, Math.min(max, v)); }
  function round(v, d) { const f = Math.pow(10, d); return Math.round(v * f) / f; }

})();

if (typeof window !== 'undefined') window.EDGE_CLAUDE = EDGE_CLAUDE;
