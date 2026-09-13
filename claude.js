// ============================================================
// EDGE — CLAUDE RISK MANAGER v2.0
// Batch-first. Prompt-cached. Opus.
// Physics runs first, always. Claude can only approve/veto/reduce.
// Fails safe: on any error, every pick auto-approves unchanged.
// ============================================================

const EDGE_CLAUDE = (() => {

  const DIRECT_API_URL = 'https://api.anthropic.com/v1/messages';
  // When an Edge Function proxy is configured the Anthropic key lives in
  // Supabase secrets and never reaches this browser.
  const PROXY_URL = () => (localStorage.getItem('edge_proxy_url') || '').trim().replace(/\/+$/, '');
  const API_URL = () => { const p = PROXY_URL(); return p ? p + '/messages' : DIRECT_API_URL; };
  const MODEL = 'claude-opus-4-20250514';
  const MAX_TOKENS = 2048;
  const TIMEOUT_MS = 25000;

  const MAX_REDUCTION = -0.15;
  const PROMPT_VERSION = '2.0.0';

  // ── SYSTEM PROMPT (cached across every call) ──
  const SYSTEM_PROMPT = `You are EDGE's risk officer. A deterministic quantitative model has already made betting decisions. Your job is NOT to predict games. Your job is to review a BATCH of model picks and, for each one, decide whether to approve, veto, or reduce.

For each pick you receive:
- The model's side, confidence, edge, units, consensus score, agreement index
- Full 9-family algorithm breakdown with each family's vote, confidence, and reason
- Market lines and context (sharp %, public %, line movement, weather, injuries, rest)

Rules you MUST follow:
1. You may only APPROVE, VETO, or REDUCE. Never increase size. Never flip sides.
2. VETO only when you can name a specific, concrete reason the model's signal is stale or compromised — not vague doubt.
3. REDUCE when the edge is real but there's meaningful uncertainty (injury news, sharp money opposing, weather degradation).
4. APPROVE when you see no specific reason to override.
5. Do NOT veto because "anything can happen." That is not a reason.
6. Do NOT veto based on your own game prediction. You are not a predictor.
7. If uncertain, APPROVE with 0 adjustment. Default to trusting the model.

Return ONLY valid JSON — an array of objects, one per pick, in the same order as input:
[
  { "pick_id": "<id from input>", "decision": "approve" | "veto" | "reduce", "confidence_adjustment": 0.0 to -0.15, "reason": "one concise sentence" }
]

No prose. No markdown. JSON array only.`;

  // ============================================================
  // ── BATCH ENTRY (preferred) ──
  // ============================================================

  async function reviewBatch(picks, context = {}) {
    const apiKey = localStorage.getItem('edge_claude_api_key');

    if (!apiKey && !PROXY_URL()) {
      return picks.map(p => ({
        pick_id: p.pick_id,
        ...fallbackReview('No Anthropic API key and no proxy configured'),
      }));
    }

    // Filter to actionable picks only — PASS/CAPPED are never sent to Claude
    const actionable = picks.filter(p =>
      p.physics && p.physics.decision !== 'PASS' && p.physics.decision !== 'CAPPED' && p.physics.units > 0
    );

    const passthrough = picks.filter(p => !actionable.includes(p));

    if (actionable.length === 0) {
      return passthrough.map(p => ({
        pick_id: p.pick_id,
        ...fallbackReview('No actionable picks in batch'),
      }));
    }

    const userPrompt = buildBatchPrompt(actionable, context);

    try {
      const raw = await callClaude(apiKey, userPrompt);
      const parsed = parseBatchResponse(raw, actionable);

      if (!parsed.valid) {
        return [
          ...actionable.map(p => ({ pick_id: p.pick_id, ...fallbackReview(`Parse error: ${parsed.error}`) })),
          ...passthrough.map(p => ({ pick_id: p.pick_id, ...fallbackReview('No actionable') })),
        ];
      }

      return [
        ...parsed.reviews,
        ...passthrough.map(p => ({ pick_id: p.pick_id, ...fallbackReview('No actionable') })),
      ];
    } catch (err) {
      return picks.map(p => ({
        pick_id: p.pick_id,
        ...fallbackReview(`Claude error: ${err.message}`),
      }));
    }
  }

  // ============================================================
  // ── SINGLE-PICK ENTRY (fallback / testing) ──
  // ============================================================

  async function review(physicsOutput, prior, context = {}) {
    const batch = await reviewBatch([{ pick_id: 'single', physics: physicsOutput, prior, context }], context);
    return batch[0] || fallbackReview('Empty batch result');
  }

  // ============================================================
  // ── PROMPT BUILDER ──
  // ============================================================

  function buildBatchPrompt(picks, context) {
    const blocks = picks.map((p, idx) => buildPickBlock(p, idx, context));

    return `BATCH REVIEW — ${picks.length} pick${picks.length === 1 ? '' : 's'}

${blocks.join('\n\n---\n\n')}

Return JSON array only.`;
  }

  function buildPickBlock(pick, idx, context) {
    const physics = pick.physics || {};
    const prior = pick.prior || {};
    const sideTeam = physics.side_label?.team || 'Unknown';
    const action = physics.direction === 'home' ? 'HOME' : physics.direction === 'away' ? 'AWAY' : 'NONE';

    const familyBreakdown = (physics.governor_snapshot?.breakdown || [])
      .map(f => `    ${f.family}: ${f.vote.toUpperCase()} @ ${(f.confidence * 100).toFixed(0)}% (w=${f.weight}) — ${f.reason}`)
      .join('\n');

    const marketLines = [
      `    Spread: ${physics.market_snapshot?.spread ?? 'N/A'}`,
      `    Total: ${physics.market_snapshot?.total ?? 'N/A'}`,
      `    Home ML: ${physics.market_snapshot?.home_ml ?? 'N/A'}`,
      `    Away ML: ${physics.market_snapshot?.away_ml ?? 'N/A'}`,
    ].join('\n');

    const marketCtx = [];
    const lh = pick.context?.lineHistory || context.lineHistory || {};
    if (lh.sharp_pct != null)   marketCtx.push(`    Sharp %: ${lh.sharp_pct}%`);
    if (lh.public_pct != null)  marketCtx.push(`    Public %: ${lh.public_pct}%`);
    if (lh.open_spread != null && physics.market_snapshot?.spread != null) {
      marketCtx.push(`    Open → Current: ${lh.open_spread} → ${physics.market_snapshot.spread}`);
    }

    const envCtx = [];
    const w = pick.context?.weather || {};
    if (w.wind_mph != null)   envCtx.push(`    Wind: ${w.wind_mph} mph`);
    if (w.temp_f != null)     envCtx.push(`    Temp: ${w.temp_f}°F`);
    if (w.precip_pct != null) envCtx.push(`    Precip: ${w.precip_pct}%`);

    const inj = pick.context?.injuries || {};
    if (inj.home?.length) envCtx.push(`    Home injuries: ${inj.home.map(i => `${i.name || i.position} (${i.status})`).join(', ')}`);
    if (inj.away?.length) envCtx.push(`    Away injuries: ${inj.away.map(i => `${i.name || i.position} (${i.status})`).join(', ')}`);

    return `PICK ${idx + 1} — id="${pick.pick_id}"
  Sport: ${prior.sport || 'Unknown'}
  Matchup: ${prior.away_team || 'Away'} @ ${prior.home_team || 'Home'}
  Commence: ${prior.commence_time || 'N/A'}

  MODEL PICK
    Side: ${action} (${sideTeam})
    Decision: ${physics.decision}
    Units: ${physics.units}
    Confidence: ${physics.confidence}%
    Edge: ${((physics.edge || 0) * 100).toFixed(2)}%
    Consensus Score: ${physics.governor_snapshot?.consensus_score ?? 'N/A'}
    Agreement Index: ${physics.governor_snapshot?.agreement_index ?? 'N/A'}
    Posterior Home Prob: ${physics.governor_snapshot?.posterior_home_prob ?? 'N/A'}

  FAMILY BREAKDOWN
${familyBreakdown || '    (none)'}

  MARKET LINES
${marketLines}

  MARKET CONTEXT
${marketCtx.length ? marketCtx.join('\n') : '    (none)'}

  ENVIRONMENTAL CONTEXT
${envCtx.length ? envCtx.join('\n') : '    (none)'}`;
  }

  // ============================================================
  // ── CLAUDE CALL WITH PROMPT CACHING ──
  // ============================================================

  async function callClaude(apiKey, userPrompt) {
    const controller = new AbortController();
    const timeout = setTimeout(() => controller.abort(), TIMEOUT_MS);
    const start = Date.now();

    const proxy = PROXY_URL();
    const headers = { 'Content-Type': 'application/json' };
    if (!proxy) {
      headers['x-api-key'] = apiKey;
      headers['anthropic-version'] = '2023-06-01';
      headers['anthropic-beta'] = 'prompt-caching-2024-07-31';
      headers['anthropic-dangerous-direct-browser-access'] = 'true';
    }

    try {
      const res = await fetch(API_URL(), {
        method: 'POST',
        signal: controller.signal,
        headers,
        body: JSON.stringify({
          model: MODEL,
          max_tokens: MAX_TOKENS,
          system: [
            {
              type: 'text',
              text: SYSTEM_PROMPT,
              cache_control: { type: 'ephemeral' },
            },
          ],
          messages: [{ role: 'user', content: userPrompt }],
        }),
      });

      clearTimeout(timeout);

      if (!res.ok) {
        const errText = await res.text().catch(() => '');
        throw new Error(`HTTP ${res.status}: ${errText.slice(0, 140)}`);
      }

      const data = await res.json();
      const text = data?.content?.[0]?.text || '';
      const usage = data?.usage || {};

      return {
        text,
        latency_ms: Date.now() - start,
        usage: {
          input_tokens: usage.input_tokens || 0,
          output_tokens: usage.output_tokens || 0,
          cache_creation_input_tokens: usage.cache_creation_input_tokens || 0,
          cache_read_input_tokens: usage.cache_read_input_tokens || 0,
        },
      };
    } catch (err) {
      clearTimeout(timeout);
      throw err;
    }
  }

  // ============================================================
  // ── BATCH RESPONSE PARSER ──
  // ============================================================

  function parseBatchResponse(raw, actionablePicks) {
    if (!raw || !raw.text) return { valid: false, error: 'Empty response' };

    let text = raw.text.trim();
    text = text.replace(/^```(?:json)?\s*/i, '').replace(/```\s*$/i, '').trim();

    const firstBracket = text.indexOf('[');
    const lastBracket = text.lastIndexOf(']');
    if (firstBracket === -1 || lastBracket === -1 || lastBracket <= firstBracket) {
      return { valid: false, error: 'No JSON array found' };
    }

    let parsed;
    try {
      parsed = JSON.parse(text.slice(firstBracket, lastBracket + 1));
    } catch (e) {
      return { valid: false, error: `JSON parse: ${e.message}` };
    }

    if (!Array.isArray(parsed)) {
      return { valid: false, error: 'Response is not an array' };
    }

    // Build lookup of expected pick_ids
    const expected = new Set(actionablePicks.map(p => p.pick_id));
    const reviews = [];
    const seen = new Set();

    for (const entry of parsed) {
      const pickId = String(entry.pick_id || '');
      if (!expected.has(pickId) || seen.has(pickId)) continue;

      const decision = String(entry.decision || '').toLowerCase();
      if (!['approve', 'veto', 'reduce'].includes(decision)) continue;

      let adjustment = Number(entry.confidence_adjustment);
      if (!isFinite(adjustment)) adjustment = 0;

      const review = enforceConstraints({
        decision,
        confidence_adjustment: adjustment,
        reason: String(entry.reason || '').slice(0, 300),
      });

      reviews.push({
        pick_id: pickId,
        available: true,
        ...review,
        model: MODEL,
        prompt_version: PROMPT_VERSION,
        latency_ms: raw.latency_ms,
        usage: raw.usage,
        fallback: false,
      });

      seen.add(pickId);
    }

    // Any picks Claude didn't return → fallback approve
    for (const pick of actionablePicks) {
      if (!seen.has(pick.pick_id)) {
        reviews.push({ pick_id: pick.pick_id, ...fallbackReview('Claude omitted pick') });
      }
    }

    return { valid: true, reviews };
  }

  // ============================================================
  // ── CONSTRAINT ENFORCEMENT ──
  // ============================================================

  function enforceConstraints(output) {
    const decision = output.decision;
    let adjustment = output.confidence_adjustment;

    if (decision === 'veto') {
      adjustment = 0;
    } else if (decision === 'approve') {
      adjustment = 0;
    } else if (decision === 'reduce') {
      adjustment = Math.max(Math.min(adjustment, 0), MAX_REDUCTION);
      if (adjustment === 0) adjustment = -0.05;
    }

    return {
      decision,
      confidence_adjustment: adjustment,
      reason: output.reason || '',
    };
  }

  // ============================================================
  // ── FALLBACK ──
  // ============================================================

  function fallbackReview(reason) {
    return {
      available: false,
      decision: 'approve',
      confidence_adjustment: 0,
      reason,
      model: MODEL,
      prompt_version: PROMPT_VERSION,
      fallback: true,
    };
  }

  // ============================================================
  // ── PUBLIC API ──

  return {
    reviewBatch,
    review,
    SYSTEM_PROMPT,
    PROMPT_VERSION,
    MODEL,
    fallbackReview,
  };

})();

if (typeof window !== 'undefined') window.EDGE_CLAUDE = EDGE_CLAUDE;