// ============================================================
// EDGE — CONTEXT BUILDER v3.0
// Top-tier build.
// Real ESPN injuries · rich weather · practice days · road-trip detection
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

  // Lookback for rest-day / schedule context. Big enough that every team's
  // most recent game falls inside the window even across a bye week.
  const REST_LOOKBACK_DAYS = 60;

  // Injuries update slowly. One fetch per sport per hour is plenty.
  const INJURY_CACHE_KEY = 'edge_injury_cache_v1';
  const INJURY_CACHE_TTL_MS = 60 * 60 * 1000;

  // How much a missing player at each position is worth in spread points.
  // Values are the estimated per-game point value over a replacement starter.
  const POSITION_VORP = {
    // NFL offense
    QB: 7.0, RB: 1.5, FB: 0.5,
    WR: 1.5, 'WR1': 2.0, TE: 1.2,
    // NFL offensive line
    LT: 3.0, LG: 1.5, C: 1.8, RG: 1.5, RT: 2.5,
    OT: 2.5, G: 1.5, T: 2.5,
    // NFL defense
    EDGE: 2.5, DE: 2.5, DT: 2.0, NT: 2.0, DL: 2.0,
    CB: 2.5, S: 2.0, FS: 2.0, SS: 2.0,
    LB: 1.8, ILB: 1.8, OLB: 2.0, MLB: 2.0,
    K: 0.8, P: 0.4,
    // NBA
    PG: 4.5, SG: 4.0, SF: 4.0, PF: 4.0, 'C': 3.5,
    G: 4.0, F: 4.0,
    // MLB
    SP: 4.0, RP: 1.5, CP: 2.5,
    DH: 1.5, IF: 1.5, OF: 1.5,
    // NHL
    G: 4.0, D: 2.5, LW: 2.0, RW: 2.0,
    // generic
    STAR: 5.0, STARTER: 3.0, ROLE: 1.0,
  };

  // Multiply the VORP by status to get the effective loss.
  const STATUS_WEIGHT = {
    'out': 1.0,
    'out for season': 1.0,
    'injured reserve': 1.0,
    'ir': 1.0,
    'suspended': 1.0,
    'doubtful': 0.75,
    'questionable': 0.35,
    'day-to-day': 0.2,
    'game-time decision': 0.4,
    'probable': 0.05,
  };

  const TEAM_CITIES = {
    // ── NFL ──
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

    // ── NBA ──
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
    'LA Clippers': [34.0430, -118.2673],
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

    // ── MLB ──
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
    'Athletics': [38.5804, -121.5088], // West Sacramento
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

    // ── NHL ──
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
  };

  // Venues that remove weather from the equation entirely.
  const DOMED_HOMES = new Set([
    'Arizona Cardinals', 'Atlanta Falcons', 'Dallas Cowboys', 'Detroit Lions',
    'Houston Texans', 'Indianapolis Colts', 'Las Vegas Raiders', 'Los Angeles Chargers',
    'Los Angeles Rams', 'Minnesota Vikings', 'New Orleans Saints',
    'Arizona Diamondbacks', 'Houston Astros', 'Miami Marlins', 'Milwaukee Brewers',
    'Seattle Mariners', 'Texas Rangers', 'Toronto Blue Jays', 'Tampa Bay Rays',
  ]);

  // US Eastern timezone reference — every city coord ends up producing
  // the same tz shift calculation.
  const TZ_REF_LON = -75;

  return {
    buildContext,
    computeRestDays,
    computeTravelMiles,
    TEAM_CITIES,
    POSITION_VORP,
    STATUS_WEIGHT,
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
      loadedAt: new Date().toISOString(),
    };

    if (!Array.isArray(games) || !games.length) return ctx;

    ctx.lineHistoryByGame = await loadLineHistory(games);
    const schedule = await loadScheduleContext(games);
    ctx.restByTeam = schedule.restByTeam;
    ctx.practiceDaysByTeam = schedule.practiceDaysByTeam;
    ctx.travelTypeByTeam = schedule.travelTypeByTeam;
    ctx.roadTripLengthByTeam = schedule.roadTripLengthByTeam;

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
    ctx.injuriesByGame = await loadInjuries(games);

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
      const openSpread = h.open.spread;
      const currentSpread = h.latest.spread;
      const moved = openSpread != null && currentSpread != null && openSpread !== currentSpread;
      out[gid] = {
        open_spread: openSpread,
        current_spread: currentSpread,
        open_total: h.open.total,
        current_total: h.latest.total,
        movement: moved ? (currentSpread - openSpread) : 0,
        public_pct: h.latest.public_pct ?? null,
        sharp_pct: h.latest.sharp_pct ?? null,
      };
    });

    return out;
  }

  // ============================================================
  // ── SCHEDULE / REST / PRACTICE / ROAD TRIP ──
  // ============================================================

  async function loadScheduleContext(games) {
    const out = {
      restByTeam: {},
      practiceDaysByTeam: {},
      travelTypeByTeam: {},
      roadTripLengthByTeam: {},
    };

    const sports = Array.from(new Set(
      games.map(g => g._sport || g.sport).filter(s => s && ESPN_MAP[s])
    ));
    if (!sports.length) return out;

    const now = new Date();
    const start = new Date(now.getTime() - REST_LOOKBACK_DAYS * 86400000);

    // per-sport: sorted list of completed games with home/away team names
    const schedules = {};

    await Promise.all(sports.map(async sport => {
      const events = await fetchEspnRange(ESPN_MAP[sport], start, now);
      const list = [];
      events.forEach(e => {
        const comp = e.competitions?.[0];
        if (!comp) return;
        if (comp.status?.type?.completed !== true) return;

        const when = new Date(e.date);
        if (isNaN(when) || when < start || when > now) return;

        const home = comp.competitors?.find(c => c.homeAway === 'home');
        const away = comp.competitors?.find(c => c.homeAway === 'away');
        if (!home || !away) return;

        const homeName = home.team?.displayName;
        const awayName = away.team?.displayName;
        if (!homeName || !awayName) return;

        list.push({ when, homeName, awayName });
      });
      list.sort((a, b) => a.when - b.when);
      schedules[sport] = list;
    }));

    // For every game in the request, compute rest + travel context for
    // both teams based on their last 5 completed games.
    games.forEach(g => {
      const sport = g._sport || g.sport;
      const when = new Date(g.commence_time || g.time);
      if (isNaN(when)) return;
      const schedule = schedules[sport] || [];

      [['home', g.home_team || g.home], ['away', g.away_team || g.away]].forEach(([side, team]) => {
        if (!team) return;
        const key = `${sport}:${team}`;

        const priorGames = schedule
          .filter(e => e.when < when && (e.homeName === team || e.awayName === team))
          .slice(-5);

        if (!priorGames.length) return;

        const last = priorGames[priorGames.length - 1];
        const rest = Math.round((when - last.when) / 86400000);
        if (rest < 0 || rest > 30) return;

        out.restByTeam[key] = rest;
        // Practice days: one recovery/travel day is lost between games.
        out.practiceDaysByTeam[key] = Math.max(0, rest - 1);

        const wasHome = last.homeName === team;
        const isHome = side === 'home';
        out.travelTypeByTeam[key] = wasHome
          ? (isHome ? 'home_to_home' : 'home_to_away')
          : (isHome ? 'away_to_home' : 'away_to_away');

        // Consecutive away games ending at this game.
        let roadTrip = 0;
        for (let i = priorGames.length - 1; i >= 0; i--) {
          const wasAway = priorGames[i].homeName !== team;
          if (!wasAway) break;
          roadTrip++;
        }
        // Plus the current game if it's away.
        const currentAway = !isHome;
        out.roadTripLengthByTeam[key] = roadTrip + (currentAway ? 1 : 0);
      });
    });

    return out;
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
  // ── WEATHER (Open-Meteo, rich) ──
  // ============================================================

  async function loadWeather(games) {
    const out = {};

    const targets = games.filter(g => {
      const sport = g._sport || g.sport;
      if (['NBA', 'NHL', 'NCAAB'].includes(sport)) return false;
      const home = g.home_team || g.home;
      if (DOMED_HOMES.has(home)) return false;
      if (!TEAM_CITIES[home]) return false;
      const when = new Date(g.commence_time || g.time);
      if (isNaN(when)) return false;
      const daysOut = (when - Date.now()) / 86400000;
      return daysOut >= -1 && daysOut <= 14;
    });

    if (!targets.length) return out;

    const HOURLY = [
      'temperature_2m', 'apparent_temperature', 'relative_humidity_2m',
      'dew_point_2m', 'precipitation', 'rain', 'snowfall', 'snow_depth',
      'precipitation_probability', 'weather_code', 'cloud_cover',
      'pressure_msl', 'wind_speed_10m', 'wind_gusts_10m', 'wind_direction_10m',
    ].join(',');

    await Promise.all(targets.map(async g => {
      const home = g.home_team || g.home;
      const [lat, lon] = TEAM_CITIES[home];
      const when = new Date(g.commence_time || g.time);
      try {
        const res = await fetch(
          `https://api.open-meteo.com/v1/forecast` +
          `?latitude=${lat}&longitude=${lon}` +
          `&hourly=${HOURLY}` +
          `&temperature_unit=fahrenheit&wind_speed_unit=mph&precipitation_unit=inch` +
          `&timezone=UTC&forecast_days=16`
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

        const num = (v, d = 0) => typeof v === 'number' ? Math.round(v * Math.pow(10, d)) / Math.pow(10, d) : null;
        const pick = k => num(data.hourly?.[k]?.[bestIdx]);
        const pickF = (k, d = 0) => num(data.hourly?.[k]?.[bestIdx], d);

        const temp = pick('temperature_2m');
        const windSpeed = pick('wind_speed_10m');
        const windGust = pick('wind_gusts_10m');
        const precipIn = pickF('precipitation', 3);
        const rainIn = pickF('rain', 3);
        const snowCm = pick('snowfall');

        // Effective wind for betting: gust weight above steady speed.
        const windEffect = (windSpeed != null && windGust != null)
          ? Math.round(windSpeed + (windGust - windSpeed) * 0.3)
          : windSpeed;

        out[g.id] = {
          temp_f: temp,
          feels_like_f: pick('apparent_temperature'),
          humidity: pick('relative_humidity_2m'),
          dew_point_f: pick('dew_point_2m'),
          pressure_hpa: pick('pressure_msl'),
          cloud_cover: pick('cloud_cover'),
          weather_code: pick('weather_code'),
          wind_mph: windSpeed,
          wind_gust_mph: windGust,
          wind_effect_mph: windEffect,
          wind_dir_deg: pick('wind_direction_10m'),
          precip_pct: pick('precipitation_probability'),
          precip_in: precipIn,
          rain_in: rainIn,
          snow_cm: snowCm,
          precip_type: (snowCm && snowCm > 0) ? 'snow' : (rainIn && rainIn > 0) ? 'rain' : 'none',
          forecast_for: times[bestIdx],
        };
      } catch {}
    }));

    return out;
  }

  // ============================================================
  // ── INJURIES (ESPN) ──
  // ============================================================

  async function loadInjuries(games) {
    const out = {};

    const teamsBySport = {};
    games.forEach(g => {
      const sport = g._sport || g.sport;
      if (!ESPN_MAP[sport]) return;
      if (!teamsBySport[sport]) teamsBySport[sport] = new Set();
      teamsBySport[sport].add(g.home_team || g.home);
      teamsBySport[sport].add(g.away_team || g.away);
    });

    if (!Object.keys(teamsBySport).length) return out;

    // Per-sport injury cache: { [sport]: { fetchedAt, byTeam: { teamName: [...] } } }
    let cache = {};
    try { cache = JSON.parse(localStorage.getItem(INJURY_CACHE_KEY) || '{}'); } catch {}

    for (const sport of Object.keys(teamsBySport)) {
      const entry = cache[sport];
      const fresh = entry && (Date.now() - entry.fetchedAt) < INJURY_CACHE_TTL_MS;
      if (!fresh) {
        const byTeam = await fetchEspnInjuries(ESPN_MAP[sport]);
        cache[sport] = { fetchedAt: Date.now(), byTeam };
      }
    }

    try { localStorage.setItem(INJURY_CACHE_KEY, JSON.stringify(cache)); } catch {}

    games.forEach(g => {
      const sport = g._sport || g.sport;
      const byTeam = cache[sport]?.byTeam || {};
      const home = g.home_team || g.home;
      const away = g.away_team || g.away;

      const homeInj = normalizeInjuries(byTeam[home] || []);
      const awayInj = normalizeInjuries(byTeam[away] || []);

      if (!homeInj.length && !awayInj.length) return;

      out[g.id] = {
        home: homeInj,
        away: awayInj,
        home_impact: sumVorp(homeInj),
        away_impact: sumVorp(awayInj),
        net_impact: sumVorp(awayInj) - sumVorp(homeInj), // positive favors home
      };
    });

    return out;
  }

  async function fetchEspnInjuries(path) {
    const urls = [
      `https://site.api.espn.com/apis/site/v2/sports/${path}/injuries`,
      `https://site.api.espn.com/apis/site/v2/sports/${path}/injuries?limit=500`,
    ];

    for (const url of urls) {
      try {
        const res = await fetch(url, { cache: 'no-store' });
        if (!res.ok) continue;
        const data = await res.json();
        const byTeam = parseEspnInjuries(data);
        if (Object.keys(byTeam).length) return byTeam;
      } catch {}
    }

    return {};
  }

  function parseEspnInjuries(data) {
    const byTeam = {};
    if (!data) return byTeam;

    const list =
      Array.isArray(data.injuries) ? data.injuries :
      Array.isArray(data.items)    ? data.items    :
      Array.isArray(data.athletes) ? data.athletes : [];

    list.forEach(entry => {
      // Two shapes ESPN uses:
      // 1) { team: {...}, injuries: [ { athlete, status } ] }
      // 2) { athlete: {...}, team: {...}, status: "..." }
      const teamName =
        entry.team?.displayName ||
        entry.team?.name ||
        entry.teamName ||
        null;
      if (!teamName) return;

      const injuries = Array.isArray(entry.injuries) ? entry.injuries : [entry];

      if (!byTeam[teamName]) byTeam[teamName] = [];

      injuries.forEach(inj => {
        const athlete = inj.athlete || entry.athlete;
        const name = athlete?.displayName || athlete?.fullName || null;
        const position =
          athlete?.position?.abbreviation ||
          athlete?.position?.name ||
          inj.position?.abbreviation ||
          null;
        const status =
          (inj.status || entry.status || '').toString().toLowerCase().trim();

        if (!name && !position) return;

        byTeam[teamName].push({
          name: name || 'Unknown',
          position: position || 'ROLE',
          status,
          short_comment: inj.shortComment || inj.longComment || inj.details?.type || null,
        });
      });
    });

    return byTeam;
  }

  function normalizeInjuries(list) {
    return list.filter(i => {
      if (!i || !i.status) return false;
      const s = i.status.toLowerCase();
      // Only keep statuses that matter.
      return s === 'out' || s === 'out for season' || s === 'injured reserve'
          || s === 'ir' || s === 'suspended'
          || s === 'doubtful' || s === 'questionable'
          || s === 'day-to-day' || s === 'game-time decision';
    });
  }

  function sumVorp(injuries) {
    return injuries.reduce((sum, inj) => {
      const posWeight = POSITION_VORP[inj.position] || POSITION_VORP.ROLE;
      const statusWeight = STATUS_WEIGHT[inj.status.toLowerCase()] ?? 0.25;
      return sum + (posWeight * statusWeight);
    }, 0);
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
    return Math.round((homeCoord[1] - awayCoord[1]) / 15);
  }

})();

if (typeof window !== 'undefined') window.EDGE_CONTEXT = EDGE_CONTEXT;