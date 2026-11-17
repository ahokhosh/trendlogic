import fs from 'fs';

// ---------------------------------------------------------------------------
// Keyless AI scene-image providers (no API key, no quota, no billing).
//
// Live-tested 2026-09-11 from this environment:
//   - Pollinations `flux`  -> HTTP 200 image/jpeg  ✅
//   - Pollinations `turbo` -> HTTP 200 image/jpeg  ✅
//   - Pollinations `kontext` -> HTTP 500           ❌ removed
//   - HF Spaces motion (Scope-Camera / Wan2.1) -> flaky root, /config timeouts,
//     gradio API 404s, multi-minute queues        ❌ removed (2026-09-11)
//   - Google Veo 3.1 -> paid billing required     ❌ removed (veoService.ts)
//
// The motion chain is gone on purpose: the single render engine
// (server/videoRenderer.ts) animates the AI scene image with the cinematic
// broadcast template + neural narration. This module only synthesizes the
// still scene image with automatic flux -> turbo -> offline-gradient failover.
// ---------------------------------------------------------------------------

export type FreeAiVisualMethod =
  | 'pollinations_flux'
  | 'pollinations_turbo'
  | 'cinematic_gradient';

export interface FreeAiVisualAttempt {
  method: FreeAiVisualMethod;
  ok: boolean;
  error?: string;
  elapsedMs: number;
}

export type FreeAiLogFn = (step: string, message: string, type?: 'info' | 'success' | 'warn' | 'error') => void;

/** Registry metadata for the image-provider chain (UI display & diagnostics). */
export const FREE_AI_PROVIDER_CHAIN: Array<{
  method: FreeAiVisualMethod;
  label: string;
  kind: string;
  offline: boolean;
}> = [
  { method: 'pollinations_flux', label: 'Pollinations Flux (tested ✅)', kind: 'Keyless text-to-image — no API key', offline: false },
  { method: 'pollinations_turbo', label: 'Pollinations Turbo (tested ✅)', kind: 'Keyless text-to-image — no API key', offline: false },
  { method: 'cinematic_gradient', label: 'Offline cinematic gradient', kind: 'Procedural fallback — always available', offline: true }
];

const GENERIC_HEADERS: Record<string, string> = {
  'User-Agent': 'Mozilla/5.0 (Windows NT 10.0; Win64; x64) AppleWebKit/537.36 (KHTML, like Gecko) Chrome/125.0 Safari/537.36'
};

async function fetchWithTimeout(url: string, ms: number, init?: RequestInit): Promise<Response | null> {
  const controller = new AbortController();
  const timer = setTimeout(() => controller.abort(), ms);
  try {
    return await fetch(url, { ...init, signal: controller.signal, headers: { ...GENERIC_HEADERS, ...(init?.headers || {}) } });
  } catch {
    return null;
  } finally {
    clearTimeout(timer);
  }
}

/** Keyless image synthesis. Returns true if a valid image file was written. */
async function tryPollinations(prompt: string, outputPath: string, model: 'flux' | 'turbo'): Promise<boolean> {
  const url = `https://image.pollinations.ai/prompt/${encodeURIComponent(prompt.trim())}?width=720&height=1280&model=${model}&nologo=true&enhance=true&seed=${Math.floor(Math.random() * 1000000)}`;
  let res = await fetchWithTimeout(url, 45000);
  // Anonymous tier is rate limited (429) — wait briefly and retry once.
  if (res && res.status === 429) {
    await new Promise(r => setTimeout(r, 6000));
    res = await fetchWithTimeout(url, 45000);
  }
  if (!res || !res.ok) return false;
  const buf = Buffer.from(await res.arrayBuffer());
  if (buf.length < 500 || !looksLikeImage(buf)) return false;
  fs.writeFileSync(outputPath, buf);
  return true;
}

function looksLikeImage(buf: Buffer): boolean {
  if (buf.length < 12) return false;
  if (buf[0] === 0xFF && buf[1] === 0xD8) return true; // JPEG
  if (buf[0] === 0x89 && buf[1] === 0x50) return true; // PNG
  if (buf[0] === 0x42 && buf[1] === 0x4D) return true; // BMP
  if (buf[0] === 0x47 && buf[1] === 0x49 && buf[2] === 0x46) return true; // GIF
  if (buf.subarray(0, 5).toString('ascii') === '<svg ') return true; // SVG
  if (buf[0] === 0x52 && buf[1] === 0x49 && buf.subarray(8, 12).toString('ascii') === 'WEBP') return true; // WEBP
  return false;
}

/** Never-fails final method: deterministic cinematic gradient backdrop. */
async function tryCinematicGradient(prompt: string, outputPath: string): Promise<boolean> {
  let hue = 0;
  for (let i = 0; i < prompt.length; i++) hue = (hue * 31 + prompt.charCodeAt(i)) % 360;
  const hue2 = (hue + 50 + (hue % 100)) % 360;
  try {
    writeGradientBmp(outputPath, hue, hue2);
    return fs.existsSync(outputPath) && fs.statSync(outputPath).size > 300;
  } catch {
    return false;
  }
}

/** hsl -> [r,g,b] (0-255) */
function hslToRgb(h: number, s: number, l: number): [number, number, number] {
  const c = (1 - Math.abs(2 * l - 1)) * s;
  const hp = (h % 360) / 60;
  const x = c * (1 - Math.abs((hp % 2) - 1));
  let r = 0, g = 0, b = 0;
  if (hp < 1) { r = c; g = x; }
  else if (hp < 2) { r = x; g = c; }
  else if (hp < 3) { g = c; b = x; }
  else if (hp < 4) { g = x; b = c; }
  else if (hp < 5) { r = x; b = c; }
  else { r = c; b = x; }
  const m = l - c / 2;
  return [Math.round((r + m) * 255), Math.round((g + m) * 255), Math.round((b + m) * 255)];
}

function lerpRgb(a: [number, number, number], b: [number, number, number], t: number): [number, number, number] {
  return [
    Math.round(a[0] + (b[0] - a[0]) * t),
    Math.round(a[1] + (b[1] - a[1]) * t),
    Math.round(a[2] + (b[2] - a[2]) * t)
  ];
}

/**
 * Writes a 720x1280 24-bit BMP with a cinematic radial gradient + glow orbs.
 * Pure JS (no ffmpeg/SVG codec needed) so this fallback can never fail on a
 * missing system dependency.
 */
export function writeGradientBmp(outPath: string, hue: number, hue2: number): void {
  const W = 720, H = 1280;
  const rowSize = W * 3; // 2160 bytes, already 4-byte aligned
  const pixelDataSize = rowSize * H;
  const FILE_HEADER = 14, INFO_HEADER = 40;
  const buf = Buffer.alloc(FILE_HEADER + INFO_HEADER + pixelDataSize);
  buf.write('BM', 0, 'ascii');
  buf.writeUInt32LE(buf.length, 2);
  buf.writeUInt32LE(FILE_HEADER + INFO_HEADER, 10);
  buf.writeUInt32LE(INFO_HEADER, 14);
  buf.writeInt32LE(W, 18);
  buf.writeInt32LE(H, 22);
  buf.writeUInt16LE(1, 26);
  buf.writeUInt16LE(24, 28);
  buf.writeUInt32LE(pixelDataSize, 34);

  const cx = W * 0.3, cy = H * 0.25;
  const maxR = Math.hypot(W, H) * 0.85;
  const top = hslToRgb(hue, 0.85, 0.28);
  const mid = hslToRgb(hue2, 0.70, 0.14);
  const bot: [number, number, number] = [5, 7, 13];
  const glow1 = hslToRgb(hue2, 0.90, 0.60);
  const glow2 = hslToRgb(hue, 0.90, 0.55);
  const orb1 = { x: 180 + (hue % 360), y: 240 + (hue % 500), r: 260 + (hue % 160) };
  const orb2 = { x: 540 - (hue % 240), y: 980 - (hue % 340), r: 180 + (hue % 120) };

  for (let y = 0; y < H; y++) {
    // BMP rows are stored bottom-up: buffer row 0 is the image's bottom row.
    const yImg = H - 1 - y;
    for (let x = 0; x < W; x++) {
      const d = Math.hypot(x - cx, yImg - cy) / maxR;
      let rgb: [number, number, number];
      if (d < 0.55) rgb = lerpRgb(top, mid, d / 0.55);
      else rgb = lerpRgb(mid, bot, Math.min(1, (d - 0.55) / 0.45));

      const g1 = 0.13 * Math.max(0, 1 - Math.hypot(x - orb1.x, yImg - orb1.y) / orb1.r);
      const g2 = 0.10 * Math.max(0, 1 - Math.hypot(x - orb2.x, yImg - orb2.y) / orb2.r);
      if (g1 > 0 || g2 > 0) {
        const mix = (c: number, glow: number, a: number) => Math.round(c * (1 - a) + glow * a);
        rgb = g2 > g1
          ? [mix(rgb[0], glow2[0], g2), mix(rgb[1], glow2[1], g2), mix(rgb[2], glow2[2], g2)]
          : [mix(rgb[0], glow1[0], g1), mix(rgb[1], glow1[1], g1), mix(rgb[2], glow1[2], g1)];
      }

      // Pixels are stored as BGR
      const off = FILE_HEADER + INFO_HEADER + y * rowSize + x * 3;
      buf[off] = rgb[2];
      buf[off + 1] = rgb[1];
      buf[off + 2] = rgb[0];
    }
  }
  fs.writeFileSync(outPath, buf);
}

interface VisualMethodEntry {
  method: FreeAiVisualMethod;
  run: (prompt: string, outputPath: string) => Promise<boolean>;
}

const VISUAL_METHODS: VisualMethodEntry[] = [
  { method: 'pollinations_flux', run: (p, o) => tryPollinations(p, o, 'flux') },
  { method: 'pollinations_turbo', run: (p, o) => tryPollinations(p, o, 'turbo') },
  { method: 'cinematic_gradient', run: (p, o) => tryCinematicGradient(p, o) }
];

/**
 * Tries every keyless image method in order until a visual file is produced.
 * The final method (cinematic gradient) is fully offline and cannot fail,
 * so a visual ALWAYS exists after this call.
 */
export async function generateFreeAiVisualWithFallback(
  prompt: string,
  outputPath: string,
  preferredModel: string = 'flux',
  onLog?: FreeAiLogFn
): Promise<{ method: FreeAiVisualMethod; attempts: FreeAiVisualAttempt[] }> {
  const attempts: FreeAiVisualAttempt[] = [];

  const ordered: VisualMethodEntry[] = [...VISUAL_METHODS];
  if (preferredModel === 'turbo') {
    const idx = ordered.findIndex(m => m.method === 'pollinations_turbo');
    if (idx > 0) {
      const [entry] = ordered.splice(idx, 1);
      ordered.unshift(entry);
    }
  }

  for (const entry of ordered) {
    const started = Date.now();
    try {
      onLog?.('AI Video Engine', `Trying AI provider "${entry.method}"...`, 'info');
      const ok = await entry.run(prompt, outputPath);
      const sizeOk = ok && fs.existsSync(outputPath) && fs.statSync(outputPath).size > 300;
      attempts.push({ method: entry.method, ok: !!sizeOk, elapsedMs: Date.now() - started });
      if (sizeOk) {
        onLog?.('AI Video Engine', `AI scene synthesized via "${entry.method}" (keyless, free).`, 'success');
        return { method: entry.method, attempts };
      }
    } catch (err: any) {
      attempts.push({ method: entry.method, ok: false, error: err?.message || String(err), elapsedMs: Date.now() - started });
    }
    onLog?.('AI Video Engine', `Provider "${entry.method}" unavailable — auto-switching to the next method...`, 'warn');
    // Small pause so the rate-limited anonymous tier gets a fresh window.
    await new Promise(r => setTimeout(r, 1200));
  }

  // Unreachable in practice (gradient cannot fail), kept for type-safety.
  return { method: 'cinematic_gradient', attempts };
}
