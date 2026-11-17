/**
 * Route external trend photos through the same-origin image proxy
 * (GET /api/image?url=). Publisher origins (alamy, gala, unsplash, ...)
 * routinely refuse direct browser loads — hotlink guards, TLS quirks,
 * timeouts — which surfaced as ERR_CONNECTION_TIMED_OUT /
 * ERR_SSL_PROTOCOL_ERROR with broken thumbnails. Local /videos art,
 * data: and blob: URLs pass through untouched.
 */
export function proxiedImg(url?: string | null): string {
  if (!url) return '';
  const u = String(url).trim();
  if (!u) return '';
  if (u.startsWith('data:') || u.startsWith('blob:') || u.startsWith('/')) return u;
  if (!/^https?:\/\//i.test(u)) return u;
  return `/api/image?url=${encodeURIComponent(u)}`;
}
