// Moteur de lecture : un seul <audio> (indispensable pour que l'iPhone
// continue la lecture en arrière-plan / écran verrouillé), file d'attente,
// aléatoire, répétition, radio, minuteur et contrôles de l'écran verrouillé.

// Petit WAV silencieux pour "déverrouiller" l'audio au premier toucher (iOS).
const SILENT = (() => {
  const n = 400;
  const buf = new Uint8Array(44 + n);
  const dv = new DataView(buf.buffer);
  const w = (o, s) => [...s].forEach((c, i) => (buf[o + i] = c.charCodeAt(0)));
  w(0, 'RIFF'); dv.setUint32(4, 36 + n, true); w(8, 'WAVE'); w(12, 'fmt ');
  dv.setUint32(16, 16, true); dv.setUint16(20, 1, true); dv.setUint16(22, 1, true);
  dv.setUint32(24, 8000, true); dv.setUint32(28, 8000, true);
  dv.setUint16(32, 1, true); dv.setUint16(34, 8, true);
  w(36, 'data'); dv.setUint32(40, n, true); buf.fill(128, 44);
  return URL.createObjectURL(new Blob([buf], { type: 'audio/wav' }));
})();

export function shuffleArr(a) {
  for (let i = a.length - 1; i > 0; i--) {
    const j = Math.floor(Math.random() * (i + 1));
    [a[i], a[j]] = [a[j], a[i]];
  }
  return a;
}

export function createPlayer(audio, lib) {
  const P = new EventTarget();
  Object.assign(P, {
    mode: null, // 'track' | 'radio' | null
    queue: [],
    original: null, // ordre d'origine quand l'aléatoire est actif
    index: 0,
    shuffle: false,
    repeat: 'off', // 'off' | 'all' | 'one'
    source: '',
    station: null,
    stations: [],
    stationIndex: 0,
    rate: 1,
    sleep: null, // {mode:'time', endAt} | {mode:'track'}
  });

  let curUrl = null;
  let pre = null; // titre suivant préchargé {id, url}
  let primed = false;
  let counted = false;
  let token = 0;
  let errStreak = 0;
  let sleepTimer = 0;
  let lastSave = 0;

  const ms = 'mediaSession' in navigator ? navigator.mediaSession : null;
  const emit = (type, detail) => P.dispatchEvent(new CustomEvent(type, { detail }));
  const srcAttr = () => audio.getAttribute('src');

  Object.defineProperties(P, {
    currentId: { get: () => (P.mode === 'track' ? P.queue[P.index] ?? null : null) },
    paused: { get: () => audio.paused },
    time: { get: () => audio.currentTime },
    duration: { get: () => audio.duration },
  });

  // ---------- Débloquer l'audio dans le geste de l'utilisateur (iOS)
  P.prime = () => {
    if (primed) return;
    primed = true;
    if (!audio.paused) return;
    if (!srcAttr()) audio.src = SILENT;
    audio.muted = true;
    const p = audio.play();
    if (p && p.then) {
      p.then(() => audio.pause()).catch(() => {}).finally(() => { audio.muted = false; });
    } else audio.muted = false;
  };

  function play() {
    audio.muted = false;
    const p = audio.play();
    if (p && p.catch) p.catch((e) => { if (e.name !== 'AbortError') emit('state'); });
  }

  function applyLoop() {
    audio.loop = P.mode === 'track' && P.repeat === 'one' && P.sleep?.mode !== 'track';
  }

  // ---------- Contrôles écran verrouillé / Centre de contrôle
  const seekHandler = (d) => {
    if (d.seekTime == null) return;
    if (d.fastSeek && audio.fastSeek) audio.fastSeek(d.seekTime);
    else P.seek(d.seekTime);
    posState();
  };
  const setAction = (a, f) => { try { ms.setActionHandler(a, f); } catch {} };
  if (ms) {
    setAction('play', () => P.resume());
    setAction('pause', () => audio.pause());
    setAction('stop', () => audio.pause());
    setAction('previoustrack', () => P.prev());
    setAction('nexttrack', () => P.next());
    setAction('seekto', seekHandler);
  }

  function posState() {
    if (!ms || !ms.setPositionState) return;
    try {
      const d = audio.duration;
      if (P.mode === 'track' && isFinite(d) && d > 0) {
        ms.setPositionState({ duration: d, playbackRate: audio.playbackRate || 1, position: Math.min(audio.currentTime || 0, d) });
      }
    } catch {}
  }

  async function updateMeta() {
    if (!ms || typeof MediaMetadata === 'undefined') return;
    const my = token;
    setAction('seekto', P.mode === 'track' ? seekHandler : null);
    if (P.mode === 'track') {
      const t = lib.getTrack(P.currentId);
      if (!t) return;
      let art = lib.defaultArtwork;
      try { art = (await lib.artwork(t)) || art; } catch {}
      if (my !== token) return;
      ms.metadata = new MediaMetadata({ title: t.title, artist: t.artist || '', album: t.album || '', artwork: art });
    } else if (P.mode === 'radio' && P.station) {
      const s = P.station;
      ms.metadata = new MediaMetadata({
        title: s.name,
        artist: 'Radio en direct',
        album: s.country || '',
        artwork: s.favicon ? [{ src: s.favicon, sizes: '512x512' }] : lib.defaultArtwork,
      });
    }
  }

  // ---------- Sauvegarde / restauration de la session
  function save(force) {
    const now = Date.now();
    if (!force && now - lastSave < 4000) return;
    lastSave = now;
    lib.saveState({
      mode: P.mode, queue: P.queue, original: P.original, index: P.index,
      shuffle: P.shuffle, repeat: P.repeat, rate: P.rate, source: P.source,
      position: P.mode === 'track' ? audio.currentTime || 0 : 0,
      station: P.station, stations: P.stations.slice(0, 100),
    });
  }
  P.save = () => save(true);

  P.restore = (st) => {
    if (!st) return;
    P.shuffle = !!st.shuffle;
    P.repeat = st.repeat || 'off';
    P.rate = st.rate || 1;
    P.source = st.source || '';
    if (st.mode === 'track') {
      const valid = (id) => !!lib.getTrack(id);
      const cur = st.queue?.[st.index];
      P.queue = (st.queue || []).filter(valid);
      P.original = st.original ? st.original.filter(valid) : null;
      if (!P.queue.length) return;
      const idx = P.queue.indexOf(cur);
      P.index = idx >= 0 ? idx : 0;
      loadTrack(false, idx >= 0 ? st.position || 0 : 0);
    } else if (st.mode === 'radio' && st.station) {
      P.mode = 'radio';
      P.station = st.station;
      P.stations = st.stations?.length ? st.stations : [st.station];
      P.stationIndex = Math.max(0, P.stations.findIndex((s) => s.id === st.station.id));
      updateMeta();
      emit('track');
      emit('state');
    }
  };

  // ---------- Chargement d'un titre
  async function loadTrack(autoplay = true, startAt = 0) {
    const my = ++token;
    const id = P.queue[P.index];
    const t = lib.getTrack(id);
    if (!t) return;
    P.mode = 'track';
    P.station = null;
    counted = false;
    applyLoop();
    emit('track');
    let url;
    if (pre && pre.id === id) {
      url = pre.url;
      pre = null;
    } else {
      if (pre) { URL.revokeObjectURL(pre.url); pre = null; }
      let buf;
      try { buf = await lib.getAudio(id); } catch {}
      if (my !== token) return;
      if (!buf) { emit('message', 'Fichier audio introuvable'); return; }
      url = URL.createObjectURL(new Blob([buf], { type: t.mime || 'audio/mpeg' }));
    }
    const old = curUrl;
    curUrl = url;
    audio.defaultPlaybackRate = P.rate;
    audio.src = url;
    audio.playbackRate = P.rate;
    if (old) URL.revokeObjectURL(old);
    if (startAt > 0) {
      audio.addEventListener('loadedmetadata', () => {
        if (my === token) try { audio.currentTime = startAt; } catch {}
      }, { once: true });
    }
    updateMeta();
    if (autoplay) {
      lib.onStart?.(t);
      play();
    }
    emit('state');
    save(true);
    preloadNext();
  }

  function peekNext() {
    if (P.mode !== 'track' || !P.queue.length) return null;
    const i = P.index + 1 < P.queue.length ? P.index + 1 : P.repeat === 'all' ? 0 : -1;
    return i >= 0 ? P.queue[i] : null;
  }

  async function preloadNext() {
    const nid = peekNext();
    if (!nid || pre?.id === nid) return;
    const my = token;
    let buf;
    try { buf = await lib.getAudio(nid); } catch {}
    if (my !== token || !buf || peekNext() !== nid) return;
    if (pre) URL.revokeObjectURL(pre.url);
    pre = { id: nid, url: URL.createObjectURL(new Blob([buf], { type: lib.getTrack(nid)?.mime || 'audio/mpeg' })) };
  }

  function changed() {
    emit('queue');
    preloadNext();
    save(true);
  }

  // ---------- API publique
  P.playList = (ids, start = 0, opts = {}) => {
    if (!ids?.length) return;
    P.prime();
    if (opts.shuffle !== undefined) P.shuffle = opts.shuffle;
    P.source = opts.source || '';
    if (P.shuffle) {
      const first = start >= 0 ? ids[start] : null;
      const rest = ids.slice();
      if (first != null) rest.splice(start, 1);
      shuffleArr(rest);
      P.original = ids.slice();
      P.queue = first != null ? [first, ...rest] : rest;
      P.index = 0;
    } else {
      P.original = null;
      P.queue = ids.slice();
      P.index = Math.max(0, start);
    }
    emit('queue');
    loadTrack(true);
  };

  P.resume = () => {
    if (!P.mode) return;
    primed = true;
    if (P.mode === 'radio') {
      if (!P.station) return;
      audio.src = P.station.url; // on repart sur le direct
      play();
      return;
    }
    const s = srcAttr();
    if (!s || s === SILENT) { loadTrack(true); return; }
    if (audio.ended) audio.currentTime = 0;
    play();
  };

  P.pause = () => audio.pause();
  P.toggle = () => (audio.paused ? P.resume() : audio.pause());

  P.seek = (t) => {
    if (P.mode !== 'track' || !isFinite(t)) return;
    const d = audio.duration;
    try { audio.currentTime = Math.max(0, isFinite(d) ? Math.min(t, d - 0.05) : t); } catch {}
    posState();
  };

  P.next = (auto = false) => {
    if (P.mode === 'radio') return stepStation(1);
    if (P.mode !== 'track' || !P.queue.length) return;
    if (!auto) P.prime();
    let autoplay = true;
    if (P.index + 1 < P.queue.length) P.index++;
    else if (P.repeat === 'all') P.index = 0;
    else if (auto) { emit('state'); return; }
    else { P.index = 0; autoplay = false; }
    loadTrack(autoplay);
  };

  P.prev = () => {
    if (P.mode === 'radio') return stepStation(-1);
    if (P.mode !== 'track') return;
    P.prime();
    if (audio.currentTime > 3 || (P.index === 0 && P.repeat !== 'all')) {
      P.seek(0);
      if (audio.paused) play();
      return;
    }
    P.index = P.index > 0 ? P.index - 1 : P.queue.length - 1;
    loadTrack(true);
  };

  P.jumpTo = (i) => {
    if (i < 0 || i >= P.queue.length) return;
    P.prime();
    P.index = i;
    loadTrack(true);
  };

  P.setShuffle = (on) => {
    on = !!on;
    if (on === P.shuffle) return;
    P.shuffle = on;
    if (P.mode === 'track' && P.queue.length) {
      const cur = P.queue[P.index];
      if (on) {
        P.original = P.queue.slice();
        const rest = P.queue.filter((_, i) => i !== P.index);
        shuffleArr(rest);
        P.queue = [cur, ...rest];
        P.index = 0;
      } else if (P.original) {
        const idx = P.original.indexOf(cur);
        P.queue = P.original;
        P.index = Math.max(0, idx);
        P.original = null;
      }
    }
    emit('state');
    changed();
  };

  P.cycleRepeat = () => {
    P.repeat = P.repeat === 'off' ? 'all' : P.repeat === 'all' ? 'one' : 'off';
    applyLoop();
    emit('state');
    changed();
  };

  const asIds = (x) => (Array.isArray(x) ? x : [x]);

  P.playNext = (ids) => {
    ids = asIds(ids);
    if (P.mode !== 'track' || !P.queue.length) return P.playList(ids, 0);
    P.queue.splice(P.index + 1, 0, ...ids);
    if (P.original) {
      const oi = P.original.indexOf(P.queue[P.index]);
      P.original.splice(oi + 1, 0, ...ids);
    }
    changed();
  };

  P.addToQueue = (ids) => {
    ids = asIds(ids);
    if (P.mode !== 'track' || !P.queue.length) return P.playList(ids, 0);
    P.queue.push(...ids);
    P.original?.push(...ids);
    changed();
  };

  P.removeAt = (i) => {
    if (i === P.index || i < 0 || i >= P.queue.length) return;
    const [id] = P.queue.splice(i, 1);
    if (i < P.index) P.index--;
    if (P.original) {
      const oi = P.original.indexOf(id);
      if (oi >= 0) P.original.splice(oi, 1);
    }
    changed();
  };

  P.move = (i, j) => {
    if (i === j || j < 0 || j >= P.queue.length) return;
    const [id] = P.queue.splice(i, 1);
    P.queue.splice(j, 0, id);
    if (P.index === i) P.index = j;
    else if (i < P.index && j >= P.index) P.index--;
    else if (i > P.index && j <= P.index) P.index++;
    changed();
  };

  // Titres supprimés de l'appareil
  P.purge = (ids) => {
    const set = new Set(ids);
    if (pre && set.has(pre.id)) { URL.revokeObjectURL(pre.url); pre = null; }
    if (!P.queue.some((id) => set.has(id))) return;
    const curGone = set.has(P.currentId);
    const before = P.queue.slice(0, P.index).filter((id) => set.has(id)).length;
    P.queue = P.queue.filter((id) => !set.has(id));
    if (P.original) P.original = P.original.filter((id) => !set.has(id));
    P.index = Math.max(0, P.index - before);
    if (curGone && P.mode === 'track') {
      token++;
      audio.pause();
      audio.removeAttribute('src');
      audio.load();
      if (curUrl) { URL.revokeObjectURL(curUrl); curUrl = null; }
      if (P.queue.length) {
        if (P.index >= P.queue.length) P.index = 0;
        loadTrack(false);
      } else {
        P.mode = null;
        emit('track');
        emit('state');
      }
    }
    changed();
  };

  P.reset = () => {
    token++;
    audio.pause();
    audio.removeAttribute('src');
    audio.load();
    if (curUrl) { URL.revokeObjectURL(curUrl); curUrl = null; }
    if (pre) { URL.revokeObjectURL(pre.url); pre = null; }
    Object.assign(P, { mode: null, queue: [], original: null, index: 0, station: null, stations: [] });
    emit('track');
    emit('state');
    save(true);
  };

  // ---------- Radio
  P.playStation = (st, list) => {
    P.prime();
    token++;
    if (pre) { URL.revokeObjectURL(pre.url); pre = null; }
    const old = curUrl;
    curUrl = null;
    P.mode = 'radio';
    P.station = st;
    P.stations = list?.length ? list.slice(0, 200) : [st];
    P.stationIndex = Math.max(0, P.stations.findIndex((s) => s.id === st.id));
    applyLoop();
    audio.defaultPlaybackRate = 1;
    audio.src = st.url;
    audio.playbackRate = 1;
    if (old) URL.revokeObjectURL(old);
    play();
    lib.onStation?.(st);
    updateMeta();
    emit('track');
    emit('state');
    save(true);
  };

  function stepStation(d) {
    if (!P.stations.length) return;
    P.stationIndex = (P.stationIndex + d + P.stations.length) % P.stations.length;
    P.playStation(P.stations[P.stationIndex], P.stations);
  }

  // ---------- Vitesse & minuteur
  P.setRate = (r) => {
    P.rate = r;
    if (P.mode === 'track') {
      audio.defaultPlaybackRate = r;
      audio.playbackRate = r;
    }
    emit('state');
    save(true);
  };

  function fireSleep() {
    clearTimeout(sleepTimer);
    P.sleep = null;
    applyLoop();
    audio.pause();
    emit('sleep');
    emit('message', 'Minuteur terminé : lecture en pause');
  }

  P.setSleep = (v) => {
    clearTimeout(sleepTimer);
    if (v == null) P.sleep = null;
    else if (v === 'track') P.sleep = { mode: 'track' };
    else {
      P.sleep = { mode: 'time', endAt: Date.now() + v * 60000 };
      sleepTimer = setTimeout(fireSleep, v * 60000 + 50);
    }
    applyLoop();
    emit('sleep');
  };

  // ---------- Évènements du lecteur audio
  audio.addEventListener('play', () => { if (ms) ms.playbackState = 'playing'; emit('state'); });
  audio.addEventListener('pause', () => { if (ms) ms.playbackState = 'paused'; emit('state'); save(true); });
  audio.addEventListener('playing', () => { errStreak = 0; posState(); emit('buffer', false); });
  audio.addEventListener('waiting', () => emit('buffer', true));
  audio.addEventListener('ratechange', posState);
  audio.addEventListener('seeked', posState);
  audio.addEventListener('loadedmetadata', () => {
    posState();
    if (P.mode === 'track') {
      const t = lib.getTrack(P.currentId);
      const d = audio.duration;
      if (t && isFinite(d) && d > 0 && Math.abs((t.duration || 0) - d) > 1) lib.setDuration?.(t, d);
    }
    emit('time');
  });
  audio.addEventListener('timeupdate', () => {
    emit('time');
    if (P.mode === 'track' && !counted) {
      const d = audio.duration;
      const need = Math.min(30, (isFinite(d) && d > 0 ? d : 60) * 0.5);
      if (audio.currentTime >= need) {
        counted = true;
        const t = lib.getTrack(P.currentId);
        if (t) lib.onCounted?.(t);
      }
    }
    if (P.sleep?.mode === 'time' && Date.now() >= P.sleep.endAt) fireSleep();
    save();
  });
  audio.addEventListener('ended', () => {
    if (P.mode !== 'track') return;
    if (P.sleep?.mode === 'track') {
      P.sleep = null;
      applyLoop();
      emit('sleep');
      emit('message', 'Minuteur terminé : lecture en pause');
      if (P.index + 1 < P.queue.length) { P.index++; loadTrack(false); }
      return;
    }
    P.next(true);
  });
  audio.addEventListener('error', () => {
    const s = srcAttr();
    if (!s || s === SILENT) return;
    if (P.mode === 'radio') {
      emit('message', 'Cette radio ne répond pas. Essaie-en une autre.');
      emit('state');
      return;
    }
    if (P.mode === 'track') {
      errStreak++;
      emit('message', 'Lecture impossible : ' + (lib.getTrack(P.currentId)?.title || 'fichier'));
      if (errStreak < Math.min(P.queue.length, 5)) setTimeout(() => P.next(true), 400);
    }
  });

  return P;
}
