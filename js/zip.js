// Lecture d'archives .zip sans dépendance : on lit seulement l'index de
// l'archive, puis chaque fichier à la demande (pas besoin de tout charger
// en mémoire, même pour un gros dossier de musique).

const u16 = (dv, o) => dv.getUint16(o, true);
const u32 = (dv, o) => dv.getUint32(o, true);

export const isZip = (f) => /\.zip$/i.test(f.name) || /zip/i.test(f.type);

export async function listZip(file) {
  const tailStart = Math.max(0, file.size - 65557);
  const tail = new Uint8Array(await file.slice(tailStart).arrayBuffer());
  let eocd = -1;
  for (let i = tail.length - 22; i >= 0; i--) {
    if (tail[i] === 0x50 && tail[i + 1] === 0x4b && tail[i + 2] === 0x05 && tail[i + 3] === 0x06) { eocd = i; break; }
  }
  if (eocd < 0) throw new Error('Archive zip illisible');
  const ev = new DataView(tail.buffer, eocd);
  const count = u16(ev, 10);
  const cdSize = u32(ev, 12);
  const cdOff = u32(ev, 16);
  if (cdOff === 0xffffffff) throw new Error('Archive trop grosse (zip64)');
  const cd = new Uint8Array(await file.slice(cdOff, cdOff + cdSize).arrayBuffer());
  const cv = new DataView(cd.buffer);
  const dec = new TextDecoder('utf-8');
  const out = [];
  let p = 0;
  for (let n = 0; n < count && p + 46 <= cd.length; n++) {
    if (u32(cv, p) !== 0x02014b50) break;
    const method = u16(cv, p + 10);
    const csize = u32(cv, p + 20);
    const usize = u32(cv, p + 24);
    const nl = u16(cv, p + 28);
    const el = u16(cv, p + 30);
    const cl = u16(cv, p + 32);
    const lho = u32(cv, p + 42);
    const path = dec.decode(cd.subarray(p + 46, p + 46 + nl));
    p += 46 + nl + el + cl;
    const name = path.split('/').pop();
    // dossiers, fichiers cachés et métadonnées macOS ignorés
    if (!name || path.endsWith('/') || path.startsWith('__MACOSX/') || name.startsWith('._') || name.startsWith('.')) continue;
    out.push({ path, name, method, csize, usize, lho });
  }
  return out;
}

export async function readZipEntry(file, e, type = '') {
  const lh = new DataView(await file.slice(e.lho, e.lho + 30).arrayBuffer());
  if (u32(lh, 0) !== 0x04034b50) throw new Error('Entrée zip invalide');
  const start = e.lho + 30 + u16(lh, 26) + u16(lh, 28);
  const raw = file.slice(start, start + e.csize);
  let blob;
  if (e.method === 0) blob = raw;
  else if (e.method === 8) {
    if (typeof DecompressionStream === 'undefined') throw new Error('Mets à jour iOS pour importer des .zip');
    blob = await new Response(raw.stream().pipeThrough(new DecompressionStream('deflate-raw'))).blob();
  } else throw new Error('Compression non prise en charge');
  return new File([blob], e.name, { type });
}
