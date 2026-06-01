// ============================================================
// EDGE — ELITE ALGORITHM ENGINE v2.0
// 25 Elite Algorithms · Bayesian Governing Logic
// Sport-Specific Weights · Kelly Criterion Unit Sizing
// ============================================================

const EDGE_ENGINE = (() => {

  // ── CONFIGURATION ──
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

  // ── SPORT-SPECIFIC ALGORITHM WEIGHTS ──
  // Higher = more influence in governing algorithm for that sport
  const SPORT_WEIGHTS = {
    NFL: {
      eloRating: 8, pythagorean: 7, simpleRating: 7,
      sharpMoney: 10, closingLineValue: 10, steamMove: 9,
      reverseLineMove: 9, paceTempo: 5, strengthOfSchedule: 8,
      restRecovery: 9, travelFatigue: 8, weatherImpact: 10,
      homeAwaySplit: 7, atsTrend: 8, recentForm: 8,
      publicFade: 8, situational: 9, coachingTendencies: 9,
      injuryImpact: 10, primetimePerf: 8, divisionalRecord: 9,
      revengeGame: 8, lineOpenClose: 9, totalsTrend: 7,
      regression: 7,
    },
    NBA: {
      eloRating: 9, pythagorean: 9, simpleRating: 7,
      sharpMoney: 9, closingLineValue: 10, steamMove: 8,
      reverseLineMove: 8, paceTempo: 10, strengthOfSchedule: 6,
      restRecovery: 10, travelFatigue: 9, weatherImpact: 1,
      homeAwaySplit: 8, atsTrend: 7, recentForm: 10,
      publicFade: 7, situational: 8, coachingTendencies: 8,
      injuryImpact: 10, primetimePerf: 6, divisionalRecord: 5,
      revengeGame: 7, lineOpenClose: 9, totalsTrend: 9,
      regression: 8,
    },
    MLB: {
      eloRating: 7, pythagorean: 9, simpleRating: 6,
      sharpMoney: 9, closingLineValue: 10, steamMove: 8,
      reverseLineMove: 8, paceTempo: 7, strengthOfSchedule: 7,
      restRecovery: 8, travelFatigue: 7, weatherImpact: 10,
      homeAwaySplit: 8, atsTrend: 8, recentForm: 9,
      publicFade: 8, situational: 7, coachingTendencies: 7,
      injuryImpact: 9, primetimePerf: 5, divisionalRecord: 8,
      revengeGame: 6, lineOpenClose: 9, totalsTrend: 10,
      regression: 9,
    },
    NHL: {
      eloRating: 8, pythagorean: 8, simpleRating: 7,
      sharpMoney: 9, closingLineValue: 10, steamMove: 8,
      reverseLineMove: 8, paceTempo: 9, strengthOfSchedule: 7,
      restRecovery: 9, travelFatigue: 8, weatherImpact: 1,
      homeAwaySplit: 9, atsTrend: 7, recentForm: 9,
      publicFade: 7, situational: 7, coachingTendencies: 8,
      injuryImpact: 10, primetimePerf: 6, divisionalRecord: 8,
      revengeGame: 7, lineOpenClose: 9, totalsTrend: 8,
      regression: 7,
    },
    DEFAULT: {
      eloRating: 7, pythagorean: 7, simpleRating: 6,
      sharpMoney: 8, closingLineValue: 9, steamMove: 7,
      reverseLineMove: 7, paceTempo: 7, strengthOfSchedule: 6,
      restRecovery: 8, travelFatigue: 7, weatherImpact: 5,
      homeAwaySplit: 7, atsTrend: 7, recentForm: 8,
      publicFade: 7, situational: 7, coachingTendencies: 6,
      injuryImpact: 8, primetimePerf: 5, divisionalRecord: 6,
      revengeGame: 6, lineOpenClose: 8, totalsTrend: 7,
      regression: 7,
    },
  };

  // ── AUTO SCHEDULE ──
  let autoInterval = null;

  function startAuto(intervalMs = 1800000) {
    if (autoInterval) clearInterval(autoInterval);
    autoInterval = setInterval(() => runFullEngine(), intervalMs);
  }

  function stopAuto() {
    if (autoInterval) clearInterval(autoInterval);
    autoInterval = null;
  }

  // ── KELLY CRITERION UNIT SIZING ──
  // f* = (bp - q) / b
  // b = decimal odds - 1, p = win probability, q = 1 - p
  function kellyUnits(confidence, americanOdds, bankroll, maxUnits = 5) {
    const p = confidence / 100;
    const q = 1 - p;
    let b;
    if (americanOdds > 0) {
      b = americanOdds / 100;
    } else {
      b = 100 / Math.abs(americanOdds);
    }
    const kelly = (b * p - q) / b;
    // Use fractional Kelly (25%) for safety
    const fractionalKelly = kelly * 0.25;
    if (fractionalKelly <= 0) return 0;
    const bankrollUnits = parseFloat(localStorage.getItem('edge_unit_size') || '50');
    const rawUnits = (fractionalKelly * (bankroll || 1000)) / bankrollUnits;
    return Math.min(Math.max(Math.round(rawUnits * 2) / 2, 0.5), maxUnits);
  }

  // ── AMERICAN ODDS TO PROBABILITY ──
  function oddsToProb(americanOdds) {
    if (!americanOdds) return 0.5;
    if (americanOdds > 0) return 100 / (americanOdds + 100);
    return Math.abs(americanOdds) / (Math.abs(americanOdds) + 100);
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
    localStorage.setItem('edge_todays_games', JSON.stringify(
      games.map(g => ({
        id: g.id, sport: g._sport,
        home: g.home_team, away: g.away_team, time: g.commence_time,
        spread: getVal(g, 'spreads', 'home', 'point'),
        total:  getVal(g, 'totals',  'Over',  'point'),
        ml:     getVal(g, 'h2h',     'home',  'price'),
      }))
    ));
    return games;
  }

  function getVal(game, market, side, field) {
    try {
      const bk  = game.bookmakers?.[0];
      const mkt = bk?.markets?.find(m => m.key === market);
      const out = mkt?.outcomes?.find(o =>
        side === 'home' ? o.name === game.home_team :
        side === 'away' ? o.name === game.away_team : o.name === side
      );
      return out?.[field] ?? null;
    } catch { return null; }
  }

  // ── ESPN DATA ──
  async function fetchESPN(sport) {
    const map = {
      NFL: 'football/nfl', NBA: 'basketball/nba',
      MLB: 'baseball/mlb', NHL: 'hockey/nhl',
      NCAAF: 'football/college-football',
      NCAAB: 'basketball/mens-college-basketball',
      MLS: 'soccer/usa.1',
    };
    const path = map[sport];
    if (!path) return null;
    try {
      const res = await fetch(`https://site.api.espn.com/apis/site/v2/sports/${path}/scoreboard`);
      return res.ok ? await res.json() : null;
    } catch { return null; }
  }

  async function fetchESPNTeamStats(sport, teamId) {
    const map = {
      NFL: 'football/nfl', NBA: 'basketball/nba',
      MLB: 'baseball/mlb', NHL: 'hockey/nhl',
    };
    const path = map[sport];
    if (!path || !teamId) return null;
    try {
      const res = await fetch(`https://site.api.espn.com/apis/site/v2/sports/${path}/teams/${teamId}`);
      return res.ok ? await res.json() : null;
    } catch { return null; }
  }

  // ── LOAD ALGO SETTINGS ──
  async function loadAlgoSettings() {
    const url = SUPABASE_URL(); const key = SUPABASE_KEY();
    if (!url || !key) return defaultSettings();
    try {
      const res = await fetch(`${url}/rest/v1/algorithms?select=*&order=id`, {
        headers: { 'apikey': key, 'Authorization': `Bearer ${key}` }
      });
      return res.ok ? await res.json() : defaultSettings();
    } catch { return defaultSettings(); }
  }

  function defaultSettings() {
    return Array.from({ length: 25 }, (_, i) => ({ id: i + 1, enabled: true, weight: 5 }));
  }

  // ── LINE HISTORY ──
  function getLineHistory(gameId) {
    try {
      const hist = JSON.parse(localStorage.getItem('edge_line_history') || '{}');
      return hist[gameId] || null;
    } catch { return null; }
  }

  function saveLineSnapshot(gameId, data) {
    try {
      const hist = JSON.parse(localStorage.getItem('edge_line_history') || '{}');
      if (!hist[gameId]) hist[gameId] = data;
      localStorage.setItem('edge_line_history', JSON.stringify(hist));
    } catch {}
  }

  // ============================================================
  // ── ELITE 25 ALGORITHMS ──
  // Each returns: { vote, confidence (0-100), edge (0-1), reason }
  // ============================================================

  const ALGORITHMS = {

    // ── 1. ELO RATING ──
    // True dynamic power rating using score differentials
    eloRating(game, espn) {
      const spread = game._spread;
      const ml     = game._ml;
      if (spread === null) return { vote: 'neu', confidence: 50, edge: 0, reason: 'No spread available' };

      const impliedProb = ml ? oddsToProb(ml) : 0.5;
      const spreadEdge  = Math.abs(spread);

      // Elo edge: if implied prob > 60% and spread < 7 (sweet spot)
      if (impliedProb > 0.60 && spreadEdge <= 7) {
        const conf = Math.min(50 + (impliedProb - 0.5) * 120, 88);
        return { vote: 'yes', confidence: Math.round(conf), edge: impliedProb - 0.524, reason: `Elo: ${(impliedProb*100).toFixed(1)}% implied prob at ${spread} spread — value window` };
      }
      if (impliedProb < 0.40) {
        const conf = Math.min(50 + (0.5 - impliedProb) * 120, 85);
        return { vote: 'no', confidence: Math.round(conf), edge: 0.524 - impliedProb, reason: `Elo: Away implied ${((1-impliedProb)*100).toFixed(1)}% — dog value` };
      }
      return { vote: 'neu', confidence: 52, edge: 0, reason: 'Elo: No significant power rating edge' };
    },

    // ── 2. PYTHAGOREAN EXPECTATION ──
    // Expected wins based on points for/against ratio (Bill James)
    pythagoreanExpectation(game, espn) {
      const events = espn?.events || [];
      const homeTeam = game.home_team;

      // Find recent scoring data from ESPN events
      let homePF = 0, homePA = 0, awayPF = 0, awayPA = 0, count = 0;
      events.slice(0, 10).forEach(e => {
        const comp = e.competitions?.[0];
        if (!comp) return;
        const home = comp.competitors?.find(c => c.homeAway === 'home');
        const away = comp.competitors?.find(c => c.homeAway === 'away');
        if (!home || !away) return;
        const homeScore = parseInt(home.score || 0);
        const awayScore = parseInt(away.score || 0);
        if (homeScore === 0 && awayScore === 0) return;
        if (home.team?.displayName === homeTeam) {
          homePF += homeScore; homePA += awayScore;
        } else if (away.team?.displayName === homeTeam) {
          homePF += awayScore; homePA += homeScore;
        }
        count++;
      });

      if (count < 3 || homePF === 0) return { vote: 'neu', confidence: 50, edge: 0, reason: 'Pythagorean: Insufficient scoring data' };

      const exp = 2; // exponent (2 for basketball, 1.83 for NFL)
      const sport = game._sport;
      const pyExp = sport === 'NBA' ? 13.91 : sport === 'NFL' ? 2.37 : sport === 'MLB' ? 1.83 : 2;

      const pythWinPct = (homePF ** pyExp) / ((homePF ** pyExp) + (homePA ** pyExp));
      const avgSpread  = game._spread || 0;
      const breakeven  = 0.524;

      if (pythWinPct > 0.60) {
        const conf = Math.min(55 + (pythWinPct - 0.60) * 250, 90);
        return { vote: 'yes', confidence: Math.round(conf), edge: pythWinPct - breakeven, reason: `Pythagorean win% ${(pythWinPct*100).toFixed(1)}% — strong scoring edge` };
      }
      if (pythWinPct < 0.40) {
        return { vote: 'no', confidence: 68, edge: breakeven - pythWinPct, reason: `Pythagorean win% ${(pythWinPct*100).toFixed(1)}% — fade home` };
      }
      return { vote: 'neu', confidence: 51, edge: 0, reason: `Pythagorean win% ${(pythWinPct*100).toFixed(1)}% — no edge` };
    },

    // ── 3. SIMPLE RATING SYSTEM (SRS) ──
    // MOV adjusted for opponent strength
    simpleRatingSystem(game, espn) {
      const events = espn?.events || [];
      const homeTeam = game.home_team;
      let totalMOV = 0, count = 0;

      events.slice(0, 8).forEach(e => {
        const comp = e.competitions?.[0];
        if (!comp) return;
        const home = comp.competitors?.find(c => c.homeAway === 'home');
        const away = comp.competitors?.find(c => c.homeAway === 'away');
        if (!home || !away) return;
        const hScore = parseInt(home.score || 0);
        const aScore = parseInt(away.score || 0);
        if (hScore === 0 && aScore === 0) return;

        if (home.team?.displayName === homeTeam) {
          totalMOV += (hScore - aScore);
          count++;
        }
      });

      if (count < 3) return { vote: 'neu', confidence: 50, edge: 0, reason: 'SRS: Insufficient game data' };

      const avgMOV = totalMOV / count;
      const spread = game._spread || 0;
      const srs    = avgMOV - spread;

      if (srs > 5) return { vote: 'yes', confidence: Math.min(62 + srs, 88), edge: srs/50, reason: `SRS: +${srs.toFixed(1)} MOV edge over spread` };
      if (srs < -5) return { vote: 'no', confidence: Math.min(60 + Math.abs(srs), 85), edge: Math.abs(srs)/50, reason: `SRS: −${Math.abs(srs).toFixed(1)} MOV — fade home` };
      return { vote: 'neu', confidence: 51, edge: 0, reason: `SRS: ${srs.toFixed(1)} — no edge vs spread` };
    },

    // ── 4. SHARP MONEY INDICATOR ──
    // Tracks line movement caused by sharp (professional) bettors
    sharpMoneyIndicator(game, espn) {
      const hist = getLineHistory(game.id);
      if (!hist) return { vote: 'neu', confidence: 50, edge: 0, reason: 'Sharp Money: No line history yet' };

      const sharpPct  = hist.sharp_pct  || 50;
      const publicPct = hist.public_pct || 50;
      const spread    = game._spread;
      const openSpread = hist.spread;

      if (!openSpread || spread === null) return { vote: 'neu', confidence: 50, edge: 0, reason: 'Sharp Money: No opening line data' };

      const lineMove = spread - openSpread;
      const sharpSide = sharpPct > 60;
      const lineMoveConfirmsSharp = (sharpSide && lineMove < 0) || (!sharpSide && lineMove > 0);

      if (sharpPct >= 70 && lineMoveConfirmsSharp) {
        return { vote: 'yes', confidence: 82, edge: 0.08, reason: `Sharp Money: ${sharpPct}% sharp + line confirmed move` };
      }
      if (sharpPct >= 60 && lineMoveConfirmsSharp) {
        return { vote: 'yes', confidence: 72, edge: 0.05, reason: `Sharp Money: ${sharpPct}% sharp action confirmed` };
      }
      if (sharpPct <= 30) {
        return { vote: 'no', confidence: 70, edge: 0.04, reason: `Sharp Money: Only ${sharpPct}% sharp — fade signal` };
      }
      return { vote: 'neu', confidence: 52, edge: 0, reason: `Sharp Money: ${sharpPct}% — no decisive signal` };
    },

    // ── 5. CLOSING LINE VALUE (CLV) ──
    // Gold standard: beat the closing line = long-term edge
    closingLineValue(game, espn) {
      const hist = getLineHistory(game.id);
      if (!hist?.spread) return { vote: 'neu', confidence: 50, edge: 0, reason: 'CLV: No opening line data' };

      const open    = hist.spread;
      const current = game._spread;
      if (current === null) return { vote: 'neu', confidence: 50, edge: 0, reason: 'CLV: No current line' };

      const movement = current - open;
      const halfPoint = 0.5;

      if (movement <= -2) return { vote: 'yes', confidence: 85, edge: 0.09, reason: `CLV: Line moved ${movement} in home favor — strong CLV` };
      if (movement <= -1) return { vote: 'yes', confidence: 76, edge: 0.06, reason: `CLV: Line moved ${movement} — positive CLV signal` };
      if (movement <= -halfPoint) return { vote: 'yes', confidence: 65, edge: 0.03, reason: `CLV: Slight CLV advantage (${movement})` };
      if (movement >= 2)  return { vote: 'no',  confidence: 83, edge: 0.08, reason: `CLV: Line moved +${movement} against home — negative CLV` };
      if (movement >= 1)  return { vote: 'no',  confidence: 72, edge: 0.05, reason: `CLV: Line shifted against home` };
      return { vote: 'neu', confidence: 53, edge: 0, reason: 'CLV: Line stable — no CLV edge' };
    },

    // ── 6. STEAM MOVE DETECTOR ──
    // Rapid coordinated sharp syndicate action
    steamMoveDetector(game, espn) {
      const hist = getLineHistory(game.id);
      if (!hist?.spread) return { vote: 'neu', confidence: 50, edge: 0, reason: 'Steam: No opening line' };

      const open    = hist.spread;
      const current = game._spread;
      if (current === null) return { vote: 'neu', confidence: 50, edge: 0, reason: 'Steam: No current line' };

      const diff     = Math.abs(current - open);
      const timeNow  = new Date();
      const gameTime = new Date(game.commence_time);
      const hoursOut = (gameTime - timeNow) / 3600000;

      // Steam is most significant when rapid and within 48 hours
      if (diff >= 2 && hoursOut <= 48) {
        return { vote: 'yes', confidence: 86, edge: 0.10, reason: `Steam: ${diff}pt rapid move ${hoursOut.toFixed(0)}hrs to game — syndicate signal` };
      }
      if (diff >= 1.5 && hoursOut <= 24) {
        return { vote: 'yes', confidence: 80, edge: 0.08, reason: `Steam: ${diff}pt late move — sharp steam detected` };
      }
      if (diff >= 1) {
        return { vote: 'yes', confidence: 68, edge: 0.05, reason: `Steam: ${diff}pt line move — possible steam` };
      }
      return { vote: 'neu', confidence: 50, edge: 0, reason: 'Steam: No steam move detected' };
    },

    // ── 7. REVERSE LINE MOVEMENT (RLM) ──
    // Line moves opposite to public — sharpest signal in betting
    reverseLineMovement(game, espn) {
      const hist = getLineHistory(game.id);
      if (!hist) return { vote: 'neu', confidence: 50, edge: 0, reason: 'RLM: No data available' };

      const publicPct  = hist.public_pct || 50;
      const open       = hist.spread;
      const current    = game._spread;
      if (!open || current === null) return { vote: 'neu', confidence: 50, edge: 0, reason: 'RLM: Missing line data' };

      const lineMove = current - open;
      // Public heavily on home but line moved away from home = RLM
      const publicOnHome = publicPct > 60;
      const lineAgainstPublic = (publicOnHome && lineMove > 0.5) || (!publicOnHome && lineMove < -0.5);

      if (publicPct >= 70 && lineAgainstPublic) {
        return { vote: publicOnHome ? 'no' : 'yes', confidence: 84, edge: 0.09, reason: `RLM: ${publicPct}% public on home but line moved opposite — elite sharp signal` };
      }
      if (publicPct >= 60 && lineAgainstPublic) {
        return { vote: publicOnHome ? 'no' : 'yes', confidence: 74, edge: 0.06, reason: `RLM: ${publicPct}% public, line moved against them` };
      }
      return { vote: 'neu', confidence: 51, edge: 0, reason: 'RLM: No reverse line movement detected' };
    },

    // ── 8. PACE & TEMPO ANALYSIS ──
    // Possessions per game drives totals edge
    paceTempoAnalysis(game, espn) {
      const total = game._total;
      if (!total) return { vote: 'neu', confidence: 50, edge: 0, reason: 'Pace: No total data' };

      const sport = game._sport;
      const events = espn?.events || [];
      let avgScore = 0, count = 0;

      events.slice(0, 10).forEach(e => {
        const comp = e.competitions?.[0];
        const scores = comp?.competitors?.map(c => parseInt(c.score || 0)) || [];
        const gameTotal = scores.reduce((a, b) => a + b, 0);
        if (gameTotal > 0) { avgScore += gameTotal; count++; }
      });

      if (count < 3) return { vote: 'neu', confidence: 50, edge: 0, reason: 'Pace: Insufficient scoring history' };

      const avgTotal = avgScore / count;
      const diff     = ((total - avgTotal) / avgTotal) * 100;

      // Total set significantly higher/lower than recent averages = edge
      if (diff > 5) return { vote: 'no', confidence: Math.min(60 + diff, 82), edge: diff/100, reason: `Pace: Total ${total} is ${diff.toFixed(1)}% above avg — lean under` };
      if (diff < -5) return { vote: 'yes', confidence: Math.min(60 + Math.abs(diff), 80), edge: Math.abs(diff)/100, reason: `Pace: Total ${total} is ${Math.abs(diff).toFixed(1)}% below avg — lean over` };
      return { vote: 'neu', confidence: 51, edge: 0, reason: `Pace: Total ${total} near historical average` };
    },

    // ── 9. STRENGTH OF SCHEDULE (SOS) ──
    // Adjusts performance metrics for opponent quality
    strengthOfSchedule(game, espn) {
      const events = espn?.events || [];
      const homeTeam = game.home_team;
      let totalOppScore = 0, count = 0;

      events.slice(0, 8).forEach(e => {
        const comp = e.competitions?.[0];
        if (!comp) return;
        const home = comp.competitors?.find(c => c.homeAway === 'home');
        const away = comp.competitors?.find(c => c.homeAway === 'away');
        if (!home || !away) return;
        // Track opponent scores as proxy for opponent quality
        if (home.team?.displayName === homeTeam) {
          totalOppScore += parseInt(away.score || 0);
          count++;
        }
      });

      if (count < 3) return { vote: 'neu', confidence: 50, edge: 0, reason: 'SOS: Insufficient schedule data' };

      const avgOppScore = totalOppScore / count;
      const spread = game._spread || 0;

      // High opponent average score = tough schedule = undervalued team
      if (avgOppScore > 28 && game._sport === 'NFL') {
        return { vote: 'yes', confidence: 66, edge: 0.04, reason: `SOS: Tough schedule (avg opp ${avgOppScore.toFixed(0)} pts) — team undervalued` };
      }
      if (avgOppScore > 110 && game._sport === 'NBA') {
        return { vote: 'yes', confidence: 64, edge: 0.03, reason: `SOS: High opp avg ${avgOppScore.toFixed(0)} — battled-tested edge` };
      }
      return { vote: 'neu', confidence: 51, edge: 0, reason: `SOS: Average opponent quality detected` };
    },

    // ── 10. REST & RECOVERY INDEX ──
    // Days rest is one of the most quantifiable edges in sports betting
    restRecoveryIndex(game, espn) {
      const events = espn?.events || [];
      const now     = new Date();
      const gameDate = new Date(game.commence_time);

      // Find last game date from ESPN
      let lastGameDate = null;
      if (events.length > 0) {
        const lastEvent = events[0];
        const dateStr = lastEvent.date;
        if (dateStr) lastGameDate = new Date(dateStr);
      }

      if (!lastGameDate) return { vote: 'neu', confidence: 50, edge: 0, reason: 'Rest: No schedule data from ESPN' };

      const daysRest = Math.round((gameDate - lastGameDate) / 86400000);

      if (daysRest === 0) return { vote: 'no', confidence: 72, edge: 0.05, reason: 'Rest: Back-to-back — significant fatigue factor' };
      if (daysRest === 1) return { vote: 'no', confidence: 62, edge: 0.03, reason: 'Rest: Only 1 day rest — mild fatigue concern' };
      if (daysRest >= 5)  return { vote: 'yes', confidence: 70, edge: 0.05, reason: `Rest: ${daysRest} days rest — fully recovered, motivated` };
      if (daysRest >= 3)  return { vote: 'yes', confidence: 60, edge: 0.02, reason: `Rest: ${daysRest} days rest — adequate recovery` };
      return { vote: 'neu', confidence: 52, edge: 0, reason: `Rest: ${daysRest} days — neutral rest factor` };
    },

    // ── 11. TRAVEL FATIGUE MODEL ──
    // Cross-timezone travel degrades performance measurably
    travelFatigueModel(game, espn) {
      const sport    = game._sport;
      const homeTeam = game.home_team;
      const awayTeam = game.away_team;

      // Time zone estimation by city name keywords
      const eastCities  = ['Boston','New York','Brooklyn','Philadelphia','Toronto','Miami','Orlando','Atlanta','Charlotte','Washington','Cleveland','Indiana','Detroit','Milwaukee'];
      const westCities  = ['Los Angeles','Golden State','Portland','Sacramento','Phoenix','Utah','Denver','Dallas','Houston','San Antonio','Oklahoma','New Orleans','Minnesota'];
      const centralCities = ['Chicago','Memphis','New Orleans','Minnesota','Milwaukee','Dallas','Houston','San Antonio','Oklahoma'];

      const getZone = (team) => {
        if (eastCities.some(c => team.includes(c.split(' ')[0]))) return 'east';
        if (westCities.some(c => team.includes(c.split(' ')[0]))) return 'west';
        if (centralCities.some(c => team.includes(c.split(' ')[0]))) return 'central';
        return 'unknown';
      };

      const homeZone = getZone(homeTeam);
      const awayZone = getZone(awayTeam);

      if (homeZone === 'unknown' || awayZone === 'unknown') {
        return { vote: 'neu', confidence: 50, edge: 0, reason: 'Travel: Unable to determine travel zones' };
      }
      if (homeZone === awayZone) {
        return { vote: 'neu', confidence: 51, edge: 0, reason: 'Travel: Same timezone — no travel edge' };
      }

      const crossCountry = (homeZone === 'east' && awayZone === 'west') || (homeZone === 'west' && awayZone === 'east');
      if (crossCountry) {
        return { vote: 'yes', confidence: 68, edge: 0.04, reason: `Travel: Away team cross-country — home team significant advantage` };
      }
      return { vote: 'yes', confidence: 59, edge: 0.02, reason: 'Travel: Timezone shift for away team — home edge' };
    },

    // ── 12. WEATHER IMPACT MODEL ──
    // Outdoor sports: wind kills passing games, cold kills scoring
    weatherImpactModel(game, espn) {
      const sport = game._sport;
      const indoor = ['NBA','NHL','NCAAB'];
      if (indoor.includes(sport)) {
        return { vote: 'neu', confidence: 50, edge: 0, reason: 'Weather: Indoor sport — irrelevant' };
      }

      const total = game._total;
      if (!total) return { vote: 'neu', confidence: 50, edge: 0, reason: 'Weather: No total to assess' };

      const gameDate = new Date(game.commence_time);
      const month    = gameDate.getMonth(); // 0=Jan

      // NFL: Oct-Jan outdoor games in cold markets
      if (sport === 'NFL') {
        const coldMonth = month >= 9 || month <= 1;
        const coldMarkets = ['Green Bay','Chicago','Cleveland','Buffalo','New England','New York','Philadelphia','Pittsburgh','Minnesota','Kansas City'];
        const inColdMarket = coldMarkets.some(m => game.home_team.includes(m.split(' ')[0]));

        if (coldMonth && inColdMarket) {
          return { vote: 'no', confidence: 72, edge: 0.06, reason: `Weather: Cold market in ${['Oct','Nov','Dec','Jan','Feb'][month-9] || 'winter'} — under lean` };
        }
      }

      // MLB: April/May = cold, ball doesn't carry
      if (sport === 'MLB' && (month <= 4)) {
        return { vote: 'no', confidence: 65, edge: 0.04, reason: 'Weather: Early season cold — under edge' };
      }

      return { vote: 'neu', confidence: 51, edge: 0, reason: 'Weather: No significant weather factor' };
    },
  };
  // END PART 1 — CONTINUES IN PART 2

  return { _part: 1, ALGORITHMS, SPORT_WEIGHTS, kellyUnits, oddsToProb, fetchGames, fetchESPN, loadAlgoSettings, getLineHistory, saveLineSnapshot, getVal, startAuto, stopAuto };

})();
