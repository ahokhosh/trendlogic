import { fetchTrendingNow } from './trendingNowService.js';
import { fetchGoogleTrendsRSS } from './googleTrendsService.js';
import { pickPlayableImage } from './imageProxy.js';
import type { NormalizedTrend } from '../src/types.js';
import type { LiveTrendSnapshot } from './liveStreamService.js';

// ---------------------------------------------------------------------------
// Live rundown: the broadcast never sits still. N important countries × top 5
// highest-volume stories each, rotating story-by-story on a timer (country
// rolls over when its 5 are done), so the viewer always sees a fresh page.
//
// Data refreshes every LIVE_RUNDOWN_REFRESH_MIN (default 10) from the same
// live feeds as the app (Trending Now, RSS fallback). Rotation runs in this
// process via startRundownLoop() — boot starts it once, no client needed.
// ---------------------------------------------------------------------------

export interface RundownCountry {
  code: string;
  name: string;
  stories: NormalizedTrend[];
  updatedAt: string | null;
}

export interface RundownPointer {
  countryIdx: number;
  storyIdx: number;
}

const COUNTRY_NAMES: Record<string, string> = {
  US: 'United States', GB: 'United Kingdom', CA: 'Canada', AU: 'Australia',
  IE: 'Ireland', NZ: 'New Zealand', IR: 'Iran', DE: 'Germany',
  FR: 'France', JP: 'Japan', IT: 'Italy', ES: 'Spain',
  BR: 'Brazil', IN: 'India', TR: 'Turkey', SA: 'Saudi Arabia',
  AE: 'UAE', NL: 'Netherlands', KR: 'South Korea',
};

function resolveCountries(): string[] {
  // English-speaking feeds only (US, UK, Canada, Australia, Ireland) —
  // one language for narration, cards and Shorts audience.
  const raw = String(process.env.LIVE_COUNTRIES || 'US,GB,CA,AU,IE');
  const seen = new Set<string>();
  const out: string[] = [];
  for (const part of raw.split(',')) {
    const c = part.trim().toUpperCase();
    if (/^[A-Z]{2}$/.test(c) && !seen.has(c) && out.length < 8) {
      seen.add(c);
      out.push(c);
    }
  }
  return out.length > 0 ? out : ['US'];
}

export function rundownRotateSec(): number {
  const v = parseInt(process.env.LIVE_ROTATE_SEC || '10', 10);
  if (!isFinite(v)) return 10;
  return Math.min(600, Math.max(5, v));
}

function rundownRefreshMs(): number {
  const v = parseFloat(process.env.LIVE_RUNDOWN_REFRESH_MIN || '10');
  if (!isFinite(v)) return 10 * 60 * 1000;
  return Math.min(120, Math.max(3, v)) * 60 * 1000;
}

let countries: RundownCountry[] = resolveCountries().map(code => ({
  code,
  name: COUNTRY_NAMES[code] || code,
  stories: [],
  updatedAt: null,
}));
let pointer: RundownPointer = { countryIdx: 0, storyIdx: 0 };
let rotateTimer: NodeJS.Timeout | null = null;
let refreshTimer: NodeJS.Timeout | null = null;
let refreshing = false;

const byVolume = (a: NormalizedTrend, b: NormalizedTrend) =>
  (Number(b.search_volume) || 0) - (Number(a.search_volume) || 0) ||
  (Number(b.trend_score) || 0) - (Number(a.trend_score) || 0);

/** A hanging feed must never wedge the rotation: cap every fetch. */
function withFeedTimeout<T>(p: Promise<T>, ms: number, code: string): Promise<T> {
  let timer: NodeJS.Timeout | null = null;
  const timeout = new Promise<T>((_, reject) => {
    timer = setTimeout(() => reject(new Error(`feed timeout (${ms}ms)`)), ms);
    (timer as any)?.unref?.();
  });
  return Promise.race([p, timeout]).finally(() => {
    if (timer) clearTimeout(timer);
  });
}

const FEED_TIMEOUT_MS = 45000;

async function fetchCountryTop5(code: string): Promise<NormalizedTrend[]> {
  let list: NormalizedTrend[] = [];
  try {
    list = await withFeedTimeout(fetchTrendingNow(code, 24, { maxTrends: 12, maxNewsTrends: 6 }), FEED_TIMEOUT_MS, code);
  } catch (err) {
    console.warn(`[Rundown] Trending Now failed for ${code}, RSS fallback:`, (err as Error)?.message || err);
  }
  if (list.length === 0) {
    try {
      list = await withFeedTimeout(fetchGoogleTrendsRSS(code), FEED_TIMEOUT_MS, code);
    } catch (err) {
      console.warn(`[Rundown] RSS fallback failed for ${code}:`, (err as Error)?.message || err);
    }
  }
  // Highest search volume first — the 5 stories viewers actually search.
  return [...list].sort(byVolume).slice(0, 5);
}

/** Refresh every country's top 5 (parallel). Failed countries keep last data. */
export async function refreshRundownNow(): Promise<void> {
  if (refreshing) return;
  refreshing = true;
  try {
    const results = await Promise.allSettled(countries.map(c => fetchCountryTop5(c.code)));
    results.forEach((r, i) => {
      if (r.status === 'fulfilled' && r.value.length > 0) {
        countries[i] = { ...countries[i], stories: r.value, updatedAt: new Date().toISOString() };
      }
    });
    const filled = countries.filter(c => c.stories.length > 0).length;
    console.log(`[Rundown] refreshed ${filled}/${countries.length} countries (${countries.map(c => `${c.code}:${c.stories.length}`).join(' ')}).`);
    clampPointer();
  } finally {
    refreshing = false;
  }
}

function liveCountries(): RundownCountry[] {
  const filled = countries.filter(c => c.stories.length > 0);
  return filled.length > 0 ? filled : countries;
}

function clampPointer(): void {
  const list = liveCountries();
  if (pointer.countryIdx >= list.length) pointer = { countryIdx: 0, storyIdx: 0 };
  const stories = list[pointer.countryIdx]?.stories.length || 1;
  if (pointer.storyIdx >= stories) pointer.storyIdx = 0;
}

/** Advance one story; roll over to the next country when its 5 are done. */
export function advanceRundown(): RundownPointer {
  const list = liveCountries();
  if (list.length === 0) return pointer;
  let { countryIdx, storyIdx } = pointer;
  // Map the pointer onto the live list (countries may have filled in).
  countryIdx = Math.min(countryIdx, list.length - 1);
  storyIdx++;
  if (storyIdx >= (list[countryIdx]?.stories.length || 1)) {
    storyIdx = 0;
    countryIdx = (countryIdx + 1) % list.length;
  }
  pointer = { countryIdx, storyIdx };
  // Translate back to the master index for stability across refreshes.
  const code = list[countryIdx]?.code;
  const master = countries.findIndex(c => c.code === code);
  if (master >= 0) pointer = { countryIdx: master, storyIdx };
  return { ...pointer };
}

export function getRundownPointer(): RundownPointer {
  return { ...pointer };
}

/** Next slot WITHOUT advancing (prefetch uses it so every story speaks and
 *  shows on time). Mirrors advanceRundown's mapping exactly. */
export function peekNextStory(): { story: NormalizedTrend; country: RundownCountry } | null {
  const list = liveCountries();
  if (list.length === 0) return null;
  let ci = Math.min(pointer.countryIdx, list.length - 1);
  let si = pointer.storyIdx + 1;
  if (si >= (list[ci]?.stories.length || 1)) {
    si = 0;
    ci = (ci + 1) % list.length;
  }
  const code = list[ci]?.code;
  const master = countries.findIndex(c => c.code === code);
  const country = master >= 0 ? countries[master] : list[ci];
  const story = country?.stories[Math.min(si, (country?.stories.length || 1) - 1)];
  if (!country || !story) return null;
  return { story, country };
}

export function getRundownCountries(): RundownCountry[] {
  return countries;
}

/** Current on-air story (or the pinned manual topic when given). */
export function getRundownSnapshot(pinnedKeyword?: string | null): LiveTrendSnapshot | null {
  const pin = String(pinnedKeyword || '').trim().toLowerCase();
  if (pin) {
    for (const c of countries) {
      const hit = c.stories.find(t => t.keyword.toLowerCase() === pin);
      if (hit) return snapshotFromTrend(hit, c.stories);
    }
    return null;
  }
  const list = liveCountries();
  const cur = list[Math.min(pointer.countryIdx, list.length - 1)];
  if (!cur || cur.stories.length === 0) return null;
  const story = cur.stories[Math.min(pointer.storyIdx, cur.stories.length - 1)];
  return snapshotFromTrend(story, cur.stories);
}

export function snapshotFromTrend(t: NormalizedTrend, list: NormalizedTrend[]): LiveTrendSnapshot {
  const fmt = (x: NormalizedTrend): string => x.rawGoogleTraffic || `${x.search_volume}K+`;
  // Cover: Google-hosted first (list order), skipping hosts under cooldown
  // (recent 403/410) — a story whose only photo refuses simply airs the
  // honest fallback instead of a broken fetch every 10 seconds.
  const cover = pickPlayableImage([t.image_url, ...(t.storyImageUrls || [])]);
  return {
    keyword: t.keyword,
    question: t.primaryQuestion || `Why is ${t.keyword} trending today?`,
    description: t.description || '',
    category: t.category || 'world',
    traffic: fmt(t),
    velocity: t.velocity,
    score: t.trend_score,
    ticker: list.slice(0, 8).map((x, i) => `#${i + 1} ${x.keyword}`).join('   •   '),
    topList: list.slice(0, 10).map((x, i) => ({ rank: i + 1, keyword: x.keyword, traffic: fmt(x) })),
    imageUrl: cover || null,
    country: t.country || 'US',
    sourceName: t.sources?.[0]?.name || 'Google Trends',
    sourceTitle: t.sources?.[0]?.title || t.description || '',
  };
}

/** Public shape for the scene API + story selector (lightweight). */
export function getRundownPublic(): {
  countries: { code: string; name: string; updatedAt: string | null; stories: { keyword: string; traffic: string; rank: number }[] }[];
  current: { countryIdx: number; storyIdx: number; code: string };
  rotateSec: number;
} {
  const list = liveCountries();
  const cur = list[Math.min(pointer.countryIdx, list.length - 1)];
  return {
    countries: countries.map(c => ({
      code: c.code,
      name: c.name,
      updatedAt: c.updatedAt,
      stories: c.stories.map((t, i) => ({
        keyword: t.keyword,
        traffic: t.rawGoogleTraffic || `${t.search_volume}K+`,
        rank: i + 1,
      })),
    })),
    current: {
      countryIdx: pointer.countryIdx,
      storyIdx: pointer.storyIdx,
      code: cur?.code || countries[0]?.code || 'US',
    },
    rotateSec: rundownRotateSec(),
  };
}

/**
 * Boot once: initial fetch, then rotate stories every LIVE_ROTATE_SEC and
 * refresh data every LIVE_RUNDOWN_REFRESH_MIN. onSlot fires after every
 * advance (the live engine repaints the overlay from it).
 */
export function startRundownLoop(onSlot: () => void): void {
  if (rotateTimer) return; // already running
  void refreshRundownNow().catch(() => {});
  const rotateMs = rundownRotateSec() * 1000;
  rotateTimer = setInterval(() => {
    try {
      advanceRundown();
      onSlot();
    } catch (err) {
      console.warn('[Rundown] advance note:', (err as Error)?.message || err);
    }
  }, rotateMs);
  (rotateTimer as any)?.unref?.();
  refreshTimer = setInterval(() => {
    void refreshRundownNow().catch(() => {});
  }, rundownRefreshMs());
  (refreshTimer as any)?.unref?.();
  console.log(`[Rundown] loop armed — rotate every ${rundownRotateSec()}s across ${countries.map(c => c.code).join(',')}; data refresh every ${Math.round(rundownRefreshMs() / 60000)}m.`);
}
