import fs from 'fs';
import path from 'path';
import { sanitizeMultiline, sanitizeSingleLine } from '../shared/text.js';

const UA = 'Mozilla/5.0 (Windows NT 10.0; Win64; x64) AppleWebKit/537.36 (KHTML, like Gecko) Chrome/126.0.0.0 Safari/537.36';

function getDownloaderOrigins(): string[] {
  const primary = (process.env.DOWNLOADER_BASE_URL || '').trim().replace(/\/$/, '');
  const list: string[] = [];
  if (primary) list.push(primary);
  const podPort = process.env.DOWNLOADER_PORT || '';
  if (podPort) list.push(`http://127.0.0.1:${podPort}`);
  list.push('http://downloder:3000');
  list.push('http://downloader:3000');
  list.push('http://127.0.0.1:8100');
  list.push('http://127.0.0.1:3000');
  list.push('http://localhost:3000');
  return [...new Set(list)];
}

async function fetchTimeout(url: string, init: RequestInit, ms: number): Promise<Response> {
  const controller = new AbortController();
  const timer = setTimeout(() => controller.abort(), ms);
  try {
    return await fetch(url, { ...init, signal: controller.signal });
  } finally {
    clearTimeout(timer);
  }
}

export function parseInstagramUsername(raw: string): string | null {
  const s = String(raw || '').trim();
  if (!s) return null;
  if (/^[A-Za-z0-9_.]{1,30}$/.test(s)) return s;
  try {
    const u = new URL(s.startsWith('http') ? s : `https://${s}`);
    if (!/instagram\.com$/i.test(u.hostname.replace(/^www\./, ''))) return null;
    const seg = u.pathname.split('/').filter(Boolean)[0] || '';
    if (/^[A-Za-z0-9_.]{1,30}$/.test(seg)) return seg;
    return null;
  } catch {
    return null;
  }
}

export function normalizeProfileUrl(raw: string): string | null {
  const username = parseInstagramUsername(raw);
  if (!username) return null;
  return `https://www.instagram.com/${username}/`;
}

async function resolveDownloader(): Promise<string | null> {
  for (const origin of getDownloaderOrigins()) {
    try {
      const h = await fetchTimeout(`${origin}/api/health`, {}, 4000);
      if (h.ok) return origin;
    } catch { /* try next */ }
  }
  return null;
}

export interface ProfileReelItem {
  shortcode: string;
  url: string;
  title: string;
  description: string;
}

function stripTags(s: string): string {
  return s.replace(/<[^>]*>/g, ' ').replace(/\s+/g, ' ').trim();
}

// Short per-engine cooldown after a 429 (in-memory): hammering a
// rate-limited engine only extends the ban — skip it until the window ends.
const engineCooldownUntil = new Map<string, number>();
function engineCool(name: string): boolean {
  return (engineCooldownUntil.get(name) || 0) > Date.now();
}
function engineBan(name: string, ms = 30 * 60 * 1000) {
  engineCooldownUntil.set(name, Date.now() + ms);
}

function decodeBingTargets(text: string): string {
  // Bing HTML wraps result links: /ck/a?...&u=a1<base64url>&... — decode to
  // the real target URL so reel links become matchable.
  return text.replace(/[?&]u=a1([A-Za-z0-9\-_+/=]+)/g, (_m, b64: string) => {
    try {
      let s = String(b64).replace(/-/g, '+').replace(/_/g, '/');
      while (s.length % 4) s += '=';
      return Buffer.from(s, 'base64').toString('utf8');
    } catch {
      return _m;
    }
  });
}

function extractReelUrls(html: string, username: string): ProfileReelItem[] {
  // Only reels that verifiably belong to the introduced profile are kept —
  // search results routinely surface reels from OTHER accounts that merely
  // mention the username in their caption, and those must never be discovered
  // or published for this watch.
  const out: ProfileReelItem[] = [];
  const ownedOut: ProfileReelItem[] = [];
  const seen = new Set<string>();
  let text = html.replace(/&amp;/g, '&');
  // DuckDuckGo wraps external links as uddg=<url-encoded> — decode first,
  // otherwise profile-scoped reel URLs never match the regex below.
  text = text.replace(/uddg=(https?[^"'\s&]+)/gi, (_m, enc: string) => {
    try { return decodeURIComponent(enc); } catch { return _m; }
  });
  // Bing wraps result links in /ck/a redirects — decode to real targets.
  if (text.includes('/ck/a?')) text = decodeBingTargets(text);
    const push = (fullUrl: string, shortcode: string, title: string, owned: boolean) => {
    const clean = shortcode.replace(/\/$/, '');
    if (!clean || seen.has(clean)) return;
    // Drop anything that is not verifiably this profile's own reel.
    if (!owned) return;
    seen.add(clean);
    const item = { shortcode: clean, url: fullUrl, title: title.slice(0, 200), description: '' };
    ownedOut.push(item);
  };
  const re = /https?:\/\/(?:www\.)?instagram\.com\/(?:([A-Za-z0-9_.]+)\/)?(reel|reels|p)\/(?!audio(?:\/|$))([A-Za-z0-9_\-]+)/gi;
  let m: RegExpExecArray | null;
  while ((m = re.exec(text)) !== null) {
    const userSeg = (m[1] || '').toLowerCase();
    if (userSeg === 'reel' || userSeg === 'reels' || userSeg === 'p') continue;
    if (m[3].toLowerCase() === 'audio') continue;
    const start = Math.max(0, m.index - 200);
    const owned = !!userSeg && userSeg === username.toLowerCase();
    push(m[0].split('?')[0], m[3], stripTags(text.slice(start, m.index)), owned);
    if (ownedOut.length >= 12) break;
  }
  return [...ownedOut];
}

/**
 * Fallback discovery when Instagram-native listing is login-walled.
 * Uses public web search (site:instagram.com <username> reel) — RECENCY FIRST:
 * day-filtered results come before week-filtered and unfiltered ones, so old
 * archive files don't crowd out the latest reels (same idea as Google qdr:d).
 * No login needed. Order is relevance-based, not chronological.
 */
export async function searchProfileReels(username: string, limit = 8): Promise<ProfileReelItem[]> {
  // Path-scoped form first (site:instagram.com/<user>/reel) — it returns this
  // account's own reels at the top, newest-ish first; the check picks #1.
  const queries = [
    `site:instagram.com/${username}/reel`,
    `site:instagram.com ${username} reel`,
    `"${username}" instagram reel`
  ];
  const endpoints: { name: string; url: string }[] = [];
  for (const q of queries) {
    const e = encodeURIComponent(q);
    // Brave FIRST: answers Node.js with real results. Bing HTML supports a
    // real TIME filter (qft age-lt10080 = past week — Google qdr:d equivalent),
    // RSS + Mojeek are backups; DDG last (202-challenges Node).
    endpoints.push({ name: 'brave', url: `https://search.brave.com/search?q=${e}&source=web` });
    endpoints.push({ name: 'bing-week', url: `https://www.bing.com/search?q=${e}&qft=+filterui:age-lt10080` });
    endpoints.push({ name: 'bing', url: `https://www.bing.com/search?q=${e}` });
    endpoints.push({ name: 'bing-videos', url: `https://www.bing.com/videos/search?q=${e}` });
    endpoints.push({ name: 'bing-rss', url: `https://www.bing.com/search?q=${e}&format=rss` });
    endpoints.push({ name: 'mojeek', url: `https://www.mojeek.com/search?q=${e}` });
    endpoints.push({ name: 'ddg', url: `https://lite.duckduckgo.com/lite/?q=${e}` });
  }
  const found: ProfileReelItem[] = [];
  const seen = new Set<string>();
  const deadline = Date.now() + 90000;
  for (const ep of endpoints) {
    if (Date.now() >= deadline || found.length >= limit) break;
    if (engineCool(ep.name)) continue;
    try {
      const r = await fetchTimeout(ep.url, {
        headers: { 'User-Agent': UA, 'Accept': 'text/html', 'Accept-Language': 'en-US' }
      }, 15000);
      // NOTE: only 200 counts — DDG's 202 is a bot-challenge page (ok==true
      // but zero results), parsing it just wastes the cycle.
      if (r.status === 429) { engineBan(ep.name); continue; }
      if (r.status !== 200) continue;
      const html = await r.text();
      for (const item of extractReelUrls(html, username)) {
        if (seen.has(item.shortcode)) continue;
        seen.add(item.shortcode);
        found.push(item);
        if (found.length >= limit) break;
      }
    } catch { /* next engine */ }
  }
  return found;
}

export async function fetchProfileReels(profileUrl: string, limit = 12, cookies?: string | null): Promise<{ items: ProfileReelItem[]; origin: string; warning?: string; source?: string }> {
  const origin = await resolveDownloader();
  if (!origin) throw new Error('Downloader unreachable — check DOWNLOADER_BASE_URL.');
  const r = await fetchTimeout(`${origin}/api/profile`, {
    method: 'POST',
    headers: { 'Content-Type': 'application/json', 'User-Agent': UA },
    body: JSON.stringify({ url: profileUrl, limit, ...(cookies ? { cookies } : {}) })
  }, 200000);
  if (!r.ok) throw new Error(`Profile list failed (HTTP ${r.status}). The profile may be private or rate-limited.`);
  const j: any = await r.json();
  if (!j?.ok) throw new Error(j?.error || 'Profile list failed.');
  return { items: (Array.isArray(j.items) ? j.items : []) as ProfileReelItem[], origin, warning: j?.warning ? String(j.warning) : undefined, source: j?.source ? String(j.source) : undefined };
}

export interface ReelMetadata {
  title: string;
  description: string;
  uploader: string;
  webpageUrl: string;
}

// Normalize a provider caption that may arrive as a bare string OR as the
// Instagram caption object ({ text, ... }). Reads of a raw object would
// stringify to "[object Object]" and silently degrade the YouTube title to
// the "@user Instagram Reel" fallback — always collapse to the real text.
export function normalizeCaption(raw: unknown): string {
  if (raw == null) return '';
  if (typeof raw === 'string') return sanitizeMultiline(raw);
  if (typeof raw === 'object') {
    const t = (raw as any).text;
    if (typeof t === 'string') return sanitizeMultiline(t);
    if (t != null) return sanitizeMultiline(t);
    return '';
  }
  return sanitizeMultiline(raw);
}

// True when a caption is missing or is search-engine junk (bare URL,
// breadcrumb, engine domain) instead of the reel's real caption — caller
// must fetch /api/metadata for the real one.
export function needsRealCaption(caption: string): boolean {
  const c = normalizeCaption(caption).trim();
  if (c.length < 12) return true;
  // Stringified-object / placeholder artifacts are NOT the reel's caption.
  if (/^\[object\s+\w+\]$/i.test(c)) return true;
  if (/^(undefined|null|nan|n\/a)$/i.test(c)) return true;
  if (/^https?:\/\//i.test(c)) return true;
  if (/bing\.com|duckduckgo\.com|search\.brave\.com|mojeek\.com|google\.com\/search|swisscows\.com|yahoo\.com\/search/i.test(c)) return true;
  return false;
}

export async function fetchReelMetadata(reelUrl: string, originHint?: string, cookies?: string | null): Promise<ReelMetadata> {
  const origins = originHint ? [originHint, ...getDownloaderOrigins()] : getDownloaderOrigins();
  let lastErr = '';
  for (const origin of [...new Set(origins)]) {
    try {
      const r = await fetchTimeout(`${origin}/api/metadata`, {
        method: 'POST',
        headers: { 'Content-Type': 'application/json', 'User-Agent': UA },
        body: JSON.stringify({ url: reelUrl, ...(cookies ? { cookies } : {}) })
      }, 70000);
      if (!r.ok) { lastErr = `HTTP ${r.status}`; continue; }
      const j: any = await r.json();
      if (!j?.ok) { lastErr = j?.error || 'metadata failed'; continue; }
      return {
        title: sanitizeMultiline(j.title || ''),
        description: sanitizeMultiline(j.description || ''),
        uploader: String(j.uploader || ''),
        webpageUrl: String(j.webpageUrl || reelUrl)
      };
    } catch (e: any) {
      lastErr = String(e?.message || e);
    }
  }
  throw new Error(`Reel metadata failed (${lastErr}).`);
}

export async function downloadReelMp4(
  reelUrl: string,
  destDir: string,
  filenameBase: string,
  originHint?: string,
  onLog?: (msg: string) => void
): Promise<{ filePath: string; sizeBytes: number }> {
  const origins = originHint ? [originHint, ...getDownloaderOrigins()] : getDownloaderOrigins();
  let origin: string | null = null;
  for (const o of [...new Set(origins)]) {
    try {
      const h = await fetchTimeout(`${o}/api/health`, {}, 4000);
      if (h.ok) { origin = o; break; }
    } catch { /* next */ }
  }
  if (!origin) throw new Error('Downloader unreachable.');
  const submit = await fetchTimeout(`${origin}/api/download`, {
    method: 'POST',
    headers: { 'Content-Type': 'application/json', 'User-Agent': UA },
    body: JSON.stringify({ url: reelUrl, mode: 'video' })
  }, 15000);
  if (!submit.ok) throw new Error(`Downloader rejected reel (HTTP ${submit.status}).`);
  const sj: any = await submit.json();
  const id = String(sj?.id || '');
  if (!id) throw new Error('Downloader gave no job.');
  onLog?.(`Download job ${id}`);
  const deadline = Date.now() + 8 * 60 * 1000;
  for (;;) {
    await new Promise(r => setTimeout(r, 3000));
    if (Date.now() >= deadline) throw new Error('Download timed out.');
    let j: any = null;
    try {
      const jr = await fetchTimeout(`${origin}/api/jobs/${id}`, {}, 10000);
      if (!jr.ok) continue;
      j = await jr.json();
    } catch { continue; }
    if (j?.status === 'error') throw new Error(j?.error || 'Downloader engine error.');
    if (j?.status !== 'done') continue;
    const files = Array.isArray(j?.files) ? j.files : [];
    const vid = files.find((f: any) => f?.type === 'video' && /\.mp4$/i.test(String(f?.name || '')))
      || files.find((f: any) => /\.mp4$/i.test(String(f?.name || '')))
      || files.find((f: any) => f?.type === 'video');
    if (!vid?.url) throw new Error('Downloader job has no video file.');
    const fileUrl = /^https?:/i.test(String(vid.url)) ? String(vid.url) : `${origin}${String(vid.url).startsWith('/') ? '' : '/'}${vid.url}`;
    const dr = await fetchTimeout(fileUrl, { headers: { 'User-Agent': UA } }, 60000);
    if (!dr.ok) throw new Error(`Clip fetch failed (HTTP ${dr.status}).`);
    const buf = Buffer.from(await dr.arrayBuffer());
    if (buf.length < 100 * 1024) throw new Error('Downloaded clip too small.');
    if (!fs.existsSync(destDir)) fs.mkdirSync(destDir, { recursive: true });
    const filePath = path.join(destDir, `${filenameBase}.mp4`);
    fs.writeFileSync(filePath, buf);
    return { filePath, sizeBytes: buf.length };
  }
}

function cleanCaption(s: string): string {
  // Strip @profile mentions (e.g. @khande) — credit tags must not leak into
  // YouTube titles/descriptions — but keep the caption text AND #hashtags.
  // The boundary before @ protects emails (name@domain) and the lookahead
  // keeps trailing punctuation (…, !) intact.
  const noMentions = String(s || '').replace(/(^|[\s\n([>])@[A-Za-z0-9._]{2,30}(?![A-Za-z0-9._])/g, '$1');
  return noMentions.replace(/\r/g, '\n').replace(/[ \t]+\n/g, '\n').replace(/\n{3,}/g, '\n\n').replace(/ {2,}/g, ' ').trim();
}

function captionHeadline(caption: string): string {
  const clean = cleanCaption(normalizeCaption(caption));
  if (!clean || needsRealCaption(clean)) return '';
  const firstLine = clean.split('\n').map(l => l.trim()).find(l => l.length > 0) || '';
  const oneLine = firstLine.replace(/\s+/g, ' ').trim();
  if (oneLine.length >= 12) return oneLine;
  return clean.replace(/\s+/g, ' ').trim();
}

function toHashtagWord(w: string): string | null {
  const t = String(w || '').replace(/^[@#]+/, '').trim();
  if (t.length < 3 || t.length > 30) return null;
  if (!/^[A-Za-z\u0600-\u06FF][A-Za-z0-9_\u0600-\u06FF]*$/.test(t)) return null;
  return `#${t[0].toUpperCase() + t.slice(1)}`;
}

export interface RepostMetadata {
  title: string;
  description: string;
  tags: string[];
}

export function buildRepostMetadata(caption: string, username: string, reelUrl: string, channelTitle?: string | null, hashtags?: unknown): RepostMetadata {
  void reelUrl;
  const full = cleanCaption(caption);
  const head = captionHeadline(full);
  const suffix = ' #Shorts';
  // When no real caption is available, never mention "Instagram Reel" — fall
  // back to the YouTube channel name (or the IG username as last resort) so
  // the title stays channel-branded instead of leaking the source platform.
  const fallback = sanitizeSingleLine(String(channelTitle || username || '').trim()) || username;
  let base = sanitizeSingleLine(head || fallback);
  if (base.length > 100 - suffix.length) base = base.slice(0, 100 - suffix.length - 3).trimEnd() + '...';
  // Title = the caption's own head + #Shorts (YouTube Shorts ranking signal).
  const title = `${base}${suffix}`.slice(0, 100);

  // Normalize per-profile custom hashtags into "#tag" tokens.
  const customTags: string[] = [];
  const seenTags = new Set<string>();
  const rawTags = Array.isArray(hashtags) ? hashtags : (typeof hashtags === 'string' ? hashtags.split(/[\s,]+/) : []);
  for (const t of rawTags) {
    for (const part of String(t || '').split(/[\s,]+/)) {
      let tag = part.trim();
      if (!tag) continue;
      if (tag.startsWith('#')) tag = tag.slice(1);
      tag = tag.replace(/[^\w\u0600-\u06FF]/g, '');
      if (!tag) continue;
      const key = tag.toLowerCase();
      if (seenTags.has(key)) continue;
      seenTags.add(key);
      customTags.push(`#${tag}`);
      if (customTags.length >= 20) break;
    }
  }
  // Description = the reel's own caption text, followed by the profile's
  // custom hashtags (when defined) so they land in the YouTube description.
  const baseDescription = sanitizeMultiline(full || fallback).slice(0, 4900);
  const hashtagSuffix = customTags.length ? `\n\n${customTags.join(' ')}` : '';
  const description = (baseDescription + hashtagSuffix).slice(0, 4900);

  // Tags are invisible YouTube metadata (not shown in the description) —
  // kept for ranking, derived from the caption words.
  const hashWords = full.split(/[^A-Za-z\u0600-\u06FF0-9_]+/).filter(w => w.length >= 4).slice(0, 8);
  const tags = [...new Set([
    'Shorts',
    username.toLowerCase(),
    'Instagram Reel',
    'Repost',
    ...hashWords
  ])].map(t => t.slice(0, 40)).slice(0, 15);

  return { title, description, tags };
}
