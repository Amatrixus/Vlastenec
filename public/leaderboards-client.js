(() => {
  'use strict';

  const CATEGORIES = [
    ['vedy','Přírodní vědy','tiles/tile1.png'],
    ['literatura','Literatura','tiles/tile2.png'],
    ['technologie','Technologie','tiles/tile3.png'],
    ['geografie','Geografie','tiles/tile4.png'],
    ['historie','Historie','tiles/tile5.png'],
    ['kultura','Kultura','tiles/tile6.png'],
    ['sport','Sport','tiles/tile7.png'],
    ['osobnosti','Osobnosti','tiles/tile8.png'],
    ['politika','Politika','tiles/tile9.png']
  ];
  const PERIOD_LABELS = { '7d':'za 7 dní','30d':'za 30 dní','90d':'za 90 dní','all':'celkem' };
  const state = { scope:'normal', view:'overall', period:'30d', category:'historie' };
  let loadToken = 0;

  const $ = id => document.getElementById(id);
  const fmt = new Intl.NumberFormat('cs-CZ');
  const pct = value => `${(Number(value || 0) * 100).toLocaleString('cs-CZ',{maximumFractionDigits:1})} %`;
  const num = value => fmt.format(Number(value || 0));
  const escapeHtml = value => String(value ?? '').replace(/[&<>'"]/g, c => ({'&':'&amp;','<':'&lt;','>':'&gt;',"'":'&#39;','"':'&quot;'}[c]));

  function showStatus(message = '', error = false) {
    const el = $('status-banner');
    if (!message) { el.hidden = true; el.textContent=''; el.classList.remove('error'); return; }
    el.hidden = false; el.textContent = message; el.classList.toggle('error',!!error);
  }

  async function json(url) {
    const response = await fetch(url,{ credentials:'same-origin', headers:{ Accept:'application/json' } });
    const data = await response.json().catch(()=>({}));
    if (!response.ok || data.ok === false) throw new Error(data.message || 'Data se nepodařilo načíst.');
    return data;
  }

  function setLoading() {
    $('my-position-card').innerHTML = `<div class="my-empty"><b>Načítám pořadí…</b><span>Aktualizujeme žebříček.</span></div>`;
    $('podium').innerHTML = '';
    $('ranking-body').innerHTML = '';
    $('ranking-empty').hidden = true;
    $('nearby-card').hidden = true;
  }

  function normalMyCard(me, period) {
    if (!me) return `<div class="my-empty"><span class="my-label">VAŠE POZICE</span><b>Zatím bez hodnocení</b><span>Do výkonnosti se započítají rychlé hry, ve kterých jsou všichni tři hráči přihlášení.</span></div>`;
    const delta=Number(me.periodDelta||0);
    return `
      <div><span class="my-label">VAŠE POZICE · ${escapeHtml(PERIOD_LABELS[period] || '')}</span><div class="my-rank">#${num(me.rank)}</div><div class="my-name">${escapeHtml(me.displayName)}</div></div>
      <div class="my-stats">
        <span class="my-stat"><small>Výkonnost</small><strong>${num(me.rating)}</strong></span>
        <span class="my-stat"><small>Změna</small><strong class="${delta>0?'delta-up':delta<0?'delta-down':''}">${delta>0?'+':''}${num(delta)}</strong></span>
        <span class="my-stat"><small>Hodnocené hry</small><strong>${num(me.games)}</strong></span>
        <span class="my-stat"><small>Win rate</small><strong>${pct(me.winRate)}</strong></span>
      </div>`;
  }

  function leagueMyCard(overview) {
    const me = overview?.me;
    if (!overview?.authenticated) return `<div class="my-empty"><span class="my-label">VAŠE POZICE</span><b>Přihlas se</b><span>Po přihlášení tu uvidíš svou ligovou pozici a sezonní statistiky.</span></div>`;
    if (!me) return `<div class="my-empty"><span class="my-label">VAŠE POZICE</span><b>Rozřazení nezačalo</b><span>Vstup do ligového matchmakingu a odehraj první zápas.</span></div>`;
    if (!me.ranked) return `
      <div><span class="my-label">ROZŘAZENÍ · ${escapeHtml(overview.season?.name || '')}</span><div class="my-rank">${num(me.placementGames)}<small> / ${num(me.placementRequired)}</small></div><div class="my-name">${escapeHtml(overview.user?.displayName || 'Hráč')}</div></div>
      <div class="my-stats"><span class="my-stat"><small>Zápasy</small><strong>${num(me.games)}</strong></span><span class="my-stat"><small>Výhry</small><strong>${num(me.wins)}</strong></span><span class="my-stat"><small>Rating</small><strong>Skryt</strong></span><span class="my-stat"><small>Sezóna</small><strong>${escapeHtml(overview.season?.name || '—')}</strong></span></div>`;
    return `
      <div><span class="my-label">VAŠE POZICE · ${escapeHtml(overview.season?.name || '')}</span><div class="my-rank">#${num(me.rank)}</div><div class="my-name">${escapeHtml(overview.user?.displayName || 'Hráč')} · ${escapeHtml(me.division?.name || '')}</div></div>
      <div class="my-stats"><span class="my-stat"><small>Rating</small><strong>${num(me.rating)}</strong></span><span class="my-stat"><small>Změna v sezóně</small><strong>${me.ratingDeltaSeason>=0?'+':''}${num(me.ratingDeltaSeason)}</strong></span><span class="my-stat"><small>Zápasy</small><strong>${num(me.games)}</strong></span><span class="my-stat"><small>Win rate</small><strong>${pct(me.games?me.wins/me.games:0)}</strong></span></div>`;
  }

  function renderPodium(rows, league = false) {
    const podium = $('podium');
    const top = (rows || []).slice(0,3);
    if (!top.length) {
      podium.innerHTML = `<div class="my-empty" style="grid-column:1/-1"><b>Žebříček se teprve tvoří</b><span>Jakmile se objeví první výsledky, TOP 3 se zobrazí tady.</span></div>`;
      return;
    }
    podium.innerHTML = top.map((row,index) => `
      <article class="podium-card place-${index+1}">
        <span class="podium-rank">${index+1}.</span><span class="podium-medal">${index===0?'★':index===1?'II':'III'}</span>
        <div class="podium-name">${escapeHtml(row.displayName)}</div>
        <div class="podium-value">${league ? `${num(row.rating)} rating` : `${num(row.rating)} výkonnost`}</div>
        <div class="podium-sub">${league ? `${escapeHtml(row.division?.name || '')} · ${num(row.games)} zápasů` : `${num(row.wins)} výher · ${pct(row.winRate)} win rate`}</div>
      </article>`).join('');
  }

  function renderNormalTable(data) {
    $('ranking-head').innerHTML = `<tr><th>#</th><th>Hráč</th><th>Výkonnost</th><th>Změna</th><th>Hodnocené hry</th><th>Výhry</th><th>Win rate</th><th>Průměrné pořadí</th></tr>`;
    $('ranking-body').innerHTML = (data.rows || []).map(row => {
      const delta=Number(row.periodDelta||0);
      return `<tr class="${row.isMe?'is-me':''}">
        <td class="rank-cell ${row.rank<=3?'top':''}">#${num(row.rank)}</td>
        <td class="player-cell">${escapeHtml(row.displayName)}${row.isMe?' · TY':''}</td>
        <td class="metric-gold">${num(row.rating)}</td>
        <td class="${delta>0?'delta-up':delta<0?'delta-down':''}">${delta>0?'+':''}${num(delta)}</td>
        <td>${num(row.games)}</td><td class="metric-strong">${num(row.wins)}</td><td>${pct(row.winRate)}</td>
        <td>${Number(row.averagePlacement || 0).toLocaleString('cs-CZ',{maximumFractionDigits:2})}</td>
      </tr>`;
    }).join('');
    $('ranking-empty').hidden = !!data.rows?.length;
    $('ranking-empty').textContent = 'V tomto období zatím není žádná hodnocená rychlá hra tří přihlášených hráčů.';
    $('table-count').textContent = `${num(data.total)} hráčů`;
  }

  function renderLeagueTable(data) {
    $('ranking-head').innerHTML = `<tr><th>#</th><th>Hráč</th><th>Divize</th><th>Rating</th><th>Zápasy</th><th>Výhry</th><th>Win rate</th></tr>`;
    $('ranking-body').innerHTML = (data.rows || []).map(row => `
      <tr class="${row.isMe?'is-me':''}">
        <td class="rank-cell ${row.rank<=3?'top':''}">#${num(row.rank)}</td><td class="player-cell">${escapeHtml(row.displayName)}${row.isMe?' · TY':''}</td>
        <td>${escapeHtml(row.division?.name || '—')}</td><td class="metric-gold">${num(row.rating)}</td><td>${num(row.games)}</td><td class="metric-strong">${num(row.wins)}</td><td>${pct(row.winRate)}</td>
      </tr>`).join('');
    $('ranking-empty').hidden = !!data.rows?.length;
    $('ranking-empty').textContent = 'V aktuální sezoně zatím nikdo nedokončil rozřazení.';
    $('table-count').textContent = `${num(data.total)} rozřazených`;
  }

  function renderNearby(rows, league = false) {
    const card = $('nearby-card');
    if (!rows?.length) { card.hidden=true; return; }
    card.hidden=false;
    $('nearby-list').innerHTML = rows.map(row => `
      <div class="nearby-row ${row.isMe?'is-me':''}">
        <span class="nearby-rank">#${num(row.rank)}</span><span class="nearby-name">${escapeHtml(row.displayName)}${row.isMe?' · TY':''}</span>
        <span class="nearby-metric">${league?'Rating':'Výkonnost'} <b>${num(row.rating)}</b></span>
        <span class="nearby-metric">${league?'Výhry':'Win rate'} <b>${league?num(row.wins):pct(row.winRate)}</b></span>
      </div>`).join('');
  }

  async function loadOverall() {
    const token = ++loadToken; setLoading(); showStatus();
    try {
      if (state.scope === 'normal') {
        const data = await json(`/api/leaderboards/normal?period=${encodeURIComponent(state.period)}&limit=100`);
        if (token!==loadToken) return;
        $('my-position-card').innerHTML = normalMyCard(data.me,state.period);
        renderPodium(data.rows,false); renderNormalTable(data); renderNearby(data.nearby,false);
        $('table-kicker').textContent='NORMÁLNÍ HRA'; $('table-title').textContent=`Nejlepší hráči ${PERIOD_LABELS[state.period]}`; $('table-note').textContent='Výkonnost je serverový rating. Započítají se jen rychlé hry tří přihlášených hráčů.';
      } else {
        const [board,overview] = await Promise.all([json('/api/league/leaderboard?limit=100'),json('/api/league/overview')]);
        if (token!==loadToken) return;
        $('my-position-card').innerHTML = leagueMyCard(overview);
        renderPodium(board.rows,true); renderLeagueTable(board); renderNearby(overview?.leaderboard?.nearby || [],true);
        $('table-kicker').textContent='LIGA'; $('table-title').textContent=`${board.season?.name || 'Aktuální sezóna'} · celkové pořadí`; $('table-note').textContent='Ligový rating a pořadí se počítají z aktuální sezóny.';
      }
    } catch (err) { if(token!==loadToken)return; showStatus(err.message,true); $('ranking-empty').hidden=false; $('ranking-empty').textContent=err.message; }
  }

  function renderCategoryGrid() {
    $('category-grid').innerHTML = CATEGORIES.map(([slug,label,image]) => `
      <button type="button" class="category-button ${state.category===slug?'is-active':''}" data-category="${slug}"><img src="${image}" alt=""><span>${escapeHtml(label)}</span></button>`).join('');
    document.querySelectorAll('.category-button').forEach(button => button.addEventListener('click',()=>{state.category=button.dataset.category;renderCategoryGrid();loadCategory();}));
  }

  async function loadCategory() {
    const token=++loadToken; showStatus();
    const meta=CATEGORIES.find(row=>row[0]===state.category) || CATEGORIES[4];
    $('category-title').textContent=meta[1]; $('category-kicker').textContent='KATEGORIE'; $('category-period-note').textContent=PERIOD_LABELS[state.period] || 'celkem'; $('category-body').innerHTML=''; $('category-empty').hidden=true;
    $('category-me').innerHTML=`<div class="my-empty"><b>Načítám kategorii…</b></div>`;
    try {
      const data=await json(`/api/leaderboards/category?category=${encodeURIComponent(state.category)}&period=${encodeURIComponent(state.period)}&limit=100`);
      if(token!==loadToken)return;
      const me=data.me;
      $('category-me').innerHTML = me ? `
        <div><span class="my-label">VAŠE STATISTIKA · ${escapeHtml(meta[1])}</span><div class="my-rank">${pct(me.accuracy)}</div><div class="my-name">${me.eligible ? 'Zařazen do žebříčku' : `Ještě ${Math.max(0,data.minAnswers-me.played)} odpovědí do žebříčku`}</div></div>
        <div class="my-stats"><span class="my-stat"><small>Správně</small><strong>${num(me.successes)}</strong></span><span class="my-stat"><small>Celkem</small><strong>${num(me.played)}</strong></span><span class="my-stat"><small>Minimum</small><strong>${num(data.minAnswers)}</strong></span><span class="my-stat"><small>Stav</small><strong>${me.eligible?'Aktivní':'Prozatímní'}</strong></span></div>`
        : `<div class="my-empty"><span class="my-label">VAŠE STATISTIKA</span><b>Bez odpovědí</b><span>V této kategorii zatím nemáš uloženou odpověď.</span></div>`;
      $('category-body').innerHTML=(data.rows||[]).map(row=>`<tr class="${row.isMe?'is-me':''}"><td class="rank-cell ${row.rank<=3?'top':''}">#${num(row.rank)}</td><td class="player-cell">${escapeHtml(row.displayName)}${row.isMe?' · TY':''}</td><td class="metric-gold">${pct(row.accuracy)}</td><td class="metric-strong">${num(row.successes)}</td><td>${num(row.played)}</td></tr>`).join('');
      $('category-count').textContent=`${num(data.total)} kvalifikovaných`;
      $('category-empty').hidden=!!data.rows?.length;
      $('category-empty').textContent=`Zatím nikdo nesplnil minimum ${data.minAnswers} odpovědí v této kategorii.`;
    } catch(err){if(token!==loadToken)return;showStatus(err.message,true);$('category-empty').hidden=false;$('category-empty').textContent=err.message;}
  }


  async function loadNumeric() {
    const token=++loadToken; showStatus();
    $('numeric-body').innerHTML=''; $('numeric-empty').hidden=true;
    $('numeric-me').innerHTML=`<div class="my-empty"><b>Načítám numerické statistiky…</b></div>`;
    try {
      const data=await json(`/api/leaderboards/numeric?period=${encodeURIComponent(state.period)}&limit=100`);
      if(token!==loadToken)return;
      const me=data.me;
      $('numeric-me').innerHTML = me ? `
        <div><span class="my-label">VAŠE NUMERICKÁ PŘESNOST · ${escapeHtml(PERIOD_LABELS[state.period]||'')}</span><div class="my-rank">${Number(me.medianErrorPct||0).toLocaleString('cs-CZ',{maximumFractionDigits:1})} %</div><div class="my-name">medián odchylky · ${me.eligible?'zařazen do žebříčku':`ještě ${Math.max(0,data.minAnswers-me.attempts)} odhadů`}</div></div>
        <div class="my-stats"><span class="my-stat"><small>Přesnost</small><strong>${pct(me.accuracy)}</strong></span><span class="my-stat"><small>Přesné zásahy</small><strong>${num(me.exactHits)}</strong></span><span class="my-stat"><small>Odhadů</small><strong>${num(me.attempts)}</strong></span><span class="my-stat"><small>Odesláno</small><strong>${num(me.submitted)}</strong></span></div>`
        : `<div class="my-empty"><span class="my-label">VAŠE NUMERICKÁ PŘESNOST</span><b>Zatím bez odhadu</b><span>Numerické otázky z rychlé hry se začnou počítat od této verze.</span></div>`;
      $('numeric-body').innerHTML=(data.rows||[]).map(row=>`<tr class="${row.isMe?'is-me':''}"><td class="rank-cell ${row.rank<=3?'top':''}">#${num(row.rank)}</td><td class="player-cell">${escapeHtml(row.displayName)}${row.isMe?' · TY':''}</td><td class="metric-gold">${Number(row.medianErrorPct||0).toLocaleString('cs-CZ',{maximumFractionDigits:1})} %</td><td class="metric-strong">${pct(row.accuracy)}</td><td>${num(row.exactHits)}</td><td>${num(row.attempts)}</td></tr>`).join('');
      $('numeric-count').textContent=`${num(data.total)} kvalifikovaných`;
      $('numeric-empty').hidden=!!data.rows?.length;
      $('numeric-empty').textContent=`Zatím nikdo nesplnil minimum ${data.minAnswers} numerických odhadů v tomto období.`;
    } catch(err){if(token!==loadToken)return;showStatus(err.message,true);$('numeric-empty').hidden=false;$('numeric-empty').textContent=err.message;}
  }

  async function loadRecords() {
    const token=++loadToken; showStatus(); $('records-grid').innerHTML='';
    if(state.scope==='league') {
      $('records-grid').innerHTML=`<article class="coming-card" style="grid-column:1/-1;min-height:300px"><span class="section-kicker">LIGOVÉ REKORDY</span><h2>Sezonní rekordy přidáme nad autoritativní ligová data</h2><p>Samotné pořadí Ligy už je serverové. Rekordové disciplíny vytvoříme až poté, co přesně určíme, které ligové výkony chceme archivovat napříč sezonami.</p></article>`;
      return;
    }
    try {
      const data=await json(`/api/leaderboards/records?period=${encodeURIComponent(state.period)}`); if(token!==loadToken)return;
      const r=data.records||{};
      const defs=[
        ['★','Nejvíce vítězství',r.mostWins,r.mostWins?`${num(r.mostWins.wins)} výher`:null],
        ['%','Nejvyšší win rate',r.bestWinRate,r.bestWinRate?`${pct(r.bestWinRate.winRate)} · ${num(r.bestWinRate.games)} her`:null],
        ['◆','Nejvyšší skóre',r.bestScore,r.bestScore?`${num(r.bestScore.bestScore)} bodů`:null],
        ['⌂','Nejvíce území',r.mostTerritories,r.mostTerritories?`${num(r.mostTerritories.territories)} území`:null],
        ['✓','Nejvíce úspěšných otázek',r.mostQuestionWins,r.mostQuestionWins?`${num(r.mostQuestionWins.questionWins)} úspěchů`:null]
      ];
      $('records-grid').innerHTML=defs.map(([icon,label,row,value])=>`<article class="record-card"><div><span class="record-icon">${icon}</span><div class="record-label">${label}</div></div>${row?`<div><div class="record-player">${escapeHtml(row.displayName)}</div><div class="record-value">${value}</div></div>`:`<div class="record-empty">Zatím bez dat</div>`}</article>`).join('');
    } catch(err){if(token!==loadToken)return;showStatus(err.message,true);}
  }

  function applyStateToUI() {
    document.querySelectorAll('.scope-tab').forEach(el=>el.classList.toggle('is-active',el.dataset.scope===state.scope));
    if(state.scope==='league' && state.view!=='overall' && state.view!=='records') state.view='overall';
    document.querySelectorAll('.view-tab').forEach(el=>{
      const unsupported=state.scope==='league' && ['categories','numeric'].includes(el.dataset.view);
      el.disabled=unsupported; el.style.opacity=unsupported?'.30':''; el.title=unsupported?'Nejdřív oddělíme ligové statistiky kategorií od ostatních režimů.':'';
      el.classList.toggle('is-active',el.dataset.view===state.view);
    });
    document.querySelectorAll('.view-panel').forEach(el=>el.hidden=true);
    $(`${state.view}-view`).hidden=false;
    const showPeriods=state.scope==='normal' && ['overall','categories','numeric','records'].includes(state.view);
    $('period-controls').hidden=!showPeriods;
    $('period-caption').hidden=showPeriods;
    if(!showPeriods){$('period-caption').textContent=state.scope==='league'?'Aktuální sezóna':'Celková statistika';}
    document.querySelectorAll('#period-controls button').forEach(el=>el.classList.toggle('is-active',el.dataset.period===state.period));
    $('records-description').textContent=state.scope==='normal'?`Rekordy rychlé hry ${PERIOD_LABELS[state.period]}.`:'Rekordy aktuální ligové sezóny.';
  }

  function reload() {
    applyStateToUI(); showStatus();
    if(state.view==='overall') loadOverall();
    else if(state.view==='categories'){renderCategoryGrid();loadCategory();}
    else if(state.view==='numeric') loadNumeric();
    else if(state.view==='records') loadRecords();
  }

  function wireControls() {
    document.querySelectorAll('.scope-tab').forEach(el=>el.addEventListener('click',()=>{state.scope=el.dataset.scope;state.view='overall';reload();}));
    document.querySelectorAll('.view-tab').forEach(el=>el.addEventListener('click',()=>{if(el.disabled)return;state.view=el.dataset.view;reload();}));
    document.querySelectorAll('#period-controls button').forEach(el=>el.addEventListener('click',()=>{state.period=el.dataset.period;reload();}));
  }

  function wireHeader() {
    const counter=$('online-count');
    if(counter && typeof io==='function'){
      const socket=io({transports:['websocket','polling']});
      socket.on('portal:onlineCount',payload=>{const value=Number(payload?.count);counter.textContent=Number.isFinite(value)?String(value):'—';});
    }
    const chip=$('profile-chip'), name=$('profile-name'), meta=$('profile-meta');
    chip?.addEventListener('click',()=>{if(window.VlastenecAuth?.state?.authenticated)location.href='profile.html';else window.VLASTENEC_OPEN_LOGIN?.(`${location.pathname}${location.search}${location.hash}`);});
    (async()=>{try{if(window.VLASTENEC_AUTH_READY)await window.VLASTENEC_AUTH_READY;}catch(_){ }const auth=window.VlastenecAuth?.state;if(auth?.authenticated&&auth.user){name.textContent=auth.user.displayName;meta.textContent='Profil a statistiky';}else{name.textContent='Přihlásit se';meta.textContent='Ukládej postup a výsledky';}})();
  }

  wireHeader(); wireControls(); renderCategoryGrid(); reload();
  console.log('🧪 VLASTENEC CLIENT: leaderboards-v2');
})();
