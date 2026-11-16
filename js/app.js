import * as db from './db.js';
import { readTags, mp3Duration } from './id3.js';
import { createPlayer, shuffleArr } from './player.js';
import * as radio from './radio.js';
import { isZip, listZip, readZipEntry } from './zip.js';

const VERSION = '1.3.0';

// ============================================================ Utilitaires
const $ = (s, r = document) => r.querySelector(s);
const $$ = (s, r = document) => [...r.querySelectorAll(s)];
const ESC = { '&': '&amp;', '<': '&lt;', '>': '&gt;', '"': '&quot;', "'": '&#39;' };
const esc = (s) => String(s ?? '').replace(/[&<>"']/g, (c) => ESC[c]);
const icon = (n, cls = '') => `<svg class="i ${cls}" aria-hidden="true"><use href="#i-${n}"/></svg>`;
const EQ = '<span class="eq"><i></i><i></i><i></i></span>';
const uid = () => (crypto.randomUUID ? crypto.randomUUID() : Date.now().toString(36) + Math.random().toString(36).slice(2));
const norm = (s) => (s || '').trim().toLowerCase();
const fold = (s) => (s || '').normalize('NFD').replace(/[̀-ͯ]/g, '').toLowerCase();
function hash(s) {
  let h = 5381;
  for (let i = 0; i < s.length; i++) h = ((h << 5) + h + s.charCodeAt(i)) | 0;
  return (h >>> 0).toString(36);
}
const hue = (s) => parseInt(hash(s || 'x'), 36) % 360;
function fmt(sec) {
  if (!isFinite(sec) || sec < 0) sec = 0;
  sec = Math.floor(sec);
  const h = Math.floor(sec / 3600), m = Math.floor((sec % 3600) / 60), s = sec % 60;
  return h ? `${h}:${String(m).padStart(2, '0')}:${String(s).padStart(2, '0')}` : `${m}:${String(s).padStart(2, '0')}`;
}
function fmtLong(sec) {
  if (sec > 0 && sec < 60) return `${Math.round(sec)} s`;
  const m = Math.round(sec / 60);
  return m < 60 ? `${m} min` : `${Math.floor(m / 60)} h ${String(m % 60).padStart(2, '0')}`;
}
const plural = (n, w, p) => `${n} ${n > 1 ? p || w + 's' : w}`;
const fmtBytes = (b) => (b > 1e9 ? (b / 1e9).toFixed(1) + ' Go' : Math.round(b / 1e6) + ' Mo');
function mulberry(seed) {
  return () => {
    seed |= 0; seed = (seed + 0x6d2b79f5) | 0;
    let t = Math.imul(seed ^ (seed >>> 15), 1 | seed);
    t = (t + Math.imul(t ^ (t >>> 7), 61 | t)) ^ t;
    return ((t ^ (t >>> 14)) >>> 0) / 4294967296;
  };
}
const isIOS = /iphone|ipad|ipod/i.test(navigator.userAgent) || (navigator.platform === 'MacIntel' && navigator.maxTouchPoints > 1);
const isStandalone = () => navigator.standalone || matchMedia('(display-mode: standalone)').matches;

// ============================================================ État
const S = {
  tracks: new Map(),
  covers: new Map(), // clé -> objectURL
  coverData: new Map(), // clé -> dataURL (écran verrouillé)
  playlists: [],
  radioFavs: [],
  radioRecent: [],
  ver: 0,
  ui: { libTab: 'songs', sort: 'added', q: '', radioTab: 'top', radioCountry: 'FR', radioGenre: 'pop', radioLocal: true, radioQ: '', hideInstall: false },
};
const radioCache = new Map();
const bump = () => S.ver++;
let uiSaveT = 0;
const saveUI = () => { clearTimeout(uiSaveT); uiSaveT = setTimeout(() => db.put('kv', S.ui, 'ui').catch(() => {}), 400); };

const audio = $('#audio');
const DEFAULT_ART = [{ src: new URL('icons/icon-512.png', location.href).href, sizes: '512x512', type: 'image/png' }];

const player = createPlayer(audio, {
  getTrack: (id) => S.tracks.get(id),
  getAudio: (id) => db.get('audio', id),
  defaultArtwork: DEFAULT_ART,
  artwork: artworkFor,
  onStart(t) { t.lastPlayed = Date.now(); db.put('tracks', t).catch(() => {}); },
  onCounted(t) { t.plays = (t.plays || 0) + 1; db.put('tracks', t).catch(() => {}); },
  setDuration(t, d) { t.duration = d; db.put('tracks', t).catch(() => {}); },
  onStation(st) {
    S.radioRecent = [st, ...S.radioRecent.filter((s) => s.id !== st.id)].slice(0, 20);
    db.put('kv', S.radioRecent, 'radioRecent').catch(() => {});
    radio.click(st.id);
  },
  saveState: (st) => db.put('kv', st, 'player').catch(() => {}),
});

// ============================================================ Données dérivées
const albumKeyOf = (t) => (t.album ? norm(t.album) + '::' + norm(t.albumArtist || t.artist) : '');
const artistKeyOf = (t) => norm(t.artist) || '?';

let memo = { ver: -1 };
function lib() {
  if (memo.ver === S.ver) return memo;
  const tracks = [...S.tracks.values()];
  const albums = new Map();
  const artists = new Map();
  for (const t of tracks) {
    const ak = albumKeyOf(t);
    if (ak) {
      let a = albums.get(ak);
      if (!a) {
        a = { id: hash(ak), key: ak, name: t.album, artist: t.albumArtist || t.artist || 'Artiste inconnu', year: t.year, tracks: [], addedAt: 0 };
        albums.set(ak, a);
      }
      a.tracks.push(t);
      a.addedAt = Math.max(a.addedAt, t.addedAt || 0);
      if (!a.year && t.year) a.year = t.year;
    }
    const rk = artistKeyOf(t);
    let r = artists.get(rk);
    if (!r) {
      r = { id: hash(rk), key: rk, name: t.artist || 'Artiste inconnu', tracks: [] };
      artists.set(rk, r);
    }
    r.tracks.push(t);
  }
  const byTrack = (a, b) => (a.trackNo || 999) - (b.trackNo || 999) || a.title.localeCompare(b.title);
  for (const a of albums.values()) a.tracks.sort(byTrack);
  const albumList = [...albums.values()].sort((a, b) => a.name.localeCompare(b.name));
  const artistList = [...artists.values()].sort((a, b) => a.name.localeCompare(b.name));
  memo = {
    ver: S.ver, tracks, albums: albumList, artists: artistList,
    albumById: new Map(albumList.map((a) => [a.id, a])),
    albumByKey: albums,
    artistById: new Map(artistList.map((a) => [a.id, a])),
  };
  return memo;
}

function coverURL(t) {
  if (!t) return null;
  return S.covers.get(t.coverKey) || (t.album ? S.covers.get('a:' + albumKeyOf(t)) : null) || null;
}
function coverKeyFor(t) {
  if (t.coverKey && S.covers.has(t.coverKey)) return t.coverKey;
  const k = 'a:' + albumKeyOf(t);
  return t.album && S.covers.has(k) ? k : null;
}

async function artworkFor(t) {
  const k = coverKeyFor(t);
  if (!k) return DEFAULT_ART;
  if (!S.coverData.has(k)) {
    const buf = await db.get('covers', k);
    if (!buf) return DEFAULT_ART;
    const url = await new Promise((res) => {
      const fr = new FileReader();
      fr.onload = () => res(fr.result);
      fr.onerror = () => res(null);
      fr.readAsDataURL(new Blob([buf], { type: 'image/jpeg' }));
    });
    if (!url) return DEFAULT_ART;
    S.coverData.set(k, url);
  }
  return [{ src: S.coverData.get(k), sizes: '512x512', type: 'image/jpeg' }];
}

// ============================================================ Petits composants
function coverEl(t, size = 'sm', extra = '') {
  const url = coverURL(t);
  if (url) return `<img class="cv ${size} ${extra}" src="${url}" alt="" loading="lazy" decoding="async">`;
  return `<div class="cv ${size} ph ${extra}" style="--h:${hue(t?.album || t?.title)}">${icon('note')}</div>`;
}
function phEl(size, name, ic = 'note', extra = '') {
  return `<div class="cv ${size} ph ${extra}" style="--h:${hue(name)}">${icon(ic)}</div>`;
}
function stationLogo(st, size = 'sm') {
  if (st.favicon) return `<img class="cv ${size} logo" src="${esc(st.favicon)}" alt="" loading="lazy" referrerpolicy="no-referrer" data-ph="${hue(st.name)}" data-ic="radio">`;
  return phEl(size, st.name, 'radio');
}
function mosaicEl(ids, size, name, ic = 'queue') {
  const urls = [];
  for (const id of ids) {
    const u = coverURL(S.tracks.get(id));
    if (u && !urls.includes(u)) urls.push(u);
    if (urls.length === 4) break;
  }
  if (urls.length === 4) return `<div class="cv ${size} mosaic">${urls.map((u) => `<img src="${u}" alt="">`).join('')}</div>`;
  if (urls.length) return `<img class="cv ${size}" src="${urls[0]}" alt="">`;
  return phEl(size, name, ic);
}
function autoCover(size, ic) {
  return `<div class="cv ${size} auto">${icon(ic)}</div>`;
}

// Registre des listes affichées (pour savoir quoi jouer quand on touche un titre)
let LISTS = [];
let STLISTS = [];
const reg = (ids, src = '') => (LISTS.push({ ids, src }), LISTS.length - 1);
const regSt = (list) => (STLISTS.push(list), STLISTS.length - 1);

function trackRow(t, ctx, i, o = {}) {
  const sub = [t.artist || 'Artiste inconnu', o.showAlbum !== false && t.album ? t.album : null, t.duration ? fmt(t.duration) : null]
    .filter(Boolean).join(' • ');
  const lead = o.num != null
    ? `<div class="num"><span>${o.num}</span>${EQ}</div>`
    : coverEl(t, 'sm');
  return `<div class="row" data-action="play" data-ctx="${ctx}" data-i="${i}" data-tid="${t.id}">
    ${lead}
    <div class="meta"><div class="t1">${o.num == null ? EQ : ''}${esc(t.title)}</div><div class="t2">${t.liked ? icon('heart-fill', 'tiny') : ''}${esc(sub)}</div></div>
    <button class="ib" data-action="track-menu" data-id="${t.id}"${o.pl ? ` data-pl="${o.pl}" data-pi="${i}"` : ''} aria-label="Options">${icon('more')}</button>
  </div>`;
}
function trackCard(t, ctx, i) {
  return `<div class="card" data-action="play" data-ctx="${ctx}" data-i="${i}" data-tid="${t.id}">${coverEl(t, 'lg')}<div class="t1">${esc(t.title)}</div><div class="t2">${esc(t.artist || '')}</div></div>`;
}
function albumCard(a) {
  return `<div class="card" data-action="nav" data-to="#/album/${a.id}">${coverEl(a.tracks[0], 'lg')}<div class="t1">${esc(a.name)}</div><div class="t2">${esc(a.artist)}${a.year ? ' • ' + esc(a.year) : ''}</div></div>`;
}
function stationRow(st, ctx, i) {
  const fav = isFav(st.id);
  const sub = [st.tags, st.country, st.bitrate ? st.bitrate + ' kbps' : ''].filter(Boolean).join(' • ') || 'Radio';
  return `<div class="row" data-action="play-station" data-sctx="${ctx}" data-i="${i}" data-sid="${esc(st.id)}">
    ${stationLogo(st, 'sm')}
    <div class="meta"><div class="t1">${EQ}${esc(st.name)}</div><div class="t2">${esc(sub)}</div></div>
    <button class="ib ${fav ? 'on' : ''}" data-action="fav-station" data-sctx="${ctx}" data-i="${i}" aria-label="Favori">${icon(fav ? 'heart-fill' : 'heart')}</button>
  </div>`;
}
function stationCard(st, ctx, i) {
  return `<div class="card" data-action="play-station" data-sctx="${ctx}" data-i="${i}" data-sid="${esc(st.id)}">${stationLogo(st, 'lg')}<div class="t1">${esc(st.name)}</div><div class="t2">${esc(st.tags || st.country || 'Radio')}</div></div>`;
}
function topbar(title, { back = false, right = '', jp = '' } = {}) {
  return `<header class="topbar ${back ? 'has-back' : ''}">${back ? `<button class="ib" data-action="back" aria-label="Retour">${icon('back')}</button>` : ''}<h1>${esc(title)}${jp ? `<small class="jp">${esc(jp)}</small>` : ''}</h1>${right || (back ? '<span class="spacer"></span>' : '')}</header>`;
}
const section = (title, body, link = '') => `<section class="section"><h2>${esc(title)}${link}</h2>${body}</section>`;
const loadingEl = () => '<div class="loading"><div class="spin"></div></div>';

function installBanner() {
  if (!isIOS || isStandalone() || S.ui.hideInstall) return '';
  return `<div class="banner"><div>Pour la lecture en arrière-plan, installe l’appli : touche ${icon('share', 'share')} <b>Partager</b> puis <b>Sur l’écran d’accueil</b>.</div><button class="ib" data-action="hide-install" aria-label="Masquer">${icon('close')}</button></div>`;
}

// ============================================================ Vues
const SPECIAL = {
  liked: { name: 'Titres likés', icon: 'heart-fill' },
  top: { name: 'Les plus écoutés', icon: 'chart' },
  recent: { name: 'Ajoutés récemment', icon: 'history' },
};
function specialIds(id) {
  const L = lib();
  if (id === 'liked') return L.tracks.filter((t) => t.liked).sort((a, b) => (b.likedAt || 0) - (a.likedAt || 0)).map((t) => t.id);
  if (id === 'top') return L.tracks.filter((t) => t.plays > 0).sort((a, b) => b.plays - a.plays || b.lastPlayed - a.lastPlayed).slice(0, 50).map((t) => t.id);
  if (id === 'recent') return L.tracks.slice().sort((a, b) => b.addedAt - a.addedAt).slice(0, 50).map((t) => t.id);
  return [];
}

function dailyMix(tracks) {
  const d = new Date();
  const rnd = mulberry(d.getFullYear() * 10000 + (d.getMonth() + 1) * 100 + d.getDate());
  const a = tracks.slice().sort((x, y) => (x.id < y.id ? -1 : 1));
  for (let i = a.length - 1; i > 0; i--) {
    const j = Math.floor(rnd() * (i + 1));
    [a[i], a[j]] = [a[j], a[i]];
  }
  // un petit bonus pour les titres likés
  return [...a.filter((t) => t.liked).slice(0, 8), ...a.filter((t) => !t.liked)].slice(0, 25);
}

function vHome() {
  const L = lib();
  const h = new Date().getHours();
  const hello = h < 5 ? 'Bonne nuit' : h < 18 ? 'Bonjour' : 'Bonsoir';
  const jp = h >= 5 && h < 11 ? 'おはよう' : h < 18 && h >= 5 ? 'こんにちは' : 'こんばんは';
  const right = `<button class="ib" data-action="nav" data-to="#/settings" aria-label="Réglages">${icon('tune')}</button>`;
  const sys = L.tracks.length
    ? `« Rapport » Analyse terminée : ${plural(L.tracks.length, 'titre')}, ${plural(L.albums.length, 'album')}.`
    : '« Avis » Aucune musique détectée. En attente d’import.';
  let html = topbar(hello, { right, jp }) + `<div class="sys-line" data-type="${esc(sys)}"></div>` + installBanner();

  if (!L.tracks.length) {
    html += `<div class="empty"><div class="big">${icon('note')}</div><h2>Ta musique, partout</h2>
      <p>Importe tes MP3 depuis l’app Fichiers (iCloud Drive, Téléchargements…) ou écoute la radio en direct.</p>
      <p class="tip">Astuce : pour tout importer d’un coup, dans Fichiers garde le doigt sur ton dossier de musique → <b>Compresser</b>, puis importe le <b>.zip</b>.</p>
      <div class="stack"><button class="btn primary" data-action="import">${icon('upload')}Importer des MP3</button>
      <button class="btn" data-action="nav" data-to="#/radio">${icon('radio')}Écouter la radio</button></div></div>`;
    return html + homeRadio();
  }

  const mix = dailyMix(L.tracks);
  html += `<div class="mix" data-action="play-list" data-ctx="${reg(mix.map((t) => t.id), 'Mix du jour')}">
    <div class="meta"><h3>Mix du jour</h3><p>${plural(mix.length, 'titre')} choisis pour aujourd’hui</p></div>
    <div class="play">${icon('play')}</div></div>`;
  html += `<div class="chips" style="margin-top:12px">
    <button class="chip" data-action="shuffle-all">${icon('shuffle')}Tout en aléatoire</button>
    <button class="chip" data-action="nav" data-to="#/playlist/liked">${icon('heart-fill')}Titres likés</button>
    <button class="chip" data-action="rediscover">${icon('sparkle')}Redécouvrir</button>
    <button class="chip" data-action="nav" data-to="#/radio">${icon('radio')}Radio</button></div>`;

  const recent = L.tracks.filter((t) => t.lastPlayed).sort((a, b) => b.lastPlayed - a.lastPlayed).slice(0, 15);
  if (recent.length) {
    const c = reg(recent.map((t) => t.id), 'Écoutés récemment');
    html += section('Écoutés récemment', `<div class="carousel">${recent.map((t, i) => trackCard(t, c, i)).join('')}</div>`);
  }
  const top = L.tracks.filter((t) => t.plays > 0).sort((a, b) => b.plays - a.plays).slice(0, 6);
  if (top.length >= 3) {
    const c = reg(top.map((t) => t.id), 'Tes préférés');
    html += section('Tes préférés', top.map((t, i) => trackRow(t, c, i)).join(''), `<a href="#/playlist/top">Tout voir</a>`);
  }
  const added = L.tracks.slice().sort((a, b) => b.addedAt - a.addedAt).slice(0, 15);
  {
    const c = reg(added.map((t) => t.id), 'Ajoutés récemment');
    html += section('Ajoutés récemment', `<div class="carousel">${added.map((t, i) => trackCard(t, c, i)).join('')}</div>`, `<a href="#/playlist/recent">Tout voir</a>`);
  }
  const albums = L.albums.slice().sort((a, b) => b.addedAt - a.addedAt).slice(0, 12);
  if (albums.length) html += section('Albums', `<div class="carousel">${albums.map(albumCard).join('')}</div>`);
  return html + homeRadio();
}

function homeRadio() {
  const list = S.radioFavs.length ? S.radioFavs : S.radioRecent;
  if (!list.length) return '';
  const c = regSt(list);
  return section(S.radioFavs.length ? 'Tes radios' : 'Radios écoutées', `<div class="carousel">${list.map((s, i) => stationCard(s, c, i)).join('')}</div>`);
}

function vSearch() {
  const html = `<header class="topbar"><label class="searchbox">${icon('search')}<input id="q" type="search" placeholder="Titres, artistes, albums…" autocomplete="off" autocorrect="off" spellcheck="false" enterkeyhint="search" value="${esc(S.ui.q)}"></label></header><div id="results">${searchResults(S.ui.q)}</div>`;
  return {
    html,
    after() {
      const q = $('#q');
      q.addEventListener('input', () => {
        S.ui.q = q.value;
        $('#results').innerHTML = searchResults(q.value);
        markPlaying();
      });
      q.addEventListener('keydown', (e) => { if (e.key === 'Enter') q.blur(); });
    },
  };
}

function searchResults(q) {
  const L = lib();
  const words = fold(q).split(/\s+/).filter(Boolean);
  if (!words.length) {
    if (!L.tracks.length) return `<div class="note">Ta bibliothèque est vide. Importe des MP3 depuis l’onglet Bibliothèque.</div>`;
    let html = `<div class="section"><h2>Parcourir</h2><div class="chips" style="flex-wrap:wrap">`;
    html += `<button class="chip" data-action="nav" data-to="#/playlist/liked">${icon('heart-fill')}Titres likés</button>`;
    html += `<button class="chip" data-action="nav" data-to="#/playlist/top">${icon('chart')}Les plus écoutés</button>`;
    html += `<button class="chip" data-action="nav" data-to="#/playlist/recent">${icon('history')}Ajoutés récemment</button>`;
    html += `<button class="chip" data-action="lib-go" data-tab="albums">${icon('album')}Albums</button>`;
    html += `<button class="chip" data-action="lib-go" data-tab="artists">${icon('person')}Artistes</button>`;
    return html + '</div></div>';
  }
  const match = (s) => { const f = fold(s); return words.every((w) => f.includes(w)); };
  const tracks = L.tracks.filter((t) => match(`${t.title} ${t.artist} ${t.album}`)).slice(0, 40);
  const albums = L.albums.filter((a) => match(`${a.name} ${a.artist}`)).slice(0, 12);
  const artists = L.artists.filter((a) => match(a.name)).slice(0, 10);
  const pls = S.playlists.filter((p) => match(p.name));
  let html = '';
  if (artists.length) html += section('Artistes', artists.map(artistRow).join(''));
  if (tracks.length) {
    const c = reg(tracks.map((t) => t.id), 'Recherche');
    html += section('Titres', tracks.map((t, i) => trackRow(t, c, i)).join(''));
  }
  if (albums.length) html += section('Albums', `<div class="carousel">${albums.map(albumCard).join('')}</div>`);
  if (pls.length) html += section('Playlists', pls.map(playlistRow).join(''));
  if (!html) html = `<div class="note">Aucun résultat dans ta bibliothèque pour « ${esc(q)} ».</div>`;
  html += `<div class="actions" style="justify-content:center;padding:24px 16px"><button class="btn" data-action="radio-search-from" data-q="${esc(q)}">${icon('radio')}Chercher « ${esc(q)} » dans les radios</button></div>`;
  return html;
}

function artistRow(a) {
  return `<div class="row" data-action="nav" data-to="#/artist/${a.id}">${coverEl(a.tracks[0], 'sm', 'round')}<div class="meta"><div class="t1">${esc(a.name)}</div><div class="t2">Artiste • ${plural(a.tracks.length, 'titre')}</div></div></div>`;
}
function playlistRow(p) {
  return `<div class="row" data-action="nav" data-to="#/playlist/${p.id}">${mosaicEl(p.trackIds, 'sm', p.name)}<div class="meta"><div class="t1">${esc(p.name)}</div><div class="t2">Playlist • ${plural(p.trackIds.length, 'titre')}</div></div></div>`;
}

const SORTS = {
  added: ['Ajout récent', (a, b) => b.addedAt - a.addedAt],
  title: ['Titre (A-Z)', (a, b) => a.title.localeCompare(b.title)],
  artist: ['Artiste (A-Z)', (a, b) => (a.artist || '~').localeCompare(b.artist || '~') || a.title.localeCompare(b.title)],
  plays: ['Plus écoutés', (a, b) => (b.plays || 0) - (a.plays || 0) || a.title.localeCompare(b.title)],
};

function vLibrary() {
  const L = lib();
  const tab = S.ui.libTab;
  const right = `<button class="ib" data-action="import" aria-label="Importer des MP3">${icon('upload')}</button>`;
  let html = topbar('Bibliothèque', { right, jp: 'ライブラリ' });
  html += `<div class="chips">${[['songs', 'Titres'], ['albums', 'Albums'], ['artists', 'Artistes'], ['playlists', 'Playlists']]
    .map(([k, l]) => `<button class="chip ${tab === k ? 'on' : ''}" data-action="lib-tab" data-tab="${k}">${l}</button>`).join('')}</div>`;

  if (tab === 'playlists') {
    html += `<div class="row" data-action="new-playlist">${autoCover('sm', 'plus')}<div class="meta"><div class="t1">Nouvelle playlist</div></div></div>`;
    for (const [id, s] of Object.entries(SPECIAL)) {
      const n = specialIds(id).length;
      html += `<div class="row" data-action="nav" data-to="#/playlist/${id}">${autoCover('sm', s.icon)}<div class="meta"><div class="t1">${s.name}</div><div class="t2">Playlist auto • ${plural(n, 'titre')}</div></div></div>`;
    }
    html += S.playlists.slice().sort((a, b) => b.updatedAt - a.updatedAt).map(playlistRow).join('');
    return html;
  }
  if (!L.tracks.length) {
    return html + `<div class="empty"><div class="big">${icon('upload')}</div><h2>Aucun titre</h2>
      <p>Touche le bouton ci-dessous et choisis tes MP3 dans l’app Fichiers. Tu peux en sélectionner plusieurs d’un coup.</p>
      <p class="tip">Plus rapide : dans Fichiers, garde le doigt sur ton dossier de musique → <b>Compresser</b>, puis importe le <b>.zip</b> : tout le dossier est ajouté d’un coup.</p>
      <button class="btn primary" data-action="import">${icon('upload')}Importer des MP3</button></div>`;
  }
  if (tab === 'albums') {
    if (!L.albums.length) return html + `<div class="note">Aucun album détecté (les MP3 n’ont pas de tag « album »).</div>`;
    return html + `<div class="grid">${L.albums.map(albumCard).join('')}</div>`;
  }
  if (tab === 'artists') return html + L.artists.map(artistRow).join('');

  const sort = SORTS[S.ui.sort] ? S.ui.sort : 'added';
  const list = L.tracks.slice().sort(SORTS[sort][1]);
  const c = reg(list.map((t) => t.id), 'Bibliothèque');
  html += `<div class="actions">
    <button class="btn primary" data-action="play-list" data-ctx="${c}">${icon('play')}Lire</button>
    <button class="btn" data-action="shuffle-list" data-ctx="${c}">${icon('shuffle')}Aléatoire</button>
    <span class="grow"></span>
    <select class="sort" data-change="sort" aria-label="Trier">${Object.entries(SORTS).map(([k, [l]]) => `<option value="${k}" ${k === sort ? 'selected' : ''}>${l}</option>`).join('')}</select>
  </div>`;
  html += `<div class="note" style="text-align:left;padding:2px 16px 6px">${plural(list.length, 'titre')} • ${fmtLong(list.reduce((s, t) => s + (t.duration || 0), 0))}</div>`;
  return html + list.map((t, i) => trackRow(t, c, i)).join('');
}

function vAlbum(id) {
  const a = lib().albumById.get(id);
  if (!a) return topbar('Album', { back: true }) + `<div class="note">Album introuvable.</div>`;
  const c = reg(a.tracks.map((t) => t.id), a.name);
  const dur = a.tracks.reduce((s, t) => s + (t.duration || 0), 0);
  const artist = lib().artistById.get(hash(artistKeyOf(a.tracks[0])));
  return topbar('', { back: true, right: `<button class="ib" data-action="album-menu" data-id="${a.id}" aria-label="Options">${icon('more')}</button>` }) +
    `<div class="hero">${coverEl(a.tracks[0], 'xl')}<h1>${esc(a.name)}</h1>
      <div class="sub">${artist ? `<button data-action="nav" data-to="#/artist/${artist.id}">${esc(a.artist)}</button>` : esc(a.artist)}</div>
      <div class="sub">Album${a.year ? ' • ' + esc(a.year) : ''} • ${plural(a.tracks.length, 'titre')} • ${fmtLong(dur)}</div></div>
    <div class="hero-actions"><button class="btn primary" data-action="play-list" data-ctx="${c}">${icon('play')}Lire</button>
      <button class="btn" data-action="shuffle-list" data-ctx="${c}">${icon('shuffle')}Aléatoire</button></div>` +
    a.tracks.map((t, i) => trackRow(t, c, i, { num: t.trackNo || i + 1, showAlbum: false })).join('');
}

function vArtist(id) {
  const L = lib();
  const r = L.artistById.get(id);
  if (!r) return topbar('Artiste', { back: true }) + `<div class="note">Artiste introuvable.</div>`;
  const tracks = r.tracks.slice().sort((a, b) => (b.plays || 0) - (a.plays || 0) || a.title.localeCompare(b.title));
  const albums = L.albums.filter((a) => a.tracks.some((t) => artistKeyOf(t) === r.key) || norm(a.artist) === r.key);
  const c = reg(tracks.map((t) => t.id), r.name);
  let html = topbar('', { back: true }) +
    `<div class="hero">${coverEl(tracks[0], 'xl', 'round')}<h1>${esc(r.name)}</h1>
      <div class="sub">${plural(tracks.length, 'titre')}${albums.length ? ' • ' + plural(albums.length, 'album') : ''}</div></div>
    <div class="hero-actions"><button class="btn primary" data-action="play-list" data-ctx="${c}">${icon('play')}Lire</button>
      <button class="btn" data-action="shuffle-list" data-ctx="${c}">${icon('shuffle')}Aléatoire</button></div>`;
  if (albums.length) html += section('Albums', `<div class="carousel">${albums.map(albumCard).join('')}</div>`);
  html += section('Titres', tracks.map((t, i) => trackRow(t, c, i)).join(''));
  return html;
}

function vPlaylist(id) {
  const sp = SPECIAL[id];
  const p = sp ? null : S.playlists.find((x) => x.id === id);
  if (!sp && !p) return topbar('Playlist', { back: true }) + `<div class="note">Playlist introuvable.</div>`;
  const name = sp ? sp.name : p.name;
  const ids = (sp ? specialIds(id) : p.trackIds).filter((x) => S.tracks.has(x));
  const tracks = ids.map((x) => S.tracks.get(x));
  const c = reg(ids, name);
  const dur = tracks.reduce((s, t) => s + (t.duration || 0), 0);
  const menu = sp ? '' : `<button class="ib" data-action="pl-menu" data-id="${p.id}" aria-label="Options">${icon('more')}</button>`;
  let html = topbar('', { back: true, right: menu }) +
    `<div class="hero">${sp ? autoCover('xl', sp.icon) : mosaicEl(ids, 'xl', name)}<h1>${esc(name)}</h1>
      <div class="sub">${sp ? 'Playlist automatique' : 'Playlist'} • ${plural(tracks.length, 'titre')}${dur ? ' • ' + fmtLong(dur) : ''}</div></div>`;
  if (!tracks.length) {
    return html + `<div class="note">${id === 'liked' ? 'Touche ♡ sur un titre pour le retrouver ici.' : 'Cette playlist est vide. Ajoute des titres avec le bouton ⋮ à côté d’un morceau.'}</div>`;
  }
  html += `<div class="hero-actions"><button class="btn primary" data-action="play-list" data-ctx="${c}">${icon('play')}Lire</button>
    <button class="btn" data-action="shuffle-list" data-ctx="${c}">${icon('shuffle')}Aléatoire</button></div>`;
  return html + tracks.map((t, i) => trackRow(t, c, i, { pl: sp ? null : p.id })).join('');
}

// ---------- Radio
function vRadio() {
  const tab = S.ui.radioTab;
  const right = `<button class="ib" data-action="add-stream" aria-label="Ajouter un flux">${icon('plus')}</button>`;
  let html = topbar('Radio', { right, jp: 'ラジオ' });
  html += `<div class="chips">${[['top', 'Populaires'], ['genres', 'Genres'], ['favs', 'Mes radios'], ['search', 'Rechercher']]
    .map(([k, l]) => `<button class="chip ${tab === k ? 'on' : ''}" data-action="radio-tab" data-tab="${k}">${l}</button>`).join('')}</div>`;

  let key = null;
  let loader = null;
  if (tab === 'top') {
    const cc = S.ui.radioCountry;
    html += `<div class="chips">${radio.COUNTRIES.map(([k, l]) => `<button class="chip ${cc === k ? 'on' : ''}" data-action="radio-country" data-cc="${k}">${l}</button>`).join('')}</div>`;
    key = 'top:' + cc;
    loader = () => radio.top(cc);
  } else if (tab === 'genres') {
    const g = S.ui.radioGenre;
    const cc = S.ui.radioLocal ? S.ui.radioCountry || 'FR' : '';
    const cname = (radio.COUNTRIES.find(([k]) => k === (S.ui.radioCountry || 'FR')) || [, 'France'])[1];
    html += `<div class="chips" style="flex-wrap:wrap">${radio.GENRES.map(([k, l]) => `<button class="chip ${g === k ? 'on' : ''}" data-action="radio-genre" data-g="${k}">${l}</button>`).join('')}</div>`;
    html += `<div class="chips"><button class="chip ${cc ? 'on' : ''}" data-action="radio-local">${cc ? icon('check') : ''}${esc(cname)} uniquement</button></div>`;
    key = `tag:${g}:${cc}`;
    loader = () => radio.byTag(g, cc);
  } else if (tab === 'favs') {
    if (S.radioFavs.length) {
      const c = regSt(S.radioFavs);
      html += section('Favoris', S.radioFavs.map((s, i) => stationRow(s, c, i)).join(''));
    } else {
      html += `<div class="note">Touche ♡ à côté d’une radio pour l’ajouter ici.</div>`;
    }
    if (S.radioRecent.length) {
      const c = regSt(S.radioRecent);
      html += section('Écoutées récemment', S.radioRecent.map((s, i) => stationRow(s, c, i)).join(''));
    }
    html += `<div class="actions" style="justify-content:center;padding:20px"><button class="btn" data-action="add-stream">${icon('plus')}Ajouter un flux (URL)</button></div>`;
    return html;
  } else {
    html += `<div style="display:flex;padding:6px 8px 4px 16px"><label class="searchbox">${icon('search')}<input id="rq" type="search" placeholder="Nom de la radio (ex : Skyrock, FIP…)" autocomplete="off" autocorrect="off" spellcheck="false" enterkeyhint="search" value="${esc(S.ui.radioQ)}"></label></div>`;
    const q = S.ui.radioQ.trim();
    if (q.length >= 2) {
      key = 'q:' + q.toLowerCase();
      loader = () => radio.search(q);
    }
  }
  const cached = key && radioCache.get(key);
  html += `<div id="radio-list">${!key ? '' : cached ? stationList(cached) : loadingEl()}</div>`;
  return {
    html,
    after() {
      const rq = $('#rq');
      if (rq) {
        let t = 0;
        rq.addEventListener('input', () => {
          clearTimeout(t);
          t = setTimeout(() => { S.ui.radioQ = rq.value; saveUI(); render(); }, 450);
        });
        rq.addEventListener('keydown', (e) => { if (e.key === 'Enter') { clearTimeout(t); S.ui.radioQ = rq.value; rq.blur(); render(); } });
        if (!rq.value) rq.focus();
      }
      if (key && !cached) fetchRadio(key, loader);
    },
  };
}

function stationList(list) {
  if (!list.length) return `<div class="note">Aucune station trouvée.</div>`;
  const c = regSt(list);
  return list.map((s, i) => stationRow(s, c, i)).join('');
}

async function fetchRadio(key, loader) {
  try {
    const list = await loader();
    radioCache.set(key, list);
    const box = $('#radio-list');
    if (box && currentRoute()[0] === 'radio') { box.innerHTML = stationList(list); markPlaying(); }
  } catch (e) {
    const box = $('#radio-list');
    if (box) box.innerHTML = `<div class="note">Impossible de charger les radios. Vérifie ta connexion.<br><br><button class="btn" data-action="rerender">Réessayer</button></div>`;
  }
}

function vSettings() {
  const L = lib();
  const th = theme();
  const html = topbar('Réglages', { back: true, jp: '設定' }) + `<div class="settings">
    <div class="card-box"><h3>Apparence</h3>
      <div class="theme-pick">${THEMES.map((t) => `<button class="${th === t.id ? 'on' : ''}" data-action="set-theme" data-theme-id="${t.id}"><span class="sw" style="background:${t.sw}"></span><b>${t.name}</b><small>${t.sub}</small></button>`).join('')}</div>
      <p>Fond d’écran : mets l’image de ton choix (ton perso préféré, un fond d’anime…). Elle reste sur ton téléphone.</p>
      <div class="stack" style="align-items:flex-start;flex-direction:row;flex-wrap:wrap"><button class="btn" data-action="wallpaper">${icon('upload')}Choisir une image</button>
      ${S.hasWall ? `<button class="btn danger" data-action="wallpaper-remove">${icon('close')}Retirer</button>` : ''}</div></div>
    <div class="card-box"><h3>Stockage</h3><div id="storage"><p>Calcul…</p></div>
      <button class="btn" data-action="persist">Protéger mes fichiers</button></div>
    <div class="card-box"><h3>Bibliothèque</h3><p>Pour importer tout un dossier : dans l’app Fichiers, garde le doigt sur le dossier → <b>Compresser</b>, puis importe le fichier .zip obtenu.</p><p>${plural(L.tracks.length, 'titre')}, ${plural(L.albums.length, 'album')}, ${plural(S.playlists.length, 'playlist')}.</p>
      <div class="stack" style="align-items:flex-start"><button class="btn primary" data-action="import">${icon('upload')}Importer des MP3 ou un .zip</button>
      <button class="btn danger" data-action="wipe">${icon('delete')}Tout effacer</button></div></div>
    <div class="card-box"><h3>Écouter en arrière-plan</h3><ol>
      <li>Ouvre Hikaku <b>depuis l’icône de l’écran d’accueil</b> (pas depuis Safari).</li>
      <li>Lance un titre ou une radio, puis change d’appli ou verrouille l’écran : la musique continue.</li>
      <li>Contrôle la lecture depuis l’écran verrouillé ou le Centre de contrôle.</li>
      <li>Ne ferme pas Hikaku en la balayant vers le haut dans le sélecteur d’apps, sinon la lecture s’arrête.</li></ol></div>
    <div class="card-box"><h3>Installer sur l’iPhone</h3><ol>
      <li>Ouvre ce site dans <b>Safari</b>.</li><li>Touche ${icon('share', 'share')} <b>Partager</b>.</li>
      <li>Choisis <b>Sur l’écran d’accueil</b>, puis <b>Ajouter</b>.</li></ol></div>
    <div class="card-box"><h3>À propos</h3><p>Hikaku ${VERSION}. Tes fichiers restent sur ton téléphone, rien n’est envoyé sur Internet. Les radios viennent de l’annuaire libre radio-browser.info.</p></div>
  </div>`;
  return {
    html,
    async after() {
      const box = $('#storage');
      try {
        const est = await navigator.storage?.estimate?.();
        const persisted = await navigator.storage?.persisted?.();
        if (!est || !box) return;
        const pct = est.quota ? Math.min(100, (est.usage / est.quota) * 100) : 0;
        box.innerHTML = `<p>${fmtBytes(est.usage || 0)} utilisés${est.quota ? ' sur ' + fmtBytes(est.quota) + ' disponibles' : ''}.</p>
          <div class="meter"><i style="width:${pct.toFixed(1)}%"></i></div>
          <p>${persisted ? 'Protection activée : iOS ne supprimera pas tes fichiers.' : 'Sans protection, iOS peut effacer les données d’un site peu utilisé. Installer l’appli sur l’écran d’accueil évite ce problème.'}</p>`;
      } catch {}
    },
  };
}

// ============================================================ Routeur
const ROUTES = { home: vHome, search: vSearch, library: vLibrary, album: vAlbum, artist: vArtist, playlist: vPlaylist, radio: vRadio, settings: vSettings };
const TAB_OF = { home: 'home', settings: 'home', search: 'search', library: 'library', album: 'library', artist: 'library', playlist: 'library', radio: 'radio' };
const scrolls = new Map();
let lastHash = location.hash;
let navCount = 0;

function currentRoute() {
  const parts = location.hash.replace(/^#\/?/, '').split('/').map((x) => decodeURIComponent(x));
  if (!ROUTES[parts[0]]) parts[0] = 'home';
  return parts;
}

function render(keepScroll = true) {
  const y = window.scrollY;
  LISTS = [];
  STLISTS = [];
  const [name, ...args] = currentRoute();
  const out = ROUTES[name](...args);
  const { html, after } = typeof out === 'string' ? { html: out } : out;
  $('#view').innerHTML = html;
  $$('#tabbar a').forEach((a) => a.classList.toggle('on', a.dataset.tab === TAB_OF[name]));
  if (keepScroll) window.scrollTo(0, y);
  after?.();
  typeSysLine();
  markPlaying();
}

// Ligne « système » tapée lettre par lettre (thème Sage)
let typedOnce = false;
let typeT = 0;
function typeSysLine() {
  const el = $('.sys-line');
  if (!el) return;
  const full = el.dataset.type;
  clearInterval(typeT);
  if (typedOnce || theme() !== 'sage' || matchMedia('(prefers-reduced-motion: reduce)').matches) { el.textContent = full; return; }
  typedOnce = true;
  let i = 0;
  typeT = setInterval(() => {
    i += 1;
    el.textContent = full.slice(0, i);
    if (i >= full.length) clearInterval(typeT);
  }, 22);
}

window.addEventListener('hashchange', () => {
  scrolls.set(lastHash, window.scrollY);
  lastHash = location.hash;
  navCount++;
  closeNP();
  closeOverlay();
  render(false);
  window.scrollTo(0, scrolls.get(location.hash) || 0);
});

function go(h) {
  if (location.hash === h) { closeNP(); return; }
  location.hash = h;
}

// ============================================================ Lecture en cours
function markPlaying() {
  const id = player.currentId;
  const sid = player.mode === 'radio' ? player.station?.id : null;
  $$('[data-tid]').forEach((el) => el.classList.toggle('playing', el.dataset.tid === id));
  $$('[data-sid]').forEach((el) => el.classList.toggle('playing', el.dataset.sid === sid));
}

const npEl = $('#np');
// Le lecteur plein écran ne doit jamais défiler (iOS < 16 ignore overflow: clip)
npEl.addEventListener('scroll', () => { if (npEl.scrollTop) npEl.scrollTop = 0; });
const seekEl = $('#seek');
let seeking = false;

function renderPlayer() {
  const m = player.mode;
  document.body.classList.toggle('has-mini', !!m);
  document.body.classList.toggle('radio', m === 'radio');
  $('#mini').hidden = !m;
  npEl.classList.toggle('radio', m === 'radio');
  if (!m) { closeNP(); return; }
  let title, sub, cover, coverBig, bg, liked;
  if (m === 'track') {
    const t = S.tracks.get(player.currentId);
    if (!t) return;
    title = t.title;
    sub = t.artist || 'Artiste inconnu';
    cover = coverEl(t, 'sm');
    coverBig = coverEl(t, 'np');
    bg = coverURL(t) || '';
    liked = t.liked;
    $('#np-src').textContent = player.source ? 'Lecture depuis · ' + player.source : 'En lecture';
  } else {
    const s = player.station;
    title = s.name;
    sub = 'Radio en direct' + (s.country ? ' • ' + s.country : '');
    cover = stationLogo(s, 'sm');
    coverBig = s.favicon ? stationLogo(s, 'np') : phEl('np', s.name, 'radio');
    bg = s.favicon || '';
    liked = isFav(s.id);
    $('#np-src').textContent = 'Radio';
  }
  $('#mini-cv').innerHTML = cover;
  $('#mini-title').textContent = title;
  $('#mini-sub').textContent = sub;
  $('#np-cover').innerHTML = coverBig;
  $('#np-title').textContent = title;
  $('#np-artist').textContent = sub;
  const bgEl = $('#np-bg');
  if (bg) bgEl.src = bg; else bgEl.removeAttribute('src');
  $('#np-like').innerHTML = icon(liked ? 'heart-fill' : 'heart');
  $('#np-like').classList.toggle('on', !!liked);
  renderState();
  renderTime();
  if (panel === 'queue') renderQueue();
  if (panel === 'lyrics') renderLyrics();
}

function renderState() {
  const p = player.paused;
  document.body.classList.toggle('paused', p);
  const ic = icon(p ? 'play' : 'pause');
  $('#mini-play').innerHTML = ic;
  $('#b-play').innerHTML = ic;
  $('#b-shuffle').classList.toggle('on', player.shuffle);
  $('#b-repeat').innerHTML = icon(player.repeat === 'one' ? 'repeat-one' : 'repeat');
  $('#b-repeat').classList.toggle('on', player.repeat !== 'off');
  $('#b-speed span').textContent = (player.rate === 1 ? '1' : String(player.rate).replace('.', ',')) + '×';
  $('#b-speed').classList.toggle('on', player.rate !== 1);
  renderSleep();
}

function renderSleep() {
  const s = player.sleep;
  const b = $('#b-sleep');
  b.classList.toggle('on', !!s);
  b.querySelector('span').textContent = !s ? 'Minuteur' : s.mode === 'track' ? 'Fin du titre' : Math.max(1, Math.ceil((s.endAt - Date.now()) / 60000)) + ' min';
}
setInterval(() => { if (player.sleep?.mode === 'time') renderSleep(); }, 15000);

let rafT = 0;
function renderTime() {
  if (rafT) return;
  rafT = requestAnimationFrame(() => {
    rafT = 0;
    const d = player.duration;
    const t = S.tracks.get(player.currentId);
    const dur = isFinite(d) && d > 0 ? d : t?.duration || 0;
    const c = player.time || 0;
    const p = dur ? Math.min(1, c / dur) : 0;
    $('#mini-prog').style.width = (p * 100).toFixed(2) + '%';
    if (!seeking) {
      seekEl.value = Math.round(p * 1000);
      seekEl.style.setProperty('--p', (p * 100).toFixed(2) + '%');
      $('#t-cur').textContent = fmt(c);
    }
    $('#t-dur').textContent = fmt(dur);
  });
}

seekEl.addEventListener('input', () => {
  seeking = true;
  const d = player.duration;
  const v = seekEl.value / 1000;
  seekEl.style.setProperty('--p', v * 100 + '%');
  $('#t-cur').textContent = fmt(isFinite(d) ? v * d : 0);
});
seekEl.addEventListener('change', () => {
  const d = player.duration;
  if (isFinite(d)) player.seek((seekEl.value / 1000) * d);
  seeking = false;
});

player.addEventListener('track', () => { renderPlayer(); markPlaying(); });
player.addEventListener('state', () => { renderState(); markPlaying(); });
player.addEventListener('time', renderTime);
player.addEventListener('queue', () => { if (panel === 'queue') renderQueue(); });
player.addEventListener('sleep', renderSleep);
player.addEventListener('message', (e) => toast(e.detail, false, /impossible|répond|introuvable/i.test(e.detail) ? 'alerte' : 'rapport'));
player.addEventListener('buffer', (e) => npEl.classList.toggle('buffering', !!e.detail));

function openNP() {
  if (!player.mode) return;
  npEl.classList.add('open');
  document.body.classList.add('np-open');
}
function closeNP() {
  npEl.classList.remove('open');
  document.body.classList.remove('np-open');
  closePanel();
}

// Glisser vers le bas pour fermer
(() => {
  let y0 = null, dy = 0;
  const start = (e) => {
    if (!npEl.classList.contains('open') || panel || e.target.closest('input,.np-ctrl,.np-tools')) return;
    y0 = e.touches[0].clientY; dy = 0;
  };
  npEl.addEventListener('touchstart', start, { passive: true });
  npEl.addEventListener('touchmove', (e) => {
    if (y0 == null) return;
    dy = Math.max(0, e.touches[0].clientY - y0);
    if (dy > 6) { npEl.classList.add('dragging'); npEl.style.transform = `translateY(${dy}px)`; }
  }, { passive: true });
  npEl.addEventListener('touchend', () => {
    if (y0 == null) return;
    y0 = null;
    npEl.classList.remove('dragging');
    npEl.style.transform = '';
    if (dy > 110) closeNP();
  });
})();

// ---------- Panneau "À suivre" / "Paroles"
let panel = null;
function openPanel(kind) {
  panel = kind;
  $('#np-panel').classList.add('open');
  if (kind === 'queue') renderQueue(true);
  else renderLyrics();
}
function closePanel() {
  panel = null;
  $('#np-panel').classList.remove('open');
}

function renderQueue(scroll) {
  $('#panel-title').textContent = player.mode === 'radio' ? 'Stations' : 'À suivre';
  const body = $('#panel-body');
  if (player.mode === 'radio') {
    const c = regSt(player.stations);
    body.innerHTML = player.stations.map((s, i) => stationRow(s, c, i)).join('');
    markPlaying();
    return;
  }
  const q = player.queue;
  let html = `<div class="panel-toggles">
    <button class="chip ${player.shuffle ? 'on' : ''}" data-action="shuffle">${icon('shuffle')}Aléatoire</button>
    <button class="chip ${player.repeat !== 'off' ? 'on' : ''}" data-action="repeat">${icon(player.repeat === 'one' ? 'repeat-one' : 'repeat')}${player.repeat === 'one' ? 'Répéter le titre' : player.repeat === 'all' ? 'Tout répéter' : 'Répéter'}</button></div>`;
  html += q.map((id, i) => {
    const t = S.tracks.get(id);
    if (!t) return '';
    const cur = i === player.index;
    return `<div class="row ${cur ? 'current' : ''} ${i < player.index ? 'dim' : ''}" data-action="q-jump" data-i="${i}" ${cur ? 'id="q-cur"' : ''}>
      ${coverEl(t, 'sm')}<div class="meta"><div class="t1">${esc(t.title)}</div><div class="t2">${esc(t.artist || '')}${t.duration ? ' • ' + fmt(t.duration) : ''}</div></div>
      ${cur ? `<span class="ib">${EQ}</span>` : `<button class="ib" data-action="q-up" data-i="${i}" aria-label="Monter">${icon('up')}</button>
      <button class="ib" data-action="q-down" data-i="${i}" aria-label="Descendre">${icon('down')}</button>
      <button class="ib" data-action="q-remove" data-i="${i}" aria-label="Retirer">${icon('close')}</button>`}
    </div>`;
  }).join('');
  const st = body.scrollTop;
  body.innerHTML = html;
  body.scrollTop = st;
  const cur = $('#q-cur');
  if (scroll && cur) body.scrollTop = Math.max(0, cur.offsetTop - body.clientHeight / 2 + cur.offsetHeight / 2);
}

function renderLyrics() {
  const t = S.tracks.get(player.currentId);
  $('#panel-title').textContent = 'Paroles';
  const body = $('#panel-body');
  if (!t) { body.innerHTML = ''; return; }
  body.innerHTML = t.lyrics
    ? `<div class="lyrics">${esc(t.lyrics)}</div><div class="actions" style="justify-content:center"><button class="btn" data-action="edit-lyrics" data-id="${t.id}">${icon('edit')}Modifier</button></div>`
    : `<div class="empty"><div class="big">${icon('lyrics')}</div><h2>Pas de paroles</h2><p>Ce MP3 ne contient pas de paroles. Tu peux les coller toi-même.</p><button class="btn primary" data-action="edit-lyrics" data-id="${t.id}">${icon('edit')}Ajouter des paroles</button></div>`;
}

// ============================================================ Feuilles, fenêtres, toasts
const overlay = $('#overlay');
function closeOverlay() { overlay.innerHTML = ''; }

function sheet({ head = '', items }) {
  overlay.innerHTML = `<div class="sheet-wrap"><div class="sheet-bd"></div><div class="sheet" role="menu"><div class="grip"></div>${head}
    ${items.map((it, i) => `<button class="item ${it.danger ? 'danger' : ''} ${it.on ? 'on' : ''}" data-si="${i}" role="menuitem">${icon(it.icon || 'note')}<span>${esc(it.label)}</span>${it.on ? `<span class="chk">${icon('check')}</span>` : ''}</button>`).join('')}
  </div></div>`;
  const wrap = overlay.firstElementChild;
  wrap.addEventListener('click', (e) => {
    e.stopPropagation();
    const b = e.target.closest('[data-si]');
    if (b) { closeOverlay(); items[+b.dataset.si].fn(); return; }
    if (e.target.classList.contains('sheet-bd')) closeOverlay();
  });
}
const sheetHead = (cover, title, sub) => `<div class="head">${cover}<div class="meta"><div class="t1">${esc(title)}</div><div class="t2">${esc(sub || '')}</div></div></div>`;

function modal({ title, body, ok = 'OK', danger = false, onOk }) {
  overlay.innerHTML = `<div class="modal-wrap"><form class="modal"><h3>${esc(title)}</h3>${body}
    <div class="modal-btns"><button type="button" class="btn" data-m="cancel">Annuler</button><button type="submit" class="btn ${danger ? 'danger' : 'primary'}">${esc(ok)}</button></div></form></div>`;
  const form = overlay.querySelector('form');
  overlay.firstElementChild.addEventListener('click', (e) => {
    e.stopPropagation();
    if (e.target.dataset.m === 'cancel' || e.target.classList.contains('modal-wrap')) closeOverlay();
  });
  form.addEventListener('submit', async (e) => {
    e.preventDefault();
    const r = await onOk(new FormData(form));
    if (r !== false) closeOverlay();
  });
  setTimeout(() => form.querySelector('input,textarea')?.focus(), 50);
}
const field = (name, label, value = '', type = 'text', extra = '') =>
  `<label class="field"><span>${esc(label)}</span><input name="${name}" type="${type}" value="${esc(value)}" ${extra}></label>`;
const confirmBox = (title, text, ok, fn) => modal({ title, body: `<p>${esc(text)}</p>`, ok, danger: true, onOk: fn });

let toastT = 0;
const TAGS = { avis: 'Avis', rapport: 'Rapport', alerte: 'Alerte' };
function toast(msg, sticky = false, kind = 'avis') {
  const el = $('#toast');
  const set = (m) => { el.innerHTML = `<span class="toast-tag ${kind}">« ${TAGS[kind] || 'Avis'} »</span>${esc(m)}`; };
  set(msg);
  el.classList.add('show');
  clearTimeout(toastT);
  if (!sticky) toastT = setTimeout(() => el.classList.remove('show'), 2800);
  return { update: set, close: () => { el.classList.remove('show'); } };
}

// Image cassée (logo de radio…) -> vignette de remplacement
document.addEventListener('error', (e) => {
  const img = e.target;
  if (img.tagName !== 'IMG' || !img.classList.contains('cv')) return;
  const div = document.createElement('div');
  div.className = img.className.replace('logo', '') + ' ph';
  div.style.setProperty('--h', img.dataset.ph || 250);
  div.innerHTML = icon(img.dataset.ic || 'note');
  img.replaceWith(div);
}, true);

// ============================================================ Actions
function toggleLike(id) {
  const t = S.tracks.get(id);
  if (!t) return;
  t.liked = !t.liked;
  t.likedAt = t.liked ? Date.now() : 0;
  db.put('tracks', t);
  bump();
  toast(t.liked ? 'Ajouté aux titres likés' : 'Retiré des titres likés');
  render();
  renderPlayer();
}

function isFav(id) { return S.radioFavs.some((s) => s.id === id); }
function toggleFav(st) {
  if (isFav(st.id)) S.radioFavs = S.radioFavs.filter((s) => s.id !== st.id);
  else S.radioFavs = [st, ...S.radioFavs];
  db.put('kv', S.radioFavs, 'radioFavs');
  toast(isFav(st.id) ? 'Ajoutée à Mes radios' : 'Retirée de Mes radios');
  if (currentRoute()[0] === 'radio' || currentRoute()[0] === 'home') render();
  renderPlayer();
}

async function savePlaylist(p) {
  p.updatedAt = Date.now();
  await db.put('playlists', p);
}
function newPlaylist(thenAdd = []) {
  modal({
    title: 'Nouvelle playlist',
    body: field('name', 'Nom', '', 'text', 'required maxlength="80" placeholder="Ma playlist"'),
    ok: 'Créer',
    async onOk(fd) {
      const name = String(fd.get('name') || '').trim();
      if (!name) return false;
      const p = { id: uid(), name, trackIds: thenAdd.slice(), createdAt: Date.now(), updatedAt: Date.now() };
      S.playlists.push(p);
      await savePlaylist(p);
      toast(thenAdd.length ? `Ajouté à « ${name} »` : `Playlist « ${name} » créée`);
      render();
    },
  });
}
function addToPlaylistSheet(ids) {
  const items = [{ icon: 'plus', label: 'Nouvelle playlist', fn: () => newPlaylist(ids) }];
  for (const p of S.playlists.slice().sort((a, b) => b.updatedAt - a.updatedAt)) {
    items.push({
      icon: 'queue',
      label: p.name,
      fn: async () => {
        const fresh = ids.filter((x) => !p.trackIds.includes(x));
        if (!fresh.length) { toast('Déjà dans la playlist'); return; }
        p.trackIds.push(...fresh);
        await savePlaylist(p);
        toast(`Ajouté à « ${p.name} »`);
        render();
      },
    });
  }
  sheet({ head: sheetHead('', 'Ajouter à une playlist', plural(ids.length, 'titre')), items });
}

function trackMenu(id, plId, pi) {
  const t = S.tracks.get(id);
  if (!t) return;
  const L = lib();
  const album = t.album ? L.albumByKey.get(albumKeyOf(t)) : null;
  const pl = plId ? S.playlists.find((p) => p.id === plId) : null;
  pi = Number(pi);
  const items = [
    { icon: 'play-next', label: 'Lire ensuite', fn: () => { player.playNext(id); toast('Sera lu juste après'); } },
    { icon: 'queue', label: 'Ajouter à la file d’attente', fn: () => { player.addToQueue(id); toast('Ajouté à la file d’attente'); } },
    { icon: 'playlist-add', label: 'Ajouter à une playlist', fn: () => addToPlaylistSheet([id]) },
    { icon: t.liked ? 'heart-fill' : 'heart', label: t.liked ? 'Retirer des titres likés' : 'J’aime', fn: () => toggleLike(id) },
    album && { icon: 'album', label: 'Accéder à l’album', fn: () => go('#/album/' + album.id) },
    t.artist && { icon: 'person', label: 'Accéder à l’artiste', fn: () => go('#/artist/' + hash(artistKeyOf(t))) },
    pl && pi > 0 && { icon: 'up', label: 'Monter dans la playlist', fn: () => movePl(pl, pi, -1) },
    pl && pi < pl.trackIds.length - 1 && { icon: 'down', label: 'Descendre dans la playlist', fn: () => movePl(pl, pi, 1) },
    pl && { icon: 'close', label: 'Retirer de cette playlist', fn: () => removeFromPl(pl, pi) },
    { icon: 'lyrics', label: t.lyrics ? 'Modifier les paroles' : 'Ajouter des paroles', fn: () => editLyrics(id) },
    { icon: 'edit', label: 'Modifier les infos', fn: () => editInfo(id) },
    { icon: 'delete', label: 'Supprimer de l’appareil', danger: true, fn: () => deleteTracks([id]) },
  ].filter(Boolean);
  sheet({ head: sheetHead(coverEl(t, 'sm'), t.title, [t.artist, t.album].filter(Boolean).join(' • ')), items });
}

async function movePl(p, i, d) {
  const ids = p.trackIds.filter((x) => S.tracks.has(x));
  p.trackIds = ids;
  const j = i + d;
  if (j < 0 || j >= ids.length) return;
  [ids[i], ids[j]] = [ids[j], ids[i]];
  await savePlaylist(p);
  render();
}
async function removeFromPl(p, i) {
  p.trackIds = p.trackIds.filter((x) => S.tracks.has(x));
  p.trackIds.splice(i, 1);
  await savePlaylist(p);
  toast('Retiré de la playlist');
  render();
}

function editLyrics(id) {
  const t = S.tracks.get(id);
  if (!t) return;
  modal({
    title: 'Paroles — ' + t.title,
    body: `<label class="field"><span>Colle les paroles ici</span><textarea name="lyrics">${esc(t.lyrics || '')}</textarea></label>`,
    ok: 'Enregistrer',
    async onOk(fd) {
      t.lyrics = String(fd.get('lyrics') || '').trim();
      await db.put('tracks', t);
      if (panel === 'lyrics') renderLyrics();
      toast('Paroles enregistrées');
    },
  });
}

function editInfo(id) {
  const t = S.tracks.get(id);
  if (!t) return;
  modal({
    title: 'Modifier les infos',
    body: field('title', 'Titre', t.title, 'text', 'required') + field('artist', 'Artiste', t.artist) + field('album', 'Album', t.album) +
      field('trackNo', 'N° de piste', t.trackNo || '', 'number', 'min="0" inputmode="numeric"'),
    ok: 'Enregistrer',
    async onOk(fd) {
      const title = String(fd.get('title') || '').trim();
      if (!title) return false;
      const oldKey = albumKeyOf(t);
      const oldCover = coverKeyFor(t);
      Object.assign(t, {
        title,
        artist: String(fd.get('artist') || '').trim(),
        album: String(fd.get('album') || '').trim(),
        trackNo: parseInt(fd.get('trackNo'), 10) || 0,
      });
      if (oldKey !== albumKeyOf(t) && oldCover) t.coverKey = oldCover; // garder la pochette
      await db.put('tracks', t);
      bump();
      render();
      renderPlayer();
      toast('Infos mises à jour');
    },
  });
}

function deleteTracks(ids) {
  const n = ids.length;
  confirmBox(n > 1 ? `Supprimer ${n} titres ?` : 'Supprimer ce titre ?', 'Le fichier sera effacé de ton iPhone (pas de ton app Fichiers).', 'Supprimer', async () => {
    player.purge(ids);
    for (const id of ids) {
      const t = S.tracks.get(id);
      if (!t) continue;
      S.tracks.delete(id);
      const ck = t.coverKey;
      const stillUsed = ck && [...S.tracks.values()].some((x) => x.coverKey === ck || (x.album && 'a:' + albumKeyOf(x) === ck));
      await db.removeTrack(id, ck && !stillUsed ? ck : null);
      if (ck && !stillUsed && S.covers.has(ck)) { URL.revokeObjectURL(S.covers.get(ck)); S.covers.delete(ck); S.coverData.delete(ck); }
    }
    for (const p of S.playlists) {
      const before = p.trackIds.length;
      p.trackIds = p.trackIds.filter((x) => !ids.includes(x));
      if (p.trackIds.length !== before) await savePlaylist(p);
    }
    bump();
    render();
    toast(n > 1 ? `${n} titres supprimés` : 'Titre supprimé');
  });
}

function sleepSheet() {
  const s = player.sleep;
  const opts = [[5, '5 minutes'], [10, '10 minutes'], [15, '15 minutes'], [30, '30 minutes'], [45, '45 minutes'], [60, '1 heure'], [90, '1 h 30']];
  const items = [];
  if (s) items.push({ icon: 'close', label: 'Désactiver le minuteur', fn: () => { player.setSleep(null); toast('Minuteur désactivé'); } });
  for (const [v, l] of opts) items.push({ icon: 'timer', label: l, fn: () => { player.setSleep(v); toast(`Pause dans ${l}`); } });
  if (player.mode === 'track') items.push({ icon: 'note', label: 'À la fin du titre', on: s?.mode === 'track', fn: () => { player.setSleep('track'); toast('Pause à la fin du titre'); } });
  sheet({ head: sheetHead('', 'Minuteur de mise en veille', s ? 'Actif' : 'La musique se mettra en pause automatiquement'), items });
}

function speedSheet() {
  const items = [0.5, 0.75, 1, 1.25, 1.5, 2].map((r) => ({
    icon: 'speed', label: r === 1 ? 'Normale (1×)' : String(r).replace('.', ',') + '×', on: player.rate === r, fn: () => player.setRate(r),
  }));
  sheet({ head: sheetHead('', 'Vitesse de lecture', ''), items });
}

function npMenu() {
  if (player.mode === 'radio') {
    const s = player.station;
    sheet({
      head: sheetHead(stationLogo(s, 'sm'), s.name, 'Radio en direct'),
      items: [
        { icon: isFav(s.id) ? 'heart-fill' : 'heart', label: isFav(s.id) ? 'Retirer de Mes radios' : 'Ajouter à Mes radios', fn: () => toggleFav(s) },
        { icon: 'timer', label: 'Minuteur de mise en veille', fn: sleepSheet },
      ],
    });
    return;
  }
  const id = player.currentId;
  if (id) trackMenu(id);
}

function albumMenu(id) {
  const a = lib().albumById.get(id);
  if (!a) return;
  const ids = a.tracks.map((t) => t.id);
  sheet({
    head: sheetHead(coverEl(a.tracks[0], 'sm'), a.name, a.artist),
    items: [
      { icon: 'play-next', label: 'Lire ensuite', fn: () => { player.playNext(ids); toast('Album ajouté juste après'); } },
      { icon: 'queue', label: 'Ajouter à la file d’attente', fn: () => { player.addToQueue(ids); toast('Album ajouté à la file d’attente'); } },
      { icon: 'playlist-add', label: 'Ajouter à une playlist', fn: () => addToPlaylistSheet(ids) },
      { icon: 'delete', label: 'Supprimer l’album de l’appareil', danger: true, fn: () => deleteTracks(ids) },
    ],
  });
}

function plMenu(id) {
  const p = S.playlists.find((x) => x.id === id);
  if (!p) return;
  const ids = p.trackIds.filter((x) => S.tracks.has(x));
  sheet({
    head: sheetHead(mosaicEl(ids, 'sm', p.name), p.name, plural(ids.length, 'titre')),
    items: [
      { icon: 'play-next', label: 'Lire ensuite', fn: () => ids.length && player.playNext(ids) },
      { icon: 'queue', label: 'Ajouter à la file d’attente', fn: () => ids.length && player.addToQueue(ids) },
      {
        icon: 'edit', label: 'Renommer', fn: () => modal({
          title: 'Renommer la playlist', body: field('name', 'Nom', p.name, 'text', 'required maxlength="80"'), ok: 'Enregistrer',
          async onOk(fd) { const n = String(fd.get('name') || '').trim(); if (!n) return false; p.name = n; await savePlaylist(p); render(); },
        }),
      },
      {
        icon: 'delete', label: 'Supprimer la playlist', danger: true, fn: () => confirmBox('Supprimer la playlist ?', `« ${p.name} » sera supprimée. Les titres restent dans ta bibliothèque.`, 'Supprimer', async () => {
          S.playlists = S.playlists.filter((x) => x !== p);
          await db.del('playlists', p.id);
          toast('Playlist supprimée');
          go('#/library');
        }),
      },
    ],
  });
}

function addStream() {
  modal({
    title: 'Ajouter une radio',
    body: `<p>Colle l’adresse d’un flux audio (elle doit commencer par https://).</p>` +
      field('name', 'Nom', '', 'text', 'required placeholder="Ma radio"') +
      field('url', 'Adresse du flux', '', 'url', 'required placeholder="https://…" autocapitalize="off"'),
    ok: 'Ajouter',
    onOk(fd) {
      const name = String(fd.get('name') || '').trim();
      const url = String(fd.get('url') || '').trim();
      if (!name || !url) return false;
      if (!/^https:\/\//i.test(url)) { toast('L’adresse doit commencer par https://'); return false; }
      const st = { id: 'custom-' + uid(), name, url, favicon: '', tags: 'Flux perso', country: '', bitrate: 0 };
      S.radioFavs = [st, ...S.radioFavs];
      db.put('kv', S.radioFavs, 'radioFavs');
      toast('Radio ajoutée à Mes radios');
      S.ui.radioTab = 'favs';
      saveUI();
      if (currentRoute()[0] === 'radio') render(); else go('#/radio');
    },
  });
}

// ---------- Import des MP3
const MIME = { mp3: 'audio/mpeg', m4a: 'audio/mp4', aac: 'audio/aac', wav: 'audio/wav', ogg: 'audio/ogg', oga: 'audio/ogg', opus: 'audio/ogg', flac: 'audio/flac' };
const extOf = (n) => (n.match(/\.([a-z0-9]+)$/i)?.[1] || '').toLowerCase();

function parseFileName(name) {
  let base = name.replace(/\.[^.]+$/, '').replace(/_/g, ' ').replace(/\s+/g, ' ').trim();
  base = base.replace(/^\d{1,3}\s*[-.)]?\s+/, '');
  const m = base.split(' - ');
  if (m.length >= 2) return { artist: m[0].trim(), title: m.slice(1).join(' - ').trim() };
  return { artist: '', title: base || name };
}

async function resizeCover(pic) {
  const url = URL.createObjectURL(new Blob([pic.data], { type: pic.mime }));
  try {
    const img = new Image();
    img.src = url;
    await img.decode();
    const s = Math.min(img.naturalWidth, img.naturalHeight);
    if (!s) return null;
    const out = Math.min(512, s);
    const c = document.createElement('canvas');
    c.width = c.height = out;
    c.getContext('2d').drawImage(img, (img.naturalWidth - s) / 2, (img.naturalHeight - s) / 2, s, s, 0, 0, out, out);
    const b = await new Promise((r) => c.toBlob(r, 'image/jpeg', 0.86));
    return b ? await b.arrayBuffer() : null;
  } catch {
    return null;
  } finally {
    URL.revokeObjectURL(url);
  }
}

function probeDuration(blob) {
  return new Promise((res) => {
    const a = new Audio();
    const url = URL.createObjectURL(blob);
    let done = false;
    const fin = (d) => {
      if (done) return;
      done = true;
      URL.revokeObjectURL(url);
      a.removeAttribute('src');
      res(isFinite(d) && d > 0 ? d : 0);
    };
    a.preload = 'metadata';
    a.onloadedmetadata = () => fin(a.duration);
    a.onerror = () => fin(0);
    setTimeout(() => fin(0), 3000);
    a.src = url;
  });
}

async function importOne(f) {
  const buf = await f.arrayBuffer();
  const ext = extOf(f.name);
  const tags = readTags(buf);
  const fromName = parseFileName(f.name);
  const id = uid();
  const t = {
    id,
    title: tags.title || fromName.title,
    artist: tags.artist || fromName.artist || '',
    album: tags.album || '',
    albumArtist: tags.albumArtist || '',
    trackNo: tags.track || 0,
    year: tags.year || '',
    lyrics: tags.lyrics || '',
    duration: 0,
    addedAt: Date.now(),
    plays: 0,
    lastPlayed: 0,
    liked: false,
    likedAt: 0,
    size: f.size,
    fileName: f.name,
    mime: f.type || MIME[ext] || 'audio/mpeg',
    coverKey: null,
  };
  if (ext === 'mp3' || t.mime === 'audio/mpeg') t.duration = mp3Duration(new Uint8Array(buf), tags.end || 0);
  if (!t.duration) t.duration = await probeDuration(new Blob([buf], { type: t.mime }));
  const ak = albumKeyOf(t);
  const ck = ak ? 'a:' + ak : 't:' + id;
  let cover = null;
  if (tags.picture && !S.covers.has(ck)) {
    const cb = await resizeCover(tags.picture);
    if (cb) cover = { key: ck, buf: cb };
  }
  if (cover || S.covers.has(ck)) t.coverKey = ck;
  await db.addTrack(t, buf, cover);
  S.tracks.set(id, t);
  if (cover) S.covers.set(ck, URL.createObjectURL(new Blob([cover.buf], { type: 'image/jpeg' })));
  return t;
}

async function importFiles(input) {
  const isAudio = (name, type = '') => type.startsWith('audio/') || !!MIME[extOf(name)];
  // Chaque source sait se transformer en fichier au moment voulu (les .zip sont lus morceau par morceau)
  const files = [];
  let zipErr = null;
  for (const f of [...input]) {
    if (isZip(f)) {
      try {
        const entries = await listZip(f);
        for (const e of entries) {
          if (isAudio(e.name)) files.push({ name: e.name, size: e.usize, get: () => readZipEntry(f, e, MIME[extOf(e.name)] || '') });
        }
      } catch (e) { zipErr = e; }
    } else if (isAudio(f.name, f.type)) files.push({ name: f.name, size: f.size, get: async () => f });
  }
  if (!files.length) { toast(zipErr ? zipErr.message : 'Aucun fichier audio trouvé', false, 'alerte'); return; }
  navigator.storage?.persist?.().catch(() => {});
  const seen = new Set([...S.tracks.values()].map((t) => t.fileName + '|' + t.size));
  let added = 0, skipped = 0, failed = 0;
  const tt = toast(`Import… 0/${files.length}`, true);
  for (let i = 0; i < files.length; i++) {
    const src = files[i];
    tt.update(`Import ${i + 1}/${files.length} • ${src.name}`);
    if (seen.has(src.name + '|' + src.size)) { skipped++; continue; }
    try {
      const f = await src.get();
      await importOne(f);
      seen.add(f.name + '|' + f.size);
      added++;
      if (added % 10 === 0) { bump(); render(); }
    } catch (e) {
      console.error(e);
      failed++;
      if (e?.name === 'QuotaExceededError') { toast('Stockage plein : libère de la place sur ton iPhone', false, 'alerte'); break; }
    }
  }
  bump();
  render();
  const parts = [plural(added, 'titre ajouté', 'titres ajoutés')];
  if (skipped) parts.push(`${skipped} déjà présent${skipped > 1 ? 's' : ''}`);
  if (failed) parts.push(`${failed} en échec`);
  tt.close();
  toast(parts.join(' • '), false, 'rapport');
}

$('#file-input').addEventListener('change', (e) => {
  const files = e.target.files;
  if (files?.length) importFiles(files).finally(() => { e.target.value = ''; });
});

// ---------- Délégation des clics
const listOf = (el) => LISTS[+el.dataset.ctx] || { ids: [], src: '' };
const A = {
  play(el) { const l = listOf(el); player.playList(l.ids, +el.dataset.i, { source: l.src }); },
  'play-list'(el) { const l = listOf(el); player.playList(l.ids, 0, { shuffle: false, source: l.src }); },
  'shuffle-list'(el) { const l = listOf(el); player.playList(l.ids, -1, { shuffle: true, source: l.src }); },
  'shuffle-all'() { player.playList(lib().tracks.map((t) => t.id), -1, { shuffle: true, source: 'Toute la bibliothèque' }); },
  rediscover() {
    const ids = lib().tracks.slice().sort((a, b) => (a.plays || 0) - (b.plays || 0) || (a.lastPlayed || 0) - (b.lastPlayed || 0)).slice(0, 30).map((t) => t.id);
    player.playList(ids, -1, { shuffle: true, source: 'Redécouvrir' });
  },
  'track-menu'(el) { trackMenu(el.dataset.id, el.dataset.pl, el.dataset.pi); },
  'album-menu'(el) { albumMenu(el.dataset.id); },
  'pl-menu'(el) { plMenu(el.dataset.id); },
  'new-playlist'() { newPlaylist(); },
  nav(el) { go(el.dataset.to); },
  back() {
    if (navCount > 0) { navCount -= 2; history.back(); } else go('#/library');
  },
  import() { $('#file-input').click(); },
  'lib-tab'(el) { S.ui.libTab = el.dataset.tab; saveUI(); render(false); },
  'lib-go'(el) { S.ui.libTab = el.dataset.tab; saveUI(); go('#/library'); },
  'radio-tab'(el) { S.ui.radioTab = el.dataset.tab; saveUI(); render(false); },
  'radio-country'(el) { S.ui.radioCountry = el.dataset.cc; saveUI(); render(); },
  'radio-genre'(el) { S.ui.radioGenre = el.dataset.g; saveUI(); render(); },
  'radio-local'() { S.ui.radioLocal = !S.ui.radioLocal; saveUI(); render(); },
  'radio-search-from'(el) { S.ui.radioTab = 'search'; S.ui.radioQ = el.dataset.q; saveUI(); go('#/radio'); },
  'play-station'(el) { const list = STLISTS[+el.dataset.sctx] || []; const st = list[+el.dataset.i]; if (st) player.playStation(st, list); },
  'fav-station'(el) { const st = (STLISTS[+el.dataset.sctx] || [])[+el.dataset.i]; if (st) toggleFav(st); },
  'add-stream'() { addStream(); },
  rerender() { radioCache.clear(); render(); },
  'hide-install'() { S.ui.hideInstall = true; saveUI(); render(); },
  'np-open'() { openNP(); },
  'np-close'() { closeNP(); },
  'np-menu'() { npMenu(); },
  'np-like'() { if (player.mode === 'radio') toggleFav(player.station); else if (player.currentId) toggleLike(player.currentId); },
  'np-artist'() {
    const t = S.tracks.get(player.currentId);
    if (t?.artist) go('#/artist/' + hash(artistKeyOf(t)));
  },
  'np-queue'() { openPanel('queue'); },
  'np-lyrics'() { openPanel('lyrics'); },
  'panel-close'() { closePanel(); },
  'edit-lyrics'(el) { editLyrics(el.dataset.id); },
  toggle() { player.toggle(); },
  next() { player.next(); },
  prev() { player.prev(); },
  shuffle() { player.setShuffle(!player.shuffle); toast(player.shuffle ? 'Lecture aléatoire activée' : 'Lecture aléatoire désactivée'); },
  repeat() { player.cycleRepeat(); toast(player.repeat === 'one' ? 'Répéter ce titre' : player.repeat === 'all' ? 'Tout répéter' : 'Répétition désactivée'); },
  sleep() { sleepSheet(); },
  speed() { speedSheet(); },
  'q-jump'(el) { player.jumpTo(+el.dataset.i); },
  'q-up'(el) { const i = +el.dataset.i; player.move(i, i - 1); },
  'q-down'(el) { const i = +el.dataset.i; player.move(i, i + 1); },
  'q-remove'(el) { player.removeAt(+el.dataset.i); },
  'set-theme'(el) { setTheme(el.dataset.themeId); render(); },
  wallpaper() { $('#wall-input').click(); },
  async 'wallpaper-remove'() { await db.del('kv', 'wallpaper'); applyWallpaper(null); render(); toast('Fond d’écran retiré'); },
  async persist() {
    const ok = await navigator.storage?.persist?.();
    toast(ok ? 'Fichiers protégés' : 'iOS a refusé : installe d’abord l’appli sur l’écran d’accueil');
    render();
  },
  wipe() {
    confirmBox('Tout effacer ?', 'Tous tes titres, playlists et radios favorites seront supprimés de cet appareil.', 'Tout effacer', async () => {
      player.reset();
      await db.clearAll();
      for (const u of S.covers.values()) URL.revokeObjectURL(u);
      S.tracks.clear(); S.covers.clear(); S.coverData.clear();
      S.playlists = []; S.radioFavs = []; S.radioRecent = [];
      bump();
      render();
      toast('Bibliothèque effacée');
    });
  },
};

document.addEventListener('click', (e) => {
  const el = e.target.closest('[data-action]');
  if (!el) return;
  const fn = A[el.dataset.action];
  if (!fn) return;
  e.preventDefault();
  fn(el, e);
});
document.addEventListener('change', (e) => {
  if (e.target.dataset.change === 'sort') { S.ui.sort = e.target.value; saveUI(); render(false); }
});
document.addEventListener('visibilitychange', () => { if (document.hidden) player.save(); });
window.addEventListener('pagehide', () => player.save());

// ============================================================ Thème & fond d'écran
const THEMES = [
  { id: 'manga', name: 'Manga', sub: 'Noir & blanc, trames', color: '#f6f3ea', sw: 'radial-gradient(circle,#111 1.2px,transparent 1.6px) 0 0/6px 6px,#fff;border:2px solid #111' },
  { id: 'classic', name: 'Normal', sub: 'La 1re version', color: '#0b0b10', sw: 'linear-gradient(135deg,#7b6cff,#ff6fae)' },
  { id: 'jpop', name: 'J-pop', sub: 'Pastel & kawaii', color: '#fff5fb', sw: 'linear-gradient(135deg,#ff7ac6,#b388ff 52%,#62d6ff)' },
  { id: 'sage', name: 'Sage', sub: 'Holographique bleu', color: '#040a16', sw: 'radial-gradient(circle at 70% 40%,#4fe3ff,#0b3a6e 45%,#040a16)' },
];
function theme() {
  const t = document.documentElement.dataset.theme;
  return THEMES.some((x) => x.id === t) ? t : 'manga';
}
function setTheme(t) {
  const def = THEMES.find((x) => x.id === t) || THEMES[0];
  document.documentElement.dataset.theme = def.id;
  try { localStorage.setItem('hikaku-theme', def.id); } catch {}
  $('meta[name=theme-color]').setAttribute('content', def.color);
  toast(`Thème ${def.name} activé`, false, 'rapport');
}

let wallUrl = null;
function applyWallpaper(buf) {
  if (wallUrl) URL.revokeObjectURL(wallUrl);
  wallUrl = buf ? URL.createObjectURL(new Blob([buf], { type: 'image/jpeg' })) : null;
  $('#wall').style.backgroundImage = wallUrl ? `url("${wallUrl}")` : '';
  document.body.classList.toggle('has-wall', !!wallUrl);
  S.hasWall = !!wallUrl;
}

const wallInput = document.createElement('input');
wallInput.type = 'file';
wallInput.accept = 'image/*';
wallInput.id = 'wall-input';
wallInput.hidden = true;
document.body.appendChild(wallInput);
wallInput.addEventListener('change', async () => {
  const f = wallInput.files?.[0];
  wallInput.value = '';
  if (!f) return;
  const url = URL.createObjectURL(f);
  try {
    const img = new Image();
    img.src = url;
    await img.decode();
    const k = Math.min(1, 1600 / Math.max(img.naturalWidth, img.naturalHeight));
    const c = document.createElement('canvas');
    c.width = Math.round(img.naturalWidth * k);
    c.height = Math.round(img.naturalHeight * k);
    c.getContext('2d').drawImage(img, 0, 0, c.width, c.height);
    const b = await new Promise((r) => c.toBlob(r, 'image/jpeg', 0.85));
    const buf = await b.arrayBuffer();
    await db.put('kv', buf, 'wallpaper');
    applyWallpaper(buf);
    render();
    toast('Fond d’écran appliqué', false, 'rapport');
  } catch {
    toast('Image illisible', false, 'alerte');
  } finally {
    URL.revokeObjectURL(url);
  }
});

// Cercles magiques autour de la pochette (thème Sage)
(() => {
  const ticks = Array.from({ length: 36 }, (_, i) => i % 3
    ? `<path transform="rotate(${i * 10} 100 100)" d="M100 4.5v4"/>`
    : `<path class="fill" transform="rotate(${i * 10} 100 100)" d="M100 3l2.4 3.6L100 10.2l-2.4-3.6z"/>`).join('');
  const glyphs = Array.from({ length: 8 }, (_, i) =>
    `<path transform="rotate(${i * 45 + 22.5} 100 100)" d="M96 17h8M100 14v6M97.5 20.5l5-5"/>`).join('');
  const sq = 'M100 24L176 100L100 176L24 100Z M153.7 46.3V153.7H46.3V46.3Z';
  const dots = [[100, 24], [176, 100], [100, 176], [24, 100], [153.7, 46.3], [153.7, 153.7], [46.3, 153.7], [46.3, 46.3]]
    .map(([x, y]) => `<circle class="fill" cx="${x}" cy="${y}" r="2.2"/>`).join('');
  $('#np-orb').insertAdjacentHTML('afterbegin',
    `<svg class="ring ring-c" viewBox="0 0 200 200" aria-hidden="true"><circle cx="100" cy="100" r="99" stroke-dasharray="0.6 5"/></svg>` +
    `<svg class="ring ring-a" viewBox="0 0 200 200" aria-hidden="true"><circle cx="100" cy="100" r="96"/><circle cx="100" cy="100" r="90" stroke-dasharray="1.2 3"/><circle cx="100" cy="100" r="86"/>${ticks}${glyphs}</svg>` +
    `<svg class="ring ring-b" viewBox="0 0 200 200" aria-hidden="true"><path d="${sq}"/><circle cx="100" cy="100" r="76"/>${dots}</svg>`);
})();

$('meta[name=theme-color]').setAttribute('content', (THEMES.find((x) => x.id === theme()) || THEMES[0]).color);

// ============================================================ Démarrage
async function boot() {
  try {
    const [tracks, covers, playlists, favs, recent, ui, pstate] = await Promise.all([
      db.getAll('tracks'), db.entries('covers'), db.getAll('playlists'),
      db.get('kv', 'radioFavs'), db.get('kv', 'radioRecent'), db.get('kv', 'ui'), db.get('kv', 'player'),
    ]);
    db.get('kv', 'wallpaper').then((w) => w && applyWallpaper(w)).catch(() => {});
    for (const t of tracks) S.tracks.set(t.id, t);
    for (const [k, buf] of covers) S.covers.set(k, URL.createObjectURL(new Blob([buf], { type: 'image/jpeg' })));
    S.playlists = playlists || [];
    S.radioFavs = favs || [];
    S.radioRecent = recent || [];
    if (ui) Object.assign(S.ui, ui, { q: '' });
    bump();
    render(false);
    player.restore(pstate);
    renderPlayer();
    hideSplash();
  } catch (e) {
    console.error(e);
    hideSplash();
    $('#view').innerHTML = `<div class="empty"><h2>Oups</h2><p>Impossible d’ouvrir le stockage de l’appli. Si tu es en navigation privée, ouvre Hikaku dans un onglet normal.</p></div>`;
  }
}
const bootAt = performance.now();
function hideSplash() {
  const sp = $('#splash');
  setTimeout(() => sp.classList.add('hide'), Math.max(0, 1100 - (performance.now() - bootAt)));
}
$('#splash').addEventListener('click', () => $('#splash').classList.add('hide'));
boot();

if ('serviceWorker' in navigator && location.protocol !== 'file:') {
  navigator.serviceWorker.register('sw.js').catch(() => {});
}
