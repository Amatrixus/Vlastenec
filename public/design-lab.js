(() => {
  const THEMES = {
    portal: 'Portál',
    heritage: 'Heritage',
    studio: 'Studio'
  };

  const root = document.documentElement;
  root.dataset.page = 'home';
  const trigger = document.getElementById('themeTrigger');
  const menu = document.getElementById('themeMenu');
  const name = document.getElementById('themeName');

  function applyTheme(theme) {
    if (!THEMES[theme]) theme = 'portal';
    root.dataset.theme = theme;
    name.textContent = THEMES[theme];
    document.querySelectorAll('[data-theme-choice]').forEach(btn => {
      btn.classList.toggle('is-active', btn.dataset.themeChoice === theme);
    });
    try { localStorage.setItem('vlastenec-theme', theme); } catch (_) {}
  }

  applyTheme(root.dataset.theme || 'portal');

  trigger.addEventListener('click', (e) => {
    e.stopPropagation();
    const open = menu.classList.toggle('is-open');
    trigger.setAttribute('aria-expanded', open ? 'true' : 'false');
  });

  menu.addEventListener('click', (e) => {
    const btn = e.target.closest('[data-theme-choice]');
    if (!btn) return;
    applyTheme(btn.dataset.themeChoice);
    menu.classList.remove('is-open');
    trigger.setAttribute('aria-expanded', 'false');
  });

  document.addEventListener('click', () => {
    menu.classList.remove('is-open');
    trigger.setAttribute('aria-expanded', 'false');
  });

  document.querySelectorAll('.page-tab').forEach(tab => {
    tab.addEventListener('click', () => {
      const page = tab.dataset.page;
      root.dataset.page = page;
      document.querySelectorAll('.page-tab').forEach(t => t.classList.toggle('is-active', t === tab));
      document.querySelectorAll('.page-view').forEach(view => view.classList.toggle('is-active', view.dataset.view === page));
      window.scrollTo({ top: 0, behavior: 'smooth' });
    });
  });
})();
