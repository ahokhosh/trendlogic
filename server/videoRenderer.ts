import fs from 'fs';
import path from 'path';
import os from 'os';
import { exec, execSync } from 'child_process';
import { promisify } from 'util';
import googleTTS from 'google-tts-api';
import WebSocket from 'ws';
import { GoogleGenAI } from '@google/genai';
import { createHash } from 'crypto';
import ffmpegPath from 'ffmpeg-static';
import ffprobeStatic from 'ffprobe-static';
import { writeGradientBmp } from './freeAiVideoService.js';
import { fetchInstagramClip } from './instagramClip.js';

const execAsync = promisify(exec);

// The renderer shells out to `ffmpeg`/`ffprobe`. The linux container
// apt-installs a full ffmpeg (apk ffmpeg + font-liberation, with the
// drawtext filter the overlays need), while local Windows dev usually has
// no system ffmpeg and relies on the npm static binaries. The npm
// linux static binary does NOT ship drawtext ("No such filter: 'drawtext'"
// -> every render fails and no /videos/*.mp4 is ever produced), so the
// system PATH binary must win whenever it provides drawtext. Probe the
// candidates and pick the first one that actually lists the filter.
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
function pickFfmpegBin(staticPath: string | null): string {
  const cands: string[] = [];
  if (process.env.FFMPEG_BIN) cands.push(process.env.FFMPEG_BIN);
  cands.push('ffmpeg'); // system PATH first (full build on the container)
  if (staticPath && !cands.includes(staticPath)) cands.push(staticPath);
  for (const c of cands) {
    if (path.isAbsolute(c) && !fs.existsSync(c)) continue;
    if (binHasDrawtext(c)) return c;
  }
  console.warn(
    `[trendlogic] no ffmpeg candidate provides drawtext (${cands.join(', ')}) — renders will fail; install full ffmpeg + fonts`
  );
  return cands[0] ?? 'ffmpeg';
}
function pickFfprobeBin(staticPath: string | null): string {
  const cands: string[] = [];
  if (process.env.FFPROBE_BIN) cands.push(process.env.FFPROBE_BIN);
  cands.push('ffprobe');
  if (staticPath && !cands.includes(staticPath)) cands.push(staticPath);
  for (const c of cands) {
    if (path.isAbsolute(c) && !fs.existsSync(c)) continue;
    try {
      execSync(`"${c}" -version`, { timeout: 15000, stdio: ['ignore', 'pipe', 'pipe'] });
      return c;
    } catch {
      /* try next candidate */
    }
  }
  return cands[0] ?? 'ffprobe';
}
// Single-pod mode (scripts/start-portal.mjs) runs every service in ONE
// container whose base image has no system ffmpeg — the per-service
// trendlogic.Dockerfile (apk ffmpeg + font-liberation) is bypassed there.
// Try to install a full ffmpeg at runtime when no drawtext-capable binary
// is present. Best-effort and idempotent: guarded so it runs once.
let runtimeFfmpegAttempted = false;
function ensureRuntimeFfmpeg(): void {
  if (runtimeFfmpegAttempted) return;
  runtimeFfmpegAttempted = true;
  if (process.platform === 'win32') return;
  try {
    if (binHasDrawtext('ffmpeg')) return; // system binary already good
  } catch { /* fall through to install */ }
  const attempts: string[] = [
    // Debian/Ubuntu pod images (official node image family).
    'apt-get update -qq && apt-get install -y -qq ffmpeg fonts-liberation',
    // Alpine images.
    'apk add --no-cache ffmpeg font-liberation',
  ];
  for (const cmd of attempts) {
    try {
      execSync(cmd, { timeout: 300000, stdio: ['ignore', 'pipe', 'pipe'] });
      if (binHasDrawtext('ffmpeg')) {
        console.log('[trendlogic] runtime ffmpeg installed (system package)');
        return;
      }
    } catch {
      /* try next package manager */
    }
  }
  console.warn(
    '[trendlogic] runtime ffmpeg install failed — renders need a full ffmpeg with drawtext (apt-get install ffmpeg fonts-liberation)'
  );
}
function resolveFfmpegBin(): string {
  ensureRuntimeFfmpeg();
  return pickFfmpegBin((ffmpegPath as unknown as string) || null);
}
let FFMPEG_BIN = pickFfmpegBin((ffmpegPath as unknown as string) || null);
const FFPROBE_BIN = pickFfprobeBin(ffprobeStatic?.path || null);
console.log(`[trendlogic] ffmpeg bin: ${FFMPEG_BIN} (drawtext=${binHasDrawtext(FFMPEG_BIN)}) ffprobe bin: ${FFPROBE_BIN}`);
// Re-resolve lazily at render time so a runtime-installed ffmpeg (see
// ensureRuntimeFfmpeg) is picked up even though the import-time probe ran
// before the install finished. Exported: the live RTMP engine resolves the
// SAME binary (single-pod containers need the runtime apt/apk install here,
// otherwise /api/stream/start 400s with "no ffmpeg with drawtext").
export function ffmpegBin(): string {
  if (!binHasDrawtext(FFMPEG_BIN)) {
    const fresh = resolveFfmpegBin();
    if (binHasDrawtext(fresh)) FFMPEG_BIN = fresh;
  }
  return FFMPEG_BIN;
}

export interface RenderVideoResult {
  videoUrl: string;
  audioUrl: string;
  videoFilePath: string;
  fileSizeBytes: number;
  durationSec: number;
  /** Which visual source actually produced the backdrops. */
  visualMethod?: string;
}

export interface SceneCaption {
  start: number;
  end: number;
  caption: string;
}

export interface RenderVideoOptions {
  jobId: string;
  keyword: string;
  question: string;
  category: string;
  imageUrl?: string;
  /** Extra news-image URLs (RSS news items) so the short cuts between photos. */
  extraImageUrls?: string[];
  fullScript: string;
  primaryPublisher?: string;
  primaryNews?: string;
  /** All trend news headlines fed to the top scrolling ticker. */
  tickerNews?: string[];
  rawTraffic?: string;
  /** Graphic theme override (default: random pick per render for variety). */
  theme?: 'red' | 'gold' | 'blue';
  /** Per-scene caption straps (from the script package). */
  scenes?: SceneCaption[];
  /** Skip the Instagram-clip lookup (default: attempt it, stills on failure). */
  skipInstagramClip?: boolean;
  /** Narrator voice preset id (see TEMPLATE_VOICES; default: anchor-deep). */
  voice?: string;
  onLog?: (step: string, message: string, type?: 'info' | 'success' | 'warn' | 'error') => void;
}

// ---------------------------------------------------------------------------
// Fonts: Archivo Black (bundled news headline font) -> Liberation (container)
// -> ffmpeg built-in. The bundled file keeps local Windows renders working;
// the container falls back gracefully if assets/ is ever missing from deploy.
// ---------------------------------------------------------------------------
function escFont(p: string): string {
  return p.replace(/\\/g, '/').replace(/:/g, '\\:');
}
function pickFont(...candidates: string[]): string {
  for (const c of candidates) {
    if (c && fs.existsSync(c)) return `fontfile=${escFont(c)}:`;
  }
  return '';
}
const ARCHIVO_PATH = path.join(process.cwd(), 'assets', 'fonts', 'ArchivoBlack-Regular.ttf');
const LIBERATION_PATH = '/usr/share/fonts/truetype/liberation/LiberationSans-Bold.ttf';
const HEAD = pickFont(ARCHIVO_PATH, LIBERATION_PATH); // big news titles
// BODY must always resolve to a real fontfile: the single-pod container has
// no fonts-liberation package, so fall back to the bundled Archivo (shipped
// in assets/ by deploy-portal.cmd). An empty fontfile string makes every
// drawtext filter fail ("No font filename provided") even with full ffmpeg.
const BODY = pickFont(LIBERATION_PATH, ARCHIVO_PATH); // tickers, straps, small print

// ---------------------------------------------------------------------------
// Graphic themes: a different look is picked at random for every render so
// the channel never looks uniform. All themes are YouTube-safe: no fake
// LIVE bug, no red breaking-news bar, no engine branding.
// ---------------------------------------------------------------------------
export interface Theme {
  id: 'red' | 'gold' | 'blue';
  name: string;
  rule: string; // accent rules / dividers
  bar: string; // question-card side bar
  kick: string; // top-bar kicker text
  q2: string; // question second line
  flash: string; // hook-flash subline
  strap: string; // scene caption straps
  pill: string; // category/traffic pill
  sub: string; // subscribe button
}

const THEMES: Theme[] = [
  { id: 'red', name: 'Newsroom Red', rule: '0xef4444', bar: '0xf59e0b', kick: '0xfcd34d', q2: '0xfcd34d', flash: '0xfcd34d', strap: '0xfcd34d', pill: '0x38bdf8', sub: '0xdc2626' },
  { id: 'gold', name: 'Midnight Gold', rule: '0xf59e0b', bar: '0xfbbf24', kick: '0xfbbf24', q2: '0xfbbf24', flash: '0xfbbf24', strap: '0xfbbf24', pill: '0xe2e8f0', sub: '0xb45309' },
  { id: 'blue', name: 'Wire Blue', rule: '0x38bdf8', bar: '0x38bdf8', kick: '0x7dd3fc', q2: '0x7dd3fc', flash: '0x7dd3fc', strap: '0x7dd3fc', pill: '0xfcd34d', sub: '0x1d4ed8' }
];

function pickTheme(id?: 'red' | 'gold' | 'blue'): Theme {
  const found = id ? THEMES.find(t => t.id === id) : undefined;
  return found || THEMES[Math.floor(Math.random() * THEMES.length)];
}

// Sanitize string for FFmpeg drawtext. Colons are ESCAPED (not stripped)
// because ffmpeg >= 7 rejects a raw ':' even inside quoted text — '\:'
// renders as ':' on every ffmpeg version (same trick as '\,' below).
function sanitizeFfmpegText(text: string, maxLen = 60): string {
  if (!text) return '';
  return text
    .replace(/\\/g, '')
    .replace(/'/g, '')
    .replace(/"/g, '')
    .replace(/:/g, '\\:')
    .replace(/,/g, ' ')
    .replace(/%/g, ' pct')
    .replace(/[\r\n]+/g, ' ')
    .trim()
    .slice(0, maxLen);
}

// Wrap text into multiple lines for FFmpeg
function wrapText(text: string, maxCharsPerLine = 28): string[] {
  const words = text.split(/\s+/);
  const lines: string[] = [];
  let currentLine = '';

  for (const word of words) {
    if ((currentLine + ' ' + word).trim().length <= maxCharsPerLine) {
      currentLine = (currentLine + ' ' + word).trim();
    } else {
      if (currentLine) lines.push(currentLine);
      currentLine = word;
    }
  }
  if (currentLine) lines.push(currentLine);
  return lines.slice(0, 3);
}

// ---------------------------------------------------------------------------
// Voice: Microsoft Edge neural news anchor (keyless), Google TTS fallback.
// ---------------------------------------------------------------------------
const EDGE_TOKEN = '6A5AA1D4EAFF4E9FB37E23D68491D6F4';
const EDGE_GEC_VERSION = '1-143.0.3650.75';
// Voice recipe: polished prime-time anchor. Tunable via env without code edits.
const EDGE_VOICE = process.env.TEMPLATE_VOICE || 'en-US-AriaNeural';
const EDGE_RATE = process.env.TEMPLATE_RATE || '-5%';
const EDGE_PITCH = process.env.TEMPLATE_PITCH || '+0Hz';

export interface TemplateVoiceOption {
  id: string;
  label: string;
  gender: 'male' | 'female';
  description: string;
  voice: string;
  rate: string;
  pitch: string;
}

// Narrator voice catalog (all English Edge neural voices). The frontend
// lists these so the user picks the narration voice per render.
export const DEFAULT_TEMPLATE_VOICE_ID = 'anchor-prime';
export const TEMPLATE_VOICES: TemplateVoiceOption[] = [
  { id: 'anchor-prime', label: 'Prime Female Anchor', gender: 'female', description: 'Polished prime-time female anchor (default)', voice: 'en-US-AriaNeural', rate: '-5%', pitch: '+0Hz' },
  { id: 'anchor-deep', label: 'Deep News Anchor', gender: 'male', description: 'Authoritative deep broadcast anchor', voice: 'en-US-ChristopherNeural', rate: '-10%', pitch: '-20Hz' },
  { id: 'anchor-live', label: 'Live Correspondent', gender: 'male', description: 'Mature on-the-ground correspondent', voice: 'en-US-GuyNeural', rate: '0%', pitch: '-10Hz' },
  { id: 'anchor-bold', label: 'Bold Breaking Voice', gender: 'male', description: 'Punchy high-energy breaking-news read', voice: 'en-US-EricNeural', rate: '+5%', pitch: '-5Hz' },
  { id: 'anchor-friendly', label: 'Friendly Reporter', gender: 'female', description: 'Warm conversational field reporter', voice: 'en-US-JennyNeural', rate: '0%', pitch: '+0Hz' },
  { id: 'anchor-studio', label: 'Studio Narrator', gender: 'male', description: 'Calm documentary-style studio narration', voice: 'en-US-DavisNeural', rate: '-5%', pitch: '-5Hz' }
];

export function isKnownTemplateVoice(id: unknown): id is string {
  return typeof id === 'string' && TEMPLATE_VOICES.some(v => v.id === id);
}

/** Resolve a voice id to Edge synthesis params. Unknown ids and the default
 *  preset honor the TEMPLATE_VOICE / TEMPLATE_RATE / TEMPLATE_PITCH envs. */
export function resolveTemplateVoice(id?: string): { voice: string; rate: string; pitch: string } {
  const preset = id ? TEMPLATE_VOICES.find(v => v.id === id) : undefined;
  if (preset && preset.id !== DEFAULT_TEMPLATE_VOICE_ID) {
    return { voice: preset.voice, rate: preset.rate, pitch: preset.pitch };
  }
  return { voice: EDGE_VOICE, rate: EDGE_RATE, pitch: EDGE_PITCH };
}

function escapeSsml(text: string): string {
  return text.replace(/&/g, '&amp;').replace(/</g, '&lt;').replace(/>/g, '&gt;');
}

/** Sec-MS-GEC token (SHA256 of rounded Windows ticks + client token). */
function generateSecMsGec(): string {
  let ticks = Date.now() / 1000 + 11644473600; // Unix -> Windows epoch
  ticks -= ticks % 300; // round down to 5 minutes
  ticks *= 1e9 / 100; // 100-nanosecond intervals
  return createHash('sha256').update(`${Math.round(ticks)}${EDGE_TOKEN}`, 'ascii').digest('hex').toUpperCase();
}

/** JS-style date string the Edge endpoint expects (with trailing Z quirk). */
function edgeDateToString(): string {
  const d = new Date();
  const days = ['Sun', 'Mon', 'Tue', 'Wed', 'Thu', 'Fri', 'Sat'];
  const months = ['Jan', 'Feb', 'Mar', 'Apr', 'May', 'Jun', 'Jul', 'Aug', 'Sep', 'Oct', 'Nov', 'Dec'];
  const p = (n: number) => String(n).padStart(2, '0');
  return `${days[d.getUTCDay()]} ${months[d.getUTCMonth()]} ${p(d.getUTCDate())} ${d.getUTCFullYear()} ${p(d.getUTCHours())}:${p(d.getUTCMinutes())}:${p(d.getUTCSeconds())} GMT+0000 (Coordinated Universal Time)`;
}

/** Edge neural TTS (exported for the live narrator — same anchor voice as renders). */
export function synthEdgeNeural(text: string, voice: string, timeoutMs = 60000, rate = EDGE_RATE, pitch = EDGE_PITCH): Promise<Buffer> {
  return new Promise((resolve, reject) => {
    const connectId = [...crypto.getRandomValues(new Uint8Array(16))]
      .map(b => b.toString(16).padStart(2, '0'))
      .join('');
    const url =
      'wss://speech.platform.bing.com/consumer/speech/synthesize/readaloud/edge/v1' +
      `?TrustedClientToken=${EDGE_TOKEN}&ConnectionId=${connectId}` +
      `&Sec-MS-GEC=${generateSecMsGec()}&Sec-MS-GEC-Version=${EDGE_GEC_VERSION}`;
    const ws = new WebSocket(url, {
      headers: {
        Pragma: 'no-cache',
        'Cache-Control': 'no-cache',
        Origin: 'chrome-extension://jdiccldimpdaibmpdkjnbmckianbfold',
        'User-Agent':
          'Mozilla/5.0 (Windows NT 10.0; Win64; x64) AppleWebKit/537.36 (KHTML, like Gecko) Chrome/143.0.0.0 Safari/537.36 Edg/143.0.0.0',
        'Accept-Encoding': 'gzip, deflate, br',
        'Accept-Language': 'en-US,en;q=0.9'
      }
    });
    const chunks: Buffer[] = [];
    const requestId = [...crypto.getRandomValues(new Uint8Array(16))]
      .map(b => b.toString(16).padStart(2, '0'))
      .join('');
    const fail = (msg: string) => {
      try { ws.close(); } catch { /* ignore */ }
      reject(new Error(msg));
    };
    const timer = setTimeout(() => fail('Edge TTS timed out'), timeoutMs);
    ws.on('open', () => {
      ws.send(
        `X-Timestamp:${edgeDateToString()}\r\nContent-Type:application/json; charset=utf-8\r\nPath:speech.config\r\n\r\n` +
        `{"context":{"synthesis":{"audio":{"metadataoptions":{"sentenceBoundaryEnabled":"false","wordBoundaryEnabled":"false"},"outputFormat":"audio-24khz-48kbitrate-mono-mp3"}}}}`
      );
       // Split into sentences and insert short pauses so the neural voice
       // reads with natural cadence instead of one flat run-on stream.
       const sentences = (text.match(/[^.!?]+[.!?]+/g) || [text])
         .map(s => s.trim())
         .filter(Boolean);
       const inner = sentences.length > 0
         ? sentences.map(s => `${escapeSsml(s)}<break time="300ms"/>`).join(' ')
         : escapeSsml(text);
       const ssml =
         `<speak version='1.0' xmlns='http://www.w3.org/2001/10/synthesis' xml:lang='en-US'>` +
         `<voice name='${voice}'><prosody rate='${rate}' pitch='${pitch}'>${inner}</prosody></voice></speak>`;
      ws.send(`X-RequestId:${requestId}\r\nContent-Type:application/ssml+xml\r\nX-Timestamp:${edgeDateToString()}Z\r\nPath:ssml\r\n\r\n${ssml}`);
    });
    ws.on('message', (data: WebSocket.RawData, isBinary: boolean) => {
      const buf = Buffer.isBuffer(data) ? data : Buffer.from(data as Uint8Array);
      if (!isBinary) {
        const sep = buf.indexOf('\r\n\r\n');
        const head = buf.toString('utf8', 0, sep === -1 ? buf.length : sep);
        if (head.includes('Path:turn.end')) {
          clearTimeout(timer);
          try { ws.close(); } catch { /* ignore */ }
          resolve(Buffer.concat(chunks));
        }
        return;
      }
      // Binary frame: first 2 bytes (big-endian) = header length.
      if (buf.length < 2) return;
      const headerLen = buf.readUInt16BE(0);
      if (2 + headerLen > buf.length) return;
      const head = buf.toString('utf8', 2, 2 + headerLen);
      const audio = buf.subarray(2 + headerLen);
      if (head.includes('Path:audio') && audio.length > 0) chunks.push(audio);
    });
    ws.on('error', () => fail('Edge TTS connection failed'));
    ws.on('unexpected-response', (_req, res) => fail(`Edge TTS rejected (HTTP ${res.statusCode})`));
  });
}

/**
 * Clean prose for TTS (guide §4): strip markdown, links and emoji-ish marks
 * an LLM/script may contain so they are never read aloud.
 */
function cleanForTts(s: string): string {
  return s
    .replace(/https?:\S+/g, ' ')
    .replace(/\[\d+\]/g, ' ') // grounded-answer citation markers
    .replace(/\(Source:[^)]*\)/gi, ' ')
    .replace(/[#*_`>\[\]()|]/g, ' ')
    .replace(/\s+/g, ' ')
    .trim();
}

/**
 * Generate natural voice narration: Edge neural anchor first, Google TTS
 * robot only as last-resort fallback.
 */
/** Write a minimal WAV container around raw PCM (24kHz mono s16le from Gemini). */
function writeWavFile(filePath: string, pcm: Buffer, sampleRate: number, channels: number, bitsPerSample: number): void {
  const byteRate = sampleRate * channels * (bitsPerSample / 8);
  const blockAlign = channels * (bitsPerSample / 8);
  const header = Buffer.alloc(44);
  header.write('RIFF', 0);
  header.writeUInt32LE(36 + pcm.length, 4);
  header.write('WAVE', 8);
  header.write('fmt ', 12);
  header.writeUInt32LE(16, 16);
  header.writeUInt16LE(1, 20); // PCM
  header.writeUInt16LE(channels, 22);
  header.writeUInt32LE(sampleRate, 24);
  header.writeUInt32LE(byteRate, 28);
  header.writeUInt16LE(blockAlign, 32);
  header.writeUInt16LE(bitsPerSample, 34);
  header.write('data', 36);
  header.writeUInt32LE(pcm.length, 40);
  fs.writeFileSync(filePath, Buffer.concat([header, pcm]));
}

/**
 * Gemini TTS (natural, uses the existing GEMINI_API_KEY). Returns byte size
 * written, or throws on failure so callers can fall back.
 */
async function generateGeminiVoiceAudio(text: string, outputPath: string, voiceId?: string): Promise<number> {
  const key = String(process.env.GEMINI_API_KEY || '').trim();
  if (!key) throw new Error('GEMINI_API_KEY not set');
  const ai = new GoogleGenAI({ apiKey: key });
  const model = process.env.GEMINI_TTS_MODEL || 'gemini-2.5-flash-preview-tts';
  // Map the selected narrator (Edge voice id) to a natural Gemini voice so the
  // user's choice is honored; fall back to a varied pick when unknown.
  const geminiVoiceMap: Record<string, string> = {
    'anchor-prime': 'Kore',
    'anchor-deep': 'Charon',
    'anchor-live': 'Fenrir',
    'anchor-bold': 'Puck',
    'anchor-friendly': 'Aoede',
    'anchor-studio': 'Orus',
  };
  const geminiVoices = ['Kore', 'Puck', 'Charon', 'Fenrir', 'Aoede', 'Leda', 'Orus', 'Zephyr'];
  const forced = String(process.env.GEMINI_TTS_VOICE || '').trim();
  const mapped = voiceId ? geminiVoiceMap[voiceId] : undefined;
  const voiceName = forced || mapped || geminiVoices[Math.floor(Math.random() * geminiVoices.length)];
  const r = await ai.models.generateContent({
    model,
    contents: text,
    config: {
      responseModalities: ['AUDIO'],
      speechConfig: { voiceConfig: { prebuiltVoiceConfig: { voiceName } } }
    }
  });
  const b64 = r?.candidates?.[0]?.content?.parts?.[0]?.inlineData?.data;
  if (!b64) throw new Error('Gemini TTS returned no audio');
  const pcm = Buffer.from(b64, 'base64');
  if (pcm.length < 1000) throw new Error('Gemini TTS returned an empty stream');
  const wavPath = outputPath + '.wav';
  writeWavFile(wavPath, pcm, 24000, 1, 16);
  try {
    await execAsync(
      `"${ffmpegBin()}" -y -i "${wavPath}" -c:a libmp3lame -q:a 2 "${outputPath}"`,
      { maxBuffer: 16 * 1024 * 1024, timeout: 120000 }
    );
  } finally {
    try { fs.unlinkSync(wavPath); } catch { /* ignore */ }
  }
  if (!fs.existsSync(outputPath) || fs.statSync(outputPath).size < 500) {
    throw new Error('Gemini TTS mp3 encode failed');
  }
  return fs.statSync(outputPath).size;
}

export async function generateNaturalVoiceAudio(text: string, outputPath: string, voiceId?: string): Promise<number> {
  // Use concise narration for short-form video pacing (approx 35-45 words)
  const raw = text.length > 350 ? text.slice(0, 350) + '...' : text;
  const narration = cleanForTts(raw) || raw;

  const v = resolveTemplateVoice(voiceId);

  // 1. Gemini TTS (most natural, uses the existing API key) when enabled.
  if (String(process.env.GEMINI_TTS || '1').trim() !== '0') {
    try {
      const size = await generateGeminiVoiceAudio(narration, outputPath, voiceId);
      if (size > 500) return size;
    } catch (gemErr: any) {
      console.warn(`[Voice] Gemini TTS unavailable (${String(gemErr?.message || gemErr).slice(0, 120)}) — falling back to Edge neural.`);
    }
  }

  // 2. Edge neural TTS (keyless, natural-ish).
  try {
    const neural = await synthEdgeNeural(narration, v.voice, 60000, v.rate, v.pitch);
    if (neural.length > 1000) {
      fs.writeFileSync(outputPath, neural);
      return neural.length;
    }
    throw new Error('Edge TTS returned an empty stream');
  } catch (edgeErr: any) {
    console.warn(`[Voice] Edge neural TTS unavailable (${edgeErr.message}) — falling back to Google TTS.`);
  }

  // 3. Google TTS (last resort, robotic).
  const chunks = await googleTTS.getAllAudioBase64(narration, {
    lang: 'en',
    slow: false,
    timeout: 10000
  });

  const buffers = chunks.map(c => Buffer.from(c.base64, 'base64'));
  const fullAudio = Buffer.concat(buffers);
  fs.writeFileSync(outputPath, fullAudio);

  return fullAudio.length;
}

/**
 * Download a single image URL into outputPath.
 */
export async function downloadThumbnail(imageUrl: string, outputPath: string): Promise<boolean> {
  if (!imageUrl || !imageUrl.startsWith('http')) return false;

  try {
    const controller = new AbortController();
    const timeout = setTimeout(() => controller.abort(), 8000);
    const res = await fetch(imageUrl, {
      signal: controller.signal,
      headers: {
        'User-Agent': 'Mozilla/5.0 (Windows NT 10.0; Win64; x64) AppleWebKit/537.36'
      }
    });
    clearTimeout(timeout);

    if (!res.ok) return false;
    const arrayBuf = await res.arrayBuffer();
    if (arrayBuf.byteLength < 500) return false;

    const buf = Buffer.from(arrayBuf);
    // Accept photographic containers only (skip tracking pixels / svg).
    const isJpg = buf[0] === 0xff && buf[1] === 0xd8;
    const isPng = buf[0] === 0x89 && buf[1] === 0x50;
    const isWebp = buf[0] === 0x52 && buf[1] === 0x49;
    if (!isJpg && !isPng && !isWebp) return false;

    fs.writeFileSync(outputPath, buf);
    return true;
  } catch (err: any) {
    console.warn(`[Thumbnail download fallback] ${err.message}`);
    return false;
  }
}

/** Shared generic placeholders carry no topic signal — treat as "no photo"
 *  so missing slots fall back to the neutral gradient instead of rendering
 *  the same (or a random seeded) opening shot for every trend. This includes
 *  the picsum seeded fallback: a random landscape, NOT the trend's own
 *  Google photo, so it must never become a shot. */
const PLACEHOLDER_PHOTO_IDS = new Set([
  'photo-1504711434969-e33886168f5c', // trendingNow legacy shared placeholder
  'photo-1585829365295-ab7cd400c167', // custom-trend shared placeholder
  // Seed-demo stock photos (mockTrends): generic, banned as sources — the
  // engine renders its own gradient/panel instead of hotlinking Unsplash.
  'photo-1508098682722-e99c43a406b2',
  'photo-1517976487502-5f7154ff7177',
  'photo-1591488320449-011701bb6704',
  'photo-1451187580459-43490279c0fa',
  'photo-1574629810360-7efbbe195018',
  'photo-1431324155629-1a6deb1dec8d',
  'photo-1518609878373-06d740f60d8b',
  'photo-1522778119026-d647f0596c20',
]);
function isPlaceholderPhoto(url: string | undefined): boolean {
  if (!url) return true;
  if (url.includes('picsum.photos/seed/')) return true;
  for (const id of PLACEHOLDER_PHOTO_IDS) {
    if (url.includes(id)) return true;
  }
  return false;
}

// Keyless AI-scene generation REMOVED (slow + low quality): empty slots
// reuse Google photos, and a neutral gradient covers the no-photo case.

/**
 * Trend photo frame: up to 3 usable photos of this trend (1..3) composed
 * into ONE 1080x1920 slide — stacked panels on a dark card.
 * A single photo is returned as-is (the caller renders it native
 * full-bleed); 2+ photos become the grid card so every photo appears
 * without blurry full-bleed upscaling.
 * Returns the composite path, or null on any failure (never throws).
 */
const PHOTO_FRAME_MAX = 3;
async function buildPhotoGrid(opts: {
  jobId: string;
  photos: string[];
  tempDir: string;
  onLog?: RenderVideoOptions['onLog'];
}): Promise<string | null> {
  const pics = opts.photos.filter(p => p && fs.existsSync(p)).slice(0, PHOTO_FRAME_MAX);
  if (pics.length < 2) return null;
  const { jobId, tempDir, onLog } = opts;
  const out = path.join(tempDir, `${jobId}_photoframe.jpg`);
  try {
    // Vertical stack: equal panels with small gaps, centered on a dark card.
    const n = pics.length;
    const marginX = 80, topMargin = 150, bottomMargin = 150, gap = 20;
    const panelW = 1080 - marginX * 2;
    const panelH = Math.floor((1920 - topMargin - bottomMargin - gap * (n - 1)) / n);
    const layouts = pics.map((_, i) => ({
      w: panelW, h: panelH, x: marginX, y: topMargin + i * (panelH + gap)
    }));
    const scales = pics.map((_, i) =>
      `[${i}:v]scale=${layouts[i].w}:${layouts[i].h}:force_original_aspect_ratio=increase,crop=${layouts[i].w}:${layouts[i].h},setsar=1[p${i}]`
    ).join(';');
    let fc = `${scales};color=size=1080x1920:color=0x0b1120[bg]`;
    let cur = 'bg';
    layouts.forEach((l, i) => {
      fc += `;[${cur}][p${i}]overlay=${l.x}:${l.y}[ov${i}]`;
      cur = `ov${i}`;
    });
    layouts.forEach((l, i) => {
      const nxt = i === layouts.length - 1 ? 'frlast' : `fr${i}`;
      fc += `;[${cur}]drawbox=x=${l.x}:y=${l.y}:w=${l.w}:h=${l.h}:color=white@0.55:t=4[${nxt}]`;
      cur = nxt;
    });
    fc += `;[${cur}]format=yuv420p[out]`;
    const inputs = pics.map(p => `-i "${p}"`).join(' ');
    await execAsync(
      `"${ffmpegBin()}" -y ${inputs} -filter_complex "${fc}" -map "[out]" -frames:v 1 -q:v 3 "${out}"`,
      { maxBuffer: 32 * 1024 * 1024, timeout: 180000 }
    );
    if (fs.existsSync(out) && fs.statSync(out).size > 500) {
      onLog?.('Asset Pipeline', `Trend photo frame ready (all ${pics.length} trend photos in one frame)`, 'success');
      return out;
    }
  } catch (err: any) {
    onLog?.('Asset Pipeline', `Photo frame skipped (${(err as Error)?.message || err}) — first photo continues solo`, 'warn');
  }
  return null;
}

/**
 * Fixed story pipeline (Google photos + Instagram clip only — NO AI scenes):
 *  Shot 0 = ONE frame holding up to 3 usable photos of this trend (1..3):
 *    - 1 photo  -> the photo itself (rendered native full-bleed),
 *    - 2+ photos -> a single grid card with all of them.
 *  Everything after shot 0 = the downloaded Instagram motion clip.
 * With NO photo at all NO gradient is generated (owner request 2026-10-10):
 * the caller renders the downloaded clip full-bleed as one continuous short
 * instead. Returns 0-1 still paths (empty = no-photo case).
 */
async function collectStoryVisuals(opts: {
  jobId: string;
  keyword: string;
  imageUrl?: string;
  extraImageUrls?: string[];
  tempDir: string;
  onLog?: RenderVideoOptions['onLog'];
}): Promise<{ paths: string[]; methods: string[] }> {
  const { jobId, keyword, tempDir, onLog } = opts;
  const paths: string[] = [];
  const methods: string[] = [];

  const push = (p: string, method: string) => {
    if (fs.existsSync(p) && fs.statSync(p).size > 500) {
      paths.push(p);
      methods.push(method);
    }
  };

  // Download the trend's OWN photos: main picture first, then news-source
  // photos (extraImageUrls carries trend.storyImageUrls + news pictures).
  // Placeholders never count: identical (or random) for every trend.
  // Capped at PHOTO_FRAME_MAX so one photo-heavy trend can't stall the cut.
  const downloaded: string[] = [];
  {
    const seen = new Set<string>();
    const urls: string[] = [];
    if (opts.imageUrl?.startsWith('http') && !isPlaceholderPhoto(opts.imageUrl)) {
      urls.push(opts.imageUrl);
      // Seed `seen` with the primary so the SAME URL appearing again in
      // extraImageUrls is not downloaded a second time (which would show the
      // identical photo twice in the frame-0 grid).
      seen.add(opts.imageUrl);
    }
    for (const url of opts.extraImageUrls || []) {
      if (urls.length >= PHOTO_FRAME_MAX) break;
      if (!url?.startsWith('http') || seen.has(url) || isPlaceholderPhoto(url)) continue;
      seen.add(url);
      urls.push(url);
    }
    let slot = 0;
    for (const url of urls) {
      const out = path.join(tempDir, `${jobId}_news${slot}.jpg`);
      slot++;
      if (await downloadThumbnail(url, out)) downloaded.push(out);
      if (downloaded.length >= PHOTO_FRAME_MAX) break;
    }
  }

  // No Google photo at all: return EMPTY — the caller substitutes the
  // downloaded Instagram motion clip full-bleed (continuous short, no
  // gradient). Gradient cover was removed per owner request 2026-10-10.
  if (downloaded.length === 0) {
    onLog?.('Asset Pipeline', 'No Google photos — Instagram clip becomes the full background (no gradient)', 'warn');
    return { paths, methods };
  }

  // Shot 0 — ONE frame with every photo of this trend.
  if (downloaded.length === 1) {
    push(downloaded[0], 'rss-photo');
    onLog?.('Asset Pipeline', `Shot 0 locked: single Google trend photo`, 'success');
  } else {
    const grid = await buildPhotoGrid({ jobId, photos: downloaded, tempDir, onLog });
    if (grid) {
      push(grid, 'google-grid');
    } else {
      // Grid failed: first photo still covers shot 0 on its own.
      push(downloaded[0], 'rss-photo');
    }
  }

  onLog?.('Asset Pipeline', `Shot 0 locked (${methods.join(' / ')}) — all ${downloaded.length} trend photos in one frame, rest is the downloaded clip`, 'success');
  return { paths, methods };
}

async function probeDuration(filePath: string, fallback: number): Promise<number> {
  try {
    const { stdout } = await execAsync(
      `"${FFPROBE_BIN}" -v error -show_entries format=duration -of default=noprint_wrappers=1:nokey=1 "${filePath}"`,
      { timeout: 30000, maxBuffer: 1024 * 1024 }
    );
    const parsed = parseFloat(stdout.trim());
    if (!isNaN(parsed) && parsed > 0) return Math.round(parsed * 10) / 10;
  } catch (err: any) {
    console.warn(`Duration probe fallback: ${err.message}`);
  }
  return fallback;
}

// ---------------------------------------------------------------------------
// Subscribe bumper: a ready-made 9:16 end-card (gradient backdrop, SUBSCRIBE
// button, bell prompt) shown for exactly 1 second — NO narration. Silent so it
// only adds a 1s visual tail, keeping the Short short (owner request).
// Appended to every template video via concat (silent track keeps A/V concat).
// ---------------------------------------------------------------------------
const BUMPER_SEC = 1;

async function renderSubscribeBumper(opts: {
  jobId: string;
  keyword: string;
  tempDir: string;
  theme: Theme;
  voiceId?: string;
  onLog?: RenderVideoOptions['onLog'];
}): Promise<{ videoPath: string; audioPath: string; durationSec: number }> {
  const { jobId, keyword, tempDir, theme, onLog } = opts;
  const cleanKeyword = sanitizeFfmpegText(keyword, 30).toUpperCase();

  // Ready-made subscribe end-card (user-provided artwork). Drop the file at
  // assets/subscribe-endcard.jpg (.png/.jpeg also accepted) and the bumper
  // uses it as-is — no generated text on top. Falls back to the generated
  // gradient + text bumper only when the artwork file is missing.
  const artwork = ['subscribe-endcard.jpg', 'subscribe-endcard.png', 'subscribe-endcard.jpeg']
    .map(f => path.join(process.cwd(), 'assets', f))
    .find(f => fs.existsSync(f));
  const useArtwork = !!artwork;

  const bgPath = useArtwork
    ? (artwork as string)
    : path.join(tempDir, `${jobId}_bumper_bg.bmp`);
  if (!useArtwork) writeGradientBmp(bgPath, 4, 210);

  const dur = BUMPER_SEC;
  // Silent track (no voice): the card is a mute 1s end-frame. The concat step
  // needs an audio stream on every input, so generate exact-length silence.
  const audioPath = path.join(tempDir, `${jobId}_bumper.m4a`);
  await execAsync(
    `"${ffmpegBin()}" -y -f lavfi -i anullsrc=r=48000:cl=stereo -t ${dur} -c:a aac -b:a 128k "${audioPath}"`,
    { maxBuffer: 16 * 1024 * 1024, timeout: 60000 }
  );

  // (Slide-in text animation was evaluated; static broadcast cards proved
  // more legible at Shorts Figurine sizes, so the bumper uses fixed cards.)
  // Artwork bumper: the image already carries every graphic (subscribe,
  // bell, link) — just present it full-bleed for the 1s tail.
  const fc = useArtwork
    ? [
        `[0:v]scale=1080:1920:force_original_aspect_ratio=increase,crop=1080:1920,fps=30,setsar=1,` +
        `drawbox=x=0:y=1908:w=1080:h=12:color=0x334155@0.8:t=fill,` +
        `drawbox=x=0:y=1908:w=\x271080*(t/${dur})\x27:h=12:color=${theme.rule}@1.0:t=fill[outv]`
      ].join(';')
    : [
    `[0:v]scale=1080:1920,fps=30,setsar=1[bg]`,
    `[bg]drawbox=x=0:y=0:w=1080:h=1920:color=black@0.35:t=fill,` +
    `drawbox=x=0:y=120:w=1080:h=6:color=${theme.rule}@1.0:t=fill,` +
    `drawbox=x=170:y=410:w=740:h=150:color=${theme.sub}@1.0:t=fill,` +
    `drawbox=x=170:y=410:w=740:h=150:color=white@0.95:t=5,` +
    `drawbox=x=0:y=1100:w=1080:h=4:color=${theme.rule}@1.0:t=fill,` +
    `drawbox=x=0:y=1908:w=1080:h=12:color=0x334155@0.8:t=fill,` +
    `drawbox=x=0:y=1908:w=\x271080*(t/${dur})\x27:h=12:color=${theme.rule}@1.0:t=fill[outv]`
  ].join(';');

  const videoPath = path.join(tempDir, `${jobId}_bumper.mp4`);
  await execAsync(
    `"${ffmpegBin()}" -y -loop 1 -t ${dur} -i "${bgPath}" -i "${audioPath}" ` +
    `-filter_complex "${fc}" -map "[outv]" -map 1:a -t ${dur} ` +
    `-c:v libx264 -pix_fmt yuv420p -preset ultrafast -crf 26 -r 30 -c:a aac -b:a 128k -movflags +faststart "${videoPath}"`,
    { maxBuffer: 64 * 1024 * 1024, timeout: 600000 }
  );
  onLog?.('Video Assembly', `Subscribe bumper ready (${dur}s silent end-card — no narration)`, 'success');
  return { videoPath, audioPath, durationSec: dur };
}

/** Delete all intermediate files for a job from the render temp dir
 *  (story photos, IG clip, bumper audio, backdrops). Final deliverables
 *  live in public/videos and are never touched. Never throws. */
export function cleanupJobTempFiles(jobId: string): void {
  try {
    const tempDir = path.join(process.cwd(), 'temp', 'renders');
    if (!fs.existsSync(tempDir)) return;
    const prefix = `${jobId}_`;
    for (const f of fs.readdirSync(tempDir)) {
      if (f.startsWith(prefix)) {
        try { fs.unlinkSync(path.join(tempDir, f)); } catch { /* ignore */ }
      }
    }
  } catch { /* never fail a render/publish over temp cleanup */ }
}

/**
 * Renders a full 1080x1920 (9:16) MP4 video ready for YouTube Shorts & TikTok:
 * shot 0 = ONE frame with up to 3 trend photos, then the downloaded Instagram
 * clip; overlays, scrolling top ticker, neural narration, plus a 1s SILENT
 * subscribe end-card. No center hook-flash text on the photo (owner request).
 */
export async function renderShortMp4(options: RenderVideoOptions): Promise<RenderVideoResult> {
  const {
    jobId,
    keyword,
    question,
    category,
    imageUrl,
    extraImageUrls,
    fullScript,
    primaryPublisher = 'Verified News Wires',
    primaryNews = '',
    rawTraffic = '10K+',
    scenes,
    voice,
    onLog
  } = options;

  const publicVideosDir = path.join(process.cwd(), 'public', 'videos');
  const tempDir = path.join(process.cwd(), 'temp', 'renders');

  if (!fs.existsSync(publicVideosDir)) fs.mkdirSync(publicVideosDir, { recursive: true });
  if (!fs.existsSync(tempDir)) fs.mkdirSync(tempDir, { recursive: true });

  const audioPath = path.join(publicVideosDir, `${jobId}.mp3`);
  const videoPath = path.join(publicVideosDir, `${jobId}.mp4`);
  const mainPath = path.join(tempDir, `${jobId}_main.mp4`);

  // Step 1: Voice Generation (neural anchor, user-selected preset)
  const narrationVoiceLabel = TEMPLATE_VOICES.find(v => v.id === voice)?.label || 'Deep News Anchor';
  onLog?.('Voice Engine', `Synthesizing neural news-anchor narration (${narrationVoiceLabel})...`);
  await generateNaturalVoiceAudio(fullScript, audioPath, voice);
  onLog?.('Voice Engine', 'Neural narration mastered into 24kHz stream', 'success');

  // Detect precise audio duration
  const audioDuration = await probeDuration(audioPath, 28);

  // Step 2: Story visuals in pipeline order —
  // shot 0 Google photo, shot 1 news-photo frame, then IG clip coverage.
  onLog?.('Asset Pipeline', 'Collecting shot 0 (Google photo) + news-photo frame...');
  const { paths: shots, methods } = await collectStoryVisuals({
    jobId, keyword, imageUrl, extraImageUrls, tempDir, onLog
  });
  let visualMethod = methods[0] || 'kinetic';

  // Instagram motion clip for the post-shot-0 slot: searched by trend
  // phrase + description/question (QC-gated), downloaded via the downloader
  // service. Null on any failure or QC reject — the still-image flow below
  // then continues untouched.
  let instaClip: string | null = null;
  if (!options.skipInstagramClip) {
    try {
      onLog?.('Instagram Clip QC', `QC search for "${keyword}" — topic must match title/snippet or clip is rejected`);
      instaClip = await fetchInstagramClip(keyword, { jobId, tempDir, onLog }, {
        description: `${primaryNews || ''} ${category || ''}`,
        question,
      });
    } catch {
      instaClip = null;
    }
    if (!instaClip) onLog?.('Instagram Clip', 'Continuing with the still-image cut', 'info');
  }

  // Step 3: Captions & texts (kept short so nothing spills outside the 1080 frame)
  const cleanKeyword = sanitizeFfmpegText(keyword, 30).toUpperCase();
  const cleanQuestion = sanitizeFfmpegText(question, 55).toUpperCase();
  const questionLines = wrapText(cleanQuestion, 20);
  const qLine1 = sanitizeFfmpegText(questionLines[0] || `WHY IS ${cleanKeyword} TRENDING?`, 24);
  const qLine2 = sanitizeFfmpegText(questionLines[1] || '', 24);
  // Top scrolling ticker: live trend news headlines (all source titles +
  // description), joined with +++ and looped so the strip never runs empty.
  const newsItems = (options.tickerNews || [])
    .map(s => String(s || '').replace(/[\r\n]+/g, ' ').trim())
    .filter(Boolean)
    .slice(0, 6);
  const tickerSource = newsItems.length > 0
    ? newsItems.join(' +++ ')
    : `${primaryNews || keyword} +++ ${question}`;
  const tickerText = sanitizeFfmpegText(`${tickerSource} +++ `.repeat(3), 600);
  // Ticker scroll speed (px/s): fast enough to read as motion on a ~28s
  // Short — the old 150px/s crawled. Override via TICKER_SPEED (100..800).
  const TICKER_SPEED = (() => {
    const v = parseFloat(process.env.TICKER_SPEED || '380');
    if (!isFinite(v)) return 380;
    return Math.min(800, Math.max(100, v));
  })();

  // Per-scene caption straps (script scenes) or even quarters as fallback.
  // Kept to ~30 chars so the strap never exceeds its 960px box.
  const FALLBACK_CAPS = ['THE SPARK', 'THE EVIDENCE', 'THE CONTEXT', "WHAT'S NEXT"];
  const straps: SceneCaption[] = (scenes && scenes.length > 0)
    ? scenes.map(s => ({
        start: Math.max(0, s.start),
        end: Math.max(s.start + 0.5, s.end),
        caption: sanitizeFfmpegText(s.caption || FALLBACK_CAPS[0], 30).toUpperCase()
      }))
    : FALLBACK_CAPS.map((c, i) => ({
        start: (audioDuration / 4) * i,
        end: (audioDuration / 4) * (i + 1),
        caption: sanitizeFfmpegText(c, 30).toUpperCase()
      }));

  // Step 4: 2-part assembly — shot 0 (the all-photos frame) first, then
  // the downloaded Instagram clip; single 0.5s crossfade between them.
  // NOTE: every [vX] must end with fps+format+timebase normalization —
  // xfade fails with "frame rate (30/1) vs (1/0)" when trim/setpts sits
  // AFTER fps.
  const XF = 0.5;
  const hasStill = shots.length > 0;
  const clipFile = instaClip && fs.existsSync(instaClip) ? (instaClip as string) : null;
  const twoPart = hasStill && !!clipFile;
  // Two-part split: shot 0 is a SHORT intro card (SHOT0_SEC), the downloaded
  // clip carries the rest (stills less, motion more). Total stays exact:
  // segA + segB - XF = audioDuration.
  const SHOT0_SEC = (() => {
    const v = parseFloat(process.env.SHOT0_SEC || '3');
    if (!isFinite(v)) return 3;
    return Math.min(12, Math.max(2, v));
  })();
  const segA = Math.max(XF + 1, Math.min(SHOT0_SEC, audioDuration - XF - 3));
  const segB = audioDuration - segA + XF;
  const segFrames = Math.round(segA * 30);
  const stillMove =
    `z=\x27min(zoom+0.0009\\,1.18)\x27:x=\x27iw/2-(iw/zoom/2)\x27:y=\x27ih/2-(ih/zoom/2)\x27`;
  const segFilters: string[] = [];
  const firstIsNative = methods[0] === 'rss-photo';
  if (twoPart) {
    onLog?.('Video Assembly', `Pipeline locked: [shot0 all-photos frame ${segA.toFixed(1)}s, rest Instagram clip ${segB.toFixed(1)}s] — ${path.basename(clipFile as string)}`, 'success');
    if (firstIsNative) {
      segFilters.push(
        `[0:v]split=2[0a][0b];` +
        `[0a]scale=1080:1920:force_original_aspect_ratio=increase,crop=1080:1920,boxblur=20:1,setsar=1,fps=30[bg0];` +
        `[0b]scale=1080:1920:force_original_aspect_ratio=decrease:flags=lanczos[fg0];` +
        `[bg0][fg0]overlay=(W-w)/2:(H-h)/2:repeatlast=1,trim=duration=${segA.toFixed(2)},setpts=PTS-STARTPTS,fps=30,format=yuv420p,settb=AVTB,setsar=1[v0]`
      );
    } else {
      segFilters.push(
        `[0:v]scale=1296:2304,zoompan=${stillMove}:d=${segFrames}:s=1080x1920:fps=30,fps=30,format=yuv420p,settb=AVTB,setsar=1[v0]`
      );
    }
    segFilters.push(
      `[1:v]scale=1080:1920:force_original_aspect_ratio=increase,crop=1080:1920,setsar=1,` +
      `trim=duration=${segB.toFixed(2)},setpts=PTS-STARTPTS,fps=30,format=yuv420p,settb=AVTB,setsar=1[v1]`
    );
  }
  // o1 = the cut point: photo->clip cut in two-part mode, first quarter
  // otherwise (top texts only ever cover the opening of the short).
  const o1 = (twoPart ? segA - XF : audioDuration / 4).toFixed(2);
  if (twoPart) {
    segFilters.push(`[v0][v1]xfade=transition=fade:duration=${XF}:offset=${o1}[vx]`);
    segFilters.push(`[vx]setsar=1[vxs]`);
  }

  // Per-scene caption straps, pre-joined (one comma-chained chunk).
  // (Theme is picked below; captions are re-colored there.)
  const strapDefs = straps;

  // Graphic theme: random per render (override via options.theme).
  const theme = pickTheme(options.theme);
  onLog?.('Video Assembly', `Graphic theme: ${theme.name} — building the overlay stack...`);

  // NOTE: no center hook-flash overlay (owner request): extra middle text
  // on the photo frame only clutters it — the photo stays clean.

  const strapChain = strapDefs.map(s =>
    `drawbox=x=60:y=1320:w=960:h=76:color=0x020617@0.88:t=fill:enable=\x27between(t\\,${s.start.toFixed(1)}\\,${s.end.toFixed(1)})\x27,` +
    `drawtext=${HEAD}text=\x27${s.caption}\x27:fontcolor=white:fontsize=30:x=(w-text_w)/2:y=1340:enable=\x27between(t\\,${s.start.toFixed(1)}\\,${s.end.toFixed(1)})\x27:borderw=2:bordercolor=black@0.85,`
  ).join('');

  // Top-of-page texts (trending bar + question card) show only while shot
  // 0 is on screen — they vanish with the cut to the clip.
  const topOnly = `enable=\x27lt(t\\,${o1})\x27`;

  const overlayFilters = [
    // Scrolling news ticker pinned to the TOP (trend headlines, full duration):
    // tall strip with a glossy news-gradient look (layered bands fake the
    // gradient — drawbox has no gradient fill) + theme accent underline,
    // big headline font so it reads at Shorts size.
    `[vxs]drawbox=x=0:y=0:w=1080:h=104:color=0x0b1120@1.0:t=fill,` +
    `drawbox=x=0:y=0:w=1080:h=38:color=white@0.12:t=fill,` +
    `drawbox=x=0:y=38:w=1080:h=34:color=white@0.05:t=fill,` +
    `drawbox=x=0:y=98:w=1080:h=6:color=${theme.bar}@1.0:t=fill,` +
     `drawtext=${HEAD}text=\x27${tickerText}\x27:fontcolor=white:fontsize=46:x=\x27w-mod(${TICKER_SPEED}*t\\,w+text_w)\x27:y=24:borderw=2:bordercolor=black@0.85,` +

    // Real-Time Dynamic Progress Bar (neutral white — no red accent line)
    `drawbox=x=0:y=1908:w=1080:h=12:color=0x334155@0.8:t=fill,` +
    `drawbox=x=0:y=1908:w=\x271080*(t/${audioDuration})\x27:h=12:color=0xffffff@1.0:t=fill[outv]`
  ];

  // Overlay entries form ONE comma-chained filter; segments join with
  // ';'. Do not change the joiners — ':'/',' parsing is positional.
  // Four modes (owner spec):
  //  twoPart     = shot 0 (ALL trend photos, one frame) + downloaded clip,
  //  still-only  = shot 0 alone across the whole narration (no clip found),
  //  full-clip   = downloaded clip across the whole narration (no photos),
  //  solid       = flat dark lavfi color (neither photos nor clip).
  const noStills = !hasStill;
  let filterComplex: string;
  if (twoPart) {
    visualMethod = methods[0] === 'rss-photo' ? 'photo-then-clip' : 'grid-then-clip';
    filterComplex = segFilters.join(';') + ';' + overlayFilters.join('');
  } else {
    visualMethod = hasStill ? methods[0] : (clipFile ? 'instagram-fullclip' : 'solid');
    onLog?.(
      'Video Assembly',
      hasStill
        ? 'Clip missing — single photo frame covers the whole short with a slow drift'
        : clipFile
          ? 'No photos — rendering one continuous Instagram-clip short (no gradient, no stills)'
          : 'No photos and no clip — rendering on a flat dark backdrop (no gradient)',
      hasStill || clipFile ? 'success' : 'warn'
    );
    const overlayOnBase = overlayFilters.join('').replace('[vxs]', '[vbase]');
    let base: string;
    if (hasStill) {
      const stillFrames = Math.round(audioDuration * 30);
      base = firstIsNative
        ? `[0:v]split=2[0a][0b];` +
          `[0a]scale=1080:1920:force_original_aspect_ratio=increase,crop=1080:1920,boxblur=20:1,setsar=1,fps=30[bg0];` +
          `[0b]scale=1080:1920:force_original_aspect_ratio=decrease:flags=lanczos[fg0];` +
          `[bg0][fg0]overlay=(W-w)/2:(H-h)/2:repeatlast=1,trim=duration=${audioDuration.toFixed(2)},setpts=PTS-STARTPTS,fps=30,format=yuv420p,settb=AVTB,setsar=1[vbase];`
        : `[0:v]scale=1296:2304,zoompan=${stillMove}:d=${stillFrames}:s=1080x1920:fps=30,fps=30,format=yuv420p,settb=AVTB,setsar=1[vbase];`;
    } else if (clipFile) {
      base = `[0:v]scale=1080:1920:force_original_aspect_ratio=increase,crop=1080:1920,setsar=1,fps=30,format=yuv420p,settb=AVTB[vbase];`;
    } else {
      base = `[0:v]fps=30,format=yuv420p,settb=AVTB,setsar=1[vbase];`;
    }
    filterComplex = base + overlayOnBase;
  }

  onLog?.('Video Assembly', `Encoding 1080x1920 Short (${audioDuration}s): photo frame -> downloaded clip, with ticker & neural voice...`);

  let inputs = '';
  let narrationIdx = 2;
  if (twoPart) {
    // 2 visual inputs: short shot-0 photo card, then the looped clip (sized
    // to cover its longer segment) — narration.
    const clipWindow = (segB + 2).toFixed(2);
    // -stream_loop -1 (infinite) bounded by -t guarantees the clip covers its
    // whole segment regardless of length; a fixed count under-runs whenever
    // the reel is shorter than segment/count (video ends before the audio).
    inputs = `-framerate 30 -loop 1 -t ${segA.toFixed(2)} -i "${shots[0]}" -stream_loop -1 -t ${clipWindow} -i "${clipFile}"`;
    narrationIdx = 2;
  } else if (hasStill) {
    // Single photo frame across the whole narration — then narration.
    inputs = `-framerate 30 -loop 1 -t ${audioDuration.toFixed(2)} -i "${shots[0]}"`;
    narrationIdx = 1;
  } else if (clipFile) {
    // Single looped clip covering the whole narration — then narration.
    // -stream_loop -1 (infinite) + -t bounds it to the exact duration so a
    // short reel never under-runs the narration.
    inputs = `-stream_loop -1 -t ${audioDuration.toFixed(2)} -i "${clipFile}"`;
    narrationIdx = 1;
  } else {
    throw new Error('No visuals available: no trend photos and no Instagram clip downloaded. Aborting render to avoid a black video.');
  }
  await execAsync(
    `"${ffmpegBin()}" -y ${inputs} -i "${audioPath}" ` +
    `-filter_complex "${filterComplex}" -map "[outv]" -map ${narrationIdx}:a -t ${audioDuration} ` +
    `-c:v libx264 -pix_fmt yuv420p -preset ultrafast -crf 26 -r 30 -c:a aac -b:a 128k -movflags +faststart "${mainPath}"`,
    { maxBuffer: 64 * 1024 * 1024, timeout: 1200000 }
  );

  // Step 6: 1s SILENT subscribe end-card + concat (normalize audio first so
  // concat never fails on sample-rate/channel mismatch between takes; the
  // bumper's silent track keeps the A/V concat valid).
  const bumper = await renderSubscribeBumper({ jobId, keyword, tempDir, theme, onLog });
  await execAsync(
    `"${ffmpegBin()}" -y -i "${mainPath}" -i "${bumper.videoPath}" ` +
    `-filter_complex "[0:a]aformat=sample_rates=48000:channel_layouts=stereo[a0];[1:a]aformat=sample_rates=48000:channel_layouts=stereo[a1];[0:v][a0][1:v][a1]concat=n=2:v=1:a=1[outv][outa]" ` +
    `-map "[outv]" -map "[outa]" -c:v libx264 -profile:v high -level 4.0 -pix_fmt yuv420p -preset ultrafast -crf 26 -r 30 ` +
    `-c:a aac -b:a 128k -ar 48000 -ac 2 -movflags +faststart "${videoPath}"`,
    { maxBuffer: 64 * 1024 * 1024, timeout: 600000 }
  );

  try { fs.unlinkSync(mainPath); } catch { /* ignore */ }
  try { fs.unlinkSync(bumper.videoPath); } catch { /* ignore */ }
  // Temps served their purpose (ffmpeg assembly) — free the disk now.
  cleanupJobTempFiles(jobId);

  // Per-video poster frame (shot 0, ~1.2s in): the list UI and the player
  // poster use THIS file, so every video shows its own opening shot instead
  // of one shared preview image. Never throws (list falls back gracefully).
  try {
    const thumbPath = path.join(publicVideosDir, `${jobId}_thumb.jpg`);
    await execAsync(
      `"${ffmpegBin()}" -y -ss 1.2 -i "${videoPath}" -vframes 1 -q:v 3 "${thumbPath}"`,
      { maxBuffer: 16 * 1024 * 1024, timeout: 60000 }
    );
  } catch { /* poster optional */ }

  const stats = fs.statSync(videoPath);
  const totalDur = Math.round((audioDuration + bumper.durationSec) * 10) / 10;
  onLog?.('Video Assembly', `Rendered CNN-style 9:16 MP4 (${Math.round(stats.size / 1024)} KB, ${totalDur}s incl. subscribe bumper).`, 'success');

  return {
    videoUrl: `/videos/${jobId}.mp4`,
    audioUrl: `/videos/${jobId}.mp3`,
    videoFilePath: videoPath,
    fileSizeBytes: stats.size,
    durationSec: totalDur,
    visualMethod
  };
}
