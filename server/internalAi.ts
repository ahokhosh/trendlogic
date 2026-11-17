/**
 * Internal text-AI client: trendlogic asks the ai-chatbot service's
 * /api/ai/answer with model=ai-overview (Google-grounded answers).
 * Never throws: null means "fall back to template logic".
 */

export interface OverviewSource {
  title: string;
  url: string;
}

export interface OverviewAnswer {
  text: string;
  provider: string;
  model: string;
  sources: OverviewSource[];
}

function candidateBases(): string[] {
  const list: string[] = [];
  const env = (process.env.AI_CHATBOT_URL || '').trim().replace(/\/$/, '');
  if (env) list.push(env);
  // Pod runner injects AI_CHATBOT_URL, but honor a bare port too so a
  // mis-wired env still resolves to the local sibling service.
  const portEnv = (process.env.AI_CHATBOT_PORT || '').trim();
  if (portEnv && /^\d+$/.test(portEnv)) list.push(`http://127.0.0.1:${portEnv}`);
  // Pod / compose: docker DNS name. Local dev: ai-chatbot usually on 3006.
  list.push('http://ai-chatbot:3000');
  list.push('http://127.0.0.1:3006');
  list.push('http://127.0.0.1:3000');
  list.push('http://localhost:3006');
  return [...new Set(list)];
}

function extractSources(j: any): OverviewSource[] {
  const chunks = Array.isArray(j?.groundingChunks) ? j.groundingChunks : [];
  const out: OverviewSource[] = [];
  for (const c of chunks) {
    const web = c?.web || c;
    const url = String(web?.uri || web?.url || '');
    if (!url.startsWith('http')) continue;
    const title = String(web?.title || url).slice(0, 160);
    if (out.some(s => s.url === url)) continue;
    out.push({ title, url });
    if (out.length >= 5) break;
  }
  return out;
}

async function postAnswer(base: string, q: string, model: string, timeoutMs: number): Promise<OverviewAnswer | null> {
  const ctrl = new AbortController();
  const timer = setTimeout(() => ctrl.abort(), timeoutMs);
  try {
    let r: Response;
    try {
      r = await fetch(`${base}/api/ai/answer`, {
        method: 'POST',
        headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify({ q, model, temperature: 0.4, timeoutMs }),
        signal: ctrl.signal,
      });
    } catch (err: any) {
      console.warn(`[trendlogic] internal AI unreachable at ${base}: ${err?.message || err}`);
      return null;
    }
    if (!r.ok) {
      console.warn(`[trendlogic] internal AI at ${base} answered HTTP ${r.status}`);
      return null;
    }
    const j = (await r.json()) as any;
    const text = String(j?.text || '').trim();
    if (!text) {
      console.warn(`[trendlogic] internal AI at ${base} returned an empty answer`);
      return null;
    }
    return {
      text,
      provider: String(j?.provider || ''),
      model: String(j?.model || ''),
      sources: extractSources(j),
    };
  } catch {
    return null;
  } finally {
    clearTimeout(timer);
  }
}

/** "Why is X trending?" via the internal Google-grounded overview model. */
export async function askOverview(question: string, timeoutMs = 30000): Promise<OverviewAnswer | null> {
  for (const base of candidateBases()) {
    const ans = await postAnswer(base, question, 'ai-overview', Math.min(timeoutMs, 30000));
    if (ans) return ans;
  }
  return null;
}

/** Structured prompts (JSON contracts) via the router's auto pick. */
export async function askInternalAI(prompt: string, timeoutMs = 25000): Promise<string | null> {
  for (const base of candidateBases()) {
    const ans = await postAnswer(base, prompt, 'auto', Math.min(timeoutMs, 25000));
    if (ans?.text) return ans.text;
  }
  return null;
}

export function internalAiBases(): string[] {
  return candidateBases();
}
