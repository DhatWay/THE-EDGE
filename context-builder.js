// ============================================================
// EDGE — CONTEXT BUILDER v1.0
// Loads all non-ratings data that algorithms need.
// Line history · rest days · travel · (weather/injuries stubbed)
// ============================================================

const EDGE_CONTEXT = (() => {

  const SUPABASE_URL = () => localStorage.getItem('edge_supabase_url');
  const SUPABASE_KEY = () => localStorage.getItem('edge_supabase_key');

  // Team home cities for travel computation
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

  return {
    buildContext,
    computeRestDays,
    computeTravelMiles,
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

    const url = SUPABASE_URL();
    const key = SUPABASE_KEY();

    // ── Line history ──
    if (url && key) {
      try {
        const gameIds = games.map(g => g.id).filter(Boolean);
        if (gameIds.length) {
          const inList = gameIds.map(id => `"${id}"`).join(',');
          const res = await fetch(
            `${url}/rest/v1/line_history?select=game_id,spread,total,ml,public_pct,sharp_pct,created_at&game_id=in.(${inList})&order=created_at.asc`,
            { headers: { apikey: key, Authorization: `Bearer ${key}` } }
          );
          if (res.ok) {
            const rows = await res.json();
            const perGame = {};
            rows.forEach(r => {
              if (!perGame[r.game_id]) perGame[r.game_id] = { open: r, latest: r };
              else perGame[r.game_id].latest = r;
            });
            Object.entries(perGame).forEach(([gid, h]) => {
              ctx.lineHistoryByGame[gid] = {
                open_spread: h.open.spread,
                current_spread: h.latest.spread,
                open_total: h.open.total,
                current_total: h.latest.total,
                public_pct: h.latest.public_pct ?? null,
                sharp_pct: h.latest.sharp_pct ?? null,
              };
            });
          }
        }
      } catch {}
    }

    // ── Rest days + travel ──
    // Group games by team, then compute days since each team's previous game
    const gamesByTeam = {};
    games.forEach(g => {
      const home = g.home_team || g.home;
      const away = g.away_team || g.away;
      const sport = g._sport || g.sport;
      const time = g.commence_time || g.time;
      if (!time) return;
      if (home) (gamesByTeam[`${sport}:${home}`] ||= []).push({ time, atHome: true, opp: away });
      if (away) (gamesByTeam[`${sport}:${away}`] ||= []).push({ time, atHome: false, opp: home });
    });

    Object.entries(gamesByTeam).forEach(([teamKey, list]) => {
      list.sort((a, b) => new Date(a.time) - new Date(b.time));
      // For every game on this team's schedule, rest days = days since previous
      list.forEach((entry, i) => {
        if (i === 0) {
          ctx.restByTeam[teamKey] = ctx.restByTeam[teamKey] ?? 3; // assume 3 for first appearance
        } else {
          const days = (new Date(entry.time) - new Date(list[i - 1].time)) / 86400000;
          ctx.restByTeam[teamKey] = Math.max(0, Math.round(days));
        }
      });
    });

    // ── Travel miles ──
    games.forEach(g => {
      const sport = g._sport || g.sport;
      const home = g.home_team || g.home;
      const away = g.away_team || g.away;

      const homeCoord = TEAM_CITIES[home];
      const awayCoord = TEAM_CITIES[away];
      if (!homeCoord || !awayCoord) return;

      const miles = haversine(homeCoord, awayCoord);
      const timezones = estimateTimezoneShift(awayCoord, homeCoord);

      ctx.travelByGame[g.id] = { miles: Math.round(miles), timezones };
    });

    // Weather + injuries are stubs for now (no free source wired yet)

    return ctx;
  }

  // ============================================================
  // ── HELPERS ──
  // ============================================================

  function computeRestDays(teamKey, allGames) {
    // Kept for API symmetry
    return 3;
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
    // Longitude difference: 15° ≈ 1 hour. Eastern US is more negative (further west).
    // Away team traveling east = positive shift. Traveling west = negative.
    const lonDiff = homeCoord[1] - awayCoord[1];
    return Math.round(lonDiff / 15);
  }

})();

if (typeof window !== 'undefined') window.EDGE_CONTEXT = EDGE_CONTEXT;