import crypto from 'crypto';
import fs from 'fs';
import {
  getTikTokRow,
  saveTikTokRow,
  clearTikTokTokens,
} from './db';
import { sanitizeSingleLine } from '../shared/text.js';

// ---------------------------------------------------------------------------
// Per-user TikTok OAuth + Content Posting API (mirrors server/youtubeService).
// Every app user keeps their OWN TikTok tokens in MySQL (tl_tiktok), so one
// login persists across restarts and publishing is one click afterwards.
// Secrets and raw tokens NEVER leave the backend — the frontend only ever
// sees the public status shape below.
//
// Required app scopes (TikTok for Developers -> Login Kit + Content Posting
// API): user.info.basic, video.list, video.upload, video.publish.
// NOTE: while the TikTok app is unaudited, only test users can publish and
// only with SELF_ONLY privacy — a PUBLIC_TO_EVERYONE init then fails with a
// clear API error (surfaced verbatim, never masked).
// ---------------------------------------------------------------------------

const TIKTOK_CLIENT_KEY = process.env.TIKTOK_CLIENT_KEY || '';
const TIKTOK_CLIENT_SECRET = process.env.TIKTOK_CLIENT_SECRET || '';

export function isTikTokConfigured(): boolean {
  return !!(TIKTOK_CLIENT_KEY && TIKTOK_CLIENT_SECRET);
}

/** Exact redirect URI TikTok must call back. Env override wins (pod/proxy
 *  setups), otherwise APP_URL + /tiktok/callback — register EXACTLY this
 *  string in "Redirect URI" on developers.tiktok.com. */
export function tiktokRedirectUri(fallbackOrigin?: string): string {
  const fixed = String(process.env.TIKTOK_REDIRECT_URI || '').trim().replace(/\/$/, '');
  if (fixed) return fixed;
  const base = String(
    process.env.APP_URL || fallbackOrigin || 'https://bidbes.com/trendlogic'
  ).trim().replace(/\/$/, '');
  return `${base}/tiktok/callback`;
}

const TIKTOK_SCOPES = [
  'user.info.basic',
  'video.list',
  'video.upload',
  'video.publish',
].join(',');

// Short-lived OAuth link tokens: state -> app user (10 min TTL). Binds the
// TikTok popup callback to the user who clicked "Connect".
const oauthLinks = new Map<string, { userId: string; exp: number }>();

export function createTikTokOAuthLink(userId: string): string {
  const state = crypto.randomBytes(24).toString('hex');
  oauthLinks.set(state, { userId, exp: Date.now() + 10 * 60 * 1000 });
  if (oauthLinks.size > 500) {
    const oldest = oauthLinks.keys().next().value;
    if (oldest) oauthLinks.delete(oldest);
  }
  return state;
}

export function consumeTikTokOAuthLink(state: string | undefined): string | null {
  if (!state) return null;
  const link = oauthLinks.get(state);
  if (!link) return null;
  oauthLinks.delete(state);
  if (link.exp < Date.now()) return null;
  return link.userId;
}

export interface TikTokAccountConfig {
  openId: string | null;
  displayName: string;
  avatarUrl: string;
  privacyLevel: 'PUBLIC_TO_EVERYONE' | 'SELF_ONLY';
  connected: boolean;
  lastPublishDate: string;
  lastPublishId: string;
}

/** Public status shape — contains NO tokens and NO secrets. */
export async function getTikTokStatus(userId: string): Promise<TikTokAccountConfig> {
  const row = await getTikTokRow(userId);
  const privacy =
    row?.privacy_level === 'SELF_ONLY' ? 'SELF_ONLY' : 'PUBLIC_TO_EVERYONE';
  return {
    openId: row?.open_id || null,
    displayName: row?.display_name || 'Not connected',
    avatarUrl: row?.avatar_url || '',
    privacyLevel: privacy,
    connected: !!row?.connected && !!(row?.access_token || row?.refresh_token),
    lastPublishDate: row?.last_publish_date || '',
    lastPublishId: row?.last_publish_id || '',
  };
}

export async function saveTikTokPrefs(
  userId: string,
  prefs: { privacyLevel?: 'PUBLIC_TO_EVERYONE' | 'SELF_ONLY' }
): Promise<TikTokAccountConfig> {
  if (prefs.privacyLevel) {
    await saveTikTokRow(userId, { privacy_level: prefs.privacyLevel });
  }
  return getTikTokStatus(userId);
}

export async function disconnectTikTok(userId: string): Promise<TikTokAccountConfig> {
  await clearTikTokTokens(userId);
  return getTikTokStatus(userId);
}

/** Authorize URL opened in a popup (state binds the callback to the user). */
export function generateTikTokAuthUrl(redirectUri: string, state: string): string {
  const params = new URLSearchParams({
    client_key: TIKTOK_CLIENT_KEY,
    scope: TIKTOK_SCOPES,
    response_type: 'code',
    redirect_uri: redirectUri,
    state,
  });
  return `https://www.tiktok.com/v2/auth/authorize/?${params.toString()}`;
}

function tiktokErrorText(body: any, fallback: string): string {
  try {
    const e = body?.error;
    if (e && (e.code || e.message)) {
      const code = String(e.code || '').trim();
      const msg = String(e.message || '').trim();
      // Unaudited-app denials arrive here (e.g. scope/privacy errors) — keep
      // them verbatim so the user knows to add a test user / request audit.
      return code && msg ? `TikTok API [${code}]: ${msg}` : msg || code || fallback;
    }
    if (typeof body === 'string' && body.trim()) return body.slice(0, 300);
  } catch { /* fall through */ }
  return fallback;
}

/** Exchange the callback code for tokens and persist them to the user. */
export async function exchangeTikTokCodeForTokens(
  code: string,
  redirectUri: string,
  userId: string
): Promise<{ success: boolean; profile?: any; error?: string }> {
  if (!isTikTokConfigured()) {
    return { success: false, error: 'TikTok app keys are not configured on the server (TIKTOK_CLIENT_KEY / TIKTOK_CLIENT_SECRET).' };
  }
  try {
    const tokenRes = await fetch('https://open.tiktokapis.com/v2/oauth/token/', {
      method: 'POST',
      signal: AbortSignal.timeout(30000),
      headers: { 'Content-Type': 'application/x-www-form-urlencoded' },
      body: new URLSearchParams({
        client_key: TIKTOK_CLIENT_KEY,
        client_secret: TIKTOK_CLIENT_SECRET,
        code,
        grant_type: 'authorization_code',
        redirect_uri: redirectUri,
      }),
    });
    const tokenData = await tokenRes.json().catch(() => null);
    if (!tokenRes.ok || !tokenData?.access_token) {
      console.error('[TikTok OAuth Token Exchange Error]', JSON.stringify(tokenData)?.slice(0, 300));
      return { success: false, error: tiktokErrorText(tokenData, 'Failed to exchange TikTok authorization code.') };
    }
    // Persist BEFORE the profile fetch so a token is never lost if the
    // info call hiccups — display details can refresh later.
    await saveTikTokRow(userId, {
      access_token: tokenData.access_token,
      ...(tokenData.refresh_token ? { refresh_token: tokenData.refresh_token } : {}),
      open_id: tokenData.open_id || null,
      connected: 1,
    });

    // Fetch the public profile for the status card.
    try {
      const meRes = await fetch(
        'https://open.tiktokapis.com/v2/user/info/?fields=open_id,union_id,avatar_url,display_name',
        {
          headers: { Authorization: `Bearer ${tokenData.access_token}`, Accept: 'application/json' },
          signal: AbortSignal.timeout(20000),
        }
      );
      if (meRes.ok) {
        const me = await meRes.json().catch(() => null);
        const u = me?.data?.user;
        if (u) {
          await saveTikTokRow(userId, {
            open_id: String(u.open_id || tokenData.open_id || ''),
            display_name: String(u.display_name || 'TikTok Account'),
            avatar_url: String(u.avatar_url || ''),
            connected: 1,
          });
          return {
            success: true,
            profile: { openId: u.open_id, displayName: u.display_name, avatarUrl: u.avatar_url },
          };
        }
      }
    } catch { /* profile refresh is best effort */ }

    await saveTikTokRow(userId, { display_name: 'TikTok Account Connected', connected: 1 });
    return { success: true, profile: { displayName: 'TikTok Account Connected' } };
  } catch (err: any) {
    console.error('[TikTok OAuth Error]', err?.message || err);
    return { success: false, error: String(err?.message || err).slice(0, 300) };
  }
}

/** Silent refresh; returns a usable access token or null. */
async function refreshTikTokAccessToken(userId: string): Promise<string | null> {
  const row = await getTikTokRow(userId);
  if (!row?.refresh_token) return row?.access_token || null;
  if (!isTikTokConfigured()) return row?.access_token || null;
  try {
    const res = await fetch('https://open.tiktokapis.com/v2/oauth/token/', {
      method: 'POST',
      signal: AbortSignal.timeout(30000),
      headers: { 'Content-Type': 'application/x-www-form-urlencoded' },
      body: new URLSearchParams({
        client_key: TIKTOK_CLIENT_KEY,
        client_secret: TIKTOK_CLIENT_SECRET,
        grant_type: 'refresh_token',
        refresh_token: row.refresh_token,
      }),
    });
    const data = await res.json().catch(() => null);
    if (res.ok && data?.access_token) {
      await saveTikTokRow(userId, {
        access_token: data.access_token,
        ...(data.refresh_token ? { refresh_token: data.refresh_token } : {}),
        connected: 1,
      });
      return data.access_token;
    }
    if (!res.ok) {
      console.warn('[TikTok refresh note]', tiktokErrorText(data, `HTTP ${res.status}`).slice(0, 160));
    }
  } catch (err: any) {
    console.warn('[TikTok Refresh Token Error]', String(err?.message || err).slice(0, 160));
  }
  return row?.access_token || null;
}

async function activeTikTokToken(userId: string): Promise<string | null> {
  const row = await getTikTokRow(userId);
  if (row?.access_token) return row.access_token;
  return refreshTikTokAccessToken(userId);
}

/** Validate the saved grant (auto-refreshes once on auth failure). */
export async function testTikTokConnection(
  userId: string
): Promise<{ success: boolean; message: string; profile?: any }> {
  const row = await getTikTokRow(userId);
  if (!row || (!row.access_token && !row.refresh_token)) {
    return {
      success: false,
      message: 'No TikTok account linked yet. Click "Connect TikTok Account" to authorize once — it stays saved.',
    };
  }
  const attempt = async (token: string) =>
    fetch('https://open.tiktokapis.com/v2/user/info/?fields=open_id,union_id,avatar_url,display_name', {
      headers: { Authorization: `Bearer ${token}`, Accept: 'application/json' },
      signal: AbortSignal.timeout(20000),
    });
  try {
    let token = row.access_token || (await refreshTikTokAccessToken(userId));
    if (!token) {
      return { success: false, message: 'Saved TikTok authorization expired. Please reconnect your account.' };
    }
    let res = await attempt(token);
    if ((res.status === 401 || res.status === 403) && row.refresh_token) {
      const refreshed = await refreshTikTokAccessToken(userId);
      if (refreshed && refreshed !== token) {
        token = refreshed;
        res = await attempt(token);
      }
    }
    if (res.ok) {
      const me = await res.json().catch(() => null);
      const u = me?.data?.user;
      const name = String(u?.display_name || row.display_name || 'TikTok Account');
      if (u) {
        await saveTikTokRow(userId, {
          open_id: String(u.open_id || row.open_id || ''),
          display_name: name,
          avatar_url: String(u.avatar_url || row.avatar_url || ''),
          connected: 1,
        });
      }
      return {
        success: true,
        message: `Connected to TikTok as "${name}" — stays saved, no need to log in again.`,
        profile: { displayName: name },
      };
    }
    const body = await res.json().catch(() => null);
    return { success: false, message: tiktokErrorText(body, `TikTok API returned status ${res.status}`) };
  } catch (err: any) {
    return {
      success: false,
      message: `Network error reaching TikTok API: ${String(err?.message || err).slice(0, 160)}`,
    };
  }
}

export interface TikTokPublishResult {
  success: boolean;
  publishId: string;
  publishedUrl: string | null;
  displayName: string;
  privacyLevel: string;
  message: string;
}

/**
 * Publish the SAME vertical MP4 (the one already rendered for YouTube Shorts)
 * to the USER's linked TikTok account via the Content Posting API
 * (FILE_UPLOAD + status poll). Saved refresh token keeps this working — the
 * user authorizes once and publishes with one click afterwards.
 */
export async function publishVideoToTikTok(
  userId: string,
  videoFilePath: string,
  opts: {
    title?: string;
    privacyLevel?: 'PUBLIC_TO_EVERYONE' | 'SELF_ONLY';
  } = {}
): Promise<TikTokPublishResult> {
  const row = await getTikTokRow(userId);
  const privacy = opts.privacyLevel || row?.privacy_level || 'PUBLIC_TO_EVERYONE';

  if (!fs.existsSync(videoFilePath)) {
    throw new Error(`MP4 video file not found at path: ${videoFilePath}`);
  }
  const fileSize = fs.statSync(videoFilePath).size;
  if (fileSize <= 0) throw new Error('Video file is empty — render it first.');
  // FILE_UPLOAD single-PUT ceiling is 128 MB; our 9:16 Shorts are ~5-20 MB.
  if (fileSize > 128 * 1024 * 1024) {
    throw new Error(`Video is ${(fileSize / 1048576).toFixed(1)} MB — TikTok single upload caps at 128 MB.`);
  }

  let token = await activeTikTokToken(userId);
  if (!token) {
    throw new Error('No TikTok account linked yet. Click "Connect TikTok Account" once — it stays saved afterwards.');
  }

  // TikTok caption: plain title + tags, max 2200 chars (no #Shorts injection).
  const caption = sanitizeSingleLine(opts.title || 'Trending explained').slice(0, 2200) || 'Trending explained';

  const initOnce = async (authToken: string) => {
    const res = await fetch('https://open.tiktokapis.com/v2/post/publish/video/init/', {
      method: 'POST',
      signal: AbortSignal.timeout(60000),
      headers: {
        Authorization: `Bearer ${authToken}`,
        'Content-Type': 'application/json; charset=UTF-8',
      },
      body: JSON.stringify({
        post_info: {
          title: caption,
          privacy_level: privacy,
          disable_duet: false,
          disable_comment: false,
          disable_stitch: false,
          video_cover_timestamp_ms: 1000,
        },
        source_info: {
          source: 'FILE_UPLOAD',
          video_size: fileSize,
          chunk_size: fileSize,
          total_chunk_count: 1,
        },
      }),
    });
    const data = await res.json().catch(() => null);
    if (res.status === 401 || res.status === 403) {
      const e: any = new Error(tiktokErrorText(data, `TikTok init returned ${res.status}`));
      e.status = res.status;
      e.retryable = true;
      throw e;
    }
    if (!res.ok || !data?.data?.upload_url || !data?.data?.publish_id) {
      throw new Error(tiktokErrorText(data, `TikTok init returned ${res.status}`));
    }
    return data.data as { upload_url: string; publish_id: string };
  };

  // Bounded: raw PUT without a signal hangs FOREVER on a stalled socket and
  // wedges the io-queue slot (same lesson as the YouTube resumable upload).
  const putBytes = async (uploadUrl: string) => {
    const buf = fs.readFileSync(videoFilePath);
    const res = await fetch(uploadUrl, {
      method: 'PUT',
      signal: AbortSignal.timeout(600000),
      headers: {
        'Content-Type': 'video/mp4',
        'Content-Length': String(fileSize),
        'Content-Range': `bytes 0-${fileSize - 1}/${fileSize}`,
      },
      body: buf,
    });
    if (!res.ok) {
      const txt = await res.text().catch(() => '');
      throw new Error(`TikTok byte upload failed (HTTP ${res.status}): ${txt.slice(0, 200)}`);
    }
  };

  const fetchStatus = async (authToken: string, publishId: string): Promise<string> => {
    const res = await fetch('https://open.tiktokapis.com/v2/post/publish/status/fetch/', {
      method: 'POST',
      signal: AbortSignal.timeout(30000),
      headers: {
        Authorization: `Bearer ${authToken}`,
        'Content-Type': 'application/json; charset=UTF-8',
      },
      body: JSON.stringify({ publish_id: publishId }),
    });
    const data = await res.json().catch(() => null);
    if (!res.ok) throw new Error(tiktokErrorText(data, `TikTok status returned ${res.status}`));
    return String(data?.data?.status || 'PROCESSING');
  };

  let init: { upload_url: string; publish_id: string };
  try {
    init = await initOnce(token);
  } catch (err: any) {
    if (err?.retryable && row?.refresh_token) {
      const refreshed = await refreshTikTokAccessToken(userId);
      if (refreshed && refreshed !== token) {
        token = refreshed;
        init = await initOnce(token);
      } else {
        throw err;
      }
    } else {
      throw err;
    }
  }

  await putBytes(init.upload_url);

  // Poll until TikTok finishes processing (cap ~2 min, then return with the
  // publish_id — the post lands on its own; the status row can refresh later).
  let status = 'PROCESSING';
  for (let i = 0; i < 12; i++) {
    await new Promise((r) => setTimeout(r, 10000));
    try {
      status = await fetchStatus(token, init.publish_id);
    } catch (err: any) {
      console.warn('[TikTok status note]', String(err?.message || err).slice(0, 140));
      break;
    }
    if (status === 'PUBLISH_COMPLETE' || status === 'FAILED') break;
  }
  if (status === 'FAILED') {
    throw new Error('TikTok failed to process the upload (FAILED). Try again or re-render the MP4.');
  }

  const st = await getTikTokStatus(userId);
  await saveTikTokRow(userId, {
    last_publish_date: new Date().toISOString(),
    last_publish_id: init.publish_id,
  });

  return {
    success: true,
    publishId: init.publish_id,
    publishedUrl: null, // TikTok returns no public URL until processing completes
    displayName: st.displayName || 'Linked TikTok account',
    privacyLevel: privacy,
    message:
      status === 'PUBLISH_COMPLETE'
        ? `Video published to TikTok (${privacy}) — check your profile, it is live now.`
        : `Video uploaded to TikTok (${privacy}) and is still processing — it will appear on your profile shortly (publish id ${init.publish_id}).`,
  };
}
