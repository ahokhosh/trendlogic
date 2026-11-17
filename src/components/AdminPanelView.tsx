import React, { useEffect, useMemo, useState } from 'react';
import {
  ShieldCheck,
  RefreshCw,
  ArrowLeft,
  Eye,
  ThumbsUp,
  MessageSquare,
  ExternalLink,
  Clock,
  AlertCircle,
  User as UserIcon,
  Search,
  Users,
  LayoutGrid,
  Activity,
  Film,
  Sparkles,
  CheckCircle2,
  History,
  ChevronDown,
  HardDrive
} from 'lucide-react';
import { sanitizeSingleLine } from '@/shared/text';

interface AdminVideoOwner {
  id: string;
  name: string;
}

interface AdminVideo {
  videoId: string;
  title: string;
  description: string;
  thumbnail: string;
  publishedAt: string;
  viewCount: number | null;
  likeCount: number | null;
  commentCount: number | null;
  channelId: string;
  channelTitle: string;
  url: string;
  embedUrl: string;
  owner: AdminVideoOwner;
}

interface AdminChannel {
  user: AdminVideoOwner;
  channelId: string | null;
  channelTitle: string | null;
  channelThumbnail: string | null;
  subscriberCount: string | null;
  lastPublishDate: string | null;
  videos: AdminVideo[];
  error: string | null;
}

interface AdminWatch {
  id: string;
  userId: string;
  userName: string;
  profileUrl: string;
  username: string;
  enabled: number;
  intervalHours: number;
  autoPublish: number;
  dailyTimes: string[];
  dailyTz: string;
  lastCheckAt: string | null;
  nextRunAt: string | null;
  lastShortcode: string | null;
  lastError: string | null;
  liveEnabled: number;
  attention: string[];
}

interface PublishStats {
  ig24h: number;
  ig7d: number;
  relax24h: number;
  relax7d: number;
}

interface AuditRow {
  id: string;
  adminUserId: string;
  adminName: string;
  action: string;
  detail: string | null;
  createdAt: string;
}

interface AdminChannelConn {
  userId: string;
  userName: string;
  channelId: string | null;
  channelTitle: string | null;
  subscriberCount: string | null;
  lastPublishDate: string | null;
  needsReconnect: number;
}

interface TitleRotation {
  video_id: string;
  user_id: string;
  old_title: string | null;
  new_title: string | null;
  views_at_rotation: number | null;
  created_at: string;
}

interface RetentionRow {
  owner: AdminVideoOwner;
  channelTitle: string | null;
  videoId: string;
  title: string;
  publishedAt: string | null;
  views: number;
  avgViewDurationSec: number;
  avgViewPercentage: number;
}

interface RapidKeyState {
  index: number;
  prefix: string;
  exhausted: boolean;
}

interface RapidUsage {
  total: number;
  userinfo: number;
  single: number;
  sinceIso: string;
}

interface RapidKeysStatus {
  total: number;
  live: number;
  keys: RapidKeyState[];
  usage?: RapidUsage | null;
}

function formatCount(n: number | null): string {
  if (n === null || n === undefined) return 'â€”';
  if (n >= 1_000_000) return `${(n / 1_000_000).toFixed(1)}M`;
  if (n >= 1_000) return `${(n / 1_000).toFixed(1)}K`;
  return String(n);
}

function formatDate(iso: string): string {
  if (!iso) return 'â€”';
  try {
    return new Date(iso).toLocaleString();
  } catch {
    return iso;
  }
}

/** Readable subscriber count ("1.2K") â€” full number stays as tooltip. */
function formatSubs(raw: string | null | undefined): { short: string; full: string } {
  if (raw === null || raw === undefined || raw === '') return { short: 'â€”', full: 'No subscriber data' };
  const n = Number(String(raw).replace(/,/g, ''));
  if (!Number.isFinite(n)) return { short: String(raw), full: String(raw) };
  const full = n.toLocaleString('en-US');
  if (n >= 1_000_000) return { short: `${(n / 1_000_000).toFixed(1)}M`, full };
  if (n >= 1_000) return { short: `${(n / 1_000).toFixed(1)}K`, full };
  return { short: full, full };
}

/** Relative publish time, SHORT format ("16m", "5h", "3d") â€” absolute date stays as tooltip. */
function formatRelative(iso: string): string {
  if (!iso) return 'â€”';
  const t = Date.parse(iso);
  if (!Number.isFinite(t)) return iso;
  const diffMs = Date.now() - t;
  if (diffMs < 0) return formatDate(iso); // future / clock skew â€” absolute
  const mins = Math.floor(diffMs / 60000);
  if (mins < 1) return 'now';
  if (mins < 60) return `${mins}m`;
  const hours = Math.floor(mins / 60);
  if (hours < 24) return `${hours}h`;
  const days = Math.floor(hours / 24);
  if (days < 7) return `${days}d`;
  const weeks = Math.floor(days / 7);
  if (weeks < 5) return `${weeks}w`;
  const months = Math.floor(days / 30);
  if (months < 12) return `${months}mo`;
  return `${Math.floor(days / 365)}y`;
}

const ATTENTION_LABELS: Record<string, string> = {
  error: 'has error',
  no_schedule: 'no schedule',
  stale: 'stale check',
  never_checked: 'never checked'
};

/** Compact info-only row: thumbnail (link) + useful metadata, no iframe embed.
 *  Keeps channel / owner / publish time / views / likes / comments visible
 *  in a dense single-row card so the manager scans many uploads at once. */
const VideoCard: React.FC<{ v: AdminVideo }> = ({ v }) => {
  const title = sanitizeSingleLine(v.title);
  return (
  <article className="flex gap-3 rounded-2xl bg-slate-900 border border-slate-800 p-2.5 hover:border-slate-700 transition-colors">
    <a
      href={v.url}
      target="_blank"
      rel="noreferrer"
      title={title}
      className="relative w-28 sm:w-36 shrink-0 aspect-video rounded-xl overflow-hidden bg-black group"
    >
      {v.thumbnail ? (
        <img
          src={v.thumbnail}
          alt=""
          loading="lazy"
          className="w-full h-full object-cover group-hover:opacity-90 transition-opacity"
        />
      ) : (
        <span className="w-full h-full flex items-center justify-center text-slate-600">
          <Film className="w-6 h-6" />
        </span>
      )}
    </a>
    <div className="min-w-0 flex-1 space-y-1">
      <h3 className="text-[13px] font-bold text-white leading-snug line-clamp-2" dir="auto" title={title}>
        {title}
      </h3>
      <div className="flex flex-wrap items-center gap-x-2 gap-y-0.5 text-[11px] min-w-0">
        <span className="font-bold text-slate-200 truncate max-w-[12rem]" dir="auto" title={v.channelTitle}>
          {v.channelTitle}
        </span>
        <span className="flex items-center gap-1 text-slate-500 min-w-0">
          <span className="w-4 h-4 rounded-full bg-gradient-to-br from-amber-500 to-orange-600 flex items-center justify-center text-[8px] font-black text-white shrink-0">
            {(v.owner.name || '?')[0]?.toUpperCase()}
          </span>
          <span className="truncate max-w-[8rem]" dir="auto" title={`App user: ${v.owner.name}`}>
            {v.owner.name}
          </span>
        </span>
      </div>
      <div className="flex flex-wrap items-center gap-x-3 gap-y-0.5 text-[11px] font-mono text-slate-300">
        <span className="flex items-center gap-1" title="Views">
          <Eye className="w-3.5 h-3.5 text-sky-400" />
          {formatCount(v.viewCount)}
        </span>
        <span className="flex items-center gap-1" title={formatDate(v.publishedAt)}>
          <Clock className="w-3.5 h-3.5 text-slate-400" />
          {formatRelative(v.publishedAt)}
        </span>
        <span className="flex items-center gap-1" title="Likes">
          <ThumbsUp className="w-3.5 h-3.5 text-emerald-400" />
          {formatCount(v.likeCount)}
        </span>
        <span className="flex items-center gap-1" title="Comments">
          <MessageSquare className="w-3.5 h-3.5 text-amber-400" />
          {formatCount(v.commentCount)}
        </span>
        <a
          href={v.url}
          target="_blank"
          rel="noreferrer"
          className="ml-auto flex items-center gap-1 text-slate-500 hover:text-white transition-colors"
          title={v.videoId}
        >
          <ExternalLink className="w-3.5 h-3.5" />
          <span>YouTube</span>
        </a>
      </div>
    </div>
  </article>
  );
};

/** Manager-only view: latest uploads across users (compact info rows, no
 *  embeds) plus timer health, publish stats and the audit trail. */
export const AdminPanelView: React.FC<{ onBack: () => void }> = ({ onBack }) => {
  const [section, setSection] = useState<'videos' | 'health'>('videos');

  // Uploads
  const [videos, setVideos] = useState<AdminVideo[]>([]);
  const [channels, setChannels] = useState<AdminChannel[]>([]);
  const [fetchedAt, setFetchedAt] = useState<string | null>(null);
  const [cached, setCached] = useState<boolean>(false);
  const [loading, setLoading] = useState<boolean>(false);
  const [error, setError] = useState<string | null>(null);
  const [forbidden, setForbidden] = useState<boolean>(false);

  // Videos toolbar
  const [query, setQuery] = useState<string>('');
  const [timeFilter, setTimeFilter] = useState<'all' | '24h' | '7d'>('all');
  const [sort, setSort] = useState<'newest' | 'views'>('newest');
  const [layout, setLayout] = useState<'feed' | 'users'>('users');
  const [collapsed, setCollapsed] = useState<Set<string>>(new Set());

  // Health
  const [watches, setWatches] = useState<AdminWatch[]>([]);
  const [stats, setStats] = useState<PublishStats | null>(null);
  const [audit, setAudit] = useState<AuditRow[]>([]);
  const [conns, setConns] = useState<AdminChannelConn[]>([]);
  const [rotations, setRotations] = useState<TitleRotation[]>([]);
  const [rapidKeys, setRapidKeys] = useState<RapidKeysStatus | null>(null);
  const [rapidResetting, setRapidResetting] = useState<boolean>(false);
  const [storagePurchases, setStoragePurchases] = useState<any[]>([]);
  const [storageLoading, setStorageLoading] = useState<boolean>(false);
  const [users, setUsers] = useState<any[]>([]);
  const [usersLoading, setUsersLoading] = useState<boolean>(false);
  const [usersModalOpen, setUsersModalOpen] = useState<boolean>(false);
  const [videosModalOpen, setVideosModalOpen] = useState<boolean>(false);
  const [healthModalOpen, setHealthModalOpen] = useState<boolean>(false);
  const [overviewAt, setOverviewAt] = useState<string | null>(null);
  const [overviewLoading, setOverviewLoading] = useState<boolean>(false);
  const [overviewError, setOverviewError] = useState<string | null>(null);
  const [overviewLoaded, setOverviewLoaded] = useState<boolean>(false);

  // Retention (Analytics API, cached server-side)
  const [retention, setRetention] = useState<RetentionRow[]>([]);
  const [retentionReconnect, setRetentionReconnect] = useState<{ userId: string; userName: string; channelTitle: string | null }[]>([]);
  const [retentionAt, setRetentionAt] = useState<string | null>(null);
  const [retentionLoading, setRetentionLoading] = useState<boolean>(false);

  const load = async (force = false) => {
    setLoading(true);
    setError(null);
    setForbidden(false);
    try {
      const res = await fetch(`/api/admin/youtube-uploads?perChannel=3&maxChannels=25${force ? '&refresh=1' : ''}`);
      if (res.status === 403) {
        setForbidden(true);
        return;
      }
      if (!res.ok) {
        const data = await res.json().catch(() => null);
        throw new Error(data?.error || `Request failed (${res.status})`);
      }
      const data = await res.json();
      setVideos(Array.isArray(data.videos) ? data.videos : []);
      setChannels(Array.isArray(data.channels) ? data.channels : []);
      setFetchedAt(data.fetchedAt || null);
      setCached(!!data.cached);
    } catch (err: any) {
      setError(err?.message || 'Could not load uploads.');
    } finally {
      setLoading(false);
    }
  };

  const loadOverview = async () => {
    setOverviewLoading(true);
    setOverviewError(null);
    try {
      const res = await fetch('/api/admin/overview');
      if (res.status === 403) {
        setForbidden(true);
        return;
      }
      if (!res.ok) {
        const data = await res.json().catch(() => null);
        throw new Error(data?.error || `Request failed (${res.status})`);
      }
      const data = await res.json();
      setWatches(Array.isArray(data.watches) ? data.watches : []);
      setStats(data.stats || null);
      setAudit(Array.isArray(data.audit) ? data.audit : []);
      setConns(Array.isArray(data.channels) ? data.channels : []);
      setRotations(Array.isArray(data.rotations) ? data.rotations : []);
      setRapidKeys(data.rapidKeys || null);
      setOverviewAt(data.fetchedAt || null);
      setOverviewLoaded(true);
    } catch (err: any) {
      setOverviewError(err?.message || 'Could not load overview.');
    } finally {
      setOverviewLoading(false);
    }
  };

  const loadRetention = async () => {
    setRetentionLoading(true);
    try {
      const res = await fetch('/api/admin/retention');
      if (res.status === 403) {
        setForbidden(true);
        return;
      }
      if (!res.ok) return;
      const data = await res.json();
      setRetention(Array.isArray(data.rows) ? data.rows : []);
      setRetentionReconnect(Array.isArray(data.reconnect) ? data.reconnect : []);
      setRetentionAt(data.fetchedAt || null);
    } finally {
      setRetentionLoading(false);
    }
  };

  const openUsersModal = () => {
    setUsersModalOpen(true);
    if (users.length === 0) loadUsers();
  };
  const loadUsers = async () => {
    setUsersLoading(true);
    try {
      const res = await fetch('/api/admin/users');
      if (res.status === 403) { setForbidden(true); return; }
      if (!res.ok) { console.warn('users load failed', res.status); return; }
      const data = await res.json();
      setUsers(Array.isArray(data.users) ? data.users : []);
    } catch (e) { console.warn('users load error', e); }
    finally { setUsersLoading(false); }
  };
  const toggleUserStatus = async (id: string, current: string) => {
    const next = current === 'disabled' ? 'active' : 'disabled';
    try {
      const res = await fetch(`/api/admin/users/${id}/status`, { method: 'POST', headers: { 'Content-Type': 'application/json' }, body: JSON.stringify({ status: next }) });
      if (!res.ok) { const d = await res.json().catch(() => null); alert(d?.error || 'Failed'); return; }
      await loadUsers();
    } catch (e: any) { alert(e?.message || 'Failed'); }
  };
  const loadStoragePurchases = async () => {
    setStorageLoading(true);
    try {
      const res = await fetch('/api/admin/uploads/purchases');
      if (res.status === 403) { setForbidden(true); return; }
      if (!res.ok) return;
      const data = await res.json();
      setStoragePurchases(Array.isArray(data.purchases) ? data.purchases : []);
    } finally {
      setStorageLoading(false);
    }
  };
  const decidePurchase = async (id: string, action: 'approve' | 'reject') => {
    try {
      const res = await fetch(`/api/admin/uploads/purchases/${id}/${action}`, {
        method: 'POST',
        headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify({})
      });
      if (!res.ok) {
        const d = await res.json().catch(() => null);
        alert(d?.error || 'Failed');
        return;
      }
      await loadStoragePurchases();
    } catch (e: any) { alert(e?.message || 'Failed'); }
  };
  const resetRapidCounter = async () => {
    setRapidResetting(true);
    setOverviewError(null);
    try {
      const res = await fetch('/api/admin/rapid-reset', { method: 'POST' });
      if (res.status === 403) {
        setForbidden(true);
        return;
      }
      const data = await res.json().catch(() => null);
      if (!res.ok) throw new Error(data?.error || `Request failed (${res.status})`);
      if (data?.rapidKeys) setRapidKeys(data.rapidKeys);
    } catch (err: any) {
      setOverviewError(err?.message || 'Could not reset counter.');
    } finally {
      setRapidResetting(false);
    }
  };

  useEffect(() => {
    // Load nothing on mount — each section fetches on demand.
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, []);

  useEffect(() => {
    // No auto-fetch; health data loads via the "Fetch health" button.
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [section]);

  const filtered = useMemo(() => {
    const q = query.trim().toLowerCase();
    const now = Date.now();
    const cutoff = timeFilter === '24h' ? now - 24 * 3600 * 1000 : timeFilter === '7d' ? now - 7 * 24 * 3600 * 1000 : 0;
    const list = videos.filter(v => {
      if (cutoff > 0) {
        const t = Date.parse(v.publishedAt || '');
        if (!Number.isFinite(t) || t < cutoff) return false;
      }
      if (!q) return true;
      return (
        sanitizeSingleLine(v.title).toLowerCase().includes(q) ||
        v.channelTitle.toLowerCase().includes(q) ||
        v.owner.name.toLowerCase().includes(q)
      );
    });
    list.sort((a, b) =>
      sort === 'views'
        ? (b.viewCount ?? -1) - (a.viewCount ?? -1)
        : +new Date(b.publishedAt || 0) - +new Date(a.publishedAt || 0)
    );
    return list;
  }, [videos, query, timeFilter, sort]);

  const grouped = useMemo(() => {
    const subsByUser = new Map<string, string | null>();
    for (const c of channels) subsByUser.set(c.user.id, c.subscriberCount);
    const map = new Map<string, { owner: AdminVideoOwner; channelTitle: string; subscriberCount: string | null; videos: AdminVideo[] }>();
    for (const v of filtered) {
      const g = map.get(v.owner.id) || { owner: v.owner, channelTitle: v.channelTitle, subscriberCount: subsByUser.get(v.owner.id) ?? null, videos: [] };
      g.videos.push(v);
      map.set(v.owner.id, g);
    }
    return [...map.values()];
  }, [filtered, channels]);

  const attention = useMemo(() => watches.filter(w => w.attention.length > 0), [watches]);
  const deadChannels = useMemo(() => channels.filter(c => c.error), [channels]);
  const reconnectConns = useMemo(() => conns.filter(c => c.needsReconnect === 1), [conns]);
  const topRetention = useMemo(() => [...retention].sort((a, b) => b.views - a.views).slice(0, 5), [retention]);
  const lowRetention = useMemo(
    () => [...retention].filter(r => r.views >= 10).sort((a, b) => a.avgViewPercentage - b.avgViewPercentage).slice(0, 5),
    [retention]
  );

  const toggleUser = (id: string) => {
    setCollapsed(prev => {
      const next = new Set(prev);
      if (next.has(id)) next.delete(id);
      else next.add(id);
      return next;
    });
  };

  const tabBtn = (id: 'videos' | 'health', label: string) => (
    <button
      key={id}
      type="button"
      onClick={() => setSection(id)}
      className={`px-4 py-1.5 rounded-xl text-xs font-bold transition-all ${
        section === id
          ? 'bg-amber-600 text-white shadow-md shadow-amber-600/30'
          : 'text-slate-400 hover:text-white hover:bg-slate-800'
      }`}
    >
      {label}
    </button>
  );

  return (
    <div className="space-y-5 max-w-none w-full mx-auto">
      {/* Header */}
      <div className="relative overflow-hidden rounded-3xl border border-amber-500/30 bg-gradient-to-br from-slate-900 via-slate-900 to-amber-950/40 p-5 sm:p-6">
        <div className="flex flex-wrap items-center gap-3 justify-between">
          <div className="flex items-center gap-3 min-w-0">
            <div className="w-12 h-12 rounded-2xl bg-gradient-to-br from-amber-500 to-orange-600 flex items-center justify-center shadow-lg shadow-amber-500/30 shrink-0">
              <ShieldCheck className="w-6 h-6 text-white" />
            </div>
            <div className="min-w-0">
              <div className="text-[10px] font-mono uppercase tracking-widest text-amber-400/80">
                Manager only
              </div>
              <h1 className="text-xl sm:text-2xl font-black text-white">Admin Panel</h1>
              <p className="text-[11px] text-slate-400">
                {section === 'videos' ? (
                  <>
                    Latest YouTube uploads by all users
                    {fetchedAt ? ` â€¢ updated ${formatRelative(fetchedAt)}` : ''}
                    {cached && <span className="ml-1 px-1.5 py-0.5 rounded bg-slate-700/60 text-slate-300 font-mono text-[10px]">cached</span>}
                  </>
                ) : (
                  <>
                    Timer health, publish stats & audit
                    {overviewAt ? ` â€¢ updated ${formatRelative(overviewAt)}` : ''}
                  </>
                )}
              </p>
            </div>
          </div>
          <div className="flex items-center gap-2">
            <div />
            <button
              type="button"
              onClick={() => {
                if (section === 'videos') load(true);
                else {
                  loadOverview();
                  loadRetention();
                }
              }}
              disabled={loading || overviewLoading}
              className="flex items-center gap-1.5 px-3.5 py-2 rounded-xl bg-slate-800 hover:bg-slate-700 border border-slate-700 text-slate-200 text-xs font-bold transition-colors disabled:opacity-50"
            >
              <RefreshCw className={`w-4 h-4 ${(loading || overviewLoading) ? 'animate-spin' : ''}`} />
              <span>{loading || overviewLoading ? 'Loadingâ€¦' : 'Refresh'}</span>
            </button>
            <button
              type="button"
              onClick={onBack}
              className="flex items-center gap-1.5 px-3.5 py-2 rounded-xl bg-slate-800/60 hover:bg-slate-700 border border-slate-700 text-slate-300 text-xs font-bold transition-colors"
            >
              <ArrowLeft className="w-4 h-4" />
              <span>Back to Profile</span>
            </button>
          </div>
        </div>
      </div>

      {forbidden && (
        <div className="p-4 rounded-2xl bg-red-950/40 border border-red-800 text-red-300 text-sm flex items-start gap-2.5">
          <AlertCircle className="w-5 h-5 shrink-0 mt-0.5" />
          <span>Admin access required â€” your account does not hold the manager role.</span>
        </div>
      )}

      {/* ============================ VIDEOS ============================ */}
      {videosModalOpen && !forbidden && (
        <div className="fixed inset-0 z-50 flex items-center justify-center bg-black/70 p-0">
          <div className="w-full max-w-none w-full max-h-none h-full overflow-auto rounded-3xl bg-slate-900 border border-slate-800 p-5 space-y-4">
            <div className="flex items-center justify-between">
              <h3 className="text-sm font-black text-white uppercase font-mono">Channel videos</h3>
              <button onClick={() => setVideosModalOpen(false)} className="px-3 py-1.5 rounded-lg bg-slate-800 hover:bg-slate-700 text-slate-200 text-xs font-bold">Close</button>
            </div>
            <button onClick={() => load(true)} className="text-xs text-slate-400 hover:text-white">Refresh</button>
            <>
              {/* Toolbar: search + time + sort + layout */}
          <div className="p-3.5 rounded-2xl bg-slate-900 border border-slate-800 flex flex-wrap items-center gap-2">
            <label className="flex items-center gap-2 flex-1 min-w-[12rem] px-3 py-2 rounded-xl bg-slate-950 border border-slate-800 focus-within:border-amber-500/60">
              <Search className="w-4 h-4 text-slate-500 shrink-0" />
              <input
                value={query}
                onChange={e => setQuery(e.target.value)}
                placeholder="Search user, channel or titleâ€¦"
                className="w-full bg-transparent text-xs text-white placeholder-slate-500 focus:outline-none"
              />
            </label>
            <select
              value={timeFilter}
              onChange={e => setTimeFilter(e.target.value as any)}
              className="px-3 py-2 rounded-xl bg-slate-950 border border-slate-800 text-xs text-slate-200 font-semibold focus:outline-none cursor-pointer"
              title="Time range"
            >
              <option value="all">All time</option>
              <option value="24h">Last 24h</option>
              <option value="7d">Last 7 days</option>
            </select>
            <select
              value={sort}
              onChange={e => setSort(e.target.value as any)}
              className="px-3 py-2 rounded-xl bg-slate-950 border border-slate-800 text-xs text-slate-200 font-semibold focus:outline-none cursor-pointer"
              title="Sort order"
            >
              <option value="newest">Newest first</option>
              <option value="views">Most viewed</option>
            </select>
            <div className="flex items-center gap-1 p-1 rounded-xl bg-slate-950 border border-slate-800">
              <button
                type="button"
                onClick={() => setLayout('feed')}
                title="Feed layout"
                className={`p-1.5 rounded-lg transition-colors ${layout === 'feed' ? 'bg-slate-700 text-white' : 'text-slate-500 hover:text-slate-300'}`}
              >
                <LayoutGrid className="w-4 h-4" />
              </button>
              <button
                type="button"
                onClick={() => setLayout('users')}
                title="Group by user"
                className={`p-1.5 rounded-lg transition-colors ${layout === 'users' ? 'bg-slate-700 text-white' : 'text-slate-500 hover:text-slate-300'}`}
              >
                <Users className="w-4 h-4" />
              </button>
            </div>
            {(query || timeFilter !== 'all') && (
              <span className="text-[11px] font-mono text-slate-400" dir="ltr">
                {filtered.length}/{videos.length}
              </span>
            )}
          </div>

          {error && (
            <div className="p-4 rounded-2xl bg-amber-950/40 border border-amber-800 text-amber-300 text-sm flex items-start gap-2.5">
              <AlertCircle className="w-5 h-5 shrink-0 mt-0.5" />
              <span>{error}</span>
            </div>
          )}

          {!loading && !error && filtered.length === 0 && (
            <div className="p-8 rounded-3xl bg-slate-900 border border-slate-800 text-center">
              <UserIcon className="w-8 h-8 text-slate-600 mx-auto" />
              <p className="text-sm font-bold text-white mt-3">
                {videos.length === 0 ? 'No uploads found' : 'No matches'}
              </p>
              <p className="text-xs text-slate-400 mt-1">
                {videos.length === 0
                  ? 'No linked YouTube channel has published videos yet â€” uploads appear here automatically.'
                  : 'Try a different search or time range.'}
              </p>
            </div>
          )}

          {deadChannels.length > 0 && (
            <div className="p-3.5 rounded-2xl bg-slate-900 border border-slate-800 text-xs text-slate-400 space-y-1">
              <div className="font-bold text-slate-300 uppercase font-mono text-[10px]">
                {deadChannels.length} channel{deadChannels.length === 1 ? '' : 's'} unreachable
              </div>
              {deadChannels.map(c => (
                <div key={c.user.id} className="truncate" dir="auto">
                  {c.user.name} â€” {c.error}
                </div>
              ))}
            </div>
          )}

          {layout === 'feed' ? (
            <div className="grid grid-cols-1 xl:grid-cols-2 gap-2.5">
              {filtered.map(v => (
                <VideoCard key={`${v.owner.id}-${v.videoId}`} v={v} />
              ))}
            </div>
          ) : (
            <div className="space-y-3">
              {grouped.map(g => {
                const isCollapsed = collapsed.has(g.owner.id);
                return (
                  <div key={g.owner.id} className="rounded-3xl bg-slate-900 border border-slate-800 overflow-hidden">
                    <button
                      type="button"
                      onClick={() => toggleUser(g.owner.id)}
                      className="w-full flex items-center gap-3 p-4 hover:bg-slate-800/40 transition-colors text-left"
                    >
                      <span className="w-9 h-9 rounded-2xl bg-gradient-to-br from-amber-500 to-orange-600 flex items-center justify-center text-sm font-black text-white shrink-0">
                        {(g.owner.name || '?')[0]?.toUpperCase()}
                      </span>
                      <span className="min-w-0 flex-1">
                        <span className="block text-sm font-black text-white truncate" dir="auto">
                          {g.owner.name}
                        </span>
                        <span className="block text-[11px] font-mono text-slate-400 truncate" dir="auto">
                          {g.channelTitle}
                        </span>
                      </span>
                      {(() => {
                        const subs = formatSubs(g.subscriberCount);
                        return (
                          <span
                            className="flex items-center gap-1 px-2 py-0.5 rounded-full bg-emerald-950/60 border border-emerald-800/60 text-emerald-300 text-[11px] font-mono shrink-0"
                            dir="ltr"
                            title={`${subs.full} subscribers${fetchedAt ? ` â€¢ updated ${formatDate(fetchedAt)}` : ''}`}
                          >
                            <Users className="w-3 h-3" />
                            {subs.short}
                          </span>
                        );
                      })()}
                      <span className="px-2 py-0.5 rounded-full bg-slate-800 text-slate-300 text-[11px] font-mono shrink-0" dir="ltr" title={`${g.videos.length} videos`}>
                        {g.videos.length}
                      </span>
                      <ChevronDown className={`w-4 h-4 text-slate-500 shrink-0 transition-transform ${isCollapsed ? '' : 'rotate-180'}`} />
                    </button>
                      {!isCollapsed && (
                      <div className="grid grid-cols-1 xl:grid-cols-2 gap-2.5 p-3 pt-0">
                        {g.videos.map(v => (
                          <VideoCard key={v.videoId} v={v} />
                        ))}
                      </div>
                    )}
                  </div>
                );
              })}
            </div>
          )}

          {loading && videos.length === 0 && (
            <div className="p-8 rounded-3xl bg-slate-900 border border-slate-800 text-center">
              <RefreshCw className="w-6 h-6 text-amber-400 mx-auto animate-spin" />
              <p className="text-xs font-mono text-slate-400 mt-3 uppercase tracking-widest">
                Fetching latest uploadsâ€¦
              </p>
            </div>
          )}
        </>
            </div>
          </div>
        )}

      {/* ============================ HEALTH ============================ */}
      {healthModalOpen && !forbidden && (
        <div className="fixed inset-0 z-50 flex items-center justify-center bg-black/70 p-0">
          <div className="w-full max-w-none w-full max-h-none h-full overflow-auto rounded-3xl bg-slate-900 border border-slate-800 p-5 space-y-4">
            <div className="flex items-center justify-between">
              <h3 className="text-sm font-black text-white uppercase font-mono">Health overview</h3>
              <button onClick={() => setHealthModalOpen(false)} className="px-3 py-1.5 rounded-lg bg-slate-800 hover:bg-slate-700 text-slate-200 text-xs font-bold">Close</button>
            </div>
            <button onClick={() => { loadOverview(); loadRetention(); }} className="text-xs text-slate-400 hover:text-white">Fetch health</button>
            <>
              {overviewError && (
            <div className="p-4 rounded-2xl bg-amber-950/40 border border-amber-800 text-amber-300 text-sm flex items-start gap-2.5">
              <AlertCircle className="w-5 h-5 shrink-0 mt-0.5" />
              <span>{overviewError}</span>
            </div>
          )}

          {overviewLoading && !overviewLoaded && (
            <div className="p-8 rounded-3xl bg-slate-900 border border-slate-800 text-center">
              <RefreshCw className="w-6 h-6 text-amber-400 mx-auto animate-spin" />
              <p className="text-xs font-mono text-slate-400 mt-3 uppercase tracking-widest">
                Loading overviewâ€¦
              </p>
            </div>
          )}

          {overviewLoaded && stats && (
            <div className="grid grid-cols-2 md:grid-cols-4 gap-3">
              {[
                { label: 'IG Repost â€¢ 24h', value: stats.ig24h, Icon: Film, tint: 'text-sky-400' },
                { label: 'IG Repost â€¢ 7d', value: stats.ig7d, Icon: Film, tint: 'text-sky-400' },
                { label: 'Relax Shorts â€¢ 24h', value: stats.relax24h, Icon: Sparkles, tint: 'text-teal-400' },
                { label: 'Relax Shorts â€¢ 7d', value: stats.relax7d, Icon: Sparkles, tint: 'text-teal-400' }
              ].map(s => (
                <div key={s.label} className="p-4 rounded-2xl bg-slate-900 border border-slate-800">
                  <div className="flex items-center gap-1.5 text-[10px] font-mono uppercase tracking-wider text-slate-500">
                    <s.Icon className={`w-3.5 h-3.5 ${s.tint}`} />
                    <span>{s.label}</span>
                  </div>
                  <div className="text-2xl font-black text-white mt-1" dir="ltr">
                    {s.value}
                  </div>
                </div>
              ))}
            </div>
          )}

          {overviewLoaded && rapidKeys && (
            <div className={`p-3.5 rounded-2xl border text-xs space-y-1.5 ${
              rapidKeys.live === 0
                ? 'bg-red-950/40 border-red-800 text-red-300'
                : rapidKeys.live < rapidKeys.total
                  ? 'bg-amber-950/40 border-amber-800 text-amber-200'
                  : 'bg-slate-900 border-slate-800 text-slate-400'
            }`}>
              <p className="font-bold uppercase font-mono text-[10px] flex items-center gap-1.5" dir="ltr">
                <span>RapidAPI keys: {rapidKeys.live}/{rapidKeys.total} live</span>
                {rapidKeys.live === 0 && <span>â€” discovery falls back to the downloader</span>}
              </p>
              <div className="flex items-center gap-2 flex-wrap" dir="ltr">
                <span className="font-mono text-[11px] text-slate-200">
                  {rapidKeys.usage ? `${rapidKeys.usage.total} requests sent` : 'requests: â€”'}
                </span>
                {rapidKeys.usage && (
                  <span className="font-mono text-[10px] text-slate-500">
                    ({rapidKeys.usage.userinfo} profile â€¢ {rapidKeys.usage.single} single
                    {rapidKeys.usage.sinceIso ? ` â€¢ since ${formatRelative(rapidKeys.usage.sinceIso)}` : ''})
                  </span>
                )}
                <button
                  onClick={resetRapidCounter}
                  disabled={rapidResetting}
                  title="Reset the sent-requests counter to 0"
                  className="ml-auto flex items-center gap-1 px-2 py-0.5 rounded-full font-mono text-[10px] border border-slate-700 text-slate-300 hover:border-slate-500 hover:text-white disabled:opacity-50 transition-colors"
                >
                  <RefreshCw className={`w-3 h-3 ${rapidResetting ? 'animate-spin' : ''}`} />
                  {rapidResetting ? 'Resettingâ€¦' : 'Reset counter'}
                </button>
              </div>
              <div className="flex flex-wrap gap-1.5" dir="ltr">
                {rapidKeys.keys.map(k => (
                  <span
                    key={k.index}
                    title={k.exhausted ? `Key #${k.index} parked (quota/rejected)` : `Key #${k.index} live`}
                    className={`px-2 py-0.5 rounded-full font-mono text-[10px] border ${
                      k.exhausted
                        ? 'bg-red-500/10 border-red-500/40 text-red-300'
                        : 'bg-emerald-500/10 border-emerald-500/40 text-emerald-300'
                    }`}
                  >
                    #{k.index} {k.prefix}
                  </span>
                ))}
              </div>
            </div>
          )}

          {overviewLoaded && reconnectConns.length > 0 && (
            <div className="p-4 rounded-2xl bg-amber-950/40 border border-amber-800 text-amber-200 text-xs space-y-1.5">
              <p className="flex items-start gap-2 font-bold">
                <AlertCircle className="w-4 h-4 shrink-0 mt-0.5" />
                <span>
                  {reconnectConns.length} channel{reconnectConns.length === 1 ? '' : 's'} need{reconnectConns.length === 1 ? 's' : ''} one YouTube reconnect
                </span>
              </p>
              <p className="text-amber-300/80 pl-6">
                Auto-comments, title rotation and retention stats stay off for them until the owner reconnects once in Profile â†’ YouTube (new permission). Uploads keep working.
              </p>
              <p className="pl-6 truncate font-mono" dir="auto">
                {reconnectConns.map(c => c.userName).join(' â€¢ ')}
              </p>
            </div>
          )}

          {(retention.length > 0 || retentionLoading) && (
            <div className="p-4 rounded-3xl bg-slate-900 border border-slate-800 space-y-3">
              <div className="flex items-center gap-2">
                <Activity className="w-4 h-4 text-sky-400" />
                <h2 className="text-sm font-black text-white uppercase font-mono">
                  Retention
                </h2>
                <span className="ml-auto text-[11px] font-mono text-slate-400" dir="ltr">
                  {retentionAt ? `updated ${formatRelative(retentionAt)}` : retentionLoading ? 'loadingâ€¦' : ''}
                </span>
              </div>
              <div className="grid grid-cols-1 md:grid-cols-2 gap-3">
                <div className="space-y-1.5">
                  <div className="text-[10px] font-mono uppercase tracking-wider text-slate-500">Top by views</div>
                  {topRetention.map(r => (
                    <div key={r.videoId} className="p-2.5 rounded-xl bg-slate-950 border border-slate-800">
                      <p className="text-xs font-bold text-white truncate" dir="auto" title={sanitizeSingleLine(r.title)}>{sanitizeSingleLine(r.title)}</p>
                      <p className="text-[10px] font-mono text-slate-400 mt-0.5" dir="ltr">
                        {formatCount(r.views)} views â€¢ avg {r.avgViewDurationSec}s â€¢{' '}
                        <span className={r.avgViewPercentage >= 50 ? 'text-emerald-400' : r.avgViewPercentage >= 30 ? 'text-amber-400' : 'text-rose-400'}>
                          {r.avgViewPercentage}%
                        </span>
                        {' '}â€¢ {r.owner.name}
                      </p>
                    </div>
                  ))}
                  {topRetention.length === 0 && <p className="text-[11px] text-slate-600">No data yet.</p>}
                </div>
                <div className="space-y-1.5">
                  <div className="text-[10px] font-mono uppercase tracking-wider text-slate-500">Needs work (lowest keep)</div>
                  {lowRetention.map(r => (
                    <div key={r.videoId} className="p-2.5 rounded-xl bg-slate-950 border border-slate-800">
                      <p className="text-xs font-bold text-white truncate" dir="auto" title={sanitizeSingleLine(r.title)}>{sanitizeSingleLine(r.title)}</p>
                      <p className="text-[10px] font-mono text-slate-400 mt-0.5" dir="ltr">
                        {formatCount(r.views)} views â€¢ avg {r.avgViewDurationSec}s â€¢{' '}
                        <span className={r.avgViewPercentage >= 50 ? 'text-emerald-400' : r.avgViewPercentage >= 30 ? 'text-amber-400' : 'text-rose-400'}>
                          {r.avgViewPercentage}%
                        </span>
                        {' '}â€¢ {r.owner.name}
                      </p>
                    </div>
                  ))}
                  {lowRetention.length === 0 && <p className="text-[11px] text-slate-600">No data yet.</p>}
                </div>
              </div>
              {retentionReconnect.length > 0 && (
                <p className="text-[11px] font-mono text-slate-500" dir="auto">
                  No retention for: {retentionReconnect.map(r => r.userName).join(' â€¢ ')} (reconnect needed)
                </p>
              )}
            </div>
          )}

          {overviewLoaded && rotations.length > 0 && (
            <div className="p-4 rounded-3xl bg-slate-900 border border-slate-800 space-y-2">
              <div className="flex items-center gap-2">
                <History className="w-4 h-4 text-slate-400" />
                <h2 className="text-sm font-black text-white uppercase font-mono">
                  Recent title rotations
                </h2>
              </div>
              {rotations.map(t => (
                <div key={t.video_id} className="text-[11px] font-mono text-slate-400 space-y-0.5">
                  <p className="truncate text-slate-500 line-through" dir="auto" title={t.old_title || ''}>{t.old_title}</p>
                  <p className="truncate text-emerald-300" dir="auto" title={t.new_title || ''}>â†’ {t.new_title}</p>
                  <p className="text-slate-600" dir="ltr">
                    {t.views_at_rotation ?? 'â€”'} views at rotation â€¢ {formatRelative(t.created_at)}
                  </p>
                </div>
              ))}
            </div>
          )}

          {overviewLoaded && (
            <div className="p-4 rounded-3xl bg-slate-900 border border-slate-800 space-y-3">
              <div className="flex items-center gap-2">
                <Activity className="w-4 h-4 text-amber-400" />
                <h2 className="text-sm font-black text-white uppercase font-mono">
                  Watch timers
                </h2>
                <span className="ml-auto text-[11px] font-mono text-slate-400" dir="ltr">
                  {watches.length} total â€¢ {attention.length} need attention
                </span>
              </div>
              {watches.length === 0 && (
                <p className="text-xs text-slate-500">No Instagram watches configured by any user yet.</p>
              )}
              {attention.length === 0 && watches.length > 0 && (
                <p className="text-xs text-emerald-300 flex items-center gap-1.5">
                  <CheckCircle2 className="w-4 h-4" />
                  All timers healthy.
                </p>
              )}
              <div className="space-y-2">
                {attention.map(w => (
                  <div key={w.id} className="p-3 rounded-2xl bg-slate-950 border border-slate-800 space-y-1.5">
                    <div className="flex flex-wrap items-center gap-2">
                      <span className="text-xs font-black text-white" dir="auto">
                        @{w.username}
                      </span>
                      <span className="text-[11px] text-slate-500" dir="auto">
                        by {w.userName}
                      </span>
                      {!w.enabled && (
                        <span className="px-1.5 py-0.5 rounded bg-slate-800 text-slate-500 text-[10px] font-mono">
                          disabled
                        </span>
                      )}
                      {w.attention.map(r => (
                        <span key={r} className="px-1.5 py-0.5 rounded bg-red-500/10 border border-red-500/30 text-red-300 text-[10px] font-mono">
                          {ATTENTION_LABELS[r] || r}
                        </span>
                      ))}
                      <span className="ml-auto text-[10px] font-mono text-slate-500" dir="ltr" title={w.nextRunAt ? formatDate(w.nextRunAt) : ''}>
                        next: {w.nextRunAt ? formatRelative(w.nextRunAt) : 'â€”'}
                      </span>
                    </div>
                    {w.lastError && (
                      <p className="text-[11px] font-mono text-amber-300/90 truncate" dir="auto" title={w.lastError}>
                        {w.lastError}
                      </p>
                    )}
                    <p className="text-[10px] font-mono text-slate-600" dir="ltr">
                      last check: {w.lastCheckAt ? formatRelative(w.lastCheckAt) : 'never'}
                      {w.dailyTimes.length > 0 ? ` â€¢ daily ${w.dailyTimes.join(', ')} (${w.dailyTz})` : ` â€¢ every ${w.intervalHours}h`}
                    </p>
                  </div>
                ))}
              </div>
            </div>
          )}

          {overviewLoaded && audit.length > 0 && (
            <div className="p-4 rounded-3xl bg-slate-900 border border-slate-800 space-y-3">
              <div className="flex items-center gap-2">
                <History className="w-4 h-4 text-slate-400" />
                <h2 className="text-sm font-black text-white uppercase font-mono">
                  Recent admin activity
                </h2>
              </div>
              <div className="space-y-1.5">
                {audit.map(a => (
                  <div key={a.id} className="flex flex-wrap items-center gap-x-3 gap-y-0.5 text-[11px] font-mono text-slate-400">
                    <span className="text-slate-500" dir="ltr" title={formatDate(a.createdAt)}>
                      {formatRelative(a.createdAt)}
                    </span>
                    <span className="font-bold text-slate-200" dir="auto">
                      {a.adminName}
                    </span>
                    <span className="px-1.5 py-0.5 rounded bg-slate-800 text-slate-300">
                      {a.action}
                    </span>
                    {a.detail && (
                      <span className="truncate text-slate-500" dir="auto" title={a.detail}>
                        {a.detail}
                      </span>
                    )}
                  </div>
                ))}
              </div>
            </div>
          )}
        </>
            </div>
          </div>
        )}

      <div className="grid grid-cols-1 sm:grid-cols-3 gap-3">
      {/* ============================ VIDEOS ============================ */}
      <div className="p-4 rounded-3xl bg-slate-900 border border-slate-800 flex items-center justify-between gap-3">
        <div className="flex items-center gap-2">
          <Film className="w-4 h-4 text-sky-400" />
          <h2 className="text-sm font-black text-white uppercase font-mono">Channel videos</h2>
        </div>
        <button onClick={() => { setVideosModalOpen(true); if (!loading) load(true); }} className="px-3 py-1.5 rounded-lg bg-slate-800 hover:bg-slate-700 text-slate-200 text-xs font-bold">
          Open
        </button>
      </div>

      {/* ============================ HEALTH ============================ */}
      <div className="p-4 rounded-3xl bg-slate-900 border border-slate-800 flex items-center justify-between gap-3">
        <div className="flex items-center gap-2">
          <Activity className="w-4 h-4 text-emerald-400" />
          <h2 className="text-sm font-black text-white uppercase font-mono">Health overview</h2>
        </div>
        <button onClick={() => { setHealthModalOpen(true); if (!overviewLoaded) { loadOverview(); loadRetention(); } }} className="px-3 py-1.5 rounded-lg bg-slate-800 hover:bg-slate-700 text-slate-200 text-xs font-bold">
          Open
        </button>
      </div>

      {/* ============================ USER MANAGEMENT ============================ */}
      <div className="p-4 rounded-3xl bg-slate-900 border border-slate-800 flex items-center justify-between gap-3">
        <div className="flex items-center gap-2">
          <UserIcon className="w-4 h-4 text-sky-400" />
          <h2 className="text-sm font-black text-white uppercase font-mono">User management</h2>
        </div>
        <button onClick={openUsersModal} className="px-3 py-1.5 rounded-lg bg-slate-800 hover:bg-slate-700 text-slate-200 text-xs font-bold">
          Manage users
        </button>
      </div>
      </div>

      {/* ============================ STORAGE PURCHASES ============================ */}
      <div className="p-4 rounded-3xl bg-slate-900 border border-slate-800 space-y-3">
        <div className="flex items-center gap-2">
          <HardDrive className="w-4 h-4 text-violet-400" />
          <h2 className="text-sm font-black text-white uppercase font-mono">Storage purchase requests</h2>
          <button onClick={loadStoragePurchases} className="ml-auto text-xs text-slate-400 hover:text-white">Refresh</button>
        </div>
        {storageLoading && <p className="text-xs text-slate-500">Loading…</p>}
        {!storageLoading && storagePurchases.length === 0 && <p className="text-xs text-slate-500">No requests.</p>}
        <div className="space-y-2">
          {storagePurchases.map((p: any) => (
            <div key={p.id} className="p-3 rounded-2xl bg-slate-950 border border-slate-800 space-y-2">
              <div className="flex items-center justify-between gap-3">
                <div className="min-w-0">
                  <p className="text-xs font-bold text-white">{p.user_name || p.user_id} • {(p.bytes_requested / (1024**3)).toFixed(2)} GB{p.months_requested ? ` • ${p.months_requested} mo` : ''}</p>
                  <p className="text-[11px] font-mono text-slate-400">{p.crypto_network} • {p.tx_hash}</p>
                  {p.proof && <p className="text-[11px] text-slate-500 truncate" title={p.proof}>{p.proof}</p>}
                </div>
                <span className={`px-2 py-0.5 rounded-full text-[10px] font-mono border ${
                  p.status === 'approved' ? 'bg-emerald-500/10 border-emerald-500/40 text-emerald-300' :
                  p.status === 'rejected' ? 'bg-red-500/10 border-red-500/40 text-red-300' :
                  'bg-amber-500/10 border-amber-500/40 text-amber-300'
                }`}>{p.status}</span>
              </div>
              {p.status === 'pending' && (
                <div className="flex items-center gap-2">
                  <button onClick={() => decidePurchase(p.id, 'approve')} className="px-3 py-1.5 rounded-lg bg-emerald-600 hover:bg-emerald-500 text-white text-xs font-bold">Approve</button>
                  <button onClick={() => decidePurchase(p.id, 'reject')} className="px-3 py-1.5 rounded-lg bg-red-600 hover:bg-red-500 text-white text-xs font-bold">Reject</button>
                </div>
              )}
            </div>
          ))}
        </div>
      </div>
      {usersModalOpen && (
        <div className="fixed inset-0 z-50 flex items-center justify-center bg-black/70 p-0">
          <div className="w-full max-w-none w-full max-h-none h-full overflow-auto rounded-3xl bg-slate-900 border border-slate-800 p-5 space-y-4">
            <div className="flex items-center justify-between">
              <h3 className="text-sm font-black text-white uppercase font-mono">User management</h3>
              <button onClick={() => setUsersModalOpen(false)} className="px-3 py-1.5 rounded-lg bg-slate-800 hover:bg-slate-700 text-slate-200 text-xs font-bold">Close</button>
            </div>
            <button onClick={loadUsers} className="text-xs text-slate-400 hover:text-white">Refresh</button>
            {usersLoading && <p className="text-xs text-slate-500">Loading…</p>}
            {!usersLoading && users.length === 0 && <p className="text-xs text-slate-500">No users.</p>}
            <div className="space-y-2">
              {users.map((u: any) => (
                <div key={u.id} className="p-3 rounded-2xl bg-slate-950 border border-slate-800 flex items-center justify-between gap-3">
                  <div className="min-w-0">
                    <p className="text-xs font-bold text-white truncate">{u.name}</p>
                    <p className="text-[11px] font-mono text-slate-400 truncate">{u.email} • {u.role}</p>
                  </div>
                  <div className="flex items-center gap-2">
                    <span className={`px-2 py-0.5 rounded-full text-[10px] font-mono border ${u.status === 'disabled' ? 'bg-red-500/10 border-red-500/40 text-red-300' : 'bg-emerald-500/10 border-emerald-500/40 text-emerald-300'}`}>{u.status}</span>
                    <button onClick={() => toggleUserStatus(u.id, u.status)} className={`px-3 py-1.5 rounded-lg text-white text-xs font-bold ${u.status === 'disabled' ? 'bg-emerald-600 hover:bg-emerald-500' : 'bg-red-600 hover:bg-red-500'}`}>
                      {u.status === 'disabled' ? 'Enable' : 'Disable'}
                    </button>
                  </div>
                </div>
              ))}
            </div>
          </div>
        </div>
      )}

    </div>
  );
};
