// ============================================================
// EDGE — CONTEXT BUILDER v2.0
// Loads all non-ratings data that algorithms need.
// Line history · rest days (real, from ESPN) · travel · weather
// ============================================================

const EDGE_CONTEXT = (() => {

  const SUPABASE_URL = () => localStorage.getItem('edge_supabase_url');
  const SUPABASE_KEY = () => localStorage.getItem('edge_supabase_key');

  const ESPN_MAP = {
    NFL:   'football/nfl',
    NBA:   'basketball/nba',
    MLB:   'baseball/mlb',
    NHL:   'hockey/nhl',
    NCAAF: 'football/college-football',
    NCAAB: 'basketball/mens-college-basketball',
    MLS:   'soccer/usa.1',
  };

  // How far back to look for each team's previous game.
  const REST_LOOKBACK_DAYS = 21;

  // Indoor sports never get a weather lookup.
  const INDOOR = ['NBA', 'NHL', 'NCAAB'];

  // Team home cities for travel + weather
  const TEAM_CITIES = {
    // NFL
    'Arizona Cardinals': [33.53, -112.26], 'Atlanta Falcons': [33.75, -84.40],
    'Baltimore Ravens': [39.28, -76.62], 'Buffalo Bills': [42.77, -78.79],
    'Carolina Panthers': [35.23, -80.85], 'Chicago Bears': [41.86, -87.62],
    'Cincinnati Bengals': [39.10, -84.51], 'Cleveland Browns': [41.50, -81.70],
    'Dallas Cowboys': [32.75, -97.09], 'Denver Broncos': [39.74, -105.02],
    'Detroit Lions': [42.34, -83.05], 'Green Bay Packers': [44.51, -88.02],
    'Houston Texans': [29.68, -95.41], 'Indianapolis Colts': [39.76, -86.16],
    'Jacksonville Jaguars': [30.32, -81.64], 'Kansas City Chiefs': [39.05, -94.48],
    'Las Vegas Raiders': [36.09, -115.18], 'Los Angeles Chargers': [33.95, -118.34],
    'Los Angeles Rams': [33.95, -118.34], 'Miami Dolphins': [25.96, -80.24],
    'Minnesota Vikings': [44.97, -93.26], 'New England Patriots': [42.09, -71.26],
    'New Orleans Saints': [29.95, -90.08], 'New York Giants': [40.81, -74.07],
    'New York Jets': [40.81, -74.07], 'Philadelphia Eagles': [39.90, -75.17],
    'Pittsburgh Steelers': [40.45, -80.01], 'San Francisco 49ers': [37.40, -121.97],
    'Seattle Seahawks': [47.60, -122.33], 'Tampa Bay Buccaneers': [27.98, -82.50],
    'Tennessee Titans': [36.17, -86.77], 'Washington Commanders': [38.91, -77.07],
    // NBA
    'Atlanta Hawks': [33.76, -84.40], 'Boston Celtics': [42.36, -71.06],
    'Brooklyn Nets': [40.68, -73.98], 'Charlotte Hornets': [35.23, -80.84],
    'Chicago Bulls': [41.88, -87.67], 'Cleveland Cavaliers': [41.50, -81.69],
    'Dallas Mavericks': [32.79, -96.81], 'Denver Nuggets': [39.75, -105.01],
    'Detroit Pistons': [42.34, -83.06], 'Golden State Warriors': [37.77, -122.39],
    'Houston Rockets': [29.75, -95.36], 'Indiana Pacers': [39.76, -86.16],
    'LA Clippers': [34.04, -118.27], 'Los Angeles Lakers': [34.04, -118.27],
    'Memphis Grizzlies': [35.14, -90.05], 'Miami Heat': [25.78, -80.19],
    'Milwaukee Bucks': [43.04, -87.92], 'Minnesota Timberwolves': [44.98, -93.27],
    'New Orleans Pelicans': [29.95, -90.08], 'New York Knicks': [40.75, -73.99],
    'Oklahoma City Thunder': [35.46, -97.51], 'Orlando Magic': [28.54, -81.38],
    'Philadelphia 76ers': [39.90, -75.17], 'Phoenix Suns': [33.45, -112.07],
    'Portland Trail Blazers': [45.53, -122.67], 'Sacramento Kings': [38.58, -121.49],
    'San Antonio Spurs': [29.43, -98.49], 'Toronto Raptors': [43.65, -79.38],
    'Utah Jazz': [40.77, -111.90], 'Washington Wizards': [38.90, -77.02],
    // MLB
    'Arizona Diamondbacks': [33.45, -112.07], 'Atlanta Braves': [33.89, -84.47],
    'Baltimore Orioles': [39.28, -76.62], 'Boston Red Sox': [42.35, -71.10],
    'Chicago Cubs': [41.95, -87.66], 'Chicago White Sox': [41.83, -87.63],
    'Cincinnati Reds': [39.10, -84.51], 'Cleveland Guardians': [41.50, -81.69],
    'Colorado Rockies': [39.76, -104.99], 'Detroit Tigers': [42.34, -83.05],
    'Houston Astros': [29.76, -95.36], 'Kansas City Royals': [39.05, -94.48],
    'Los Angeles Angels': [33.80, -117.88], 'Los Angeles Dodgers': [34.07, -118.24],
    'Miami Marlins': [25.78, -80.22], 'Milwaukee Brewers': [43.03, -87.97],
    'Minnesota Twins': [44.98, -93.28], 'New York Mets': [40.76, -73.85],
    'New York Yankees': [40.83, -73.93], 'Athletics': [38.58, -121.51],
    'Philadelphia Phillies': [39.91, -75.17], 'Pittsburgh Pirates': [40.45, -80.01],
    'San Diego Padres': [32.71, -117.16], 'San Francisco Giants': [37.78, -122.39],
    'Seattle Mariners': [47.59, -122.33], 'St. Louis Cardinals': [38.62, -90.19],
    'Tampa Bay Rays': [27.77, -82.65], 'Texas Rangers': [32.75, -97.08],
    'Toronto Blue Jays': [43.64, -79.39], 'Washington Nationals': [38.87, -77.01],
  };

  // Venues where weather never matters even for an outdoor sport.
  const DOMED_HOMES = new Set([
    'Arizona Cardinals', 'Atlanta Falcons', 'Dallas Cowboys', 'Detroit Lions',
    'Houston Texans', 'Indianapolis Colts', 'Las Vegas Raiders', 'Los Angeles Chargers',
    'Los Angeles Rams', 'Minnesota Vikings', 'New Orleans Saints',
    'Arizona Diamondbacks', 'Houston Astros', 'Miami Marlins', 'Milwaukee Brewers',
    'Seattle Mariners', 'Texas Rangers', 'Toronto Blue Jays', 'Tampa Bay Rays',
  ]);

  return {
    buildContext,
    computeRestDays,
    computeTravelMiles,
    TEAM_CITIES,
  };

  // ============================================================
  // ── MAIN ──
  // ============================================================

  async function buildContext(games) {
    const ctx = {
      lineHistoryByGame: {},
      restByTeam: {},
      travelByGame: {},
      weatherByGame: {},
      injuriesByGame: {},
      loadedAt: new Date().toISOString(),
    };

    if (!Array.isArray(games) || !games.length) return ctx;

    ctx.lineHistoryByGame = await loadLineHistory(games);
    ctx.restByTeam = await loadRestDays(games);

    games.forEach(g => {
      const home = g.home_team || g.home;
      const away = g.away_team || g.away;
      const homeCoord = TEAM_CITIES[home];
      const awayCoord = TEAM_CITIES[away];
      if (!homeCoord || !awayCoord) return;
      ctx.travelByGame[g.id] = {
        miles: Math.round(haversine(homeCoord, awayCoord)),
        timezones: estimateTimezoneShift(awayCoord, homeCoord),
      };
    });

    ctx.weatherByGame = await loadWeather(games);

    return ctx;
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

    const inList = gameIds.map(id => `"${id}"`).join(',');
    const headers = { apikey: key, Authorization: `Bearer ${key}` };

    // public_pct / sharp_pct are optional columns. If the table doesn't have
    // them PostgREST rejects the whole query, so fall back to the core columns
    // rather than losing line history entirely.
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
      } catch {}
    }
    if (!rows) return out;

    const perGame = {};
    rows.forEach(r => {
      if (!perGame[r.game_id]) perGame[r.game_id] = { open: r, latest: r };
      else perGame[r.game_id].latest = r;
    });

    Object.entries(perGame).forEach(([gid, h]) => {
      out[gid] = {
        open_spread: h.open.spread,
        current_spread: h.latest.spread,
        open_total: h.open.total,
        current_total: h.latest.total,
        public_pct: h.latest.public_pct ?? null,
        sharp_pct: h.latest.sharp_pct ?? null,
      };
    });

    return out;
  }

  // ============================================================
  // ── REST DAYS ──
  // Each team's previous completed game from ESPN, measured
  // against the upcoming game's start time.
  // ============================================================

  async function loadRestDays(games) {
    const rest = {};

    const sports = Array.from(new Set(
      games.map(g => g._sport || g.sport).filter(s => s && ESPN_MAP[s])
    ));
    if (!sports.length) return rest;

    const end = new Date();
    const start = new Date(end.getTime() - REST_LOOKBACK_DAYS * 86400000);

    const lastPlayed = {}; // `${sport}:${team}` -> Date

    await Promise.all(sports.map(async sport => {
      const events = await fetchEspnRange(ESPN_MAP[sport], start, end);
      events.forEach(e => {
        const comp = e.competitions?.[0];
        if (!comp) return;
        if (comp.status?.type?.completed !== true) return;
        const when = new Date(e.date);
        if (isNaN(when)) return;
        (comp.competitors || []).forEach(c => {
          const name = c.team?.displayName;
          if (!name) return;
          const k = `${sport}:${name}`;
          if (!lastPlayed[k] || when > lastPlayed[k]) lastPlayed[k] = when;
        });
      });
    }));

    games.forEach(g => {
      const sport = g._sport || g.sport;
      const when = new Date(g.commence_time || g.time);
      if (isNaN(when)) return;
      [g.home_team || g.home, g.away_team || g.away].forEach(team => {
        if (!team) return;
        const k = `${sport}:${team}`;
        const prev = lastPlayed[k];
        if (!prev) return;
        rest[k] = Math.max(0, Math.round((when - prev) / 86400000));
      });
    });

    return rest;
  }

  async function fetchEspnRange(path, start, end) {
    const fmt = d => `${d.getFullYear()}${String(d.getMonth() + 1).padStart(2, '0')}${String(d.getDate()).padStart(2, '0')}`;
    try {
      const res = await fetch(
        `https://site.api.espn.com/apis/site/v2/sports/${path}/scoreboard?dates=${fmt(start)}-${fmt(end)}&limit=1000`
      );
      if (!res.ok) return [];
      const data = await res.json();
      return data.events || [];
    } catch { return []; }
  }

  // ============================================================
  // ── WEATHER ──
  // Open-Meteo forecast API — no key, no account required.
  // ============================================================

  async function loadWeather(games) {
    const out = {};

    const targets = games.filter(g => {
      const sport = g._sport || g.sport;
      if (INDOOR.includes(sport)) return false;
      const home = g.home_team || g.home;
      if (DOMED_HOMES.has(home)) return false;
      if (!TEAM_CITIES[home]) return false;
      const when = new Date(g.commence_time || g.time);
      if (isNaN(when)) return false;
      const daysOut = (when - Date.now()) / 86400000;
      return daysOut >= -1 && daysOut <= 14;
    });

    if (!targets.length) return out;

    await Promise.all(targets.map(async g => {
      const home = g.home_team || g.home;
      const [lat, lon] = TEAM_CITIES[home];
      const when = new Date(g.commence_time || g.time);
      try {
        const res = await fetch(
          `https://api.open-meteo.com/v1/forecast` +
          `?latitude=${lat}&longitude=${lon}` +
          `&hourly=temperature_2m,precipitation_probability,wind_speed_10m` +
          `&temperature_unit=fahrenheit&wind_speed_unit=mph&timezone=UTC&forecast_days=16`
        );
        if (!res.ok) return;
        const data = await res.json();
        const times = data?.hourly?.time || [];
        if (!times.length) return;

        let bestIdx = 0;
        let bestGap = Infinity;
        for (let i = 0; i < times.length; i++) {
          const gap = Math.abs(new Date(times[i] + 'Z') - when);
          if (gap < bestGap) { bestGap = gap; bestIdx = i; }
        }
        if (bestGap > 6 * 3600000) return;

        const temp = data.hourly.temperature_2m?.[bestIdx];
        const wind = data.hourly.wind_speed_10m?.[bestIdx];
        const precip = data.hourly.precipitation_probability?.[bestIdx];

        out[g.id] = {
          temp_f: typeof temp === 'number' ? Math.round(temp) : null,
          wind_mph: typeof wind === 'number' ? Math.round(wind) : null,
          precip_pct: typeof precip === 'number' ? Math.round(precip) : null,
          forecast_for: times[bestIdx],
        };
      } catch {}
    }));

    return out;
  }

  // ============================================================
  // ── HELPERS ──
  // ============================================================

  function computeRestDays(teamKey, restIndex) {
    if (!restIndex || typeof restIndex !== 'object') return null;
    return restIndex[teamKey] ?? null;
  }

  function computeTravelMiles(fromCity, toCity) {
    const a = TEAM_CITIES[fromCity];
    const b = TEAM_CITIES[toCity];
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
    // 15° of longitude ≈ 1 hour. Away team traveling east = positive shift.
    return Math.round((homeCoord[1] - awayCoord[1]) / 15);
  }

})();

if (typeof window !== 'undefined') window.EDGE_CONTEXT = EDGE_CONTEXT;