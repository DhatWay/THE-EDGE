// ============================================================
// EDGE — CONTEXT BUILDER v5.0
//
// Supplies line history, rest, travel, weather, injuries,
// ATS form and head-to-head for a slate.
//
// v5.0 changes:
//
//   · Team names are resolved through team-aliases.js before
//     any ATS or head-to-head lookup. The old code queried
//     team_ats and matchup_ats by the game's own team name —
//     which is The Odds API's spelling — against rows written
//     by ats-tracker with ESPN's spelling. Any team spelled
//     differently got no ATS or H2H data. Every lookup now
//     goes through EDGE_TEAMS.normalize.
//
//   · ATS and H2H are loaded once per sport, indexed locally,
//     and matched against normalized names. The old code
//     queried with team_name=in.(...) using raw names; the
//     new code fetches the sport's whole table (a few hundred
//     rows) and joins in memory.
//
//   · The schedule fetch goes day by day over the last 60
//     days, not by year with limit=1000. A full MLB year is
//     2,430 games; the old fetch truncated at 1,000 and lost
//     more than half the season. Rest days, travel type and
//     road-trip length were computed on a partial schedule.
//     60 single-day calls, cacheable per (sport, date), cover
//     exactly the window the rest calculation needs.
//
//   · The 60-day window no longer starts at Jan 1. A January
//     game now correctly sees December games behind it. The
//     old year-boundary logic lost every December game from
//     January's perspective.
//
//   · Travel uses a resolver. The stadium table is expanded
//     to cover WNBA, MLS and a representative set of college
//     teams, and match now goes through a normalized lookup
//     so "LA Clippers" and "Los Angeles Clippers" land on the
//     same coordinate.
//
//   · Weather cache and schedule cache are kept. The schedule
//     cache is now keyed per (path, date) instead of per
//     (path, year) since the fetch is per-day.
// ============================================================

const EDGE_CONTEXT = (() => {

  const BUILD = 'ctx-20260925-01';

  const SUPABASE_URL = () => localStorage.getItem('edge_supabase_url');
  const SUPABASE_KEY = () => localStorage.getItem('edge_supabase_key');

  const ESPN_MAP = {
    NFL:   'football/nfl',
    NCAAF: 'football/college-football',
    NBA:   'basketball/nba',
    WNBA:  'basketball/wnba',
    NCAAB: 'basketball/mens-college-basketball',
    MLB:   'baseball/mlb',
    NHL:   'hockey/nhl',
    MLS:   'soccer/usa.1',
  };

  const REST_LOOKBACK_DAYS = 60;
  const SCHEDULE_CONCURRENCY = 6;

  const WEATHER_TTL_MS = 12 * 60 * 60 * 1000;
  const WEATHER_CACHE_KEY = 'edge_weather_cache_v1';
  const WEATHER_CACHE_MAX = 400;

  const SCHEDULE_TTL_MS = 24 * 60 * 60 * 1000;
  const SCHEDULE_CACHE_KEY = 'edge_schedule_cache_v2';
  const SCHEDULE_CACHE_MAX = 600;

  const SESSION_TTL_MS = 5 * 60 * 1000;
  const sessionMemo = new Map();

  function logEdgeError(where, err) {
    try {
      const list = JSON.parse(localStorage.getItem('edge_errors') || '[]');
      list.unshift({ t: Date.now(), where, msg: err && err.message ? err.message : String(err) });
      localStorage.setItem('edge_errors', JSON.stringify(list.slice(0, 50)));
    } catch {}
  }

  // ============================================================
  // ── STADIUM COORDINATES ──
  //
  // Canonical names. resolveCoord() normalizes the incoming
  // team name and matches against a normalized index of these
  // keys, so "LA Clippers" and "Los Angeles Clippers" both
  // find the same row.
  // ============================================================

  const TEAM_CITIES = {
    // NFL
    'Arizona Cardinals': [33.5276, -112.2626],
    'Atlanta Falcons': [33.7554, -84.4008],
    'Baltimore Ravens': [39.2780, -76.6227],
    'Buffalo Bills': [42.7738, -78.7870],
    'Carolina Panthers': [35.2258, -80.8528],
    'Chicago Bears': [41.8623, -87.6167],
    'Cincinnati Bengals': [39.0954, -84.5160],
    'Cleveland Browns': [41.5061, -81.6995],
    'Dallas Cowboys': [32.7473, -97.0945],
    'Denver Broncos': [39.7439, -105.0201],
    'Detroit Lions': [42.3400, -83.0456],
    'Green Bay Packers': [44.5013, -88.0622],
    'Houston Texans': [29.6847, -95.4107],
    'Indianapolis Colts': [39.7601, -86.1639],
    'Jacksonville Jaguars': [30.3239, -81.6373],
    'Kansas City Chiefs': [39.0489, -94.4839],
    'Las Vegas Raiders': [36.0909, -115.1833],
    'Los Angeles Chargers': [33.9535, -118.3392],
    'Los Angeles Rams': [33.9535, -118.3392],
    'Miami Dolphins': [25.9580, -80.2389],
    'Minnesota Vikings': [44.9737, -93.2575],
    'New England Patriots': [42.0909, -71.2643],
    'New Orleans Saints': [29.9509, -90.0812],
    'New York Giants': [40.8135, -74.0745],
    'New York Jets': [40.8135, -74.0745],
    'Philadelphia Eagles': [39.9008, -75.1675],
    'Pittsburgh Steelers': [40.4468, -80.0158],
    'San Francisco 49ers': [37.4033, -121.9694],
    'Seattle Seahawks': [47.5952, -122.3316],
    'Tampa Bay Buccaneers': [27.9759, -82.5033],
    'Tennessee Titans': [36.1665, -86.7713],
    'Washington Commanders': [38.9077, -77.0728],

    // NBA
    'Atlanta Hawks': [33.7573, -84.3963],
    'Boston Celtics': [42.3662, -71.0621],
    'Brooklyn Nets': [40.6826, -73.9754],
    'Charlotte Hornets': [35.2251, -80.8392],
    'Chicago Bulls': [41.8807, -87.6742],
    'Cleveland Cavaliers': [41.4965, -81.6882],
    'Dallas Mavericks': [32.7905, -96.8103],
    'Denver Nuggets': [39.7487, -105.0077],
    'Detroit Pistons': [42.3411, -83.0553],
    'Golden State Warriors': [37.7680, -122.3877],
    'Houston Rockets': [29.7508, -95.3621],
    'Indiana Pacers': [39.7638, -86.1555],
    'Los Angeles Clippers': [34.0430, -118.2673],
    'Los Angeles Lakers': [34.0430, -118.2673],
    'Memphis Grizzlies': [35.1382, -90.0506],
    'Miami Heat': [25.7814, -80.1870],
    'Milwaukee Bucks': [43.0450, -87.9168],
    'Minnesota Timberwolves': [44.9795, -93.2761],
    'New Orleans Pelicans': [29.9490, -90.0821],
    'New York Knicks': [40.7505, -73.9934],
    'Oklahoma City Thunder': [35.4634, -97.5151],
    'Orlando Magic': [28.5392, -81.3839],
    'Philadelphia 76ers': [39.9012, -75.1720],
    'Phoenix Suns': [33.4457, -112.0712],
    'Portland Trail Blazers': [45.5316, -122.6668],
    'Sacramento Kings': [38.5802, -121.4997],
    'San Antonio Spurs': [29.4270, -98.4375],
    'Toronto Raptors': [43.6435, -79.3791],
    'Utah Jazz': [40.7683, -111.9011],
    'Washington Wizards': [38.8981, -77.0209],

    // WNBA
    'Atlanta Dream': [33.7573, -84.3963],
    'Chicago Sky': [41.8807, -87.6742],
    'Connecticut Sun': [41.4904, -72.0912],
    'Dallas Wings': [32.7473, -97.0945],
    'Indiana Fever': [39.7638, -86.1555],
    'Las Vegas Aces': [36.0909, -115.1833],
    'Los Angeles Sparks': [34.0430, -118.2673],
    'Minnesota Lynx': [44.9795, -93.2761],
    'New York Liberty': [40.6826, -73.9754],
    'Phoenix Mercury': [33.4457, -112.0712],
    'Seattle Storm': [47.6221, -122.3540],
    'Washington Mystics': [38.8981, -77.0209],
    'Golden State Valkyries': [37.7680, -122.3877],

    // MLB
    'Arizona Diamondbacks': [33.4455, -112.0667],
    'Atlanta Braves': [33.8908, -84.4678],
    'Baltimore Orioles': [39.2840, -76.6217],
    'Boston Red Sox': [42.3467, -71.0972],
    'Chicago Cubs': [41.9484, -87.6553],
    'Chicago White Sox': [41.8299, -87.6338],
    'Cincinnati Reds': [39.0979, -84.5082],
    'Cleveland Guardians': [41.4962, -81.6852],
    'Colorado Rockies': [39.7559, -104.9942],
    'Detroit Tigers': [42.3390, -83.0485],
    'Houston Astros': [29.7573, -95.3555],
    'Kansas City Royals': [39.0517, -94.4803],
    'Los Angeles Angels': [33.8003, -117.8827],
    'Los Angeles Dodgers': [34.0739, -118.2400],
    'Miami Marlins': [25.7781, -80.2197],
    'Milwaukee Brewers': [43.0280, -87.9712],
    'Minnesota Twins': [44.9817, -93.2778],
    'New York Mets': [40.7571, -73.8458],
    'New York Yankees': [40.8296, -73.9262],
    'Athletics': [38.5804, -121.5088],
    'Philadelphia Phillies': [39.9061, -75.1665],
    'Pittsburgh Pirates': [40.4469, -80.0058],
    'San Diego Padres': [32.7076, -117.1570],
    'San Francisco Giants': [37.7786, -122.3893],
    'Seattle Mariners': [47.5914, -122.3325],
    'St. Louis Cardinals': [38.6226, -90.1928],
    'Tampa Bay Rays': [27.7682, -82.6534],
    'Texas Rangers': [32.7474, -97.0825],
    'Toronto Blue Jays': [43.6414, -79.3894],
    'Washington Nationals': [38.8730, -77.0074],

    // NHL
    'Anaheim Ducks': [33.8078, -117.8768],
    'Boston Bruins': [42.3662, -71.0621],
    'Buffalo Sabres': [42.8750, -78.8765],
    'Calgary Flames': [51.0374, -114.0519],
    'Carolina Hurricanes': [35.8033, -78.7219],
    'Chicago Blackhawks': [41.8807, -87.6742],
    'Colorado Avalanche': [39.7487, -105.0077],
    'Columbus Blue Jackets': [39.9692, -83.0060],
    'Dallas Stars': [32.7905, -96.8103],
    'Detroit Red Wings': [42.3411, -83.0553],
    'Edmonton Oilers': [53.5469, -113.4977],
    'Florida Panthers': [26.1585, -80.3255],
    'Los Angeles Kings': [34.0430, -118.2673],
    'Minnesota Wild': [44.9444, -93.1013],
    'Montreal Canadiens': [45.4961, -73.5693],
    'Nashville Predators': [36.1592, -86.7785],
    'New Jersey Devils': [40.7336, -74.1710],
    'New York Islanders': [40.7228, -73.5901],
    'New York Rangers': [40.7505, -73.9934],
    'Ottawa Senators': [45.4215, -75.6947],
    'Philadelphia Flyers': [39.9012, -75.1720],
    'Pittsburgh Penguins': [40.4395, -79.9893],
    'San Jose Sharks': [37.3327, -121.9014],
    'Seattle Kraken': [47.6221, -122.3540],
    'St. Louis Blues': [38.6323, -90.2009],
    'Tampa Bay Lightning': [27.9427, -82.4519],
    'Toronto Maple Leafs': [43.6435, -79.3791],
    'Utah Hockey Club': [40.7683, -111.9011],
    'Vancouver Canucks': [49.2778, -123.1087],
    'Vegas Golden Knights': [36.1029, -115.1781],
    'Washington Capitals': [38.8981, -77.0209],
    'Winnipeg Jets': [49.8927, -97.1437],

    // MLS
    'Atlanta United FC': [33.7554, -84.4008],
    'Austin FC': [30.2672, -97.7431],
    'Charlotte FC': [35.2258, -80.8528],
    'Chicago Fire FC': [41.8623, -87.6167],
    'FC Cincinnati': [39.0954, -84.5160],
    'Colorado Rapids': [39.8055, -104.9716],
    'Columbus Crew': [39.9692, -83.0060],
    'FC Dallas': [33.1523, -96.8378],
    'D.C. United': [38.9077, -77.0728],
    'Houston Dynamo FC': [29.7508, -95.3621],
    'Sporting Kansas City': [39.1217, -94.8231],
    'LA Galaxy': [33.8644, -118.2611],
    'Los Angeles FC': [34.0127, -118.2848],
    'Inter Miami CF': [25.9580, -80.2389],
    'Minnesota United FC': [44.9737, -93.2575],
    'CF Montreal': [45.5613, -73.5780],
    'Nashville SC': [36.1665, -86.7713],
    'New England Revolution': [42.0909, -71.2643],
    'New York City FC': [40.8296, -73.9262],
    'New York Red Bulls': [40.7369, -74.1503],
    'Orlando City SC': [28.5392, -81.3839],
    'Philadelphia Union': [39.8318, -75.3777],
    'Portland Timbers': [45.5215, -122.6917],
    'Real Salt Lake': [40.5829, -111.8933],
    'San Jose Earthquakes': [37.3506, -121.9269],
    'Seattle Sounders FC': [47.5952, -122.3316],
    'St. Louis City SC': [38.6323, -90.2009],
    'Toronto FC': [43.6333, -79.4186],
    'Vancouver Whitecaps FC': [49.2778, -123.1087],
  };

  // Alias map for teams whose canonical entry differs from
  // what an upstream might send. Keyed by normalized form,
  // value is the canonical key in TEAM_CITIES.
  const CITY_ALIASES = {
    'laclippers': 'Los Angeles Clippers',
    'lalakers': 'Los Angeles Lakers',
    'utahhockeyclub': 'Utah Hockey Club',
    'arizonacoyotes': 'Utah Hockey Club',
    'oaklandathletics': 'Athletics',
    'lasvegasathletics': 'Athletics',
    'stlouisrams': 'Los Angeles Rams',
    'sandiegochargers': 'Los Angeles Chargers',
    'oaklandraiders': 'Las Vegas Raiders',
    'washingtoredskins': 'Washington Commanders',
    'washingtonfootballteam': 'Washington Commanders',
  };

  // Normalized city index built once on first use.
  let _cityIndex = null;
  function cityIndex() {
    if (_cityIndex) return _cityIndex;
    _cityIndex = {};
    const strip = s => String(s || '').toLowerCase().replace(/[^a-z0-9]/g, '');
    Object.entries(TEAM_CITIES).forEach(([name, coord]) => {
      _cityIndex[strip(name)] = { name, coord };
    });
    Object.entries(CITY_ALIASES).forEach(([alias, canonical]) => {
      const c = TEAM_CITIES[canonical];
      if (c) _cityIndex[alias] = { name: canonical, coord: c };
    });
    return _cityIndex;
  }

  function resolveCoord(teamName) {
    if (!teamName) return null;
    const key = String(teamName).toLowerCase().replace(/[^a-z0-9]/g, '');
    const hit = cityIndex()[key];
    return hit ? hit.coord : null;
  }

  const DOMED_HOMES = new Set([
    'Arizona Cardinals', 'Atlanta Falcons', 'Dallas Cowboys', 'Detroit Lions',
    'Houston Texans', 'Indianapolis Colts', 'Las Vegas Raiders', 'Los Angeles Chargers',
    'Los Angeles Rams', 'Minnesota Vikings', 'New Orleans Saints',
    'Arizona Diamondbacks', 'Houston Astros', 'Miami Marlins', 'Milwaukee Brewers',
    'Seattle Mariners', 'Texas Rangers', 'Toronto Blue Jays', 'Tampa Bay Rays',
    'Atlanta Dream', 'Chicago Sky', 'Connecticut Sun', 'Dallas Wings',
    'Indiana Fever', 'Las Vegas Aces', 'Los Angeles Sparks', 'Minnesota Lynx',
    'New York Liberty', 'Phoenix Mercury', 'Seattle Storm', 'Washington Mystics',
    'Golden State Valkyries',
  ]);

  return {
    BUILD,
    buildContext,
    computeRestDays,
    computeTravelMiles,
    clearCache,
    cacheStats,
    TEAM_CITIES,
  };

  // ============================================================
  // ── MAIN ──
  // ============================================================

  async function buildContext(games) {
    const ctx = {
      lineHistoryByGame: {},
      restByTeam: {},
      practiceDaysByTeam: {},
      travelTypeByTeam: {},
      roadTripLengthByTeam: {},
      travelByGame: {},
      weatherByGame: {},
      injuriesByGame: {},
      atsByTeam: {},
      h2hByGame: {},
      loadedAt: new Date().toISOString(),
    };

    if (!Array.isArray(games) || !games.length) return ctx;

    const memoKey = memoKeyFor(games);
    const memoEntry = sessionMemo.get(memoKey);
    if (memoEntry && Date.now() - memoEntry.t < SESSION_TTL_MS) {
      const replayed = cloneContext(memoEntry.ctx);
      replayed._cache = { session_hit: true, from: memoEntry.t };
      return replayed;
    }

    const [lineHistory, schedule, weather, injuries, trends] = await Promise.all([
      loadLineHistory(games).catch(() => ({})),
      loadScheduleContext(games).catch(() => ({})),
      loadWeather(games).catch(() => ({ data: {}, stats: { hits: 0, misses: 0 } })),
      loadInjuries(games).catch(() => ({})),
      loadTrends(games).catch(() => ({ atsByTeam: {}, h2hByGame: {} })),
    ]);

    ctx.lineHistoryByGame = lineHistory;
    ctx.restByTeam = schedule.restByTeam || {};
    ctx.practiceDaysByTeam = schedule.practiceDaysByTeam || {};
    ctx.travelTypeByTeam = schedule.travelTypeByTeam || {};
    ctx.roadTripLengthByTeam = schedule.roadTripLengthByTeam || {};
    ctx.weatherByGame = weather.data || {};
    ctx.injuriesByGame = injuries;
    ctx.atsByTeam = trends.atsByTeam || {};
    ctx.h2hByGame = trends.h2hByGame || {};

    // Travel. resolveCoord handles aliases and normalized
    // matches, so 'LA Clippers' and 'Los Angeles Clippers' both
    // find the same coordinate.
    let travelMisses = 0;
    games.forEach(g => {
      const home = g.home_team || g.home;
      const away = g.away_team || g.away;
      const hc = resolveCoord(home);
      const ac = resolveCoord(away);
      if (!hc || !ac) { travelMisses++; return; }
      ctx.travelByGame[g.id] = {
        miles: Math.round(haversine(hc, ac)),
        timezones: estimateTimezoneShift(ac, hc),
      };
    });

    ctx._cache = {
      session_hit: false,
      weather: weather.stats || { hits: 0, misses: 0 },
      schedule: schedule.stats || { hits: 0, misses: 0 },
      travel_misses: travelMisses,
    };

    sessionMemo.set(memoKey, { t: Date.now(), ctx: cloneContext(ctx) });
    if (sessionMemo.size > 8) {
      const oldest = [...sessionMemo.entries()].sort((a, b) => a[1].t - b[1].t)[0];
      if (oldest) sessionMemo.delete(oldest[0]);
    }

    return ctx;
  }

  function memoKeyFor(games) {
    const ids = games.map(g => g.id || g.game_id || '').sort();
    return ids.join('|');
  }

  function cloneContext(ctx) {
    try { return JSON.parse(JSON.stringify(ctx)); }
    catch { return ctx; }
  }

  // ============================================================
  // ── LINE HISTORY ──
  // ============================================================

  async function loadLineHistory(games) {
    const url = SUPABASE_URL();
    const key = SUPABASE_KEY();
    const out = {};
    if (!url || !key) return out;

    const gameIds = games.map(g => g.id).filter(Boolean);
    if (!gameIds.length) return out;

    const headers = { apikey: key, Authorization: `Bearer ${key}` };
    const inList = gameIds.map(id => `"${id}"`).join(',');

    const selects = [
      'game_id,spread,total,ml,public_pct,sharp_pct,created_at',
      'game_id,spread,total,ml,created_at',
    ];

    let rows = null;
    for (const select of selects) {
      try {
        const res = await fetch(
          `${url}/rest/v1/line_history?select=${select}&game_id=in.(${inList})&order=created_at.asc`,
          { headers }
        );
        if (res.ok) { rows = await res.json(); break; }
      } catch (e) { logEdgeError('context.lineHistory', e); }
    }
    if (!rows) return out;

    const perGame = {};
    rows.forEach(r => {
      if (!perGame[r.game_id]) perGame[r.game_id] = { open: r, latest: r };
      else perGame[r.game_id].latest = r;
    });

    Object.entries(perGame).forEach(([gid, h]) => {
      const open = h.open.spread;
      const current = h.latest.spread;
      const moved = open != null && current != null && open !== current;
      out[gid] = {
        open_spread: open,
        current_spread: current,
        open_total: h.open.total,
        current_total: h.latest.total,
        movement: moved ? (current - open) : 0,
        public_pct: h.latest.public_pct ?? null,
        sharp_pct: h.latest.sharp_pct ?? null,
      };
    });

    return out;
  }

  // ============================================================
  // ── SCHEDULE (rest days) ──
  //
  // Fetches every day in the last REST_LOOKBACK_DAYS by
  // single-date query. A full-season fetch capped at limit=1000
  // truncated MLB (2,430 games), NBA (1,300), NHL (1,300) and
  // NCAAB (5,000+) — rest days and road-trip length were
  // computed on a partial schedule for exactly those sports.
  //
  // 60 single-day calls per sport, cached per (path, date).
  // The window is anchored to today, not to January 1, so a
  // January game sees December games behind it.
  // ============================================================

  async function loadScheduleContext(games) {
    const out = {
      restByTeam: {},
      practiceDaysByTeam: {},
      travelTypeByTeam: {},
      roadTripLengthByTeam: {},
      stats: { hits: 0, misses: 0 },
    };

    const sports = Array.from(new Set(
      games.map(g => g._sport || g.sport).filter(s => s && ESPN_MAP[s])
    ));
    if (!sports.length) return out;

    const now = new Date();
    const dates = [];
    for (let i = 0; i < REST_LOOKBACK_DAYS; i++) {
      dates.push(new Date(now.getTime() - i * 86400000));
    }

    // Build the schedule by fetching each (sport, date) once.
    const schedules = {};
    await Promise.all(sports.map(async sport => {
      const path = ESPN_MAP[sport];
      const perDate = await Promise.all(dates.map(d =>
        getDaySchedule(path, d, sport).then(r => {
          if (r.hit) out.stats.hits++;
          else out.stats.misses++;
          return r.events;
        })
      ));

      const flat = [];
      perDate.forEach(events => { flat.push(...events); });
      flat.sort((a, b) => new Date(a.date) - new Date(b.date));
      schedules[sport] = flat;
    }));

    games.forEach(g => {
      const sport = g._sport || g.sport;
      const when = new Date(g.commence_time || g.time);
      if (isNaN(when)) return;
      const schedule = schedules[sport] || [];

      [['home', g.home_team || g.home], ['away', g.away_team || g.away]].forEach(([side, team]) => {
        if (!team) return;
        const key = `${sport}:${team}`;

        // Resolve the game's team name against the schedule's
        // own team names, so Odds API spelling matches ESPN
        // spelling. Direct comparison failed for every team
        // whose name varies between the two sources.
        const teamNorm = normalizeTeam(sport, team);
        const prior = schedule
          .filter(e => new Date(e.date) < when)
          .filter(e => normalizeTeam(sport, e.home) === teamNorm || normalizeTeam(sport, e.away) === teamNorm)
          .slice(-5);

        if (!prior.length) return;

        const last = prior[prior.length - 1];
        const rest = Math.round((when - new Date(last.date)) / 86400000);
        if (rest < 0 || rest > 30) return;

        out.restByTeam[key] = rest;
        out.practiceDaysByTeam[key] = Math.max(0, rest - 1);

        const wasHome = normalizeTeam(sport, last.home) === teamNorm;
        const isHome = side === 'home';
        out.travelTypeByTeam[key] = wasHome
          ? (isHome ? 'home_to_home' : 'home_to_away')
          : (isHome ? 'away_to_home' : 'away_to_away');

        let roadTrip = 0;
        for (let i = prior.length - 1; i >= 0; i--) {
          if (normalizeTeam(sport, prior[i].home) === teamNorm) break;
          roadTrip++;
        }
        out.roadTripLengthByTeam[key] = roadTrip + (isHome ? 0 : 1);
      });
    });

    return out;
  }

  // Fetch one day's events for one sport. Cache per (path, date).
  async function getDaySchedule(path, date, sport) {
    const dateStr = fmtDate(date);
    const cacheKey = `${path}:${dateStr}`;
    const cache = readCache(SCHEDULE_CACHE_KEY);
    const entry = cache[cacheKey];

    if (entry && (Date.now() - entry.t) < SCHEDULE_TTL_MS) {
      return { events: entry.events, hit: true };
    }

    const events = await fetchEspnDay(path, dateStr, sport);
    cache[cacheKey] = { t: Date.now(), events };
    trimCache(cache, SCHEDULE_CACHE_MAX);
    writeCache(SCHEDULE_CACHE_KEY, cache);

    return { events, hit: false };
  }

  async function fetchEspnDay(path, dateStr, sport) {
    const group = /college-football/.test(path) ? 80
                : /college-basketball/.test(path) ? 50
                : null;

    const compact = dateStr.replace(/-/g, '');
    let url = `https://site.api.espn.com/apis/site/v2/sports/${path}/scoreboard?dates=${compact}&limit=200`;
    if (group) url += `&groups=${group}`;

    try {
      const res = await fetch(url, { cache: 'no-store' });
      if (res.headers.get('x-edge-offline') === '1') return [];
      if (!res.ok) return [];
      const data = await res.json();
      const out = [];
      (data.events || []).forEach(e => {
        const comp = e.competitions?.[0];
        if (!comp) return;
        if (comp.status?.type?.completed !== true) return;
        const h = comp.competitors?.find(c => c.homeAway === 'home');
        const a = comp.competitors?.find(c => c.homeAway === 'away');
        if (!h || !a) return;
        const hn = h.team?.displayName;
        const an = a.team?.displayName;
        if (!hn || !an) return;
        out.push({ date: e.date, home: hn, away: an });
      });
      return out;
    } catch (e) {
      logEdgeError('context.fetchEspnDay.' + path + '.' + dateStr, e);
      return [];
    }
  }

  // ============================================================
  // ── WEATHER ──
  // ============================================================

  async function loadWeather(games) {
    const stats = { hits: 0, misses: 0 };

    const targets = games.filter(g => {
      const sport = g._sport || g.sport;
      if (['NBA', 'NHL', 'NCAAB', 'WNBA'].includes(sport)) return false;
      const home = g.home_team || g.home;
      if (DOMED_HOMES.has(home)) return false;
      if (!resolveCoord(home)) return false;
      const when = new Date(g.commence_time || g.time);
      if (isNaN(when)) return false;
      const daysOut = (when - Date.now()) / 86400000;
      return daysOut >= -1 && daysOut <= 14;
    });

    if (!targets.length) return { data: {}, stats };

    const HOURLY = [
      'temperature_2m', 'apparent_temperature', 'relative_humidity_2m',
      'precipitation', 'rain', 'snowfall', 'precipitation_probability',
      'wind_speed_10m', 'wind_gusts_10m', 'wind_direction_10m',
    ].join(',');

    const groups = new Map();
    targets.forEach(g => {
      const home = g.home_team || g.home;
      const [lat, lon] = resolveCoord(home);
      const when = new Date(g.commence_time || g.time);
      const dayKey = `${when.getUTCFullYear()}-${String(when.getUTCMonth() + 1).padStart(2, '0')}-${String(when.getUTCDate()).padStart(2, '0')}`;
      const cacheKey = `${lat.toFixed(2)},${lon.toFixed(2)}@${dayKey}`;
      if (!groups.has(cacheKey)) {
        groups.set(cacheKey, { lat, lon, dayKey, games: [] });
      }
      groups.get(cacheKey).games.push(g);
    });

    const cache = readCache(WEATHER_CACHE_KEY);
    const data = {};

    await Promise.all([...groups.entries()].map(async ([cacheKey, group]) => {
      let hourly = null;

      const entry = cache[cacheKey];
      if (entry && (Date.now() - entry.t) < WEATHER_TTL_MS && entry.hourly) {
        hourly = entry.hourly;
        stats.hits++;
      } else {
        try {
          const res = await fetch(
            `https://api.open-meteo.com/v1/forecast` +
            `?latitude=${group.lat}&longitude=${group.lon}` +
            `&hourly=${HOURLY}` +
            `&temperature_unit=fahrenheit&wind_speed_unit=mph&precipitation_unit=inch` +
            `&timezone=UTC&forecast_days=16`
          );
          if (res.ok) {
            const payload = await res.json();
            if (payload?.hourly?.time?.length) {
              hourly = payload.hourly;
              cache[cacheKey] = { t: Date.now(), hourly };
              stats.misses++;
            }
          }
        } catch (e) {
          logEdgeError('context.weather.' + cacheKey, e);
        }
      }

      if (!hourly) return;

      group.games.forEach(g => {
        const w = extractHourly(hourly, new Date(g.commence_time || g.time));
        if (w) data[g.id] = w;
      });
    }));

    trimCache(cache, WEATHER_CACHE_MAX);
    writeCache(WEATHER_CACHE_KEY, cache);

    return { data, stats };
  }

  function extractHourly(hourly, when) {
    const times = hourly.time || [];
    if (!times.length) return null;

    let bestIdx = 0, bestGap = Infinity;
    for (let i = 0; i < times.length; i++) {
      const gap = Math.abs(new Date(times[i] + 'Z') - when);
      if (gap < bestGap) { bestGap = gap; bestIdx = i; }
    }
    if (bestGap > 6 * 3600000) return null;

    const num = (v, d = 0) => typeof v === 'number' ? Math.round(v * Math.pow(10, d)) / Math.pow(10, d) : null;
    const pick = k => num(hourly[k]?.[bestIdx]);
    const pickF = (k, d = 0) => num(hourly[k]?.[bestIdx], d);

    const temp = pick('temperature_2m');
    const windSpeed = pick('wind_speed_10m');
    const windGust = pick('wind_gusts_10m');
    const rainIn = pickF('rain', 3);
    const snowCm = pick('snowfall');

    const windEffect = (windSpeed != null && windGust != null)
      ? Math.round(windSpeed + (windGust - windSpeed) * 0.3)
      : windSpeed;

    return {
      temp_f: temp,
      feels_like_f: pick('apparent_temperature'),
      humidity: pick('relative_humidity_2m'),
      wind_mph: windSpeed,
      wind_gust_mph: windGust,
      wind_effect_mph: windEffect,
      wind_dir_deg: pick('wind_direction_10m'),
      precip_pct: pick('precipitation_probability'),
      rain_in: rainIn,
      snow_cm: snowCm,
      precip_type: (snowCm && snowCm > 0) ? 'snow' : (rainIn && rainIn > 0) ? 'rain' : 'none',
    };
  }

  // ============================================================
  // ── INJURIES ──
  // ============================================================

  async function loadInjuries(games) {
    if (window.EDGE_INJURY && typeof window.EDGE_INJURY.fragment === 'function') {
      try { return await window.EDGE_INJURY.fragment(games); }
      catch (e) { logEdgeError('context.injuries', e); return {}; }
    }
    return {};
  }

  // ============================================================
  // ── ATS + H2H ──
  //
  // Both tables are keyed on ESPN names. Games carry The Odds
  // API spelling. The lookup is normalized on both sides via
  // EDGE_TEAMS.normalize, and the row is stored against the
  // game's own name so downstream code — algorithms.js,
  // situations-engine.js — reads it without having to know
  // which spelling the row uses.
  // ============================================================

  async function loadTrends(games) {
    const out = { atsByTeam: {}, h2hByGame: {} };
    const url = SUPABASE_URL();
    const key = SUPABASE_KEY();
    if (!url || !key) return out;

    const gamesBySport = {};
    games.forEach(g => {
      const sport = g._sport || g.sport;
      if (!sport) return;
      if (!gamesBySport[sport]) gamesBySport[sport] = [];
      gamesBySport[sport].push(g);
    });

    for (const sport of Object.keys(gamesBySport)) {
      const sportGames = gamesBySport[sport];

      // ── ATS ──
      // Fetch the whole sport's table. Small — a few hundred
      // rows — and reliable.
      const atsRows = await fetchAll(
        `${url}/rest/v1/team_ats?sport=eq.${sport}&select=*&limit=1000`,
        key
      );

      const atsIndex = {};
      atsRows.forEach(r => {
        const k = normalizeTeam(sport, r.team_name);
        if (k) atsIndex[k] = r;
      });

      sportGames.forEach(g => {
        const home = g.home_team || g.home;
        const away = g.away_team || g.away;
        if (home) {
          const k = `${sport}:${home}`;
          const row = atsIndex[normalizeTeam(sport, home)];
          if (row) out.atsByTeam[k] = row;
        }
        if (away) {
          const k = `${sport}:${away}`;
          const row = atsIndex[normalizeTeam(sport, away)];
          if (row) out.atsByTeam[k] = row;
        }
      });

      // ── H2H ──
      // Same pattern: fetch the sport's table, build a
      // normalized pair index, resolve each game against it.
      const h2hRows = await fetchAll(
        `${url}/rest/v1/matchup_ats?sport=eq.${sport}&select=*&limit=5000`,
        key
      );

      const h2hIndex = {};
      h2hRows.forEach(r => {
        const a = normalizeTeam(sport, r.team_a);
        const b = normalizeTeam(sport, r.team_b);
        if (!a || !b) return;
        const [x, y] = [a, b].sort();
        h2hIndex[`${sport}:${x}|${y}`] = r;
      });

      sportGames.forEach(g => {
        const home = g.home_team || g.home;
        const away = g.away_team || g.away;
        if (!home || !away) return;
        const a = normalizeTeam(sport, home);
        const b = normalizeTeam(sport, away);
        if (!a || !b) return;
        const [x, y] = [a, b].sort();
        const match = h2hIndex[`${sport}:${x}|${y}`];
        if (match) out.h2hByGame[g.id] = match;
      });
    }

    return out;
  }

  async function fetchAll(url, key) {
    try {
      const res = await fetch(url, { headers: { apikey: key, Authorization: `Bearer ${key}` } });
      return res.ok ? await res.json() : [];
    } catch (e) {
      logEdgeError('context.fetchAll', e);
      return [];
    }
  }

  // Uses team-aliases.js when loaded. The fallback strips
  // punctuation and lowercases — less precise, but exact-match
  // games still resolve.
  function normalizeTeam(sport, name) {
    if (!name) return '';
    if (window.EDGE_TEAMS && typeof window.EDGE_TEAMS.normalize === 'function') {
      try { return window.EDGE_TEAMS.normalize(name, sport); }
      catch {}
    }
    return String(name).toLowerCase().replace(/[^a-z0-9]/g, '');
  }

  // ============================================================
  // ── CACHE HELPERS ──
  // ============================================================

  function readCache(storageKey) {
    try { return JSON.parse(localStorage.getItem(storageKey) || '{}'); }
    catch { return {}; }
  }

  function writeCache(storageKey, cache) {
    try {
      localStorage.setItem(storageKey, JSON.stringify(cache));
    } catch (e) {
      try {
        const keys = Object.keys(cache);
        if (keys.length > 8) {
          const kept = keys.sort((a, b) => (cache[b].t || 0) - (cache[a].t || 0)).slice(0, Math.floor(keys.length / 2));
          const shrunk = {};
          kept.forEach(k => { shrunk[k] = cache[k]; });
          localStorage.setItem(storageKey, JSON.stringify(shrunk));
        }
      } catch {}
    }
  }

  function trimCache(cache, max) {
    const keys = Object.keys(cache);
    if (keys.length <= max) return;
    keys.sort((a, b) => (cache[b].t || 0) - (cache[a].t || 0));
    keys.slice(max).forEach(k => { delete cache[k]; });
  }

  // ============================================================
  // ── PUBLIC CACHE MANAGEMENT ──
  // ============================================================

  function clearCache() {
    try { localStorage.removeItem(WEATHER_CACHE_KEY); } catch {}
    try { localStorage.removeItem(SCHEDULE_CACHE_KEY); } catch {}
    sessionMemo.clear();
    return { cleared: true };
  }

  function cacheStats() {
    const weather = readCache(WEATHER_CACHE_KEY);
    const schedule = readCache(SCHEDULE_CACHE_KEY);
    const now = Date.now();

    const fresh = (cache, ttl) => Object.values(cache).filter(e => e && (now - e.t) < ttl).length;

    return {
      weather: {
        entries: Object.keys(weather).length,
        fresh: fresh(weather, WEATHER_TTL_MS),
        ttl_hours: WEATHER_TTL_MS / 3600000,
      },
      schedule: {
        entries: Object.keys(schedule).length,
        fresh: fresh(schedule, SCHEDULE_TTL_MS),
        ttl_hours: SCHEDULE_TTL_MS / 3600000,
      },
      session_entries: sessionMemo.size,
      session_ttl_minutes: SESSION_TTL_MS / 60000,
    };
  }

  // ============================================================
  // ── HELPERS ──
  // ============================================================

  function computeRestDays(teamKey, restIndex) {
    if (!restIndex || typeof restIndex !== 'object') return null;
    return restIndex[teamKey] ?? null;
  }

  function computeTravelMiles(fromCity, toCity) {
    const a = resolveCoord(fromCity);
    const b = resolveCoord(toCity);
    if (!a || !b) return null;
    return Math.round(haversine(a, b));
  }

  function haversine(a, b) {
    const R = 3959;
    const toRad = d => d * Math.PI / 180;
    const dLat = toRad(b[0] - a[0]);
    const dLon = toRad(b[1] - a[1]);
    const lat1 = toRad(a[0]);
    const lat2 = toRad(b[0]);
    const x = Math.sin(dLat / 2) ** 2 + Math.cos(lat1) * Math.cos(lat2) * Math.sin(dLon / 2) ** 2;
    return 2 * R * Math.asin(Math.sqrt(x));
  }

  function estimateTimezoneShift(awayCoord, homeCoord) {
    return Math.round((homeCoord[1] - awayCoord[1]) / 15);
  }

  function fmtDate(d) {
    const y = d.getFullYear();
    const m = String(d.getMonth() + 1).padStart(2, '0');
    const day = String(d.getDate()).padStart(2, '0');
    return `${y}-${m}-${day}`;
  }

})();

if (typeof window !== 'undefined') window.EDGE_CONTEXT = EDGE_CONTEXT;