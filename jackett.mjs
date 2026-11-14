import { DatabaseSync } from 'node:sqlite';
import { readTorrent } from './torrent.mjs';
const indexers = [...new Set((process.env.JACKETT_INDEXERS ?? '').split(',')
  .map(id => id.trim()).filter(id => /^[a-z0-9_-]+$/i.test(id) && id !== 'all'))].slice(0, 24);
const apiKey = process.env.JACKETT_API_KEY;
const base = (process.env.JACKETT_URL ?? 'http://127.0.0.1:9117').replace(/\/$/, '');
const direct = (process.env.DIRECT_INDEXERS ?? 'apibay,knaben,torrentscsv,therarbg,eztvtorrent').split(',').map(id => id.trim()).filter(id => ['apibay', 'knaben', 'torrentscsv', 'therarbg', 'eztvtorrent'].includes(id));
const torzConfig = encodeURIComponent(Buffer.from(JSON.stringify({ stores: [{ c: 'p2p', t: '' }] })).toString('base64'));
const addonSources = {
  'stremthru-torz': 'https://stremthru.13377001.xyz/stremio/torz/' + torzConfig,
  torrentio: 'https://torrentio.strem.fun',
};
const enabledAddons = (process.env.P2P_ADDONS ?? 'stremthru-torz,torrentio').split(',')
  .map(id => id.trim()).filter(id => Object.hasOwn(addonSources, id));
const providers = [...new Set([
  ...direct,
  ...enabledAddons,
  ...(apiKey ? indexers : []),
])];
const db = providers.length
  ? new DatabaseSync(process.env.JACKETT_DB ?? 'jackett-index.sqlite') : null;
db?.exec('CREATE TABLE IF NOT EXISTS releases (id TEXT, indexer TEXT, updated INTEGER, streams TEXT, PRIMARY KEY(id, indexer))');
const lookup = db?.prepare('SELECT updated, streams FROM releases WHERE id = ? AND indexer = ?');
const save = db?.prepare('INSERT OR REPLACE INTO releases VALUES (?, ?, ?, ?)');
const normalize = text => text.toLowerCase().normalize('NFKD').replace(/\p{M}/gu, '')
  .replace(/[^a-z0-9]+/g, ' ').trim();

async function movieMetadata(id) {
  const response = await fetch('https://v3-cinemeta.strem.io/meta/movie/' + id + '.json', {
    signal: AbortSignal.timeout(5000),
  });
  if (!response.ok) return null;
  const { meta } = await response.json();
  const year = String(meta?.year ?? meta?.releaseInfo ?? '').match(/^\d{4}$/)?.[0];
  return meta?.name && year ? { name: meta.name, year } : null;
}

function matchesMovie(release, id, movie) {
  if (release.TrackerType !== 'public' || typeof release.Title !== 'string' || release.Seeders === 0) return false;
  const imdb = Number(String(release.Imdb ?? '').replace(/^tt/, ''));
  if (imdb > 0) return imdb === Number(id.slice(2));
  if (!movie) return false;
  const prefix = normalize(movie.name) + ' ' + movie.year;
  const title = normalize(release.Title);
  return title === prefix || title.startsWith(prefix + ' ');
}

async function resolveMagnet(release, signal) {
  if (release.MagnetUri?.startsWith('magnet:')) return release.MagnetUri;
  if (release.Link?.startsWith('magnet:')) return release.Link;
  const link = new URL(release.Link);
  const server = new URL(base);
  if (link.origin !== server.origin || !link.pathname.startsWith(server.pathname.replace(/\/$/, '') + '/dl/')) return null;
  const response = await fetch(link, { signal, redirect: 'manual' });
  if (response.ok && /^(application\/x-bittorrent|application\/octet-stream)\b/i.test(response.headers.get('content-type') ?? '') && response.body) {
    const chunks = [];
    let length = 0;
    for await (const chunk of response.body) {
      length += chunk.length;
      if (length > 4 * 1024 * 1024) return null;
      chunks.push(chunk);
    }
    const torrent = readTorrent(Buffer.concat(chunks));
    const params = new URLSearchParams({ xt: 'urn:btih:' + torrent.infoHash });
    for (const tracker of torrent.sources) params.append('tr', tracker.slice('tracker:'.length));
    return 'magnet:?' + params;
  }
  await response.body?.cancel();
  return response.status >= 300 && response.status < 400 ? response.headers.get('location') : null;
}
const pending = new Map();

function parseRelease(release, uri, provider = 'Jackett') {
  if (!uri) return null;
  const magnet = new URL(uri);
  if (magnet.protocol !== 'magnet:') return null;
  const hash = magnet.searchParams.get('xt')?.match(/^urn:btih:([a-f0-9]{40})$/i)?.[1];
  if (!hash) return null;
  const seeders = Number.isSafeInteger(release.Seeders) && release.Seeders >= 0 ? release.Seeders : null;
  const trackers = magnet.searchParams.getAll('tr').filter(url => {
    try {
      const tracker = new URL(url);
      return ['http:', 'https:', 'udp:'].includes(tracker.protocol) &&
        !tracker.username && !tracker.password && !tracker.search;
    } catch { return false; }
  });
  return {
    seeders,
    stream: {
      format: { release: release.Title, size: Number(release.Size) > 0 ? Number(release.Size) : undefined },
      infoHash: hash.toLowerCase(), name: 'Torrent Direct',
      description: [release.Title, seeders === null ? null : seeders + ' seeders', provider]
        .filter(Boolean).join(' · '),
      sources: [...new Set(trackers)].slice(0, 12).map(url => 'tracker:' + url),
    },
  };
}

const seriesNames = new Map();

export async function seriesName(id) {
  const imdb = id.split(':')[0];
  if (seriesNames.has(imdb)) return seriesNames.get(imdb);
  try {
    const response = await fetch('https://v3-cinemeta.strem.io/meta/series/' + imdb + '.json', {
      signal: AbortSignal.timeout(1000),
    });
    if (!response.ok) return null;
    const { meta } = await response.json();
    if (typeof meta?.name !== 'string') return null;
    if (seriesNames.size >= 512) seriesNames.delete(seriesNames.keys().next().value);
    seriesNames.set(imdb, meta.name);
    return meta.name;
  } catch { return null; }
}

export function matchesEpisode(stream, id, name) {
  const file = stream.behaviorHints?.filename;
  if (!file) return true;
  const marker = file.match(/\bS(\d{1,3})E(\d{1,4})(?!\d|E\d)/i);
  if (!marker) return true;
  const [, season, episode] = id.split(':');
  if (Number(marker[1]) !== Number(season) || Number(marker[2]) !== Number(episode)) return false;
  const prefix = normalize(file.slice(0, marker.index).replace(/\[[^\]]*\]/g, ''));
  if (!prefix || !name) return true;
  const title = normalize(name);
  return prefix === title || prefix.startsWith(title + ' ') || prefix.endsWith(' ' + title);
}
async function queryAddon(provider, id) {
  try {
    const type = id.includes(':') ? 'series' : 'movie';
    const response = await fetch(addonSources[provider] + '/stream/' + type + '/' + id + '.json', {
      signal: AbortSignal.timeout(5000), redirect: 'error',
    });
    if (!response.ok) return null;
    const { streams } = await response.json();
    if (!Array.isArray(streams)) return null;
    return streams.slice(0, 120).flatMap(item => {
      if (!/^[a-f0-9]{40}$/i.test(item?.infoHash ?? '') || /^0+$/.test(item.infoHash)) return [];
      const infoHash = item.infoHash.toLowerCase();
      const description = typeof item.description === 'string' ? item.description :
        typeof item.title === 'string' ? item.title : '';
      const peerCount = description.match(/(?:👤|\bseeders?[: ]+)\s*(\d+)/iu);
      const seeders = peerCount ? Number(peerCount[1]) : null;
      if (seeders === 0) return [];
      const fileIdx = Number.isSafeInteger(item.fileIdx) && item.fileIdx >= 0 ? item.fileIdx : undefined;
      const filename = typeof item.behaviorHints?.filename === 'string' ? item.behaviorHints.filename : undefined;
      const videoSize = Number.isSafeInteger(item.behaviorHints?.videoSize) ? item.behaviorHints.videoSize : undefined;
      const sources = Array.isArray(item.sources) ? item.sources.filter(source =>
        typeof source === 'string' && /^(tracker:(?:https?|udp):\/\/|dht:[a-f0-9]{40}$)/i.test(source)).slice(0, 12) : [];
      return { seeders, stream: {
        infoHash, fileIdx, sources, name: 'Torrent Direct',
        description, behaviorHints: { filename, videoSize },
        format: { release: [item.name, filename ?? description.split('\n')[0]].filter(v => typeof v === 'string').join(' ') },
      } };
    });
  } catch { return null; }
}
async function queryEztvTorrent(movie) {
  if (!movie) return null;
  const origin = 'https://eztvtorrent.co';
  const slug = normalize(movie.name).replace(/ /g, '-') + '-' + movie.year;
  if (!/^[a-z0-9-]+-\d{4}$/.test(slug)) return [];
  const signal = AbortSignal.timeout(6500);
  try {
    const search = await fetch(origin + '/search?' + new URLSearchParams({ s: movie.name }), {
      signal, redirect: 'error',
    });
    if (!search.ok) return null;
    const path = '/movie/' + slug;
    const html = await search.text();
    const found = [...html.matchAll(/href=["']([^"']+)["']/gi)]
      .some(([, href]) => href === origin + path || href === path);
    if (!found) return [];
    const detail = await fetch(origin + path, { signal, redirect: 'error' });
    if (!detail.ok) return null;
    const results = [];
    for (const [row] of (await detail.text()).matchAll(/<tr\b[^>]*>[\s\S]*?<\/tr>/gi)) {
      const uri = row.match(/href=["'](magnet:\?[^"']+)["']/i)?.[1]?.replace(/&amp;/gi, '&');
      if (!uri) continue;
      const cells = [...row.matchAll(/<td\b[^>]*>\s*([^<]+?)\s*<\/td>/gi)].map(([, value]) => value);
      const size = cells[0]?.match(/^([\d.]+)\s*(MB|GB)$/i);
      const parsed = parseRelease({
        Title: [movie.name, movie.year, cells[1]].filter(Boolean).join(' '),
        Size: size ? Math.round(Number(size[1]) * (size[2].toUpperCase() === 'GB' ? 1e9 : 1e6)) : undefined,
      }, uri, 'EZTVTorrent.co');
      if (parsed) results.push(parsed);
      if (results.length >= 20) break;
    }
    return results;
  } catch { return null; }
}
async function queryDirect(provider, id, movie) {
  if (provider === 'eztvtorrent') return queryEztvTorrent(movie);
  if (!movie) return null;
  const isBay = provider === 'apibay';
  const isCsv = provider === 'torrentscsv';
  const isRarbg = provider === 'therarbg';
  const endpoint = isBay ? 'https://apibay.org/q.php'
    : isCsv ? 'https://torrents-csv.com/service/search' : 'https://api.knaben.org/v2/search';
  const url = new URL(isRarbg
    ? 'https://therarbg.to/get-posts/order:-se:category:Movies:keywords:' +
      encodeURIComponent(normalize(movie.name) + ' ' + movie.year) + ':paginate_by:100:format:json/'
    : endpoint);
  if (!isRarbg) url.search = new URLSearchParams(isBay
    ? { q: movie.name + ' ' + movie.year, cat: '200' }
    : isCsv ? { q: movie.name + ' ' + movie.year, size: '75' }
    : { q: movie.name + ' ' + movie.year, o: 'seeders', s: '75' });
  try {
    const response = await fetch(url, { signal: AbortSignal.timeout(4000), redirect: 'error' });
    if (!response.ok) return null;
    const data = await response.json();
    const rows = isBay ? data : isCsv ? data.torrents : isRarbg ? data.results : data.hits;
    if (!Array.isArray(rows)) return null;
    return rows.slice(0, 100).flatMap(row => {
      const hash = isBay ? row.info_hash : isCsv ? row.infohash : isRarbg ? row.h : row.hash;
      const seeders = Number((isRarbg ? row.se : row.seeders) ?? 0);
      const release = { TrackerType: 'public', Title: isBay || isCsv ? row.name : isRarbg ? row.n : row.title, Seeders: seeders, Size: isCsv ? row.size_bytes : isBay ? row.size : isRarbg ? row.s : row.bytes };
      if (isRarbg) release.Imdb = String(row.i ?? '').replace(/^B/, '');
      if (isBay && /^(?:tt)?\d+$/.test(row.imdb ?? '')) release.Imdb = row.imdb;
      if (!Number.isSafeInteger(seeders) || seeders < 1 || !matchesMovie(release, id, movie) ||
          !/^[a-f0-9]{40}$/i.test(hash) || /^0+$/.test(hash)) return [];
      const fallback = 'magnet:?xt=urn:btih:' + hash;
      const supplied = typeof row.magnetUrl === 'string' ? row.magnetUrl : '';
      let uri = fallback;
      try {
        const magnet = new URL(supplied);
        if (magnet.protocol === 'magnet:' &&
            magnet.searchParams.get('xt')?.toLowerCase() === 'urn:btih:' + hash.toLowerCase()) uri = supplied;
      } catch { /* L'infohash suffit si aucun magnet valide n'est présent. */ }
      return parseRelease(release, uri, isBay ? 'Pirate Bay' : isCsv ? 'Torrents.csv' : isRarbg ? 'TheRARBG' : 'Knaben');
    });
  } catch { return null; }
}
async function query(indexer, id, metadata) {
  const start = performance.now();
  try {
    const url = new URL(base + '/api/v2.0/indexers/' + indexer + '/results');
    url.search = new URLSearchParams({ apikey: apiKey, t: 'movie', imdbid: id });
    const movie = await metadata;
    if (movie && indexer !== 'yts') url.search = new URLSearchParams({ apikey: apiKey, t: 'search', cat: '2000',
      q: movie.name, query: movie.name });
    const signal = AbortSignal.timeout(45_000);
    const response = await fetch(url, { signal, redirect: 'error' });
    if (!response.ok) throw new Error('HTTP ' + response.status);
    const { Results, Indexers } = await response.json();
    if (!Array.isArray(Results) || Indexers?.some(item => item.Status !== 2 && item.Status !== 'OK')) {
      throw new Error('Réponse invalide');
    }
    const selected = Results.filter(release => matchesMovie(release, id, movie))
      .sort((a, b) => (b.Seeders ?? -1) - (a.Seeders ?? -1)).slice(0, 20);
    const results = [];
    for (const release of selected) {
      try {
        const result = parseRelease(release, await resolveMagnet(release, signal), indexer);
        if (result) results.push(result);
      } catch { /* Une fiche indisponible ne bloque pas les autres. */ }
    }
    if (selected.length && !results.length) return null;
    console.log('Jackett', indexer, id, results.length, 'résultats', Math.round(performance.now() - start), 'ms');
    return results;
  } catch {
    console.warn('Jackett', indexer, id, 'indisponible', Math.round(performance.now() - start), 'ms');
    return null;
  }
}

const retryAfter = new Map();

export function refreshJackett(id, knownMovie) {
  if (!db || !/^tt\d+(?::\d+:\d+)?$/.test(id)) return;
  if (pending.has(id)) return pending.get(id);
  if (pending.size >= 4 || (retryAfter.get(id) ?? 0) > Date.now()) return;
  const now = Date.now();
  const candidates = id.includes(':') ? enabledAddons : providers;
  const due = candidates.filter(indexer => {
    const row = lookup.get(id, indexer);
    return !row || now - row.updated > (row.streams === '[]' ? 300_000 : 3_600_000);
  });
  if (!due.length) return;
  const metadata = id.includes(':') ? Promise.resolve(null) : knownMovie ? Promise.resolve(knownMovie) : movieMetadata(id).catch(() => null);
  const request = Promise.all(due.map(async indexer => {
    const results = enabledAddons.includes(indexer)
      ? await queryAddon(indexer, id)
      : direct.includes(indexer)
      ? await queryDirect(indexer, id, await metadata)
      : await query(indexer, id, metadata);
    if (direct.includes(indexer) || enabledAddons.includes(indexer)) {
      console.log(indexer, id, results === null ? 'indisponible' : results.length + ' résultats');
    }
    if (results === null) return;
    const previous = lookup.get(id, indexer);
    if (!results.length && previous && previous.streams !== '[]' && Date.now() - previous.updated < 86_400_000) return;
    save.run(id, indexer, Date.now(), JSON.stringify(results));
  })).catch(error => console.warn('Index Jackett:', error.code ?? error.name))
    .finally(() => {
      pending.delete(id);
      retryAfter.delete(id);
      if (retryAfter.size >= 1024) retryAfter.delete(retryAfter.keys().next().value);
      retryAfter.set(id, Date.now() + 60_000);
    });
  pending.set(id, request);
  return request;
}

export function jackettStreams(id, name) {
  if (!db) return [];
  const entries = providers.flatMap(indexer => JSON.parse(lookup.get(id, indexer)?.streams ?? '[]'));
  const available = entries.filter(entry => entry.seeders !== 0 && (!id.includes(':') || matchesEpisode(entry.stream, id, name)));
  available.sort((a, b) => (b.seeders ?? -1) - (a.seeders ?? -1));
  const distinct = new Map();
  const indexedHashes = new Set(available.filter(({ stream }) => stream.fileIdx !== undefined).map(({ stream }) => stream.infoHash));
  for (const { stream } of available) {
    if (stream.fileIdx === undefined && indexedHashes.has(stream.infoHash)) continue;
    const key = stream.infoHash + ':' + (stream.fileIdx ?? '');
    const existing = distinct.get(key);
    if (existing) {
      existing.sources = [...new Set([...existing.sources, ...stream.sources])].slice(0, 12);
    } else {
      distinct.set(key, stream);
    }
  }

  return [...distinct.values()];
}
