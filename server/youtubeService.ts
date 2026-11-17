import crypto from 'crypto';
import fs from 'fs';
import {
  getYouTubeRow,
  saveYouTubeRow,
  clearYouTubeTokens,
  type YouTubeRow
} from './db';
import { YouTubeChannelConfig } from '../src/types';
import { sanitizeMultiline, sanitizeSingleLine } from '../shared/text.js';

// ---------------------------------------------------------------------------
// Per-user YouTube OAuth. Every app user keeps their OWN channel tokens in
// MySQL (tl_youtube), so a login persists across restarts and publishing
// never asks twice. Secrets and raw tokens NEVER leave the backend — the
// frontend only ever sees the public status shape.
// ---------------------------------------------------------------------------

const OAUTH_CLIENT_ID = process.env.YOUTUBE_CLIENT_ID || '';
const OAUTH_CLIENT_SECRET = process.env.YOUTUBE_CLIENT_SECRET || '';

const OAUTH_SCOPES = [
  'https://www.googleapis.com/auth/youtube.upload',
  'https://www.googleapis.com/auth/youtube.readonly',
  // Write + analytics scopes for the virality engine (auto-comments, title
  // rotation, retention stats). They apply to NEW consents only — existing
  // tokens keep working for upload/reads, and every privileged call below
  // degrades gracefully (NEEDS_RECONNECT) so old channels never break.
  'https://www.googleapis.com/auth/youtube.force-ssl',
  'https://www.googleapis.com/auth/yt-analytics.readonly',
  'https://www.googleapis.com/auth/userinfo.profile'
].join(' ');

// Short-lived OAuth link tokens: state -> app user (10 min TTL). Binds the
// Google popup callback to the user who clicked "Connect".
const oauthLinks = new Map<string, { userId: string; exp: number }>();

export function createOAuthLink(userId: string): string {
  const state = crypto.randomBytes(24).toString('hex');
  oauthLinks.set(state, { userId, exp: Date.now() + 10 * 60 * 1000 });
  if (oauthLinks.size > 500) {
    const oldest = oauthLinks.keys().next().value;
    if (oldest) oauthLinks.delete(oldest);
  }
  return state;
}

export function consumeOAuthLink(state: string | undefined): string | null {
  if (!state) return null;
  const link = oauthLinks.get(state);
  if (!link) return null;
  oauthLinks.delete(state);
  if (link.exp < Date.now()) return null;
  return link.userId;
}

/** Public status shape — contains NO tokens and NO secrets. */
export async function getYouTubeStatus(userId: string): Promise<YouTubeChannelConfig> {
  const row = await getYouTubeRow(userId);
  return {
    channelId: row?.channel_id || '',
    channelTitle: row?.channel_title || 'Not connected',
    channelThumbnail: row?.channel_thumbnail || '',
    subscriberCount: row?.subscriber_count || '',
    privacyStatus: (row?.privacy_status as YouTubeChannelConfig['privacyStatus']) || 'unlisted',
    connected: !!row?.connected && !!(row?.access_token || row?.refresh_token),
    lastPublishDate: row?.last_publish_date || '',
    lastVideoId: row?.last_video_id || ''
  };
}

export async function saveYouTubePrefs(
  userId: string,
  prefs: { privacyStatus?: 'public' | 'unlisted' | 'private' }
): Promise<YouTubeChannelConfig> {
  if (prefs.privacyStatus) {
    await saveYouTubeRow(userId, { privacy_status: prefs.privacyStatus });
  }
  return getYouTubeStatus(userId);
}

export async function disconnectYouTube(userId: string): Promise<YouTubeChannelConfig> {
  await clearYouTubeTokens(userId);
  return getYouTubeStatus(userId);
}

/**
 * Generate Google OAuth 2.0 authorization URL for YouTube Data API v3.
 * `state` binds the callback to the app user (see consumeOAuthLink).
 */
export function generateOAuthAuthUrl(redirectUri: string, state: string): string {
  const params = new URLSearchParams({
    client_id: OAUTH_CLIENT_ID,
    redirect_uri: redirectUri,
    response_type: 'code',
    scope: OAUTH_SCOPES,
    access_type: 'offline',
    prompt: 'consent',
    state
  });

  return `https://accounts.google.com/o/oauth2/v2/auth?${params.toString()}`;
}

/**
 * Exchange OAuth Authorization Code for tokens and persist them to the user.
 */
export async function exchangeCodeForTokens(
  code: string,
  redirectUri: string,
  userId: string
): Promise<{ success: boolean; channel?: any; error?: string }> {
  try {
    const tokenRes = await fetch('https://oauth2.googleapis.com/token', {
      method: 'POST',
      headers: {
        'Content-Type': 'application/x-www-form-urlencoded'
      },
      body: new URLSearchParams({
        code,
        client_id: OAUTH_CLIENT_ID,
        client_secret: OAUTH_CLIENT_SECRET,
        redirect_uri: redirectUri,
        grant_type: 'authorization_code'
      }),
      // A stalled Google socket must never wedge the OAuth callback forever.
      signal: AbortSignal.timeout(30000)
    });

    if (!tokenRes.ok) {
      const errText = await tokenRes.text();
      console.error('[OAuth Token Exchange Error]', errText);
      return { success: false, error: `Failed to exchange token: ${errText}` };
    }

    const tokenData = await tokenRes.json();
    // Persist BEFORE the channel fetch so a token is never lost if the
    // profile call hiccups — the channel details can refresh later.
    await saveYouTubeRow(userId, {
      access_token: tokenData.access_token || null,
      ...(tokenData.refresh_token ? { refresh_token: tokenData.refresh_token } : {}),
      connected: 1,
      needs_reconnect: 0
    });

    // Now fetch channel details
    const channelRes = await fetch('https://www.googleapis.com/youtube/v3/channels?part=snippet,statistics&mine=true', {
      headers: {
        'Authorization': `Bearer ${tokenData.access_token}`,
        'Accept': 'application/json'
      },
      signal: AbortSignal.timeout(30000)
    });

    if (channelRes.ok) {
      const channelData = await channelRes.json();
      if (channelData.items && channelData.items.length > 0) {
        const item = channelData.items[0];
        const title = item.snippet?.title || 'Connected Channel';
        const subs = item.statistics?.subscriberCount ? `${item.statistics.subscriberCount}` : 'Connected';
        const thumb = item.snippet?.thumbnails?.default?.url || '';
        await saveYouTubeRow(userId, {
          channel_id: item.id,
          channel_title: title,
          channel_thumbnail: thumb,
          subscriber_count: subs,
          connected: 1
        });

        return {
          success: true,
          channel: { id: item.id, title, subscribers: subs, thumbnail: thumb }
        };
      }
    }

    // Brand new Google account with no channel yet — tokens are saved, the
    // channel row will fill in on the next successful API call.
    await saveYouTubeRow(userId, { channel_title: 'Google Account Connected', connected: 1 });
    return {
      success: true,
      channel: { title: 'Google Account Connected', subscribers: '0' }
    };
  } catch (err: any) {
    console.error('[OAuth Error]', err);
    return { success: false, error: err.message };
  }
}

/** Silent refresh; returns a usable access token or null. */
async function refreshYouTubeAccessToken(userId: string): Promise<string | null> {
  const row = await getYouTubeRow(userId);
  if (!row?.refresh_token) return row?.access_token || null;

  try {
    const res = await fetch('https://oauth2.googleapis.com/token', {
      method: 'POST',
      headers: { 'Content-Type': 'application/x-www-form-urlencoded' },
      body: new URLSearchParams({
        client_id: OAUTH_CLIENT_ID,
        client_secret: OAUTH_CLIENT_SECRET,
        refresh_token: row.refresh_token,
        grant_type: 'refresh_token'
      }),
      // Hot path of EVERY publish: a stalled socket would wedge the serial
      // upload lane and the io lane — always bound it.
      signal: AbortSignal.timeout(30000)
    });

    if (res.ok) {
      const data = await res.json();
      if (data.access_token) {
        await saveYouTubeRow(userId, { access_token: data.access_token, connected: 1 });
        return data.access_token;
      }
    } else if (res.status === 400 || res.status === 401) {
      // Refresh token revoked/expired in Google — drop BOTH tokens and flag a
      // reconnect. Keeping the dead refresh_token made every later publish
      // re-hit Google with it (a doomed request each time, forever).
      await saveYouTubeRow(userId, {
        access_token: null, refresh_token: null, connected: 0, needs_reconnect: 1
      });
      return null;
    }
  } catch (err: any) {
    console.warn('[Refresh Token Error]', err.message);
  }

  return row?.access_token || null;
}

async function activeYouTubeToken(userId: string): Promise<string | null> {
  const row = await getYouTubeRow(userId);
  if (row?.access_token) return row.access_token;
  return refreshYouTubeAccessToken(userId);
}

/** Usable OAuth token for extra Data API calls (auto-refreshes). Exported
 *  for the live ingest-health check — tokens never leave the backend. */
export async function getYouTubeAccessToken(userId: string): Promise<string | null> {
  return activeYouTubeToken(userId);
}

export interface IngestStreamHealth {
  id: string;
  title: string;
  streamNameSuffix: string;
  healthStatus: string;
  streamStatus: string;
  matchesSavedKey: boolean;
}

export interface IngestHealth {
  checkedAt: string;
  streams: IngestStreamHealth[];
  note: string;
}

/**
 * Ask YouTube itself whether our RTMP data is arriving: liveStreams.list
 * (mine=true) reports per-stream healthStatus (good/degraded/bad/noData).
 * Also compares each streamName against the account's saved stream key
 * (suffix match, server-side only) so a rotated/invalid key is caught
 * without ever exposing the key.
 */
export async function getIngestHealth(userId: string, savedKey: string | null): Promise<IngestHealth> {
  const token = await activeYouTubeToken(userId);
  if (!token) {
    throw new Error('No YouTube channel linked to your account yet — connect it once in Settings, then check again.');
  }
  const attempt = async (authToken: string) => fetch(
    'https://www.googleapis.com/youtube/v3/liveStreams?part=id,snippet,cdn,status&mine=true&maxResults=10',
    { headers: { 'Authorization': `Bearer ${authToken}`, 'Accept': 'application/json' }, signal: AbortSignal.timeout(30000) }
  );
  let res = await attempt(token);
  if (res.status === 401) {
    const refreshed = await refreshYouTubeAccessToken(userId);
    if (refreshed && refreshed !== token) res = await attempt(refreshed);
  }
  if (!res.ok) {
    const body = await res.text().catch(() => '');
    throw new Error(`YouTube API returned ${res.status}: ${body.slice(0, 140)}`);
  }
  const data = await res.json();
  const items = Array.isArray(data?.items) ? data.items : [];
  const keyTail = typeof savedKey === 'string' && savedKey.trim().length >= 4
    ? savedKey.trim().slice(-8)
    : null;
  const streams: IngestStreamHealth[] = items.map((it: any) => {
    const streamName = String(it?.cdn?.ingestionInfo?.streamName || '');
    return {
      id: String(it?.id || ''),
      title: String(it?.snippet?.title || 'Untitled stream'),
      streamNameSuffix: streamName ? `••••${streamName.slice(-4)}` : '(none)',
      healthStatus: String(it?.status?.healthStatus || 'unknown'),
      streamStatus: String(it?.status?.streamStatus || 'unknown'),
      matchesSavedKey: !!keyTail && !!streamName && streamName.endsWith(keyTail),
    };
  });
  return {
    checkedAt: new Date().toISOString(),
    streams,
    note: streams.length === 0
      ? 'No live streams found on this channel — create one in YouTube Studio → Go Live → Stream first.'
      : 'healthStatus "good" with recent data = YouTube IS receiving. "noData" while we push = the push never arrives (URL/key/network).',
  };
}

/**
 * Test the stored connection (auto-refreshes once on 401).
 */
export async function testYouTubeConnection(userId: string): Promise<{ success: boolean; message: string; channel?: any }> {
  const row = await getYouTubeRow(userId);
  if (!row || (!row.access_token && !row.refresh_token)) {
    return {
      success: false,
      message: 'No YouTube channel linked yet. Click "Connect YouTube Account" to authorize once — it stays saved.'
    };
  }

  const attempt = async (token: string) => fetch(
    'https://www.googleapis.com/youtube/v3/channels?part=snippet,statistics&mine=true',
    { headers: { 'Authorization': `Bearer ${token}`, 'Accept': 'application/json' }, signal: AbortSignal.timeout(30000) }
  );

  try {
    let token = row.access_token || await refreshYouTubeAccessToken(userId);
    if (!token) {
      return { success: false, message: 'Saved YouTube authorization expired. Please reconnect your channel.' };
    }
    let res = await attempt(token);

    if (res.status === 401 && row.refresh_token) {
      const refreshed = await refreshYouTubeAccessToken(userId);
      if (refreshed && refreshed !== token) {
        token = refreshed;
        res = await attempt(token);
      }
    }

    if (res.ok) {
      const data = await res.json();
      if (data.items && data.items.length > 0) {
        const item = data.items[0];
        const title = item.snippet?.title || row.channel_title || 'Connected Channel';
        const subs = item.statistics?.subscriberCount ? `${item.statistics.subscriberCount}` : row.subscriber_count || '';
        await saveYouTubeRow(userId, {
          channel_id: item.id,
          channel_title: title,
          channel_thumbnail: item.snippet?.thumbnails?.default?.url || row.channel_thumbnail,
          subscriber_count: subs,
          connected: 1
        });
        return {
          success: true,
          message: `Connected to YouTube channel: "${title}"${subs ? ` (${subs} subscribers)` : ''} — stays saved, no need to log in again.`,
          channel: { title, id: item.id, subscribers: subs }
        };
      }
    }

    const errText = await res.text();
    return {
      success: false,
      message: `YouTube API returned status ${res.status}: ${errText.slice(0, 120)}`
    };
  } catch (err: any) {
    return {
      success: false,
      message: `Network error connecting to YouTube Data API: ${err.message}`
    };
  }
}

export interface PublishResult {
  success: boolean;
  videoId: string;
  publishedUrl: string;
  channelTitle: string;
  privacyStatus: string;
  message: string;
}

/**
 * Upload short MP4 video to the USER's linked YouTube channel (resumable
 * upload). The saved refresh token keeps this working indefinitely — the
 * user authorizes once and publishes with one click afterwards.
 */
export async function publishShortToYouTube(
  userId: string,
  videoFilePath: string,
  metadata: {
    title: string;
    description: string;
    tags?: string[];
    privacyStatus?: 'public' | 'unlisted' | 'private';
    /** Verbatim mode (Instagram repost): use title/description exactly as
     *  given — no injected #Shorts or hashtag suffix. */
    verbatim?: boolean;
  }
): Promise<PublishResult> {
  const row = await getYouTubeRow(userId);
  const privacy = metadata.privacyStatus || row?.privacy_status || 'unlisted';

  if (!fs.existsSync(videoFilePath)) {
    throw new Error(`MP4 video file not found at path: ${videoFilePath}`);
  }

  const fileStats = fs.statSync(videoFilePath);
  const fileSize = fileStats.size;

  // Format title safely within YouTube's strict 100 character limit
  let safeTitle = sanitizeSingleLine(metadata.title || 'Breaking Google Trends Explained');
  let safeDescription: string;
  if (metadata.verbatim) {
    safeTitle = safeTitle.slice(0, 100);
    safeDescription = sanitizeMultiline(metadata.description || safeTitle).slice(0, 4800);
  } else {
    if (!safeTitle.includes('#Shorts')) {
      if (safeTitle.length > 90) {
        safeTitle = safeTitle.slice(0, 87).trim() + '...';
      }
      safeTitle = `${safeTitle} #Shorts`;
    } else if (safeTitle.length > 100) {
      safeTitle = safeTitle.slice(0, 97).trim() + '...';
    }

    safeDescription = sanitizeMultiline(metadata.description || safeTitle).slice(0, 4800) +
      (metadata.description?.includes('#Shorts') ? '' : '\n\n#Shorts #TrendingNews #GoogleTrends');
  }

  const safeTags = (metadata.tags && metadata.tags.length > 0)
    ? metadata.tags.slice(0, 15).map(t => t.slice(0, 40))
    : ['#Shorts', 'Trending', 'News', 'GoogleTrends'];

  // Saved token first, silent refresh when needed — no user interaction.
  let token = await activeYouTubeToken(userId);

  if (!token) {
    throw new Error('No YouTube channel linked to your account yet. Click "Connect YouTube Account" once — it stays saved afterwards.');
  }

  // Upload directly via YouTube Data API v3 Resumable Upload.
  // Bounded: raw fetch without a signal hangs FOREVER on a stalled socket,
  // wedging the io-queue slot AND the watch's cycle guard — the timer then
  // "fires" every minute but never publishes again. Init gets 60s; the byte
  // PUT gets 10 min (a Short at any sane uplink fits; a stall aborts loudly
  // and the post stays retryable instead of wedging the queue).
  const performUpload = async (authToken: string) => {
    const initRes = await fetch('https://www.googleapis.com/upload/youtube/v3/videos?uploadType=resumable&part=snippet,status', {
      method: 'POST',
      signal: AbortSignal.timeout(60000),
      headers: {
        'Authorization': `Bearer ${authToken}`,
        'Content-Type': 'application/json; charset=UTF-8',
        'X-Upload-Content-Length': fileSize.toString(),
        'X-Upload-Content-Type': 'video/mp4'
      },
      body: JSON.stringify({
        snippet: {
          title: safeTitle,
          description: safeDescription,
          tags: safeTags,
          categoryId: '25' // News & Politics
        },
        status: {
          privacyStatus: privacy,
          selfDeclaredMadeForKids: false
        }
      })
    });

    if (!initRes.ok) {
      const errText = await initRes.text();
      let parsedMsg = errText;
      try {
        const j = JSON.parse(errText);
        parsedMsg = j.error?.message || errText;
      } catch (_) {}
      return { ok: false, status: initRes.status, error: parsedMsg };
    }

    const uploadUrl = initRes.headers.get('location');
    if (!uploadUrl) {
      return { ok: false, status: 500, error: 'Google YouTube upload server did not return a resumable upload location.' };
    }

    const videoBuffer = fs.readFileSync(videoFilePath);
    const uploadRes = await fetch(uploadUrl, {
      method: 'PUT',
      signal: AbortSignal.timeout(600000),
      headers: {
        'Content-Length': fileSize.toString(),
        'Content-Type': 'video/mp4'
      },
      body: videoBuffer
    });

    if (!uploadRes.ok) {
      const uploadErr = await uploadRes.text();
      let parsedMsg = uploadErr;
      try {
        const j = JSON.parse(uploadErr);
        parsedMsg = j.error?.message || uploadErr;
      } catch (_) {}
      return { ok: false, status: uploadRes.status, error: `Upload stream failed: ${parsedMsg}` };
    }

    const uploadData = await uploadRes.json();
    return { ok: true, data: uploadData };
  };

  let uploadAttempt = await performUpload(token);

  // If unauthorized, attempt token refresh once
  if (!uploadAttempt.ok && uploadAttempt.status === 401) {
    const refreshed = await refreshYouTubeAccessToken(userId);
    if (refreshed && refreshed !== token) {
      token = refreshed;
      uploadAttempt = await performUpload(token);
    }
  }

  if (!uploadAttempt.ok) {
    throw new Error(`YouTube API Error: ${uploadAttempt.error}`);
  }

  const videoId = uploadAttempt.data.id;
  const publishedUrl = `https://youtube.com/shorts/${videoId}`;
  const status = await getYouTubeStatus(userId);
  await saveYouTubeRow(userId, { last_publish_date: new Date().toISOString(), last_video_id: videoId });

  return {
    success: true,
    videoId,
    publishedUrl,
    channelTitle: status.channelTitle || 'Connected YouTube Channel',
    privacyStatus: privacy,
    message: `Video successfully published directly to your YouTube channel "${status.channelTitle}" as ${privacy.toUpperCase()}!`
  };
}

export interface AdminUploadItem {
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
  /** Canonical watch URL (works for Shorts too) + privacy-friendly embed. */
  url: string;
  embedUrl: string;
}

/** Bounded YouTube Data API GET (never wedges the admin aggregation). */
async function ytGetJson(url: string, token: string, ms = 15000): Promise<any> {
  const res = await fetch(url, {
    headers: { 'Authorization': `Bearer ${token}`, 'Accept': 'application/json' },
    signal: AbortSignal.timeout(ms)
  });
  if (res.status === 401) {
    const err: any = new Error('UNAUTHORIZED');
    err.status = 401;
    throw err;
  }
  if (!res.ok) {
    const body = await res.text().catch(() => '');
    throw new Error(`YouTube API returned ${res.status}: ${body.slice(0, 120)}`);
  }
  return res.json();
}

function toCount(v: unknown): number | null {
  const n = Number(v);
  return Number.isFinite(n) ? n : null;
}

/**
 * Latest uploads of ONE user's linked channel (admin use): uploads playlist
 * -> playlistItems -> videos statistics. Refreshes the token once on 401.
 * Throws when the channel has no usable token — the caller records a
 * per-channel error instead of failing the whole panel.
 */
export async function fetchChannelLatestUploads(
  userId: string,
  maxResults = 3
): Promise<{ items: AdminUploadItem[]; channelId: string; channelTitle: string; subscriberCount: string | null }> {
  const n = Math.min(10, Math.max(1, Math.floor(Number(maxResults) || 3)));
  let token = await activeYouTubeToken(userId);
  if (!token) throw new Error('No usable YouTube token for this account.');

  const run = async (t: string) => {
    const mine = await ytGetJson(
      'https://www.googleapis.com/youtube/v3/channels?part=snippet,contentDetails,statistics&mine=true',
      t
    );
    const ch = mine?.items?.[0];
    if (!ch) throw new Error('Channel not found for this account.');
    // Fresh subscriber count on every fetch (admin header shows it live).
    // Best-effort persist so the stored value never goes stale.
    const freshSubs = ch?.statistics?.subscriberCount != null ? String(ch.statistics.subscriberCount) : null;
    if (freshSubs != null) {
      try { await saveYouTubeRow(userId, { subscriber_count: freshSubs }); } catch { /* never fail uploads over a counter */ }
    }
    const uploadsPlaylist = ch?.contentDetails?.relatedPlaylists?.uploads;
    if (!uploadsPlaylist) throw new Error('Uploads playlist unavailable.');
    const pl = await ytGetJson(
      `https://www.googleapis.com/youtube/v3/playlistItems?part=snippet,contentDetails&playlistId=${encodeURIComponent(uploadsPlaylist)}&maxResults=${n}`,
      t
    );
    const ids: string[] = (Array.isArray(pl?.items) ? pl.items : [])
      .map((it: any) => String(it?.contentDetails?.videoId || it?.snippet?.resourceId?.videoId || ''))
      .filter(Boolean);
    if (ids.length === 0) {
      return {
        items: [] as AdminUploadItem[],
        channelId: String(ch.id || ''),
        channelTitle: String(ch?.snippet?.title || ''),
        subscriberCount: freshSubs
      };
    }
    const vs = await ytGetJson(
      `https://www.googleapis.com/youtube/v3/videos?part=snippet,statistics&id=${ids.map(encodeURIComponent).join(',')}`,
      t
    );
    const items: AdminUploadItem[] = (Array.isArray(vs?.items) ? vs.items : []).map((v: any) => {
      const id = String(v?.id || '');
      const thumbs = v?.snippet?.thumbnails || {};
      return {
        videoId: id,
        title: sanitizeSingleLine(v?.snippet?.title || '(untitled)'),
        description: sanitizeMultiline(v?.snippet?.description || '').slice(0, 300),
        thumbnail: String(thumbs?.medium?.url || thumbs?.default?.url || ''),
        publishedAt: String(v?.snippet?.publishedAt || ''),
        viewCount: toCount(v?.statistics?.viewCount),
        likeCount: toCount(v?.statistics?.likeCount),
        commentCount: toCount(v?.statistics?.commentCount),
        channelId: String(v?.snippet?.channelId || ch.id || ''),
        channelTitle: sanitizeSingleLine(v?.snippet?.channelTitle || ch?.snippet?.title || ''),
        url: `https://www.youtube.com/watch?v=${id}`,
        embedUrl: `https://www.youtube-nocookie.com/embed/${id}`
      };
    });
    return {
      items,
      channelId: String(ch.id || ''),
      channelTitle: String(ch?.snippet?.title || ''),
      subscriberCount: freshSubs
    };
  };

  try {
    return await run(token);
  } catch (err: any) {
    if (err?.status === 401 || String(err?.message || '').includes('UNAUTHORIZED')) {
      const refreshed = await refreshYouTubeAccessToken(userId);
      if (refreshed && refreshed !== token) {
        token = refreshed;
        return await run(token);
      }
    }
    throw err;
  }
}

/** True when the API refuses for lack of OAuth scope (channel owner must
 *  reconnect once — new consents already include the scope). Distinguished
 *  from quota/rate errors so we never nag about reconnects needlessly. */
function isScopeDenial(status: number | undefined, body: string): boolean {
  if (status !== 403) return false;
  return /insufficientPermissions|insufficient[^a-z]*scope/i.test(body);
}

function needsReconnectError(where: string): Error {
  const e = new Error(`NEEDS_RECONNECT: reconnect the channel once to enable ${where} (new YouTube permission).`);
  (e as any).needsReconnect = true;
  return e;
}

/** POST a top-level comment (the engagement question) on a fresh upload.
 *  Throws NEEDS_RECONNECT when the saved grant predates the write scope. */
export async function postTopComment(userId: string, videoId: string, text: string): Promise<string> {
  const clean = String(text || '').trim().slice(0, 1000);
  if (!clean) throw new Error('Empty comment text.');
  if (!videoId) throw new Error('Missing video id.');
  let token = await activeYouTubeToken(userId);
  if (!token) throw new Error('No usable YouTube token for this account.');
  const run = async (t: string) => {
    const res = await fetch('https://www.googleapis.com/youtube/v3/commentThreads?part=snippet', {
      method: 'POST',
      signal: AbortSignal.timeout(20000),
      headers: {
        'Authorization': `Bearer ${t}`,
        'Content-Type': 'application/json',
        'Accept': 'application/json'
      },
      body: JSON.stringify({
        snippet: {
          videoId,
          topLevelComment: { snippet: { textOriginal: clean } }
        }
      })
    });
    if (res.status === 401) {
      const e: any = new Error('UNAUTHORIZED');
      e.status = 401;
      throw e;
    }
    if (!res.ok) {
      const body = await res.text().catch(() => '');
      if (/commentsDisabled/i.test(body)) throw new Error('Comments are disabled on this video.');
      if (isScopeDenial(res.status, body)) throw needsReconnectError('auto-comments');
      const e: any = new Error(`YouTube API returned ${res.status}: ${body.slice(0, 140)}`);
      e.status = res.status;
      throw e;
    }
    const j = await res.json();
    return String(j?.id || j?.snippet?.topLevelComment?.id || '');
  };
  try {
    return await run(token);
  } catch (err: any) {
    if (err?.status === 401) {
      const refreshed = await refreshYouTubeAccessToken(userId);
      if (refreshed && refreshed !== token) {
        token = refreshed;
        return await run(token);
      }
    }
    throw err;
  }
}

/** Rotate a stale title: refetch the live snippet (update REPLACES it, so a
 *  blind write would wipe description/tags) and rewrite only the title. */
export async function updateVideoTitle(userId: string, videoId: string, title: string): Promise<void> {
  const safe = sanitizeSingleLine(title).slice(0, 100);
  if (!safe) throw new Error('Empty title.');
  if (!videoId) throw new Error('Missing video id.');
  let token = await activeYouTubeToken(userId);
  if (!token) throw new Error('No usable YouTube token for this account.');
  const run = async (t: string) => {
    const cur = await ytGetJson(
      `https://www.googleapis.com/youtube/v3/videos?part=snippet,status&id=${encodeURIComponent(videoId)}`,
      t
    );
    const item = cur?.items?.[0];
    if (!item) throw new Error('Video not found on this channel.');
    const snippet = { ...item.snippet, title: safe };
    delete (snippet as any).thumbnails;
    const res = await fetch('https://www.googleapis.com/youtube/v3/videos?part=snippet', {
      method: 'PUT',
      signal: AbortSignal.timeout(20000),
      headers: {
        'Authorization': `Bearer ${t}`,
        'Content-Type': 'application/json',
        'Accept': 'application/json'
      },
      body: JSON.stringify({ id: videoId, snippet })
    });
    if (res.status === 401) {
      const e: any = new Error('UNAUTHORIZED');
      e.status = 401;
      throw e;
    }
    if (!res.ok) {
      const body = await res.text().catch(() => '');
      if (isScopeDenial(res.status, body)) throw needsReconnectError('title rotation');
      throw new Error(`YouTube API returned ${res.status}: ${body.slice(0, 140)}`);
    }
  };
  try {
    await run(token);
  } catch (err: any) {
    if (err?.status === 401) {
      const refreshed = await refreshYouTubeAccessToken(userId);
      if (refreshed && refreshed !== token) {
        token = refreshed;
        await run(token);
        return;
      }
    }
    throw err;
  }
}

export interface RetentionRow {
  videoId: string;
  views: number;
  avgViewDurationSec: number;
  avgViewPercentage: number;
}

/** Per-video retention via the Analytics API (ids=channel==MINE + video
 *  filter, last 30 days). Needs the analytics scope — NEEDS_RECONNECT
 *  otherwise, so old grants degrade to "no retention data" instead of 403s. */
/** Read the connected channel's "About" (snippet.description) for auto-tagging. */
export async function fetchChannelAbout(userId: string): Promise<string> {
  try {
    const token = await getYouTubeAccessToken(userId);
    if (!token) return '';
    const r = await fetch('https://www.googleapis.com/youtube/v3/channels?part=snippet&mine=true', {
      headers: { Authorization: `Bearer ${token}` },
      signal: AbortSignal.timeout(15000)
    });
    if (!r.ok) return '';
    const d: any = await r.json();
    return sanitizeMultiline(String(d?.items?.[0]?.snippet?.description || ''));
  } catch {
    return '';
  }
}

export async function fetchVideoRetention(userId: string, videoIds: string[]): Promise<RetentionRow[]> {
  const ids = [...new Set((videoIds || []).map(String).filter(Boolean))].slice(0, 25);
  if (ids.length === 0) return [];
  let token = await activeYouTubeToken(userId);
  if (!token) throw new Error('No usable YouTube token for this account.');
  const end = new Date().toISOString().slice(0, 10);
  const start = new Date(Date.now() - 30 * 24 * 3600 * 1000).toISOString().slice(0, 10);
  const run = async (t: string) => {
    const url = 'https://youtubeanalytics.googleapis.com/v2/reports?' + new URLSearchParams({
      ids: 'channel==MINE',
      startDate: start,
      endDate: end,
      metrics: 'views,averageViewDuration,averageViewPercentage',
      dimensions: 'video',
      filters: `video==${ids.join(',')}`,
      sort: '-views'
    }).toString();
    const res = await fetch(url, {
      headers: { 'Authorization': `Bearer ${t}`, 'Accept': 'application/json' },
      signal: AbortSignal.timeout(20000)
    });
    if (res.status === 401) {
      const e: any = new Error('UNAUTHORIZED');
      e.status = 401;
      throw e;
    }
    if (!res.ok) {
      const body = await res.text().catch(() => '');
      if (isScopeDenial(res.status, body)) throw needsReconnectError('retention stats');
      throw new Error(`YouTube Analytics returned ${res.status}: ${body.slice(0, 140)}`);
    }
    const j = await res.json();
    const headers: string[] = (j?.columnHeaders || []).map((h: any) => String(h?.name || ''));
    const rows: any[][] = Array.isArray(j?.rows) ? j.rows : [];
    const num = (v: unknown): number => {
      const n = Number(v);
      return Number.isFinite(n) ? n : 0;
    };
    return rows.map(r => {
      const get = (name: string) => num(r[headers.indexOf(name)]);
      return {
        videoId: String(r[headers.indexOf('video')] || ''),
        views: get('views'),
        avgViewDurationSec: Math.round(get('averageViewDuration') * 10) / 10,
        avgViewPercentage: Math.round(get('averageViewPercentage') * 10) / 10
      } as RetentionRow;
    }).filter(x => x.videoId);
  };
  try {
    return await run(token);
  } catch (err: any) {
    if (err?.status === 401) {
      const refreshed = await refreshYouTubeAccessToken(userId);
      if (refreshed && refreshed !== token) {
        token = refreshed;
        return await run(token);
      }
    }
    throw err;
  }
}
