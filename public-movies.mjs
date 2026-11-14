const base = 'https://caching.stremio.net/publicdomainmovies.now.sh/';
const cache = new Map();
const pending = new Map();
const freshFor = 60 * 60_000;

async function cached(path, parse) {
  const stored = cache.get(path);
  if (stored && stored.expires > Date.now()) return stored.data;
  if (pending.has(path)) return pending.get(path);
  if (pending.size >= 24) return stored?.data ?? [];
  const request = (async () => {
    try {
      const response = await fetch(new URL(path, base), {
        signal: AbortSignal.timeout(2200), redirect: 'error',
      });
      if (!response.ok) throw new Error('HTTP ' + response.status);
      const data = parse(await response.json());
      cache.delete(path);
      if (cache.size >= 1024) cache.delete(cache.keys().next().value);
      cache.set(path, { data, expires: Date.now() + (data.length ? freshFor : 60_000) });
      return data;
    } catch {
      return stored?.data ?? [];
    } finally {
      pending.delete(path);
    }
  })();
  pending.set(path, request);
  return request;
}

export function publicMovies(search) {
  const extra = search ? '/search=' + encodeURIComponent(search) : '';
  return cached('catalog/movie/publicdomainmovies' + extra + '.json', ({ metas }) =>
    metas.filter(meta => /^tt\d+$/.test(meta?.id) && typeof meta.name === 'string')
      .map(({ id, name, poster, releaseInfo }) => ({ id, type: 'movie', name, poster, releaseInfo })));
}

export function publicStreams(id) {
  return cached('stream/movie/' + id + '.json', ({ streams }) =>
    streams.filter(stream => /^[a-f0-9]{40}$/i.test(stream?.infoHash) &&
      Number.isSafeInteger(stream.fileIdx) && stream.fileIdx >= 0)
      .map(({ infoHash, fileIdx, name, title, description }) => ({
        infoHash: infoHash.toLowerCase(), fileIdx, name: 'Torrent Direct',
        description: [name, description ?? title, 'Public Domain Movies'].join(' · '),
      })));
}
