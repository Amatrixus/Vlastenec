(() => {
  'use strict';

  const MARKER = '🧪 VLASTENEC FIX: mobile-game-safe-v4-ui-polish';
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

  function forceChatClosed() {
    const drawer = document.getElementById('game_chat_drawer');
    if (!drawer) return;
    drawer.classList.remove('open');
    drawer.setAttribute('aria-hidden', 'true');
  }

  function guardFullscreenTouch() {
    const toggle = document.getElementById('game_chat_toggle');
    if (toggle) toggle.style.pointerEvents = 'none';

    // Some mobile Chromium builds re-target the end of a touch sequence while
    // the viewport is being rebuilt for fullscreen. Keep the chat firmly closed
    // through that transition so the fullscreen tap can never become a chat tap.
    [0, 80, 220, 450, 750].forEach(ms => setTimeout(forceChatClosed, ms));
    setTimeout(() => {
      if (toggle) toggle.style.pointerEvents = '';
    }, 800);
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

    // Stop the fullscreen gesture here. This prevents the same tap/pointer
    // sequence from reaching the nearby game UI while Chromium rebuilds the viewport.
    fullscreen.addEventListener('pointerdown', (event) => {
      event.stopPropagation();
    }, { passive: true });

    fullscreen.addEventListener('click', async (event) => {
      event.preventDefault();
      event.stopPropagation();
      guardFullscreenTouch();
      forceChatClosed();

      try {
        if (document.fullscreenElement) {
          await document.exitFullscreen?.();
          try { screen.orientation?.unlock?.(); } catch (_) {}
          guardFullscreenTouch();
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
          guardFullscreenTouch();
        }
      } catch (err) {
        console.debug('[mobile-game] fullscreen unavailable:', err?.message || err);
      } finally {
        forceChatClosed();
      }
    });

    document.addEventListener('fullscreenchange', () => { forceChatClosed(); syncFullscreenButton(); queuePinReflow(); }, { passive: true });
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
    forceChatClosed();
  }

  // Rendering-only mobile safeguard. The original game remains solely
  // responsible for which player can claim which region and for creating or
  // removing pin elements. We only ask its existing resize renderer to
  // recalculate coordinates after Chrome changes the viewport/fullscreen.
  function refreshExistingPinPositions() {
    if (!document.body?.classList.contains('vl-phone-game')) return;
    if (!document.body?.classList.contains('is-game-started')) return;
    if (typeof window.updateAllPins !== 'function') return;
    try { window.updateAllPins(); } catch (err) {
      console.debug('[mobile-game] pin reflow skipped:', err?.message || err);
    }
  }

  function queuePinReflow() {
    [0, 80, 220, 500].forEach(ms => setTimeout(refreshExistingPinPositions, ms));
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
        queuePinReflow();
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

    window.addEventListener('resize', () => { syncMode(); queuePinReflow(); }, { passive: true });
    window.addEventListener('orientationchange', () => {
      setTimeout(() => { syncMode(); queuePinReflow(); }, 80);
      setTimeout(() => { syncMode(); queuePinReflow(); }, 300);
    }, { passive: true });
    window.visualViewport?.addEventListener('resize', () => { syncMode(); queuePinReflow(); }, { passive: true });
  }

  if (document.readyState === 'loading') {
    document.addEventListener('DOMContentLoaded', init, { once: true });
  } else {
    init();
  }
})();
