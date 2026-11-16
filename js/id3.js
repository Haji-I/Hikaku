// Lecture des tags ID3 (v1, v2.2, v2.3, v2.4) + calcul de la durée d'un MP3,
// sans aucune dépendance externe.

const be32 = (b, o) => ((b[o] << 24) | (b[o + 1] << 16) | (b[o + 2] << 8) | b[o + 3]) >>> 0;
const ss32 = (b, o) => ((b[o] & 0x7f) << 21) | ((b[o + 1] & 0x7f) << 14) | ((b[o + 2] & 0x7f) << 7) | (b[o + 3] & 0x7f);
const termLen = (enc) => (enc === 1 || enc === 2 ? 2 : 1);

function unsync(b) {
  const out = new Uint8Array(b.length);
  let j = 0;
  for (let i = 0; i < b.length; i++) {
    out[j++] = b[i];
    if (b[i] === 0xff && b[i + 1] === 0x00) i++;
  }
  return out.subarray(0, j);
}

function decode(enc, b) {
  let label = 'windows-1252';
  if (enc === 1) {
    if (b[0] === 0xfe && b[1] === 0xff) { label = 'utf-16be'; b = b.subarray(2); }
    else if (b[0] === 0xff && b[1] === 0xfe) { label = 'utf-16le'; b = b.subarray(2); }
    else label = 'utf-16le';
  } else if (enc === 2) label = 'utf-16be';
  else if (enc === 3) label = 'utf-8';
  try { return new TextDecoder(label).decode(b); } catch { return ''; }
}

// Position du terminateur nul (1 octet ou 2 selon l'encodage)
function term(b, from, enc) {
  if (enc === 1 || enc === 2) {
    for (let i = from; i + 1 < b.length; i += 2) if (b[i] === 0 && b[i + 1] === 0) return i;
  } else {
    for (let i = from; i < b.length; i++) if (b[i] === 0) return i;
  }
  return b.length;
}

const cleanText = (s) => s.split('\0').map((x) => x.replace(/^﻿/, '').trim()).filter(Boolean).join(', ');

const TEXT = {
  TIT2: 'title', TT2: 'title',
  TPE1: 'artist', TP1: 'artist',
  TALB: 'album', TAL: 'album',
  TPE2: 'albumArtist', TP2: 'albumArtist',
  TRCK: 'track', TRK: 'track',
  TYER: 'year', TYE: 'year', TDRC: 'year',
};

function parseV2(b, out) {
  const ver = b[3];
  const flags = b[5];
  const size = ss32(b, 6);
  out.end = 10 + size + (flags & 0x10 ? 10 : 0);
  let tag = b.subarray(10, Math.min(b.length, 10 + size));
  if ((flags & 0x80) && ver < 4) tag = unsync(tag);
  let p = 0;
  if (flags & 0x40) p = ver === 3 ? 4 + be32(tag, 0) : ver === 4 ? ss32(tag, 0) : 0;
  const v2 = ver === 2;
  const idLen = v2 ? 3 : 4;
  const hl = v2 ? 6 : 10;
  const pics = [];

  while (p + hl <= tag.length) {
    if (tag[p] === 0) break; // padding
    const id = String.fromCharCode(...tag.subarray(p, p + idLen));
    if (!/^[A-Z0-9]+$/.test(id)) break;
    const fs = v2 ? (tag[p + 3] << 16) | (tag[p + 4] << 8) | tag[p + 5] : ver === 4 ? ss32(tag, p + 4) : be32(tag, p + 4);
    const ff = v2 ? 0 : (tag[p + 8] << 8) | tag[p + 9];
    const s = p + hl;
    const e = s + fs;
    if (fs <= 0 || e > tag.length) break;
    p = e;
    let d = tag.subarray(s, e);
    if (ver === 3 && (ff & 0xc0)) continue; // compressé / chiffré
    if (ver === 4) {
      if (ff & 0x0c) continue;
      if (ff & 0x01) d = d.subarray(4);
      if (ff & 0x02) d = unsync(d);
    }
    const key = TEXT[id];
    if (key) {
      if (!out[key]) out[key] = cleanText(decode(d[0], d.subarray(1)));
    } else if (id === 'APIC' || id === 'PIC') {
      const enc = d[0];
      let mime, type, i;
      if (id === 'APIC') {
        const me = term(d, 1, 0);
        mime = decode(0, d.subarray(1, me)).toLowerCase().trim();
        type = d[me + 1];
        i = term(d, me + 2, enc) + termLen(enc);
      } else {
        mime = decode(0, d.subarray(1, 4)).toLowerCase();
        type = d[4];
        i = term(d, 5, enc) + termLen(enc);
      }
      if (!mime.includes('/')) mime = 'image/' + (mime === 'jpg' || !mime ? 'jpeg' : mime);
      if (mime === 'image/jpg') mime = 'image/jpeg';
      const data = d.slice(i);
      if (data.length > 32) pics.push({ mime, type, data });
    } else if ((id === 'USLT' || id === 'ULT') && !out.lyrics) {
      const enc = d[0];
      const de = term(d, 4, enc);
      out.lyrics = decode(enc, d.subarray(de + termLen(enc))).replace(/\0+$/, '').replace(/\r\n?/g, '\n').trim();
    }
  }
  if (pics.length) out.picture = pics.find((x) => x.type === 3) || pics[0];
}

export function readTags(buf) {
  const b = new Uint8Array(buf);
  const out = { end: 0 };
  if (b.length > 10 && b[0] === 0x49 && b[1] === 0x44 && b[2] === 0x33) {
    try { parseV2(b, out); } catch (e) { console.warn('ID3', e); }
  }
  // ID3v1 en secours
  if (!out.title && b.length > 128) {
    const o = b.length - 128;
    if (b[o] === 0x54 && b[o + 1] === 0x41 && b[o + 2] === 0x47) {
      const s = (a, l) => decode(0, b.subarray(o + a, o + a + l)).replace(/\0[\s\S]*$/, '').trim();
      out.title ||= s(3, 30);
      out.artist ||= s(33, 30);
      out.album ||= s(63, 30);
      out.year ||= s(93, 4);
    }
  }
  if (out.track) out.track = parseInt(out.track, 10) || 0;
  if (out.year) out.year = String(out.year).slice(0, 4);
  return out;
}

// ---- Durée d'un MP3 (en-tête Xing/Info/VBRI, sinon estimation CBR)
const BR1 = [0, 32, 40, 48, 56, 64, 80, 96, 112, 128, 160, 192, 224, 256, 320];
const BR2 = [0, 8, 16, 24, 32, 40, 48, 56, 64, 80, 96, 112, 128, 144, 160];
const SR = { 3: [44100, 48000, 32000], 2: [22050, 24000, 16000], 0: [11025, 12000, 8000] };

function frameHeader(b, i) {
  if (b[i] !== 0xff || (b[i + 1] & 0xe0) !== 0xe0) return null;
  const v = (b[i + 1] >> 3) & 3;
  const layer = (b[i + 1] >> 1) & 3;
  if (v === 1 || layer !== 1) return null; // MPEG Layer III uniquement
  const bi = b[i + 2] >> 4;
  const si = (b[i + 2] >> 2) & 3;
  if (bi === 0 || bi === 15 || si === 3) return null;
  const br = (v === 3 ? BR1 : BR2)[bi];
  const sr = SR[v][si];
  const spf = v === 3 ? 1152 : 576;
  const len = Math.floor(((spf / 8) * br * 1000) / sr) + ((b[i + 2] >> 1) & 1);
  return { v, br, sr, spf, len, mono: b[i + 3] >> 6 === 3 };
}

export function mp3Duration(buf, start = 0) {
  const b = buf instanceof Uint8Array ? buf : new Uint8Array(buf);
  const lim = Math.min(b.length - 4, start + 262144);
  const at = (o, s) => String.fromCharCode(b[o], b[o + 1], b[o + 2], b[o + 3]) === s;
  for (let i = start; i < lim; i++) {
    const h = frameHeader(b, i);
    if (!h) continue;
    const n = i + h.len;
    if (n + 4 <= b.length && !frameHeader(b, n)) continue;
    const side = h.v === 3 ? (h.mono ? 17 : 32) : h.mono ? 9 : 17;
    const x = i + 4 + side;
    if (x + 12 < b.length && (at(x, 'Xing') || at(x, 'Info'))) {
      const fl = be32(b, x + 4);
      if (fl & 1) {
        const frames = be32(b, x + 8);
        if (frames) return (frames * h.spf) / h.sr;
      }
    }
    const vb = i + 36;
    if (vb + 18 < b.length && at(vb, 'VBRI')) {
      const frames = be32(b, vb + 14);
      if (frames) return (frames * h.spf) / h.sr;
    }
    let end = b.length;
    if (end > 128 && b[end - 128] === 0x54 && b[end - 127] === 0x41 && b[end - 126] === 0x47) end -= 128;
    return ((end - i) * 8) / (h.br * 1000);
  }
  return 0;
}
