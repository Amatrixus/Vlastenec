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
  let socket = null;

  let matchmakingMode = 'idle'; // idle | queue | ready | launching
  let queueWaitAnchor = 0;
  let queueClockTimer = null;
  let readyClockTimer = null;
  let readyMatchId = null;
  let readyDeadline = 0;
  let readyPlayers = [];

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
      root.innerHTML = '<div class="empty-state">Zatím tu nejsou žádné ligové zápasy.</div>';
      return;
    }
    root.innerHTML = matches.map(match => {
      const visible = match.ratingVisible !== false;
      const delta = Number(match.ratingDelta || 0);
      const cls = visible ? (delta > 0 ? 'positive' : delta < 0 ? 'negative' : '') : '';
      const date = match.finishedAt ? new Date(match.finishedAt).toLocaleDateString('cs-CZ',{day:'numeric',month:'short'}) : '—';
      return `<div class="recent-row">
        <span class="match-place${match.placement===1?' first':''}">${match.placement}. místo</span>
        <span class="match-opponents">${escapeHtml((match.opponents||[]).join(' · ') || 'Ligový zápas')}<small class="match-date">${date}</small></span>
        <span class="match-rating ${cls}">${visible ? signed(delta) : '—'}</span>
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

  function showMatchmakingState(which) {
    $('league-matchmaking').classList.remove('hidden');
    $('queue-state').classList.toggle('hidden', which !== 'queue');
    $('ready-state').classList.toggle('hidden', which !== 'ready');
    $('matchmaking-message-state').classList.toggle('hidden', which !== 'message');
  }

  function hideMatchmaking() {
    $('league-matchmaking').classList.add('hidden');
  }

  function formatClock(ms) {
    const total = Math.max(0, Math.floor(ms / 1000));
    const m = Math.floor(total / 60);
    const s = total % 60;
    return `${String(m).padStart(2,'0')}:${String(s).padStart(2,'0')}`;
  }

  function updateQueueClock() {
    if (!queueWaitAnchor) return;
    $('queue-time').textContent = formatClock(Date.now() - queueWaitAnchor);
  }

  function startQueueClock(waitMs = 0) {
    queueWaitAnchor = Date.now() - Math.max(0, Number(waitMs) || 0);
    if (queueClockTimer) clearInterval(queueClockTimer);
    updateQueueClock();
    queueClockTimer = setInterval(updateQueueClock, 250);
  }

  function stopQueueClock() {
    if (queueClockTimer) clearInterval(queueClockTimer);
    queueClockTimer = null;
  }

  function queueRangeCopy(range) {
    if (range == null) return 'Čekáš déle. Hledáme už mezi všemi dostupnými vhodnými hráči.';
    if (range <= 100) return 'Začínáme úzkým ratingovým rozmezím ±100.';
    if (range <= 200) return 'Hledání se rozšířilo na ±200 ratingu.';
    return 'Hledání se rozšířilo na ±350 ratingu.';
  }

  function applyQueueStatus(data = {}) {
    matchmakingMode = 'queue';
    showMatchmakingState('queue');
    startQueueClock(data.waitMs || 0);
    $('queue-range').textContent = data.searchRange == null ? 'VOLNÉ' : `±${data.searchRange}`;
    $('queue-position').textContent = fmt(data.position || 1);
    $('queue-size').textContent = fmt(data.queueSize || 1);
    $('queue-search-note').textContent = queueRangeCopy(data.searchRange);
  }

  function renderReadyPlayers(acceptedMap = new Map()) {
    const meId = String(window.VlastenecAuth?.state?.user?.id || overview?.user?.id || '');
    $('ready-players').innerHTML = readyPlayers.map(player => {
      const accepted = acceptedMap.get(String(player.userId)) || false;
      const meta = player.ranked ? `Rating ${fmt(player.rating)}` : 'Rozřazení';
      return `<div class="ready-player${String(player.userId)===meId?' me':''}${accepted?' accepted':''}" data-user="${escapeHtml(player.userId)}">
        <span class="ready-avatar">${escapeHtml(initials(player.displayName))}</span>
        <span class="ready-name"><strong>${escapeHtml(player.displayName)}</strong><small>${meta}</small></span>
        <span class="ready-mark">${accepted ? '✓' : '·'}</span>
      </div>`;
    }).join('');
  }

  function updateReadyClock() {
    const left = Math.max(0, Math.ceil((readyDeadline - Date.now()) / 1000));
    $('ready-seconds').textContent = String(left);
  }

  function startReadyClock() {
    if (readyClockTimer) clearInterval(readyClockTimer);
    updateReadyClock();
    readyClockTimer = setInterval(updateReadyClock, 100);
  }

  function stopReadyClock() {
    if (readyClockTimer) clearInterval(readyClockTimer);
    readyClockTimer = null;
  }

  function showMessage(title, copy) {
    matchmakingMode = 'idle';
    stopQueueClock(); stopReadyClock();
    $('matchmaking-message-title').textContent = title;
    $('matchmaking-message-copy').textContent = copy;
    showMatchmakingState('message');
  }

  function ensureLeagueSocket() {
    if (socket) return socket;
    socket = io({ autoConnect:false });

    socket.on('connect', () => {
      if (matchmakingMode === 'queue') socket.emit('league:queue:join');
      else if (matchmakingMode === 'ready' && readyMatchId) socket.emit('league:ready:resume', { matchId:readyMatchId });
    });

    socket.on('league:queue:joined', applyQueueStatus);
    socket.on('league:queue:status', applyQueueStatus);
    socket.on('league:queue:left', () => {
      matchmakingMode = 'idle'; stopQueueClock(); hideMatchmaking();
    });
    socket.on('league:queue:replaced', ({ message } = {}) => showMessage('Matchmaking přesunut', message || 'Fronta je otevřená v jiném okně.'));
    socket.on('league:queue:error', ({ message, cooldownSeconds } = {}) => {
      const suffix = cooldownSeconds ? ` Zkus to za ${cooldownSeconds} s.` : '';
      showMessage('Do fronty se nepodařilo vstoupit', `${message || 'Matchmaking není dostupný.'}${suffix}`);
    });

    socket.on('league:ready:found', ({ matchId, deadline, players } = {}) => {
      matchmakingMode = 'ready';
      stopQueueClock();
      readyMatchId = String(matchId || '');
      readyDeadline = Number(deadline || (Date.now()+10000));
      readyPlayers = Array.isArray(players) ? players : [];
      $('ready-accept').classList.remove('is-accepted');
      $('ready-accept').querySelector('span').textContent = 'POTVRDIT ZÁPAS';
      renderReadyPlayers();
      showMatchmakingState('ready');
      startReadyClock();
    });

    socket.on('league:ready:update', ({ accepted, deadline } = {}) => {
      if (deadline) readyDeadline = Number(deadline);
      const map = new Map((accepted || []).map(x => [String(x.userId), !!x.accepted]));
      renderReadyPlayers(map);
      const meId = String(window.VlastenecAuth?.state?.user?.id || overview?.user?.id || '');
      if (map.get(meId)) {
        $('ready-accept').classList.add('is-accepted');
        $('ready-accept').querySelector('span').textContent = 'POTVRZENO';
      }
    });

    socket.on('league:ready:cancelled', ({ requeued, message, cooldownSeconds } = {}) => {
      stopReadyClock(); readyMatchId = null;
      if (requeued) {
        matchmakingMode = 'queue';
        showMatchmakingState('queue');
        $('queue-copy').textContent = message || 'Vracíme tě do fronty se zachovanou prioritou.';
      } else {
        const suffix = cooldownSeconds ? ` Další hledání bude možné za ${cooldownSeconds} sekund.` : '';
        showMessage('Zápas se nespustil', `${message || 'Ready check skončil.'}${suffix}`);
      }
    });
    socket.on('league:ready:error', ({ message } = {}) => showMessage('Ready check skončil', message || 'Zápas už není dostupný.'));

    socket.on('league:ready:launch', ({ url } = {}) => {
      matchmakingMode = 'launching'; stopReadyClock();
      $('matchmaking-message-title').textContent = 'Spouštíme zápas';
      $('matchmaking-message-copy').textContent = 'Všichni tři hráči potvrdili. Připojujeme tě k herní mapě…';
      showMatchmakingState('message');
      $('matchmaking-message-close').classList.add('hidden');
      setTimeout(() => { location.href = url || 'league.html'; }, 180);
    });

    socket.on('disconnect', () => {
      if (matchmakingMode === 'queue') $('queue-copy').textContent = 'Obnovujeme spojení se serverem…';
    });

    return socket;
  }

  function startMatchmaking() {
    if (!window.VlastenecAuth?.state?.authenticated || !overview?.authenticated) {
      return window.VLASTENEC_OPEN_LOGIN?.(`${location.pathname}${location.search}${location.hash}`);
    }
    matchmakingMode = 'queue';
    $('queue-copy').textContent = overview?.me?.ranked
      ? 'Hledáme dva hráče přibližně na tvé úrovni.'
      : 'Hledáme soupeře pro rozřazovací zápas.';
    applyQueueStatus({ waitMs:0, searchRange:100, position:1, queueSize:1 });
    const s = ensureLeagueSocket();
    if (!s.connected) s.connect(); else s.emit('league:queue:join');
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
  $('league-play').addEventListener('click', startMatchmaking);
  $('queue-cancel').addEventListener('click', () => {
    if (socket?.connected) socket.emit('league:queue:leave');
    matchmakingMode = 'idle'; stopQueueClock(); hideMatchmaking();
  });
  $('ready-accept').addEventListener('click', () => {
    if (!readyMatchId || !socket?.connected) return;
    socket.emit('league:ready:accept', { matchId:readyMatchId });
  });
  $('ready-decline').addEventListener('click', () => {
    if (!readyMatchId || !socket?.connected) return;
    socket.emit('league:ready:decline', { matchId:readyMatchId });
  });
  $('matchmaking-message-close').addEventListener('click', async () => {
    matchmakingMode='idle'; readyMatchId=null; hideMatchmaking();
    $('matchmaking-message-close').classList.remove('hidden');
    await loadOverview();
  });

  (async () => {
    try { if (window.VLASTENEC_AUTH_READY) await window.VLASTENEC_AUTH_READY; } catch (_) {}
    renderIdentity();
    await loadOverview();
    console.log('🧪 VLASTENEC LEAGUE CLIENT: league-matchmaking-v1');
  })();
})();
