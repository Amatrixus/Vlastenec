(() => {
  'use strict';

  const counter = document.querySelector('[data-portal-online-count]');
  if (counter && typeof io === 'function') {
    const socket = io({ transports: ['websocket', 'polling'] });
    socket.on('portal:onlineCount', payload => {
      const value = Number(payload?.count);
      counter.textContent = Number.isFinite(value) ? String(value) : '—';
    });
  }

  const chip = document.querySelector('[data-portal-profile-chip]');
  const name = document.querySelector('[data-portal-profile-name]');
  const meta = document.querySelector('[data-portal-profile-meta]');

  if (chip) {
    chip.addEventListener('click', () => {
      if (window.VlastenecAuth?.state?.authenticated) {
        location.href = 'profile.html';
        return;
      }
      if (document.body.dataset.portalPage === 'login') {
        document.getElementById('login-id')?.focus();
        return;
      }
      window.VLASTENEC_OPEN_LOGIN?.(`${location.pathname}${location.search}${location.hash}`);
    });
  }

  (async () => {
    try { if (window.VLASTENEC_AUTH_READY) await window.VLASTENEC_AUTH_READY; } catch (_) {}
    const auth = window.VlastenecAuth?.state;
    if (!name || !meta) return;
    if (auth?.authenticated && auth.user) {
      name.textContent = auth.user.displayName;
      meta.textContent = 'Profil a statistiky';
      if (chip) chip.title = 'Otevřít profil';
    } else {
      name.textContent = 'Přihlásit se';
      meta.textContent = auth?.databaseAvailable === false ? 'Účty čekají na databázi' : 'Ukládej postup a výsledky';
      if (chip) chip.title = 'Přihlásit se';
    }
  })();
})();
