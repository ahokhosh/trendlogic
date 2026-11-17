import fs from 'fs';
import path from 'path';
import dns from 'dns';
import { execSync, execFileSync, spawn, type ChildProcess } from 'child_process';
import { ffmpegBin } from './videoRenderer.js';
import { getAnyLiveStream, saveLiveStream, clearLiveStream, isDbReady } from './db.js';
import { fetchProxiedImage, isHostCooling } from './imageProxy.js';
import { writeGradientBmp } from './freeAiVideoService.js';
import { getRundownCountries, getRundownPointer, peekNextStory, rundownRotateSec, snapshotFromTrend } from './liveRundown.js';
import { renderStoryCard, isCardRendererAvailable, getCardRendererError, type CardInput } from './liveCardRenderer.js';
import { getStoryVoice, buildSlotAudio, prefetchStoryVoice, peekCachedVoice, voiceKey, voiceEnabled, getVoiceHealth } from './liveNarration.js';
// NOTE: liveCaptureService.ts (Chromium CDP engine) was removed — composed
// story cards render the same design faster, with zero browser/RAM overhead
// and no pipe-timing edge cases. Git history keeps the capture experiment.

// ---------------------------------------------------------------------------
// YouTube Live RTMP engine: pushes a CONTINUOUS, real-time generated
// broadcast to YouTube Live (default vertical 9:16 for the Shorts feed).
//
// What is "generated in the moment":
//   CARDS engine (default): every story is composed server-side into a full
//   broadcast frame (photo, LIVE bug, flag, title, question, description,
//   stats, top-5, source — same design as the preview page) and pumped to
//   ffmpeg at 30 fps. Rotation re-renders the next card in the background
//   and swaps the buffer: zero reconnects, zero gaps, story changes every
//   LIVE_ROTATE_SEC.
//   DRAWTEXT engine (fallback): story-wall photo + flag image + wrapped
//   straps drawn live with drawtext textfiles (reload=1). No ticker by
//   design in either engine.
//
// One global broadcast at a time: ffmpeg x264 is heavy, so a second start
// is rejected with 409 until the running one is stopped.
//
// Server-side by design: the ffmpeg child + the overlay refresh timer both
// live in THIS process — closing the browser/tab changes nothing. The
// session (owner, RTMP url, key, topic) is ALSO persisted in tl_live_stream
// so a server restart/redeploy auto-resumes the push with no client around.
// The stream key is NEVER returned by any endpoint (masked host only).
// ---------------------------------------------------------------------------

export interface LiveTrendSnapshot {
  keyword: string;
  question: string;
  description: string;
  category: string;
  traffic: string;
  velocity: number;
  score: number;
  ticker: string;
  topList: { rank: number; keyword: string; traffic: string }[];
  /** News photo (trend cover) + ISO country + lead source for the broadcast. */
  imageUrl: string | null;
  country: string;
  sourceName: string;
  sourceTitle: string;
}

/** What feeds the single global RTMP push: news story cards (rotation or
 *  pin) vs one Instagram reel looping until the profile timer swaps it.
 *  Reel mode reuses the SAME pipe encoder + pacer as cards — only the frame
 *  source (reel decoder instead of card renderer) and the audio source (reel
 *  soundtrack instead of narration) differ. Swapping reels therefore never
 *  touches the RTMP connection: the push stays up continuously. */
export type LiveSourceMode = 'news' | 'reel';

export interface LiveReelInfo {
  watchId: string;
  username: string;
  shortcode: string;
  startedAt: string;
}
/** Broadcast canvas: vertical 9:16 (phone-first, Shorts feed) is the default;
 *  horizontal 16:9 stays available for desktop-first streams. */
export type LiveOrientation = 'vertical' | 'horizontal';
export function normalizeLiveOrientation(v: unknown): LiveOrientation {
  return String(v || '').toLowerCase() === 'horizontal' ? 'horizontal' : 'vertical';
}
export function defaultLiveOrientation(): LiveOrientation {
  return normalizeLiveOrientation(process.env.LIVE_ORIENTATION);
}

/** Realtime encoder health parsed from ffmpeg -progress (null while off air
 *  or still warming up). speed < 1 means the encoder is slower than realtime
 *  — the exact condition behind YouTube's "not receiving enough video".
 *  totalMB proves bytes actually left the box (stuck-at-0 with uptime
 *  climbing = connected nowhere). */
export interface LiveEngineStats {
  fps: number;
  kbps: number;
  speed: number;
  totalMB: number;
  updatedAt: string;
}

export interface LiveSlot {
  countryCode: string;
  countryName: string;
  storyIndex: number; // 1-based within the country
  storyTotal: number;
}

/** What the viewer actually sees behind the text — answers "why no photo"
 *  directly from /api/stream/status. */
export interface LiveAssetsInfo {
  cover: LiveCoverKind;
  flag: boolean;
  photos: number;
}

export interface LiveStatus {
  active: boolean;
  startedAt: string | null;
  uptimeSec: number;
  topic: string;
  orientation: LiveOrientation;
  /** What feeds the push: news cards vs a looping Instagram reel. */
  mode: LiveSourceMode;
  /** Set while mode = reel (null in news mode / off air). */
  reel: LiveReelInfo | null;
  /** True = auto-rotation across countries/stories; false = pinned manual topic. */
  rotation: boolean;
  slot: LiveSlot | null;
  /** Which renderer feeds YouTube: composed story cards, or the drawtext
   *  mirror fallback. */
  engineType: 'cards' | 'drawtext';
  /** Why the card backend is unavailable (null when cards work or when the
   *  drawtext engine was explicitly forced). */
  cardError: string | null;
  rtmpHost: string | null;
  ffmpegOk: boolean;
  overlayUpdatedAt: string | null;
  /** Session durably stored — the push auto-resumes after a server restart. */
  persisted: boolean;
  engine: LiveEngineStats | null;
  /** True while the current slot carries real narration (false = silence). */
  voice: boolean;
  /** Narrator backend health (breaker, consecutive failures, last error). */
  voiceHealth: { coolingDown: boolean; consecFails: number; lastError: string | null; cached: number };
  /** Last rotation tick: age, render cost, photo hit — cadence proof. */
  tick: { ageSec: number | null; renderMs: number | null; photo: boolean };
  /** Pacer flow proof: ticks/writes since push start — a silent pacer with a
   *  live push is exactly "YouTube gets nothing". */
  pacer: { ticks: number; tickAgeMs: number | null; videoWrites: number; audioWrites: number; videoSkips: number; audioSkips: number; lastSkip: string | null; lastError: string | null };
  assets: LiveAssetsInfo;
  fonts: LiveFontStatus;
  logTail: string[];
  message: string;
}

/** server.ts injects a reader for the live trends database. */
let trendsProvider: (() => LiveTrendSnapshot | null) | null = null;
export function setLiveTrendsProvider(fn: () => LiveTrendSnapshot | null): void {
  trendsProvider = fn;
}

// ---- ffmpeg binary: shared resolver from videoRenderer (system full build
// wins, npm static is the fallback, and single-pod containers get a runtime
// apt/apk install when drawtext is missing). One source of truth so the
// live engine never 400s where template renders work. -----------------------
function binHasDrawtext(bin: string): boolean {
  try {
    const out = execSync(`"${bin}" -hide_banner -filters`, {
      timeout: 15000,
      stdio: ['ignore', 'pipe', 'pipe'],
    }).toString();
    return out.includes('drawtext');
  } catch {
    return false;
  }
}
function resolveFfmpegBin(): string {
  return ffmpegBin();
}

// ---- fonts (same files as videoRenderer) -----------------------------------
// drawtext + Windows drive colons are broken together: once a `fontfile=`
// value carries a `\:` escape (e.g. `D\:/...`), this static ffmpeg build
// mis-parses the REST of the filter ("Both text and text file provided"),
// quoted or not (verified by bisection). Fix: pass colon-free paths —
// CWD-relative on every OS, absolute only when it holds no colon at all
// (Linux /usr/... has none; Windows `D:\...` is skipped). The server
// contract is cwd = service folder (pod runner + compose both set it), so
// `assets/...` and `temp/...` resolve identically everywhere.
function liveFont(...candidates: string[]): string {
  for (const c of candidates) {
    if (!c || /:/.test(c)) continue; // drive colon would poison the filter
    const abs = path.isAbsolute(c) ? c : path.join(process.cwd(), c);
    if (fs.existsSync(abs)) return `fontfile=${c.replace(/\\/g, '/')}:`;
  }
  return '';
}
/** CWD-relative forward-slash path for drawtext textfile= (same colon rule). */
function liveRel(p: string): string {
  return path.relative(process.cwd(), p).replace(/\\/g, '/');
}

// ---- drawtext text sanitizer: textfile content is literal, but strip the
// chars that break the filter parser or draw odd glyphs ----------------------
function cleanLiveText(s: string, maxLen = 90): string {
  return String(s || '')
    .replace(/[\r\n\t]+/g, ' ')
    .replace(/[%:'"\\]/g, '')
    .replace(/\s+/g, ' ')
    .trim()
    .slice(0, maxLen);
}

/** Greedy word-wrap for narrow canvases (drawtext renders \n as new lines).
 *  Truncates with "..." when the text outgrows maxLines. */
function wrapLiveText(s: string, perLine: number, maxLines: number): string {
  const words = cleanLiveText(s, perLine * maxLines + 20).split(' ').filter(Boolean);
  const lines: string[] = [];
  let cur = '';
  let i = 0;
  while (i < words.length && lines.length < maxLines) {
    const t = cur ? cur + ' ' + words[i] : words[i];
    if (t.length > perLine && cur) {
      lines.push(cur);
      cur = '';
      continue; // retry the same word on the next line
    }
    cur = t;
    i++;
  }
  if (cur && lines.length < maxLines) lines.push(cur);
  const out = lines.slice(0, maxLines);
  if (i < words.length && out.length > 0) {
    const li = out.length - 1;
    out[li] = out[li].slice(0, Math.max(0, perLine - 3)).trimEnd() + '...';
  }
  return out.join('\n');
}

// ---- state ------------------------------------------------------------------
let child: ChildProcess | null = null;
let startedAt: string | null = null;
let currentTopic = '';
let currentOrientation: LiveOrientation = defaultLiveOrientation();
let rotationOn = true;
// Source mode + reel pointer (see LiveSourceMode). News rotation ticks and
// overlay refreshes are no-ops while a reel loop owns the push.
let liveMode: LiveSourceMode = 'news';
let reelInfo: LiveReelInfo | null = null;
/** Fired whenever the push ends (stop/restart/crash) so the reel decoder
 *  processes (owned by igLiveService) die with it — registered from server
 *  boot to avoid a live<->igLive import cycle. */
let liveStopHook: (() => void) | null = null;
export function setLiveStopHook(fn: () => void): void {
  liveStopHook = fn;
}
/** Self-heal path for reel mode: after an unexpected ffmpeg death the owner
 *  hook rebuilds the reel loop (same watch/file/key); returning true means
 *  "handled — skip the news restart". */
let liveReelRestartHook: (() => Promise<boolean>) | null = null;
export function setLiveReelRestartHook(fn: () => Promise<boolean>): void {
  liveReelRestartHook = fn;
}
export function getLiveMode(): LiveSourceMode {
  return liveMode;
}
export function getReelInfo(): LiveReelInfo | null {
  return reelInfo;
}
/** Feed one decoded reel frame (complete JPEG) into the 30 Hz pacer — the
 *  push duplicates it to YouTube until the next frame arrives. */
export function setReelFrame(jpeg: Buffer): void {
  if (!jpeg || jpeg.length < 1000) return;
  latestCard = jpeg;
}
/** Append decoded reel PCM (s16le 44.1k stereo) to the narration queue the
 *  pacer drains each tick. Bounded: when the decoder outruns realtime, the
 *  oldest audio is dropped (a glitch beats unbounded RAM + A/V drift). */
export function appendReelAudio(pcm: Buffer): void {
  if (!pcm || pcm.length === 0) return;
  const CAP = 8 * 1024 * 1024;
  if (audioQueue.length + pcm.length > CAP) {
    const overflow = audioQueue.length + pcm.length - CAP;
    audioQueue = audioQueue.subarray(Math.min(overflow, audioQueue.length));
  }
  audioQueue = Buffer.concat([audioQueue, pcm]);
}
export function setLiveTopicText(t: string): void {
  if (t) currentTopic = t;
}
let cardBackendError: string | null = null;
let assetsInfo: LiveAssetsInfo = { cover: 'none', flag: false, photos: 0 };
let fontsInfo: LiveFontStatus = { head: false, body: false };
let currentEngine: 'cards' | 'drawtext' = 'drawtext';
// Card pacer: the latest composed story frame, duplicated at 30 Hz into
// ffmpeg stdin so the push is ALWAYS dense realtime video (sparse delivery
// stalls some ffmpeg input paths; duplicates cost a memcpy and keep every
// timestamp truthful).
let latestCard: Buffer | null = null;
let pacerTimer: NodeJS.Timeout | null = null;
// Pacer flow proof (surfaced in /api/diag pushIo + /api/stream/status pacer):
// a silent pacer is exactly "push alive, YouTube gets nothing", so every tick
// records itself and every failure mode is counted, never swallowed.
let pacerTicks = 0;
let pacerLastTickAt = 0;
let pacerVideoWrites = 0;
let pacerAudioWrites = 0;
let pacerVideoSkips = 0;
let pacerAudioSkips = 0;
let pacerLastError: string | null = null;
let pacerLastSkip: string | null = null;
// Stall healer: a push that stops delivering (dead pacer OR wedged RTMP with
// zero bytes out) is killed so the existing unexpected-death path
// (stopPacer + scheduleAutoRestart, reel hook included) rebuilds it with
// backoff instead of lying LIVE forever. Bounded by the 5-try budget there.
let healTimer: NodeJS.Timeout | null = null;
let healFiredAt = 0;
let cardGen = 0;
const photoCache = new Map<string, Buffer>();
const flagCache = new Map<string, Buffer>();
// Narrator audio: exact-length slot PCM pumped with video (see liveNarration).
// Bytes per pacer tick derive from the output fps (44100 Hz stereo s16le =
// 176400 B/s ÷ fps) — computed inside startPacer, never hard-coded.
let audioQueue: Buffer = Buffer.alloc(0);
let voiceOn = false;
// Rotation tick diagnostics (answers "is the 10s cadence actually holding"
// straight from /api/stream/status).
let lastTickAt = 0;
let lastRenderMs: number | null = null;
let lastPhotoOk = false;

/** Renderer selection (async — availability needs a live probe):
 *  LIVE_ENGINE=cards forces composed frames (throws when the canvas backend
 *  is missing), =drawtext forces the mirror graph, auto (default) uses
 *  cards when available and falls back to drawtext otherwise. */
async function resolveEngine(): Promise<'cards' | 'drawtext'> {
  const want = String(process.env.LIVE_ENGINE || 'auto').trim().toLowerCase();
  if (want === 'drawtext') return 'drawtext';
  if (await isCardRendererAvailable()) {
    cardBackendError = null;
    return 'cards';
  }
  cardBackendError = getCardRendererError() || 'canvas backend failed to load';
  if (want === 'cards') {
    throw new Error(`Card engine requested (LIVE_ENGINE=cards) but unavailable: ${cardBackendError}`);
  }
  console.warn(`[LiveStream] card backend unavailable (${cardBackendError}) — drawtext mirror engine. Fix: ensure @napi-rs/canvas-linux-x64-musl is installed (see trendlogic.Dockerfile).`);
  return 'drawtext';
}
let ownerUserId: string | null = null;
let persistedSession = false;
let rtmpHostMasked: string | null = null;
let overlayUpdatedAt: string | null = null;
let refreshTimer: NodeJS.Timeout | null = null;
const stderrTail: string[] = [];
let engineStats: LiveEngineStats | null = null;
let progressBuf = '';
let autoRestartTimer: NodeJS.Timeout | null = null;
let autoRestartAttempts = 0;

const OVERLAY_DIR = path.join(process.cwd(), 'temp', 'livestream');
const REFRESH_MS = parseInt(process.env.LIVE_OVERLAY_REFRESH_MS || '120000', 10) || 120000;

function overlayPaths() {
  const base = {
    headline: path.join(OVERLAY_DIR, 'headline.txt'),
    question: path.join(OVERLAY_DIR, 'question.txt'),
    desc: path.join(OVERLAY_DIR, 'desc.txt'),
    traffic: path.join(OVERLAY_DIR, 'traffic.txt'),
    stats: path.join(OVERLAY_DIR, 'stats.txt'),
    nextup: path.join(OVERLAY_DIR, 'nextup.txt'),
    source: path.join(OVERLAY_DIR, 'source.txt'),
    country: path.join(OVERLAY_DIR, 'country.txt'),
  };
  // Top-story rows mirror the preview sidebar (built dynamically — only
  // existing rows get a drawtext; an empty textfile fails filter init).
  const rows: Record<string, string> = {};
  for (let i = 1; i <= 5; i++) rows[`top${i}`] = path.join(OVERLAY_DIR, `top${i}.txt`);
  return { ...base, ...rows } as typeof base & Record<string, string>;
}

/** Write the drawtext overlay files from a trend snapshot. Headline/question
 *  are word-wrapped (narrow 9:16 canvas needs it; the 16:9 graph benefits
 *  too — long single lines used to run off-canvas). */
export function writeLiveOverlay(snap: LiveTrendSnapshot): void {
  fs.mkdirSync(OVERLAY_DIR, { recursive: true });
  const p = overlayPaths();
  const kw = cleanLiveText(snap.keyword, 90) || 'Trending now';
  fs.writeFileSync(p.headline, wrapLiveText(kw.toUpperCase(), 30, 2) || 'TRENDING NOW', 'utf8');
  fs.writeFileSync(p.question, wrapLiveText(snap.question, 48, 2) || 'Why is this trending today', 'utf8');
  fs.writeFileSync(p.traffic, cleanLiveText(snap.traffic, 24) || 'surging', 'utf8');
  fs.writeFileSync(
    p.source,
    cleanLiveText(`${snap.sourceName || 'Google Trends'}  •  ${snap.sourceTitle || snap.description}`, 84) || 'LIVE FROM GOOGLE TRENDS',
    'utf8'
  );
  const cc = /^[A-Za-z]{2}$/.test(String(snap.country || '').trim()) ? String(snap.country).trim().toUpperCase() : '';
  fs.writeFileSync(p.country, cc || 'LIVE', 'utf8');
  const rank = snap.topList.find(t => t.keyword === snap.keyword)?.rank
    ?? snap.topList.find(t => t.keyword !== snap.keyword)?.rank ?? 1;
  fs.writeFileSync(
    p.stats,
    cleanLiveText(`#${rank} TRENDING  •  VEL ${snap.velocity}  •  SCORE ${snap.score}  •  ${snap.traffic}`, 90),
    'utf8'
  );
  const idx = snap.topList.findIndex(t => t.keyword === snap.keyword);
  const next = (idx >= 0 ? snap.topList[idx + 1] : null)
    || snap.topList.find(t => t.keyword !== snap.keyword)
    || null;
  fs.writeFileSync(
    p.nextup,
    next ? cleanLiveText(`NEXT  #${next.rank} ${next.keyword}`, 48) : 'LIVE FROM GOOGLE TRENDS',
    'utf8'
  );
  // Story description (preview parity) + sidebar rows. Rows carry rank,
  // keyword and traffic exactly like the preview list; files for missing
  // rows are removed so the builder skips them (empty textfile = init fail).
  fs.writeFileSync(p.desc, wrapLiveText(snap.description, 56, 2) || ' ', 'utf8');
  const rows = snap.topList.slice(0, 5);
  for (let i = 0; i < 5; i++) {
    const f = (p as Record<string, string>)[`top${i + 1}`];
    const r = rows[i];
    if (r) {
      fs.writeFileSync(f, cleanLiveText(`#${r.rank} ${r.keyword} (${r.traffic})`, 52) || ' ', 'utf8');
    } else {
      try { fs.rmSync(f, { force: true }); } catch { /* absent = skipped */ }
    }
  }
  overlayUpdatedAt = new Date().toISOString();
}

/** News photo + country flag for the broadcast (CWD-relative paths ready
 *  for drawtext/overlay). Photo: the trend's own cover (same one the UI
 *  shows); flag: flagcdn by ISO country. Fresh files per topic — stale
 *  cover.* are wiped first so a failed download never shows yesterday's
 *  picture. No photo → locally generated gradient backdrop (never blank).
 *  All downloads ride the SSRF-guarded image proxy (8 MB, image/* only). */
export type LiveCoverKind = 'wall' | 'single' | 'gradient' | 'page' | 'card' | 'none';

export interface LiveAssets {
  cover: string; // always present (photo or generated gradient)
  flag: string | null; // null when the country has no fetchable flag
  kind: LiveCoverKind; // what the viewer actually sees behind the text
  photos: number; // story photos stitched (0 = generated backdrop)
}

export interface LiveFontStatus {
  head: boolean;
  body: boolean;
}

function wipeCovers(): void {
  try {
    for (const f of fs.readdirSync(OVERLAY_DIR)) {
      if (/^cover\.[a-z0-9]+$/i.test(f) || /^cell\d+\.[a-z0-9]+$/i.test(f) || f === 'flag.png') {
        try { fs.rmSync(path.join(OVERLAY_DIR, f), { force: true }); } catch { /* keep going */ }
      }
    }
  } catch { /* dir may not exist yet */ }
}

/** Stitch downloaded story photos into one grid backdrop (single ffmpeg
 *  still render at start — NOT live). Cells cycle-fill when photos don't
 *  divide the grid evenly. Returns the CWD-relative cover path or null.
 *  Exported for file-based verification of the exact on-air filter graph. */
export function buildCoverGrid(cellAbs: string[], orientation: LiveOrientation): string | null {
  try {
    const vertical = orientation === 'vertical';
    const cols = vertical ? 2 : 3;
    const CW = vertical ? 540 : 640;
    const CH = vertical ? 640 : 540;
    const rows = Math.min(vertical ? 3 : 2, Math.max(1, Math.ceil(cellAbs.length / cols)));
    const total = cols * rows;
    const layout: string[] = [];
    const parts: string[] = [];
    const inputs: string[] = [];
    for (let i = 0; i < total; i++) {
      const src = cellAbs[i % cellAbs.length];
      inputs.push('-i', src);
      parts.push(`[${i}:v]scale=${CW}:${CH}:force_original_aspect_ratio=increase,crop=${CW}:${CH},setsar=1[c${i}]`);
      layout.push(`${(i % cols) * CW}_${Math.floor(i / cols) * CH}`);
    }
    const fc = `${parts.join(';')};${parts.map((_, i) => `[c${i}]`).join('')}xstack=inputs=${total}:layout=${layout.join('|')}[cover]`;
    const out = path.join(OVERLAY_DIR, 'cover.jpg');
    try { fs.rmSync(out, { force: true }); } catch { /* fresh */ }
    execFileSync(resolveFfmpegBin(), [
      '-hide_banner', '-loglevel', 'error',
      ...inputs,
      '-filter_complex', fc,
      '-map', '[cover]', '-frames:v', '1', '-q:v', '3', out,
    ], { timeout: 90000, stdio: ['ignore', 'pipe', 'pipe'] });
    const st = fs.statSync(out);
    if (st.size > 0) return liveRel(out);
    return null;
  } catch (err) {
    console.warn('[LiveStream] grid stitch note:', (err as Error)?.message || err);
    return null;
  }
}

const COVER_EXT_BY_TYPE: Record<string, string> = {
  'image/png': 'png',
  'image/jpeg': 'jpg',
  'image/webp': 'webp',
  'image/gif': 'gif',
};

export async function ensureLiveAssets(
  stories: { imageUrl: string | null }[],
  country: string,
  orientation: LiveOrientation
): Promise<LiveAssets> {
  fs.mkdirSync(OVERLAY_DIR, { recursive: true });
  wipeCovers();
  const done = (cover: string, flag: string | null, kind: LiveCoverKind, photos: number): LiveAssets =>
    ({ cover, flag, kind, photos });
  // Story wall: one photo per country top story (max 6, current story
  // first), stitched into a single grid backdrop. A single RTMP push can
  // never hot-swap its image input (ffmpeg -loop caches the file — verified
  // empirically), so the wall carries every photo the rotation will show:
  // text/flag/country rotate live over it with zero reconnects.
  let cover: string | null = null;
  let kind: LiveCoverKind = 'none';
  let photos = 0;
  const seen = new Set<string>();
  const urls: string[] = [];
  for (const s of stories) {
    const u = String(s?.imageUrl || '').trim();
    // Skip hosts under cooldown (recent 403/410) — the wall only carries
    // photos that actually load.
    if (u && !seen.has(u) && !isHostCooling(u) && urls.length < 6) {
      seen.add(u);
      urls.push(u);
    }
  }
  if (urls.length > 0) {
    try {
      const got = await Promise.allSettled(urls.map(u => fetchProxiedImage(u)));
      const shots: { abs: string }[] = [];
      got.forEach((r, i) => {
        if (r.status !== 'fulfilled') return;
        try {
          const ext = COVER_EXT_BY_TYPE[r.value.contentType] || 'jpg';
          const abs = path.join(OVERLAY_DIR, `cell${i}.${ext}`);
          fs.writeFileSync(abs, r.value.buf);
          shots.push({ abs });
        } catch { /* skip this cell */ }
      });
      if (shots.length >= 2) {
        const grid = buildCoverGrid(shots.map(s => s.abs), orientation);
        if (grid) {
          cover = grid;
          kind = 'wall';
          photos = shots.length;
        }
      }
      if (!cover && shots.length >= 1) {
        try {
          const first = shots[0].abs;
          const abs = path.join(OVERLAY_DIR, `cover.${first.split('.').pop() || 'jpg'}`);
          if (first !== abs) fs.renameSync(first, abs);
          cover = liveRel(abs);
          kind = 'single';
          photos = 1;
        } catch { /* fall through to gradient */ }
      }
      // Leftover cell files are wiped on the next ensure (wipeCovers covers cell*).
      for (const s of shots) {
        try {
          if (fs.existsSync(s.abs)) fs.rmSync(s.abs, { force: true });
        } catch { /* best effort */ }
      }
      if (cover) console.log(`[LiveStream] cover ready (${kind}, ${photos} photos, ${orientation}).`);
    } catch (err) {
      console.warn('[LiveStream] cover download note, using generated backdrop:', (err as Error)?.message || err);
    }
  }
  if (!cover) {
    const abs = path.join(OVERLAY_DIR, 'cover.bmp');
    try {
      writeGradientBmp(abs, 350, 215);
      cover = liveRel(abs);
      kind = 'gradient';
    } catch (err) {
      console.warn('[LiveStream] gradient backdrop note:', (err as Error)?.message || err);
      cover = '';
    }
  }
  let flag: string | null = null;
  const cc = /^[A-Za-z]{2}$/.test(String(country || '').trim()) ? String(country).trim().toLowerCase() : '';
  if (cc) {
    try {
      const img = await fetchProxiedImage(`https://flagcdn.com/w160/${cc}.png`);
      const abs = path.join(OVERLAY_DIR, 'flag.png');
      fs.writeFileSync(abs, img.buf);
      flag = liveRel(abs);
    } catch (err) {
      console.warn('[LiveStream] flag download note (continuing without it):', (err as Error)?.message || err);
    }
  }
  return done(cover || '', flag, kind, photos);
}

function refreshOverlayFromProvider(): void {
  try {
    // A reel loop owns every pixel + sample while on air — news overlay
    // files must not repaint under it (and the drawtext graph isn't running).
    if (liveMode === 'reel') return;
    if (!trendsProvider) return;
    const snap = trendsProvider();
    if (!snap) return;
    writeLiveOverlay(snap);
    if (snap.keyword && snap.keyword !== currentTopic) currentTopic = snap.keyword;
    // NOTE: cover files are intentionally NOT rewritten here — ffmpeg -loop
    // caches its image inputs (verified), so mid-stream swaps never appear.
    // The story-wall backdrop (built at start from every country's top
    // photo) already contains each photo the rotation shows; only text,
    // flag and country straps follow the topic live.
  } catch (err) {
    console.warn('[LiveStream] overlay refresh note:', (err as Error)?.message || err);
  }
}

export function isLiveActive(): boolean {
  return !!child && child.exitCode === null && !child.killed;
}

/** Owner of the running broadcast (null when off air). Routes use it to
 *  decide whose Start/Stop/Restart buttons are armed — never sent raw. */
export function getLiveOwner(): string | null {
  return isLiveActive() ? ownerUserId : null;
}

/** Current rotation slot for the status line (null when pinned or off air). */
function currentSlotInfo(): LiveSlot | null {
  if (!isLiveActive() || !rotationOn) return null;
  try {
    const ptr = getRundownPointer();
    const list = getRundownCountries();
    const c = list[ptr.countryIdx];
    if (!c || c.stories.length === 0) return null;
    return {
      countryCode: c.code,
      countryName: c.name,
      storyIndex: Math.min(ptr.storyIdx, c.stories.length - 1) + 1,
      storyTotal: c.stories.length,
    };
  } catch {
    return null;
  }
}

/** Rotation tick entry point (wired to the rundown loop at boot). Cards
 *  engine: render + swap the next frame (fire-and-forget, generation
 *  guarded). Drawtext engine: repaint the live overlay text. No-op off air. */
export function handleRundownSlot(): void {
  try {
    // Reel mode has no slots — the decoder owns the frames; a rotation tick
    // must never swap a card buffer over the looping reel.
    if (liveMode === 'reel') return;
    if (!isLiveActive() || !trendsProvider) return;
    if (currentEngine === 'cards') {
      void rotateCardSlot();
      return;
    }
    const snap = trendsProvider();
    if (!snap) return;
    writeLiveOverlay(snap);
    if (snap.keyword) currentTopic = snap.keyword;
  } catch (err) {
    console.warn('[LiveStream] slot repaint note:', (err as Error)?.message || err);
  }
}

/** Throttle for the zero-byte stall warning (log at most once per 5 min). */
let stalledWarnedAt = 0;

export interface FfmpegProcInfo {
  pid: number;
  ppid: number;
  comm: string;
  state: string;
  /** User+system CPU seconds consumed (approx: assumes 100Hz ticks). */
  cpuSec: number;
  rssMB: number;
  /** Seconds since the process started (null when unknowable). */
  etimeSec: number | null;
  /** Full command line with any stream key redacted (safe for diag output). */
  cmd: string;
  /** True when this is OUR current push child (not a stale orphan). */
  ours: boolean;
  /** Current syscall of the main thread (lightweight strace: read/poll =
   *  waiting input, connect = hanging RTMP dial, futex = idle/compute). */
  syscall: string;
  /** Kernel wait channel (pipe_wait / poll_schedule_timeout / 0…). */
  wchan: string;
}

/** x86_64 syscall numbers we care about (best-effort labels). */
function syscallLabel(nr: number): string {
  const map: Record<number, string> = {
    0: 'read', 1: 'write', 7: 'poll', 9: 'mmap', 10: 'mprotect', 11: 'munmap',
    42: 'connect', 43: 'accept', 44: 'sendto', 45: 'recvfrom', 48: 'shutdown',
    202: 'futex', 228: 'clock_gettime', 230: 'exit_group',
    231: 'epoll_wait', 232: 'epoll_wait', 233: 'epoll_ctl', 270: 'pselect6', 271: 'ppoll',
    281: 'epoll_pwait', 284: 'sched_yield', 35: 'nanosleep',
  };
  return map[nr] || `sys_${nr}`;
}

function clockTicksPerSec(): number {
  try {
    const out = execSync('getconf CLK_TCK', { timeout: 5000, stdio: ['ignore', 'pipe', 'pipe'] }).toString().trim();
    const v = parseInt(out, 10);
    if (isFinite(v) && v > 0) return v;
  } catch { /* default below */ }
  return 100;
}

function procBootEpochSec(): number | null {
  try {
    const txt = fs.readFileSync('/proc/stat', 'utf8');
    const m = /^btime (\d+)$/m.exec(txt);
    if (m) return parseInt(m[1], 10);
  } catch { /* non-linux */ }
  return null;
}

/** Every ffmpeg on the box (any parent) + our direct children: answers "is
 *  the encoder burning CPU (output blocked) or sleeping (input starved)?"
 *  and "did a previous deploy leave an orphan push holding our stream key?".
 *  Linux-only (/proc); everywhere else returns []. */
export function listFfmpegProcs(): FfmpegProcInfo[] {
  const out: FfmpegProcInfo[] = [];
  if (process.platform !== 'linux') return out;
  let pids: string[];
  try {
    pids = fs.readdirSync('/proc').filter(d => /^\d+$/.test(d));
  } catch {
    return out;
  }
  const HZ = clockTicksPerSec();
  const btime = procBootEpochSec();
  const nowSec = Math.floor(Date.now() / 1000);
  const ourChildPid: number | null = child ? (child as any).pid ?? null : null;
  for (const pidStr of pids) {
    const pid = parseInt(pidStr, 10);
    let comm = '';
    try {
      comm = fs.readFileSync(`/proc/${pidStr}/comm`, 'utf8').trim();
    } catch {
      continue;
    }
    const isOurs = ourChildPid !== null && pid === ourChildPid;
    if (comm !== 'ffmpeg' && !isOurs) continue; // only ffmpeg matters here
    let state = '?';
    let ppid = 0;
    let cpuSec = 0;
    let rssMB = 0;
    let etimeSec: number | null = null;
    try {
      const stat = fs.readFileSync(`/proc/${pidStr}/stat`, 'utf8');
      const after = stat.slice(stat.lastIndexOf(')') + 1).trim().split(/\s+/);
      state = after[0] || '?';
      ppid = parseInt(after[1], 10) || 0;
      const utime = parseInt(after[11], 10) || 0;
      const stime = parseInt(after[12], 10) || 0;
      cpuSec = Math.round(((utime + stime) / HZ) * 10) / 10;
      const rssPages = parseInt(after[21], 10) || 0;
      rssMB = Math.round((rssPages * 4096) / 1024 / 1024 * 10) / 10;
      const starttime = parseInt(after[19], 10) || 0;
      if (btime !== null && starttime > 0) etimeSec = Math.max(0, nowSec - (btime + Math.floor(starttime / HZ)));
    } catch {
      continue;
    }
    let cmd = '';
    try {
      cmd = fs.readFileSync(`/proc/${pidStr}/cmdline`, 'utf8').split('\0').filter(Boolean).join(' ');
    } catch {
      cmd = '';
    }
    // Redact the stream key (everything after /live/ or /live2/) — the host
    // stays visible so "where does it push" remains answerable.
    cmd = cmd.replace(/(live2?\/)[^\s'"]+/gi, '$1***').slice(0, 400);
    let syscall = '?';
    let wchan = '?';
    try {
      const sc = fs.readFileSync(`/proc/${pidStr}/syscall`, 'utf8').trim().split(/\s+/)[0];
      const nr = parseInt(sc, 10);
      syscall = isFinite(nr) ? (nr === -1 ? 'running' : syscallLabel(nr)) : '?';
    } catch { /* gone or restricted */ }
    try {
      wchan = fs.readFileSync(`/proc/${pidStr}/wchan`, 'utf8').trim() || '?';
    } catch { /* gone or restricted */ }
    out.push({ pid, ppid, comm, state, cpuSec, rssMB, etimeSec, cmd, ours: isOurs, syscall, wchan });
    if (out.length >= 40) break;
  }
  return out;
}

/** Kill YouTube RTMP pushes left behind by a previous process incarnation
 *  (a SIGKILLed node never runs its exit handler, so its ffmpeg keeps the
 *  stream-key slot on YouTube and the new push fights it). Matches any ffmpeg
 *  whose command line pushes over rtmp:// (hostname OR IPv4 literal — the
 *  dial target is an IP since the IPv4-literal fix). The downloader's
 *  transcodes never contain rtmp:// output. Call once at boot, before resume. */
export function reapStaleRtmpPushes(): number {
  if (process.platform !== 'linux') return 0;
  const stale = listFfmpegProcs().filter(p => !p.ours && /rtmp:\/\//i.test(p.cmd));
  for (const p of stale) {
    try {
      console.log(`[LiveStream] reaping stale RTMP push from a previous incarnation (pid=${p.pid} etime=${p.etimeSec ?? '?'}s): ${p.cmd.slice(0, 120)}`);
      process.kill(p.pid, 'SIGTERM');
      setTimeout(() => {
        try {
          if (fs.existsSync(`/proc/${p.pid}`)) {
            process.kill(p.pid, 'SIGKILL');
            console.log(`[LiveStream] stale push pid=${p.pid} ignored SIGTERM — SIGKILL sent.`);
          }
        } catch { /* already gone */ }
      }, 4000)?.unref?.();
    } catch (err) {
      console.warn(`[LiveStream] reap note for pid=${p.pid}:`, (err as Error)?.message || err);
    }
  }
  if (stale.length > 0) console.log(`[LiveStream] reaped ${stale.length} stale RTMP push(es) — the stream-key slot is free.`);
  return stale.length;
}

export function getLiveStatus(): LiveStatus {
  const ff = resolveFfmpegBin();
  const onAir = isLiveActive();
  const uptimeSec = startedAt ? Math.max(0, Math.round((Date.now() - new Date(startedAt).getTime()) / 1000)) : 0;
  // Zero-byte stall: the push process is alive but nothing leaves the box
  // (uptime climbs, totalMB frozen at 0). YouTube then shows "No data" while
  // the UI would otherwise claim LIVE — surface it loudly instead: the cause
  // is always outside the encoder (blocked RTMP egress, dead handshake that
  // -rw_timeout hasn't reaped yet, or a rejected key mid-session).
  const stalled = onAir && uptimeSec > 90 && (!engineStats || !(engineStats.totalMB > 0));
  if (stalled && Date.now() - stalledWarnedAt > 5 * 60 * 1000) {
    stalledWarnedAt = Date.now();
    console.error(
      `[LiveStream] STALLED push: alive ${uptimeSec}s with 0 MB out to ${rtmpHostMasked || 'RTMP'} — ` +
      `YouTube receives nothing ("No data"). Check outbound TCP/1935 egress + stream key. ` +
      `ffmpeg tail: ${stderrTail.slice(-2).join(' | ') || '(empty)'}`
    );
  }
  return {
    active: onAir,
    startedAt,
    uptimeSec,
    topic: currentTopic,
    orientation: currentOrientation,
    mode: onAir ? liveMode : 'news',
    reel: onAir && liveMode === 'reel' ? reelInfo : null,
    rotation: rotationOn,
    slot: currentSlotInfo(),
    engineType: currentEngine,
    cardError: cardBackendError,
    rtmpHost: rtmpHostMasked,
    ffmpegOk: binHasDrawtext(ff),
    overlayUpdatedAt,
    persisted: persistedSession,
    engine: isLiveActive() ? engineStats : null,
    voice: isLiveActive() ? voiceOn : false,
    voiceHealth: getVoiceHealth(),
    tick: {
      ageSec: lastTickAt ? Math.max(0, Math.round((Date.now() - lastTickAt) / 1000)) : null,
      renderMs: lastRenderMs,
      photo: lastPhotoOk,
    },
    pacer: {
      ticks: pacerTicks,
      tickAgeMs: pacerLastTickAt > 0 ? Math.max(0, Date.now() - pacerLastTickAt) : null,
      videoWrites: pacerVideoWrites,
      audioWrites: pacerAudioWrites,
      videoSkips: pacerVideoSkips,
      audioSkips: pacerAudioSkips,
      lastSkip: pacerLastSkip,
      lastError: pacerLastError,
    },
    assets: assetsInfo,
    fonts: fontsInfo,
    logTail: stderrTail.slice(-15),
    message: !isLiveActive()
      ? 'Off air — paste your YouTube stream key and press Go Live.'
      : stalled
        ? `STALLED — push is alive ${uptimeSec}s but 0 MB reached YouTube ("No data" in Studio). Outbound RTMP is blocked or the handshake is wedged — check the server log for [LiveStream] STALLED.`
        : `LIVE — streaming "${currentTopic}" to YouTube.`,
  };
}

function maskRtmpForLog(url: string): string {
  try {
    const u = new URL(url.replace(/^rtmp/, 'http'));
    return `rtmp://${u.host}${u.pathname}`;
  } catch {
    return 'rtmp://<host>/live/***';
  }
}

/** Dial-target for ffmpeg: the ingest hostname rewritten to a literal IPv4
 *  (pods resolve AAAA-first with no global IPv6; plain RTMP needs no SNI).
 *  Falls back to the hostname when DNS fails. Exported for the diag probe. */
export async function dialTargetFor(base: string, key: string): Promise<string> {
  const target = `${base}${key}`;
  let host = '';
  try {
    host = new URL(base.replace(/^rtmp/, 'http')).hostname;
  } catch {
    return target;
  }
  if (!host || /^\d+\.\d+\.\d+\.\d+$/.test(host)) return target;
  try {
    const lookup = dns.promises.lookup(host, { family: 4 });
    const timeout = new Promise<null>(resolve => setTimeout(() => resolve(null), 6000));
    const found = await Promise.race([lookup, timeout]);
    const ip = typeof found === 'object' && found && typeof (found as any).address === 'string'
      ? (found as any).address as string
      : null;
    if (ip) {
      console.log(`[LiveStream] RTMP dial via IPv4 ${ip} (ingest host ${host}).`);
      return target.replace(host, ip);
    }
  } catch (err) {
    console.warn('[LiveStream] IPv4 resolve note (dialing hostname as-is):', (err as Error)?.message || err);
  }
  return target;
}

export interface StartLiveOptions {
  rtmpUrl: string;
  streamKey: string;
  snapshot: LiveTrendSnapshot;
  /** Signed-in user pressing Go Live — owns Stop/Restart, persisted for resume. */
  ownerUserId: string | null;
  /** Canvas: vertical 9:16 default, horizontal 16:9 on request. */
  orientation?: LiveOrientation | null;
  /** False = pinned manual topic (no rotation); default true = rundown. */
  rotation?: boolean;
}

/**
 * Build the ffmpeg invocation for the live picture (exported so the exact
 * filter graph can be verified against a local file without touching any
 * channel: replace the trailing target with a .mp4 path + `-t N`).
 */
// Output profile: LIGHTWEIGHT by design (YouTube "not receiving enough
// video" buffering warnings come from feeding slower than realtime).
// Vertical reels go out at 480x854, 24 fps, ~1500k video + 128k audio —
// light enough for the pod CPU + egress with wide headroom, yet clean enough
// for high-motion reels (1000k showed block artifacts after the double
// transcode mix->MJPEG->air). Keyframes every 2s per YouTube's spec
// (g = fps*2). Near-static cards compress trivially, so visual loss is
// negligible. Tunables for ops: LIVE_FPS (15..30, default 24),
// LIVE_VBITRATE_K (400..8000, default 1500), LIVE_RES (e.g. 540x960 —
// overrides per-canvas default), LIVE_PRESET (default ultrafast).
const LIVE_PRESET_ALLOW = new Set(['ultrafast', 'superfast', 'veryfast', 'faster', 'fast', 'medium']);
// ultrafast default: the air signal is near-static story cards, which compress
// trivially at any preset — ultrafast roughly halves encoder CPU vs veryfast
// with no visible difference here, headroom YouTube buffering warnings need.
// LIVE_PRESET / LIVE_VBITRATE_K still override per deployment.
export function livePreset(): string {
  const p = String(process.env.LIVE_PRESET || 'ultrafast').trim().toLowerCase();
  return LIVE_PRESET_ALLOW.has(p) ? p : 'ultrafast';
}
export function liveVideoKbps(): number {
  const v = parseInt(process.env.LIVE_VBITRATE_K || '1500', 10);
  if (!isFinite(v)) return 1500;
  return Math.min(8000, Math.max(400, v));
}

/** Output frame rate (default 24 — reels/cards look identical, cost less). */
export function liveFps(): number {
  const v = parseInt(process.env.LIVE_FPS || '24', 10);
  if (!isFinite(v)) return 24;
  return Math.min(30, Math.max(15, v));
}

/** Output canvas (default 480x854 vertical / 854x480 horizontal).
 *  LIVE_RES="540x960" overrides both canvases (single size for ops). */
export function liveOutSize(o: LiveOrientation): { w: number; h: number } {
  const m = /^\s*(\d{3,4})\s*x\s*(\d{3,4})\s*$/i.exec(String(process.env.LIVE_RES || ''));
  if (m) {
    const w = parseInt(m[1], 10);
    const h = parseInt(m[2], 10);
    if (w >= 240 && w <= 1920 && h >= 240 && h <= 1920) return { w, h };
  }
  return o === 'vertical' ? { w: 480, h: 854 } : { w: 854, h: 480 };
}

export interface LiveBuilderAssets {
  cover: string; // CWD-relative image (news photo or generated gradient)
  flag: string | null; // CWD-relative flag PNG, null when unavailable
}

export function buildLiveFfmpegArgs(
  snapshot: LiveTrendSnapshot,
  target: string,
  orientation: LiveOrientation = defaultLiveOrientation(),
  assets?: LiveBuilderAssets | null
): { bin: string; args: string[]; fonts: LiveFontStatus } {
  const ff = resolveFfmpegBin();
  const vbr = liveVideoKbps();
  const preset = livePreset();
  // Colon-free paths only (see liveFont): relative first, Linux absolute
  // (no drive colon) as fallback. Order mirrors videoRenderer (Archivo for
  // headlines, Liberation for body) where the files exist.
  const HEAD = liveFont('assets/fonts/ArchivoBlack-Regular.ttf', '/usr/share/fonts/truetype/liberation/LiberationSans-Bold.ttf');
  const BODY = liveFont('/usr/share/fonts/truetype/liberation/LiberationSans-Bold.ttf', 'assets/fonts/ArchivoBlack-Regular.ttf');
  const p = overlayPaths();
  const esc = (s: string) => liveRel(s);
  void snapshot; // overlay text arrives via textfiles, never via argv

  const vertical = orientation === 'vertical';
  const W = vertical ? 1080 : 1920;
  const H = vertical ? 1920 : 1080;
  const cover = assets?.cover || '';
  const flag = assets?.flag || null;

  // Inputs: looped cover photo (or flat color), looped flag PNG, silent audio.
  // filter_complex is mandatory (two video inputs) — -vf can't do this.
  const inputs: string[] = [];
  if (cover) {
    inputs.push('-loop', '1', '-framerate', '30', '-i', cover);
  } else {
    inputs.push('-f', 'lavfi', '-i', `color=c=0x0a0f1e:s=${W}x${H}:r=30`);
  }
  if (flag) inputs.push('-loop', '1', '-i', flag);
  inputs.push('-f', 'lavfi', '-i', 'anullsrc=r=44100:cl=stereo');
  const audioIdx = flag ? 2 : 1;

  // Background: story-wall photo scaled+cropped to fill, dimmed so text
  // always reads, plus a darker top bar band (mirrors the preview header).
  const barH = vertical ? 150 : 120;
  let fc = cover
    ? `[0:v]scale=${W}:${H}:force_original_aspect_ratio=increase,crop=${W}:${H},setsar=1,drawbox=x=0:y=0:w=iw:h=ih:c=black@0.45:t=fill,drawbox=x=0:y=0:w=iw:h=${barH}:c=black@0.6:t=fill[bg]`
    : `[0:v]setsar=1,drawbox=x=0:y=0:w=iw:h=${barH}:c=black@0.6:t=fill[bg]`;
  let vid = '[bg]';
  const flagY = vertical ? 30 : 28;
  if (flag) {
    fc += `;[1:v]scale=140:-1,format=rgba[fg];${vid}[fg]overlay=(W-w-40):${flagY}:format=auto[vid]`;
    vid = '[vid]';
  }
  let dtCount = 0;
  const dt = (filter: string): void => {
    const out = `[t${dtCount++}]`;
    fc += `;${vid}drawtext=${filter}${out}`;
    vid = out;
  };
  // Sidebar rows mirror the preview top list (rank + keyword + traffic).
  // Only existing files get a filter — an empty textfile fails filter init.
  const absOf = (rel: string): string => path.join(process.cwd(), rel);
  const rowFiles = [1, 2, 3, 4, 5]
    .map(i => (p as Record<string, string>)[`top${i}`])
    .filter(f => {
      try {
        return !!f && fs.existsSync(absOf(liveRel(f)));
      } catch {
        return false;
      }
    });
  // Live clock (drawtext strftime expansion — same time the preview shows).
  const CLOCK = `%{localtime\\:%H\\:%M}`;

  if (vertical) {
    // Vertical 9:16 — mirrors LiveNewsSceneVertical: top bar, kicker, hero
    // title, question, description, stats, story list, source footer.
    dt(`${HEAD}text='LIVE':fontcolor=white:fontsize=52:x=48:y=40:box=1:boxcolor=0xdc2626:boxborderw=24`);
    dt(`${BODY}textfile='${esc(p.traffic)}':reload=1:fontcolor=white:fontsize=36:x=260:y=52:box=1:boxcolor=black@0.55:boxborderw=14`);
    dt(`${BODY}text='${CLOCK}':fontcolor=white:fontsize=36:x=w-text_w-220:y=52`);
    dt(`${BODY}textfile='${esc(p.country)}':reload=1:fontcolor=white:fontsize=36:x=48:y=168:box=1:boxcolor=black@0.55:boxborderw=14`);
    dt(`${BODY}text='TRENDING NOW':fontcolor=0xfcd34d:fontsize=44:x=(w-text_w)/2:y=320:borderw=1:bordercolor=black@0.85`);
    dt(`${HEAD}textfile='${esc(p.headline)}':reload=1:fontcolor=white:fontsize=84:x=(w-text_w)/2:y=400:line_spacing=12:borderw=2:bordercolor=black@0.85`);
    dt(`${BODY}textfile='${esc(p.question)}':reload=1:fontcolor=0xfcd34d:fontsize=46:x=(w-text_w)/2:y=880:line_spacing=10:borderw=1:bordercolor=black@0.85`);
    dt(`${BODY}textfile='${esc(p.desc)}':reload=1:fontcolor=0xe2e8f0:fontsize=38:x=(w-text_w)/2:y=1100:line_spacing=8:borderw=1:bordercolor=black@0.85`);
    dt(`${BODY}textfile='${esc(p.stats)}':reload=1:fontcolor=white:fontsize=38:x=(w-text_w)/2:y=1300:box=1:boxcolor=black@0.55:boxborderw=12`);
    rowFiles.forEach((f, i) => {
      dt(`${BODY}textfile='${esc(f)}':reload=1:fontcolor=0xe2e8f0:fontsize=32:x=80:y=${1400 + i * 62}:borderw=1:bordercolor=black@0.85`);
    });
    dt(`${BODY}textfile='${esc(p.source)}':reload=1:fontcolor=0xe2e8f0:fontsize=32:x=(w-text_w)/2:y=h-140:box=1:boxcolor=black@0.5:boxborderw=12`);
  } else {
    // Horizontal 16:9 — mirrors LiveNewsScene: top bar, left hero column
    // (title, question, description), right story list, bottom straps.
    dt(`${HEAD}text='LIVE':fontcolor=white:fontsize=46:x=60:y=28:box=1:boxcolor=0xdc2626:boxborderw=22`);
    dt(`${BODY}textfile='${esc(p.traffic)}':reload=1:fontcolor=white:fontsize=34:x=230:y=36:box=1:boxcolor=black@0.55:boxborderw=14`);
    dt(`${BODY}text='${CLOCK}':fontcolor=white:fontsize=34:x=w-text_w-210:y=36`);
    dt(`${BODY}textfile='${esc(p.country)}':reload=1:fontcolor=white:fontsize=30:x=60:y=140:box=1:boxcolor=black@0.55:boxborderw=12`);
    dt(`${HEAD}textfile='${esc(p.headline)}':reload=1:fontcolor=white:fontsize=68:x=120:y=300:line_spacing=8:borderw=2:bordercolor=black@0.85`);
    dt(`${BODY}textfile='${esc(p.question)}':reload=1:fontcolor=0xfcd34d:fontsize=38:x=120:y=540:line_spacing=8:borderw=1:bordercolor=black@0.85`);
    dt(`${BODY}textfile='${esc(p.desc)}':reload=1:fontcolor=0xe2e8f0:fontsize=32:x=120:y=700:line_spacing=6:borderw=1:bordercolor=black@0.85`);
    rowFiles.forEach((f, i) => {
      dt(`${BODY}textfile='${esc(f)}':reload=1:fontcolor=0xe2e8f0:fontsize=30:x=1300:y=${300 + i * 64}:borderw=1:bordercolor=black@0.85`);
    });
    dt(`${BODY}textfile='${esc(p.stats)}':reload=1:fontcolor=white:fontsize=32:x=(w-text_w)/2:y=h-230:box=1:boxcolor=black@0.55:boxborderw=12`);
    dt(`${BODY}textfile='${esc(p.source)}':reload=1:fontcolor=0xe2e8f0:fontsize=30:x=(w-text_w)/2:y=h-140:box=1:boxcolor=black@0.5:boxborderw=12`);
  }
  const OUT_W = liveOutSize(orientation).w;
  const OUT_H = liveOutSize(orientation).h;
  fc += `;${vid}scale=${OUT_W}:${OUT_H}[out]`;

  const args = [
    '-hide_banner', '-loglevel', 'warning',
    '-re',
    ...inputs,
    '-filter_complex', fc,
    '-map', '[out]', '-map', `${audioIdx}:a`,
    '-c:v', 'libx264', '-preset', preset, '-tune', 'zerolatency',
    '-b:v', `${vbr}k`, '-maxrate', `${vbr}k`, '-bufsize', `${vbr * 2}k`,
    '-pix_fmt', 'yuv420p', '-g', '60',
    '-c:a', 'aac', '-b:a', '128k', '-ar', '44100',
    '-progress', 'pipe:1',
    // Socket IO guard only (-rw_timeout). NEVER -timeout on RTMP outputs:
    // it matches the protocol's `timeout` option which IMPLIES LISTEN MODE —
    // ffmpeg then BINDS the ingest IP instead of connecting ("Cannot assign
    // requested address"). Same footgun as the pipe encoder; see there.
    '-rw_timeout', '15000000',
    '-f', 'flv', target,
  ];
  return { bin: ff, args, fonts: { head: HEAD !== '', body: BODY !== '' } };
}

function clockText(): string {
  try {
    return new Date().toLocaleTimeString('en-GB', { hour: '2-digit', minute: '2-digit' });
  } catch {
    return '';
  }
}

/** Photo bytes with a small FIFO cache (rotation must never wait on net). */
async function fetchCardPhoto(url: string | null): Promise<Buffer | null> {
  const u = String(url || '').trim();
  if (!u) return null;
  const hit = photoCache.get(u);
  if (hit) return hit;
  try {
    const img = await fetchProxiedImage(u);
    photoCache.set(u, img.buf);
    if (photoCache.size > 24) {
      const oldest = photoCache.keys().next().value;
      if (oldest) photoCache.delete(oldest);
    }
    return img.buf;
  } catch {
    return null;
  }
}

async function fetchCardFlag(code: string): Promise<Buffer | null> {
  const cc = String(code || '').trim().toLowerCase();
  if (!/^[a-z]{2}$/.test(cc)) return null;
  const hit = flagCache.get(cc);
  if (hit) return hit;
  try {
    const img = await fetchProxiedImage(`https://flagcdn.com/w160/${cc}.png`);
    flagCache.set(cc, img.buf);
    if (flagCache.size > 12) {
      const oldest = flagCache.keys().next().value;
      if (oldest) flagCache.delete(oldest);
    }
    return img.buf;
  } catch {
    return null;
  }
}

function countryNameFor(code: string): string {
  try {
    const hit = getRundownCountries().find(c => c.code === String(code || '').trim().toUpperCase());
    if (hit?.name) return hit.name;
  } catch { /* fallback below */ }
  return String(code || '').trim().toUpperCase() || 'World';
}

/**
 * Card input with a HARD asset budget: photo/flag downloads race a timer
 * (tick 4s, start 6s) and lose to the fallback panel — a slow origin can
 * delay one story's photo, never the rotation cadence or the swap itself.
 */
async function buildCardInput(snap: LiveTrendSnapshot, assetBudgetMs = 0): Promise<CardInput> {
  const rank = snap.topList.find(t => t.keyword === snap.keyword)?.rank ?? 1;
  let photo: Buffer | null = null;
  let flag: Buffer | null = null;
  try {
    const pair = Promise.all([
      fetchCardPhoto(snap.imageUrl),
      fetchCardFlag(snap.country),
    ]);
    if (assetBudgetMs > 0) {
      const timeout = new Promise<[null, null]>(resolve =>
        setTimeout(() => resolve([null, null]), assetBudgetMs)
      );
      [photo, flag] = await Promise.race([pair, timeout]);
      // Losers keep downloading in the background and self-cache on success
      // (fetchCardPhoto/fetchCardFlag cache internally) — the NEXT tick
      // picks them up. Nothing is wasted, cadence never waits.
    } else {
      [photo, flag] = await pair;
    }
  } catch {
    photo = null;
    flag = null;
  }
  return {
    keyword: snap.keyword,
    question: snap.question,
    description: snap.description,
    traffic: snap.traffic,
    velocity: snap.velocity,
    score: snap.score,
    category: snap.category,
    rank,
    countryCode: snap.country,
    countryName: countryNameFor(snap.country),
    sourceName: snap.sourceName,
    sourceTitle: snap.sourceTitle,
    topRows: snap.topList.slice(0, 5).map(t => ({
      rank: t.rank,
      keyword: t.keyword,
      traffic: t.traffic,
      current: t.keyword === snap.keyword,
    })),
    photo,
    flag,
    clockText: clockText(),
  };
}

/** 30 Hz A/V pump: duplicate the latest card into ffmpeg stdin (video, fd 0)
 *  and the next 33 ms of slot audio into ffmpeg's dedicated audio pipe
 *  (fd 3). Two transports because raw PCM inside image2pipe's stdin corrupts
 *  JPEG framing (the video demuxer eats everything as picture data and audio
 *  starves — verified). Audio used to ride UDP loopback here, but a wedged
 *  datagram path starves the encoder with zero errors (alive, 0 CPU, 0 bytes
 *  out) — a pipe's delivery is observable via writableLength, so a stall can
 *  never hide. Video and audio writes are INDEPENDENT (a backed-up video pipe
 *  drops frames, a backed-up audio pipe drops 33 ms — neither ever blocks the
 *  other, so the single-threaded ffmpeg demuxer can always make progress on
 *  at least one input). Drops (never blocks) when the encoder falls behind;
 *  silence pads an empty audio queue. A failed write must never kill the push. */
function startPacer(proc: ChildProcess): void {
  stopPacer();
  // Pacer cadence follows the output frame rate; each tick carries exactly
  // one frame's worth of audio (176400 B/s ÷ fps) so A/V never drifts.
  const fps = liveFps();
  const intervalMs = Math.max(20, Math.round(1000 / fps));
  const bytesPerTick = Math.max(1470, Math.round(176400 / fps));
  pacerTicks = 0;
  pacerVideoWrites = 0;
  pacerAudioWrites = 0;
  pacerVideoSkips = 0;
  pacerAudioSkips = 0;
  pacerLastError = null;
  pacerLastSkip = null;
  pacerLastTickAt = Date.now();
  pacerTimer = setInterval(() => {
    try {
      if (!child || child !== proc) {
        pacerLastSkip = 'child-mismatch';
        return;
      }
      if (proc.exitCode !== null) {
        pacerLastSkip = 'proc-exited';
        return;
      }
      pacerTicks++;
      pacerLastTickAt = Date.now();
      // Video and audio are INDEPENDENT transports with their own guards —
      // a throwing video write must never silently kill the audio drain
      // (that exact shape pins the audio queue at its cap while the encoder
      // starves: "alive, 0 bytes out").
      try {
        const stdin = (proc as any).stdin as NodeJS.WritableStream | null;
        if (stdin && (stdin as any).writable && ((stdin as any).writableLength || 0) <= 5 * 1024 * 1024) {
          if (latestCard) {
            stdin.write(latestCard);
            pacerVideoWrites++;
          } else {
            pacerVideoSkips++;
            pacerLastSkip = 'no-frame';
          }
        } else {
          pacerVideoSkips++;
          pacerLastSkip = 'stdin-blocked';
        }
      } catch (err) {
        pacerVideoSkips++;
        pacerLastSkip = 'stdin-throw';
        pacerLastError = String((err as Error)?.message || err).slice(0, 160);
      }
      try {
        const audioPipe = (proc as any).stdio?.[3] as NodeJS.WritableStream | null;
        if (audioPipe && (audioPipe as any).writable && ((audioPipe as any).writableLength || 0) <= 1 * 1024 * 1024) {
          let chunk: Buffer;
          if (audioQueue.length >= bytesPerTick) {
            chunk = audioQueue.subarray(0, bytesPerTick);
            audioQueue = audioQueue.subarray(bytesPerTick);
          } else {
            // Queue underrun (slot boundary race): pad silence, keep the clock.
            chunk = audioQueue.length > 0
              ? Buffer.concat([audioQueue, Buffer.alloc(bytesPerTick - audioQueue.length)])
              : Buffer.alloc(bytesPerTick);
            audioQueue = Buffer.alloc(0);
          }
          audioPipe.write(chunk);
          pacerAudioWrites++;
        } else {
          pacerAudioSkips++;
          pacerLastSkip = 'audiopipe-blocked';
        }
      } catch (err) {
        pacerAudioSkips++;
        pacerLastSkip = 'audiopipe-throw';
        pacerLastError = String((err as Error)?.message || err).slice(0, 160);
      }
    } catch (err) {
      pacerLastError = String((err as Error)?.message || err).slice(0, 160);
    }
  }, intervalMs);
  (pacerTimer as any)?.unref?.();
  armStallHealer();
}

/** Observable push IO for /api/diag: proves the pacer feeds BOTH transports
 *  (a hidden stall here is exactly "alive, 0 CPU, 0 bytes out"). */
export function getPushIoState(): {
  pacerRunning: boolean;
  stdinWritable: boolean;
  stdinBufferedBytes: number;
  audioPipeWritable: boolean;
  audioPipeBufferedBytes: number;
  audioQueueBytes: number;
  latestCardBytes: number;
  pacerTicks: number;
  pacerTickAgeMs: number | null;
  pacerVideoWrites: number;
  pacerAudioWrites: number;
  pacerVideoSkips: number;
  pacerAudioSkips: number;
  pacerLastSkip: string | null;
  pacerLastError: string | null;
} {
  const proc = child;
  const stdin = (proc as any)?.stdin as any;
  const audioPipe = (proc as any)?.stdio?.[3] as any;
  return {
    pacerRunning: pacerTimer !== null && !!proc && (proc as any).exitCode === null,
    stdinWritable: !!stdin && !!stdin.writable,
    stdinBufferedBytes: stdin && typeof stdin.writableLength === 'number' ? stdin.writableLength : -1,
    audioPipeWritable: !!audioPipe && !!audioPipe.writable,
    audioPipeBufferedBytes: audioPipe && typeof audioPipe.writableLength === 'number' ? audioPipe.writableLength : -1,
    audioQueueBytes: audioQueue.length,
    latestCardBytes: latestCard ? latestCard.length : 0,
    pacerTicks,
    pacerTickAgeMs: pacerLastTickAt > 0 ? Math.max(0, Date.now() - pacerLastTickAt) : null,
    pacerVideoWrites,
    pacerAudioWrites,
    pacerVideoSkips,
    pacerAudioSkips,
    pacerLastSkip,
    pacerLastError,
  };
}

function stopPacer(): void {
  if (pacerTimer) {
    clearInterval(pacerTimer);
    pacerTimer = null;
  }
}

/**
 * Stall healer (armed with the pacer, disarmed when the push ends): every
 * 20s it checks the two silent-death shapes that no other watchdog covers —
 * (a) the pacer tick itself stopped firing (feeds nothing, pipes stay empty,
 * the audio queue pins at its cap), (b) the pacer feeds but zero bytes leave
 * the box for minutes (wedged RTMP handshake -rw_timeout didn't reap).
 * Either way the wedged encoder is SIGKILLed WITHOUT nulling `child`, so the
 * exit handler treats it as unexpected and the existing auto-restart
 * machinery (reel-hook-first, 5-try backoff) rebuilds the push. A deliberate
 * stop disarms via killLiveProcess; the 5-try budget bounds flapping.
 */
function armStallHealer(): void {
  disarmStallHealer();
  healTimer = setInterval(() => {
    try {
      const proc = child;
      if (!proc || (proc as any).exitCode !== null) {
        disarmStallHealer();
        return;
      }
      const now = Date.now();
      const tickAgeMs = pacerLastTickAt > 0 ? now - pacerLastTickAt : 0;
      const uptimeSec = startedAt ? Math.max(0, Math.round((now - new Date(startedAt).getTime()) / 1000)) : 0;
      const outMB = engineStats && engineStats.totalMB > 0 ? engineStats.totalMB : 0;
      // (a) pacer dead: no successful tick for 30s (warm-up grace: skip while
      // the push is younger than 45s — decoders/pipes are still settling).
      if (uptimeSec > 45 && tickAgeMs > 30000) {
        return healStalledPush(`pacer dead — no tick for ${Math.round(tickAgeMs / 1000)}s (writes v/a ${pacerVideoWrites}/${pacerAudioWrites}, last skip: ${pacerLastSkip || 'none'}, last error: ${pacerLastError || 'none'})`);
      }
      // (b) pacer feeds but nothing leaves for 3+ minutes.
      if (uptimeSec > 180 && !(outMB > 0)) {
        return healStalledPush(`0 MB out after ${uptimeSec}s with a live pacer (${pacerTicks} ticks, ${pacerVideoWrites} video writes) — wedged RTMP handshake`);
      }
    } catch (err) {
      console.warn('[LiveStream] stall-healer note:', (err as Error)?.message || err);
    }
  }, 20000);
  (healTimer as any)?.unref?.();
}

function disarmStallHealer(): void {
  if (healTimer) {
    clearInterval(healTimer);
    healTimer = null;
  }
}

/** Kill the wedged encoder so the unexpected-death path heals it. The child
 *  is deliberately NOT nulled: the exit handler must see it as unexpected
 *  (deliberate stops null first). Throttled to one kill per 60s. */
function healStalledPush(reason: string): void {
  const proc = child;
  if (!proc || (proc as any).exitCode !== null) return;
  if (Date.now() - healFiredAt < 60000) return;
  healFiredAt = Date.now();
  console.error(`[LiveStream] STALLED push detected (${reason}) — killing the wedged encoder so auto-restart rebuilds it.`);
  try {
    proc.kill('SIGKILL');
  } catch (err) {
    console.warn('[LiveStream] stall-heal kill note:', (err as Error)?.message || err);
  }
}

/** Swallow async EPIPE errors on the audio pipe (fd 3): when the encoder dies
 *  mid-write, the failure surfaces as an async 'error' event — without this
 *  listener it crashes the whole server instead of healing via the exit path
 *  (same guard stdin already has in attachFfmpegHandlers). */
function guardAudioPipe(proc: ChildProcess): void {
  try {
    const audioPipe = (proc as any).stdio?.[3] as NodeJS.WritableStream | null;
    audioPipe?.on('error', () => {});
  } catch { /* pipe-less paths have nothing to guard */ }
}

/**
 * Composed-frame start: render the first story card BEFORE spawn (dense
 * flow from t=0 + instant visual validation), then pump duplicates at
 * 30 Hz. Rotation ticks render the next card in the background and swap
 * the buffer — zero reconnects, zero gaps.
 */
async function startCardBroadcast(
  opts: StartLiveOptions,
  ctx: { target: string; base: string; key: string }
): Promise<LiveStatus> {
  const { target, base, key } = ctx;
  const ff = resolveFfmpegBin();
  if (!binRuns(ff)) {
    throw new Error('No working ffmpeg found — the container needs a full ffmpeg install (apk ffmpeg).');
  }
  let first: Buffer;
  let firstInput: CardInput;
  try {
    firstInput = await buildCardInput(opts.snapshot, 6000);
    first = await renderStoryCard(firstInput, currentOrientation);
  } catch (err) {
    throw new Error(`Story card render failed: ${(err as Error)?.message || err}`);
  }
  latestCard = first;
  cardGen++;
  assetsInfo = {
    cover: 'card',
    flag: !!firstInput.flag,
    photos: firstInput.photo ? 1 : 0,
  };
  // Narrator: warm the opening voice (bounded — never stall Go Live), then
  // prime this slot's exact audio (voice if ready, silence otherwise).
  try {
    if (!peekCachedVoice(voiceKeyFor(opts.snapshot))) {
      await Promise.race([
        getStoryVoice(voiceKeyFor(opts.snapshot), countryNameFor(opts.snapshot.country), opts.snapshot.keyword, ff),
        new Promise(r => setTimeout(r, 8000)),
      ]);
    }
  } catch { /* silence slot */ }
  swapSlotAudio(opts.snapshot, ff);

  stderrTail.length = 0;
  engineStats = null;
  progressBuf = '';
  if (autoRestartTimer) {
    clearTimeout(autoRestartTimer);
    autoRestartTimer = null;
  }
  fontsInfo = { head: true, body: true };

  console.log(`[LiveStream] GOING LIVE (cards ${currentOrientation}) — topic "${currentTopic}" → ${rtmpHostMasked} (ffmpeg: ${ff})`);
  // Four piped stdios: stdin = video JPEGs, stdout = -progress, stderr = log,
  // fd 3 = raw audio PCM (see buildPipeEncodeArgs, input `pipe:3`).
  const proc = spawn(ff, buildPipeEncodeArgs(target), { stdio: ['pipe', 'pipe', 'pipe', 'pipe'] });
  child = proc;
  startedAt = new Date().toISOString();
  ownerUserId = opts.ownerUserId || null;
  persistedSession = false;
  if (ownerUserId) {
    // Rotation broadcasts persist a NULL topic (resume keeps rotating);
    // only a manual pin persists its keyword (resume restores the pin).
    persistLiveSession(ownerUserId, base, key, rotationOn ? null : (opts.snapshot.keyword || null), proc);
  }

  attachFfmpegHandlers(proc, key);
  guardAudioPipe(proc);
  startPacer(proc);

  if (refreshTimer) clearInterval(refreshTimer);
  refreshTimer = setInterval(refreshOverlayFromProvider, REFRESH_MS);
  // Never let the timer keep the process alive alone.
  (refreshTimer as any)?.unref?.();

  // Warm the photo cache for the upcoming slots (rotation never waits).
  void prefetchRotationPhotos().catch(() => {});
  return getLiveStatus();
}

export interface StartReelOptions {
  rtmpUrl: string;
  streamKey: string;
  ownerUserId: string | null;
  watchId: string;
  username: string;
  shortcode: string;
  /** Validated first picture of the reel (extracted before the push starts).
   *  Guarantees the encoder has dense video from t=0 even if the loop decoder
   *  lags a beat — without it YouTube sees a connected push with "No data". */
  standbyFrame?: Buffer | null;
}

/** Drop any stale reel picture/audio (call before (re)arming a loop so an
 *  old session's last frame can never leak into the new push). */
export function clearReelFeed(): void {
  latestCard = null;
  audioQueue = Buffer.alloc(0);
}

/** Drop buffered PCM only (video keeps flowing): every decoder (re)spawn
 *  must start from a clean audio baseline, otherwise the previous reel's
 *  tail plays under the new reel's picture — a permanent lip-sync offset. */
export function clearAudioQueue(): void {
  audioQueue = Buffer.alloc(0);
}

/**
 * Reel-loop broadcast: the SAME 30 Hz pipe encoder as cards, but frames and
 * audio arrive from the Instagram reel decoder (igLiveService) instead of
 * the card renderer + narrator. No rotation, no overlay refresh — the reel
 * owns every pixel until a newer reel swaps the decoder (seamless) or the
 * push is stopped. Reels are vertical, so the canvas is forced to vertical.
 */
export async function startReelBroadcast(opts: StartReelOptions): Promise<LiveStatus> {
  if (isLiveActive()) {
    throw new Error('Already live — stop the current broadcast before starting the reel loop.');
  }
  const key = String(opts.streamKey || '').trim();
  if (!key || key.length < 4) {
    throw new Error('A valid YouTube stream key is required (save it once in the Live tab).');
  }
  let base = String(opts.rtmpUrl || 'rtmp://a.rtmp.youtube.com/live/').trim();
  if (!/^rtmps?:\/\//i.test(base)) {
    throw new Error('RTMP URL must start with rtmp:// or rtmps://');
  }
  if (base.includes(key)) {
    throw new Error('Paste the stream KEY only — not the full URL with the key inside.');
  }
  if (!base.endsWith('/')) base += '/';
  const target = await dialTargetFor(base, key);
  rtmpHostMasked = maskRtmpForLog(base);
  const ff = resolveFfmpegBin();
  if (!binRuns(ff)) {
    throw new Error('No working ffmpeg found — the container needs a full ffmpeg install (apk ffmpeg).');
  }
  const label = `@${opts.username} reel ${opts.shortcode}`;
  currentTopic = label;
  currentOrientation = 'vertical';
  rotationOn = false;
  liveMode = 'reel';
  currentEngine = 'cards'; // pipe encoder path (frames come from the decoder)
  reelInfo = {
    watchId: opts.watchId,
    username: opts.username,
    shortcode: opts.shortcode,
    startedAt: new Date().toISOString()
  };
  // Fresh A/V queues: no stale narration may leak into the reel soundtrack.
  // latestCard is KEPT when the decoder already flows (Go Live waits for the
  // first live frame BEFORE starting the push, so t=0 already has picture);
  // otherwise the validated standby snapshot feeds the encoder from the very
  // first tick — an image2pipe push started with zero video bytes connects
  // to YouTube yet delivers "No data" forever.
  audioQueue = Buffer.alloc(0);
  voiceOn = false;
  if (!latestCard && opts.standbyFrame && opts.standbyFrame.length > 1000) {
    latestCard = opts.standbyFrame;
  }
  stderrTail.length = 0;
  engineStats = null;
  progressBuf = '';
  if (autoRestartTimer) {
    clearTimeout(autoRestartTimer);
    autoRestartTimer = null;
  }
  fontsInfo = { head: true, body: true };

  console.log(`[LiveStream] GOING LIVE (reel loop ${currentOrientation}) — "${label}" → ${rtmpHostMasked} (ffmpeg: ${ff})`);
  // Four piped stdios: stdin = video JPEGs, stdout = -progress, stderr = log,
  // fd 3 = raw audio PCM (see buildPipeEncodeArgs, input `pipe:3`).
  const proc = spawn(ff, buildPipeEncodeArgs(target), { stdio: ['pipe', 'pipe', 'pipe', 'pipe'] });
  child = proc;
  startedAt = new Date().toISOString();
  ownerUserId = opts.ownerUserId || null;
  persistedSession = false;
  if (ownerUserId) {
    persistLiveSession(ownerUserId, base, key, label, proc, {
      mode: 'reel',
      reelWatchId: opts.watchId,
      reelShortcode: opts.shortcode
    });
  }
  attachFfmpegHandlers(proc, key);
  guardAudioPipe(proc);
  startPacer(proc);
  // No overlay refresh in reel mode (guarded anyway); no rotation warm.
  return getLiveStatus();
}

/** Point the on-air reel loop at a newer shortcode (metadata only — the
 *  decoder swap itself is seamless and never touches this push). */
export function setReelShortcode(shortcode: string): void {
  if (reelInfo && shortcode) {
    reelInfo.shortcode = shortcode;
    currentTopic = `@${reelInfo.username} reel ${shortcode}`;
  }
}

/** Swap the narrator audio for a slot (sync — voice comes from cache; a
 *  miss plays exact-length silence and warms the cache for next cycle). */
function swapSlotAudio(snap: LiveTrendSnapshot, ffBin: string): void {
  const slotMs = rundownRotateSec() * 1000;
  let voice: Buffer | null = null;
  try {
    // Sync cache read only — rotation must never wait on network.
    voice = peekCachedVoice(voiceKey(snap.country, snap.keyword));
  } catch {
    voice = null;
  }
  audioQueue = buildSlotAudio(voice, slotMs);
  voiceOn = !!voice;
  // Warm the upcoming slots in the background (voice + photo, best-effort).
  void warmUpcomingVoices(ffBin).catch(() => {});
  void prefetchRotationPhotos().catch(() => {});
}

async function warmUpcomingVoices(ffBin: string): Promise<void> {
  try {
    const next = peekNextStory();
    if (!next) return;
    const list = getRundownCountries().find(c => c.code === next.country.code)?.stories || [];
    prefetchStoryVoice(voiceKey(next.country.code, next.story.keyword), next.country.name, next.story.keyword, ffBin);
    const idx = list.findIndex(t => t.keyword === next.story.keyword);
    const following = list[idx + 1] || list[0];
    if (following && following.keyword !== next.story.keyword) {
      prefetchStoryVoice(voiceKey(next.country.code, following.keyword), next.country.name, following.keyword, ffBin);
    }
  } catch { /* best effort */ }
}

/** Voice cache key for a snapshot (shared with prefetch + swap). */
function voiceKeyFor(snap: LiveTrendSnapshot): string {
  return voiceKey(snap.country, snap.keyword);
}

/** Rotation tick for the card engine: render the new slot, swap on ready.
 *  Superseded renders are dropped by generation — a slow download can never
 *  show a stale story or blank the push. */
async function rotateCardSlot(): Promise<void> {
  if (!isLiveActive() || currentEngine !== 'cards' || !trendsProvider) return;
  const snap = trendsProvider();
  if (!snap) return;
  const g = ++cardGen;
  const tickStart = Date.now();
  lastTickAt = tickStart;
  swapSlotAudio(snap, resolveFfmpegBin());
  try {
    const input = await buildCardInput(snap, 4000);
    const buf = await renderStoryCard(input, currentOrientation);
    if (g !== cardGen || !isLiveActive() || currentEngine !== 'cards') return;
    latestCard = buf;
    assetsInfo = { cover: 'card', flag: !!input.flag, photos: input.photo ? 1 : 0 };
    lastRenderMs = Date.now() - tickStart;
    lastPhotoOk = !!input.photo;
    writeLiveOverlay(snap);
    if (snap.keyword) currentTopic = snap.keyword;
  } catch (err) {
    lastRenderMs = Date.now() - tickStart;
    console.warn('[LiveStream] card rotation note (keeping current frame):', (err as Error)?.message || err);
  }
}

/** Background warm of the next slots' photos (best-effort, never blocking). */
async function prefetchRotationPhotos(): Promise<void> {
  try {
    const urls = new Set<string>();
    for (const c of getRundownCountries()) {
      for (const t of c.stories.slice(0, 3)) {
        const u = String((t as any)?.image_url || '').trim();
        if (u) urls.add(u);
      }
      if (urls.size >= 12) break;
    }
    await Promise.allSettled([...urls].map(u => fetchCardPhoto(u)));
  } catch { /* best effort */ }
}

export async function startLiveBroadcast(opts: StartLiveOptions): Promise<LiveStatus> {
  if (isLiveActive()) {
    throw new Error('Already live — stop the current broadcast (or Restart with the new key) before starting a new one.');
  }
  const key = String(opts.streamKey || '').trim();
  if (!key || key.length < 4) {
    throw new Error('A valid YouTube stream key is required (YouTube Studio → Go Live → Stream → copy key).');
  }
  let base = String(opts.rtmpUrl || 'rtmp://a.rtmp.youtube.com/live/').trim();
  if (!/^rtmps?:\/\//i.test(base)) {
    throw new Error('RTMP URL must start with rtmp:// or rtmps://');
  }
  if (base.includes(key)) {
    throw new Error('Paste the stream KEY only — not the full URL with the key inside.');
  }
  if (!base.endsWith('/')) base += '/';
  const target = await dialTargetFor(base, key);
  rtmpHostMasked = maskRtmpForLog(base);

  if (!binHasDrawtext(resolveFfmpegBin())) {
    throw new Error('No ffmpeg with drawtext available — install full ffmpeg + fonts (the container needs ffmpeg + font-liberation).');
  }

  // Fresh overlay files from the chosen topic (auto-refreshed while live;
  // the capture engine ignores them, the drawtext engine lives on them).
  writeLiveOverlay(opts.snapshot);
  currentTopic = opts.snapshot.keyword;
  currentOrientation = opts.orientation || defaultLiveOrientation();
  rotationOn = opts.rotation !== false;
  liveMode = 'news';
  reelInfo = null;

  // Engine choice: composed story cards when the canvas backend exists
  // (fast, exact, no browser), drawtext mirror otherwise. LIVE_ENGINE=cards
  // forces and throws loud instead of silently downgrading.
  currentEngine = await resolveEngine();
  if (currentEngine === 'cards') {
    return startCardBroadcast(opts, { target, base, key });
  }

  // Story-wall backdrop: current story first, then every country's top
  // photo (downloaded fresh; missing files are dropped so ffmpeg init can
  // never fail on a stale path). Hard budget (DRAWTEXT_ASSET_BUDGET_MS,
  // default 8s): a slow origin delays one Go Live, never wedges it — late
  // downloads still land in the shared proxy cache for later. Rotation
  // repaints text/flag live over it.
  let assets: LiveBuilderAssets = { cover: '', flag: null };
  let fetched: LiveAssets = { cover: '', flag: null, kind: 'none', photos: 0 };
  try {
    const wall: { imageUrl: string | null }[] = [{ imageUrl: opts.snapshot.imageUrl }];
    for (const c of getRundownCountries()) {
      if (c.stories[0]?.image_url) wall.push({ imageUrl: c.stories[0].image_url });
    }
    const budgetMs = Math.min(30000, Math.max(2000,
      parseInt(process.env.DRAWTEXT_ASSET_BUDGET_MS || '8000', 10) || 8000));
    const timeout = new Promise<LiveAssets>(resolve =>
      setTimeout(() => resolve({ cover: '', flag: null, kind: 'none', photos: 0 }), budgetMs)
    );
    fetched = await Promise.race([ensureLiveAssets(wall, opts.snapshot.country, currentOrientation), timeout]);
    const exists = (rel: string): string => {
      try {
        return rel && fs.existsSync(path.join(process.cwd(), rel)) ? rel : '';
      } catch {
        return '';
      }
    };
    assets = { cover: exists(fetched.cover), flag: fetched.flag && exists(fetched.flag) ? fetched.flag : null };
  } catch (err) {
    console.warn('[LiveStream] assets note (color backdrop, no flag):', (err as Error)?.message || err);
  }

  // The exact live filter graph (built in one place so file-based tests use
  // the identical command that goes to RTMP in production).
  const built = buildLiveFfmpegArgs(opts.snapshot, target, currentOrientation, assets);
  const { bin: ff, args } = built;
  fontsInfo = built.fonts;
  // Diagnostics: what the viewer actually sees behind the text. A fetched
  // file that vanished before spawn degrades to the color input (never a
  // failed init) and reports as 'none'.
  assetsInfo = {
    cover: !assets.cover ? 'none' : fetched.kind,
    flag: !!assets.flag,
    photos: assets.cover ? fetched.photos : 0,
  };

  stderrTail.length = 0;
  engineStats = null;
  progressBuf = '';
  if (autoRestartTimer) {
    clearTimeout(autoRestartTimer);
    autoRestartTimer = null;
  }
  console.log(`[LiveStream] GOING LIVE (${currentOrientation}) — topic "${currentTopic}" → ${rtmpHostMasked} (ffmpeg: ${ff})`);
  const proc = spawn(ff, args, { stdio: ['ignore', 'pipe', 'pipe'] });
  child = proc;
  startedAt = new Date().toISOString();
  ownerUserId = opts.ownerUserId || null;
  // Durable session: rotation persists a NULL topic (resume keeps rotating),
  // a manual pin persists its keyword (resume restores the pin). Best-effort
  // — the broadcast itself never depends on it.
  persistedSession = false;
  if (ownerUserId) {
    persistLiveSession(ownerUserId, base, key, rotationOn ? null : (opts.snapshot.keyword || null), proc);
  }

  attachFfmpegHandlers(proc, key);

  if (refreshTimer) clearInterval(refreshTimer);
  refreshTimer = setInterval(refreshOverlayFromProvider, REFRESH_MS);
  // Never let the timer keep the process alive alone.
  (refreshTimer as any)?.unref?.();

  return getLiveStatus();
}

/**
 * Shared ffmpeg wiring for BOTH engines (drawtext graph + capture pipe):
 * log tail (key masked), -progress health parsing, and the self-heal exit
 * path. stop()/restart() null the child first, so only real deaths heal.
 */
function attachFfmpegHandlers(proc: ChildProcess, key: string): void {
  // Pacer writes to a dead encoder surface as EPIPE *async errors* (try/
  // catch can't see them); without this listener a single YouTube-side drop
  // crashes the whole server instead of healing. Recovery stays owned by
  // the exit handler below.
  try {
    const stdin = (proc as any).stdin as NodeJS.WritableStream | null;
    stdin?.on('error', () => {});
  } catch { /* stdin-less paths (drawtext) have nothing to guard */ }
  proc.stderr?.on('data', (d: Buffer) => {
    // Redact by URL shape (/live/KEY, /live2/KEY), not by exact key match —
    // exact matching demonstrably missed lines ("Error opening output file …
    // live2/<key>" reached the status endpoint unmasked once).
    const line = String(d)
      .split(key).join('***')
      .replace(/(live2?\/)[^\s'"]+/gi, '$1***')
      .slice(0, 300);
    stderrTail.push(line);
    if (stderrTail.length > 40) stderrTail.shift();
  });
  // Realtime encoder health: -progress emits key=value lines on stdout.
  // speed < 1 means slower than realtime — exactly what makes YouTube buffer.
  proc.stdout?.on('data', (d: Buffer) => {
    progressBuf += d.toString();
    if (progressBuf.length > 8192) progressBuf = progressBuf.slice(-4096);
    const blocks = progressBuf.split('progress=');
    if (blocks.length < 2) return;
    progressBuf = blocks[blocks.length - 1];
    const get = (k: string): string | null => {
      const m = new RegExp(`^${k}=(.*)$`, 'm').exec(blocks[blocks.length - 1]);
      return m ? m[1].trim() : null;
    };
    const fps = parseFloat(get('fps') || '');
    const kbps = parseFloat((get('bitrate') || '').replace('kbits/s', ''));
    const speed = parseFloat((get('speed') || '').replace('x', ''));
    const totalBytes = parseFloat(get('total_size') || '');
    if (isFinite(fps) && isFinite(kbps) && isFinite(speed)) {
      engineStats = {
        fps: Math.round(fps * 10) / 10,
        kbps: Math.round(kbps),
        speed: Math.round(speed * 100) / 100,
        totalMB: isFinite(totalBytes) ? Math.round((totalBytes / (1024 * 1024)) * 10) / 10 : 0,
        updatedAt: new Date().toISOString(),
      };
    }
  });
  proc.on('error', (err) => {
    console.error('[LiveStream] ffmpeg spawn failed:', (err as Error)?.message || err);
    stderrTail.push(`spawn failed: ${(err as Error)?.message || err}`.slice(0, 300));
    child = null;
  });
  proc.on('exit', (code, signal) => {
    console.log(`[LiveStream] ffmpeg exited (code=${code} signal=${signal}) — off air.`);
    const unexpected = child === proc; // stop()/restart() null the child first
    if (child === proc) child = null;
    engineStats = null;
    // A dead push has no uptime — clear it (a successful auto-restart stamps
    // a fresh one; otherwise status would count uptime while off air).
    startedAt = null;
    if (!unexpected) assetsInfo = { cover: 'none', flag: false, photos: 0 };
    if (refreshTimer) {
      clearInterval(refreshTimer);
      refreshTimer = null;
    }
    // Self-heal: a crash or a network-blip kill must not end the broadcast
    // silently — re-push from the durable row (same key/topic/orientation)
    // with backoff, up to 5 tries. Deliberate stops never land here.
    if (unexpected && ownerUserId) {
      stopPacer();
      scheduleAutoRestart();
    }
  });
}

function binRuns(bin: string): boolean {
  try {
    execFileSync(bin, ['-version'], { timeout: 15000, stdio: ['ignore', 'pipe', 'pipe'] });
    return true;
  } catch {
    return false;
  }
}

/** ffmpeg argv for the frame pipe (steady 30 Hz JPEGs on stdin, no wallclock
 *  games: arrival spacing already equals the declared rate, so timestamps
 *  stay truthful) + narration PCM over a dedicated audio pipe (fd 3 — the
 *  child is spawned with four piped stdios). Two transports because stuffing
 *  raw PCM into image2pipe's stdin corrupts JPEG framing (the video demuxer
 *  eats everything as picture data and audio starves — verified). A pipe's
 *  delivery is observable (writableLength) unlike UDP loopback, whose silent
 *  datagram loss once wedged the encoder with zero errors. Exported for
 *  file-based verification of the exact on-air encode chain. */
export function buildPipeEncodeArgs(target: string, orientation: LiveOrientation = currentOrientation): string[] {
  const vbr = liveVideoKbps();
  const preset = livePreset();
  const fps = liveFps();
  const { w: OW, h: OH } = liveOutSize(orientation);
  const format = target.toLowerCase().endsWith('.mp4') ? 'mp4' : 'flv';
  return [
    '-hide_banner', '-loglevel', 'warning',
    '-framerate', String(fps),
    '-f', 'image2pipe', '-i', '-',
    '-f', 's16le', '-ar', '44100', '-ac', '2',
    '-i', 'pipe:3',
    '-map', '0:v', '-map', '1:a',
    '-vf', `scale=${OW}:${OH}`,
    '-r', String(fps),
    '-c:v', 'libx264', '-preset', preset, '-tune', 'zerolatency',
    '-b:v', `${vbr}k`, '-maxrate', `${vbr}k`, '-bufsize', `${vbr * 2}k`,
    '-pix_fmt', 'yuv420p', '-g', String(fps * 2),
    '-c:a', 'aac', '-b:a', '128k', '-ar', '44100',
    '-progress', 'pipe:1',
    // Socket IO guard: -rw_timeout aborts a wedged RTMP connection (µs).
    // NEVER add -timeout here: on RTMP outputs it matches the protocol's
    // `timeout` option, which IMPLIES LISTEN MODE (rtmpproto.c) — ffmpeg then
    // BINDS YouTube's IP instead of connecting and dies with "Cannot assign
    // requested address" (verified live: listen_timeout printed as
    // 15000000*1000 mod 2^32 = 2115098112). This exact footgun shipped once.
    '-rw_timeout', '15000000',
    '-f', format, target,
  ];
}

/** Durable session write shared by both engines (never fails the start). */
function persistLiveSession(
  owner: string,
  base: string,
  key: string,
  topic: string | null,
  proc: ChildProcess,
  extra?: { mode?: LiveSourceMode; reelWatchId?: string | null; reelShortcode?: string | null }
): void {
  saveLiveStream(owner, {
    rtmpUrl: base,
    streamKey: key,
    topicKeyword: topic,
    orientation: currentOrientation,
    mode: extra?.mode || 'news',
    reelWatchId: extra?.reelWatchId ?? null,
    reelShortcode: extra?.reelShortcode ?? null
  })
    .then(() => {
      // Only mark the CURRENT broadcast persisted (a stop/restart may have
      // replaced it while the query was in flight).
      if (child === proc) persistedSession = true;
    })
    .catch((err) => {
      console.warn('[LiveStream] session persist note (broadcast continues, resume on restart unavailable):', (err as Error)?.message || err);
    });
}

/**
 * Owner-only stop. Anyone else gets 403 — the broadcast belongs to the user
 * who started it, and only they (or a server restart clearing everything)
 * can end it. The durable row dies with it so boot never resumes a stopped
 * stream.
 */
export function stopLiveBroadcast(requesterUserId?: string | null): LiveStatus {
  const owner = getLiveOwner();
  if (owner && requesterUserId && owner !== requesterUserId) {
    throw new Error('This broadcast was started by another signed-in user — only they can stop it.');
  }
  killLiveProcess('stop requested');
  const ownerToClear = ownerUserId || owner;
  ownerUserId = null;
  persistedSession = false;
  liveMode = 'news';
  reelInfo = null;
  engineStats = null;
  assetsInfo = { cover: 'none', flag: false, photos: 0 };
  voiceOn = false;
  autoRestartAttempts = 0;
  if (autoRestartTimer) {
    clearTimeout(autoRestartTimer);
    autoRestartTimer = null;
  }
  if (ownerToClear) {
    void clearLiveStream(ownerToClear).catch(() => {});
  }
  return getLiveStatus();
}

/** Shared kill path (stop + restart use it — restart keeps the owner/row). */
function killLiveProcess(reason: string): void {
  if (refreshTimer) {
    clearInterval(refreshTimer);
    refreshTimer = null;
  }
  engineStats = null;
  // Reel decoders (if any) die with the push — otherwise they'd pump frames
  // into a dead pacer and leak ffmpeg children.
  try {
    liveStopHook?.();
  } catch { /* hook is best effort */ }
  // Pacer first: nothing more in flight the moment the push is ending
  // (killing the proc closes its pipes; the EPIPE guards stay quiet).
  stopPacer();
  disarmStallHealer();
  latestCard = null;
  audioQueue = Buffer.alloc(0);
  voiceOn = false;
  // No uptime while off air (a restart stamps a fresh startedAt on success).
  startedAt = null;
  const proc = child;
  child = null;
  if (proc && proc.exitCode === null && !proc.killed) {
    try {
      proc.kill('SIGTERM');
      // Escalate if ffmpeg ignores SIGTERM (wedged RTMP handshake). NOTE:
      // the check must be exitCode ONLY — Node sets proc.killed=true as soon
      // as WE send any signal, so `!killed` here would skip the SIGKILL
      // forever and every restart would orphan another push fighting for the
      // same stream key (exactly what happened: 3 stalled pushes alive).
      setTimeout(() => {
        try {
          if (proc.exitCode === null) proc.kill('SIGKILL');
        } catch { /* already gone */ }
      }, 4000)?.unref?.();
      console.log(`[LiveStream] ${reason} (SIGTERM sent) — off air.`);
    } catch (err) {
      console.warn('[LiveStream] stop note:', (err as Error)?.message || err);
    }
  } else {
    console.log(`[LiveStream] ${reason} while already off air.`);
  }
}

/**
 * Self-heal after an UNEXPECTED ffmpeg death (crash, YouTube-side drop,
 * network blip): re-push from the durable row with backoff, up to 5 tries.
 * Deliberate stop()/restart() clear the timer first, so they never land here.
 */
function scheduleAutoRestart(): void {
  if (autoRestartTimer || !ownerUserId) return;
  if (autoRestartAttempts >= 5) {
    console.error('[LiveStream] auto-restart gave up after 5 tries — manual Go Live needed.');
    autoRestartAttempts = 0;
    return;
  }
  const delays = [5000, 15000, 30000, 60000, 120000];
  const wait = delays[Math.min(autoRestartAttempts, delays.length - 1)];
  autoRestartAttempts++;
  console.log(`[LiveStream] unexpected ffmpeg death — auto-restart try ${autoRestartAttempts}/5 in ${Math.round(wait / 1000)}s.`);
  autoRestartTimer = setTimeout(() => {
    autoRestartTimer = null;
    void (async () => {
      try {
        if (isLiveActive() || !isDbReady() || !ownerUserId) return;
        // Reel mode heals through its own hook (same watch/file/key) so the
        // loop comes back as a loop — never as a news broadcast.
        if (liveMode === 'reel' && liveReelRestartHook) {
          try {
            if (await liveReelRestartHook()) {
              autoRestartAttempts = 0;
              return;
            }
          } catch (err) {
            console.warn('[LiveStream] reel auto-restart try failed:', (err as Error)?.message || err);
            scheduleAutoRestart();
            return;
          }
        }
        const { getLiveStream } = await import('./db.js');
        const row = await getLiveStream(ownerUserId);
        if (!row?.stream_key) return;
        if (!trendsProvider) return;
        const snap = trendsProvider();
        if (!snap) return;
        await startLiveBroadcast({
          rtmpUrl: row.rtmp_url || 'rtmp://a.rtmp.youtube.com/live/',
          streamKey: row.stream_key,
          snapshot: snap,
          ownerUserId,
          orientation: normalizeLiveOrientation((row as any).orientation),
          // A saved manual topic resumes pinned; an empty one resumes
          // rotating — status.rotation/slot stay truthful either way.
          rotation: !row.topic_keyword,
        });
        autoRestartAttempts = 0; // back on air — reset the budget
      } catch (err) {
        console.warn('[LiveStream] auto-restart try failed:', (err as Error)?.message || err);
        scheduleAutoRestart(); // next backoff step
      }
    })();
  }, wait);
  (autoRestartTimer as any)?.unref?.();
}

export interface RestartLiveOptions {
  streamKey: string;
  rtmpUrl?: string;
  topicKeyword?: string | null;
  requesterUserId: string | null;
  snapshot: LiveTrendSnapshot;
  orientation?: LiveOrientation | null;
  rotation?: boolean;
}

/**
 * Owner-only atomic "new key" swap: the old push is killed and a fresh one
 * starts with the replacement key (and optional new RTMP/topic) — one call
 * from the client, zero downtime thinking. The durable row is rewritten, so
 * a restart right after still resumes the NEW key.
 */
export async function restartLiveBroadcast(opts: RestartLiveOptions): Promise<LiveStatus> {
  const owner = getLiveOwner();
  if (!isLiveActive()) {
    throw new Error('Nothing is live — use Go Live to start a broadcast first.');
  }
  if (owner && opts.requesterUserId && owner !== opts.requesterUserId) {
    throw new Error('This broadcast was started by another signed-in user — only they can restart it.');
  }
  const key = String(opts.streamKey || '').trim();
  if (!key || key.length < 4) {
    throw new Error('Paste the replacement YouTube stream key first.');
  }
  killLiveProcess('restart requested');
  // Let the old RTMP connection fully drop before the new handshake, or
  // YouTube may keep the stale session and reject the fresh push.
  await new Promise(r => setTimeout(r, 1500));
  return startLiveBroadcast({
    rtmpUrl: opts.rtmpUrl || 'rtmp://a.rtmp.youtube.com/live/',
    streamKey: key,
    snapshot: opts.snapshot,
    ownerUserId: owner || opts.requesterUserId,
    // A restart without explicit values keeps the running canvas AND mode
    // (never silently flips vertical<->horizontal or rotation mid-session).
    orientation: opts.orientation || currentOrientation,
    rotation: opts.rotation !== undefined ? opts.rotation : rotationOn,
  });
}

/**
 * Boot auto-resume: if tl_live_stream holds a session (i.e. the server died
 * or redeployed mid-broadcast), re-push it with the SAVED key — no browser
 * needed. Waits for the DB + a trend snapshot, then starts exactly once.
 */
export async function resumeLiveBroadcast(
  buildSnapshot: (topicKeyword?: string) => LiveTrendSnapshot | null
): Promise<LiveStatus | null> {
  if (isLiveActive()) return getLiveStatus();
  // The DB pool retries in the background at boot — wait for it (up to ~2m).
  for (let i = 0; i < 24 && !isDbReady(); i++) {
    await new Promise(r => setTimeout(r, 5000));
  }
  if (!isDbReady()) {
    console.log('[LiveStream] resume skipped — database unreachable.');
    return null;
  }
  const row = await getAnyLiveStream();
  if (!row?.stream_key || !row?.user_id) {
    return null; // nobody was live — nothing to resume.
  }
  const snap = buildSnapshot(row.topic_keyword || undefined);
  if (!snap) {
    console.log('[LiveStream] resume skipped — no trends loaded yet.');
    return null;
  }
  try {
    const st = await startLiveBroadcast({
      rtmpUrl: row.rtmp_url || 'rtmp://a.rtmp.youtube.com/live/',
      streamKey: row.stream_key,
      snapshot: snap,
      ownerUserId: row.user_id,
      orientation: normalizeLiveOrientation((row as any).orientation),
      rotation: !row.topic_keyword,
    });
    console.log(`[LiveStream] RESUMED after restart — topic "${st.topic}" (owner ${row.user_id}).`);
    return st;
  } catch (err) {
    console.warn('[LiveStream] resume failed:', (err as Error)?.message || err);
    return null;
  }
}

// Best effort: never leave an orphaned ffmpeg pushing to YouTube.
process.on('exit', () => {
  try {
    if (child && child.exitCode === null && !child.killed) child.kill('SIGKILL');
  } catch { /* shutting down */ }
});
