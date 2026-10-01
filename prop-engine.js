// ============================================================
// EDGE — PROP ENGINE v1.0
//
// A prop runs the same path as a spread pick:
//
//   1. The ranking — a projection of the player's stat from his own
//      box scores (recent form and season), adjusted for the
//      opponent's defense rating from power_ratings.
//   2. A chance of going over the line entered.
//   3. A few adjustment families (form, hit rate, history against
//      this opponent, the matchup) that can move that chance by a
//      few points at most.
//   4. The governor's thresholds (EDGE_GOVERNOR.runProp).
//   5. Claude, when the decision mode brings it in.
//   6. Saved to prop_picks, graded from the next box score by
//      shadow-grader.js.
//
// No new data and no Odds API credits: the line is typed in, and
// everything else is already in player_game_stats, players and
// power_ratings.
// ============================================================

const EDGE_PROPS = (() => {
  const BUILD = 'props-engine-20261001-01';

  const SUPABASE_URL = () => localStorage.getItem('edge_supabase_url');
  const SUPABASE_KEY = () => localStorage.getItem('edge_supabase_key');

  // Games read for a player's projection.
  const LOG_GAMES = 40;

  // A stat line needs this many games before it is projected at all.
  const MIN_GAMES = 3;

  // Opponent defense can move a scoring projection by at most this
  // share either way.
  const OPP_FACTOR_LIMIT = 0.15;

  // Stats a prop can be entered for. `cols` are player_game_stats
  // columns, summed for combined props. `dist` is how the outcome is
  // modeled: 'count' — small whole numbers (touchdowns, hits, goals),
  // Poisson; 'normal' — yards, points and larger totals. `scoring`
  // marks stats the opponent's defense rating applies to.
  const FOOTBALL = [
    { key: 'passing_yards',    label: 'Passing yards',     cols: ['passing_yards'],                     dist: 'normal', scoring: true },
    { key: 'passing_tds',      label: 'Passing TDs',       cols: ['passing_tds'],                       dist: 'count',  scoring: true },
    { key: 'rushing_yards',    label: 'Rushing yards',     cols: ['rushing_yards'],                     dist: 'normal', scoring: true },
    { key: 'rushing_tds',      label: 'Rushing TDs',       cols: ['rushing_tds'],                       dist: 'count',  scoring: true },
    { key: 'receptions',       label: 'Receptions',        cols: ['receptions'],                        dist: 'count',  scoring: false },
    { key: 'receiving_yards',  label: 'Receiving yards',   cols: ['receiving_yards'],                   dist: 'normal', scoring: true },
    { key: 'receiving_tds',    label: 'Receiving TDs',     cols: ['receiving_tds'],                     dist: 'count',  scoring: true },
    { key: 'rush_rec_yards',   label: 'Rush + rec yards',  cols: ['rushing_yards', 'receiving_yards'],  dist: 'normal', scoring: true },
    { key: 'pass_attempts',    label: 'Pass attempts',     cols: ['pass_attempts'],                     dist: 'normal', scoring: false },
    { key: 'pass_completions', label: 'Completions',       cols: ['pass_completions'],                  dist: 'normal', scoring: false },
    { key: 'interceptions',    label: 'Interceptions thrown', cols: ['interceptions'],                  dist: 'count',  scoring: false },
    { key: 'rush_attempts',    label: 'Rush attempts',     cols: ['rush_attempts'],                     dist: 'normal', scoring: false },
    { key: 'targets',          label: 'Targets',           cols: ['targets'],                           dist: 'count',  scoring: false },
  ];
  const BASKETBALL = [
    { key: 'points',           label: 'Points',            cols: ['points'],                            dist: 'normal', scoring: true },
    { key: 'rebounds',         label: 'Rebounds',          cols: ['rebounds'],                          dist: 'normal', scoring: false },
    { key: 'assists',          label: 'Assists',           cols: ['assists'],                           dist: 'normal', scoring: false },
    { key: 'three_made',       label: 'Threes made',       cols: ['three_made'],                        dist: 'count',  scoring: true },
    { key: 'pts_reb_ast',      label: 'Pts + reb + ast',   cols: ['points', 'rebounds', 'assists'],     dist: 'normal', scoring: true },
    { key: 'pts_reb',          label: 'Pts + reb',         cols: ['points', 'rebounds'],                dist: 'normal', scoring: true },
    { key: 'pts_ast',          label: 'Pts + ast',         cols: ['points', 'assists'],                 dist: 'normal', scoring: true },
    { key: 'reb_ast',          label: 'Reb + ast',         cols: ['rebounds', 'assists'],               dist: 'normal', scoring: false },
    { key: 'steals',           label: 'Steals',            cols: ['steals'],                            dist: 'count',  scoring: false },
    { key: 'blocks',           label: 'Blocks',            cols: ['blocks'],                            dist: 'count',  scoring: false },
    { key: 'stocks',           label: 'Steals + blocks',   cols: ['steals', 'blocks'],                  dist: 'count',  scoring: false },
    { key: 'turnovers',        label: 'Turnovers',         cols: ['turnovers'],                         dist: 'count',  scoring: false },
  ];
  const STATS = {
    NFL: FOOTBALL,
    NCAAF: FOOTBALL,
    NBA: BASKETBALL,
    WNBA: BASKETBALL,
    NCAAB: BASKETBALL,
    MLB: [
      { key: 'hits',                label: 'Hits',                cols: ['hits'],                dist: 'count', scoring: true },
      { key: 'home_runs',           label: 'Home runs',           cols: ['home_runs'],           dist: 'count', scoring: true },
      { key: 'rbis',                label: 'RBIs',                cols: ['rbis'],                dist: 'count', scoring: true },
      { key: 'runs',                label: 'Runs',                cols: ['runs'],                dist: 'count', scoring: true },
      { key: 'strikeouts',          label: 'Batter strikeouts',   cols: ['strikeouts'],          dist: 'count', scoring: false },
      { key: 'pitching_strikeouts', label: 'Pitcher strikeouts',  cols: ['pitching_strikeouts'], dist: 'count', scoring: false },
      { key: 'earned_runs',         label: 'Earned runs allowed', cols: ['earned_runs'],         dist: 'count', scoring: false },
      { key: 'walks',               label: 'Batter walks',        cols: ['walks'],               dist: 'count', scoring: false },
      { key: 'hits_allowed',        label: 'Hits allowed',        cols: ['hits_allowed'],        dist: 'count', scoring: false },
      { key: 'walks_allowed',       label: 'Walks allowed',       cols: ['walks_allowed'],       dist: 'count', scoring: false },
    ],
    NHL: [
      { key: 'goals',   label: 'Goals',   cols: ['goals'],            dist: 'count',  scoring: true },
      { key: 'assists', label: 'Assists', cols: ['assists'],          dist: 'count',  scoring: true },
      { key: 'points',  label: 'Points',  cols: ['goals', 'assists'], dist: 'count',  scoring: true },
      { key: 'saves',   label: 'Saves',   cols: ['saves'],            dist: 'normal', scoring: false },
      { key: 'shots',   label: 'Shots on goal', cols: ['shots'],        dist: 'count',  scoring: true },
    ],
    MLS: [],
  };

  return {
    BUILD,
    STATS,
    statsFor,
    loadRoster,
    evaluate,
    save,
    listForGame,
    probabilities,
  };

  // ============================================================
  // ── CATALOG ──
  // ============================================================

  function statsFor(sport) {
    return STATS[sport] || [];
  }

  function findStat(sport, key) {
    return statsFor(sport).find(s => s.key === key) || null;
  }

  // ============================================================
  // ── ROSTER ──
  // Players for the two teams of a board game. The board uses The
  // Odds API's team names and the players table ESPN's, so each
  // name is resolved against power_ratings first.
  // ============================================================

  async function loadRoster(game) {
    const sport = game._sport || game.sport;
    const url = SUPABASE_URL(), key = SUPABASE_KEY();
    if (!url || !key) throw new Error('Supabase not connected');

    const names = await resolveEspnNames(sport, [game.home_team, game.away_team]);
    const espnHome = names.get(game.home_team) || game.home_team;
    const espnAway = names.get(game.away_team) || game.away_team;
    const inList = [espnHome, espnAway].map(n => `"${String(n).replace(/"/g, '\\"')}"`).join(',');

    const rows = await getJson(
      `${url}/rest/v1/players?sport=eq.${sport}&team_name=in.(${encodeURIComponent(inList)})` +
      `&select=player_id,name,team_name,position,position_group,is_starter&order=is_starter.desc,name.asc&limit=1000`,
      key);

    return {
      home: rows.filter(r => r.team_name === espnHome),
      away: rows.filter(r => r.team_name === espnAway),
      espnHome,
      espnAway,
    };
  }

  // ============================================================
  // ── EVALUATE ──
  //
  // input: { game, player: {player_id, name, team_name, position_group},
  //          stat, line, side: 'over'|'under', price (optional, American) }
  // ============================================================

  async function evaluate(input) {
    const { game, player, line } = input;
    const sport = game._sport || game.sport;
    const stat = findStat(sport, input.stat);
    if (!stat) throw new Error(`No ${sport} prop for ${input.stat}`);
    if (!player?.player_id) throw new Error('Pick a player');
    if (!isFinite(Number(line))) throw new Error('Enter a line');

    const url = SUPABASE_URL(), key = SUPABASE_KEY();
    if (!url || !key) throw new Error('Supabase not connected');

    const side = input.side === 'under' ? 'under' : 'over';
    const price = isFinite(Number(input.price)) && Number(input.price) !== 0 ? Number(input.price) : null;

    // ── Opponent ──
    const names = await resolveEspnNames(sport, [game.home_team, game.away_team]);
    const espnHome = names.get(game.home_team) || game.home_team;
    const espnAway = names.get(game.away_team) || game.away_team;
    const playerIsHome = sameTeam(sport, player.team_name, espnHome);
    const opponent = playerIsHome ? espnAway : espnHome;

    // ── Player log ──
    const log = await loadPlayerLog(sport, player.player_id, stat, url, key);
    const seasonStart = window.EDGE_POWER?.seasonStart ? window.EDGE_POWER.seasonStart(sport, new Date()) : null;
    const season = seasonStart ? log.filter(r => new Date(r.game_date) >= seasonStart) : [];

    const values = log.map(r => r.value);
    const last5 = values.slice(0, 5);
    const last10 = values.slice(0, 10);
    const seasonVals = season.map(r => r.value);

    if (values.length < MIN_GAMES) {
      return finish(input, {
        sport, stat, side, price, opponent, playerIsHome,
        projection: null, sigma: null, prob: null,
        detail: { games: values.length, note: `Only ${values.length} games with ${stat.label.toLowerCase()} on file` },
        families: [],
      });
    }

    // ── The ranking: projection ──
    // Recent form weighs most, the season anchors it. When this season
    // has fewer than three games, the last ten (reaching into last
    // season) stand in for it.
    const parts = [
      [mean(last5), 0.45],
      [mean(last10), 0.30],
      [seasonVals.length >= 3 ? mean(seasonVals) : mean(last10), 0.25],
    ].filter(([v]) => v != null);
    const wSum = parts.reduce((s, [, w]) => s + w, 0);
    const base = parts.reduce((s, [v, w]) => s + v * w, 0) / wSum;

    // Opponent defense, from the ranking system: defense_index 100 is
    // league average, higher is a better defense. Scoring stats scale
    // by 100 / defense_index, limited to ±15%.
    const oppRow = await loadPowerRow(sport, opponent, url, key);
    let oppFactor = 1;
    if (stat.scoring && oppRow && isFinite(oppRow.defense_index) && oppRow.defense_index > 0) {
      oppFactor = clamp(100 / oppRow.defense_index, 1 - OPP_FACTOR_LIMIT, 1 + OPP_FACTOR_LIMIT);
    }
    const projection = base * oppFactor;

    // Spread of outcomes: the player's own game-to-game variation,
    // never below a fifth of the projection (or 1).
    const recentSd = sd(values.slice(0, 15));
    const sigma = Math.max(recentSd || 0, projection * 0.2, 1);

    const prob = probabilities(stat.dist, projection, sigma, Number(line));

    // ── Adjustment families ──
    const lineNum = Number(line);
    const families = [];

    const seasonAvg = seasonVals.length >= 3 ? mean(seasonVals) : mean(last10);
    families.push(signalFamily('form', (mean(last5) - seasonAvg) / sigma,
      Math.min(0.5 + last5.length * 0.05, 0.75),
      `Last ${last5.length}: ${fmt(mean(last5))} vs ${fmt(seasonAvg)} average`));

    const overCount = last10.filter(v => v > lineNum).length;
    const underCount = last10.filter(v => v < lineNum).length;
    const decided = overCount + underCount;
    families.push(decided
      ? signalFamily('hit_rate', ((overCount / decided) - 0.5) * 2,
          Math.min(0.45 + decided * 0.03, 0.75),
          `Over ${lineNum} in ${overCount} of last ${decided}`)
      : neutralFamily('hit_rate', 'No decided games in the last 10'));

    const vsOpp = log.filter(r => sameTeam(sport, r.opponent, opponent)).map(r => r.value);
    families.push(vsOpp.length >= 2
      ? signalFamily('vs_opponent', (mean(vsOpp) - lineNum) / sigma,
          Math.min(0.45 + vsOpp.length * 0.05, 0.7),
          `${fmt(mean(vsOpp))} average in ${vsOpp.length} games against ${opponent}`)
      : neutralFamily('vs_opponent', vsOpp.length ? 'One game against this opponent' : 'No games against this opponent'));

    families.push(stat.scoring && oppFactor !== 1
      ? signalFamily('matchup', (oppFactor - 1) / OPP_FACTOR_LIMIT, 0.6,
          `${opponent} defense index ${fmt(oppRow.defense_index)} (100 is average)`)
      : neutralFamily('matchup', stat.scoring ? 'Opponent defense rating unavailable' : 'Not a scoring stat'));

    return finish(input, {
      sport, stat, side, price, opponent, playerIsHome,
      projection, sigma, prob, families,
      detail: {
        games: values.length,
        season_games: seasonVals.length,
        last5: round(mean(last5), 2),
        last10: round(mean(last10), 2),
        season_avg: seasonVals.length ? round(mean(seasonVals), 2) : null,
        base: round(base, 2),
        opp_factor: round(oppFactor, 3),
        opp_defense_index: oppRow?.defense_index ?? null,
        sigma: round(sigma, 2),
        vs_opponent_games: vsOpp.length,
        dist: stat.dist,
        cols: stat.cols,
      },
    });
  }

  // Governor, then Claude, then the result object the page shows and
  // save() stores.
  async function finish(input, r) {
    const { game, player, line } = input;
    const lineNum = Number(line);
    const probOver = r.prob ? r.prob.over_excl_push : null;

    const governor = (window.EDGE_GOVERNOR && typeof window.EDGE_GOVERNOR.runProp === 'function' && probOver != null)
      ? window.EDGE_GOVERNOR.runProp(r.families, {
          sport: r.sport, prob_over: probOver, games: r.detail.games,
          line: lineNum, price: r.price, side: r.side,
        })
      : { decision: 'PASS', direction: 'none', units: 0, confidence: 0, edge: 0, data_caps: [r.detail.note || 'No projection'] };

    const claude = await claudeStep(governor, {
      sport: r.sport, player: player.name, team: player.team_name, opponent: r.opponent,
      stat: r.stat.label, line: lineNum, side_entered: r.side, price: r.price,
      projection: r.projection != null ? round(r.projection, 2) : null,
      sigma: r.sigma != null ? round(r.sigma, 2) : null,
      chance_over: probOver != null ? round(probOver * 100, 1) : null,
      detail: r.detail,
      families: (r.families || []).map(f => ({ family: f.family, vote: f.vote, reason: f.reason })),
      governor: { decision: governor.decision, side: governor.direction, confidence: governor.confidence },
    });

    const final = claude.final || governor;

    return {
      game_id: game.id,
      sport: r.sport,
      commence_time: game.commence_time || game.time || null,
      home_team: game.home_team,
      away_team: game.away_team,
      player_id: String(player.player_id),
      player_name: player.name,
      team_name: player.team_name,
      opponent: r.opponent,
      position_group: player.position_group || null,
      stat: r.stat.key,
      stat_label: r.stat.label,
      line: lineNum,
      side: r.side,
      price: r.price,
      projection: r.projection != null ? round(r.projection, 2) : null,
      prob_over: probOver != null ? round(probOver, 4) : null,
      pick_side: final.direction === 'none' ? null : final.direction,
      decision: final.decision,
      units: final.units || 0,
      confidence: final.confidence || 0,
      edge: governor.edge || 0,
      claude_decision: claude.verdict,
      detail: {
        ...r.detail,
        families: r.families,
        governor: {
          decision: governor.decision, direction: governor.direction, confidence: governor.confidence,
          model_over_prob: governor.model_over_prob ?? null, posterior_over_prob: governor.posterior_over_prob ?? null,
          data_caps: governor.data_caps || [],
        },
        claude: claude.detail,
        path: claude.path,
      },
    };
  }

  // Claude comes in the way it does for games (Settings decision
  // mode): math only — the governor decides; AI assisted — Claude
  // must agree with the governor's side or the pick passes; AI lead —
  // Claude decides. Without a key or proxy it is skipped.
  async function claudeStep(governor, bundle) {
    const mode = (window.EDGE_ORCHESTRATOR?.getMode?.()) || localStorage.getItem('edge_decision_mode') || 'math_only';
    if (mode === 'math_only' || !window.EDGE_CLAUDE || typeof window.EDGE_CLAUDE.reviewProp !== 'function') {
      return { final: null, verdict: null, detail: null, path: 'governor' };
    }

    const review = await window.EDGE_CLAUDE.reviewProp(bundle);
    if (!review.ok) {
      return { final: null, verdict: null, detail: { error: review.error }, path: 'governor (Claude unavailable)' };
    }

    const verdict = review.decision;
    const tiers = window.EDGE_GOVERNOR?.THRESHOLDS?.DEFAULT || { bet2u: 57, bet1u: 55, lean: 53 };
    const sized = (c) => c >= tiers.bet2u ? ['BET_2U', 2] : c >= tiers.bet1u ? ['BET_1U', 1] : c >= tiers.lean ? ['LEAN', 0.5] : ['PASS', 0];

    if (mode === 'ai_lead') {
      if (verdict === 'pass') {
        return { final: { ...governor, decision: 'PASS', units: 0 }, verdict, detail: review, path: 'claude' };
      }
      const [decision, units] = sized(review.confidence);
      return { final: { ...governor, direction: verdict, confidence: review.confidence, decision, units },
               verdict, detail: review, path: 'claude' };
    }

    // ai_assisted
    if (governor.decision === 'PASS') return { final: governor, verdict, detail: review, path: 'governor+claude' };
    if (verdict !== governor.direction) {
      return { final: { ...governor, decision: 'PASS', units: 0 }, verdict, detail: review,
               path: verdict === 'pass' ? 'governor+claude (Claude passed)' : 'governor+claude (Claude disagreed)' };
    }
    return { final: { ...governor, confidence: Math.min(governor.confidence, review.confidence) },
             verdict, detail: review, path: 'governor+claude' };
  }

  // ============================================================
  // ── PROBABILITY ──
  // Chance of over, under and push for a line. over_excl_push is
  // the over chance with pushes set aside — the number compared
  // with 50%.
  // ============================================================

  function probabilities(dist, mu, sigma, line) {
    let over, under, push;
    const whole = Number.isInteger(line);

    if (dist === 'count') {
      const lambda = Math.max(mu, 0.01);
      if (whole) {
        push = poissonPmf(line, lambda);
        under = line > 0 ? poissonCdf(line - 1, lambda) : 0;
        over = 1 - under - push;
      } else {
        under = poissonCdf(Math.floor(line), lambda);
        push = 0;
        over = 1 - under;
      }
    } else {
      if (whole) {
        over = 1 - normalCdf((line + 0.5 - mu) / sigma);
        under = normalCdf((line - 0.5 - mu) / sigma);
        push = Math.max(0, 1 - over - under);
      } else {
        over = 1 - normalCdf((line - mu) / sigma);
        under = 1 - over;
        push = 0;
      }
    }

    over = clamp(over, 0, 1);
    under = clamp(under, 0, 1);
    const decided = over + under;
    return {
      over: round(over, 4),
      under: round(under, 4),
      push: round(push, 4),
      over_excl_push: decided > 0 ? clamp(over / decided, 0.01, 0.99) : 0.5,
    };
  }

  function poissonPmf(k, lambda) {
    let logP = -lambda + k * Math.log(lambda);
    for (let i = 2; i <= k; i++) logP -= Math.log(i);
    return Math.exp(logP);
  }

  function poissonCdf(k, lambda) {
    let sum = 0;
    for (let i = 0; i <= k; i++) sum += poissonPmf(i, lambda);
    return Math.min(1, sum);
  }

  function normalCdf(z) {
    // Abramowitz–Stegun 7.1.26
    const t = 1 / (1 + 0.3275911 * Math.abs(z) / Math.SQRT2);
    const y = 1 - (((((1.061405429 * t - 1.453152027) * t) + 1.421413741) * t - 0.284496736) * t + 0.254829592) * t
      * Math.exp(-(z * z) / 2);
    return z >= 0 ? (1 + y) / 2 : (1 - y) / 2;
  }

  // ============================================================
  // ── DATA ──
  // ============================================================

  // The player's most recent games where the stat was recorded,
  // newest first, as { game_id, game_date, opponent, value }.
  // A game where ESPN listed no line for the player in that stat's
  // category does not appear — it is not counted as a zero.
  async function loadPlayerLog(sport, playerId, stat, url, key) {
    const cols = Array.from(new Set(stat.cols));
    const rows = await getJson(
      `${url}/rest/v1/player_game_stats?sport=eq.${sport}&player_id=eq.${encodeURIComponent(playerId)}` +
      `&select=game_id,game_date,opponent,${cols.join(',')}` +
      `&order=game_date.desc&limit=${LOG_GAMES}`,
      key);
    return rows
      .filter(r => cols.some(c => r[c] != null))
      .map(r => ({
        game_id: r.game_id,
        game_date: r.game_date,
        opponent: r.opponent,
        value: cols.reduce((s, c) => s + (Number(r[c]) || 0), 0),
      }));
  }

  async function loadPowerRow(sport, teamName, url, key) {
    try {
      const rows = await getJson(
        `${url}/rest/v1/power_ratings?sport=eq.${sport}&team_name=eq.${encodeURIComponent(teamName)}` +
        `&select=team_name,defense_index,attack_index,overall&limit=1`, key);
      return rows[0] || null;
    } catch { return null; }
  }

  async function resolveEspnNames(sport, names) {
    const out = new Map();
    const url = SUPABASE_URL(), key = SUPABASE_KEY();
    let teams = [];
    try {
      teams = (await getJson(`${url}/rest/v1/power_ratings?sport=eq.${sport}&select=team_name&limit=1000`, key))
        .map(r => r.team_name);
    } catch {}
    names.forEach(n => {
      if (!n) return;
      const hit = teams.find(t => t === n) || teams.find(t => sameTeam(sport, t, n));
      out.set(n, hit || n);
    });
    return out;
  }

  function sameTeam(sport, a, b) {
    if (!a || !b) return false;
    const norm = (s) => {
      if (window.EDGE_TEAMS && typeof window.EDGE_TEAMS.normalize === 'function') {
        try { return window.EDGE_TEAMS.normalize(s, sport); } catch {}
      }
      return String(s).toLowerCase().replace(/[^a-z0-9]/g, '');
    };
    return norm(a) === norm(b);
  }

  // ============================================================
  // ── STORAGE ──
  // ============================================================

  async function save(result) {
    const url = SUPABASE_URL(), key = SUPABASE_KEY();
    if (!url || !key) throw new Error('Supabase not connected');
    const res = await fetch(`${url}/rest/v1/prop_picks`, {
      method: 'POST',
      headers: {
        apikey: key, Authorization: `Bearer ${key}`,
        'Content-Type': 'application/json', Prefer: 'return=representation',
      },
      body: JSON.stringify([result]),
    });
    if (!res.ok) {
      const body = await res.text().catch(() => '');
      throw new Error(`Save failed: HTTP ${res.status} ${body.slice(0, 160)}`);
    }
    const rows = await res.json();
    return rows[0] || null;
  }

  async function listForGame(gameId) {
    const url = SUPABASE_URL(), key = SUPABASE_KEY();
    if (!url || !key) return [];
    try {
      return await getJson(
        `${url}/rest/v1/prop_picks?game_id=eq.${encodeURIComponent(gameId)}` +
        `&select=id,player_name,stat_label,line,side,projection,prob_over,pick_side,decision,units,confidence,result,actual` +
        `&order=created_at.desc&limit=50`, key);
    } catch { return []; }
  }

  async function getJson(fullUrl, key) {
    const res = await fetch(fullUrl, { headers: { apikey: key, Authorization: `Bearer ${key}` } });
    if (!res.ok) {
      const body = await res.text().catch(() => '');
      throw new Error(`HTTP ${res.status} ${body.slice(0, 160)}`);
    }
    return res.json();
  }

  // ============================================================
  // ── HELPERS ──
  // ============================================================

  function signalFamily(family, rawSignal, confidence, reason) {
    const signal = clamp(isFinite(rawSignal) ? rawSignal : 0, -1, 1);
    const vote = signal > 0.15 ? 'yes' : signal < -0.15 ? 'no' : 'neu';
    return { family, vote, signal: round(signal, 3), confidence: round(confidence, 3), weight: 1, reason };
  }

  function neutralFamily(family, reason) {
    return { family, vote: 'neu', signal: 0, confidence: 0.5, weight: 1, reason };
  }

  function mean(arr) {
    const v = (arr || []).filter(x => isFinite(x));
    return v.length ? v.reduce((s, x) => s + x, 0) / v.length : null;
  }

  function sd(arr) {
    const v = (arr || []).filter(x => isFinite(x));
    if (v.length < 3) return null;
    const m = mean(v);
    return Math.sqrt(v.reduce((s, x) => s + (x - m) ** 2, 0) / (v.length - 1));
  }

  function fmt(v) { return v == null ? '—' : (Math.round(v * 10) / 10).toString(); }
  function clamp(v, min, max) { return Math.max(min, Math.min(max, v)); }
  function round(v, d) { const f = Math.pow(10, d); return Math.round(v * f) / f; }
})();

if (typeof window !== 'undefined') window.EDGE_PROPS = EDGE_PROPS;
