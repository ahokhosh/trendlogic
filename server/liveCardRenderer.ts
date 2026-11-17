import fs from 'fs';
import path from 'path';
import { execFile, execFileSync } from 'child_process';
import { promisify } from 'util';

const execFileAsync = promisify(execFile);

// ---------------------------------------------------------------------------
// Broadcast story cards: one full video frame per news story, composed
// server-side with 2D canvas (same technique family as trend's share cards:
// gradients, pills, wrapped type, cover photo, rounded panels) — no browser,
// no screenshot, no heavy dependency. A card renders in milliseconds, so the
// 10-second rotation always has the next frame ready: render story N+1 while
// story N is on air, then swap the buffer (zero reconnects, zero gaps).
//
// Layout mirrors the ?scene=live page 1:1 (top bar, kicker, title, question,
// photo hero, description, stats, top-5 list, source footer) so the air
// signal and the preview are the same broadcast.
// ---------------------------------------------------------------------------

let canvasLib: any = null;
let fontsReady = false;
let lastLoadError: string | null = null;
let vendorLoadError: string | null = null;

function shortErr(err: unknown): string {
  return String((err as Error)?.message || err).slice(0, 220);
}

// Vendored backend location. The pod's /app/node_modules is outside what the
// deploy controls (no canvas binary there), so deploy-portal.cmd vendors the
// pure-JS canvas package + the linux-gnu binary tarball into
// <service>/vendor-canvas/node_modules/@napi-rs/ (same layout npm would
// make). LIVE_CANVAS_VENDOR overrides the root for tests.
function vendorCanvasDir(): string {
  const override = String(process.env.LIVE_CANVAS_VENDOR || '').trim();
  if (override) return path.join(override, '@napi-rs', 'canvas');
  return path.join(process.cwd(), 'vendor-canvas', 'node_modules', '@napi-rs', 'canvas');
}

/**
 * Load a canvas backend from an explicit directory (no node_modules walking
 * — works wherever the tree lands). Shared by the vendor path and the
 * runtime-npm path below.
 */
async function loadFromDir(dir: string): Promise<any | null> {
  const pkgPath = path.join(dir, 'package.json');
  if (!fs.existsSync(pkgPath)) return null;
  let pkg: any = null;
  try {
    pkg = JSON.parse(fs.readFileSync(pkgPath, 'utf8'));
  } catch {
    return null;
  }
  const main = path.join(dir, String(pkg.main || 'index.js'));
  if (!fs.existsSync(main)) return null;
  try {
    const { pathToFileURL } = await import('url');
    const mod: any = await import(pathToFileURL(main).href);
    const lib = mod?.default ?? mod;
    if (!lib || typeof lib.createCanvas !== 'function') return null;
    return lib;
  } catch {
    return null;
  }
}

/**
 * Load the vendored backend by explicit file path (no node_modules walking
 * involved — works wherever the deploy tree lands). Exported for
 * verification; the engine prefers the normal resolution first.
 */
export async function tryVendorCanvas(): Promise<any | null> {
  const dir = vendorCanvasDir();
  const lib = await loadFromDir(dir);
  if (lib) {
    vendorLoadError = null;
    return lib;
  }
  vendorLoadError = fs.existsSync(path.join(dir, 'package.json'))
    ? `vendor entry unloadable: ${dir}`
    : `no vendor package at ${dir}`;
  return null;
}

let npmInstallPromise: Promise<any | null> | null = null;
let npmInstallError: string | null = null;

function canvasVersionSpec(): string {
  try {
    const pkg = JSON.parse(fs.readFileSync(path.join(process.cwd(), 'package.json'), 'utf8'));
    const v = pkg?.dependencies?.['@napi-rs/canvas'];
    if (typeof v === 'string' && v.trim()) return v.trim();
  } catch { /* fall through */ }
  return '1.0.5';
}

function findNpmBin(): string | null {
  const cands = [process.env.NPM_BIN, 'npm', '/usr/local/bin/npm', '/usr/bin/npm'].filter(Boolean) as string[];
  for (const c of cands) {
    try {
      if (path.isAbsolute(c)) {
        if (fs.existsSync(c)) return c;
        continue;
      }
      execFileSync(c, ['--version'], { timeout: 10000, stdio: ['ignore', 'pipe', 'pipe'] });
      return c;
    } catch { /* next candidate */ }
  }
  return null;
}

/**
 * Self-provisioning tier: npm-install the canvas backend into temp/ ON THE
 * POD ITSELF. npm resolves the platform binary for the machine it runs on
 * (linux-gnu on Debian pods, musl on Alpine, win32 locally) — no deploy
 * cooperation, no version guessing, no tarball surgery. Single-flight per
 * process; failures record a message and never throw.
 */
function npmInstallOnce(): Promise<any | null> {
  if (!npmInstallPromise) {
    npmInstallPromise = (async (): Promise<any | null> => {
      const dir = path.join(process.cwd(), 'temp', 'canvas-npm', 'node_modules', '@napi-rs', 'canvas');
      const existing = await loadFromDir(dir);
      if (existing) return existing;
      const npm = findNpmBin();
      if (!npm) {
        npmInstallError = 'npm binary not found (tried PATH + /usr/local/bin + /usr/bin)';
        return null;
      }
      const spec = `@napi-rs/canvas@${canvasVersionSpec()}`;
      const target = path.join(process.cwd(), 'temp', 'canvas-npm');
      const cacheDir = path.join(process.cwd(), 'temp', 'canvas-npm-cache');
      try {
        fs.mkdirSync(target, { recursive: true });
        fs.mkdirSync(cacheDir, { recursive: true });
        console.log(`[LiveCards] provisioning ${spec} for this machine (one-time, background-capable)...`);
        await execFileAsync(npm,
          ['install', '--prefix', target, '--no-save', '--no-fund', '--no-audit', '--no-progress', spec],
          {
            timeout: 300000,
            maxBuffer: 8 * 1024 * 1024,
            env: {
              ...process.env,
              npm_config_cache: cacheDir,
              npm_config_update_notifier: 'false',
            },
          });
        const lib = await loadFromDir(dir);
        if (!lib) {
          npmInstallError = 'npm install finished but the backend is unloadable';
          return null;
        }
        npmInstallError = null;
        console.log('[LiveCards] canvas backend provisioned at runtime.');
        return lib;
      } catch (err) {
        npmInstallError = shortErr(err);
        console.warn(`[LiveCards] runtime provisioning failed: ${npmInstallError}`);
        return null;
      }
    })();
  }
  return npmInstallPromise;
}

// Dynamic import (NOT require()): this module loads as ESM under tsx and as
// bundled CJS in production — bare require() exists in neither reliably,
// while import() works in both (esbuild leaves external packages alone).
async function ensureLib(): Promise<boolean> {
  if (canvasLib) return true;
  let normalErr: string | null = null;
  try {
    canvasLib = await import('@napi-rs/canvas');
  } catch (err) {
    normalErr = shortErr(err);
    canvasLib = null;
  }
  if (!canvasLib) {
    // Pod fallback 1: the vendored backend deploy-portal.cmd ships.
    canvasLib = await tryVendorCanvas();
  }
  if (!canvasLib) {
    // Pod fallback 2: provision on the machine itself (npm picks the right
    // platform binary for whatever pod this is). Bounded so Go Live never
    // hangs: the install keeps running in the background for next time.
    try {
      const RACE_MS = 90000;
      const timeout = new Promise<null>(resolve => setTimeout(() => resolve(null), RACE_MS));
      (timeout as any)?.unref?.();
      const won = await Promise.race([npmInstallOnce(), timeout]);
      if (won) canvasLib = won;
    } catch {
      /* error already recorded inside */
    }
  }
  if (!canvasLib) {
    // Recorded (not swallowed): surfaced via getCardRendererError() into
    // /api/stream/status + logs, so a missing platform binary is visible in
    // seconds, not weeks.
    lastLoadError = `npm: ${normalErr || 'missing'} | vendor: ${vendorLoadError || 'absent'} | runtime-install: ${npmInstallError || 'not attempted'}`;
    return false;
  }
  lastLoadError = null;
  if (!fontsReady) {
    try {
      const archivo = path.join(process.cwd(), 'assets', 'fonts', 'ArchivoBlack-Regular.ttf');
      if (fs.existsSync(archivo)) {
        canvasLib.GlobalFonts.registerFromPath(archivo, 'ArchivoBlack');
        fontsReady = true;
      }
    } catch {
      fontsReady = false;
    }
  }
  return true;
}

/** True when cards can be composed (library present; fonts best-effort). */
export async function isCardRendererAvailable(): Promise<boolean> {
  try {
    return await ensureLib();
  } catch {
    return false;
  }
}

/** Last backend load failure (null when healthy) — status/UI/logs read this. */
export function getCardRendererError(): string | null {
  return lastLoadError;
}

export interface CardTopRow {
  rank: number;
  keyword: string;
  traffic: string;
  current: boolean;
}

export interface CardInput {
  keyword: string;
  question: string;
  description: string;
  traffic: string;
  velocity: number;
  score: number;
  category: string;
  rank: number;
  countryCode: string;
  countryName: string;
  sourceName: string;
  sourceTitle: string;
  topRows: CardTopRow[];
  photo: Buffer | null;
  flag: Buffer | null;
  clockText: string; // HH:MM at compose time
}

type Ctx = any;

const HEAD = '"ArchivoBlack", sans-serif';
const BODY = '"Liberation Sans", Arial, sans-serif';
const MONO = '"Liberation Sans", Arial, sans-serif';

function rr(ctx: Ctx, x: number, y: number, w: number, h: number, r: number): void {
  const rad = Math.min(r, w / 2, h / 2);
  ctx.beginPath();
  ctx.moveTo(x + rad, y);
  ctx.arcTo(x + w, y, x + w, y + h, rad);
  ctx.arcTo(x + w, y + h, x, y + h, rad);
  ctx.arcTo(x, y + h, x, y, rad);
  ctx.arcTo(x, y, x + w, y, rad);
  ctx.closePath();
}

/** Greedy word wrap with ellipsis cap. */
function wrapLines(ctx: Ctx, text: string, maxW: number, maxLines: number): string[] {
  const words = String(text || '').replace(/\s+/g, ' ').trim().split(' ').filter(Boolean);
  const lines: string[] = [];
  let cur = '';
  for (const w of words) {
    const t = cur ? cur + ' ' + w : w;
    if (ctx.measureText(t).width > maxW && cur) {
      lines.push(cur);
      cur = w;
      if (lines.length === maxLines) {
        cur = '';
        break;
      }
    } else {
      cur = t;
    }
  }
  if (cur && lines.length < maxLines) lines.push(cur);
  const out = lines.slice(0, maxLines);
  const consumed = out.join(' ').length;
  if (words.join(' ').length > consumed && out.length > 0) {
    const li = out.length - 1;
    while (out[li].length > 3 && ctx.measureText(out[li] + '...').width > maxW) {
      out[li] = out[li].slice(0, -1);
    }
    out[li] = (out[li] || '').trimEnd() + '...';
  }
  return out;
}

function pill(
  ctx: Ctx, x: number, y: number, text: string,
  opts: { bg: string; border?: string | null; color: string; font: string; h?: number; padX?: number }
): number {
  const h = opts.h || 40;
  const padX = opts.padX ?? 14;
  const w = ctx.measureText(text).width + padX * 2;
  ctx.fillStyle = opts.bg;
  rr(ctx, x, y, w, h, h / 2);
  ctx.fill();
  if (opts.border) {
    ctx.strokeStyle = opts.border;
    ctx.lineWidth = 1.5;
    ctx.stroke();
  }
  ctx.fillStyle = opts.color;
  ctx.font = opts.font;
  ctx.textBaseline = 'middle';
  ctx.fillText(text, x + padX, y + h / 2 + 1);
  ctx.textBaseline = 'alphabetic';
  return w;
}

function paintBackground(ctx: Ctx, W: number, H: number): void {
  const bg = ctx.createLinearGradient(0, 0, W, H);
  bg.addColorStop(0, '#040711');
  bg.addColorStop(0.45, '#090e1c');
  bg.addColorStop(1, '#02040a');
  ctx.fillStyle = bg;
  ctx.fillRect(0, 0, W, H);
  ctx.strokeStyle = 'rgba(255,255,255,0.025)';
  ctx.lineWidth = 1;
  for (let x = 0; x < W; x += 40) {
    ctx.beginPath(); ctx.moveTo(x, 0); ctx.lineTo(x, H); ctx.stroke();
  }
  for (let y = 0; y < H; y += 40) {
    ctx.beginPath(); ctx.moveTo(0, y); ctx.lineTo(W, y); ctx.stroke();
  }
  const g1 = ctx.createRadialGradient(W * 0.85, H * 0.06, 10, W * 0.85, H * 0.06, W * 0.45);
  g1.addColorStop(0, 'rgba(220,38,38,0.28)');
  g1.addColorStop(1, 'rgba(0,0,0,0)');
  ctx.fillStyle = g1;
  ctx.fillRect(0, 0, W, H);
  const g2 = ctx.createRadialGradient(W * 0.05, H * 0.95, 10, W * 0.05, H * 0.95, W * 0.4);
  g2.addColorStop(0, 'rgba(56,189,248,0.14)');
  g2.addColorStop(1, 'rgba(0,0,0,0)');
  ctx.fillStyle = g2;
  ctx.fillRect(0, 0, W, H);
}

async function drawCover(
  ctx: Ctx, lib: any,
  photo: Buffer | null, x: number, y: number, w: number, h: number, r: number
): Promise<boolean> {
  if (!photo) return false;
  try {
    const img = await lib.loadImage(photo);
    const iw = (img as any).width as number;
    const ih = (img as any).height as number;
    if (!iw || !ih) return false;
    ctx.save();
    rr(ctx, x, y, w, h, r);
    ctx.clip();
    const scale = Math.max(w / iw, h / ih);
    const dw = iw * scale;
    const dh = ih * scale;
    ctx.drawImage(img as any, x - (dw - w) / 2, y - (dh - h) / 2, dw, dh);
    const grad = ctx.createLinearGradient(0, y, 0, y + h);
    grad.addColorStop(0, 'rgba(0,0,0,0.10)');
    grad.addColorStop(0.6, 'rgba(2,6,23,0.35)');
    grad.addColorStop(1, 'rgba(2,6,23,0.92)');
    ctx.fillStyle = grad;
    ctx.fillRect(x, y, w, h);
    ctx.restore();
    ctx.strokeStyle = 'rgba(255,255,255,0.15)';
    ctx.lineWidth = 1.5;
    rr(ctx, x, y, w, h, r);
    ctx.stroke();
    return true;
  } catch {
    return false;
  }
}

function fallbackPanel(ctx: Ctx, x: number, y: number, w: number, h: number, rank: number, country: string): void {
  ctx.fillStyle = 'rgba(15,23,42,0.92)';
  ctx.strokeStyle = 'rgba(220,38,38,0.35)';
  ctx.lineWidth = 1.5;
  rr(ctx, x, y, w, h, 22);
  ctx.fill();
  ctx.stroke();
  ctx.fillStyle = '#dc2626';
  ctx.font = `800 ${Math.round(h * 0.28)}px ${HEAD}`;
  ctx.textAlign = 'center';
  ctx.fillText(`#${rank}`, x + w / 2, y + h / 2);
  ctx.fillStyle = '#ffffff';
  ctx.font = `700 ${Math.round(h * 0.075)}px ${BODY}`;
  ctx.fillText('TRENDING STORY', x + w / 2, y + h / 2 + h * 0.14);
  ctx.fillStyle = '#94a3b8';
  ctx.font = `600 ${Math.round(h * 0.06)}px ${MONO}`;
  ctx.fillText(country.toUpperCase(), x + w / 2, y + h / 2 + h * 0.24);
  ctx.textAlign = 'left';
}

async function renderVertical(input: CardInput): Promise<Buffer> {
  const lib = canvasLib!;
  const W = 720;
  const H = 1280;
  const cv = lib.createCanvas(W, H);
  const ctx = cv.getContext('2d');
  const P = 36; // side padding
  paintBackground(ctx, W, H);

  // ── Top bar ──
  ctx.fillStyle = '#dc2626';
  rr(ctx, P, 30, 118, 52, 10);
  ctx.fill();
  ctx.fillStyle = '#ffffff';
  ctx.font = `800 30px ${HEAD}`;
  ctx.fillText('LIVE', P + 22, 65);
  ctx.font = `700 25px ${MONO}`;
  let tx = P + 118 + 12;
  tx += pill(ctx, tx, 32, input.traffic, {
    bg: 'rgba(0,0,0,0.55)', border: 'rgba(255,255,255,0.25)', color: '#ffffff', font: `700 25px ${MONO}`, h: 48,
  }) + 10;
  ctx.fillStyle = '#e2e8f0';
  ctx.font = `700 28px ${MONO}`;
  const clock = input.clockText;
  ctx.fillText(clock, W - P - 116 - ctx.measureText(clock).width - 10, 65);
  if (input.flag) {
    try {
      const flag = await lib.loadImage(input.flag);
      const fw = 104;
      const fh = 70;
      const fx = W - P - fw;
      const fy = 28;
      ctx.save();
      rr(ctx, fx, fy, fw, fh, 8);
      ctx.clip();
      ctx.drawImage(flag as any, fx, fy, fw, fh);
      ctx.restore();
      ctx.strokeStyle = 'rgba(255,255,255,0.35)';
      ctx.lineWidth = 2;
      rr(ctx, fx, fy, fw, fh, 8);
      ctx.stroke();
    } catch { /* flag badge below still names the country */ }
  }

  // ── Country + category ──
  let cx = P;
  const cy = 100;
  cx += pill(ctx, cx, cy, input.countryName.toUpperCase(), {
    bg: 'rgba(255,255,255,0.10)', border: 'rgba(255,255,255,0.20)', color: '#e2e8f0', font: `700 22px ${BODY}`, h: 40,
  }) + 8;
  pill(ctx, cx, cy, input.category.toUpperCase(), {
    bg: 'rgba(255,255,255,0.06)', border: null, color: '#94a3b8', font: `700 22px ${MONO}`, h: 40,
  });

  // ── Kicker + title + question ──
  ctx.fillStyle = '#fcd34d';
  ctx.font = `800 29px ${BODY}`;
  ctx.textAlign = 'center';
  ctx.fillText('TRENDING NOW', W / 2, 190);
  ctx.textAlign = 'left';
  let size = 62;
  ctx.font = `800 ${size}px ${HEAD}`;
  const titleW = W - P * 2;
  while (size > 42 && ctx.measureText(input.keyword.toUpperCase()).width > titleW) {
    size -= 8;
    ctx.font = `800 ${size}px ${HEAD}`;
  }
  const titleLines = wrapLines(ctx, input.keyword.toUpperCase(), titleW, 3);
  ctx.fillStyle = '#ffffff';
  let ty = 232;
  for (const ln of titleLines) {
    ctx.fillText(ln, P, ty);
    ty += Math.round(size * 1.14);
  }
  ctx.fillStyle = '#fcd34d';
  ctx.font = `700 29px ${BODY}`;
  const qLines = wrapLines(ctx, input.question, titleW, 2);
  for (const ln of qLines) {
    ctx.fillText(ln, P, ty);
    ty += 38;
  }

  // ── Photo hero ──
  const photoY = ty + 14;
  const photoH = 330;
  const photoOk = await drawCover(ctx, lib, input.photo, P, photoY, W - P * 2, photoH, 22);
  if (!photoOk) fallbackPanel(ctx, P, photoY, W - P * 2, photoH, input.rank, input.countryName);
  // Source pill on the photo
  ctx.font = `700 22px ${MONO}`;
  pill(ctx, P + 14, photoY + photoH - 52, (input.sourceName || 'SOURCE').toUpperCase().slice(0, 24), {
    bg: 'rgba(2,6,23,0.85)', border: 'rgba(52,211,153,0.5)', color: '#6ee7b7', font: `700 22px ${MONO}`, h: 38,
  });

  // ── Description ──
  let dy = photoY + photoH + 40;
  ctx.fillStyle = '#cbd5e1';
  ctx.font = `400 26px ${BODY}`;
  const dLines = wrapLines(ctx, input.description, titleW, 2);
  for (const ln of dLines) {
    ctx.fillText(ln, P, dy);
    dy += 34;
  }

  // ── Stats pills ──
  dy += 8;
  let sx = P;
  sx += pill(ctx, sx, dy, `#${input.rank}`, { bg: '#dc2626', border: null, color: '#fff', font: `800 23px ${BODY}`, h: 42 }) + 8;
  sx += pill(ctx, sx, dy, `VEL ${input.velocity}`, { bg: 'rgba(16,185,129,0.16)', border: 'rgba(52,211,153,0.45)', color: '#6ee7b7', font: `700 23px ${MONO}`, h: 42 }) + 8;
  sx += pill(ctx, sx, dy, `SCORE ${input.score}`, { bg: 'rgba(56,189,248,0.16)', border: 'rgba(56,189,248,0.45)', color: '#7dd3fc', font: `700 23px ${MONO}`, h: 42 }) + 8;
  pill(ctx, sx, dy, input.traffic, { bg: 'rgba(245,158,11,0.16)', border: 'rgba(245,158,11,0.45)', color: '#fcd34d', font: `700 23px ${MONO}`, h: 42 });

  // ── Top stories list ──
  let ly = dy + 42 + 18;
  ctx.font = `800 22px ${BODY}`;
  ctx.fillStyle = '#94a3b8';
  ctx.fillText('TOP STORIES', P, ly);
  ly += 12;
  const rows = input.topRows.slice(0, 5);
  for (const r of rows) {
    if (ly + 52 > H - 64) break;
    if (r.current) {
      ctx.fillStyle = 'rgba(220,38,38,0.18)';
      ctx.strokeStyle = 'rgba(220,38,38,0.55)';
      ctx.lineWidth = 1.5;
      rr(ctx, P, ly, W - P * 2, 52, 12);
      ctx.fill();
      ctx.stroke();
    }
    ctx.fillStyle = r.current ? '#fca5a5' : '#64748b';
    ctx.font = `800 24px ${MONO}`;
    ctx.fillText(String(r.rank), P + 14, ly + 34);
    ctx.fillStyle = r.current ? '#ffffff' : '#cbd5e1';
    ctx.font = `700 24px ${BODY}`;
    let label = `${r.keyword} (${r.traffic})`;
    const maxLabel = W - P * 2 - 130;
    while (label.length > 4 && ctx.measureText(label).width > maxLabel) label = label.slice(0, -1);
    if (label !== `${r.keyword} (${r.traffic})`) label = label.trimEnd() + '...';
    ctx.fillText(label, P + 58, ly + 34);
    ly += 60;
  }

  // ── Footer ──
  ctx.fillStyle = '#64748b';
  ctx.font = `600 20px ${BODY}`;
  let foot = `${input.sourceName}  •  ${input.sourceTitle}`.trim();
  while (foot.length > 4 && ctx.measureText(foot).width > W - P * 2 - 150) foot = foot.slice(0, -1);
  ctx.fillText(foot, P, H - 30);
  ctx.fillStyle = '#f87171';
  ctx.font = `800 20px ${MONO}`;
  ctx.fillText('LIVE', W - P - ctx.measureText('LIVE').width, H - 30);

  return cv.encode('jpeg', 85) as unknown as Buffer;
}

async function renderHorizontal(input: CardInput): Promise<Buffer> {
  const lib = canvasLib!;
  const W = 1280;
  const H = 720;
  const cv = lib.createCanvas(W, H);
  const ctx = cv.getContext('2d');
  const P = 40;
  paintBackground(ctx, W, H);

  // Top bar
  ctx.fillStyle = '#dc2626';
  rr(ctx, P, 26, 112, 48, 10);
  ctx.fill();
  ctx.fillStyle = '#ffffff';
  ctx.font = `800 28px ${HEAD}`;
  ctx.fillText('LIVE', P + 21, 59);
  let tx = P + 112 + 12;
  tx += pill(ctx, tx, 28, input.traffic, {
    bg: 'rgba(0,0,0,0.55)', border: 'rgba(255,255,255,0.25)', color: '#ffffff', font: `700 23px ${MONO}`, h: 44,
  }) + 10;
  pill(ctx, tx, 28, input.countryName.toUpperCase(), {
    bg: 'rgba(255,255,255,0.10)', border: 'rgba(255,255,255,0.20)', color: '#e2e8f0', font: `700 22px ${BODY}`, h: 44,
  });
  ctx.fillStyle = '#e2e8f0';
  ctx.font = `700 26px ${MONO}`;
  ctx.fillText(input.clockText, W - P - 220 - ctx.measureText(input.clockText).width, 59);
  if (input.flag) {
    try {
      const flag = await lib.loadImage(input.flag);
      const fx = W - P - 150;
      ctx.save();
      rr(ctx, fx, 24, 150, 56, 8);
      ctx.clip();
      ctx.drawImage(flag as any, fx, 24, 150, 56);
      ctx.restore();
      ctx.strokeStyle = 'rgba(255,255,255,0.35)';
      ctx.lineWidth = 2;
      rr(ctx, fx, 24, 150, 56, 8);
      ctx.stroke();
    } catch { /* country pill already names it */ }
  }

  // Left column: story
  const leftW = 640;
  ctx.fillStyle = '#fcd34d';
  ctx.font = `800 24px ${BODY}`;
  ctx.fillText('TRENDING NOW', P, 150);
  let size = 56;
  ctx.font = `800 ${size}px ${HEAD}`;
  while (size > 38 && ctx.measureText(input.keyword.toUpperCase()).width > leftW) {
    size -= 6;
    ctx.font = `800 ${size}px ${HEAD}`;
  }
  const titleLines = wrapLines(ctx, input.keyword.toUpperCase(), leftW, 2);
  ctx.fillStyle = '#ffffff';
  let ty = 200;
  for (const ln of titleLines) {
    ctx.fillText(ln, P, ty);
    ty += Math.round(size * 1.12);
  }
  ctx.fillStyle = '#fcd34d';
  ctx.font = `700 26px ${BODY}`;
  const qLines = wrapLines(ctx, input.question, leftW, 2);
  for (const ln of qLines) {
    ctx.fillText(ln, P, ty);
    ty += 34;
  }
  ctx.fillStyle = '#cbd5e1';
  ctx.font = `400 23px ${BODY}`;
  const dLines = wrapLines(ctx, input.description, leftW, 2);
  for (const ln of dLines) {
    ctx.fillText(ln, P, ty);
    ty += 30;
  }
  ty += 12;
  let sx = P;
  sx += pill(ctx, sx, ty, `#${input.rank}`, { bg: '#dc2626', border: null, color: '#fff', font: `800 20px ${BODY}`, h: 38 }) + 8;
  sx += pill(ctx, sx, ty, `VEL ${input.velocity}`, { bg: 'rgba(16,185,129,0.16)', border: 'rgba(52,211,153,0.45)', color: '#6ee7b7', font: `700 20px ${MONO}`, h: 38 }) + 8;
  pill(ctx, sx, ty, input.traffic, { bg: 'rgba(245,158,11,0.16)', border: 'rgba(245,158,11,0.45)', color: '#fcd34d', font: `700 20px ${MONO}`, h: 38 });

  // Right column: photo hero
  const imgX = P + leftW + 40;
  const imgW = W - imgX - P;
  const imgY = 120;
  const imgH = H - imgY - 90;
  const photoOk = await drawCover(ctx, lib, input.photo, imgX, imgY, imgW, imgH, 20);
  if (!photoOk) fallbackPanel(ctx, imgX, imgY, imgW, imgH, input.rank, input.countryName);
  ctx.font = `700 20px ${MONO}`;
  pill(ctx, imgX + 12, imgY + imgH - 48, (input.sourceName || 'SOURCE').toUpperCase().slice(0, 26), {
    bg: 'rgba(2,6,23,0.85)', border: 'rgba(52,211,153,0.5)', color: '#6ee7b7', font: `700 20px ${MONO}`, h: 36,
  });

  // Footer
  ctx.fillStyle = '#64748b';
  ctx.font = `600 20px ${BODY}`;
  let foot = `${input.sourceName}  •  ${input.sourceTitle}`.trim();
  while (foot.length > 4 && ctx.measureText(foot).width > W - P * 2 - 120) foot = foot.slice(0, -1);
  ctx.fillText(foot, P, H - 28);

  return cv.encode('jpeg', 85) as unknown as Buffer;
}

/**
 * Compose one full broadcast frame. Photo/flag arrive as decoded-ready
 * buffers (fetched by the caller); missing photo falls back to a branded
 * panel — never blank, never throws for content.
 */
export async function renderStoryCard(
  input: CardInput,
  orientation: 'vertical' | 'horizontal'
): Promise<Buffer> {
  if (!(await ensureLib()) || !canvasLib) {
    throw new Error('Card renderer unavailable (@napi-rs/canvas missing).');
  }
  const buf = orientation === 'vertical'
    ? await renderVertical(input)
    : await renderHorizontal(input);
  return Buffer.from(buf);
}
