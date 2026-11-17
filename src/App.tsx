import React, { useState, useEffect } from 'react';
import { Sparkles, Play, ExternalLink, Film, Timer, Layers, Radio, Instagram } from 'lucide-react';
import { Header } from './components/Header';
import { AuthPage, AuthUser, AuthPrefs } from './components/AuthPage';
import { TrendDiscoveryFeed } from './components/TrendDiscoveryFeed';
import { VideoPlayerStudio } from './components/VideoPlayerStudio';
import { PipelineInspector } from './components/PipelineInspector';
import { InstagramRepostView } from './components/InstagramRepostView';
import { RelaxShortsView } from './components/RelaxShortsView';
import { LiveStreamView } from './components/LiveStreamView';
import { StandaloneLiveScene } from './components/LiveNewsScene';
import { ProvidersSettingsView } from './components/ProvidersSettingsView';
import { AdminPanelView } from './components/AdminPanelView';
import { UploaderView } from './components/UploaderView';
import { PublishingModal } from './components/PublishingModal';
import { CreateTrendModal } from './components/CreateTrendModal';
import {
  NormalizedTrend,
  PipelineJob,
  TrendProviderConfig,
  PipelineSettings,
  ScriptPackage,
  VerifiedFact,
  RenderedVideoItem
} from './types';
import {
  INITIAL_TRENDS,
  PRESET_FACTS_MAP,
  PRESET_SCRIPT_MAP,
  PRESET_QC_MAP,
  PRESET_SEO_MAP
} from './data/mockTrends';

/** Auto-Pilot timer bounds: 4 hours .. 7 days (mirrors the backend). */
const AUTO_MIN_HOURS = 4;
const AUTO_MAX_HOURS = 168;

function splitAutoInterval(totalHours: number): { h: number; m: number } {
  const totalMin = Math.round(Number(totalHours || 0) * 60);
  return { h: Math.floor(totalMin / 60), m: totalMin % 60 };
}

function joinAutoInterval(h: number, m: number): number {
  const hh = Math.min(AUTO_MAX_HOURS, Math.max(0, Math.floor(Number(h) || 0)));
  const mm = Math.min(59, Math.max(0, Math.floor(Number(m) || 0)));
  return Math.round((hh + mm / 60) * 10000) / 10000;
}

function formatAutoInterval(hours: number): string {
  const { h, m } = splitAutoInterval(hours);
  if (h === 0 && m === 0) return '—';
  if (h === 0) return `Every ${m}m`;
  if (m === 0) return `Every ${h}h`;
  return `Every ${h}h ${m}m`;
}

/** Auto-Pilot hours+minutes editor: free typing while focused, committed to
 *  the server on blur/Enter. Invalid or out-of-range values revert so the
 *  display never disagrees with the persisted timer. */
const AutoPilotIntervalEditor: React.FC<{ intervalHours: number; disabled: boolean; onSave: (h: number) => void }> = ({ intervalHours, disabled, onSave }) => {
  const split = splitAutoInterval(intervalHours);
  // Raw text while editing so the field can be cleared / set to 0 freely —
  // validity is decided only on commit, not on every keystroke.
  const [h, setH] = useState(String(split.h));
  const [m, setM] = useState(String(split.m));
  const [editing, setEditing] = useState(false);
  useEffect(() => {
    if (!editing) {
      const s = splitAutoInterval(intervalHours);
      setH(String(s.h)); setM(String(s.m));
    }
  }, [intervalHours, editing]);
  const commit = () => {
    setEditing(false);
    let total = joinAutoInterval(Number(h) || 0, Number(m) || 0);
    if (total <= 0 || total > AUTO_MAX_HOURS) {
      const s = splitAutoInterval(intervalHours);
      setH(String(s.h)); setM(String(s.m));
      return;
    }
    // Below minimum (e.g. staging 0h while minutes are still low): clamp up
    // instead of reverting, so 0h stays and minutes can be raised after.
    if (total < AUTO_MIN_HOURS) total = AUTO_MIN_HOURS;
    if (Math.abs(total - intervalHours) > 1e-9) {
      onSave(total);
    } else {
      const s = splitAutoInterval(total);
      setH(String(s.h)); setM(String(s.m));
    }
  };
  return (
    <div className="flex items-center gap-2 px-3 py-2 rounded-xl bg-slate-800 border border-slate-700 text-slate-200 text-sm font-semibold" title="Auto-Pilot interval — hours + minutes (at least 4 hours, up to 7 days). Saved on blur/Enter, survives redeploys.">
      <Timer className="w-4 h-4 text-amber-400" />
      <input
        type="number" min={4} max={168} value={h} disabled={disabled}
        onFocus={() => setEditing(true)}
        onChange={e => { setEditing(true); setH(e.target.value); }}
        onBlur={commit}
        onKeyDown={e => { if (e.key === 'Enter') (e.target as HTMLInputElement).blur(); if (e.key === 'Escape') { const s = splitAutoInterval(intervalHours); setH(String(s.h)); setM(String(s.m)); setEditing(false); } }}
        className="w-16 px-2 py-1 rounded-lg bg-slate-950 border border-slate-700 text-slate-100 text-sm font-bold outline-none focus:border-amber-500 disabled:opacity-50"
        dir="ltr"
      />
      <span className="text-slate-400 font-bold">h</span>
      <input
        type="number" min={0} max={59} step={5} value={m} disabled={disabled}
        onFocus={() => setEditing(true)}
        onChange={e => { setEditing(true); setM(e.target.value); }}
        onBlur={commit}
        onKeyDown={e => { if (e.key === 'Enter') (e.target as HTMLInputElement).blur(); if (e.key === 'Escape') { const s = splitAutoInterval(intervalHours); setH(String(s.h)); setM(String(s.m)); setEditing(false); } }}
        className="w-16 px-2 py-1 rounded-lg bg-slate-950 border border-slate-700 text-slate-100 text-sm font-bold outline-none focus:border-amber-500 disabled:opacity-50"
        dir="ltr"
      />
      <span className="text-slate-400 font-bold">m</span>
      <span className="text-slate-400 hidden sm:inline">• {formatAutoInterval(joinAutoInterval(Number(h) || 0, Number(m) || 0))}</span>
    </div>
  );
};

/** Narrator voice picked by the user (same `tl_voice` key the Studio and
 *  Profile screens share). Sent with every pipeline run so the render uses
 *  the chosen voice instead of silently falling back to the default. */
function storedVoiceId(): string | undefined {
  try {
    return localStorage.getItem('tl_voice') || undefined;
  } catch {
    return undefined;
  }
}

export default function App() {
  const [activeTab, setActiveTab] = useState<
    'dashboard' | 'settings' | 'repost' | 'stream' | 'relax' | 'uploader' | 'services' | 'admin'
  >('settings');
  const [showPipeline, setShowPipeline] = useState<boolean>(false);
  const [showStudio, setShowStudio] = useState<boolean>(false);

  // Fullscreen broadcast scene (?scene=live): public, no login — usable as an
  // OBS Browser Source or a studio display. Renders instead of the whole app.
  const [isLiveScene] = useState(() => {
    try {
      return new URLSearchParams(window.location.search).get('scene') === 'live';
    } catch {
      return false;
    }
  });

  const [selectedCountry, setSelectedCountry] = useState<string>('US');
  const [quotaBytes, setQuotaBytes] = useState<number>(0);
  const [openPurchaseModal, setOpenPurchaseModal] = useState<boolean>(false);
  const [trends, setTrends] = useState<NormalizedTrend[]>(INITIAL_TRENDS);
  const [selectedTrend, setSelectedTrend] = useState<NormalizedTrend>(INITIAL_TRENDS[0]);
  const [jobs, setJobs] = useState<PipelineJob[]>([]);
  const [activeJob, setActiveJob] = useState<PipelineJob | null>(null);
  const [videosList, setVideosList] = useState<RenderedVideoItem[]>([]);

  const [isDiscovering, setIsDiscovering] = useState<boolean>(false);
  const [isCreatingTrend, setIsCreatingTrend] = useState<boolean>(false);
  const [isPublishModalOpen, setIsPublishModalOpen] = useState<boolean>(false);

  // Auto-Pilot timer (user-configured interval production + publishing).
  // Persisted per-user in tl_auto_schedule — arming it once keeps it firing
  // across all future redeploys.
  interface AutoSchedule {
    enabled: boolean;
    intervalHours: number;
    intervalMinutes: number;
    autoPublish: boolean;
    country: string;
    lastRunAt: string | null;
    nextRunAt: string | null;
    lastJobId: string | null;
  }
  const [schedule, setSchedule] = useState<AutoSchedule | null>(null);
  const [scheduleSaving, setScheduleSaving] = useState<boolean>(false);
  const [scheduleError, setScheduleError] = useState<string | null>(null);
  const fetchSchedule = async () => {
    try {
      const res = await fetch('/api/schedule');
      if (res.ok) {
        const data = await res.json();
        if (data.schedule) setSchedule(data.schedule);
      }
    } catch {
      /* schedule panel stays hidden */
    }
  };
  const saveSchedule = async (patch: Partial<AutoSchedule>) => {
    if (patch.intervalHours !== undefined && quotaBytes <= 0) { setScheduleError('Buy credit to enable timer.'); setActiveTab('uploader'); return; }
    if (!schedule) return;
    const prev = schedule;
    const next = { ...schedule, ...patch };
    setSchedule(next);
    setScheduleError(null);
    setScheduleSaving(true);
    try {
      const res = await fetch('/api/schedule', {
        method: 'PUT',
        headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify(next)
      });
      if (res.ok) {
        const data = await res.json();
        if (data.schedule) setSchedule(data.schedule);
      } else {
        // Backend did NOT arm — revert the optimistic UI so ON never lies.
        setSchedule(prev);
        if (res.status === 401) {
          setScheduleError('Session expired — sign in again, then press Enable.');
        } else {
          const data = await res.json().catch(() => null);
          setScheduleError(data?.error || 'Timer save failed on the server.');
        }
      }
    } catch (err) {
      // Network failure — revert so the switch reflects the real backend state.
      setSchedule(prev);
      setScheduleError('Timer save failed (network).');
      console.error('Failed to save schedule:', err);
    } finally {
      setScheduleSaving(false);
    }
  };

  // Single real discovery source (mirrors the backend): live Google Trends RSS.
  const [providers, setProviders] = useState<TrendProviderConfig[]>([
    {
      id: 'prov-google-trends',
      name: 'Google Trends Real-Time Engine',
      providerType: 'google_trends',
      active: true,
      country: 'US',
      category: 'all',
      refreshIntervalMin: 15,
      lastSync: new Date().toISOString(),
      itemsDiscoveredCount: 142
    }
  ]);

  const [settings, setSettings] = useState<PipelineSettings>({
    autoPublish: false,
    minQcScoreForAutoPublish: 95,
    minFactConfidence: 90,
    targetVideoLengthSec: 38,
    voiceModel: 'Kore',
    activePlatforms: ['youtube_shorts', 'tiktok']
  });

  // Auth state (server-gated app: every API and /videos requires a session)
  const [user, setUser] = useState<AuthUser | null>(null);
  // Manager role owns the Admin Panel entry (Profile tab) and the admin tab
  // itself — ordinary users never see either. `admin` is a legacy alias.
  const isAdmin = !!user && ['manager', 'admin'].includes(String(user.role || '').toLowerCase());
  const [prefs, setPrefs] = useState<AuthPrefs>({ preferred_ai_model: 'flux', brand_color: '#dc2626' });
  const [authLoading, setAuthLoading] = useState<boolean>(true);

  useEffect(() => {
    let cancelled = false;
    let attempts = 0;
    const check = async () => {
      for (;;) {
        try {
          const res = await fetch('/api/auth/me');
          if (cancelled) return;
          if (res.ok) {
            const data = await res.json();
            setUser(data.user);
            if (data.prefs) setPrefs(data.prefs);
            setAuthLoading(false);
            return;
          }
          // 503 -> DB not ready yet, retry; 401 -> signed out, show login
          if (res.status !== 503) {
            setAuthLoading(false);
            return;
          }
        } catch {
          if (cancelled) return;
          setAuthLoading(false);
          return;
        }
        attempts++;
        if (attempts > 20) {
          if (!cancelled) setAuthLoading(false);
          return;
        }
        await new Promise(r => setTimeout(r, 2000));
      }
    };
    check();
    return () => {
      cancelled = true;
    };
  }, []);

  const handleLogout = async () => {
    try {
      await fetch('/api/auth/logout', { method: 'POST' });
    } catch {
      // best effort
    }
    setUser(null);
    setPrefs({ preferred_ai_model: 'flux', brand_color: '#dc2626' });
    setJobs([]);
    setActiveJob(null);
    setVideosList([]);
  };

  // Fetch initial trends, jobs, and rendered videos from backend
  const fetchTrendsAndJobs = async () => {
    try {
      const [trendsRes, jobsRes, providersRes, videosRes] = await Promise.all([
        fetch('/api/trends').then(r => (r.ok ? r.json() : null)),
        fetch('/api/pipeline/jobs').then(r => (r.ok ? r.json() : null)),
        fetch('/api/providers').then(r => (r.ok ? r.json() : null)),
        fetch('/api/videos/list').then(r => (r.ok ? r.json() : null))
      ]);

      if (trendsRes?.trends) {
        setTrends(trendsRes.trends);
        if (!selectedTrend && trendsRes.trends.length > 0) {
          setSelectedTrend(trendsRes.trends[0]);
        }
      }

      if (jobsRes?.jobs) {
        setJobs(jobsRes.jobs);
        if (jobsRes.jobs.length > 0 && !activeJob) {
          setActiveJob(jobsRes.jobs[0]);
          if (jobsRes.jobs[0].trend) {
            setSelectedTrend(jobsRes.jobs[0].trend);
          }
        }
      }

      if (providersRes?.providers) {
        setProviders(providersRes.providers);
      }

      if (videosRes?.videos) {
        setVideosList(videosRes.videos);
      }
    } catch (err) {
      console.warn('API fetch fallback:', err);
    }
  };

  useEffect(() => {
    if (!user) return;
    fetchTrendsAndJobs();
    fetchSchedule();
    fetch('/api/uploads/quota').then(r => r.ok ? r.json() : null).then(d => { if (d) setQuotaBytes(Number(d.quota_bytes || 0)); }).catch(() => {});
  }, [user]);

  // Poll running jobs
  useEffect(() => {
    const hasRunningJob = jobs.some(j => j.status === 'running' || j.status === 'queued');
    if (!hasRunningJob) return;

    const interval = setInterval(async () => {
      try {
        const res = await fetch('/api/pipeline/jobs');
        if (res.ok) {
          const data = await res.json();
          if (data.jobs) {
            setJobs(data.jobs);
            // Update activeJob if it is running
            if (activeJob) {
              const updated = data.jobs.find((j: PipelineJob) => j.id === activeJob.id);
              if (updated) {
                setActiveJob(updated);
              }
            }
          }
        }
      } catch (e) {
        // silent poll error
      }
    }, 1000);

    return () => clearInterval(interval);
  }, [jobs, activeJob]);

  // Discover live Google Trends handler
  const handleDiscoverTrends = async (geo?: string) => {
    const country = geo || selectedCountry;
    setIsDiscovering(true);
    try {
      const res = await fetch('/api/trends/discover', {
        method: 'POST',
        headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify({ country })
      });
      if (res.ok) {
        const data = await res.json();
        if (data.trends) {
          setTrends(data.trends);
          if (data.trends.length > 0) {
            setSelectedTrend(data.trends[0]);
          }
        }
      }
    } catch (err) {
      console.error('Failed to discover trends:', err);
    } finally {
      setIsDiscovering(false);
    }
  };

  // ONE-CLICK: Auto-ingest Google Trends and immediately produce video for #1 top spike
  const handleAutoTopVideo = async () => {
    setIsDiscovering(true);
    try {
      const res = await fetch('/api/trends/auto-top-video', {
        method: 'POST',
        headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify({ country: selectedCountry, voice: storedVoiceId() })
      });
      if (res.ok) {
        const data = await res.json();
        if (data.trend) {
          setSelectedTrend(data.trend);
        }
        if (data.job) {
          setJobs(prev => [data.job, ...prev.filter(j => j.id !== data.job.id)]);
          setActiveJob(data.job);
          // Switch user immediately to 9:16 video studio
          setShowStudio(true);
        }
        // Refresh trends
        fetch('/api/trends').then(r => r.json()).then(d => {
          if (d?.trends) setTrends(d.trends);
        });
      }
    } catch (err) {
      console.error('Failed to auto-generate video for #1 top trend:', err);
    } finally {
      setIsDiscovering(false);
    }
  };

  // Run pipeline handler
  const handleRunPipeline = async (trend: NormalizedTrend, question?: string) => {
    try {
      const res = await fetch('/api/pipeline/run', {
        method: 'POST',
        headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify({
          trendId: trend.id,
          customQuestion: question || trend.primaryQuestion,
          voice: storedVoiceId()
        })
      });

      if (res.ok) {
        const data = await res.json();
        if (data.job) {
          setJobs(prev => [data.job, ...prev]);
          setActiveJob(data.job);
          setSelectedTrend(trend);
          setShowPipeline(true);
        }
      }
    } catch (err) {
      console.error('Failed to run pipeline:', err);
    }
  };

  // Create custom trend
  const handleCreateTrend = async (trendData: any) => {
    try {
      const res = await fetch('/api/trends/create', {
        method: 'POST',
        headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify(trendData)
      });
      if (res.ok) {
        const data = await res.json();
        if (data.trend) {
          setTrends(prev => [data.trend, ...prev]);
          setSelectedTrend(data.trend);
          // Automatically launch pipeline for newly injected trend
          handleRunPipeline(data.trend);
        }
      }
    } catch (err) {
      console.error('Failed to create trend:', err);
    }
  };

  // Toggle provider active
  const handleToggleProvider = async (id: string, active: boolean) => {
    setProviders(prev => prev.map(p => (p.id === id ? { ...p, active } : p)));
    try {
      await fetch(`/api/providers/${id}`, {
        method: 'PUT',
        headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify({ active })
      });
    } catch (err) {
      console.warn('Failed to update provider status:', err);
    }
  };

  // Get current script and facts for studio
  const currentScript: ScriptPackage =
    activeJob?.script ||
    PRESET_SCRIPT_MAP[selectedTrend.id] ||
    PRESET_SCRIPT_MAP['trend-rm-fcb-01'];

  const currentFacts: VerifiedFact[] =
    activeJob?.facts ||
    PRESET_FACTS_MAP[selectedTrend.id] ||
    PRESET_FACTS_MAP['trend-rm-fcb-01'];

  const currentQc =
    activeJob?.qc ||
    PRESET_QC_MAP[selectedTrend.id] ||
    PRESET_QC_MAP['trend-rm-fcb-01'];

  const currentSeo =
    activeJob?.seo ||
    PRESET_SEO_MAP[selectedTrend.id] ||
    PRESET_SEO_MAP['trend-rm-fcb-01'];

  const latestAiVideoItem = videosList.find(v => v.isAiVideo) || jobs.find(j => j.videoUrl?.includes('_ai.mp4'));
  const hasAiVideo = !!latestAiVideoItem;

  if (isLiveScene) {
    return <StandaloneLiveScene />;
  }

  if (authLoading) {
    return (
      <div className="min-h-screen bg-slate-950 text-slate-100 flex items-center justify-center font-sans selection:bg-red-500 selection:text-white">
        <div className="text-center">
          <div className="w-14 h-14 rounded-2xl bg-gradient-to-br from-red-500 via-orange-500 to-amber-500 mx-auto flex items-center justify-center shadow-lg shadow-red-500/30 animate-pulse">
            <Sparkles className="w-7 h-7 text-white" />
          </div>
          <p className="text-xs font-mono text-slate-400 mt-4 uppercase tracking-widest">
            Loading your studio...
          </p>
        </div>
      </div>
    );
  }

  if (!user) {
    return (
      <AuthPage
        onAuth={(authUser, authPrefs) => {
          setUser(authUser);
          setPrefs(authPrefs || prefs);
        }}
      />
    );
  }

  return (
    <div className="min-h-screen bg-slate-950 text-slate-100 flex flex-col font-sans selection:bg-red-500 selection:text-white">
      {/* Top Header & Navigation */}
      <Header
        activeTab={activeTab}
        setActiveTab={setActiveTab}
        onDiscover={() => handleDiscoverTrends()}
        isDiscovering={isDiscovering}
        selectedCountry={selectedCountry}
        onSelectCountry={geo => {
          setSelectedCountry(geo);
          handleDiscoverTrends(geo);
        }}
        hasAiVideo={hasAiVideo}
        userName={user?.name}
      />

      {/* Main Content Area */}
      <main className="flex-1 max-w-7xl w-full mx-auto px-4 sm:px-6 lg:px-8 py-6 pb-24 md:pb-8">
        {activeTab === 'services' && (
          <div className="space-y-6">
            <div>
              <h2 className="text-2xl font-black text-white">Services</h2>
              <p className="text-sm text-slate-400 mt-1">Choose a service to continue.</p>
            </div>
            <div className="grid sm:grid-cols-2 lg:grid-cols-3 gap-6">
              <button
                onClick={() => setActiveTab('repost')}
                className="group p-6 rounded-3xl bg-gradient-to-br from-slate-900 to-slate-950 border border-slate-800 hover:border-pink-500/60 text-left transition-all hover:shadow-xl hover:shadow-pink-950/40"
              >
                <div className="flex items-center gap-4 mb-4">
                  <div className="w-14 h-14 rounded-2xl bg-gradient-to-br from-pink-500 via-rose-500 to-amber-500 flex items-center justify-center shadow-lg shadow-pink-500/30 group-hover:scale-105 transition-transform">
                    <Instagram className="w-7 h-7 text-white" />
                  </div>
                  <div>
                    <h3 className="text-xl font-black text-white">IG Repost</h3>
                    <span className="text-[10px] font-mono text-slate-500 uppercase tracking-widest">Instagram → YouTube</span>
                  </div>
                </div>
                <p className="text-sm text-slate-400 leading-relaxed">Instagram profile reels auto-discovery and repost to YouTube Shorts.</p>
              </button>
              <button
                onClick={() => setActiveTab('dashboard')}
                className="group p-6 rounded-3xl bg-gradient-to-br from-slate-900 to-slate-950 border border-slate-800 hover:border-red-500/60 text-left transition-all hover:shadow-xl hover:shadow-red-950/40"
              >
                <div className="flex items-center gap-4 mb-4">
                  <div className="w-14 h-14 rounded-2xl bg-gradient-to-br from-red-500 via-rose-500 to-amber-500 flex items-center justify-center shadow-lg shadow-red-500/30 group-hover:scale-105 transition-transform">
                    <Radio className="w-7 h-7 text-white" />
                  </div>
                  <div>
                    <h3 className="text-xl font-black text-white">Newsroom</h3>
                    <span className="text-[10px] font-mono text-slate-500 uppercase tracking-widest">Trends & Production</span>
                  </div>
                </div>
                <p className="text-sm text-slate-400 leading-relaxed">Live Google Trends ingestion, AI newsroom, script generation and automated vertical video production.</p>
              </button>
              <button
                onClick={() => setActiveTab('relax')}
                className="group p-6 rounded-3xl bg-gradient-to-br from-slate-900 to-slate-950 border border-slate-800 hover:border-teal-500/60 text-left transition-all hover:shadow-xl hover:shadow-teal-950/40"
              >
                <div className="flex items-center gap-4 mb-4">
                  <div className="w-14 h-14 rounded-2xl bg-gradient-to-br from-teal-500 to-cyan-600 flex items-center justify-center shadow-lg shadow-teal-500/30 group-hover:scale-105 transition-transform">
                    <Sparkles className="w-7 h-7 text-white" />
                  </div>
                  <div>
                    <h3 className="text-xl font-black text-white">Relax</h3>
                    <span className="text-[10px] font-mono text-slate-500 uppercase tracking-widest">AI Soundscapes</span>
                  </div>
                </div>
                <p className="text-sm text-slate-400 leading-relaxed">AI-generated soundscapes, ambient mixes and relaxing audio production.</p>
              </button>
            </div>
          </div>
        )}
        {activeTab === 'dashboard' && (
          <div className="space-y-6">
            {/* AI Video Ready Spotlight Card */}
            {hasAiVideo && (
              <div className="p-4 rounded-2xl bg-gradient-to-r from-emerald-950/90 via-teal-950/90 to-slate-900 border-2 border-emerald-500/50 flex flex-wrap items-center justify-between gap-4 shadow-xl shadow-emerald-950/40">
                <div className="flex items-center gap-3.5">
                  <div className="w-11 h-11 rounded-2xl bg-gradient-to-br from-emerald-500 to-teal-600 flex items-center justify-center text-slate-950 font-black shadow-lg shadow-emerald-500/30 shrink-0">
                    <Sparkles className="w-6 h-6 text-white animate-pulse" />
                  </div>
                  <div>
                    <div className="flex items-center gap-2">
                      <span className="px-2 py-0.5 rounded text-[10px] uppercase font-mono font-black bg-emerald-500 text-slate-950">
                        ⚡ AI Video Ready
                      </span>
                      <span className="text-xs text-emerald-300 font-mono">
                        {videosList.find(v => v.isAiVideo)?.sizeFormatted || '2.3 MB'} • AI Video • 9:16 Shorts
                      </span>
                    </div>
                    <h3 className="text-sm font-bold text-white mt-0.5">
                      AI video was generated and is ready to play in the studio
                    </h3>
                  </div>
                </div>

                <div className="flex items-center gap-2">
                  <button
                    onClick={() => {
                      const aiVid = videosList.find(v => v.isAiVideo);
                      if (aiVid) {
                        const matchJob = jobs.find(j => j.id === aiVid.jobId || j.videoUrl?.includes(aiVid.filename));
                        if (matchJob) setActiveJob(matchJob);
                      }
          setShowStudio(true);
                    }}
                    className="px-4 py-2 rounded-xl bg-gradient-to-r from-emerald-500 to-teal-500 hover:brightness-110 active:scale-95 text-slate-950 font-black text-xs shadow-lg shadow-emerald-500/30 transition-all flex items-center gap-1.5"
                  >
                    <Play className="w-3.5 h-3.5 fill-current" />
                    <span>View & Play in Studio ▶</span>
                  </button>

                  {videosList.find(v => v.isAiVideo)?.url && (
                    <a
                      href={videosList.find(v => v.isAiVideo)?.url}
                      target="_blank"
                      rel="noreferrer"
                      className="px-3 py-2 rounded-xl bg-slate-800 hover:bg-slate-700 text-slate-200 text-xs font-semibold flex items-center gap-1.5 transition-colors border border-slate-700"
                    >
                      <ExternalLink className="w-3.5 h-3.5 text-emerald-400" />
                      <span>New Tab</span>
                    </a>
                  )}
                </div>
              </div>
            )}

            {/* Auto-Pilot Timer: user-configured interval production + publishing */}
            {schedule && (
              <div className="p-5 rounded-3xl bg-slate-900/90 border border-slate-700 shadow-lg flex flex-col sm:flex-row sm:items-center gap-4">
                <div className="flex items-center gap-3 min-w-0">
                  <div className="w-10 h-10 rounded-xl bg-amber-500/15 border border-amber-500/30 flex items-center justify-center shrink-0">
                    <Timer className="w-5 h-5 text-amber-400" />
                  </div>
                  <div className="min-w-0">
                    <div className="text-sm font-black text-white uppercase tracking-wide flex items-center gap-2">
                      Auto-Pilot Timer
                      <span className={`px-2 py-0.5 rounded text-[10px] font-mono ${schedule.enabled ? 'bg-emerald-600/30 text-emerald-300' : 'bg-slate-700/60 text-slate-400'}`}>
                        {schedule.enabled ? 'ON' : 'OFF'}
                      </span>
                    </div>
                    <div className="text-xs text-slate-400 truncate mt-0.5">
                      {schedule.enabled
                        ? `${formatAutoInterval(schedule.intervalHours)}${schedule.autoPublish ? ' + auto-publish to YouTube' : ''} • Next: ${schedule.nextRunAt ? new Date(schedule.nextRunAt).toLocaleString() : '—'}`
                        : 'Off — produce manually with ⚡'}
                    </div>
                    {scheduleError && (
                      <div className="text-[11px] font-semibold text-red-400">
                        {scheduleError}
                      </div>
                    )}
                  </div>
                </div>
                <div className="flex flex-wrap items-center gap-2 sm:ml-auto">
                  <AutoPilotIntervalEditor
                    intervalHours={schedule.intervalHours}
                    disabled={scheduleSaving}
                    onSave={h => saveSchedule({ intervalHours: h, intervalMinutes: Math.round(h * 60) })}
                  />
                  <label className="flex items-center gap-1.5 px-2.5 py-1.5 rounded-lg bg-slate-800 border border-slate-700 text-slate-300 text-xs font-semibold cursor-pointer" title="Publish each auto video to your connected YouTube channel">
                    <input
                      type="checkbox"
                      checked={schedule.autoPublish}
                      onChange={e => saveSchedule({ autoPublish: e.target.checked })}
                      disabled={scheduleSaving}
                      className="accent-red-600"
                    />
                    Auto-publish
                  </label>
                  <button
                    onClick={() => saveSchedule({ enabled: !schedule.enabled })}
                    disabled={scheduleSaving}
                    className={`px-3.5 py-1.5 rounded-lg text-xs font-bold transition-all active:scale-95 disabled:opacity-50 ${schedule.enabled ? 'bg-slate-700 hover:bg-slate-600 text-slate-200' : 'bg-emerald-600 hover:bg-emerald-500 text-white'}`}
                  >
                    {schedule.enabled ? 'Disable' : 'Enable'}
                  </button>
                </div>
              </div>
            )}

            <div className="flex justify-end gap-2">
              <button
                onClick={() => setShowStudio(true)}
                className="px-3 py-1.5 rounded-lg bg-slate-800 hover:bg-slate-700 text-slate-200 text-xs font-semibold flex items-center gap-1.5"
              >
                <Play className="w-4 h-4" />
                Studio
              </button>
              <button
                onClick={() => setShowPipeline(true)}
                className="px-3 py-1.5 rounded-lg bg-slate-800 hover:bg-slate-700 text-slate-200 text-xs font-semibold flex items-center gap-1.5"
              >
                <Layers className="w-4 h-4" />
                Pipeline
              </button>
            </div>

            {/* Discovery Feed of Trends */}
            <TrendDiscoveryFeed
              trends={trends}
              selectedTrendId={selectedTrend?.id}
              onSelectTrend={trend => {
                setSelectedTrend(trend);
                // Look for job matching this trend
                const match = jobs.find(j => j.trendId === trend.id);
                if (match) setActiveJob(match);
              }}
              onRunPipeline={trend => handleRunPipeline(trend)}
              isProcessing={jobs.some(j => j.status === 'running')}
              onAutoTopVideo={handleAutoTopVideo}
              selectedCountry={selectedCountry}
               onSelectCountry={geo => {
                 setSelectedCountry(geo);
                 handleDiscoverTrends(geo);
               }}
               hasCredit={quotaBytes > 0}
               onBuyCredit={() => { setActiveTab('uploader'); setOpenPurchaseModal(true); }}
             />
          </div>
        )}

        {showStudio && (
          <div className="fixed inset-0 z-50 flex items-center justify-center bg-black/70 p-4">
            <div className="w-full max-w-none w-full max-h-none h-full overflow-auto rounded-3xl bg-slate-900 border border-slate-800 p-4">
              <div className="flex items-center justify-between mb-3">
                <h3 className="text-sm font-black text-white uppercase font-mono">Studio</h3>
                <button onClick={() => setShowStudio(false)} className="px-3 py-1.5 rounded-lg bg-slate-800 hover:bg-slate-700 text-slate-200 text-xs font-bold">Close</button>
              </div>
              <VideoPlayerStudio
                script={currentScript}
                facts={currentFacts}
                qc={currentQc}
                seo={currentSeo}
                keyword={selectedTrend?.keyword || 'Trending News'}
                videoUrl={activeJob?.videoUrl || jobs.find(j => j.videoUrl)?.videoUrl}
                audioUrl={activeJob?.audioUrl}
                renderedMp4Size={activeJob?.renderedMp4Size}
                jobId={activeJob?.id}
                onPublishClick={() => setIsPublishModalOpen(true)}
                onVideoGenerated={() => fetchTrendsAndJobs()}
                user={{ prefs: prefs }}
                onSavePrefs={p => {
                  setPrefs(prev => ({ ...prev, ...p }));
                  fetch('/api/auth/prefs', {
                    method: 'PUT',
                    headers: { 'Content-Type': 'application/json' },
                    body: JSON.stringify(p)
                  }).catch(err => console.warn('Failed to save prefs:', err));
                }}
              />
            </div>
          </div>
        )}

        {showPipeline && (
          <div className="fixed inset-0 z-50 flex items-center justify-center bg-black/70 p-4">
            <div className="w-full max-w-none w-full max-h-none h-full overflow-auto rounded-3xl bg-slate-900 border border-slate-800 p-4">
              <div className="flex items-center justify-between mb-3">
                <h3 className="text-sm font-black text-white uppercase font-mono">Pipeline Inspector</h3>
                <button onClick={() => setShowPipeline(false)} className="px-3 py-1.5 rounded-lg bg-slate-800 hover:bg-slate-700 text-slate-200 text-xs font-bold">Close</button>
              </div>
              <PipelineInspector
                activeJob={activeJob || jobs[0]}
                onRetry={() => {
                  if (selectedTrend) handleRunPipeline(selectedTrend);
                }}
                onViewStudio={() => { setShowPipeline(false); setShowStudio(true); }}
              />
            </div>
          </div>
        )}

        {activeTab === 'repost' && <InstagramRepostView onBuyCredit={() => { setActiveTab('uploader'); setOpenPurchaseModal(true); }} />}

        {activeTab === 'relax' && <RelaxShortsView onBuyCredit={() => { setActiveTab('uploader'); setOpenPurchaseModal(true); }} />}

        {activeTab === 'uploader' && <UploaderView openPurchase={openPurchaseModal} onPurchaseOpened={() => setOpenPurchaseModal(false)} />}

        {activeTab === 'stream' && <LiveStreamView trends={trends} country={selectedCountry} />}

        {activeTab === 'settings' && (
          <ProvidersSettingsView
            providers={providers}
            onToggleProvider={handleToggleProvider}
            settings={settings}
            onUpdateSettings={newS => setSettings(prev => ({ ...prev, ...newS }))}
            userName={user?.name}
            userEmail={user?.email}
            onLogout={handleLogout}
            onProfileUpdate={u => setUser(u)}
            isAdmin={isAdmin}
            onOpenAdmin={() => setActiveTab('admin')}
          />
        )}

        {activeTab === 'admin' && (
          isAdmin ? (
            <AdminPanelView onBack={() => setActiveTab('settings')} />
          ) : (
            <div className="max-w-xl mx-auto p-8 rounded-3xl bg-slate-900 border border-slate-800 text-center">
              <p className="text-sm font-bold text-white">Admin access required</p>
              <p className="text-xs text-slate-400 mt-1">Your account does not hold the manager role.</p>
              <button
                onClick={() => setActiveTab('settings')}
                className="mt-4 px-4 py-2 rounded-xl bg-slate-800 hover:bg-slate-700 text-slate-200 text-xs font-bold transition-colors"
              >
                Back to Profile
              </button>
            </div>
          )
        )}
      </main>

      {/* Modals */}
      <CreateTrendModal
        isOpen={isCreatingTrend}
        onClose={() => setIsCreatingTrend(false)}
        onCreate={handleCreateTrend}
      />

      <PublishingModal
        isOpen={isPublishModalOpen}
        onClose={() => setIsPublishModalOpen(false)}
        jobId={activeJob?.id}
        videoUrl={activeJob?.videoUrl || jobs.find(j => j.videoUrl)?.videoUrl}
        seo={currentSeo}
        qc={currentQc}
        keyword={selectedTrend?.keyword || 'Trending News'}
        publishingStatus={activeJob?.publishing}
        onConfirmPublish={platforms => {
          if (activeJob) {
            const updated = {
              ...activeJob,
              publishing: (activeJob.publishing || []).map(p => ({
                ...p,
                status: platforms.includes(p.platform) ? 'published' : p.status
              }))
            };
            setActiveJob(updated);
            setJobs(prev => prev.map(j => j.id === updated.id ? updated : j));
          }
        }}
      />
    </div>
  );
}
