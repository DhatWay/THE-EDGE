// ============================================================
// EDGE — ELITE ALGORITHM ENGINE v3.0
// Data: Odds API + ESPN + Sportradar + Action Network + OpenWeatherMap
// Logic: 25 Elite Algorithms + Bayesian Governing + Kelly Criterion
// Plug & Play — gracefully degrades when APIs not yet connected
// ============================================================

const EDGE_ENGINE = (() => {

  // ── API KEYS (all from localStorage — set in Admin) ──
  const KEY = {
    odds:          () => localStorage.getItem('edge_odds_api_key'),
    supabaseUrl:   () => localStorage.getItem('edge_supabase_url'),
    supabaseKey:   () => localStorage.getItem('edge_supabase_key'),
    claude:        () => localStorage.getItem('edge_claude_api_key'),
    sportradar:    () => localStorage.getItem('edge_sportradar_key'),
    actionNetwork: () => localStorage.getItem('edge_action_network_key'),
    weather:       () => localStorage.getItem('edge_weather_key'),
  };

  // ── SPORTS ──
  const SPORTS = [
    { oddsKey: 'americanfootball_nfl',   label: 'NFL',   srKey: 'nfl',        espnPath: 'football/nfl' },
    { oddsKey: 'basketball_nba',         label: 'NBA',   srKey: 'nba',        espnPath: 'basketball/nba' },
    { oddsKey: 'baseball_mlb',           label: 'MLB',   srKey: 'mlb',        espnPath: 'baseball/mlb' },
    { oddsKey: 'icehockey_nhl',          label: 'NHL',   srKey: 'nhl',        espnPath: 'hockey/nhl' },
    { oddsKey: 'americanfootball_ncaaf', label: 'NCAAF', srKey: 'ncaafb',     espnPath: 'football/college-football' },
    { oddsKey: 'basketball_ncaab',       label: 'NCAAB', srKey: 'ncaamb',     espnPath: 'basketball/mens-college-basketball' },
    { oddsKey: 'soccer_usa_mls',         label: 'MLS',   srKey: 'mls',        espnPath: 'soccer/usa.1' },
  ];

  // ── SPORT-SPECIFIC ALGORITHM WEIGHTS ──
  const W = {
    NFL:  { elo:10,pyth:8,srs:8,sharp:10,clv:10,steam:9,rlm:9,pace:5,sos:8,rest:9,travel:8,weather:10,ha:7,ats:8,form:8,public:8,spot:9,coach:9,injury:10,prime:8,div:9,revenge:8,loc:9,totals:7,reg:7 },
    NBA:  { elo:9,pyth:10,srs:7,sharp:9,clv:10,steam:8,rlm:8,pace:10,sos:6,rest:10,travel:9,weather:1,ha:8,ats:7,form:10,public:7,spot:8,coach:8,injury:10,prime:6,div:5,revenge:7,loc:9,totals:9,reg:8 },
    MLB:  { elo:7,pyth:9,srs:6,sharp:9,clv:10,steam:8,rlm:8,pace:7,sos:7,rest:8,travel:7,weather:10,ha:8,ats:8,form:9,public:8,spot:7,coach:7,injury:9,prime:5,div:8,revenge:6,loc:9,totals:10,reg:9 },
    NHL:  { elo:8,pyth:8,srs:7,sharp:9,clv:10,steam:8,rlm:8,pace:9,sos:7,rest:9,travel:8,weather:1,ha:9,ats:7,form:9,public:7,spot:7,coach:8,injury:10,prime:6,div:8,revenge:7,loc:9,totals:8,reg:7 },
    DEFAULT:{ elo:7,pyth:7,srs:6,sharp:8,clv:9,steam:7,rlm:7,pace:7,sos:6,rest:8,travel:7,weather:5,ha:7,ats:7,form:8,public:7,spot:7,coach:6,injury:8,prime:5,div:6,revenge:6,loc:8,totals:7,reg:7 },
  };

  const WKEY = ['elo','pyth','srs','sharp','clv','steam','rlm','pace','sos','rest','travel','weather','ha','ats','form','public','spot','coach','injury','prime','div','revenge','loc','totals','reg'];

  // ── AUTO SCHEDULE ──
  let autoInterval = null;
  const startAuto = (ms=1800000) => { if(autoInterval) clearInterval(autoInterval); autoInterval=setInterval(()=>runFullEngine(),ms); };
  const stopAuto  = () => { if(autoInterval) clearInterval(autoInterval); autoInterval=null; };

  // ── KELLY CRITERION ──
  function kellyUnits(confidence, americanOdds, bankroll) {
    const p = Math.min(confidence/100, 0.95);
    const q = 1-p;
    const b = americanOdds>0 ? americanOdds/100 : 100/Math.abs(americanOdds||110);
    const kelly = (b*p-q)/b;
    const frac  = kelly*0.25; // 25% fractional Kelly for risk management
    if(frac<=0) return 0;
    const unitSize = parseFloat(localStorage.getItem('edge_unit_size')||'50');
    return Math.min(Math.max(Math.round(((frac*(bankroll||1000))/unitSize)*2)/2, 0.5), 5);
  }

  const oddsToProb = o => !o?0.5:o>0?100/(o+100):Math.abs(o)/(Math.abs(o)+100);

  // ── HELPER: GET MARKET VALUE FROM ODDS API ──
  function getVal(game, market, side, field) {
    try {
      const bk  = game.bookmakers?.[0];
      const mkt = bk?.markets?.find(m=>m.key===market);
      const out = mkt?.outcomes?.find(o=>side==='home'?o.name===game.home_team:side==='away'?o.name===game.away_team:o.name===side);
      return out?.[field]??null;
    } catch { return null; }
  }

  // ── LINE HISTORY ──
  function getHist(id) { try { return JSON.parse(localStorage.getItem('edge_line_history')||'{}')[id]||null; } catch { return null; } }
  function saveHist(id,data) { try { const h=JSON.parse(localStorage.getItem('edge_line_history')||'{}'); if(!h[id])h[id]={...data,saved_at:new Date().toISOString()}; localStorage.setItem('edge_line_history',JSON.stringify(h)); } catch {} }

  // ============================================================
  // ── DATA FETCHERS ──
  // Each returns null if API not connected — engine degrades gracefully
  // ============================================================

  async function fetchOddsGames() {
    const key=KEY.odds();
    if(!key) throw new Error('Odds API key not set');
    const games=[];
    for(const sport of SPORTS) {
      try {
        const r=await fetch(`https://api.the-odds-api.com/v4/sports/${sport.oddsKey}/odds/?apiKey=${key}&regions=us&markets=spreads,h2h,totals&oddsFormat=american`);
        if(!r.ok) continue;
        const data=await r.json();
        data.forEach(g=>{ g._sport=sport.label; g._sportConfig=sport; games.push(g); });
      } catch {}
    }
    return games;
  }

  async function fetchESPN(sportConfig) {
    try {
      const r=await fetch(`https://site.api.espn.com/apis/site/v2/sports/${sportConfig.espnPath}/scoreboard`);
      return r.ok?await r.json():null;
    } catch { return null; }
  }

  async function fetchESPNTeam(sportConfig, teamName) {
    try {
      const search=await fetch(`https://site.api.espn.com/apis/site/v2/sports/${sportConfig.espnPath}/teams?limit=200`);
      if(!search.ok) return null;
      const data=await search.json();
      const team=data.sports?.[0]?.leagues?.[0]?.teams?.find(t=>t.team?.displayName===teamName||t.team?.shortDisplayName===teamName);
      if(!team?.team?.id) return null;
      const r=await fetch(`https://site.api.espn.com/apis/site/v2/sports/${sportConfig.espnPath}/teams/${team.team.id}`);
      return r.ok?await r.json():null;
    } catch { return null; }
  }

  async function fetchSportradar(sport, endpoint) {
    const key=KEY.sportradar();
    if(!key) return null;
    try {
      const r=await fetch(`https://api.sportradar.com/${sport}/trial/v7/en/${endpoint}.json?api_key=${key}`);
      return r.ok?await r.json():null;
    } catch { return null; }
  }

  async function fetchActionNetwork(gameId) {
    const key=KEY.actionNetwork();
    if(!key) return null;
    try {
      const r=await fetch(`https://api.actionnetwork.com/web/v1/games/${gameId}/odds`,{headers:{'Authorization':`Bearer ${key}`}});
      return r.ok?await r.json():null;
    } catch { return null; }
  }

  async function fetchWeather(venue, gameDate) {
    const key=KEY.weather();
    if(!key) return null;
    try {
      const geo=await fetch(`https://api.openweathermap.org/geo/1.0/direct?q=${encodeURIComponent(venue)}&limit=1&appid=${key}`);
      if(!geo.ok) return null;
      const geoData=await geo.json();
      if(!geoData[0]) return null;
      const {lat,lon}=geoData[0];
      const ts=Math.floor(new Date(gameDate).getTime()/1000);
      const r=await fetch(`https://api.openweathermap.org/data/3.0/onecall/timemachine?lat=${lat}&lon=${lon}&dt=${ts}&appid=${key}&units=imperial`);
      return r.ok?await r.json():null;
    } catch { return null; }
  }

  async function fetchInjuries(sportConfig, teamName) {
    const key=KEY.sportradar();
    if(!key) return null;
    try {
      const r=await fetch(`https://api.sportradar.com/${sportConfig.srKey}/trial/v7/en/league/injuries.json?api_key=${key}`);
      if(!r.ok) return null;
      const data=await r.json();
      // Filter to team
      const teams=data.teams||data.league?.teams||[];
      return teams.find(t=>t.name===teamName||t.alias===teamName)||null;
    } catch { return null; }
  }

  async function fetchSchedule(sportConfig, teamName) {
    const key=KEY.sportradar();
    if(!key) return null;
    try {
      const season=new Date().getFullYear();
      const r=await fetch(`https://api.sportradar.com/${sportConfig.srKey}/trial/v7/en/seasons/${season}/schedules.json?api_key=${key}`);
      if(!r.ok) return null;
      const data=await r.json();
      const games=(data.games||data.schedule||[]).filter(g=>g.home?.name===teamName||g.away?.name===teamName);
      return games;
    } catch { return null; }
  }

  // ── LOAD ALGO SETTINGS FROM SUPABASE ──
  async function loadAlgoSettings() {
    const url=KEY.supabaseUrl(), key=KEY.supabaseKey();
    if(!url||!key) return Array.from({length:25},(_,i)=>({id:i+1,enabled:true,weight:5}));
    try {
      const r=await fetch(`${url}/rest/v1/algorithms?select=*&order=id`,{headers:{'apikey':key,'Authorization':`Bearer ${key}`}});
      return r.ok?await r.json():Array.from({length:25},(_,i)=>({id:i+1,enabled:true,weight:5}));
    } catch { return Array.from({length:25},(_,i)=>({id:i+1,enabled:true,weight:5})); }
  }

  // ============================================================
  // ── ELITE 25 ALGORITHMS ──
  // Each returns: { vote:'yes'|'no'|'neu', confidence:0-100, edge:0-1, reason:string }
  // Degrades gracefully — returns 'neu' when data unavailable
  // ============================================================

  const ALGORITHMS = {

    // 1. ELO RATING — Dynamic power rating from implied market probability
    elo(game, data) {
      const ml=game._ml, spread=game._spread;
      if(spread===null) return {vote:'neu',confidence:50,edge:0,reason:'Elo: No market data'};
      const p=ml?oddsToProb(ml):0.5;
      const absSpread=Math.abs(spread);
      // Value window: implied prob significantly above breakeven in reasonable spread range
      if(p>0.62&&absSpread<=7) { const c=Math.min(52+(p-0.5)*130,90); return {vote:'yes',confidence:Math.round(c),edge:p-0.524,reason:`Elo: ${(p*100).toFixed(1)}% implied prob at ${spread} spread — market value window`}; }
      if(p<0.38) { const c=Math.min(52+(0.5-p)*130,88); return {vote:'no',confidence:Math.round(c),edge:0.524-p,reason:`Elo: Away implied ${((1-p)*100).toFixed(1)}% — dog value on spread`}; }
      return {vote:'neu',confidence:52,edge:0,reason:`Elo: ${(p*100).toFixed(1)}% implied — no edge`};
    },

    // 2. PYTHAGOREAN EXPECTATION — True winning % from scoring ratio
    pyth(game, data) {
      const events=data.espn?.events||[];
      const ht=game.home_team;
      let hPF=0,hPA=0,n=0;
      events.slice(0,15).forEach(e=>{
        const comp=e.competitions?.[0];if(!comp)return;
        const home=comp.competitors?.find(c=>c.homeAway==='home');
        const away=comp.competitors?.find(c=>c.homeAway==='away');
        if(!home||!away)return;
        const hs=parseInt(home.score||0),as=parseInt(away.score||0);
        if(!hs&&!as)return;
        if(home.team?.displayName===ht){hPF+=hs;hPA+=as;n++;}
        else if(away.team?.displayName===ht){hPF+=as;hPA+=hs;n++;}
      });
      if(n<4||!hPF) return {vote:'neu',confidence:50,edge:0,reason:'Pythagorean: Need 4+ scored games'};
      const exp=game._sport==='NBA'?13.91:game._sport==='NFL'?2.37:game._sport==='MLB'?1.83:2.0;
      const pyth=(hPF**exp)/((hPF**exp)+(hPA**exp));
      if(pyth>0.62){const c=Math.min(56+(pyth-0.62)*280,92);return{vote:'yes',confidence:Math.round(c),edge:pyth-0.524,reason:`Pythagorean: ${(pyth*100).toFixed(1)}% win expectation (${n} game sample)`};}
      if(pyth<0.38)return{vote:'no',confidence:Math.min(56+(0.38-pyth)*280,90),edge:0.524-pyth,reason:`Pythagorean: ${(pyth*100).toFixed(1)}% — fade home`};
      return{vote:'neu',confidence:51,edge:0,reason:`Pythagorean: ${(pyth*100).toFixed(1)}% — no edge`};
    },

    // 3. SIMPLE RATING SYSTEM — MOV adjusted for opponent quality
    srs(game, data) {
      const events=data.espn?.events||[];
      const ht=game.home_team;
      let movTotal=0,n=0;
      events.slice(0,10).forEach(e=>{
        const comp=e.competitions?.[0];if(!comp)return;
        const home=comp.competitors?.find(c=>c.homeAway==='home');
        const away=comp.competitors?.find(c=>c.homeAway==='away');
        if(!home||!away)return;
        const hs=parseInt(home.score||0),as=parseInt(away.score||0);
        if(!hs&&!as)return;
        if(home.team?.displayName===ht){movTotal+=(hs-as);n++;}
      });
      if(n<4) return {vote:'neu',confidence:50,edge:0,reason:'SRS: Need 4+ games'};
      const avgMOV=movTotal/n;
      const spread=game._spread||0;
      const srs=avgMOV+spread; // positive = home covers
      if(srs>6)return{vote:'yes',confidence:Math.min(63+srs,90),edge:Math.min(srs/60,0.12),reason:`SRS: +${srs.toFixed(1)} adjusted edge over spread`};
      if(srs<-6)return{vote:'no',confidence:Math.min(61+Math.abs(srs),88),edge:Math.min(Math.abs(srs)/60,0.10),reason:`SRS: −${Math.abs(srs).toFixed(1)} — home underperforming spread`};
      return{vote:'neu',confidence:51,edge:0,reason:`SRS: ${srs.toFixed(1)} — no material edge`};
    },

    // 4. SHARP MONEY INDICATOR — Professional bettor positioning
    sharp(game, data) {
      const an=data.actionNetwork;
      const hist=getHist(game.id);
      // Action Network is primary source; line history as fallback
      const sharpPct=an?.consensus?.sharp_money_pct||hist?.sharp_pct||null;
      const open=hist?.spread, current=game._spread;
      if(sharpPct===null) return {vote:'neu',confidence:50,edge:0,reason:'Sharp: Action Network not connected'};
      if(open===null||current===null) return {vote:'neu',confidence:50,edge:0,reason:'Sharp: No opening line'};
      const move=current-open;
      const sharpHome=sharpPct>55;
      const lineConfirms=(sharpHome&&move<0)||(!sharpHome&&move>0);
      if(sharpPct>=75&&lineConfirms)return{vote:'yes',confidence:88,edge:0.11,reason:`Sharp: ${sharpPct}% sharp on home + line confirmed — max signal`};
      if(sharpPct>=65&&lineConfirms)return{vote:'yes',confidence:78,edge:0.07,reason:`Sharp: ${sharpPct}% sharp action confirmed by line`};
      if(sharpPct>=55&&lineConfirms)return{vote:'yes',confidence:66,edge:0.04,reason:`Sharp: ${sharpPct}% sharp — moderate signal`};
      if(sharpPct<=25)return{vote:'no',confidence:75,edge:0.06,reason:`Sharp: Only ${sharpPct}% sharp on home — strong fade`};
      if(sharpPct<=35)return{vote:'no',confidence:64,edge:0.03,reason:`Sharp: ${sharpPct}% — lean fade`};
      return{vote:'neu',confidence:52,edge:0,reason:`Sharp: ${sharpPct}% — no decisive signal`};
    },

    // 5. CLOSING LINE VALUE — Gold standard long-term edge metric
    clv(game, data) {
      const hist=getHist(game.id);
      if(!hist?.spread) return {vote:'neu',confidence:50,edge:0,reason:'CLV: No opening line recorded'};
      const open=hist.spread, current=game._spread;
      if(current===null) return {vote:'neu',confidence:50,edge:0,reason:'CLV: No current line'};
      const move=current-open;
      if(move<=-2.5)return{vote:'yes',confidence:90,edge:0.13,reason:`CLV: Moved ${move} in home favor — elite positive CLV`};
      if(move<=-1.5)return{vote:'yes',confidence:82,edge:0.09,reason:`CLV: +${Math.abs(move)} CLV — strong signal`};
      if(move<=-0.5)return{vote:'yes',confidence:70,edge:0.05,reason:`CLV: ${move} — positive CLV edge`};
      if(move>=2.5)return{vote:'no',confidence:88,edge:0.12,reason:`CLV: Moved +${move} against home — strong negative CLV`};
      if(move>=1.5)return{vote:'no',confidence:80,edge:0.08,reason:`CLV: Line shifted +${move} against home`};
      if(move>=0.5)return{vote:'no',confidence:66,edge:0.04,reason:`CLV: Slight negative CLV (+${move})`};
      return{vote:'neu',confidence:53,edge:0,reason:'CLV: Line stable — no CLV edge'};
    },

    // 6. STEAM MOVE DETECTOR — Rapid sharp syndicate action
    steam(game, data) {
      const hist=getHist(game.id);
      const an=data.actionNetwork;
      if(!hist?.spread) return {vote:'neu',confidence:50,edge:0,reason:'Steam: No opening line'};
      const diff=Math.abs((game._spread||0)-hist.spread);
      const hoursOut=(new Date(game.commence_time)-new Date())/3600000;
      const anSteam=an?.consensus?.steam_move||false;
      if((anSteam||diff>=2.5)&&hoursOut<=24)return{vote:'yes',confidence:90,edge:0.13,reason:`Steam: ${diff}pt rapid move ${hoursOut.toFixed(0)}h out — confirmed syndicate`};
      if(diff>=2&&hoursOut<=48)return{vote:'yes',confidence:84,edge:0.10,reason:`Steam: ${diff}pt move — sharp syndicate signal`};
      if(diff>=1.5&&hoursOut<=36)return{vote:'yes',confidence:76,edge:0.07,reason:`Steam: ${diff}pt late move detected`};
      if(diff>=1)return{vote:'yes',confidence:65,edge:0.04,reason:`Steam: ${diff}pt shift — possible steam`};
      return{vote:'neu',confidence:50,edge:0,reason:'Steam: None detected'};
    },

    // 7. REVERSE LINE MOVEMENT — Sharpest signal: line vs public
    rlm(game, data) {
      const an=data.actionNetwork;
      const hist=getHist(game.id);
      const pubPct=an?.consensus?.home_ticket_pct||hist?.public_pct||null;
      const open=hist?.spread, current=game._spread;
      if(pubPct===null||!open||current===null) return {vote:'neu',confidence:50,edge:0,reason:'RLM: Needs Action Network or line history'};
      const move=current-open;
      const pubHome=pubPct>55;
      const against=(pubHome&&move>0.5)||(!pubHome&&move<-0.5);
      if(pubPct>=75&&against)return{vote:pubHome?'no':'yes',confidence:88,edge:0.12,reason:`RLM: ${pubPct}% public on home but line moved opposite — elite sharp signal`};
      if(pubPct>=65&&against)return{vote:pubHome?'no':'yes',confidence:78,edge:0.08,reason:`RLM: ${pubPct}% public, line against them — strong RLM`};
      if(pubPct>=58&&against)return{vote:pubHome?'no':'yes',confidence:68,edge:0.05,reason:`RLM: ${pubPct}% public, moderate RLM`};
      return{vote:'neu',confidence:51,edge:0,reason:'RLM: Not detected'};
    },

    // 8. PACE & TEMPO — Possessions drive totals edge
    pace(game, data) {
      const total=game._total;
      if(!total) return {vote:'neu',confidence:50,edge:0,reason:'Pace: No total set'};
      const events=data.espn?.events||[];
      let sumTotal=0,n=0;
      events.slice(0,12).forEach(e=>{
        const scores=e.competitions?.[0]?.competitors?.map(c=>parseInt(c.score||0))||[];
        const t=scores.reduce((a,b)=>a+b,0);
        if(t>0){sumTotal+=t;n++;}
      });
      if(n<4) return {vote:'neu',confidence:50,edge:0,reason:'Pace: Insufficient scoring history'};
      const avg=sumTotal/n;
      const deviation=((total-avg)/avg)*100;
      if(deviation>8)return{vote:'no',confidence:Math.min(63+deviation,86),edge:Math.min(deviation/100,0.09),reason:`Pace: Total ${total} is ${deviation.toFixed(1)}% above 12-game avg — under value`};
      if(deviation<-8)return{vote:'yes',confidence:Math.min(61+Math.abs(deviation),84),edge:Math.min(Math.abs(deviation)/100,0.08),reason:`Pace: Total ${total} is ${Math.abs(deviation).toFixed(1)}% below avg — over value`};
      return{vote:'neu',confidence:51,edge:0,reason:`Pace: Total ${total} near ${avg.toFixed(0)} avg — no edge`};
    },

    // 9. STRENGTH OF SCHEDULE — Sportradar standings adjusted
    sos(game, data) {
      const sr=data.sportradar;
      if(!sr) {
        // ESPN fallback
        const events=data.espn?.events||[];
        const ht=game.home_team;
        let oppScoreSum=0,n=0;
        events.slice(0,10).forEach(e=>{
          const comp=e.competitions?.[0];if(!comp)return;
          const home=comp.competitors?.find(c=>c.homeAway==='home');
          const away=comp.competitors?.find(c=>c.homeAway==='away');
          if(!home||!away)return;
          if(home.team?.displayName===ht){oppScoreSum+=parseInt(away.score||0);n++;}
        });
        if(n<4) return {vote:'neu',confidence:50,edge:0,reason:'SOS: Sportradar not connected — ESPN fallback insufficient'};
        const avg=oppScoreSum/n;
        const sport=game._sport;
        if(avg>27&&sport==='NFL')return{vote:'yes',confidence:67,edge:0.04,reason:`SOS: Tough schedule (avg opp ${avg.toFixed(0)} pts NFL) — team undervalued`};
        if(avg>112&&sport==='NBA')return{vote:'yes',confidence:65,edge:0.03,reason:`SOS: High opp avg ${avg.toFixed(0)} NBA — battle-tested edge`};
        return{vote:'neu',confidence:51,edge:0,reason:'SOS: Average schedule difficulty'};
      }
      // Full Sportradar SOS calculation
      const standings=sr.standings||[];
      const homeTeam=standings.find(t=>t.name===game.home_team);
      if(!homeTeam) return {vote:'neu',confidence:51,edge:0,reason:'SOS: Team not in Sportradar standings'};
      const sosRank=homeTeam.sos_rank||null;
      if(!sosRank) return {vote:'neu',confidence:51,edge:0,reason:'SOS: No SOS data in Sportradar'};
      const totalTeams=standings.length;
      const percentile=(totalTeams-sosRank)/totalTeams;
      if(percentile>0.75)return{vote:'yes',confidence:70,edge:0.05,reason:`SOS: Top ${Math.round((1-percentile)*100)}% schedule difficulty — undervalued team`};
      if(percentile<0.25)return{vote:'no',confidence:64,edge:0.03,reason:`SOS: Easy schedule — team may be overvalued`};
      return{vote:'neu',confidence:51,edge:0,reason:`SOS: Average schedule (${sosRank}/${totalTeams})`};
    },

    // 10. REST & RECOVERY INDEX — Days rest from Sportradar schedule
    rest(game, data) {
      const schedule=data.schedule||[];
      const gameDate=new Date(game.commence_time);
      if(!schedule.length){
        // ESPN fallback
        const events=data.espn?.events||[];
        const last=events[0]?.date?new Date(events[0].date):null;
        if(!last) return {vote:'neu',confidence:50,edge:0,reason:'Rest: No schedule data'};
        const days=Math.round((gameDate-last)/86400000);
        if(days===0)return{vote:'no',confidence:75,edge:0.06,reason:'Rest: Back-to-back — fatigue quantified'};
        if(days===1)return{vote:'no',confidence:63,edge:0.03,reason:'Rest: 1 day — fatigue concern'};
        if(days>=7)return{vote:'yes',confidence:74,edge:0.06,reason:`Rest: ${days} days — peak recovery + hunger`};
        if(days>=4)return{vote:'yes',confidence:64,edge:0.03,reason:`Rest: ${days} days — adequate recovery`};
        return{vote:'neu',confidence:52,edge:0,reason:`Rest: ${days} days — neutral`};
      }
      // Sportradar: find actual last game
      const pastGames=schedule.filter(g=>new Date(g.scheduled)<gameDate).sort((a,b)=>new Date(b.scheduled)-new Date(a.scheduled));
      const lastGame=pastGames[0];
      if(!lastGame) return {vote:'neu',confidence:51,edge:0,reason:'Rest: No past games in schedule'};
      const days=Math.round((gameDate-new Date(lastGame.scheduled))/86400000);
      if(days===0)return{vote:'no',confidence:76,edge:0.07,reason:'Rest: Back-to-back confirmed via Sportradar'};
      if(days===1)return{vote:'no',confidence:65,edge:0.04,reason:'Rest: 1 day rest — Sportradar confirmed'};
      if(days>=7)return{vote:'yes',confidence:76,edge:0.07,reason:`Rest: ${days} days rest — Sportradar confirmed`};
      if(days>=4)return{vote:'yes',confidence:66,edge:0.04,reason:`Rest: ${days} days rest`};
      return{vote:'neu',confidence:52,edge:0,reason:`Rest: ${days} days — neutral`};
    },

    // 11. TRAVEL FATIGUE — Cross-timezone travel from Sportradar locations
    travel(game, data) {
      const sr=data.sportradar;
      let homeCity=null, awayCity=null;
      if(sr?.venue) {
        homeCity=sr.venue.city;
      }
      // City from team name as fallback
      const east=['Boston','Brooklyn','Philadelphia','Toronto','Miami','Orlando','Atlanta','Charlotte','Washington','Cleveland','Indiana','Detroit','Milwaukee'];
      const west=['Los Angeles','Golden State','Portland','Sacramento','Phoenix','Utah','Denver','Dallas','Houston','San Antonio','Oklahoma','Memphis'];
      const getZone=t=>east.some(c=>t.includes(c.split(' ')[0]))?0:west.some(c=>t.includes(c.split(' ')[0]))?3:1;
      const homeZone=getZone(game.home_team);
      const awayZone=getZone(game.away_team);
      const tzDiff=Math.abs(homeZone-awayZone);
      if(tzDiff===0)return{vote:'neu',confidence:51,edge:0,reason:'Travel: Same timezone — no edge'};
      if(tzDiff>=3)return{vote:'yes',confidence:72,edge:0.06,reason:`Travel: ${tzDiff} timezone cross-country — home advantage quantified`};
      if(tzDiff>=2)return{vote:'yes',confidence:64,edge:0.04,reason:`Travel: ${tzDiff} timezone shift — home edge`};
      return{vote:'yes',confidence:57,edge:0.02,reason:'Travel: 1 timezone difference — minor home edge'};
    },

    // 12. WEATHER IMPACT — OpenWeatherMap real-time outdoor conditions
    weather(game, data) {
      const sport=game._sport;
      if(['NBA','NHL','NCAAB'].includes(sport))return{vote:'neu',confidence:50,edge:0,reason:'Weather: Indoor sport — N/A'};
      const w=data.weather;
      const total=game._total;
      if(!w) {
        // No weather API: use season/month heuristic
        const month=new Date(game.commence_time).getMonth();
        const coldMarkets=['Green Bay','Chicago','Cleveland','Buffalo','New England','New York Jets','New York Giants','Philadelphia','Pittsburgh','Minnesota','Kansas City'];
        const inCold=coldMarkets.some(m=>game.home_team.includes(m.split(' ')[0]));
        if(sport==='NFL'&&(month>=9||month<=1)&&inCold)return{vote:'no',confidence:68,edge:0.05,reason:'Weather: Cold market winter game — scoring suppression (heuristic)'};
        if(sport==='MLB'&&month<=4)return{vote:'no',confidence:62,edge:0.03,reason:'Weather: Early MLB season cold — ball carry suppressed'};
        return{vote:'neu',confidence:51,edge:0,reason:'Weather: OpenWeatherMap not connected — using heuristics'};
      }
      // Real weather data
      const wind=w.data?.[0]?.wind_speed||0;
      const temp=w.data?.[0]?.temp||60;
      const rain=w.data?.[0]?.rain?.['1h']||0;
      const snow=w.data?.[0]?.snow?.['1h']||0;
      const precip=rain+snow;
      if(wind>20||precip>0.3||temp<25)return{vote:'no',confidence:Math.min(70+wind/2+precip*10,90),edge:Math.min((wind/200+precip/10),0.12),reason:`Weather: Wind ${wind.toFixed(0)}mph, Temp ${temp.toFixed(0)}°F, Precip ${precip.toFixed(2)}" — scoring suppression`};
      if(wind>12||temp<35)return{vote:'no',confidence:64,edge:0.04,reason:`Weather: Wind ${wind.toFixed(0)}mph, Temp ${temp.toFixed(0)}°F — moderate impact`};
      if(temp>80&&wind<5)return{vote:'yes',confidence:60,edge:0.02,reason:`Weather: Ideal conditions ${temp.toFixed(0)}°F — scoring favorable`};
      return{vote:'neu',confidence:51,edge:0,reason:`Weather: Neutral conditions (${temp.toFixed(0)}°F, ${wind.toFixed(0)}mph)`};
    },

    // 13. HOME/AWAY SPLIT — Historical cover rates by spread range and sport
    ha(game, data) {
      const spread=game._spread;
      const sport=game._sport;
      if(spread===null)return{vote:'neu',confidence:50,edge:0,reason:'H/A: No spread'};
      // NBA: home -1 to -5 cover at ~53.5% historically
      if(sport==='NBA'&&spread>=-5&&spread<=-1)return{vote:'yes',confidence:67,edge:0.035,reason:`H/A: NBA home ${spread} — 53.5% historical cover rate`};
      // NFL: home underdogs +1.5 to +6 cover at ~54% historically
      if(sport==='NFL'&&spread>=1.5&&spread<=6)return{vote:'yes',confidence:66,edge:0.03,reason:`H/A: NFL home dog +${spread} — historical 54% ATS`};
      // MLB: home -110 to -130 ML hits at ~54%
      if(sport==='MLB'&&game._ml&&game._ml>=-130&&game._ml<=-105)return{vote:'yes',confidence:64,edge:0.025,reason:'H/A: MLB home moderate favorite — 54% historical ML'};
      // NHL: home ice historically worth ~0.3 goals
      if(sport==='NHL'&&spread>=-1.5&&spread<=0)return{vote:'yes',confidence:62,edge:0.02,reason:'H/A: NHL home ice — 0.3 goal historical edge'};
      // Fade large home favorites
      if(spread<=-10)return{vote:'no',confidence:70,edge:0.05,reason:`H/A: Large favorite ${spread} — historical fade spot (52.8% for dogs)`};
      if(spread<=-7)return{vote:'no',confidence:62,edge:0.03,reason:`H/A: Heavy favorite ${spread} — moderate fade value`};
      return{vote:'neu',confidence:51,edge:0,reason:'H/A: No historical split edge at this number'};
    },

    // 14. ATS TREND — Cover rate from Supabase pick history
    ats(game, data) {
      const picks=JSON.parse(localStorage.getItem('edge_picks_local')||'[]');
      const rel=picks.filter(p=>p.matchup?.includes(game.home_team)&&p.result&&p.pick_type==='ATS');
      if(rel.length<6) return {vote:'neu',confidence:50,edge:0,reason:`ATS: Need 6+ games (have ${rel.length})`};
      const wins=rel.filter(p=>p.result==='W').length;
      const pct=wins/rel.length;
      const rec=`${wins}-${rel.length-wins}`;
      if(pct>0.65)return{vote:'yes',confidence:Math.min(60+pct*35,88),edge:pct-0.524,reason:`ATS: ${rec} cover record — ${(pct*100).toFixed(0)}% rate`};
      if(pct>0.58)return{vote:'yes',confidence:64,edge:pct-0.524,reason:`ATS: ${rec} — trending above breakeven`};
      if(pct<0.35)return{vote:'no',confidence:Math.min(60+(0.524-pct)*60,86),edge:0.524-pct,reason:`ATS: ${rec} — ${(pct*100).toFixed(0)}% cover rate — strong fade`};
      if(pct<0.42)return{vote:'no',confidence:62,edge:0.524-pct,reason:`ATS: ${rec} — below breakeven`};
      return{vote:'neu',confidence:51,edge:0,reason:`ATS: ${rec} — neutral trend`};
    },

    // 15. RECENT FORM INDEX — Last 5 weighted with recency bias
    form(game, data) {
      const events=data.espn?.events||[];
      if(!events.length)return{vote:'neu',confidence:50,edge:0,reason:'Form: No ESPN data'};
      const last5=events.slice(0,5);
      let weightedScore=0, totalWeight=0;
      last5.forEach((e,i)=>{
        const w=5-i; // most recent = weight 5
        const home=e.competitions?.[0]?.competitors?.find(c=>c.homeAway==='home');
        const winner=home?.winner===true;
        weightedScore+=winner?w:0;
        totalWeight+=w;
      });
      const formPct=totalWeight>0?weightedScore/totalWeight:0.5;
      const wins=last5.filter(e=>e.competitions?.[0]?.competitors?.find(c=>c.homeAway==='home')?.winner===true).length;
      if(formPct>0.72)return{vote:'yes',confidence:Math.min(67+formPct*25,88),edge:formPct-0.524,reason:`Form: ${wins}/5 wins, weighted ${(formPct*100).toFixed(0)}% — hot streak`};
      if(formPct<0.28)return{vote:'no',confidence:Math.min(65+(0.524-formPct)*30,86),edge:0.524-formPct,reason:`Form: ${wins}/5, weighted ${(formPct*100).toFixed(0)}% — cold streak`};
      return{vote:'neu',confidence:52,edge:0,reason:`Form: ${wins}/5 wins — neutral momentum`};
    },

  };

  // Export Part 1 internals for Part 2
  return { _p1: true, ALGORITHMS, WKEY, W, KEY, SPORTS, getHist, saveHist, getVal, oddsToProb, kellyUnits, fetchOddsGames, fetchESPN, fetchESPNTeam, fetchSportradar, fetchActionNetwork, fetchWeather, fetchInjuries, fetchSchedule, loadAlgoSettings, startAuto, stopAuto };

})();


const EDGE_ENGINE = (() => {

  // ── API KEYS (all from localStorage — set in Admin) ──
  const KEY = {
    odds:          () => localStorage.getItem('edge_odds_api_key'),
    supabaseUrl:   () => localStorage.getItem('edge_supabase_url'),
    supabaseKey:   () => localStorage.getItem('edge_supabase_key'),
    claude:        () => localStorage.getItem('edge_claude_api_key'),
    sportradar:    () => localStorage.getItem('edge_sportradar_key'),
    actionNetwork: () => localStorage.getItem('edge_action_network_key'),
    weather:       () => localStorage.getItem('edge_weather_key'),
  };

  // ── SPORTS ──
  const SPORTS = [
    { oddsKey: 'americanfootball_nfl',   label: 'NFL',   srKey: 'nfl',        espnPath: 'football/nfl' },
    { oddsKey: 'basketball_nba',         label: 'NBA',   srKey: 'nba',        espnPath: 'basketball/nba' },
    { oddsKey: 'baseball_mlb',           label: 'MLB',   srKey: 'mlb',        espnPath: 'baseball/mlb' },
    { oddsKey: 'icehockey_nhl',          label: 'NHL',   srKey: 'nhl',        espnPath: 'hockey/nhl' },
    { oddsKey: 'americanfootball_ncaaf', label: 'NCAAF', srKey: 'ncaafb',     espnPath: 'football/college-football' },
    { oddsKey: 'basketball_ncaab',       label: 'NCAAB', srKey: 'ncaamb',     espnPath: 'basketball/mens-college-basketball' },
    { oddsKey: 'soccer_usa_mls',         label: 'MLS',   srKey: 'mls',        espnPath: 'soccer/usa.1' },
  ];

  // ── SPORT-SPECIFIC ALGORITHM WEIGHTS ──
  const W = {
    NFL:  { elo:10,pyth:8,srs:8,sharp:10,clv:10,steam:9,rlm:9,pace:5,sos:8,rest:9,travel:8,weather:10,ha:7,ats:8,form:8,public:8,spot:9,coach:9,injury:10,prime:8,div:9,revenge:8,loc:9,totals:7,reg:7 },
    NBA:  { elo:9,pyth:10,srs:7,sharp:9,clv:10,steam:8,rlm:8,pace:10,sos:6,rest:10,travel:9,weather:1,ha:8,ats:7,form:10,public:7,spot:8,coach:8,injury:10,prime:6,div:5,revenge:7,loc:9,totals:9,reg:8 },
    MLB:  { elo:7,pyth:9,srs:6,sharp:9,clv:10,steam:8,rlm:8,pace:7,sos:7,rest:8,travel:7,weather:10,ha:8,ats:8,form:9,public:8,spot:7,coach:7,injury:9,prime:5,div:8,revenge:6,loc:9,totals:10,reg:9 },
    NHL:  { elo:8,pyth:8,srs:7,sharp:9,clv:10,steam:8,rlm:8,pace:9,sos:7,rest:9,travel:8,weather:1,ha:9,ats:7,form:9,public:7,spot:7,coach:8,injury:10,prime:6,div:8,revenge:7,loc:9,totals:8,reg:7 },
    DEFAULT:{ elo:7,pyth:7,srs:6,sharp:8,clv:9,steam:7,rlm:7,pace:7,sos:6,rest:8,travel:7,weather:5,ha:7,ats:7,form:8,public:7,spot:7,coach:6,injury:8,prime:5,div:6,revenge:6,loc:8,totals:7,reg:7 },
  };

  const WKEY = ['elo','pyth','srs','sharp','clv','steam','rlm','pace','sos','rest','travel','weather','ha','ats','form','public','spot','coach','injury','prime','div','revenge','loc','totals','reg'];

  // ── AUTO SCHEDULE ──
  let autoInterval = null;
  const startAuto = (ms=1800000) => { if(autoInterval) clearInterval(autoInterval); autoInterval=setInterval(()=>runFullEngine(),ms); };
  const stopAuto  = () => { if(autoInterval) clearInterval(autoInterval); autoInterval=null; };

  // ── KELLY CRITERION ──
  function kellyUnits(confidence, americanOdds, bankroll) {
    const p = Math.min(confidence/100, 0.95);
    const q = 1-p;
    const b = americanOdds>0 ? americanOdds/100 : 100/Math.abs(americanOdds||110);
    const kelly = (b*p-q)/b;
    const frac  = kelly*0.25; // 25% fractional Kelly for risk management
    if(frac<=0) return 0;
    const unitSize = parseFloat(localStorage.getItem('edge_unit_size')||'50');
    return Math.min(Math.max(Math.round(((frac*(bankroll||1000))/unitSize)*2)/2, 0.5), 5);
  }

  const oddsToProb = o => !o?0.5:o>0?100/(o+100):Math.abs(o)/(Math.abs(o)+100);

  // ── HELPER: GET MARKET VALUE FROM ODDS API ──
  function getVal(game, market, side, field) {
    try {
      const bk  = game.bookmakers?.[0];
      const mkt = bk?.markets?.find(m=>m.key===market);
      const out = mkt?.outcomes?.find(o=>side==='home'?o.name===game.home_team:side==='away'?o.name===game.away_team:o.name===side);
      return out?.[field]??null;
    } catch { return null; }
  }

  // ── LINE HISTORY ──
  function getHist(id) { try { return JSON.parse(localStorage.getItem('edge_line_history')||'{}')[id]||null; } catch { return null; } }
  function saveHist(id,data) { try { const h=JSON.parse(localStorage.getItem('edge_line_history')||'{}'); if(!h[id])h[id]={...data,saved_at:new Date().toISOString()}; localStorage.setItem('edge_line_history',JSON.stringify(h)); } catch {} }

  // ============================================================
  // ── DATA FETCHERS ──
  // Each returns null if API not connected — engine degrades gracefully
  // ============================================================

  async function fetchOddsGames() {
    const key=KEY.odds();
    if(!key) throw new Error('Odds API key not set');
    const games=[];
    for(const sport of SPORTS) {
      try {
        const r=await fetch(`https://api.the-odds-api.com/v4/sports/${sport.oddsKey}/odds/?apiKey=${key}&regions=us&markets=spreads,h2h,totals&oddsFormat=american`);
        if(!r.ok) continue;
        const data=await r.json();
        data.forEach(g=>{ g._sport=sport.label; g._sportConfig=sport; games.push(g); });
      } catch {}
    }
    return games;
  }

  async function fetchESPN(sportConfig) {
    try {
      const r=await fetch(`https://site.api.espn.com/apis/site/v2/sports/${sportConfig.espnPath}/scoreboard`);
      return r.ok?await r.json():null;
    } catch { return null; }
  }

  async function fetchESPNTeam(sportConfig, teamName) {
    try {
      const search=await fetch(`https://site.api.espn.com/apis/site/v2/sports/${sportConfig.espnPath}/teams?limit=200`);
      if(!search.ok) return null;
      const data=await search.json();
      const team=data.sports?.[0]?.leagues?.[0]?.teams?.find(t=>t.team?.displayName===teamName||t.team?.shortDisplayName===teamName);
      if(!team?.team?.id) return null;
      const r=await fetch(`https://site.api.espn.com/apis/site/v2/sports/${sportConfig.espnPath}/teams/${team.team.id}`);
      return r.ok?await r.json():null;
    } catch { return null; }
  }

  async function fetchSportradar(sport, endpoint) {
    const key=KEY.sportradar();
    if(!key) return null;
    try {
      const r=await fetch(`https://api.sportradar.com/${sport}/trial/v7/en/${endpoint}.json?api_key=${key}`);
      return r.ok?await r.json():null;
    } catch { return null; }
  }

  async function fetchActionNetwork(gameId) {
    const key=KEY.actionNetwork();
    if(!key) return null;
    try {
      const r=await fetch(`https://api.actionnetwork.com/web/v1/games/${gameId}/odds`,{headers:{'Authorization':`Bearer ${key}`}});
      return r.ok?await r.json():null;
    } catch { return null; }
  }

  async function fetchWeather(venue, gameDate) {
    const key=KEY.weather();
    if(!key) return null;
    try {
      const geo=await fetch(`https://api.openweathermap.org/geo/1.0/direct?q=${encodeURIComponent(venue)}&limit=1&appid=${key}`);
      if(!geo.ok) return null;
      const geoData=await geo.json();
      if(!geoData[0]) return null;
      const {lat,lon}=geoData[0];
      const ts=Math.floor(new Date(gameDate).getTime()/1000);
      const r=await fetch(`https://api.openweathermap.org/data/3.0/onecall/timemachine?lat=${lat}&lon=${lon}&dt=${ts}&appid=${key}&units=imperial`);
      return r.ok?await r.json():null;
    } catch { return null; }
  }

  async function fetchInjuries(sportConfig, teamName) {
    const key=KEY.sportradar();
    if(!key) return null;
    try {
      const r=await fetch(`https://api.sportradar.com/${sportConfig.srKey}/trial/v7/en/league/injuries.json?api_key=${key}`);
      if(!r.ok) return null;
      const data=await r.json();
      // Filter to team
      const teams=data.teams||data.league?.teams||[];
      return teams.find(t=>t.name===teamName||t.alias===teamName)||null;
    } catch { return null; }
  }

  async function fetchSchedule(sportConfig, teamName) {
    const key=KEY.sportradar();
    if(!key) return null;
    try {
      const season=new Date().getFullYear();
      const r=await fetch(`https://api.sportradar.com/${sportConfig.srKey}/trial/v7/en/seasons/${season}/schedules.json?api_key=${key}`);
      if(!r.ok) return null;
      const data=await r.json();
      const games=(data.games||data.schedule||[]).filter(g=>g.home?.name===teamName||g.away?.name===teamName);
      return games;
    } catch { return null; }
  }

  // ── LOAD ALGO SETTINGS FROM SUPABASE ──
  async function loadAlgoSettings() {
    const url=KEY.supabaseUrl(), key=KEY.supabaseKey();
    if(!url||!key) return Array.from({length:25},(_,i)=>({id:i+1,enabled:true,weight:5}));
    try {
      const r=await fetch(`${url}/rest/v1/algorithms?select=*&order=id`,{headers:{'apikey':key,'Authorization':`Bearer ${key}`}});
      return r.ok?await r.json():Array.from({length:25},(_,i)=>({id:i+1,enabled:true,weight:5}));
    } catch { return Array.from({length:25},(_,i)=>({id:i+1,enabled:true,weight:5})); }
  }

  // ============================================================
  // ── ELITE 25 ALGORITHMS ──
  // Each returns: { vote:'yes'|'no'|'neu', confidence:0-100, edge:0-1, reason:string }
  // Degrades gracefully — returns 'neu' when data unavailable
  // ============================================================

  const ALGORITHMS = {

    // 1. ELO RATING — Dynamic power rating from implied market probability
    elo(game, data) {
      const ml=game._ml, spread=game._spread;
      if(spread===null) return {vote:'neu',confidence:50,edge:0,reason:'Elo: No market data'};
      const p=ml?oddsToProb(ml):0.5;
      const absSpread=Math.abs(spread);
      // Value window: implied prob significantly above breakeven in reasonable spread range
      if(p>0.62&&absSpread<=7) { const c=Math.min(52+(p-0.5)*130,90); return {vote:'yes',confidence:Math.round(c),edge:p-0.524,reason:`Elo: ${(p*100).toFixed(1)}% implied prob at ${spread} spread — market value window`}; }
      if(p<0.38) { const c=Math.min(52+(0.5-p)*130,88); return {vote:'no',confidence:Math.round(c),edge:0.524-p,reason:`Elo: Away implied ${((1-p)*100).toFixed(1)}% — dog value on spread`}; }
      return {vote:'neu',confidence:52,edge:0,reason:`Elo: ${(p*100).toFixed(1)}% implied — no edge`};
    },

    // 2. PYTHAGOREAN EXPECTATION — True winning % from scoring ratio
    pyth(game, data) {
      const events=data.espn?.events||[];
      const ht=game.home_team;
      let hPF=0,hPA=0,n=0;
      events.slice(0,15).forEach(e=>{
        const comp=e.competitions?.[0];if(!comp)return;
        const home=comp.competitors?.find(c=>c.homeAway==='home');
        const away=comp.competitors?.find(c=>c.homeAway==='away');
        if(!home||!away)return;
        const hs=parseInt(home.score||0),as=parseInt(away.score||0);
        if(!hs&&!as)return;
        if(home.team?.displayName===ht){hPF+=hs;hPA+=as;n++;}
        else if(away.team?.displayName===ht){hPF+=as;hPA+=hs;n++;}
      });
      if(n<4||!hPF) return {vote:'neu',confidence:50,edge:0,reason:'Pythagorean: Need 4+ scored games'};
      const exp=game._sport==='NBA'?13.91:game._sport==='NFL'?2.37:game._sport==='MLB'?1.83:2.0;
      const pyth=(hPF**exp)/((hPF**exp)+(hPA**exp));
      if(pyth>0.62){const c=Math.min(56+(pyth-0.62)*280,92);return{vote:'yes',confidence:Math.round(c),edge:pyth-0.524,reason:`Pythagorean: ${(pyth*100).toFixed(1)}% win expectation (${n} game sample)`};}
      if(pyth<0.38)return{vote:'no',confidence:Math.min(56+(0.38-pyth)*280,90),edge:0.524-pyth,reason:`Pythagorean: ${(pyth*100).toFixed(1)}% — fade home`};
      return{vote:'neu',confidence:51,edge:0,reason:`Pythagorean: ${(pyth*100).toFixed(1)}% — no edge`};
    },

    // 3. SIMPLE RATING SYSTEM — MOV adjusted for opponent quality
    srs(game, data) {
      const events=data.espn?.events||[];
      const ht=game.home_team;
      let movTotal=0,n=0;
      events.slice(0,10).forEach(e=>{
        const comp=e.competitions?.[0];if(!comp)return;
        const home=comp.competitors?.find(c=>c.homeAway==='home');
        const away=comp.competitors?.find(c=>c.homeAway==='away');
        if(!home||!away)return;
        const hs=parseInt(home.score||0),as=parseInt(away.score||0);
        if(!hs&&!as)return;
        if(home.team?.displayName===ht){movTotal+=(hs-as);n++;}
      });
      if(n<4) return {vote:'neu',confidence:50,edge:0,reason:'SRS: Need 4+ games'};
      const avgMOV=movTotal/n;
      const spread=game._spread||0;
      const srs=avgMOV+spread; // positive = home covers
      if(srs>6)return{vote:'yes',confidence:Math.min(63+srs,90),edge:Math.min(srs/60,0.12),reason:`SRS: +${srs.toFixed(1)} adjusted edge over spread`};
      if(srs<-6)return{vote:'no',confidence:Math.min(61+Math.abs(srs),88),edge:Math.min(Math.abs(srs)/60,0.10),reason:`SRS: −${Math.abs(srs).toFixed(1)} — home underperforming spread`};
      return{vote:'neu',confidence:51,edge:0,reason:`SRS: ${srs.toFixed(1)} — no material edge`};
    },

    // 4. SHARP MONEY INDICATOR — Professional bettor positioning
    sharp(game, data) {
      const an=data.actionNetwork;
      const hist=getHist(game.id);
      // Action Network is primary source; line history as fallback
      const sharpPct=an?.consensus?.sharp_money_pct||hist?.sharp_pct||null;
      const open=hist?.spread, current=game._spread;
      if(sharpPct===null) return {vote:'neu',confidence:50,edge:0,reason:'Sharp: Action Network not connected'};
      if(open===null||current===null) return {vote:'neu',confidence:50,edge:0,reason:'Sharp: No opening line'};
      const move=current-open;
      const sharpHome=sharpPct>55;
      const lineConfirms=(sharpHome&&move<0)||(!sharpHome&&move>0);
      if(sharpPct>=75&&lineConfirms)return{vote:'yes',confidence:88,edge:0.11,reason:`Sharp: ${sharpPct}% sharp on home + line confirmed — max signal`};
      if(sharpPct>=65&&lineConfirms)return{vote:'yes',confidence:78,edge:0.07,reason:`Sharp: ${sharpPct}% sharp action confirmed by line`};
      if(sharpPct>=55&&lineConfirms)return{vote:'yes',confidence:66,edge:0.04,reason:`Sharp: ${sharpPct}% sharp — moderate signal`};
      if(sharpPct<=25)return{vote:'no',confidence:75,edge:0.06,reason:`Sharp: Only ${sharpPct}% sharp on home — strong fade`};
      if(sharpPct<=35)return{vote:'no',confidence:64,edge:0.03,reason:`Sharp: ${sharpPct}% — lean fade`};
      return{vote:'neu',confidence:52,edge:0,reason:`Sharp: ${sharpPct}% — no decisive signal`};
    },

    // 5. CLOSING LINE VALUE — Gold standard long-term edge metric
    clv(game, data) {
      const hist=getHist(game.id);
      if(!hist?.spread) return {vote:'neu',confidence:50,edge:0,reason:'CLV: No opening line recorded'};
      const open=hist.spread, current=game._spread;
      if(current===null) return {vote:'neu',confidence:50,edge:0,reason:'CLV: No current line'};
      const move=current-open;
      if(move<=-2.5)return{vote:'yes',confidence:90,edge:0.13,reason:`CLV: Moved ${move} in home favor — elite positive CLV`};
      if(move<=-1.5)return{vote:'yes',confidence:82,edge:0.09,reason:`CLV: +${Math.abs(move)} CLV — strong signal`};
      if(move<=-0.5)return{vote:'yes',confidence:70,edge:0.05,reason:`CLV: ${move} — positive CLV edge`};
      if(move>=2.5)return{vote:'no',confidence:88,edge:0.12,reason:`CLV: Moved +${move} against home — strong negative CLV`};
      if(move>=1.5)return{vote:'no',confidence:80,edge:0.08,reason:`CLV: Line shifted +${move} against home`};
      if(move>=0.5)return{vote:'no',confidence:66,edge:0.04,reason:`CLV: Slight negative CLV (+${move})`};
      return{vote:'neu',confidence:53,edge:0,reason:'CLV: Line stable — no CLV edge'};
    },

    // 6. STEAM MOVE DETECTOR — Rapid sharp syndicate action
    steam(game, data) {
      const hist=getHist(game.id);
      const an=data.actionNetwork;
      if(!hist?.spread) return {vote:'neu',confidence:50,edge:0,reason:'Steam: No opening line'};
      const diff=Math.abs((game._spread||0)-hist.spread);
      const hoursOut=(new Date(game.commence_time)-new Date())/3600000;
      const anSteam=an?.consensus?.steam_move||false;
      if((anSteam||diff>=2.5)&&hoursOut<=24)return{vote:'yes',confidence:90,edge:0.13,reason:`Steam: ${diff}pt rapid move ${hoursOut.toFixed(0)}h out — confirmed syndicate`};
      if(diff>=2&&hoursOut<=48)return{vote:'yes',confidence:84,edge:0.10,reason:`Steam: ${diff}pt move — sharp syndicate signal`};
      if(diff>=1.5&&hoursOut<=36)return{vote:'yes',confidence:76,edge:0.07,reason:`Steam: ${diff}pt late move detected`};
      if(diff>=1)return{vote:'yes',confidence:65,edge:0.04,reason:`Steam: ${diff}pt shift — possible steam`};
      return{vote:'neu',confidence:50,edge:0,reason:'Steam: None detected'};
    },

    // 7. REVERSE LINE MOVEMENT — Sharpest signal: line vs public
    rlm(game, data) {
      const an=data.actionNetwork;
      const hist=getHist(game.id);
      const pubPct=an?.consensus?.home_ticket_pct||hist?.public_pct||null;
      const open=hist?.spread, current=game._spread;
      if(pubPct===null||!open||current===null) return {vote:'neu',confidence:50,edge:0,reason:'RLM: Needs Action Network or line history'};
      const move=current-open;
      const pubHome=pubPct>55;
      const against=(pubHome&&move>0.5)||(!pubHome&&move<-0.5);
      if(pubPct>=75&&against)return{vote:pubHome?'no':'yes',confidence:88,edge:0.12,reason:`RLM: ${pubPct}% public on home but line moved opposite — elite sharp signal`};
      if(pubPct>=65&&against)return{vote:pubHome?'no':'yes',confidence:78,edge:0.08,reason:`RLM: ${pubPct}% public, line against them — strong RLM`};
      if(pubPct>=58&&against)return{vote:pubHome?'no':'yes',confidence:68,edge:0.05,reason:`RLM: ${pubPct}% public, moderate RLM`};
      return{vote:'neu',confidence:51,edge:0,reason:'RLM: Not detected'};
    },

    // 8. PACE & TEMPO — Possessions drive totals edge
    pace(game, data) {
      const total=game._total;
      if(!total) return {vote:'neu',confidence:50,edge:0,reason:'Pace: No total set'};
      const events=data.espn?.events||[];
      let sumTotal=0,n=0;
      events.slice(0,12).forEach(e=>{
        const scores=e.competitions?.[0]?.competitors?.map(c=>parseInt(c.score||0))||[];
        const t=scores.reduce((a,b)=>a+b,0);
        if(t>0){sumTotal+=t;n++;}
      });
      if(n<4) return {vote:'neu',confidence:50,edge:0,reason:'Pace: Insufficient scoring history'};
      const avg=sumTotal/n;
      const deviation=((total-avg)/avg)*100;
      if(deviation>8)return{vote:'no',confidence:Math.min(63+deviation,86),edge:Math.min(deviation/100,0.09),reason:`Pace: Total ${total} is ${deviation.toFixed(1)}% above 12-game avg — under value`};
      if(deviation<-8)return{vote:'yes',confidence:Math.min(61+Math.abs(deviation),84),edge:Math.min(Math.abs(deviation)/100,0.08),reason:`Pace: Total ${total} is ${Math.abs(deviation).toFixed(1)}% below avg — over value`};
      return{vote:'neu',confidence:51,edge:0,reason:`Pace: Total ${total} near ${avg.toFixed(0)} avg — no edge`};
    },

    // 9. STRENGTH OF SCHEDULE — Sportradar standings adjusted
    sos(game, data) {
      const sr=data.sportradar;
      if(!sr) {
        // ESPN fallback
        const events=data.espn?.events||[];
        const ht=game.home_team;
        let oppScoreSum=0,n=0;
        events.slice(0,10).forEach(e=>{
          const comp=e.competitions?.[0];if(!comp)return;
          const home=comp.competitors?.find(c=>c.homeAway==='home');
          const away=comp.competitors?.find(c=>c.homeAway==='away');
          if(!home||!away)return;
          if(home.team?.displayName===ht){oppScoreSum+=parseInt(away.score||0);n++;}
        });
        if(n<4) return {vote:'neu',confidence:50,edge:0,reason:'SOS: Sportradar not connected — ESPN fallback insufficient'};
        const avg=oppScoreSum/n;
        const sport=game._sport;
        if(avg>27&&sport==='NFL')return{vote:'yes',confidence:67,edge:0.04,reason:`SOS: Tough schedule (avg opp ${avg.toFixed(0)} pts NFL) — team undervalued`};
        if(avg>112&&sport==='NBA')return{vote:'yes',confidence:65,edge:0.03,reason:`SOS: High opp avg ${avg.toFixed(0)} NBA — battle-tested edge`};
        return{vote:'neu',confidence:51,edge:0,reason:'SOS: Average schedule difficulty'};
      }
      // Full Sportradar SOS calculation
      const standings=sr.standings||[];
      const homeTeam=standings.find(t=>t.name===game.home_team);
      if(!homeTeam) return {vote:'neu',confidence:51,edge:0,reason:'SOS: Team not in Sportradar standings'};
      const sosRank=homeTeam.sos_rank||null;
      if(!sosRank) return {vote:'neu',confidence:51,edge:0,reason:'SOS: No SOS data in Sportradar'};
      const totalTeams=standings.length;
      const percentile=(totalTeams-sosRank)/totalTeams;
      if(percentile>0.75)return{vote:'yes',confidence:70,edge:0.05,reason:`SOS: Top ${Math.round((1-percentile)*100)}% schedule difficulty — undervalued team`};
      if(percentile<0.25)return{vote:'no',confidence:64,edge:0.03,reason:`SOS: Easy schedule — team may be overvalued`};
      return{vote:'neu',confidence:51,edge:0,reason:`SOS: Average schedule (${sosRank}/${totalTeams})`};
    },

    // 10. REST & RECOVERY INDEX — Days rest from Sportradar schedule
    rest(game, data) {
      const schedule=data.schedule||[];
      const gameDate=new Date(game.commence_time);
      if(!schedule.length){
        // ESPN fallback
        const events=data.espn?.events||[];
        const last=events[0]?.date?new Date(events[0].date):null;
        if(!last) return {vote:'neu',confidence:50,edge:0,reason:'Rest: No schedule data'};
        const days=Math.round((gameDate-last)/86400000);
        if(days===0)return{vote:'no',confidence:75,edge:0.06,reason:'Rest: Back-to-back — fatigue quantified'};
        if(days===1)return{vote:'no',confidence:63,edge:0.03,reason:'Rest: 1 day — fatigue concern'};
        if(days>=7)return{vote:'yes',confidence:74,edge:0.06,reason:`Rest: ${days} days — peak recovery + hunger`};
        if(days>=4)return{vote:'yes',confidence:64,edge:0.03,reason:`Rest: ${days} days — adequate recovery`};
        return{vote:'neu',confidence:52,edge:0,reason:`Rest: ${days} days — neutral`};
      }
      // Sportradar: find actual last game
      const pastGames=schedule.filter(g=>new Date(g.scheduled)<gameDate).sort((a,b)=>new Date(b.scheduled)-new Date(a.scheduled));
      const lastGame=pastGames[0];
      if(!lastGame) return {vote:'neu',confidence:51,edge:0,reason:'Rest: No past games in schedule'};
      const days=Math.round((gameDate-new Date(lastGame.scheduled))/86400000);
      if(days===0)return{vote:'no',confidence:76,edge:0.07,reason:'Rest: Back-to-back confirmed via Sportradar'};
      if(days===1)return{vote:'no',confidence:65,edge:0.04,reason:'Rest: 1 day rest — Sportradar confirmed'};
      if(days>=7)return{vote:'yes',confidence:76,edge:0.07,reason:`Rest: ${days} days rest — Sportradar confirmed`};
      if(days>=4)return{vote:'yes',confidence:66,edge:0.04,reason:`Rest: ${days} days rest`};
      return{vote:'neu',confidence:52,edge:0,reason:`Rest: ${days} days — neutral`};
    },

    // 11. TRAVEL FATIGUE — Cross-timezone travel from Sportradar locations
    travel(game, data) {
      const sr=data.sportradar;
      let homeCity=null, awayCity=null;
      if(sr?.venue) {
        homeCity=sr.venue.city;
      }
      // City from team name as fallback
      const east=['Boston','Brooklyn','Philadelphia','Toronto','Miami','Orlando','Atlanta','Charlotte','Washington','Cleveland','Indiana','Detroit','Milwaukee'];
      const west=['Los Angeles','Golden State','Portland','Sacramento','Phoenix','Utah','Denver','Dallas','Houston','San Antonio','Oklahoma','Memphis'];
      const getZone=t=>east.some(c=>t.includes(c.split(' ')[0]))?0:west.some(c=>t.includes(c.split(' ')[0]))?3:1;
      const homeZone=getZone(game.home_team);
      const awayZone=getZone(game.away_team);
      const tzDiff=Math.abs(homeZone-awayZone);
      if(tzDiff===0)return{vote:'neu',confidence:51,edge:0,reason:'Travel: Same timezone — no edge'};
      if(tzDiff>=3)return{vote:'yes',confidence:72,edge:0.06,reason:`Travel: ${tzDiff} timezone cross-country — home advantage quantified`};
      if(tzDiff>=2)return{vote:'yes',confidence:64,edge:0.04,reason:`Travel: ${tzDiff} timezone shift — home edge`};
      return{vote:'yes',confidence:57,edge:0.02,reason:'Travel: 1 timezone difference — minor home edge'};
    },

    // 12. WEATHER IMPACT — OpenWeatherMap real-time outdoor conditions
    weather(game, data) {
      const sport=game._sport;
      if(['NBA','NHL','NCAAB'].includes(sport))return{vote:'neu',confidence:50,edge:0,reason:'Weather: Indoor sport — N/A'};
      const w=data.weather;
      const total=game._total;
      if(!w) {
        // No weather API: use season/month heuristic
        const month=new Date(game.commence_time).getMonth();
        const coldMarkets=['Green Bay','Chicago','Cleveland','Buffalo','New England','New York Jets','New York Giants','Philadelphia','Pittsburgh','Minnesota','Kansas City'];
        const inCold=coldMarkets.some(m=>game.home_team.includes(m.split(' ')[0]));
        if(sport==='NFL'&&(month>=9||month<=1)&&inCold)return{vote:'no',confidence:68,edge:0.05,reason:'Weather: Cold market winter game — scoring suppression (heuristic)'};
        if(sport==='MLB'&&month<=4)return{vote:'no',confidence:62,edge:0.03,reason:'Weather: Early MLB season cold — ball carry suppressed'};
        return{vote:'neu',confidence:51,edge:0,reason:'Weather: OpenWeatherMap not connected — using heuristics'};
      }
      // Real weather data
      const wind=w.data?.[0]?.wind_speed||0;
      const temp=w.data?.[0]?.temp||60;
      const rain=w.data?.[0]?.rain?.['1h']||0;
      const snow=w.data?.[0]?.snow?.['1h']||0;
      const precip=rain+snow;
      if(wind>20||precip>0.3||temp<25)return{vote:'no',confidence:Math.min(70+wind/2+precip*10,90),edge:Math.min((wind/200+precip/10),0.12),reason:`Weather: Wind ${wind.toFixed(0)}mph, Temp ${temp.toFixed(0)}°F, Precip ${precip.toFixed(2)}" — scoring suppression`};
      if(wind>12||temp<35)return{vote:'no',confidence:64,edge:0.04,reason:`Weather: Wind ${wind.toFixed(0)}mph, Temp ${temp.toFixed(0)}°F — moderate impact`};
      if(temp>80&&wind<5)return{vote:'yes',confidence:60,edge:0.02,reason:`Weather: Ideal conditions ${temp.toFixed(0)}°F — scoring favorable`};
      return{vote:'neu',confidence:51,edge:0,reason:`Weather: Neutral conditions (${temp.toFixed(0)}°F, ${wind.toFixed(0)}mph)`};
    },

    // 13. HOME/AWAY SPLIT — Historical cover rates by spread range and sport
    ha(game, data) {
      const spread=game._spread;
      const sport=game._sport;
      if(spread===null)return{vote:'neu',confidence:50,edge:0,reason:'H/A: No spread'};
      // NBA: home -1 to -5 cover at ~53.5% historically
      if(sport==='NBA'&&spread>=-5&&spread<=-1)return{vote:'yes',confidence:67,edge:0.035,reason:`H/A: NBA home ${spread} — 53.5% historical cover rate`};
      // NFL: home underdogs +1.5 to +6 cover at ~54% historically
      if(sport==='NFL'&&spread>=1.5&&spread<=6)return{vote:'yes',confidence:66,edge:0.03,reason:`H/A: NFL home dog +${spread} — historical 54% ATS`};
      // MLB: home -110 to -130 ML hits at ~54%
      if(sport==='MLB'&&game._ml&&game._ml>=-130&&game._ml<=-105)return{vote:'yes',confidence:64,edge:0.025,reason:'H/A: MLB home moderate favorite — 54% historical ML'};
      // NHL: home ice historically worth ~0.3 goals
      if(sport==='NHL'&&spread>=-1.5&&spread<=0)return{vote:'yes',confidence:62,edge:0.02,reason:'H/A: NHL home ice — 0.3 goal historical edge'};
      // Fade large home favorites
      if(spread<=-10)return{vote:'no',confidence:70,edge:0.05,reason:`H/A: Large favorite ${spread} — historical fade spot (52.8% for dogs)`};
      if(spread<=-7)return{vote:'no',confidence:62,edge:0.03,reason:`H/A: Heavy favorite ${spread} — moderate fade value`};
      return{vote:'neu',confidence:51,edge:0,reason:'H/A: No historical split edge at this number'};
    },

    // 14. ATS TREND — Cover rate from Supabase pick history
    ats(game, data) {
      const picks=JSON.parse(localStorage.getItem('edge_picks_local')||'[]');
      const rel=picks.filter(p=>p.matchup?.includes(game.home_team)&&p.result&&p.pick_type==='ATS');
      if(rel.length<6) return {vote:'neu',confidence:50,edge:0,reason:`ATS: Need 6+ games (have ${rel.length})`};
      const wins=rel.filter(p=>p.result==='W').length;
      const pct=wins/rel.length;
      const rec=`${wins}-${rel.length-wins}`;
      if(pct>0.65)return{vote:'yes',confidence:Math.min(60+pct*35,88),edge:pct-0.524,reason:`ATS: ${rec} cover record — ${(pct*100).toFixed(0)}% rate`};
      if(pct>0.58)return{vote:'yes',confidence:64,edge:pct-0.524,reason:`ATS: ${rec} — trending above breakeven`};
      if(pct<0.35)return{vote:'no',confidence:Math.min(60+(0.524-pct)*60,86),edge:0.524-pct,reason:`ATS: ${rec} — ${(pct*100).toFixed(0)}% cover rate — strong fade`};
      if(pct<0.42)return{vote:'no',confidence:62,edge:0.524-pct,reason:`ATS: ${rec} — below breakeven`};
      return{vote:'neu',confidence:51,edge:0,reason:`ATS: ${rec} — neutral trend`};
    },

    // 15. RECENT FORM INDEX — Last 5 weighted with recency bias
    form(game, data) {
      const events=data.espn?.events||[];
      if(!events.length)return{vote:'neu',confidence:50,edge:0,reason:'Form: No ESPN data'};
      const last5=events.slice(0,5);
      let weightedScore=0, totalWeight=0;
      last5.forEach((e,i)=>{
        const w=5-i; // most recent = weight 5
        const home=e.competitions?.[0]?.competitors?.find(c=>c.homeAway==='home');
        const winner=home?.winner===true;
        weightedScore+=winner?w:0;
        totalWeight+=w;
      });
      const formPct=totalWeight>0?weightedScore/totalWeight:0.5;
      const wins=last5.filter(e=>e.competitions?.[0]?.competitors?.find(c=>c.homeAway==='home')?.winner===true).length;
      if(formPct>0.72)return{vote:'yes',confidence:Math.min(67+formPct*25,88),edge:formPct-0.524,reason:`Form: ${wins}/5 wins, weighted ${(formPct*100).toFixed(0)}% — hot streak`};
      if(formPct<0.28)return{vote:'no',confidence:Math.min(65+(0.524-formPct)*30,86),edge:0.524-formPct,reason:`Form: ${wins}/5, weighted ${(formPct*100).toFixed(0)}% — cold streak`};
      return{vote:'neu',confidence:52,edge:0,reason:`Form: ${wins}/5 wins — neutral momentum`};
    },

  };

  // Export Part 1 internals for Part 2
  return { _p1: true, ALGORITHMS, WKEY, W, KEY, SPORTS, getHist, saveHist, getVal, oddsToProb, kellyUnits, fetchOddsGames, fetchESPN, fetchESPNTeam, fetchSportradar, fetchActionNetwork, fetchWeather, fetchInjuries, fetchSchedule, loadAlgoSettings, startAuto, stopAuto };

})();
