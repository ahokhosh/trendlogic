import React, { useCallback, useEffect, useMemo, useState } from 'react';
import { Video, Square, Play, Eye, EyeOff, Copy, Check, Info, Monitor, Radio, Smartphone, MonitorPlay } from 'lucide-react';
import { NormalizedTrend } from '../types';
import { LiveNewsScene, LiveNewsSceneVertical, trendsToScene, scenePayloadToSceneData, FlagBadge, type RundownInfo, type SceneData } from './LiveNewsScene';

interface StreamStatus {
  active: boolean;
  startedAt: string | null;
  uptimeSec: number;
  topic: string;
  orientation: 'vertical' | 'horizontal';
  /** What feeds the push: news cards vs a looping Instagram reel. */
  mode?: 'news' | 'reel';
  reel?: { watchId: string; username: string; shortcode: string; startedAt: string } | null;
  engineType: 'cards' | 'drawtext';
  cardError: string | null;
  rotation: boolean;
  slot: { countryCode: string; countryName: string; storyIndex: number; storyTotal: number } | null;
  rtmpHost: string | null;
  ffmpegOk: boolean;
  overlayUpdatedAt: string | null;
  persisted: boolean;
  engine: { fps: number; kbps: number; speed: number; totalMB: number; updatedAt: string } | null;
  voice: boolean;
  voiceHealth: { coolingDown: boolean; consecFails: number; lastError: string | null; cached: number };
  tick: { ageSec: number | null; renderMs: number | null; photo: boolean };
  assets: { cover: 'wall' | 'single' | 'gradient' | 'page' | 'card' | 'none'; flag: boolean; photos: number };
  fonts: { head: boolean; body: boolean };
  /** False when another signed-in user owns the running broadcast. */
  mine: boolean;
  logTail: string[];
  message: string;
}

const DEFAULT_RTMP = 'rtmp://a.rtmp.youtube.com/live/';

function fmtUptime(sec: number): string {
  const h = Math.floor(sec / 3600);
  const m = Math.floor((sec % 3600) / 60);
  const s = sec % 60;
  return [h, m, s].map(n => String(n).padStart(2, '0')).join(':');
}

export const LiveStreamView: React.FC<{ trends: NormalizedTrend[]; country: string }> = ({
  trends,
  country
}) => {
  const [status, setStatus] = useState<StreamStatus | null>(null);
  const [rtmpUrl, setRtmpUrl] = useState(DEFAULT_RTMP);
  const [streamKey, setStreamKey] = useState('');
  const [showKey, setShowKey] = useState(false);
  const [topicKeyword, setTopicKeyword] = useState(''); // '' = auto #1
  // Vertical 9:16 is the default canvas (phone-first, Shorts feed).
  const [orientation, setOrientation] = useState<'vertical' | 'horizontal'>('vertical');
  const [busy, setBusy] = useState(false);
  const [error, setError] = useState<string | null>(null);
  const [copied, setCopied] = useState(false);
  // YouTube-side ingest verdict (asks YouTube's own API whether our RTMP
  // data arrives + whether the saved key matches a real stream).
  const [ingest, setIngest] = useState<{
    checkedAt: string;
    streams: { id: string; title: string; streamNameSuffix: string; healthStatus: string; streamStatus: string; matchesSavedKey: boolean }[];
    note: string;
  } | null>(null);
  const [ingestError, setIngestError] = useState<string | null>(null);
  const [ingestBusy, setIngestBusy] = useState(false);
  const checkIngest = useCallback(async () => {
    setIngestBusy(true);
    setIngestError(null);
    try {
      const res = await fetch('/api/stream/ingest-health');
      const json = await res.json().catch(() => null);
      if (!res.ok || !json?.success) {
        throw new Error(json?.error || `Check failed (${res.status})`);
      }
      setIngest(json.health);
    } catch (e: any) {
      setIngestError(e?.message || 'Ingest check failed.');
    } finally {
      setIngestBusy(false);
    }
  }, []);
  // Per-account saved setup (key entered once, reused). The key itself never
  // comes back — only presence + masked hint + RTMP/orientation prefs.
  const [saved, setSaved] = useState<{
    hasKey: boolean; keyHint: string; rtmpUrl: string | null; orientation: string | null;
  } | null>(null);
  const prefsApplied = React.useRef(false);
  const fetchSettings = useCallback(async () => {
    try {
      const res = await fetch('/api/stream/settings');
      if (!res.ok) return;
      const json = await res.json();
      const s = json.settings || null;
      setSaved(s);
      // Prefill once (never clobber the user's own edits afterwards).
      if (s && !prefsApplied.current) {
        prefsApplied.current = true;
        if (s.rtmpUrl) setRtmpUrl(s.rtmpUrl);
        if (s.orientation === 'horizontal' || s.orientation === 'vertical') {
          setOrientation(s.orientation);
        }
      }
    } catch {
      /* setup form keeps manual values */
    }
  }, []);

  useEffect(() => {
    fetchSettings();
  }, [fetchSettings]);

  const handleForgetKey = async () => {
    setBusy(true);
    try {
      await fetch('/api/stream/settings', { method: 'DELETE' });
      await fetchSettings();
    } finally {
      setBusy(false);
    }
  };

  const fetchStatus = useCallback(async () => {
    try {
      const res = await fetch('/api/stream/status');
      if (res.ok) {
        const json = await res.json();
        if (json.stream) setStatus(json.stream);
      }
    } catch {
      /* status pill keeps last state */
    }
  }, []);

  useEffect(() => {
    fetchStatus();
  }, [fetchStatus]);
  useEffect(() => {
    if (!status?.active) return;
    const t = setInterval(fetchStatus, 5000);
    return () => clearInterval(t);
  }, [status?.active, fetchStatus]);

  // Rotation state (public scene feed): countries × top-5 by volume,
  // current slot pointer and the on-air hero with photo/country/source.
  const [scene, setScene] = useState<{ data: SceneData; rundown: RundownInfo; live: boolean } | null>(null);
  const fetchScene = useCallback(async () => {
    try {
      const res = await fetch('/api/stream/scene');
      if (!res.ok) return;
      const mapped = scenePayloadToSceneData(await res.json());
      if (mapped) setScene(mapped);
    } catch {
      /* preview keeps last state */
    }
  }, []);

  useEffect(() => {
    fetchScene();
    // Track the server rotation (~10s per story) so the preview never lags
    // a full story behind the air signal.
    const t = setInterval(fetchScene, 8000);
    return () => clearInterval(t);
  }, [fetchScene]);

  /** Preview mirrors the rotation feed (same hero/photo/country as on air);
   *  falls back to the local trend list while the rotation warms up. */
  const previewData = useMemo(() => {
    if (scene) return scene.data;
    let list = trends;
    if (topicKeyword) {
      const picked = trends.find(t => t.keyword === topicKeyword);
      if (picked) list = [picked, ...trends.filter(t => t.keyword !== topicKeyword)];
    }
    return trendsToScene(list, country);
  }, [scene, trends, topicKeyword, country]);

  const sceneUrl = useMemo(() => {
    try {
      const u = new URL(window.location.href);
      u.search = `?scene=live&orientation=${orientation}`;
      u.hash = '';
      return u.toString();
    } catch {
      return `?scene=live&orientation=${orientation}`;
    }
  }, [orientation]);

  const handleStart = async () => {
    setBusy(true);
    setError(null);
    try {
      const res = await fetch('/api/stream/start', {
        method: 'POST',
        headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify({ streamKey, rtmpUrl, topicKeyword, orientation })
      });
      const json = await res.json().catch(() => null);
      if (!res.ok || !json?.success) {
        throw new Error(json?.error || `Start failed (${res.status})`);
      }
      setStatus(json.stream);
      // The key served its purpose — drop it from the form immediately
      // (the server saved it to the account for next time).
      setStreamKey('');
      void fetchSettings();
    } catch (e: any) {
      setError(e?.message || 'Could not start the broadcast.');
    } finally {
      setBusy(false);
    }
  };

  const handleStop = async () => {
    setBusy(true);
    setError(null);
    try {
      const res = await fetch('/api/stream/stop', { method: 'POST' });
      const json = await res.json().catch(() => null);
      if (!res.ok || !json?.success) {
        throw new Error(json?.error || `Stop failed (${res.status})`);
      }
      if (json?.stream) setStatus(json.stream);
      else await fetchStatus();
    } catch (e: any) {
      setError(e?.message || 'Could not stop the broadcast.');
    } finally {
      setBusy(false);
    }
  };

  /** Owner-only "new key" swap while live: one call, server kills the old
   *  push and resumes with the replacement key — the tab stays irrelevant. */
  const handleRestart = async () => {
    setBusy(true);
    setError(null);
    try {
      const res = await fetch('/api/stream/restart', {
        method: 'POST',
        headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify({ streamKey, rtmpUrl, topicKeyword, orientation })
      });
      const json = await res.json().catch(() => null);
      if (!res.ok || !json?.success) {
        throw new Error(json?.error || `Restart failed (${res.status})`);
      }
      setStatus(json.stream);
      setStreamKey('');
      void fetchSettings();
    } catch (e: any) {
      setError(e?.message || 'Could not restart the broadcast.');
    } finally {
      setBusy(false);
    }
  };

  const copySceneUrl = async () => {
    try {
      await navigator.clipboard.writeText(sceneUrl);
      setCopied(true);
      setTimeout(() => setCopied(false), 2000);
    } catch {
      /* clipboard unavailable */
    }
  };

  const live = !!status?.active;
  const foreignLive = live && status && status.mine === false;
  // Saved account key counts exactly like a typed one — Go Live never asks
  // twice. A fresh typed key always wins over the saved one.
  const hasUsableKey = streamKey.trim().length >= 4 || !!saved?.hasKey;

  return (
    <div className="space-y-5">
      {/* ── Status banner ─────────────────────────────────────── */}
      {foreignLive && (
        <div className="p-3 rounded-xl bg-amber-950/50 border border-amber-500/40 text-amber-200 text-xs font-semibold">
          Another signed-in user started this broadcast — it runs fully on the server and only they can stop it or swap its key. Your controls are read-only until it ends.
        </div>
      )}
      <div
        className={`p-4 rounded-2xl border-2 flex flex-wrap items-center gap-4 ${
          live
            ? 'bg-gradient-to-r from-red-950/90 via-slate-900 to-slate-900 border-red-500/60 shadow-xl shadow-red-950/40'
            : 'bg-slate-900/80 border-slate-800'
        }`}
      >
        <div className={`w-12 h-12 rounded-2xl flex items-center justify-center shrink-0 ${live ? 'bg-red-600 shadow-lg shadow-red-600/40' : 'bg-slate-800'}`}>
          <Radio className={`w-6 h-6 ${live ? 'text-white' : 'text-slate-500'}`} />
        </div>
        <div className="min-w-0 flex-1">
          <div className="flex items-center gap-2 flex-wrap">
            <span className={`px-2 py-0.5 rounded text-[10px] uppercase font-mono font-black ${live ? 'bg-red-600 text-white' : 'bg-slate-700/60 text-slate-400'}`}>
              {live ? '● On air' : 'Off air'}
            </span>
            {live && status && (
              <span className="text-xs font-mono text-red-300 tabular-nums">
                {fmtUptime(status.uptimeSec)}
              </span>
            )}
            {live && status && (
              <span className="px-2 py-0.5 rounded text-[10px] font-mono font-bold bg-white/10 border border-white/15 text-slate-200">
                {status.orientation === 'vertical' ? '9:16 vertical' : '16:9 horizontal'}
              </span>
            )}
            {live && status && (
              <span
                className={`px-2 py-0.5 rounded text-[10px] font-mono font-bold border ${
                  status.engineType === 'cards'
                    ? 'bg-emerald-500/15 text-emerald-300 border-emerald-500/40'
                    : 'bg-amber-500/15 text-amber-300 border-amber-500/40'
                }`}
                title={status.engineType === 'cards'
                  ? 'Composed-frame engine: every story rendered as a full broadcast card, swapped live'
                  : `Drawtext mirror fallback (no voice, static wall) — cards unavailable: ${status.cardError || 'unknown reason'}`}
              >
                {status.engineType === 'cards' ? 'CARDS • composed frames' : 'DRAWTEXT • cards missing!'}
              </span>
            )}
            {live && status?.engine && (
              <span
                className={`px-2 py-0.5 rounded text-[10px] font-mono font-bold border tabular-nums ${
                  status.engine.speed >= 0.95
                    ? 'bg-emerald-500/15 text-emerald-300 border-emerald-500/40'
                    : 'bg-amber-500/15 text-amber-300 border-amber-500/40'
                }`}
                title="Realtime encoder health (fps • output bitrate • speed • total MB sent; MB frozen while uptime climbs = nothing reaches YouTube)"
              >
                {status.engine.fps}fps • {status.engine.kbps}kbps • {status.engine.speed}x • {status.engine.totalMB}MB out
              </span>
            )}
            {live && status?.engine && status.engine.speed < 0.95 && (
              <span className="px-2 py-0.5 rounded text-[10px] font-bold bg-amber-500/20 text-amber-200 border border-amber-500/40">
                Encoder slower than realtime — buffering risk
              </span>
            )}
            {live && status && (
              <span
                className={`px-2 py-0.5 rounded text-[10px] font-mono font-bold border ${
                  status.voice
                    ? 'bg-emerald-500/15 text-emerald-300 border-emerald-500/40'
                    : 'bg-amber-500/15 text-amber-300 border-amber-500/40'
                }`}
                title={status.voice
                  ? `Narrator is reading each story (country, then title). Voices cached: ${status.voiceHealth?.cached ?? 0}`
                  : `Narrator silent — ${status.voiceHealth?.coolingDown
                    ? 'TTS backend cooling down after failures (10m breaker)'
                    : status.voiceHealth?.lastError
                      ? `last TTS error: ${status.voiceHealth.lastError}`
                      : 'voice warming up or LIVE_VOICE=0'}`}
              >
                {status.voice ? 'VOICE • narrator on' : `VOICE • muted${status.voiceHealth?.coolingDown ? ' (cooldown)' : ''}`}
              </span>
            )}
            {live && status?.tick && status.tick.ageSec !== null && (
              <span
                className={`px-2 py-0.5 rounded text-[10px] font-mono font-bold border tabular-nums ${
                  status.tick.ageSec <= 15
                    ? 'bg-white/10 text-slate-300 border-white/15'
                    : 'bg-amber-500/15 text-amber-300 border-amber-500/40'
                }`}
                title="Rotation cadence proof: how long ago the last story tick fired, what the card render cost, and whether its photo arrived"
              >
                tick {status.tick.ageSec}s ago • render {status.tick.renderMs ?? '—'}ms • photo {status.tick.photo ? '✓' : '✗'}
              </span>
            )}
            {live && status?.assets && (
              <span
                className={`px-2 py-0.5 rounded text-[10px] font-mono font-bold border ${
                  status.assets.cover === 'none' || status.assets.cover === 'gradient'
                    ? 'bg-amber-500/15 text-amber-300 border-amber-500/40'
                    : 'bg-white/10 text-slate-300 border-white/15'
                }`}
                title={`Backdrop: ${status.assets.cover} (${status.assets.photos} photos) • Flag: ${status.assets.flag ? 'on' : 'off'} • Fonts: head ${status.fonts?.head ? 'ok' : 'MISSING'}, body ${status.fonts?.body ? 'ok' : 'MISSING'}`}
              >
                BG: {status.assets.cover === 'card' ? 'live card' : status.assets.cover}{status.assets.photos > 0 ? ` (${status.assets.photos} photos)` : ''} • Flag: {status.assets.flag ? 'on' : 'off'}
                {status.fonts && (!status.fonts.head || !status.fonts.body) ? ' • FONT MISSING' : ''}
              </span>
            )}
            {live && status && status.rotation && status.slot && (
              <span className="px-2 py-0.5 rounded text-[10px] font-mono font-bold bg-sky-500/15 text-sky-300 border border-sky-500/40 tabular-nums">
                {status.slot.countryCode} • story {status.slot.storyIndex}/{status.slot.storyTotal} • rotates every {scene?.rundown.rotateSec || 45}s
              </span>
            )}
            {live && status && !status.rotation && status?.mode !== 'reel' && (
              <span className="px-2 py-0.5 rounded text-[10px] font-mono font-bold bg-white/10 text-slate-300 border border-white/15">
                Pinned story — rotation paused
              </span>
            )}
            {live && status?.mode === 'reel' && status?.reel && (
              <span className="px-2 py-0.5 rounded text-[10px] font-mono font-bold bg-red-600 text-white border border-red-400 tabular-nums" title="An Instagram profile's newest reel is looping (repeats until its timer swaps in a newer reel — the push never restarts). Manage it from the Instagram tab.">
                REEL LOOP • @{status.reel.username} • {status.reel.shortcode}
              </span>
            )}
            {!live && scene && scene.rundown.countries.length > 0 && (
              <span className="px-2 py-0.5 rounded text-[10px] font-mono font-bold bg-white/10 text-slate-300 border border-white/15 tabular-nums">
                {scene.rundown.countries.map(c => c.code).join(' • ')} — {scene.rundown.countries.reduce((n, c) => n + c.stories.length, 0)} stories in rotation
              </span>
            )}
            {status && !status.ffmpegOk && (
              <span className="px-2 py-0.5 rounded text-[10px] font-mono font-bold bg-amber-500/20 text-amber-300 border border-amber-500/40">
                ffmpeg drawtext missing — install full ffmpeg
              </span>
            )}
          </div>
          <p className="text-sm text-slate-300 mt-1">
            {status?.message || 'Checking broadcast engine…'}
          </p>
          {live && status && (
            <p className="text-[11px] text-slate-500 mt-0.5">
              Runs 100% on the server — closing this tab changes nothing.
              {status.persisted
                ? ' Session saved: a server restart auto-resumes this push.'
                : ' Session NOT saved (database unreachable): a server restart would end this push.'}
            </p>
          )}
          {live && status?.rtmpHost && (
            <p className="text-[11px] font-mono text-slate-500 mt-0.5">
              {status.rtmpHost} • key hidden • overlay synced {status.overlayUpdatedAt ? new Date(status.overlayUpdatedAt).toLocaleTimeString() : '—'}
            </p>
          )}
        </div>
        <div className="flex items-center gap-2">
          {!live ? (
            <button
              onClick={handleStart}
              disabled={busy || !hasUsableKey}
              title={!hasUsableKey ? 'Paste your YouTube stream key once — it stays saved to your account' : 'Push live to YouTube now'}
              className="px-5 py-2.5 rounded-xl bg-gradient-to-r from-red-600 to-rose-600 hover:brightness-110 active:scale-95 text-white font-black text-sm shadow-lg shadow-red-600/30 transition-all disabled:opacity-40 flex items-center gap-2"
            >
              <Play className="w-4 h-4 fill-current" />
              Go Live
            </button>
          ) : foreignLive ? null : (
            <>
              <button
                onClick={handleRestart}
                disabled={busy}
                title={streamKey.trim()
                  ? 'Kill the running push and resume instantly with the new key above'
                  : 'Reconnect the running push with your saved key (fixes a wedged stream)'}
                className="px-5 py-2.5 rounded-xl bg-gradient-to-r from-amber-600 to-orange-600 hover:brightness-110 active:scale-95 text-white font-black text-sm shadow-lg shadow-amber-600/30 transition-all disabled:opacity-40 flex items-center gap-2"
              >
                <Play className="w-4 h-4 fill-current" />
                {streamKey.trim() ? 'Restart with new key' : 'Restart (same key)'}
              </button>
              <button
                onClick={handleStop}
                disabled={busy}
                className="px-5 py-2.5 rounded-xl bg-slate-700 hover:bg-slate-600 active:scale-95 text-white font-black text-sm transition-all disabled:opacity-50 flex items-center gap-2"
              >
                <Square className="w-4 h-4 fill-current" />
                End Stream
              </button>
            </>
          )}
        </div>
      </div>

      {error && (
        <div className="p-3 rounded-xl bg-red-950/60 border border-red-500/40 text-red-300 text-xs font-semibold">
          {error}
        </div>
      )}

      <div className="grid grid-cols-1 lg:grid-cols-5 gap-5">
        {/* ── Setup ───────────────────────────────────────────── */}
        <div className="lg:col-span-2 space-y-4">
          <div className="p-4 rounded-2xl bg-slate-900/80 border border-slate-800 space-y-3">
            <h3 className="text-xs font-black uppercase tracking-widest text-slate-300 flex items-center gap-2">
              <Video className="w-4 h-4 text-red-500" />
              YouTube Live setup
            </h3>

            <label className="block">
              <span className="text-[11px] font-bold text-slate-400 uppercase">
                Stream key (from YouTube Studio)
                {saved?.hasKey && (
                  <span className="ml-2 px-1.5 py-0.5 rounded bg-emerald-500/15 border border-emerald-500/40 text-emerald-300 text-[10px] font-mono normal-case">
                    saved {saved.keyHint}
                  </span>
                )}
              </span>
              <div className="mt-1 flex items-center gap-1.5">
                <input
                  type={showKey ? 'text' : 'password'}
                  value={streamKey}
                  onChange={e => setStreamKey(e.target.value)}
                  placeholder={saved?.hasKey ? `Saved ${saved.keyHint} — type to replace` : 'xxxx-xxxx-xxxx-xxxx-xxxx'}
                  dir="ltr"
                  disabled={busy || !!foreignLive}
                  className="flex-1 min-w-0 px-3 py-2 rounded-xl bg-slate-950 border border-slate-700 text-slate-100 text-sm font-mono outline-none focus:border-red-500 disabled:opacity-50"
                />
                <button
                  onClick={() => setShowKey(v => !v)}
                  className="p-2 rounded-xl bg-slate-800 hover:bg-slate-700 text-slate-300 transition-colors"
                  title={showKey ? 'Hide key' : 'Show key'}
                >
                  {showKey ? <EyeOff className="w-4 h-4" /> : <Eye className="w-4 h-4" />}
                </button>
                {saved?.hasKey && !live && (
                  <button
                    onClick={handleForgetKey}
                    disabled={busy}
                    className="px-2.5 py-2 rounded-xl bg-slate-800 hover:bg-red-950/60 hover:text-red-300 text-slate-400 text-[11px] font-bold transition-colors disabled:opacity-50 whitespace-nowrap"
                    title="Delete the saved key from your account (you will be asked again next time)"
                  >
                    Forget
                  </button>
                )}
              </div>
              <span className="text-[10px] text-slate-500">
                {live && !foreignLive
                  ? (streamKey.trim()
                    ? 'Restart will swap to this new key — the saved one updates too.'
                    : 'Restart reconnects with your saved key — type above to swap to a new one.')
                  : (saved?.hasKey
                    ? `Key saved to your account ${saved.keyHint} — Go Live works without typing. Type a new one only to replace it.`
                    : 'Enter once — it stays saved to your account and you will not be asked again. The key itself is never shown back.')}
              </span>
            </label>

            <label className="block">
              <span className="text-[11px] font-bold text-slate-400 uppercase">RTMP server</span>
              <input
                type="text"
                value={rtmpUrl}
                onChange={e => setRtmpUrl(e.target.value)}
                dir="ltr"
                disabled={busy || !!foreignLive}
                className="mt-1 w-full px-3 py-2 rounded-xl bg-slate-950 border border-slate-700 text-slate-100 text-xs font-mono outline-none focus:border-red-500 disabled:opacity-50"
              />
            </label>

            <div className="block">
              <span className="text-[11px] font-bold text-slate-400 uppercase">Canvas (default: vertical Shorts)</span>
              <div className="mt-1 grid grid-cols-2 gap-1.5">
                <button
                  onClick={() => setOrientation('vertical')}
                  disabled={busy || !!foreignLive}
                  title="9:16 portrait — fullscreen on phones, discoverable in the Shorts feed"
                  className={`px-3 py-2 rounded-xl text-xs font-black flex items-center justify-center gap-1.5 transition-all active:scale-95 disabled:opacity-50 ${
                    orientation === 'vertical'
                      ? 'bg-red-600 text-white shadow-lg shadow-red-600/30'
                      : 'bg-slate-950 border border-slate-700 text-slate-400 hover:text-slate-200'
                  }`}
                >
                  <Smartphone className="w-4 h-4" />
                  9:16 Vertical
                </button>
                <button
                  onClick={() => setOrientation('horizontal')}
                  disabled={busy || !!foreignLive}
                  title="16:9 landscape — classic desktop live"
                  className={`px-3 py-2 rounded-xl text-xs font-black flex items-center justify-center gap-1.5 transition-all active:scale-95 disabled:opacity-50 ${
                    orientation === 'horizontal'
                      ? 'bg-red-600 text-white shadow-lg shadow-red-600/30'
                      : 'bg-slate-950 border border-slate-700 text-slate-400 hover:text-slate-200'
                  }`}
                >
                  <MonitorPlay className="w-4 h-4" />
                  16:9 Horizontal
                </button>
              </div>
              <span className="text-[10px] text-slate-500">
                {live && !foreignLive && status && status.orientation !== orientation
                  ? `Applies on Restart — the running push stays ${status.orientation} until then.`
                  : 'Vertical fills phone screens and can surface in the Shorts feed.'}
              </span>
            </div>

            <label className="block">
              <span className="text-[11px] font-bold text-slate-400 uppercase">Story on air</span>
              <select
                value={topicKeyword}
                onChange={e => setTopicKeyword(e.target.value)}
                disabled={busy || !!foreignLive}
                className="mt-1 w-full px-3 py-2 rounded-xl bg-slate-950 border border-slate-700 text-slate-100 text-sm font-semibold outline-none focus:border-red-500 disabled:opacity-50"
              >
                <option value="">
                  Auto-rotation — top stories across {scene ? scene.rundown.countries.length : '…'} countries
                  {scene ? ` (now: ${scene.data.trends[0]?.keyword.slice(0, 32) || '…'})` : ''}
                </option>
                {(scene ? scene.rundown.countries : []).map(c => (
                  <optgroup key={c.code} label={`${c.code} — ${c.name} (top ${c.stories.length} by volume)`}>
                    {c.stories.map(s => (
                      <option key={`${c.code}:${s.keyword}`} value={s.keyword}>
                        #{s.rank} {s.keyword.slice(0, 56)} ({s.traffic})
                      </option>
                    ))}
                  </optgroup>
                ))}
              </select>
              <span className="text-[10px] text-slate-500">
                {topicKeyword
                  ? 'Pinned story — rotation pauses for this broadcast (photo wall + straps stay on it).'
                  : `Auto-rotation cycles every story (~${scene?.rundown.rotateSec || 45}s each, 5 per country) — photo wall, flag, country and straps follow live.`}
              </span>
            </label>
          </div>

          {/* YouTube-side ingest verdict */}
          <div className="p-4 rounded-2xl bg-slate-900/80 border border-slate-800 space-y-2.5">
            <div className="flex items-center justify-between gap-2">
              <h3 className="text-xs font-black uppercase tracking-widest text-slate-300 flex items-center gap-2">
                <Radio className="w-4 h-4 text-emerald-400" />
                Is YouTube receiving?
              </h3>
              <button
                onClick={checkIngest}
                disabled={ingestBusy}
                className="px-3 py-1.5 rounded-lg bg-slate-800 hover:bg-slate-700 text-slate-200 text-[11px] font-bold transition-colors disabled:opacity-50"
              >
                {ingestBusy ? 'Checking…' : 'Check YouTube'}
              </button>
            </div>
            <p className="text-[11px] text-slate-500 leading-relaxed">
              Asks YouTube's own API about your channel's streams (health + whether your saved key matches a real stream). Needs your YouTube account connected in Settings.
            </p>
            {ingestError && (
              <div className="p-2.5 rounded-xl bg-red-950/60 border border-red-500/40 text-red-300 text-xs font-semibold">
                {ingestError}
              </div>
            )}
            {ingest && (
              <div className="space-y-1.5">
                {ingest.streams.length === 0 && (
                  <p className="text-xs text-amber-300 font-semibold">{ingest.note}</p>
                )}
                {ingest.streams.map(s => (
                  <div key={s.id} className="flex items-center gap-2 rounded-xl bg-slate-950 border border-slate-800 px-3 py-2">
                    <span className={`w-2 h-2 rounded-full shrink-0 ${s.healthStatus === 'good' ? 'bg-emerald-400' : s.healthStatus === 'noData' ? 'bg-red-500' : 'bg-amber-400'}`} />
                    <div className="min-w-0 flex-1">
                      <div className="truncate text-xs font-bold text-white">{s.title}</div>
                      <div className="text-[10px] font-mono text-slate-500">
                        health: {s.healthStatus} • status: {s.streamStatus} • key {s.streamNameSuffix}
                        {s.matchesSavedKey ? ' • MATCHES your saved key ✓' : ' • does NOT match your saved key'}
                      </div>
                    </div>
                  </div>
                ))}
                {ingest.streams.length > 0 && (
                  <p className="text-[10px] text-slate-500 leading-relaxed">{ingest.note}</p>
                )}
              </div>
            )}
          </div>

          {/* Guide */}
          <div className="p-4 rounded-2xl bg-slate-900/80 border border-slate-800 space-y-2.5">
            <h3 className="text-xs font-black uppercase tracking-widest text-slate-300 flex items-center gap-2">
              <Info className="w-4 h-4 text-sky-400" />
              How to go live
            </h3>
            <ol className="text-xs text-slate-300 space-y-1.5 list-decimal list-inside leading-relaxed">
              <li>Open <b>YouTube Studio → Create → Go live → Stream</b> and copy your <b>Stream key</b>.</li>
              <li>Paste the key above <b>once</b> (it stays saved to your account), pick Auto-rotation or a story and the canvas (vertical 9:16 default), press <b>Go Live</b>.</li>
              <li>Wait ~30s, then check YouTube Studio — preview appears, press <b>Go Live</b> there too.</li>
              <li>When done, press <b>End Stream</b> here <i>and</i> End Stream in Studio.</li>
            </ol>
            <div className="pt-1 border-t border-slate-800">
              <p className="text-xs font-bold text-slate-300 flex items-center gap-1.5">
                <Monitor className="w-3.5 h-3.5 text-emerald-400" />
                Prefer OBS? Use the broadcast page as a Browser Source:
              </p>
              <div className="mt-1.5 flex items-center gap-1.5">
                <code className="flex-1 min-w-0 truncate px-2 py-1.5 rounded-lg bg-slate-950 border border-slate-700 text-[10px] font-mono text-emerald-300" dir="ltr">
                  {sceneUrl}
                </code>
                <button onClick={copySceneUrl} className="p-2 rounded-lg bg-slate-800 hover:bg-slate-700 text-slate-300 transition-colors" title="Copy scene URL">
                  {copied ? <Check className="w-4 h-4 text-emerald-400" /> : <Copy className="w-4 h-4" />}
                </button>
              </div>
            </div>
          </div>

          {/* Engine log */}
          {status && status.logTail.length > 0 && (
            <details className="p-4 rounded-2xl bg-slate-900/80 border border-slate-800">
              <summary className="text-xs font-black uppercase tracking-widest text-slate-400 cursor-pointer">
                Engine log
              </summary>
              <pre className="mt-2 max-h-40 overflow-auto text-[10px] font-mono text-slate-400 whitespace-pre-wrap" dir="ltr">
                {status.logTail.join('\n')}
              </pre>
            </details>
          )}
        </div>

        {/* ── Live preview ────────────────────────────────────── */}
        <div className="lg:col-span-3 space-y-2">
          <div className="flex items-center justify-between">
            <h3 className="text-xs font-black uppercase tracking-widest text-slate-300">
              On-air preview <span className="text-slate-500 font-mono normal-case">— this page is what streams</span>
            </h3>
            <a
              href={sceneUrl}
              target="_blank"
              rel="noreferrer"
              className="px-2.5 py-1.5 rounded-lg bg-slate-800 hover:bg-slate-700 text-slate-300 text-[11px] font-bold transition-colors"
            >
              Open fullscreen ↗
            </a>
          </div>
          {orientation === 'vertical' ? (
            <LiveNewsSceneVertical key={topicKeyword} data={previewData} autoRotate={!scene} />
          ) : (
            <LiveNewsScene key={topicKeyword} data={previewData} autoRotate={!scene} />
          )}
          <p className="text-[11px] text-slate-500 leading-relaxed">
            The server renders the same news photo, headline, question and source straps into the RTMP
            signal in real time — the video YouTube receives is generated live, not a pre-made upload.
            The fullscreen page above auto-rotates the top stories and refreshes every 30 seconds.
          </p>
        </div>
      </div>
    </div>
  );
};
