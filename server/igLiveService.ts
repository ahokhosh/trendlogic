import fs from 'fs';
import path from 'path';
import { spawn, execFileSync, type ChildProcess } from 'child_process';
import { ffmpegBin } from './videoRenderer.js';
import {
  appendReelAudio,
  clearAudioQueue,
  clearReelFeed,
  getLiveMode,
  getLiveOwner,
  getLiveStatus,
  getPushIoState,
  getReelInfo,
  isLiveActive,
  liveFps,
  liveOutSize,
  setLiveStopHook,
  setLiveReelRestartHook,
  setReelFrame,
  setReelShortcode,
  startReelBroadcast
} from './liveStreamService.js';
import { getAnyLiveStream, getIgWatchById, touchLiveReelShortcode } from './db.js';

// ---------------------------------------------------------------------------
// Instagram-to-Live reel loop: decodes ONE mp4 on repeat and pumps its frames
// + soundtrack into the running RTMP push (see LiveSourceMode in
// liveStreamService). Swapping to a newer reel restarts ONLY these decoder
// children — the push to YouTube never drops, so the live never disconnects.
//
// One global loop at a time (one global push). State = which watch owns it.
// ---------------------------------------------------------------------------

interface DecoderSet {
  video: ChildProcess | null;
  audio: ChildProcess | null;
  filePath: string;
  shortcode: string;
  watchId: string;
}

let decoders: DecoderSet | null = null;
/** Last requested loop (survives decoder crashes so the watchdog can heal).
 *  `audio` remembers whether the file carries a soundtrack — audio-less reels
 *  loop picture-only (pacer pads silence) instead of respawning a doomed
 *  audio decoder every 3s and resetting the picture with it. */
let desired: { watchId: string; userId: string; username: string; shortcode: string; filePath: string; rtmpUrl: string; streamKey: string; audio: boolean } | null = null;

/** Flow diagnostics for the CURRENT decoder generation — answers "is any
 *  picture actually reaching the push?" without guessing. Reset on every
 *  (re)spawn; exposed via /api/ig-live/status. */
interface DecoderStats {
  frames: number;
  audioBytes: number;
  firstFrameAt: string | null;
  lastFrameAt: string | null;
  lastAudioAt: string | null;
  fileSize: number;
  spawnedAt: string | null;
  videoExit: string | null;
  audioExit: string | null;
  videoErrTail: string[];
  audioErrTail: string[];
}
let stats: DecoderStats = freshStats();
function freshStats(): DecoderStats {
  return {
    frames: 0, audioBytes: 0, firstFrameAt: null, lastFrameAt: null, lastAudioAt: null,
    fileSize: 0, spawnedAt: null, videoExit: null, audioExit: null, videoErrTail: [], audioErrTail: []
  };
}
function pushTail(arr: string[], line: string): void {
  arr.push(line.slice(0, 300));
  if (arr.length > 8) arr.shift();
}

function killDecoders(): void {
  const d = decoders;
  decoders = null;
  for (const proc of [d?.video, d?.audio]) {
    try {
      if (proc && proc.exitCode === null && !proc.killed) proc.kill('SIGKILL');
    } catch { /* already gone */ }
  }
}

export function stopReelDecoders(): void {
  killDecoders();
}

function spawnDecoder(filePath: string, shortcode: string, watchId: string, withAudio = true): void {
  killDecoders();
  // Fresh audio baseline on EVERY (re)spawn: leftover PCM from a previous
  // reel (or a pre-swap generation) must never play under the new picture —
  // that tail is a permanent A/V offset. A sub-second silence gap is the
  // correct price; the pacer pads it and the loop re-locks from zero.
  clearAudioQueue();
  stats = freshStats();
  stats.spawnedAt = new Date().toISOString();
  try {
    stats.fileSize = fs.statSync(filePath).size;
  } catch {
    stats.fileSize = 0;
  }
  const ff = ffmpegBin();
  const mb = (stats.fileSize / (1024 * 1024)).toFixed(1);
  // Decode straight to the output canvas + rate (480x854@24 default): less
  // CPU, smaller JPEGs on the pacer pipe, zero quality wasted on pixels the
  // encoder would downscale anyway.
  const { w: DW, h: DH } = liveOutSize('vertical');
  const DF = liveFps();
  console.log(`[IG-Live] decoders spawned for reel ${shortcode} (${mb} MB, ${ff}) — first frame watch armed${withAudio ? '' : ' (picture-only: file carries no soundtrack, silence padded)'}.`);
  // Video: infinite realtime loop, output canvas, MJPEG frames at out rate.
  // -re keeps A/V realtime so the pacer queues stay balanced. q:v 2 (not 3):
  // the pipe re-encode is a second lossy generation, so the decoder must feed
  // it clean frames — localhost pipe bandwidth is free, quality is not.
  const video = spawn(ff, [
    '-hide_banner', '-loglevel', 'error',
    '-stream_loop', '-1', '-re', '-i', filePath,
    '-vf', `scale=${DW}:${DH}:force_original_aspect_ratio=increase,crop=${DW}:${DH},fps=${DF}`,
    '-f', 'image2pipe', '-vcodec', 'mjpeg', '-q:v', '2', '-'
  ], { stdio: ['ignore', 'pipe', 'pipe'] });
  // Audio: infinite realtime loop, raw PCM matching the pacer's UDP format.
  // Skipped entirely for soundtrack-less files — spawning it anyway exits
  // instantly and the exit handler would respawn BOTH decoders in a 3s storm,
  // resetting the picture over and over while YouTube starves.
  const audio = withAudio ? spawn(ff, [
    '-hide_banner', '-loglevel', 'error',
    '-stream_loop', '-1', '-re', '-i', filePath,
    '-vn', '-f', 's16le', '-ar', '44100', '-ac', '2', '-'
  ], { stdio: ['ignore', 'pipe', 'pipe'] }) : null;
  decoders = { video, audio, filePath, shortcode, watchId };
  // MJPEG framing: each frame is FFD8...FFD9. Split the byte stream on it.
  let pending = Buffer.alloc(0);
  video.stdout?.on('data', (chunk: Buffer) => {
    pending = Buffer.concat([pending, chunk]);
    // Drain complete frames; cap the buffer so a corrupt stream can't OOM.
    for (;;) {
      const start = pending.indexOf(Buffer.from([0xff, 0xd8]));
      if (start < 0) {
        if (pending.length > 2 * 1024 * 1024) pending = pending.subarray(pending.length - 2 * 1024 * 1024);
        break;
      }
      let end = -1;
      let from = start + 2;
      for (;;) {
        const idx = pending.indexOf(Buffer.from([0xff, 0xd9]), from);
        if (idx < 0) break;
        end = idx + 2;
        break;
      }
      if (end < 0) {
        if (start > 0) pending = pending.subarray(start);
        if (pending.length > 8 * 1024 * 1024) pending = Buffer.alloc(0);
        break;
      }
      const frame = pending.subarray(start, end);
      pending = pending.subarray(end);
      // Only forward frames for the CURRENT loop (a stale decoder racing a
      // swap must never paint its old reel back over the new one).
      if (decoders && decoders.video === video) {
        setReelFrame(frame);
        stats.frames++;
        const now = new Date().toISOString();
        stats.lastFrameAt = now;
        if (!stats.firstFrameAt) {
          stats.firstFrameAt = now;
          console.log(`[IG-Live] first reel frame flowing (${(frame.length / 1024).toFixed(0)} KB) — picture is reaching the push.`);
        }
      }
    }
  });
  audio?.stdout?.on('data', (chunk: Buffer) => {
    if (decoders && decoders.audio === audio) {
      appendReelAudio(chunk);
      stats.audioBytes += chunk.length;
      stats.lastAudioAt = new Date().toISOString();
    }
  });
  video.stderr?.on('data', (d: Buffer) => {
    for (const line of String(d).split('\n')) {
      const t = line.trim();
      if (t) pushTail(stats.videoErrTail, t);
    }
  });
  audio?.stderr?.on('data', (d: Buffer) => {
    for (const line of String(d).split('\n')) {
      const t = line.trim();
      if (t) pushTail(stats.audioErrTail, t);
    }
  });
  // First-frame watchdog: when the decoder yields zero pictures in 15s,
  // YouTube gets an audio-only (or empty) push and Studio shows "No data".
  // Loud log now beats silent confusion later.
  const myVideo = video;
  setTimeout(() => {
    if (decoders && decoders.video === myVideo && stats.frames === 0) {
      console.error(
        `[IG-Live] NO FRAMES from the reel decoder after 15s (file ${(stats.fileSize / 1024).toFixed(0)} KB) — ` +
        `YouTube will show "No data". decoder stderr: ${stats.videoErrTail.slice(-3).join(' | ') || '(empty)'}. ` +
        `Check the loop file plays locally: public/videos/iglive-${watchId}.mp4`
      );
    }
  }, 15000)?.unref?.();
  const onDecoderExit = (which: string) => (code: number | null, signal: string | null) => {
    if (which === 'video') stats.videoExit = `code=${code} signal=${signal || '-'} tail=${stats.videoErrTail.slice(-2).join(' | ') || '(empty)'}`;
    else stats.audioExit = `code=${code} signal=${signal || '-'}`;
    // A decoder death while its loop is still desired = heal by respawn
    // (file vanished mid-read, transient ffmpeg fault). The push itself
    // keeps repeating the last frame + silence meanwhile — still on air.
    if (decoders && (decoders.video === video || (audio && decoders.audio === audio)) && desired && desired.watchId === watchId) {
      console.warn(`[IG-Live] ${which} decoder exited (code=${code}) — respawning loop for @${desired.username}.`);
      setTimeout(() => {
        if (desired && desired.watchId === watchId && fs.existsSync(desired.filePath)) {
          try {
            spawnDecoder(desired.filePath, desired.shortcode, desired.watchId, desired.audio !== false);
          } catch (err) {
            console.warn('[IG-Live] decoder respawn note:', (err as Error)?.message || err);
          }
        }
      }, 3000)?.unref?.();
    }
  };
  video.on('exit', onDecoderExit('video'));
  audio?.on('exit', onDecoderExit('audio'));
  for (const proc of [video, audio]) {
    if (!proc) continue;
    proc.on('error', () => {});
    try {
      (proc.stdin as any)?.on?.('error', () => {});
    } catch { /* stdin-less */ }
  }
}

/** One-shot first picture of a reel file (same canvas/filter as the loop
 *  decoder). Doubles as a decodability proof: null = this file yields no
 *  picture, and starting a push for it would be a fake "LIVE". */
function extractStandbyFrame(filePath: string): Buffer | null {
  try {
    const { w: DW, h: DH } = liveOutSize('vertical');
    const out = execFileSync(ffmpegBin(), [
      '-hide_banner', '-loglevel', 'error',
      '-i', filePath,
      '-vf', `scale=${DW}:${DH}:force_original_aspect_ratio=increase,crop=${DW}:${DH}`,
      '-frames:v', '1', '-f', 'image2', '-vcodec', 'mjpeg', '-q:v', '4', 'pipe:1'
    ], { timeout: 60000, maxBuffer: 32 * 1024 * 1024, stdio: ['ignore', 'pipe', 'pipe'] });
    const buf = Buffer.isBuffer(out) ? out : Buffer.from(out as any);
    return buf && buf.length > 1000 ? buf : null;
  } catch {
    return null;
  }
}

/** True when the file carries an audio stream. `ffmpeg -i` with no output
 *  prints the stream map to stderr without decoding anything (fast). */
function fileHasAudio(filePath: string): boolean {
  try {
    execFileSync(ffmpegBin(), ['-hide_banner', '-i', filePath], {
      timeout: 25000, stdio: ['ignore', 'pipe', 'pipe']
    });
    return false; // unreachable: no output file always exits non-zero
  } catch (err: any) {
    const txt = String(err?.stderr || '') + String(err?.stdout || '');
    return /Audio:/i.test(txt);
  }
}

/** Bounded wait for the loop decoder's first flowing frame. Resolves true as
 *  soon as picture provably reaches the push — Go Live only reports LIVE
 *  after this, so YouTube never gets an empty "No data" push. */
function waitForDecoderFrames(watchId: string, timeoutMs: number): Promise<boolean> {
  return new Promise((resolve) => {
    const start = Date.now();
    const t = setInterval(() => {
      if (!decoders || decoders.watchId !== watchId) {
        clearInterval(t);
        resolve(false);
        return;
      }
      if (stats.frames > 0) {
        clearInterval(t);
        resolve(true);
        return;
      }
      if (Date.now() - start > timeoutMs) {
        clearInterval(t);
        resolve(false);
      }
    }, 200);
    (t as any)?.unref?.();
  });
}

/** Bounded wait for the first decoded audio (~0.5s of PCM). Picture alone is
 *  not enough to start the push: audio decoders lag video by 1–2s, and every
 *  millisecond the pacer runs on silence-first becomes a PERMANENT lip-sync
 *  offset for the whole loop. Skipped for soundtrack-less files. */
function waitForDecoderAudio(minBytes: number, timeoutMs: number): Promise<boolean> {
  return new Promise((resolve) => {
    const start = Date.now();
    const t = setInterval(() => {
      if (!decoders) {
        clearInterval(t);
        resolve(false);
        return;
      }
      try {
        if (getPushIoState().audioQueueBytes >= minBytes) {
          clearInterval(t);
          resolve(true);
          return;
        }
      } catch { /* diag read is best effort */ }
      if (Date.now() - start > timeoutMs) {
        clearInterval(t);
        resolve(false);
      }
    }, 200);
    (t as any)?.unref?.();
  });
}

export interface IgLivePublicStatus {
  active: boolean;
  mode: 'news' | 'reel';
  watchId: string | null;
  username: string | null;
  shortcode: string | null;
  startedAt: string | null;
  mine: boolean;
  hasDecoders: boolean;
  /** Flow proof: pictures actually decoded for the push (0 = stalled). */
  frames: number;
  audioBytes: number;
  firstFrameAt: string | null;
  lastFrameAt: string | null;
  fileSize: number;
  videoExit: string | null;
  audioExit: string | null;
  videoErrTail: string[];
}

export function getIgLiveStatus(callerUserId?: string | null): IgLivePublicStatus {
  const st = getLiveStatus();
  const reel = getReelInfo();
  const owner = getLiveOwner();
  return {
    active: st.active && getLiveMode() === 'reel',
    mode: st.active ? getLiveMode() : 'news',
    watchId: st.active && getLiveMode() === 'reel' ? reel?.watchId || null : null,
    username: st.active && getLiveMode() === 'reel' ? reel?.username || null : null,
    shortcode: st.active && getLiveMode() === 'reel' ? reel?.shortcode || null : null,
    startedAt: st.active && getLiveMode() === 'reel' ? reel?.startedAt || st.startedAt : null,
    mine: !owner || !callerUserId || owner === callerUserId,
    hasDecoders: !!decoders,
    frames: stats.frames,
    audioBytes: stats.audioBytes,
    firstFrameAt: stats.firstFrameAt,
    lastFrameAt: stats.lastFrameAt,
    fileSize: stats.fileSize,
    videoExit: stats.videoExit,
    audioExit: stats.audioExit,
    videoErrTail: stats.videoErrTail
  };
}

export interface BeginLoopInput {
  watchId: string;
  userId: string;
  username: string;
  shortcode: string;
  filePath: string;
  rtmpUrl: string;
  streamKey: string;
}

/**
 * Bring the reel loop on air for a watch. Cases:
 *  - Off air → start the push + decoders (one brief connect, then stable).
 *  - Same watch already looping → just (re)spawn decoders (no-op when the
 *    same file is already looping).
 *  - Anything else on air → 409 unless `force` (explicit Go Live takes over
 *    the push; the timer path never hijacks).
 * The swap itself never restarts the push — the live stays connected.
 */
export async function beginReelLoop(input: BeginLoopInput, force = false): Promise<IgLivePublicStatus> {
  let size = 0;
  try {
    size = fs.statSync(input.filePath).size;
  } catch {
    size = 0;
  }
  if (!size) {
    throw new Error('Reel file not found on disk — press Check now first, then Go Live again.');
  }
  if (size < 100 * 1024) {
    throw new Error(`Reel file is too small (${(size / 1024).toFixed(0)} KB) — the download was incomplete. Press Check now, then Go Live again.`);
  }
  const owner = getLiveOwner();
  if (owner && input.userId && owner !== input.userId) {
    throw new Error('YouTube Live is on air for another signed-in user — only they can stop or replace it.');
  }
  const onAirReel = isLiveActive() && getLiveMode() === 'reel' ? getReelInfo() : null;
  // Probe once per arming: soundtrack-less reels loop picture-only (the pacer
  // pads silence) instead of spawning a doomed audio decoder.
  const withAudio = fileHasAudio(input.filePath);
  if (onAirReel && onAirReel.watchId === input.watchId) {
    desired = { ...input, audio: withAudio };
    // Same file still looping → nothing to do (timer re-entry is free).
    if (decoders && decoders.shortcode === input.shortcode && decoders.filePath === input.filePath) {
      return getIgLiveStatus(input.userId);
    }
    // Newer reel for the SAME loop → seamless decoder swap, push untouched.
    // Validate first: swapping to an undecodable file would stall a working
    // live, so a bad newcomer is rejected while the current reel keeps looping.
    if (!extractStandbyFrame(input.filePath)) {
      throw new Error('Newer reel file yields no decodable picture — keeping the current reel looping. Press Check now for a fresh download.');
    }
    spawnDecoder(input.filePath, input.shortcode, input.watchId, withAudio);
    setReelShortcode(input.shortcode);
    try {
      const watch = await getIgWatchById(input.watchId);
      if (watch) {
        const { updateIgWatch } = await import('./db.js');
        await updateIgWatch(input.watchId, watch.user_id, { liveShortcode: input.shortcode });
        await touchLiveReelShortcode(watch.user_id, input.shortcode);
      }
    } catch { /* pointer sync is best effort */ }
    return getIgLiveStatus(input.userId);
  }
  if (isLiveActive() && !force) {
    throw new Error(
      getLiveMode() === 'reel'
        ? 'Another profile’s reel is looping on air — use Go Live on THIS profile to take over.'
        : 'News broadcast is on air — use Go Live on this profile to switch it to the reel loop (or Stop it first).'
    );
  }
  // Startup order matters: the file must provably yield picture BEFORE any
  // push exists. Previously the push started first with an empty frame queue,
  // so YouTube saw a connected stream with "No data" while the API already
  // reported LIVE — the exact "live doesn't really happen" symptom.
  const standby = extractStandbyFrame(input.filePath);
  if (!standby) {
    throw new Error(
      'Reel file yields no decodable picture (corrupt or partial download) — starting a push for it would show "No data" on YouTube. Press Check now to re-discover, then Go Live again.'
    );
  }
  console.log(`[IG-Live] standby picture validated for reel ${input.shortcode}${withAudio ? '' : ' (no soundtrack — silence padded)'}.`);
  desired = { ...input, audio: withAudio };
  clearReelFeed();
  if (isLiveActive()) {
    // Explicit takeover: the old push must drop (one reconnect), then the
    // reel loop owns the push continuously from there on.
    const { stopLiveBroadcast } = await import('./liveStreamService.js');
    try {
      stopLiveBroadcast(input.userId);
    } catch { /* already gone */ }
    await new Promise(r => setTimeout(r, 1500));
  }
  // Decoders first; the push starts only after the first live frame provably
  // flows (bounded wait) — YouTube receives dense picture from second zero.
  spawnDecoder(input.filePath, input.shortcode, input.watchId, withAudio);
  const flowing = await waitForDecoderFrames(input.watchId, 12000);
  if (!flowing) {
    const tail = stats.videoErrTail.slice(-3).join(' | ') || '(empty)';
    killDecoders();
    desired = null;
    throw new Error(
      `Reel decoder produced no picture within 12s — nothing would reach YouTube (decoder: ${tail}). The reel file may use an unsupported codec; try Check now for a fresh download.`
    );
  }
  // ...and only after the first AUDIO bytes land too (bounded): starting the
  // pacer on silence-first bakes a permanent lip-sync offset into the loop.
  if (withAudio) {
    const audioOk = await waitForDecoderAudio(88000, 6000);
    if (!audioOk) {
      console.warn(`[IG-Live] reel ${input.shortcode}: proceeding with picture-proven flow but unconfirmed audio (sparse soundtrack start?) — a small A/V offset is possible.`);
    } else {
      console.log(`[IG-Live] reel ${input.shortcode}: picture + soundtrack locked together — starting push in sync.`);
    }
  }
  await startReelBroadcast({
    rtmpUrl: input.rtmpUrl,
    streamKey: input.streamKey,
    ownerUserId: input.userId,
    watchId: input.watchId,
    username: input.username,
    shortcode: input.shortcode,
    standbyFrame: standby
  });
  return getIgLiveStatus(input.userId);
}

/** Stop the reel loop. When this watch owns the push, the push goes off air
 *  (nothing sensible to fall back to mid-loop); decoders always die. */
export async function stopReelLoop(userId: string | null, watchId?: string): Promise<IgLivePublicStatus> {
  const reel = getLiveMode() === 'reel' ? getReelInfo() : null;
  killDecoders();
  desired = null;
  if (isLiveActive() && getLiveMode() === 'reel' && (!watchId || reel?.watchId === watchId)) {
    const { stopLiveBroadcast } = await import('./liveStreamService.js');
    try {
      stopLiveBroadcast(userId);
    } catch (err) {
      throw err;
    }
  }
  return getIgLiveStatus(userId);
}

/** Boot resume: a persisted reel session (mode=reel) comes back as a loop —
 *  same watch, same key, latest on-disk file. Returns true when resumed. */
export async function resumeIgLiveBroadcast(): Promise<boolean> {
  try {
    if (isLiveActive()) return false;
    const row = await getAnyLiveStream();
    if (!row || (row.mode || 'news') !== 'reel' || !row.reel_watch_id || !row.stream_key) return false;
    const watch = await getIgWatchById(row.reel_watch_id);
    if (!watch || !watch.live_enabled) return false;
    const filePath = liveFilePath(watch.id);
    if (!fs.existsSync(filePath)) {
      console.log(`[IG-Live] resume skipped — loop file missing for @${watch.username} (timer will rebuild it).`);
      return false;
    }
    const shortcode = row.reel_shortcode || watch.live_shortcode || watch.last_shortcode || 'live';
    await beginReelLoop({
      watchId: watch.id,
      userId: watch.user_id,
      username: watch.username,
      shortcode,
      filePath,
      rtmpUrl: row.rtmp_url || 'rtmp://a.rtmp.youtube.com/live/',
      streamKey: row.stream_key
    }, true);
    console.log(`[IG-Live] RESUMED after restart — @${watch.username} reel ${shortcode} looping.`);
    return true;
  } catch (err) {
    console.warn('[IG-Live] resume note:', (err as Error)?.message || err);
    return false;
  }
}

/** Self-heal hook for unexpected ffmpeg deaths (registered at boot). */
export async function restartIgLiveLoop(): Promise<boolean> {
  try {
    if (isLiveActive() || !desired) return false;
    if (!fs.existsSync(desired.filePath)) return false;
    await beginReelLoop({ ...desired }, true);
    console.log(`[IG-Live] auto-restarted loop for @${desired.username}.`);
    return true;
  } catch (err) {
    console.warn('[IG-Live] auto-restart note:', (err as Error)?.message || err);
    return false;
  }
}

/** On-disk loop file for a watch (persistent — never served, never pruned). */
export function liveFilePath(watchId: string): string {
  return path.join(process.cwd(), 'public', 'videos', `iglive-${watchId}.mp4`);
}

/** Register cross-service hooks (call once at boot). */
export function registerIgLiveHooks(): void {
  setLiveStopHook(() => {
    killDecoders();
    desired = null;
  });
  setLiveReelRestartHook(() => restartIgLiveLoop());
}
