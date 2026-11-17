// Instagram Discovery via RapidAPI
// (instagram-downloader-download-instagram-videos-stories1).
//
// Why this exists: the old discovery paths (search-engine scraping +
// downloader yt-dlp listing, then instagram-public-bulk-scraper) are
// login-walled / flaky / quota-hungry. This provider uses two endpoints:
//   - `GET /?Userinfo=<profileUrl>` -> profile + stories + highlights +
//     latest 12 posts. Video posts carry a direct MP4 (`url`) + shortcode
//     (`id`), newest first. No pagination — 12 latest only.
//   - `GET /get-info-rapidapi?url=<reelUrl>` -> single reel/post: direct
//     `download_url` MP4 + caption + thumb. Used for the publish-time rescue
//     (any shortcode, 1 credit) instead of paging the whole profile.
// The keys live in env (RAPIDAPI_KEY or INSTAGRAM_RAPIDAPI_KEY, comma-separated),
// never in code. Requests fail over key1 -> key2 -> ... on 429/401/403.

import fs from 'fs';
import path from 'path';
import { spawn, execFileSync } from 'child_process';
import { ffmpegBin } from './videoRenderer.js';
import { liveFps, liveOutSize, livePreset, liveVideoKbps } from './liveStreamService.js';
import { sanitizeMultiline } from '../shared/text.js';

const UA =
  'Mozilla/5.0 (Windows NT 10.0; Win64; x64) AppleWebKit/537.36 (KHTML, like Gecko) Chrome/126.0.0.0 Safari/537.36';

export function getRapidConfig(): { keys: string[]; host: string } {
  // Multi-key pool: comma/space/newline-separated (RAPIDAPI_KEY="key1,key2").
  // Requests fail over key1 -> key2 -> ... automatically (see fetchRapidReels).
  const splitKeys = (s: unknown): string[] =>
    String(s || '')
      .split(/[\s,;]+/)
      .map(k => k.trim())
      .filter(k => k.length > 10);
  const keys: string[] = [];
  for (const k of [...splitKeys(process.env.RAPIDAPI_KEY), ...splitKeys(process.env.INSTAGRAM_RAPIDAPI_KEY)]) {
    if (!keys.includes(k)) keys.push(k);
  }
  const host = String(
    process.env.RAPIDAPI_IG_HOST ||
      process.env.INSTAGRAM_RAPIDAPI_HOST ||
      'instagram-downloader-download-instagram-videos-stories1.p.rapidapi.com'
  ).trim();
  return { keys, host };
}

export function isRapidConfigured(): boolean {
  return getRapidConfig().keys.length > 0;
}

/** Runtime failover state: a key that answers 429 (quota) or 401/403
 *  (rejected) is parked for the rest of the process life (monthly quota —
 *  retrying it would only burn time). Restart (or a redeploy with fresh keys
 *  in .env) resets the pool. Full key material is NEVER logged. */
const rapidExhausted = new Set<string>();

function maskKey(k: string): string {
  return k.length <= 8 ? '****' : `${k.slice(0, 4)}…${k.slice(-4)}`;
}

// ---------------------------------------------------------------------------
// Request counter: every HTTP request actually fired at the RapidAPI host
// (including failover retries with the next key — each retry IS a billed
// request). Shown in the Admin Health tab; resettable via
// POST /api/admin/rapid-reset. Persisted best-effort to temp/ so a restart
// doesn't silently zero it.
// ---------------------------------------------------------------------------
export interface RapidUsage {
  total: number;
  userinfo: number;
  single: number;
  sinceIso: string;
}

const RAPID_USAGE_FILE = path.join(process.cwd(), 'temp', 'rapid-usage.json');

const rapidUsage: RapidUsage = (() => {
  const fresh = (): RapidUsage => ({ total: 0, userinfo: 0, single: 0, sinceIso: new Date().toISOString() });
  try {
    if (fs.existsSync(RAPID_USAGE_FILE)) {
      const j = JSON.parse(fs.readFileSync(RAPID_USAGE_FILE, 'utf8'));
      const u = fresh();
      if (Number.isFinite(Number(j?.total))) u.total = Math.max(0, Math.floor(Number(j.total)));
      if (Number.isFinite(Number(j?.userinfo))) u.userinfo = Math.max(0, Math.floor(Number(j.userinfo)));
      if (Number.isFinite(Number(j?.single))) u.single = Math.max(0, Math.floor(Number(j.single)));
      if (typeof j?.sinceIso === 'string' && j.sinceIso) u.sinceIso = j.sinceIso;
      return u;
    }
  } catch {
    /* corrupt file — start fresh */
  }
  return fresh();
})();

function saveRapidUsage(): void {
  try {
    fs.mkdirSync(path.dirname(RAPID_USAGE_FILE), { recursive: true });
    fs.writeFileSync(RAPID_USAGE_FILE, JSON.stringify(rapidUsage));
  } catch {
    /* counter stays in memory */
  }
}

function countRapidRequest(kind: 'userinfo' | 'single'): void {
  rapidUsage.total += 1;
  rapidUsage[kind] += 1;
  saveRapidUsage();
}

export function getRapidUsage(): RapidUsage {
  return { ...rapidUsage };
}

export function resetRapidUsage(): RapidUsage {
  rapidUsage.total = 0;
  rapidUsage.userinfo = 0;
  rapidUsage.single = 0;
  rapidUsage.sinceIso = new Date().toISOString();
  saveRapidUsage();
  return getRapidUsage();
}

/** Fires one RapidAPI request with the standard headers and counts it. */
function rapidFetch(url: string, key: string, host: string, kind: 'userinfo' | 'single', ms: number): Promise<Response> {
  countRapidRequest(kind);
  return fetchTimeout(
    url,
    { headers: { 'x-rapidapi-key': key, 'x-rapidapi-host': host, 'User-Agent': UA } },
    ms
  );
}

/** Manager-safe pool status (masked prefixes only) for the Admin Health tab. */
export function getRapidKeysStatus(): {
  total: number;
  live: number;
  keys: { index: number; prefix: string; exhausted: boolean }[];
  usage: RapidUsage;
} {
  const { keys } = getRapidConfig();
  return {
    total: keys.length,
    live: keys.filter(k => !rapidExhausted.has(k)).length,
    keys: keys.map((k, i) => ({ index: i + 1, prefix: maskKey(k), exhausted: rapidExhausted.has(k) })),
    usage: getRapidUsage()
  };
}

export interface RapidReelItem {
  shortcode: string;
  url: string;
  caption: string;
  thumbnail: string;
  /** Direct MP4 — playable in <video> with zero download. */
  previewUrl: string;
  playCount: number;
  likeCount: number;
  commentCount: number;
  durationSec: number;
  takenAt: string | null;
  username: string;
  hasAudio: boolean;
}

function num(v: unknown): number {
  const n = Number(v);
  return Number.isFinite(n) ? n : 0;
}

/** Provider captions arrive either as a bare string or as the Instagram
 *  caption object ({ text, ... }). Reading a raw object stringifies to
 *  "[object Object]" and degrades the YouTube title to the generic
 *  "@user Instagram Reel" fallback — always collapse to the real text. */
function normalizeProviderCaption(raw: unknown): string {
  if (raw == null) return '';
  if (typeof raw === 'string') return sanitizeMultiline(raw);
  if (typeof raw === 'object') {
    const t = (raw as any).text;
    return t == null ? '' : sanitizeMultiline(t);
  }
  return sanitizeMultiline(raw);
}

function pickPreviewUrl(videoVersions: unknown): string {
  // Kept for shape-compat: the new provider hands us the MP4 directly,
  // so this is only a fallback if a bulk-scraper-shaped payload ever returns.
  if (typeof videoVersions === 'string' && /^https?:/i.test(videoVersions)) return videoVersions;
  if (!Array.isArray(videoVersions)) return '';
  let best = '';
  let bestW = -1;
  for (const v of videoVersions) {
    const u = String((v as any)?.url || '');
    if (!u || !/^https?:/i.test(u)) continue;
    const w = num((v as any)?.width);
    if (w >= bestW) {
      bestW = w;
      best = u;
    }
  }
  return best;
}

function pickThumbnail(imageVersions2: unknown): string {
  if (typeof imageVersions2 === 'string' && /^https?:/i.test(imageVersions2)) return imageVersions2;
  try {
    const cands = (imageVersions2 as any)?.candidates;
    if (Array.isArray(cands) && cands[0]?.url) return String(cands[0].url);
    const add = (imageVersions2 as any)?.additional_candidates;
    const first = add?.first_frame?.url || add?.igtv_first_frame?.url;
    if (first) return String(first);
  } catch {
    /* empty */
  }
  return '';
}

/** Normalize one `posts[]` entry of the new Userinfo payload into a
 *  preview-ready item. Only `type === 'video'` entries are reels; images /
 *  albums have no MP4 and are skipped by the caller. NOTE: the list endpoint
 *  carries NO caption and NO per-post thumbnail — caption is resolved later
 *  (single lookup at publish time, or the anonymous metadata path). */
export function normalizeRapidMedia(m: any, fallbackUsername: string): RapidReelItem | null {
  if (!m || typeof m !== 'object') return null;
  const code = String(m.id || m.shortcode || m.code || '').replace(/\/$/, '');
  if (!code) return null;
  const type = String(m.type || '').toLowerCase();
  if (type && type !== 'video') return null;
  const previewUrl = String(m.url || m.download_url || pickPreviewUrl(m.video_versions) || '');
  if (!previewUrl || !/^https?:/i.test(previewUrl)) return null;
  const owner = m.user || m.owner || {};
  const username = String(owner.username || fallbackUsername || '').replace(/^@/, '');
  let takenAt: string | null = null;
  const rawTaken = m.taken_at ?? m.takenAt ?? null;
  if (typeof rawTaken === 'number' && Number.isFinite(rawTaken) && rawTaken > 0) {
    takenAt = new Date(rawTaken * 1000).toISOString();
  } else if (typeof rawTaken === 'string' && rawTaken) {
    const d = new Date(rawTaken);
    takenAt = Number.isNaN(d.getTime()) ? null : d.toISOString();
  }
  return {
    shortcode: code,
    url: `https://www.instagram.com/reel/${code}/`,
    caption: normalizeProviderCaption(m.caption),
    thumbnail: pickThumbnail(m.thumbnail ?? m.thumb ?? m.image_versions2),
    previewUrl,
    playCount: num(m.play_count ?? m.fb_play_count),
    likeCount: num(m.like_count),
    commentCount: num(m.comment_count),
    durationSec: Math.round(num(m.video_duration) * 10) / 10,
    takenAt,
    username,
    hasAudio: m.has_audio !== false
  };
}

export interface RapidDiscoverResult {
  items: RapidReelItem[];
  nextMaxId: string | null;
  moreAvailable: boolean;
}

/* ========================================================================= */
/* Winner-content scoring — the "winning reel" of a profile is the one with  */
/* the most views; likes/comments only break ties. Views dominate by orders  */
/* of magnitude on Instagram, so a plain weighted sum keeps views decisive   */
/* while engagement decides between near-equal view counts. The score rides  */
/* FREE inside the Userinfo response (zero extra RapidAPI credits) and the   */
/* publish queue orders unpublished reels by it (highest first).             */
/*                                                                           */
/* Discovery capacity (provider hard limit — do NOT regress): the Userinfo    */
/* endpoint returns the profile's LATEST 12 POSTS ONLY (mixed image/album/    */
/* video, no pagination, no cursor). After filtering type === 'video' a      */
/* check typically scores 5–12 reels. The "winner" is therefore the winner   */
/* of the latest-12 window, not of the profile's full history.               */
/* ========================================================================= */

/** Provider capacity: max posts scorable per discovery (see above). */
export const RAPID_DISCOVERY_WINDOW = 12;

export function computeWinnerScore(
  playCount: unknown, likeCount: unknown, commentCount: unknown
): number {
  const plays = Math.max(0, Math.floor(Number(playCount) || 0));
  const likes = Math.max(0, Math.floor(Number(likeCount) || 0));
  const comments = Math.max(0, Math.floor(Number(commentCount) || 0));
  return plays + likes * 5 + comments * 10;
}

export function winnerScoreOf(item: { playCount?: unknown; likeCount?: unknown; commentCount?: unknown }): number {
  return computeWinnerScore(item.playCount, item.likeCount, item.commentCount);
}

/** Newest-first in, winner-first out (stable: equal scores keep recency). */
export function sortByWinnerScore<T extends { playCount?: unknown; likeCount?: unknown; commentCount?: unknown }>(items: T[]): T[] {
  return [...items]
    .map((it, idx) => ({ it, idx, score: winnerScoreOf(it) }))
    .sort((a, b) => (b.score - a.score) || (a.idx - b.idx))
    .map(e => e.it);
}

/** The single winning reel of a discovery batch (null when empty). */
export function pickWinnerReel<T extends { playCount?: unknown; likeCount?: unknown; commentCount?: unknown }>(items: T[]): T | null {
  if (!items || items.length === 0) return null;
  let best = items[0];
  let bestScore = winnerScoreOf(best);
  for (let i = 1; i < items.length; i++) {
    const s = winnerScoreOf(items[i]);
    if (s > bestScore) { best = items[i]; bestScore = s; }
  }
  return bestScore > 0 ? best : null;
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

/**
 * List a profile's latest reels via the new provider, failing over the key
 * pool first to last: a key answering 429 (quota) or 401/403 (rejected) is
 * parked and the SAME request retries immediately with the next key.
 * Network-level failures throw at once (host problem, not a key problem) so
 * the caller falls back to the downloader path.
 *
 * Provider limits (do NOT regress): the Userinfo endpoint returns the latest
 * 12 posts only (mixed image/album/video) with NO pagination and NO caption.
 * We filter `type === 'video'` and return them newest-first as reels.
 * `paginationId` is accepted for caller compat and ignored.
 */
export async function fetchRapidReels(
  usernameOrId: string,
  limit = 12,
  _paginationId?: string | null
): Promise<RapidDiscoverResult> {
  const { keys, host } = getRapidConfig();
  if (keys.length === 0) throw new Error('RapidAPI key missing — set RAPIDAPI_KEY in the service .env.');
  const usable = keys.filter(k => !rapidExhausted.has(k));
  if (usable.length === 0) {
    throw new Error(
      `All ${keys.length} RapidAPI key(s) exhausted (quota/rejected) — add fresh keys to RAPIDAPI_KEY (comma-separated) and restart, or wait for the monthly reset.`
    );
  }
  const id = String(usernameOrId || '').trim().replace(/^@/, '').replace(/\/$/, '').split('/').filter(Boolean)[0] || '';
  if (!id) throw new Error('Enter an Instagram username.');
  const profileUrl = `https://www.instagram.com/${id}/`;
  const url = `https://${host}/?Userinfo=${encodeURIComponent(profileUrl)}`;
  let lastErr = '';
  for (const key of usable) {
    let r: Response;
    try {
      r = await rapidFetch(url, key, host, 'userinfo', 30000);
    } catch (e: any) {
      throw new Error(`RapidAPI unreachable (${String(e?.message || e).slice(0, 120)}).`);
    }
    if (r.status === 401 || r.status === 403 || r.status === 429) {
      rapidExhausted.add(key);
      lastErr = r.status === 429 ? 'quota hit (429)' : 'key rejected (401/403)';
      console.warn(
        `[RapidAPI] key ${maskKey(key)} ${lastErr} — parked for this process (${rapidExhausted.size}/${keys.length} parked), failing over.`
      );
      continue;
    }
    if (!r.ok) throw new Error(`RapidAPI error (HTTP ${r.status}).`);
    if (rapidExhausted.size > 0) {
      console.log(`[RapidAPI] served by failover key ${maskKey(key)} (${keys.length - rapidExhausted.size}/${keys.length} live).`);
    }
    let j: any = null;
    try {
      j = await r.json();
    } catch {
      throw new Error('RapidAPI returned non-JSON.');
    }
    if (j?.error === true) {
      throw new Error(String(j?.message || 'Instagram user not found or private.').slice(0, 200));
    }
    const raw: any[] = Array.isArray(j?.posts) ? j.posts : [];
    const items: RapidReelItem[] = [];
    const seen = new Set<string>();
    for (const it of raw) {
      const n = normalizeRapidMedia(it, id);
      if (!n || seen.has(n.shortcode)) continue;
      // Only reels owned by the requested profile — never leak other accounts.
      if (n.username && n.username.toLowerCase() !== id.toLowerCase()) continue;
      seen.add(n.shortcode);
      items.push(n);
      if (items.length >= Math.min(24, Math.max(1, limit))) break;
    }
    // No pagination on this provider — one page of the latest 12 posts.
    return { items, nextMaxId: null, moreAvailable: false };
  }
  // Every live key answered 429/401/403 — nothing left to try this process.
  throw new Error(
    `All ${keys.length} RapidAPI key(s) exhausted (${lastErr || 'quota/rejected'}) — add fresh keys to RAPIDAPI_KEY (comma-separated) and restart, or wait for the monthly reset.`
  );
}

/**
 * Direct single-reel lookup: `GET /get-info-rapidapi?url=<reelUrl>` with the
 * SAME key-pool failover. Costs 1 credit and returns the downloadable MP4 +
 * caption + thumb for ANY shortcode (no need to page the profile). Used by the
 * publish-time rescue when the stored previewUrl expired.
 */
export async function fetchRapidSingleMedia(
  reelUrl: string
): Promise<{ previewUrl: string; caption: string; thumbnail: string } | null> {
  const { keys, host } = getRapidConfig();
  if (keys.length === 0) throw new Error('RapidAPI key missing — set RAPIDAPI_KEY in the service .env.');
  const usable = keys.filter(k => !rapidExhausted.has(k));
  if (usable.length === 0) {
    throw new Error(
      `All ${keys.length} RapidAPI key(s) exhausted (quota/rejected) — add fresh keys to RAPIDAPI_KEY (comma-separated) and restart, or wait for the monthly reset.`
    );
  }
  const target = String(reelUrl || '').trim();
  if (!target || !/^https?:/i.test(target)) throw new Error('Enter an Instagram reel link.');
  const url = `https://${host}/get-info-rapidapi?url=${encodeURIComponent(target)}`;
  let lastErr = '';
  for (const key of usable) {
    let r: Response;
    try {
      r = await rapidFetch(url, key, host, 'single', 30000);
    } catch (e: any) {
      throw new Error(`RapidAPI unreachable (${String(e?.message || e).slice(0, 120)}).`);
    }
    if (r.status === 401 || r.status === 403 || r.status === 429) {
      rapidExhausted.add(key);
      lastErr = r.status === 429 ? 'quota hit (429)' : 'key rejected (401/403)';
      console.warn(
        `[RapidAPI] key ${maskKey(key)} ${lastErr} — parked for this process (${rapidExhausted.size}/${keys.length} parked), failing over.`
      );
      continue;
    }
    if (!r.ok) throw new Error(`RapidAPI error (HTTP ${r.status}).`);
    let j: any = null;
    try {
      j = await r.json();
    } catch {
      throw new Error('RapidAPI returned non-JSON.');
    }
    if (j?.error === true) return null;
    const previewUrl = String(j?.download_url || '');
    if (!previewUrl || !/^https?:/i.test(previewUrl)) return null;
    // The single endpoint names the caption differently across provider
    // versions (caption / description / title) and may hand it back as the
    // Instagram caption OBJECT — normalize all shapes so the REAL caption is
    // used and the title never degrades to "@user Instagram Reel".
    const caption =
      normalizeProviderCaption(j?.caption) ||
      normalizeProviderCaption(j?.description) ||
      normalizeProviderCaption(j?.title);
    return {
      previewUrl,
      caption,
      thumbnail: String(j?.thumb || '')
    };
  }
  throw new Error(
    `All ${keys.length} RapidAPI key(s) exhausted (${lastErr || 'quota/rejected'}) — add fresh keys to RAPIDAPI_KEY (comma-separated) and restart, or wait for the monthly reset.`
  );
}

// ---------------------------------------------------------------------------
// Combine: N selected preview MP4s -> ONE vertical MP4 for the YouTube stream.
// Downloads use the previewUrl directly (no yt-dlp, no login). Every part is
// normalized DIRECTLY to the live output profile (liveOutSize/liveFps +
// livePreset/liveVideoKbps + 128k audio — same bytes YouTube receives) so the
// mix step does no wasted work: fewer pixels than 1080p, ultrafast instead of
// veryfast, and the reel-loop decoder's scale/crop becomes a no-op while the
// pacer re-muxes the same geometry. Output lands in public/videos/.
// Env overrides (LIVE_RES / LIVE_FPS / LIVE_PRESET / LIVE_VBITRATE_K) are
// honored here too, so the mix can never drift from the on-air encoder.
// ---------------------------------------------------------------------------

function runCmd(bin: string, args: string[], ms: number): Promise<void> {
  return new Promise((resolve, reject) => {
    let proc: ReturnType<typeof spawn>;
    try {
      proc = spawn(bin, args, { stdio: ['ignore', 'pipe', 'pipe'] });
    } catch (e: any) {
      reject(new Error(String(e?.message || e)));
      return;
    }
    let tail = '';
    proc.stderr?.on('data', (d: Buffer) => {
      tail += String(d);
      if (tail.length > 4000) tail = tail.slice(-4000);
    });
    const timer = setTimeout(() => {
      try {
        proc.kill('SIGKILL');
      } catch {
        /* gone */
      }
      reject(new Error('ffmpeg timed out.'));
    }, ms);
    (timer as any)?.unref?.();
    proc.on('error', (e: any) => {
      clearTimeout(timer);
      reject(new Error(String(e?.message || e)));
    });
    proc.on('exit', (code: number | null) => {
      clearTimeout(timer);
      if (code === 0) resolve();
      else reject(new Error(`ffmpeg exit ${code}: ${tail.split('\n').slice(-3).join(' | ').slice(0, 300)}`));
    });
  });
}

function partHasAudio(filePath: string): boolean {
  try {
    execFileSync(ffmpegBin(), ['-hide_banner', '-i', filePath], {
      timeout: 25000,
      stdio: ['ignore', 'pipe', 'pipe']
    });
    return false;
  } catch (err: any) {
    const txt = String((err as any)?.stderr || '') + String((err as any)?.stdout || '');
    return /Audio:/i.test(txt);
  }
}

/** Download a direct (previewUrl) MP4 to disk. Shared by the mix combiner
 *  AND the watch prefetch cache — preview CDN links expire fast, so callers
 *  download immediately after discovery and never store the URL itself. */
export async function downloadToFile(url: string, dest: string): Promise<number> {
  const r = await fetchTimeout(url, { headers: { 'User-Agent': UA } }, 90000);
  if (!r.ok) throw new Error(`Clip fetch failed (HTTP ${r.status}).`);
  const buf = Buffer.from(await r.arrayBuffer());
  if (buf.length < 50 * 1024) throw new Error('Downloaded clip too small — expired CDN link? Re-run Discovery.');
  fs.writeFileSync(dest, buf);
  return buf.length;
}

export interface MixSource {
  shortcode: string;
  previewUrl: string;
}

export interface MixProgress {
  /** Machine-readable stage: downloading | normalizing | joining | going-live */
  step: string;
  done: number;
  total: number;
}

// ---------------------------------------------------------------------------
// Async mix jobs: a 10-clip mix (downloads + ffmpeg + live takeover) takes
// MINUTES, far longer than any browser/proxy keeps one HTTP request alive
// (the exact ERR_ADDRESS_UNREACHABLE seen on mix-go-live). So POST /mix*
// returns a jobId IMMEDIATELY and the UI polls GET /mix-status/:id.
// In-memory like the pipeline jobsDatabase — a restart loses it (poll 404s,
// UI says "retry").
// ---------------------------------------------------------------------------

export type MixJobStatus = 'queued' | 'running' | 'done' | 'failed';

export interface MixJob {
  id: string;
  userId: string;
  mode: 'mix' | 'live';
  status: MixJobStatus;
  step: string;
  done: number;
  total: number;
  result?: { filename: string; url: string; count: number; sizeBytes: number };
  error?: string;
  createdAt: string;
}

const mixJobs = new Map<string, MixJob>();

export function createMixJob(userId: string, mode: 'mix' | 'live', total: number): MixJob {
  const id = `mixjob-${Date.now().toString(36)}-${Math.random().toString(36).slice(2, 8)}`;
  const job: MixJob = {
    id, userId, mode, status: 'queued', step: 'Queued — waiting for the video lane…',
    done: 0, total: Math.max(1, total), createdAt: new Date().toISOString()
  };
  mixJobs.set(id, job);
  // Bounded: keep the newest 30, drop the rest (no leak across days).
  if (mixJobs.size > 30) {
    const keys = [...mixJobs.keys()];
    for (const k of keys.slice(0, mixJobs.size - 30)) mixJobs.delete(k);
  }
  return job;
}

export function getMixJob(id: string): MixJob | undefined {
  return mixJobs.get(id);
}

export function updateMixJob(id: string, patch: Partial<MixJob>): void {
  const j = mixJobs.get(id);
  if (j) Object.assign(j, patch);
}

export function publicMixJob(j: MixJob): Omit<MixJob, 'userId'> {
  const { userId: _u, ...pub } = j;
  return pub;
}

export async function combineReelsToMp4(
  sources: MixSource[],
  outPath: string,
  onLog?: (msg: string) => void,
  onProgress?: (p: MixProgress) => void
): Promise<{ filePath: string; sizeBytes: number; count: number }> {
  const list = (sources || []).filter((s) => s?.previewUrl && /^https?:/i.test(s.previewUrl));
  if (list.length === 0) throw new Error('No selectable clips — re-run Discovery first (preview links expire).');
  if (list.length > 10) throw new Error('Pick at most 10 reels per mix.');
  const dir = path.dirname(outPath);
  if (!fs.existsSync(dir)) fs.mkdirSync(dir, { recursive: true });
  const tmp = path.join(process.cwd(), 'temp', `igmix-${Date.now().toString(36)}`);
  fs.mkdirSync(tmp, { recursive: true });
  const ff = ffmpegBin();
  // Live output profile — the single source of truth lives in
  // liveStreamService (defaults 480x854 @ 24fps ~1000k ultrafast; env can
  // override). Normalizing straight to it keeps the mix fast and the loop
  // decoder cheap (same pixels in, same pixels out).
  const { w: MW, h: MH } = liveOutSize('vertical');
  const MFPS = liveFps();
  const MPRESET = livePreset();
  const MVBR = liveVideoKbps();
  const normFiles: string[] = [];
  try {
    let i = 0;
    for (const s of list) {
      i++;
      onLog?.(`Downloading ${i}/${list.length} (${s.shortcode})…`);
      onProgress?.({ step: `Downloading clip ${i}/${list.length} (${s.shortcode})…`, done: i * 2 - 2, total: list.length * 2 + 1 });
      const part = path.join(tmp, `part-${i}.mp4`);
      await downloadToFile(s.previewUrl, part);
      onLog?.(`Normalizing ${i}/${list.length} to ${MW}x${MH}@${MFPS} (live profile)…`);
      onProgress?.({ step: `Normalizing clip ${i}/${list.length} to ${MW}x${MH}@${MFPS}…`, done: i * 2 - 1, total: list.length * 2 + 1 });
      const norm = path.join(tmp, `norm-${i}.mp4`);
      const vf = `scale=${MW}:${MH}:force_original_aspect_ratio=increase,crop=${MW}:${MH},fps=${MFPS}`;
      const vArgs = ['-c:v', 'libx264', '-preset', MPRESET,
        '-b:v', `${MVBR}k`, '-maxrate', `${MVBR}k`, '-bufsize', `${MVBR * 2}k`,
        '-pix_fmt', 'yuv420p', '-g', '60'];
      const aArgs = ['-c:a', 'aac', '-b:a', '128k', '-ar', '44100', '-ac', '2'];
      if (partHasAudio(part)) {
        await runCmd(
          ff,
          ['-hide_banner', '-loglevel', 'error', '-y', '-i', part, '-vf', vf,
            ...vArgs, ...aArgs, '-movflags', '+faststart', norm],
          300000
        );
      } else {
        // Soundtrack-less part: pad generated silence so concat keeps A/V sync.
        await runCmd(
          ff,
          ['-hide_banner', '-loglevel', 'error', '-y', '-i', part,
            '-f', 'lavfi', '-i', 'anullsrc=r=44100:cl=stereo',
            '-vf', vf, ...vArgs, '-map', '0:v:0', '-map', '1:a:0',
            ...aArgs, '-shortest', '-movflags', '+faststart', norm],
          300000
        );
      }
      normFiles.push(norm);
    }
    const lstFile = path.join(tmp, 'list.txt');
    // Forward slashes: the concat demuxer treats backslash as an escape, so
    // native Windows paths (C:\...) would corrupt the file list on dev boxes.
    fs.writeFileSync(lstFile, normFiles.map((f) => `file '${f.replace(/\\/g, '/').replace(/'/g, "'\\''")}'`).join('\n'));
    onLog?.(`Joining ${normFiles.length} clips into one video…`);
    onProgress?.({ step: `Joining ${normFiles.length} clips into one video…`, done: list.length * 2, total: list.length * 2 + 1 });
    await runCmd(
      ff,
      ['-hide_banner', '-loglevel', 'error', '-y', '-f', 'concat', '-safe', '0',
        '-i', lstFile, '-c', 'copy', '-movflags', '+faststart', outPath],
      300000
    );
    const size = fs.statSync(outPath).size;
    if (size < 100 * 1024) throw new Error('Mix output too small — inputs were unreadable.');
    onProgress?.({ step: 'Mix video ready.', done: list.length * 2 + 1, total: list.length * 2 + 1 });
    return { filePath: outPath, sizeBytes: size, count: normFiles.length };
  } finally {
    try {
      fs.rmSync(tmp, { recursive: true, force: true });
    } catch {
      /* temp cleanup is best effort */
    }
  }
}
