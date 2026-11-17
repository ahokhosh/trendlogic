import React, { useEffect, useState } from 'react';
import { Sparkles, Clock, Youtube, ExternalLink, RefreshCw, CheckCircle2, Pause, Play, Instagram } from 'lucide-react';

interface RelaxSchedule {
  enabled: boolean;
  intervalHours: number;
  intervalMinutes: number;
  privacyStatus: 'public' | 'unlisted' | 'private';
  dailyTimes: string[];
  dailyTz: string;
  lastRunAt: string | null;
  nextRunAt: string | null;
  lastRelaxPostId: string | null;
  lastYtVideoId: string | null;
  lastError: string | null;
  igProfileUrl: string | null;
  igRecentCount: number;
}

interface RelaxPreview {
  id: string;
  title: string;
  description: string;
  coverImage: string | null;
  soundLayers: string[];
  tags: string[];
  authorUsername: string;
  createdAt: string;
  relaxUrl: string;
}

interface RelaxHistoryItem {
  id: string;
  relax_post_id: string;
  relax_title: string | null;
  filename: string | null;
  yt_video_id: string | null;
  yt_url: string | null;
  status: string;
  error: string | null;
  created_at: string;
}

const MIN_MINUTES = 240;
const MAX_MINUTES = 168 * 60;

function splitMinutes(totalMin: number): { h: number; m: number } {
  const t = Math.round(Number(totalMin) || 0);
  return { h: Math.floor(t / 60), m: t % 60 };
}

function formatInterval(totalMin: number): string {
  const { h, m } = splitMinutes(totalMin);
  if (h === 0 && m === 0) return '—';
  if (h === 0) return `Every ${m}m`;
  if (m === 0) return `Every ${h}h`;
  return `Every ${h}h ${m}m`;
}

const browserTimeZone = (): string => {
  try {
    return Intl.DateTimeFormat().resolvedOptions().timeZone || 'UTC';
  } catch {
    return 'UTC';
  }
};

export const RelaxShortsView: React.FC<{ onBuyCredit?: () => void }> = ({ onBuyCredit }) => {
  const [schedule, setSchedule] = useState<RelaxSchedule | null>(null);
  const [h, setH] = useState(24);
  const [m, setM] = useState(0);
  const [editing, setEditing] = useState(false);
  const [draftTime, setDraftTime] = useState('08:00');
  const [preview, setPreview] = useState<RelaxPreview | null>(null);
  const [skipIds, setSkipIds] = useState<string[]>([]);
  const [previewEmpty, setPreviewEmpty] = useState(false);
  const [history, setHistory] = useState<RelaxHistoryItem[]>([]);
  const [ytConnected, setYtConnected] = useState<boolean | null>(null);
  const [ytTitle, setYtTitle] = useState('');
  const [loading, setLoading] = useState(false);
  const [saving, setSaving] = useState(false);
  const [running, setRunning] = useState(false);
  const [error, setError] = useState<string | null>(null);
  const [notice, setNotice] = useState<string | null>(null);
  const [quotaBytes, setQuotaBytes] = useState<number>(0);
  useEffect(() => { fetch('/api/uploads/quota').then(r => r.ok ? r.json() : null).then(d => { if (d) setQuotaBytes(Number(d.quota_bytes || 0)); }).catch(() => {}); }, []);
  const [igDraft, setIgDraft] = useState('');

  const fetchAll = async (exclude: string[] = []) => {
    setLoading(true);
    setError(null);
    try {
      const q = exclude.length ? `?exclude=${encodeURIComponent(exclude.join(','))}` : '';
      const [schedR, prevR, histR, ytR] = await Promise.all([
        fetch('/api/relax-shorts/schedule').then(r => (r.ok ? r.json() : null)),
        fetch(`/api/relax-shorts/latest${q}`).then(r => (r.ok ? r.json() : null)),
        fetch('/api/relax-shorts/history').then(r => (r.ok ? r.json() : null)),
        fetch('/api/youtube/config').then(r => (r.ok ? r.json() : null))
      ]);
      if (schedR?.schedule) {
        setSchedule(schedR.schedule);
        setIgDraft(schedR.schedule.igProfileUrl || '');
        if (!editing) {
          const s = splitMinutes(schedR.schedule.intervalMinutes);
          setH(s.h);
          setM(s.m);
        }
      }
      if (prevR?.post) {
        setPreview(prevR.post);
        setPreviewEmpty(false);
      } else {
        setPreview(null);
        setPreviewEmpty(true);
      }
      if (histR?.items) setHistory(histR.items);
      if (ytR?.config) {
        setYtConnected(!!ytR.config.connected);
        setYtTitle(ytR.config.channelTitle || '');
      }
    } catch {
      setError('Could not load Relax Shorts — network error.');
    } finally {
      setLoading(false);
    }
  };

  useEffect(() => {
    fetchAll();
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, []);

  const save = async (patch: Record<string, unknown>) => {
    if ((patch.intervalMinutes !== undefined || patch.intervalHours !== undefined) && quotaBytes <= 0) { setError('Buy credit to enable timer.'); onBuyCredit?.(); return; }
    if (!schedule) return;
    const prev = schedule;
    setSchedule({ ...schedule, ...patch } as RelaxSchedule);
    setSaving(true);
    setError(null);
    try {
      const r = await fetch('/api/relax-shorts/schedule', {
        method: 'PUT',
        headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify({ ...patch, dailyTz: (patch.dailyTz as string) || schedule.dailyTz || browserTimeZone() })
      });
      const d = await r.json().catch(() => null);
      if (!r.ok) {
        setSchedule(prev);
        setError(d?.error || 'Timer save failed.');
        return;
      }
      if (d?.schedule) {
        setSchedule(d.schedule);
        const s = splitMinutes(d.schedule.intervalMinutes);
        setH(s.h);
        setM(s.m);
      }
    } catch {
      setSchedule(prev);
      setError('Timer save failed (network).');
    } finally {
      setSaving(false);
      setEditing(false);
    }
  };

  const commitInterval = () => {
    setEditing(false);
    const total = Math.min(MAX_MINUTES, Math.max(0, Math.floor(h) * 60 + Math.floor(m)));
    if (total < MIN_MINUTES || total > MAX_MINUTES) {
      if (schedule) {
        const s = splitMinutes(schedule.intervalMinutes);
        setH(s.h);
        setM(s.m);
      }
      setError(`Timer must be between 4 hours and 7 days — shorter intervals can look suspicious to YouTube.`);
      return;
    }
    if (schedule && total !== schedule.intervalMinutes) {
      save({ intervalHours: Math.round((total / 60) * 10000) / 10000, intervalMinutes: total });
    }
  };

  const addTime = () => {
    if (!schedule) return;
    const mm = /^(\d{1,2}):(\d{2})$/.exec(draftTime.trim());
    if (!mm || Number(mm[1]) > 23 || Number(mm[2]) > 59) return;
    const norm = `${String(Number(mm[1])).padStart(2, '0')}:${mm[2]}`;
    if (schedule.dailyTimes.includes(norm) || schedule.dailyTimes.length >= 24) return;
    const next = [...schedule.dailyTimes, norm].sort();
    save({
      dailyTimes: next,
      dailyTz: !schedule.dailyTz || schedule.dailyTz === 'UTC' ? browserTimeZone() : schedule.dailyTz
    });
  };

  const removeTime = (t: string) => {
    if (!schedule) return;
    save({ dailyTimes: schedule.dailyTimes.filter(x => x !== t) });
  };

  const saveIgProfile = async () => {
    const trimmed = igDraft.trim();
    await save({ igProfileUrl: trimmed });
    // Reflect the canonicalized value the server stored.
    setIgDraft((prev) => (prev.trim() === trimmed ? prev.trim() : prev));
  };

  const runNow = async () => {
    setRunning(true);
    setError(null);
    setNotice(null);
    try {
      const r = await fetch('/api/relax-shorts/run', { method: 'POST' });
      const d = await r.json().catch(() => null);
      if (!r.ok) {
        setError(d?.error || 'Publish failed.');
        return;
      }
      setNotice(`Published to YouTube Shorts: ${d?.ytUrl || ''}`);
      await fetchAll();
    } catch {
      setError('Publish failed (network).');
    } finally {
      setRunning(false);
    }
  };

  return (
    <div className="space-y-5">
      <div className="p-5 rounded-3xl bg-gradient-to-l from-teal-950/60 via-slate-900 to-slate-900 border border-teal-800/30">
        <div className="flex items-center gap-3">

          <div>
            <h1 className="text-lg font-black text-white">Relax Shorts → YouTube</h1>
            <p className="text-[11px] text-slate-400 mt-0.5">
              Each firing takes the newest Relax AI soundscape for the AUDIO and renders an exact 20-second vertical Short
              for your connected YouTube channel. With an Instagram profile set below, the VIDEO is a random reel from that
              profile (its original audio is dropped); otherwise the Relax cover image is used. Caption carries the full
              description plus the Relax post link. A Relax post is never published twice.
            </p>
          </div>
        </div>

        {ytConnected === false && (
          <div className="mt-3 p-3 rounded-2xl bg-amber-950/40 border border-amber-500/30 text-[12px] text-amber-200 font-semibold">
            No YouTube channel connected — connect it once in Settings → YouTube, then publishing works with one click.
          </div>
        )}
        {ytConnected === true && (
          <div className="mt-3 text-[11px] text-emerald-300 font-semibold flex items-center gap-1.5">
            <Youtube className="w-3.5 h-3.5" /> Connected: {ytTitle || 'YouTube channel'} — Shorts publish as {schedule?.privacyStatus || 'public'}.
          </div>
        )}

        {schedule && (
          <div className="mt-4 flex flex-wrap items-center gap-2">
            <div className="flex items-center gap-2 px-3 py-2 rounded-xl bg-slate-800 border border-slate-700 text-slate-200 text-sm font-semibold" title="Timer — hours + minutes (at least 4 hours, up to 7 days). Saved on blur/Enter.">
              <Clock className="w-4 h-4 text-teal-400" />
              <input
                type="number" min={4} max={168} value={h} disabled={saving}
                onFocus={() => setEditing(true)}
                onChange={e => { setEditing(true); setH(Math.min(168, Math.max(0, Math.floor(Number(e.target.value) || 0)))); }}
                onBlur={commitInterval}
                onKeyDown={e => { if (e.key === 'Enter') (e.target as HTMLInputElement).blur(); }}
                className="w-16 px-2 py-1 rounded-lg bg-slate-950 border border-slate-700 text-slate-100 text-sm font-bold outline-none focus:border-teal-500 disabled:opacity-50"
                dir="ltr"
              />
              <span className="text-slate-400 font-bold">h</span>
              <input
                type="number" min={0} max={59} step={5} value={m} disabled={saving}
                onFocus={() => setEditing(true)}
                onChange={e => { setEditing(true); setM(Math.min(59, Math.max(0, Math.floor(Number(e.target.value) || 0)))); }}
                onBlur={commitInterval}
                onKeyDown={e => { if (e.key === 'Enter') (e.target as HTMLInputElement).blur(); }}
                className="w-16 px-2 py-1 rounded-lg bg-slate-950 border border-slate-700 text-slate-100 text-sm font-bold outline-none focus:border-teal-500 disabled:opacity-50"
                dir="ltr"
              />
              <span className="text-slate-400 font-bold">m</span>
              <span className="text-slate-400 hidden sm:inline">• {formatInterval(h * 60 + m)}</span>
            </div>

            <div className="flex flex-wrap items-center gap-1.5 px-2 py-1.5 rounded-lg bg-slate-800 border border-slate-700 text-slate-200 text-[11px] font-semibold" title="Exact daily firing times. When ≥1 is set, exact times REPLACE the rolling interval.">
              <Clock className="w-3 h-3 text-amber-400" />
              {schedule.dailyTimes.map(t => (
                <span key={t} className="flex items-center gap-1 px-1.5 py-0.5 rounded-md bg-amber-500/15 border border-amber-500/30 text-amber-200 font-mono font-bold" dir="ltr">
                  {t}
                  <button onClick={() => removeTime(t)} className="text-amber-400/70 hover:text-red-400 font-black leading-none" title="Remove">×</button>
                </span>
              ))}
              <input
                type="time" value={draftTime}
                onChange={e => setDraftTime(e.target.value)}
                onKeyDown={e => { if (e.key === 'Enter') addTime(); }}
                className="px-1.5 py-0.5 rounded bg-slate-950 border border-slate-700 text-slate-100 text-[11px] font-bold outline-none focus:border-amber-500"
                dir="ltr"
              />
              <button onClick={addTime} className="px-2 py-0.5 rounded-md bg-amber-600/80 hover:bg-amber-500 text-white text-[11px] font-bold">+ Add</button>
              <span className="text-slate-500 hidden sm:inline">• {schedule.dailyTz || 'UTC'}</span>
            </div>

            <select
              value={schedule.privacyStatus}
              onChange={e => save({ privacyStatus: e.target.value })}
              disabled={saving}
              className="px-2.5 py-1.5 rounded-lg bg-slate-800 border border-slate-700 text-slate-200 text-xs font-semibold disabled:opacity-50"
            >
              <option value="public">YouTube: Public</option>
              <option value="unlisted">YouTube: Unlisted</option>
              <option value="private">YouTube: Private</option>
            </select>

            <button
              onClick={() => save({ enabled: !schedule.enabled })}
              disabled={saving}
              className={`px-3.5 py-1.5 rounded-lg text-xs font-bold transition-all active:scale-95 disabled:opacity-50 flex items-center gap-1.5 ${schedule.enabled ? 'bg-slate-700 hover:bg-slate-600 text-slate-200' : 'bg-emerald-600 hover:bg-emerald-500 text-white'}`}
            >
              {schedule.enabled ? <><Pause className="w-3.5 h-3.5" /> Disable</> : <><Play className="w-3.5 h-3.5" /> Enable</>}
            </button>

            <span className={`px-2 py-1 rounded text-[10px] font-mono font-bold ${schedule.enabled ? 'bg-emerald-600/20 text-emerald-300' : 'bg-slate-700/60 text-slate-400'}`}>
              {schedule.enabled ? 'ON' : 'OFF'}
            </span>
          </div>
        )}

        {/* Video source: a random reel from this Instagram profile becomes the
            video; the audio always comes from Relax. Empty = cover-image Short. */}
        {schedule && (
          <div className="mt-3 p-3 rounded-2xl bg-slate-950/60 border border-pink-800/30">
            <label className="text-[11px] font-bold text-pink-200 flex items-center gap-1.5">
              <Instagram className="w-3.5 h-3.5 text-pink-400" /> Instagram profile for the video track
            </label>
            <div className="mt-2 flex flex-wrap items-center gap-2">
              <input
                value={igDraft}
                onChange={e => setIgDraft(e.target.value)}
                onKeyDown={e => { if (e.key === 'Enter') saveIgProfile(); }}
                placeholder="https://www.instagram.com/username/ (leave empty for cover image)"
                dir="ltr"
                disabled={saving}
                className="flex-1 min-w-[220px] px-3 py-1.5 rounded-lg bg-slate-950 border border-slate-700 text-slate-100 text-xs outline-none focus:border-pink-500 placeholder:text-slate-600 disabled:opacity-50"
              />
              <button
                onClick={saveIgProfile}
                disabled={saving || igDraft.trim() === (schedule.igProfileUrl || '')}
                className="px-3 py-1.5 rounded-lg bg-pink-600/80 hover:bg-pink-500 text-white text-xs font-bold disabled:opacity-40"
              >
                Save
              </button>
            </div>
            <div className="mt-1.5 text-[11px] text-slate-400">
              {schedule.igProfileUrl
                ? <span className="text-pink-200">Video track: <b>random reel</b> from <b dir="ltr">@{schedule.igProfileUrl.replace(/^https?:\/\/(www\.)?instagram\.com\//, '').replace(/\/$/, '')}</b> (recently used reels are skipped{schedule.igRecentCount > 0 ? ` — ${schedule.igRecentCount} remembered` : ''}). Audio stays from Relax.</span>
                : <span>No profile set — the Relax cover image is used as the video. Add a profile to use a random reel instead.</span>}
            </div>
          </div>
        )}

        {schedule && (
          <div className="mt-2 text-[11px] text-slate-500">
            {schedule.enabled
              ? `Next firing: ${schedule.nextRunAt ? new Date(schedule.nextRunAt).toLocaleString() : '—'}${schedule.dailyTimes.length > 0 ? ` (exact times ${schedule.dailyTimes.join(', ')} ${schedule.dailyTz})` : ` (${formatInterval(schedule.intervalMinutes)})`} • 20s Short per firing`
              : 'Timer off — publish manually with the button below.'}
            {schedule.lastError && <span className="block text-amber-400 font-semibold mt-1">Last error: {schedule.lastError}</span>}
          </div>
        )}

        {error && <div className="text-xs text-red-400 font-semibold mt-2">{error}</div>}
        {notice && <div className="text-xs text-emerald-300 font-semibold mt-2">{notice}</div>}
      </div>

      <div className="p-5 rounded-3xl bg-slate-900/80 border border-slate-800">
        <div className="flex items-center justify-between flex-wrap gap-2">
          <h2 className="text-sm font-black text-white uppercase font-mono">Next up — latest Relax AI post</h2>
          <div className="flex items-center gap-2">
            <button
              onClick={() => { if (preview?.id) fetchAll([preview.id]); else fetchAll(); }}
              disabled={loading}
              className="px-3 py-1.5 rounded-lg bg-slate-800 hover:bg-slate-700 text-slate-300 text-xs font-semibold flex items-center gap-1.5 disabled:opacity-50"
            >
              <RefreshCw className={`w-3.5 h-3.5 ${loading ? 'animate-spin' : ''}`} /> Refresh
            </button>
            <button
              onClick={runNow}
              disabled={running || !preview}
              className="px-4 py-1.5 rounded-lg bg-gradient-to-r from-teal-500 to-emerald-600 hover:brightness-110 text-white text-xs font-black flex items-center gap-1.5 disabled:opacity-40"
              title="Render the 20s Short from this post and publish it to your YouTube channel now"
            >
              <Youtube className="w-4 h-4" /> {running ? 'Publishing…' : 'Publish now → 20s Short'}
            </button>
          </div>
        </div>

        {!preview && !previewEmpty && (
          <div className="text-xs text-slate-500 py-6 text-center">Loading the Relax feed…</div>
        )}
        {previewEmpty && (
          <div className="text-xs text-slate-500 py-6 text-center">
            No new Relax AI post — everything latest is already published for your account, or the Relax feed is unreachable.
          </div>
        )}
        {preview && (
          <div className="mt-4 flex flex-col sm:flex-row gap-4">
            <div className="w-full sm:w-40 shrink-0">
              <div className="rounded-2xl overflow-hidden border border-slate-700 bg-black aspect-square">
                {preview.coverImage ? (
                  <img
                    src={preview.coverImage.startsWith('http') ? preview.coverImage : (preview.coverImage.startsWith('/relax/') ? `${new URL(preview.relaxUrl).origin}${preview.coverImage}` : `${new URL(preview.relaxUrl).origin}/relax${preview.coverImage}`)}
                    alt={preview.title}
                    className="w-full h-full object-cover"
                    onError={e => { (e.currentTarget as HTMLImageElement).style.display = 'none'; }}
                  />
                ) : (
                  <div className="w-full h-full flex items-center justify-center text-slate-600 text-[11px] font-mono p-3 text-center" dir="ltr">
                    no cover
                  </div>
                )}
              </div>
              <a
                href={preview.relaxUrl}
                target="_blank"
                rel="noreferrer"
                className="mt-2 px-3 py-1.5 rounded-lg bg-slate-800 hover:bg-slate-700 text-teal-300 text-[11px] font-bold flex items-center justify-center gap-1"
              >
                <ExternalLink className="w-3.5 h-3.5" /> Open Relax post
              </a>
            </div>
            <div className="min-w-0 flex-1">
              <div className="text-sm font-bold text-white" dir="auto">{preview.title}</div>
              <div className="text-[11px] text-slate-500 mt-0.5" dir="ltr">
                by @{preview.authorUsername} • {preview.createdAt ? new Date(preview.createdAt).toLocaleString() : '—'}
              </div>
              <div className="text-xs text-slate-300 mt-2 leading-relaxed line-clamp-4" dir="auto">{preview.description}</div>
              <div className="mt-2 flex flex-wrap gap-1.5">
                {preview.soundLayers.map(l => (
                  <span key={l} className="px-2 py-0.5 rounded-full bg-teal-500/10 border border-teal-500/30 text-teal-300 text-[10px] font-mono" dir="auto">{l}</span>
                ))}
              </div>
              {preview.tags.length > 0 && (
                <div className="mt-1.5 text-[10px] font-mono text-slate-500" dir="ltr">#{preview.tags.slice(0, 8).join(' #')}</div>
              )}
              <div className="mt-2 text-[11px] text-slate-500">
                Renders as an exact <b className="text-teal-300 font-mono">20s</b> 1080×1920 Short with the 20s AI mix as the audio.
                {schedule?.igProfileUrl
                  ? <> The video is a <b className="text-pink-300">random reel</b> from your Instagram profile (looped to 20s, reel audio dropped).</>
                  : <> Set an Instagram profile above to use a random reel as the video; otherwise the Relax cover image (Ken Burns) is used.</>}
              </div>
            </div>
          </div>
        )}
      </div>

      <div className="p-5 rounded-3xl bg-slate-900/80 border border-slate-800">
        <h2 className="text-sm font-black text-white uppercase font-mono">History</h2>
        {history.length === 0 && (
          <div className="text-xs text-slate-500 py-4 text-center">Nothing published yet.</div>
        )}
        <div className="mt-3 space-y-2">
          {history.map(it => (
            <div key={it.id} className="p-3 rounded-2xl bg-slate-950/70 border border-slate-800 flex flex-wrap items-center gap-2.5">
              <div className="min-w-0 flex-1">
                <div className="text-xs font-bold text-white truncate" dir="auto">{it.relax_title || it.relax_post_id}</div>
                <div className="flex items-center gap-2 mt-1 text-[11px] flex-wrap">
                  {it.status === 'published'
                    ? <span className="text-emerald-400 flex items-center gap-1 font-semibold"><CheckCircle2 className="w-3.5 h-3.5" />Published</span>
                    : <span className="text-red-400 font-semibold">Failed: {it.error?.slice(0, 80)}</span>}
                  {it.filename && <a href={`/videos/${it.filename}`} target="_blank" rel="noreferrer" className="text-sky-400 hover:underline font-mono" dir="ltr">{it.filename}</a>}
                  <span className="text-slate-600 font-mono" dir="ltr">{new Date(it.created_at).toLocaleString()}</span>
                </div>
              </div>
              {it.yt_url && (
                <a href={it.yt_url} target="_blank" rel="noreferrer" className="p-1.5 rounded-lg bg-slate-800 hover:bg-slate-700 text-red-400" title="YouTube Short">
                  <ExternalLink className="w-4 h-4" />
                </a>
              )}
            </div>
          ))}
        </div>
      </div>
    </div>
  );
};
