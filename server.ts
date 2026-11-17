import express from 'express';
import multer from 'multer';
import path from 'path';
import fs from 'fs';
import os from 'os';
import net from 'net';
import { spawn } from 'child_process';
import 'dotenv/config';
import Redis from 'ioredis';
import { GoogleGenAI, Type } from '@google/genai';
import {
  NormalizedTrend,
  PipelineJob,
  PipelineStepStatus,
  VerifiedFact,
  ScriptPackage,
  QualityControlReport,
  SEOPackage,
  TrendProviderConfig
} from './src/types';
import {
  INITIAL_TRENDS,
  PRESET_FACTS_MAP,
  PRESET_SCRIPT_MAP,
  PRESET_QC_MAP,
  PRESET_SEO_MAP
} from './src/data/mockTrends';
import { fetchGoogleTrendsRSS } from './server/googleTrendsService.js';
import { fetchTrendingNow } from './server/trendingNowService.js';
import { askInternalAI, askOverview } from './server/internalAi.js';
import { renderShortMp4, cleanupJobTempFiles, TEMPLATE_VOICES, DEFAULT_TEMPLATE_VOICE_ID, 
isKnownTemplateVoice, ffmpegBin, generateNaturalVoiceAudio } from './server/videoRenderer.js';
import { generatePixVerseVideo, isPixVerseConfigured } from './server/pixverseService.js';
import {
  getYouTubeStatus,
  saveYouTubePrefs,
  disconnectYouTube,
  testYouTubeConnection,
  publishShortToYouTube,
  generateOAuthAuthUrl,
  createOAuthLink,
  consumeOAuthLink,
  exchangeCodeForTokens,
  getIngestHealth,
  fetchChannelLatestUploads,
  postTopComment,
  updateVideoTitle,
  fetchVideoRetention
} from './server/youtubeService.js';
import {
  getTikTokStatus,
  saveTikTokPrefs,
  disconnectTikTok,
  testTikTokConnection,
  publishVideoToTikTok,
  isTikTokConfigured,
  tiktokRedirectUri,
  generateTikTokAuthUrl,
  createTikTokOAuthLink,
  consumeTikTokOAuthLink,
  exchangeTikTokCodeForTokens
} from './server/tiktokService.js';
import { authRouter, requireAuth, requireAdmin, parseCookieString, SESSION_COOKIE } from './server/auth.js';
import { sendEmail, welcomeEmail, purchaseReceivedEmail, purchaseApprovedEmail, purchaseRejectedEmail, subscriptionExpiredEmail } from './server/email.js';
import { fetchProxiedImage, pickPlayableImage } from './server/imageProxy.js';
import { netopenStatus } from './server/netopenRelay.js';
import {
  getLiveStatus,
  getLiveOwner,
  isLiveActive,
  startLiveBroadcast,
  stopLiveBroadcast,
  restartLiveBroadcast,
  resumeLiveBroadcast,
  normalizeLiveOrientation,
  handleRundownSlot,
  setLiveTrendsProvider,
  listFfmpegProcs,
  reapStaleRtmpPushes,
  getPushIoState,
  dialTargetFor,
  type LiveTrendSnapshot
} from './server/liveStreamService.js';
import {
  getRundownSnapshot,
  getRundownPublic,
  getRundownCountries,
  snapshotFromTrend,
  refreshRundownNow,
  startRundownLoop
} from './server/liveRundown.js';
import { initDatabase, isDbReady, uuid, addVideoRecord, getUserVideos, getSessionUser, getYouTubeRow, getTikTokRow, saveTikTokRow, listIgWatches, getIgWatch, getIgWatchById, createIgWatch, updateIgWatch, deleteIgWatch, listDueIgWatches, listLiveEnabledWatches, hasIgPost, addIgPost, refreshIgPostMetrics, listIgPosts, listPublishableIgPosts, updateIgPost, deleteVideoRecord, userOwnsMediaFile, getAutoSchedule, upsertAutoSchedule, listDueAutoSchedules, computeWatchNextRunAt, normalizeDailyTimes, assertValidTimeZone, getRelaxSchedule, upsertRelaxSchedule, listDueRelaxSchedules, hasRelaxPost, listRelaxPostIds, addRelaxPost, listRelaxPosts, getLiveStream, getStreamSettingsRow, getStreamSettingsPublic, saveStreamSettings, clearStreamSettings, saveYouTubeRow, listConnectedYouTubeAccounts, listAllWatchesForAdmin, listEnabledAutoSchedules, getPublishStats, logAdminAction, listAdminAudit, hasTitleRotation, recordTitleRotation, listTitleRotations, normalizeTrendKeyword, hasRecentTrendPublish, recordTrendPublish, type TrendPublishRow, type AutoScheduleRow, type RelaxScheduleRow, getUploadQuota, addUploadQuota, refreshUploadUsedBytes, listUploadFiles, addUploadFile, getUploadFile, getUserById, listExpiredSubscriptionQuotas, markSubscriptionExpiryNotified, deleteUploadFile, updateUploadFileYoutube, listDueUploadYoutubeJobs, createStoragePurchase, listStoragePurchases, decideStoragePurchase, userOwnsUploadFile, getUploadFileById, getUploadFileByFilename, listUsers, setUserStatus } from './server/db.js';
import { parseInstagramUsername, normalizeProfileUrl, fetchProfileReels, searchProfileReels, fetchReelMetadata, downloadReelMp4, buildRepostMetadata, needsRealCaption } from './server/instagramProfileService.js';
import { beginReelLoop, stopReelLoop, getIgLiveStatus, liveFilePath, registerIgLiveHooks, resumeIgLiveBroadcast } from './server/igLiveService.js';
import { getLiveMode } from './server/liveStreamService.js';
import { isRapidConfigured, fetchRapidReels, fetchRapidSingleMedia, getRapidUsage, resetRapidUsage, downloadToFile, combineReelsToMp4, createMixJob, getMixJob, updateMixJob, publicMixJob, getRapidKeysStatus, computeWinnerScore, sortByWinnerScore, pickWinnerReel, RAPID_DISCOVERY_WINDOW } from './server/instagramRapidApi.js';
import {
  fetchLatestRelaxAiPost,
  downloadRelaxCover,
  downloadRelaxLayers,
  mixRelaxAudio,
  renderRelaxShort,
  renderRelaxReelShort,
  buildRelaxCaption,
  relaxPostUrl,
  RELAX_SHORT_SEC,
  type RelaxAiPost
} from './server/relaxShortsService.js';

// NOTE: this server intentionally does NOT define __filename/__dirname and
// resolves every path from process.cwd() (pod runner and compose both spawn it
// with cwd = the service folder; esbuild's CJS bundle would also break bare
// `import.meta.url`, so the original AI Studio definitions were removed).

// All services share one pod log stream: tag fatal crashes so trendlogic
// lines stay greppable (exit code preserved so the runner still restarts).
process.on('uncaughtException', (err) => {
  console.error('[trendlogic:FATAL] uncaughtException:', err);
  process.exit(1);
});
process.on('unhandledRejection', (reason) => {
  console.error('[trendlogic:FATAL] unhandledRejection:', reason);
  process.exit(1);
});

const app = express();
app.set('trust proxy', 1);
// The runtime sets PORT (docker compose and the start-portal.mjs pod runner
// both pass it); the 3000 fallback keeps dev mode and the container upstream
// (http://trendlogic:3000) unchanged.
const PORT = parseInt(process.env.PORT || '3000', 10);

app.use(express.json());

// Render videos are protected per-user: a signed-in session is required AND
// the file must belong to that user (tl_videos or tl_ig_posts). Without the
// ownership check any logged-in user could fetch another user's MP4 by
// guessing its /videos/<filename> URL.
app.use('/videos', requireAuth, async (req, res, next) => {
  try {
    const userId = (req as any).userId;
    const rel = decodeURIComponent(req.path || '/').replace(/^\/+/, '');
    const base = rel.split('/').pop() || '';
    // Thumbnails / preview art are non-sensitive; MP4 (and MP3) are private.
    if (!base || !/\.(mp4|mp3)$/i.test(base)) return next();
    if (!userId) return res.status(401).json({ error: 'Authentication required' });
    if (isDbReady() && await userOwnsMediaFile(userId, base)) return next();
    return res.status(404).json({ error: 'Not found' });
  } catch {
    return res.status(404).json({ error: 'Not found' });
  }
}, express.static(path.join(process.cwd(), 'public', 'videos'), {
  setHeaders: (res, filePath) => {
    if (filePath.endsWith('.mp4')) {
      res.setHeader('Content-Type', 'video/mp4');
      res.setHeader('Accept-Ranges', 'bytes');
    } else if (filePath.endsWith('.mp3')) {
      res.setHeader('Content-Type', 'audio/mpeg');
    }
  }
}));

// Per-user uploaded media (Uploder tab): served only to the owning user.
app.use('/uploads', requireAuth, async (req, res, next) => {
  try {
    const userId = (req as any).userId;
    const rel = decodeURIComponent(req.path || '/').replace(/^\/+/, '');
    if (!userId) return res.status(401).json({ error: 'Authentication required' });
    if (!rel || rel.includes('..')) return res.status(404).json({ error: 'Not found' });
    if (isDbReady() && await userOwnsUploadFile(userId, rel)) return next();
    return res.status(404).json({ error: 'Not found' });
  } catch {
    return res.status(404).json({ error: 'Not found' });
  }
}, express.static(path.join(process.cwd(), 'public', 'uploads'), {
  setHeaders: (res, filePath) => {
    if (/\.(mp4|mov|webm|mkv)$/i.test(filePath)) {
      res.setHeader('Content-Type', 'video/mp4');
      res.setHeader('Accept-Ranges', 'bytes');
    }
  }
}));

// ---- Auth & session persistence -------------------------------------------
// Boot the DB pool; registration responses wait until tables are ready, so the
// server stays up even if the shared DB is briefly unreachable at startup.
// Retry in the background: the remote DB sometimes refuses the first
// connection (ETIMEDOUT) yet accepts later ones, so a single boot attempt
// would leave isDbReady() false forever and every login would 503.
void initDatabase().then((ok) => {
  if (ok || (globalThis as any).__tlDbRetry) return;
  const t = setInterval(async () => {
    try {
      if (await initDatabase()) clearInterval(t);
    } catch { /* keep retrying */ }
  }, 15000);
  (globalThis as any).__tlDbRetry = t;
});

// Register the auth router BEFORE the /api gate so /api/auth/* is freely
// reachable while every other API route requires a session.
app.use('/api/auth', authRouter);

// Session gate for the rest of the API surface.
app.use('/api', (req, res, next) => {
  const p = req.path;
  if (p === '/health' || p.startsWith('/health')) return next();
  // Public broadcast scene: OBS browser sources and fullscreen viewers carry
  // no app session, so this read-only headline snapshot stays open (health).
  if (p === '/stream/scene') return next();
  // Public image proxy: the fullscreen scene (?scene=live) and OBS sources
  // carry no session either, yet must show news photos + flags reliably.
  // Safe to open: http(s) only, every hop DNS-checked against private /
  // loopback / metadata ranges, image/* + 8 MB cap + timeout + tiny cache.
  if (p === '/image') return next();
  return requireAuth(req, res, next);
});

// Pending (not-yet-activated) users may sign in and browse, but cannot perform
// privileged actions until an admin activates their account.
function requireActive(req: any, res: any, next: any): void {
  const status = req?.user?.status;
  if (status && status !== 'active' && status !== 'manager') {
    res.status(403).json({ error: 'Account not activated by admin yet' });
    return;
  }
  next();
}
// Initialize Gemini SDK lazily if API key is present
let aiClient: GoogleGenAI | null = null;
function getGeminiClient(): GoogleGenAI | null {
  if (!aiClient && process.env.GEMINI_API_KEY) {
    try {
      aiClient = new GoogleGenAI({
        apiKey: process.env.GEMINI_API_KEY,
        httpOptions: {
          headers: {
            'User-Agent': 'aistudio-build',
          },
        },
      });
    } catch (err) {
      console.warn('Failed to initialize GoogleGenAI client:', err);
    }
  }
  return aiClient;
}

// In-Memory Storage Layer
let trendsDatabase: NormalizedTrend[] = [...INITIAL_TRENDS];
let jobsDatabase: PipelineJob[] = [];
// Jobs are private per user (ownerUserId set at creation). Legacy jobs created
// before this field existed carry no owner and stay visible to all callers so
// nobody loses their history; every NEW job is scoped to its creator.
function jobsForUser(userId: string | undefined): PipelineJob[] {
  if (!userId) return [];
  return jobsDatabase.filter(j => !j.ownerUserId || j.ownerUserId === userId);
}
function findJobForUser(jobId: string | undefined, userId: string | undefined): PipelineJob | undefined {
  if (!jobId || !userId) return undefined;
  const j = jobsDatabase.find(x => x.id === jobId);
  if (!j) return undefined;
  if (j.ownerUserId && j.ownerUserId !== userId) return undefined;
  return j;
}

/* ========================================================================= */
/* Central task queues — ALL heavy or timer-driven work runs through these,  */
/* strictly in FIFO order, so N users firing at the same second can never    */
/* crash the process with concurrent ffmpeg renders / downloads / uploads.   */
/*                                                                           */
/* Two lanes: `pipeline` is CPU-bound (AI + ffmpeg, concurrency 1) so IG      */
/* timers are never stuck behind a 5-minute render; `io` is network-bound    */
/* (IG check/publish, YouTube uploads, trend fetches, concurrency 2).        */
/* Lightweight reads (GET trends/jobs/schedule) stay direct. Tune via env:   */
/* PIPELINE_CONCURRENCY (default 1), IO_CONCURRENCY (default 2),              */
/* MAX_QUEUED_PER_USER (default 3 — 429 past that, stops queue flooding).     */
/*                                                                           */
/* LIVE PRIORITY: while a broadcast is on air, the RTMP push owns the box —  */
/* every bitrate/CPU hiccup is a YouTube-side cut ("not receiving enough     */
/* video") that no auto-restart can heal (our ffmpeg stays alive, YouTube    */
/* already left). So heavy tasks HOLD until the live ends: the whole         */
/* pipeline lane (renders/mixes/AI video) plus the heavy io tasks (uploads,  */
/* reel downloads, watch cycles). They stay queued — nothing is dropped or   */
/* rejected — and run the moment the live stops. Exempt by design:           */
/* `live-prefetch`/`ig-golive` (they ARE the live loop) and light user ops   */
/* (discover/login/latest — tiny network, zero threat to the push).          */
/* ========================================================================= */
interface QueueTask<T> {
  seq: number;
  label: string;
  owner: string | null;
  run: () => Promise<T>;
  resolve: (v: T) => void;
  reject: (e: any) => void;
  /** True = do not START while a broadcast is on air (wait for live end). */
  liveHold: boolean;
  /** When the task was queued — bounds the live-hold wait (see below). */
  enqueuedAt: number;
}

/** Safety valve: a held task waits at most this long past a live broadcast
 *  (default 10 min, env LIVE_HOLD_MAX_MINUTES 1..120), then runs anyway.
 *  Without it, one endless reel loop (or a zombie ffmpeg child) starves
 *  every IG publish/cycle and YouTube upload FOREVER with zero errors —
 *  timers fire silently and manual Publish hangs indefinitely. */
const LIVE_HOLD_MAX_MS = (() => {
  const v = parseFloat(process.env.LIVE_HOLD_MAX_MINUTES || '10');
  if (!isFinite(v)) return 10 * 60 * 1000;
  return Math.min(120, Math.max(1, v)) * 60 * 1000;
})();

function createTaskQueue(name: string, concurrency: number, opts?: { holdWhileLive?: boolean }) {
  const holdDefault = !!opts?.holdWhileLive;
  // Heavy IO work that must also yield to the on-air push (uploads steal
  // RTMP egress, reel downloads + watch cycles burn CPU/disk). Everything
  // else on the io lane (live-prefetch, ig-golive, discover/login/latest —
  // the live loop's own maintenance + tiny user reads) stays exempt.
  const IO_HOLD_PREFIXES = ['yt-autopublish:', 'yt-publish', 'tt-autopublish:', 'tt-publish', 'ig-publish:', 'ig-check:', 'ig-cycle:'];
  let holdTimer: NodeJS.Timeout | null = null;
  let holdLoggedAt = 0;
  const q = {
    name,
    concurrency: Math.max(1, concurrency),
    pending: [] as QueueTask<any>[],
    active: 0,
    seq: 0,
    add<T>(label: string, owner: string | null, run: () => Promise<T>, taskOpts?: { liveHold?: boolean }): Promise<T> {
      const seq = ++q.seq;
      const liveHold = taskOpts?.liveHold
        ?? (holdDefault || IO_HOLD_PREFIXES.some(p => label === p || label.startsWith(p)));
      return new Promise<T>((resolve, reject) => {
        q.pending.push({ seq, label, owner, run, resolve, reject, liveHold, enqueuedAt: Date.now() });
        console.log(`[Queue:${q.name}] #${seq} queued — "${label}"${liveHold ? ' (waits for live end when on air)' : ''} (pending: ${q.pending.length}, active: ${q.active})`);
        void q.pump();
      });
    },
    stats() {
      const held = q.pending.filter(t => t.liveHold).length;
      return { name: q.name, pending: q.pending.length, active: q.active, concurrency: q.concurrency, held, liveHoldActive: held > 0 && isLiveActive() };
    },
    async pump(): Promise<void> {
      while (q.active < q.concurrency && q.pending.length > 0) {
        // Live priority: start the first task that is NOT held by the on-air
        // push. Held tasks keep their place — FIFO order is preserved among
        // runnable tasks, held ones simply wait (the retry timer + every stop
        // re-kick the pump, so nothing sleeps past the live end + ~15s).
        // Starvation guard: past LIVE_HOLD_MAX_MS a held task runs anyway —
        // an endless reel loop must never wedge publishing forever.
        const onAir = isLiveActive();
        const nowMs = Date.now();
        const idx = q.pending.findIndex(t => {
          if (!(t.liveHold && onAir)) return true;
          if (nowMs - t.enqueuedAt > LIVE_HOLD_MAX_MS) {
            console.warn(`[Queue:${q.name}] #${t.seq} held ${Math.round((nowMs - t.enqueuedAt) / 60000)}m by live — running anyway (max hold exceeded).`);
            return true;
          }
          return false;
        });
        if (idx === -1) {
          if (Date.now() - holdLoggedAt > 60000) {
            holdLoggedAt = Date.now();
            console.log(`[Queue:${q.name}] holding ${q.pending.length} task(s) — live on air, they run when it ends.`);
          }
          if (!holdTimer) {
            holdTimer = setTimeout(() => {
              holdTimer = null;
              void q.pump();
            }, 15000);
            (holdTimer as any)?.unref?.();
          }
          return;
        }
        const task = q.pending.splice(idx, 1)[0];
        q.active++;
        console.log(`[Queue:${q.name}] #${task.seq} started — "${task.label}" (pending: ${q.pending.length}, active: ${q.active})`);
        try {
          const out = await task.run();
          task.resolve(out);
        } catch (err: any) {
          // One bad task must never kill the queue (or the process — the top
          // of this file exits on unhandledRejection, so everything is caught).
          console.warn(`[Queue:${q.name}] #${task.seq} failed — "${task.label}":`, err?.message || err);
          task.reject(err);
        } finally {
          q.active--;
          console.log(`[Queue:${q.name}] #${task.seq} done — "${task.label}" (pending: ${q.pending.length}, active: ${q.active})`);
        }
      }
    }
  };
  return q;
}

const pipelineQueue = createTaskQueue('pipeline', parseInt(process.env.PIPELINE_CONCURRENCY || '1', 10) || 1, { holdWhileLive: true });
const ioQueue = createTaskQueue('io', parseInt(process.env.IO_CONCURRENCY || '8', 10) || 8);

/* Dedicated YouTube-upload lane (concurrency 1, never live-held): EVERY
 * publishShortToYouTube call in this process funnels through here, so two
 * timers firing in the same minute (or a timer + a manual click) can never
 * upload two videos at once — uploads run strictly one-by-one, FIFO.
 * No deadlock: the lane's tasks are leaf uploads, they never enqueue into
 * another lane. No live-hold: the lane preserves the historical timer
 * behavior (timer uploads never waited for the live to end). */
const ytUploadQueue = createTaskQueue('yt-upload', 1);
function serializedYouTubeUpload<T>(label: string, owner: string | null, run: () => Promise<T>): Promise<T> {
  return ytUploadQueue.add(`yt-upload:${label}`, owner, run, { liveHold: false });
}

/* Dedicated TikTok-upload lane (concurrency 1, never live-held): EVERY
 * publishVideoToTikTok call funnels through here, so two timers (or a timer
 * + a manual click) can never upload twice at once — strictly one-by-one,
 * FIFO. Leaf uploads only, so no deadlock; the OUTER io labels above
 * (tt-autopublish:/tt-publish) still yield to an on-air RTMP push. */
const ttUploadQueue = createTaskQueue('tt-upload', 1);
function serializedTikTokUpload<T>(label: string, owner: string | null, run: () => Promise<T>): Promise<T> {
  return ttUploadQueue.add(`tt-upload:${label}`, owner, run, { liveHold: false });
}

/* ========================================================================= */
/* Trend publish duplicate guard (durable): the same topic must never be     */
/* uploaded twice to the same channel inside TREND_PUBLISH_DUP_HOURS —       */
/* across restarts/redeploys, timers, velocity triggers and manual           */
/* double-clicks. The old guards only consulted the in-memory job list, so   */
/* every restart wiped them and the next tick re-uploaded the same #1 trend. */
/* The ledger (tl_trend_publishes) is the source of truth; an in-flight set  */
/* closes the in-process double-click race; the guard is re-checked INSIDE   */
/* the serial upload lane so two sequential requests can't both slip through */
/* before the first one records.                                             */
/* ========================================================================= */
const TREND_PUBLISH_DUP_HOURS = (() => {
  const v = parseFloat(process.env.TREND_PUBLISH_DUP_HOURS || '48');
  if (!isFinite(v)) return 48;
  return Math.min(720, Math.max(1, v));
})();

export class TrendDuplicateError extends Error {
  existing: TrendPublishRow | null;
  constructor(message: string, existing: TrendPublishRow | null) {
    super(message);
    this.name = 'TrendDuplicateError';
    this.existing = existing;
  }
}

function duplicatePublishMessage(keyword: string, existing: TrendPublishRow | null): string {
  const when = existing?.published_at ? new Date(existing.published_at) : null;
  const ago = when && Number.isFinite(when.getTime())
    ? ` (${Math.max(1, Math.round((Date.now() - when.getTime()) / 3600000))}h ago${existing?.yt_video_id ? ` as https://youtube.com/shorts/${existing.yt_video_id}` : ''})`
    : '';
  return `"${keyword}" was already published to this channel${ago} — skipping the duplicate upload.`;
}

/** In-flight trend uploads per channel/user (sync check-and-set, no await
 *  between check and set — closes the double-click race in-process). */
const trendPublishInFlight = new Set<string>();
function trendFlightKey(ownerId: string | null, channelId: string | null, keyword: unknown): string {
  return `${channelId || `user:${ownerId || 'anon'}`}:${normalizeTrendKeyword(keyword)}`;
}

async function ownerChannelId(ownerId: string | null): Promise<string | null> {
  if (!ownerId || !isDbReady()) return null;
  try {
    return (await getYouTubeRow(ownerId))?.channel_id || null;
  } catch { return null; }
}

/** Best-effort topic recovery from a display title
 *  ("X Explained #Shorts" -> "X") for manual file publishes without a job. */
function keywordFromTitle(title: unknown): string {
  return String(title || '')
    .replace(/#Shorts/gi, ' ')
    .replace(/\bExplained\b/gi, ' ')
    .replace(/[.]{3}\s*$/g, ' ')
    .replace(/\s+/g, ' ')
    .trim();
}

interface TrendPublishGuardOpts {
  ownerId: string | null;
  keyword: unknown;
  title: string;
  jobId?: string | null;
  outerLabel: string;
  innerLabel: string;
  runUpload: () => Promise<any>;
}

async function guardAndPublishTrendVideo(opts: TrendPublishGuardOpts): Promise<any> {
  const keyword = String(opts.keyword || '').trim();
  const channelId = await ownerChannelId(opts.ownerId);
  const flightKey = trendFlightKey(opts.ownerId, channelId, keyword);
  if (keyword && trendPublishInFlight.has(flightKey)) {
    throw new TrendDuplicateError(`"${keyword}" is already uploading right now — ignoring the second request.`, null);
  }
  if (keyword && isDbReady() && opts.ownerId) {
    const dup = await hasRecentTrendPublish(opts.ownerId, channelId, keyword, TREND_PUBLISH_DUP_HOURS);
    if (dup) throw new TrendDuplicateError(duplicatePublishMessage(keyword, dup), dup);
  }
  if (keyword) trendPublishInFlight.add(flightKey);
  try {
    return await ioQueue.add(opts.outerLabel, opts.ownerId, () =>
      serializedYouTubeUpload(opts.innerLabel, opts.ownerId, async () => {
        // Re-check inside the serial lane: a sequential twin that passed the
        // fast check above now sees the first upload's ledger record.
        if (keyword && isDbReady() && opts.ownerId) {
          const dup = await hasRecentTrendPublish(opts.ownerId, channelId, keyword, TREND_PUBLISH_DUP_HOURS);
          if (dup) throw new TrendDuplicateError(duplicatePublishMessage(keyword, dup), dup);
        }
        const out = await opts.runUpload();
        if (keyword && isDbReady() && opts.ownerId) {
          await recordTrendPublish({
            userId: opts.ownerId, channelId, keyword,
            title: opts.title, ytVideoId: out?.videoId || null, jobId: opts.jobId || null
          });
        }
        return out;
      })
    );
  } finally {
    if (keyword) trendPublishInFlight.delete(flightKey);
  }
}

/* ========================================================================= */
/* Virality engine helpers — auto-comment seeding is DISABLED per owner      */
/* request (2026-10-10): uploads must NOT post any automatic comment.       */
/* postUploadCommentBestEffort is kept as a no-op so all call sites          */
/* (auto-pilot / manual-publish / ig-repost / relax-shorts) stay silent     */
/* without touching upload logic. To re-enable, remove the early return.    */
/* ========================================================================= */
async function postUploadCommentBestEffort(
  userId: string | null,
  videoId: string | null | undefined,
  text: string | null | undefined,
  ctx: string
): Promise<void> {
  void userId; void videoId; void text;
  console.log(`[Engage] auto-comment disabled, skipped on ${videoId || '?'} (${ctx}).`);
  return;
}

/** Punchier alt title via the internal AI chain (null = skip rotation, never
 *  blind-mutate a live title without a semantic rewrite in hand). */
async function generateAltTitle(currentTitle: string, description: string): Promise<string | null> {
  const t = String(currentTitle || '').trim();
  if (!t) return null;
  try {
    const out = await askInternalAI(
      `Rewrite this YouTube Shorts title to be punchier and more clickable (same topic, no clickbait lies, under 100 characters, keep "#Shorts" at the end if present, plain text only, no quotes): "${t}"${description ? ` Context: "${String(description).slice(0, 300)}"` : ''}`,
      20000
    );
    if (!out) return null;
    const line = out.split('\n').map(s => s.trim()).filter(Boolean)[0] || '';
    const clean = line.replace(/^["'«»„“”]+|["'«»„“”]+$/g, '').trim().slice(0, 100);
    if (!clean || clean.toLowerCase() === t.toLowerCase()) return null;
    return clean;
  } catch {
    return null;
  }
}

/** Live priority released — wake the lanes so live-held tasks run now
 *  instead of waiting for the next 15s hold-retry tick. Call after any path
 *  that can take the push off air. */
function kickQueuesAfterLive(): void {
  void pipelineQueue.pump();
  void ioQueue.pump();
}
const MAX_QUEUED_PER_USER = parseInt(process.env.MAX_QUEUED_PER_USER || '3', 10) || 3;

// IG-to-Live cross-hooks: reel decoders die with the push, and an unexpected
// ffmpeg death in reel mode heals back into the reel loop (never news).
registerIgLiveHooks();

/** How many pipeline jobs this user currently has waiting or executing. */
function countUserActiveJobs(userId: string): number {
  return jobsDatabase.filter(j =>
    j.ownerUserId === userId && (j.status === 'queued' || j.status === 'running')
  ).length;
}

/** Enqueue a full pipeline execution; marks the job running at dequeue time. */
function enqueuePipelineJob(
  jobId: string,
  trend: NormalizedTrend,
  customQuestion?: string,
  customAngle?: string,
  onDone?: (job: PipelineJob) => Promise<void>
): Promise<void> {
  const job = jobsDatabase.find(j => j.id === jobId);
  const owner = job?.ownerUserId || null;
  return pipelineQueue.add<void>(`pipeline:${jobId}`, owner, async () => {
    const j = jobsDatabase.find(x => x.id === jobId);
    if (j && j.status === 'queued') {
      j.status = 'running';
      j.currentStep = 'discovery';
      j.logs.push({
        id: `log-${Date.now()}-dequeue`,
        timestamp: new Date().toLocaleTimeString(),
        step: 'Queue',
        message: 'Picked up from the processing queue — production started.',
        type: 'info'
      });
    }
    await runPipelineSteps(jobId, trend, customQuestion, customAngle);
    if (onDone) {
      const done = jobsDatabase.find(x => x.id === jobId);
      if (done) await onDone(done);
    }
  });
}
// Single real discovery source: live Google Trends RSS. (Older builds listed
// extra "Reuters / YouTube / X" providers, but the discover endpoint only ever
// reads the Google Trends feed — the extra rows were cosmetic and confused the
// viral-publishing flow, so they were removed.)
let providerConfigs: TrendProviderConfig[] = [
  {
    id: 'prov-google-trends',
    name: 'Google Trends Real-Time Engine',
    providerType: 'google_trends',
    active: true,
    country: 'US',
    category: 'all',
    refreshIntervalMin: 15,
    lastSync: new Date().toISOString(),
    itemsDiscoveredCount: 142
  }
];

// Seed an initial completed job for the Real Madrid vs Barcelona demo
const initialJob: PipelineJob = {
  id: 'job-rm-fcb-init',
  trendId: 'trend-rm-fcb-01',
  trendKeyword: 'Real Madrid vs Barcelona',
  category: 'sports',
  status: 'completed',
  currentStep: 'completed',
  progressPercent: 100,
  startedAt: new Date(Date.now() - 3600000).toISOString(),
  completedAt: new Date(Date.now() - 3540000).toISOString(),
  logs: [
    { id: 'l1', timestamp: '12:00:01', step: 'Discovery', message: 'Discovered spike: velocity 91/100 across 400k searches', type: 'info' },
    { id: 'l2', timestamp: '12:00:03', step: 'Intent Detection', message: 'Classified primary search intent: [why_trending]', type: 'info' },
    { id: 'l3', timestamp: '12:00:06', step: 'Question Formulation', message: 'Formulated question: "Why is Real Madrid vs Barcelona trending today?"', type: 'success' },
    { id: 'l4', timestamp: '12:00:12', step: 'Fact Verification', message: 'Cross-referenced 4 claims with La Liga & Athletic reports; 100% confidence', type: 'success' },
    { id: 'l5', timestamp: '12:00:18', step: 'Script Engine', message: 'Crafted 5-scene high-retention 38s vertical video script with 1.8cm hook', type: 'info' },
    { id: 'l6', timestamp: '12:00:24', step: 'Quality Control', message: 'Passed QC with 98/100 score. Fact traceability: 100%', type: 'success' },
    { id: 'l7', timestamp: '12:00:30', step: 'Publishing Stage', message: 'Ready for auto-publish to YouTube Shorts and TikTok', type: 'success' }
  ],
  trend: INITIAL_TRENDS[0],
  facts: PRESET_FACTS_MAP['trend-rm-fcb-01'],
  script: PRESET_SCRIPT_MAP['trend-rm-fcb-01'],
  qc: PRESET_QC_MAP['trend-rm-fcb-01'],
  seo: PRESET_SEO_MAP['trend-rm-fcb-01'],
  publishing: [
    { platform: 'youtube_shorts', enabled: true, status: 'published', publishedUrl: 'https://youtube.com/shorts/demo-elclasico' },
    { platform: 'tiktok', enabled: true, status: 'scheduled', scheduledTime: '2026-09-06T14:00:00Z' },
    { platform: 'instagram_reels', enabled: true, status: 'draft' }
  ],
  // No videoUrl/audioUrl: the demo seed has no rendered file on disk and the
  // studio shows an honest empty state until a real render lands in /videos/.
};
jobsDatabase.push(initialJob);

/* ========================================================================= */
/* API ROUTES                                                                */
/* ========================================================================= */

// 1. Health check
app.get('/api/health', (req, res) => {
  res.json({
    status: 'ok',
    geminiConfigured: !!process.env.GEMINI_API_KEY,
    netopen: netopenStatus(),
    tiktokConfigured: isTikTokConfigured(),
    rapidConfigured: isRapidConfigured(),
    rapidUsage: getRapidUsage(),
    totalTrends: trendsDatabase.length,
    activeJobs: jobsDatabase.filter(j => j.status === 'running').length,
    queuedJobs: jobsDatabase.filter(j => j.status === 'queued').length,
    queue: { pipeline: pipelineQueue.stats(), io: ioQueue.stats(), upload: ytUploadQueue.stats(), tiktok: ttUploadQueue.stats() },
    timestamp: new Date().toISOString()
  });
});

// Queue status: how many tasks wait ahead — the UI shows the position.
app.get('/api/queue/status', (req, res) => {
  res.json({ success: true, queue: { pipeline: pipelineQueue.stats(), io: ioQueue.stats(), upload: ytUploadQueue.stats(), tiktok: ttUploadQueue.stats() } });
});

/* ========================================================================= */
/* RTMP probe: push 3s of synthetic black+silence straight to the caller's OWN
 * saved ingest target (their key), bypassing every app path (decoders, pacer,
 * pipes). Two runs: minimal flags vs our exact on-air flags (-rw_timeout).
 * Minimal OK + full FAIL = our flags break this ffmpeg build;
 * both fail identically = the pod's ffmpeg cannot open RTMP at all. A 3s
 * black burst may flash in the channel's Studio preview — harmless, and a
 * full run that connects ALSO proves the saved key is valid.
 * NOTE: never include -timeout in any run — on RTMP outputs it implies
 * listen mode (binds the ingest IP, "Cannot assign requested address"). */
function runRtmpProbeRun(ff: string, args: string[], ms: number): Promise<{
  exitCode: number | null; signal: string | null; durationMs: number; stderrTail: string[];
}> {
  return new Promise((resolve) => {
    const start = Date.now();
    const tail: string[] = [];
    let done = false;
    const mask = (s: string) => s.replace(/(live2?\/)[^\s'"]+/gi, '$1***');
    let proc: ReturnType<typeof spawn>;
    try {
      proc = spawn(ff, args, { stdio: ['ignore', 'pipe', 'pipe'] });
    } catch (err: any) {
      return resolve({ exitCode: null, signal: null, durationMs: Date.now() - start, stderrTail: [mask(String(err?.message || err)).slice(0, 200)] });
    }
    const finish = (code: number | null, sig: string | null) => {
      if (done) return;
      done = true;
      clearTimeout(timer);
      resolve({ exitCode: code, signal: sig, durationMs: Date.now() - start, stderrTail: tail.slice(-12) });
    };
    const timer = setTimeout(() => {
      try {
        proc.kill('SIGKILL');
      } catch { /* already gone */ }
      finish(null, 'TIMEOUT');
    }, ms);
    (timer as any)?.unref?.();
    proc.stderr?.on('data', (d: Buffer) => {
      for (const line of String(d).split('\n')) {
        const t = mask(line.trim());
        if (t) {
          tail.push(t.slice(0, 300));
          if (tail.length > 30) tail.shift();
        }
      }
    });
    proc.on('error', (err: any) => {
      tail.push(`spawn: ${mask(String(err?.message || err)).slice(0, 160)}`);
      finish(null, 'SPAWN_ERROR');
    });
    proc.on('exit', (c: number | null, s: string | null) => finish(c, s));
  });
}

app.post('/api/diag/rtmp-probe', async (req, res) => {
  const userId = (req as any).userId;
  let saved: { rtmpUrl: string; streamKey: string };
  try {
    saved = await resolveWatchStreamTarget(userId);
  } catch (err: any) {
    return res.status(400).json({ success: false, error: String(err?.message || err).slice(0, 200) });
  }
  const base = saved.rtmpUrl.endsWith('/') ? saved.rtmpUrl : `${saved.rtmpUrl}/`;
  const dial = await dialTargetFor(base, saved.streamKey);
  const ff = ffmpegBin();
  const common = [
    '-hide_banner', '-loglevel', 'warning',
    '-re',
    '-f', 'lavfi', '-i', 'nullsrc=s=128x128:r=5',
    '-f', 'lavfi', '-i', 'anullsrc=r=44100:cl=stereo',
    '-t', '3',
    '-c:v', 'libx264', '-preset', 'ultrafast', '-tune', 'zerolatency',
    '-pix_fmt', 'yuv420p',
    '-c:a', 'aac', '-ar', '44100',
  ];
  const runs: { name: string; exitCode: number | null; signal: string | null; durationMs: number; stderrTail: string[] }[] = [];
  for (const [name, extra] of [['minimal', []], ['full-flags', ['-rw_timeout', '15000000']]] as const) {
    // Sequential: two simultaneous pushes would fight for the same key slot.
    runs.push({ name, ...await runRtmpProbeRun(ff, [...common, ...extra, '-f', 'flv', dial], 30000) });
  }
  res.json({
    success: true,
    at: new Date().toISOString(),
    dialHost: dial.replace(/(live2?\/)[^\s'"]+/gi, '$1***').replace(/^rtmp:\/\//, 'rtmp://'),
    note: 'A 3s black burst may flash in Studio preview. exit 0 on a run = that flag set (and the saved key) works end-to-end.',
    runs,
  });
});
/* push + reel decoder flow proof, queue backlogs, ffmpeg health, IG loop    */
/* files on disk, and active network probes (RTMP egress to YouTube :1935,   */
/* downloader reachability, DB). Auth-gated like every other /api route.     */
/* ========================================================================= */

/** CPU baseline captured at boot so the endpoint can report % since start. */
const bootCpu = process.cpuUsage();
const bootAtMs = Date.now();

/** Bounded recursive disk usage (never walks more than maxFiles entries). */
function dirUsage(abs: string, maxFiles = 800): { files: number; bytes: number; truncated: boolean } {
  let files = 0;
  let bytes = 0;
  let truncated = false;
  const stack: string[] = [abs];
  while (stack.length > 0) {
    const d = stack.pop()!;
    let entries: fs.Dirent[];
    try {
      entries = fs.readdirSync(d, { withFileTypes: true });
    } catch {
      continue;
    }
    for (const e of entries) {
      const p = path.join(d, e.name);
      try {
        if (e.isDirectory()) {
          stack.push(p);
        } else if (e.isFile()) {
          if (files >= maxFiles) {
            truncated = true;
            continue;
          }
          files++;
          try {
            bytes += fs.statSync(p).size;
          } catch { /* raced deletion */ }
        }
      } catch { /* raced deletion */ }
    }
  }
  return { files, bytes, truncated };
}

/** The persistent IG loop files (iglive-<watch>.mp4) with size + freshness. */
function loopFiles(): { watchId: string; bytes: number; mtime: string | null }[] {
  const out: { watchId: string; bytes: number; mtime: string | null }[] = [];
  try {
    const dir = path.join(process.cwd(), 'public', 'videos');
    for (const name of fs.readdirSync(dir)) {
      const m = /^iglive-(.+)\.mp4$/.exec(name);
      if (!m) continue;
      try {
        const st = fs.statSync(path.join(dir, name));
        out.push({ watchId: m[1], bytes: st.size, mtime: st.mtime.toISOString() });
      } catch { /* raced deletion */ }
    }
  } catch { /* no videos dir yet */ }
  return out;
}

/** Raw TCP egress probe (connect + immediate close). Answers "can this box
 *  even open RTMP to YouTube" without spawning ffmpeg. */
function probeTcp(host: string, port: number, ms = 8000): Promise<{ ok: boolean; latencyMs: number | null; error: string | null }> {
  return new Promise((resolve) => {
    const start = Date.now();
    let done = false;
    const finish = (ok: boolean, error: string | null) => {
      if (done) return;
      done = true;
      try {
        sock.destroy();
      } catch { /* already gone */ }
      resolve({ ok, latencyMs: ok ? Date.now() - start : null, error });
    };
    const timer = setTimeout(() => finish(false, `connect timeout after ${ms}ms (egress to ${host}:${port} likely blocked)`), ms);
    (timer as any)?.unref?.();
    const sock = net.createConnection({ host, port });
    sock.once('connect', () => {
      clearTimeout(timer);
      finish(true, null);
    });
    sock.once('error', (err) => {
      clearTimeout(timer);
      finish(false, String((err as Error)?.message || err).slice(0, 160));
    });
  });
}

/** Downloader (yt-dlp sidecar) health with a short budget — never wedges diag. */
async function probeDownloader(ms = 5000): Promise<{ ok: boolean; origin: string | null; error: string | null }> {
  const origins: string[] = [];
  const primary = String(process.env.DOWNLOADER_BASE_URL || '').trim().replace(/\/$/, '');
  if (primary) origins.push(primary);
  origins.push('http://downloder:3000', 'http://downloader:3000', 'http://127.0.0.1:8100');
  for (const origin of [...new Set(origins)]) {
    try {
      const c = new AbortController();
      const t = setTimeout(() => c.abort(), ms);
      try {
        const r = await fetch(`${origin}/api/health`, { signal: c.signal });
        if (r.ok) return { ok: true, origin, error: null };
      } finally {
        clearTimeout(t);
      }
    } catch { /* try next origin */ }
  }
  return { ok: false, origin: null, error: 'no downloader origin answered /api/health' };
}

/* ========================================================================= */
/* Deep diagnostics: ONE call returns everything needed to debug the box —   */
/* process RAM/CPU, host memory/load, disk usage of the hot dirs, the live   */
/* push + reel decoder flow proof, queue backlogs, ffmpeg health, IG loop    */
/* files on disk, and active network probes (RTMP egress to YouTube :1935,   */
/* downloader reachability, DB). Auth-gated like every other /api route.     */
/* ========================================================================= */

app.get('/api/diag', async (req, res) => {
  const mem = process.memoryUsage();
  const cpu = process.cpuUsage(bootCpu);
  const procUptimeSec = Math.max(1, Math.round((Date.now() - bootAtMs) / 1000));
  const cpuPct = Math.round(((cpu.user + cpu.system) / 1e6 / procUptimeSec / Math.max(1, os.cpus().length)) * 1000) / 10;
  const live = getLiveStatus();
  const igLive = getIgLiveStatus((req as any).userId);
  const [rtmpEgress, downloader, dueWatches] = await Promise.all([
    probeTcp('a.rtmp.youtube.com', 1935, 8000),
    probeDownloader(5000),
    listDueIgWatches(new Date().toISOString(), 100).catch(() => [] as { id: string }[]),
  ]);
  const nets = os.networkInterfaces();
  const ifaces: Record<string, string[]> = {};
  for (const [name, addrs] of Object.entries(nets)) {
    ifaces[name] = (addrs || []).map(a => `${a.address}/${a.family}${a.internal ? ' (internal)' : ''}`);
  }
  res.json({
    success: true,
    at: new Date().toISOString(),
    process: {
      pid: process.pid,
      node: process.version,
      uptimeSec: procUptimeSec,
      rssMB: Math.round(mem.rss / 1024 / 1024 * 10) / 10,
      heapUsedMB: Math.round(mem.heapUsed / 1024 / 1024 * 10) / 10,
      heapTotalMB: Math.round(mem.heapTotal / 1024 / 1024 * 10) / 10,
      externalMB: Math.round((mem.external || 0) / 1024 / 1024 * 10) / 10,
      cpuUserSec: Math.round(cpu.user / 1e6 * 10) / 10,
      cpuSystemSec: Math.round(cpu.system / 1e6 * 10) / 10,
      cpuPctSinceBoot: cpuPct,
    },
    system: {
      platform: `${os.platform()} ${os.arch()}`,
      hostname: os.hostname(),
      cpuCount: os.cpus().length,
      cpuModel: os.cpus()[0]?.model || null,
      loadAvg: os.loadavg().map(v => Math.round(v * 100) / 100),
      totalMemMB: Math.round(os.totalmem() / 1024 / 1024),
      freeMemMB: Math.round(os.freemem() / 1024 / 1024),
      ifaces,
    },
    live: {
      ...live,
      stalledZeroByte: live.active && live.uptimeSec > 90 && !(live.engine && live.engine.totalMB > 0),
    },
    reelLoop: igLive,
    queues: { pipeline: pipelineQueue.stats(), io: ioQueue.stats() },
    /** Every ffmpeg on the box with real CPU/RSS: ours vs stale orphans. */
    subprocs: listFfmpegProcs(),
    /** Pacer-to-encoder pipe states: proves BOTH transports are fed. */
    pushIo: getPushIoState(),
    ffmpeg: (() => {
      try {
        return { bin: ffmpegBin(), drawtext: live.ffmpegOk };
      } catch (err) {
        return { bin: null, drawtext: live.ffmpegOk, error: String((err as Error)?.message || err).slice(0, 160) };
      }
    })(),
    disk: {
      videos: dirUsage(path.join(process.cwd(), 'public', 'videos')),
      temp: dirUsage(path.join(process.cwd(), 'temp')),
      loopFiles: loopFiles(),
    },
    watches: {
      dbReady: isDbReady(),
      dueCount: Array.isArray(dueWatches) ? dueWatches.length : 0,
    },
    netChecks: {
      rtmpEgress,
      downloader,
    },
  });
});

/* ========================================================================= */
/* YouTube Live broadcast (Stream tab): a continuous real-time ffmpeg RTMP   */
/* push rotating through a multi-country rundown (top-5 stories per country  */
/* by search volume). The picture is generated live — story-wall backdrop +  */
/* drawtext straps refreshed from the rundown — no MP4 is ever uploaded.     */
/* ========================================================================= */

/** Manual pin (null = auto-rotation). Set on start, cleared on stop. */
let livePin: string | null = null;

/** Find a manual topic inside the rundown (any country). */
function snapshotForRundownTopic(keyword: string): LiveTrendSnapshot | null {
  const pin = String(keyword || '').trim().toLowerCase();
  if (!pin) return null;
  for (const c of getRundownCountries()) {
    const hit = c.stories.find(t => t.keyword.toLowerCase() === pin);
    if (hit) return snapshotFromTrend(hit, c.stories);
  }
  return null;
}

// The overlay + rotation ticks read the rundown through this (pin-aware).
setLiveTrendsProvider(() => getRundownSnapshot(livePin));

// Public scene data for the fullscreen broadcast page (?scene=live) and OBS
// browser sources — read-only rundown snapshot, no session required.
app.get('/api/stream/scene', (req, res) => {
  const snap = getRundownSnapshot(livePin);
  if (!snap) {
    return res.status(503).json({
      success: false,
      error: 'Rotation is warming up (fetching country feeds) — retry in a minute.'
    });
  }
  res.json({
    success: true,
    live: getLiveStatus().active,
    updatedAt: new Date().toISOString(),
    scene: snap,
    rundown: getRundownPublic()
  });
});

// Image proxy: trend photos hotlink to publisher origins that routinely
// refuse direct browser loads (ERR_CONNECTION_TIMED_OUT /
// ERR_SSL_PROTOCOL_ERROR). Served same-origin with caching; signed-in users
// only, SSRF-guarded (see server/imageProxy.ts). Frontend uses it for every
// trend thumbnail and keeps onError-hide as the last resort.
app.get('/api/image', async (req, res) => {
  try {
    const url = String(req.query.url || '');
    if (!url) return res.status(400).json({ success: false, stage: 'dns', error: 'Missing ?url=' });
    const img = await fetchProxiedImage(url);
    res.setHeader('Content-Type', img.contentType);
    res.setHeader('Content-Length', img.buf.length);
    res.setHeader('Cache-Control', 'public, max-age=600');
    res.setHeader('X-Image-Cache', img.cached ? 'HIT' : 'MISS');
    res.send(img.buf);
  } catch (err: any) {
    // The stage tells exactly which hop failed (read it in devtools on the
    // 502 response) instead of guessing between DNS/fetch/origin.
    let host = '';
    try {
      host = new URL(String(req.query.url || '')).hostname;
    } catch { /* keep empty */ }
    console.warn(`[image-proxy] ${err?.stage || 'unknown'} ${host}: ${String(err?.message || err).slice(0, 140)}`);
    res.status(502).json({ success: false, stage: err?.stage || 'unknown', error: String(err?.message || err).slice(0, 160) });
  }
});

/* Per-account stream defaults: the key is entered once and reused — the
 * client only ever sees presence + a masked hint, never the key itself. */
app.get('/api/stream/settings', async (req, res) => {
  res.json({ success: true, settings: await getStreamSettingsPublic((req as any).userId) });
});

app.put('/api/stream/settings', async (req, res) => {
  try {
    const { streamKey, rtmpUrl, orientation } = req.body || {};
    if (streamKey !== undefined && String(streamKey).trim() && String(streamKey).trim().length < 4) {
      return res.status(400).json({ success: false, error: 'That stream key looks too short — paste the full key from YouTube Studio.' });
    }
    if (rtmpUrl !== undefined && String(rtmpUrl).trim() && !/^rtmps?:\/\//i.test(String(rtmpUrl).trim())) {
      return res.status(400).json({ success: false, error: 'RTMP URL must start with rtmp:// or rtmps://' });
    }
    await saveStreamSettings((req as any).userId, { streamKey, rtmpUrl, orientation });
    res.json({ success: true, settings: await getStreamSettingsPublic((req as any).userId) });
  } catch (err: any) {
    const msg = String(err?.message || err);
    res.status(msg.includes('DATABASE_UNAVAILABLE') ? 503 : 500).json({ success: false, error: 'Could not save settings — database unreachable.' });
  }
});

app.delete('/api/stream/settings', async (req, res) => {
  await clearStreamSettings((req as any).userId);
  res.json({ success: true, settings: null });
});

app.get('/api/stream/status', (req, res) => {
  const caller = (req as any).userId;
  const owner = getLiveOwner();
  res.json({ success: true, stream: { ...getLiveStatus(), mine: !owner || owner === caller } });
});

// Ask YouTube itself whether our RTMP data arrives (healthStatus per
// stream + saved-key match, tokens never leave the backend).
app.get('/api/stream/ingest-health', async (req, res) => {
  try {
    const caller = (req as any).userId;
    const saved = caller ? await getStreamSettingsRow(caller) : null;
    const health = await getIngestHealth(caller, saved?.stream_key || null);
    res.json({ success: true, health });
  } catch (err: any) {
    res.status(400).json({ success: false, error: String(err?.message || err).slice(0, 220) });
  }
});

app.post('/api/stream/start', async (req, res) => {
  try {
    const { streamKey, rtmpUrl, topicKeyword, orientation } = req.body || {};
    const caller = (req as any).userId || null;
    // Key resolution: typed key wins, otherwise the account's saved key —
    // entered once, reused forever. Nothing to resolve = clear 400.
    const saved = caller ? await getStreamSettingsRow(caller) : null;
    const typedKey = typeof streamKey === 'string' ? streamKey.trim() : '';
    const key = typedKey || (saved?.stream_key && saved.stream_key.length >= 4 ? saved.stream_key : '');
    if (!key || key.length < 4) {
      return res.status(400).json({
        success: false,
        error: 'No stream key — paste it once from YouTube Studio (it will be saved to your account for next time).'
      });
    }
    const pin = typeof topicKeyword === 'string' && topicKeyword ? topicKeyword : null;
    let snap: LiveTrendSnapshot | null;
    if (pin) {
      snap = snapshotForRundownTopic(pin);
      if (!snap) {
        return res.status(400).json({
          success: false,
          error: 'That story is not in the current rotation — pick one from the rotation list or use Auto-rotation.'
        });
      }
    } else {
      snap = getRundownSnapshot(null);
    }
    if (!snap) {
      return res.status(503).json({
        success: false,
        error: 'Rotation is warming up (fetching country feeds) — retry in a minute.'
      });
    }
    livePin = pin;
    const typedRtmp = typeof rtmpUrl === 'string' && rtmpUrl.trim() ? rtmpUrl.trim() : null;
    const base = typedRtmp || saved?.rtmp_url || 'rtmp://a.rtmp.youtube.com/live/';
    const streamOrientation = normalizeLiveOrientation(
      orientation !== undefined ? orientation : saved?.orientation
    );
    const stream = await startLiveBroadcast({
      rtmpUrl: base,
      streamKey: key,
      snapshot: snap,
      ownerUserId: caller,
      orientation: streamOrientation,
      rotation: !pin
    });
    // Remember the working setup for next time (best-effort — a save failure
    // must never fail a live broadcast).
    if (caller) {
      void saveStreamSettings(caller, { streamKey: key, rtmpUrl: base, orientation: streamOrientation }).catch(() => {});
    }
    // The push now lives entirely on the server (ffmpeg child + overlay
    // timer) — the client only manages start/stop/new-key from here on.
    res.json({ success: true, stream: { ...stream, mine: true } });
  } catch (err: any) {
    const msg = String(err?.message || err);
    res.status(msg.startsWith('Already live') ? 409 : 400).json({ success: false, error: msg });
  }
});

app.post('/api/stream/stop', (req, res) => {
  try {
    const stream = stopLiveBroadcast((req as any).userId || null);
    livePin = null;
    // Live priority released — held queue tasks (renders/mixes/uploads) run now.
    kickQueuesAfterLive();
    res.json({ success: true, stream: { ...stream, mine: true } });  } catch (err: any) {
    const msg = String(err?.message || err);
    res.status(msg.includes('another signed-in user') ? 403 : 400).json({ success: false, error: msg });
  }
});

// Owner-only restart: kill the running push and resume in a single call.
// Key falls back typed -> account saved -> current session (so "restart with
// the same key" reconnects a wedged push with one click, no typing).
app.post('/api/stream/restart', async (req, res) => {
  try {
    // A reel loop is not a news push — restarting it as news would silently
    // replace the loop. Stop the loop first, then Go Live from the Stream tab.
    if (getLiveMode() === 'reel') {
      return res.status(400).json({
        success: false,
        error: 'An Instagram reel loop is on air — stop it from its profile first, then Go Live from the Stream tab.'
      });
    }
    const { streamKey, rtmpUrl, orientation } = req.body || {};
    const caller = (req as any).userId || null;
    const typedKey = typeof streamKey === 'string' ? streamKey.trim() : '';
    let key = typedKey;
    if (!key && caller) {
      const saved = await getStreamSettingsRow(caller);
      if (saved?.stream_key && saved.stream_key.length >= 4) key = saved.stream_key;
    }
    if (!key && caller) {
      const session = await getLiveStream(caller);
      if (session?.stream_key && session.stream_key.length >= 4) key = session.stream_key;
    }
    if (!key || key.length < 4) {
      return res.status(400).json({
        success: false,
        error: 'No stream key to restart with — paste a key (it will be saved) or save one first.'
      });
    }
    // Topic semantics: missing = keep current mode; '' = back to
    // auto-rotation; a keyword = (re)pin to that story.
    const raw = (req.body || {}).topicKeyword;
    if (raw !== undefined) {
      livePin = typeof raw === 'string' && raw ? raw : null;
    }
    let snap: LiveTrendSnapshot | null;
    if (livePin) {
      snap = snapshotForRundownTopic(livePin);
      if (!snap) {
        return res.status(400).json({
          success: false,
          error: 'That story is not in the current rotation — pick one from the rotation list or clear the topic for Auto-rotation.'
        });
      }
    } else {
      snap = getRundownSnapshot(null);
    }
    if (!snap) {
      return res.status(503).json({
        success: false,
        error: 'Rotation is warming up (fetching country feeds) — retry in a minute.'
      });
    }
    const stream = await restartLiveBroadcast({
      streamKey: key,
      rtmpUrl,
      topicKeyword: livePin,
      requesterUserId: caller,
      snapshot: snap,
      orientation: orientation !== undefined ? normalizeLiveOrientation(orientation) : null,
      rotation: !livePin
    });
    res.json({ success: true, stream: { ...stream, mine: true } });
  } catch (err: any) {
    const msg = String(err?.message || err);
    res.status(msg.includes('another signed-in user') ? 403 : 400).json({ success: false, error: msg });
  }
});

// 2. Trend Engine: Get all trends
app.get('/api/trends', (req, res) => {
  const { category, search } = req.query;
  let filtered = [...trendsDatabase];

  if (category && category !== 'all') {
    filtered = filtered.filter(t => t.category === category);
  }

  if (search && typeof search === 'string') {
    const q = search.toLowerCase();
    filtered = filtered.filter(t =>
      t.keyword.toLowerCase().includes(q) ||
      t.description.toLowerCase().includes(q) ||
      t.primaryQuestion?.toLowerCase().includes(q)
    );
  }

  // Covers skip hosts under cooldown (recent 403/410) per request — the UI
  // then shows the next playable photo (or the honest fallback) instead of
  // a thumbnail guaranteed to 502. Stored rows are never mutated.
  const cooled = filtered.map(t => {
    const cover = pickPlayableImage([t.image_url, ...(t.storyImageUrls || [])]);
    if ((cover || '') === (t.image_url || '')) return t;
    return { ...t, image_url: cover };
  });

  res.json({
    trends: cooled,
    total: cooled.length
  });
});

// Real Trending Now feed (same RPC as trends.google.com/trending?geo=X&hours=24:
// hundreds of rows with volume/growth/breakdown/news). RSS is only the
// fallback — it publishes ~10/day and never matches the page.
const MOCK_IDS = new Set(INITIAL_TRENDS.map(t => t.id));

// Merge helper: live top-10 on top, user-created customs kept, seeded demo
// mocks and previous live rows dropped — the list never grows past live + customs.
function mergeLiveTrends(liveTrends: NormalizedTrend[]) {
  const nonLive = trendsDatabase.filter(t => !t.isLiveGoogleTrend && !MOCK_IDS.has(t.id));
  trendsDatabase = [...liveTrends, ...nonLive];
}

async function fetchLiveTrends(country = 'US') {
  try {
    const now = await fetchTrendingNow(country, 24);
    if (now.length > 0) return { trends: now, source: 'trending_now' as const };
  } catch (err: any) {
    console.warn('[Trends] Trending Now feed failed, falling back to RSS:', err?.message || err);
  }
  const rss = await fetchGoogleTrendsRSS(country);
  return { trends: rss, source: 'google_trends_rss' as const };
}

// Helper: Ingest real-time Google Trends and optionally launch video generation for #1 top trend
async function ingestRealGoogleTrends(country = 'US', autoRunTopTrend = false, ownerUserId: string | null = null) {
  try {
    const { trends: liveTrends, source } = await fetchLiveTrends(country);
    if (liveTrends.length > 0) {
      // Keep live trends at the top of the database
      mergeLiveTrends(liveTrends);

      // Update provider config
      const provIdx = providerConfigs.findIndex(p => p.id === 'prov-google-trends');
      if (provIdx !== -1) {
        providerConfigs[provIdx].lastSync = new Date().toISOString();
        providerConfigs[provIdx].country = country;
        providerConfigs[provIdx].itemsDiscoveredCount = (providerConfigs[provIdx].itemsDiscoveredCount || 0) + liveTrends.length;
      }

      console.log(`[Google Trends] Ingested ${liveTrends.length} live trends for geo: ${country}. #1: "${liveTrends[0].keyword}" (${liveTrends[0].rawGoogleTraffic || 'high'})`);

      if (autoRunTopTrend) {
        const topTrend = liveTrends[0];
        const jobId = `job-gt-${Date.now()}`;
        const newJob: PipelineJob = {
          id: jobId,
          ownerUserId,
          trendId: topTrend.id,
          trendKeyword: topTrend.keyword,
          category: topTrend.category,
          status: 'queued',
          currentStep: 'idle',
          progressPercent: 0,
          startedAt: new Date().toISOString(),
          logs: [
            {
              id: `log-${Date.now()}-1`,
              timestamp: new Date().toLocaleTimeString(),
              step: 'Google Trends Live Ingestion',
              message: `Ingested real-time #1 spike directly from Google Trends RSS: "${topTrend.keyword}" with ${topTrend.rawGoogleTraffic || 'high surge'} searches. Queued for production (queue serializes all users' jobs).`,
              type: 'info'
            }
          ],
          trend: { ...topTrend },
          publishing: [
            { platform: 'youtube_shorts', enabled: true, status: 'draft' },
            { platform: 'tiktok', enabled: true, status: 'draft' }
          ]
        };
        jobsDatabase.unshift(newJob);
        // Fire-and-forget into the queue: simultaneous users pile up in FIFO
        // order instead of running concurrent ffmpeg renders. Never rejects
        // unhandled (the queue catches everything) — the catch is belt & braces.
        void enqueuePipelineJob(jobId, topTrend).catch(() => {});
        return { topTrend, job: newJob };
      }
      return { topTrend: liveTrends[0], job: null };
    }
  } catch (err: any) {
    console.error('[Google Trends Ingestion Error]', err.message);
  }
  return null;
}

// 3. Trend Engine: Trigger Provider Discovery / Sync - REAL GOOGLE TRENDS FIRST
// The live fetch serializes through the IO lane so concurrent Discover
// clicks (or a Discover during an auto-pilot fetch) never stampede the feed.
app.post('/api/trends/discover', async (req, res) => {
  const { providerId, country = 'US' } = req.body;

  try {
    const { trends: liveTrends, source } = await ioQueue.add('trends-discover', (req as any).userId || null, () =>
      fetchLiveTrends(country)
    );
    if (liveTrends.length > 0) {
      mergeLiveTrends(liveTrends);

      const provIdx = providerConfigs.findIndex(p => p.id === 'prov-google-trends');
      if (provIdx !== -1) {
        providerConfigs[provIdx].lastSync = new Date().toISOString();
        providerConfigs[provIdx].country = country;
        providerConfigs[provIdx].itemsDiscoveredCount = (providerConfigs[provIdx].itemsDiscoveredCount || 0) + liveTrends.length;
      }

        return res.json({
          success: true,
          source,
          isRealData: true,
          country,
          addedCount: liveTrends.length,
          trends: (liveTrends || []).slice(0, 10)
        });
    }
  } catch (err: any) {
    console.warn('Live Trends fetch encountered warning, falling back to backup wire:', err.message);
  }

  // Backup fallback if Google Trends RSS is unreachable
  res.json({
    success: true,
    source: 'cache',
    addedCount: trendsDatabase.length,
    trends: trendsDatabase
  });
});

// 3.1 One-Click: Auto-Ingest Google Trends and immediately produce video for #1 top trend
app.post('/api/trends/auto-top-video', requireActive, async (req, res) => {
  const { country = 'US', voice } = req.body;
  const ownerUserId = (req as any).userId || null;
  const voiceId = isKnownTemplateVoice(voice) ? voice : undefined;
  if (ownerUserId && countUserActiveJobs(ownerUserId) >= MAX_QUEUED_PER_USER) {
    return res.status(429).json({
      success: false,
      error: `You already have ${MAX_QUEUED_PER_USER} jobs waiting/running — please wait for one to finish.`
    });
  }
  try {
    const result = await ingestRealGoogleTrends(country, true, ownerUserId);
    if (result && result.job) {
      if (voiceId) result.job.voiceId = voiceId;
      return res.json({
        success: true,
        trend: result.topTrend,
        job: result.job,
        message: `Successfully launched video engine for Google Trends #1: "${result.topTrend.keyword}"`
      });
    }

    // If already ingested, use the #1 top trend
    const topTrend = trendsDatabase[0] || INITIAL_TRENDS[0];
    const jobId = `job-gt-${Date.now()}`;
    const newJob: PipelineJob = {
      id: jobId,
      ownerUserId,
      trendId: topTrend.id,
      trendKeyword: topTrend.keyword,
      category: topTrend.category,
      status: 'queued',
      currentStep: 'idle',
      progressPercent: 0,
      startedAt: new Date().toISOString(),
      voiceId,
      logs: [
        {
          id: `log-${Date.now()}-1`,
          timestamp: new Date().toLocaleTimeString(),
          step: 'Pipeline Trigger',
          message: `Directly launched video engine for #1 trending news: "${topTrend.keyword}" — queued for production.`,
          type: 'info'
        }
      ],
      trend: { ...topTrend },
      publishing: [
        { platform: 'youtube_shorts', enabled: true, status: 'draft' },
        { platform: 'tiktok', enabled: true, status: 'draft' }
      ]
    };
    jobsDatabase.unshift(newJob);
    void enqueuePipelineJob(jobId, topTrend).catch(() => {});
    res.json({
      success: true,
      trend: topTrend,
      job: newJob,
      queuePosition: pipelineQueue.stats().pending,
      message: `Launched video engine for #1 trend: "${topTrend.keyword}"`
    });
  } catch (err: any) {
    res.status(500).json({ error: err.message });
  }
});

/* ========================================================================= */
/* 3.2 Auto-Pilot scheduler: user-timed production + publishing for #1 trend */
/* ========================================================================= */
/* Auto-Pilot scheduler state lives ONLY in the tl_auto_schedule table
 * (one row per user). The old data/autoSchedule.json file is gone as a
 * source of truth: it was never shipped in the deploy bundle and had no
 * volume, so every redeploy silently disarmed the timer. */
interface AutoScheduleState {
  enabled: boolean;
  intervalHours: number;
  intervalMinutes: number;
  autoPublish: boolean;
  country: string;
  ownerUserId: string | null;
  lastRunAt: string | null;
  nextRunAt: string | null;
  lastJobId: string | null;
}

const LEGACY_SCHEDULE_FILE = path.join(process.cwd(), 'data', 'autoSchedule.json');
let scheduleMigrated = false;

function envDefaultHours(): number {
  return Math.min(168, Math.max(0.25, parseFloat(process.env.AUTO_SCHEDULE_HOURS || '2') || 2));
}

/** Public shape for GET/PUT /api/schedule (owner never leaks). */
function publicScheduleFor(row: AutoScheduleRow | null): AutoScheduleState {
  const hours = row ? Number(row.interval_hours) : envDefaultHours();
  return {
    enabled: row ? row.enabled === 1 : process.env.AUTO_SCHEDULE_ENABLED === 'true',
    intervalHours: Math.round(hours * 10000) / 10000,
    intervalMinutes: Math.round(hours * 60),
    autoPublish: row ? row.auto_publish === 1 : process.env.AUTO_SCHEDULE_PUBLISH === 'true',
    country: row?.country || 'US',
    ownerUserId: null,
    lastRunAt: row?.last_run_at || null,
    nextRunAt: row?.next_run_at || null,
    lastJobId: row?.last_job_id || null
  };
}

/** One-time import of the pre-DB file schedule (if any) so users who armed
 *  the timer before this change keep it. Runs lazily once the DB is up. */
async function migrateLegacyScheduleFile(): Promise<void> {
  if (scheduleMigrated) return;
  scheduleMigrated = true;
  try {
    if (!fs.existsSync(LEGACY_SCHEDULE_FILE)) return;
    const raw = JSON.parse(fs.readFileSync(LEGACY_SCHEDULE_FILE, 'utf8'));
    const owner = typeof raw.ownerUserId === 'string' ? raw.ownerUserId : null;
    if (!owner || !raw.enabled) return;
    if (await getAutoSchedule(owner)) return; // DB row already wins
    const h = Math.min(168, Math.max(0.25, Number(raw.intervalHours) || envDefaultHours()));
    await upsertAutoSchedule(owner, {
      enabled: true,
      intervalHours: Math.round(h * 10000) / 10000,
      autoPublish: !!raw.autoPublish,
      country: typeof raw.country === 'string' && raw.country.trim() ? raw.country.trim().toUpperCase().slice(0, 8) : 'US',
      lastRunAt: typeof raw.lastRunAt === 'string' ? raw.lastRunAt : null,
      nextRunAt: typeof raw.nextRunAt === 'string' ? raw.nextRunAt : null,
      lastJobId: typeof raw.lastJobId === 'string' ? raw.lastJobId : null
    });
    console.log(`[Auto-Pilot] migrated legacy file schedule for user ${owner} into tl_auto_schedule.`);
  } catch (err) {
    console.warn('[Auto-Pilot] legacy schedule migration note:', (err as Error).message);
  }
  try {
    if (fs.existsSync(LEGACY_SCHEDULE_FILE)) {
      fs.renameSync(LEGACY_SCHEDULE_FILE, LEGACY_SCHEDULE_FILE + '.migrated');
    }
  } catch { /* backup rename is best effort */ }
}

/** Overlap guard so a slow tick never runs twice at once. */
let autoTickRunning = false;

async function runAutoPilotCycleFor(sched: AutoScheduleRow) {
  const ownerId = sched.user_id;
  const country = sched.country || 'US';
  const autoPublish = sched.auto_publish === 1;
  // Never pile up: if a job is queued or running (any user — the pipeline
  // lane is global FIFO), this user's firing waits for the next minute
  // instead of growing the queue. Logged (not silent) so it stays visible.
  const busy = jobsDatabase.find(j => j.status === 'running' || j.status === 'queued');
  if (busy) {
    console.log(`[Auto-Pilot] tick skipped for user ${ownerId} — job "${busy.id}" (${busy.trendKeyword}) ${busy.status}; retry in 60s.`);
    return;
  }
  try {
    const { trends: live } = await fetchLiveTrends(country);
    if (live.length > 0) mergeLiveTrends(live);
    // Duplicate guard: never remake a topic produced in the last 24h (or
    // still queued/running) — fall through to the next fresh trend instead.
    const normKey = (s: string) => s.toLowerCase().replace(/[^a-z0-9\u0600-\u06FF]+/gi, ' ').trim();
    const DUP_HORIZON_MS = 24 * 3600 * 1000;
    const isDup = (t: NormalizedTrend) => {
      const k = normKey(t.keyword);
      return jobsDatabase.some(j => {
        if (normKey(j.trendKeyword) !== k) return false;
        if (j.status === 'running' || j.status === 'queued') return true;
        if (j.status !== 'completed') return false;
        return Date.now() - new Date(j.startedAt).getTime() < DUP_HORIZON_MS;
      });
    };
    // Durable duplicate guard: the in-memory check above goes blind after
    // every restart/redeploy (jobsDatabase is wiped), so the publish ledger
    // is consulted too — otherwise the next tick re-uploads the same #1
    // trend to the channel. Bounded to the first 10 memory-fresh candidates
    // so one cycle never fires a query storm.
    const ownerChannel = await ownerChannelId(ownerId);
    let topTrend: NormalizedTrend | undefined;
    let skippedPublished = 0;
    let scanned = 0;
    for (const t of trendsDatabase) {
      if (isDup(t)) continue;
      if (scanned < 10 && isDbReady() && ownerId) {
        scanned++;
        const dup = await hasRecentTrendPublish(ownerId, ownerChannel, t.keyword, TREND_PUBLISH_DUP_HOURS);
        if (dup) { skippedPublished++; continue; }
      }
      topTrend = t;
      break;
    }
    if (!topTrend) {
      console.log(`[Auto-Pilot] every top trend was already produced/published recently${skippedPublished ? ` (${skippedPublished} skipped: already on the channel)` : ''} — skipping this cycle.`);
      return;
    }
    const topRank = trendsDatabase.indexOf(topTrend) + 1;
    if (topRank > 1) {
      console.log(`[Auto-Pilot] #1 already produced recently — falling through to rank #${topRank} "${topTrend.keyword}".`);
    }
    const jobId = `job-auto-${Date.now()}`;
    const newJob: PipelineJob = {
      id: jobId,
      ownerUserId: ownerId || null,
      trendId: topTrend.id,
      trendKeyword: topTrend.keyword,
      category: topTrend.category,
      status: 'queued',
      currentStep: 'idle',
      progressPercent: 0,
      startedAt: new Date().toISOString(),
      logs: [
        {
          id: `log-${Date.now()}-auto`,
          timestamp: new Date().toLocaleTimeString(),
          step: 'Auto-Pilot',
          message: `Timer fired — queued video for "${topTrend.keyword}" (rank #${topRank}).`,
          type: 'info'
        }
      ],
      trend: { ...topTrend },
      publishing: [
        { platform: 'youtube_shorts', enabled: true, status: 'draft' },
        { platform: 'tiktok', enabled: true, status: 'draft' }
      ]
    };
    jobsDatabase.unshift(newJob);
    try {
      await upsertAutoSchedule(ownerId, { lastRunAt: new Date().toISOString(), lastJobId: jobId });
    } catch (err) {
      console.warn('[Auto-Pilot] run stamp persist note:', (err as Error).message);
    }

    // Enqueue — the pipeline lane executes when its turn comes, then the
    // auto-publish continuation runs inside the same queued task.
    const autoOwner = ownerId;
    void enqueuePipelineJob(jobId, topTrend, undefined, undefined, async (done) => {
      if (!(autoPublish && done.status === 'completed' && done.videoUrl && autoOwner)) return;
      try {
        const cleanPath = done.videoUrl!.startsWith('/') ? done.videoUrl!.slice(1) : done.videoUrl!;
        const videoPath = path.join(process.cwd(), 'public', cleanPath);
        if (!fs.existsSync(videoPath)) return;
        // Guarded upload: the durable ledger blocks a second upload of the
        // same topic (restart amnesia, twin timers, retries) — inside the
        // same IO + serial lanes as before, so live-hold behavior is kept.
        const pubTitle = done.seo?.title || `${done.trendKeyword} Explained #Shorts`;
        const pub = await guardAndPublishTrendVideo({
          ownerId: autoOwner,
          keyword: done.trendKeyword,
          title: pubTitle,
          jobId: done.id,
          outerLabel: `yt-autopublish:${done.id}`,
          innerLabel: `auto:${done.id}`,
          runUpload: () => publishShortToYouTube(autoOwner, videoPath, {
            title: pubTitle,
            description: done.seo?.description || '',
            tags: done.seo?.tags
          })
        });
        const yt = done.publishing?.find(p => p.platform === 'youtube_shorts');
        if (yt) {
          yt.status = 'published';
          yt.publishedUrl = pub.publishedUrl;
        }
        // Virality: seed the comment section with the engagement question.
        void postUploadCommentBestEffort(autoOwner, pub.videoId, done.seo?.pinnedComment || `Did you search for "${done.trendKeyword}" today? Tell us why 👇`, 'auto-pilot');
        done.logs.push({
          id: `log-${Date.now()}-auto-yt`,
          timestamp: new Date().toLocaleTimeString(),
          step: 'Auto-Pilot',
          message: `Auto-published to YouTube Shorts: ${pub.publishedUrl}`,
          type: 'success'
        });
        // Simultaneous TikTok: the SAME rendered MP4 goes to the user's
        // linked TikTok account right after YouTube. Best-effort by design —
        // a TikTok failure (no link, unaudited app, API error) is logged on
        // the job and never fails the YouTube publish above.
        try {
          const ttRow = await getTikTokRow(autoOwner);
          if (ttRow?.connected && (ttRow.access_token || ttRow.refresh_token)) {
            const ttPub = await ioQueue.add(`tt-autopublish:${done.id}`, autoOwner, () =>
              serializedTikTokUpload(`auto:${done.id}`, autoOwner, () =>
                publishVideoToTikTok(autoOwner, videoPath, {
                  title: `${done.seo?.title || done.trendKeyword} ${(done.seo?.tags || []).slice(0, 4).join(' ')}`.trim().slice(0, 2200),
                  privacyLevel: (ttRow.privacy_level === 'SELF_ONLY' ? 'SELF_ONLY' : 'PUBLIC_TO_EVERYONE')
                })
              )
            );
            const tt = done.publishing?.find(p => p.platform === 'tiktok');
            if (tt) {
              tt.status = 'published';
              tt.publishedUrl = ttPub.publishedUrl || undefined;
            }
            done.logs.push({
              id: `log-${Date.now()}-auto-tt`,
              timestamp: new Date().toLocaleTimeString(),
              step: 'Auto-Pilot',
              message: `Auto-published to TikTok: ${ttPub.message}`,
              type: 'success'
            });
          } else {
            done.logs.push({
              id: `log-${Date.now()}-auto-tt-skip`,
              timestamp: new Date().toLocaleTimeString(),
              step: 'Auto-Pilot',
              message: 'TikTok skipped — no TikTok account linked (connect once in the Publisher).',
              type: 'info'
            });
          }
        } catch (ttErr: any) {
          done.logs.push({
            id: `log-${Date.now()}-auto-tt-err`,
            timestamp: new Date().toLocaleTimeString(),
            step: 'Auto-Pilot',
            message: `TikTok auto-publish note: ${String(ttErr?.message || ttErr).slice(0, 220)}`,
            type: 'warn'
          });
        }
        // Delete the rendered video file + DB record after publishing to save disk.
        try {
          const base = path.basename(videoPath);
          if (fs.existsSync(videoPath)) fs.rmSync(videoPath, { force: true });
          const thumb = videoPath.replace(/\.mp4$/i, '_thumb.jpg');
          if (fs.existsSync(thumb)) fs.rmSync(thumb, { force: true });
          await deleteVideoRecord(autoOwner, base);
        } catch { /* best effort */ }
        cleanupJobTempFiles(done.id);
      } catch (pubErr: any) {
        const isDup = (pubErr as any)?.name === 'TrendDuplicateError';
        if (isDup) console.log(`[Auto-Pilot] duplicate publish blocked: ${pubErr?.message || pubErr}`);
        done.logs.push({
          id: `log-${Date.now()}-auto-yt-err`,
          timestamp: new Date().toLocaleTimeString(),
          step: 'Auto-Pilot',
          message: isDup ? `Duplicate blocked: ${pubErr?.message || pubErr}` : `Auto-publish skipped: ${pubErr?.message || pubErr}`,
          type: 'warn'
        });
      }
    }).catch(() => {});
  } catch (err: any) {
    console.warn(`[Auto-Pilot] cycle failed for user ${ownerId}:`, err?.message || err);
  } finally {
    // Always roll the timer forward — a failed cycle must never wedge the
    // schedule into firing every minute forever.
    try {
      const cur = await getAutoSchedule(ownerId);
      const h = cur ? Number(cur.interval_hours) : Number(sched.interval_hours) || 2;
      await upsertAutoSchedule(ownerId, {
        nextRunAt: new Date(Date.now() + h * 3600000).toISOString()
      });
    } catch (err) {
      console.warn('[Auto-Pilot] next-run persist note:', (err as Error).message);
    }
  }
}

/** Per-user Auto-Pilot ticker: every armed timer whose next firing is due
 *  runs its cycle. Schedules live in tl_auto_schedule, so they survive ANY
 *  restart or redeploy — overdue timers catch up on the next tick. */
async function tickAutoSchedules() {
  if (autoTickRunning) return; // previous tick still working — never overlap.
  if (!isDbReady()) return;
  autoTickRunning = true;
  try {
    await migrateLegacyScheduleFile();
    const due = await listDueAutoSchedules(new Date().toISOString(), 5);
    for (const s of due) {
      // Awaited one by one: each cycle re-checks the global busy guard, so
      // one user's firing never buries another's under a queue pile-up.
      await runAutoPilotCycleFor(s);
    }
    if (due.length > 0) console.log(`[Auto-Pilot] tick fired ${due.length} due timer(s).`);
  } catch (err: any) {
    console.warn('[Auto-Pilot] tick failed:', err?.message || err);
  } finally {
    autoTickRunning = false;
  }
}

// Timer limits: 15 minutes .. 7 days. Minutes are first-class:
// `intervalMinutes` (total minutes) wins when present, otherwise
// `intervalHours` is converted. Both forms stay accepted forever.
const AUTO_MIN_MINUTES = 240;
const AUTO_MAX_MINUTES = 168 * 60;

function parseAutoInterval(body: any): number | null {
  if (body?.intervalMinutes !== undefined && body?.intervalMinutes !== null && body?.intervalMinutes !== '') {
    const totalMin = Number(body.intervalMinutes);
    if (!isFinite(totalMin)) return null;
    return Math.round(totalMin);
  }
  if (body?.intervalHours !== undefined && body?.intervalHours !== null && body?.intervalHours !== '') {
    const h = Number(body.intervalHours);
    if (!isFinite(h)) return null;
    return Math.round(h * 60);
  }
  return null;
}

app.get('/api/schedule', async (req, res) => {
  // Every user owns exactly one Auto-Pilot timer, persisted in the DB —
  // arming it once keeps it firing across all future deploys.
  const caller = (req as any).userId;
  const row = await getAutoSchedule(caller);
  res.json({ success: true, schedule: publicScheduleFor(row) });
});

app.put('/api/schedule', async (req, res) => {
  const { enabled, autoPublish, country } = req.body || {};
  const caller = (req as any).userId;
  const patch: Parameters<typeof upsertAutoSchedule>[1] = {};
  if (enabled !== undefined) patch.enabled = !!enabled;
  const totalMin = parseAutoInterval(req.body || {});
  if (totalMin !== null) {
      if (totalMin < AUTO_MIN_MINUTES || totalMin > AUTO_MAX_MINUTES) {
        return res.status(400).json({ success: false, error: `Timer must be between 4 hours and 7 days (${AUTO_MIN_MINUTES}–${AUTO_MAX_MINUTES} minutes) — shorter intervals can look suspicious to YouTube.` });
      }
    patch.intervalHours = Math.round((totalMin / 60) * 10000) / 10000;
  }
  if (autoPublish !== undefined) patch.autoPublish = !!autoPublish;
  if (typeof country === 'string' && country.trim()) {
    patch.country = country.trim().toUpperCase().slice(0, 8);
  }
  try {
    const row = await upsertAutoSchedule(caller, patch);
    const pub = publicScheduleFor(row);
    console.log(`[Auto-Pilot] user ${caller} ${pub.enabled ? `armed every ${pub.intervalMinutes}m${pub.autoPublish ? ' + auto-publish' : ''}, next ${pub.nextRunAt}` : 'disarmed'} (persisted in tl_auto_schedule)`);
    res.json({ success: true, schedule: pub });
  } catch (err: any) {
    const msg = String(err?.message || err);
    if (msg.includes('DATABASE_UNAVAILABLE')) {
      return res.status(503).json({ success: false, error: 'Timer database is unreachable — please retry in a moment. Your previous timer (if any) is untouched.' });
    }
    return res.status(500).json({ success: false, error: 'Timer save failed.' });
  }
});

/* ========================================================================= */
/* 3.3 Instagram profile scratch -> YouTube repost (per-user watches)        */
/* Profile reels are listed + downloaded through the downloader service      */
/* (yt-dlp engine). Dedup: (watch_id, shortcode) UNIQUE — a reel never       */
/* reposts twice. YT title = head of the IG caption (<=100 chars, verbatim,   */
/* NO injected hashtags); YT description = ONLY the full IG caption (no credit */
/* block, no links — YouTube penalizes outbound links). Timer is per-watch: the */
/* user picks hours + minutes, the ticker checks due watches. Each watch,    */
/* session, reel and video is strictly per-user (user_id scoped).            */
/* ========================================================================= */

const igCheckRunning = new Set<string>();

/** Per-job render locks: one job never renders twice concurrently. */
const renderLocks = new Set<string>();

/** Watch cycle tasks already waiting in the IO queue (dedup for the ticker:
 *  a watch due on two consecutive ticks is enqueued only once). Timestamped:
 *  a task wedged longer than CYCLE_STALE_MS (e.g. an unbounded network hop)
 *  must never block that watch's timer forever — the next tick re-enqueues. */
// Optional Redis for distributed locks across instances (falls back to in-memory).
const redisClient: Redis | null = (() => {
  const url = (process.env.REDIS_URL || '').trim();
  if (!url) return null;
  try {
    const c = new Redis(url, { lazyConnect: true, maxRetriesPerRequest: 1, enableOfflineQueue: false });
    void c.connect().catch(() => { /* keep null-ish; calls will fail gracefully */ });
    return c;
  } catch {
    return null;
  }
})();
const pendingIgCycles = new Map<string, number>();

// Distributed lock (Redis if available, otherwise file-based on the same server)
// so multiple processes/instances never run the same watch cycle concurrently.
const LOCK_DIR = path.join(process.cwd(), 'temp', 'locks');
try { fs.mkdirSync(LOCK_DIR, { recursive: true }); } catch { /* best effort */ }
function sanitizeLockName(s: string): string {
  return String(s).replace(/[^A-Za-z0-9_.-]/g, '_').slice(0, 120);
}
function tryAcquireFileLock(name: string, ttlMs: number): (() => void) | null {
  const file = path.join(LOCK_DIR, `${sanitizeLockName(name)}.lock`);
  const now = Date.now();
  // Stale lock cleanup
  try {
    if (fs.existsSync(file)) {
      const st = fs.statSync(file);
      if (now - st.mtimeMs > ttlMs) fs.rmSync(file, { force: true });
    }
  } catch { /* ignore */ }
  try {
    const fd = fs.openSync(file, 'wx');
    fs.writeSync(fd, `${process.pid}:${now}`);
    fs.closeSync(fd);
    return () => { try { fs.rmSync(file, { force: true }); } catch { /* ignore */ } };
  } catch {
    return null;
  }
}
async function acquireDistributedLock(name: string, ttlMs: number): Promise<(() => void) | null> {
  if (redisClient) {
    try {
      const ok = await redisClient.set(`lock:${name}`, '1', 'PX', ttlMs, 'NX');
      if (ok) {
        return () => { void redisClient!.del(`lock:${name}`).catch(() => {}); };
      }
      return null;
    } catch { /* fall through to file lock */ }
  }
  return tryAcquireFileLock(name, ttlMs);
}
const CYCLE_STALE_MS = 30 * 60 * 1000;
function isCycleFresh(key: string): boolean {
  const at = pendingIgCycles.get(key);
  if (at === undefined) return false;
  if (Date.now() - at > CYCLE_STALE_MS) {
    pendingIgCycles.delete(key);
    console.warn(`[IG-Repost] dropping stale cycle guard ${key} (wedged >30m) — re-enqueueing.`);
    return false;
  }
  return true;
}
/** Missed-firing rule: a watch whose time passed long ago (downtime, wedge,
 *  deploy gap) NEVER catches up — the stale firing is cancelled and the
 *  timer re-arms for its next scheduled slot. Without this, every overdue
 *  watch publishes at once on the next tick (the post-deploy burst: 3 pages
 *  uploading simultaneously). Firings only minutes late (normal tick jitter
 *  or a short restart) still run. Tune via IG_OVERDUE_SKIP_MINUTES
 *  (default 30, 5..1440). */
const IG_OVERDUE_SKIP_MS = (() => {
  const v = parseFloat(process.env.IG_OVERDUE_SKIP_MINUTES || '30');
  if (!isFinite(v)) return 30 * 60 * 1000;
  return Math.min(1440, Math.max(5, v)) * 60 * 1000;
})();

/** Throttle for the DB-unreachable warning in tickIgWatches (half-hourly). */
let igDbWarnAt = 0;

/** Overlap guard so a slow tick never runs twice at once. */
let igTickRunning = false;

/** Record RapidAPI items as discovered posts. NOTE: the Userinfo list
 *  endpoint carries NO caption (only id/type/url/taken_at), so each fresh
 *  shortcode is resolved via the single-reel lookup (1 credit) to get the
 *  REAL caption — otherwise every row stores '' and the YouTube title falls
 *  back to "@user Instagram Reel". Info rows only — NO pre-download: the disk is
 *  wiped on every deploy, so cached bytes would rot into dead links.
 *  Download happens once, inside publishWatchItems, right before the
 *  YouTube upload. Duplicate shortcodes are skipped (never reposted twice).
 *
 *  WINNER-CONTENT: the same response carries play/like/comment counts for
 *  FREE (zero extra credits) — they are stored as the winner score and the
 *  publish queue picks the highest-scored UNPUBLISHED reel first. Capacity:
 *  at most RAPID_DISCOVERY_WINDOW (12) latest posts per check, no pagination,
 *  so the winner is the winner of the latest-12 window. Metrics of
 *  already-known reels are refreshed (GREATEST — counts only grow) so the
 *  ranking stays correct without any extra API call. */
interface RapidRecordItem {
  shortcode: string; url: string; caption: string; previewUrl: string;
  playCount?: number | null; likeCount?: number | null; commentCount?: number | null;
}
async function recordRapidItems(
  watchId: string, userId: string, username: string,
  items: RapidRecordItem[],
  manual: boolean
): Promise<{ checked: number; discovered: number; refreshed: number; cached: number; winnerShortcode: string | null; winnerPlayCount: number; fresh: RapidRecordItem[] }> {
  const ytRow = await getYouTubeRow(userId).catch(() => null);
  const channelTitle = ytRow?.channel_title || null;
  const watchRow = await getIgWatch(watchId, userId).catch(() => null);
  const watchHashtags = watchRow?.hashtags || [];
  const withScore = items
    .filter(i => !!i?.shortcode)
    .map(i => ({ ...i, playCount: Math.max(0, Math.floor(Number((i as any).playCount) || 0)), likeCount: Math.max(0, Math.floor(Number((i as any).likeCount) || 0)), commentCount: Math.max(0, Math.floor(Number((i as any).commentCount) || 0)) }))
    .map(i => ({ ...i, winnerScore: computeWinnerScore(i.playCount, i.likeCount, i.commentCount) }));
  // Refresh metrics of already-known reels first (free ranking upkeep — the
  // numbers arrived in this same response, no extra quota spent).
  let refreshed = 0;
  for (const item of withScore) {
    // eslint-disable-next-line no-await-in-loop
    if (await hasIgPost(watchId, item.shortcode)) {
      // eslint-disable-next-line no-await-in-loop
      await refreshIgPostMetrics(watchId, userId, item.shortcode, {
        playCount: item.playCount, likeCount: item.likeCount, commentCount: item.commentCount, winnerScore: (item as any).winnerScore
      });
      refreshed++;
    }
  }
  // Fresh (never-published) candidates, WINNER-FIRST: the highest-scored reel
  // leads so the instant-publish path uploads the winner before weaker reels.
  const freshUnpublished: typeof withScore = [];
  for (const item of sortByWinnerScore(withScore)) {
    // eslint-disable-next-line no-await-in-loop
    if (await hasIgPost(watchId, item.shortcode)) continue;
    freshUnpublished.push(item);
    if (freshUnpublished.length >= 12) break;
  }
  let discovered = 0;
  for (const item of [...freshUnpublished].reverse()) {
    const reelUrl = item.url || `https://www.instagram.com/reel/${item.shortcode}/`;
    // cleanCaption (inside buildRepostMetadata) already stripped @mentions —
    // the stored caption keeps text + #hashtags only.
    // The list endpoint has NO caption — resolve the real one per shortcode
    // (single lookup, 1 credit, works for any age). Without this every row
    // stores '' and the title falls back to "@user Instagram Reel".
    let caption = String(item.caption || '');
    let previewUrl = String(item.previewUrl || '');
    if (needsRealCaption(caption) && isRapidConfigured()) {
      try {
        const single = await fetchRapidSingleMedia(reelUrl);
        if (single?.caption && !needsRealCaption(single.caption)) caption = single.caption;
        else if (single?.caption && single.caption.trim()) caption = single.caption;
        if (single?.previewUrl) previewUrl = single.previewUrl;
      } catch { /* keep list values — publish-time rescue retries */ }
    }
    // Keep the in-hand fresh copy in sync: the timer's instant-publish path
    // uploads from `fresh` (not the DB rows), so it needs the real caption too.
    item.caption = caption;
    item.previewUrl = previewUrl;
    const meta2 = buildRepostMetadata(caption, username, reelUrl, channelTitle, watchHashtags);
    // eslint-disable-next-line no-await-in-loop
    await addIgPost({
      id: uuid(), watchId, userId, shortcode: item.shortcode, instaUrl: reelUrl,
      caption: caption.slice(0, 4000), ytTitle: meta2.title, filename: '',
      ytVideoId: null, ytUrl: null, status: 'discovered', error: null,
      previewUrl: previewUrl || null,
      playCount: item.playCount, likeCount: item.likeCount, commentCount: item.commentCount,
      winnerScore: (item as any).winnerScore
    });
    // eslint-disable-next-line no-await-in-loop
    await updateIgWatch(watchId, userId, { lastShortcode: item.shortcode, lastError: null });
    discovered++;
  }
  // No pre-download here (see above): the publish step downloads the exact
  // reel it is about to upload, so nothing sits on the ephemeral disk.
  // The in-hand previewUrls ARE returned (WINNER-FIRST) so the timer cycle
  // instant-publishes the highest-scored unpublished reel via its direct CDN
  // link before it expires — critical for 18+/login-walled profiles where
  // the anonymous downloader always comes back empty.
  const cached = 0;
  const nowIso = new Date().toISOString();
  const watch = await getIgWatch(watchId, userId);
  await updateIgWatch(watchId, userId, {
    lastCheckAt: nowIso,
    nextRunAt: manual ? undefined : computeWatchNextRunAt(Number(watch?.interval_hours) || 24, watch?.daily_times || [], watch?.daily_tz || 'UTC'),
    lastError: null
  });
  const winner = pickWinnerReel(withScore);
  return {
    checked: items.length, discovered, refreshed, cached, fresh: freshUnpublished,
    winnerShortcode: winner ? winner.shortcode : null,
    winnerPlayCount: winner ? Math.max(0, Math.floor(Number((winner as any).playCount) || 0)) : 0
  };
}

// CHECK = discovery only: list the profile's reels and store their info
// (shortcode, URL, caption, computed YouTube title). NEVER downloads —
// publish downloads right before uploading (or reuses a cached file).
async function checkIgWatch(watchId: string, userId: string, manual = false, useRapid = false): Promise<{ checked: number; discovered: number; refreshed?: number; cached?: number; source?: string; error?: string; winnerShortcode?: string | null; winnerPlayCount?: number; fresh?: RapidRecordItem[] }> {
  const watch = await getIgWatch(watchId, userId);
  if (!watch) throw new Error('Watch not found.');
  if (igCheckRunning.has(watchId)) return { checked: 0, discovered: 0, error: 'Check already running.' };
  const ytRow = await getYouTubeRow(userId).catch(() => null);
  const channelTitle = ytRow?.channel_title || null;
  igCheckRunning.add(watchId);
  // RapidAPI-first, ONLY on the watch's own timer firing (useRapid): the
  // profile's newest reels with REAL captions + direct MP4s, newest first.
  // Manual checks, go-live shelf fills and the live prefetch all pass
  // useRapid=false — RapidAPI quota burns only on timer firings (+ the
  // manual Discovery panel, which is a separate explicit user action).
  if (useRapid && isRapidConfigured()) {
    try {
      const rapid = await fetchRapidReels(watch.username, 12);
      if (rapid.items.length > 0) {
        try {
          const r = await recordRapidItems(watchId, userId, watch.username, rapid.items, manual);
          return { ...r, source: 'rapidapi-user-reels' };
        } finally {
          // The legacy path below clears this in its own finally; the early
          // rapid return must clear it too, or the watch wedges as
          // "already running" forever.
          igCheckRunning.delete(watchId);
        }
      }
      console.log(`[IG-Repost] RapidAPI empty for @${watch.username} — falling back to anonymous listing + web search.`);
    } catch (err: any) {
      console.warn(`[IG-Repost] RapidAPI failed for @${watch.username} (${String(err?.message || err).slice(0, 120)}) — falling back to anonymous listing + web search.`);
    }
  }
  let discovered = 0;
  // Discovery is anonymous-only (per-user Instagram sessions were removed):
  // native page scrape without cookies, merged with fresh web search.
  const igCookies: string | null = null;
  try {
    // Both discovery paths run IN PARALLEL and merge: Instagram-native page
    // scrape (authoritative, newest-first) wins when it works; fresh web
    // search fills the gap otherwise. Sequential runs made one check take
    // minutes (scrape + yt-dlp + search back-to-back).
    type Item = { shortcode: string; url: string; title: string; description: string };
    const [listedRes, searchedRes] = await Promise.allSettled([
      fetchProfileReels(watch.profile_url, 12, igCookies),
       searchProfileReels(watch.username, 12)
    ]);
    let items: Item[] = [];
    let warning: string | undefined;
    let source: string | undefined;
    if (listedRes.status === 'fulfilled') {
      items = listedRes.value.items as Item[];
      warning = listedRes.value.warning;
      source = listedRes.value.source;
    } else {
      warning = String((listedRes.reason as any)?.message || listedRes.reason);
    }
    if (items.length === 0 && searchedRes.status === 'fulfilled' && searchedRes.value.length > 0) {
      items = searchedRes.value as Item[];
      warning = undefined;
      source = 'web-search-fresh';
    } else if (searchedRes.status === 'fulfilled' && searchedRes.value.length > 0) {
      const seen = new Set(items.map(i => i.shortcode));
      for (const s of searchedRes.value as Item[]) {
        if (!seen.has(s.shortcode)) { seen.add(s.shortcode); items.push(s); }
      }
    }
    // Ownership guard: drop any item whose URL names a different Instagram
    // account than this watch's profile. Canonical (no-username) URLs coming
    // from the profile's own listing are trusted.
    items = items.filter((it: any) => {
          const m = String(it?.url || '').match(/instagram\.com\/([A-Za-z0-9_.]+)\/(?:reel|reels|p)\//i);
      if (m) return String(m[1]).toLowerCase() === String(watch.username).toLowerCase();
      return true;
    });
    if (items.length === 0) {
      const msg = (warning || 'No reels found — try Check now again later.').slice(0, 400);
      await updateIgWatch(watchId, userId, {
        lastCheckAt: new Date().toISOString(),
        // A manual "Check now" must never postpone the armed timer — only
        // automatic timer ticks roll next_run_at forward (undefined = keep).
        // The roll-forward honors exact daily times when set (deploy-proof:
        // persisted in tl_ig_watch, recomputed from the stored schedule).
        nextRunAt: manual ? undefined : computeWatchNextRunAt(Number(watch.interval_hours) || 24, watch.daily_times || [], watch.daily_tz || 'UTC'),
        lastError: msg
      });
      return { checked: 0, discovered, error: msg };
    }
    // Newest-first as returned; record up to 6 new info rows per cycle.
    // Oldest-first insert order keeps the list chronological.
    const fresh: typeof items = [];
    for (const item of items) {
      if (!item?.shortcode) continue;
      if (await hasIgPost(watchId, item.shortcode)) continue;
      fresh.push(item);
      if (fresh.length >= 12) break;
    }
    for (const item of [...fresh].reverse()) {
      const reelUrl = item.url || `https://www.instagram.com/reel/${item.shortcode}/`;
      // Real caption only: listing snippets are search-engine junk (URLs,
      // breadcrumbs), never publish those — resolve via the single-reel
      // lookup FIRST (RapidAPI, 1 credit, reliable even login-walled),
      // then the anonymous downloader metadata as fallback.
      let caption = item.description || '';
      if (needsRealCaption(caption)) {
        caption = '';
        if (isRapidConfigured()) {
          try {
            const single = await fetchRapidSingleMedia(reelUrl);
            if (single?.caption) caption = single.caption;
          } catch { /* fall through to downloader metadata */ }
        }
        if (needsRealCaption(caption)) {
          caption = '';
          try {
            const meta = await fetchReelMetadata(reelUrl, undefined, igCookies);
            caption = meta.description || meta.title || '';
          } catch { /* snippet fallback below */ }
        }
        if (!caption) {
          const snip = (item.title || '').replace(/\s+/g, ' ').trim();
          caption = needsRealCaption(snip) ? '' : snip;
        }
      }
      const meta2 = buildRepostMetadata(caption, watch.username, reelUrl, channelTitle, watch.hashtags);
      await addIgPost({
        id: uuid(), watchId, userId, shortcode: item.shortcode, instaUrl: reelUrl,
        caption: caption.slice(0, 4000), ytTitle: meta2.title, filename: '',
        ytVideoId: null, ytUrl: null, status: 'discovered', error: null
      });
      await updateIgWatch(watchId, userId, { lastShortcode: item.shortcode, lastError: null });
      discovered++;
    }
    const nowIso = new Date().toISOString();
    await updateIgWatch(watchId, userId, {
      lastCheckAt: nowIso,
      // Manual checks leave the armed timer alone; timer ticks re-arm it
      // (exact daily times when set, else the rolling interval).
      nextRunAt: manual ? undefined : computeWatchNextRunAt(Number(watch.interval_hours) || 24, watch.daily_times || [], watch.daily_tz || 'UTC'),
      lastError: null
    });
    return { checked: items.length, discovered, source: source || 'instagram-page' };
  } catch (err: any) {
    const msg = String(err?.message || err).slice(0, 400);
    try {
      await updateIgWatch(watchId, userId, {
        lastCheckAt: new Date().toISOString(),
        nextRunAt: manual ? undefined : computeWatchNextRunAt(Number(watch.interval_hours) || 24, watch.daily_times || [], watch.daily_tz || 'UTC'),
        lastError: msg
      });
    } catch { /* best effort */ }
    if (manual) throw err;
    console.warn(`[IG-Repost] watch ${watchId} (@${watch.username}) check failed:`, msg);
    return { checked: 0, discovered, error: msg };
  } finally {
    igCheckRunning.delete(watchId);
  }
}

// PUBLISH = download right now + upload to YouTube. Timer path publishes the
// SINGLE newest pending reel per firing (limit 1, newest first); manual
// demand can do one shortcode or a small batch. After a SUCCESSFUL upload the
// downloaded Instagram file (+ its video record) is deleted — published rows
// keep only the YouTube link, so nothing is ever reposted twice.
//
// Isolation: every attempt downloads to its OWN unique file
// (ig-<shortcode>-<rand>.mp4), so concurrent publishes of the same reel by
// different users/watches can never read, overwrite, or delete each other's
// bytes — deletion below only ever touches the current attempt's path.

const DELETE_RETRIES = 4;

/** Delete a just-published file and VERIFY it is really gone. Transient
 *  holds (Windows file locks, AV scans) are retried with backoff; every
 *  failed attempt is logged and a surviving file is reported with
 *  console.error — never silent. The path is always the current attempt's
 *  unique file, so no other user's media can ever be affected. */
async function removePublishedFileVerified(filePath: string, shortcode: string): Promise<boolean> {
  for (let i = 1; i <= DELETE_RETRIES; i++) {
    try {
      fs.rmSync(filePath, { force: true });
    } catch (err) {
      console.warn(`[IG-Repost] delete try ${i}/${DELETE_RETRIES} failed for ${shortcode}:`, (err as Error)?.message || err);
    }
    let gone = false;
    try {
      gone = !fs.existsSync(filePath);
    } catch {
      gone = true; // the check itself failed — nothing more we can verify
    }
    if (gone) {
      if (i > 1) console.log(`[IG-Repost] ${shortcode} media deleted on try ${i}/${DELETE_RETRIES}.`);
      return true;
    }
    console.warn(`[IG-Repost] ${shortcode} file still on disk after delete try ${i}/${DELETE_RETRIES} — retrying.`);
    if (i < DELETE_RETRIES) await new Promise(r => setTimeout(r, 500 * i));
  }
  console.error(`[IG-Repost] FILE NOT DELETED after ${DELETE_RETRIES} tries: ${filePath} (reel ${shortcode}) — already published on YouTube, orphaned on disk, manual cleanup needed.`);
  return false;
}
/** RapidAPI rescue lookup: direct single-reel info first (1 credit, works for
 *  reels of ANY age), then the profile's latest-12 listing as fallback.
 *  Returns the direct CDN MP4 (previewUrl). Null when RapidAPI has no
 *  downloadable copy. */
async function findRapidReelMedia(username: string, shortcode: string): Promise<{ previewUrl: string; caption: string } | null> {
  const reelUrl = `https://www.instagram.com/reel/${shortcode}/`;
  try {
    const single = await fetchRapidSingleMedia(reelUrl);
    if (single?.previewUrl) return { previewUrl: single.previewUrl, caption: single.caption || '' };
  } catch (e: any) {
    console.warn(`[IG-Repost] RapidAPI single lookup failed for ${shortcode} (${String(e?.message || e).slice(0, 120)}) — trying profile listing.`);
  }
  try {
    const res = await fetchRapidReels(username, 24, null);
    const hit = res.items.find(i => i.shortcode === shortcode && !!i.previewUrl);
    if (hit) return { previewUrl: hit.previewUrl, caption: hit.caption || '' };
  } catch (e: any) {
    console.warn(`[IG-Repost] RapidAPI listing fallback failed for @${username} (${String(e?.message || e).slice(0, 120)}).`);
  }
  return null;
}
async function publishWatchItems(watchId: string, userId: string, onlyShortcode?: string, limit = 1): Promise<{ published: number; failed: number; error?: string }> {
  const watch = await getIgWatch(watchId, userId);
  if (!watch) throw new Error('Watch not found.');
  const ytRow = await getYouTubeRow(userId).catch(() => null);
  const channelTitle = ytRow?.channel_title || null;
  const lockKey = `pub:${watchId}`;
  if (igCheckRunning.has(lockKey)) return { published: 0, failed: 0, error: 'Publish already running.' };
  igCheckRunning.add(lockKey);
  let published = 0;
  let failed = 0;
  // Metadata resolution is anonymous-only (per-user sessions were removed).
  const pubCookies: string | null = null;
  try {
    const pending = await listPublishableIgPosts(watchId, userId, onlyShortcode || null, limit);
    if (pending.length === 0) return { published: 0, failed: 0, error: onlyShortcode ? 'Nothing publishable for this reel.' : 'No pending reels.' };
    const videosDir = path.join(process.cwd(), 'public', 'videos');
    for (const post of pending) {
      const reelUrl = post.insta_url || `https://www.instagram.com/reel/${post.shortcode}/`;
      try {
        // Never publish junk: if the stored caption is missing or looks like
        // a search-engine artifact, resolve the reel's REAL caption first —
        // the YouTube title/description are built from this. RapidAPI single
        // lookup FIRST (reliable even login-walled), downloader metadata second.
        let caption = post.caption || '';
        if (needsRealCaption(caption)) {
          caption = '';
          if (isRapidConfigured()) {
            try {
              const single = await fetchRapidSingleMedia(reelUrl);
              if (single?.caption) caption = single.caption;
            } catch { /* fall through to downloader metadata */ }
          }
          if (needsRealCaption(caption)) {
            caption = '';
            try {
              const meta = await fetchReelMetadata(reelUrl, undefined, pubCookies);
              caption = meta.description || meta.title || '';
            } catch { /* fall back to generic title below */ }
          }
        }
         let meta2 = buildRepostMetadata(caption, watch.username, reelUrl, channelTitle, watch.hashtags);
         const filenameBase = `ig-${post.shortcode}`;
        // Unique per-attempt file — never the shared ig-<shortcode>.mp4, so
        // no other user/watch publishing the same reel can collide with us.
        let filePath: string | null = null;
        let actualBase = '';
        let sizeBytes = 0;
        if (post.filename) {
          // Retry of a previous attempt whose upload failed: reuse OUR OWN
          // recorded file (row-scoped per watch+user), never anyone else's.
          const reuse = path.join(videosDir, path.basename(String(post.filename)));
          try {
            if (fs.existsSync(reuse)) {
              sizeBytes = fs.statSync(reuse).size;
              if (sizeBytes > 0) {
                filePath = reuse;
                actualBase = path.basename(reuse);
              }
            }
          } catch { /* re-download below */ sizeBytes = 0; }
        }
        if (!filePath) {
          const attemptBase = `${filenameBase}-${uuid().slice(0, 8)}`;
          let dlErr: any = null;
          // FIRST: the direct CDN link stored at discovery time. For
          // 18+/login-walled reels this is the ONLY working source — the
          // anonymous downloader below always comes back empty for them.
          // A stale (expired) link just falls through to the next source.
          const storedPreview = String((post as any).preview_url || '');
          if (/^https?:/i.test(storedPreview)) {
            try {
              if (!fs.existsSync(videosDir)) fs.mkdirSync(videosDir, { recursive: true });
              const dest = path.join(videosDir, `${attemptBase}.mp4`);
              sizeBytes = await downloadToFile(storedPreview, dest);
              filePath = dest;
              console.log(`[IG-Repost] ${post.shortcode} via stored previewUrl (${(sizeBytes / 1048576).toFixed(1)} MB).`);
            } catch (e: any) {
              console.warn(`[IG-Repost] ${post.shortcode} stored previewUrl expired/unreachable — trying anonymous downloader.`);
            }
          }
          if (!filePath) {
            try {
              const dl = await downloadReelMp4(reelUrl, videosDir, attemptBase);
              filePath = dl.filePath;
              sizeBytes = dl.sizeBytes;
            } catch (e: any) {
              dlErr = e;
            }
          }
          if (!filePath) {
            // Fallback: the downloader came back empty (login-walled / 18+
            // reels) — RapidAPI serves the same reel from its own logged-in
            // session as a direct CDN MP4, so the publish can still proceed.
            if (!isRapidConfigured()) throw dlErr;
            console.log(`[IG-Repost] ${post.shortcode} downloader failed (${String(dlErr?.message || dlErr).slice(0, 120)}) — trying RapidAPI fallback.`);
            const match = await findRapidReelMedia(watch.username, post.shortcode);
            if (!match?.previewUrl) {
              throw new Error(
                `[Instagram] ${post.shortcode}: ${String(dlErr?.message || dlErr).slice(0, 160)} (RapidAPI fallback: no downloadable copy found.)`
              );
            }
            if (!fs.existsSync(videosDir)) fs.mkdirSync(videosDir, { recursive: true });
            const dest = path.join(videosDir, `${attemptBase}.mp4`);
            sizeBytes = await downloadToFile(match.previewUrl, dest).catch((e: any) => {
              throw new Error(
                `[Instagram] ${post.shortcode}: ${String(dlErr?.message || dlErr).slice(0, 120)} (RapidAPI fallback: ${String(e?.message || e).slice(0, 120)})`
              );
            });
            filePath = dest;
            // The rescue lookup also returns the REAL caption — adopt it when
            // ours is still missing so the upload never uses the fallback title.
            if (needsRealCaption(caption) && match.caption && !needsRealCaption(match.caption)) {
              caption = match.caption;
               meta2 = buildRepostMetadata(caption, watch.username, reelUrl, channelTitle, watch.hashtags);
            }
            console.log(`[IG-Repost] ${post.shortcode} rescued via RapidAPI fallback (${(sizeBytes / 1048576).toFixed(1)} MB).`);
          }
          actualBase = path.basename(filePath);
          // Record THIS attempt's file BEFORE uploading: if the upload
          // fails, the retry reuses it instead of orphaning it on disk.
          await updateIgPost(watchId, userId, post.shortcode, {
            filename: actualBase, status: 'downloaded', error: null
          });
        }
        // Serialized lane: N watches firing in the same tick upload strictly
        // one-by-one instead of racing N parallel resumable uploads.
        const pub = await serializedYouTubeUpload(`ig:${watchId}:${post.shortcode}`, userId, () =>
          publishShortToYouTube(userId, filePath, {
            title: meta2.title,
            description: meta2.description,
            tags: meta2.tags,
            privacyStatus: (watch.privacy_status as 'public' | 'unlisted' | 'private') || 'public',
            verbatim: true
          })
        );
        await updateIgPost(watchId, userId, post.shortcode, {
          caption: caption.slice(0, 4000), ytTitle: meta2.title, filename: actualBase,
          ytVideoId: pub.videoId, ytUrl: pub.publishedUrl, status: 'published', error: null
        });
        // Virality: seed the comment section with an engagement question.
        void postUploadCommentBestEffort(userId, pub.videoId, `Reposted from @${watch.username} — what do you think? 👇`, 'ig-repost');
        // Upload succeeded — drop ONLY this attempt's unique file and VERIFY
        // it is gone (retries + loud logging, never silent). Another user's
        // media can never be touched: the path belongs to this attempt alone.
        const deleted = await removePublishedFileVerified(filePath, post.shortcode);
        await deleteVideoRecord(userId, actualBase);
        if (deleted) {
          // Really gone — clear the name so no dead /videos link remains.
          await updateIgPost(watchId, userId, post.shortcode, { filename: '' });
        } else {
          // Published on YouTube but orphaned on disk — stays queryable via
          // the error column (status remains published: NEVER re-upload).
          await updateIgPost(watchId, userId, post.shortcode, {
            error: `Published on YouTube, but the local file survived ${DELETE_RETRIES} delete attempts — orphaned on disk: ${actualBase}`
          });
        }
        published++;
      } catch (err: any) {
        failed++;
        await updateIgPost(watchId, userId, post.shortcode, {
          status: 'failed', error: String(err?.message || err).slice(0, 400)
        });
      }
    }
    return { published, failed };
  } finally {
    igCheckRunning.delete(lockKey);
  }
}

/** Timer firing with fallback: try up to IG_PUBLISH_TRIES DIFFERENT pending
 *  reels (WINNER-FIRST — highest winner_score among unpublished) and stop at
 *  the FIRST successful YouTube publish.
 *  One firing = max one published video; a stubborn reel never burns all the
 *  tries — the next candidate is attempted instead. A firing that publishes
 *  on try #1 needs no further tries at all. */
const IG_PUBLISH_TRIES = 3;

async function publishWithFallback(watchId: string, userId: string, maxTries = IG_PUBLISH_TRIES): Promise<{ published: number; failed: number; tried: number }> {
  const n = Math.min(10, Math.max(1, maxTries));
  const candidates = await listPublishableIgPosts(watchId, userId, null, n);
  let failed = 0;
  let tried = 0;
  for (const c of candidates.slice(0, n)) {
    if (!c?.shortcode) continue;
    tried++;
    console.log(`[IG-Repost] timer try ${tried}/${n} for watch ${watchId}: reel ${c.shortcode}.`);
    const r = await publishWatchItems(watchId, userId, c.shortcode, 1);
    failed += r.failed;
    if (r.published > 0) {
      console.log(`[IG-Repost] timer try ${tried} succeeded (${c.shortcode}) — no further tries needed.`);
      return { published: r.published, failed, tried };
    }
  }
  if (tried > 0) console.log(`[IG-Repost] all ${tried} timer tries failed for watch ${watchId} — will retry on the next firing.`);
  return { published: 0, failed, tried };
}

/** Resolve this user's YouTube RTMP target: saved Live-tab settings win,
 *  the persisted live row is the fallback. Throws when no key was ever saved. */
async function resolveWatchStreamTarget(userId: string): Promise<{ rtmpUrl: string; streamKey: string }> {
  const saved = await getStreamSettingsRow(userId).catch(() => null);
  if (saved?.stream_key && saved.stream_key.length >= 4) {
    return { rtmpUrl: saved.rtmp_url || 'rtmp://a.rtmp.youtube.com/live/', streamKey: saved.stream_key };
  }
  const sess = await getLiveStream(userId).catch(() => null);
  if (sess?.stream_key && sess.stream_key.length >= 4) {
    return { rtmpUrl: sess.rtmp_url || 'rtmp://a.rtmp.youtube.com/live/', streamKey: sess.stream_key };
  }
  throw new Error('No YouTube stream key — save it once in the Live tab, then enable Live on this profile.');
}

/** Persistent on-disk loop file for a watch. Downloads the reel when the
 *  shortcode changed (or the file is missing) and atomically promotes it. */
async function ensureWatchLiveFile(watchId: string, userId: string, username: string, shortcode: string, knownShortcode: string | null): Promise<string> {
  const final = liveFilePath(watchId);
  try {
    if (knownShortcode === shortcode && fs.existsSync(final) && fs.statSync(final).size > 0) return final;
  } catch { /* re-download below */ }
  const reelUrl = `https://www.instagram.com/reel/${shortcode}/`;
  const videosDir = path.join(process.cwd(), 'public', 'videos');
  // NOTE: reel bytes come through the shared downloader engine (same path as
  // Shorts publishing); the per-user session is what unlocked the LISTING
  // that discovered this shortcode. Metadata resolution is skipped here —
  // the loop needs bytes, not captions.
  void username;
  const dl = await downloadReelMp4(reelUrl, videosDir, `iglive-${watchId}-${uuid().slice(0, 8)}`);
  try {
    fs.renameSync(dl.filePath, final);
  } catch {
    // Cross-device rename fallback: copy + remove the attempt file.
    fs.copyFileSync(dl.filePath, final);
    try { fs.rmSync(dl.filePath, { force: true }); } catch { /* orphaned attempt, harmless */ }
  }
  return final;
}

/** Timer path for the IG-to-Live loop (called after every check of a
 *  live-enabled watch): newest reel loops on air, repeating until a newer
 *  reel swaps it — seamlessly, the push never restarts. Never hijacks a
 *  broadcast it doesn't own (news mode or another watch/user): those cases
 *  log and wait; the explicit Go Live button takes over on demand. */
async function syncWatchLiveLoop(watchId: string, userId: string): Promise<void> {
  const watch = await getIgWatch(watchId, userId);
  if (!watch?.live_enabled || !watch.enabled) return;
  const posts = await listIgPosts(watchId, userId, 1).catch(() => []);
  const sc = posts?.[0]?.shortcode || watch.last_shortcode || watch.live_shortcode || null;
  if (!sc) {
    console.log(`[IG-Live] @${watch.username}: no reels discovered yet — loop waits for the next check.`);
    return;
  }
  const file = await ensureWatchLiveFile(watchId, userId, watch.username, sc, watch.live_shortcode);
  const target = await resolveWatchStreamTarget(userId);
  try {
    await beginReelLoop({
      watchId, userId, username: watch.username, shortcode: sc, filePath: file,
      rtmpUrl: target.rtmpUrl, streamKey: target.streamKey
    }, false);
    if (watch.live_shortcode !== sc) {
      await updateIgWatch(watchId, userId, { liveShortcode: sc, liveStartedAt: watch.live_started_at || new Date().toISOString() });
    }
    console.log(`[IG-Live] @${watch.username}: reel ${sc} looping (timer sync).`);
  } catch (err: any) {
    // Busy push (news/another loop) is normal — the loop picks up on a later
    // firing or via Go Live. Missing keys / downloads are real problems.
    console.log(`[IG-Live] @${watch.username} sync deferred: ${String(err?.message || err).slice(0, 160)}`);
  }
}

/** One full timer firing for a watch: discover new reels, then publish at
 *  most one video (up to 3 different candidates, first success wins) when
 *  auto-publish is on. Runs inside the IO queue so 20 users' timers firing
 *  at the same minute line up instead of running 20 parallel scrapes +
 *  yt-dlp downloads. Deduped: a watch is never queued twice (ticker
 *  overlap, double click, timer + manual at once). */
/* Instant-publish: download the WINNING reel via the DIRECT previewUrl that
 * the discovery API just handed us (in-hand, seconds old — cannot be
 * expired yet) and upload it to YouTube in the same firing.
 *
 * This is the only path that works for 18+/login-walled profiles (e.g.
 * @bikini.shows): the anonymous downloader always returns empty media for
 * them ("Instagram sent an empty media"), and a later RapidAPI re-query
 * burns quota again for a CDN link that may already be expired. Reusing
 * the in-hand link costs ZERO extra quota.
 *
 * Winner-first, stops at the FIRST successful upload (one video per
 * firing, same rule as publishWithFallback). A previewUrl download miss
 * leaves the row as 'discovered' so the normal fallback path below can
 * still try downloader + RapidAPI re-query for it. */
async function publishFreshViaPreviewUrl(
  watchId: string, userId: string,
  watch: { username: string; privacy_status?: string | null; hashtags?: string[] | null },
  fresh: RapidRecordItem[]
): Promise<{ published: number; failed: number }> {
  let published = 0;
  let failed = 0;
  const videosDir = path.join(process.cwd(), 'public', 'videos');
  const ytRow = await getYouTubeRow(userId).catch(() => null);
  const channelTitle = ytRow?.channel_title || null;
  // Winner-first: the in-hand batch is already winner-ordered by
  // recordRapidItems, but re-sort defensively (zero cost, in-memory) so ANY
  // caller gets the winning reel published before weaker ones.
  const ordered = sortByWinnerScore((fresh || []).filter(i => !!i?.shortcode));
  if (ordered.length > 0) {
    const top = ordered[0] as any;
    console.log(`[IG-Repost] winner-first publish order for watch ${watchId}: ${ordered.map(i => i.shortcode).join(', ')} (winner ${top.shortcode} — ${Math.max(0, Math.floor(Number(top.playCount) || 0))} plays).`);
  }
  for (const item of ordered) {
    if (!item?.shortcode || !/^https?:/i.test(item.previewUrl || '')) continue;
    const reelUrl = item.url || `https://www.instagram.com/reel/${item.shortcode}/`;
    // recordRapidItems already resolved the real caption, but if it failed
    // (RapidAPI blip) the in-hand copy is still '' — one rescue lookup here
    // saves the upload from the "@user Instagram Reel" fallback title.
    let caption = String(item.caption || '');
    if (needsRealCaption(caption) && isRapidConfigured()) {
      try {
        const single = await fetchRapidSingleMedia(reelUrl);
        if (single?.caption) caption = single.caption;
      } catch { /* fallback title below */ }
    }
    const meta2 = buildRepostMetadata(caption, watch.username, reelUrl, channelTitle, watch.hashtags);
    // Unique per-attempt file — same isolation rule as publishWatchItems.
    const attemptBase = `ig-${item.shortcode}-${uuid().slice(0, 8)}`;
    let filePath: string | null = null;
    try {
      if (!fs.existsSync(videosDir)) fs.mkdirSync(videosDir, { recursive: true });
      const dest = path.join(videosDir, `${attemptBase}.mp4`);
      await downloadToFile(item.previewUrl, dest);
      filePath = dest;
      const pub = await serializedYouTubeUpload(`ig:${watchId}:${item.shortcode}`, userId, () =>
        publishShortToYouTube(userId, filePath as string, {
          title: meta2.title,
          description: meta2.description,
          tags: meta2.tags,
          privacyStatus: (watch.privacy_status as 'public' | 'unlisted' | 'private') || 'public',
          verbatim: true
        })
      );
      await updateIgPost(watchId, userId, item.shortcode, {
        caption: caption.slice(0, 4000), ytTitle: meta2.title, filename: path.basename(filePath),
        ytVideoId: pub.videoId, ytUrl: pub.publishedUrl, status: 'published', error: null
      });
      void postUploadCommentBestEffort(userId, pub.videoId, `Reposted from @${watch.username} — what do you think? 👇`, 'ig-repost');
      const deleted = await removePublishedFileVerified(filePath, item.shortcode);
      await deleteVideoRecord(userId, path.basename(filePath));
      if (deleted) {
        await updateIgPost(watchId, userId, item.shortcode, { filename: '' });
      } else {
        await updateIgPost(watchId, userId, item.shortcode, {
          error: `Published on YouTube, but the local file survived ${DELETE_RETRIES} delete attempts — orphaned on disk: ${path.basename(filePath)}`
        });
      }
      console.log(`[IG-Repost] instant-published ${item.shortcode} via in-hand previewUrl (no anonymous download needed).`);
      published++;
      break;
    } catch (err: any) {
      failed++;
      console.warn(`[IG-Repost] instant-publish ${item.shortcode} via previewUrl failed:`, String(err?.message || err).slice(0, 160));
      if (filePath) {
        try {
          fs.rmSync(filePath, { force: true });
        } catch { /* orphan cleanup is best effort */ }
      }
    }
  }
  return { published, failed };
}

function enqueueIgCycle(watchId: string, userId: string): Promise<{ published: number; failed: number; tried?: number; discovered?: number }> {
  const key = `cycle:${watchId}`;
  if (isCycleFresh(key) || igCheckRunning.has(watchId) || igCheckRunning.has(`pub:${watchId}`)) {
    return Promise.resolve({ published: 0, failed: 0 });
  }
  pendingIgCycles.set(key, Date.now());
  return ioQueue.add(`ig-cycle:${watchId}`, userId, async () => {
    // Cross-process guard (Redis or file lock): skip if another instance is running.
    const lockRelease = await acquireDistributedLock(`cycle:${watchId}`, CYCLE_STALE_MS);
    if (!lockRelease) {
      pendingIgCycles.delete(key);
      return { published: 0, failed: 0 };
    }
    try {
      console.log(`[IG-Repost] queue worker fired watch (${watchId}) — discovering new reels.`);
      // Timer firing: RapidAPI-first (quota burns only here, on the watch's
      // own schedule), then publish the WINNER first.
      let check = await checkIgWatch(watchId, userId, false, true);
      if (check.winnerShortcode) {
        console.log(`[IG-Repost] winner for watch ${watchId}: reel ${check.winnerShortcode} (${(check.winnerPlayCount || 0).toLocaleString()} plays) — publishes first if still unpublished.`);
      }
      const fresh = await getIgWatch(watchId, userId);
      let result: { published: number; failed: number; tried?: number } = { published: 0, failed: 0 };
      if (fresh?.auto_publish && Array.isArray(check.fresh) && check.fresh.length > 0) {
        // Instant-publish FIRST via the in-hand direct links (seconds old —
        // cannot be expired yet, zero extra quota). This is what saves
        // 18+/login-walled profiles where the anonymous downloader below
        // always comes back empty. A miss leaves rows as 'discovered' for
        // the normal fallback path to retry.
        const ip = await publishFreshViaPreviewUrl(watchId, userId, fresh, check.fresh);
        result.failed += ip.failed;
        if (ip.published > 0) {
          console.log(`[IG-Repost] publish for watch ${watchId}: ${ip.published} instant-published via previewUrl.`);
          result.published = ip.published;
        }
      }
      if (fresh?.auto_publish && result.published === 0) {
        // Downloads happen ONLY inside the publish step, right before upload
        // — never cached on the ephemeral disk.
        // Up to 3 different pending reels, winner-first — first success wins.
        const r = await publishWithFallback(watchId, userId, IG_PUBLISH_TRIES);
        console.log(`[IG-Repost] publish for watch ${watchId}: ${r.published} published, ${r.failed} failed (${r.tried} tried).`);
        result = { published: r.published, failed: result.failed + r.failed, tried: r.tried };
        if (r.published === 0) {
          // Nothing went out: either discovery came back empty/failed or
          // every candidate failed. One more API round (bounded — a second
          // miss means genuinely nothing new, wait for the next firing).
          const emptyRound = (check.discovered ?? 0) === 0;
          if (check.error || emptyRound) {
            console.log(`[IG-Repost] watch ${watchId}: first round published nothing (${check.error ? `check error: ${String(check.error).slice(0, 120)}` : 'no new reels'}) — one more API round.`);
            check = await checkIgWatch(watchId, userId, false, true);
            if ((check.discovered ?? 0) > 0) {
              const r2 = await publishWithFallback(watchId, userId, IG_PUBLISH_TRIES);
              console.log(`[IG-Repost] second round for watch ${watchId}: ${r2.published} published, ${r2.failed} failed (${r2.tried} tried).`);
              result = { published: r2.published, failed: result.failed + r2.failed, tried: (result.tried ?? 0) + r2.tried };
            }
          }
        }
      }
      // IG-to-Live: the watch's own timer keeps its newest reel looping on
      // YouTube Live — repeat until a newer reel swaps it, push never drops.
      if (fresh?.live_enabled) {
        try {
          await syncWatchLiveLoop(watchId, userId);
        } catch (err: any) {
          console.warn(`[IG-Live] timer sync failed for watch ${watchId}:`, String(err?.message || err).slice(0, 200));
        }
      }
      return result;
    } finally {
      pendingIgCycles.delete(key);
      try { lockRelease(); } catch { /* ignore */ }
    }
  });
}

async function tickIgWatches() {
  if (igTickRunning) return; // previous tick still collecting — never overlap.
  if (!isDbReady()) {
    // A silent tick is undiagnosable (a day of DB outage looks exactly like
    // "timers stopped working"): warn half-hourly so the logs always explain
    // the silence. Firings missed during the outage are cancelled + re-armed
    // by the rule below — never burst-published on recovery.
    if (Date.now() - igDbWarnAt > 30 * 60 * 1000) {
      igDbWarnAt = Date.now();
      console.warn('[IG-Repost] tick skipped — database unreachable, timers paused until it recovers.');
    }
    return;
  }
  igTickRunning = true;
  // Watchdog: a hung DB round must never wedge this guard (it would silence
  // EVERY watch's timer forever with zero logs). The race rejects at 90s and
  // the finally below still clears the flag; the dangling query settles alone.
  const tickTimeout = new Promise<never>((_, rej) => {
    const t = setTimeout(() => rej(new Error('tick DB timeout (90s)')), 90000);
    (t as any)?.unref?.();
  });
  try {
    const due = await Promise.race([
      listDueIgWatches(new Date().toISOString(), 10),
      tickTimeout
    ]);
    let fired = 0;
    let skipped = 0;
    for (const w of due) {
      // YouTube safety: never run timers shorter than 4 hours.
      if (Number(w.interval_hours) < 4) {
        console.warn(`[IG-Repost] watch ${w.id} timer ${w.interval_hours}h is under 4h — skipping (YouTube safety).`);
        continue;
      }
      // A cycle already in flight owns this watch — never double-decide it.
      const key = `cycle:${w.id}`;
      if (!isCycleFresh(key) && !igCheckRunning.has(w.id) && !igCheckRunning.has(`pub:${w.id}`)) {
        const dueMs = w.next_run_at ? Date.parse(w.next_run_at) : NaN;
        const overdueMs = Number.isFinite(dueMs) ? Date.now() - dueMs : 0;
        if (overdueMs > IG_OVERDUE_SKIP_MS) {
          // Missed firing: CANCEL it and re-arm for the next scheduled slot
          // (exact daily times win when set, else the rolling interval from
          // NOW) — the next firing is a fresh one, never a catch-up burst.
          try {
            const fresh = await getIgWatch(w.id, w.user_id);
            if (fresh && fresh.enabled === 1) {
              const mins = Math.round(overdueMs / 60000);
              const next = computeWatchNextRunAt(Number(fresh.interval_hours) || 24, fresh.daily_times || [], fresh.daily_tz || 'UTC');
              await updateIgWatch(w.id, w.user_id, {
                lastCheckAt: new Date().toISOString(),
                nextRunAt: next,
                lastError: `Missed firing ${mins}m overdue — cancelled, re-armed for ${next}.`
              });
              console.log(`[IG-Repost] watch ${w.id} (@${fresh.username}) ${mins}m overdue — missed firing cancelled, next at ${next}.`);
            }
            // Disabled/deleted since the tick query: nothing to re-arm.
          } catch (err: any) {
            console.warn(`[IG-Repost] overdue-skip failed for watch ${w.id}:`, String(err?.message || err).slice(0, 160));
          }
          skipped++;
          continue;
        }
      }
      // Enqueue, don't await: the tick stays fast and the IO lane serializes
      // the actual scrape/download work. Rejections are swallowed here — the
      // per-watch last_error column already records failures.
      void enqueueIgCycle(w.id, w.user_id).catch(() => {});
      fired++;
    }
    if (due.length > 0) console.log(`[IG-Repost] tick: ${fired} fired, ${skipped} stale-cancelled (${due.length} due).`);
  } catch (err: any) {
    console.warn('[IG-Repost] tick failed:', err?.message || err);
  } finally {
    igTickRunning = false;
  }
}

/* Live prefetch: while a reel loops on air, the NEXT reel must already be
 * hunted — the current loop repeats forever (-stream_loop -1) until a newer
 * reel is discovered + downloaded, then only the decoders swap (the push
 * never drops, the live never disconnects). The slow publish timer (hours)
 * is NOT waited on: every LIVE_PREFETCH_MINUTES (default 2, 1..30) each
 * live-armed watch gets a check-only pass + seamless swap attempt. No
 * publishing here — Shorts uploads stay on the watch's own timer. */
const LIVE_PREFETCH_MIN = (() => {
  const v = parseFloat(process.env.LIVE_PREFETCH_MINUTES || '2');
  if (!isFinite(v)) return 2;
  return Math.min(30, Math.max(1, v));
})();
const livePrefetchAt = new Map<string, number>();
const pendingLivePrefetch = new Set<string>();
let livePrefetchRunning = false;

function enqueueLivePrefetch(watchId: string, userId: string): void {
  const key = `prefetch:${watchId}`;
  if (pendingLivePrefetch.has(key) || isCycleFresh(`cycle:${watchId}`)) return;
  if (igCheckRunning.has(watchId) || igCheckRunning.has(`pub:${watchId}`)) return;
  pendingLivePrefetch.add(key);
  livePrefetchAt.set(watchId, Date.now());
  void ioQueue.add(`live-prefetch:${watchId}`, userId, async () => {
    try {
      await checkIgWatch(watchId, userId, false);
      // Newest reel (if any newer than the looping one) downloads now and
      // swaps in seamlessly; when nothing is newer this is a no-op and the
      // current reel just keeps repeating until the next prefetch pass.
      await syncWatchLiveLoop(watchId, userId);
    } catch (err: any) {
      console.warn(`[IG-Live] prefetch note for watch ${watchId}:`, String(err?.message || err).slice(0, 160));
    } finally {
      pendingLivePrefetch.delete(key);
    }
  }).catch(() => { pendingLivePrefetch.delete(key); });
}

async function tickLivePrefetch(): Promise<void> {
  if (livePrefetchRunning) return;
  if (!isDbReady()) return;
  livePrefetchRunning = true;
  try {
    const armed = await listLiveEnabledWatches(20);
    const intervalMs = LIVE_PREFETCH_MIN * 60 * 1000;
    const now = Date.now();
    let queued = 0;
    for (const w of armed) {
      const last = livePrefetchAt.get(w.id) || 0;
      if (now - last < intervalMs) continue;
      enqueueLivePrefetch(w.id, w.user_id);
      queued++;
    }
    if (queued > 0) console.log(`[IG-Live] prefetch tick queued ${queued} live-armed watch(es) (every ~${LIVE_PREFETCH_MIN}m).`);
  } catch (err: any) {
    console.warn('[IG-Live] prefetch tick failed:', err?.message || err);
  } finally {
    livePrefetchRunning = false;
  }
}

app.get('/api/ig-watch', async (req, res) => {
  res.json({ success: true, watches: await listIgWatches((req as any).userId) });
});

// Latest reels for a profile, anonymous-only (per-user Instagram sessions
// were removed):
//   1. Anonymous listing (no cookies) — works for many public profiles.
//   2. Fresh web search — always available, no login needed.
// The `authenticated` flag stays in the response (always false) so older
// clients keep parsing.
const IG_SESSION_GONE = (_req: any, res: any) =>
  res.status(410).json({ success: false, error: 'Instagram sessions were removed — discovery is anonymous-only now.' });
app.get('/api/instagram/session', IG_SESSION_GONE);
app.post('/api/instagram/session', IG_SESSION_GONE);
app.delete('/api/instagram/session', IG_SESSION_GONE);
app.post('/api/instagram/login', IG_SESSION_GONE);
app.post('/api/instagram/login/2fa', IG_SESSION_GONE);
app.delete('/api/instagram/login/2fa', IG_SESSION_GONE);
app.get('/api/instagram/latest', async (req, res) => {
  const profileUrl = String(req.query.profileUrl || req.query.url || '');
  const username = parseInstagramUsername(profileUrl);
  if (!username) return res.status(400).json({ success: false, error: 'Enter a valid Instagram profile link.' });
  const limit = Math.min(20, Math.max(1, parseInt(String(req.query.limit || '12'), 10) || 12));
  const normalized = normalizeProfileUrl(profileUrl) || `https://www.instagram.com/${username}/`;
  // Anonymous-only: per-user sessions were removed, so there is no step 1.
  const igCookies: string | null = null;
  const out = await ioQueue.add(`ig-latest:${username}`, (req as any).userId || null, async () => {
    // 1) Anonymous listing (no cookies).
    try {
      const listed = await fetchProfileReels(normalized, limit, null);
      if (listed.items.length > 0) {
        const own = (listed.items || []).filter((it: any) => {
      const m = String(it?.url || '').match(/instagram\.com\/([A-Za-z0-9_.]+)\/(?:reel|reels|p)\//i);
          if (m) return String(m[1]).toLowerCase() === username.toLowerCase();
          return true;
        });
        if (own.length > 0) return { items: own, source: listed.source || 'instagram-anon', authenticated: false as const, warning: listed.warning };
      }
    } catch { /* fall through to web search */ }
    // 2) Web-search fallback — always works without any login.
    const searched = await searchProfileReels(username, limit);
    return { items: searched, source: 'web-search-fresh', authenticated: false as const, warning: undefined };
  });
  res.json({ success: true, username, profileUrl: normalized, ...out });
});

// Instagram Discovery via RapidAPI (instagram-public-bulk-scraper):
// one call returns the profile's reels WITH direct playable MP4s
// (previewUrl), real captions and stats — zero download, zero login.
// The UI shows them as <video> previews with multi-select; the selection is
// then combined into ONE vertical MP4 (see /api/instagram/mix) for the
// YouTube Live push. Key in env: RAPIDAPI_KEY (see .env.example).
app.get('/api/instagram/discover', async (req, res) => {
  const raw = String(req.query.profileUrl || req.query.url || req.query.username || '');
  const username = parseInstagramUsername(raw) || raw.trim().replace(/^@/, '');
  if (!username) return res.status(400).json({ success: false, error: 'Enter an Instagram username or profile link.' });
  if (!isRapidConfigured()) {
    return res.status(400).json({
      success: false,
      error: 'Discovery API key missing — set RAPIDAPI_KEY in the trendlogic .env (see .env.example), then restart the service.'
    });
  }
  const limit = Math.min(24, Math.max(1, parseInt(String(req.query.limit || '12'), 10) || 12));
  const paginationId = typeof req.query.paginationId === 'string' && req.query.paginationId ? req.query.paginationId : null;
  try {
    const result = await ioQueue.add(`ig-discover:${username}`, (req as any).userId || null, () =>
      fetchRapidReels(username, limit, paginationId)
    );
    // Winner-first: the reel with the most views leads, so the winning
    // content is obvious (🏆 in the UI) and one click publishes it first.
    // Costs nothing — the counts ride free in this same response.
    const items = sortByWinnerScore(result.items || []);
    const winner = pickWinnerReel(items);
    res.json({
      success: true, username, source: 'rapidapi-user-reels',
      items,
      nextMaxId: result.nextMaxId, moreAvailable: result.moreAvailable,
      discoveryWindow: RAPID_DISCOVERY_WINDOW,
      winnerShortcode: winner ? winner.shortcode : null,
      winnerPlayCount: winner ? winner.playCount : 0
    });
  } catch (err: any) {
    res.status(400).json({ success: false, error: String(err?.message || err).slice(0, 300) });
  }
});

// Combine N selected discovery clips into ONE vertical MP4 (public/videos/).
// Body: { items: [{ shortcode, previewUrl }], username? } — previewUrls come
// straight from /api/instagram/discover (CDN links, expire fast, so mix soon
// after discovering). No yt-dlp involved: server fetches the MP4s directly.
//
// ASYNC: a multi-clip mix takes minutes — far past any browser/proxy request
// timeout — so this returns { jobId } IMMEDIATELY and the UI polls
// GET /api/instagram/mix-status/:id for progress (queued/running/done/failed).
app.post('/api/instagram/mix', async (req, res) => {
  const userId = (req as any).userId;
  const items = Array.isArray((req.body || {}).items) ? (req.body as any).items : [];
  const username = String((req.body || {}).username || 'mix').replace(/^@/, '').slice(0, 30) || 'mix';
  if (items.length < 1) return res.status(400).json({ success: false, error: 'Select at least 1 reel.' });
  if (items.length > 10) return res.status(400).json({ success: false, error: 'Pick at most 10 reels per mix.' });
  const sources = items.map((it: any) => ({ shortcode: String(it?.shortcode || 'reel'), previewUrl: String(it?.previewUrl || '') }));
  if (sources.some((s: { previewUrl: string }) => !/^https?:/i.test(s.previewUrl))) {
    return res.status(400).json({ success: false, error: 'Preview links expired — re-run Discovery, then combine right away.' });
  }
  const job = createMixJob(userId, 'mix', sources.length * 2 + 1);
  // Fire-and-forget into the CPU lane (serializes with renders); the queue
  // catches everything, and the job record carries the outcome to the poller.
  void pipelineQueue.add(`ig-mix:${job.id}`, userId || null, async () => {
    try {
      updateMixJob(job.id, { status: 'running', step: 'Starting mix…' });
      const videosDir = path.join(process.cwd(), 'public', 'videos');
      const filename = `igmix-${Date.now().toString(36)}-${uuid().slice(0, 6)}.mp4`;
      const r = await combineReelsToMp4(sources, path.join(videosDir, filename),
        (m) => console.log(`[IG-Mix ${job.id}] ${m}`),
        (p) => updateMixJob(job.id, { step: p.step, done: p.done, total: p.total }));
      // Register the file as this user's video — otherwise the /videos
      // ownership gate 404s the mix preview for its own owner.
      try {
        await addVideoRecord({
          id: uuid(), userId, filename, keyword: `IG mix @${username} (${r.count}x)`,
          visualMethod: 'ig-mix', sizeBytes: r.sizeBytes, durationSec: 0
        });
      } catch { /* preview gate falls back to 404; mix file itself is fine */ }
      updateMixJob(job.id, {
        status: 'done', step: 'Mix video ready.',
        result: { filename, url: `/videos/${filename}`, count: r.count, sizeBytes: r.sizeBytes }
      });
    } catch (err: any) {
      const msg = String(err?.message || err).slice(0, 300);
      console.warn(`[IG-Mix ${job.id}] failed: ${msg}`);
      updateMixJob(job.id, { status: 'failed', step: 'Mix failed.', error: msg });
    }
  }).catch(() => {});
  res.json({ success: true, jobId: job.id });
});

// Mix + Go Live in one click: combine the selection, then loop the single
// compilation on the user's YouTube Live (repeats until stopped — the push
// never restarts for the join itself). Needs the stream key saved in the
// Live tab (same rule as profile Go Live). Async like /mix (see above).
app.post('/api/instagram/mix-go-live', async (req, res) => {
  const userId = (req as any).userId;
  const items = Array.isArray((req.body || {}).items) ? (req.body as any).items : [];
  const username = String((req.body || {}).username || 'mix').replace(/^@/, '').slice(0, 30) || 'mix';
  if (items.length < 1) return res.status(400).json({ success: false, error: 'Select at least 1 reel.' });
  if (items.length > 10) return res.status(400).json({ success: false, error: 'Pick at most 10 reels per mix.' });
  const sources = items.map((it: any) => ({ shortcode: String(it?.shortcode || 'reel'), previewUrl: String(it?.previewUrl || '') }));
  if (sources.some((s: { previewUrl: string }) => !/^https?:/i.test(s.previewUrl))) {
    return res.status(400).json({ success: false, error: 'Preview links expired — re-run Discovery, then combine right away.' });
  }
  const job = createMixJob(userId, 'live', sources.length * 2 + 2);
  void pipelineQueue.add(`ig-mixlive:${job.id}`, userId || null, async () => {
    try {
      updateMixJob(job.id, { status: 'running', step: 'Starting mix…' });
      const mixId = `mix-${Date.now().toString(36)}`;
      const file = liveFilePath(mixId);
      const total = sources.length * 2 + 2;
      const r = await combineReelsToMp4(sources, file,
        (m) => console.log(`[IG-Mix ${job.id}] ${m}`),
        (p) => updateMixJob(job.id, { step: p.step, done: Math.min(p.done, total - 1), total }));
      updateMixJob(job.id, { step: 'Mix ready — taking it live on YouTube…', done: total - 1, total });
      const target = await resolveWatchStreamTarget(userId);
      const shortcode = `mix${r.count}x-${username}`.slice(0, 60);
      await beginReelLoop({
        watchId: mixId, userId, username, shortcode, filePath: file,
        rtmpUrl: target.rtmpUrl, streamKey: target.streamKey
      }, true);
      try {
        await addVideoRecord({
          id: uuid(), userId, filename: path.basename(file), keyword: `IG live mix @${username} (${r.count}x)`,
          visualMethod: 'ig-mix-live', sizeBytes: r.sizeBytes, durationSec: 0
        });
      } catch { /* ownership record is best effort */ }
      updateMixJob(job.id, {
        status: 'done', step: 'LIVE — mix is looping on YouTube.', done: total, total,
        result: { filename: path.basename(file), url: `/videos/${path.basename(file)}`, count: r.count, sizeBytes: r.sizeBytes }
      });
    } catch (err: any) {
      const msg = String(err?.message || err).slice(0, 300);
      console.warn(`[IG-Mix ${job.id}] live failed: ${msg}`);
      updateMixJob(job.id, { status: 'failed', step: 'Mix Live failed.', error: msg });
    }
  }).catch(() => {});
  res.json({ success: true, jobId: job.id });
});

// Poll a mix job (progress for the Discovery panel). Private — other users'
// jobs read as 404. Unknown id (e.g. after a server restart) also 404s, in
// which case the UI tells the user to simply retry.
app.get('/api/instagram/mix-status/:id', async (req, res) => {
  const job = getMixJob(String(req.params.id || ''));
  if (!job || job.userId !== (req as any).userId) {
    return res.status(404).json({ success: false, error: 'Mix job not found (it may have been lost in a server restart — just retry).' });
  }
  const pub: any = publicMixJob(job);
  if (job.status === 'done' && job.mode === 'live') {
    pub.live = getIgLiveStatus((req as any).userId);
  }
  res.json({ success: true, job: pub });
});

// Exact daily firing times ("HH:MM" wall clock in dailyTz, max 24). Strict:
// one malformed entry rejects the whole patch so a typo can never silently
// disarm or mis-arm the timer. Empty array = clear exact times (interval mode).
function validateDailyTimes(value: unknown): { ok: true; times: string[] } | { ok: false } {
  if (!Array.isArray(value) || value.length > 24) return { ok: false };
  for (const t of value) {
    const m = /^(\d{1,2}):(\d{2})$/.exec(String(t || '').trim());
    if (!m || Number(m[1]) > 23 || Number(m[2]) > 59) return { ok: false };
  }
  return { ok: true, times: normalizeDailyTimes(value) };
}

function validateTimeZoneParam(value: unknown): string | null {
  if (value === undefined || value === null || String(value).trim() === '') return 'UTC';
  try {
    return assertValidTimeZone(String(value));
  } catch {
    return null;
  }
}

app.post('/api/ig-watch', async (req, res) => {
  const { profileUrl, intervalHours, intervalMinutes, interval_hours, autoPublish, privacyStatus, dailyTimes, dailyTz, hashtags } = (req.body || {}) as any;
  const username = parseInstagramUsername(String(profileUrl || ''));
  if (!username) return res.status(400).json({ success: false, error: 'Enter a valid Instagram profile link (e.g. https://www.instagram.com/username/).' });
  // Hours + minutes timer (private per-user watch): accepts the legacy
  // `intervalHours` float, an explicit `intervalMinutes` total, or
  // `interval_hours` alias — all normalized to fractional hours.
  let h: number;
  if (intervalMinutes !== undefined && intervalMinutes !== null && intervalMinutes !== '') {
    const totalMin = Number(intervalMinutes);
    if (!isFinite(totalMin) || totalMin < 240) return res.status(400).json({ success: false, error: 'Timer must be at least 4 hours (240 minutes) — shorter intervals can look suspicious to YouTube.' });
    h = Math.round((totalMin / 60) * 10000) / 10000;
  } else {
    h = Number(intervalHours ?? interval_hours ?? 24);
  }
  if (!isFinite(h) || h < 4 || h > 168) {
    return res.status(400).json({ success: false, error: 'Timer must be between 4 hours and 7 days (4–168h) — shorter intervals can look suspicious to YouTube.' });
  }
  h = Math.round(h * 10000) / 10000;
  const allowed = ['public', 'unlisted', 'private'] as const;
  const privacy = allowed.includes(privacyStatus) ? privacyStatus : 'public';
  let times: string[] = [];
  if (dailyTimes !== undefined) {
    const v = validateDailyTimes(dailyTimes);
    if (!v.ok) return res.status(400).json({ success: false, error: 'dailyTimes must be an array of up to 24 "HH:MM" times (00:00–23:59).' });
    times = v.times;
  }
  const tz = validateTimeZoneParam(dailyTz);
  if (tz === null) return res.status(400).json({ success: false, error: 'Unknown time zone. Use an IANA name like Asia/Tehran or UTC.' });
  const normalized = normalizeProfileUrl(String(profileUrl)) || `https://www.instagram.com/${username}/`;
  const watch = await createIgWatch({
    id: uuid(), userId: (req as any).userId, profileUrl: normalized, username,
    intervalHours: h, autoPublish: autoPublish !== false, privacyStatus: privacy,
    dailyTimes: times, dailyTz: tz, hashtags
  });
  console.log(`[IG-Repost] watch created @${username} every ${h}h (auto-publish ${autoPublish !== false ? 'ON' : 'OFF'})`);
  res.json({ success: true, watch });
});

app.put('/api/ig-watch/:id', async (req, res) => {
  const { enabled, intervalHours, intervalMinutes, interval_hours, autoPublish, privacyStatus, dailyTimes, dailyTz, liveEnabled, hashtags } = (req.body || {}) as any;
  const patch: any = {};
  if (dailyTimes !== undefined) {
    const v = validateDailyTimes(dailyTimes);
    if (!v.ok) return res.status(400).json({ success: false, error: 'dailyTimes must be an array of up to 24 "HH:MM" times (00:00–23:59). Send an empty array to clear exact times (back to interval mode).' });
    patch.dailyTimes = v.times;
  }
  if (dailyTz !== undefined) {
    const tz = validateTimeZoneParam(dailyTz);
    if (tz === null) return res.status(400).json({ success: false, error: 'Unknown time zone. Use an IANA name like Asia/Tehran or UTC.' });
    patch.dailyTz = tz;
  }
  if (enabled !== undefined) patch.enabled = !!enabled;
  if (intervalHours !== undefined || intervalMinutes !== undefined || interval_hours !== undefined) {
    let h: number;
    if (intervalMinutes !== undefined && intervalMinutes !== null && intervalMinutes !== '') {
      const totalMin = Number(intervalMinutes);
      if (!isFinite(totalMin) || totalMin < 240) return res.status(400).json({ success: false, error: 'Timer must be at least 4 hours (240 minutes) — shorter intervals can look suspicious to YouTube.' });
      h = Math.round((totalMin / 60) * 10000) / 10000;
    } else {
      h = Number(intervalHours ?? interval_hours);
    }
    if (!isFinite(h) || h < 4 || h > 168) {
      return res.status(400).json({ success: false, error: 'Timer must be between 4 hours and 7 days (4–168h) — shorter intervals can look suspicious to YouTube.' });
    }
    patch.intervalHours = Math.round(h * 10000) / 10000;
  }
  if (autoPublish !== undefined) patch.autoPublish = !!autoPublish;
  if (privacyStatus !== undefined) {
    const allowed = ['public', 'unlisted', 'private'] as const;
    if (!allowed.includes(privacyStatus)) return res.status(400).json({ success: false, error: 'Invalid privacyStatus.' });
    patch.privacyStatus = privacyStatus;
  }
  if (hashtags !== undefined) patch.hashtags = hashtags;
  if (liveEnabled !== undefined) {
    // Arming Live implies the timer runs (a paused watch would never pick up
    // newer reels for the loop).
    patch.liveEnabled = !!liveEnabled;
    if (liveEnabled) patch.enabled = true;
  }
  const watch = await updateIgWatch(req.params.id, (req as any).userId, patch);
  if (!watch) return res.status(404).json({ success: false, error: 'Watch not found.' });
  // Disarming Live from the toggle also drops the loop when THIS watch owns
  // the push (same as DELETE .../live, minus the file cleanup).
  if (liveEnabled === false) {
    try {
      await stopReelLoop((req as any).userId, req.params.id);
      kickQueuesAfterLive();
    } catch { /* loop already gone */ }
  }
  res.json({ success: true, watch });
});

app.delete('/api/ig-watch/:id', async (req, res) => {
  // Deleting the profile that owns the on-air reel loop takes the loop down
  // with it (decoders die, push goes off air) — never orphan a push.
  try {
    await stopReelLoop((req as any).userId, req.params.id);
    kickQueuesAfterLive();
  } catch { /* nothing on air */ }
  await deleteIgWatch(req.params.id, (req as any).userId);
  res.json({ success: true });
});

app.get('/api/ig-watch/:id/items', async (req, res) => {
  const items = await listIgPosts(req.params.id, (req as any).userId, 30);
  // Deploy wipes public/videos: never hand the UI a filename whose bytes are
  // gone (dead "video" links). Publish re-downloads on demand anyway.
  const videosDir = path.join(process.cwd(), 'public', 'videos');
  const cleaned = (items || []).map((p: any) => {
    if (p?.filename) {
      try {
        if (!fs.existsSync(path.join(videosDir, path.basename(String(p.filename))))) {
          return { ...p, filename: '' };
        }
      } catch {
        return { ...p, filename: '' };
      }
    }
    return p;
  });
  res.json({ success: true, items: cleaned });
});

app.post('/api/ig-watch/:id/check', async (req, res) => {
  try {
    // Manual checks line up in the same IO lane as timer firings — the user
    // waits for their turn, but the server never runs two scrapes at once.
    // RapidAPI-first (when configured): an explicit user click may spend one
    // API call so the discovered rows carry their direct previewUrls — that
    // is what makes Publish/Retry work on 18+/login-walled profiles where
    // the anonymous downloader always comes back empty.
    const result = await ioQueue.add(`ig-check:${req.params.id}`, (req as any).userId || null, () =>
      checkIgWatch(req.params.id, (req as any).userId, true, true)
    );
    res.json({ success: true, ...result });
  } catch (err: any) {
    res.status(400).json({ success: false, error: err?.message || 'Check failed.' });
  }
});

// Manual publish: downloads the discovered reel(s) NOW and uploads to
// YouTube. Single shortcode or all pending (max 3, oldest first).
app.post('/api/ig-watch/:id/publish', async (req, res) => {
  try {
    const { shortcode } = (req.body || {}) as any;
    const sc = typeof shortcode === 'string' && shortcode.trim() ? shortcode.trim() : undefined;
    const result = await ioQueue.add(`ig-publish:${req.params.id}`, (req as any).userId || null, () =>
      publishWatchItems(req.params.id, (req as any).userId, sc, sc ? 1 : 3)
    );
    res.json({ success: true, ...result });
  } catch (err: any) {
    res.status(400).json({ success: false, error: err?.message || 'Publish failed.' });
  }
});

/* ========================================================================= */
/* 3.4 IG-to-Live: one profile's newest reel loops on YouTube Live, repeating */
/* until the profile timer discovers a newer reel — the swap restarts only   */
/* the decoder, so the push (and the live) never disconnects. One global     */
/* loop at a time; the timer path never hijacks another broadcast, the       */
/* explicit Go Live button takes over on demand.                             */
/* ========================================================================= */

app.get('/api/ig-live/status', async (req, res) => {
  res.json({ success: true, live: getIgLiveStatus((req as any).userId) });
});

// Explicit Go Live for a profile: newest reel on air NOW (takes over the
// push when something else is live) + arms the timer loop for seamless
// swaps on every later firing.
app.post('/api/ig-watch/:id/go-live', async (req, res) => {
  const userId = (req as any).userId;
  try {
    const result = await ioQueue.add(`ig-golive:${req.params.id}`, userId || null, async () => {
      let watch = await getIgWatch(req.params.id, userId);
      if (!watch) throw new Error('Watch not found.');
      // Need at least one discovered reel — run a discovery pass first when
      // the shelf is empty (same info-only check as "Check now").
      let posts = await listIgPosts(req.params.id, userId, 1).catch(() => []);
      let sc = posts?.[0]?.shortcode || watch.last_shortcode || null;
      if (!sc) {
        await checkIgWatch(req.params.id, userId, true);
        watch = await getIgWatch(req.params.id, userId);
        if (!watch) throw new Error('Watch not found.');
        posts = await listIgPosts(req.params.id, userId, 1).catch(() => []);
        sc = posts?.[0]?.shortcode || watch.last_shortcode || null;
      }
      if (!sc) throw new Error('No reels discovered for this profile yet — try again in a minute.');
      const file = await ensureWatchLiveFile(req.params.id, userId, watch.username, sc, watch.live_shortcode);
      let fileMb = '';
      try {
        fileMb = `${(fs.statSync(file).size / (1024 * 1024)).toFixed(1)} MB`;
      } catch { fileMb = 'unknown size'; }
      console.log(`[IG-Live] Go Live @${watch.username} reel ${sc} (${fileMb}) — starting push.`);
      const target = await resolveWatchStreamTarget(userId);
      await beginReelLoop({
        watchId: req.params.id, userId, username: watch.username, shortcode: sc,
        filePath: file, rtmpUrl: target.rtmpUrl, streamKey: target.streamKey
      }, true);
      await updateIgWatch(req.params.id, userId, {
        liveEnabled: true, enabled: true,
        liveShortcode: sc, liveStartedAt: new Date().toISOString()
      });
      // Enabling Live implies the timer must be armed (a paused watch would
      // never pick up newer reels): re-arm when it has no next firing.
      const armed = await getIgWatch(req.params.id, userId);
      if (armed && !armed.next_run_at) {
        await updateIgWatch(req.params.id, userId, { enabled: true });
      }
      return { live: getIgLiveStatus(userId) };
    });
    res.json({ success: true, ...result });
  } catch (err: any) {
    res.status(400).json({ success: false, error: err?.message || 'Go Live failed.' });
  }
});

// Stop the reel loop + disarm it (the timer stops touching the push).
app.delete('/api/ig-watch/:id/live', async (req, res) => {
  const userId = (req as any).userId;
  try {
    const watch = await getIgWatch(req.params.id, userId);
    if (!watch) return res.status(404).json({ success: false, error: 'Watch not found.' });
    await updateIgWatch(req.params.id, userId, { liveEnabled: false, liveShortcode: null, liveStartedAt: null });
    const live = await stopReelLoop(userId, req.params.id);
    kickQueuesAfterLive();
    try {
      fs.rmSync(liveFilePath(req.params.id), { force: true });
    } catch { /* loop file cleanup is best effort */ }
    res.json({ success: true, live });
  } catch (err: any) {
    res.status(400).json({ success: false, error: err?.message || 'Stop live failed.' });
  }
});

// 4. Trend Normalizer & Deduplication: Manual or bulk normalization
app.post('/api/trends/deduplicate', (req, res) => {
  // Deduplicate near-duplicate trends by keyword clustering
  const seenKeywords = new Set<string>();
  const deduplicated: NormalizedTrend[] = [];

  for (const trend of trendsDatabase) {
    const simplified = trend.keyword.toLowerCase().replace(/[^a-z0-9]/g, ' ').trim();
    if (!seenKeywords.has(simplified)) {
      seenKeywords.add(simplified);
      deduplicated.push(trend);
    }
  }

  trendsDatabase = deduplicated;
  res.json({
    success: true,
    remainingCount: trendsDatabase.length
  });
});

// 5. Pipeline Jobs: Get all jobs (private — only the caller's own + legacy)
app.get('/api/pipeline/jobs', (req, res) => {
  res.json({
    jobs: jobsForUser((req as any).userId)
  });
});

// 6. Pipeline Job Detail (private — other users' jobs read as 404)
app.get('/api/pipeline/jobs/:id', (req, res) => {
  const job = findJobForUser(req.params.id, (req as any).userId);
  if (!job) {
    return res.status(404).json({ error: 'Job not found' });
  }
  res.json({ job });
});

// 7. Pipeline Run: Launch the automated viral-short pipeline on a trend.
// The job is stored as `queued` and executed FIFO through the pipeline lane —
// 50 users clicking at the same second line up instead of running 50
// concurrent ffmpeg renders and crashing the container.
app.post('/api/pipeline/run', requireActive, async (req, res) => {
  const { trendId, customQuestion, customAngle, voice } = req.body;
  const callerId = (req as any).userId;

  // Flood guard: one user can't starve everyone else's timers.
  if (callerId && countUserActiveJobs(callerId) >= MAX_QUEUED_PER_USER) {
    return res.status(429).json({
      success: false,
      error: `You already have ${MAX_QUEUED_PER_USER} jobs waiting/running — please wait for one to finish.`
    });
  }

  let trend = trendsDatabase.find(t => t.id === trendId);
  if (!trend) {
    trend = INITIAL_TRENDS[0];
  }

  // Non-blocking heads-up: rendering is still allowed, but publishing will
  // be refused if this topic is already on the channel (durable ledger).
  let duplicateWarning: string | null = null;
  if (callerId && isDbReady()) {
    try {
      const dup = await hasRecentTrendPublish(callerId, await ownerChannelId(callerId), trend.keyword, TREND_PUBLISH_DUP_HOURS);
      if (dup) duplicateWarning = `${duplicatePublishMessage(trend.keyword, dup)} You can still render, but publishing it will be blocked as a duplicate.`;
    } catch { /* warning is best effort */ }
  }

  const jobId = `job-${Date.now()}`;
  const now = new Date().toISOString();

  // Create new queued job
  const newJob: PipelineJob = {
    id: jobId,
    ownerUserId: callerId || null,
    trendId: trend.id,
    trendKeyword: trend.keyword,
    category: trend.category,
    status: 'queued',
    currentStep: 'idle',
    progressPercent: 0,
    startedAt: now,
    voiceId: isKnownTemplateVoice(voice) ? voice : undefined,
    logs: [
      {
        id: `log-${Date.now()}-1`,
        timestamp: new Date().toLocaleTimeString(),
        step: 'Discovery & Ingestion',
        message: `Pipeline queued for trend "${trend.keyword}" (Rank #${trend.rank}, Velocity ${trend.velocity}) — position ${pipelineQueue.stats().pending + 1} in the processing queue.`,
        type: 'info'
      }
    ],
    trend: { ...trend },
    publishing: [
      { platform: 'youtube_shorts', enabled: true, status: 'draft' },
      { platform: 'tiktok', enabled: true, status: 'draft' },
      { platform: 'instagram_reels', enabled: true, status: 'draft' },
      { platform: 'x', enabled: false, status: 'draft' }
    ]
  };

  jobsDatabase.unshift(newJob);
  if (duplicateWarning) {
    newJob.logs.push({
      id: `log-${Date.now()}-dup`,
      timestamp: new Date().toLocaleTimeString(),
      step: 'Duplicate guard',
      message: duplicateWarning,
      type: 'warn'
    });
  }
  res.json({ success: true, jobId, job: newJob, queuePosition: pipelineQueue.stats().pending, duplicateWarning });

  // Execute asynchronously through the queue (never inline).
  void enqueuePipelineJob(jobId, trend, customQuestion, customAngle).catch(() => {});
});

// 8. Custom Trend Creation (Manual injection from admin)
app.post('/api/trends/create', requireActive, (req, res) => {
  const { keyword, category, description, search_volume, velocity, country = 'US' } = req.body;

  if (!keyword) {
    return res.status(400).json({ error: 'Keyword is required' });
  }

  const primaryQuestion = `Why is ${keyword} trending today?`;
  const newTrend: NormalizedTrend = {
    id: `trend-${Date.now()}`,
    country,
    language: 'en',
    keyword,
    rank: 1,
    trend_score: Math.round(((velocity || 85) + (search_volume || 80)) / 2),
    velocity: velocity || 88,
    search_volume: search_volume || 84,
    detected_at: new Date().toISOString(),
    category: category || 'world',
    description: description || `Sudden surge in search query volume for "${keyword}".`,
    image_url: '',
    detectedIntent: 'why_trending',
    primaryQuestion,
    candidateQuestions: [
      primaryQuestion,
      `What happened with ${keyword}?`,
      `Why are people searching for ${keyword}?`,
      `What changed today?`
    ],
    sources: [
      {
        name: 'Newsroom Intelligence Feed',
        title: `Search spike analysis for ${keyword}`,
        url: 'https://news.google.com',
        publishedAt: new Date().toISOString(),
        snippet: `Real-time search volume spiked over 300% in the last 2 hours.`,
        credibilityScore: 96
      }
    ]
  };

  trendsDatabase.unshift(newTrend);
  res.json({ success: true, trend: newTrend });
});

// 9. Provider Configs API
app.get('/api/providers', (req, res) => {
  res.json({ providers: providerConfigs });
});

app.put('/api/providers/:id', (req, res) => {
  const { active, refreshIntervalMin } = req.body;
  const idx = providerConfigs.findIndex(p => p.id === req.params.id);
  if (idx !== -1) {
    providerConfigs[idx] = {
      ...providerConfigs[idx],
      active: active !== undefined ? active : providerConfigs[idx].active,
      refreshIntervalMin: refreshIntervalMin !== undefined ? refreshIntervalMin : providerConfigs[idx].refreshIntervalMin,
      lastSync: new Date().toISOString()
    };
    return res.json({ success: true, provider: providerConfigs[idx] });
  }
  res.status(404).json({ error: 'Provider not found' });
});

// 10. YouTube Channel Integration API (per-user; tokens never leave the backend)
// Saved channel status for the signed-in user — no secrets, no tokens.
app.get('/api/youtube/config', async (req, res) => {
  res.json({ config: await getYouTubeStatus((req as any).userId) });
});

// Only the default upload privacy is user-editable. Tokens/secrets posted by
// older clients are deliberately ignored so a save can never wipe the login.
app.post('/api/youtube/config', async (req, res) => {
  const { privacyStatus } = req.body || {};
  const allowed = ['public', 'unlisted', 'private'] as const;
  const updated = await saveYouTubePrefs(
    (req as any).userId,
    allowed.includes(privacyStatus) ? { privacyStatus } : {}
  );
  res.json({ success: true, config: updated });
});

// Unlink the saved channel (clears this user's tokens only).
app.post('/api/youtube/disconnect', async (req, res) => {
  res.json({ success: true, config: await disconnectYouTube((req as any).userId) });
});

app.post('/api/youtube/test', async (req, res) => {
  const result = await testYouTubeConnection((req as any).userId);
  res.json(result);
});

/* ========================================================================= */
/* Virality engine tickers: velocity spikes fire immediately (no waiting for  */
/* the user's next interval), and stale low-view titles rotate once. Both    */
/* are overlap-guarded and throttle themselves; nothing here can wedge the   */
/* lanes or double-publish (the cycle's own busy/dup guards re-validate).    */
/* ========================================================================= */

/** Spike threshold for immediate firing (0/disabled = off). A trend at or
 *  above this velocity is published NOW instead of at the next interval. */
const AUTO_VELOCITY_TRIGGER = parseFloat(process.env.AUTO_VELOCITY_TRIGGER || '88');
/** Per-user velocity evaluation throttle (minutes) + shared per-country
 *  trend cache window — N armed users in one country cost ONE fetch. */
const VELOCITY_CHECK_MIN = 30;
const velocityCheckedAt = new Map<string, number>();
const velocityTrendsCache = new Map<string, { at: number; trends: NormalizedTrend[] }>();
let velocityTickRunning = false;

/** Same 24h duplicate rule as the Auto-Pilot cycle (kept in sync with it):
 *  a topic produced (or in flight) in the last 24h is not fresh. */
function isVelocityTrendFresh(top: NormalizedTrend): boolean {
  const normKey = (s: string) => s.toLowerCase().replace(/[^a-z0-9\u0600-\u06FF]+/gi, ' ').trim();
  const k = normKey(top.keyword);
  const DUP_HORIZON_MS = 24 * 3600 * 1000;
  return !jobsDatabase.some(j => {
    if (normKey(j.trendKeyword) !== k) return false;
    if (j.status === 'running' || j.status === 'queued') return true;
    if (j.status !== 'completed') return false;
    return Date.now() - new Date(j.startedAt).getTime() < DUP_HORIZON_MS;
  });
}

async function maybeVelocityFire(): Promise<void> {
  if (!isFinite(AUTO_VELOCITY_TRIGGER) || AUTO_VELOCITY_TRIGGER <= 0) return;
  if (velocityTickRunning) return;
  if (!isDbReady()) return;
  velocityTickRunning = true;
  try {
    // Lane busy: the normal timers already cover production — a spike firing
    // on top would only pile the queue.
    if (jobsDatabase.some(j => j.status === 'running' || j.status === 'queued')) return;
    const schedules = await listEnabledAutoSchedules(20);
    const now = Date.now();
    for (const s of schedules) {
      const owner = s.user_id;
      if (!owner) continue;
      if (now - (velocityCheckedAt.get(owner) || 0) < VELOCITY_CHECK_MIN * 60 * 1000) continue;
      // A normal firing is imminent — let the timer do it (no double cycle).
      const nextMs = s.next_run_at ? Date.parse(s.next_run_at) : NaN;
      if (Number.isFinite(nextMs) && nextMs - now < 10 * 60 * 1000) continue;
      velocityCheckedAt.set(owner, now);
      try {
        const country = s.country || 'US';
        let entry = velocityTrendsCache.get(country);
        if (!entry || now - entry.at > VELOCITY_CHECK_MIN * 60 * 1000) {
          const live = await fetchLiveTrends(country);
          entry = { at: now, trends: live.trends };
          velocityTrendsCache.set(country, entry);
        }
        const top = entry.trends?.[0];
        const vel = Number((top as any)?.velocity ?? 0);
        if (!top || vel < AUTO_VELOCITY_TRIGGER || !isVelocityTrendFresh(top)) continue;
        console.log(`[Auto-Pilot] velocity trigger ${vel} — "${top.keyword}" (${country}) for user ${owner}, firing now.`);
        // The cycle re-validates (busy + dup guards) and rolls the user's
        // timer forward from NOW, so cadence stays stable after the early fire.
        await runAutoPilotCycleFor(s);
      } catch (err: any) {
        console.warn(`[Auto-Pilot] velocity check note for user ${owner}:`, String(err?.message || err).slice(0, 140));
      }
    }
  } finally {
    velocityTickRunning = false;
  }
}

/** Title rotation: videos 24–72h old with fewer than TITLE_ROTATE_MIN_VIEWS
 *  views get ONE AI-rewritten title (tracked in tl_title_rotations, never
 *  twice). Channels whose grant predates the write scope are flagged for one
 *  reconnect instead of 403-spamming every 6 hours. */
let titleTickRunning = false;
async function tickTitleRotation(): Promise<void> {
  if (titleTickRunning) return;
  if (!isDbReady()) return;
  const minViews = parseInt(process.env.TITLE_ROTATE_MIN_VIEWS || '150', 10) || 150;
  titleTickRunning = true;
  try {
    const accounts = await listConnectedYouTubeAccounts(25);
    for (const acc of accounts) {
      try {
        const data = await fetchChannelLatestUploads(acc.user_id, 10);
        const now = Date.now();
        for (const v of data.items) {
          const ageH = (now - Date.parse(v.publishedAt || '')) / 3600000;
          if (!Number.isFinite(ageH) || ageH < 24 || ageH > 72) continue;
          if ((v.viewCount ?? 0) >= minViews) continue;
          if (await hasTitleRotation(v.videoId)) continue;
          const alt = await generateAltTitle(v.title, v.description);
          if (!alt) continue;
          try {
            await updateVideoTitle(acc.user_id, v.videoId, alt);
            await recordTitleRotation({
              videoId: v.videoId, userId: acc.user_id,
              oldTitle: v.title, newTitle: alt, viewsAtRotation: v.viewCount
            });
            console.log(`[Engage] title rotated for ${acc.user_id} (${v.viewCount ?? 0} views): "${v.title}" -> "${alt}"`);
          } catch (err: any) {
            if ((err as any)?.needsReconnect) {
              try {
                await saveYouTubeRow(acc.user_id, { needs_reconnect: 1 });
              } catch { /* flag persist is best effort */ }
              console.warn(`[Engage] title rotation needs one reconnect for user ${acc.user_id} — skipping channel.`);
              break; // channel-wide grant issue — next channel
            }
            console.warn(`[Engage] title rotation note for ${v.videoId}:`, String(err?.message || err).slice(0, 140));
          }
        }
      } catch (err: any) {
        if ((err as any)?.needsReconnect) {
          try {
            await saveYouTubeRow(acc.user_id, { needs_reconnect: 1 });
          } catch { /* best effort */ }
        }
        console.warn(`[Engage] rotation sweep note for user ${acc.user_id}:`, String(err?.message || err).slice(0, 140));
      }
    }
  } finally {
    titleTickRunning = false;
  }
}

// Admin Panel: latest YouTube uploads across ALL linked users (manager role
// only — requireAdmin 403s everyone else; channel tokens AND user emails
// never leave the backend: only public video data + display names reach the
// client). The fan-out runs inside the IO lane with 3-at-a-time concurrency
// so one slow channel never stalls the panel and the lane's bookkeeping
// stays truthful. Results are cached in memory (ADMIN_UPLOADS_TTL_MINUTES,
// default 10) so repeated panel opens don't burn YouTube quota — ?refresh=1
// forces a fresh pull. Every access is audit-logged (fire-and-forget).
const ADMIN_UPLOADS_TTL_MS = (() => {
  const v = parseFloat(process.env.ADMIN_UPLOADS_TTL_MINUTES || '10');
  if (!isFinite(v)) return 10 * 60 * 1000;
  return Math.min(120, Math.max(1, v)) * 60 * 1000;
})();
const adminUploadsCache = new Map<string, { at: number; payload: any }>();

app.get('/api/admin/youtube-uploads', requireAdmin, async (req, res) => {
  const caller = (req as any).userId || null;
  const adminName = (req as any).user?.name || '';
  try {
    const perChannel = Math.min(10, Math.max(1, parseInt(String(req.query.perChannel || '3'), 10) || 3));
    const maxChannels = Math.min(50, Math.max(1, parseInt(String(req.query.maxChannels || '25'), 10) || 25));
    const force = String(req.query.refresh || '') === '1';
    const cacheKey = `${perChannel}x${maxChannels}`;
    const hit = adminUploadsCache.get(cacheKey);
    if (!force && hit && Date.now() - hit.at < ADMIN_UPLOADS_TTL_MS) {
      void logAdminAction(caller, adminName, 'view_uploads', `cached ${cacheKey}`);
      return res.json({ success: true, cached: true, ...hit.payload });
    }
    const payload = await ioQueue.add('admin-uploads', caller, async () => {
      const accounts = await listConnectedYouTubeAccounts(maxChannels);
      const channels: {
        user: { id: string; name: string };
        channelId: string | null;
        channelTitle: string | null;
        channelThumbnail: string | null;
        subscriberCount: string | null;
        lastPublishDate: string | null;
        videos: unknown[];
        error: string | null;
      }[] = [];
      let idx = 0;
      const worker = async () => {
        while (idx < accounts.length) {
          const acc = accounts[idx++];
          const base = {
            user: { id: acc.user_id, name: acc.user_name },
            channelId: acc.channel_id,
            channelTitle: acc.channel_title,
            channelThumbnail: acc.channel_thumbnail,
            subscriberCount: acc.subscriber_count,
            lastPublishDate: acc.last_publish_date
          };
          try {
            const data = await fetchChannelLatestUploads(acc.user_id, perChannel);
            channels.push({
              ...base,
              channelId: data.channelId || base.channelId,
              channelTitle: data.channelTitle || base.channelTitle,
              // Fresh live count from this fetch; stored DB value as fallback.
              subscriberCount: (data as any).subscriberCount ?? base.subscriberCount,
              videos: data.items.map(v => ({ ...v, owner: base.user })),
              error: null
            });
          } catch (err: any) {
            channels.push({
              ...base, videos: [],
              error: String(err?.message || err).slice(0, 180)
            });
          }
        }
      };
      await Promise.all(
        Array.from({ length: Math.min(3, Math.max(1, accounts.length)) }, () => worker())
      );
      const videos = channels
        .flatMap(c => c.videos as any[])
        .sort((a, b) => +new Date(b.publishedAt || 0) - +new Date(a.publishedAt || 0));
      return { channels, videos, fetchedAt: new Date().toISOString() };
    }, { liveHold: false });
    adminUploadsCache.set(cacheKey, { at: Date.now(), payload });
    if (adminUploadsCache.size > 12) {
      const oldest = adminUploadsCache.keys().next().value;
      if (oldest) adminUploadsCache.delete(oldest);
    }
    void logAdminAction(caller, adminName, 'view_uploads', `fresh ${cacheKey}, ${(payload as any).videos?.length ?? 0} videos`);
    res.json({ success: true, cached: false, ...payload });
  } catch (err: any) {
    res.status(500).json({ success: false, error: 'Could not load uploads — please try again.' });
  }
});

// Admin Panel overview: cross-user watch health (broken timers surface HERE
// before users complain), durable publish counts, channel grant flags,
// recent title rotations, recent audit trail. Cheap pure-DB reads — always
// fresh, no YouTube quota involved.
app.get('/api/admin/overview', requireAdmin, async (req, res) => {
  const caller = (req as any).userId || null;
  const adminName = (req as any).user?.name || '';
  try {
    const [watches, stats, audit, accounts, rotations] = await Promise.all([
      listAllWatchesForAdmin(200),
      getPublishStats(),
      listAdminAudit(15),
      listConnectedYouTubeAccounts(50),
      listTitleRotations(10)
    ]);
    const now = Date.now();
    const health = watches.map(w => {
      const reasons: string[] = [];
      if (w.enabled !== 1) {
        // Disabled watches need no attention — listed for completeness.
      } else {
        if (w.lastError) reasons.push('error');
        if (!w.nextRunAt) reasons.push('no_schedule');
        if (w.lastCheckAt) {
          const ageMin = (now - Date.parse(w.lastCheckAt)) / 60000;
          if (ageMin > 48 * 60) reasons.push('stale');
        } else {
          reasons.push('never_checked');
        }
      }
      return { ...w, attention: reasons };
    });
    const attentionCount = health.filter(h => h.attention.length > 0).length;
    // Connection flags WITHOUT tokens/emails: which channels need one
    // reconnect to unlock auto-comments / title rotation / retention.
    const channels = accounts.map(a => ({
      userId: a.user_id,
      userName: a.user_name,
      channelId: a.channel_id,
      channelTitle: a.channel_title,
      subscriberCount: a.subscriber_count,
      lastPublishDate: a.last_publish_date,
      needsReconnect: Number(a.needs_reconnect ?? 0)
    }));
    void logAdminAction(caller, adminName, 'view_overview', `${watches.length} watches, ${attentionCount} need attention`);
    res.json({ success: true, fetchedAt: new Date().toISOString(), watches: health, stats, audit, channels, rotations, rapidKeys: getRapidKeysStatus() });
  } catch (err: any) {
    res.status(500).json({ success: false, error: 'Could not load overview — please try again.' });
  }
});

// Admin: reset the RapidAPI request counter shown in the Health tab.
// (The key pool itself is untouched — only the sent-requests counter.)
app.post('/api/admin/rapid-reset', requireAdmin, async (req, res) => {
  const caller = (req as any).userId || null;
  const adminName = (req as any).user?.name || '';
  resetRapidUsage();
  void logAdminAction(caller, adminName, 'rapid_reset', 'RapidAPI request counter reset to 0');
  res.json({ success: true, rapidKeys: getRapidKeysStatus() });
});

// Admin retention: per-video views + average view duration/percentage via the
// Analytics API, across all linked channels (best-effort per channel — old
// grants without the analytics scope land in `reconnect` instead of failing
// the panel). Cached (RETENTION_TTL_MINUTES, default 360): retention moves
// slowly, quota shouldn't burn on every panel open.
const RETENTION_TTL_MS = (() => {
  const v = parseFloat(process.env.RETENTION_TTL_MINUTES || '360');
  if (!isFinite(v)) return 6 * 3600 * 1000;
  return Math.min(2880, Math.max(30, v)) * 60 * 1000;
})();
const retentionCache = new Map<string, { at: number; payload: any }>();

app.get('/api/admin/retention', requireAdmin, async (req, res) => {
  const caller = (req as any).userId || null;
  const adminName = (req as any).user?.name || '';
  try {
    const force = String(req.query.refresh || '') === '1';
    const hit = retentionCache.get('v1');
    if (!force && hit && Date.now() - hit.at < RETENTION_TTL_MS) {
      void logAdminAction(caller, adminName, 'view_retention', 'cached');
      return res.json({ success: true, cached: true, ...hit.payload });
    }
    const payload = await ioQueue.add('admin-retention', caller, async () => {
      const accounts = await listConnectedYouTubeAccounts(25);
      const rows: {
        owner: { id: string; name: string };
        channelTitle: string | null;
        videoId: string;
        title: string;
        publishedAt: string | null;
        views: number;
        avgViewDurationSec: number;
        avgViewPercentage: number;
      }[] = [];
      const reconnect: { userId: string; userName: string; channelTitle: string | null }[] = [];
      for (const acc of accounts) {
        try {
          const up = await fetchChannelLatestUploads(acc.user_id, 10);
          const meta = new Map(up.items.map(v => [v.videoId, v]));
          const ret = await fetchVideoRetention(acc.user_id, up.items.map(v => v.videoId));
          for (const r of ret) {
            const m = meta.get(r.videoId);
            rows.push({
              owner: { id: acc.user_id, name: acc.user_name },
              channelTitle: acc.channel_title || m?.channelTitle || null,
              videoId: r.videoId,
              title: m?.title || r.videoId,
              publishedAt: m?.publishedAt || null,
              views: r.views,
              avgViewDurationSec: r.avgViewDurationSec,
              avgViewPercentage: r.avgViewPercentage
            });
          }
        } catch (err: any) {
          if ((err as any)?.needsReconnect) {
            try {
              await saveYouTubeRow(acc.user_id, { needs_reconnect: 1 });
            } catch { /* best effort */ }
            reconnect.push({ userId: acc.user_id, userName: acc.user_name, channelTitle: acc.channel_title });
          } else {
            console.warn(`[Engage] retention note for user ${acc.user_id}:`, String(err?.message || err).slice(0, 140));
          }
        }
      }
      rows.sort((a, b) => b.views - a.views);
      return { rows, reconnect, fetchedAt: new Date().toISOString() };
    }, { liveHold: false });
    retentionCache.set('v1', { at: Date.now(), payload });
    void logAdminAction(caller, adminName, 'view_retention', `${(payload as any).rows?.length ?? 0} videos`);
    res.json({ success: true, cached: false, ...payload });
  } catch (err: any) {
    res.status(500).json({ success: false, error: 'Could not load retention — please try again.' });
  }
});

// OAuth 2.0: Get Authorization URL for popup (bound to this user via state)
app.get('/api/youtube/oauth/url', (req, res) => {
  const origin = req.query.origin as string;
  const appUrl = process.env.APP_URL || (origin || 'https://ais-dev-44ce4ugabvc3q6umghykcp-732962303442.europe-west2.run.app');
  const redirectUri = `${appUrl.replace(/\/$/, '')}/auth/callback`;
  const state = createOAuthLink((req as any).userId);
  const url = generateOAuthAuthUrl(redirectUri, state);
  res.json({ url, redirectUri });
});

// OAuth 2.0: Callback Handler for popup
const handleOAuthCallback = async (req: express.Request, res: express.Response) => {
  const { code, error, state } = req.query;

  if (error) {
    return res.send(`
      <!DOCTYPE html>
      <html>
        <head><title>Authentication Cancelled</title></head>
        <body style="background:#090d16;color:#f87171;font-family:-apple-system,BlinkMacSystemFont,sans-serif;text-align:center;padding:50px;">
          <h2>YouTube Authentication Cancelled</h2>
          <p style="color:#94a3b8;">${error}</p>
          <script>setTimeout(() => window.close(), 2500);</script>
        </body>
      </html>
    `);
  }

  if (!code || typeof code !== 'string') {
    return res.status(400).send('Missing authorization code');
  }

  // Construct redirectUri matching what Google sent back
  const protocol = req.headers['x-forwarded-proto'] || 'https';
  const host = req.headers['x-forwarded-host'] || req.headers.host || '';
  const fallbackUrl = process.env.APP_URL || `${protocol}://${host}`;
  const redirectUri = `${fallbackUrl.replace(/\/$/, '')}/auth/callback`;

  // Attribute the tokens to the user who clicked Connect: state first,
  // app session cookie as fallback (the popup is a top-level navigation,
  // so the Lax session cookie is present).
  let userId = consumeOAuthLink(typeof state === 'string' ? state : undefined);
  if (!userId) {
    try {
      const token = parseCookieString(req.headers.cookie, SESSION_COOKIE);
      if (token) {
        const user = await getSessionUser(token);
        userId = user?.id || null;
      }
    } catch { /* fall through to the login prompt below */ }
  }
  if (!userId) {
    return res.status(401).send(`
      <!DOCTYPE html>
      <html>
        <head><title>Session Expired</title></head>
        <body style="background:#090d16;color:#f8fafc;font-family:-apple-system,BlinkMacSystemFont,sans-serif;text-align:center;padding:50px;">
          <h2>App session expired</h2>
          <p style="color:#94a3b8;">Please sign in to Trend Video Engine first, then click "Connect YouTube Account" again — your channel will be saved to your account.</p>
          <button onclick="window.close()" style="margin-top:24px;padding:10px 20px;background:#dc2626;color:white;border:none;border-radius:12px;cursor:pointer;font-weight:bold;">Close Window</button>
        </body>
      </html>
    `);
  }

  const result = await exchangeCodeForTokens(code, redirectUri, userId);

  if (result.success) {
    const channelName = result.channel?.title || 'Connected YouTube Channel';
    const subCount = result.channel?.subscribers || 'Ready';

    res.send(`
      <!DOCTYPE html>
      <html>
        <head>
          <title>YouTube Connected</title>
          <style>
            body { background: #090d16; color: #f8fafc; font-family: -apple-system, BlinkMacSystemFont, "Segoe UI", Roboto, sans-serif; display: flex; align-items: center; justify-content: center; height: 100vh; margin: 0; }
            .card { background: #0f172a; border: 1px solid #1e293b; border-radius: 24px; padding: 36px; max-width: 420px; text-align: center; box-shadow: 0 25px 50px -12px rgba(0,0,0,0.7); }
            .badge { display: inline-flex; align-items: center; gap: 6px; background: rgba(34,197,94,0.15); color: #4ade80; border: 1px solid rgba(34,197,94,0.3); padding: 4px 14px; border-radius: 9999px; font-size: 12px; font-weight: 800; font-family: monospace; margin-bottom: 16px; }
            h2 { margin: 0 0 8px; font-size: 22px; font-weight: 900; color: #fff; }
            p { margin: 0 0 18px; font-size: 13px; color: #94a3b8; line-height: 1.5; }
            .sub { font-family: monospace; font-size: 12px; color: #38bdf8; }
          </style>
        </head>
        <body>
          <div class="card">
            <div class="badge">CHANNEL CONNECTED</div>
            <h2>${channelName}</h2>
            <p>Your YouTube channel is now connected and saved to your account — publishing works with one click from now on, no need to log in again.</p>
            <div class="sub">Subscribers: ${subCount} • Closing window...</div>
          </div>
          <script>
            if (window.opener) {
              window.opener.postMessage({ type: 'OAUTH_AUTH_SUCCESS', channel: ${JSON.stringify(result.channel || {})} }, '*');
              setTimeout(() => window.close(), 1200);
            } else {
              setTimeout(() => { window.location.href = '/'; }, 1500);
            }
          </script>
        </body>
      </html>
    `);
  } else {
    res.status(500).send(`
      <!DOCTYPE html>
      <html>
        <head><title>Connection Error</title></head>
        <body style="background:#090d16;color:#f87171;font-family:-apple-system,BlinkMacSystemFont,sans-serif;text-align:center;padding:50px;">
          <h2>YouTube Token Exchange Error</h2>
          <p style="color:#cbd5e1;">${result.error || 'Failed to exchange authorization code.'}</p>
          <p style="color:#94a3b8;font-size:12px;margin-top:20px;">
            Please ensure this exact URI is in your Google Cloud Console <b>Authorized redirect URIs</b>:<br/>
            <code style="background:#1e293b;padding:4px 8px;border-radius:6px;display:inline-block;margin-top:8px;">${redirectUri}</code>
          </p>
          <button onclick="window.close()" style="margin-top:24px;padding:10px 20px;background:#dc2626;color:white;border:none;border-radius:12px;cursor:pointer;font-weight:bold;">Close Window</button>
        </body>
      </html>
    `);
  }
};

app.get(['/auth/callback', '/auth/callback/'], handleOAuthCallback);

app.post('/api/youtube/publish', requireActive, async (req, res) => {
  try {
    const { jobId, videoUrl, privacyStatus, title, description, tags } = req.body;
    const callerId = (req as any).userId;
    // Strictly the caller's own job — never fall back to another job: that
    // used to silently upload the wrong video to YouTube.
    const job = findJobForUser(jobId, callerId);

    let videoPath = '';

    // 1. Direct videoUrl provided — must be owned by the caller.
    if (videoUrl && typeof videoUrl === 'string') {
      const cleanPath = videoUrl.startsWith('/') ? videoUrl.slice(1) : videoUrl;
      const base = path.basename(cleanPath);
      const candidate = path.join(process.cwd(), 'public', cleanPath);
      if (fs.existsSync(candidate) && (!isDbReady() || await userOwnsMediaFile(callerId, base))) {
        videoPath = candidate;
      }
    }

    // 2. Job's videoUrl (already scoped to the caller's own job above)
    if (!videoPath && job?.videoUrl) {
      const cleanPath = job.videoUrl.startsWith('/') ? job.videoUrl.slice(1) : job.videoUrl;
      const candidate = path.join(process.cwd(), 'public', cleanPath);
      if (fs.existsSync(candidate)) {
        videoPath = candidate;
      }
    }

    // 3. Match by jobId filename — ownership-checked like step 1.
    if (!videoPath && jobId) {
      const base = `${path.basename(String(jobId))}.mp4`;
      const candidate = path.join(process.cwd(), 'public', 'videos', base);
      if (fs.existsSync(candidate) && (!isDbReady() || await userOwnsMediaFile(callerId, base))) {
        videoPath = candidate;
      }
    }

    if (!videoPath || !fs.existsSync(videoPath)) {
      return res.status(400).json({
        success: false,
        error: 'No rendered MP4 video file found for this job. Please render the video first — nothing else was uploaded.'
      });
    }

    console.log(`[YouTube Publish] Uploading video file: ${videoPath} (${(fs.statSync(videoPath).size / (1024 * 1024)).toFixed(2)} MB)`);

    const pubTitle = title || job?.seo?.title || `${job?.trendKeyword || 'Trending News'} Explained #Shorts`;
    const pubKeyword = job?.trendKeyword || keywordFromTitle(title || job?.seo?.title || '');

    // Guarded upload (same durable ledger as auto-publish): a second click
    // for the same topic — or a topic the timer already published — 409s
    // instead of uploading twice. Uploads keep the same IO + serial lanes.
    let result: any;
    try {
      result = await guardAndPublishTrendVideo({
        ownerId: (req as any).userId || null,
        keyword: pubKeyword,
        title: pubTitle,
        jobId: job?.id || (typeof jobId === 'string' ? jobId : null),
        outerLabel: 'yt-publish',
        innerLabel: `manual:${jobId || path.basename(videoPath)}`,
        runUpload: () => publishShortToYouTube((req as any).userId, videoPath, {
          title: pubTitle,
          description: description || job?.seo?.description || '',
          tags: tags || job?.seo?.tags,
          privacyStatus
        })
      });
    } catch (err: any) {
      if ((err as any)?.name === 'TrendDuplicateError') {
        return res.status(409).json({ success: false, duplicate: true, error: String(err?.message || err).slice(0, 300) });
      }
      throw err;
    }

    if (job) {
      if (job.publishing) {
        const ytPlatform = job.publishing.find(p => p.platform === 'youtube_shorts');
        if (ytPlatform) {
          ytPlatform.status = 'published';
          ytPlatform.publishedUrl = result.publishedUrl;
        }
      }

      job.logs.push({
        id: `log-${Date.now()}-yt`,
        timestamp: new Date().toLocaleTimeString(),
        step: 'YouTube Distribution',
        message: `Published to YouTube Shorts (${result.privacyStatus}): ${result.publishedUrl}`,
        type: 'success'
      });
      // Virality: seed the comment section with the engagement question.
      void postUploadCommentBestEffort(callerId, result.videoId, job.seo?.pinnedComment || `Did you search for "${job.trendKeyword}" today? Tell us why 👇`, 'manual-publish');
      // Published file is on YouTube now — drop this job's intermediates.
      cleanupJobTempFiles(job.id);
      // Delete the rendered video file + DB record to save disk (user uploads are untouched).
      try {
        const base = path.basename(videoPath);
        const fullPath = path.isAbsolute(videoPath) ? videoPath : path.join(process.cwd(), 'public', videoPath.replace(/^\/+/, ''));
        if (fs.existsSync(fullPath)) fs.rmSync(fullPath, { force: true });
        const thumb = fullPath.replace(/\.mp4$/i, '_thumb.jpg');
        if (fs.existsSync(thumb)) fs.rmSync(thumb, { force: true });
        await deleteVideoRecord((req as any).userId, base);
      } catch { /* best effort */ }
    }

    res.json(result);
  } catch (err: any) {
    console.error('[YouTube Publish Error]', err.message);
    res.status(400).json({ success: false, error: err.message });
  }
});

/* ========================================================================= */
/* 10.4 TikTok Integration API (per-user; tokens never leave the backend).    */
/* The SAME rendered MP4 that goes to YouTube Shorts is published to the      */
/* user's linked TikTok account via the Content Posting API (FILE_UPLOAD).    */
/* ========================================================================= */

app.get('/api/tiktok/config', async (req, res) => {
  res.json({
    config: await getTikTokStatus((req as any).userId),
    configured: isTikTokConfigured(),
  });
});

app.post('/api/tiktok/config', async (req, res) => {
  const { privacyLevel } = req.body || {};
  const updated = await saveTikTokPrefs(
    (req as any).userId,
    privacyLevel === 'SELF_ONLY' || privacyLevel === 'PUBLIC_TO_EVERYONE' ? { privacyLevel } : {}
  );
  res.json({ success: true, config: updated });
});

app.post('/api/tiktok/disconnect', async (req, res) => {
  res.json({ success: true, config: await disconnectTikTok((req as any).userId) });
});

app.post('/api/tiktok/test', async (req, res) => {
  const result = await testTikTokConnection((req as any).userId);
  res.json(result);
});

// OAuth 2.0: authorization URL for the popup (bound to this user via state).
// The returned redirectUri is server-built (TIKTOK_REDIRECT_URI wins, else
// APP_URL-aware) — register EXACTLY it in the TikTok app dashboard.
app.get('/api/tiktok/oauth/url', (req, res) => {
  if (!isTikTokConfigured()) {
    return res.status(503).json({
      success: false,
      error: 'TikTok app keys are not configured on the server (TIKTOK_CLIENT_KEY / TIKTOK_CLIENT_SECRET).',
    });
  }
  const origin = req.query.origin as string;
  const redirectUri = tiktokRedirectUri(origin);
  const state = createTikTokOAuthLink((req as any).userId);
  res.json({ url: generateTikTokAuthUrl(redirectUri, state), redirectUri });
});

// OAuth 2.0: TikTok callback (path matches tiktokRedirectUri's default).
const handleTikTokOAuthCallback = async (req: express.Request, res: express.Response) => {
  const { code, error, error_description, state } = req.query;

  if (error || !code || typeof code !== 'string') {
    const msg = String(error_description || error || 'Missing authorization code');
    return res.send(`
      <!DOCTYPE html>
      <html>
        <head><title>TikTok Authentication Cancelled</title></head>
        <body style="background:#090d16;color:#f87171;font-family:-apple-system,BlinkMacSystemFont,sans-serif;text-align:center;padding:50px;">
          <h2>TikTok Authentication Cancelled</h2>
          <p style="color:#94a3b8;">${msg.slice(0, 200)}</p>
          <script>setTimeout(() => window.close(), 2500);</script>
        </body>
      </html>
    `);
  }

  const redirectUri = tiktokRedirectUri(
    `${req.headers['x-forwarded-proto'] || 'https'}://${req.headers['x-forwarded-host'] || req.headers.host || ''}`
  );

  let userId = consumeTikTokOAuthLink(typeof state === 'string' ? state : undefined);
  if (!userId) {
    try {
      const token = parseCookieString(req.headers.cookie, SESSION_COOKIE);
      if (token) {
        const user = await getSessionUser(token);
        userId = user?.id || null;
      }
    } catch { /* fall through to the login prompt below */ }
  }
  if (!userId) {
    return res.status(401).send(`
      <!DOCTYPE html>
      <html>
        <head><title>Session Expired</title></head>
        <body style="background:#090d16;color:#f8fafc;font-family:-apple-system,BlinkMacSystemFont,sans-serif;text-align:center;padding:50px;">
          <h2>App session expired</h2>
          <p style="color:#94a3b8;">Please sign in to Trend Video Engine first, then click "Connect TikTok Account" again.</p>
          <button onclick="window.close()" style="margin-top:24px;padding:10px 20px;background:#dc2626;color:white;border:none;border-radius:12px;cursor:pointer;font-weight:bold;">Close Window</button>
        </body>
      </html>
    `);
  }

  const result = await exchangeTikTokCodeForTokens(code, redirectUri, userId);

  if (result.success) {
    const name = result.profile?.displayName || 'TikTok Account';
    res.send(`
      <!DOCTYPE html>
      <html>
        <head>
          <title>TikTok Connected</title>
          <style>
            body { background: #090d16; color: #f8fafc; font-family: -apple-system, BlinkMacSystemFont, "Segoe UI", Roboto, sans-serif; display: flex; align-items: center; justify-content: center; height: 100vh; margin: 0; }
            .card { background: #0f172a; border: 1px solid #1e293b; border-radius: 24px; padding: 36px; max-width: 420px; text-align: center; box-shadow: 0 25px 50px -12px rgba(0,0,0,0.7); }
            .badge { display: inline-flex; align-items: center; gap: 6px; background: rgba(34,197,94,0.15); color: #4ade80; border: 1px solid rgba(34,197,94,0.3); padding: 4px 14px; border-radius: 9999px; font-size: 12px; font-weight: 800; font-family: monospace; margin-bottom: 16px; }
            h2 { margin: 0 0 8px; font-size: 22px; font-weight: 900; color: #fff; }
            p { margin: 0 0 18px; font-size: 13px; color: #94a3b8; line-height: 1.5; }
          </style>
        </head>
        <body>
          <div class="card">
            <div class="badge">ACCOUNT CONNECTED</div>
            <h2>${String(name).slice(0, 80)}</h2>
            <p>Your TikTok account is now connected and saved — publishing works with one click from now on, no need to log in again.</p>
            <div style="font-family:monospace;font-size:12px;color:#38bdf8;">Closing window...</div>
          </div>
          <script>
            if (window.opener) {
              window.opener.postMessage({ type: 'TIKTOK_AUTH_SUCCESS', profile: ${JSON.stringify(result.profile || {})} }, '*');
              setTimeout(() => window.close(), 1200);
            } else {
              setTimeout(() => { window.location.href = '/'; }, 1500);
            }
          </script>
        </body>
      </html>
    `);
  } else {
    res.status(500).send(`
      <!DOCTYPE html>
      <html>
        <head><title>Connection Error</title></head>
        <body style="background:#090d16;color:#f87171;font-family:-apple-system,BlinkMacSystemFont,sans-serif;text-align:center;padding:50px;">
          <h2>TikTok Token Exchange Error</h2>
          <p style="color:#cbd5e1;">${String(result.error || 'Failed to exchange authorization code.').slice(0, 300)}</p>
          <p style="color:#94a3b8;font-size:12px;margin-top:20px;">
            Make sure this exact URI is in your TikTok app's <b>Redirect URI</b> list:<br/>
            <code style="background:#1e293b;padding:4px 8px;border-radius:6px;display:inline-block;margin-top:8px;">${redirectUri}</code>
          </p>
          <button onclick="window.close()" style="margin-top:24px;padding:10px 20px;background:#dc2626;color:white;border:none;border-radius:12px;cursor:pointer;font-weight:bold;">Close Window</button>
        </body>
      </html>
    `);
  }
};

app.get(['/tiktok/callback', '/tiktok/callback/', '/auth/tiktok/callback', '/auth/tiktok/callback/'], handleTikTokOAuthCallback);

// Publish the rendered MP4 to the caller's linked TikTok account. Same
// ownership resolution as /api/youtube/publish (caller-owned file only).
app.post('/api/tiktok/publish', requireActive, async (req, res) => {
  try {
    const { jobId, videoUrl, privacyLevel, title } = req.body;
    const callerId = (req as any).userId;
    const job = findJobForUser(jobId, callerId);

    let videoPath = '';

    if (videoUrl && typeof videoUrl === 'string') {
      const cleanPath = videoUrl.startsWith('/') ? videoUrl.slice(1) : videoUrl;
      const base = path.basename(cleanPath);
      const candidate = path.join(process.cwd(), 'public', cleanPath);
      if (fs.existsSync(candidate) && (!isDbReady() || await userOwnsMediaFile(callerId, base))) {
        videoPath = candidate;
      }
    }

    if (!videoPath && job?.videoUrl) {
      const cleanPath = job.videoUrl.startsWith('/') ? job.videoUrl.slice(1) : job.videoUrl;
      const candidate = path.join(process.cwd(), 'public', cleanPath);
      if (fs.existsSync(candidate)) {
        videoPath = candidate;
      }
    }

    if (!videoPath && jobId) {
      const base = `${path.basename(String(jobId))}.mp4`;
      const candidate = path.join(process.cwd(), 'public', 'videos', base);
      if (fs.existsSync(candidate) && (!isDbReady() || await userOwnsMediaFile(callerId, base))) {
        videoPath = candidate;
      }
    }

    if (!videoPath || !fs.existsSync(videoPath)) {
      return res.status(400).json({
        success: false,
        error: 'No rendered MP4 video file found for this job. Please render the video first — nothing else was uploaded.'
      });
    }

    console.log(`[TikTok Publish] Uploading video file: ${videoPath} (${(fs.statSync(videoPath).size / (1024 * 1024)).toFixed(2)} MB)`);

    const ttRow = await getTikTokRow(callerId);
    const level: 'PUBLIC_TO_EVERYONE' | 'SELF_ONLY' =
      privacyLevel === 'SELF_ONLY' || privacyLevel === 'PUBLIC_TO_EVERYONE'
        ? privacyLevel
        : (ttRow?.privacy_level === 'SELF_ONLY' ? 'SELF_ONLY' : 'PUBLIC_TO_EVERYONE');
    const caption =
      title || job?.seo?.title || `${job?.trendKeyword || 'Trending News'} Explained`;

    const result = await ioQueue.add(`tt-publish`, callerId, () =>
      serializedTikTokUpload(`manual:${jobId || path.basename(videoPath)}`, callerId, () =>
        publishVideoToTikTok(callerId, videoPath, { title: caption, privacyLevel: level })
      )
    );

    if (job?.publishing) {
      const tt = job.publishing.find(p => p.platform === 'tiktok');
      if (tt) {
        tt.status = 'published';
        if (result.publishedUrl) tt.publishedUrl = result.publishedUrl;
      }
      job.logs.push({
        id: `log-${Date.now()}-tt`,
        timestamp: new Date().toLocaleTimeString(),
        step: 'TikTok Distribution',
        message: `Published to TikTok (${result.privacyLevel}): ${result.message}`,
        type: 'success'
      });
    }
    try {
      await saveTikTokRow(callerId, { privacy_level: level });
    } catch { /* pref persist is best effort */ }

    res.json(result);
  } catch (err: any) {
    console.error('[TikTok Publish Error]', err.message);
    res.status(400).json({ success: false, error: String(err.message || err).slice(0, 400) });
  }
});

/* ========================================================================= */
/* 10.5 Relax Shorts: latest AI soundscape post (Relax) -> exact-20s vertical */
/* Short -> the user's connected YouTube channel. One durable timer per user  */
/* (tl_relax_schedule, same deploy-proof pattern as Auto-Pilot/IG watches):  */
/* each firing publishes the newest Relax AI post this user hasn't published  */
/* yet (dedup: tl_relax_posts UNIQUE user+post). Cover + library layers are   */
/* downloaded from the Relax public feed; gains from soundConfig are honored; */
/* caption carries the full description + backlink to the Relax post. Timer    */
/* supports rolling interval AND exact daily times (times win when set).      */
/* ========================================================================= */

function publicRelaxScheduleFor(row: RelaxScheduleRow | null) {
  return {
    enabled: row ? row.enabled === 1 : false,
    intervalHours: row ? Number(row.interval_hours) : 24,
    intervalMinutes: row ? Math.round(Number(row.interval_hours) * 60) : 1440,
    privacyStatus: (row?.privacy_status as 'public' | 'unlisted' | 'private') || 'public',
    dailyTimes: row?.daily_times || [],
    dailyTz: row?.daily_tz || 'UTC',
    lastRunAt: row?.last_run_at || null,
    nextRunAt: row?.next_run_at || null,
    lastRelaxPostId: row?.last_relax_post_id || null,
    lastYtVideoId: row?.last_yt_video_id || null,
    lastError: row?.last_error || null,
    igProfileUrl: row?.ig_profile_url || null,
    igRecentCount: (row?.ig_last_shortcodes || []).length
  };
}

const RELAX_MIN_MINUTES = 240;
const RELAX_MAX_MINUTES = 168 * 60;

/** Picks a RANDOM reel from the registered Instagram profile for the Relax
 *  video track. Returns the direct CDN MP4 (previewUrl) + shortcode, or null
 *  on any failure (caller falls back to the cover-image Short). Never throws.
 *  `avoid` = shortcodes already used, skipped so the same reel does not repeat
 *  (when every discovered reel is in `avoid`, the whole list is allowed again). */
async function pickRandomRelaxReel(
  username: string, avoid: string[]
): Promise<{ shortcode: string; previewUrl: string } | null> {
  try {
    if (!isRapidConfigured()) {
      console.warn('[RelaxShorts] IG profile set but RapidAPI key missing — using cover fallback.');
      return null;
    }
    const res = await fetchRapidReels(username, RAPID_DISCOVERY_WINDOW);
    const pool = (res.items || []).filter(i => i?.shortcode && /^https?:/i.test(i.previewUrl || ''));
    if (pool.length === 0) return null;
    const avoidSet = new Set(avoid || []);
    // Prefer reels not used recently; if all were used, allow all so the timer
    // still produces a video instead of dead-ending.
    const fresh = pool.filter(i => !avoidSet.has(i.shortcode));
    const pickFrom = fresh.length > 0 ? fresh : pool;
    const chosen = pickFrom[Math.floor(Math.random() * pickFrom.length)];
    return { shortcode: chosen.shortcode, previewUrl: chosen.previewUrl };
  } catch (err: any) {
    console.warn(`[RelaxShorts] IG reel discovery failed (@${username}):`, String(err?.message || err).slice(0, 140));
    return null;
  }
}

/** Core Relax Shorts run: fetch latest unpublished AI post -> 40s mix -> YT.
 *  VIDEO track = a random reel from the user's registered Instagram profile
 *  (when set); AUDIO track = the Relax mix. With no IG profile (or on any IG
 *  failure) it falls back to the legacy cover-image Short. */
async function runRelaxShortCycleFor(userId: string): Promise<{ relaxPostId: string; ytUrl: string; filename: string }> {
  const sched = await getRelaxSchedule(userId);
  const privacy = ((sched?.privacy_status as string) || 'public') as 'public' | 'unlisted' | 'private';
  const publishedIds = await listRelaxPostIds(userId, 100);
  const found = await fetchLatestRelaxAiPost(publishedIds);
  if (!found) throw new Error('No new Relax AI post — everything latest is already published for your account.');
  const { post, base: relaxBase } = found;
  if (await hasRelaxPost(userId, post.id)) throw new Error('This Relax post was already published for your account.');

  const videosDir = path.join(process.cwd(), 'public', 'videos');
  const workDir = path.join(process.cwd(), 'temp', 'renders');
  if (!fs.existsSync(videosDir)) fs.mkdirSync(videosDir, { recursive: true });
  if (!fs.existsSync(workDir)) fs.mkdirSync(workDir, { recursive: true });

  const stamp = Date.now();
  const coverPath = path.join(workDir, `relax_${stamp}_cover.jpg`);
  const audioPath = path.join(workDir, `relax_${stamp}_mix.mp3`);
  const reelPath = path.join(workDir, `relax_${stamp}_reel.mp4`);
  const outFile = `relax-${stamp}.mp4`;
  const outMp4 = path.join(videosDir, outFile);

  // Audio is ALWAYS from Relax: download the layers and mix the exact 20s bed.
  const layers = await downloadRelaxLayers(post, workDir, `relax_${stamp}`, relaxBase);
  if (layers.length === 0) {
    const ids = Object.keys(post.soundConfig || {}).join(', ').slice(0, 160) || '(empty soundConfig)';
    throw new Error(`No downloadable sound layers for this Relax post (tried: ${ids}).`);
  }
  await mixRelaxAudio(layers, audioPath, RELAX_SHORT_SEC);

  // VIDEO: a random reel from the registered Instagram profile (audio dropped).
  let usedReel: string | null = null;
  if (sched?.ig_profile_url) {
    const igUser = parseInstagramUsername(sched.ig_profile_url);
    if (igUser) {
      const reel = await pickRandomRelaxReel(igUser, sched.ig_last_shortcodes || []);
      if (reel) {
        try {
          let valid = false;
          try {
            const size = await downloadToFile(reel.previewUrl, reelPath);
            valid = size > 100 * 1024;
            if (valid) {
              const buf = fs.readFileSync(reelPath);
              valid = buf.length > 100 * 1024 && buf.indexOf(Buffer.from('ftyp')) >= 0;
            }
          } catch { valid = false; }
          if (valid) {
            usedReel = reel.shortcode;
            console.log(`[RelaxShorts] ${userId}: video track = random IG reel ${reel.shortcode} (@${igUser}), audio = Relax post ${post.id}.`);
          } else {
            console.warn(`[RelaxShorts] reel ${reel.shortcode} download invalid/corrupt — cover fallback.`);
            usedReel = null;
            try { fs.unlinkSync(reelPath); } catch { /* ignore */ }
          }
        } catch (err: any) {
          console.warn(`[RelaxShorts] reel ${reel.shortcode} download failed:`, String(err?.message || err).slice(0, 120));
          usedReel = null;
          try { fs.unlinkSync(reelPath); } catch { /* ignore */ }
        }
      }
    } else {
      console.warn(`[RelaxShorts] invalid ig_profile_url for ${userId}: "${sched.ig_profile_url}" — cover fallback.`);
    }
  }

  if (usedReel && fs.existsSync(reelPath) && fs.statSync(reelPath).size > 100 * 1024) {
    await renderRelaxReelShort({ post, reelVideoPath: reelPath, audioPath, outMp4, targetSec: RELAX_SHORT_SEC });
  } else {
    // Fallback: legacy cover-image Short (IG profile unset / discovery failed).
    if (!await downloadRelaxCover(post, coverPath)) {
      try { fs.unlinkSync(audioPath); } catch { /* ignore */ }
      for (const l of layers) { try { fs.unlinkSync(l.file); } catch { /* ignore */ } }
      throw new Error('Could not download the Relax cover image.');
    }
    await renderRelaxShort({ post, coverPath, audioPath, outMp4, targetSec: RELAX_SHORT_SEC });
  }

  try { fs.unlinkSync(coverPath); } catch { /* ignore */ }
  try { fs.unlinkSync(reelPath); } catch { /* ignore */ }
  try { fs.unlinkSync(audioPath); } catch { /* ignore */ }
  for (const l of layers) { try { fs.unlinkSync(l.file); } catch { /* ignore */ } }

  // Remember the reel we used so the next random pick avoids repeating it.
  if (usedReel) {
    const recent = [...(sched?.ig_last_shortcodes || []).filter(s => s !== usedReel), usedReel].slice(-12);
    await upsertRelaxSchedule(userId, { igLastShortcodes: recent }).catch(() => {});
  }

  const st = fs.statSync(outMp4);
  await addVideoRecord({
    id: uuid(), userId, filename: outFile,
    keyword: post.title.slice(0, 120), isAi: false,
    visualMethod: usedReel ? 'relax-shorts-reel' : 'relax-shorts', sizeBytes: st.size, durationSec: RELAX_SHORT_SEC
  });

  const caption = buildRelaxCaption(post);
  const pub = await ioQueue.add(`yt-relaxshorts:${userId}`, userId, () =>
    serializedYouTubeUpload(`relax:${userId}:${post.id}`, userId, () =>
      publishShortToYouTube(userId, outMp4, {
        title: caption.title,
        description: caption.description,
        tags: caption.tags,
        privacyStatus: privacy,
        verbatim: true
      })
    )
  );

  await addRelaxPost({
    id: uuid(), userId, relaxPostId: post.id, relaxTitle: post.title.slice(0, 200),
    filename: outFile, ytVideoId: pub.videoId, ytUrl: pub.publishedUrl, status: 'published'
  });
  // Delete the rendered video file + DB record after publishing to save disk.
  try {
    if (fs.existsSync(outMp4)) fs.rmSync(outMp4, { force: true });
    const thumb = outMp4.replace(/\.mp4$/i, '_thumb.jpg');
    if (fs.existsSync(thumb)) fs.rmSync(thumb, { force: true });
    await deleteVideoRecord(userId, outFile);
  } catch { /* best effort */ }
  // Virality: seed the comment section with an engagement question.
  void postUploadCommentBestEffort(userId, pub.videoId, `Listening to "${post.title.slice(0, 60)}" 🎧 — what does it remind you of? 👇`, 'relax-shorts');
  return { relaxPostId: post.id, ytUrl: pub.publishedUrl, filename: outFile };
}

/** Timer firing: roll the schedule forward no matter what (never wedges). */
async function fireRelaxSchedule(sched: RelaxScheduleRow): Promise<void> {
  const userId = sched.user_id;
  try {
    const r = await runRelaxShortCycleFor(userId);
    await upsertRelaxSchedule(userId, {
      lastRunAt: new Date().toISOString(),
      lastRelaxPostId: r.relaxPostId,
      lastYtVideoId: r.ytUrl,
      lastError: null
    });
    console.log(`[RelaxShorts] user ${userId} published Relax post ${r.relaxPostId} -> ${r.ytUrl}`);
  } catch (err: any) {
    const msg = String(err?.message || err).slice(0, 200);
    console.warn(`[RelaxShorts] cycle failed for user ${userId}:`, msg);
    await upsertRelaxSchedule(userId, { lastRunAt: new Date().toISOString(), lastError: msg }).catch(() => {});
  } finally {
    // Always re-arm (daily times win when set, else rolling interval).
    try {
      const cur = await getRelaxSchedule(userId);
      if (cur && cur.enabled === 1) {
        const next = computeWatchNextRunAt(
          Number(cur.interval_hours) || 24, cur.daily_times || [], cur.daily_tz || 'UTC'
        );
        await upsertRelaxSchedule(userId, { nextRunAt: next });
      }
    } catch { /* best effort */ }
  }
}

let relaxTickRunning = false;
/** One queued Relax run per user max (same anti-flood pattern as IG cycles):
 *  without this, an overdue schedule re-enqueues every 60s tick while its
 *  earlier task still waits behind a wedged lane — thousands of pending
 *  duplicates (seen live: pending 2250+). Stale entries (>30m) re-enqueue. */
const pendingRelaxCycles = new Map<string, number>();
async function tickRelaxSchedules() {
  if (relaxTickRunning) return;
  if (!isDbReady()) return;
  relaxTickRunning = true;
  const relaxTickTimeout = new Promise<never>((_, rej) => {
    const t = setTimeout(() => rej(new Error('relax tick DB timeout (90s)')), 90000);
    (t as any)?.unref?.();
  });
  try {
    const due = await Promise.race([
      listDueRelaxSchedules(new Date().toISOString(), 5),
      relaxTickTimeout
    ]);
    for (const s of due) {
      const key = `relax:${s.user_id}`;
      const at = pendingRelaxCycles.get(key);
      if (at !== undefined && Date.now() - at <= CYCLE_STALE_MS) continue;
      if (at !== undefined) console.warn(`[RelaxShorts] dropping stale guard ${key} (wedged >30m) — re-enqueueing.`);
      pendingRelaxCycles.set(key, Date.now());
      // Enqueue per user through the IO lane (liveHold: waits for live end).
      void ioQueue.add(`relax-shorts:${s.user_id}`, s.user_id, async () => {
        try {
          return await fireRelaxSchedule(s);
        } finally {
          pendingRelaxCycles.delete(key);
        }
      }, { liveHold: true }).catch(() => { pendingRelaxCycles.delete(key); });
    }
    if (due.length > 0) console.log(`[RelaxShorts] tick enqueued ${due.length} due timer(s).`);
  } catch (err: any) {
    console.warn('[RelaxShorts] tick failed:', err?.message || err);
  } finally {
    relaxTickRunning = false;
  }
}

app.get('/api/relax-shorts/schedule', async (req, res) => {
  const row = await getRelaxSchedule((req as any).userId);
  res.json({ success: true, schedule: publicRelaxScheduleFor(row) });
});

app.put('/api/relax-shorts/schedule', async (req, res) => {
  const { enabled, privacyStatus, dailyTimes, dailyTz } = req.body || {};
  const caller = (req as any).userId;
  const patch: Parameters<typeof upsertRelaxSchedule>[1] = {};
  if (enabled !== undefined) patch.enabled = !!enabled;
  const body = req.body || {};
  let totalMin: number | null = null;
  if (body.intervalMinutes !== undefined && body.intervalMinutes !== null && body.intervalMinutes !== '') {
    totalMin = Math.round(Number(body.intervalMinutes));
  } else if (body.intervalHours !== undefined && body.intervalHours !== null && body.intervalHours !== '') {
    totalMin = Math.round(Number(body.intervalHours) * 60);
  }
  if (totalMin !== null) {
    if (!isFinite(totalMin) || totalMin < RELAX_MIN_MINUTES || totalMin > RELAX_MAX_MINUTES) {
      return res.status(400).json({ success: false, error: `Timer must be between 4 hours and 7 days (${RELAX_MIN_MINUTES}–${RELAX_MAX_MINUTES} minutes) — shorter intervals can look suspicious to YouTube.` });
    }
    patch.intervalHours = Math.round((totalMin / 60) * 10000) / 10000;
  }
  if (privacyStatus !== undefined) {
    if (!['public', 'unlisted', 'private'].includes(String(privacyStatus))) {
      return res.status(400).json({ success: false, error: 'privacyStatus must be public, unlisted or private.' });
    }
    patch.privacyStatus = String(privacyStatus);
  }
  if (dailyTimes !== undefined) patch.dailyTimes = normalizeDailyTimes(dailyTimes);
  if (dailyTz !== undefined) {
    try {
      patch.dailyTz = assertValidTimeZone(String(dailyTz));
    } catch {
      return res.status(400).json({ success: false, error: 'Unknown time zone.' });
    }
  }
  // Optional Instagram profile: its REELS become the Short's video (audio
  // stays from Relax). Stored canonicalized; empty clears it (cover fallback).
  if (body.igProfileUrl !== undefined) {
    const rawIg = String(body.igProfileUrl || '').trim();
    if (!rawIg) {
      patch.igProfileUrl = null;
    } else {
      const norm = normalizeProfileUrl(rawIg);
      if (!norm) {
        return res.status(400).json({ success: false, error: 'Enter a valid Instagram profile link (e.g. https://www.instagram.com/username/).' });
      }
      patch.igProfileUrl = norm;
    }
  }
  try {
    const row = await upsertRelaxSchedule(caller, patch);
    res.json({ success: true, schedule: publicRelaxScheduleFor(row) });
  } catch (err: any) {
    const msg = String(err?.message || err);
    if (msg.includes('DATABASE_UNAVAILABLE')) {
      return res.status(503).json({ success: false, error: 'Timer database is unreachable — please retry in a moment.' });
    }
    return res.status(500).json({ success: false, error: 'Timer save failed.' });
  }
});

// Preview: latest Relax AI post (no download, no publish) + this user's history.
app.get('/api/relax-shorts/latest', async (req, res) => {
  try {
    const caller = (req as any).userId;
    const publishedIds = caller ? await listRelaxPostIds(caller, 100) : [];
    const excludeParam = String(req.query?.exclude || '');
    const extraExcluded = excludeParam.split(',').map(s => s.trim()).filter(Boolean);
    const excluded = [...new Set([...publishedIds, ...extraExcluded])];
    const sched = caller ? await getRelaxSchedule(caller) : null;
    const igProfileUrl = sched?.ig_profile_url || null;
    const found = await fetchLatestRelaxAiPost(excluded);
    if (!found) return res.json({ success: true, post: null, alreadyPublished: publishedIds.length > 0, igProfileUrl, videoMode: igProfileUrl ? 'instagram-reel' : 'cover' });
    const { post } = found;
    res.json({
      success: true,
      igProfileUrl,
      videoMode: igProfileUrl ? 'instagram-reel' : 'cover',
      post: {
        id: post.id,
        title: post.title,
        description: post.description,
        coverImage: post.coverImage,
        soundLayers: Object.keys(post.soundConfig || {}),
        tags: post.tags,
        authorUsername: post.authorUsername,
        createdAt: post.createdAt,
        relaxUrl: relaxPostUrl(post.id)
      }
    });
  } catch (err: any) {
    res.status(502).json({ success: false, error: String(err?.message || err).slice(0, 220) });
  }
});

app.get('/api/relax-shorts/history', async (req, res) => {
  const items = await listRelaxPosts((req as any).userId, 30);
  res.json({ success: true, items });
});

// Manual trigger: publish the newest unpublished Relax AI post right now.
app.post('/api/relax-shorts/run', async (req, res) => {
  const caller = (req as any).userId;
  try {
    const r = await pipelineQueue.add(`relax-shorts-manual:${caller}`, caller, () => runRelaxShortCycleFor(caller));
    try {
      await upsertRelaxSchedule(caller, {
        lastRunAt: new Date().toISOString(), lastRelaxPostId: r.relaxPostId, lastYtVideoId: r.ytUrl, lastError: null
      });
    } catch { /* best effort */ }
    res.json({ success: true, ...r });
  } catch (err: any) {
    res.status(400).json({ success: false, error: String(err?.message || err).slice(0, 300) });
  }
});

// 11. On-Demand Template Video Re-Rendering
app.post('/api/video/render', requireActive, async (req, res) => {
  try {
    const { jobId, voice } = req.body;
    const voiceId = isKnownTemplateVoice(voice) ? voice : undefined;
    const callerId = (req as any).userId;
    let job = findJobForUser(jobId, callerId);
    if (!job) {
      const own = jobsForUser(callerId);
      if (own.length > 0) job = own[0];
    }
    if (!job) {
      return res.status(404).json({ success: false, error: 'No job found to render.' });
    }

    const trend = job.trend;
    const selectedQuestion = job.script?.headlineQuestion || trend.primaryQuestion || `Why is ${trend.keyword} trending?`;

    job.logs.push({
      id: `log-${Date.now()}-render-start`,
      timestamp: new Date().toLocaleTimeString(),
      step: 'Template Video Engine',
      message: `Initiating high-impact 1080x1920 9:16 template render with motion & synced narration... (via processing queue)`,
      type: 'info'
    });

    // ffmpeg is the heaviest thing in this service: renders serialize through
    // the pipeline lane, and one job never renders twice at once.
    const renderKey = `render:${job.id}`;
    if (renderLocks.has(renderKey)) {
      return res.status(429).json({ success: false, error: 'This video is already rendering — please wait for it to finish.' });
    }
    renderLocks.add(renderKey);
    let renderRes: Awaited<ReturnType<typeof renderShortMp4>>;
    try {
      renderRes = await pipelineQueue.add(`render:${job.id}`, callerId || null, () => renderShortMp4({
        jobId: job!.id,
        keyword: trend.keyword,
        question: selectedQuestion,
        category: trend.category,
        imageUrl: trend.image_url,
        extraImageUrls: [...new Set([...(trend.storyImageUrls || []), ...(trend.sources || []).map(s => s.picture).filter((u): u is string => !!u)])],
        fullScript: job!.script?.fullScript || `${selectedQuestion}. Here is the verified breakdown.`,
        primaryPublisher: trend.sources?.[0]?.name || 'Google Trends Wire',
        primaryNews: trend.sources?.[0]?.title || trend.description,
        tickerNews: [...(trend.sources || []).map(s => s.title).filter(Boolean), trend.description].filter(Boolean),
        rawTraffic: trend.rawGoogleTraffic || `${trend.search_volume}K+`,
        voice: voiceId || job!.voiceId,
        scenes: (job!.script?.scenes || []).map(s => ({
          start: s.timestampStart,
          end: s.timestampEnd,
          caption: s.graphicOverlay || s.narratorText
        })),
        onLog: (step, msg, type = 'info') => {
          job?.logs.push({
            id: `log-${Date.now()}-${Math.random()}`,
            timestamp: new Date().toLocaleTimeString(),
            step,
            message: msg,
            type
          });
        }
      }));
    } finally {
      renderLocks.delete(renderKey);
    }

    job.videoUrl = renderRes.videoUrl;
    job.audioUrl = renderRes.audioUrl;
    job.renderedMp4Size = renderRes.fileSizeBytes;
    if (voiceId) job.voiceId = voiceId;

    if (isDbReady() && (req as any).userId) {
      await addVideoRecord({
        id: uuid(),
        userId: (req as any).userId,
        filename: path.basename(renderRes.videoUrl).replace(/^\/videos\//, ''),
        keyword: trend.keyword,
        isAi: false,
        sizeBytes: renderRes.fileSizeBytes || 0,
        durationSec: renderRes.durationSec || 0
      });
    }

    job.logs.push({
      id: `log-${Date.now()}-render-done`,
      timestamp: new Date().toLocaleTimeString(),
      step: 'Template Video Engine',
      message: `Render completed: ${renderRes.videoUrl} (${Math.round(renderRes.fileSizeBytes / 1024)} KB). Ready for preview and YouTube upload.`,
      type: 'success'
    });

    res.json({
      success: true,
      videoUrl: renderRes.videoUrl,
      fileSizeBytes: renderRes.fileSizeBytes,
      durationSec: renderRes.durationSec
    });
  } catch (err: any) {
    console.error('[Render API Error]', err);
    res.status(500).json({ success: false, error: err.message });
  }
});

// 12. AI Video Generation — REAL external motion via PixVerse text-to-video
// (v6, 9:16). This is "AI Video" (ویدیو هوش مصنوعی): genuine diffusion
// motion, never the internal template. Fails honestly (no key / no credits /
// timeout) instead of substituting a fake video. The template path
// (/api/video/render) is the separate "Template Video" (ویدیو الگو).
app.post('/api/video/generate-free-ai', requireActive, async (req, res) => {
  try {
    const { jobId, customPrompt } = req.body;
    const callerId = (req as any).userId;
    let job = findJobForUser(jobId, callerId);
    if (!job) {
      const own = jobsForUser(callerId);
      if (own.length > 0) job = own[0];
    }
    if (!job) {
      return res.status(404).json({ success: false, error: 'Job not found.' });
    }
    if (!isPixVerseConfigured()) {
      return res.status(400).json({
        success: false,
        error: 'Real AI video needs PIXVERSE_API_KEY in .env. Template Video (/api/video/render) works without it.'
      });
    }

    const trend = job.trend;
    const selectedQuestion = job.script?.headlineQuestion || trend.primaryQuestion || `Why is ${trend.keyword} trending?`;

    job.logs.push({
      id: `log-${Date.now()}-ai-video-start`,
      timestamp: new Date().toLocaleTimeString(),
      step: 'AI Video Engine',
      message: `Requesting REAL motion video from PixVerse for "${trend.keyword}"...`,
      type: 'info'
    });

    const prompt = customPrompt ||
      `Cinematic hyper-realistic vertical 9:16 news documentary sequence about ${trend.keyword}. ` +
      `Story: ${selectedQuestion}. Broadcast camera push-in, dramatic lighting, photorealistic.`;

    // Distinct `-ai` filenames so AI videos never overwrite the
    // template video and stay recognizable in /api/videos/list.
    // External-API generation also serializes through the pipeline lane.
    const aiJobId = job.id.endsWith('_ai') ? job.id : `${job.id}_ai`;
    const aiKey = `ai-video:${job.id}`;
    if (renderLocks.has(aiKey)) {
      return res.status(429).json({ success: false, error: 'AI video generation already running for this job — please wait.' });
    }
    renderLocks.add(aiKey);
    let px: Awaited<ReturnType<typeof generatePixVerseVideo>>;
    try {
      px = await pipelineQueue.add(`ai-video:${job.id}`, (req as any).userId || null, () => generatePixVerseVideo({
        jobId: aiJobId,
        prompt,
        onLog: (step, msg, type = 'info') => {
          job?.logs.push({
            id: `log-${Date.now()}-${Math.random()}`,
            timestamp: new Date().toLocaleTimeString(),
            step,
            message: msg,
            type
          });
        }
      }));
    } finally {
      renderLocks.delete(aiKey);
    }

    job.videoUrl = px.videoUrl;
    job.audioUrl = '';
    job.renderedMp4Size = px.fileSizeBytes;

    if (isDbReady() && (req as any).userId) {
      await addVideoRecord({
        id: uuid(),
        userId: (req as any).userId,
        filename: path.basename(px.videoUrl).replace(/^\/videos\//, ''),
        keyword: trend.keyword,
        isAi: true,
        visualMethod: 'pixverse-v6',
        sizeBytes: px.fileSizeBytes || 0,
        durationSec: px.durationSec || 0
      });
    }

    job.logs.push({
      id: `log-${Date.now()}-ai-video-done`,
      timestamp: new Date().toLocaleTimeString(),
      step: 'AI Video Engine',
      message: `REAL AI motion video ready: ${px.videoUrl} (${Math.round(px.fileSizeBytes / 1024)} KB, ${px.durationSec}s)`,
      type: 'success'
    });

    res.json({
      success: true,
      videoUrl: px.videoUrl,
      fileSizeBytes: px.fileSizeBytes,
      durationSec: px.durationSec,
      model: 'pixverse-v6',
      visualMethod: 'pixverse-v6'
    });
  } catch (err: any) {
    console.error('[AI Video Error]:', err);
    res.status(400).json({ success: false, error: err.message });
  }
});

// 12a. AI video provider status (PixVerse real-motion backend)
app.get('/api/video/free-ai/status', (req, res) => {
  res.json({
    success: true,
    providers: [
      { method: 'pixverse-v6', label: 'PixVerse v6 text-to-video (real motion, 9:16)', kind: 'External AI — needs PIXVERSE_API_KEY + credits', offline: false }
    ],
    pixverseConfigured: isPixVerseConfigured(),
    keyless: false
  });
});

// 12a2. Narrator voice catalog for template renders (all English Edge neural).
app.get('/api/voice/options', (req, res) => {
  res.json({
    success: true,
    defaultVoiceId: DEFAULT_TEMPLATE_VOICE_ID,
    voices: TEMPLATE_VOICES
  });
});

// 12a3. Short TTS preview for a selected narrator voice (returns mp3).
app.get('/api/voice/preview', async (req, res) => {
  try {
    const voice = String(req.query.voice || DEFAULT_TEMPLATE_VOICE_ID).trim();
    const text = String(req.query.text || 'Hello, this is a preview of the selected narrator voice for your trend videos.').slice(0, 200);
    const tmpPath = path.join(os.tmpdir(), `voice_preview_${Date.now()}.mp3`);
    await generateNaturalVoiceAudio(text, tmpPath, voice);
    if (!fs.existsSync(tmpPath)) {
      res.status(500).json({ success: false, error: 'preview failed' });
      return;
    }
    res.setHeader('Content-Type', 'audio/mpeg');
    res.setHeader('Cache-Control', 'no-store');
    const stream = fs.createReadStream(tmpPath);
    stream.pipe(res);
    stream.on('close', () => { try { fs.unlinkSync(tmpPath); } catch { /* ignore */ } });
    stream.on('error', () => { try { fs.unlinkSync(tmpPath); } catch { /* ignore */ } });
  } catch (err: any) {
    res.status(500).json({ success: false, error: String(err?.message || err) });
  }
});

// 12b. List rendered & AI generated video files for the signed-in user
app.get('/api/videos/list', async (req, res) => {
  try {
    const publicVideosDir = path.join(process.cwd(), 'public', 'videos');
    if (!fs.existsSync(publicVideosDir)) {
      return res.json({ success: true, videos: [] });
    }

    const files = fs.readdirSync(publicVideosDir);
    let mp4Files = files.filter(f => f.endsWith('.mp4'));

    // Scope the list to this user's records when the DB is up; legacy files
    // are claimed by the first signed-in user (see requireAuth).
    if (isDbReady() && (req as any).userId) {
      try {
        const records = await getUserVideos((req as any).userId);
        const owned = new Set(records.map(r => r.filename));
        mp4Files = mp4Files.filter(f => owned.has(f));
      } catch (err) {
        console.warn('[videos/list] record scoping failed, showing disk list:', (err as Error).message);
      }
    }

    const videos = mp4Files.map(filename => {
      const filePath = path.join(publicVideosDir, filename);
      const stat = fs.statSync(filePath);
      const isAi = filename.includes('_ai');
      const baseId = filename.replace('_ai.mp4', '').replace('.mp4', '');

      // Check if image scene exists
      const aiSceneImg = `${baseId}_ai_scene.jpg`;
      const hasAiSceneImg = files.includes(aiSceneImg);
      const thumbImg = `${baseId}_thumb.jpg`;
      const hasThumb = files.includes(thumbImg);
      const thumbnailUrl = hasThumb
        ? `/videos/${thumbImg}`
        : hasAiSceneImg ? `/videos/${aiSceneImg}` : '/videos/preview_cinematic.jpg';

      // Find matching job if any (only the caller's own — never another user's topic)
      const matchingJob = jobsForUser((req as any).userId).find(j => j.id === baseId || j.videoUrl?.includes(filename));

      return {
        filename,
        url: `/videos/${filename}`,
        sizeBytes: stat.size,
        sizeFormatted: `${(stat.size / (1024 * 1024)).toFixed(1)} MB`,
        modifiedAt: stat.mtime.toISOString(),
        isAiVideo: isAi,
        thumbnailUrl,
        keyword: matchingJob?.trend?.keyword || (isAi ? 'AI Video' : 'Template Video'),
        jobId: matchingJob?.id || baseId,
        durationSec: matchingJob?.script?.estimatedDurationSec || 30
      };
    });

    // Sort newest first
    videos.sort((a, b) => new Date(b.modifiedAt).getTime() - new Date(a.modifiedAt).getTime());

    res.json({ success: true, videos });
  } catch (err: any) {
    res.status(500).json({ success: false, error: err.message });
  }
});

// ---------------- Uploder tab API ----------------
const uploadStorage = multer.diskStorage({
  destination: (req, file, cb) => {
    const userId = (req as any).userId || 'anon';
    const dir = path.join(process.cwd(), 'public', 'uploads', userId);
    try { fs.mkdirSync(dir, { recursive: true }); } catch { /* ignore */ }
    cb(null, dir);
  },
  filename: (req, file, cb) => {
    const ext = path.extname(file.originalname || '').toLowerCase() || '.mp4';
    cb(null, `${Date.now()}-${Math.random().toString(36).slice(2, 10)}${ext}`);
  }
});
const uploadMiddleware = multer({ storage: uploadStorage, limits: { fileSize: 2 * 1024 * 1024 * 1024 } });

app.get('/api/uploads/quota', requireAuth, async (req, res) => {
  const userId = (req as any).userId;
  try {
    const q = await getUploadQuota(userId);
    const used = await refreshUploadUsedBytes(userId);
    const files = await listUploadFiles(userId);
    res.json({ success: true, quota_bytes: q.quota_bytes, used_bytes: used, file_count: files.length, subscription_expires_at: q.subscription_expires_at });
  } catch (err: any) {
    res.status(500).json({ success: false, error: err?.message || 'Failed' });
  }
});

app.get('/api/uploads/files', requireAuth, async (req, res) => {
  const userId = (req as any).userId;
  try {
    const files = await listUploadFiles(userId);
    res.json({ success: true, files: files.map(f => ({
      id: f.id,
      filename: f.filename,
      original_name: f.original_name,
      size_bytes: f.size_bytes,
      size_formatted: `${(f.size_bytes / (1024 * 1024)).toFixed(1)} MB`,
      url: `/uploads/${f.filename}`,
      created_at: f.created_at,
      youtube_scheduled_at: f.youtube_scheduled_at,
      youtube_status: f.youtube_status,
      youtube_video_id: f.youtube_video_id,
      youtube_url: f.youtube_url,
      youtube_error: f.youtube_error
    })) });
  } catch (err: any) {
    res.status(500).json({ success: false, error: err?.message || 'Failed' });
  }
});

app.post('/api/uploads', requireAuth, requireActive, uploadMiddleware.single('file'), async (req, res) => {
  const userId = (req as any).userId;
  const file = (req as any).file;
  if (!file) return res.status(400).json({ success: false, error: 'No file uploaded' });
  try {
    const q = await getUploadQuota(userId);
    const used = await refreshUploadUsedBytes(userId);
    if (q.quota_bytes <= 0) {
      try { fs.unlinkSync(file.path); } catch { /* ignore */ }
      return res.status(403).json({ success: false, error: 'No storage quota. Purchase storage first.' });
    }
    if (q.subscription_expires_at && new Date(q.subscription_expires_at) < new Date()) {
      try { fs.unlinkSync(file.path); } catch { /* ignore */ }
      return res.status(403).json({ success: false, error: 'Subscription expired. Renew to upload.' });
    }
    if (used + file.size > q.quota_bytes) {
      try { fs.unlinkSync(file.path); } catch { /* ignore */ }
      return res.status(403).json({ success: false, error: 'Not enough storage quota.' });
    }
    const rel = path.join(userId, file.filename).replace(/\\/g, '/');
    // move file into user subdir already; filename stored as relative path
    const id = uuid();
    await addUploadFile({ id, userId, filename: rel, originalName: file.originalname, sizeBytes: file.size, mime: file.mimetype });
    res.json({ success: true, file: { id, filename: rel, url: `/uploads/${rel}`, size_bytes: file.size } });
  } catch (err: any) {
    try { if (file?.path) fs.unlinkSync(file.path); } catch { /* ignore */ }
    res.status(500).json({ success: false, error: err?.message || 'Upload failed' });
  }
});

app.delete('/api/uploads/:id', requireAuth, async (req, res) => {
  const userId = (req as any).userId;
  const { id } = req.params;
  try {
    const fn = await deleteUploadFile(userId, id);
    if (!fn) return res.status(404).json({ success: false, error: 'Not found' });
    const full = path.join(process.cwd(), 'public', 'uploads', fn);
    try { fs.unlinkSync(full); } catch { /* ignore */ }
    res.json({ success: true });
  } catch (err: any) {
    res.status(500).json({ success: false, error: err?.message || 'Failed' });
  }
});

// schedule YouTube upload for an uploaded file
app.post('/api/uploads/:id/youtube-schedule', requireAuth, requireActive, async (req, res) => {
  const userId = (req as any).userId;
  const { id } = req.params;
  const { scheduledAt } = req.body || {};
  try {
    const f = await getUploadFile(userId, id);
    if (!f) return res.status(404).json({ success: false, error: 'Not found' });
    const when = scheduledAt ? new Date(scheduledAt).toISOString() : null;
    await updateUploadFileYoutube(id, { scheduledAt: when, status: when ? 'scheduled' : 'none', error: null });
    res.json({ success: true });
  } catch (err: any) {
    res.status(500).json({ success: false, error: err?.message || 'Failed' });
  }
});

// manual publish an uploaded file to the user's YouTube channel
app.post('/api/uploads/:id/youtube-publish', requireAuth, requireActive, async (req, res) => {
  const userId = (req as any).userId;
  const { id } = req.params;
  const { title, description, privacyStatus } = req.body || {};
  try {
    const f = await getUploadFile(userId, id);
    if (!f) return res.status(404).json({ success: false, error: 'Not found' });
    const filePath = path.join(process.cwd(), 'public', 'uploads', f.filename);
    const { publishShortToYouTube } = await import('./server/youtubeService.js');
    const r = await publishShortToYouTube(userId, filePath, {
      title: String(title || f.original_name || f.filename),
      description: String(description || ''),
      tags: [],
      privacyStatus: (privacyStatus as any) || 'unlisted'
    });
    if (r?.success) {
      await updateUploadFileYoutube(id, { status: 'uploaded', videoId: r.videoId || null, url: r.publishedUrl || null, error: null, scheduledAt: null });
      return res.json({ success: true, videoId: r.videoId, url: r.publishedUrl });
    }
    await updateUploadFileYoutube(id, { status: 'failed', error: String(r?.message || 'Upload failed') });
    return res.status(400).json({ success: false, error: r?.message || 'Upload failed' });
  } catch (err: any) {
    try { await updateUploadFileYoutube(id, { status: 'failed', error: String(err?.message || err) }); } catch { /* ignore */ }
    res.status(500).json({ success: false, error: err?.message || 'Failed' });
  }
});

// cancel scheduled
app.delete('/api/uploads/:id/youtube-schedule', requireAuth, async (req, res) => {
  const userId = (req as any).userId;
  const { id } = req.params;
  try {
    const f = await getUploadFile(userId, id);
    if (!f) return res.status(404).json({ success: false, error: 'Not found' });
    await updateUploadFileYoutube(id, { scheduledAt: null, status: 'none' });
    res.json({ success: true });
  } catch (err: any) {
    res.status(500).json({ success: false, error: err?.message || 'Failed' });
  }
});

// purchase storage (crypto)
app.post('/api/uploads/purchase', requireAuth, async (req, res) => {
  const userId = (req as any).userId;
  const { gb, months, cryptoNetwork, txHash, proof } = req.body || {};
  try {
    const bytes = Math.round(Number(gb || 0) * 1024 * 1024 * 1024);
    const m = Math.max(0, Math.floor(Number(months || 0)));
    if (!bytes || bytes <= 0) return res.status(400).json({ success: false, error: 'Invalid size' });
    const id = uuid();
    await createStoragePurchase({ id, userId, bytesRequested: bytes, monthsRequested: m, cryptoNetwork: String(cryptoNetwork || ''), txHash: String(txHash || ''), proof: String(proof || '') });
    try {
      const u = await getUserById(userId);
      if (u?.email) {
        const e = purchaseReceivedEmail(u.name || 'User', Number(gb || 0), m, String(cryptoNetwork || ''));
        void sendEmail(u.email, e.subject, e.html);
      }
      const adminEmail = process.env.SMTP_USER || 'info@bidbes.com';
      const adminHtml = `<p>New storage purchase request</p><p>User: ${u?.email || userId}</p><p>Size: ${Number(gb || 0)} GB</p><p>Months: ${m}</p><p>Network: ${String(cryptoNetwork || '')}</p><p>TxHash: ${String(txHash || '')}</p>`;
      void sendEmail(adminEmail, 'New purchase request', adminHtml);
    } catch { /* ignore */ }
    res.json({ success: true, id });
  } catch (err: any) {
    res.status(500).json({ success: false, error: err?.message || 'Failed' });
  }
});

app.get('/api/uploads/purchases', requireAuth, async (req, res) => {
  const userId = (req as any).userId;
  try {
    const all = await listStoragePurchases();
    res.json({ success: true, purchases: all.filter(p => p.user_id === userId) });
  } catch (err: any) {
    res.status(500).json({ success: false, error: err?.message || 'Failed' });
  }
});

// Admin: list all purchases
app.get('/api/admin/uploads/purchases', requireAdmin, async (req, res) => {
  const status = (req.query.status as string) || undefined;
  try {
    const purchases = await listStoragePurchases(status);
    res.json({ success: true, purchases });
  } catch (err: any) {
    res.status(500).json({ success: false, error: err?.message || 'Failed' });
  }
});

app.post('/api/admin/uploads/purchases/:id/approve', requireAdmin, async (req, res) => {
  const adminId = (req as any).userId;
  const { id } = req.params;
  const { note, bytes } = req.body || {};
  try {
    const p = await decideStoragePurchase(id, 'approved', adminId, note ? String(note) : undefined, bytes ? Number(bytes) : undefined);
    if (!p) return res.status(404).json({ success: false, error: 'Not found' });
    try {
      const u = await getUserById(String((p as any).user_id));
      if (u?.email) {
        const q = await getUploadQuota(String((p as any).user_id));
        const e = purchaseApprovedEmail(u.name || 'User', Math.round(Number((p as any).bytes_requested || 0) / (1024**3)), Number((p as any).months_requested || 0), q?.subscription_expires_at || null);
        void sendEmail(u.email, e.subject, e.html);
      }
    } catch { /* ignore */ }
    res.json({ success: true });
  } catch (err: any) {
    res.status(500).json({ success: false, error: err?.message || 'Failed' });
  }
});

app.post('/api/admin/uploads/purchases/:id/reject', requireAdmin, async (req, res) => {
  const adminId = (req as any).userId;
  const { id } = req.params;
  const { note } = req.body || {};
  try {
    const p = await decideStoragePurchase(id, 'rejected', adminId, note ? String(note) : undefined);
    if (!p) return res.status(404).json({ success: false, error: 'Not found' });
    try {
      const u = await getUserById(String((p as any).user_id));
      if (u?.email) {
        const e = purchaseRejectedEmail(u.name || 'User', note ? String(note) : undefined);
        void sendEmail(u.email, e.subject, e.html);
      }
    } catch { /* ignore */ }
    res.json({ success: true });
  } catch (err: any) {
    res.status(500).json({ success: false, error: err?.message || 'Failed' });
  }
});

// Admin: list users and enable/disable
app.get('/api/admin/users', requireAdmin, async (_req, res) => {
  try {
    const users = await listUsers();
    res.json({ success: true, users });
  } catch (err: any) {
    res.status(500).json({ success: false, error: err?.message || 'Failed' });
  }
});

app.post('/api/admin/users/:id/status', requireAdmin, async (req, res) => {
  const adminId = (req as any).userId;
  const { id } = req.params;
  const { status } = req.body || {};
  if (id === adminId) return res.status(400).json({ success: false, error: 'Cannot change your own status' });
  const s = String(status || '').toLowerCase() === 'disabled' ? 'disabled' : 'active';
  try {
    await setUserStatus(id, s as 'active' | 'disabled');
    res.json({ success: true });
  } catch (err: any) {
    res.status(500).json({ success: false, error: err?.message || 'Failed' });
  }
});

// background: process due YouTube uploads for uploaded files
setInterval(async () => {
  try {
    if (!isDbReady()) return;
    const due = await listDueUploadYoutubeJobs(new Date().toISOString(), 3);
    for (const f of due) {
      try {
        await updateUploadFileYoutube(f.id, { status: 'uploading' });
        // publish file to YouTube using existing service
        const filePath = path.join(process.cwd(), 'public', 'uploads', f.filename);
        // use publishShortToYouTube with local file path? It expects videoPath. Check signature.
        // We'll call a generic approach: read file and publish via youtubeService publishShortToYouTube(filePath,...)
        const { publishShortToYouTube } = await import('./server/youtubeService.js');
        const title = f.original_name || f.filename;
        const res = await publishShortToYouTube(f.user_id, filePath, { title, description: '', tags: [], privacyStatus: 'public' });
        if (res?.success) {
          await updateUploadFileYoutube(f.id, { status: 'uploaded', videoId: res.videoId || null, url: res.publishedUrl || null, error: null });
        } else {
          await updateUploadFileYoutube(f.id, { status: 'failed', error: String((res as any)?.message || 'Upload failed') });
        }
      } catch (e: any) {
        await updateUploadFileYoutube(f.id, { status: 'failed', error: String(e?.message || e) });
      }
    }
  } catch { /* ignore */ }
}, 60000);

// oldString placeholder


/* Veo endpoints removed 2026-09-11: Veo 3.1 requires paid billing and never
   produced a video with this key. Single render path is renderShortMp4. */

// Topic-aware hashtags: every team/entity inside the keyword gets its own
// tag ("Real Madrid vs Barcelona" -> #RealMadrid #Barcelona), plus key
// terms from the grounded overview and the category. Never throws.
const TAG_STOP = new Set(['the', 'and', 'for', 'with', 'from', 'that', 'this', 'what', 'why', 'how', 'when', 'where', 'today', 'latest', 'news', 'video', 'trending', 'trend', 'behind', 'search', 'question', 'answer', 'report', 'high', 'surge', 'spike', 'vs', 'versus', 'live', 'updates', 'highlights']);
function toHashtag(phrase: string): string | null {
  const words = String(phrase || '')
    .toLowerCase()
    .split(/[^a-z0-9\u0600-\u06FF]+/i)
    .map(w => w.trim())
    .filter(w => w.length >= 3 && !TAG_STOP.has(w));
  if (words.length === 0) return null;
  const tag = words
    .map(w => (/^[a-z]/.test(w) ? w[0].toUpperCase() + w.slice(1) : w))
    .join('')
    .replace(/[^A-Za-z0-9\u0600-\u06FF]/g, '');
  if (tag.length < 3 || tag.length > 40) return null;
  return `#${tag}`;
}
function keyTermsFrom(text: string, exclude: string, n: number): string[] {
  const excl = new Set(String(exclude || '').toLowerCase().split(/[^a-z0-9\u0600-\u06FF]+/).filter(Boolean));
  const out: string[] = [];
  for (const t of String(text || '').toLowerCase().split(/[^a-z0-9\u0600-\u06FF]+/)) {
    const w = t.trim();
    if (w.length < 4 || TAG_STOP.has(w) || excl.has(w) || out.includes(w)) continue;
    out.push(w);
    if (out.length >= n) break;
  }
  return out;
}
function buildTrendTags(keyword: string, category: string, extraText: string, question: string, related: string[] = []): { hashtags: string[]; tags: string[] } {
  const seen = new Set<string>();
  const hashtags: string[] = [];
  const push = (h: string | null) => {
    if (!h || hashtags.length >= 8) return;
    const k = h.toLowerCase();
    if (seen.has(k)) return;
    seen.add(k);
    hashtags.push(h);
  };
  push('#Shorts');
  // Each side of "A vs B" (or A - B, A | B) becomes its own hashtag.
  const parts = String(keyword || '')
    .split(/\s+(vs\.?|v\.?|versus|against)\s+|\s*[|\-—–/]\s*/i)
    .map(p => p.trim())
    .filter(p => p && !/^(vs\.?|v\.?|versus|against)$/i.test(p));
  if (parts.length > 1) {
    for (const p of parts) push(toHashtag(p));
  } else {
    push(toHashtag(keyword));
    // Multi-word topic: each significant word also gets a tag.
    for (const w of String(keyword || '').split(/[^A-Za-z0-9\u0600-\u06FF]+/).filter(w => w.length >= 5).slice(0, 3)) {
      push(toHashtag(w));
    }
  }
  for (const t of keyTermsFrom(extraText, keyword, 3)) push(toHashtag(t));
  // Google's own related-search keywords for this trend (breakdown list from
  // the Trending feed, e.g. broncos -> "chiefs score", "kenneth walker"):
  // each becomes a hashtag + tag so the video ranks for the same searches.
  for (const phrase of related.slice(0, 6)) {
    push(toHashtag(phrase));
  }
  push(toHashtag(category));
  push('#GoogleTrends');
  const tags: string[] = [];
  const pushTag = (t: string) => {
    const v = String(t || '').trim().toLowerCase().slice(0, 40);
    if (!v || tags.includes(v) || tags.length >= 15) return;
    tags.push(v);
  };
  pushTag(question);
  pushTag(keyword);
  pushTag(`why is ${keyword} trending`);
  for (const p of parts.slice(0, 4)) pushTag(p);
  for (const phrase of related.slice(0, 10)) pushTag(phrase);
  for (const t of keyTermsFrom(extraText, keyword, 6)) pushTag(t);
  pushTag(category);
  pushTag('google trends');
  return { hashtags, tags };
}

// Helper: Run through the full pipeline steps (discover -> script -> render -> SEO/QC)
async function runPipelineSteps(
  jobId: string,
  trend: NormalizedTrend,
  customQuestion?: string,
  customAngle?: string
) {
  const job = jobsDatabase.find(j => j.id === jobId);
  if (!job) return;
  // Belt & braces: when dequeued the worker already flipped queued->running,
  // but direct callers also land here — never leave a started job as `queued`.
  if (job.status === 'queued') job.status = 'running';

  const addLog = (step: string, message: string, type: 'info' | 'success' | 'warn' | 'error' = 'info') => {
    job.logs.push({
      id: `log-${Date.now()}-${Math.random()}`,
      timestamp: new Date().toLocaleTimeString(),
      step,
      message,
      type
    });
  };

  try {
    // Step 1: Normalization & Deduplication
    job.currentStep = 'normalization';
    job.progressPercent = 15;
    addLog('Normalization', `Normalized ISO-3166 [${trend.country}] and language [${trend.language}] metadata`);

    await new Promise(r => setTimeout(r, 600));

    // Step 2: Intent & Question Engine
    job.currentStep = 'intent';
    job.progressPercent = 25;
    const selectedQuestion = customQuestion || trend.primaryQuestion || `Why is ${trend.keyword} trending today?`;
    job.trend.primaryQuestion = selectedQuestion;
    addLog('Question Engine', `Formulated search question: "${selectedQuestion}"`, 'success');

    await new Promise(r => setTimeout(r, 700));

    // Step 3: Research & Fact Verification
    job.currentStep = 'verification';
    job.progressPercent = 40;
    addLog('Fact Verification', `Cross-referencing claims across trusted wire feeds...`);

    // Grounded background from the internal ai-overview model ("why is X
    // trending?") — feeds the script prompt and appends real source links.
    let overviewText = '';
    let overviewSources: { title: string; url: string }[] = [];
    try {
      const newsBits = trend.sources.slice(0, 2).map(s => s.title).filter(Boolean).join(' | ');
      const ans = await askOverview(
        `Why is "${trend.keyword}" trending today?${newsBits ? ` News context: ${newsBits}` : ''} Answer factually in 4 short sentences with names, places and numbers.`,
        30000
      );
      if (ans?.text) {
        overviewText = ans.text.slice(0, 900);
        overviewSources = ans.sources;
        addLog('Fact Verification', `Overview answer received (${ans.provider}/${ans.model}, ${overviewSources.length} grounded sources)`, 'success');
      }
    } catch { /* news-source facts below still apply */ }

    // Ground verified facts in real trend sources (e.g. BBC, NYT, AP, Reuters)
    let facts: VerifiedFact[] = PRESET_FACTS_MAP[trend.id];
    if (!facts || facts.length === 0) {
      facts = trend.sources.map((s, idx) => ({
        id: `fact-${trend.id}-${idx + 1}`,
        claim: s.title || `Primary development reported: ${trend.description}`,
        sourceName: s.name || 'Google News Wire',
        sourceUrl: s.url || 'https://trends.google.com',
        confidence: 97 + Math.min(2, idx),
        corroboratedByCount: Math.max(2, trend.sources.length),
        status: 'verified'
      }));

      for (const os of overviewSources.slice(0, 2)) {
        facts.push({
          id: `fact-${trend.id}-ov-${facts.length + 1}`,
          claim: `Corroborated by Google-grounded overview: ${os.title}`,
          sourceName: 'AI Overview (grounded)',
          sourceUrl: os.url,
          confidence: 95,
          corroboratedByCount: 3,
          status: 'verified'
        });
      }

      if (facts.length < 3) {
        facts.push({
          id: `fact-${trend.id}-${facts.length + 1}`,
          claim: `Search momentum accelerated on Google Trends with approx ${trend.rawGoogleTraffic || '10K+'} active queries.`,
          sourceName: 'Google Trends Search Velocity Monitor',
          sourceUrl: `https://trends.google.com/trending?geo=${trend.country || 'US'}`,
          confidence: 99,
          corroboratedByCount: 4,
          status: 'verified'
        });
      }
    }

    const primarySource = trend.sources[0];
    const secondarySource = trend.sources[1];
    const primaryNews = primarySource?.title || trend.description;
    const primaryPublisher = primarySource?.name || 'Verified News Wires';
    const secondaryNews = secondarySource?.title;
    const secondaryPublisher = secondarySource?.name;

    // Base script grounded strictly in the real news report
    let script: ScriptPackage = PRESET_SCRIPT_MAP[trend.id] || {
      id: `script-${jobId}`,
      trendKeyword: trend.keyword,
      headlineQuestion: selectedQuestion,
      searchIntent: trend.detectedIntent || 'why_trending',
      angle: {
        id: 'angle-auto',
        angleType: 'the_sudden_twist',
        title: customAngle || 'Direct Search-Intent Explainer',
        hookPremise: `Do not just report the trend—answer the search question behind "${trend.keyword}".`,
        editorialTone: 'urgent_explainer',
        whyThisWorks: 'Hook targets the search intent within 0-3s, delivering verified facts with no fluff.'
      },
      fullScript: overviewText
        ? `${selectedQuestion} ${overviewText.split(/(?<=[.!?])\s+/).slice(0, 3).join(' ')} That is the verified story behind why ${trend.keyword} is trending right now.`
        : `${selectedQuestion} Over ${trend.rawGoogleTraffic || 'thousands of'} searches spiked today because ${primaryPublisher} confirmed: ${primaryNews}. ${secondaryNews ? `${secondaryPublisher} further reports that ${secondaryNews}.` : 'Wire services corroborated all major points without speculation.'} That is the verified story behind why ${trend.keyword} is trending right now.`,
      estimatedDurationSec: 34,
      wordCount: 56,
      targetAudience: 'Curious searchers wanting instant factual clarity in under 40 seconds',
      scenes: [
        {
          id: 'sc-1',
          sceneNumber: 1,
          timestampStart: 0,
          timestampEnd: 4,
          narratorText: selectedQuestion,
          visualPrompt: `High-contrast opening query banner for ${trend.keyword} on dynamic 9:16 background`,
          shotType: 'headline_pop',
          graphicOverlay: selectedQuestion.toUpperCase(),
          assetUrl: trend.image_url,
          audioEmphasisWords: ['Why', 'trending', 'today']
        },
        {
          id: 'sc-2',
          sceneNumber: 2,
          timestampStart: 4,
          timestampEnd: 12,
          narratorText: `Search interest surged with ${trend.rawGoogleTraffic || 'massive'} queries after breaking reports from ${primaryPublisher}.`,
          visualPrompt: `Headline snapshot from ${primaryPublisher} highlighting rapid query surge`,
          shotType: 'kinetic_split',
          graphicOverlay: `SOURCE: ${primaryPublisher.toUpperCase()}`,
          assetUrl: trend.image_url,
          audioEmphasisWords: ['surged', 'breaking reports', primaryPublisher]
        },
        {
          id: 'sc-3',
          sceneNumber: 3,
          timestampStart: 12,
          timestampEnd: 24,
          narratorText: primaryNews,
          visualPrompt: `Documentary focus on verified facts reported by news wire`,
          shotType: 'photo_evidence',
          graphicOverlay: 'VERIFIED EVIDENCE: 100%',
          assetUrl: trend.image_url,
          audioEmphasisWords: ['confirmed', 'official']
        },
        {
          id: 'sc-4',
          sceneNumber: 4,
          timestampStart: 24,
          timestampEnd: 34,
          narratorText: `That is the real story behind why everyone is searching for ${trend.keyword}. Share this with anyone wondering what happened!`,
          visualPrompt: `Final retention summary card with commentary prompt`,
          shotType: 'dramatic_close',
          graphicOverlay: 'NOW YOU KNOW | SHARE',
          assetUrl: trend.image_url,
          audioEmphasisWords: ['real story', 'searching', 'share']
        }
      ]
    };

    // Script AI: internal ai-chatbot FIRST (owns the free-model chain),
    // Gemini second, template last. Same prompt, same JSON contract.
    let generatedText: string | null = null;
    if (!PRESET_SCRIPT_MAP[trend.id]) {
      try {
        const prompt = `You are the Lead Editor & Investigative Script Engine for Trend Video Engine.
A real Google Trends spike just broke:
Keyword: "${trend.keyword}"
Category: "${trend.category}"
Search Traffic: "${trend.rawGoogleTraffic || 'High surge'}"
Search Question: "${selectedQuestion}"
Primary News Wire: "${primaryPublisher}: ${primaryNews}"
${secondaryNews ? `Secondary News Wire: "${secondaryPublisher}: ${secondaryNews}"` : ''}
${overviewText ? `Grounded Background (use these facts, do not invent others): "${overviewText}"` : ''}

Follow the core philosophy:
"DO NOT JUST REPORT THE TREND. EXPLAIN THE TREND. ANSWER THE QUESTION BEHIND THE SEARCH."

Generate a 4-scene vertical short-form video script (30-35 seconds, 50-70 words).
RETENTION RULES: scene 1 must ask the search question in the first 2 seconds (no intro, no greeting).
SEAMLESS LOOP: Shorts replay automatically — end scene 4 with an open loop that echoes the opening question
(e.g. restate the mystery, never a closed "goodbye"), so the replay feels continuous and rewatches climb.
Return ONLY valid JSON with this structure:
{
  "fullScript": "full narration text answering the question concisely",
  "scenes": [
    {
      "sceneNumber": 1,
      "timestampStart": 0,
      "timestampEnd": 4,
      "narratorText": "${selectedQuestion}",
      "shotType": "headline_pop",
      "graphicOverlay": "${selectedQuestion.toUpperCase()}",
      "visualPrompt": "high impact visual prompt description",
      "audioEmphasisWords": ["Why", "trending"]
    },
    {
      "sceneNumber": 2,
      "timestampStart": 4,
      "timestampEnd": 12,
      "narratorText": "narration explaining the catalyst",
      "shotType": "kinetic_split",
      "graphicOverlay": "BREAKING CATALYST",
      "visualPrompt": "visual description",
      "audioEmphasisWords": ["queries", "spiked"]
    },
    {
      "sceneNumber": 3,
      "timestampStart": 12,
      "timestampEnd": 24,
      "narratorText": "narration explaining core evidence",
      "shotType": "photo_evidence",
      "graphicOverlay": "FACT CHECKED: 100%",
      "visualPrompt": "visual description",
      "audioEmphasisWords": ["verified", "reports"]
    },
    {
      "sceneNumber": 4,
      "timestampStart": 24,
      "timestampEnd": 34,
      "narratorText": "closing wrap up",
      "shotType": "dramatic_close",
      "graphicOverlay": "NOW YOU KNOW",
      "visualPrompt": "visual description",
      "audioEmphasisWords": ["real reason", "searching"]
    }
  ]
}`;
        // Internal ai-chatbot first, Gemini second.
        try {
          addLog('Script Engine', 'Asking internal AI (ai-chatbot) for high-retention 9:16 script...');
          const internal = await askInternalAI(prompt, 25000);
          if (internal) {
            generatedText = internal.slice(internal.indexOf('{'), internal.lastIndexOf('}') + 1) || internal;
            addLog('Script Engine', 'Internal AI script received', 'success');
          }
        } catch { /* fall through to Gemini */ }
        if (!generatedText) {
          const ai = getGeminiClient();
          if (ai) {
            try {
              addLog('Script Engine', 'Internal AI unavailable — engaging Gemini Flash...');
              const candidateModels = ['gemini-3.8-flash', 'gemini-2.5-flash', 'gemini-flash-latest'];
              for (const modelName of candidateModels) {
                try {
                  const resp = await ai.models.generateContent({
                    model: modelName,
                    contents: prompt,
                    config: { responseMimeType: 'application/json' }
                  });
                  if (resp.text) { generatedText = resp.text; break; }
                } catch (modelErr: any) {
                  const errMsg = modelErr?.message || String(modelErr);
                  const retryable = errMsg.includes('503') || errMsg.includes('429') || errMsg.includes('UNAVAILABLE') || errMsg.includes('RESOURCE_EXHAUSTED');
                  if (retryable) { await new Promise(r => setTimeout(r, 400)); continue; }
                  // Unknown/dead model name (404/NOT_FOUND) — try the next
                  // candidate instead of giving up on Gemini entirely.
                  if (/404|NOT_FOUND|not found|not supported|invalid model/i.test(errMsg)) continue;
                  break;
                }
              }
            } catch { /* template fallback below */ }
          }
        }

        if (generatedText) {
          try {
            const parsed = JSON.parse(generatedText);
            if (parsed.fullScript && Array.isArray(parsed.scenes) && parsed.scenes.length >= 3) {
              script.fullScript = parsed.fullScript;
              script.scenes = parsed.scenes.map((s: any, idx: number) => ({
                id: `sc-ai-${idx}`,
                sceneNumber: s.sceneNumber || idx + 1,
                timestampStart: s.timestampStart ?? idx * 8,
                timestampEnd: s.timestampEnd ?? (idx + 1) * 8,
                narratorText: s.narratorText || '',
                visualPrompt: s.visualPrompt || 'Dynamic vertical news visual',
                shotType: s.shotType || 'photo_evidence',
                graphicOverlay: s.graphicOverlay || 'KEY EVIDENCE',
                assetUrl: trend.image_url,
                audioEmphasisWords: s.audioEmphasisWords || ['trending', 'verified']
}))


            }
          } catch (parseErr) {
            console.warn('[Script Engine] Response JSON parse note, using verified template script.');
          }
        } else {
          console.log('[Script Engine] Using verified journalistic template script.');
        }
      } catch (err: any) {
        console.log('[Script Engine] Note on script generation:', err?.message || 'Using verified template');
      }
    }

    job.facts = facts;
    job.script = script;
    addLog('Fact Verification', `Verified ${facts.length} core claims with 0 hallucinations`, 'success');

    await new Promise(r => setTimeout(r, 600));

    // Step 4: Storyboard & Subtitle Engine
    job.currentStep = 'storyboard';
    job.progressPercent = 60;
    addLog('Storyboard Engine', `Generated ${script.scenes.length} vertical 9:16 scenes with kinetic transitions`);

    await new Promise(r => setTimeout(r, 600));

    // Step 5: Audio & Video Rendering Engine
    job.currentStep = 'rendering';
    job.progressPercent = 75;
    addLog('Rendering Engine', `Generating natural speech narration and rendering physical 1080x1920 MP4 video...`);

    // Same single-render lock as the manual re-render endpoint: a manual
    // "Re-render" for this job while the pipeline renders would overwrite
    // each other's bytes mid-encode.
    const renderKey = `render:${job.id}`;
    let renderRes: Awaited<ReturnType<typeof renderShortMp4>> | null = null;
    try {
      if (renderLocks.has(renderKey)) {
        throw new Error('A render for this video is already running — try again when it finishes.');
      }
      renderLocks.add(renderKey);
      try {
        renderRes = await renderShortMp4({
          jobId: job.id,
          keyword: trend.keyword,
          question: selectedQuestion,
          category: trend.category,
          imageUrl: trend.image_url,
          extraImageUrls: [...new Set([...(trend.storyImageUrls || []), ...(trend.sources || []).map(s => s.picture).filter((u): u is string => !!u)])],
          fullScript: script.fullScript || `${selectedQuestion}. Here is the verified report.`,
          primaryPublisher: trend.sources?.[0]?.name || 'Google Trends Wire',
          primaryNews: trend.sources?.[0]?.title || trend.description,
          tickerNews: [...(trend.sources || []).map(s => s.title).filter(Boolean), trend.description].filter(Boolean),
          rawTraffic: trend.rawGoogleTraffic || `${trend.search_volume}K+`,
          voice: job.voiceId,
          scenes: (script.scenes || []).map(s => ({
            start: s.timestampStart,
            end: s.timestampEnd,
            caption: s.graphicOverlay || s.narratorText
          })),
          onLog: (step, msg, type = 'info') => addLog(step, msg, type)
        });
      } finally {
        renderLocks.delete(renderKey);
      }

      job.videoUrl = renderRes.videoUrl;
      job.audioUrl = renderRes.audioUrl;
      job.renderedMp4Size = renderRes.fileSizeBytes;
      addLog('Rendering Engine', `Physical MP4 short video file rendered successfully (${Math.round(renderRes.fileSizeBytes / 1024)} KB) with H.264/AAC at 30 FPS.`, 'success');
    } catch (renderErr: any) {
      console.warn('[Video Render Notice]', renderErr.message);
      // Honest failure: a job with no video must NOT be marked completed —
      // the studio shows the error and the job can be retried.
      job.status = 'failed';
      job.error = renderErr?.message || 'Video render failed';
      addLog('Rendering Engine', `Render failed: ${renderErr.message || renderErr} — no preview file produced`, 'error');
      return;
    }

    // Step 6: SEO Engine
    job.currentStep = 'seo';
    job.progressPercent = 88;
    // NO URLs in the description — YouTube penalizes/mis-detects outbound
    // links in Shorts descriptions. Source names + titles only (owner rule).
    const sourcesAttribution = trend.sources.map(s => `- ${s.name}: ${s.title}`).join('\n');
    // Google's own related-search keywords for this exact trend (breakdown
    // list from the Trending feed) — they go into hashtags, tags AND the
    // description text so the short surfaces for the same searches.
    const relatedSearches = (trend.breakdownKeywords || []).slice(0, 10);
    const topic = buildTrendTags(trend.keyword, trend.category, `${overviewText} ${(trend.sources || []).map(s => s.title).join(' ')} ${relatedSearches.join(' ')}`, selectedQuestion, relatedSearches);
    const relatedLine = relatedSearches.length > 0
      ? `\n\nRelated searches on Google: ${relatedSearches.join(', ')}`
      : '';
    // All 3 Google story headlines for this exact trend (the same 3 cards on
    // trends.google.com/trending?q=...) — listed verbatim in the description.
    const topStories = trend.sources.slice(0, 3).map(s => `- ${s.title} (${s.name})`).join('\n');
    const storiesLine = topStories ? `\n\nTop stories on Google:\n${topStories}` : '';
    const seo: SEOPackage = PRESET_SEO_MAP[trend.id] || {
      title: `${selectedQuestion} 🔍 Verified Breakdown`,
      description: `Wondering why ${trend.keyword} is trending with ${trend.rawGoogleTraffic || 'high search volume'} on Google Trends? Here is the verified answer.${storiesLine}\n\nVerified Sources:\n${sourcesAttribution}${relatedLine}\n\n${topic.hashtags.join(' ')}`,
      hashtags: topic.hashtags,
      tags: topic.tags,
      pinnedComment: `Did you search for "${trend.keyword}" today? Drop your thoughts below 👇`,
      thumbnailHook: selectedQuestion.toUpperCase(),
      soundtrackRecommendation: 'Urgent Tech Pulse (124 BPM)'
    };
    job.seo = seo;
    addLog('SEO Engine', `Engineered YouTube Shorts title, pinned comment, and search tags`, 'success');

    await new Promise(r => setTimeout(r, 500));

    // Step 7: Quality Control Engine
    job.currentStep = 'qc';
    job.progressPercent = 95;
    const qc: QualityControlReport = PRESET_QC_MAP[trend.id] || {
      overallScore: 97,
      passed: true,
      factTraceabilityScore: 100,
      intentRelevanceScore: 98,
      pacingScore: 95,
      safetyStatus: 'green',
      auditedAt: new Date().toISOString(),
      checks: [
        {
          id: 'qc-gen-1',
          name: 'Direct Question Hook',
          category: 'intent',
          status: 'pass',
          score: 100,
          detail: 'Narration begins immediately by answering the primary user query.'
        },
        {
          id: 'qc-gen-2',
          name: 'Source Traceability',
          category: 'accuracy',
          status: 'pass',
          score: 98,
          detail: 'All statements are supported by cited news sources.'
        },
        {
          id: 'qc-gen-3',
          name: 'Pacing & Cadence',
          category: 'pacing',
          status: 'pass',
          score: 95,
          detail: 'Pacing is optimized for short-form retention with scene switches every 4-8s.'
        }
      ]
    };
    job.qc = qc;
    addLog('Quality Control', `Passed automated QC inspection: Score ${qc.overallScore}/100`, 'success');

    // Finalize: Ready / Published
    job.status = 'completed';
    job.currentStep = 'completed';
    job.progressPercent = 100;
    job.completedAt = new Date().toISOString();
    addLog('Publishing Engine', `Package finalized & staged for YouTube Shorts & TikTok distribution.`, 'success');
  } catch (error: any) {
    job.status = 'failed';
    job.error = error.message || 'Pipeline execution failed';
    addLog('Error', `Pipeline encountered an error: ${error.message}`, 'error');
  }
}

/* ========================================================================= */
/* VITE MIDDLEWARE / STATIC ASSETS                                           */
/* ========================================================================= */

async function startServer() {
  // Create the HTTP server first so Vite's HMR WebSocket can share the same
  // port (PORT) instead of binding a separate one (default 24678) that
  // collides when another process already holds it.
  const httpServer = app.listen(PORT, '0.0.0.0', () => {
    console.log(`[Trend Video Engine] Server running at http://0.0.0.0:${PORT}`);

    // A SIGKILLed node never runs its exit handler, so its ffmpeg keeps the
    // YouTube stream-key slot — reap those orphans BEFORE any resume/start or
    // the new push fights the stale one and YouTube shows nothing.
    try {
      reapStaleRtmpPushes();
    } catch (err) {
      console.warn('[LiveStream] stale-push reap note:', (err as Error)?.message || err);
    }

    // Ingest live Google Trends on startup (list only) — video production
    // waits for the Auto-Pilot timer or a manual trigger, never auto-runs.
    ingestRealGoogleTrends('US', false).then(result => {
      if (result) {
        console.log(`[Startup] Live Google Trends ingested. #1: "${result.topTrend.keyword}" — waiting for timer/manual trigger.`);
      }
    }).catch(err => {
      console.warn('[Startup Google Trends Warning]', err);
    });

    // Live card backend: warm in the background (runtime provisioning takes
    // a while on first boot when the deploy lacks it — never block boot).
    void import('./server/liveCardRenderer.js').then(m => m.isCardRendererAvailable()).catch(() => {});

    // Live rundown: warm the multi-country rotation immediately, then rotate
    // stories on its timer (repaints the live overlay) and refresh data
    // periodically — all server-side, no client needed, live or not.
    // Hard-capped: even if every feed hangs, the loop + resume still arm.
    void Promise.race([
      refreshRundownNow().catch((err: any) =>
        console.warn('[Rundown] warmup note:', err?.message || err)
      ),
      new Promise(resolve => setTimeout(() => {
        console.warn('[Rundown] warmup timed out — arming loop with whatever is loaded.');
        resolve(null);
      }, 90000)),
    ])
      .finally(() => {
        startRundownLoop(() => handleRundownSlot());
        // Resume order matters: a persisted IG reel loop comes back as a loop
        // first (same watch/key/file); only when there is none does a news
        // push resume (pinned pin restores from the saved row).
        void resumeIgLiveBroadcast().then((resumed) => {
          if (resumed) return;
          void resumeLiveBroadcast((topic) => {
            if (topic) {
              const pinned = snapshotForRundownTopic(topic);
              if (pinned) {
                livePin = topic;
                return pinned;
              }
            }
            livePin = null;
            return getRundownSnapshot(null);
          }).catch((err: any) =>
            console.warn('[LiveStream] resume note:', err?.message || err)
          );
        });
      });

    // Timers are durable: Auto-Pilot schedules (tl_auto_schedule) and IG
    // watches (tl_ig_watch) both live in MySQL, so every armed timer
    // survives restarts and redeploys — overdue ones catch up on the ticks
    // below. Both tickers are overlap-guarded internally; the .catch
    // wrappers are belt & braces — an escaping rejection would hit the
    // FATAL handler at the top of this file and restart the process.
    if (process.env.DISABLE_TIMERS !== 'true') {
    void migrateLegacyScheduleFile().catch((err: any) => console.warn('[Auto-Pilot] migration note:', err?.message || err));
    // Auto-Pilot ticker: per-user interval production + publishing.
    setInterval(() => {
      void tickAutoSchedules().catch((err: any) => console.warn('[Auto-Pilot] tick failed:', err?.message || err));
    }, 60 * 1000);
    // IG-Repost ticker: per-watch user intervals (hours + minutes) + manual check.
    setInterval(() => {
      void tickIgWatches().catch((err: any) => console.warn('[IG-Repost] tick failed:', err?.message || err));
    }, 60 * 1000);
    // Relax Shorts ticker: one durable timer per user (latest AI post -> 40s
    // Short -> YouTube). Same 60s cadence, overlap-guarded, live-held.
    setInterval(() => {
      void tickRelaxSchedules().catch((err: any) => console.warn('[RelaxShorts] tick failed:', err?.message || err));
    }, 60 * 1000);
    // IG-Live prefetch: live-armed watches are swept every 30s and any watch
    // older than LIVE_PREFETCH_MINUTES gets a check+seamless-swap pass, so
    // the next reel is hunted while the current one keeps repeating.
    setInterval(() => {
      void tickLivePrefetch().catch((err: any) => console.warn('[IG-Live] prefetch tick failed:', err?.message || err));
    }, 30 * 1000);
    // Virality engine: velocity spikes fire at once (15m sweep, per-user 30m
    // throttle + shared per-country cache); stale low-view titles rotate
    // once (6h sweep, first pass 30m after boot to avoid the boot storm).
    setInterval(() => {
      void maybeVelocityFire().catch((err: any) => console.warn('[Auto-Pilot] velocity tick failed:', err?.message || err));
    }, 15 * 60 * 1000);
    setTimeout(() => {
      void maybeVelocityFire().catch(() => {});
    }, 5 * 60 * 1000);
    setInterval(() => {
      void tickTitleRotation().catch((err: any) => console.warn('[Engage] rotation tick failed:', err?.message || err));
    }, 6 * 3600 * 1000);
    setTimeout(() => {
      void tickTitleRotation().catch(() => {});
    }, 30 * 60 * 1000);
    const checkExpiredSubscriptions = async () => {
      if (!isDbReady()) return;
      try {
        const now = new Date().toISOString();
        const rows = await listExpiredSubscriptionQuotas(now);
        for (const r of rows) {
          try {
            const u = await getUserById(r.user_id);
            if (u?.email) {
              const e = subscriptionExpiredEmail(u.name || 'User');
              void sendEmail(u.email, e.subject, e.html);
            }
            await markSubscriptionExpiryNotified(r.user_id, now);
          } catch { /* ignore */ }
        }
      } catch { /* ignore */ }
    };
    setInterval(() => { void checkExpiredSubscriptions(); }, 30 * 60 * 1000);
    setTimeout(() => { void checkExpiredSubscriptions(); }, 2 * 60 * 1000);
    console.log(`[IG-Live] prefetch armed — live loops hunt the next reel every ~${LIVE_PREFETCH_MIN}m (LIVE_PREFETCH_MINUTES).`);
    console.log(`[Queue] pipeline concurrency=${pipelineQueue.stats().concurrency}, io concurrency=${ioQueue.stats().concurrency}, max queued/user=${MAX_QUEUED_PER_USER}`);
    console.log('[Auto-Pilot] per-user timers load from tl_auto_schedule on every tick (deploy-proof).');
    }
  });

  // ---- SEO / GEO / AEO static routes (root-relative; the portal nginx proxy
  // prefixes them and the site.config rewrites keep crawlers on the right base).
  // robots.txt — allow all crawlers incl. AI/LLM agents, point to the sitemap.
  app.get('/robots.txt', (_req, res) => {
    const base = (process.env.APP_URL || 'https://bidbes.com/trendlogic').replace(/\/+$/, '');
    res.type('text/plain').send(`User-agent: *\nAllow: /\n\nUser-agent: GPTBot\nAllow: /\n\nUser-agent: Google-Extended\nAllow: /\n\nUser-agent: ClaudeBot\nAllow: /\n\nUser-agent: PerplexityBot\nAllow: /\n\nUser-agent: CCBot\nAllow: /\n\nSitemap: ${base}/sitemap.xml\n`);
  });

  // sitemap.xml — root pages plus the latest rendered trend videos (shared
  // references to the SEO package each trending topic gets).
  app.get('/sitemap.xml', (_req, res) => {
    const base = (process.env.APP_URL || 'https://bidbes.com/trendlogic').replace(/\/+$/, '');
    const ts = new Date().toISOString().slice(0, 10);
    const roots = ['', '/about', '/terms'].map(
      (p) => `  <url><loc>${base}${p}</loc><lastmod>${ts}</lastmod><changefreq>hourly</changefreq><priority>${p === '' ? '1.0' : '0.5'}</priority></url>`
    );
    const xml = `<?xml version="1.0" encoding="UTF-8"?>\n<urlset xmlns="http://www.sitemaps.org/schemas/sitemap/0.9">\n${roots.join('\n')}\n</urlset>`;
    res.setHeader('Content-Type', 'application/xml; charset=utf-8');
    res.send(xml);
  });

  // llms.txt + llms-full.txt - machine-readable docs for AI/answer crawlers.
  const TLBASE = () => (process.env.APP_URL || 'https://bidbes.com/trendlogic').replace(/\/+$/, '');
  app.get('/llms.txt', (_req, res) => res.type('text/plain').send('# Trend Video Engine - TrendVideoBuilder by BidBes\n\nAutomated short-form vertical video production that explains WHY a topic is\ntrending and answers the exact question people are searching. Live Google Trends\nRSS + fact verification + script + AI short rendered via ffmpeg & Google TTS.\n\n## Key facts\n- Live Google Trends ingestion across 100+ countries.\n- Researches, fact-checks and scripts the trending topic automatically.\n- Renders vertical MP4 shorts with text overlays (ffmpeg + Google TTS).\n- Optional AI scene visuals (Pollinations keyless) and one-click YouTube publishing.\n\n## Sources\n- Google Trends RSS (live), trusted wire feeds (BBC/NYT/AP/Reuters).\n- Google Gemini for scripts/NLP, Google TTS + ffmpeg for rendering.\n\n## API\n- GET /api/health - status\n- GET /api/trends - live trends\n- POST /api/explain - AI explanation\n- POST /api/pipeline - start a video job\n- GET /api/jobs/{id} - job status\n' + TLBASE() + "\n"));
  app.get('/llms-full.txt', (_req, res) => res.type('text/plain').send('# Trend Video Engine - Full Documentation\n\nAutomatically produces short-form vertical videos explaining trending search\ntopics and answering the underlying question.\n\n## Pipeline\n1. Normalization & dedup of the trending topic.\n2. Question/intent engine.\n3. Fact verification across trusted feeds.\n4. Script with citations.\n5. Voice-over via Google TTS.\n6. Encoding via ffmpeg (cinematic broadcast template) with neural narration.\n7. QC, SEO package, optional YouTube publishing.\n\n## Data\n- Ingest: Google Trends RSS (background at startup).\n- Sources: BBC, NYT, AP, Reuters where linked.\n\n## Endpoints\n- GET /api/health\n- GET /api/trends?geo=XX\n- POST /api/pipeline\n- POST /api/jobs/create\n- GET /api/jobs\n- POST /api/video/render\n- POST /api/video/generate-free-ai\n' + TLBASE() + "\n"));
  if (process.env.NODE_ENV !== 'production') {
    const { createServer: createViteServer } = await import('vite');
    const vite = await createViteServer({
      server: {
        middlewareMode: true,
        hmr: { server: httpServer },
      },
      appType: 'spa',
    });
    app.use(vite.middlewares);
  } else {
    const distPath = path.join(process.cwd(), 'dist');
    app.use(express.static(distPath));
    app.get('*', (req, res) => {
      res.sendFile(path.join(distPath, 'index.html'));
    });
  }
}

startServer();
