const pick = (value, pattern) => value.match(pattern)?.[0] ?? '';

export function formatStream(stream, addonName) {
  const { format = {}, cached = false, ...result } = stream;
  const lines = (stream.description ?? '').split('\n');
  const parts = lines[0].split(' · ');
  const label = format.release ?? parts[0];
  const filename = stream.behaviorHints?.filename ?? format.filename ??
    (parts.at(-1) === 'Public Domain Movies' ? '' : label);
  const name = [label, filename].join(' ');
  const tokens = name.replace(/[._]/g, ' ');
  const resolution = pick(tokens, /\b(?:2160p|1080[pi]|720p|576[pi]|480p|360p|4K)\b/i).toLowerCase().replace(/^4k$/, '2160p');
  const quality = pick(tokens, /\b(?:WEB[ -]?DL|WEB[ -]?Rip|Blu[ -]?Ray|BDRip|BRRip|HDTV|DVD[ -]?Rip|REMUX|HDTS|HDCAM)\b/i);
  const encode = pick(tokens, /\b(?:x26[45]|h[ -]?26[45]|HEVC|AVC|AV1|VP9|XviD)\b/i);
  const languages = [
    [/\b(?:VFF|VFQ|VFI|TRUE[ -]?FRENCH|FRENCH(?![ -]+SUBS?\b)|VF)\b/i, 'French'],
    [/\b(?:ENGLISH|ENG)\b/i, 'English'],
    [/\b(?:VOSTFR|SUBFRENCH|FRENCH[ -]SUBS?)\b/i, 'VOSTFR'],
    [/\b(?:MULTI|DUAL AUDIO)\b/i, 'Multi'],
  ].filter(([pattern]) => pattern.test(tokens)).map(([, value]) => value);
  const visual = [...new Set((tokens.match(/\b(?:HDR10\+|HDR10|HDR|Dolby Vision|DoVi|10[ -]?bit|3D)(?!\w)/gi) ?? []).map(tag => tag.toUpperCase()))];
  const audio = [...new Set((tokens.match(/\b(?:DTS[ -]?HD(?: MA)?|DTS[ -]?X|DTS|TrueHD|Atmos|DDP|DD\+|AAC|FLAC|AC3|EAC3)(?!\w)/gi) ?? []).map(tag => tag.toUpperCase()))];
  const size = stream.behaviorHints?.videoSize ?? format.size;
  const group = filename.replace(/\.(?:mkv|mp4|avi|webm|m4v|mov)$/i, '')
    .match(/-(\w{2,24})$/)?.[1] ?? '';
  const fields = {
    RES: resolution, Q: quality, ENC: encode, BR: '', SIZE: size, DUR: '',
    LANG: languages.join(','), VT: visual.join(','), AT: audio.join(','),
    GRP: group, ADDON: addonName, CACHED: cached ? '1' : '0', FILE: filename,
  };
  result.description = Object.entries(fields).map(([key, value]) =>
    key + '=' + String(value ?? '').replace(/[|\r\n]/g, ' ')).join('|');
  return result;
}
