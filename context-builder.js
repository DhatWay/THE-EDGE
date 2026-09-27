// ============================================================
// EDGE — CONTEXT BUILDER v5.1
//
// Supplies line history, rest, travel, weather, injuries,
// ATS form and head-to-head for a slate.
//
// v5.1 changes:
//
//   · line_history is filtered by source. Both writers tag
//     their rows with the book the price came from, but the
//     reader was pulling every row for the game regardless
//     of source, so switching books on the Settings page
//     manufactured fake line movement — a snapshot from
//     DraftKings and a snapshot from FanDuel sat next to
//     each other as "open" and "current." The read now
//     filters to the currently active source. When the
//     source column is not yet present on the table, the
//     query falls back to the unfiltered shape and writes
//     one warning to edge_errors per sport per page load.
//
//   · Trends context is populated. The trends engine reads
//     prev result, prev margin, game of season, home game of
//     season, played-before, lost-last-meeting and season
//     progress from the game object and the context. None of
//     those were being set, so every "revenge," "opener,"
//     "after a loss," "off a bye" and "late season" rule
//     silently never matched a live game. Every field the
//     trends engine looks for is now computed and attached
//     directly to each game object, so parlay.html and the
//     supporting-trends panel on Today's Picks both light up.
//
//   · Per-date schedule cache TTL. Today's and yesterday's
//     scoreboards now expire after an hour instead of a full
//     day. The old fixed 24-hour TTL meant a fetch that ran
//     before a game finished kept serving a final score that
//     was still "in progress" the next morning, and back-to-
//     back detection for the following day's teams read from
//     the stale copy.
//
//   · Schedule fetch runs with the declared SCHEDULE_
//     CONCURRENCY. The constant existed but the fetch fired
//     every date at once — up to 60 parallel requests per
//     sport, eight sports, hundreds of calls from one tap.
//     Now capped at four concurrent.
//
//   · Line history query tries the source-filtered shape
//     first, then falls back. Two queries per game window in
//     the worst case, one per game in the common case.
// ============================================================

const EDGE_CONTEXT = (() => {

  const BUILD = 'ctx-20260926-01';

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
  const SCHEDULE_CONCURRENCY = 4;

  const WEATHER_TTL_MS = 12 * 60 * 60 * 1000;
  const WEATHER_CACHE_KEY = 'edge_weather_cache_v1';
  const WEATHER_CACHE_MAX = 400;

  // v4: preseason games are no longer cached as played games.
  const SCHEDULE_CACHE_KEY = 'edge_schedule_cache_v4';

  // Regular-season length, for season progress.
  const SEASON_LENGTH = { NFL: 17, NCAAF: 12, NBA: 82, WNBA: 44, NCAAB: 31, MLB: 162, NHL: 82, MLS: 34 };
  const SCHEDULE_CACHE_MAX = 900;

  const SESSION_TTL_MS = 5 * 60 * 1000;
  const sessionMemo = new Map();

  // Logged once per sport per page load, not per query, so a
  // missing source column does not flood edge_errors.
  const _warnedNoSource = new Set();

  function logEdgeError(where, err) {
    try {
      const list = JSON.parse(localStorage.getItem('edge_errors') || '[]');
      list.unshift({ t: Date.now(), where, msg: err && err.message ? err.message : String(err) });
      localStorage.setItem('edge_errors', JSON.stringify(list.slice(0, 50)));
    } catch {}
  }

  // ============================================================
  // ── STADIUM COORDINATES ──
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

  const CITY_ALIASES = {
    'laclippers': 'Los Angeles Clippers',
    'lalakers': 'Los Angeles Lakers',
    'utahhockeyclub': 'Utah Hockey Club',
    'utahmammoth': 'Utah Hockey Club',
    'arizonacoyotes': 'Utah Hockey Club',
    'oaklandathletics': 'Athletics',
    'lasvegasathletics': 'Athletics',
    'stlouisrams': 'Los Angeles Rams',
    'sandiegochargers': 'Los Angeles Chargers',
    'oaklandraiders': 'Las Vegas Raiders',
    'washingtoredskins': 'Washington Commanders',
    'washingtonfootballteam': 'Washington Commanders',
  };

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

      // Trends fields. trends-engine.js reads these through
      // the game object; they are also mirrored on the
      // context map for callers that read the context direct.
      prevResultByTeam: {},
      prevMarginByTeam: {},
      gameOfSeasonByTeam: {},
      homeGameOfSeasonByTeam: {},
      playedBeforeByTeam: {},
      lostLastMeetingByTeam: {},
      seasonProgressByGame: {},

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

    // Trends context fields, computed from the schedule and
    // attached both to the flat context maps and directly to
    // each game object so trends-engine reads them wherever it
    // looks.
    ctx.prevResultByTeam          = schedule.prevResultByTeam || {};
    ctx.prevMarginByTeam          = schedule.prevMarginByTeam || {};
    ctx.gameOfSeasonByTeam        = schedule.gameOfSeasonByTeam || {};
    ctx.homeGameOfSeasonByTeam    = schedule.homeGameOfSeasonByTeam || {};
    ctx.playedBeforeByTeam        = schedule.playedBeforeByTeam || {};
    ctx.lostLastMeetingByTeam     = schedule.lostLastMeetingByTeam || {};
    ctx.seasonProgressByGame      = schedule.seasonProgressByGame || {};
    fillFromHistory(ctx, games);

    games.forEach(g => {
      const sport = g._sport || g.sport;
      const home = g.home_team || g.home;
      const away = g.away_team || g.away;
      if (!sport || !home || !away) return;

      const homeKey = `${sport}:${home}`;
      const awayKey = `${sport}:${away}`;

      if (ctx.restByTeam[homeKey] != null) g.home_rest_days = ctx.restByTeam[homeKey];
      if (ctx.restByTeam[awayKey] != null) g.away_rest_days = ctx.restByTeam[awayKey];
      if (ctx.prevResultByTeam[homeKey] != null) g.home_prev_result = ctx.prevResultByTeam[homeKey];
      if (ctx.prevResultByTeam[awayKey] != null) g.away_prev_result = ctx.prevResultByTeam[awayKey];
      if (ctx.prevMarginByTeam[homeKey] != null) g.home_prev_margin = ctx.prevMarginByTeam[homeKey];
      if (ctx.prevMarginByTeam[awayKey] != null) g.away_prev_margin = ctx.prevMarginByTeam[awayKey];
      if (ctx.gameOfSeasonByTeam[homeKey] != null) g.home_game_of_season = ctx.gameOfSeasonByTeam[homeKey];
      if (ctx.gameOfSeasonByTeam[awayKey] != null) g.away_game_of_season = ctx.gameOfSeasonByTeam[awayKey];
      if (ctx.homeGameOfSeasonByTeam[homeKey] != null) g.home_home_game_of_season = ctx.homeGameOfSeasonByTeam[homeKey];
      if (ctx.homeGameOfSeasonByTeam[awayKey] != null) g.away_home_game_of_season = ctx.homeGameOfSeasonByTeam[awayKey];
      if (ctx.playedBeforeByTeam[homeKey] != null) g.played_before = ctx.playedBeforeByTeam[homeKey];
      if (ctx.lostLastMeetingByTeam[homeKey] != null) g.home_lost_last_meeting = ctx.lostLastMeetingByTeam[homeKey];
      if (ctx.lostLastMeetingByTeam[awayKey] != null) g.away_lost_last_meeting = ctx.lostLastMeetingByTeam[awayKey];
      if (ctx.seasonProgressByGame[g.id] != null) g.season_progress = ctx.seasonProgressByGame[g.id];
    });

    // Travel. resolveCoord handles aliases and normalized
    // matches.
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
  //
  // Reads only rows written from the currently active book (or
  // from consensus when no book is chosen). Every writer tags
  // its rows with a `source` value; without filtering, rows
  // from two books for the same game sat in the table with no
  // way to tell which was which, and the "open" line could be
  // a different book's number from the "current" line.
  //
  // When the source column does not yet exist, the query falls
  // back to the unfiltered shape and one warning is logged per
  // sport per page load.
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

    const book = (localStorage.getItem('edge_book_key') || '').trim().toLowerCase();
    const source = book ? `book:${book}` : 'consensus';

    // Two shapes. Source-filtered first, unfiltered as the
    // fallback for a table where the source column has not
    // been added yet.
    const shapes = [
      {
        url:
          `${url}/rest/v1/line_history?select=game_id,spread,total,ml,public_pct,sharp_pct,source,created_at` +
          `&game_id=in.(${inList})&source=eq.${encodeURIComponent(source)}&order=created_at.asc`,
        tag: 'source-filtered',
      },
      {
        // Same source filter without public_pct / sharp_pct, which
        // nothing writes. When those columns do not exist, the
        // query above fails and this one keeps the filter.
        url:
          `${url}/rest/v1/line_history?select=game_id,spread,total,ml,source,created_at` +
          `&game_id=in.(${inList})&source=eq.${encodeURIComponent(source)}&order=created_at.asc`,
        tag: 'source-filtered',
      },
      {
        url:
          `${url}/rest/v1/line_history?select=game_id,spread,total,ml,created_at` +
          `&game_id=in.(${inList})&order=created_at.asc`,
        tag: 'unfiltered',
      },
    ];

    let rows = null;
    for (const shape of shapes) {
      try {
        const res = await fetch(shape.url, { headers });
        if (!res.ok) continue;
        rows = await res.json();
        if (shape.tag === 'unfiltered' && !_warnedNoSource.has('line_history')) {
          _warnedNoSource.add('line_history');
          logEdgeError('context.loadLineHistory.noSource',
            new Error('line_history source column missing — reading across books'));
        }
        break;
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
        source,
      };
    });

    return out;
  }

  // ============================================================
  // ── SCHEDULE ──
  // ============================================================

  async function loadScheduleContext(games) {
    const out = {
      restByTeam: {},
      practiceDaysByTeam: {},
      travelTypeByTeam: {},
      roadTripLengthByTeam: {},
      prevResultByTeam: {},
      prevMarginByTeam: {},
      gameOfSeasonByTeam: {},
      homeGameOfSeasonByTeam: {},
      playedBeforeByTeam: {},
      lostLastMeetingByTeam: {},
      seasonProgressByGame: {},
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

    const schedules = {};
    for (const sport of sports) {
      const path = ESPN_MAP[sport];
      const perDate = [];

      await parallelMap(dates, SCHEDULE_CONCURRENCY, async d => {
        const r = await getDaySchedule(path, d, sport);
        if (r.hit) out.stats.hits++;
        else out.stats.misses++;
        perDate.push(...r.events);
      });

      perDate.sort((a, b) => new Date(a.date) - new Date(b.date));
      schedules[sport] = perDate;
    }

    games.forEach(g => {
      const sport = g._sport || g.sport;
      const when = new Date(g.commence_time || g.time);
      if (isNaN(when)) return;
      const schedule = schedules[sport] || [];

      [['home', g.home_team || g.home], ['away', g.away_team || g.away]].forEach(([side, team]) => {
        if (!team) return;
        const key = `${sport}:${team}`;
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

    // Per-team season stats. Computed from the full schedule
    // (home + away games), not just the target team's own
    // history, so homeGameOfSeason counts only home appearances.
    for (const sport of sports) {
      const schedule = schedules[sport] || [];
      if (!schedule.length) continue;

      const ordered = schedule.slice().sort((a, b) => new Date(a.date) - new Date(b.date));

      // Count how many games each team has played as of each
      // date. Uses a running map. Season reset is done by
      // checking the seasonOf() label against the last game's
      // season — a new season zeroes the counter.
      const playedByTeam = {};
      const homeByTeam = {};
      const lastSeasonByTeam = {};
      const lastResult = {};
      const metBefore = new Map();

      ordered.forEach(e => {
        const when = new Date(e.date);
        const season = seasonOf(sport, when);

        const homeTeam = e.home;
        const awayTeam = e.away;
        const homeKey = normalizeTeam(sport, homeTeam);
        const awayKey = normalizeTeam(sport, awayTeam);

        [homeTeam, awayTeam].forEach(t => {
          const k = normalizeTeam(sport, t);
          if (lastSeasonByTeam[k] !== season) {
            playedByTeam[k] = 0;
            homeByTeam[k] = 0;
            lastSeasonByTeam[k] = season;
          }
        });

        playedByTeam[homeKey] = (playedByTeam[homeKey] || 0) + 1;
        playedByTeam[awayKey] = (playedByTeam[awayKey] || 0) + 1;
        homeByTeam[homeKey] = (homeByTeam[homeKey] || 0) + 1;

        // Record the result for the previous-result lookup.
        if (e.homeScore != null && e.awayScore != null) {
          const margin = e.homeScore - e.awayScore;
          const homeResult = margin > 0 ? 'W' : margin < 0 ? 'L' : 'T';
          const awayResult = homeResult === 'W' ? 'L' : homeResult === 'L' ? 'W' : 'T';
          lastResult[homeKey] = { result: homeResult, margin };
          lastResult[awayKey] = { result: awayResult, margin: -margin };
        }

        // Head to head: keep the most recent prior meeting per
        // pair so lostLastMeetingByTeam can be computed.
        const pairKey = [homeKey, awayKey].sort().join('|');
        if (!metBefore.has(pairKey)) metBefore.set(pairKey, []);
        metBefore.get(pairKey).push({ date: when, home: homeTeam, away: awayTeam, homeScore: e.homeScore, awayScore: e.awayScore });
      });

      // Now walk the target games and attach the values the
      // trends engine reads.
      const windowStart = new Date(Date.now() - REST_LOOKBACK_DAYS * 86400000);
      games.forEach(g => {
        if ((g._sport || g.sport) !== sport) return;
        const when = new Date(g.commence_time || g.time);
        if (isNaN(when)) return;

        const home = g.home_team || g.home;
        const away = g.away_team || g.away;
        const homeNorm = normalizeTeam(sport, home);
        const awayNorm = normalizeTeam(sport, away);
        const involves = (e, n) => normalizeTeam(sport, e.home) === n || normalizeTeam(sport, e.away) === n;

        // Head to head inside the window. Older meetings are filled
        // from matchup_ats in buildContext.
        const pairKey = [homeNorm, awayNorm].sort().join('|');
        const priorMeetings = (metBefore.get(pairKey) || []).filter(m => new Date(m.date) < when);
        if (priorMeetings.length) {
          const lastMeet = priorMeetings[priorMeetings.length - 1];
          const homeWasHome = normalizeTeam(sport, lastMeet.home) === homeNorm;
          const homeMargin = lastMeet.homeScore != null && lastMeet.awayScore != null
            ? (homeWasHome ? lastMeet.homeScore - lastMeet.awayScore : lastMeet.awayScore - lastMeet.homeScore)
            : null;
          out.playedBeforeByTeam[`${sport}:${home}`] = true;
          out.playedBeforeByTeam[`${sport}:${away}`] = true;
          if (homeMargin != null) {
            out.lostLastMeetingByTeam[`${sport}:${home}`] = homeMargin < 0;
            out.lostLastMeetingByTeam[`${sport}:${away}`] = homeMargin > 0;
          }
        }

        // Game of season counts only this season's games, and only
        // when the whole season so far sits inside the 60-day
        // window. Later in a long season (MLB in September) the
        // window holds a fraction of the games, so the count is left
        // for buildContext to take from team_ats.
        const seasonStart = window.EDGE_POWER?.seasonStart ? window.EDGE_POWER.seasonStart(sport, when) : null;
        const covered = !!(seasonStart && seasonStart >= windowStart);
        const thisSeason = e => {
          const t = new Date(e.date);
          return t < when && (!seasonStart || t >= seasonStart);
        };

        if (covered) {
          const homeBefore = schedule.filter(e => thisSeason(e) && involves(e, homeNorm)).length;
          const awayBefore = schedule.filter(e => thisSeason(e) && involves(e, awayNorm)).length;
          const homeHomeBefore = schedule.filter(e => thisSeason(e) && normalizeTeam(sport, e.home) === homeNorm).length;

          out.gameOfSeasonByTeam[`${sport}:${home}`] = homeBefore + 1;
          out.gameOfSeasonByTeam[`${sport}:${away}`] = awayBefore + 1;
          out.homeGameOfSeasonByTeam[`${sport}:${home}`] = homeHomeBefore + 1;
          if (SEASON_LENGTH[sport]) {
            out.seasonProgressByGame[g.id] = Math.min((homeBefore + 1) / SEASON_LENGTH[sport], 1);
          }
        }

        // Previous result and margin — the team's last game, when it
        // was within 30 days (the same rule rest uses).
        for (const [teamNorm, teamFull] of [[homeNorm, home], [awayNorm, away]]) {
          const prev = schedule.filter(e => new Date(e.date) < when && involves(e, teamNorm)).slice(-1)[0];
          if (!prev || prev.homeScore == null || prev.awayScore == null) continue;
          if ((when - new Date(prev.date)) > 30 * 86400000) continue;
          const wasHome = normalizeTeam(sport, prev.home) === teamNorm;
          const margin = wasHome ? prev.homeScore - prev.awayScore : prev.awayScore - prev.homeScore;
          out.prevResultByTeam[`${sport}:${teamFull}`] = margin > 0 ? 'W' : margin < 0 ? 'L' : 'T';
          out.prevMarginByTeam[`${sport}:${teamFull}`] = margin;
        }
      });
    }

    return out;
  }

  // Game of season late in a long season comes from team_ats's
  // current-season record (games with a line) plus one. Revenge
  // uses matchup_ats's last meeting when the pair has not met in
  // the last 60 days.
  function fillFromHistory(ctx, games) {
    games.forEach(g => {
      const sport = g._sport || g.sport;
      const when = new Date(g.commence_time || g.time);
      const home = g.home_team || g.home;
      const away = g.away_team || g.away;
      if (!sport || !home || !away || isNaN(when)) return;

      const label = window.EDGE_POWER?.seasonLabel ? String(window.EDGE_POWER.seasonLabel(sport, when)) : null;

      [[home, true], [away, false]].forEach(([team, isHome]) => {
        const k = `${sport}:${team}`;
        if (ctx.gameOfSeasonByTeam[k] != null) return;
        const ats = ctx.atsByTeam?.[k];
        if (!ats || !label || String(ats.season_label) !== label) return;
        const played = (ats.season_wins || 0) + (ats.season_losses || 0) + (ats.season_pushes || 0);
        ctx.gameOfSeasonByTeam[k] = played + 1;
        if (isHome) ctx.homeGameOfSeasonByTeam[k] = (ats.home_wins || 0) + (ats.home_losses || 0) + 1;
      });

      const homeGos = ctx.gameOfSeasonByTeam[`${sport}:${home}`];
      if (ctx.seasonProgressByGame[g.id] == null && homeGos != null && SEASON_LENGTH[sport]) {
        ctx.seasonProgressByGame[g.id] = Math.min(homeGos / SEASON_LENGTH[sport], 1);
      }

      const hk = `${sport}:${home}`, ak = `${sport}:${away}`;
      if (ctx.playedBeforeByTeam[hk] == null) {
        const h2h = ctx.h2hByGame?.[g.id];
        const meetings = Array.isArray(h2h?.recent_meetings) ? h2h.recent_meetings : [];
        if ((h2h?.meetings || 0) > 0 || meetings.length) {
          ctx.playedBeforeByTeam[hk] = true;
          ctx.playedBeforeByTeam[ak] = true;
          const last = meetings[meetings.length - 1];
          if (last && typeof last.score === 'string' && last.score.includes('-')) {
            const [hs, as] = last.score.split('-').map(Number);
            if (isFinite(hs) && isFinite(as) && hs !== as) {
              const homeWasHome = normalizeTeam(sport, last.home) === normalizeTeam(sport, home);
              const homeWon = homeWasHome ? hs > as : as > hs;
              ctx.lostLastMeetingByTeam[hk] = !homeWon;
              ctx.lostLastMeetingByTeam[ak] = homeWon;
            }
          }
        }
      }
    });
  }

  // Fetch one day's events for one sport. Cache per (path,
  // date). The TTL is short for recent days because a
  // scoreboard fetched before a game finishes must not be
  // trusted the next morning.
  async function getDaySchedule(path, date, sport) {
    const dateStr = fmtDate(date);
    const cacheKey = `${path}:${dateStr}`;
    const cache = readCache(SCHEDULE_CACHE_KEY);
    const entry = cache[cacheKey];
    const ttl = ttlForDate(dateStr);

    if (entry && (Date.now() - entry.t) < ttl) {
      return { events: entry.events, hit: true };
    }

    const events = await fetchEspnDay(path, dateStr, sport);
    cache[cacheKey] = { t: Date.now(), events };
    trimCache(cache, SCHEDULE_CACHE_MAX);
    writeCache(SCHEDULE_CACHE_KEY, cache);

    return { events, hit: false };
  }

  // Recent days expire fast. Older days are stable and can be
  // held for a full day.
  function ttlForDate(dateStr) {
    const day = new Date(dateStr + 'T00:00:00Z');
    const daysAgo = Math.floor((Date.now() - day.getTime()) / 86400000);
    if (daysAgo < 2) return 60 * 60 * 1000;
    if (daysAgo < 7) return 6 * 60 * 60 * 1000;
    return 24 * 60 * 60 * 1000;
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
        // Preseason is not the season: it inflated game-of-season
        // (an NFL Week 1 game counted as game 4) and rest.
        if ((e.season?.type ?? comp.season?.type) === 1) return;
        const h = comp.competitors?.find(c => c.homeAway === 'home');
        const a = comp.competitors?.find(c => c.homeAway === 'away');
        if (!h || !a) return;
        const hn = h.team?.displayName;
        const an = a.team?.displayName;
        if (!hn || !an) return;

        const hs = parseInt(h.score, 10);
        const as = parseInt(a.score, 10);

        out.push({
          date: e.date,
          home: hn,
          away: an,
          homeScore: isFinite(hs) ? hs : null,
          awayScore: isFinite(as) ? as : null,
        });
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

      const atsRows = await fetchAll(
        `${url}/rest/v1/team_ats?sport=eq.${sport}&select=*&order=team_name.asc`,
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

      const h2hRows = await fetchAll(
        `${url}/rest/v1/matchup_ats?sport=eq.${sport}&select=*&order=team_a.asc,team_b.asc`,
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

  // Paged. Supabase returns at most 1,000 rows per request.
  async function fetchAll(url, key) {
    const out = [];
    const pageSize = 1000;
    try {
      for (let offset = 0; offset < 200000; offset += pageSize) {
        const res = await fetch(`${url}&limit=${pageSize}&offset=${offset}`,
          { headers: { apikey: key, Authorization: `Bearer ${key}` } });
        if (!res.ok) break;
        const rows = await res.json();
        out.push(...rows);
        if (rows.length < pageSize) break;
      }
    } catch (e) {
      logEdgeError('context.fetchAll', e);
    }
    return out;
  }

  function normalizeTeam(sport, name) {
    if (!name) return '';
    if (window.EDGE_TEAMS && typeof window.EDGE_TEAMS.normalize === 'function') {
      try { return window.EDGE_TEAMS.normalize(name, sport); }
      catch {}
    }
    return String(name).toLowerCase().replace(/[^a-z0-9]/g, '');
  }

  // Season label, matching ats-tracker, power-engine, and
  // trends-engine. Used here to zero the per-team game counter
  // when a new season starts.
  function seasonOf(sport, date) {
    const m = date.getMonth() + 1;
    const y = date.getFullYear();

    // WNBA plays inside a calendar year, like MLB and MLS.
    if (sport === 'NBA' || sport === 'NHL' || sport === 'NCAAB') {
      return String(m >= 9 ? y : y - 1);
    }
    if (sport === 'NFL' || sport === 'NCAAF') {
      return String(m >= 3 ? y : y - 1);
    }
    return String(y);
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
        fresh: Object.values(schedule).filter(e => {
          if (!e) return false;
          const key = Object.keys(schedule).find(k => schedule[k] === e);
          const dateStr = key ? key.split(':').pop() : null;
          const ttl = dateStr ? ttlForDate(dateStr) : 24 * 60 * 60 * 1000;
          return (now - e.t) < ttl;
        }).length,
        note: 'recent days expire hourly, older days daily',
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

  // 'YYYY-MM-DD' on the US Eastern calendar — the day ESPN files
  // a game under.
  function fmtDate(d) {
    if (window.EDGE_TIME) return window.EDGE_TIME.gameDay(d);
    try {
      return new Intl.DateTimeFormat('en-CA', {
        timeZone: 'America/New_York', year: 'numeric', month: '2-digit', day: '2-digit',
      }).format(d);
    } catch {
      const y = d.getFullYear();
      const m = String(d.getMonth() + 1).padStart(2, '0');
      const day = String(d.getDate()).padStart(2, '0');
      return `${y}-${m}-${day}`;
    }
  }

  async function parallelMap(items, concurrency, fn) {
    const queue = [...items];
    await Promise.all(Array.from({ length: concurrency }, async () => {
      while (queue.length) {
        const item = queue.shift();
        if (item === undefined) break;
        await fn(item);
      }
    }));
  }

})();

if (typeof window !== 'undefined') window.EDGE_CONTEXT = EDGE_CONTEXT;