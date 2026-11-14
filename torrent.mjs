import { createHash } from 'node:crypto';

export function readTorrent(bytes) {
  let offset = 0;
  let infoHash;
  function read(depth = 0) {
    if (depth > 32 || offset >= bytes.length) throw new Error('Bencode invalide');
    const marker = bytes[offset];
    if (marker === 100 || marker === 108) {
      offset++;
      const dictionary = marker === 100;
      const value = dictionary ? Object.create(null) : [];
      while (bytes[offset] !== 101) {
        if (dictionary) {
          const key = read(depth + 1);
          if (!Buffer.isBuffer(key)) throw new Error('Clé bencode invalide');
          const start = offset;
          value[key.toString()] = read(depth + 1);
          if (depth === 0 && key.toString() === 'info') {
            if (infoHash) throw new Error('Dictionnaire info dupliqué');
            infoHash = createHash('sha1').update(bytes.subarray(start, offset)).digest('hex');
          }
        } else {
          value.push(read(depth + 1));
        }
      }
      offset++;
      return value;
    }
    const integer = marker === 105;
    const start = offset + Number(integer);
    const end = bytes.indexOf(integer ? 101 : 58, start);
    const digits = bytes.toString('ascii', start, end);
    if (end < 0 || !/^-?\d+$/.test(digits)) throw new Error('Longueur ou entier invalide');
    const number = Number(digits);
    offset = end + 1;
    if (integer) return number;
    if (!Number.isSafeInteger(number) || number < 0 || offset + number > bytes.length) {
      throw new Error('Chaîne bencode invalide');
    }
    const value = bytes.subarray(offset, offset + number);
    offset += number;
    return value;
  }
  const torrent = read();
  const info = torrent.info;
  if (!infoHash || offset !== bytes.length || !Buffer.isBuffer(info?.pieces) ||
      !Buffer.isBuffer(info.name)) throw new Error('Torrent BitTorrent v1 invalide');
  if (info.private === 1) throw new Error('Torrent privé exclu');
  const files = info.files
    ? info.files.map(file => ({ filename: file.path.map(String).join('/'), size: file.length }))
    : [{ filename: info.name.toString(), size: info.length }];
  const trackers = [torrent.announce, ...(torrent['announce-list'] ?? []).flat()]
    .filter(Buffer.isBuffer).map(String).filter(url => /^(https?|udp):\/\//i.test(url));
  return { infoHash, files, sources: [...new Set(trackers)].map(url => 'tracker:' + url) };
}
