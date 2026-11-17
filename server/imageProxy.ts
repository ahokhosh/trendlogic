import dns from 'dns';
import net from 'net';

// ---------------------------------------------------------------------------
// Server-side image proxy: trend photos are hotlinked to publisher origins
// (alamy, gala, unsplash, ...) that often refuse direct browser loads
// (hotlink guards, TLS quirks, geo/timeouts -> ERR_CONNECTION_TIMED_OUT /
// ERR_SSL_PROTOCOL_ERROR in the console and broken thumbnails). Fetching
// server-side with a real browser UA + timeout + caching fixes the UI and
// keeps the client off those origins entirely.
//
// Safety: public read-only endpoint (the login-free broadcast scene needs
// it too) — http(s) URLs only, every hop (initial + up to 3 manual
// redirects) is DNS-checked against private/loopback/link-local ranges,
// content must be image/*, max 8 MB, timeout + 1 retry, small TTL cache.
// Every failure carries a `stage` (dns/fetch/status/content-type/size) so a
// 502 body tells exactly which hop failed instead of guessing.
// ---------------------------------------------------------------------------

const FETCH_TIMEOUT_MS = 18000;
const MAX_BYTES = 8 * 1024 * 1024;
const MAX_REDIRECTS = 3;
const CACHE_TTL_MS = 10 * 60 * 1000;
const CACHE_MAX = 60;

export type ImageProxyStage = 'dns' | 'fetch' | 'timeout' | 'redirect' | 'status' | 'content-type' | 'size' | 'body';

// Per-host cooldown: origins answering 403/410 (hotlink guards like squawka)
// keep refusing, so stop offering their URLs for a while instead of burning
// every story on them. Timeouts/5xx stay retryable (transient). In-memory:
// a restart simply retries — never a hard ban.
const hostCooldown = new Map<string, number>();
const HOST_COOLDOWN_MS = 30 * 60 * 1000;

function hostOf(url: string): string {
  try {
    return new URL(String(url || '')).hostname.toLowerCase();
  } catch {
    return '';
  }
}

/** Record an origin refusal (exported as a diagnostics/test hook; the live
 *  fetch path calls it on every non-OK status). In-memory hint only. */
export function noteHostStatus(host: string, status: number): void {
  if (!host) return;
  if (status === 403 || status === 410) {
    hostCooldown.set(String(host).toLowerCase(), Date.now() + HOST_COOLDOWN_MS);
  }
}

/** True while this host recently refused us (403/410) — pick another photo. */
export function isHostCooling(hostOrUrl: string): boolean {
  const h = String(hostOrUrl || '').includes('://') ? hostOf(hostOrUrl) : String(hostOrUrl || '').toLowerCase();
  if (!h) return false;
  const until = hostCooldown.get(h);
  if (!until) return false;
  if (until <= Date.now()) {
    hostCooldown.delete(h);
    return false;
  }
  return true;
}

/** Google-hosted thumbnails (gstatic / googleusercontent) come straight off
 *  Google's own CDN: fast, reliable, hotlink-friendly. Single home for URL
 *  policy — every selection in every service funnels through here. */
export function isGoogleHosted(u: string): boolean {
  try {
    const h = new URL(String(u || '')).hostname.toLowerCase();
    return h === 'gstatic.com' || h.endsWith('.gstatic.com') ||
      h === 'googleusercontent.com' || h.endsWith('.googleusercontent.com');
  } catch {
    return false;
  }
}

/** Unsplash stock is banned outright: never any trend's photo. */
export function isBannedPhotoHost(u: string): boolean {
  try {
    const h = new URL(String(u || '')).hostname.toLowerCase();
    return h === 'unsplash.com' || h.endsWith('.unsplash.com');
  } catch {
    return true;
  }
}

/** Stable reorder: Google-hosted first, banned stock dropped, rest in order. */
export function googleFirst(urls: (string | undefined)[]): string[] {
  const clean = [...new Set(
    (urls || []).filter((u): u is string => !!u && u.startsWith('http') && !isBannedPhotoHost(u))
  )];
  return [...clean.filter(isGoogleHosted), ...clean.filter(u => !isGoogleHosted(u))];
}

/** First playable URL: Google-first, skipping hosts under cooldown (recent
 *  403/410). '' = nothing playable (honest fallback downstream). */
export function pickPlayableImage(urls: (string | undefined)[]): string {
  return googleFirst(urls).find(u => !isHostCooling(u)) || '';
}

function proxyError(stage: ImageProxyStage, message: string, retryable: boolean): Error {
  const err = new Error(message) as Error & { stage: ImageProxyStage; retryable: boolean };
  err.stage = stage;
  err.retryable = retryable;
  return err;
}

interface CacheEntry {
  buf: Buffer;
  contentType: string;
  exp: number;
}
const cache = new Map<string, CacheEntry>();

function isBlockedIpv4(ip: string): boolean {
  const parts = ip.split('.').map(Number);
  if (parts.length !== 4 || parts.some(n => !Number.isFinite(n))) return true;
  const [a, b] = parts;
  return (
    a === 10 ||
    (a === 172 && b >= 16 && b <= 31) ||
    (a === 192 && b === 168) ||
    a === 127 ||
    (a === 169 && b === 254) || // link-local incl. cloud metadata
    a === 0 ||
    a >= 224 // multicast + reserved
  );
}

function isBlockedIp(ip: string): boolean {
  if (!net.isIP(ip)) return true;
  if (net.isIPv4(ip)) return isBlockedIpv4(ip);
  const low = ip.toLowerCase();
  // IPv4-mapped (::ffff:a.b.c.d) and IPv4-translated (::ffff:0:a.b.c.d)
  // addresses must be checked as the embedded IPv4 — otherwise
  // ::ffff:169.254.169.254 (cloud metadata) or ::ffff:127.0.0.1 slip past.
  const v4mapped = low.match(/^::ffff:(\d{1,3}\.\d{1,3}\.\d{1,3}\.\d{1,3})$/);
  if (v4mapped) return isBlockedIpv4(v4mapped[1]);
  if (low.startsWith('::ffff:')) return true; // mapped but not dotted — deny
  return (
    low === '::1' ||
    low === '::' ||
    low.startsWith('64:ff9b:') || // IPv4/IPv6 translation (NAT64)
    low.startsWith('fe80:') || // link-local
    low.startsWith('fc00:') || low.startsWith('fd00:') || // unique-local
    low.startsWith('ff') // multicast
  );
}

async function assertPublicHttpUrl(raw: string): Promise<URL> {
  let u: URL;
  try {
    u = new URL(String(raw || '').trim());
  } catch {
    throw proxyError('dns', 'Invalid image URL.', false);
  }
  if (u.protocol !== 'http:' && u.protocol !== 'https:') {
    throw proxyError('dns', 'Only http(s) image URLs are allowed.', false);
  }
  if (!u.hostname || u.username || u.password) {
    throw proxyError('dns', 'Invalid image URL.', false);
  }
  let records: string[];
  try {
    records = (await dns.promises.lookup(u.hostname, { all: true })).map(r => r.address);
  } catch {
    throw proxyError('dns', 'Image host could not be resolved.', true);
  }
  if (records.length === 0 || records.some(isBlockedIp)) {
    throw proxyError('dns', 'Image host is not allowed.', false);
  }
  return u;
}

export interface ProxiedImage {
  buf: Buffer;
  contentType: string;
  cached: boolean;
}

export async function fetchProxiedImage(rawUrl: string): Promise<ProxiedImage> {
  const key = String(rawUrl || '').trim();
  const hit = cache.get(key);
  if (hit && hit.exp > Date.now()) {
    // Refresh recency without growing the map.
    cache.delete(key);
    cache.set(key, hit);
    return { buf: hit.buf, contentType: hit.contentType, cached: true };
  }

  // One retry for transient network failures (slow origins, reset ASEAN/EU
  // hops): cheap, and the difference between a thumbnail and a 502.
  let lastErr: any = null;
  for (let attempt = 0; attempt < 2; attempt++) {
    try {
      const out = await attemptFetch(key);
      cache.set(key, { buf: out.buf, contentType: out.contentType, exp: Date.now() + CACHE_TTL_MS });
      if (cache.size > CACHE_MAX) {
        const oldest = cache.keys().next().value;
        if (oldest) cache.delete(oldest);
      }
      return { ...out, cached: false };
    } catch (err: any) {
      lastErr = err;
      const retryable = !!err?.retryable;
      if (!retryable || attempt === 1) throw err;
      await new Promise(r => setTimeout(r, 800));
    }
  }
  throw lastErr;
}

async function attemptFetch(key: string): Promise<{ buf: Buffer; contentType: string }> {
  let u = await assertPublicHttpUrl(key);
  let res: Response | null = null;
  for (let hop = 0; hop <= MAX_REDIRECTS; hop++) {
    const ctrl = new AbortController();
    const timer = setTimeout(() => ctrl.abort(), FETCH_TIMEOUT_MS);
    try {
      res = await fetch(u.toString(), {
        signal: ctrl.signal,
        redirect: 'manual',
        headers: {
          'User-Agent':
            'Mozilla/5.0 (Windows NT 10.0; Win64; x64) AppleWebKit/537.36 (KHTML, like Gecko) Chrome/126.0 Safari/537.36',
          Accept: 'image/avif,image/webp,image/apng,image/*,*/*;q=0.8',
          'Accept-Language': 'en-US,en;q=0.9',
        },
      });
    } catch (err: any) {
      const timedOut = err?.name === 'AbortError';
      throw proxyError(timedOut ? 'timeout' : 'fetch', timedOut ? 'Image fetch timed out.' : 'Image fetch failed (origin unreachable).', true);
    } finally {
      clearTimeout(timer);
    }
    if (res.status >= 300 && res.status < 400 && res.headers.get('location')) {
      if (hop === MAX_REDIRECTS) throw proxyError('redirect', 'Too many image redirects.', false);
      try {
        res.body?.cancel().catch(() => {});
      } catch { /* best effort */ }
      // Re-validate EVERY hop (redirect-based SSRF is the classic bypass).
      u = await assertPublicHttpUrl(new URL(res.headers.get('location')!, u).toString());
      res = null;
      continue;
    }
    break;
  }
  if (!res || !res.ok) {
    const status = res?.status || 0;
    try {
      noteHostStatus(u.hostname.toLowerCase(), status);
    } catch { /* reporting only */ }
    throw proxyError('status', `Image origin returned ${status || 'no response'}.`, status >= 500);
  }
  const contentType = (res.headers.get('content-type') || '').split(';')[0].trim().toLowerCase();
  if (!contentType.startsWith('image/')) {
    try {
      res.body?.cancel().catch(() => {});
    } catch { /* best effort */ }
    throw proxyError('content-type', `URL is not an image (${contentType || 'unknown type'}).`, false);
  }
  const announced = Number(res.headers.get('content-length') || 0);
  if (announced > MAX_BYTES) throw proxyError('size', 'Image too large.', false);

  let ab: ArrayBuffer;
  try {
    ab = await res.arrayBuffer();
  } catch {
    throw proxyError('body', 'Image download interrupted.', true);
  }
  if (ab.byteLength === 0 || ab.byteLength > MAX_BYTES) {
    throw proxyError('size', ab.byteLength === 0 ? 'Empty image response.' : 'Image too large.', false);
  }
  return { buf: Buffer.from(ab), contentType };
}
