import { NormalizedTrend, TrendSource } from '../src/types';
import { googleFirst } from './imageProxy.js';
import { relayFetch } from './netopenRelay.js';

interface GoogleTrendsItem {
  keyword: string;
  traffic: string;
  pubDate: string;
  picture: string;
  pictureSource: string;
  news: Array<{
    title: string;
    url: string;
    source: string;
    picture: string;
  }>;
}

// Decode basic XML / HTML entities
function decodeXmlEntities(str: string): string {
  if (!str) return '';
  return str
    .replace(/&amp;/g, '&')
    .replace(/&quot;/g, '"')
    .replace(/&#39;/g, "'")
    .replace(/&apos;/g, "'")
    .replace(/&lt;/g, '<')
    .replace(/&gt;/g, '>')
    .replace(/<!\[CDATA\[(.*?)\]\]>/gs, '$1')
    .trim();
}

// Infer category from keyword and news titles
function inferCategory(text: string): 'sports' | 'technology' | 'entertainment' | 'business' | 'world' | 'science' {
  const lower = text.toLowerCase();
  
  if (/football|soccer|tennis|us open|nba|nfl|mlb|premier league|chelsea|arsenal|barcelona|real madrid|everton|liverpool|transfer|goal|score|match|championship|cup|olympic|f1|grand prix|racing|player|coach|stadium|manchester/i.test(lower)) {
    return 'sports';
  }
  if (/ai|artificial intelligence|robot|openai|google|apple|samsung|microsoft|nvidia|software|chip|cyber|tech|app|iphone|android|space|nasa|spacex|satellite/i.test(lower)) {
    return 'technology';
  }
  if (/movie|film|trailer|actor|actress|singer|song|album|concert|hollywood|series|netflix|disney|grammy|oscar|celebrity|music/i.test(lower)) {
    return 'entertainment';
  }
  if (/stock|market|nasdaq|dow|crypto|bitcoin|inflation|rate|fed|bank|economy|revenue|shares|trader|wall street|financial|earnings/i.test(lower)) {
    return 'business';
  }
  if (/science|biology|physics|research|telescope|quantum|fossil|study|earthquake|volcano|discovery|planet|mars/i.test(lower)) {
    return 'science';
  }
  return 'world';
}

// Parse traffic string into ABSOLUTE searches. Google's daily RSS changed
// scale: it now reports raw counts ("200+", "2,000+") instead of K-suffixed
// values ("200K+"). Treating "200+" as 200K silently dropped every real spike
// below the volume gate — so parse the true magnitude (raw, K and M).
function parseTraffic(trafficStr: string): { volumeK: number; velocity: number; score: number } {
  if (!trafficStr) return { volumeK: 50, velocity: 80, score: 80 };

  const clean = trafficStr.replace(/[^0-9kKmM+.,]/g, '').toUpperCase();
  const numPart = parseFloat(clean.replace(/[^0-9.]/g, '')) || 0;
  let searches = 0;
  if (clean.includes('M')) {
    searches = numPart * 1000000;
  } else if (clean.includes('K')) {
    searches = numPart * 1000;
  } else {
    searches = parseInt(trafficStr.replace(/[^0-9]/g, ''), 10) || 0;
  }

  // volumeK keeps one decimal so small daily spikes stay visible (0.2 = 200).
  const volumeK = Math.max(0.1, Math.round((searches / 1000) * 10) / 10);

  // Velocity bands on absolute searches (daily feed runs 10^2–10^6).
  let velocity = 70;
  if (searches >= 1000000) velocity = 99;
  else if (searches >= 500000) velocity = 97;
  else if (searches >= 200000) velocity = 95;
  else if (searches >= 100000) velocity = 93;
  else if (searches >= 50000) velocity = 91;
  else if (searches >= 20000) velocity = 88;
  else if (searches >= 10000) velocity = 86;
  else if (searches >= 5000) velocity = 84;
  else if (searches >= 2000) velocity = 82;
  else if (searches >= 1000) velocity = 80;
  else if (searches >= 500) velocity = 78;
  else if (searches >= 200) velocity = 75;

  return { volumeK, velocity, score: velocity };
}

export async function fetchGoogleTrendsRSS(geo = 'US'): Promise<NormalizedTrend[]> {
  // Google's trending/rss feed = Daily Search Trends: spikes detected over
  // roughly the LAST 24 HOURS (each item carries pubDate + approx traffic).
  // This service only surfaces spikes above MIN_TREND_VOLUME_K (default 0.2K,
  // matching the feed's raw-count scale) and drops items older than
  // TREND_MAX_AGE_HOURS.
  const url = `https://trends.google.com/trending/rss?geo=${encodeURIComponent(geo)}`;
  
  const response = await relayFetch(url, {
    headers: {
      'User-Agent': 'Mozilla/5.0 (Windows NT 10.0; Win64; x64) AppleWebKit/537.36 (KHTML, like Gecko) Chrome/122.0.0.0 Safari/537.36',
      'Accept': 'application/rss+xml, application/xml, text/xml, */*'
    }
  });

  if (!response) {
    throw new Error('Google Trends RSS unreachable (direct + netopen channel failed)');
  }

  if (!response.ok) {
    throw new Error(`Google Trends RSS responded with status: ${response.status} ${response.statusText}`);
  }

  const xml = await response.text();
  const itemMatches = xml.match(/<item>([\s\S]*?)<\/item>/g) || [];

  if (itemMatches.length === 0) {
    throw new Error('No items found in Google Trends RSS feed');
  }

  const trends: NormalizedTrend[] = [];
  // Daily-feed scale: items run in the hundreds/thousands of searches, so the
  // default gate is 0.2K (200 searches). Override via TREND_MIN_VOLUME_K (K).
  const MIN_VOLUME_K = Number(process.env.TREND_MIN_VOLUME_K) || 0.2;
  const MAX_AGE_MS = (Number(process.env.TREND_MAX_AGE_HOURS) || 48) * 3600 * 1000;
  const now = Date.now();
  let droppedBelowVolume = 0;
  let droppedStale = 0;
  let firstBuilt: NormalizedTrend | null = null;

  for (let i = 0; i < itemMatches.length; i++) {
    const itemXml = itemMatches[i];
    const titleMatch = itemXml.match(/<title>([\s\S]*?)<\/title>/);
    const trafficMatch = itemXml.match(/<ht:approx_traffic>([\s\S]*?)<\/ht:approx_traffic>/);
    const pubDateMatch = itemXml.match(/<pubDate>([\s\S]*?)<\/pubDate>/);
    const pictureMatch = itemXml.match(/<ht:picture>([\s\S]*?)<\/ht:picture>/);
    const pictureSourceMatch = itemXml.match(/<ht:picture_source>([\s\S]*?)<\/ht:picture_source>/);

    const keyword = decodeXmlEntities(titleMatch ? titleMatch[1] : '').trim();
    if (!keyword) continue;

    const trafficRaw = trafficMatch ? trafficMatch[1].trim() : '10K+';
    const { volumeK, velocity, score } = parseTraffic(trafficRaw);

    const pubDate = pubDateMatch ? pubDateMatch[1].trim() : new Date().toISOString();
    const pubTime = Date.parse(pubDate);
    let imageUrl = pictureMatch ? pictureMatch[1].trim() : '';
    const pictureSource = pictureSourceMatch ? decodeXmlEntities(pictureSourceMatch[1]) : '';

    // Extract news items
    const newsMatches = itemXml.match(/<ht:news_item>([\s\S]*?)<\/ht:news_item>/g) || [];
    const sources: TrendSource[] = [];

    for (const nXml of newsMatches) {
      const nTitle = decodeXmlEntities(nXml.match(/<ht:news_item_title>([\s\S]*?)<\/ht:news_item_title>/)?.[1] || '');
      const nUrl = decodeXmlEntities(nXml.match(/<ht:news_item_url>([\s\S]*?)<\/ht:news_item_url>/)?.[1] || '');
      const nSource = decodeXmlEntities(nXml.match(/<ht:news_item_source>([\s\S]*?)<\/ht:news_item_source>/)?.[1] || '');
      const nSnippet = decodeXmlEntities(nXml.match(/<ht:news_item_snippet>([\s\S]*?)<\/ht:news_item_snippet>/)?.[1] || '');
      const nPic = nXml.match(/<ht:news_item_picture>([\s\S]*?)<\/ht:news_item_picture>/)?.[1] || '';

      if (!imageUrl && nPic) {
        imageUrl = nPic;
      }

      if (nTitle) {
        sources.push({
          title: nTitle,
          name: nSource || pictureSource || 'Google News Wire',
          url: nUrl || `https://news.google.com/search?q=${encodeURIComponent(keyword)}`,
          publishedAt: pubDate,
          snippet: nSnippet || nTitle,
          credibilityScore: 98,
          picture: nPic || undefined
        });
      }
    }

    // No generic stock fallback: an empty image_url honestly renders the
    // gradient/panel fallback downstream instead of hotlinking Unsplash.
    if (!imageUrl) {
      imageUrl = '';
    }

    // Headline news summary
    const primaryNews = sources[0];
    const secondaryNews = sources[1];
    let description = primaryNews
      ? `${primaryNews.title} (Reported by ${primaryNews.name})`
      : `Sudden surge in search query volume for "${keyword}".`;
    if (secondaryNews) {
      description += ` • Also covered by ${secondaryNews.name}.`;
    }

    // Determine category
    const category = inferCategory(`${keyword} ${description}`);

    // Core Question Behind Search
    const primaryQuestion = `Why is ${keyword} trending today?`;

    const trend: NormalizedTrend = {
      id: `gt-${geo.toLowerCase()}-${encodeURIComponent(keyword.toLowerCase().replace(/[^a-z0-9]/g, '-'))}-${trends.length}`,
      country: geo.toUpperCase(),
      language: 'en',
      keyword,
      rank: trends.length + 1,
      trend_score: score,
      velocity,
      search_volume: volumeK,
      detected_at: pubDate,
      category,
      description,
      // Google-hosted thumbnail first (ht:picture almost always is),
      // Unsplash stock banned outright — empty falls back honestly.
      ...(() => {
        const ordered = googleFirst([imageUrl, ...sources.map(s => s.picture)]);
        return { image_url: ordered[0] || '', storyImageUrls: ordered.slice(0, 5) };
      })(),
      sources: sources.length > 0 ? sources : [
        {
          title: `Search spike for ${keyword}`,
          name: pictureSource || 'Google Trends News',
          url: `https://trends.google.com/trending?geo=${geo}`,
          publishedAt: pubDate,
          snippet: `Search interest surged on Google Trends with approx ${trafficRaw} queries.`,
          credibilityScore: 95
        }
      ],
      detectedIntent: 'why_trending',
      primaryQuestion,
      candidateQuestions: [
        primaryQuestion,
        `What happened with ${keyword}?`,
        `The real story behind ${keyword}`,
        `Why is everyone searching for ${keyword}?`
      ],
      isLiveGoogleTrend: true,
      rawGoogleTraffic: trafficRaw
    };

    if (!firstBuilt) firstBuilt = trend;

    // 24h-feed hygiene: skip spikes older than the max age (stale cache rows).
    if (!isNaN(pubTime) && now - pubTime > MAX_AGE_MS) {
      droppedStale++;
      continue;
    }

    // Volume gate: only spikes above the minimum surface in the app.
    if (volumeK < MIN_VOLUME_K) {
      droppedBelowVolume++;
      continue;
    }

    // Re-rank by filtered position (raw RSS order minus the dropped items).
    trend.rank = trends.length + 1;
    trend.id = `gt-${geo.toLowerCase()}-${encodeURIComponent(keyword.toLowerCase().replace(/[^a-z0-9]/g, '-'))}-${trends.length}`;
    trends.push(trend);
  }

  // RSS order is chronological, NOT by traffic — a 200-search item can sit
  // above a 5000+ spike. Rank by real heat so #1 is the main trend.
  trends.sort((a, b) => {
    if (b.velocity !== a.velocity) return b.velocity - a.velocity;
    if (b.search_volume !== a.search_volume) return b.search_volume - a.search_volume;
    return Date.parse(b.detected_at) - Date.parse(a.detected_at);
  });
  trends.forEach((t, idx) => {
    t.rank = idx + 1;
    t.id = `gt-${geo.toLowerCase()}-${encodeURIComponent(t.keyword.toLowerCase().replace(/[^a-z0-9]/g, '-'))}-${idx}`;
  });

  // Never idle the engine: on a quiet day with nothing above the gate, keep
  // the raw #1 spike so discovery/auto-pipeline still have a subject.
  if (trends.length === 0 && firstBuilt) {
    console.log(`[Google Trends] Nothing above ${MIN_VOLUME_K}K for geo ${geo} — keeping raw #1 ("${firstBuilt.keyword}") so the engine never idles.`);
    trends.push(firstBuilt);
  } else {
    const top3 = trends.slice(0, 3).map(t => `"${t.keyword}" (${t.rawGoogleTraffic})`).join(', ');
    console.log(`[Google Trends] geo=${geo}: ${trends.length} spikes ≥ ${MIN_VOLUME_K}K (dropped ${droppedBelowVolume} below volume, ${droppedStale} stale >48h). Top: ${top3}. Window: last ~24h daily trends.`);
  }

  return trends;
}
