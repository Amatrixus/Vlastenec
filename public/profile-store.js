(() => {
  'use strict';

  const STORAGE_VERSION = 1;
  const GUEST_ID_KEY = 'vl_guest_profile_id';
  const GUEST_NAME_KEY = 'vl_guest_name';

  const CATEGORIES = [
    { id: 1, slug: 'vedy', name: 'Přírodní vědy', image: 'tiles/tile1.png', aliases: ['vedy','vědy','prirodni vedy','přírodní vědy','science'] },
    { id: 2, slug: 'literatura', name: 'Literatura', image: 'tiles/tile2.png', aliases: ['literatura','literature'] },
    { id: 3, slug: 'technologie', name: 'Technologie', image: 'tiles/tile3.png', aliases: ['technologie','technology','tech'] },
    { id: 4, slug: 'geografie', name: 'Geografie', image: 'tiles/tile4.png', aliases: ['geografie','geography'] },
    { id: 5, slug: 'historie', name: 'Historie', image: 'tiles/tile5.png', aliases: ['historie','history'] },
    { id: 6, slug: 'kultura', name: 'Kultura', image: 'tiles/tile6.png', aliases: ['kultura','culture'] },
    { id: 7, slug: 'sport', name: 'Sport', image: 'tiles/tile7.png', aliases: ['sport','sports'] },
    { id: 8, slug: 'osobnosti', name: 'Osobnosti', image: 'tiles/tile8.png', aliases: ['osobnosti','personalities','people'] },
    { id: 9, slug: 'politika', name: 'Politika', image: 'tiles/tile9.png', aliases: ['politika','politics'] }
  ];

  const ACHIEVEMENTS = [
    { id:'first_match', name:'První výprava', description:'Dokonči první zápas.', icon:'01', target:1, value:d=>d.stats.gamesPlayed },
    { id:'first_win', name:'První vítězství', description:'Vyhraj svůj první zápas.', icon:'02', target:1, value:d=>d.stats.wins },
    { id:'veteran_10', name:'Pravidelný hráč', description:'Odehraj 10 zápasů.', icon:'10', target:10, value:d=>d.stats.gamesPlayed },
    { id:'veteran_50', name:'Veterán', description:'Odehraj 50 zápasů.', icon:'50', target:50, value:d=>d.stats.gamesPlayed },
    { id:'cartographer_25', name:'Kartograf I', description:'Získej celkem 25 území.', icon:'25', target:25, value:d=>d.stats.territoriesCaptured },
    { id:'cartographer_100', name:'Kartograf II', description:'Získej celkem 100 území.', icon:'100', target:100, value:d=>d.stats.territoriesCaptured },
    { id:'streak_5', name:'V ráži', description:'Dosáhni série 5 úspěšných otázek.', icon:'5×', target:5, value:d=>d.stats.maxStreak },
    { id:'streak_10', name:'Bez zaváhání', description:'Dosáhni série 10 úspěšných otázek.', icon:'10×', target:10, value:d=>d.stats.maxStreak },
    { id:'polyhistor', name:'Polyhistor', description:'Uspěj alespoň jednou ve všech 9 kategoriích.', icon:'9/9', target:9, value:d=>CATEGORIES.filter(c=>(d.categories[c.slug]?.successes||0)>0).length },
    { id:'specialist', name:'Specialista', description:'Dosáhni 80 % v jedné kategorii po alespoň 10 otázkách.', icon:'80%', target:1, value:d=>CATEGORIES.some(c=>{const s=d.categories[c.slug]||{};return (s.played||0)>=10 && (s.successes||0)/(s.played||1)>=.8;}) ? 1 : 0 },
    { id:'centurion', name:'Stovka', description:'Uspěj ve 100 otázkách.', icon:'100', target:100, value:d=>d.stats.questionWins },
    { id:'high_score', name:'Bodový nájezd', description:'Získej v zápase alespoň 2 500 bodů.', icon:'2.5K', target:2500, value:d=>d.stats.bestScore }
  ];

  function safeJson(raw, fallback) {
    try { return JSON.parse(raw); } catch { return fallback; }
  }

  function randomId() {
    try { return crypto.randomUUID(); } catch { return `g-${Date.now()}-${Math.random().toString(36).slice(2)}`; }
  }

  function getProfileIdentity() {
    const external = window.VLASTENEC_PROFILE || null;
    if (external) {
      const externalId = String(external.id || external.userId || external.uid || external.email || 'profile').trim();
      const displayName = String(external.displayName || external.name || 'Hráč').trim().slice(0,24);
      return { type:'account', id:`account:${externalId}`, displayName, external };
    }

    let id = localStorage.getItem(GUEST_ID_KEY);
    if (!id) {
      id = randomId();
      localStorage.setItem(GUEST_ID_KEY, id);
    }
    const displayName = String(localStorage.getItem(GUEST_NAME_KEY) || sessionStorage.getItem(GUEST_NAME_KEY) || sessionStorage.getItem('vl_name') || 'Host').trim().slice(0,24);
    return { type:'guest', id:`guest:${id}`, displayName, external:null };
  }

  function storageKey(identity = getProfileIdentity()) {
    return `vlastenec_profile_v${STORAGE_VERSION}:${identity.id}`;
  }

  function blankCategories() {
    return Object.fromEntries(CATEGORIES.map(c => [c.slug, { played:0, successes:0 }]));
  }

  function defaultData(identity = getProfileIdentity()) {
    return {
      version: STORAGE_VERSION,
      identityId: identity.id,
      displayName: identity.displayName,
      createdAt: new Date().toISOString(),
      updatedAt: new Date().toISOString(),
      xp: 0,
      stats: {
        gamesPlayed:0, wins:0, seconds:0, thirds:0,
        totalScore:0, bestScore:0,
        questionsPlayed:0, questionWins:0,
        territoriesCaptured:0,
        currentStreak:0, maxStreak:0
      },
      modes: {
        random:{ games:0, wins:0 },
        custom:{ games:0, wins:0 },
        friends:{ games:0, wins:0 },
        bots:{ games:0, wins:0 }
      },
      categories: blankCategories(),
      achievements: {},
      matches: []
    };
  }

  function normalizeData(raw, identity = getProfileIdentity()) {
    const base = defaultData(identity);
    const data = raw && typeof raw === 'object' ? raw : {};
    return {
      ...base,
      ...data,
      displayName: identity.displayName || data.displayName || base.displayName,
      stats: { ...base.stats, ...(data.stats || {}) },
      modes: {
        random:{...base.modes.random, ...(data.modes?.random||{})},
        custom:{...base.modes.custom, ...(data.modes?.custom||{})},
        friends:{...base.modes.friends, ...(data.modes?.friends||{})},
        bots:{...base.modes.bots, ...(data.modes?.bots||{})}
      },
      categories: Object.fromEntries(CATEGORIES.map(c => [c.slug, { ...base.categories[c.slug], ...(data.categories?.[c.slug] || {}) }])),
      achievements: { ...(data.achievements || {}) },
      matches: Array.isArray(data.matches) ? data.matches.slice(0,20) : []
    };
  }

  function read() {
    const identity = getProfileIdentity();
    const raw = safeJson(localStorage.getItem(storageKey(identity)), null);
    const data = normalizeData(raw, identity);
    evaluateAchievements(data);
    return data;
  }

  function write(data) {
    const identity = getProfileIdentity();
    const clean = normalizeData(data, identity);
    clean.displayName = identity.displayName || clean.displayName;
    clean.updatedAt = new Date().toISOString();
    evaluateAchievements(clean);
    localStorage.setItem(storageKey(identity), JSON.stringify(clean));
    return clean;
  }

  function mutate(fn) {
    const data = read();
    fn(data);
    return write(data);
  }

  function normalizeCategory(raw) {
    if (raw == null) return null;
    const value = String(Array.isArray(raw) ? raw[0] : raw).trim().toLowerCase().normalize('NFD').replace(/[\u0300-\u036f]/g,'');
    for (const c of CATEGORIES) {
      if (c.slug === value) return c.slug;
      if (c.aliases.some(a => a.normalize('NFD').replace(/[\u0300-\u036f]/g,'') === value)) return c.slug;
    }
    return null;
  }

  function levelInfo(xpValue) {
    let xp = Math.max(0, Number(xpValue) || 0);
    let level = 1;
    let spent = 0;
    while (level < 999) {
      const need = 200 + (level - 1) * 100;
      if (xp < spent + need) {
        const current = xp - spent;
        return { level, currentXp: current, nextXp: need, totalXp: xp, progress: need ? current / need : 1, title: titleForLevel(level) };
      }
      spent += need;
      level++;
    }
    return { level, currentXp:0, nextXp:0, totalXp:xp, progress:1, title:titleForLevel(level) };
  }

  function titleForLevel(level) {
    if (level >= 50) return 'Legenda';
    if (level >= 30) return 'Velitel';
    if (level >= 20) return 'Stratég';
    if (level >= 10) return 'Znalec';
    if (level >= 5) return 'Průzkumník';
    return 'Nováček';
  }

  function achievementProgress(def, data) {
    const value = Math.max(0, Number(def.value(data)) || 0);
    return { value, target:def.target, ratio:Math.min(1, def.target ? value/def.target : 0), unlocked:value >= def.target };
  }

  function evaluateAchievements(data) {
    const now = new Date().toISOString();
    for (const def of ACHIEVEMENTS) {
      const progress = achievementProgress(def, data);
      if (progress.unlocked && !data.achievements[def.id]) data.achievements[def.id] = now;
    }
  }

  function recordQuestion(category, success) {
    const slug = normalizeCategory(category);
    return mutate(data => {
      data.stats.questionsPlayed += 1;
      if (success) {
        data.stats.questionWins += 1;
        data.stats.currentStreak += 1;
        data.stats.maxStreak = Math.max(data.stats.maxStreak, data.stats.currentStreak);
      } else {
        data.stats.currentStreak = 0;
      }
      if (slug) {
        data.categories[slug].played += 1;
        if (success) data.categories[slug].successes += 1;
      }
    });
  }

  function xpForMatch({ placement=3, score=0, questionWins=0, territories=0 } = {}) {
    const placementBonus = placement === 1 ? 80 : placement === 2 ? 45 : 25;
    const scoreBonus = Math.min(90, Math.max(0, Math.round((Number(score)||0) / 100)));
    return 40 + placementBonus + scoreBonus + Math.max(0, Number(questionWins)||0) * 5 + Math.max(0, Number(territories)||0) * 4;
  }

  function recordMatch(result = {}) {
    const placement = Math.max(1, Math.min(3, Number(result.placement) || 3));
    const score = Math.max(0, Number(result.score) || 0);
    const mode = ['random','custom','friends','bots'].includes(result.mode) ? result.mode : 'random';
    const territories = Math.max(0, Number(result.territories) || 0);
    const questionWins = Math.max(0, Number(result.questionWins) || 0);
    const xpEarned = xpForMatch({ placement, score, questionWins, territories });

    const before = levelInfo(read().xp);
    const data = mutate(d => {
      d.stats.gamesPlayed += 1;
      if (placement === 1) d.stats.wins += 1;
      if (placement === 2) d.stats.seconds += 1;
      if (placement === 3) d.stats.thirds += 1;
      d.stats.totalScore += score;
      d.stats.bestScore = Math.max(d.stats.bestScore, score);
      d.stats.territoriesCaptured += territories;
      d.modes[mode].games += 1;
      if (placement === 1) d.modes[mode].wins += 1;
      d.xp += xpEarned;
      d.matches.unshift({
        id: `${Date.now()}-${Math.random().toString(36).slice(2,7)}`,
        playedAt: new Date().toISOString(),
        mode,
        placement,
        score,
        xp: xpEarned,
        territories,
        questionWins,
        opponents: Array.isArray(result.opponents) ? result.opponents.slice(0,2).map(String) : []
      });
      d.matches = d.matches.slice(0,20);
    });
    const after = levelInfo(data.xp);
    return { data, xpEarned, beforeLevel:before.level, afterLevel:after.level, leveledUp:after.level > before.level };
  }

  function updateGuestName(name) {
    const safe = String(name || '').replace(/\s+/g,' ').trim().slice(0,24);
    if (!safe) return;
    localStorage.setItem(GUEST_NAME_KEY, safe);
    sessionStorage.setItem(GUEST_NAME_KEY, safe);
    sessionStorage.setItem('vl_name', safe);
    const data = read();
    data.displayName = safe;
    write(data);
  }

  window.VlastenecProfileStore = {
    CATEGORIES,
    ACHIEVEMENTS,
    getIdentity:getProfileIdentity,
    read,
    write,
    mutate,
    normalizeCategory,
    levelInfo,
    achievementProgress,
    recordQuestion,
    recordMatch,
    xpForMatch,
    updateGuestName
  };
})();
