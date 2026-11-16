// Radios du monde entier via l'annuaire libre radio-browser.info
const HOSTS = ['de1', 'nl1', 'at1', 'de2', 'fi1'].map((h) => `https://${h}.api.radio-browser.info`);
let best = null;

async function api(path, params = {}) {
  const qs = new URLSearchParams({ hidebroken: 'true', ...params }).toString();
  const order = best ? [best, ...HOSTS.filter((h) => h !== best)] : [...HOSTS].sort(() => Math.random() - 0.5);
  let lastErr;
  for (const h of order) {
    const ctl = new AbortController();
    const to = setTimeout(() => ctl.abort(), 7000);
    try {
      const r = await fetch(`${h}/json/${path}?${qs}`, { signal: ctl.signal });
      if (!r.ok) throw new Error('HTTP ' + r.status);
      const j = await r.json();
      best = h;
      return j;
    } catch (e) {
      lastErr = e;
    } finally {
      clearTimeout(to);
    }
  }
  throw lastErr || new Error('Réseau indisponible');
}

// L'iPhone refuse les flux "http://" dans une page sécurisée : on garde le https.
function clean(list) {
  const seen = new Set();
  const out = [];
  for (const s of list || []) {
    const url = (s.url_resolved || s.url || '').trim();
    if (!url.startsWith('https://')) continue;
    const name = (s.name || '').trim().replace(/\s+/g, ' ');
    if (!name) continue;
    const k = name.toLowerCase();
    if (seen.has(k)) continue;
    seen.add(k);
    out.push({
      id: s.stationuuid,
      name,
      url,
      favicon: (s.favicon || '').startsWith('https://') ? s.favicon : '',
      tags: (s.tags || '').split(',').map((t) => t.trim()).filter(Boolean).slice(0, 3).join(', '),
      country: s.countrycode || '',
      bitrate: s.bitrate || 0,
      codec: s.codec || '',
    });
  }
  return out;
}

const common = { order: 'clickcount', reverse: 'true', limit: '100' };

export const top = (cc) =>
  (cc ? api(`stations/bycountrycodeexact/${encodeURIComponent(cc)}`, common) : api('stations/search', common)).then(clean);

export const search = (q) => api('stations/search', { ...common, name: q, limit: '60' }).then(clean);

export const byTag = (tag, cc) =>
  api('stations/search', { ...common, tag, ...(cc ? { countrycode: cc } : {}), limit: '80' }).then(clean);

// Signale l'écoute à l'annuaire (aide le classement des stations populaires)
export const click = (id) => {
  if (id && !String(id).startsWith('custom')) api(`url/${encodeURIComponent(id)}`).catch(() => {});
};

export const GENRES = [
  ['pop', 'Pop'], ['hiphop', 'Rap / Hip-hop'], ['rnb', 'R&B'], ['rock', 'Rock'],
  ['electronic', 'Électro'], ['dance', 'Dance'], ['house', 'House'], ['lofi', 'Lo-fi'],
  ['chillout', 'Chill'], ['jazz', 'Jazz'], ['soul', 'Soul'], ['classical', 'Classique'],
  ['reggae', 'Reggae'], ['afrobeat', 'Afro'], ['latin', 'Latino'], ['kpop', 'K-pop'],
  ['metal', 'Metal'], ['80s', 'Années 80'], ['90s', 'Années 90'], ['news', 'Infos'], ['talk', 'Talk'],
];

export const COUNTRIES = [
  ['FR', 'France'], ['BE', 'Belgique'], ['CH', 'Suisse'], ['CA', 'Canada'], ['MA', 'Maroc'],
  ['DZ', 'Algérie'], ['TN', 'Tunisie'], ['SN', 'Sénégal'], ['CI', 'Côte d’Ivoire'],
  ['US', 'États-Unis'], ['GB', 'Royaume-Uni'], ['ES', 'Espagne'], ['IT', 'Italie'],
  ['DE', 'Allemagne'], ['JP', 'Japon'], ['', 'Monde'],
];
