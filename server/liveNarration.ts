import { spawnSync } from 'child_process';
import googleTTS from 'google-tts-api';
import { synthEdgeNeural, resolveTemplateVoice } from './videoRenderer.js';

// ---------------------------------------------------------------------------
// Live narrator: a short anchor read per story ("United States. Falcons
// versus Packers.") synthesized in the background, decoded to PCM once, and
// spliced into exact 10-second slot buffers (voice + silence pad) that the
// card engine's pacer pumps alongside video. Same Deep News Anchor voice as
// the channel's rendered videos (Edge neural, Google TTS fallback).
//
// Design constraints: rotation must NEVER wait on voice (a missing clip =
// silence that slot, cached for the next cycle), and a failed fetch must
// never break the push. LIVE_VOICE=0 disables all TTS work (pure silence).
// ---------------------------------------------------------------------------

export const NARR_SAMPLE_RATE = 44100;
export const NARR_CHANNELS = 2;
export const NARR_BYTES_PER_SEC = NARR_SAMPLE_RATE * NARR_CHANNELS * 2; // s16le

export function voiceEnabled(): boolean {
  const v = String(process.env.LIVE_VOICE || '1').trim().toLowerCase();
  return v !== '0' && v !== 'false' && v !== 'off';
}

/** What the anchor reads: country first, then the trend title. */
export function buildNarrationText(countryName: string, keyword: string): string {
  const clean = (s: string): string =>
    String(s || '')
      .replace(/https?:\S+/g, ' ')
      .replace(/[%#*_`"\\[\]()|]/g, ' ')
      .replace(/\bvs\.?\b/gi, 'versus')
      .replace(/\s+/g, ' ')
      .trim()
      .slice(0, 140);
  const country = clean(countryName) || 'Trending now';
  const title = clean(keyword) || 'top story';
  return `${country}. ${title}.`;
}

const ttsCache = new Map<string, Buffer>();

function cachePut(key: string, buf: Buffer): void {
  ttsCache.set(key, buf);
  if (ttsCache.size > 30) {
    const oldest = ttsCache.keys().next().value;
    if (oldest) ttsCache.delete(oldest);
  }
}

// Circuit breaker: keyless TTS endpoints throttle hammering (a story every
// 10s around the clock). After 3 consecutive failures, stop trying for 10
// minutes so a throttle can lift instead of digging deeper — slots stay
// silent meanwhile, the push never suffers.
let consecFails = 0;
let coolUntil = 0;
let lastVoiceError: string | null = null;

function noteVoiceFail(msg: string): void {
  consecFails++;
  lastVoiceError = String(msg || 'unknown').slice(0, 120);
  if (consecFails >= 3 && coolUntil <= Date.now()) {
    coolUntil = Date.now() + 10 * 60 * 1000;
    console.warn(`[LiveVoice] breaker open for 10m after ${consecFails} consecutive failures (last: ${lastVoiceError}). Slots go silent, push continues.`);
  }
}

function noteVoiceOk(): void {
  consecFails = 0;
  coolUntil = 0;
  lastVoiceError = null;
}

/** Diagnostics for /api/stream/status (no secrets, just health). */
export function getVoiceHealth(): { coolingDown: boolean; consecFails: number; lastError: string | null; cached: number } {
  return {
    coolingDown: Date.now() < coolUntil,
    consecFails,
    lastError: lastVoiceError,
    cached: ttsCache.size,
  };
}

/** Raw TTS MP3 for the text: Edge neural anchor, Google robot fallback. */
async function fetchTtsMp3(text: string): Promise<Buffer> {
  const v = resolveTemplateVoice('anchor-deep');
  try {
    const neural = await synthEdgeNeural(text, v.voice, 15000, v.rate, v.pitch);
    if (neural && neural.length > 1000) return neural;
    throw new Error('Edge TTS returned an empty stream');
  } catch (edgeErr: any) {
    console.warn(`[LiveVoice] Edge neural unavailable (${String(edgeErr?.message || edgeErr).slice(0, 120)}) — Google fallback.`);
  }
  const chunks = await googleTTS.getAllAudioBase64(text, { lang: 'en', slow: false, timeout: 10000 });
  const buf = Buffer.concat(chunks.map(c => Buffer.from(c.base64, 'base64')));
  if (buf.length < 500) throw new Error('Google TTS returned an empty stream');
  return buf;
}

/** Decode any voice MP3 to 44.1kHz stereo s16le PCM (one-shot ffmpeg). */
function decodeToPcm(mp3: Buffer, ffmpegBin: string): Buffer | null {
  try {
    const r = spawnSync(
      ffmpegBin,
      [
        '-hide_banner', '-loglevel', 'error',
        '-i', 'pipe:0',
        '-ar', String(NARR_SAMPLE_RATE), '-ac', String(NARR_CHANNELS),
        '-af', 'loudnorm=I=-16:TP=-1.5:LRA=11',
        '-f', 's16le', '-acodec', 'pcm_s16le', 'pipe:1',
      ],
      { input: mp3, timeout: 20000, maxBuffer: 16 * 1024 * 1024 }
    );
    if (r.status !== 0 || !r.stdout || r.stdout.length < 1000) return null;
    return Buffer.from(r.stdout);
  } catch {
    return null;
  }
}

/**
 * Voice PCM for a story (cached). Returns null on any failure — the caller
 * plays silence instead. Never throws.
 */
export async function getStoryVoice(
  cacheKey: string,
  countryName: string,
  keyword: string,
  ffmpegBin: string
): Promise<Buffer | null> {
  if (!voiceEnabled()) return null;
  const hit = ttsCache.get(cacheKey);
  if (hit) return hit;
  if (Date.now() < coolUntil) return null; // breaker open: silent, no hammering
  try {
    const text = buildNarrationText(countryName, keyword);
    if (!text) return null;
    const mp3 = await fetchTtsMp3(text);
    const pcm = decodeToPcm(mp3, ffmpegBin);
    if (!pcm) {
      noteVoiceFail('decode produced no audio');
      return null;
    }
    cachePut(cacheKey, pcm);
    noteVoiceOk();
    return pcm;
  } catch (err) {
    const msg = String((err as Error)?.message || err).slice(0, 120);
    console.warn(`[LiveVoice] voice note for "${String(keyword).slice(0, 40)}" (silent slot):`, msg);
    noteVoiceFail(msg);
    return null;
  }
}

/** Exact-length slot buffer: voice (truncated) + silence pad. Always exact. */
export function buildSlotAudio(voicePcm: Buffer | null, slotMs: number): Buffer {
  const total = Math.max(1000, Math.round((slotMs / 1000) * NARR_BYTES_PER_SEC));
  const out = Buffer.alloc(total, 0);
  if (voicePcm && voicePcm.length > 0) {
    voicePcm.copy(out, 0, 0, Math.min(voicePcm.length, total));
  }
  return out;
}

/** Fire-and-forget warm for an upcoming story (never blocks rotation). */
export function prefetchStoryVoice(
  cacheKey: string,
  countryName: string,
  keyword: string,
  ffmpegBin: string
): void {
  if (!voiceEnabled() || ttsCache.has(cacheKey)) return;
  void getStoryVoice(cacheKey, countryName, keyword, ffmpegBin).catch(() => {});
}

/** For tests/diagnostics: is this story's voice already cached? */
export function hasCachedVoice(cacheKey: string): boolean {
  return ttsCache.has(cacheKey);
}

/** Cache key convention (country-scoped: same keyword can trend in two). */
export function voiceKey(countryCode: string, keyword: string): string {
  return `${String(countryCode || '').trim().toUpperCase()}:${String(keyword || '').trim().toLowerCase()}`;
}

/** Sync cache read for the rotation hot path (never waits on network). */
export function peekCachedVoice(cacheKey: string): Buffer | null {
  return ttsCache.get(cacheKey) || null;
}
