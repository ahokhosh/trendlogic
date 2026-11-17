import React, { useEffect, useState } from 'react';
import { Instagram, Plus, RefreshCw, Trash2, ExternalLink, Youtube, Clock, CheckCircle2, XCircle, Pause, Play, Radio } from 'lucide-react';
import { IgWatch, IgPost } from '../types';
import { sanitizeMultiline, sanitizeSingleLine } from '@/shared/text';

const INTERVALS = [
  { v: 1, label: 'Every hour' },
  { v: 6, label: 'Every 6 hours' },
  { v: 12, label: 'Every 12 hours' },
  { v: 24, label: 'Daily' },
  { v: 48, label: 'Every 2 days' },
  { v: 168, label: 'Weekly' }
];

/** Minimum timer step: 5 minutes — anything faster hammers IG/YT quotas. */
const MIN_INTERVAL_HOURS = 4;
const MAX_INTERVAL_HOURS = 168;

function splitInterval(totalHours: number): { h: number; m: number } {
  const totalMin = Math.round(Number(totalHours || 0) * 60);
  return { h: Math.floor(totalMin / 60), m: totalMin % 60 };
}

function joinInterval(h: number, m: number): number {
  const hh = Math.min(MAX_INTERVAL_HOURS, Math.max(0, Math.floor(Number(h) || 0)));
  const mm = Math.min(59, Math.max(0, Math.floor(Number(m) || 0)));
  const total = hh + mm / 60;
  return Math.round(total * 10000) / 10000;
}

function formatInterval(hours: number): string {
  const hit = INTERVALS.find(o => Math.abs(o.v - hours) < 1e-9);
  if (hit) return hit.label;
  const { h, m } = splitInterval(hours);
  if (h === 0 && m === 0) return '—';
  if (h === 0) return `Every ${m}m`;
  if (m === 0) return `Every ${h}h`;
  return `Every ${h}h ${m}m`;
}

/** Per-watch private timer editor: hours + minutes, free typing while
 *  focused and committed on blur/Enter. Out-of-range values revert so the
 *  display never disagrees with the persisted timer. */
const WatchIntervalEditor: React.FC<{ watchId: string; intervalHours: number; onSave: (h: number) => void }> = ({ intervalHours, onSave }) => {
  const split = splitInterval(intervalHours);
  // Raw text while editing so the field can be cleared / set to 0 freely —
  // validity is decided only on commit, not on every keystroke.
  const [h, setH] = useState(String(split.h));
  const [m, setM] = useState(String(split.m));
  const [editing, setEditing] = useState(false);
  useEffect(() => {
    if (!editing) {
      const s = splitInterval(intervalHours);
      setH(String(s.h)); setM(String(s.m));
    }
  }, [intervalHours, editing]);
  const commit = () => {
    setEditing(false);
    let total = joinInterval(Number(h) || 0, Number(m) || 0);
    if (total <= 0 || total > MAX_INTERVAL_HOURS) {
      const s = splitInterval(intervalHours);
      setH(String(s.h)); setM(String(s.m));
      return;
    }
    // Below minimum (e.g. staging 0h while minutes are still low): clamp up
    // to the minimum instead of reverting, so 0h stays and the user can then
    // raise the minutes (e.g. 0:10).
    if (total < MIN_INTERVAL_HOURS) total = MIN_INTERVAL_HOURS;
    if (Math.abs(total - intervalHours) > 1e-9) {
      onSave(total);
    } else {
      const s = splitInterval(total);
      setH(String(s.h)); setM(String(s.m));
    }
  };
  const cancel = () => {
    const s = splitInterval(intervalHours);
    setH(String(s.h)); setM(String(s.m));
    setEditing(false);
  };
  return (
    <div className="flex items-center gap-2 px-3 py-2 rounded-xl bg-slate-800 border border-slate-700 text-slate-200 text-sm font-semibold" title="Private timer for this profile only — hours + minutes (at least 4 hours, up to 7 days), saved on blur/Enter, survives redeploys">
      <Clock className="w-4 h-4 text-pink-400" />
      <input
        type="number" min={4} max={168} value={h}
        onFocus={() => setEditing(true)}
        onChange={e => { setEditing(true); setH(e.target.value); }}
        onBlur={commit}
        onKeyDown={e => { if (e.key === 'Enter') (e.target as HTMLInputElement).blur(); if (e.key === 'Escape') cancel(); }}
        className="w-16 px-2 py-1 rounded-lg bg-slate-950 border border-slate-700 text-slate-100 text-sm font-bold outline-none focus:border-pink-500"
        dir="ltr"
      />
      <span className="text-slate-400 font-bold">h</span>
      <input
        type="number" min={0} max={59} step={5} value={m}
        onFocus={() => setEditing(true)}
        onChange={e => { setEditing(true); setM(e.target.value); }}
        onBlur={commit}
        onKeyDown={e => { if (e.key === 'Enter') (e.target as HTMLInputElement).blur(); if (e.key === 'Escape') cancel(); }}
        className="w-16 px-2 py-1 rounded-lg bg-slate-950 border border-slate-700 text-slate-100 text-sm font-bold outline-none focus:border-pink-500"
        dir="ltr"
      />
      <span className="text-slate-400 font-bold">m</span>
    </div>
  );
};

/** Per-profile custom hashtags editor: chips + input, commits to server on add/remove. */
const HashtagsEditor: React.FC<{ tags: string[]; onSave: (tags: string[]) => void }> = ({ tags, onSave }) => {
  const list = Array.isArray(tags) ? tags : [];
  const [draft, setDraft] = useState('');
  const add = () => {
    const parts = draft.split(/[\s,]+/).map(s => s.trim()).filter(Boolean);
    if (parts.length === 0) return;
    const next = [...list];
    for (const p of parts) {
      const norm = p.startsWith('#') ? p : `#${p}`;
      if (!next.includes(norm)) next.push(norm);
    }
    onSave(next);
    setDraft('');
  };
  const remove = (t: string) => onSave(list.filter(x => x !== t));
  return (
    <div className="flex flex-wrap items-center gap-2 px-3 py-2 rounded-xl bg-slate-800 border border-slate-700 text-slate-200 text-sm font-semibold" title="Custom hashtags appended to the YouTube description when publishing reels for this profile.">
      <span className="text-pink-400 font-bold">#</span>
      {list.map(t => (
        <span key={t} className="flex items-center gap-1 px-2 py-1 rounded-lg bg-pink-500/15 border border-pink-500/30 text-pink-200 font-mono font-bold" dir="ltr">
          {t}
          <button onClick={() => remove(t)} className="text-pink-400/70 hover:text-red-400 font-black leading-none" title="Remove this hashtag">×</button>
        </span>
      ))}
      <input
        type="text"
        value={draft}
        onChange={e => setDraft(e.target.value)}
        onKeyDown={e => { if (e.key === 'Enter') add(); }}
        placeholder="#tag"
        className="px-2 py-1 rounded-lg bg-slate-950 border border-slate-700 text-slate-100 text-sm font-bold outline-none focus:border-pink-500 w-24"
        dir="ltr"
      />
      <button onClick={add} className="px-3 py-1 rounded-lg bg-pink-600/80 hover:bg-pink-500 text-white text-sm font-bold" title="Add hashtag(s)">
        + Add
      </button>
    </div>
  );
};

const browserTimeZone = (): string => {
  try {
    return Intl.DateTimeFormat().resolvedOptions().timeZone || 'UTC';
  } catch {
    return 'UTC';
  }
};

/** Exact-times-per-day editor: pick HH:MM, Add; chips with × to remove.
 *  Commits to the server immediately on add/remove. An empty list means
 *  classic interval mode. Stored per watch in the DB — deploy-proof. */
const DailyTimesEditor: React.FC<{ times: string[]; timeZone: string; onSave: (times: string[]) => void }> = ({ times, timeZone, onSave }) => {
  const list = Array.isArray(times) ? times : [];
  const [draft, setDraft] = useState('08:00');
  const add = () => {
    const m = /^(\d{1,2}):(\d{2})$/.exec(draft.trim());
    if (!m || Number(m[1]) > 23 || Number(m[2]) > 59) return;
    const norm = `${String(Number(m[1])).padStart(2, '0')}:${m[2]}`;
    if (list.includes(norm) || list.length >= 24) return;
    onSave([...list, norm].sort());
    setDraft(norm);
  };
  const remove = (t: string) => onSave(list.filter(x => x !== t));
  return (
    <div className="flex flex-wrap items-center gap-2 px-3 py-2 rounded-xl bg-slate-800 border border-slate-700 text-slate-200 text-sm font-semibold" title="Exact daily firing times for this profile (e.g. 08:00 and 14:00). When ≥1 is set, exact times REPLACE the rolling interval. Stored in the database — survives redeploys.">
      <Clock className="w-4 h-4 text-amber-400" />
      {list.map(t => (
        <span key={t} className="flex items-center gap-1 px-2 py-1 rounded-lg bg-amber-500/15 border border-amber-500/30 text-amber-200 font-mono font-bold" dir="ltr">
          {t}
          <button onClick={() => remove(t)} className="text-amber-400/70 hover:text-red-400 font-black leading-none" title="Remove this time">×</button>
        </span>
      ))}
      <input
        type="time" value={draft}
        onChange={e => setDraft(e.target.value)}
        onKeyDown={e => { if (e.key === 'Enter') add(); }}
        className="px-2 py-1 rounded-lg bg-slate-950 border border-slate-700 text-slate-100 text-sm font-bold outline-none focus:border-amber-500"
        dir="ltr"
      />
      <button onClick={add} className="px-3 py-1 rounded-lg bg-amber-600/80 hover:bg-amber-500 text-white text-sm font-bold" title="Add this exact time">
        + Add
      </button>
      <span className="text-slate-500 hidden sm:inline">• {timeZone || 'UTC'}</span>
    </div>
  );
};

export const InstagramRepostView: React.FC<{ onBuyCredit?: () => void }> = ({ onBuyCredit }) => {
  const [watches, setWatches] = useState<IgWatch[]>([]);
  const [posts, setPosts] = useState<Record<string, IgPost[]>>({});
  const [profileUrl, setProfileUrl] = useState('');
  const [newHours, setNewHours] = useState(24);
  const [newMins, setNewMins] = useState(0);
  const intervalHours = joinInterval(newHours, newMins);
  const [newTimes, setNewTimes] = useState<string[]>([]);
  const [newHashtags, setNewHashtags] = useState('');
  // Hardcoded publishing defaults (no UI): auto-publish ON, public.
  const autoPublish = true;
  const privacy = 'public' as const;
  const [loading, setLoading] = useState(false);
  const [checking, setChecking] = useState<string | null>(null);
  const [publishing, setPublishing] = useState<string | null>(null);
  const [error, setError] = useState<string | null>(null);
  const [quotaBytes, setQuotaBytes] = useState<number>(0);
  useEffect(() => { fetch('/api/uploads/quota').then(r => r.ok ? r.json() : null).then(d => { if (d) setQuotaBytes(Number(d.quota_bytes || 0)); }).catch(() => {}); }, []);
  const [notice, setNotice] = useState<string | null>(null);
  const [expanded, setExpanded] = useState<string | null>(null);
  // IG-to-Live loop state (one global loop — polled so every card shows the
  // truthful on-air badge even when another profile owns the push).
  const [igLive, setIgLive] = useState<{
    active: boolean; mode: string; watchId: string | null; username: string | null;
    shortcode: string | null; startedAt: string | null; mine: boolean;
    frames: number; lastFrameAt: string | null; fileSize: number; videoExit: string | null;
  } | null>(null);
  const [liveBusy, setLiveBusy] = useState<string | null>(null);
  // Latest-reels preview for the typed profile URL (anonymous listing +
  // web-search fallback — mirrors the check pipeline).
  const [latestItems, setLatestItems] = useState<{ shortcode: string; url: string; title: string }[]>([]);
  const [latestSource, setLatestSource] = useState<string | null>(null);
  const [latestLoading, setLatestLoading] = useState(false);
  // Rapid Discovery: real reel previews (direct MP4, no download yet) with
  // multi-select. The selection is combined server-side into ONE vertical
  // MP4 and pushed to YouTube Live (see combineSelected / mixGoLive).
  interface RapidItem {
    shortcode: string; url: string; caption: string; thumbnail: string;
    previewUrl: string; playCount: number; likeCount: number;
    commentCount: number; durationSec: number; takenAt: string | null;
    username: string; hasAudio: boolean;
  }
  const [discItems, setDiscItems] = useState<RapidItem[]>([]);
  const [discNext, setDiscNext] = useState<string | null>(null);
  const [discMore, setDiscMore] = useState(false);
  const [discLoading, setDiscLoading] = useState(false);
  const [discUser, setDiscUser] = useState('');
  const [discWinner, setDiscWinner] = useState<string | null>(null);
  const [selected, setSelected] = useState<string[]>([]);
  const [mixBusy, setMixBusy] = useState(false);
  const [mixLiveBusy, setMixLiveBusy] = useState(false);
  const [mixResult, setMixResult] = useState<{ filename: string; url: string; count: number; sizeBytes: number } | null>(null);
  // Async mix job (POST returns instantly, progress via polling — a 10-clip
  // mix takes minutes, no browser keeps one request open that long).
  const [mixJob, setMixJob] = useState<{ id: string; step: string; done: number; total: number; status: string } | null>(null);

  useEffect(() => {
    if (!mixJob || (mixJob.status !== 'queued' && mixJob.status !== 'running')) return;
    const t = setInterval(async () => {
      try {
        const r = await fetch(`/api/instagram/mix-status/${mixJob.id}`);
        const d = await r.json().catch(() => null);
        if (!r.ok) {
          setError(d?.error || 'Mix job lost — just retry.');
          setMixJob(null); setMixBusy(false); setMixLiveBusy(false);
          return;
        }
        const j = d?.job;
        if (!j) return;
        setMixJob({ id: j.id, step: j.step, done: j.done, total: j.total, status: j.status });
        if (j.status === 'done') {
          const wasLive = j.mode === 'live';
          if (j.result) setMixResult({ filename: j.result.filename, url: j.result.url, count: j.result.count, sizeBytes: j.result.sizeBytes });
          if (j.live) setIgLive(j.live);
          if (wasLive) {
            await fetchWatches();
            setNotice(`LIVE — your ${j.result?.count ?? ''}-reel mix is looping on YouTube Live as one video. It repeats until you stop it.`);
          } else {
            setNotice(`Combined ${j.result?.count ?? ''} reel(s) into one video (${(((j.result?.sizeBytes || 0)) / 1048576).toFixed(1)} MB) — preview it below, then send it to Live.`);
          }
          setMixBusy(false); setMixLiveBusy(false);
        } else if (j.status === 'failed') {
          setError(j.error || 'Mix failed — re-run Discovery (preview links expire) and retry with fewer reels.');
          setMixBusy(false); setMixLiveBusy(false);
        }
      } catch { /* keep polling — transient network blip */ }
    }, 3000);
    return () => clearInterval(t);
  }, [mixJob]);

  const refreshItems = async (id: string) => {
    try {
      const items = await fetch(`/api/ig-watch/${id}/items`).then(rr => rr.json()).catch(() => null);
      if (items?.items) setPosts(prev => ({ ...prev, [id]: items.items }));
    } catch { /* silent */ }
  };

  const fetchWatches = async () => {
    try {
      const r = await fetch('/api/ig-watch');
      if (!r.ok) return;
      const d = await r.json();
      if (d?.watches) {
        setWatches(d.watches);
        for (const w of d.watches as IgWatch[]) {
          if (!posts[w.id]) {
            fetch(`/api/ig-watch/${w.id}/items`).then(rr => rr.ok ? rr.json() : null).then(dd => {
              if (dd?.items) setPosts(prev => ({ ...prev, [w.id]: dd.items }));
            }).catch(() => {});
          }
        }
      }
    } catch { /* silent */ }
  };

  useEffect(() => { fetchWatches(); fetchIgLive(); }, []);

  const fetchIgLive = async () => {
    try {
      const r = await fetch('/api/ig-live/status');
      if (!r.ok) return;
      const d = await r.json();
      if (d?.live) setIgLive(d.live);
    } catch { /* badge keeps last state */ }
  };

  useEffect(() => {
    const t = setInterval(fetchIgLive, 10000);
    return () => clearInterval(t);
  }, []);

  const loadLatest = async () => {
    if (!profileUrl.trim()) { setError('Enter an Instagram profile link first.'); return; }
    setLatestLoading(true); setError(null);
    try {
      const r = await fetch(`/api/instagram/latest?profileUrl=${encodeURIComponent(profileUrl.trim())}&limit=6`);
      const d = await r.json();
      if (!r.ok) { setError(d?.error || 'Could not load latest reels.'); return; }
      setLatestItems(Array.isArray(d?.items) ? d.items : []);
      setLatestSource(d?.source || null);
      if ((d?.items || []).length === 0) setNotice('No reels found for this profile yet — it may be private or rate-limited.');
    } catch { setError('Network error.'); } finally { setLatestLoading(false); }
  };

  // Rapid Discovery: fetch real reel previews (playable MP4s, no download).
  // `more` appends the next page via the API's pagination cursor.
  const discoverRapid = async (more = false) => {
    if (!profileUrl.trim()) { setError('Enter an Instagram profile link first.'); return; }
    setDiscLoading(true); setError(null); setNotice(null);
    try {
      const qs = new URLSearchParams({
        profileUrl: profileUrl.trim(), limit: '12',
        ...(more && discNext ? { paginationId: discNext } : {})
      });
      const r = await fetch(`/api/instagram/discover?${qs.toString()}`);
      const d = await r.json();
      if (!r.ok) { setError(d?.error || 'Discovery failed.'); return; }
      const got: RapidItem[] = Array.isArray(d?.items) ? d.items : [];
      setDiscItems(prev => more ? [...prev, ...got.filter(g => !prev.some(p => p.shortcode === g.shortcode))] : got);
      setDiscNext(d?.nextMaxId || null);
      setDiscMore(!!d?.moreAvailable);
      setDiscUser(d?.username || '');
      // Winner-first order comes from the backend (most views first);
      // remember the winner shortcode so the 🏆 badge survives "Load more".
      if (!more) setDiscWinner(typeof d?.winnerShortcode === 'string' && d.winnerShortcode ? d.winnerShortcode : (got[0]?.shortcode || null));
      else if (!discWinner && got.length > 0) setDiscWinner(got[0].shortcode);
      if (!more) { setSelected([]); setMixResult(null); }
      if (got.length === 0) setNotice('No reels returned — the profile may be private or the API quota hit.');
      else setNotice(`Discovery: ${got.length} reel preview(s) — 🏆 marks the winning reel (most views), which auto-publish picks first. Tick the ones you want, then combine into one video for Live. Nothing downloaded yet.`);
    } catch { setError('Network error.'); } finally { setDiscLoading(false); }
  };

  const toggleSelect = (code: string) => {
    setSelected(prev => prev.includes(code) ? prev.filter(c => c !== code) : [...prev, code].slice(0, 10));
  };

  const selectedItems = discItems.filter(it => selected.includes(it.shortcode));

  // Combine the ticked previews into ONE vertical MP4 (server downloads the
  // preview MP4s directly + ffmpeg-joins them). Async: POST returns a jobId
  // instantly, the poller above tracks progress (minutes for big mixes).
  const combineSelected = async () => {
    if (selectedItems.length === 0) { setError('Tick at least 1 reel preview first.'); return; }
    setMixBusy(true); setMixLiveBusy(false); setError(null); setNotice(null);
    setMixJob(null); setMixResult(null);
    try {
      const r = await fetch('/api/instagram/mix', {
        method: 'POST', headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify({ items: selectedItems.map(it => ({ shortcode: it.shortcode, previewUrl: it.previewUrl })), username: discUser })
      });
      const d = await r.json();
      if (!r.ok || !d?.jobId) { setError(d?.error || 'Combine failed.'); setMixBusy(false); return; }
      setMixJob({ id: d.jobId, step: 'Queued — waiting for the video lane…', done: 0, total: 1, status: 'queued' });
      setNotice('Mix queued — you can keep using the app, progress shows below. No need to keep this request waiting.');
    } catch { setError('Network error.'); setMixBusy(false); }
  };

  // One click: combine + loop the compilation on YouTube Live (needs the
  // stream key saved in the Live tab — same rule as profile Go Live).
  // Async like combine (see above) — going live lands via the poller.
  const mixGoLive = async () => {
    if (selectedItems.length === 0) { setError('Tick at least 1 reel preview first.'); return; }
    setMixLiveBusy(true); setMixBusy(false); setError(null); setNotice(null);
    setMixJob(null);
    try {
      const r = await fetch('/api/instagram/mix-go-live', {
        method: 'POST', headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify({ items: selectedItems.map(it => ({ shortcode: it.shortcode, previewUrl: it.previewUrl })), username: discUser })
      });
      const d = await r.json();
      if (!r.ok || !d?.jobId) { setError(d?.error || 'Mix Go Live failed.'); setMixLiveBusy(false); return; }
      setMixJob({ id: d.jobId, step: 'Queued — waiting for the video lane…', done: 0, total: 1, status: 'queued' });
      setNotice('Mix + Live queued — combining first (minutes), then it goes live automatically. Progress below.');
    } catch { setError('Mix Go Live failed.'); setMixLiveBusy(false); }
  };

  const addWatch = async () => {
    if (quotaBytes <= 0) { setError('Buy credit to enable timer.'); onBuyCredit?.(); return; }
    if (!profileUrl.trim()) { setError('Enter an Instagram profile link.'); return; }
    if (intervalHours < MIN_INTERVAL_HOURS || intervalHours > MAX_INTERVAL_HOURS) {
      setError(`Timer must be at least 4 hours (up to 7 days) — shorter intervals can look suspicious to YouTube (you set ${formatInterval(intervalHours)}).`);
      return;
    }
    setLoading(true); setError(null);
    try {
      const r = await fetch('/api/ig-watch', {
        method: 'POST', headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify({ profileUrl: profileUrl.trim(), intervalHours, autoPublish, privacyStatus: privacy, dailyTimes: newTimes, dailyTz: browserTimeZone(), hashtags: newHashtags })
      });
      const d = await r.json();
      if (!r.ok) { setError(d?.error || 'Failed to add profile.'); return; }
       setProfileUrl('');
       setNewTimes([]);
       setNewHashtags('');
       await fetchWatches();
    } catch { setError('Network error.'); } finally { setLoading(false); }
  };

  const patchWatch = async (id: string, patch: any) => {
    if ((patch?.intervalHours !== undefined || patch?.intervalMinutes !== undefined) && quotaBytes <= 0) { setError('Buy credit to enable timer.'); onBuyCredit?.(); return; }
    try {
      const r = await fetch(`/api/ig-watch/${id}`, {
        method: 'PUT', headers: { 'Content-Type': 'application/json' }, body: JSON.stringify(patch)
      });
      if (r.ok) {
        const d = await r.json();
        if (d?.watch) setWatches(prev => prev.map(w => w.id === id ? d.watch : w));
      } else {
        // Timer change rejected — resync from the server so the display
        // never shows a timer value that isn't actually armed.
        const d = await r.json().catch(() => null);
        setError(d?.error || 'Timer save failed on the server — value reverted.');
        await fetchWatches();
      }
    } catch {
      setError('Timer save failed (network) — value reverted.');
      await fetchWatches();
    }
  };

  const removeWatch = async (id: string) => {
    if (!confirm('Remove this profile from the watch list?')) return;
    await fetch(`/api/ig-watch/${id}`, { method: 'DELETE' });
    setWatches(prev => prev.filter(w => w.id !== id));
  };

  // Server calls can wait behind the queue (live-hold, downloads, uploads)
  // for minutes — never leave a button stuck forever: abort and report.
  const fetchWithTimeout = async (url: string, opts: RequestInit, ms: number): Promise<Response> => {
    const c = new AbortController();
    const t = setTimeout(() => c.abort(), ms);
    try {
      return await fetch(url, { ...opts, signal: c.signal });
    } finally {
      clearTimeout(t);
    }
  };
  const timeoutMessage = (err: unknown, fallback: string): string => {
    if (err instanceof DOMException && err.name === 'AbortError') {
      return 'Request timed out — the server is still working (queue/live-hold). Try again in a minute.';
    }
    return fallback;
  };

  const checkNow = async (id: string) => {
    setChecking(id); setError(null); setNotice(null);
    try {
      const r = await fetchWithTimeout(`/api/ig-watch/${id}/check`, { method: 'POST' }, 3 * 60 * 1000);
      const d = await r.json();
      if (!r.ok) { setError(d?.error || 'Check failed.'); return; }
      await refreshItems(id);
      await fetchWatches();
      const via = d?.source === 'web-search-fresh'
        ? 'via fresh web search'
        : d?.source === 'instagram-anon'
          ? 'via anonymous profile listing'
          : 'directly from the Instagram profile';
      const win = d?.winnerShortcode ? ` 🏆 Winner: ${d.winnerShortcode} (${Number(d?.winnerPlayCount || 0).toLocaleString()} views) — publishes first.` : '';
      setNotice(`Check done: ${d?.discovered ?? 0} new reel(s) discovered ${via}.${win}`);
    } catch (err) { setError(timeoutMessage(err, 'Check failed.')); } finally { setChecking(null); }
  };

  const goLive = async (id: string) => {
    setLiveBusy(id); setError(null); setNotice(null);
    try {
      const r = await fetch(`/api/ig-watch/${id}/go-live`, { method: 'POST' });
      const d = await r.json();
      if (!r.ok) { setError(d?.error || 'Go Live failed.'); return; }
      if (d?.live) setIgLive(d.live);
      await fetchWatches();
      setNotice('LIVE — the newest reel is looping on your YouTube Live. It repeats until the timer picks up a newer reel, which swaps in seamlessly (the live never disconnects).');
    } catch { setError('Go Live failed.'); } finally { setLiveBusy(null); }
  };

  const stopLive = async (id: string) => {
    setLiveBusy(id); setError(null); setNotice(null);
    try {
      const r = await fetch(`/api/ig-watch/${id}/live`, { method: 'DELETE' });
      const d = await r.json();
      if (!r.ok) { setError(d?.error || 'Stop live failed.'); return; }
      if (d?.live) setIgLive(d.live);
      await fetchWatches();
      setNotice('Reel loop stopped and disarmed — the push is off air.');
    } catch { setError('Stop live failed.'); } finally { setLiveBusy(null); }
  };

  const publishItems = async (id: string, shortcode?: string) => {
    setPublishing(shortcode ? `${id}:${shortcode}` : id); setError(null); setNotice(null);
    try {
      const r = await fetchWithTimeout(`/api/ig-watch/${id}/publish`, {
        method: 'POST', headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify(shortcode ? { shortcode } : {})
      }, 8 * 60 * 1000);
      const d = await r.json();
      if (!r.ok) { setError(d?.error || 'Publish failed.'); return; }
      await refreshItems(id);
      await fetchWatches();
      setNotice(`Publish done: ${d?.published ?? 0} published, ${d?.failed ?? 0} failed.`);
    } catch (err) { setError(timeoutMessage(err, 'Publish failed.')); } finally { setPublishing(null); }
  };

  return (
    <div className="space-y-5">
      <div className="p-5 rounded-3xl bg-gradient-to-l from-pink-950/60 via-slate-900 to-slate-900 border border-pink-800/30">
        <div className="flex items-center gap-2.5">
          <div className="w-11 h-11 shrink-0 rounded-2xl bg-gradient-to-br from-pink-500 via-rose-500 to-amber-500 flex items-center justify-center shadow-lg shadow-pink-500/30">
            <Instagram className="w-6 h-6 text-white" />
          </div>
          <div>
            <h1 className="text-base font-black text-white">Instagram Profile Scraper to YouTube</h1>
            <p className="text-[11px] text-slate-400 mt-0.5">Add a profile link — Check discovers reel info only (no download). When the timer fires, the 🏆 winning reel (most views among unpublished) is auto-published to your YouTube channel first. No duplicates, original caption preserved.</p>
          </div>
        </div>
        <div className="grid sm:grid-cols-[1fr_auto] gap-2.5 mt-4">
          <input
            value={profileUrl}
            onChange={e => setProfileUrl(e.target.value)}
            placeholder="https://www.instagram.com/username/"
            dir="ltr"
            className="px-3.5 py-2.5 rounded-xl bg-slate-950 border border-slate-700 text-slate-100 text-sm outline-none focus:border-pink-500 placeholder:text-slate-600"
          />
          <button
            onClick={addWatch}
            disabled={loading}
            className="px-4 py-2.5 rounded-xl bg-gradient-to-r from-pink-600 to-rose-600 hover:brightness-110 text-white text-sm font-bold flex items-center gap-1.5 disabled:opacity-50"
          >
            <Plus className="w-4 h-4" /> {loading ? 'Adding...' : 'Add profile'}
          </button>
        </div>
        {(latestItems.length > 0 || latestSource) && (
          <div className="mt-3 p-3 rounded-2xl bg-slate-950/70 border border-slate-800">
            <div className="flex items-center gap-2 flex-wrap text-[11px] font-bold">
              <span className="text-slate-300">Latest reels preview</span>
              {latestSource && (
                <span className="px-1.5 py-0.5 rounded font-mono bg-slate-700/60 text-slate-300" dir="ltr">
                  {latestSource}
                </span>
              )}
            </div>
            <div className="mt-2 space-y-1.5">
              {latestItems.map(it => (
                <div key={it.shortcode} className="flex items-center gap-2 text-[11px]">
                  <a href={it.url} target="_blank" rel="noreferrer" className="text-pink-300 hover:underline font-mono" dir="ltr">{it.shortcode}</a>
                  <span className="text-slate-500 truncate" dir="auto">{sanitizeSingleLine(it.title) || '—'}</span>
                </div>
              ))}
              {latestItems.length === 0 && <div className="text-[11px] text-slate-500">No reels found — try again later.</div>}
            </div>
          </div>
        )}
        {/* ⚡ Rapid Discovery: real previews (video, no download) + multi-select
            -> combine into ONE video -> YouTube Live. Preview links are CDN
            URLs that expire, so combine soon after discovering. */}
        {(discItems.length > 0 || discLoading) && (
          <div className="mt-3 p-3 rounded-2xl bg-slate-950/70 border border-amber-500/30">
            <div className="flex items-center gap-2 flex-wrap text-[11px] font-bold">
              <span className="text-amber-300">⚡ Discovery previews — nothing downloaded yet</span>
              {discUser && <span className="text-slate-400 font-mono" dir="ltr">@{discUser}</span>}
              <span className="px-1.5 py-0.5 rounded bg-amber-600/20 text-amber-300 font-mono" dir="ltr">
                {selected.length} selected
              </span>
              <div className="flex items-center gap-1.5 ml-auto">
                <button onClick={() => setSelected(discItems.map(it => it.shortcode).slice(0, 10))} className="px-2 py-1 rounded-lg bg-slate-800 hover:bg-slate-700 text-slate-200 text-[11px] font-bold">
                  Select all
                </button>
                <button onClick={() => setSelected([])} className="px-2 py-1 rounded-lg bg-slate-800 hover:bg-slate-700 text-slate-400 text-[11px] font-semibold">
                  Clear
                </button>
              </div>
            </div>
            <div className="mt-2 grid sm:grid-cols-2 lg:grid-cols-3 gap-2.5">
              {discItems.map(it => {
                const on = selected.includes(it.shortcode);
                const isWinner = discWinner ? it.shortcode === discWinner : discItems.indexOf(it) === 0;
                return (
                  <div key={it.shortcode} className={`relative rounded-2xl overflow-hidden border ${on ? 'border-amber-400 ring-2 ring-amber-400/40' : isWinner ? 'border-yellow-400/60' : 'border-slate-800'}`}>
                    <label className="absolute top-2 left-2 z-10 flex items-center gap-1.5 px-2 py-1 rounded-lg bg-black/70 text-white text-[11px] font-bold cursor-pointer">
                      <input type="checkbox" checked={on} onChange={() => toggleSelect(it.shortcode)} className="accent-amber-500 w-4 h-4" />
                      {on ? `#${selected.indexOf(it.shortcode) + 1}` : 'Pick'}
                    </label>
                    {isWinner && (
                      <span className="absolute top-2 right-2 z-10 px-2 py-1 rounded-lg bg-yellow-500/90 text-black text-[11px] font-black" title="Winning reel — most views in this discovery window, auto-publish picks it first">
                        🏆 Winner
                      </span>
                    )}
                    {it.previewUrl ? (
                      <video src={it.previewUrl} poster={it.thumbnail || undefined} controls preload="none" playsInline className="w-full aspect-[9/16] bg-black object-contain" />
                    ) : (
                      <div className="w-full aspect-[9/16] bg-slate-900 flex items-center justify-center text-slate-500 text-[11px]">No preview</div>
                    )}
                    <div className="p-2 bg-slate-900/95">
                      <div className="text-[11px] text-slate-200 line-clamp-2 leading-snug" dir="auto">{sanitizeMultiline(it.caption).slice(0, 140) || '—'}</div>
                      <div className="mt-1 flex items-center gap-2 text-[10px] font-mono text-slate-400" dir="ltr">
                        <span>▶ {(it.playCount || 0).toLocaleString()}</span>
                        <span>♥ {(it.likeCount || 0).toLocaleString()}</span>
                        {it.durationSec > 0 && <span>⏱ {it.durationSec}s</span>}
                        <a href={it.url} target="_blank" rel="noreferrer" className="ml-auto text-pink-300 hover:underline">{it.shortcode.slice(0, 10)}</a>
                      </div>
                    </div>
                  </div>
                );
              })}
            </div>
            <div className="mt-2.5 flex flex-wrap items-center gap-2">
              <button
                onClick={combineSelected}
                disabled={mixBusy || mixLiveBusy || selected.length === 0}
                className="px-4 py-2 rounded-xl bg-gradient-to-r from-amber-500 to-orange-600 hover:brightness-110 text-white text-xs font-black disabled:opacity-40"
                title="Download the ticked previews and join them into ONE vertical MP4 (queued — takes minutes, progress below)"
              >
                {mixBusy ? 'Queued…' : `Combine selected (${selected.length}) → one video`}
              </button>
              <button
                onClick={mixGoLive}
                disabled={mixLiveBusy || mixBusy || selected.length === 0}
                className="px-4 py-2 rounded-xl bg-gradient-to-r from-red-600 to-rose-600 hover:brightness-110 text-white text-xs font-black disabled:opacity-40 flex items-center gap-1.5"
                title="Combine + loop the mix on your YouTube Live (queued — combines first, then goes live automatically; needs the stream key saved in the Live tab)"
              >
                <Radio className="w-3.5 h-3.5" />{mixLiveBusy ? 'Queued…' : `Mix + Go Live (${selected.length})`}
              </button>
              {discMore && (
                <button onClick={() => discoverRapid(true)} disabled={discLoading} className="px-3 py-2 rounded-xl bg-slate-800 hover:bg-slate-700 text-slate-200 text-xs font-bold disabled:opacity-50">
                  {discLoading ? 'Loading…' : 'Load more'}
                </button>
              )}
              <span className="text-[10px] text-slate-500">Order = tick order • max 10 • 1080×1920</span>
            </div>
            {/* Async job progress: survives minutes-long mixes (the request
                itself returns instantly, this polls every 3s). */}
            {mixJob && (mixJob.status === 'queued' || mixJob.status === 'running') && (
              <div className="mt-2.5 p-2.5 rounded-2xl bg-slate-900 border border-amber-500/30">
                <div className="text-[11px] font-bold text-amber-200" dir="auto">{mixJob.step}</div>
                <div className="mt-1.5 h-2 rounded-full bg-slate-800 overflow-hidden" dir="ltr">
                  <div
                    className="h-full rounded-full bg-gradient-to-r from-amber-500 to-orange-500 transition-all duration-500"
                    style={{ width: `${Math.min(100, Math.round((mixJob.done / Math.max(1, mixJob.total)) * 100))}%` }}
                  />
                </div>
                <div className="mt-1 text-[10px] font-mono text-slate-500" dir="ltr">
                  step {Math.min(mixJob.done, mixJob.total)}/{mixJob.total} • {mixJob.status} • safe to keep browsing, this keeps running on the server
                </div>
              </div>
            )}
            {mixResult && (
              <div className="mt-2.5 p-2.5 rounded-2xl bg-emerald-950/40 border border-emerald-500/30">
                <div className="text-[11px] font-bold text-emerald-300">
                  Mix ready: {mixResult.count} reel(s) → one video ({((mixResult.sizeBytes || 0) / 1048576).toFixed(1)} MB)
                  <a href={mixResult.url} target="_blank" rel="noreferrer" className="ml-2 underline font-mono" dir="ltr">{mixResult.filename}</a>
                </div>
                <video src={mixResult.url} controls preload="none" playsInline className="mt-2 w-full max-w-[280px] aspect-[9/16] bg-black rounded-xl object-contain" />
              </div>
            )}
          </div>
        )}
        <div className="flex flex-wrap items-center gap-2 mt-3">
          <div className="flex items-center gap-1.5 px-2.5 py-1.5 rounded-lg bg-slate-800 border border-slate-700 text-slate-200 text-xs font-semibold" title="Private timer for this profile — hours + minutes, applies only to your account">
            <Clock className="w-3.5 h-3.5 text-pink-400" />
            <input
              type="number" min={0} max={168} value={newHours}
              onChange={e => setNewHours(Math.min(168, Math.max(0, Number(e.target.value) || 0)))}
              className="w-14 px-1.5 py-0.5 rounded bg-slate-950 border border-slate-700 text-slate-100 text-xs font-bold outline-none focus:border-pink-500"
              dir="ltr"
            />
            <span className="text-slate-400">h</span>
            <input
              type="number" min={0} max={59} step={5} value={newMins}
              onChange={e => setNewMins(Math.min(59, Math.max(0, Number(e.target.value) || 0)))}
              className="w-14 px-1.5 py-0.5 rounded bg-slate-950 border border-slate-700 text-slate-100 text-xs font-bold outline-none focus:border-pink-500"
              dir="ltr"
            />
            <span className="text-slate-400">m</span>
            <span className="text-slate-400 hidden sm:inline">• {formatInterval(intervalHours)}</span>
          </div>
          <DailyTimesEditor times={newTimes} timeZone={browserTimeZone()} onSave={setNewTimes} />
          <input
            value={newHashtags}
            onChange={e => setNewHashtags(e.target.value)}
            placeholder="Custom hashtags for this profile (e.g. #fun #travel) — added to YouTube description"
            dir="ltr"
            className="px-3 py-2 rounded-xl bg-slate-950 border border-slate-700 text-slate-100 text-xs outline-none focus:border-pink-500 placeholder:text-slate-600 flex-1 min-w-[200px]"
          />
          {newTimes.length > 0 && (
            <span className="text-[11px] text-amber-300/90 font-semibold">⏰ Exact mode: fires {newTimes.join(', ')} daily — rolling interval paused.</span>
          )}
        </div>
        {error && <div className="text-xs text-red-400 font-semibold mt-2">{error}</div>}
        {notice && <div className="text-xs text-emerald-300 font-semibold mt-2">{notice}</div>}
        <details className="mt-3 text-[11px] text-slate-500">
          <summary className="cursor-pointer text-slate-400 font-semibold hover:text-slate-200">How discovery works</summary>
          <div className="mt-1.5 leading-relaxed" dir="ltr">
            Discovery is anonymous-only: the “Latest” preview and every Check list public reels without any login (anonymous profile listing + fresh web search, which only finds reels search engines have indexed).
            Server admins can additionally set a shared fallback via <code className="text-pink-300">IG_COOKIES_FILE</code> on the downloader.
          </div>
        </details>
        <div className="text-[11px] text-slate-500 mt-2">YouTube title is the first line of the reel's own Instagram caption (max 100 chars, verbatim, no injected hashtags) — description is the full original caption followed by the profile's custom hashtags (no credit block, no source links).</div>
        <div className="text-[11px] text-slate-500 mt-1">Timer and all discovered content are private to your account — other users never see your profiles, reels, or videos.</div>

      </div>

      {watches.length === 0 && (
        <div className="p-8 rounded-3xl bg-slate-900/70 border border-slate-800 text-center text-slate-500 text-sm">No profiles yet — add a link above.</div>
      )}

      {watches.map(w => {
        const list = posts[w.id] || [];
        const isOpen = expanded === w.id;
        // Winner among still-unpublished reels (highest winner_score, then
        // views) — this is what the next timer firing publishes first.
        const pending = list.filter(p => p.status === 'discovered' || p.status === 'downloaded' || p.status === 'failed');
        const winnerCode = pending.length > 0
          ? [...pending].sort((a, b) => ((b.winner_score || 0) - (a.winner_score || 0)) || ((b.play_count || 0) - (a.play_count || 0)))[0].shortcode
          : null;
        const liveOnAir = !!igLive?.active && igLive.watchId === w.id;
        const liveArmed = Number((w as any).live_enabled || 0) === 1;
        return (
          <div key={w.id} className={`rounded-3xl bg-slate-900/80 border overflow-hidden ${liveOnAir ? 'border-red-500/60' : 'border-slate-800'}`}>
            <div className="p-4 space-y-3">
              <div className="flex items-center gap-3">
              <div className="w-10 h-10 shrink-0 rounded-xl bg-gradient-to-br from-pink-600 to-amber-500 flex items-center justify-center font-black text-white">@{w.username[0]?.toUpperCase()}</div>
              <div className="min-w-0 flex-1">
                <div className="flex items-center gap-2 flex-wrap">
                  <span className="font-bold text-white text-sm" dir="ltr">@{w.username}</span>
                  <span className={`px-1.5 py-0.5 rounded text-[10px] font-mono font-bold ${w.enabled ? 'bg-emerald-600/20 text-emerald-300' : 'bg-slate-700/60 text-slate-400'}`}>{w.enabled ? 'Active' : 'Paused'}</span>
                  {liveOnAir && (
                    <span className="px-1.5 py-0.5 rounded text-[10px] font-mono font-black bg-red-600 text-white animate-pulse" title={`Looping reel ${igLive?.shortcode || ''} on your YouTube Live`}>
                      ● LIVE{igLive?.shortcode ? ` · ${igLive.shortcode}` : ''}
                    </span>
                  )}
                  {!liveOnAir && liveArmed && (
                    <span className="px-1.5 py-0.5 rounded text-[10px] font-mono font-bold bg-red-600/15 border border-red-500/40 text-red-300" title="Live is armed — the next timer firing puts the newest reel on air">
                      LIVE armed
                    </span>
                  )}
                  {(Array.isArray(w.daily_times) ? w.daily_times : []).length > 0 ? (
                    <span className="text-[11px] text-amber-300 flex items-center gap-1 font-semibold" title={`Exact daily times (${w.daily_tz || 'UTC'}) — rolling interval paused`}>
                      <Clock className="w-3 h-3" />⏰ {(w.daily_times as string[]).join(', ')}
                    </span>
                  ) : (
                    <span className="text-[11px] text-slate-500 flex items-center gap-1"><Clock className="w-3 h-3" />{formatInterval(Number(w.interval_hours))}</span>
                  )}
                  {w.auto_publish ? <span className="text-[11px] text-pink-300 flex items-center gap-1"><Youtube className="w-3 h-3" />Auto</span> : <span className="text-[11px] text-slate-500">Download only</span>}
                </div>
                <div className="text-[11px] text-slate-500 mt-0.5 break-all" dir="ltr">{w.profile_url}</div>
                <div className="text-[11px] text-slate-500">Next check: {w.next_run_at ? new Date(w.next_run_at).toLocaleString() : '—'}{w.last_shortcode ? ` - Last reel: ${w.last_shortcode}` : ''}</div>
                {w.last_error && <div className="text-[11px] text-amber-400 mt-0.5 break-words">{w.last_error}</div>}
              </div>
              </div>
              <div className="flex flex-wrap items-center gap-1.5 w-full">
                <button onClick={() => checkNow(w.id)} disabled={checking === w.id} className="px-3 py-2 rounded-lg bg-pink-600 hover:bg-pink-500 text-white text-xs font-bold flex items-center gap-1.5 disabled:opacity-50" title="Discover new reels (info only, no download)">
                  <RefreshCw className={`w-4 h-4 ${checking === w.id ? 'animate-spin' : ''}`} />{checking === w.id ? 'Checking...' : 'Check now'}
                </button>
                {liveOnAir ? (
                  <button onClick={() => stopLive(w.id)} disabled={liveBusy === w.id} className="px-3 py-2 rounded-lg bg-red-600 hover:bg-red-500 text-white text-xs font-bold flex items-center gap-1.5 disabled:opacity-50" title="Stop the reel loop and take the live off air">
                    <Radio className="w-4 h-4" />{liveBusy === w.id ? 'Stopping...' : 'Stop Live'}
                  </button>
                ) : null}
                <button onClick={() => patchWatch(w.id, { enabled: !w.enabled })} className="p-2 rounded-lg bg-slate-800 hover:bg-slate-700 text-slate-300" title={w.enabled ? 'Pause' : 'Resume'} aria-label={w.enabled ? 'Pause' : 'Resume'}>
                  {w.enabled ? <Pause className="w-4 h-4" /> : <Play className="w-4 h-4" />}
                </button>
                <button onClick={() => setExpanded(isOpen ? null : w.id)} className="px-2.5 py-2 rounded-lg bg-slate-800 hover:bg-slate-700 text-slate-300 text-xs font-semibold">
                  {isOpen ? 'Close' : `Reels (${list.length})`}
                </button>
                <button onClick={() => removeWatch(w.id)} title="Remove this profile from the watch list" aria-label="Remove profile" className="p-2 rounded-lg bg-slate-800 hover:bg-red-600 border border-red-500/30 hover:border-red-500 text-slate-400 hover:text-white flex items-center justify-center transition-colors"><Trash2 className="w-4 h-4" /></button>
              </div>
            </div>
            <div className="px-4 pb-3 flex flex-wrap items-center gap-2 border-t border-slate-800/70 pt-3">
              <WatchIntervalEditor
                watchId={w.id}
                intervalHours={Number(w.interval_hours)}
                onSave={(h) => patchWatch(w.id, { intervalHours: h })}
              />
              <DailyTimesEditor
                times={Array.isArray(w.daily_times) ? w.daily_times : []}
                timeZone={w.daily_tz || 'UTC'}
                onSave={(t) => {
                  const patch: any = { dailyTimes: t };
                  // First exact time on a legacy (UTC-defaulted) watch adopts
                  // the owner's browser zone so 08:00 means 08:00 their time.
                  if (t.length > 0 && (!w.daily_tz || w.daily_tz === 'UTC') && browserTimeZone() !== 'UTC') {
                    patch.dailyTz = browserTimeZone();
                  }
                  patchWatch(w.id, patch);
                }}
              />
              <HashtagsEditor
                tags={Array.isArray(w.hashtags) ? w.hashtags : []}
                onSave={(t) => patchWatch(w.id, { hashtags: t })}
              />
              {(Array.isArray(w.daily_times) ? w.daily_times : []).length > 0 && (
                <span className="text-[11px] text-amber-300/90 font-semibold">⏰ Exact times fire daily — interval paused until times are cleared.</span>
              )}

            </div>
            {(liveOnAir || liveArmed) && (
              <div className="px-4 pb-2 text-[11px] text-slate-500">
                {liveOnAir
                  ? <span>Looping <b className="text-red-300 font-mono" dir="ltr">{igLive?.shortcode}</b> on YouTube Live — repeats until a newer reel is found (the live prefetch hunts this profile every couple of minutes while on air), then swaps seamlessly without disconnecting. While nothing newer is ready, this reel just keeps repeating.
                    {(igLive?.frames || 0) > 0
                      ? <span className="text-emerald-400 font-semibold"> ● picture flowing ({igLive?.frames} frames)</span>
                      : <span className="text-amber-300 font-semibold"> ● starting… if this stays, the reel file gives no picture — check the server log for [IG-Live] NO FRAMES</span>}
                  </span>
                  : <span>Live armed — the prefetch puts the newest reel on air as soon as it is found and keeps it looping (repeating until a newer reel arrives). The hourly timer below only controls Shorts uploads, not the live loop.</span>}
              </div>
            )}
            {isOpen && (
              <div className="px-4 pb-4 space-y-2">
                {list.length === 0 && <div className="text-xs text-slate-500 py-3 text-center">No reels yet — press “Check now”.</div>}
                {list.map(p => (
                  <div key={p.id} className="p-3 rounded-2xl bg-slate-950/70 border border-slate-800 flex flex-wrap items-center gap-2.5">
                    <div className="min-w-0 flex-1">
                      <div className="text-xs font-bold text-white truncate" dir="auto">
                        {(p.status !== 'published' && p.shortcode === winnerCode) && (
                          <span className="mr-1.5 px-1.5 py-0.5 rounded bg-yellow-500/20 border border-yellow-500/40 text-yellow-300 text-[10px] font-black" title="Winning reel — most views among unpublished, publishes first on the next timer firing">🏆 Winner</span>
                        )}
                        {p.yt_title || p.shortcode}
                      </div>
                      <div className="text-[11px] text-slate-500 truncate mt-0.5" dir="auto">{p.caption?.slice(0, 120) || '—'}</div>
                      {((p.play_count || 0) > 0 || (p.like_count || 0) > 0) && (
                        <div className="text-[10px] font-mono text-slate-400 mt-0.5" dir="ltr">
                          ▶ {(p.play_count || 0).toLocaleString()} views · ♥ {(p.like_count || 0).toLocaleString()}
                        </div>
                      )}
                      <div className="flex items-center gap-2 mt-1 text-[11px] flex-wrap">
                        {p.status === 'published' ? <span className="text-emerald-400 flex items-center gap-1 font-semibold"><CheckCircle2 className="w-3.5 h-3.5" />Published</span>
                          : p.status === 'failed' ? <span className="text-red-400 flex items-center gap-1 font-semibold"><XCircle className="w-3.5 h-3.5" />Failed: {p.error?.slice(0, 80)}</span>
                          : p.status === 'downloaded' ? <span className="text-amber-300 font-semibold">Downloaded — ready to publish</span>
                          : <span className="text-sky-300 font-semibold">New — info only, not downloaded</span>}
                        {p.filename && <a href={`/videos/${p.filename}`} target="_blank" rel="noreferrer" className="text-sky-400 hover:underline" dir="ltr">{p.filename}</a>}
                        {(p.status === 'discovered' || p.status === 'downloaded' || p.status === 'failed') && (
                          <button
                            onClick={() => publishItems(w.id, p.shortcode)}
                            disabled={publishing === `${w.id}:${p.shortcode}`}
                            className="px-2 py-0.5 rounded-lg bg-red-600/80 hover:bg-red-500 text-white text-[11px] font-bold disabled:opacity-50"
                          >
                            {publishing === `${w.id}:${p.shortcode}` ? 'Publishing...' : p.status === 'failed' ? 'Retry' : 'Publish'}
                          </button>
                        )}
                      </div>
                    </div>
                    <div className="flex items-center gap-1.5">
                      {p.insta_url && <a href={p.insta_url} target="_blank" rel="noreferrer" className="p-1.5 rounded-lg bg-slate-800 hover:bg-slate-700 text-pink-300" title="Instagram post"><Instagram className="w-4 h-4" /></a>}
                      {p.yt_url && <a href={p.yt_url} target="_blank" rel="noreferrer" className="p-1.5 rounded-lg bg-slate-800 hover:bg-slate-700 text-red-400" title="YouTube video"><ExternalLink className="w-4 h-4" /></a>}
                    </div>
                  </div>
                ))}
              </div>
            )}
          </div>
        );
      })}
    </div>
  );
};
