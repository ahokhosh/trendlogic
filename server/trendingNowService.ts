import { NormalizedTrend, TrendSource } from '../src/types';
// Image-URL policy lives in ONE place (server/imageProxy.ts) so UI,
// rundown, cards and renders can never disagree about which photo wins.
import { googleFirst, isBannedPhotoHost } from './imageProxy.js';

// ---------------------------------------------------------------------------
// Trending Now feed: the SAME batchexecute RPC the Trending Now page itself
// calls (geo, language, window) — 500+ rows for US/24h with volume buckets,
// growth %, start time, category ids and breakdown keywords. The public RSS
// feed only publishes ~10/day, so this is the real list.
// No browser, no login: warm the NID cookie, POST f.req, parse 13-slot rows.
// ---------------------------------------------------------------------------

const UA = 'Mozilla/5.0 (Windows NT 10.0; Win64; x64) AppleWebKit/537.36 (KHTML, like Gecko) Chrome/126.0.0.0 Safari/537.36';
const RPC_ID = 'i0OFE';

const GEO_NAMES: Record<string, string> = {
  US: 'United States', GB: 'United Kingdom', CA: 'Canada', AU: 'Australia',
  IN: 'India', DE: 'Germany', FR: 'France', BR: 'Brazil', JP: 'Japan', MX: 'Mexico',
};

// Google's own category ids (from the Trending Now page filter menu).
const CATEGORY_IDS: Record<number, NormalizedTrend['category']> = {
  17: 'sports', 18: 'technology', 4: 'entertainment', 3: 'business',
  15: 'science', 10: 'world', 14: 'world',
};

function categoryFromIds(ids: number[], text: string): NormalizedTrend['category'] {
  for (const id of ids || []) {
    const mapped = CATEGORY_IDS[id];
    if (mapped) return mapped;
  }
  const lower = text.toLowerCase();
  if (/football|soccer|tennis|nba|nfl|mlb|match|championship|cup|olympic|f1|racing|player|coach|stadium|boxing|mls|golf/i.test(lower)) return 'sports';
  if (/ai\b|robot|openai|google|apple|samsung|microsoft|nvidia|software|chip|cyber|tech\b|iphone|android|space|nasa|tesla/i.test(lower)) return 'technology';
  if (/movie|film|trailer|actor|actress|singer|song|album|concert|hollywood|series|netflix|disney|celebrity|music/i.test(lower)) return 'entertainment';
  if (/stock|market|nasdaq|crypto|bitcoin|inflation|fed|bank|economy|revenue|wall street|earnings/i.test(lower)) return 'business';
  if (/science|research|telescope|quantum|fossil|study|earthquake|discovery|planet/i.test(lower)) return 'science';
  return 'world';
}

export function volumeLabel(volume: number): string {
  if (volume >= 1000000) {
    const m = volume / 1000000;
    return `${Number.isInteger(m) ? m : m.toFixed(1)}M+`;
  }
  if (volume >= 1000) {
    const k = volume / 1000;
    return `${Number.isInteger(k) ? k : k.toFixed(1)}K+`;
  }
  return `${volume}+`;
}

function velocityFor(volume: number): number {
  if (volume >= 1000000) return 99;
  if (volume >= 500000) return 97;
  if (volume >= 200000) return 95;
  if (volume >= 100000) return 93;
  if (volume >= 50000) return 91;
  if (volume >= 20000) return 88;
  if (volume >= 10000) return 86;
  if (volume >= 5000) return 84;
  if (volume >= 2000) return 82;
  if (volume >= 1000) return 80;
  if (volume >= 500) return 78;
  return 75;
}

export interface TrendingNowRow {
  query: string;
  normalizedQuery: string;
  geo: string;
  startedEpoch: number | null;
  endedEpoch: number | null;
  volume: number;
  growth: number;
  breakdown: string[];
  categoryIds: number[];
}

function parseRows(payload: any): TrendingNowRow[] {
  const rows = Array.isArray(payload?.[1]) ? payload[1] : [];
  const out: TrendingNowRow[] = [];
  for (const r of rows) {
    if (!Array.isArray(r) || typeof r[0] !== 'string') continue;
    out.push({
      query: r[0],
      normalizedQuery: typeof r[12] === 'string' ? r[12] : r[0],
      geo: typeof r[2] === 'string' ? r[2] : 'US',
      startedEpoch: Array.isArray(r[3]) && typeof r[3][0] === 'number' ? r[3][0] : null,
      endedEpoch: Array.isArray(r[4]) && typeof r[4][0] === 'number' ? r[4][0] : null,
      volume: typeof r[6] === 'number' ? r[6] : 0,
      growth: typeof r[8] === 'number' ? r[8] : 0,
      breakdown: Array.isArray(r[9]) ? r[9].filter((x: any) => typeof x === 'string') : [],
      categoryIds: Array.isArray(r[10]) ? r[10].filter((x: any) => typeof x === 'number') : [],
    });
  }
  return out;
}

async function fetchFeedRows(geo: string, hours: number, hl: string): Promise<TrendingNowRow[]> {
  const jar: Record<string, string> = {};
  const store = (res: Response) => {
    const raw = res.headers.getSetCookie ? res.headers.getSetCookie() : [];
    for (const c of raw) {
      const m = /^([^=]+)=([^;]*)/.exec(c);
      if (m) jar[m[1]] = m[2];
    }
  };
  const cookies = () => Object.entries(jar).map(([k, v]) => `${k}=${v}`).join('; ');
  const withTimeout = async (url: string, init: RequestInit, ms: number): Promise<Response> => {
    const ctrl = new AbortController();
    const t = setTimeout(() => ctrl.abort(), ms);
    try {
      return await fetch(url, { ...init, signal: ctrl.signal });
    } finally {
      clearTimeout(t);
    }
  };

  // Warmup: batchexecute answers 405 but sets the NID cookie anyway.
  try {
    const w = await withTimeout('https://trends.google.com/_/TrendsUi/data/batchexecute', { headers: { 'User-Agent': UA } }, 10000);
    store(w);
  } catch { /* cookie-less attempt below */ }

  const reqId = Math.floor(Math.random() * 900000) + 100000;
  const args = [null, null, geo.toUpperCase(), 0, hl, hours];
  const freq = [[[RPC_ID, JSON.stringify(args), null, 'generic']]];
  const url = `https://trends.google.com/_/TrendsUi/data/batchexecute?rpcids=${RPC_ID}&_reqid=${reqId}`;
  const r = await withTimeout(url, {
    method: 'POST',
    headers: {
      'User-Agent': UA,
      'Content-Type': 'application/x-www-form-urlencoded;charset=utf-8',
      ...(cookies() ? { Cookie: cookies() } : {}),
    },
    body: new URLSearchParams({ 'f.req': JSON.stringify(freq) }),
  }, 25000);
  if (!r.ok) throw new Error(`Trending Now feed HTTP ${r.status}`);
  const text = await r.text();
  const start = text.indexOf('\n\n');
  const top = JSON.parse(start >= 0 ? text.slice(start + 2) : text);
  const entry = Array.isArray(top) ? top.find((e: any) => e?.[1] === RPC_ID) : null;
  if (!entry || typeof entry[2] !== 'string') throw new Error('Trending Now feed returned no rows');
  return parseRows(JSON.parse(entry[2]));
}

// Google News RSS search: keyless, stable — titles/URLs/sources per trend.
// The feed rows carry only article ids (separate RPC), so this fills sources.
async function fetchNewsForQuery(query: string, geo: string, hl: string): Promise<TrendSource[]> {
  const ctrl = new AbortController();
  const t = setTimeout(() => ctrl.abort(), 9000);
  try {
    const url = `https://news.google.com/rss/search?q=${encodeURIComponent(`"${query}"`)}&hl=${encodeURIComponent(hl)}&gl=${geo}&ceid=${geo}%3Aen`;
    const r = await fetch(url, { headers: { 'User-Agent': UA }, signal: ctrl.signal });
    if (!r.ok) return [];
    const xml = await r.text();
    const items = xml.match(/<item>([\s\S]*?)<\/item>/g) || [];
    const out: TrendSource[] = [];
    for (const it of items.slice(0, 3)) {
      const titleRaw = (it.match(/<title>([\s\S]*?)<\/title>/)?.[1] || '').replace(/<!\[CDATA\[([\s\S]*?)\]\]>/g, '$1').trim();
      const link = (it.match(/<link>([\s\S]*?)<\/link>/)?.[1] || '').trim();
      const pub = (it.match(/<pubDate>([\s\S]*?)<\/pubDate>/)?.[1] || '').trim();
      const srcName = (it.match(/<source[^>]*>([\s\S]*?)<\/source>/)?.[1] || '').trim();
      if (!titleRaw) continue;
      // Titles arrive as "Headline - Publisher".
      let title = titleRaw;
      let name = srcName || 'Google News';
      const dash = titleRaw.lastIndexOf(' - ');
      if (dash > 0) {
        title = titleRaw.slice(0, dash).trim();
        if (!srcName) name = titleRaw.slice(dash + 3).trim();
      }
      out.push({
        title,
        name,
        url: link || `https://news.google.com/search?q=${encodeURIComponent(query)}`,
        publishedAt: pub || new Date().toISOString(),
        snippet: title,
        credibilityScore: 96,
      });
    }
    return out;
  } catch {
    return [];
  } finally {
    clearTimeout(t);
  }
}

function normImgKey(s: string): string {
  // Apostrophes are stripped WITHOUT inserting a space ("Widow's Bay" ->
  // "widows bay") so possessive/plural wording still exact-matches the
  // same story under a different title form.
  return (s || '').toLowerCase().replace(/[''ʼ`]/g, '').replace(/[^a-z0-9\u0600-\u06FF]+/gi, ' ').trim();
}

const IMG_STOP = new Set(['the', 'and', 'with', 'from', 'that', 'this', 'what', 'when', 'today', 'latest', 'live', 'news', 'update', 'updates', 'video', 'vs', 'versus']);

function queryTokens(s: string): string[] {
  return normImgKey(s).split(' ').filter(w => w.length >= 4 && !IMG_STOP.has(w));
}

// Fuzzy match: Trending Now query wording often differs from the Daily RSS
// item title for the SAME story ("Denver Broncos vs Cleveland Browns" vs
// "Browns vs Broncos", "widows bay" vs "Widow's Bay"). Exact map lookup
// misses, then the cover would stay empty though Google has the photo.
// Try exact, then substring both ways, then best token-overlap (needs >=2
// shared tokens or all query tokens when the query is short).
function findGooglePicsForQuery(query: string, rssPics: Map<string, string[]>): string[] {
  const key = normImgKey(query);
  if (!key) return [];
  const exact = rssPics.get(key);
  if (exact?.length) return exact;
  for (const [k, pics] of rssPics) {
    if (!pics.length) continue;
    if (k.includes(key) || key.includes(k)) return pics;
  }
  const qt = queryTokens(query);
  if (qt.length === 0) return [];
  let best: string[] = [];
  let bestScore = 0;
  for (const [k, pics] of rssPics) {
    if (!pics.length) continue;
    const kt = new Set(queryTokens(k));
    let score = 0;
    for (const t of qt) if (kt.has(t)) score++;
    if (score > bestScore) { bestScore = score; best = pics; }
  }
  const need = qt.length <= 2 ? qt.length : 2;
  return bestScore >= need ? best : [];
}

// Google's OWN photos from the official Daily Trends RSS (same geo):
// ht:picture per item plus every ht:news_item_title/ht:news_item_picture
// pair (parsed together so each story headline keeps its own photo).
// Never throws (empty result on any failure).
interface RssPictures {
  byKeyword: Map<string, string[]>;
  newsItems: { title: string; pic: string }[];
}
async function fetchGoogleRssPictures(geo: string): Promise<RssPictures> {
  const out: RssPictures = { byKeyword: new Map(), newsItems: [] };
  const ctrl = new AbortController();
  const t = setTimeout(() => ctrl.abort(), 12000);
  try {
    const r = await fetch(`https://trends.google.com/trending/rss?geo=${encodeURIComponent(geo)}`, {
      headers: { 'User-Agent': UA, 'Accept': 'application/rss+xml, application/xml, text/xml, */*' },
      signal: ctrl.signal,
    });
    if (!r.ok) return out;
    const xml = await r.text();
    const items = xml.match(/<item>([\s\S]*?)<\/item>/g) || [];
    for (const it of items) {
      const title = (it.match(/<title>([\s\S]*?)<\/title>/)?.[1] || '')
        .replace(/<!\[CDATA\[([\s\S]*?)\]\]>/g, '$1').replace(/&amp;/g, '&').trim();
      if (!title) continue;
      const pics: string[] = [];
      const main = (it.match(/<ht:picture>([\s\S]*?)<\/ht:picture>/)?.[1] || '').trim();
      if (main.startsWith('http')) pics.push(main);
      const blocks = it.match(/<ht:news_item>([\s\S]*?)<\/ht:news_item>/g) || [];
      for (const b of blocks) {
        const nt = (b.match(/<ht:news_item_title>([\s\S]*?)<\/ht:news_item_title>/)?.[1] || '')
          .replace(/<!\[CDATA\[([\s\S]*?)\]\]>/g, '$1').replace(/&amp;/g, '&').trim();
        const np = (b.match(/<ht:news_item_picture>([\s\S]*?)<\/ht:news_item_picture>/)?.[1] || '').trim();
        if (np.startsWith('http')) {
          if (!pics.includes(np)) pics.push(np);
          if (nt) out.newsItems.push({ title: nt, pic: np });
        }
      }
      if (pics.length > 0) out.byKeyword.set(normImgKey(title), pics);
    }
  } catch {
    /* RSS unreachable — covers stay empty (no fake photo) */
  } finally {
    clearTimeout(t);
  }
  return out;
}

// Same-story match: a trend source headline often words the story
// differently than the RSS item keyword ("Monroe County BOE ..." vs the
// trend query), but matches an RSS news_item_title — that item's Google
// photo then belongs to this exact story. Needs >=2 shared tokens
// (or all tokens when the headline is short).
function findStoryPicForTitle(title: string, newsItems: { title: string; pic: string }[]): string {
  const qt = queryTokens(title);
  if (qt.length === 0) return '';
  const need = qt.length <= 2 ? qt.length : 2;
  let best = '';
  let bestScore = 0;
  for (const n of newsItems) {
    const kt = new Set(queryTokens(n.title));
    let score = 0;
    for (const t of qt) if (kt.has(t)) score++;
    if (score > bestScore) {
      bestScore = score;
      best = n.pic;
    }
  }
  return bestScore >= need ? best : '';
}

// Story photos for a trend query via image search (keyless, server-side):
// fresh news photos of the exact story ("In the news" card photos cannot be
// fetched server-side — Google serves them only to its JS frontend — so the
// same stories' web photos are used). Never throws.
const storyPhotoCache = new Map<string, string[]>();
async function fetchStoryPhotos(query: string): Promise<string[]> {
  const cached = storyPhotoCache.get(query);
  if (cached !== undefined) return cached;
  const ctrl = new AbortController();
  const t = setTimeout(() => ctrl.abort(), 20000);
  try {
    const r1 = await fetch(
      'https://duckduckgo.com/?q=' + encodeURIComponent(query) + '&iar=images&iax=images&ia=images',
      { headers: { 'User-Agent': UA }, signal: ctrl.signal }
    );
    const h1 = await r1.text();
    const vqd = h1.match(/vqd="([^"]+)"/)?.[1] || h1.match(/vqd='([^']+)'/)?.[1];
    if (!vqd) {
      storyPhotoCache.set(query, []);
      return [];
    }
    const u = 'https://duckduckgo.com/i.js?l=us-en&o=json&q=' + encodeURIComponent(query)
      + '&vqd=' + vqd + '&f=,,,,,&p=1&v7exp=a';
    const r2 = await fetch(u, {
      headers: { 'User-Agent': UA, Referer: 'https://duckduckgo.com/', Accept: 'application/json' },
      signal: ctrl.signal,
    });
    if (!r2.ok) {
      storyPhotoCache.set(query, []);
      return [];
    }
    const j: any = await r2.json();
    const out: string[] = [];
    const seen = new Set<string>();
    for (const x of j?.results || []) {
      const img = String(x?.image || '').trim();
      if (!img.startsWith('http') || seen.has(img)) continue;
      // No Unsplash stock, ever — last-resort web photos only.
      if (isBannedPhotoHost(img)) continue;
      seen.add(img);
      out.push(img);
      if (out.length >= 6) break;
    }
    storyPhotoCache.set(query, out);
    return out;
  } catch {
    storyPhotoCache.set(query, []);
    return [];
  } finally {
    clearTimeout(t);
  }
}

// Fill every source's `picture`: RSS item pictures first (Google's own
// photo for the story), then the story's web photos (bounded; never throws).
async function enrichSourcesWithStoryPhotos(
  byQuery: Map<string, { sources: TrendSource[]; rssPics: string[] }>,
  rssNews: { title: string; pic: string }[],
  onLog?: (msg: string) => void
): Promise<Map<string, string[]>> {
  const queries = [...byQuery.keys()];
  const photoMap = new Map<string, string[]>();
  const deadline = Date.now() + 90000;
  const sleep = (ms: number) => new Promise(r => setTimeout(r, ms));
  for (const q of queries) {
    if (Date.now() > deadline) break;
    if (storyPhotoCache.has(q)) {
      photoMap.set(q, storyPhotoCache.get(q) || []);
      continue;
    }
    photoMap.set(q, await fetchStoryPhotos(q));
    await sleep(1000);
  }
  let filled = 0;
  let total = 0;
  for (const [q, entry] of byQuery) {
    const photos = googleFirst(photoMap.get(q) || []);
    let pi = 0;
    for (const s of entry.sources) {
      total++;
      if (s.picture) continue;
      const rss = entry.rssPics.find(u => !entry.sources.some(o => o.picture === u));
      if (rss) {
        s.picture = rss;
        filled++;
        continue;
      }
      // Same story in the Daily RSS under different wording: the Google
      // photo of that RSS news item belongs to this exact story.
      const story = findStoryPicForTitle(`${s.title} ${s.name}`, rssNews);
      if (story && !entry.sources.some(o => o.picture === story)) {
        s.picture = story;
        filled++;
        continue;
      }
      const pick = photos.find(p => !entry.sources.some(o => o.picture === p))
        || (photos.length > 0 ? photos[pi % photos.length] : undefined);
      if (pick) {
        s.picture = pick;
        pi++;
        filled++;
      }
    }
  }
  onLog?.(`[Trends] attached ${filled}/${total} story photos`);
  return photoMap;
}

export async function fetchTrendingNow(
  geo = 'US',
  hours = 24,
  opts?: { maxNewsTrends?: number; maxTrends?: number; hl?: string; onLog?: (msg: string) => void }
): Promise<NormalizedTrend[]> {
  const hl = opts?.hl || 'en-US';
  const allRows = await fetchFeedRows(geo, hours, hl);
  // Only the head of the list — the app shows the top trends, not hundreds.
  const rows = allRows.slice(0, opts?.maxTrends ?? 10);
  // Google's own order is the rank — keep it (do NOT re-sort).
  const maxNews = Math.min(opts?.maxNewsTrends ?? 10, rows.length);
  const newsBudget = Date.now() + 25000;
  const newsCache = new Map<string, TrendSource[]>();

  // Enrich the head of the list with real news (bounded concurrency + budget).
  const head = rows.slice(0, maxNews);
  const CONC = 6;
  for (let i = 0; i < head.length; i += CONC) {
    if (Date.now() > newsBudget) break;
    const batch = head.slice(i, i + CONC);
    const results = await Promise.all(batch.map(r => fetchNewsForQuery(r.query, geo.toUpperCase(), hl)));
    batch.forEach((r, j) => newsCache.set(r.query, results[j]));
  }

  // Photos for each trend, in priority order (never a random stock photo):
  //  1. ht:picture / ht:news_item_picture from the official Daily Trends RSS
  //     item with the same keyword (the trend's OWN Google photo -> shot 0).
  //  2. The Google photo of the Daily RSS news item covering the SAME STORY
  //     (matched by headline when the wording differs from the query).
  //  3. Fresh web photos of the exact story (per-query image search).
  const rss = await fetchGoogleRssPictures(geo.toUpperCase());
  const imgCache = new Map<string, string>();
  for (const r of rows) {
    const google = findGooglePicsForQuery(r.query, rss.byKeyword);
    imgCache.set(r.query, google[0] || '');
  }

  // Attach story photos to every collected source (bounded). RSS pictures
  // (Google-hosted) sort ahead of everything downstream automatically.
  const byQuery = new Map<string, { sources: TrendSource[]; rssPics: string[] }>();
  for (const r of rows) {
    byQuery.set(r.query, {
      sources: newsCache.get(r.query) || [],
      rssPics: googleFirst(findGooglePicsForQuery(r.query, rss.byKeyword)),
    });
  }
  const storyPhotos = await enrichSourcesWithStoryPhotos(byQuery, rss.newsItems, opts?.onLog);

  return rows.map((r, idx) => {
    const label = volumeLabel(r.volume);
    const velocity = velocityFor(r.volume);
    const startedIso = r.startedEpoch ? new Date(r.startedEpoch * 1000).toISOString() : new Date().toISOString();
    const sources = newsCache.get(r.query) || [];
    const breakdownBit = r.breakdown.length > 1
      ? ` Related searches: ${r.breakdown.slice(1, 6).join(', ')}.`
      : '';
    const growthBit = r.growth >= 1000 ? ' Breakout (+1000%).' : r.growth > 0 ? ` +${r.growth}%.` : '';
    const description = sources.length > 0
      ? `${sources[0].title} (Reported by ${sources[0].name}).${growthBit}${breakdownBit}`
      : `Surging search interest for "${r.query}" — ${label} searches.${growthBit}${breakdownBit}`;
    const keyword = r.query;
    const google = findGooglePicsForQuery(keyword, rss.byKeyword);
    const rssCover = imgCache.get(r.query) || '';
    // Each news source already carries its story photo (enriched above);
    // RSS item pictures fill any gap they leave.
    const sourcesWithPic = sources.length > 0
      ? sources.map((s, si) => {
        if (!s.picture && si < google.length && google[si]) return { ...s, picture: google[si] };
        return s;
      })
      : [{
        title: `Search spike for ${keyword}`,
        name: 'Google Trends',
        url: `https://trends.google.com/trending?geo=${geo}&hours=${hours}&q=${encodeURIComponent(keyword)}`,
        publishedAt: startedIso,
        snippet: `Search interest surged with approx ${label} queries.`,
        credibilityScore: 95,
      }];
    return {
      id: `tn-${geo.toLowerCase()}-${hours}h-${encodeURIComponent(r.normalizedQuery.toLowerCase().replace(/[^a-z0-9\u0600-\u06FF]+/gi, '-'))}-${idx}`,
      country: geo.toUpperCase(),
      language: hl.split('-')[0] || 'en',
      keyword,
      rank: idx + 1,
      trend_score: velocity,
      velocity,
      search_volume: Math.max(0.1, Math.round((r.volume / 1000) * 10) / 10),
      detected_at: startedIso,
      category: categoryFromIds(r.categoryIds, `${keyword} ${sources[0]?.title || ''}`),
      description,
      sources: sourcesWithPic,
      // Photo set, Google-hosted first: the trend's OWN Google thumbnail
      // (cover) wins over every publisher hotlink; Unsplash stock never
      // enters. Empty cover honestly falls back to gradient downstream.
      ...(() => {
        const srcPics = sourcesWithPic
          .map(s => s.picture)
          .filter((u): u is string => !!u && u.startsWith('http'));
        const extra = storyPhotos.get(r.query) || [];
        const ordered = googleFirst([rssCover, ...srcPics, ...google, ...extra]);
        const cover = ordered[0] || '';
        const storyImageUrls = ordered.slice(0, 5);
        return { image_url: cover, storyImageUrls };
      })(),
      detectedIntent: 'why_trending' as const,
      primaryQuestion: `Why is ${keyword} trending today?`,
      candidateQuestions: [
        `Why is ${keyword} trending today?`,
        `What happened with ${keyword}?`,
        `The real story behind ${keyword}`,
        `Why is everyone searching for ${keyword}?`,
      ],
      isLiveGoogleTrend: true,
      rawGoogleTraffic: label,
      breakdownKeywords: r.breakdown.slice(0, 12),
      percentGrowth: r.growth,
      startedAt: startedIso,
      endedAt: r.endedEpoch ? new Date(r.endedEpoch * 1000).toISOString() : null,
      isActive: !r.endedEpoch,
    };
  });
}

export function geoDisplayName(geo: string): string {
  return GEO_NAMES[geo.toUpperCase()] || geo.toUpperCase();
}
