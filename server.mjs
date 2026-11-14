import { formatStream } from './stream-format.mjs';
import { createServer } from 'node:http';
import { readFile } from 'node:fs/promises';
import { resolve, dirname } from 'node:path';
import { readTorrent } from './torrent.mjs';
import { publicMovies, publicStreams } from './public-movies.mjs';
import { jackettStreams, refreshJackett, seriesName } from './jackett.mjs';

const manifest = {
  id: 'org.selfhosted.directtorrent', version: '1.10.2', name: 'Torrent Direct',
  description: 'Index BitTorrent auto-hébergé', resources: ['stream', { name: 'meta', types: ['movie'], idPrefixes: ['tt1254207'] }, 'catalog'],
  types: ['movie', 'series'], catalogs: [{ type: 'movie', id: 'torrent-direct-demo', name: 'Torrent Direct', extra: [{ name: 'search' }] }], idPrefixes: ['tt'],
};
const demo = { id: 'tt1254207', type: 'movie', name: 'Big Buck Bunny', releaseInfo: '2008',
  poster: 'https://archive.org/services/img/BigBuckBunny_124' };
const mediaId = { movie: /^tt\d+$/, series: /^tt\d+:\d+:\d+$/ };
const configPath = resolve(process.env.CATALOG ?? 'catalog.json');
const torrentLimit = 4 * 1024 * 1024;
const maxResults = 120;
let index = new Map();
let loaded = false;
let refreshing = false;
let previous = new Map();

async function torrentBytes(source) {
  if (!/^https:\/\//i.test(source)) return readFile(resolve(dirname(configPath), source));
  const response = await fetch(source, { signal: AbortSignal.timeout(12_000) });
  if (!response.ok || !response.body) throw new Error('HTTP ' + response.status);
  let total = 0;
  const chunks = [];
  for await (const chunk of response.body) {
    total += chunk.length;
    if (total > torrentLimit) throw new Error('Torrent trop volumineux');
    chunks.push(chunk);
  }
  return Buffer.concat(chunks);
}

function addEntries(index, entry, torrent) {
  for (const [id, path] of Object.entries(entry.media)) {
    if (!mediaId.movie.test(id) && !mediaId.series.test(id)) throw new Error('ID invalide ' + id);
    const fileIdx = torrent.files.findIndex(file => file.filename === path);
    const file = torrent.files[fileIdx];
    if (!file || !/\.(mkv|mp4|webm|avi|mov|m4v)$/i.test(path)) {
      throw new Error('Vidéo introuvable dans le torrent pour ' + id);
    }
    const variants = index.get(id) ?? [];
    const size = (file.size / 1024 ** 2).toFixed(0) + ' MiB';
    variants.push({
      score: Number.isFinite(entry.priority) ? entry.priority : 0,
      stream: {
        name: manifest.name, description: [entry.label, path, size].filter(Boolean).join('\n'),
        infoHash: torrent.infoHash, fileIdx, sources: torrent.sources,
        behaviorHints: { filename: path.split('/').at(-1), videoSize: file.size },
      },
    });
    index.set(id, variants);
  }
}

async function refresh() {
  if (refreshing) return;
  refreshing = true;
  try {
    const entries = JSON.parse(await readFile(configPath, 'utf8'));
    if (!Array.isArray(entries)) throw new Error('Le catalogue doit être un tableau');
    const next = new Map();
    const parsed = new Map();
    let failures = 0;
    for (let start = 0; start < entries.length; start += 8) {
      const group = entries.slice(start, start + 8);
      await Promise.all(group.map(async entry => {
        try {
          const source = entry.torrent;
          if (typeof source !== 'string') throw new Error('Source torrent manquante');
          if (!parsed.has(source)) {
            parsed.set(source, torrentBytes(source).then(bytes => {
              if (bytes.length > torrentLimit) throw new Error('Torrent trop volumineux');
              return readTorrent(bytes);
            }).catch(error => {
              if (!previous.has(source)) throw error;
              console.warn('Source indisponible, réutilisation du torrent précédent');
              return previous.get(source);
            }));
          }
          const torrent = await parsed.get(source);
          const staged = new Map();
          addEntries(staged, entry, torrent);
          for (const [id, variants] of staged) {
            next.set(id, (next.get(id) ?? []).concat(variants));
          }
        } catch (error) {
          failures++;
          console.warn('Entrée ignorée:', error.message);
        }
      }));
    }
    if (entries.length && !next.size) throw new Error('Aucun titre indexé');
    for (const [id, variants] of next) {
      variants.sort((a, b) => b.score - a.score || a.stream.infoHash.localeCompare(b.stream.infoHash) ||
        a.stream.fileIdx - b.stream.fileIdx || a.stream.description.localeCompare(b.stream.description));
      const unique = new Map();
      for (const { stream } of variants) {
        const key = stream.infoHash + ':' + stream.fileIdx;
        if (!unique.has(key)) unique.set(key, stream);
      }
      next.set(id, [...unique.values()].slice(0, maxResults));
    }
    previous = new Map();
    for (const [source, promise] of parsed) {
      const torrent = await promise.catch(() => undefined);
      if (torrent) previous.set(source, torrent);
    }
    index = next;
    loaded = true;
    console.log('Titres indexés:', index.size, '| Entrées ignorées:', failures);
  } catch (error) {
    console.error('Actualisation impossible:', error.message);
  } finally {
    refreshing = false;
  }
}

const server = createServer(async (request, response) => {
  function json(status, body, cache = 'no-store') {
    response.writeHead(status, {
      'content-type': 'application/json; charset=utf-8',
      'access-control-allow-origin': '*', 'cache-control': cache,
    });
    response.end(JSON.stringify(body));
  }
  const path = request.url.split('?')[0];
  if (request.method !== 'GET') return json(405, { error: 'GET requis' });
  if (path === '/manifest.json') return json(200, manifest);
  if (path === '/health') return json(loaded ? 200 : 503, { ready: loaded, titles: index.size });
  const catalog = /^\/catalog\/movie\/torrent-direct-demo(?:\/search=([^/]{1,600}))?\.json$/.exec(path);
  if (catalog) {
    let search;
    try { search = decodeURIComponent(catalog[1] ?? '').trim().slice(0, 120); }
    catch { return json(400, { metas: [] }); }
    const metas = await publicMovies(search);
    const showDemo = index.has(demo.id) && demo.name.toLowerCase().includes(search.toLowerCase());
    const distinct = new Map(metas.map(meta => [meta.id, meta]));
    if (showDemo) return json(200, { metas: [demo, ...metas.filter(meta => meta.id !== demo.id)] });
    return json(200, { metas: [...distinct.values()] });
  }
  if (path === '/meta/movie/tt1254207.json') return json(200, { meta: demo });
  const match =  /^\/stream\/(movie|series)\/([^/]{1,100})\.json$/.exec(path);
  if (!match) return json(404, { error: 'Route inconnue' });
  let id;
  try { id = decodeURIComponent(match[2]); } catch { return json(400, { error: 'ID invalide' }); }
  if (!mediaId[match[1]].test(id)) return json(200, { streams: [] });
  if (!loaded) return json(503, { streams: [] });
  const local = index.get(id) ?? [];
  let jackett = [];
  let remote = [];
  {
    const knownMovie = id === demo.id ? { name: demo.name, year: demo.releaseInfo } : undefined;
    const refresh = refreshJackett(id, knownMovie);
    jackett = jackettStreams(id);
    const publicResults = !local.length && match[1] === 'movie' ? publicStreams(id) : [];
    if (!local.length && !jackett.length && refresh) {
      const deadline = Date.now() + 1800;
      while (Date.now() < deadline && !jackett.length) {
        const finished = await Promise.race([
          refresh.then(() => true),
          new Promise(resolve => setTimeout(resolve, Math.min(150, deadline - Date.now()), false)),
        ]);
        jackett = jackettStreams(id);
        if (finished) break;
      }
    }
    remote = await publicResults;
    jackett = jackettStreams(id, match[1] === 'series' ? await seriesName(id) : undefined);
  }
  const knownFiles = new Set([...local, ...remote].map(stream => stream.infoHash));
  const extra = jackett.filter(stream => stream.fileIdx !== undefined || !knownFiles.has(stream.infoHash));
  const distinct = new Map([...extra, ...local, ...remote].map(stream =>
    [stream.infoHash + ':' + stream.fileIdx, stream]));
  const formatted = [...distinct.values()].map(stream => formatStream(stream, 'REELO'));
  const frenchRank = stream => {
    const languages = stream.description.match(/\|LANG=([^|]*)\|/)?.[1].split(',') ?? [];
    if (languages.includes('French')) return 0;
    if (languages.includes('VOSTFR')) return 1;
    if (languages.includes('Multi')) return 2;
    return 3;
  };
  const streams = formatted.sort((a, b) => frenchRank(a) - frenchRank(b)).slice(0, maxResults);
  return json(200, { streams }, streams.length ? 'public, max-age=60' : 'no-store');
});

server.listen(Number(process.env.PORT ?? 7000), process.env.BIND ?? '127.0.0.1');
void refresh();
setInterval(refresh, 15 * 60_000).unref();




async function prefillJackett() {
  const ids = (process.env.JACKETT_PREFILL ?? '').split(',').map(id => id.trim()).filter(Boolean);
  for (const id of ids) {
    await refreshJackett(id, id === demo.id ? { name: demo.name, year: demo.releaseInfo } : undefined);
  }
}
void prefillJackett();
setInterval(prefillJackett, 15 * 60_000).unref();
