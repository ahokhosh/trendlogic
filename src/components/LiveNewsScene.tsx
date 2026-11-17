import React, { useEffect, useMemo, useState } from 'react';
import { NormalizedTrend } from '../types';
import { proxiedImg } from '../lib/img';
import { SmartImg } from '../lib/SmartImg';

/** ISO country code -> flag PNG (flagcdn) + display name. */
export function flagImg(code?: string | null): string {
  const c = String(code || '').trim().toLowerCase();
  if (!/^[a-z]{2}$/.test(c)) return '';
  return proxiedImg(`https://flagcdn.com/w80/${c}.png`);
}

const COUNTRY_NAMES: Record<string, string> = {
  US: 'United States', GB: 'United Kingdom', CA: 'Canada', AU: 'Australia',
  IE: 'Ireland', NZ: 'New Zealand', DE: 'Germany',
  FR: 'France', JP: 'Japan', IR: 'Iran', IT: 'Italy', ES: 'Spain',
  BR: 'Brazil', IN: 'India', CN: 'China', KR: 'South Korea',
  RU: 'Russia', UA: 'Ukraine', TR: 'Turkey', SA: 'Saudi Arabia',
  AE: 'UAE', EG: 'Egypt', NL: 'Netherlands', SE: 'Sweden', CH: 'Switzerland',
};
export function countryName(code?: string | null): string {
  const c = String(code || '').trim().toUpperCase();
  return COUNTRY_NAMES[c] || c || 'World';
}

/**
 * LiveNewsScene — the special broadcast page that goes on YouTube Live.
 *
 * A 16:9 TV-style news scene: LIVE bug, clock, the #1 trending story as a
 * hero (keyword, question, stats, verified sources), a top-trends sidebar
 * and a scrolling headlines ticker. The hero auto-rotates through the top
 * stories every ROTATE_MS so a long live never sits on one frame.
 *
 * Two modes:
 *  - embedded: parent passes `data` (used as the live preview in the
 *    Stream tab — exactly what the RTMP overlay carries as text).
 *  - standalone: <StandaloneLiveScene/> fetches /api/stream/scene itself
 *    (public, no login) and fills the screen — use its URL as an OBS
 *    Browser Source or open it fullscreen on the studio machine.
 */

export interface SceneTrend {
  keyword: string;
  question: string;
  description: string;
  category: string;
  traffic: string;
  velocity: number;
  score: number;
  volume: number;
  image: string;
  country: string;
  sources: { name: string; title: string }[];
}

export interface SceneData {
  trends: SceneTrend[];
  ticker: string;
  country: string;
}

export function trendsToScene(trends: NormalizedTrend[], country: string): SceneData {
  const top = trends.slice(0, 8);
  return {
    country,
    ticker: top.map((t, i) => `#${i + 1} ${t.keyword}`).join('   •   '),
    trends: top.map(t => ({
      keyword: t.keyword,
      question: t.primaryQuestion || `Why is ${t.keyword} trending today?`,
      description: t.description || '',
      category: t.category || 'world',
      traffic: t.rawGoogleTraffic || `${t.search_volume}K+`,
      velocity: t.velocity,
      score: t.trend_score,
      volume: t.search_volume,
      image: t.image_url || '',
      country: t.country || 'US',
      sources: (t.sources || []).slice(0, 3).map(s => ({ name: s.name, title: s.title }))
    }))
  };
}

const ROTATE_MS = 12000;

/** Shared live clock (1s tick). */
function useNow(): Date {
  const [now, setNow] = useState(() => new Date());
  useEffect(() => {
    const t = setInterval(() => setNow(new Date()), 1000);
    return () => clearInterval(t);
  }, []);
  return now;
}

export const LiveBadge: React.FC<{ small?: boolean; staticMode?: boolean }> = ({ small, staticMode }) => (
  <span
    className={`flex items-center gap-1.5 rounded-md bg-red-600 font-black tracking-widest shadow-lg shadow-red-600/40 ${
      small ? 'px-2 py-0.5 text-[10px]' : 'px-3 py-1 text-xs'
    }`}
  >
    {/* staticMode (browser-capture feed): no pulse animation — it judders at
      screencast frame rates and wastes encode bits. */}
    <span className={`${staticMode ? '' : 'tl-live-dot '}inline-block w-2 h-2 rounded-full bg-white`} />
    LIVE
  </span>
);

/** Country flag + name (flag image hides itself if unfetchable). */
export const FlagBadge: React.FC<{ code?: string | null; small?: boolean }> = ({ code, small }) => {
  const [ok, setOk] = useState(true);
  const src = flagImg(code);
  useEffect(() => {
    setOk(true);
  }, [src]);
  return (
    <span
      className={`flex items-center gap-1.5 rounded-full bg-white/10 border border-white/15 text-slate-200 font-bold ${
        small ? 'px-2 py-0.5 text-[10px]' : 'px-2.5 py-1 text-[11px]'
      }`}
      title={countryName(code)}
    >
      {src && ok ? (
        <img
          src={src}
          alt={String(code || '').toUpperCase()}
          loading="lazy"
          onError={() => setOk(false)}
          className={small ? 'w-4 h-3 rounded-[2px] object-cover' : 'w-5 h-3.5 rounded-[2px] object-cover'}
        />
      ) : (
        <span className="font-mono">{String(code || '').toUpperCase() || '••'}</span>
      )}
      <span className="uppercase tracking-wide">{countryName(code)}</span>
    </span>
  );
};

export const LiveNewsScene: React.FC<{ data: SceneData; fillScreen?: boolean; staticMode?: boolean; autoRotate?: boolean }> = ({ data, fillScreen, staticMode, autoRotate = true }) => {
  const [idx, setIdx] = useState(0);
  const now = useNow();
  const [imgOk, setImgOk] = useState(true);

  const trends = data.trends;
  // Server-driven data (rotation feed) opens on the hero and never spins
  // locally — otherwise the 12s local timer fights the server rotation.
  const heroKey = trends[0]?.keyword;
  useEffect(() => {
    setIdx(0);
  }, [heroKey]);
  useEffect(() => {
    if (!autoRotate || trends.length < 2) return;
    const t = setInterval(() => setIdx(i => (i + 1) % trends.length), ROTATE_MS);
    return () => clearInterval(t);
  }, [trends.length, autoRotate]);

  const hero = trends[idx] || trends[0];
  useEffect(() => {
    setImgOk(true);
  }, [hero?.image]);
  const showPhoto = !!hero?.image && imgOk;
  const timeStr = useMemo(
    () =>
      now.toLocaleTimeString('en-GB', { hour: '2-digit', minute: '2-digit', second: '2-digit' }),
    [now]
  );
  const dateStr = useMemo(
    () => now.toLocaleDateString('en-US', { weekday: 'long', month: 'short', day: 'numeric' }),
    [now]
  );

  if (!hero) {
    return (
      <div className="aspect-video w-full rounded-2xl bg-slate-950 border border-slate-800 flex items-center justify-center">
        <p className="text-slate-500 text-sm font-mono">No trends loaded — sync RSS first.</p>
      </div>
    );
  }

  return (
    <div className={fillScreen ? 'fixed inset-0 z-[100] bg-slate-950' : 'w-full'}>
      <style>{`
        @keyframes tl-livepulse { 0%,100% { opacity: 1; } 50% { opacity: 0.35; } }
        .tl-live-dot { animation: tl-livepulse 1.2s ease-in-out infinite; }
      `}</style>
      <div
        className={
          fillScreen
            ? 'h-full w-full flex flex-col overflow-hidden bg-slate-950 text-white'
            : 'aspect-video w-full flex flex-col overflow-hidden rounded-2xl border border-slate-700 bg-slate-950 text-white shadow-2xl'
        }
        style={{
          background: 'radial-gradient(1200px 500px at 85% -10%, rgba(220,38,38,0.28), transparent 60%), radial-gradient(900px 500px at 0% 110%, rgba(56,189,248,0.14), transparent 60%), #020617'
        }}
      >
        {/* ── Top bar ─────────────────────────────────────────── */}
        <div className="flex items-center gap-3 px-5 py-2.5 border-b border-white/10 bg-black/40">
          <LiveBadge staticMode={staticMode} />
          <span className="font-black tracking-widest text-sm">
            TRENDING <span className="text-red-500">NEWS</span>
          </span>
          <FlagBadge code={hero.country} />
          <span className="hidden sm:inline text-[11px] font-mono text-slate-400 uppercase">
            Auto-refreshing
          </span>
          <div className="ml-auto text-right leading-tight">
            <div className="font-mono font-bold text-sm tabular-nums">{timeStr}</div>
            <div className="text-[10px] font-mono text-slate-400 uppercase">{dateStr}</div>
          </div>
        </div>

        {/* ── Main ────────────────────────────────────────────── */}
        <div className={`flex-1 min-h-0 grid gap-4 px-5 py-4 ${showPhoto ? 'grid-cols-4' : 'grid-cols-3'}`}>
          {/* News photo with flag */}
          {showPhoto && (
            <div className="relative min-h-0 rounded-xl overflow-hidden border border-white/15 bg-slate-900">
              <SmartImg
                src={hero.image}
                alt={hero.keyword}
                loading="lazy"
                onHide={() => setImgOk(false)}
                className="absolute inset-0 w-full h-full object-cover"
              />
              <div className="absolute inset-x-0 bottom-0 h-2/3 bg-gradient-to-t from-black/85 to-transparent pointer-events-none" />
              <div className="absolute top-2 left-2">
                <LiveBadge small staticMode={staticMode} />
              </div>
              <div className="absolute bottom-2 left-2 right-2 flex justify-start">
                <FlagBadge code={hero.country} small />
              </div>
            </div>
          )}
          {/* Hero story */}
          <div className="col-span-2 flex flex-col justify-center min-w-0">
            <div className="flex items-center gap-2 flex-wrap">
              <span className="px-2.5 py-1 rounded-full bg-amber-400 text-slate-950 text-[11px] font-black uppercase tracking-wide">
                #{idx + 1} Trending now
              </span>
              <span className="px-2.5 py-1 rounded-full bg-white/10 border border-white/15 text-[11px] font-mono font-bold text-sky-300">
                {hero.traffic} searches
              </span>
              <span className="px-2.5 py-1 rounded-full bg-white/10 border border-white/15 text-[11px] font-mono font-bold text-slate-300 uppercase">
                {hero.category}
              </span>
            </div>
            <h1
              className="mt-2 font-black leading-[1.05] tracking-tight break-words"
              style={{ fontSize: 'clamp(22px, 4.2vw, 54px)' }}
            >
              {hero.keyword}
            </h1>
            <p className="mt-2 font-bold text-amber-300" style={{ fontSize: 'clamp(12px, 1.6vw, 22px)' }}>
              {hero.question}
            </p>
            <p className="mt-1.5 text-slate-300 line-clamp-2" style={{ fontSize: 'clamp(11px, 1.2vw, 16px)' }}>
              {hero.description}
            </p>
            <div className="mt-3 flex items-center gap-4 font-mono" style={{ fontSize: 'clamp(10px, 1.1vw, 14px)' }}>
              <span className="text-slate-400">
                Velocity <span className="text-emerald-400 font-black">{hero.velocity}</span>
              </span>
              <span className="text-slate-400">
                Score <span className="text-sky-400 font-black">{hero.score}</span>
              </span>
              {hero.volume > 0 && (
                <span className="text-slate-400">
                  Volume <span className="text-amber-300 font-black">{hero.volume}</span>
                </span>
              )}
            </div>
            {hero.sources.length > 0 && (
              <div className="mt-3 grid grid-cols-1 gap-1.5">
                {hero.sources.slice(0, 2).map((s, i) => (
                  <div key={i} className="flex items-center gap-2 min-w-0 rounded-lg bg-white/5 border border-white/10 px-3 py-1.5">
                    <span className="shrink-0 px-1.5 py-0.5 rounded bg-emerald-500/20 border border-emerald-500/40 text-emerald-300 text-[10px] font-black uppercase">
                      {s.name.slice(0, 18)}
                    </span>
                    <span className="truncate text-slate-200" style={{ fontSize: 'clamp(10px, 1.1vw, 14px)' }}>
                      {s.title}
                    </span>
                  </div>
                ))}
              </div>
            )}
          </div>

          {/* Sidebar */}
          <div className="min-h-0 flex flex-col rounded-xl bg-black/40 border border-white/10 overflow-hidden">
            <div className="px-3 py-2 text-[11px] font-black tracking-widest text-slate-300 border-b border-white/10 bg-white/5">
              TOP TRENDS
            </div>
            <div className="flex-1 min-h-0 overflow-hidden flex flex-col justify-around py-1">
              {trends.slice(0, 6).map((t, i) => (
                <div
                  key={i}
                  className={`flex items-center gap-2.5 px-3 py-1.5 transition-colors ${
                    i === idx ? 'bg-red-600/20 border-l-2 border-red-500' : 'border-l-2 border-transparent'
                  }`}
                >
                  <span
                    className={`font-mono font-black w-6 shrink-0 ${
                      i === 0 ? 'text-amber-400' : i === idx ? 'text-red-400' : 'text-slate-500'
                    }`}
                    style={{ fontSize: 'clamp(11px, 1.3vw, 17px)' }}
                  >
                    {i + 1}
                  </span>
                  <div className="min-w-0">
                    <div
                      className={`truncate font-bold ${i === idx ? 'text-white' : 'text-slate-300'}`}
                      style={{ fontSize: 'clamp(10px, 1.15vw, 15px)' }}
                    >
                      {t.keyword}
                    </div>
                    <div className="text-[10px] font-mono text-slate-500">{t.traffic}</div>
                  </div>
                </div>
              ))}
            </div>
          </div>
        </div>

        {/* ── Static source footer (no moving ticker by design) ─── */}
        <div className="border-t border-white/10 bg-black/60 py-2 px-3 flex items-center gap-2 min-w-0">
          <span className="shrink-0 px-2 py-0.5 rounded bg-emerald-600 text-[10px] font-black tracking-widest uppercase">
            {hero.sources[0]?.name.slice(0, 20) || 'Source'}
          </span>
          <span className="flex-1 truncate text-xs font-semibold text-slate-200">
            {hero.sources[0]?.title || hero.description}
          </span>
          <span className="shrink-0 hidden sm:inline text-[10px] font-mono text-slate-500 uppercase">
            Live from Google Trends
          </span>
        </div>
      </div>
    </div>
  );
};

/** Rundown info carried by GET /api/stream/scene (public). */
export interface RundownInfo {
  countries: { code: string; name: string; updatedAt: string | null; stories: { keyword: string; traffic: string; rank: number }[] }[];
  current: { countryIdx: number; storyIdx: number; code: string };
  rotateSec: number;
}

/**
 * Map the scene API payload to renderable scene data: the hero is the
 * current on-air story (rotation slot or manual pin) with its photo,
 * country and source; the list is the current country's top stories with
 * the hero pinned first so rotation always opens on air.
 */
export function scenePayloadToSceneData(json: any): { data: SceneData; rundown: RundownInfo; live: boolean } | null {
  const s = json?.scene;
  const r = json?.rundown;
  if (!s || !r) return null;
  const hero: SceneTrend = {
    keyword: String(s.keyword || 'Trending now'),
    question: String(s.question || ''),
    description: String(s.description || ''),
    category: String(s.category || 'world'),
    traffic: String(s.traffic || ''),
    velocity: Number(s.velocity) || 0,
    score: Number(s.score) || 0,
    volume: 0,
    image: String(s.imageUrl || ''),
    country: String(s.country || 'US'),
    sources: s.sourceName || s.sourceTitle
      ? [{ name: String(s.sourceName || 'Source'), title: String(s.sourceTitle || '') }]
      : []
  };
  const cur = (r.countries || []).find((c: any) => c.code === r.current?.code) || (r.countries || [])[0];
  const rows: SceneTrend[] = ((cur?.stories || []) as any[]).map((t: any) => ({
    keyword: String(t.keyword),
    question: `Why is ${t.keyword} trending today?`,
    description: '',
    category: 'trending',
    traffic: String(t.traffic || ''),
    velocity: 0,
    score: 0,
    volume: 0,
    image: String(t.keyword) === hero.keyword ? hero.image : '',
    country: String(cur?.code || hero.country),
    sources: String(t.keyword) === hero.keyword ? hero.sources : []
  }));
  if (!rows.some(t => t.keyword === hero.keyword)) rows.unshift(hero);
  return {
    data: { trends: rows.slice(0, 8), ticker: '', country: 'LIVE' },
    rundown: {
      countries: (r.countries || []).map((c: any) => ({
        code: String(c.code),
        name: String(c.name || c.code),
        updatedAt: c.updatedAt || null,
        stories: ((c.stories || []) as any[]).map((t: any) => ({
          keyword: String(t.keyword),
          traffic: String(t.traffic || ''),
          rank: Number(t.rank) || 0
        }))
      })),
      current: {
        countryIdx: Number(r.current?.countryIdx) || 0,
        storyIdx: Number(r.current?.storyIdx) || 0,
        code: String(r.current?.code || '')
      },
      rotateSec: Number(r.rotateSec) || 45
    },
    live: !!json.live
  };
}

/**
 * Vertical 9:16 broadcast scene (phone-first, Shorts feed): news photo hero
 * with LIVE + flag badges, wrapped title, question, description, stats,
 * compact top list and a static source footer. No moving ticker by design.
 */
export const LiveNewsSceneVertical: React.FC<{ data: SceneData; fillScreen?: boolean; staticMode?: boolean; autoRotate?: boolean }> = ({ data, fillScreen, staticMode, autoRotate = true }) => {
  const [idx, setIdx] = useState(0);
  const now = useNow();
  const [imgOk, setImgOk] = useState(true);

  const trends = data.trends;
  // Server-driven data (rotation feed) opens on the hero and never spins
  // locally — otherwise the 12s local timer fights the server rotation.
  const heroKey = trends[0]?.keyword;
  useEffect(() => {
    setIdx(0);
  }, [heroKey]);
  useEffect(() => {
    if (!autoRotate || trends.length < 2) return;
    const t = setInterval(() => setIdx(i => (i + 1) % trends.length), ROTATE_MS);
    return () => clearInterval(t);
  }, [trends.length, autoRotate]);

  const hero = trends[idx] || trends[0];
  useEffect(() => {
    setImgOk(true);
  }, [hero?.image]);
  const showPhoto = !!hero?.image && imgOk;
  const timeStr = useMemo(
    () => now.toLocaleTimeString('en-GB', { hour: '2-digit', minute: '2-digit' }),
    [now]
  );

  if (!hero) {
    return (
      <div className="w-full aspect-[9/16] max-h-full rounded-2xl bg-slate-950 border border-slate-800 flex items-center justify-center">
        <p className="text-slate-500 text-sm font-mono">No trends loaded — sync RSS first.</p>
      </div>
    );
  }

  const stage = (
    <div
      className={`flex flex-col overflow-hidden bg-slate-950 text-white ${
        fillScreen
          ? 'h-full aspect-[9/16] max-w-full border-x border-slate-800'
          : 'w-full max-w-[400px] aspect-[9/16] rounded-2xl border border-slate-700 shadow-2xl'
      }`}
      style={{
        background: 'radial-gradient(600px 400px at 50% -5%, rgba(220,38,38,0.25), transparent 60%), #020617'
      }}
    >
      <style>{`
        @keyframes tl-livepulse { 0%,100% { opacity: 1; } 50% { opacity: 0.35; } }
        .tl-live-dot { animation: tl-livepulse 1.2s ease-in-out infinite; }
      `}</style>
      {/* Top bar */}
      <div className="flex items-center gap-2 px-3 py-2 border-b border-white/10 bg-black/40">
        <LiveBadge small staticMode={staticMode} />
        <span className="font-black tracking-widest text-[11px]">
          TRENDING <span className="text-red-500">NEWS</span>
        </span>
        <span className="ml-auto font-mono font-bold text-[11px] tabular-nums text-slate-300">{timeStr}</span>
      </div>

      {/* News photo */}
      {showPhoto && (
        <div className="relative h-[30%] shrink-0 overflow-hidden border-b border-white/10 bg-slate-900">
          <SmartImg
            src={hero.image}
            alt={hero.keyword}
            loading="lazy"
            onHide={() => setImgOk(false)}
            className="absolute inset-0 w-full h-full object-cover"
          />
          <div className="absolute inset-0 bg-gradient-to-t from-[#020617] via-transparent to-black/30 pointer-events-none" />
          <div className="absolute bottom-2 left-2 right-2 flex items-center gap-2">
            <FlagBadge code={hero.country} small />
            <span className="px-2 py-0.5 rounded-full bg-white/10 border border-white/15 text-[10px] font-mono font-bold text-sky-300">
              {hero.traffic}
            </span>
          </div>
        </div>
      )}

      {/* Story */}
      <div className="flex-1 min-h-0 overflow-hidden flex flex-col justify-center px-4 py-3">
        <span className="self-start px-2 py-0.5 rounded-full bg-amber-400 text-slate-950 text-[10px] font-black uppercase tracking-wide">
          #{idx + 1} Trending now
        </span>
        <h1 className="mt-1.5 font-black leading-tight tracking-tight break-words text-[26px]">
          {hero.keyword}
        </h1>
        <p className="mt-1.5 font-bold text-amber-300 text-[14px] leading-snug line-clamp-3">
          {hero.question}
        </p>
        <p className="mt-1.5 text-slate-300 text-[12px] leading-relaxed line-clamp-3">
          {hero.description}
        </p>
        <div className="mt-2 flex items-center gap-3 font-mono text-[11px]">
          <span className="text-slate-400">VEL <span className="text-emerald-400 font-black">{hero.velocity}</span></span>
          <span className="text-slate-400">SCORE <span className="text-sky-400 font-black">{hero.score}</span></span>
          <span className="px-1.5 py-0.5 rounded bg-white/10 border border-white/15 text-slate-300 uppercase text-[10px]">{hero.category}</span>
        </div>
        {hero.sources.length > 0 && (
          <div className="mt-2 flex items-center gap-2 min-w-0 rounded-lg bg-white/5 border border-white/10 px-2.5 py-1.5">
            <span className="shrink-0 px-1.5 py-0.5 rounded bg-emerald-500/20 border border-emerald-500/40 text-emerald-300 text-[10px] font-black uppercase">
              {hero.sources[0].name.slice(0, 16)}
            </span>
            <span className="truncate text-slate-200 text-[11px]">{hero.sources[0].title}</span>
          </div>
        )}
      </div>

      {/* Compact top list */}
      <div className="shrink-0 border-t border-white/10 bg-black/40">
        {trends.slice(0, 4).map((t, i) => (
          <div
            key={i}
            className={`flex items-center gap-2 px-3 py-1 ${i === idx ? 'bg-red-600/20' : ''}`}
          >
            <span className={`font-mono font-black text-[11px] w-4 shrink-0 ${i === 0 ? 'text-amber-400' : 'text-slate-500'}`}>
              {i + 1}
            </span>
            <span className={`truncate font-bold text-[11px] ${i === idx ? 'text-white' : 'text-slate-300'}`}>
              {t.keyword}
            </span>
          </div>
        ))}
      </div>

      {/* Static source footer (no moving ticker by design) */}
      <div className="border-t border-white/10 bg-black/60 py-1.5 px-3 flex items-center gap-2 min-w-0">
        <span className="shrink-0 px-1.5 py-0.5 rounded bg-emerald-600 text-[9px] font-black tracking-widest uppercase">
          {hero.sources[0]?.name.slice(0, 16) || 'Source'}
        </span>
        <span className="flex-1 truncate text-[10px] font-semibold text-slate-300">
          {hero.sources[0]?.title || hero.description}
        </span>
      </div>
    </div>
  );

  if (fillScreen) {
    return (
      <div className="fixed inset-0 z-[100] bg-black flex items-center justify-center">
        {stage}
      </div>
    );
  }
  return <div className="w-full flex justify-center">{stage}</div>;
};

/**
 * Fullscreen self-loading scene: open <app>/?scene=live (vertical 9:16 by
 * default, ?scene=live&orientation=horizontal for 16:9) — usable as an OBS
 * Browser Source with no login.
 */
export const StandaloneLiveScene: React.FC = () => {
  const [parsed, setParsed] = useState<{ data: SceneData; rundown: RundownInfo; live: boolean } | null>(null);
  const [error, setError] = useState<string | null>(null);
  const [orientation] = useState<'vertical' | 'horizontal'>(() => {
    try {
      return new URLSearchParams(window.location.search).get('orientation') === 'horizontal'
        ? 'horizontal'
        : 'vertical';
    } catch {
      return 'vertical';
    }
  });
  // static=1 (browser-capture feed): freeze pulse animations — they judder
  // at screencast frame rates and waste encode bits for zero information.
  const [staticMode] = useState(() => {
    try {
      return new URLSearchParams(window.location.search).get('static') === '1';
    } catch {
      return false;
    }
  });

  useEffect(() => {
    let cancelled = false;
    const load = async () => {
      try {
        const res = await fetch('/api/stream/scene');
        if (!res.ok) throw new Error(`Scene feed ${res.status}`);
        const json = await res.json();
        if (cancelled) return;
        const mapped = scenePayloadToSceneData(json);
        if (!mapped) throw new Error('Empty rotation — warming up.');
        setParsed(mapped);
        setError(null);
      } catch (e: any) {
        if (!cancelled) setError(e?.message || 'Scene feed failed');
      }
    };
    load();
    // Track the server rotation (~10s per story): poll tight enough that no
    // story is skipped on screen, cheap enough to be irrelevant (~3 KB).
    const t = setInterval(load, 8000);
    return () => {
      cancelled = true;
      clearInterval(t);
    };
  }, []);

  if (error && !parsed) {
    return (
      <div className="fixed inset-0 z-[100] bg-slate-950 text-slate-300 flex items-center justify-center font-mono text-sm">
        Broadcast scene unavailable: {error}
      </div>
    );
  }
  if (!parsed) {
    return (
      <div className="fixed inset-0 z-[100] bg-slate-950 text-slate-400 flex items-center justify-center font-mono text-sm">
        Loading live scene…
      </div>
    );
  }
  const scene = orientation === 'horizontal'
    ? <LiveNewsScene data={parsed.data} fillScreen staticMode={staticMode} autoRotate={false} />
    : <LiveNewsSceneVertical data={parsed.data} fillScreen staticMode={staticMode} autoRotate={false} />;
  if (staticMode) return <>{scene}</>;
  return (
    <>
      {scene}
      {/* Country strip: which feeds the rotation covers (current highlighted). */}
      <div className="fixed bottom-0 inset-x-0 z-[101] flex items-center justify-center gap-1.5 py-1.5 bg-black/70 border-t border-white/10 overflow-x-auto">
        {parsed.rundown.countries.map(c => {
          const cur = c.code === parsed.rundown.current.code;
          return (
            <span
              key={c.code}
              className={`flex items-center gap-1 px-2 py-0.5 rounded-full text-[10px] font-black border shrink-0 ${
                cur ? 'bg-red-600/80 border-red-400 text-white' : 'bg-white/5 border-white/15 text-slate-300'
              }`}
              title={`${c.name} — ${c.stories.length} stories`}
            >
              <span className="font-mono">{c.code}</span>
              <span className="hidden sm:inline">{c.name}</span>
              <span className="font-mono opacity-70">{c.stories.length}</span>
            </span>
          );
        })}
        <span className="shrink-0 text-[10px] font-mono text-slate-500">
          rotates every {parsed.rundown.rotateSec}s{parsed.live ? ' • ON AIR' : ''}
        </span>
      </div>
    </>
  );
};
