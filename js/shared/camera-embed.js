export function normalizeRtspEmbedUrl(value) {
  const input = String(value || '').trim();
  if (!input) return '';

  let url;
  try {
    url = new URL(input);
  } catch {
    return '';
  }

  if (url.protocol !== 'https:' || url.hostname !== 'rtsp.me' || url.username || url.password) {
    return '';
  }

  if (url.search || url.hash) {
    return '';
  }

  const match = url.pathname.match(/^\/embed\/([A-Za-z0-9_-]+)\/?$/);
  if (!match) {
    return '';
  }

  return `https://rtsp.me/embed/${match[1]}/`;
}

export function isValidRtspEmbedUrl(value) {
  return Boolean(normalizeRtspEmbedUrl(value));
}
