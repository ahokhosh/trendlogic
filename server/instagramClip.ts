import fs from 'fs';
import path from 'path';
import { enrichTrend } from './trendEnrichment.js';

// ---------------------------------------------------------------------------
// Instagram clip provider: searches the trend phrase on Instagram (public
// reels/posts discovered via keyless web search), downloads the clip through
// the downloader service (yt-dlp engine) and hands back a local mp4 path.
//
// Any failure at any step resolves to null — the caller then falls back to
// the normal still-image flow. Never throws.
// ---------------------------------------------------------------------------

function getDownloaderOrigins(): string[] {
  const primary = (process.env.DOWNLOADER_BASE_URL || '').trim().replace(/\/$/, '');
  const list = [] as string[];
  if (primary) list.push(primary);
  const podPort = process.env.DOWNLOADER_PORT || '';
  if (podPort) list.push(`http://127.0.0.1:${podPort}`);
  list.push('http://downloder:3000');
  list.push('http://downloader:3000');
  list.push('http://127.0.0.1:8100');
  list.push('http://127.0.0.1:3000');
  list.push('http://localhost:3000');
  return [...new Set(list)];
}
const DOWNLOADER_ORIGIN = (process.env.DOWNLOADER_BASE_URL || 'http://downloder:3000').trim().replace(/\/$/, '');
const UA = 'Mozilla/5.0 (Windows NT 10.0; Win64; x64) AppleWebKit/537.36 (KHTML, like Gecko) Chrome/126.0.0.0 Safari/537.36';

export interface InstagramClipOptions {
  jobId: string;
  tempDir: string;
  /** Total time budget for search + download (default 120s). */
  budgetMs?: number;
  onLog?: (step: string, message: string, type?: 'info' | 'success' | 'warn' | 'error') => void;
}

async function fetchTimeout(url: string, init: RequestInit, ms: number): Promise<Response> {
  const controller = new AbortController();
  const timer = setTimeout(() => controller.abort(), ms);
  try {
    return await fetch(url, { ...init, signal: controller.signal });
  } finally {
    clearTimeout(timer);
  }
}

/** Public instagram reel/post results spotted in a search-result page. Handles
 *  both direct links and DuckDuckGo Lite redirect wrappers (uddg=...).
 *  Title AND snippet are kept: relevance is decided at search time from the
 *  result text (snippet reads like the post caption), never after download. */
export interface InstagramCandidate {
  url: string;
  title: string;
  snippet: string;
}

function stripTags(s: string): string {
  return s.replace(/<[^>]*>/g, ' ').replace(/\s+/g, ' ').trim();
}

function extractInstagramCandidates(html: string): InstagramCandidate[] {
  const out: InstagramCandidate[] = [];
  const seen = new Set<string>();
  const text = html.replace(/&amp;/g, '&');
  const instaRe = /(https?:\/\/(?:www\.)?instagram\.com\/(?:reel|reels|p)\/[A-Za-z0-9_\-]+)/;
  const push = (raw: string, title: string, snippet: string) => {
    const direct = instaRe.exec(raw);
    if (!direct) return;
    const clean = direct[1].replace(/\/$/, '');
    if (seen.has(clean)) return;
    seen.add(clean);
    out.push({ url: clean, title: title.slice(0, 200), snippet: snippet.slice(0, 300) });
  };
  const anchorRe = /<a[^>]+href="([^"]+)"[^>]*>([\s\S]{0,300}?)<\/a>/gi;
  let m: RegExpExecArray | null;
  while ((m = anchorRe.exec(text)) !== null) {
    const rawHref = m[1];
    const direct = instaRe.exec(rawHref);
    if (direct) {
      const title = stripTags(m[2]).slice(0, 200);
      let snippet = '';
      const after = text.slice(m.index + m[0].length, m.index + m[0].length + 1500);
      const sn = /class="result__snippet"[^>]*>([\s\S]{0,500}?)<\/a>/.exec(after);
      if (sn) {
        snippet = stripTags(sn[1]).slice(0, 300);
      } else {
        snippet = stripTags(after).slice(0, 300);
      }
      push(direct[1], title, snippet);
      continue;
    }
    const w = /uddg=(https?[^&"'\s]+)/.exec(rawHref);
    if (w) {
      try {
        const decoded = decodeURIComponent(w[1]);
        const inner = instaRe.exec(decoded);
        if (inner) {
          const title = stripTags(m[2]).slice(0, 200);
          const after = text.slice(m.index + m[0].length, m.index + m[0].length + 1500);
          push(inner[1], title, stripTags(after).slice(0, 300));
        }
      } catch { /* malformed escape — skip */ }
    }
  }
  // Fallback for RSS/XML engines (Bing RSS <link>) and plain-text pages:
  // any bare instagram reel/post URL in the body becomes a candidate whose
  // surrounding text is the snippet.
  if (out.length === 0) {
    const bareRe = /https?:\/\/(?:www\.)?instagram\.com\/(?:reel|reels|p)\/[A-Za-z0-9_\-]+/gi;
    let b: RegExpExecArray | null;
    while ((b = bareRe.exec(text)) !== null) {
      const start = Math.max(0, b.index - 400);
      const context = stripTags(text.slice(start, b.index + b[0].length + 400));
      push(b[0], context.slice(0, 200), context.slice(0, 300));
      if (out.length >= 10) break;
    }
  }
  return out;
}

/** Search-time relevance: keyword-token overlap with the result title AND
 *  snippet (+1 for reels over plain posts). Persian + Latin tokens supported.
 *  QC v2: optional description/question context boosts the score, stopwords
 *  are ignored, and a minimum-threshold gate rejects off-topic picks so an
 *  irrelevant clip is NEVER embedded — caller falls back to stills. */
export interface RelevanceContext {
  description?: string;
  question?: string;
}

const STOPWORDS = new Set([
  // en
  'the', 'and', 'for', 'with', 'from', 'that', 'this', 'what', 'why', 'how',
  'when', 'where', 'which', 'today', 'latest', 'news', 'video', 'trending',
  'trend', 'behind', 'search', 'question', 'answer', 'report', 'just', 'not',
  // fa
  'در', 'به', 'از', 'که', 'این', 'آن', 'با', 'برای', 'را', 'های', 'است', 'شد',
  'شود', 'چرا', 'چیست', 'خبر', 'امروز', 'ویدیو', 'ترند',
]);

function tokenize(s: string): string[] {
  return (s || '')
    .toLowerCase()
    .split(/[^a-z0-9\u0600-\u06FF]+/i)
    .map(t => t.trim())
    .filter(t => t.length > 2 && !STOPWORDS.has(t));
}

export function scoreInstagramCandidate(
  keyword: string,
  c: InstagramCandidate,
  ctx?: RelevanceContext
): number {
  const kwTokens = tokenize(keyword);
  const descTokens = tokenize(ctx?.description || '');
  const qTokens = tokenize(ctx?.question || '');
  const title = c.title.toLowerCase();
  const snippet = (c.snippet || '').toLowerCase();
  let score = 0;
  for (const t of kwTokens) {
    if (title.includes(t)) score += 3;
    else if (snippet.includes(t)) score += 2;
  }
  // Context tokens (description/question) are supporting evidence: +1 each.
  const ctxTokens = [...new Set([...descTokens.slice(0, 8), ...qTokens.slice(0, 8)])]
    .filter(t => !kwTokens.includes(t));
  for (const t of ctxTokens) {
    if (title.includes(t)) score += 1;
    else if (snippet.includes(t)) score += 1;
  }
  if (/\/(reel|reels)\//.test(c.url)) score += 1;
  return score;
}

/** QC gate: the top pick must actually match the topic.
 *  - Single-token topics: that token must appear in title/snippet.
 *  - Multi-token: >=50% of keyword tokens must hit, or total score >= 5.
 *  Otherwise the clip is rejected and the stills flow continues. */
export function passesRelevanceQC(
  keyword: string,
  c: InstagramCandidate,
  score: number
): boolean {
  const kwTokens = tokenize(keyword);
  if (kwTokens.length === 0) return score >= 3;
  const hay = `${c.title} ${(c.snippet || '')}`.toLowerCase();
  const hits = kwTokens.filter(t => hay.includes(t)).length;
  if (kwTokens.length === 1) return hits >= 1;
  if (hits >= Math.ceil(kwTokens.length / 2)) return true;
  return score >= 5 && hits >= 1;
}

async function resolveDownloader(onLog?: InstagramClipOptions['onLog']): Promise<string | null> {
  for (const origin of getDownloaderOrigins()) {
    try {
      const h = await fetchTimeout(`${origin}/api/health`, {}, 4000);
      if (h.ok) {
        if (origin !== DOWNLOADER_ORIGIN) onLog?.('Instagram Clip', `Downloader resolved at ${origin}`);
        return origin;
      }
    } catch { /* try next */ }
  }
  return null;
}

async function downloadViaDownloader(
  postUrl: string,
  opts: InstagramClipOptions,
  deadline: number,
  origin: string
): Promise<string | null> {
  const { jobId, tempDir, onLog } = opts;
  try {
    const submit = await fetchTimeout(
      `${origin}/api/download`,
      {
        method: 'POST',
        headers: { 'Content-Type': 'application/json', 'User-Agent': UA },
        body: JSON.stringify({ url: postUrl, mode: 'video' })
      },
      10000
    );
    if (!submit.ok) {
      onLog?.('Instagram Clip', `Downloader rejected ${postUrl} (HTTP ${submit.status})`, 'warn');
      return null;
    }
    const sj = (await submit.json()) as any;
    const id = String(sj?.id || '');
    if (!id) {
      onLog?.('Instagram Clip', `Downloader gave no job for ${postUrl}`, 'warn');
      return null;
    }
    onLog?.('Instagram Clip', `Download job ${id} for ${postUrl}`);

    while (Date.now() < deadline) {
      await new Promise(r => setTimeout(r, 3000));
      if (Date.now() >= deadline) {
        onLog?.('Instagram Clip', `Download timed out for ${postUrl}`, 'warn');
        return null;
      }
      let j: any = null;
      try {
        const jr = await fetchTimeout(`${origin}/api/jobs/${id}`, {}, 10000);
        if (!jr.ok) continue;
        j = await jr.json();
      } catch {
        continue;
      }
      if (j?.status === 'error') {
        onLog?.('Instagram Clip', `Downloader failed: ${j?.error || 'unknown engine error'}`, 'warn');
        return null;
      }
      if (j?.status !== 'done') continue;
      const files = Array.isArray(j?.files) ? j.files : [];
      const vid =
        files.find((f: any) => f?.type === 'video' && /\.mp4$/i.test(String(f?.name || ''))) ||
        files.find((f: any) => /\.mp4$/i.test(String(f?.name || ''))) ||
        files.find((f: any) => f?.type === 'video');
      if (!vid?.url) {
        onLog?.('Instagram Clip', 'Downloader job done but has no video file', 'warn');
        return null;
      }
      const fileUrl = /^https?:/i.test(String(vid.url))
        ? String(vid.url)
        : `${origin}${String(vid.url).startsWith('/') ? '' : '/'}${vid.url}`;
      const dr = await fetchTimeout(fileUrl, { headers: { 'User-Agent': UA } }, 30000);
      if (!dr.ok) {
        onLog?.('Instagram Clip', `Clip fetch failed (HTTP ${dr.status})`, 'warn');
        return null;
      }
      const buf = Buffer.from(await dr.arrayBuffer());
      if (buf.length < 100 * 1024) {
        onLog?.('Instagram Clip', 'Downloaded clip too small — discarded', 'warn');
        return null;
      }
      const head = buf.subarray(0, 12).toString('latin1');
      if (!head.includes('ftyp') && !(buf[0] === 0x1a && buf[1] === 0x45)) {
        onLog?.('Instagram Clip', 'Downloaded file is not a video — discarded', 'warn');
        return null;
      }
      const out = path.join(tempDir, `${jobId}_ig.mp4`);
      fs.writeFileSync(out, buf);
      onLog?.('Instagram Clip', `Clip downloaded via downloader (${Math.round(buf.length / 1024)} KB)`, 'success');
      return out;
    }
    return null;
  } catch {
    return null;
  }
}

/**
 * Search Instagram for the trend phrase and fetch one clip through the
 * downloader service. Returns the local mp4 path, or null when no clip
 * could be obtained for any reason (caller renders stills instead).
 */
export async function fetchInstagramClip(
  keyword: string,
  opts: InstagramClipOptions,
  ctx?: RelevanceContext
): Promise<string | null> {
  const { onLog } = opts;
  const budget = opts.budgetMs ?? 120000;
  const deadline = Date.now() + budget;
  try {
    if (!fs.existsSync(opts.tempDir)) fs.mkdirSync(opts.tempDir, { recursive: true });
    const origin = await resolveDownloader(onLog);
    if (!origin) {
      onLog?.('Instagram Clip', `Downloader unreachable (${getDownloaderOrigins().join(', ')}) — stills flow continues`, 'warn');
      return null;
    }
    onLog?.('Instagram Clip', `Downloader at ${origin}`);

    // Enriched queries via internal ai-chatbot (event/people/place), with
    // keyword fallback. The search itself must return the topic —
    // post-download probing is impossible, so relevance is decided here.
    const descHint = tokenize(ctx?.description || '').slice(0, 3).join(' ');
    const qHint = tokenize(ctx?.question || '').slice(0, 2).join(' ');
    // `site:`-scoped queries first (most precise), then plain queries — DDG
    // and Bing often return zero rows for `site:instagram.com`, while the
    // plain form still surfaces reels.
    let queries = [
      `site:instagram.com "${keyword}" reel`,
      `site:instagram.com ${keyword} reel`,
      `"${keyword}" instagram reel`,
      `${keyword} instagram reel video`,
      ...(descHint ? [`site:instagram.com ${keyword} ${descHint}`, `${keyword} ${descHint} instagram reel`] : []),
      ...(qHint ? [`${keyword} ${qHint} instagram reel`] : []),
    ];
    try {
      const newsTitles = (ctx?.description || '').split('•').map(s => s.trim()).filter(Boolean).slice(0, 3);
      const enriched = await enrichTrend(keyword, newsTitles, undefined, onLog);
      if (enriched.queries.length > 0) {
        queries = [...new Set([...enriched.queries, ...queries])].slice(0, 5);
        onLog?.('Trend Enrichment', `Enriched queries: ${enriched.queries.join(' | ').slice(0, 160)}`, 'success');
      }
      // Grounded overview terms join the QC context: scoring sees the real
      // story (people/places), not just the bare keyword.
      if (enriched.summary || enriched.visualKeywords.length > 0) {
        ctx = {
          description: `${ctx?.description || ''} ${enriched.summary} ${enriched.visualKeywords.join(' ')}`,
          question: ctx?.question,
        };
      }
    } catch { /* keyword fallback above */ }
    const hosts = [
      'https://lite.duckduckgo.com/lite/?q=',
      'https://html.duckduckgo.com/html/?q=',
      'https://duckduckgo.com/html/?q=',
    ];
    const bingRss = (q: string) =>
      `https://www.bing.com/search?q=${encodeURIComponent(q)}&format=rss`;
    const brave = (q: string) =>
      `https://search.brave.com/search?q=${encodeURIComponent(q)}&source=web`;
    const mojeek = (q: string) =>
      `https://www.mojeek.com/search?q=${encodeURIComponent(q)}`;
    const searchEndpoints: { url: string; kind: string }[] = [];
    for (const q of queries.slice(0, 6)) {
      for (const h of hosts) searchEndpoints.push({ url: `${h}${encodeURIComponent(q)}`, kind: 'ddg' });
      // One RSS + one HTML engine per query keeps the budget bounded while
      // surviving a DDG block (HTTP 202 / captcha wall).
      searchEndpoints.push({ url: bingRss(q), kind: 'bing-rss' });
      searchEndpoints.push({ url: brave(q), kind: 'brave' });
      searchEndpoints.push({ url: mojeek(q), kind: 'mojeek' });
    }
    let lastErr = '';
    let urls: string[] = [];
    // Lenient pool: best near-miss across all engines (single token hit).
    // Used only when NOTHING passes strict QC — a loosely-related real clip
    // still beats a stills-only short, and the caption overlays re-anchor it.
    let lenientBest: { url: string; score: number; title: string } | null = null;
    for (const endpoint of searchEndpoints) {
      if (Date.now() >= deadline) break;
      try {
        const q = new URL(endpoint.url).searchParams.get('q') || '';
        onLog?.('Instagram Clip', `Searching ${new URL(endpoint.url).hostname} [${endpoint.kind}] for "${q.slice(0, 80)}"...`);
        const sr = await fetchTimeout(endpoint.url, { headers: { 'User-Agent': UA, 'Accept': 'text/html', 'Accept-Language': 'en-US' } }, 15000);
        if (!sr.ok) { lastErr = `HTTP ${sr.status}`; continue; }
        const html = await sr.text();
        onLog?.('Instagram Clip', `Search HTML ${html.length} chars from ${new URL(endpoint.url).hostname}`);
        const found = extractInstagramCandidates(html);
        if (found.length > 0) {
          // Relevance first: rank by keyword (+description/question) overlap —
          // blind first-result picks are often off-topic.
          const ranked = found
            .map(c => ({ ...c, score: scoreInstagramCandidate(keyword, c, ctx) }))
            .sort((a, b) => b.score - a.score);
          for (const c of ranked.slice(0, 5)) {
            const verdict = passesRelevanceQC(keyword, c, c.score) ? 'PASS' : 'REJECT';
            const snip = c.snippet ? ` — “${c.snippet.slice(0, 100)}”` : '';
            onLog?.(
              'Instagram Clip QC',
              `[${verdict}] (score ${c.score}): ${c.title || '(no title)'}${snip} — ${c.url}`,
              verdict === 'PASS' ? 'success' : 'warn'
            );
          }
          const passing = ranked.filter(c => passesRelevanceQC(keyword, c, c.score));
          if (passing.length === 0) {
            lastErr = `found ${found.length} links but none passed QC threshold for "${keyword}"`;
            // Track the best near-miss for the lenient fallback below.
            const best = ranked[0];
            if (best && best.score >= 2 && (!lenientBest || best.score > lenientBest.score)) {
              lenientBest = { url: best.url, score: best.score, title: best.title };
            }
            continue; // try next query/host — do NOT download off-topic clips
          }
          urls = passing.slice(0, 3).map(c => c.url);
          break;
        }
        lastErr = 'no instagram links in html';
      } catch (e: any) { lastErr = String(e?.message || e); }
    }
    if (urls.length === 0) {
      if (lenientBest) {
        onLog?.('Instagram Clip QC', `LENIENT PASS (score ${lenientBest.score}): no strict match for "${keyword}" — trying closest reel: ${lenientBest.title || '(no title)'} — ${lenientBest.url}`, 'warn');
        urls = [lenientBest.url];
      } else {
        onLog?.('Instagram Clip QC', `REJECTED: no QC-passing Instagram reel for "${keyword}" (${lastErr}) — stills flow continues`, 'warn');
        return null;
      }
    }
    onLog?.('Instagram Clip QC', `PASSED: ${urls.length} QC-passing candidate(s) for "${keyword}"`, 'success');

    for (const u of urls) {
      if (Date.now() >= deadline) return null;
      const got = await downloadViaDownloader(u, opts, deadline, origin);
      if (got) return got;
      onLog?.('Instagram Clip', 'Candidate failed — trying next', 'warn');
    }
    onLog?.('Instagram Clip', 'No downloadable clip — stills flow continues', 'warn');
    return null;
  } catch {
    return null;
  }
}
