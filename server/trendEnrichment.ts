import { askOverview } from './internalAi.js';

export interface TrendEnrichment {
  /** Instagram-ready search queries (most specific first). */
  queries: string[];
  /** Visual keywords for QC scoring. */
  visualKeywords: string[];
  /** One-sentence story summary (what actually happened). */
  summary: string;
  /** Grounded source links backing the summary (may be empty). */
  sources: { title: string; url: string }[];
}

const STOP = new Set(['the', 'and', 'for', 'with', 'from', 'that', 'this', 'what', 'why', 'how', 'today', 'trending', 'trend', 'video', 'news', 'after', 'with', 'about']);

function keywordsFrom(text: string, exclude: string, n: number): string[] {
  const excl = new Set(exclude.toLowerCase().split(/[^a-z0-9]+/).filter(Boolean));
  const out: string[] = [];
  for (const t of text.toLowerCase().split(/[^a-z0-9\u0600-\u06FF]+/)) {
    const w = t.trim();
    if (w.length < 4 || STOP.has(w) || excl.has(w) || out.includes(w)) continue;
    out.push(w);
    if (out.length >= n) break;
  }
  return out;
}

function fallbackEnrichment(keyword: string, newsTitles: string[]): TrendEnrichment {
  const extra = keywordsFrom(newsTitles.join(' '), keyword, 4).join(' ');
  const q2 = extra ? `${keyword} ${extra}` : keyword;
  return {
    queries: [`site:instagram.com "${keyword}" reel`, `site:instagram.com ${q2} reel`],
    visualKeywords: extra ? extra.split(' ') : [],
    summary: newsTitles[0] || keyword,
    sources: [],
  };
}

/**
 * Enrich a thin Trends spike via the internal ai-overview model:
 * "Why is X trending?" gives a grounded prose answer + source links.
 * Never throws — falls back to keyword logic.
 */
export async function enrichTrend(
  keyword: string,
  newsTitles: string[],
  rawTraffic?: string,
  onLog?: (step: string, msg: string, type?: 'info' | 'success' | 'warn' | 'error') => void
): Promise<TrendEnrichment> {
  const titles = newsTitles.filter(Boolean).slice(0, 3);
  try {
    const q = `Why is "${keyword}" trending today?${titles.length ? ` Context: ${titles.join(' | ')}` : ''} Answer in 3 short sentences: what happened, who/where, why people search for it.`;
    const ans = await askOverview(q, 30000);
    if (!ans?.text) return fallbackEnrichment(keyword, titles);
    const firstSentence = ans.text.split(/(?<=[.!?])\s+/)[0]?.slice(0, 300) || titles[0] || keyword;
    const keyTerms = keywordsFrom(ans.text, keyword, 6);
    const queries = [
      `site:instagram.com ${keyword} ${keyTerms.slice(0, 3).join(' ')} reel`.trim(),
      `site:instagram.com "${keyword}" reel`,
      `site:instagram.com ${keyword} reel`,
    ].filter((v, i, a) => v.length > 24 && a.indexOf(v) === i).slice(0, 4);
    onLog?.('Trend Enrichment', `Overview (${ans.provider}/${ans.model}): ${firstSentence.slice(0, 120)}`, 'success');
    return {
      queries,
      visualKeywords: keyTerms,
      summary: firstSentence,
      sources: ans.sources,
    };
  } catch {
    return fallbackEnrichment(keyword, titles);
  }
}
