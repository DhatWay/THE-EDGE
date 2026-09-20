// ============================================================
// EDGE — AUTH v1.0
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
// ============================================================

const EDGE_AUTH = (() => {

  const SESSION_KEY = 'edge_auth_session';
  const LOGIN_PAGE = 'login.html';
  const REFRESH_BUFFER_MS = 60 * 1000;

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

  async function refresh(session) {
    const { url, anonKey } = getConfig();
    if (!url || !anonKey || !session?.refresh_token) return null;

    try {
      const res = await fetch(`${url}/auth/v1/token?grant_type=refresh_token`, {
        method: 'POST',
        headers: { apikey: anonKey, 'Content-Type': 'application/json' },
        body: JSON.stringify({ refresh_token: session.refresh_token }),
      });
      if (!res.ok) return null;
      const data = await res.json();
      const next = {
        access_token: data.access_token,
        refresh_token: data.refresh_token,
        expires_at: Date.now() + (data.expires_in || 3600) * 1000,
        user: data.user || session.user,
      };
      saveSession(next);
      return next;
    } catch { return null; }
  }

  async function ensureFresh() {
    let session = getSession();
    if (!session) return null;
    if (isExpired(session)) {
      session = await refresh(session);
    }
    return session;
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
  // ------------------------------------------------------------

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
            // Preserve apikey and everything else, replace Authorization.
            init.headers = { ...headers, Authorization: `Bearer ${session.access_token}` };
          }
        }
      }

      return originalFetch.call(this, resource, init);
    };
  }

  // ------------------------------------------------------------
  // GATE
  //
  // Every page loads this. If there is no valid session, bounce
  // to login. The current page is remembered so login sends you
  // back where you were.
  // ------------------------------------------------------------

  async function gate() {
    const currentPage = window.location.pathname.split('/').pop() || 'index.html';
    if (currentPage === LOGIN_PAGE) return;

    const session = await ensureFresh();
    if (!session) {
      try {
        sessionStorage.setItem('edge_return_to', currentPage + window.location.search);
      } catch {}
      window.location.replace(LOGIN_PAGE);
      return;
    }

    // Optional: show who is signed in.
    document.documentElement.dataset.edgeUser =
      (session.user && session.user.email) || 'signed in';
  }

  installInterceptor();
  gate();

  return { signIn, signOut, getSession, ensureFresh };
})();

window.EDGE_AUTH = EDGE_AUTH;