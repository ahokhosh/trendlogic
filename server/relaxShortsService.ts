import fs from 'fs';
import path from 'path';
import { exec } from 'child_process';
import { promisify } from 'util';
import { ffmpegBin } from './videoRenderer.js';
import ffprobeStatic from 'ffprobe-static';
// Bundled at build time (esbuild inlines JSON): deploy-proof, no runtime
// file needed — the pod only ships server.cjs + dist + public + assets.
import relaxCatalog from './relaxSoundsCatalog.json';

const execAsync = promisify(exec);

// ---------------------------------------------------------------------------
// Relax Shorts: latest AI soundscape post (Relax) -> 40s vertical Short -> YT.
// Relax owns its posts API; trendlogic only READS the public feed and downloads
// the public cover + library MP3s. Nothing in Relax is modified.
// ---------------------------------------------------------------------------

export interface RelaxAiPost {
  id: string;
  title: string;
  description: string;
  coverImage: string | null;
  soundConfig: Record<string, number>;
  tags: string[];
  authorUsername: string;
  createdAt: string;
}

/** Direct (in-pod DNS) first, public proxy last. First success wins. */
export function relaxBases(): string[] {
  const out: string[] = [];
  const env = String(process.env.RELAX_BASE_URL || '').trim().replace(/\/+$/, '');
  if (env) out.push(env);
  out.push('http://relax:3000');
  out.push('https://bidbes.com/relax');
  return [...new Set(out)];
}

/** Public link base for captions (portal path, not the internal DNS name). */
export function relaxPublicBase(): string {
  const env = String(process.env.RELAX_PUBLIC_URL || '').trim().replace(/\/+$/, '');
  if (env) return env;
  return 'https://bidbes.com/relax';
}

export function relaxPostUrl(postId: string): string {
  return `${relaxPublicBase()}/soundscape/${encodeURIComponent(postId)}`;
}

// Sound URL resolution: the Relax library changes over time (files move,
// categories are rescanned at boot), so the LIVE catalog
// (GET <base>/api/categories -> categories[].sounds[].{id,src}) is the source
// of truth. It is fetched per base and cached 10 min; the bundled snapshot
// (relaxSoundsCatalog.json, inlined at build time) is only a fallback.
interface CatalogMaps {
  byId: Map<string, string>;
}
function mapsFromCategories(cats: unknown): CatalogMaps {
  const byId = new Map<string, string>();
  const list = Array.isArray(cats) ? cats : [];
  for (const c of list) {
    const sounds = (c as { sounds?: { id?: string; label?: string; src?: string }[] })?.sounds;
    if (!Array.isArray(sounds)) continue;
    for (const s of sounds) {
      if (!s?.id || !s?.src) continue;
      byId.set(String(s.id), String(s.src));
      byId.set(String(s.id).toLowerCase(), String(s.src));
      if (s.label) byId.set(String(s.label), String(s.src));
    }
  }
  return { byId };
}

let snapshotMaps: CatalogMaps | null = null;
function getSnapshotMaps(): CatalogMaps {
  if (snapshotMaps) return snapshotMaps;
  try {
    snapshotMaps = mapsFromCategories(relaxCatalog as unknown[]);
  } catch {
    snapshotMaps = { byId: new Map() };
  }
  return snapshotMaps;
}

const liveCatalogCache = new Map<string, { at: number; maps: CatalogMaps }>();
const LIVE_CATALOG_TTL_MS = 10 * 60 * 1000;

/** Live id->src map for one Relax base (cached 10 min, never throws). */
async function getLiveMaps(base: string): Promise<CatalogMaps | null> {
  const hit = liveCatalogCache.get(base);
  if (hit && Date.now() - hit.at < LIVE_CATALOG_TTL_MS) return hit.maps;
  try {
    const data = await fetchJson(`${base}/api/categories`, 15000);
    const maps = mapsFromCategories(data?.categories);
    if (maps.byId.size > 0) {
      liveCatalogCache.set(base, { at: Date.now(), maps });
      return maps;
    }
  } catch (err) {
    console.warn(`[RelaxShorts] live catalog missed for ${base}:`, String((err as Error)?.message || err).slice(0, 120));
  }
  return hit?.maps || null;
}

/** Join a catalog src ("/sounds/..." or portal-prefixed "/relax/sounds/...") to a base. */
function joinSoundUrl(base: string, src: string): string {
  const cleanBase = base.replace(/\/+$/, '');
  if (src.startsWith('/relax/') && cleanBase.endsWith('/relax')) {
    return `${cleanBase}${src.slice('/relax'.length)}`;
  }
  if (src.startsWith('/relax/')) {
    // Direct backend base: strip the portal prefix.
    return `${cleanBase}${src.slice('/relax'.length)}`;
  }
  return `${cleanBase}${src.startsWith('/') ? src : `/${src}`}`;
}

/** Candidate download URLs for one sound id (primary base first). */
async function relaxSoundUrls(soundId: string, primaryBase?: string): Promise<string[]> {
  const bases = [...new Set([primaryBase, ...relaxBases()].filter(Boolean))] as string[];
  // Fetch live maps for every base in parallel (cached after first run).
  const liveMaps = await Promise.all(bases.map(b => getLiveMaps(b)));
  const snap = getSnapshotMaps();
  const urls: string[] = [];
  for (let i = 0; i < bases.length; i++) {
    const base = bases[i];
    const live = liveMaps[i];
    const src =
      live?.byId.get(soundId) ||
      live?.byId.get(String(soundId).toLowerCase()) ||
      snap.byId.get(soundId) ||
      snap.byId.get(String(soundId).toLowerCase());
    if (src) urls.push(joinSoundUrl(base, src));
  }
  return [...new Set(urls)];
}

async function fetchJson(url: string, ms = 15000): Promise<any> {
  const c = new AbortController();
  const t = setTimeout(() => c.abort(), ms);
  try {
    const res = await fetch(url, {
      signal: c.signal,
      headers: { 'User-Agent': 'trendlogic-relax-shorts/1.0', Accept: 'application/json' }
    });
    if (!res.ok) throw new Error(`HTTP ${res.status}`);
    return await res.json();
  } finally {
    clearTimeout(t);
  }
}

/** Latest AI post from the Relax public feed, optionally skipping known ids. */
export async function fetchLatestRelaxAiPost(excludeIds: string[] = []): Promise<{ post: RelaxAiPost; base: string } | null> {
  const excluded = new Set(excludeIds);
  let lastErr: any = null;
  for (const base of relaxBases()) {
    try {
      const data = await fetchJson(`${base}/api/posts?sort=newest&limit=50`);
      const posts = Array.isArray(data?.posts) ? data.posts : [];
      for (const p of posts) {
        if (!p?.isAi) continue;
        if (excluded.has(String(p.id))) continue;
        const cfg = p.soundConfig && typeof p.soundConfig === 'object' ? p.soundConfig : {};
        return {
          base,
          post: {
            id: String(p.id),
            title: String(p.title || 'Relax AI Soundscape'),
            description: String(p.description || ''),
            coverImage: p.coverImage ? String(p.coverImage) : null,
            soundConfig: cfg as Record<string, number>,
            tags: Array.isArray(p.tags) ? p.tags.map((t: any) => String(t)) : [],
            authorUsername: String(p?.author?.username || 'relax'),
            createdAt: String(p.createdAt || '')
          }
        };
      }
      return null; // reachable feed, just no (new) AI post
    } catch (err) {
      lastErr = err;
    }
  }
  throw new Error(`Relax feed unreachable (${String(lastErr?.message || lastErr).slice(0, 120)})`);
}

export async function downloadToFile(url: string, dest: string, ms = 20000): Promise<boolean> {
  try {
    const c = new AbortController();
    const t = setTimeout(() => c.abort(), ms);
    try {
      // Sound filenames contain spaces, commas and "&" — encode the path so
      // fetch doesn't throw on the raw URL (that silently failed every layer).
      const res = await fetch(encodeURI(url), {
        signal: c.signal,
        headers: { 'User-Agent': 'trendlogic-relax-shorts/1.0' }
      });
      if (!res.ok) return false;
      const buf = Buffer.from(await res.arrayBuffer());
      if (buf.length < 500) return false;
      fs.writeFileSync(dest, buf);
      return true;
    } finally {
      clearTimeout(t);
    }
  } catch {
    return false;
  }
}

/** Download the post cover via the working Relax base (tries all bases). */
export async function downloadRelaxCover(post: RelaxAiPost, dest: string): Promise<boolean> {
  if (!post.coverImage) return false;
  const p = post.coverImage.startsWith('/') ? post.coverImage : `/${post.coverImage}`;
  for (const base of relaxBases()) {
    let url = `${base}${p}`;
    // Direct backend serves without the portal "/relax" prefix.
    if (!base.includes('bidbes.com') && p.startsWith('/relax/')) {
      url = `${base}${p.replace(/^\/relax(?=\/)/, '')}`;
    }
    if (await downloadToFile(url, dest)) return true;
  }
  return false;
}

/** Download up to 4 loudest mix layers; returns [{file, gain}]. */
export async function downloadRelaxLayers(
  post: RelaxAiPost,
  workDir: string,
  prefix: string,
  primaryBase?: string
): Promise<{ file: string; gain: number; id: string }[]> {
  const entries = Object.entries(post.soundConfig || {})
    .map(([id, g]) => ({ id, gain: Math.min(1, Math.max(0.05, Number(g) || 0.5)) }))
    .sort((a, b) => b.gain - a.gain)
    .slice(0, 4);
  const out: { file: string; gain: number; id: string }[] = [];
  const missed: string[] = [];
  for (let i = 0; i < entries.length; i++) {
    const { id, gain } = entries[i];
    const dest = path.join(workDir, `${prefix}_layer${i}.mp3`);
    let ok = false;
    for (const url of await relaxSoundUrls(id, primaryBase)) {
      if (await downloadToFile(url, dest)) {
        ok = true;
        break;
      }
    }
    if (ok) out.push({ file: dest, gain, id });
    else {
      missed.push(id);
      console.warn(`[RelaxShorts] layer missed: "${id}" (no reachable MP3)`);
    }
  }
  if (out.length === 0 && entries.length > 0) {
    console.warn(`[RelaxShorts] all ${entries.length} layer(s) missed for post ${post.id}: ${missed.join(' | ').slice(0, 300)}`);
  }
  return out;
}

// Shorts are exactly 20s: layers loop/pad to fill, then cut.
export const RELAX_SHORT_SEC = 20;

function escFont(p: string): string {
  return p.replace(/\\/g, '/').replace(/:/g, '\\:');
}
function pickFont(...candidates: string[]): string {
  for (const c of candidates) {
    if (c && fs.existsSync(c)) return `fontfile=${escFont(c)}:`;
  }
  return '';
}

function sanitize(text: string, maxLen = 60): string {
  return String(text || '')
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

async function hasAudioStream(filePath: string): Promise<boolean> {
  const ffprobe = (ffprobeStatic as any)?.path || 'ffprobe';
  try {
    const { stdout } = await execAsync(`"${ffprobe}" -v error -show_entries stream=codec_type -of csv=p=0 "${filePath}"`, { maxBuffer: 4 * 1024 * 1024, timeout: 60000 });
    return String(stdout || '').split(/\r?\n/).some(l => l.trim() === 'audio');
  } catch {
    return false;
  }
}

/** Mix downloaded layers into one exact-20s stereo MP3 (gains respected). */
export async function mixRelaxAudio(
  layers: { file: string; gain: number }[],
  outMp3: string,
  targetSec = RELAX_SHORT_SEC
): Promise<void> {
  if (layers.length === 0) throw new Error('Post has no downloadable sound layers.');
  const inputs = layers.map(l => `-stream_loop 3 -i "${l.file}"`).join(' ');
  // Each layer: gain -> pad -> cut to target; then amix without normalization
  // (gains are the Relax mix balance), loud-ish but never clipping.
  const chains = layers
    .map((l, i) => `[${i}:a]volume=${l.gain},apad,atrim=0:${targetSec},asetpts=PTS-STARTPTS[a${i}]`)
    .join(';');
  const mixInputs = layers.map((_, i) => `[a${i}]`).join('');
  const fc = `${chains};${mixInputs}amix=inputs=${layers.length}:normalize=0,alimiter=limit=0.95,atrim=0:${targetSec}[out]`;
  await execAsync(
    `"${ffmpegBin()}" -y ${inputs} -filter_complex "${fc}" -map "[out]" -t ${targetSec} -c:a libmp3lame -b:a 160k -ar 44100 -ac 2 "${outMp3}"`,
    { maxBuffer: 32 * 1024 * 1024, timeout: 600000 }
  );
  if (!fs.existsSync(outMp3) || fs.statSync(outMp3).size < 1000) {
    throw new Error('Audio mix produced no output.');
  }
}

/** Render the 20s 1080x1920 Short: cover Ken Burns + title straps + audio. */
export async function renderRelaxShort(opts: {
  post: RelaxAiPost;
  coverPath: string;
  audioPath: string;
  outMp4: string;
  targetSec?: number;
}): Promise<{ file: string; sizeBytes: number; durationSec: number }> {
  const { post, coverPath, audioPath, outMp4 } = opts;
  const targetSec = opts.targetSec || RELAX_SHORT_SEC;
  const ff = ffmpegBin();
  const archivo = path.join(process.cwd(), 'assets', 'fonts', 'ArchivoBlack-Regular.ttf');
  const liberation = '/usr/share/fonts/truetype/liberation/LiberationSans-Bold.ttf';
  const HEAD = pickFont(archivo, liberation);
  const BODY = pickFont(liberation, archivo);

  const title = sanitize(post.title, 34).toUpperCase() || 'RELAX AI SOUNDSCAPE';
  const author = sanitize(`@ ${post.authorUsername} • AI SOUNDSCAPE`, 40).toUpperCase();
  const frames = targetSec * 30;
  // Slow zoom-in over the full 40s (single input, no xfade — one calm shot).
  const framesExpr = `${frames}`;
  const fc =
    `[0:v]scale=1296:2304,zoompan=z='min(zoom+0.00045\\,1.15)':x='iw/2-(iw/zoom/2)':y='ih/2-(ih/zoom/2)':d=${framesExpr}:s=1080x1920:fps=30[bg];` +
    `[bg]drawbox=x=0:y=0:w=1080:h=1920:color=black@0.32:t=fill,` +
    `drawbox=x=0:y=0:w=1080:h=120:color=0x020617@0.92:t=fill,` +
    `drawtext=${HEAD}text='RELAX • AI SOUNDSCAPE':fontcolor=0x5eead4:fontsize=30:x=(w-text_w)/2:y=34:borderw=1:bordercolor=black@0.8,` +
    `drawtext=${BODY}text='${author}':fontcolor=white:fontsize=24:x=(w-text_w)/2:y=72,` +
    `drawbox=x=60:y=1330:w=960:h=220:color=0x020617@0.88:t=fill,` +
    `drawbox=x=60:y=1330:w=10:h=220:color=0x5eead4@1.0:t=fill,` +
    `drawtext=${HEAD}text='${title}':fontcolor=white:fontsize=44:x=100:y=1360:borderw=2:bordercolor=black@0.85,` +
    `drawtext=${BODY}text='FULL MIX ON RELAX • LINK IN DESCRIPTION':fontcolor=0x5eead4:fontsize=26:x=100:y=1480,` +
    `drawbox=x=0:y=1908:w=1080:h=12:color=0x334155@0.8:t=fill,` +
    `drawbox=x=0:y=1908:w='1080*(t/${targetSec})':h=12:color=0x5eead4@1.0:t=fill[outv]`;

  await execAsync(
    `"${ff}" -y -loop 1 -t ${targetSec} -i "${coverPath}" -i "${audioPath}" ` +
      `-filter_complex "${fc}" -map "[outv]" -map 1:a -t ${targetSec} ` +
      `-c:v libx264 -pix_fmt yuv420p -preset ultrafast -crf 24 -r 30 -c:a aac -b:a 128k -movflags +faststart -shortest "${outMp4}"`,
    { maxBuffer: 64 * 1024 * 1024, timeout: 900000 }
  );
  if (!fs.existsSync(outMp4) || fs.statSync(outMp4).size < 1000) {
    throw new Error('Short render produced no output.');
  }
  if (!(await hasAudioStream(outMp4))) {
    throw new Error('Short render produced no audio track.');
  }
  const st = fs.statSync(outMp4);
  // Poster frame for the history list.
  try {
    const thumb = outMp4.replace(/\.mp4$/i, '_thumb.jpg');
    await execAsync(`"${ff}" -y -ss 2 -i "${outMp4}" -vframes 1 -q:v 4 "${thumb}"`, {
      maxBuffer: 16 * 1024 * 1024, timeout: 60000
    });
  } catch { /* poster optional */ }
  return { file: outMp4, sizeBytes: st.size, durationSec: targetSec };
}

/**
 * Render the 20s 1080x1920 Short using an INSTAGRAM REEL as the VIDEO and the
 * Relax mix as the ONLY audio. The reel is shot 0's background (scaled to
 * cover), looped to fill the exact 20s window; the reel's own audio is DISCARDED
 * (-an on the input, -map 1:a for the mix). Overlays are the same Relax straps.
 * Returns { file, sizeBytes, durationSec }.
 */
export async function renderRelaxReelShort(opts: {
  post: RelaxAiPost;
  reelVideoPath: string;
  audioPath: string;
  outMp4: string;
  targetSec?: number;
}): Promise<{ file: string; sizeBytes: number; durationSec: number }> {
  const { post, reelVideoPath, audioPath, outMp4 } = opts;
  const targetSec = opts.targetSec || RELAX_SHORT_SEC;
  const ff = ffmpegBin();
  const archivo = path.join(process.cwd(), 'assets', 'fonts', 'ArchivoBlack-Regular.ttf');
  const liberation = '/usr/share/fonts/truetype/liberation/LiberationSans-Bold.ttf';
  const HEAD = pickFont(archivo, liberation);
  const BODY = pickFont(liberation, archivo);

  const title = sanitize(post.title, 34).toUpperCase() || 'RELAX AI SOUNDSCAPE';
  const author = sanitize(`@ ${post.authorUsername} • AI SOUNDSCAPE`, 40).toUpperCase();
  // Reel covers the full frame; overlays mirror renderRelaxShort (no Ken Burns
  // — the reel is already moving). Audio is taken ONLY from the Relax mix.
  const fc =
    `[0:v]scale=1080:1920:force_original_aspect_ratio=increase,crop=1080:1920,setsar=1,fps=30[bg];` +
    `[bg]drawbox=x=0:y=0:w=1080:h=1920:color=black@0.20:t=fill,` +
    `drawbox=x=0:y=0:w=1080:h=120:color=0x020617@0.92:t=fill,` +
    `drawtext=${HEAD}text='RELAX • AI SOUNDSCAPE':fontcolor=0x5eead4:fontsize=30:x=(w-text_w)/2:y=34:borderw=1:bordercolor=black@0.8,` +
    `drawtext=${BODY}text='${author}':fontcolor=white:fontsize=24:x=(w-text_w)/2:y=72,` +
    `drawbox=x=60:y=1330:w=960:h=220:color=0x020617@0.88:t=fill,` +
    `drawbox=x=60:y=1330:w=10:h=220:color=0x5eead4@1.0:t=fill,` +
    `drawtext=${HEAD}text='${title}':fontcolor=white:fontsize=44:x=100:y=1360:borderw=2:bordercolor=black@0.85,` +
    `drawtext=${BODY}text='FULL MIX ON RELAX • LINK IN DESCRIPTION':fontcolor=0x5eead4:fontsize=26:x=100:y=1480,` +
    `drawbox=x=0:y=1908:w=1080:h=12:color=0x334155@0.8:t=fill,` +
    `drawbox=x=0:y=1908:w='1080*(t/${targetSec})':h=12:color=0x5eead4@1.0:t=fill[outv]`;

  await execAsync(
    `"${ff}" -y -stream_loop -1 -t ${targetSec} -i "${reelVideoPath}" -i "${audioPath}" ` +
      `-filter_complex "${fc}" -map "[outv]" -map 1:a -t ${targetSec} ` +
      `-c:v libx264 -pix_fmt yuv420p -preset ultrafast -crf 24 -r 30 -c:a aac -b:a 128k -movflags +faststart -shortest "${outMp4}"`,
    { maxBuffer: 64 * 1024 * 1024, timeout: 900000 }
  );
  if (!fs.existsSync(outMp4) || fs.statSync(outMp4).size < 1000) {
    throw new Error('Relax reel Short render produced no output.');
  }
  if (!(await hasAudioStream(outMp4))) {
    throw new Error('Relax reel Short render produced no audio track.');
  }
  const st = fs.statSync(outMp4);
  // Poster frame for the history list.
  try {
    const thumb = outMp4.replace(/\.mp4$/i, '_thumb.jpg');
    await execAsync(`"${ff}" -y -ss 2 -i "${outMp4}" -vframes 1 -q:v 4 "${thumb}"`, {
      maxBuffer: 16 * 1024 * 1024, timeout: 60000
    });
  } catch { /* poster optional */ }
  return { file: outMp4, sizeBytes: st.size, durationSec: targetSec };
}

/** YouTube caption: full description + backlink to the Relax post. */
export function buildRelaxCaption(post: RelaxAiPost): { title: string; description: string; tags: string[] } {
  const suffix = ' #Shorts';
  let base = String(post.title || '').replace(/[\r\n]+/g, ' ').trim();
  if (base.length > 100 - suffix.length) base = base.slice(0, 100 - suffix.length - 3).trimEnd() + '...';
  let title = `${base}${suffix}`.trim();
  const tags = [...new Set([...(post.tags || []).slice(0, 8), 'Relax', 'AISoundscape', 'Shorts', 'Ambient'])].slice(0, 15);
  const desc =
    `${post.title}\n\n${post.description || ''}\n\n` +
    `🎧 Full soundscape on Relax: ${relaxPostUrl(post.id)}\n` +
    `Sounds: ${(Object.keys(post.soundConfig || {})).slice(0, 6).join(' • ') || 'AI mix'}\n\n` +
    `#Shorts #Relax #AISoundscape #Ambient`;
  return { title, description: desc.slice(0, 4800), tags: tags.map(t => t.slice(0, 40)) };
}
