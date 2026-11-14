import { createHmac, timingSafeEqual } from 'node:crypto';

const key = process.env.TORBOX_API_KEY?.trim();
const secret = process.env.TORBOX_ACCESS_TOKEN?.trim();
const origin = process.env.TORBOX_PUBLIC_ORIGIN?.trim();
const api = 'https://api.torbox.app/v1/api/torrents/';
const hashPattern = /^[a-f0-9]{40}$/;
const video = /\.(?:mkv|mp4|m4v|avi|webm|mov|ts)$/i;
const pending = new Map();

export const privatePrefix = key && /^[a-f0-9]{32,128}$/i.test(secret ?? '') &&
  /^https:\/\/[a-z0-9.-]+(?::\d+)?$/i.test(origin ?? '') ? '/torbox/' + secret : null;

async function call(route, params, body) {
  const url = new URL(route, api);
  url.search = new URLSearchParams(params);
  const response = await fetch(url, {
    method: body ? 'POST' : 'GET', body, redirect: 'error',
    headers: { Authorization: 'Bearer ' + key }, signal: AbortSignal.timeout(6000),
  });
  if (!response.ok) throw new Error('TorBox HTTP ' + response.status);
  const result = await response.json();
  if (!result.success) throw new Error('TorBox a refusé la requête');
  return result.data;
}

function sign(ticket) {
  return createHmac('sha256', secret).update(ticket).digest('base64url');
}

function fileFor(files, id, filename) {
  const basename = value => String(value ?? '').split(/[\\/]/).at(-1).toLowerCase();
  const videos = files.filter(file => video.test(file.name));
  const [, season, episode] = id.split(':');
  const exact = filename && videos.filter(file => basename(file.name) === basename(filename));
  if (exact?.length === 1 && basename(exact[0].name) === basename(filename)) {
    const marker = basename(exact[0].name).match(/s(\d+)e(\d+)/i);
    if (season && marker && (Number(marker[1]) !== Number(season) || Number(marker[2]) !== Number(episode))) return undefined;
    return exact[0];
  }
  if (!season) return videos.length === 1 ? videos[0] : undefined;
  const marker = new RegExp('(?:^|[^a-z0-9])s0*' + Number(season) + 'e0*' +
    Number(episode) + '(?![0-9]|e[0-9])', 'i');
  const matches = videos.filter(file => marker.test(basename(file.name)));
  return matches.length === 1 ? matches[0] : undefined;
}

export async function torboxStreams(streams, id) {
  const hashes = [...new Set(streams.map(stream => stream.infoHash).filter(hash => hashPattern.test(hash)))];
  if (!hashes.length) return [];
  const cached = new Map();
  for (let i = 0; i < hashes.length; i += 75) {
    const batch = hashes.slice(i, i + 75);
    const results = await call('checkcached', { hash: batch.join(','), format: 'object', list_files: 'true' });
    const entries = Array.isArray(results) ? Object.fromEntries(results.map(item => [item.hash, item])) : results;
    for (const hash of batch) {
      if (entries && Object.hasOwn(entries, hash) && Array.isArray(entries[hash]?.files)) {
        cached.set(hash, entries[hash].files);
      }
    }
  }
  return streams.flatMap(stream => {
    const file = fileFor(cached.get(stream.infoHash) ?? [], id, stream.behaviorHints?.filename);
    if (!file) return [];
    const ticket = Buffer.from(JSON.stringify({
      hash: stream.infoHash, id, filename: file.name, expires: Date.now() + 3600_000,
    })).toString('base64url');
    const { infoHash, fileIdx, sources, ...playable } = stream;
    return [{
      ...playable, name: 'REELO', cached: true,
      behaviorHints: { ...stream.behaviorHints, filename: file.name.split(/[\\/]/).at(-1), videoSize: file.size },
      url: origin + privatePrefix + '/play/' + ticket + '.' + sign(ticket),
    }];
  });
}

async function resolve({ hash, id, filename }) {
  const form = new FormData();
  form.set('magnet', 'magnet:?xt=urn:btih:' + hash);
  form.set('add_only_if_cached', 'true');
  form.set('allow_zip', 'false');
  let torrentId;
  try {
    torrentId = (await call('createtorrent', {}, form))?.torrent_id;
  } catch {
    const library = await call('mylist', { files: 'false' });
    torrentId = library?.find?.(torrent => torrent.hash === hash)?.id;
  }
  if (!Number.isSafeInteger(torrentId)) throw new Error('Torrent indisponible');
  const torrent = await call('mylist', { id: torrentId });
  const file = fileFor(torrent?.files ?? [], id, filename);
  if (!Number.isSafeInteger(file?.id)) throw new Error('Fichier introuvable');
  const link = new URL(await call('requestdl', {
    token: key, torrent_id: torrentId, file_id: file.id, redirect: 'false',
  }));
  if (link.protocol !== 'https:' || link.href.includes(key)) throw new Error('Lien TorBox invalide');
  return link.href;
}

export async function torboxPlayback(path) {
  const match = /^\/play\/([\w-]{1,2048})\.([\w-]{43})$/.exec(path);
  if (!match || !timingSafeEqual(Buffer.from(match[2]), Buffer.from(sign(match[1])))) return null;
  const payload = JSON.parse(Buffer.from(match[1], 'base64url'));
  if (payload.expires < Date.now() || !hashPattern.test(payload.hash)) return null;
  const request = pending.get(match[1]) ?? resolve(payload).finally(() => pending.delete(match[1]));
  pending.set(match[1], request);
  return request;
}
