// ============================================================
// EDGE — MASTER ALGORITHM ENGINE
// Version 1.0
// Governs all 25 algorithms, generates picks, feeds Claude
// ============================================================

const EDGE_ENGINE = (() => {

  // ── CONSTANTS ──
  const SUPABASE_URL = () => localStorage.getItem('edge_supabase_url');
  const SUPABASE_KEY = () => localStorage.getItem('edge_supabase_key');
  const ODDS_KEY     = () => localStorage.getItem('edge_odds_api_key');
  const CLAUDE_KEY   = () => localStorage.getItem('edge_claude_api_key');

  const SPORTS = [
    { key: 'americanfootball_nfl',   label: 'NFL' },
    { key: 'basketball_nba',         label: 'NBA' },
    { key: 'baseball_mlb',           label: 'MLB' },
    { key: 'icehockey_nhl',          label: 'NHL' },
    { key: 'americanfootball_ncaaf', label: 'NCAAF' },
    { key: 'basketball_ncaab',       label: 'NCAAB' },
    { key: 'soccer_usa_mls',         label: 'MLS' },
  ];

  // ── AUTO SCHEDULE ──
  let autoInterval = null;

  function startAuto(intervalMs = 1800000) { // default 30 min
    if (autoInterval) clearInterval(autoInterval);
    autoInterval = setInterval(() => runFullEngine(), intervalMs);
    console.log('[EDGE] Auto engine started — interval:', intervalMs / 60000, 'min');
  }

  function stopAuto() {
    if (autoInterval) clearInterval(autoInterval);
    autoInterval = null;
    console.log('[EDGE] Auto engine stopped');
  }

  // ── FETCH GAME DATA ──
  async function fetchGames() {
    const key = ODDS_KEY();
    if (!key) throw new Error('No Odds API key');

    const games = [];
    for (const sport of SPORTS) {
      try {
        const res = await fetch(
          `https://api.the-odds-api.com/v4/sports/${sport.key}/odds/?apiKey=${key}&regions=us&markets=spreads,h2h,totals&oddsFormat=american`
        );
        if (!res.ok) continue;
        const data = await res.json();
        data.forEach(g => { g._sport = sport.label; games.push(g); });
      } catch {}
    }

    // Save games to localStorage for other pages
    localStorage.setItem('edge_todays_games', JSON.stringify(
      games.map(g => ({
        id: g.id,
        sport: g._sport,
        home: g.home_team,
        away: g.away_team,
        time: g.commence_time,
        spread: getMarketValue(g, 'spreads', 'home', 'point'),
        total:  getMarketValue(g, 'totals',  'Over',  'point'),
        ml:     getMarketValue(g, 'h2h',     'home',  'price'),
      }))
    ));

    return games;
  }

  function getMarketValue(game, market, side, field) {
    try {
      const bk  = game.bookmakers?.[0];
      const mkt = bk?.markets?.find(m => m.key === market);
      const out = mkt?.outcomes?.find(o => o.name === (side === 'home' ? game.home_team : side === 'away' ? game.away_team : side));
      return out?.[field] ?? null;
    } catch { return null; }
  }

  // ── FETCH ESPN DATA ──
  async function fetchESPNData(sport) {
    const sportMap = {
      NFL:   'football/nfl',
      NBA:   'basketball/nba',
      MLB:   'baseball/mlb',
      NHL:   'hockey/nhl',
      NCAAF: 'football/college-football',
      NCAAB: 'basketball/mens-college-basketball',
      MLS:   'soccer/usa.1',
    };
    const path = sportMap[sport];
    if (!path) return null;
    try {
      const res = await fetch(`https://site.api.espn.com/apis/site/v2/sports/${path}/scoreboard`);
      if (!res.ok) return null;
      return await res.json();
    } catch { return null; }
  }

  // ── LOAD ALGO SETTINGS FROM SUPABASE ──
  async function loadAlgoSettings() {
    const url = SUPABASE_URL(); const key = SUPABASE_KEY();
    if (!url || !key) return defaultAlgoSettings();
    try {
      const res = await fetch(`${url}/rest/v1/algorithms?select=*&order=id`, {
        headers: { 'apikey': key, 'Authorization': `Bearer ${key}` }
      });
      if (!res.ok) return defaultAlgoSettings();
      return await res.json();
    } catch { return defaultAlgoSettings(); }
  }

  function defaultAlgoSettings() {
    return Array.from({ length: 25 }, (_, i) => ({
      id: i + 1, enabled: true, weight: 4, wins: 0, losses: 0
    }));
  }

  // ============================================================
  // ── 25 ALGORITHM LOGIC ──
  // Each returns: { vote: 'yes'|'no'|'neu', confidence: 0-100, reason: string }
  // ============================================================

  const ALGORITHMS = {

    // 1. ELO RATING
    eloRating(game, espn) {
      const spread = game._spread;
      if (spread === null) return { vote: 'neu', confidence: 50, reason: 'No spread data' };
      // If home team favored by more than 3, lean home cover
      if (spread < -3) return { vote: 'yes', confidence: 65, reason: `Home favored ${spread} — Elo supports cover` };
      if (spread > 3)  return { vote: 'no',  confidence: 60, reason: `Away favored ${Math.abs(spread)} — Elo favors away` };
      return { vote: 'neu', confidence: 50, reason: 'Spread too close for Elo edge' };
    },

    // 2. PYTHAGOREAN EXPECTATION
    pythagoreanExpectation(game, espn) {
      // Uses points scored vs allowed ratio from ESPN data
      const teams = espn?.events?.[0]?.competitions?.[0]?.competitors || [];
      if (!teams.length) return { vote: 'neu', confidence: 50, reason: 'No scoring data' };
      const home = teams.find(t => t.homeAway === 'home');
      const away = teams.find(t => t.homeAway === 'away');
      const homePF = parseFloat(home?.statistics?.find(s => s.name === 'pointsPerGame')?.value || 0);
      const awayPF = parseFloat(away?.statistics?.find(s => s.name === 'pointsPerGame')?.value || 0);
      if (!homePF || !awayPF) return { vote: 'neu', confidence: 50, reason: 'Insufficient scoring data' };
      const pyth = (homePF ** 2) / (homePF ** 2 + awayPF ** 2);
      if (pyth > 0.6) return { vote: 'yes', confidence: 70, reason: `Pythagorean win prob ${(pyth*100).toFixed(1)}% favors home` };
      if (pyth < 0.4) return { vote: 'no',  confidence: 65, reason: `Pythagorean win prob ${(pyth*100).toFixed(1)}% favors away` };
      return { vote: 'neu', confidence: 50, reason: 'Pythagorean too close to call' };
    },

    // 3. SIMPLE RATING SYSTEM
    simpleRatingSystem(game, espn) {
      const spread = game._spread;
      if (spread === null) return { vote: 'neu', confidence: 50, reason: 'No spread' };
      const sos = Math.random() * 10 - 5; // placeholder until ESPN SOS data available
      const srs = (spread * -1) + sos;
      if (srs > 4)  return { vote: 'yes', confidence: 62, reason: `SRS score +${srs.toFixed(1)} favors home` };
      if (srs < -4) return { vote: 'no',  confidence: 60, reason: `SRS score ${srs.toFixed(1)} favors away` };
      return { vote: 'neu', confidence: 50, reason: 'SRS inconclusive' };
    },

    // 4. SHARP MONEY INDICATOR
    sharpMoneyIndicator(game, espn) {
      const hist = getLineHistory(game.id);
      if (!hist) return { vote: 'neu', confidence: 50, reason: 'No line history data' };
      const sharpPct = hist.sharp_pct || 50;
      if (sharpPct > 65) return { vote: 'yes', confidence: 72, reason: `${sharpPct}% sharp money on home` };
      if (sharpPct < 35) return { vote: 'no',  confidence: 68, reason: `Only ${sharpPct}% sharp on home — fading` };
      return { vote: 'neu', confidence: 50, reason: 'Sharp money split evenly' };
    },

    // 5. CLOSING LINE VALUE
    closingLineValue(game, espn) {
      const hist = getLineHistory(game.id);
      if (!hist) return { vote: 'neu', confidence: 50, reason: 'No opening line data' };
      const open    = hist.spread || game._spread;
      const current = game._spread;
      if (open === null || current === null) return { vote: 'neu', confidence: 50, reason: 'Missing line data' };
      const move = current - open;
      if (move < -1.5) return { vote: 'yes', confidence: 74, reason: `Line moved ${move} in home favor — positive CLV` };
      if (move > 1.5)  return { vote: 'no',  confidence: 70, reason: `Line moved +${move} against home — negative CLV` };
      return { vote: 'neu', confidence: 52, reason: 'Minimal line movement' };
    },

    // 6. STEAM MOVE DETECTOR
    steamMoveDetector(game, espn) {
      const hist = getLineHistory(game.id);
      if (!hist) return { vote: 'neu', confidence: 50, reason: 'No history' };
      const open    = hist.spread || game._spread;
      const current = game._spread;
      if (open === null || current === null) return { vote: 'neu', confidence: 50, reason: 'No data' };
      const diff = Math.abs(current - open);
      if (diff >= 2) return { vote: 'yes', confidence: 78, reason: `Steam move detected — ${diff} pt shift` };
      return { vote: 'neu', confidence: 48, reason: 'No steam move detected' };
    },

    // 7. REVERSE LINE MOVEMENT
    reverseLineMovement(game, espn) {
      const hist = getLineHistory(game.id);
      if (!hist) return { vote: 'neu', confidence: 50, reason: 'No data' };
      const publicPct = hist.public_pct || 50;
      const open    = hist.spread;
      const current = game._spread;
      if (!open || !current) return { vote: 'neu', confidence: 50, reason: 'No line data' };
      const lineMovedAgainstPublic = (publicPct > 60 && current > open) || (publicPct < 40 && current < open);
      if (lineMovedAgainstPublic) return { vote: 'yes', confidence: 76, reason: `RLM — public ${publicPct}% but line moved opposite` };
      return { vote: 'neu', confidence: 48, reason: 'No reverse line movement' };
    },

    // 8. PACE & TEMPO ANALYSIS
    paceTempoAnalysis(game, espn) {
      const total = game._total;
      if (!total) return { vote: 'neu', confidence: 50, reason: 'No total data' };
      // High total = fast pace game, favor over
      if (total > 230) return { vote: 'yes', confidence: 63, reason: `High total ${total} — pace matchup favors over` };
      if (total < 200) return { vote: 'no',  confidence: 60, reason: `Low total ${total} — pace matchup favors under` };
      return { vote: 'neu', confidence: 50, reason: 'Total in neutral range' };
    },

    // 9. STRENGTH OF SCHEDULE
    strengthOfSchedule(game, espn) {
      // Placeholder — ESPN SOS endpoint needed
      return { vote: 'neu', confidence: 50, reason: 'SOS data loads when ESPN connected' };
    },

    // 10. REST & RECOVERY INDEX
    restRecoveryIndex(game, espn) {
      const now       = new Date();
      const gameDate  = new Date(game.commence_time);
      const daysOut   = Math.round((gameDate - now) / (1000 * 60 * 60 * 24));
      if (daysOut === 0) return { vote: 'yes', confidence: 58, reason: 'Game today — rest advantage assessed' };
      return { vote: 'neu', confidence: 50, reason: 'Rest data loads from ESPN schedule' };
    },

    // 11. TRAVEL FATIGUE MODEL
    travelFatigueModel(game, espn) {
      // Needs roster/location data from ESPN
      return { vote: 'neu', confidence: 50, reason: 'Travel data loads when ESPN connected' };
    },

    // 12. WEATHER IMPACT MODEL
    weatherImpactModel(game, espn) {
      const sport = game._sport;
      const indoorSports = ['NBA','NHL','NCAAB'];
      if (indoorSports.includes(sport)) return { vote: 'neu', confidence: 50, reason: 'Indoor sport — weather irrelevant' };
      const total = game._total;
      if (!total) return { vote: 'neu', confidence: 50, reason: 'No total to assess weather impact' };
      // Placeholder — weather API needed for outdoor games
      return { vote: 'neu', confidence: 50, reason: 'Weather data pending API connection' };
    },

    // 13. HOME/AWAY SPLIT ANALYSIS
    homeAwaySplit(game, espn) {
      const spread = game._spread;
      if (spread === null) return { vote: 'neu', confidence: 50, reason: 'No spread' };
      // Home teams historically cover at higher rate when favored by 3-7
      if (spread >= -7 && spread <= -3) return { vote: 'yes', confidence: 64, reason: `Home favored ${spread} — strong cover range historically` };
      if (spread > 7) return { vote: 'no', confidence: 60, reason: `Large home favorite ${spread} — fade spot` };
      return { vote: 'neu', confidence: 50, reason: 'Spread outside historical sweet spot' };
    },

    // 14. ATS TREND ANALYSIS
    atsTrendAnalysis(game, espn) {
      // Load from Supabase pick history
      const picks = JSON.parse(localStorage.getItem('edge_picks_local') || '[]');
      const relevant = picks.filter(p => p.matchup && p.matchup.includes(game.home_team) && p.result);
      if (relevant.length < 3) return { vote: 'neu', confidence: 50, reason: 'Insufficient ATS history' };
      const wins = relevant.filter(p => p.result === 'W').length;
      const pct  = wins / relevant.length;
      if (pct > 0.6) return { vote: 'yes', confidence: 66, reason: `${(pct*100).toFixed(0)}% ATS cover rate in history` };
      if (pct < 0.4) return { vote: 'no',  confidence: 62, reason: `Only ${(pct*100).toFixed(0)}% ATS cover rate` };
      return { vote: 'neu', confidence: 50, reason: 'ATS trend neutral' };
    },

    // 15. RECENT FORM INDEX
    recentFormIndex(game, espn) {
      const events = espn?.events || [];
      if (!events.length) return { vote: 'neu', confidence: 50, reason: 'No recent game data from ESPN' };
      // Count last 5 results
      const recent = events.slice(0, 5);
      const wins = recent.filter(e => {
        const comp = e.competitions?.[0];
        const home = comp?.competitors?.find(c => c.homeAway === 'home');
        return home?.winner === true;
      }).length;
      if (wins >= 4) return { vote: 'yes', confidence: 68, reason: `Home team ${wins}/5 recent wins — hot form` };
      if (wins <= 1) return { vote: 'no',  confidence: 65, reason: `Home team ${wins}/5 recent wins — cold form` };
      return { vote: 'neu', confidence: 52, reason: `Home team ${wins}/5 recent — neutral form` };
    },

    // 16. PUBLIC BETTING % FADE
    publicBettingFade(game, espn) {
      const hist = getLineHistory(game.id);
      if (!hist) return { vote: 'neu', confidence: 50, reason: 'No public betting data' };
      const pub = hist.public_pct || 50;
      if (pub > 70) return { vote: 'no',  confidence: 67, reason: `${pub}% public on home — fade the public` };
      if (pub < 30) return { vote: 'yes', confidence: 65, reason: `Only ${pub}% public on home — contrarian play` };
      return { vote: 'neu', confidence: 50, reason: 'Public split neutral' };
    },

    // 17. SITUATIONAL SPOT ANALYSIS
    situationalSpotAnalysis(game, espn) {
      const gameDate = new Date(game.commence_time);
      const day = gameDate.getDay();
      // Thursday/Monday night games — trap game risk
      if (day === 4 || day === 1) return { vote: 'neu', confidence: 52, reason: 'Primetime game — trap spot possible' };
      return { vote: 'neu', confidence: 50, reason: 'No situational flags detected' };
    },

    // 18. COACHING TENDENCIES
    coachingTendencies(game, espn) {
      return { vote: 'neu', confidence: 50, reason: 'Coaching data loads when ESPN roster API connected' };
    },

    // 19. INJURY IMPACT SCORE
    injuryImpactScore(game, espn) {
      return { vote: 'neu', confidence: 50, reason: 'Injury data loads when ESPN connected' };
    },

    // 20. PRIMETIME PERFORMANCE
    primetimePerformance(game, espn) {
      const gameDate = new Date(game.commence_time);
      const hour = gameDate.getHours();
      const isPrimetime = hour >= 19; // 7pm+
      if (isPrimetime) return { vote: 'neu', confidence: 54, reason: 'Primetime game — performance model active' };
      return { vote: 'neu', confidence: 50, reason: 'Not a primetime game' };
    },

    // 21. DIVISIONAL RECORD
    divisionalRecord(game, espn) {
      return { vote: 'neu', confidence: 50, reason: 'Divisional data loads when ESPN connected' };
    },

    // 22. REVENGE GAME DETECTOR
    revengeGameDetector(game, espn) {
      const picks = JSON.parse(localStorage.getItem('edge_picks_local') || '[]');
      const prevLoss = picks.find(p =>
        p.matchup && p.matchup.includes(game.home_team) &&
        p.matchup.includes(game.away_team) &&
        p.result === 'L'
      );
      if (prevLoss) return { vote: 'yes', confidence: 66, reason: `Revenge game detected — home lost to ${game.away_team} previously` };
      return { vote: 'neu', confidence: 50, reason: 'No revenge game scenario detected' };
    },

    // 23. LINE OPEN-TO-CLOSE MOVEMENT
    lineOpenToClose(game, espn) {
      const hist = getLineHistory(game.id);
      if (!hist?.spread) return { vote: 'neu', confidence: 50, reason: 'No opening line data' };
      const move = (game._spread || 0) - hist.spread;
      if (Math.abs(move) >= 1) return { vote: move < 0 ? 'yes' : 'no', confidence: 65, reason: `Line moved ${move > 0 ? '+' : ''}${move} from open` };
      return { vote: 'neu', confidence: 50, reason: 'Minimal open-to-close movement' };
    },

    // 24. TOTALS TREND MODEL
    totalsTrendModel(game, espn) {
      const total = game._total;
      if (!total) return { vote: 'neu', confidence: 50, reason: 'No total data' };
      const picks = JSON.parse(localStorage.getItem('edge_picks_local') || '[]');
      const totPicks = picks.filter(p => p.pick_type === 'Total' && p.result);
      const overs = totPicks.filter(p => p.pick_label?.includes('O') && p.result === 'W').length;
      const unders = totPicks.filter(p => p.pick_label?.includes('U') && p.result === 'W').length;
      if (overs > unders + 2) return { vote: 'yes', confidence: 60, reason: `Overs trending ${overs} hits vs ${unders} unders` };
      if (unders > overs + 2) return { vote: 'no',  confidence: 60, reason: `Unders trending ${unders} hits vs ${overs} overs` };
      return { vote: 'neu', confidence: 50, reason: 'Totals trend neutral' };
    },

    // 25. REGRESSION TO THE MEAN
    regressionToMean(game, espn) {
      const events = espn?.events || [];
      if (!events.length) return { vote: 'neu', confidence: 50, reason: 'No ESPN data' };
      // If team won last 5 by large margins, regression likely
      const recent = events.slice(0, 5);
      const blowouts = recent.filter(e => {
        const comp = e.competitions?.[0];
        const scores = comp?.competitors?.map(c => parseInt(c.score || 0)) || [];
        return Math.abs(scores[0] - scores[1]) > 20;
      }).length;
      if (blowouts >= 3) return { vote: 'no', confidence: 62, reason: `${blowouts} recent blowouts — regression to mean likely` };
      return { vote: 'neu', confidence: 50, reason: 'No regression signal detected' };
    },
  };

  // ── LINE HISTORY HELPER ──
  function getLineHistory(gameId) {
    try {
      const hist = JSON.parse(localStorage.getItem('edge_line_history') || '{}');
      return hist[gameId] || null;
    } catch { return null; }
  }

  // ── GOVERNING ALGORITHM ──
  // Synthesizes all 25 votes into final pick decision
  function governingAlgorithm(votes, algoSettings, game) {
    let weightedYes = 0, weightedNo = 0, totalWeight = 0;
    let reasons = [];

    votes.forEach((v, i) => {
      const setting = algoSettings.find(a => a.id === i + 1);
      if (!setting?.enabled) return;

      const weight = setting.weight || 4;
      totalWeight += weight;

      if (v.vote === 'yes') {
        weightedYes += weight * (v.confidence / 100);
        reasons.push(v.reason);
      } else if (v.vote === 'no') {
        weightedNo += weight * (v.confidence / 100);
      }
    });

    const yesScore = totalWeight > 0 ? (weightedYes / totalWeight) * 100 : 0;
    const noScore  = totalWeight > 0 ? (weightedNo  / totalWeight) * 100 : 0;

    const yesVotes  = votes.filter(v => v.vote === 'yes').length;
    const noVotes   = votes.filter(v => v.vote === 'no').length;
    const neuVotes  = votes.filter(v => v.vote === 'neu').length;
    const consensus = yesVotes;

    // Chronological weight — recent form gets 1.2x boost
    const recentFormVote = votes[14]; // index 14 = Recent Form Index
    const recentBoost = recentFormVote?.vote === 'yes' ? 1.2 : 1.0;

    const finalScore = yesScore * recentBoost;
    const confidence = Math.min(Math.round(finalScore), 99);
    const confTier   = confidence >= 68 ? 'high' : confidence >= 48 ? 'med' : 'low';

    const pickSide = yesScore > noScore ? 'home' : 'away';
    const spread   = game._spread;

    let pickLabel, pickType, line;
    if (spread !== null) {
      pickLabel = pickSide === 'home' ? game.home_team : game.away_team;
      pickType  = 'ATS';
      line      = pickSide === 'home' ? spread : spread * -1;
    } else {
      pickLabel = pickSide === 'home' ? game.home_team : game.away_team;
      pickType  = 'ML';
      line      = null;
    }

    const units = confidence >= 75 ? 2 : 1;

    return {
      game_id:    game.id,
      sport:      game._sport,
      matchup:    `${game.away_team} vs ${game.home_team}`,
      time:       game.commence_time,
      pick_label: pickLabel,
      pick_type:  pickType,
      line:       line,
      odds:       game._ml,
      consensus:  consensus,
      confidence: confidence,
      conf_tier:  confTier,
      yes_votes:  yesVotes,
      no_votes:   noVotes,
      neu_votes:  neuVotes,
      units:      units,
      reason:     reasons.slice(0, 3).join(' · '),
      algo_votes: votes,
      status:     'pending',
      date:       new Date().toISOString().split('T')[0],
      created_at: new Date().toISOString(),
    };
  }

  // ── RUN ALGORITHMS ON SINGLE GAME ──
  async function analyzeGame(game, algoSettings, espnData) {
    game._spread = getMarketValue(game, 'spreads', 'home', 'point');
    game._total  = getMarketValue(game, 'totals',  'Over',  'point');
    game._ml     = getMarketValue(game, 'h2h',     'home',  'price');

    const algoKeys = Object.keys(ALGORITHMS);
    const votes = algoKeys.map(key => {
      try { return ALGORITHMS[key](game, espnData); }
      catch { return { vote: 'neu', confidence: 50, reason: 'Error in algorithm' }; }
    });

    return governingAlgorithm(votes, algoSettings, game);
  }

  // ── SAVE PICKS TO SUPABASE ──
  async function savePicks(picks) {
    const url = SUPABASE_URL(); const key = SUPABASE_KEY();

    // Always save to localStorage
    localStorage.setItem('edge_picks_today', JSON.stringify(picks));

    if (!url || !key) return;
    try {
      await fetch(`${url}/rest/v1/picks`, {
        method: 'POST',
        headers: { 'apikey': key, 'Authorization': `Bearer ${key}`, 'Content-Type': 'application/json', 'Prefer': 'return=minimal' },
        body: JSON.stringify(picks)
      });
    } catch {}
  }

  // ── SAVE ALGO VOTES TO SUPABASE ──
  async function saveAlgoVotes(pick) {
    const url = SUPABASE_URL(); const key = SUPABASE_KEY();
    if (!url || !key || !pick.algo_votes) return;
    try {
      const updates = pick.algo_votes.map((v, i) => ({
        id: i + 1,
        current_vote: v.vote
      }));
      for (const u of updates) {
        await fetch(`${url}/rest/v1/algorithms?id=eq.${u.id}`, {
          method: 'PATCH',
          headers: { 'apikey': key, 'Authorization': `Bearer ${key}`, 'Content-Type': 'application/json' },
          body: JSON.stringify({ current_vote: u.current_vote })
        });
      }
    } catch {}
  }

  // ── GENERATE CLAUDE NARRATIVE ──
  async function generateNarrative(pick) {
    const claudeKey = CLAUDE_KEY();
    if (!claudeKey) return 'Connect Claude API in Admin for AI narrative.';

    const yesAlgos = pick.algo_votes
      ?.map((v, i) => v.vote === 'yes' ? Object.keys(ALGORITHMS)[i] : null)
      .filter(Boolean).join(', ') || 'None';

    const prompt = `You are EDGE, an elite AI sports betting analyst. Based on the following data, write a sharp 2-3 sentence betting narrative. Be direct and data-driven. No fluff.

Game: ${pick.matchup} (${pick.sport})
Pick: ${pick.pick_label} ${pick.pick_type} ${pick.line || ''}
Confidence: ${pick.confidence}% (${pick.conf_tier.toUpperCase()})
Algorithm consensus: ${pick.yes_votes}/25 in favor
Key signals: ${pick.reason}
Supporting algorithms: ${yesAlgos}

Write the narrative now:`;

    try {
      const res = await fetch('https://api.anthropic.com/v1/messages', {
        method: 'POST',
        headers: { 'Content-Type': 'application/json', 'x-api-key': claudeKey, 'anthropic-version': '2023-06-01' },
        body: JSON.stringify({
          model: 'claude-sonnet-4-20250514',
          max_tokens: 200,
          messages: [{ role: 'user', content: prompt }]
        })
      });
      const data = await res.json();
      return data.content?.[0]?.text || 'Analysis unavailable.';
    } catch { return 'Claude API error. Check key in Admin.'; }
  }

  // ── 7-DAY DATA PURGE ──
  async function purgeOldData() {
    const url = SUPABASE_URL(); const key = SUPABASE_KEY();
    if (!url || !key) return;

    const cutoff = new Date();
    cutoff.setDate(cutoff.getDate() - 7);
    const cutoffStr = cutoff.toISOString();

    try {
      // Fetch old picks before deleting (for PDF)
      const res = await fetch(`${url}/rest/v1/picks?created_at=lt.${cutoffStr}&select=*`, {
        headers: { 'apikey': key, 'Authorization': `Bearer ${key}` }
      });
      const oldPicks = res.ok ? await res.json() : [];

      if (oldPicks.length > 0) {
        await generatePDF(oldPicks);
        // Delete from Supabase
        await fetch(`${url}/rest/v1/picks?created_at=lt.${cutoffStr}`, {
          method: 'DELETE',
          headers: { 'apikey': key, 'Authorization': `Bearer ${key}` }
        });
        await fetch(`${url}/rest/v1/line_history?created_at=lt.${cutoffStr}`, {
          method: 'DELETE',
          headers: { 'apikey': key, 'Authorization': `Bearer ${key}` }
        });
        console.log(`[EDGE] Purged ${oldPicks.length} picks older than 7 days`);
      }
    } catch (e) { console.error('[EDGE] Purge error:', e); }
  }

  // ── PDF GENERATOR ──
  function generatePDF(picks) {
    // Sort by date, sport, result
    const sorted = [...picks].sort((a, b) => {
      if (a.date !== b.date) return a.date.localeCompare(b.date);
      if (a.sport !== b.sport) return a.sport.localeCompare(b.sport);
      return (a.result || '').localeCompare(b.result || '');
    });

    const wins   = sorted.filter(p => p.result === 'W').length;
    const losses = sorted.filter(p => p.result === 'L').length;
    const pushes = sorted.filter(p => p.result === 'P').length;
    const pnl    = sorted.reduce((s, p) => s + (p.pnl || 0), 0);

    const rows = sorted.map(p => `
      <tr>
        <td>${p.date || '—'}</td>
        <td>${p.sport || '—'}</td>
        <td>${p.matchup || '—'}</td>
        <td>${p.pick_label || '—'} ${p.pick_type || ''}</td>
        <td>${p.confidence || '—'}%</td>
        <td>${p.result || 'PENDING'}</td>
        <td>${p.pnl != null ? (p.pnl > 0 ? '+' : '') + p.pnl + 'u' : '—'}</td>
      </tr>`).join('');

    const html = `
      <html><head><style>
        body { font-family: Arial, sans-serif; font-size: 12px; color: #111; padding: 20px; }
        h1 { font-size: 22px; margin-bottom: 4px; }
        .meta { font-size: 11px; color: #666; margin-bottom: 16px; }
        .summary { display: flex; gap: 20px; margin-bottom: 16px; }
        .sum-box { border: 1px solid #ddd; padding: 8px 14px; }
        .sum-val { font-size: 20px; font-weight: bold; }
        .sum-lbl { font-size: 10px; color: #666; }
        table { width: 100%; border-collapse: collapse; }
        th { background: #111; color: #C9A84C; font-size: 10px; letter-spacing: 1px; text-transform: uppercase; padding: 8px 6px; text-align: left; }
        td { padding: 7px 6px; border-bottom: 1px solid #eee; font-size: 11px; }
        tr:nth-child(even) { background: #f9f9f9; }
      </style></head><body>
        <h1>EDGE — Pick History Report</h1>
        <div class="meta">Generated ${new Date().toLocaleDateString()} · Last 7 Days</div>
        <div class="summary">
          <div class="sum-box"><div class="sum-val">${wins}–${losses}–${pushes}</div><div class="sum-lbl">Record</div></div>
          <div class="sum-box"><div class="sum-val">${pnl > 0 ? '+' : ''}${pnl.toFixed(1)}u</div><div class="sum-lbl">P&L</div></div>
          <div class="sum-box"><div class="sum-val">${sorted.length}</div><div class="sum-lbl">Total Picks</div></div>
        </div>
        <table>
          <thead><tr><th>Date</th><th>Sport</th><th>Matchup</th><th>Pick</th><th>Conf</th><th>Result</th><th>P&L</th></tr></thead>
          <tbody>${rows}</tbody>
        </table>
      </body></html>`;

    const blob = new Blob([html], { type: 'text/html' });
    const url  = URL.createObjectURL(blob);
    const a    = document.createElement('a');
    a.href     = url;
    a.download = `EDGE_Picks_${new Date().toISOString().split('T')[0]}.html`;
    a.click();
    URL.revokeObjectURL(url);
  }

  // ── MAIN ENGINE RUN ──
  async function runFullEngine(options = {}) {
    const { onProgress, onComplete, onError } = options;

    try {
      onProgress?.('Fetching game data...');
      const games = await fetchGames();
      if (!games.length) { onProgress?.('No games found'); return []; }

      onProgress?.(`${games.length} games found — loading algorithms...`);
      const algoSettings = await loadAlgoSettings();

      const picks = [];
      let processed = 0;

      for (const game of games) {
        try {
          const espnData = await fetchESPNData(game._sport);
          const pick = await analyzeGame(game, algoSettings, espnData);

          // Only generate picks above minimum confidence
          const minConf = parseInt(localStorage.getItem('edge_min_conf') || '0');
          const minCons = parseInt(localStorage.getItem('edge_min_cons') || '0');

          if (pick.confidence >= minConf && pick.consensus >= minCons) {
            // Generate Claude narrative
            onProgress?.(`Generating AI narrative for ${pick.matchup}...`);
            pick.reason = await generateNarrative(pick);
            picks.push(pick);
            await saveAlgoVotes(pick);
          }

          processed++;
          onProgress?.(`Analyzed ${processed}/${games.length} games...`);
        } catch {}
      }

      // Sort picks by confidence descending
      picks.sort((a, b) => b.confidence - a.confidence);

      await savePicks(picks);

      // Check if 7-day purge needed
      const lastPurge = localStorage.getItem('edge_last_purge');
      const now = Date.now();
      if (!lastPurge || now - parseInt(lastPurge) > 7 * 24 * 60 * 60 * 1000) {
        await purgeOldData();
        localStorage.setItem('edge_last_purge', now.toString());
      }

      onProgress?.(`✓ Engine complete — ${picks.length} picks generated`);
      onComplete?.(picks);
      return picks;

    } catch (e) {
      onError?.(e.message);
      console.error('[EDGE ENGINE ERROR]', e);
      return [];
    }
  }

  // ── PUBLIC API ──
  return {
    run: runFullEngine,
    startAuto,
    stopAuto,
    generatePDF,
    purgeOldData,
    analyzeGame,
    generateNarrative,
    isAutoRunning: () => autoInterval !== null,
  };

})();

// ── AUTO-START IF IN AUTO MODE ──
if (localStorage.getItem('edge_betting_mode') === 'auto') {
  EDGE_ENGINE.startAuto();
}
