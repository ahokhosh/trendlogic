import fs from 'fs';
import path from 'path';
import { exec } from 'child_process';
import { promisify } from 'util';
import ffmpegPath from 'ffmpeg-static';
import ffprobeStatic from 'ffprobe-static';

const execAsync = promisify(exec);

function resolveBin(staticPath: string | null, name: string): string {
  if (staticPath && fs.existsSync(staticPath)) return staticPath;
  return name;
}
const FFPROBE_BIN = resolveBin(ffprobeStatic?.path || null, 'ffprobe');

// ---------------------------------------------------------------------------
// PixVerse text-to-video — the REAL external AI motion generator behind
// "AI Video" (ویدیو هوش مصنوعی). Genuine diffusion motion, NOT the internal
// template renderer.
//
// Docs: https://docs.platform.pixverse.ai (OpenAPI v2, async: submit ->
// video_id -> poll status until status=1 -> download url).
//
// ENV:
//   PIXVERSE_API_KEY  key from platform.pixverse.ai (already in .env)
//   PIXVERSE_MODEL    default "v6" (9:16 + 1..15s supported)
//   PIXVERSE_DURATION default 5 (seconds, v6 allows 1..15)
//   PIXVERSE_QUALITY  default "540p" ("360p" | "540p" | "720p" | "1080p")
//
// NOTE (tested 2026-09-11): the key in .env authenticates fine but the
// account has NO credits (ErrCode 500090 "Insufficient balance"). Until the
// account is topped up this path fails HONESTLY — it never substitutes a
// template render and never claims a fake video.
// ---------------------------------------------------------------------------

const API_BASE = process.env.PIXVERSE_API_BASE || 'https://app-api.pixverse.ai';
const API_KEY = process.env.PIXVERSE_API_KEY || '';
const MODEL = process.env.PIXVERSE_MODEL || 'v6';
const DURATION = Math.min(15, Math.max(3, Number(process.env.PIXVERSE_DURATION) || 5));
const QUALITY = process.env.PIXVERSE_QUALITY || '540p';
const POLL_INTERVAL_MS = 8000;
const TIMEOUT_MS = 10 * 60 * 1000;

export function isPixVerseConfigured(): boolean {
  return API_KEY.length > 0;
}

export interface PixVerseResult {
  videoUrl: string;
  videoFilePath: string;
  fileSizeBytes: number;
  durationSec: number;
  videoId: number;
  elapsedMs: number;
}

function traceId(): string {
  return 'xxxxxxxx-xxxx-4xxx-yxxx-xxxxxxxxxxxx'.replace(/[xy]/g, c => {
    const r = (Math.random() * 16) | 0;
    return (c === 'x' ? r : (r & 0x3) | 0x8).toString(16);
  });
}

async function apiPost<T>(urlPath: string, body: unknown): Promise<T> {
  const res = await fetch(`${API_BASE}${urlPath}`, {
    method: 'POST',
    headers: {
      'API-KEY': API_KEY,
      'Ai-trace-id': traceId(),
      'Content-Type': 'application/json',
      'User-Agent': 'trendlogic-ai-video/1.0'
    },
    body: JSON.stringify(body),
    signal: AbortSignal.timeout(60000)
  });
  if (!res.ok) throw new Error(`PixVerse request failed (HTTP ${res.status})`);
  return (await res.json()) as T;
}

async function apiGet<T>(urlPath: string): Promise<T> {
  const res = await fetch(`${API_BASE}${urlPath}`, {
    headers: {
      'API-KEY': API_KEY,
      'Ai-trace-id': traceId(),
      'User-Agent': 'trendlogic-ai-video/1.0'
    },
    signal: AbortSignal.timeout(60000)
  });
  if (!res.ok) throw new Error(`PixVerse status query failed (HTTP ${res.status})`);
  return (await res.json()) as T;
}

interface PixVerseEnvelope<T> {
  ErrCode: number;
  ErrMsg: string;
  Resp: T;
}

function looksLikeVideo(buf: Buffer): boolean {
  if (buf.length < 12) return false;
  if (buf.subarray(4, 8).toString('ascii') === 'ftyp') return true; // mp4/mov
  if (buf[0] === 0x1a && buf[1] === 0x45 && buf[2] === 0xdf && buf[3] === 0xa3) return true; // webm/mkv
  return false;
}

/**
 * Generate REAL AI motion video (9:16 vertical Short) from a text prompt.
 * Downloads the finished MP4 into public/videos as `${jobId}_ai.mp4`.
 * Throws an honest, human-readable error when generation is impossible
 * (no key, no credits, timeout) — never a placeholder.
 */
export async function generatePixVerseVideo(opts: {
  jobId: string;
  prompt: string;
  duration?: number;
  onLog?: (step: string, message: string, type?: 'info' | 'success' | 'warn' | 'error') => void;
}): Promise<PixVerseResult> {
  const { jobId, prompt, onLog } = opts;
  if (!isPixVerseConfigured()) {
    throw new Error('PIXVERSE_API_KEY is not set. Add it to .env to enable real AI video.');
  }
  const started = Date.now();
  const duration = Math.min(15, Math.max(3, opts.duration || DURATION));

  onLog?.('AI Video Engine', `Submitting text-to-video job to PixVerse (${MODEL}, 9:16, ${duration}s)...`, 'info');
  const gen = await apiPost<PixVerseEnvelope<{ video_id: number }>>('/openapi/v2/video/text/generate', {
    aspect_ratio: '9:16',
    duration,
    model: MODEL,
    prompt: prompt.slice(0, 2000),
    quality: QUALITY,
    seed: Math.floor(Math.random() * 1000000)
  });
  if (gen.ErrCode !== 0 || !gen.Resp?.video_id) {
    throw new Error(`PixVerse rejected the job: ${gen.ErrMsg || `ErrCode ${gen.ErrCode}`}`);
  }
  const videoId = gen.Resp.video_id;
  onLog?.('AI Video Engine', `Job accepted (video_id ${videoId}) — rendering real motion...`, 'info');

  const deadline = Date.now() + TIMEOUT_MS;
  let polls = 0;
  for (;;) {
    if (Date.now() > deadline) {
      throw new Error(`PixVerse job ${videoId} did not finish within ${Math.round(TIMEOUT_MS / 60000)} minutes.`);
    }
    await new Promise(r => setTimeout(r, POLL_INTERVAL_MS));
    polls++;
    const st = await apiGet<PixVerseEnvelope<{ status: number; url?: string; detail?: string }>>(
      `/openapi/v2/video/result/${videoId}`
    );
    if (st.ErrCode !== 0 || !st.Resp) {
      throw new Error(`PixVerse status query failed: ${st.ErrMsg || `ErrCode ${st.ErrCode}`}`);
    }
    const status = st.Resp.status;
    if (status === 1 && st.Resp.url) {
      onLog?.('AI Video Engine', 'Render finished — downloading genuine motion MP4...', 'success');
      const dl = await fetch(st.Resp.url, { signal: AbortSignal.timeout(180000) });
      if (!dl.ok) throw new Error(`PixVerse video download failed (HTTP ${dl.status})`);
      const buf = Buffer.from(await dl.arrayBuffer());
      if (buf.length < 5000 || !looksLikeVideo(buf)) {
        throw new Error('PixVerse returned a file that is not a video container.');
      }
      const publicVideosDir = path.join(process.cwd(), 'public', 'videos');
      if (!fs.existsSync(publicVideosDir)) fs.mkdirSync(publicVideosDir, { recursive: true });
      const outPath = path.join(publicVideosDir, `${jobId}_ai.mp4`);
      fs.writeFileSync(outPath, buf);

      let durationSec = duration;
      try {
        const { stdout } = await execAsync(
          `"${FFPROBE_BIN}" -v error -show_entries format=duration -of default=noprint_wrappers=1:nokey=1 "${outPath}"`
        );
        const parsed = parseFloat(stdout.trim());
        if (!isNaN(parsed) && parsed > 0) durationSec = Math.round(parsed * 10) / 10;
      } catch { /* keep requested duration */ }

      return {
        videoUrl: `/videos/${jobId}_ai.mp4`,
        videoFilePath: outPath,
        fileSizeBytes: buf.length,
        durationSec,
        videoId,
        elapsedMs: Date.now() - started
      };
    }
    if (status === 7 || status === 8 || status === 9) {
      throw new Error(`PixVerse generation failed (status ${status}${st.Resp.detail ? `: ${st.Resp.detail}` : ''}).`);
    }
    if (polls % 4 === 1) {
      onLog?.('AI Video Engine', `Still rendering on PixVerse (status ${status})...`, 'info');
    }
  }
}
