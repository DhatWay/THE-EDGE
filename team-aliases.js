// ============================================================
// EDGE — TEAM NAME RESOLVER v1.0
//
// The Odds API, ESPN and the power_ratings table spell the same
// club three different ways. On a 103-game slate that cost 13
// games — they got a prior of null and were dropped silently.
//
//   Odds API            ESPN / power_ratings
//   "Chicago Fire"      "Chicago Fire FC"
//   "Columbus Crew SC"  "Columbus Crew"
//   "CF Montreal"       "CF Montréal"
//   "Los Angeles FC"    "LAFC"
//
// Rather than hand-maintain hundreds of names, this normalises
// both sides — strips club suffixes, accents, punctuation — then
// falls back to a small table for the genuinely irregular ones,
// then to a token-overlap match.
//
// resolveTeam() returns the key that actually exists in the index
// you pass it, or null. Nothing guesses past a confidence floor.
// ============================================================

const EDGE_TEAMS = (() => {

  // Club words that carry no identity. Stripped from both sides.
  const NOISE = [
    'fc', 'sc', 'cf', 'afc', 'ac', 'club', 'city',
    'united', 'utd', 'sporting', 'real',
  ];

  // Only for names that normalisation cannot reconcile.
  const EXPLICIT = {
    MLS: {
      'los angeles fc': 'lafc',
      'lafc': 'lafc',
      'la galaxy': 'la galaxy',
      'los angeles galaxy': 'la galaxy',
      'new york city fc': 'new york city',
      'nycfc': 'new york city',
      'new york red bulls': 'new york red bulls',
      'ny red bulls': 'new york red bulls',
      'red bull new york': 'new york red bulls',
      'st louis city sc': 'st louis',
      'st. louis city sc': 'st louis',
      'cf montreal': 'montreal',
      'cf montréal': 'montreal',
      'club de foot montreal': 'montreal',
      'montreal impact': 'montreal',
      'inter miami cf': 'inter miami',
      'minnesota united fc': 'minnesota',
      'atlanta united fc': 'atlanta',
      'dc united': 'dc',
      'd.c. united': 'dc',
      'sporting kansas city': 'kansas city',
      'sporting kc': 'kansas city',
      'vancouver whitecaps fc': 'vancouver whitecaps',
      'vancouver whitecaps': 'vancouver whitecaps',
      'houston dynamo fc': 'houston dynamo',
      'houston dynamo': 'houston dynamo',
      'columbus crew sc': 'columbus crew',
      'columbus crew': 'columbus crew',
      'chicago fire fc': 'chicago fire',
      'chicago fire': 'chicago fire',
      'charlotte fc': 'charlotte',
      'austin fc': 'austin',
      'nashville sc': 'nashville',
      'fc cincinnati': 'cincinnati',
      'fc dallas': 'dallas',
      'san jose earthquakes': 'san jose earthquakes',
      'seattle sounders fc': 'seattle sounders',
      'seattle sounders': 'seattle sounders',
      'portland timbers': 'portland timbers',
      'new england revolution': 'new england revolution',
      'philadelphia union': 'philadelphia union',
      'orlando city sc': 'orlando city',
      'orlando city': 'orlando city',
      'toronto fc': 'toronto',
      'colorado rapids': 'colorado rapids',
      'real salt lake': 'real salt lake',
      'san diego fc': 'san diego',
    },
    MLB: {
      'oakland athletics': 'athletics',
      'athletics': 'athletics',
      'las vegas athletics': 'athletics',
      'cleveland guardians': 'cleveland guardians',
      'cleveland indians': 'cleveland guardians',
    },
    NFL: {
      'washington commanders': 'washington commanders',
      'washington football team': 'washington commanders',
      'washington redskins': 'washington commanders',
      'oakland raiders': 'las vegas raiders',
      'las vegas raiders': 'las vegas raiders',
      'san diego chargers': 'los angeles chargers',
      'los angeles chargers': 'los angeles chargers',
      'st louis rams': 'los angeles rams',
      'los angeles rams': 'los angeles rams',
    },
    NBA: {
      'la clippers': 'los angeles clippers',
      'los angeles clippers': 'los angeles clippers',
      'la lakers': 'los angeles lakers',
      'los angeles lakers': 'los angeles lakers',
    },
  };

  // Common college shorthand the Odds API uses.
  const COLLEGE_SHORT = {
    'uconn': 'connecticut',
    'ucf': 'central florida',
    'usc': 'southern california',
    'lsu': 'louisiana state',
    'smu': 'southern methodist',
    'tcu': 'texas christian',
    'byu': 'brigham young',
    'ole miss': 'mississippi',
    'southern miss': 'southern mississippi',
    'app state': 'appalachian state',
    'central michigan': 'central michigan',
    'western michigan': 'western michigan',
    'louisiana': 'louisiana',
    'ul lafayette': 'louisiana',
    'hawaii': 'hawaii',
    'san jose st': 'san jose state',
    'fresno st': 'fresno state',
    'pitt': 'pittsburgh',
    'uab': 'alabama birmingham',
    'utep': 'texas el paso',
    'utsa': 'texas san antonio',
    'unlv': 'nevada las vegas',
    'umass': 'massachusetts',
    'miami oh': 'miami ohio',
    'miami fl': 'miami',
    'nc state': 'north carolina state',
    'ul monroe': 'louisiana monroe',
    'fiu': 'florida international',
    'fau': 'florida atlantic',
    'usf': 'south florida',
  };

  // Mascots stripped so "Georgia Bulldogs" matches "Georgia".
  // Only applied as a fallback pass, never as the primary key.
  const MASCOT_TAIL = /\s+(mountaineers|golden eagles|ragin cajuns|spartans|bulldogs|tigers|wildcats|eagles|huskies|blazers|49ers|cougars|knights|bison|hurricanes|gamecocks|lobos|hoosiers|gators|dukes|hokies|terrapins|cavaliers|fighting irish|trojans|aggies|cornhuskers|nittany lions|bearcats|rebels|volunteers|razorbacks|commodores|crimson tide|sooners|longhorns|jayhawks|cyclones|mountaineers|horned frogs|red raiders|owls|hawkeyes|badgers|boilermakers|wolverines|buckeyes|nittany|panthers|cardinals|orange|demon deacons|yellow jackets|seminoles|wolfpack|tar heels|blue devils|lions|bears|beavers|ducks|utes|buffaloes|sun devils|rams|broncos|falcons|raiders|aztecs|rainbow warriors|vandals|vikings|zips|bobcats|chippewas|rockets|golden flashes|redhawks|thundering herd|mean green|roadrunners|miners|monarchs|pirates|mustangs|bulls|midshipmen|black knights|minutemen|hilltoppers|racers|governors|colonels)$/i;

  return {
    normalize,
    resolveTeam,
    buildIndex,
    matchReport,
  };

  // ============================================================
  // ── NORMALISE ──
  // ============================================================

  function normalize(name, sport) {
    if (!name) return '';
    let s = String(name).toLowerCase().trim();

    // Accents: Montréal → montreal
    s = s.normalize('NFD').replace(/[\u0300-\u036f]/g, '');
    // Punctuation
    s = s.replace(/[.'’`]/g, '').replace(/[-_/]/g, ' ');
    s = s.replace(/\s+/g, ' ').trim();

    const explicit = EXPLICIT[sport];
    if (explicit && explicit[s]) return explicit[s];

    if (sport === 'NCAAF' || sport === 'NCAAB') {
      for (const [short, full] of Object.entries(COLLEGE_SHORT)) {
        if (s === short || s.startsWith(short + ' ')) {
          s = s.replace(short, full);
          break;
        }
      }
    }

    // Strip club noise words, but never the whole name.
    const tokens = s.split(' ').filter(Boolean);
    const kept = tokens.filter(t => !NOISE.includes(t));
    if (kept.length) s = kept.join(' ');

    return s.trim();
  }

  function stripMascot(normalized) {
    return normalized.replace(MASCOT_TAIL, '').trim();
  }

  // ============================================================
  // ── INDEX ──
  // Build a lookup once per run, then resolve against it.
  // Accepts either an array of rows with team_name, or an object
  // keyed "SPORT:Team Name" as the orchestrator already uses.
  // ============================================================

  function buildIndex(source, sport) {
    const index = { exact: new Map(), norm: new Map(), bare: new Map() };

    const add = (name, value) => {
      if (!name) return;
      index.exact.set(name, value);
      const n = normalize(name, sport);
      if (n && !index.norm.has(n)) index.norm.set(n, value);
      const b = stripMascot(n);
      if (b && b !== n && !index.bare.has(b)) index.bare.set(b, value);
    };

    if (Array.isArray(source)) {
      source.forEach(row => add(row.team_name || row.name, row));
    } else if (source && typeof source === 'object') {
      Object.entries(source).forEach(([key, value]) => {
        const name = key.includes(':') ? key.split(':').slice(1).join(':') : key;
        add(name, value);
      });
    }
    return index;
  }

  // ============================================================
  // ── RESOLVE ──
  // ============================================================

  function resolveTeam(name, index, sport) {
    if (!name || !index) return null;

    // 1. Exact
    if (index.exact.has(name)) return index.exact.get(name);

    // 2. Normalised
    const n = normalize(name, sport);
    if (index.norm.has(n)) return index.norm.get(n);

    // 3. Mascot stripped both ways
    const bare = stripMascot(n);
    if (index.bare.has(bare)) return index.bare.get(bare);
    if (index.norm.has(bare)) return index.norm.get(bare);

    // 4. Token overlap — only accepted above a clear threshold, so a
    //    genuinely absent team stays absent rather than matching the
    //    nearest wrong club.
    const target = new Set(bare.split(' ').filter(t => t.length > 2));
    if (!target.size) return null;

    let best = null;
    let bestScore = 0;
    index.norm.forEach((value, key) => {
      const tokens = new Set(stripMascot(key).split(' ').filter(t => t.length > 2));
      if (!tokens.size) return;
      let hits = 0;
      target.forEach(t => { if (tokens.has(t)) hits++; });
      const score = (2 * hits) / (target.size + tokens.size);
      if (score > bestScore) { bestScore = score; best = value; }
    });

    return bestScore >= 0.75 ? best : null;
  }

  // Diagnostics: what matched, what didn't, and why.
  function matchReport(games, index, sport) {
    const report = { total: 0, matched: 0, unmatched: [] };
    games.forEach(g => {
      const home = g.home_team || g.home;
      const away = g.away_team || g.away;
      report.total++;
      const h = resolveTeam(home, index, sport || g.sport || g._sport);
      const a = resolveTeam(away, index, sport || g.sport || g._sport);
      if (h && a) report.matched++;
      else {
        report.unmatched.push({
          sport: g.sport || g._sport,
          home, away,
          home_ok: !!h, away_ok: !!a,
          home_norm: normalize(home, g.sport || g._sport),
          away_norm: normalize(away, g.sport || g._sport),
        });
      }
    });
    return report;
  }

})();

if (typeof window !== 'undefined') window.EDGE_TEAMS = EDGE_TEAMS;
