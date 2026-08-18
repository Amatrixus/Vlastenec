(() => {
  'use strict';

  const MARKER = '🧪 VLASTENEC FIX: mobile-game-landscape-hud-v1.1-lobby-safe';
  console.log(MARKER);

  const state = {
    dismissedLandscapeGate: false,
    fullscreenAttempted: false,
    mobileActive: false
  };

  function coarsePointer() {
    try { return matchMedia('(pointer: coarse)').matches || navigator.maxTouchPoints > 0; }
    catch (_) { return navigator.maxTouchPoints > 0; }
  }

  function isHandsetViewport() {
    const w = window.visualViewport?.width || window.innerWidth || screen.width || 0;
    const h = window.visualViewport?.height || window.innerHeight || screen.height || 0;
    const shortSide = Math.min(w, h);
    const longSide = Math.max(w, h);
    return coarsePointer() && shortSide <= 540 && longSide <= 1100;
  }

  function isPortrait() {
    try { return matchMedia('(orientation: portrait)').matches; }
    catch (_) { return window.innerHeight > window.innerWidth; }
  }

  function isFullscreen() {
    return !!(document.fullscreenElement || document.webkitFullscreenElement);
  }

  function ensureGate() {
    let gate = document.getElementById('vl_mobile_game_gate');
    if (gate) return gate;

    gate = document.createElement('div');
    gate.id = 'vl_mobile_game_gate';
    gate.setAttribute('role', 'dialog');
    gate.setAttribute('aria-modal', 'true');
    gate.setAttribute('aria-labelledby', 'vl_mobile_game_gate_title');
    gate.innerHTML = `
      <section class="vl-mobile-game-gate-card">
        <div id="vl_mobile_game_gate_icon" class="vl-mobile-game-gate-icon" aria-hidden="true">↻</div>
        <h2 id="vl_mobile_game_gate_title">Otočte telefon na šířku</h2>
        <p id="vl_mobile_game_gate_copy">Samotná hra je na telefonu navržená pro režim na šířku.</p>
        <div class="vl-mobile-game-gate-actions">
          <button id="vl_mobile_fullscreen_btn" type="button">Celá obrazovka</button>
          <button id="vl_mobile_continue_btn" type="button">Pokračovat bez fullscreenu</button>
        </div>
      </section>`;
    document.body.appendChild(gate);

    gate.querySelector('#vl_mobile_fullscreen_btn')?.addEventListener('click', async () => {
      state.fullscreenAttempted = true;
      await enterFullscreenAndLandscape();
      // If browser cannot rotate automatically, portrait gate intentionally stays.
      if (!isPortrait()) {
        state.dismissedLandscapeGate = true;
        syncMobileGameUi();
      } else {
        syncMobileGameUi();
      }
    });

    gate.querySelector('#vl_mobile_continue_btn')?.addEventListener('click', () => {
      state.dismissedLandscapeGate = true;
      syncMobileGameUi();
    });

    return gate;
  }

  async function requestFullscreen() {
    if (isFullscreen()) return true;
    const target = document.documentElement;
    const fn = target.requestFullscreen || target.webkitRequestFullscreen;
    if (!fn) return false;
    try {
      await fn.call(target);
      return true;
    } catch (_) {
      return false;
    }
  }

  async function lockLandscape() {
    try {
      if (screen.orientation?.lock) {
        await screen.orientation.lock('landscape');
        return true;
      }
    } catch (_) {}
    return false;
  }

  async function enterFullscreenAndLandscape() {
    // Most mobile browsers only allow fullscreen from a user gesture.
    // The gate button is therefore the authoritative entry point.
    await requestFullscreen();
    await lockLandscape();
    setTimeout(syncMobileGameUi, 80);
    setTimeout(syncMobileGameUi, 320);
  }

  function closeGameChatOnMobile() {
    const drawer = document.getElementById('game_chat_drawer');
    if (!drawer) return;
    drawer.classList.remove('open');
    drawer.setAttribute('aria-hidden', 'true');
  }

  function updateGateContent(portrait) {
    const gate = ensureGate();
    const icon = gate.querySelector('#vl_mobile_game_gate_icon');
    const title = gate.querySelector('#vl_mobile_game_gate_title');
    const copy = gate.querySelector('#vl_mobile_game_gate_copy');
    const fsButton = gate.querySelector('#vl_mobile_fullscreen_btn');

    if (portrait) {
      if (icon) icon.textContent = '↻';
      if (title) title.textContent = 'Otočte telefon na šířku';
      if (copy) copy.textContent = 'Samotná hra je na telefonu navržená pro režim na šířku. Tlačítko níže se zároveň pokusí spustit fullscreen.';
      if (fsButton) fsButton.textContent = 'Fullscreen a otočit';
    } else {
      if (icon) icon.textContent = '⛶';
      if (title) title.textContent = 'Hrát na celé obrazovce';
      if (copy) copy.textContent = 'Fullscreen schová lišty prohlížeče a dá mapě maximum prostoru.';
      if (fsButton) fsButton.textContent = 'Spustit fullscreen';
    }
  }

  function syncMobileGameUi() {
    const started = document.body.classList.contains('is-game-started');
    const handset = isHandsetViewport();
    state.mobileActive = started && handset;

    document.body.classList.toggle('vl-mobile-game-active', state.mobileActive);

    if (!state.mobileActive) {
      document.body.classList.remove('vl-mobile-game-portrait', 'vl-mobile-game-gate-open');
      return;
    }

    closeGameChatOnMobile();

    const portrait = isPortrait();
    document.body.classList.toggle('vl-mobile-game-portrait', portrait);
    updateGateContent(portrait);

    const shouldShowLandscapeIntro = !portrait && !isFullscreen() && !state.dismissedLandscapeGate;
    const shouldShowGate = portrait || shouldShowLandscapeIntro;
    document.body.classList.toggle('vl-mobile-game-gate-open', shouldShowGate);

    // Sound icon is positioned from the leave icon's actual box.
    requestAnimationFrame(() => window.VlastenecSound?.sync?.());
  }


  function init() {
    // V lobby neděláme vůbec nic do DOMu ani do tlačítek. Mobilní vrstva se
    // aktivuje teprve ve chvíli, kdy core game přidá body.is-game-started.
    // Tím je lobby zcela izolovaná od fullscreen/orientation logiky.
    const bodyObserver = new MutationObserver((mutations) => {
      if (mutations.some(m => m.attributeName === 'class')) syncMobileGameUi();
    });
    bodyObserver.observe(document.body, { attributes: true, attributeFilter: ['class'] });

    const phase = document.getElementById('gamephase');
    if (phase) {
      new MutationObserver(() => {
        if (state.mobileActive) requestAnimationFrame(() => window.VlastenecSound?.sync?.());
      }).observe(phase, { childList: true, subtree: true, characterData: true });
    }

    const onViewportChange = () => {
      syncMobileGameUi();
      requestAnimationFrame(() => window.VlastenecSound?.sync?.());
    };

    window.addEventListener('resize', onViewportChange, { passive: true });
    window.addEventListener('orientationchange', () => {
      setTimeout(onViewportChange, 80);
      setTimeout(onViewportChange, 320);
    }, { passive: true });
    window.visualViewport?.addEventListener('resize', onViewportChange, { passive: true });
    document.addEventListener('fullscreenchange', onViewportChange);
    document.addEventListener('webkitfullscreenchange', onViewportChange);

    syncMobileGameUi();
  }

  if (document.readyState === 'loading') document.addEventListener('DOMContentLoaded', init, { once: true });
  else init();
})();
