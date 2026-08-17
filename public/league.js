(() => {
  'use strict';

  const $ = id => document.getElementById(id);
  const fmt = n => new Intl.NumberFormat('cs-CZ').format(Number(n) || 0);
  const pct = (a,b) => b ? Math.round((Number(a)||0) / (Number(b)||1) * 100) : 0;
  const signed = n => `${Number(n) > 0 ? '+' : ''}${fmt(n)}`;
  const initials = name => String(name || '?').trim().split(/\s+/).slice(0,2).map(x => x[0] || '').join('').toUpperCase() || '?';

  let overview = null;
  let leaderboardMode = 'around';
  let countdownTimer = null;

  function levelInfo(xpValue) {
    const xp = Math.max(0, Number(xpValue) || 0);
    let level = 1, spent = 0;
    while (level < 999) {
      const need = 200 + (level - 1) * 100;
      if (xp < spent + need) {
        const current = xp - spent;
        return { level, current, need, progress: need ? current / need : 1, title: titleForLevel(level) };
      }
      spent += need;
      level++;
    }
    return { level, current:0, need:0, progress:1, title:titleForLevel(level) };
  }

  function titleForLevel(level) {
    if (level >= 50) return 'Legenda';
    if (level >= 30) return 'Velitel';
    if (level >= 20) return 'Stratég';
    if (level >= 10) return 'Znalec';
    if (level >= 5) return 'Průzkumník';
    return 'Nováček';
  }

  function renderIdentity() {
    const auth = window.VlastenecAuth?.state;
    const name = auth?.authenticated ? (auth.user?.displayName || auth.user?.username || 'Hráč') : 'Přihlásit se';
    $('league-profile-name').textContent = name;
    $('league-profile-meta').textContent = auth?.authenticated ? 'Profil a statistiky' : 'Liga vyžaduje účet';
    $('league-profile-avatar').textContent = initials(name === 'Přihlásit se' ? '?' : name);
  }

  function renderSeason() {
    const season = overview?.season;
    if (!season) return;
    $('season-name').textContent = `${String(season.name || `Sezóna ${season.number}`).toUpperCase()}`;
    $('league-footer-season').textContent = season.name || `Sezóna ${season.number}`;
    startCountdown(season.endsAt);
  }

  function startCountdown(endsAt) {
    if (countdownTimer) clearInterval(countdownTimer);
    const tick = () => {
      const diff = Math.max(0, new Date(endsAt).getTime() - Date.now());
      const days = Math.floor(diff / 86400000);
      const hours = Math.floor((diff % 86400000) / 3600000);
      const mins = Math.floor((diff % 3600000) / 60000);
      $('season-countdown').textContent = diff <= 0 ? 'Sezóna se uzavírá…' : `Končí za ${days} d ${hours} h ${mins} min`;
    };
    tick(); countdownTimer = setInterval(tick, 30000);
  }

  function renderMe() {
    const authenticated = !!overview?.authenticated;
    $('rank-authenticated').classList.toggle('hidden', !authenticated);
    $('rank-guest').classList.toggle('hidden', authenticated);

    const profile = overview?.profile || { xp:0 };
    const level = levelInfo(profile.xp);
    $('league-level').textContent = `LEVEL ${level.level}`;
    $('league-xp-title').textContent = level.title;
    $('league-xp-copy').textContent = `${fmt(level.current)} / ${fmt(level.need)} XP`;
    $('league-xp-bar').style.width = `${Math.max(0,Math.min(100,level.progress*100))}%`;

    if (!authenticated || !overview.me) {
      ['league-games','league-wins','league-rating','league-rank'].forEach(id => $(id).textContent = '—');
      $('league-winrate').textContent = '—';
      $('league-placement-copy').textContent = 'přihlas se';
      $('league-rating-delta').textContent = 'rating účtu';
      $('league-ranked-count').textContent = `${fmt(overview?.rankedCount || 0)} hodnocených hráčů`;
      return;
    }

    const me = overview.me;
    $('league-games').textContent = fmt(me.games);
    $('league-wins').textContent = fmt(me.wins);
    $('league-winrate').textContent = `${pct(me.wins,me.games)} % win rate`;
    $('league-ranked-count').textContent = `${fmt(overview.rankedCount)} hodnocených hráčů`;
    $('league-placement-copy').textContent = me.ranked ? `${fmt(me.secondPlaces)}× 2. · ${fmt(me.thirdPlaces)}× 3.` : `${me.placementGames} / ${me.placementRequired} rozřazení`;

    const crest = $('rank-crest');
    crest.className = `rank-crest ${me.ranked ? me.division.key : 'provisional'}`;

    if (!me.ranked) {
      $('rank-kicker').textContent = 'ROZŘAZENÍ';
      $('rank-title').textContent = `${me.placementGames} / ${me.placementRequired} zápasů`;
      $('rank-description').textContent = 'Odehraj pět rozřazovacích zápasů. Rating a divize se odkryjí až potom.';
      $('rank-progress-left').textContent = 'Rozřazení';
      $('rank-progress-right').textContent = `${me.placementGames} / ${me.placementRequired}`;
      $('rank-progress-bar').style.width = `${Math.min(100,me.placementGames/me.placementRequired*100)}%`;
      $('league-rating').textContent = '—';
      $('league-rating-delta').textContent = 'zatím skrytý';
      $('league-rank').textContent = '—';
    } else {
      $('rank-kicker').textContent = 'AKTUÁLNÍ DIVIZE';
      $('rank-title').textContent = `${me.division.name} · ${fmt(me.rating)}`;
      $('rank-description').textContent = me.nextDivision
        ? `Do ${me.nextDivision.name} potřebuješ dosáhnout ratingu ${fmt(me.nextDivision.min)}.`
        : `Jsi v nejvyšší divizi. Teď rozhoduje tvoje pozice v sezonním žebříčku.`;
      $('rank-progress-left').textContent = me.division.name;
      $('rank-progress-right').textContent = me.nextDivision ? `${fmt(me.rating)} / ${fmt(me.nextDivision.min)}` : `#${fmt(me.rank || 0)}`;
      $('rank-progress-bar').style.width = `${Math.round((me.divisionProgress || 0)*100)}%`;
      $('league-rating').textContent = fmt(me.rating);
      $('league-rating-delta').textContent = `${signed(me.ratingDeltaSeason)} tuto sezónu`;
      $('league-rank').textContent = me.rank ? `#${fmt(me.rank)}` : '—';
    }
  }

  function renderLeaderboard() {
    const root = $('leaderboard-list');
    const source = leaderboardMode === 'top' ? overview?.leaderboard?.top : overview?.leaderboard?.nearby;
    const rows = Array.isArray(source) ? source : [];
    $('leaderboard-heading').textContent = leaderboardMode === 'top' ? 'TOP 100' : 'Kolem mě';
    $('tab-around').classList.toggle('active', leaderboardMode === 'around');
    $('tab-top').classList.toggle('active', leaderboardMode === 'top');

    if (!rows.length) {
      root.innerHTML = '<div class="empty-state">Zatím není nikdo po rozřazení. První hodnocení hráči se objeví po pěti ligových zápasech.</div>';
      return;
    }
    root.innerHTML = rows.map(row => `
      <div class="leader-row${row.isMe ? ' me' : ''}">
        <span class="leader-rank">#${fmt(row.rank)}</span>
        <span class="leader-name"><strong>${escapeHtml(row.displayName)}</strong><small>${fmt(row.wins)} vítězství · ${Math.round((row.winRate||0)*100)} %</small></span>
        <span class="leader-division">${escapeHtml(row.division.name)}</span>
        <span class="leader-rating">${fmt(row.rating)}</span>
      </div>`).join('');
  }

  function renderRecent() {
    const root = $('recent-matches');
    const matches = overview?.recentMatches || [];
    if (!matches.length) {
      root.innerHTML = '<div class="empty-state">Zatím tu nejsou žádné ligové zápasy.<br>Historie se začne plnit po spuštění ligového matchmakingu.</div>';
      return;
    }
    root.innerHTML = matches.map(match => {
      const delta = Number(match.ratingDelta || 0);
      const cls = delta > 0 ? 'positive' : delta < 0 ? 'negative' : '';
      const date = match.finishedAt ? new Date(match.finishedAt).toLocaleDateString('cs-CZ',{day:'numeric',month:'short'}) : '—';
      return `<div class="recent-row">
        <span class="match-place${match.placement===1?' first':''}">${match.placement}. místo</span>
        <span class="match-opponents">${escapeHtml((match.opponents||[]).join(' · ') || 'Ligový zápas')}<small class="match-date">${date}</small></span>
        <span class="match-rating ${cls}">${signed(delta)}</span>
        <span class="match-score">${fmt(match.score)} b.</span>
      </div>`;
    }).join('');
  }

  function renderDivisions() {
    const root = $('division-track');
    const meKey = overview?.me?.ranked ? overview.me.division?.key : null;
    root.innerHTML = (overview?.divisions || []).map(div => {
      const range = div.min == null ? `< ${fmt((div.max||999)+1)}` : div.max == null ? `${fmt(div.min)}+` : `${fmt(div.min)}–${fmt(div.max)}`;
      return `<div class="division-card${meKey===div.key?' current':''}" data-key="${div.key}">
        <div class="division-medal">V</div><strong>${escapeHtml(div.name)}</strong><small>${range}</small>
      </div>`;
    }).join('');
  }

  function escapeHtml(value) {
    return String(value ?? '').replace(/[&<>'"]/g, ch => ({'&':'&amp;','<':'&lt;','>':'&gt;',"'":'&#39;','"':'&quot;'}[ch]));
  }

  async function loadOverview() {
    try {
      const response = await fetch('/api/league/overview', { credentials:'same-origin', cache:'no-store' });
      const data = await response.json().catch(() => ({}));
      if (!response.ok) throw new Error(data.message || 'Ligu se nepodařilo načíst.');
      overview = data;
      renderSeason(); renderMe(); renderLeaderboard(); renderRecent(); renderDivisions();
    } catch (err) {
      $('leaderboard-list').innerHTML = `<div class="empty-state">${escapeHtml(err.message || 'Ligu se nepodařilo načíst.')}</div>`;
      $('recent-matches').innerHTML = '<div class="empty-state">Serverová data nejsou dostupná.</div>';
      $('season-countdown').textContent = 'Sezónu se nepodařilo načíst';
    }
  }

  $('tab-around').addEventListener('click', () => { leaderboardMode='around'; renderLeaderboard(); });
  $('tab-top').addEventListener('click', async () => {
    leaderboardMode='top';
    try {
      const r = await fetch('/api/league/leaderboard?limit=100',{credentials:'same-origin',cache:'no-store'});
      const data = await r.json();
      if (r.ok && overview) overview.leaderboard.top = data.rows || [];
    } catch (_) {}
    renderLeaderboard();
  });
  $('league-profile-chip').addEventListener('click', () => {
    if (window.VlastenecAuth?.state?.authenticated) location.href='profile.html';
    else window.VLASTENEC_OPEN_LOGIN?.(`${location.pathname}${location.search}${location.hash}`);
  });
  $('league-login').addEventListener('click', () => window.VLASTENEC_OPEN_LOGIN?.(`${location.pathname}${location.search}${location.hash}`));
  $('league-play').addEventListener('click', () => $('league-modal').classList.remove('hidden'));
  $('league-modal-close').addEventListener('click', () => $('league-modal').classList.add('hidden'));
  $('league-modal').addEventListener('click', e => { if (e.target === $('league-modal')) $('league-modal').classList.add('hidden'); });

  (async () => {
    try { if (window.VLASTENEC_AUTH_READY) await window.VLASTENEC_AUTH_READY; } catch (_) {}
    renderIdentity();
    await loadOverview();
  })();
})();
