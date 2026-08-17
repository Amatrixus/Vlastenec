(() => {
  'use strict';
  const store = window.VlastenecProfileStore;
  if (!store) return;

  const $ = id => document.getElementById(id);
  const fmt = n => new Intl.NumberFormat('cs-CZ').format(Number(n)||0);
  const pct = (a,b) => b ? Math.round((a/b)*100) : 0;
  const initials = name => String(name||'?').trim().split(/\s+/).slice(0,2).map(x=>x[0]||'').join('').toUpperCase() || '?';

  const MODE_LABELS = {
    random:'Rychlá hra', custom:'Custom hra', friends:'Hra s přáteli', bots:'Hra s boty'
  };

  function render() {
    const identity = store.getIdentity();
    const data = store.read();
    const level = store.levelInfo(data.xp);

    $('profile-name').textContent = identity.displayName || data.displayName || 'Hráč';
    $('profile-avatar').textContent = initials(identity.displayName);
    $('profile-kind').textContent = identity.type === 'guest' ? 'HOST' : 'PŘIHLÁŠENÝ HRÁČ';
    $('profile-storage-badge').textContent = identity.type === 'guest' ? 'LOKÁLNÍ PROFIL' : 'PROFIL ÚČTU';
    $('guest-note').classList.toggle('hidden', identity.type !== 'guest');
    $('profile-level').textContent = level.level;
    $('profile-title').textContent = level.title;
    $('profile-xp-copy').textContent = `${fmt(level.currentXp)} / ${fmt(level.nextXp)} XP`;
    $('profile-xp-bar').style.width = `${Math.max(0,Math.min(100,level.progress*100))}%`;
    $('profile-total-xp').textContent = `Celkem ${fmt(level.totalXp)} XP`;
    $('profile-next-level').textContent = `Do další úrovně ${fmt(Math.max(0,level.nextXp-level.currentXp))} XP`;

    const s = data.stats;
    $('stat-games').textContent = fmt(s.gamesPlayed);
    $('stat-wins').textContent = fmt(s.wins);
    $('stat-winrate').textContent = `${pct(s.wins,s.gamesPlayed)} % win rate`;
    $('stat-questions').textContent = fmt(s.questionWins);
    $('stat-accuracy').textContent = `${pct(s.questionWins,s.questionsPlayed)} % úspěšnost z ${fmt(s.questionsPlayed)}`;
    $('stat-territories').textContent = fmt(s.territoriesCaptured);
    $('stat-best-score').textContent = fmt(s.bestScore);
    $('stat-average-score').textContent = `průměr ${fmt(s.gamesPlayed ? Math.round(s.totalScore/s.gamesPlayed) : 0)}`;
    $('stat-streak').textContent = fmt(s.maxStreak);
    const online = (data.modes.random.games||0)+(data.modes.custom.games||0)+(data.modes.friends.games||0);
    $('stat-mode').textContent = `${fmt(online)} online · ${fmt(data.modes.bots.games||0)} s boty`;

    renderCategories(data);
    renderAchievements(data);
    renderModes(data);
    renderMatches(data);
  }

  function renderCategories(data) {
    const root = $('category-list');
    root.innerHTML = '';
    let total = 0;
    for (const cat of store.CATEGORIES) {
      const c = data.categories[cat.slug] || {played:0,successes:0};
      total += c.played || 0;
      const percent = pct(c.successes,c.played);
      const item = document.createElement('article');
      item.className = 'category-card';
      item.innerHTML = `
        <div class="category-art"><img src="${cat.image}" alt=""></div>
        <div class="category-copy">
          <div class="category-name-row"><span class="category-name">${cat.name}</span><span class="category-percent">${percent}%</span></div>
          <div class="category-sub">${fmt(c.successes)} úspěchů · ${fmt(c.played)} otázek</div>
          <div class="mini-track"><i style="width:${percent}%"></i></div>
        </div>`;
      root.appendChild(item);
    }
    $('category-total').textContent = `${fmt(total)} otázek`;
  }

  function renderAchievements(data) {
    const root = $('achievement-list');
    root.innerHTML = '';
    let unlockedCount = 0;
    for (const def of store.ACHIEVEMENTS) {
      const p = store.achievementProgress(def,data);
      if (p.unlocked) unlockedCount++;
      const item = document.createElement('article');
      item.className = `achievement-card${p.unlocked?' unlocked':''}`;
      const shownValue = Math.min(p.value,p.target);
      item.innerHTML = `
        <div class="achievement-icon">${def.icon}</div>
        <h3>${def.name}</h3>
        <p>${def.description}</p>
        <div class="achievement-progress">
          <div class="mini-track"><i style="width:${p.ratio*100}%"></i></div>
          <span>${p.unlocked ? 'ODEMČENO' : `${fmt(shownValue)} / ${fmt(p.target)}`}</span>
        </div>`;
      root.appendChild(item);
    }
    $('achievement-count').textContent = `${unlockedCount} / ${store.ACHIEVEMENTS.length}`;
  }

  function renderModes(data) {
    const root = $('mode-list');
    root.innerHTML = '';
    for (const mode of ['random','custom','friends','bots']) {
      const m = data.modes[mode] || {games:0,wins:0};
      const row = document.createElement('div');
      row.className = 'mode-row';
      row.innerHTML = `<div><strong>${MODE_LABELS[mode]}</strong><small>${fmt(m.wins)} vítězství · ${pct(m.wins,m.games)} %</small></div><span>${fmt(m.games)}</span>`;
      root.appendChild(row);
    }
  }

  function renderMatches(data) {
    const root = $('match-list');
    root.innerHTML = '';
    if (!data.matches.length) {
      root.innerHTML = '<div class="empty-state">Zatím tu nejsou žádné zaznamenané zápasy.<br>Statistiky se začnou zapisovat od této verze profilu.</div>';
      return;
    }
    for (const match of data.matches) {
      const date = new Date(match.playedAt);
      const row = document.createElement('div');
      row.className = 'match-row';
      const placeClass = match.placement === 1 ? ' first' : '';
      row.innerHTML = `
        <span class="match-place${placeClass}">${match.placement}. místo</span>
        <span class="match-mode">${MODE_LABELS[match.mode] || match.mode}</span>
        <span class="match-score">${fmt(match.score)}</span>
        <span class="match-date">${date.toLocaleDateString('cs-CZ',{day:'numeric',month:'short'})}</span>
        <span class="match-opponents">${match.opponents.length ? match.opponents.join(' · ') : '—'}</span>
        <span class="match-xp">+${fmt(match.xp)} XP</span>`;
      root.appendChild(row);
    }
  }

  $('profile-back').addEventListener('click', () => {
    if (history.length > 1 && document.referrer && new URL(document.referrer).origin === location.origin) history.back();
    else location.href = 'homepage.html';
  });

  render();
})();
