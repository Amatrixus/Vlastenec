(() => {
  'use strict';
  const $ = id => document.getElementById(id);
  const qs = new URLSearchParams(location.search);
  const next = window.VlastenecAuth?.safeNext(qs.get('next')) || 'homepage.html';

  // Výchozí stav musí být vždy formulář. Přihlášený panel se smí
  // zobrazit až po skutečně potvrzeném auth stavu ze serveru.
  if ($('auth-existing')) $('auth-existing').hidden = true;
  if ($('auth-forms')) $('auth-forms').hidden = false;

  function initials(name) {
    return String(name || '?').trim().split(/\s+/).slice(0,2).map(x => x[0] || '').join('').toUpperCase() || '?';
  }

  function setBusy(form, busy) {
    form?.querySelectorAll('button,input').forEach(el => { el.disabled = !!busy; });
  }

  function switchTab(tab) {
    document.querySelectorAll('.auth-tab').forEach(btn => btn.classList.toggle('is-active', btn.dataset.tab === tab));
    $('login-form').classList.toggle('is-active', tab === 'login');
    $('register-form').classList.toggle('is-active', tab === 'register');
  }

  document.querySelectorAll('.auth-tab').forEach(btn => btn.addEventListener('click', () => switchTab(btn.dataset.tab)));

  async function post(path, payload) {
    const response = await fetch(path, {
      method: 'POST',
      credentials: 'same-origin',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify(payload)
    });
    const data = await response.json().catch(() => ({}));
    if (!response.ok) throw new Error(data.message || 'Požadavek se nepodařilo dokončit.');
    return data;
  }

  $('login-form').addEventListener('submit', async event => {
    event.preventDefault();
    const form = event.currentTarget;
    $('login-error').textContent = '';
    setBusy(form, true);
    try {
      await post('/api/auth/login', { login: $('login-id').value, password: $('login-password').value });
      location.href = next;
    } catch (err) {
      $('login-error').textContent = err.message;
      setBusy(form, false);
    }
  });

  $('register-form').addEventListener('submit', async event => {
    event.preventDefault();
    const form = event.currentTarget;
    $('register-error').textContent = '';
    const password = $('register-password').value;
    if (password !== $('register-password2').value) {
      $('register-error').textContent = 'Hesla se neshodují.';
      return;
    }
    setBusy(form, true);
    try {
      await post('/api/auth/register', {
        username: $('register-username').value,
        email: $('register-email').value,
        password
      });
      location.href = next;
    } catch (err) {
      $('register-error').textContent = err.message;
      setBusy(form, false);
    }
  });

  $('continue-button').addEventListener('click', () => { location.href = next; });
  $('logout-button').addEventListener('click', async () => {
    await window.VlastenecAuth.logout();
    $('auth-existing').hidden = true;
    $('auth-forms').hidden = false;
  });

  (async () => {
    const auth = await window.VLASTENEC_AUTH_READY;
    const warning = $('database-warning');
    if (auth.databaseAvailable === false) {
      warning.hidden = false;
      warning.textContent = auth.error || 'Databáze účtů zatím není dostupná.';
      document.querySelectorAll('#auth-forms input,#auth-forms button').forEach(el => { el.disabled = true; });
    }
    if (auth.authenticated && auth.user) {
      $('auth-forms').hidden = true;
      $('auth-existing').hidden = false;
      $('existing-name').textContent = auth.user.displayName;
      $('existing-avatar').textContent = initials(auth.user.displayName);
    } else {
      $('auth-existing').hidden = true;
      $('auth-forms').hidden = false;
      $('existing-name').textContent = '';
      $('existing-avatar').textContent = '';
    }
  })();
})();
