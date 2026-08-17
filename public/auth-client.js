(() => {
  'use strict';

  const state = { ready: false, authenticated: false, user: null, databaseAvailable: null, error: null };

  function safeNext(raw) {
    const value = String(raw || '').trim();
    if (!value) return 'homepage.html';
    try {
      const url = new URL(value, location.href);
      if (url.origin !== location.origin) return 'homepage.html';
      return `${url.pathname}${url.search}${url.hash}`;
    } catch {
      return 'homepage.html';
    }
  }

  function emitReady() {
    window.dispatchEvent(new CustomEvent('vlastenec:auth-ready', { detail: { ...state } }));
  }

  async function refresh() {
    try {
      const response = await fetch('/api/auth/me', { credentials: 'same-origin', cache: 'no-store' });
      const data = await response.json().catch(() => ({}));
      if (response.status === 503) {
        state.databaseAvailable = false;
        state.authenticated = false;
        state.user = null;
        state.error = data.message || 'Databáze účtů není dostupná.';
      } else if (!response.ok) {
        state.databaseAvailable = true;
        state.authenticated = false;
        state.user = null;
        state.error = data.message || 'Přihlášení se nepodařilo načíst.';
      } else {
        state.databaseAvailable = true;
        state.authenticated = !!data.authenticated;
        state.user = data.user || null;
        state.error = null;
      }
    } catch (err) {
      state.databaseAvailable = null;
      state.authenticated = false;
      state.user = null;
      state.error = err?.message || 'Síťová chyba.';
    }

    window.VLASTENEC_PROFILE = state.user ? {
      id: state.user.id,
      userId: state.user.id,
      username: state.user.username,
      name: state.user.displayName,
      displayName: state.user.displayName,
      email: state.user.email
    } : null;
    state.ready = true;
    emitReady();
    return { ...state };
  }

  function openLogin(next = `${location.pathname}${location.search}${location.hash}`) {
    const url = new URL('login.html', location.href);
    url.searchParams.set('next', safeNext(next));
    location.href = url.toString();
  }

  async function logout() {
    try {
      await fetch('/api/auth/logout', {
        method: 'POST',
        credentials: 'same-origin',
        headers: { 'Content-Type': 'application/json' },
        body: '{}'
      });
    } finally {
      window.VLASTENEC_PROFILE = null;
      state.authenticated = false;
      state.user = null;
      emitReady();
    }
  }

  window.VLASTENEC_OPEN_LOGIN = openLogin;
  window.VLASTENEC_LOGOUT = logout;
  window.VlastenecAuth = { state, refresh, openLogin, logout, safeNext };
  window.VLASTENEC_AUTH_READY = refresh();
})();
