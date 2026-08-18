(() => {
  'use strict';

  const MARKER = '🧪 VLASTENEC FIX: mobile-game-safe-v1';
  console.log(MARKER);

  let wasGameActive = false;
  let uiBuilt = false;

  function phoneLikeViewport() {
    const coarse = window.matchMedia?.('(pointer: coarse)').matches ?? false;
    const shortSide = Math.min(window.innerWidth || 9999, window.innerHeight || 9999);
    // Explicitly exclude tablets. In landscape, modern phones are normally
    // <= 600 CSS px on the short side; tablets are substantially taller/wider.
    return coarse && shortSide <= 600;
  }

  function buildUi() {
    if (uiBuilt || !document.body) return;
    uiBuilt = true;

    const gate = document.createElement('div');
    gate.id = 'vl_mobile_rotate_gate';
    gate.setAttribute('role', 'status');
    gate.setAttribute('aria-live', 'polite');
    gate.innerHTML = `
      <div class="vl-rotate-icon" aria-hidden="true">↻</div>
      <strong>Otočte telefon na šířku</strong>
      <span>Samotná hra je na telefonu navržená pro režim landscape.</span>`;
    document.body.appendChild(gate);

    const fullscreen = document.createElement('button');
    fullscreen.id = 'vl_mobile_fullscreen_btn';
    fullscreen.type = 'button';
    fullscreen.textContent = '⛶';
    fullscreen.setAttribute('aria-label', 'Celá obrazovka');
    fullscreen.setAttribute('title', 'Celá obrazovka');
    document.body.appendChild(fullscreen);

    fullscreen.addEventListener('click', async () => {
      try {
        if (document.fullscreenElement) {
          await document.exitFullscreen?.();
          try { screen.orientation?.unlock?.(); } catch (_) {}
          return;
        }

        const root = document.documentElement;
        if (root.requestFullscreen) {
          try {
            await root.requestFullscreen({ navigationUI: 'hide' });
          } catch (_) {
            await root.requestFullscreen();
          }
          try { await screen.orientation?.lock?.('landscape'); } catch (_) {}
        }
      } catch (err) {
        console.debug('[mobile-game] fullscreen unavailable:', err?.message || err);
      }
    });

    document.addEventListener('fullscreenchange', syncFullscreenButton, { passive: true });
  }

  function syncFullscreenButton() {
    const btn = document.getElementById('vl_mobile_fullscreen_btn');
    if (!btn) return;
    const active = !!document.fullscreenElement;
    btn.textContent = active ? '×' : '⛶';
    btn.setAttribute('aria-label', active ? 'Ukončit celou obrazovku' : 'Celá obrazovka');
    btn.setAttribute('title', active ? 'Ukončit celou obrazovku' : 'Celá obrazovka');
  }

  function collapseGameChatOnce() {
    const drawer = document.getElementById('game_chat_drawer');
    if (!drawer) return;
    drawer.classList.remove('open');
    drawer.setAttribute('aria-hidden', 'true');
  }

  function syncMode() {
    if (!document.body) return;
    const phone = phoneLikeViewport();
    document.body.classList.toggle('vl-phone-game', phone);

    const active = phone && document.body.classList.contains('is-game-started');
    if (active && !wasGameActive) {
      // This is deliberately the ONLY gameplay-state side effect in this file,
      // and it occurs only after the existing client has already marked the match
      // as started. Lobby creation/join/state is never touched.
      collapseGameChatOnce();
      requestAnimationFrame(() => {
        collapseGameChatOnce();
        try { window.VlastenecSound?.sync?.(); } catch (_) {}
      });
    }
    wasGameActive = active;

    if (phone) {
      try { window.VlastenecSound?.sync?.(); } catch (_) {}
    }
    syncFullscreenButton();
  }

  function init() {
    buildUi();
    syncMode();

    // Observe only the body class used by the already-existing game client.
    // No socket listeners, no lobby listeners, no room logic, no monkeypatching.
    const observer = new MutationObserver(syncMode);
    observer.observe(document.body, { attributes: true, attributeFilter: ['class'] });

    window.addEventListener('resize', syncMode, { passive: true });
    window.addEventListener('orientationchange', () => {
      setTimeout(syncMode, 80);
      setTimeout(syncMode, 300);
    }, { passive: true });
    window.visualViewport?.addEventListener('resize', syncMode, { passive: true });
  }

  if (document.readyState === 'loading') {
    document.addEventListener('DOMContentLoaded', init, { once: true });
  } else {
    init();
  }
})();
