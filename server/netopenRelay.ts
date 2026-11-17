// netopen egress channel — generic client (mirrors Music Atlas/server/scRelay.ts).
// Services behind filtered networks use netopen (deployed on an open-internet
// host) to fetch public URLs. Config: NETOPEN_URL, NETOPEN_TOKEN.

export interface NetopenStatus {
  configured: boolean
  host: string | null
  token: boolean
}

const CONNECT_TIMEOUT_MS = 20_000
const CHANNEL_TIMEOUT_MS = 40_000

let cachedToken: string | null = null
function netopenUrl(): string {
  const v = (process.env.NETOPEN_URL || '').trim().replace(/\/+$/, '')
  return v
}
function netopenToken(): string {
  if (cachedToken === null) cachedToken = (process.env.NETOPEN_TOKEN || '').trim()
  return cachedToken
}

export function netopenConfigured(): boolean {
  try {
    return !!netopenUrl() && !!new URL(netopenUrl())
  } catch {
    return false
  }
}

export function netopenStatus(): NetopenStatus {
  const url = netopenUrl()
  let host: string | null = null
  if (url) {
    try { host = new URL(url).hostname } catch { host = null }
  }
  return { configured: !!host, host, token: !!netopenToken() }
}

function fetchWithTimeout(url: string, init?: RequestInit, timeoutMs = CONNECT_TIMEOUT_MS): Promise<Response> {
  return fetch(url, { ...init, signal: AbortSignal.timeout(timeoutMs), redirect: 'follow' })
}

export async function netopenFetch(target: string, init?: RequestInit): Promise<Response | null> {
  const base = netopenUrl()
  if (!base) return null
  const qs = new URLSearchParams({ u: target })
  const token = netopenToken()
  if (token) qs.set('t', token)
  const headers: Record<string, string> = {}
  if (init?.headers) {
    for (const [k, v] of Object.entries(init.headers as Record<string, string>)) {
      if (!/^authorization$|^x-netopen-token$|^host$|^connection$/i.test(k)) headers[k] = v
    }
  }
  try {
    return await fetchWithTimeout(`${base}/fetch?${qs.toString()}`, { ...init, headers }, CHANNEL_TIMEOUT_MS)
  } catch {
    return null
  }
}

export async function relayFetch(url: string, init?: RequestInit): Promise<Response | null> {
  try {
    return await fetchWithTimeout(url, init)
  } catch {
    /* direct unreachable -> channel */
  }
  return netopenFetch(url, init)
}
