// ============================================================
// EDGE — AUTH v1.1
//
// Email/password session against Supabase auth. Every page
// loads this. On load it:
//
//   1. Installs a fetch interceptor that swaps the anon-key
//      Bearer token for the signed-in user's JWT on every
//      /rest/v1/ request. No page code needs to change.
//   2. Redirects to login.html if there is no valid session.
//   3. Refreshes the token before it expires.
//
// Once RLS is locked to your email, the anon key alone cannot
// read or write. Only requests carrying your JWT can.
//
// v1.1 changes:
//
//   · Refresh failures are no longer silent. The old code
//     returned null on a failed refresh and the interceptor
//     simply skipped adding the JWT — the request went out
//     with the anon key, RLS rejected it, and the failure
//     surfaced much later as "no data" with no trace of why.
//     Now every refresh failure is logged to edge_errors with
//     the HTTP status or network error, and the interceptor
//     logs when it cannot inject a fresh token.
//
//   · Offline users are not bounced to login. The old gate()
//     redirected whenever ensureFresh() returned null, which
//     happens whenever the refresh call cannot reach the
//     network. That meant opening the app on a plane, or in a
//     dead zone, threw the user to a login screen that could
//     not authenticate either — and clearing the return_to
//     state in the process. The gate now distinguishes:
//       · no session at all         → redirect
//       · session expired + offline → allow through, requests
//                                      fail individually until
//                                      the network returns
//       · session expired + online
//         with refresh rejected     → redirect (the refresh
//                                      token is genuinely bad)
// ============================================================

const EDGE_AUTH = (() => {

  const BUILD = 'auth-20260924-01';

  const SESSION_KEY = 'edge_auth_session';
  const LOGIN_PAGE = 'login.html';
  const REFRESH_BUFFER_MS = 60 * 1000;

  function logEdgeError(where, err) {
    try {
      const list = JSON.parse(localStorage.getItem('edge_errors') || '[]');
      list.unshift({ t: Date.now(), where, msg: err && err.message ? err.message : String(err) });
      localStorage.setItem('edge_errors', JSON.stringify(list.slice(0, 50)));
    } catch {}
  }

  function getConfig() {
    return {
      url: (localStorage.getItem('edge_supabase_url') || '').replace(/\/+$/, ''),
      anonKey: localStorage.getItem('edge_supabase_key') || '',
    };
  }

  function getSession() {
    try {
      const raw = localStorage.getItem(SESSION_KEY);
      if (!raw) return null;
      return JSON.parse(raw);
    } catch { return null; }
  }

  function saveSession(s) {
    localStorage.setItem(SESSION_KEY, JSON.stringify(s));
  }

  function clearSession() {
    localStorage.removeItem(SESSION_KEY);
  }

  function isExpired(session) {
    if (!session || !session.expires_at) return true;
    return Date.now() >= session.expires_at - REFRESH_BUFFER_MS;
  }

  // Returns:
  //   { session }          — a valid or freshly refreshed session
  //   { session: null, reason: 'offline',  original } — no network
  //   { session: null, reason: 'rejected', status }   — server said no
  //   { session: null, reason: 'no_session' }         — nothing stored
  //
  // The reason field is what lets gate() decide whether to redirect.
  // The old code collapsed all four into a single null return.
  async function refresh(session) {
    const { url, anonKey } = getConfig();
    if (!url || !anonKey) {
      return { session: null, reason: 'no_config' };
    }
    if (!session?.refresh_token) {
      return { session: null, reason: 'no_refresh_token' };
    }

    // If the network is down there is no point attempting the call.
    if (typeof navigator !== 'undefined' && navigator.onLine === false) {
      return { session: null, reason: 'offline', original: session };
    }

    try {
      const res = await fetch(`${url}/auth/v1/token?grant_type=refresh_token`, {
        method: 'POST',
        headers: { apikey: anonKey, 'Content-Type': 'application/json' },
        body: JSON.stringify({ refresh_token: session.refresh_token }),
      });

      if (!res.ok) {
        // 400/401/403 mean the refresh token itself is bad. That
        // is a genuine sign-out situation. 5xx is transient and
        // should not throw the user out.
        const body = await res.text().catch(() => '');
        const reason = res.status >= 500 ? 'transient' : 'rejected';
        logEdgeError('auth.refresh.' + reason, new Error(`HTTP ${res.status} ${body.slice(0, 120)}`));
        return { session: null, reason, status: res.status };
      }

      const data = await res.json();
      const next = {
        access_token: data.access_token,
        refresh_token: data.refresh_token,
        expires_at: Date.now() + (data.expires_in || 3600) * 1000,
        user: data.user || session.user,
      };
      saveSession(next);
      return { session: next, reason: 'refreshed' };
    } catch (e) {
      // fetch threw. Could be offline, DNS failure, or a network
      // block. Treat as transient, keep the session, and let
      // individual requests fail until connectivity returns.
      logEdgeError('auth.refresh.network', e);
      return { session: null, reason: 'offline', original: session };
    }
  }

  // Called from both the gate and the interceptor. Returns a
  // session when one is available, or null. The distinction
  // between reasons is not exposed here because the interceptor
  // does not need it — it only needs to know whether it has a
  // fresh token to inject.
  async function ensureFresh() {
    let session = getSession();
    if (!session) return null;
    if (!isExpired(session)) return session;

    const result = await refresh(session);
    return result.session;
  }

  async function signIn(email, password) {
    const { url, anonKey } = getConfig();
    if (!url || !anonKey) throw new Error('Supabase URL and anon key are not set');

    const res = await fetch(`${url}/auth/v1/token?grant_type=password`, {
      method: 'POST',
      headers: { apikey: anonKey, 'Content-Type': 'application/json' },
      body: JSON.stringify({ email, password }),
    });

    let data;
    try { data = await res.json(); } catch { data = {}; }

    if (!res.ok) {
      const msg = data.error_description || data.msg || data.error || `HTTP ${res.status}`;
      throw new Error(msg);
    }

    const session = {
      access_token: data.access_token,
      refresh_token: data.refresh_token,
      expires_at: Date.now() + (data.expires_in || 3600) * 1000,
      user: data.user,
    };
    saveSession(session);
    return session;
  }

  function signOut() {
    clearSession();
    window.location.replace(LOGIN_PAGE);
  }

  // ------------------------------------------------------------
  // FETCH INTERCEPTOR
  //
  // Existing pages pass the anon key as the Bearer. That is what
  // the app has always done, and it is what RLS will now reject.
  // Rather than edit every fetch in every file, the interceptor
  // rewrites the Authorization header in flight for requests to
  // /rest/v1/ — everything else passes through untouched.
  //
  // v1.1: when no fresh token is available, the request still
  // proceeds with the original header (the anon key), because
  // some reads may succeed under permissive RLS. But the failure
  // is logged once per session so a stale session does not fail
  // silently forever.
  // ------------------------------------------------------------

  let interceptorWarningLogged = false;

  function installInterceptor() {
    const originalFetch = window.fetch;
    if (originalFetch.__edgePatched) return;
    originalFetch.__edgePatched = true;

    window.fetch = async function(resource, init = {}) {
      const url = typeof resource === 'string'
        ? resource
        : (resource && resource.url) || '';

      const isSupabaseRest = url.includes('.supabase.co/rest/v1/');
      if (isSupabaseRest) {
        const session = await ensureFresh();
        if (session && session.access_token) {
          const headers = init.headers || {};
          if (headers instanceof Headers) {
            headers.set('Authorization', `Bearer ${session.access_token}`);
            init.headers = headers;
          } else {
            init.headers = { ...headers, Authorization: `Bearer ${session.access_token}` };
          }
        } else if (!interceptorWarningLogged) {
          // Log once per page load. Repeated logging would flood
          // edge_errors on a page that fires twenty requests.
          interceptorWarningLogged = true;
          logEdgeError('auth.interceptor', new Error(
            'No valid session token — request sent with anon key, may be rejected by RLS'
          ));
        }
      }

      return originalFetch.call(this, resource, init);
    };
  }

  // ------------------------------------------------------------
  // GATE
  //
  // Runs at module load on every page. Decides whether the user
  // is allowed to stay where they are.
  //
  // Rules:
  //   · No session stored at all                  → redirect
  //   · Session valid                             → stay
  //   · Session expired, refresh succeeded        → stay
  //   · Session expired, refresh rejected (401)   → redirect
  //   · Session expired, offline or 5xx           → stay, log
  //     once. Requests fail individually until
  //     the network or the server returns.
  // ------------------------------------------------------------

  async function gate() {
    const currentPage = window.location.pathname.split('/').pop() || 'index.html';
    if (currentPage === LOGIN_PAGE) return;

    const stored = getSession();

    // No session at all — straight to login, nothing to preserve.
    if (!stored) {
      try {
        sessionStorage.setItem('edge_return_to', currentPage + window.location.search);
      } catch {}
      window.location.replace(LOGIN_PAGE);
      return;
    }

    // Session is still valid — nothing to do.
    if (!isExpired(stored)) {
      document.documentElement.dataset.edgeUser =
        (stored.user && stored.user.email) || 'signed in';
      return;
    }

    // Session is expired. Ask for a refresh and decide based on
    // the reason.
    const result = await refresh(stored);

    if (result.session) {
      document.documentElement.dataset.edgeUser =
        (result.session.user && result.session.user.email) || 'signed in';
      return;
    }

    if (result.reason === 'rejected') {
      // Server explicitly said the refresh token is no good.
      // This is a real sign-out.
      clearSession();
      try {
        sessionStorage.setItem('edge_return_to', currentPage + window.location.search);
      } catch {}
      window.location.replace(LOGIN_PAGE);
      return;
    }

    // offline, no_config, or transient — leave the user where
    // they are. The session stays in localStorage so that when
    // connectivity returns, the next ensureFresh() succeeds and
    // requests go through. Bouncing them to login would clear
    // the path back and force a manual sign-in for a network
    // blip.
    logEdgeError('auth.gate.defer', new Error(
      `Keeping user on page after refresh failed: ${result.reason || 'unknown'}`
    ));
    document.documentElement.dataset.edgeUser = 'session pending refresh';
  }

  installInterceptor();
  gate();

  return {
    BUILD,
    signIn,
    signOut,
    getSession,
    ensureFresh,
  };
})();

window.EDGE_AUTH = EDGE_AUTH;