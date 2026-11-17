import fs from 'fs';
import path from 'path';
import crypto from 'crypto';
import mysql from 'mysql2/promise';

// ---------------------------------------------------------------------------
// Trend Video Engine persistence (MySQL — dedicated `dbvideo` database,
// same host/credentials contract as the rest of the repo).
//
// ENV (dedicated DB name wins so the shared root DB_NAME=dbportal never
// hijacks this service):
//   TRENDLOGIC_DB_NAME / DBVIDEO_DB_NAME / MYSQL_DATABASE  -> default `dbvideo`
//   DB_HOST / MYSQL_HOST      default remote-pishgaman.runflare.com
//   DB_PORT / MYSQL_PORT      default 31720
//   DB_USER / MYSQL_USER      default root
//   DB_PASSWORD / MYSQL_PASSWORD
//
// Tables (tl_* prefix kept so existing queries stay unchanged):
//   tl_users     accounts (email + scrypt password hash)
//   tl_sessions  httpOnly session tokens
//   tl_prefs     per-user personalization (AI model default, brand color)
//   tl_videos    per-user generated video records (files live on disk)
// ---------------------------------------------------------------------------

const MYSQL_HOST = process.env.DB_HOST || process.env.MYSQL_HOST || 'remote-pishgaman.runflare.com';
const MYSQL_USER = process.env.DB_USER || process.env.MYSQL_USER || 'root';
const MYSQL_PASSWORD = process.env.DB_PASSWORD || process.env.MYSQL_PASSWORD || 'xWs47ePmR7qinNYbEByi';
const MYSQL_DATABASE = process.env.TRENDLOGIC_DB_NAME || process.env.DBVIDEO_DB_NAME || process.env.MYSQL_DATABASE || 'dbvideo';
const MYSQL_PORT = parseInt(process.env.DB_PORT || process.env.MYSQL_PORT || '31720', 10);

const SESSION_TTL_MS = 90 * 24 * 60 * 60 * 1000; // 90 days

let mysqlPool: mysql.Pool | null = null;
let dbReady = false;

try {
  mysqlPool = mysql.createPool({
    host: MYSQL_HOST,
    user: MYSQL_USER,
    password: MYSQL_PASSWORD,
    database: MYSQL_DATABASE,
    port: MYSQL_PORT,
    waitForConnections: true,
    connectionLimit: parseInt(process.env.DB_POOL_LIMIT || '50', 10),
    maxIdle: 10,
    idleTimeout: 60000,
    queueLimit: 0,
    connectTimeout: 8000,
    enableKeepAlive: true,
    keepAliveInitialDelay: 10000
  });
  console.log(`[DB] MySQL pool configured (${MYSQL_HOST}:${MYSQL_PORT}/${MYSQL_DATABASE})`);
} catch (err) {
  console.error('[DB] MySQL pool creation failed:', err);
  mysqlPool = null;
}

export function isDbReady(): boolean {
  return dbReady;
}

export async function initDatabase(): Promise<boolean> {
  if (!mysqlPool) return false;
  try {
    const admin = await mysql.createConnection({
      host: MYSQL_HOST,
      user: MYSQL_USER,
      password: MYSQL_PASSWORD,
      port: MYSQL_PORT,
      connectTimeout: 8000
    });
    try {
      await admin.query(`CREATE DATABASE IF NOT EXISTS \`${MYSQL_DATABASE}\` CHARACTER SET utf8mb4 COLLATE utf8mb4_unicode_ci;`);
    } finally {
      await admin.end();
    }
  } catch (err) {
    console.warn('[DB] ensure database note:', (err as Error).message);
  }
  let conn: mysql.PoolConnection | null = null;
  try {
    conn = await mysqlPool.getConnection();
    await conn.query(`
      CREATE TABLE IF NOT EXISTS tl_users (
        id VARCHAR(64) PRIMARY KEY,
        email VARCHAR(191) NOT NULL UNIQUE,
        password_hash VARCHAR(255) NOT NULL,
        name VARCHAR(128) NOT NULL,
        role VARCHAR(32) DEFAULT 'user',
        status VARCHAR(32) DEFAULT 'active',
        created_at VARCHAR(64),
        updated_at VARCHAR(64)
      ) ENGINE=InnoDB DEFAULT CHARSET=utf8mb4;
    `);
    await conn.query(`
      CREATE TABLE IF NOT EXISTS tl_sessions (
        token VARCHAR(128) PRIMARY KEY,
        user_id VARCHAR(64) NOT NULL,
        created_at VARCHAR(64),
        expires_at VARCHAR(64),
        KEY idx_tl_sessions_user (user_id)
      ) ENGINE=InnoDB DEFAULT CHARSET=utf8mb4;
    `);
    await conn.query(`
      CREATE TABLE IF NOT EXISTS tl_prefs (
        user_id VARCHAR(64) PRIMARY KEY,
        preferred_ai_model VARCHAR(32) DEFAULT 'flux',
        brand_color VARCHAR(16) DEFAULT '#dc2626',
        updated_at VARCHAR(64),
        created_at VARCHAR(64)
      ) ENGINE=InnoDB DEFAULT CHARSET=utf8mb4;
    `);
    await conn.query(`
      CREATE TABLE IF NOT EXISTS tl_videos (
        id VARCHAR(64) PRIMARY KEY,
        user_id VARCHAR(64) NOT NULL,
        filename VARCHAR(255) NOT NULL UNIQUE,
        keyword VARCHAR(255),
        is_ai TINYINT DEFAULT 0,
        visual_method VARCHAR(64),
        size_bytes BIGINT DEFAULT 0,
        duration_sec DOUBLE DEFAULT 0,
        created_at VARCHAR(64),
        KEY idx_tl_videos_user (user_id)
      ) ENGINE=InnoDB DEFAULT CHARSET=utf8mb4;
    `);
    await conn.query(`
      CREATE TABLE IF NOT EXISTS tl_youtube (
        user_id VARCHAR(64) PRIMARY KEY,
        access_token TEXT,
        refresh_token TEXT,
        channel_id VARCHAR(128),
        channel_title VARCHAR(255),
        channel_thumbnail VARCHAR(512),
        subscriber_count VARCHAR(64),
        privacy_status VARCHAR(16) DEFAULT 'public',
        connected TINYINT DEFAULT 0,
        last_video_id VARCHAR(64),
        last_publish_date VARCHAR(64),
        created_at VARCHAR(64),
        updated_at VARCHAR(64)
      ) ENGINE=InnoDB DEFAULT CHARSET=utf8mb4;
    `);
    // Scope-denial flag for pre-existing rows (fresh connects reset it).
    await ensureColumn(conn, 'tl_youtube', 'needs_reconnect', 'TINYINT DEFAULT 0');
    // Per-user TikTok OAuth (same posture as tl_youtube: tokens live in MySQL
    // so a login persists across restarts; the API-facing access token is
    // short-lived and silently refreshed from the stored refresh token).
    await conn.query(`
      CREATE TABLE IF NOT EXISTS tl_tiktok (
        user_id VARCHAR(64) PRIMARY KEY,
        access_token TEXT,
        refresh_token TEXT,
        open_id VARCHAR(128),
        display_name VARCHAR(255),
        avatar_url VARCHAR(512),
        privacy_level VARCHAR(32) DEFAULT 'PUBLIC_TO_EVERYONE',
        connected TINYINT DEFAULT 0,
        last_publish_id VARCHAR(128),
        last_publish_date VARCHAR(64),
        created_at VARCHAR(64),
        updated_at VARCHAR(64)
      ) ENGINE=InnoDB DEFAULT CHARSET=utf8mb4;
    `);
    await conn.query(`
      CREATE TABLE IF NOT EXISTS tl_ig_watch (
        id VARCHAR(64) PRIMARY KEY,
        user_id VARCHAR(64) NOT NULL,
        profile_url VARCHAR(512) NOT NULL,
        username VARCHAR(128) NOT NULL,
        enabled TINYINT DEFAULT 1,
        interval_hours DOUBLE DEFAULT 24,
        auto_publish TINYINT DEFAULT 1,
        privacy_status VARCHAR(16) DEFAULT 'public',
        daily_times TEXT,
        daily_tz VARCHAR(64) DEFAULT 'UTC',
        hashtags TEXT,
        last_check_at VARCHAR(64),
        next_run_at VARCHAR(64),
        last_shortcode VARCHAR(128),
        last_error VARCHAR(512),
        created_at VARCHAR(64),
        updated_at VARCHAR(64),
        KEY idx_tl_ig_watch_user (user_id),
        KEY idx_tl_ig_watch_next (enabled, next_run_at)
      ) ENGINE=InnoDB DEFAULT CHARSET=utf8mb4;
    `);
    // Deploy-proof migration for pre-existing tables: exact daily firing
    // times per watch (empty = classic rolling interval mode).
    await ensureColumn(conn, 'tl_ig_watch', 'daily_times', 'TEXT');
    await ensureColumn(conn, 'tl_ig_watch', 'daily_tz', `VARCHAR(64) DEFAULT 'UTC'`);
    await ensureColumn(conn, 'tl_ig_watch', 'hashtags', 'TEXT');
    // IG-to-Live: per-profile live loop. live_enabled arms it (the watch's
    // own timer then keeps the newest reel on air); live_shortcode tracks
    // which reel is currently looping; live_started_at marks the takeover.
    await ensureColumn(conn, 'tl_ig_watch', 'live_enabled', 'TINYINT DEFAULT 0');
    await ensureColumn(conn, 'tl_ig_watch', 'live_shortcode', 'VARCHAR(128)');
    await ensureColumn(conn, 'tl_ig_watch', 'live_started_at', 'VARCHAR(64)');
    await conn.query(`
      CREATE TABLE IF NOT EXISTS tl_ig_posts (
        id VARCHAR(64) PRIMARY KEY,
        watch_id VARCHAR(64) NOT NULL,
        user_id VARCHAR(64) NOT NULL,
        shortcode VARCHAR(128) NOT NULL,
        insta_url VARCHAR(512),
        caption TEXT,
        yt_title VARCHAR(255),
        filename VARCHAR(255),
        yt_video_id VARCHAR(64),
        yt_url VARCHAR(512),
        status VARCHAR(32) DEFAULT 'downloaded',
        error VARCHAR(512),
        created_at VARCHAR(64),
        UNIQUE KEY uq_tl_ig_posts_watch_shortcode (watch_id, shortcode),
        KEY idx_tl_ig_posts_user (user_id),
        KEY idx_tl_ig_posts_watch (watch_id)
      ) ENGINE=InnoDB DEFAULT CHARSET=utf8mb4;
    `);
    // Deploy-proof migration: exact publish moment per reel (created_at is the
    // DISCOVERY time, so the Admin Panel stats need their own column).
    await ensureColumn(conn, 'tl_ig_posts', 'published_at', 'VARCHAR(64)');
    // Direct CDN link captured at discovery time (RapidAPI previewUrl). The
    // publish step tries it FIRST — it is the only download path that works
    // for 18+/login-walled profiles, and it expires, so it must be stored
    // when fresh, not re-queried later.
    await ensureColumn(conn, 'tl_ig_posts', 'preview_url', 'TEXT');
    // Winner-content metrics (free inside the RapidAPI Userinfo response — no
    // extra quota): per-reel view/like/comment counts + the derived score the
    // publish queue orders by (highest first). Deploy-proof migrations for
    // pre-existing tables; older rows read as 0 (treated as unscored).
    await ensureColumn(conn, 'tl_ig_posts', 'play_count', 'BIGINT DEFAULT 0');
    await ensureColumn(conn, 'tl_ig_posts', 'like_count', 'BIGINT DEFAULT 0');
    await ensureColumn(conn, 'tl_ig_posts', 'comment_count', 'BIGINT DEFAULT 0');
    await ensureColumn(conn, 'tl_ig_posts', 'winner_score', 'BIGINT DEFAULT 0');
    // Auto-Pilot timer per user — the ONLY durable home for the schedule.
    // (The old data/autoSchedule.json file died with every redeploy because
    // neither the deploy bundle nor a volume carried it; this table survives.)
    await conn.query(`
      CREATE TABLE IF NOT EXISTS tl_auto_schedule (
        user_id VARCHAR(64) PRIMARY KEY,
        enabled TINYINT DEFAULT 0,
        interval_hours DOUBLE DEFAULT 2,
        auto_publish TINYINT DEFAULT 0,
        country VARCHAR(8) DEFAULT 'US',
        last_run_at VARCHAR(64),
        next_run_at VARCHAR(64),
        last_job_id VARCHAR(64),
        created_at VARCHAR(64),
        updated_at VARCHAR(64),
        KEY idx_tl_auto_schedule_next (enabled, next_run_at)
      ) ENGINE=InnoDB DEFAULT CHARSET=utf8mb4;
    `);
    // Live broadcast session per user — the ONLY durable home for the RTMP
    // push. The stream key lives here (same posture as tl_youtube OAuth
    // tokens, never returned to any client) so a server restart/redeploy
    // auto-resumes the broadcast without any browser being open.
    await conn.query(`
      CREATE TABLE IF NOT EXISTS tl_live_stream (
        user_id VARCHAR(64) PRIMARY KEY,
        rtmp_url VARCHAR(512),
        stream_key VARCHAR(256),
        topic_keyword VARCHAR(256),
        started_at VARCHAR(64),
        updated_at VARCHAR(64)
      ) ENGINE=InnoDB DEFAULT CHARSET=utf8mb4;
    `);
    await ensureColumn(conn, 'tl_live_stream', 'orientation', `VARCHAR(8) DEFAULT 'vertical'`);
    // IG-to-Live resume: which source feeds the push (news cards vs an
    // Instagram reel loop) + which watch owns the reel loop.
    await ensureColumn(conn, 'tl_live_stream', 'mode', `VARCHAR(8) DEFAULT 'news'`);
    await ensureColumn(conn, 'tl_live_stream', 'reel_watch_id', 'VARCHAR(64)');
    await ensureColumn(conn, 'tl_live_stream', 'reel_shortcode', 'VARCHAR(128)');
    // Per-account stream defaults: the YouTube stream key is entered ONCE and
    // reused for every later Go Live (never returned to any client — only a
    // masked hint leaves the backend, same posture as tl_youtube tokens).
    await conn.query(`
      CREATE TABLE IF NOT EXISTS tl_stream_settings (
        user_id VARCHAR(64) PRIMARY KEY,
        stream_key VARCHAR(256),
        rtmp_url VARCHAR(512),
        orientation VARCHAR(8) DEFAULT 'vertical',
        updated_at VARCHAR(64)
      ) ENGINE=InnoDB DEFAULT CHARSET=utf8mb4;
    `);
    // Relax Shorts: one durable timer per user (latest AI soundscape -> 40s
    // Short -> YouTube). Same deploy-proof pattern as tl_auto_schedule.
    await conn.query(`
      CREATE TABLE IF NOT EXISTS tl_relax_schedule (
        user_id VARCHAR(64) PRIMARY KEY,
        enabled TINYINT DEFAULT 0,
        interval_hours DOUBLE DEFAULT 24,
        privacy_status VARCHAR(16) DEFAULT 'public',
        daily_times TEXT,
        daily_tz VARCHAR(64) DEFAULT 'UTC',
        last_run_at VARCHAR(64),
        next_run_at VARCHAR(64),
        last_relax_post_id VARCHAR(64),
        last_yt_video_id VARCHAR(64),
        last_error VARCHAR(512),
        created_at VARCHAR(64),
        updated_at VARCHAR(64),
        KEY idx_tl_relax_schedule_next (enabled, next_run_at)
      ) ENGINE=InnoDB DEFAULT CHARSET=utf8mb4;
    `);
    await ensureColumn(conn, 'tl_relax_schedule', 'daily_times', 'TEXT');
    await ensureColumn(conn, 'tl_relax_schedule', 'daily_tz', `VARCHAR(64) DEFAULT 'UTC'`);
    await ensureColumn(conn, 'tl_relax_schedule', 'last_error', 'VARCHAR(512)');
    // Optional Instagram profile whose reels become the Relax Short's VIDEO
    // (audio stays from Relax). Empty = legacy cover-image Short.
    await ensureColumn(conn, 'tl_relax_schedule', 'ig_profile_url', 'VARCHAR(512)');
    // JSON array of the last ~12 shortcodes already used as the Relax video —
    // random reel picks avoid these so the same reel does not repeat.
    await ensureColumn(conn, 'tl_relax_schedule', 'ig_last_shortcodes', 'TEXT');
    // Relax Shorts publish log: (user_id, relax_post_id) UNIQUE — a Relax
    // post is never published twice for the same user.
    await conn.query(`
      CREATE TABLE IF NOT EXISTS tl_relax_posts (
        id VARCHAR(64) PRIMARY KEY,
        user_id VARCHAR(64) NOT NULL,
        relax_post_id VARCHAR(64) NOT NULL,
        relax_title VARCHAR(255),
        filename VARCHAR(255),
        yt_video_id VARCHAR(64),
        yt_url VARCHAR(512),
        status VARCHAR(32) DEFAULT 'published',
        error VARCHAR(512),
        created_at VARCHAR(64),
        UNIQUE KEY uq_tl_relax_posts_user_post (user_id, relax_post_id),
        KEY idx_tl_relax_posts_user (user_id)
      ) ENGINE=InnoDB DEFAULT CHARSET=utf8mb4;
    `);
    // Admin Panel audit trail: who opened what and when (manager-only views).
    await conn.query(`
      CREATE TABLE IF NOT EXISTS tl_admin_audit (
        id VARCHAR(64) PRIMARY KEY,
        admin_user_id VARCHAR(64) NOT NULL,
        admin_name VARCHAR(128) NOT NULL,
        action VARCHAR(64) NOT NULL,
        detail VARCHAR(512),
        created_at VARCHAR(64),
        KEY idx_tl_admin_audit_time (created_at)
      ) ENGINE=InnoDB DEFAULT CHARSET=utf8mb4;
    `);
    // Virality engine: one title rotation per video, ever.
    await conn.query(`
      CREATE TABLE IF NOT EXISTS tl_title_rotations (
        video_id VARCHAR(64) PRIMARY KEY,
        user_id VARCHAR(64) NOT NULL,
        old_title VARCHAR(255),
        new_title VARCHAR(255),
        views_at_rotation BIGINT DEFAULT 0,
        created_at VARCHAR(64),
        KEY idx_tl_title_rotations_time (created_at)
      ) ENGINE=InnoDB DEFAULT CHARSET=utf8mb4;
    `);
    // Trend publish ledger: every trend-video YouTube upload is recorded
    // here (topic + channel + time). The Auto-Pilot / publish guards consult
    // THIS — not the in-memory job list — so a restart/redeploy can never
    // re-upload the same topic to the same channel (the duplicate-upload bug).
    await conn.query(`
      CREATE TABLE IF NOT EXISTS tl_trend_publishes (
        id VARCHAR(64) PRIMARY KEY,
        user_id VARCHAR(64) NOT NULL,
        channel_id VARCHAR(128),
        norm_keyword VARCHAR(255) NOT NULL,
        keyword VARCHAR(255),
        title VARCHAR(255),
        yt_video_id VARCHAR(64),
        job_id VARCHAR(64),
        published_at VARCHAR(64),
        KEY idx_tl_trend_publishes_user (user_id, norm_keyword),
        KEY idx_tl_trend_publishes_channel (channel_id, norm_keyword)
      ) ENGINE=InnoDB DEFAULT CHARSET=utf8mb4;
    `);
    // Per-user uploaded files (Uploder tab): files live on disk under
    // public/uploads/<user_id>/; this table tracks ownership + metadata.
    await conn.query(`
      CREATE TABLE IF NOT EXISTS tl_upload_files (
        id VARCHAR(64) PRIMARY KEY,
        user_id VARCHAR(64) NOT NULL,
        filename VARCHAR(255) NOT NULL,
        original_name VARCHAR(255),
        size_bytes BIGINT DEFAULT 0,
        mime VARCHAR(128),
        youtube_scheduled_at VARCHAR(64),
        youtube_status VARCHAR(32) DEFAULT 'none',
        youtube_video_id VARCHAR(64),
        youtube_url VARCHAR(512),
        youtube_error VARCHAR(512),
        created_at VARCHAR(64),
        KEY idx_tl_upload_files_user (user_id),
        KEY idx_tl_upload_files_sched (youtube_status, youtube_scheduled_at)
      ) ENGINE=InnoDB DEFAULT CHARSET=utf8mb4;
    `);
    // Per-user storage quota purchased with crypto. quota_bytes is the total
    // allowance granted by approved purchases; used_bytes is recomputed from
    // tl_upload_files on demand but cached here for quick checks.
    await conn.query(`
      CREATE TABLE IF NOT EXISTS tl_upload_quota (
        user_id VARCHAR(64) PRIMARY KEY,
        quota_bytes BIGINT DEFAULT 0,
        used_bytes BIGINT DEFAULT 0,
        updated_at VARCHAR(64)
      ) ENGINE=InnoDB DEFAULT CHARSET=utf8mb4;
    `);
    await conn.query(`
      CREATE TABLE IF NOT EXISTS tl_email_codes (
        id VARCHAR(64) PRIMARY KEY,
        email VARCHAR(255) NOT NULL,
        purpose VARCHAR(32) NOT NULL,
        code VARCHAR(16) NOT NULL,
        expires_at VARCHAR(64) NOT NULL,
        used TINYINT(1) DEFAULT 0,
        created_at VARCHAR(64),
        KEY idx_tl_email_codes_email (email, purpose)
      ) ENGINE=InnoDB DEFAULT CHARSET=utf8mb4;
    `);
    // Performance indexes for auth/session hot paths (idempotent).
    try { await conn.query('CREATE INDEX idx_tl_sessions_expires ON tl_sessions (expires_at)'); } catch { /* exists */ }
    try { await conn.query('CREATE INDEX idx_tl_email_codes_created ON tl_email_codes (created_at)'); } catch { /* exists */ }
    // Crypto storage purchase requests: user submits tx hash/proof, admin
    // approves (grants quota) or rejects.
    await conn.query(`
      CREATE TABLE IF NOT EXISTS tl_storage_purchases (
        id VARCHAR(64) PRIMARY KEY,
        user_id VARCHAR(64) NOT NULL,
        bytes_requested BIGINT NOT NULL,
        crypto_network VARCHAR(64),
        tx_hash VARCHAR(255),
        proof TEXT,
        status VARCHAR(32) DEFAULT 'pending',
        admin_user_id VARCHAR(64),
        admin_note VARCHAR(512),
        created_at VARCHAR(64),
        decided_at VARCHAR(64),
        KEY idx_tl_storage_purchases_user (user_id),
        KEY idx_tl_storage_purchases_status (status)
      ) ENGINE=InnoDB DEFAULT CHARSET=utf8mb4;
    `);
    await ensureColumn(conn, 'tl_storage_purchases', 'months_requested', 'INT DEFAULT 0');
      await ensureColumn(conn, 'tl_upload_quota', 'subscription_expires_at', 'VARCHAR(64)');
      await ensureColumn(conn, 'tl_upload_quota', 'expiry_notified_at', 'VARCHAR(64)');
    // Roles for pre-existing installs + one-time admin bootstrap
    // whose display name is "Admin" owns the manager role, everyone else
    // stays 'user'. Idempotent by construction — only promotes rows that are
    // not already manager, never creates or demotes anyone.
    await ensureColumn(conn, 'tl_users', 'role', `VARCHAR(32) DEFAULT 'user'`);
    try {
      await conn.query(
        `UPDATE tl_users SET role = 'manager' WHERE LOWER(TRIM(name)) = 'admin' AND (role IS NULL OR role != 'manager')`
      );
    } catch (err) {
      console.warn('[DB] admin bootstrap note:', (err as Error).message);
    }
    dbReady = true;
    console.log(`[DB] Tables ready in '${MYSQL_DATABASE}' (tl_users, tl_sessions, tl_prefs, tl_videos, tl_youtube, tl_tiktok, tl_ig_watch, tl_ig_posts, tl_auto_schedule, tl_live_stream).`);
    return true;
  } catch (err) {
    console.error('[DB] initDatabase failed:', err);
    dbReady = false;
    return false;
  } finally {
    if (conn) conn.release();
  }
}

// ---------------------------------------------------------------------------
// Password hashing (scrypt, salt per user). Format: scrypt$N$salt$hash
// ---------------------------------------------------------------------------

const SCRYPT_N = 16384;

export function hashPassword(password: string): string {
  const salt = crypto.randomBytes(16);
  const derived = crypto.scryptSync(password, salt, 64, { N: SCRYPT_N });
  return `scrypt$${SCRYPT_N}$${salt.toString('base64')}$${derived.toString('base64')}`;
}

export function verifyPassword(password: string, stored: string): boolean {
  try {
    const parts = stored.split('$');
    if (parts.length !== 4 || parts[0] !== 'scrypt') return false;
    const n = parseInt(parts[1], 10);
    const salt = Buffer.from(parts[2], 'base64');
    const expected = Buffer.from(parts[3], 'base64');
    const derived = crypto.scryptSync(password, salt, 64, { N: n });
    return crypto.timingSafeEqual(derived, expected);
  } catch {
    return false;
  }
}

// ---------------------------------------------------------------------------
// Users & sessions
// ---------------------------------------------------------------------------

export interface DbUser {
  id: string;
  email: string;
  name: string;
  role: string;
  status: string;
  created_at?: string;
}

export interface DbPrefs {
  preferred_ai_model: string;
  brand_color: string;
}

export function uuid(): string {
  return crypto.randomUUID();
}

/** ADD COLUMN only when missing (existing installs) — duplicate-column is
 *  swallowed, every other error rethrows. */
async function ensureColumn(conn: mysql.PoolConnection, table: string, column: string, ddl: string): Promise<void> {
  try {
    await conn.query(`ALTER TABLE ${table} ADD COLUMN ${column} ${ddl}`);
  } catch (err: any) {
    if (err?.errno === 1060 || err?.code === 'ER_DUP_FIELDNAME') return;
    throw err;
  }
}

function mapUser(row: any): DbUser {
  return {
    id: row.id,
    email: row.email,
    name: row.name,
    role: row.role || 'user',
    status: row.status || 'active',
    created_at: row.created_at
  };
}

export async function getUserByEmail(email: string): Promise<DbUser | null> {
  if (!mysqlPool) throw new Error('DATABASE_UNAVAILABLE');
  const [rows] = await mysqlPool.query('SELECT * FROM tl_users WHERE email = ? LIMIT 1', [email.toLowerCase().trim()]);
  const r = (rows as any[])[0];
  return r ? mapUser(r) : null;
}

export async function getUserById(id: string): Promise<DbUser | null> {
  if (!mysqlPool) throw new Error('DATABASE_UNAVAILABLE');
  const [rows] = await mysqlPool.query('SELECT * FROM tl_users WHERE id = ? LIMIT 1', [id]);
  const r = (rows as any[])[0];
  return r ? mapUser(r) : null;
}

export async function createUser(input: {
  email: string;
  password: string;
  name: string;
}): Promise<DbUser> {
  if (!mysqlPool) throw new Error('DATABASE_UNAVAILABLE');
  const id = uuid();
  const now = new Date().toISOString();
  await mysqlPool.query(
    'INSERT INTO tl_users (id, email, password_hash, name, role, status, created_at, updated_at) VALUES (?, ?, ?, ?, ?, ?, ?, ?)',
    [id, input.email.toLowerCase().trim(), hashPassword(input.password), input.name.trim() || input.email.split('@')[0], 'user', 'active', now, now]
  );
  await mysqlPool.query('INSERT IGNORE INTO tl_prefs (user_id, preferred_ai_model, brand_color, created_at, updated_at) VALUES (?, ?, ?, ?, ?)', [id, 'flux', '#dc2626', now, now]);
  return getUserById(id) as unknown as DbUser;
}

export async function countUsers(): Promise<number> {
  if (!mysqlPool) throw new Error('DATABASE_UNAVAILABLE');
  const [rows] = await mysqlPool.query('SELECT COUNT(*) AS c FROM tl_users');
  return Number(((rows as any[])[0] || {}).c || 0);
}

export async function getPasswordHash(email: string): Promise<string | null> {  if (!mysqlPool) throw new Error('DATABASE_UNAVAILABLE');
  const [rows] = await mysqlPool.query('SELECT password_hash FROM tl_users WHERE email = ? LIMIT 1', [email.toLowerCase().trim()]);
  const r = (rows as any[])[0];
  return r ? r.password_hash : null;
}

/** Update the caller's own profile (display name + sign-in email). */
export async function updateUserProfile(userId: string, input: { name?: string; email?: string }): Promise<DbUser> {
  if (!mysqlPool) throw new Error('DATABASE_UNAVAILABLE');
  const current = await getUserById(userId);
  if (!current) throw new Error('User not found.');
  const cleanName = input.name !== undefined ? String(input.name || '').trim().slice(0, 128) : current.name;
  if (!cleanName) throw new Error('Please enter a display name.');
  const cleanEmail = input.email !== undefined ? String(input.email || '').trim().toLowerCase() : current.email;
  if (!/^[^\s@]+@[^\s@]+\.[^\s@]+$/.test(cleanEmail)) throw new Error('Please provide a valid email address.');
  if (cleanEmail !== current.email) {
    const [rows] = await mysqlPool.query('SELECT id FROM tl_users WHERE email = ? AND id <> ? LIMIT 1', [cleanEmail, userId]);
    if ((rows as any[])[0]) throw new Error('This email is already in use by another account.');
  }
  await mysqlPool.query('UPDATE tl_users SET name = ?, email = ?, updated_at = ? WHERE id = ?', [cleanName, cleanEmail, new Date().toISOString(), userId]);
  const updated = await getUserById(userId);
  if (!updated) throw new Error('User not found.');
  return updated;
}

/** Rename the caller's own display name (Profile tab). */
export async function updateUserName(userId: string, name: string): Promise<DbUser> {
  return updateUserProfile(userId, { name });
}

/** Change the caller's own password — the current one must verify first. */
export async function changeUserPassword(userId: string, currentPassword: string, newPassword: string): Promise<void> {
  if (!mysqlPool) throw new Error('DATABASE_UNAVAILABLE');
  if (!newPassword || String(newPassword).length < 6) {
    throw new Error('New password must be at least 6 characters.');
  }
  const [rows] = await mysqlPool.query('SELECT password_hash FROM tl_users WHERE id = ? LIMIT 1', [userId]);
  const r = (rows as any[])[0];
  if (!r || !verifyPassword(String(currentPassword || ''), r.password_hash)) {
    throw new Error('Current password is incorrect.');
  }
  await mysqlPool.query('UPDATE tl_users SET password_hash = ?, updated_at = ? WHERE id = ?', [
    hashPassword(String(newPassword)), new Date().toISOString(), userId
  ]);
}

/** Reset a user's password using a verified code (no current password). */
export async function resetUserPassword(userId: string, newPassword: string): Promise<void> {
  if (!mysqlPool) throw new Error('DATABASE_UNAVAILABLE');
  if (!newPassword || String(newPassword).length < 6) {
    throw new Error('New password must be at least 6 characters.');
  }
  await mysqlPool.query('UPDATE tl_users SET password_hash = ?, updated_at = ? WHERE id = ?', [
    hashPassword(String(newPassword)), new Date().toISOString(), userId
  ]);
}

export async function createEmailCode(email: string, purpose: string, code: string, expiresAt: string): Promise<void> {
  if (!mysqlPool) throw new Error('DATABASE_UNAVAILABLE');
  const id = crypto.randomUUID();
  await mysqlPool.query(
    'INSERT INTO tl_email_codes (id, email, purpose, code, expires_at, used, created_at) VALUES (?,?,?,?,?,?,?)',
    [id, email.toLowerCase(), purpose, code, expiresAt, 0, new Date().toISOString()]
  );
}

export async function getLatestEmailCode(email: string, purpose: string): Promise<{ code: string; expires_at: string; used: number } | null> {
  if (!mysqlPool) return null;
  try {
    const [rows] = await mysqlPool.query(
      'SELECT code, expires_at, used FROM tl_email_codes WHERE email = ? AND purpose = ? ORDER BY created_at DESC LIMIT 1',
      [email.toLowerCase(), purpose]
    );
    const r = (rows as any[])[0];
    if (!r) return null;
    return { code: String(r.code), expires_at: String(r.expires_at), used: Number(r.used || 0) };
  } catch { return null; }
}

export async function markEmailCodeUsed(email: string, purpose: string, code: string): Promise<void> {
  if (!mysqlPool) return;
  try {
    await mysqlPool.query('UPDATE tl_email_codes SET used = 1 WHERE email = ? AND purpose = ? AND code = ?', [email.toLowerCase(), purpose, code]);
  } catch { /* best effort */ }
}

export async function createSession(userId: string): Promise<string> {
  if (!mysqlPool) throw new Error('DATABASE_UNAVAILABLE');
  const token = crypto.randomBytes(32).toString('hex');
  const now = Date.now();
  await mysqlPool.query(
    'INSERT INTO tl_sessions (token, user_id, created_at, expires_at) VALUES (?, ?, ?, ?)',
    [token, userId, new Date(now).toISOString(), new Date(now + SESSION_TTL_MS).toISOString()]
  );
  return token;
}

export async function getSessionUser(token: string): Promise<DbUser | null> {
  if (!mysqlPool) throw new Error('DATABASE_UNAVAILABLE');
  const [rows] = await mysqlPool.query(
    'SELECT u.* FROM tl_sessions s INNER JOIN tl_users u ON u.id = s.user_id WHERE s.token = ? AND s.expires_at > ? LIMIT 1',
    [token, new Date().toISOString()]
  );
  const r = (rows as any[])[0];
  return r ? mapUser(r) : null;
}

export async function deleteSession(token: string): Promise<void> {
  if (!mysqlPool) return;
  try {
    await mysqlPool.query('DELETE FROM tl_sessions WHERE token = ?', [token]);
  } catch {
    /* best effort */
  }
}

// ---------------------------------------------------------------------------
// Prefs (per-user personalization)
// ---------------------------------------------------------------------------

export async function getPrefs(userId: string): Promise<DbPrefs> {
  const defaults: DbPrefs = { preferred_ai_model: 'flux', brand_color: '#dc2626' };
  if (!mysqlPool) return defaults;
  try {
    const [rows] = await mysqlPool.query('SELECT * FROM tl_prefs WHERE user_id = ? LIMIT 1', [userId]);
    const r = (rows as any[])[0];
    if (!r) return defaults;
    return {
      preferred_ai_model: r.preferred_ai_model || 'flux',
      brand_color: r.brand_color || '#dc2626'
    };
  } catch {
    return defaults;
  }
}

export async function savePrefs(userId: string, prefs: Partial<DbPrefs>): Promise<DbPrefs> {
  if (!mysqlPool) throw new Error('DATABASE_UNAVAILABLE');
  const current = await getPrefs(userId);
  const next: DbPrefs = { ...current, ...prefs };
  const now = new Date().toISOString();
  await mysqlPool.query(
    `INSERT INTO tl_prefs (user_id, preferred_ai_model, brand_color, created_at, updated_at)
     VALUES (?, ?, ?, ?, ?)
     ON DUPLICATE KEY UPDATE preferred_ai_model = VALUES(preferred_ai_model), brand_color = VALUES(brand_color), updated_at = VALUES(updated_at)`,
    [userId, next.preferred_ai_model, next.brand_color, now, now]
  );
  return next;
}

// ---------------------------------------------------------------------------
// Per-user video records (files live under public/videos; ownership in MySQL)
// ---------------------------------------------------------------------------

export interface VideoRecord {
  id: string;
  user_id: string;
  filename: string;
  keyword: string;
  is_ai: number;
  visual_method: string | null;
  size_bytes: number;
  duration_sec: number;
  created_at: string;
}

export async function getUserVideos(userId: string): Promise<VideoRecord[]> {
  if (!mysqlPool) return [];
  try {
    const [rows] = await mysqlPool.query(
      'SELECT * FROM tl_videos WHERE user_id = ? ORDER BY created_at DESC',
      [userId]
    );
    return rows as VideoRecord[];
  } catch {
    return [];
  }
}

export async function addVideoRecord(input: {
  id: string;
  userId: string;
  filename: string;
  keyword?: string;
  isAi?: boolean;
  visualMethod?: string;
  sizeBytes: number;
  durationSec: number;
}): Promise<void> {
  if (!mysqlPool) return;
  try {
    await mysqlPool.query(
      `INSERT INTO tl_videos (id, user_id, filename, keyword, is_ai, visual_method, size_bytes, duration_sec, created_at)
       VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?)
       ON DUPLICATE KEY UPDATE keyword = VALUES(keyword), size_bytes = VALUES(size_bytes), duration_sec = VALUES(duration_sec), visual_method = VALUES(visual_method)`,
      [
        input.id,
        input.userId,
        input.filename,
        input.keyword || '',
        input.isAi ? 1 : 0,
        input.visualMethod || null,
        input.sizeBytes,
        input.durationSec,
        new Date().toISOString()
      ]
    );
  } catch (err) {
    console.warn('[DB] addVideoRecord failed:', (err as Error).message);
  }
}

/** Assign any pre-existing MP4 files on disk (not yet in tl_videos) to a user. */
export async function claimOrphanVideos(userId: string): Promise<void> {
  if (!mysqlPool) return;
  try {
    const dir = path.join(process.cwd(), 'public', 'videos');
    if (!fs.existsSync(dir)) return;
    const [rows] = await mysqlPool.query('SELECT filename FROM tl_videos');
    const known = new Set((rows as any[]).map((r: any) => r.filename));
    const files = fs.readdirSync(dir).filter(f => f.endsWith('.mp4'));
    for (const filename of files) {
      // IG reels (ig-<shortcode>.mp4) are owned via tl_ig_posts per user —
      // never claim them into tl_videos or another user could download them.
      if (filename.startsWith('ig-')) continue;
      if (known.has(filename)) continue;
      try {
        const stat = fs.statSync(path.join(dir, filename));
        await addVideoRecord({
          id: uuid(),
          userId,
          filename,
          keyword: filename.includes('_ai') ? 'AI Synthesized Scene' : 'Broadcast Explainer',
          isAi: filename.includes('_ai'),
          sizeBytes: stat.size,
          durationSec: 0
        });
      } catch {
        /* skip unreadable file */
      }
    }
  } catch (err) {
    console.warn('[DB] claimOrphanVideos failed:', (err as Error).message);
  }
}

// ---------------------------------------------------------------------------
// Per-user YouTube OAuth (tokens live in MySQL so a channel stays connected
// across restarts and the user never has to log in again; the short-lived
// access token is silently refreshed from the stored refresh token).
// ---------------------------------------------------------------------------

export interface YouTubeRow {
  user_id: string;
  access_token: string | null;
  refresh_token: string | null;
  channel_id: string | null;
  channel_title: string | null;
  channel_thumbnail: string | null;
  subscriber_count: string | null;
  privacy_status: string;
  connected: number;
  last_video_id: string | null;
  last_publish_date: string | null;
  updated_at: string | null;
  /** 1 = a privileged call (auto-comment/title/retention) hit a scope denial:
   *  the owner reconnects once and new consents already include the scope. */
  needs_reconnect: number | null;
}

export async function getYouTubeRow(userId: string): Promise<YouTubeRow | null> {
  if (!mysqlPool) return null;
  try {
    const [rows] = await mysqlPool.query('SELECT * FROM tl_youtube WHERE user_id = ? LIMIT 1', [userId]);
    const r = (rows as any[])[0];
    return r ? (r as YouTubeRow) : null;
  } catch {
    return null;
  }
}

export async function saveYouTubeRow(
  userId: string,
  patch: Partial<Omit<YouTubeRow, 'user_id' | 'updated_at'>>
): Promise<YouTubeRow | null> {
  if (!mysqlPool) throw new Error('DATABASE_UNAVAILABLE');
  const now = new Date().toISOString();
  const current = (await getYouTubeRow(userId)) || null;
  const next: Record<string, any> = {
    user_id: userId,
    access_token: patch.access_token !== undefined ? patch.access_token : current?.access_token || null,
    refresh_token: patch.refresh_token !== undefined ? patch.refresh_token : current?.refresh_token || null,
    channel_id: patch.channel_id !== undefined ? patch.channel_id : current?.channel_id || null,
    channel_title: patch.channel_title !== undefined ? patch.channel_title : current?.channel_title || null,
    channel_thumbnail: patch.channel_thumbnail !== undefined ? patch.channel_thumbnail : current?.channel_thumbnail || null,
    subscriber_count: patch.subscriber_count !== undefined ? patch.subscriber_count : current?.subscriber_count || null,
    privacy_status: patch.privacy_status !== undefined ? patch.privacy_status : current?.privacy_status || 'unlisted',
    connected: patch.connected !== undefined ? patch.connected : current?.connected || 0,
    last_video_id: patch.last_video_id !== undefined ? patch.last_video_id : current?.last_video_id || null,
    last_publish_date: patch.last_publish_date !== undefined ? patch.last_publish_date : current?.last_publish_date || null,
    needs_reconnect: (patch as any).needs_reconnect !== undefined ? (patch as any).needs_reconnect : current?.needs_reconnect || null,
    created_at: (current as any)?.created_at || now,
    updated_at: now
  };
  await mysqlPool.query(
    `INSERT INTO tl_youtube (user_id, access_token, refresh_token, channel_id, channel_title,
      channel_thumbnail, subscriber_count, privacy_status, connected,
      last_video_id, last_publish_date, needs_reconnect, created_at, updated_at)
     VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?)
      ON DUPLICATE KEY UPDATE access_token = VALUES(access_token), refresh_token = VALUES(refresh_token),
        channel_id = VALUES(channel_id), channel_title = VALUES(channel_title),
        channel_thumbnail = VALUES(channel_thumbnail), subscriber_count = VALUES(subscriber_count),
        privacy_status = VALUES(privacy_status), connected = VALUES(connected),
        last_video_id = VALUES(last_video_id), last_publish_date = VALUES(last_publish_date),
        needs_reconnect = VALUES(needs_reconnect),
        updated_at = VALUES(updated_at)`,
    [
      next.user_id, next.access_token, next.refresh_token, next.channel_id, next.channel_title,
      next.channel_thumbnail, next.subscriber_count, next.privacy_status, next.connected,
      next.last_video_id, next.last_publish_date, next.needs_reconnect, next.created_at, next.updated_at
    ]
  );
  return getYouTubeRow(userId);
}

export async function clearYouTubeTokens(userId: string): Promise<void> {
  if (!mysqlPool) return;
  try {
    await mysqlPool.query(
      `UPDATE tl_youtube SET access_token = NULL, refresh_token = NULL, connected = 0,
        channel_title = 'Disconnected', updated_at = ? WHERE user_id = ?`,
      [new Date().toISOString(), userId]
    );
  } catch {
    /* best effort */
  }
}

// ---------------------------------------------------------------------------
// Per-user TikTok OAuth (mirrors the tl_youtube posture: tokens stay in MySQL
// and never leave the backend; the client only sees the public status shape).
// ---------------------------------------------------------------------------

export interface TikTokRow {
  user_id: string;
  access_token: string | null;
  refresh_token: string | null;
  open_id: string | null;
  display_name: string | null;
  avatar_url: string | null;
  privacy_level: string;
  connected: number;
  last_publish_id: string | null;
  last_publish_date: string | null;
  updated_at: string | null;
}

export async function getTikTokRow(userId: string): Promise<TikTokRow | null> {
  if (!mysqlPool) return null;
  try {
    const [rows] = await mysqlPool.query('SELECT * FROM tl_tiktok WHERE user_id = ? LIMIT 1', [userId]);
    const r = (rows as any[])[0];
    return r ? (r as TikTokRow) : null;
  } catch {
    return null;
  }
}

export async function saveTikTokRow(
  userId: string,
  patch: Partial<Omit<TikTokRow, 'user_id' | 'updated_at'>>
): Promise<TikTokRow | null> {
  if (!mysqlPool) throw new Error('DATABASE_UNAVAILABLE');
  const now = new Date().toISOString();
  const current = (await getTikTokRow(userId)) || null;
  const next: Record<string, any> = {
    user_id: userId,
    access_token: patch.access_token !== undefined ? patch.access_token : current?.access_token || null,
    refresh_token: patch.refresh_token !== undefined ? patch.refresh_token : current?.refresh_token || null,
    open_id: patch.open_id !== undefined ? patch.open_id : current?.open_id || null,
    display_name: patch.display_name !== undefined ? patch.display_name : current?.display_name || null,
    avatar_url: patch.avatar_url !== undefined ? patch.avatar_url : current?.avatar_url || null,
    privacy_level: patch.privacy_level !== undefined ? patch.privacy_level : current?.privacy_level || 'PUBLIC_TO_EVERYONE',
    connected: patch.connected !== undefined ? patch.connected : current?.connected || 0,
    last_publish_id: patch.last_publish_id !== undefined ? patch.last_publish_id : current?.last_publish_id || null,
    last_publish_date: patch.last_publish_date !== undefined ? patch.last_publish_date : current?.last_publish_date || null,
    created_at: (current as any)?.created_at || now,
    updated_at: now
  };
  await mysqlPool.query(
    `INSERT INTO tl_tiktok (user_id, access_token, refresh_token, open_id, display_name,
      avatar_url, privacy_level, connected,
      last_publish_id, last_publish_date, created_at, updated_at)
     VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?)
      ON DUPLICATE KEY UPDATE access_token = VALUES(access_token), refresh_token = VALUES(refresh_token),
        open_id = VALUES(open_id), display_name = VALUES(display_name),
        avatar_url = VALUES(avatar_url), privacy_level = VALUES(privacy_level),
        connected = VALUES(connected),
        last_publish_id = VALUES(last_publish_id), last_publish_date = VALUES(last_publish_date),
        updated_at = VALUES(updated_at)`,
    [
      next.user_id, next.access_token, next.refresh_token, next.open_id, next.display_name,
      next.avatar_url, next.privacy_level, next.connected,
      next.last_publish_id, next.last_publish_date, next.created_at, next.updated_at
    ]
  );
  return getTikTokRow(userId);
}

export async function clearTikTokTokens(userId: string): Promise<void> {
  if (!mysqlPool) return;
  try {
    await mysqlPool.query(
      `UPDATE tl_tiktok SET access_token = NULL, refresh_token = NULL, connected = 0,
        display_name = 'Disconnected', updated_at = ? WHERE user_id = ?`,
      [new Date().toISOString(), userId]
    );
  } catch {
    /* best effort */
  }
}

export interface ConnectedYouTubeAccount {
  user_id: string;
  user_name: string;
  user_email: string;
  user_role: string;
  access_token: string | null;
  refresh_token: string | null;
  channel_id: string | null;
  channel_title: string | null;
  channel_thumbnail: string | null;
  subscriber_count: string | null;
  privacy_status: string;
  last_video_id: string | null;
  last_publish_date: string | null;
  needs_reconnect: number | null;
}

/** Admin-only listing: every linked channel WITH its OAuth tokens. The rows
 *  stay backend-only — routes must project out the tokens and never return
 *  them to any client (same posture as every other tl_youtube consumer). */
export async function listConnectedYouTubeAccounts(limit = 25): Promise<ConnectedYouTubeAccount[]> {
  if (!mysqlPool) return [];
  const n = Math.min(50, Math.max(1, Math.floor(Number(limit) || 25)));
  try {
    const [rows] = await mysqlPool.query(
      `SELECT u.id AS user_id, u.name AS user_name, u.email AS user_email, u.role AS user_role,
              y.access_token, y.refresh_token, y.channel_id, y.channel_title,
              y.channel_thumbnail, y.subscriber_count, y.privacy_status,
              y.last_video_id, y.last_publish_date, y.needs_reconnect
         FROM tl_youtube y INNER JOIN tl_users u ON u.id = y.user_id
        WHERE y.connected = 1 AND u.status = 'active'
        ORDER BY y.updated_at DESC LIMIT ${n}`
    );
    return (rows as any[]).map((r: any) => ({
      user_id: String(r.user_id || ''),
      user_name: String(r.user_name || ''),
      user_email: String(r.user_email || ''),
      user_role: String(r.user_role || 'user'),
      access_token: r.access_token || null,
      refresh_token: r.refresh_token || null,
      channel_id: r.channel_id || null,
      channel_title: r.channel_title || null,
      channel_thumbnail: r.channel_thumbnail || null,
      subscriber_count: r.subscriber_count || null,
      privacy_status: r.privacy_status || 'unlisted',
      last_video_id: r.last_video_id || null,
      last_publish_date: r.last_publish_date || null,
      needs_reconnect: Number(r.needs_reconnect ?? 0)
    }));
  } catch {
    return [];
  }
}

// ---------------------------------------------------------------------------
// Instagram profile watches (per-user repost automation) + posted reels.
// Dedup rule: (watch_id, shortcode) is UNIQUE — a reel is never reposted twice.
// ---------------------------------------------------------------------------

export interface IgWatchRow {
  id: string;
  user_id: string;
  profile_url: string;
  username: string;
  enabled: number;
  interval_hours: number;
  auto_publish: number;
  privacy_status: string;
  /** Exact daily firing times ("HH:MM" wall clock in daily_tz). Empty = off. */
  daily_times: string[];
  daily_tz: string;
  /** Per-profile custom hashtags appended to the YouTube description. */
  hashtags: string[];
    last_check_at: string | null;
    next_run_at: string | null;
    last_shortcode: string | null;
    last_error: string | null;
    /** IG-to-Live loop: 1 = this profile's timer keeps its newest reel on air. */
    live_enabled: number;
    /** Shortcode currently looping on air for this watch (null = none). */
    live_shortcode: string | null;
    live_started_at: string | null;
    created_at: string;
    updated_at: string | null;
  }

/** Normalize anything into a sorted, deduped ["HH:MM", ...] list (max 24).
 *  Never throws — garbage in, empty list out. */
export function normalizeDailyTimes(input: unknown): string[] {
  const arr = Array.isArray(input)
    ? input
    : (typeof input === 'string' ? input.split(',') : []);
  const out: string[] = [];
  for (const t of arr) {
    const m = /^(\d{1,2}):(\d{2})$/.exec(String(t || '').trim());
    if (!m) continue;
    const hh = Number(m[1]);
    const mm = Number(m[2]);
    if (hh > 23 || mm > 59) continue;
    const norm = `${String(hh).padStart(2, '0')}:${String(mm).padStart(2, '0')}`;
    if (!out.includes(norm)) out.push(norm);
  }
  return out.sort().slice(0, 24);
}

function parseDailyTimesCell(cell: unknown): string[] {
  if (Array.isArray(cell)) return normalizeDailyTimes(cell);
  if (typeof cell === 'string' && cell.trim()) {
    try {
      return normalizeDailyTimes(JSON.parse(cell));
    } catch {
      return normalizeDailyTimes(cell);
    }
  }
  return [];
}

/** Normalize user-provided hashtags into a deduped list of "#tag" strings. */
export function normalizeHashtags(input: unknown): string[] {
  const raw = Array.isArray(input)
    ? input
    : (typeof input === 'string' ? input.split(/[\s,]+/) : []);
  const out: string[] = [];
  const seen = new Set<string>();
  for (const t of raw) {
    for (const part of String(t || '').split(/[\s,]+/)) {
      let tag = part.trim();
      if (!tag) continue;
      if (tag.startsWith('#')) tag = tag.slice(1);
      tag = tag.replace(/[^\w\u0600-\u06FF]/g, '');
      if (!tag) continue;
      const key = tag.toLowerCase();
      if (seen.has(key)) continue;
      seen.add(key);
      out.push(`#${tag}`);
      if (out.length >= 20) return out;
    }
  }
  return out;
}

/** Plain JSON string-array cell (e.g. recently-used IG shortcodes). */
function parseStringArrayCell(cell: unknown): string[] {
  if (Array.isArray(cell)) return cell.map(v => String(v)).filter(Boolean);
  if (typeof cell === 'string' && cell.trim()) {
    try {
      const j = JSON.parse(cell);
      if (Array.isArray(j)) return j.map(v => String(v)).filter(Boolean);
    } catch { /* not JSON — treat as comma list */ }
    return cell.split(',').map(s => s.trim()).filter(Boolean);
  }
  return [];
}

/** Strict IANA zone check for API validation (throws on unknown zones). */
export function assertValidTimeZone(tz: string): string {
  const s = String(tz || '').trim();
  if (!s) throw new Error('Time zone is required.');
  new Intl.DateTimeFormat('en-US', { timeZone: s }); // throws RangeError when unknown
  return s;
}

function safeTimeZone(tz: unknown): string {
  try {
    return assertValidTimeZone(String(tz || 'UTC'));
  } catch {
    return 'UTC';
  }
}

/** Wall-clock in `zone` -> UTC epoch. result = wallAsUtc − offset(guess),
 *  iterated twice (stable when the offset is constant; self-corrects across
 *  DST transitions). */
function zonedWallToUtcMs(y: number, mo: number, d: number, hh: number, mm: number, zone: string): number {
  const targetAsUtc = Date.UTC(y, mo - 1, d, hh, mm);
  const fmt = new Intl.DateTimeFormat('en-US', {
    timeZone: zone, hour12: false,
    year: 'numeric', month: '2-digit', day: '2-digit',
    hour: '2-digit', minute: '2-digit', second: '2-digit'
  });
  const offsetAt = (ms: number): number => {
    const parts = fmt.formatToParts(new Date(ms));
    const get = (t: string) => Number(parts.find(p => p.type === t)?.value || 0);
    const asUtc = Date.UTC(get('year'), get('month') - 1, get('day'), get('hour') % 24, get('minute'), get('second'));
    return asUtc - ms;
  };
  let guess = targetAsUtc;
  for (let i = 0; i < 2; i++) {
    guess = targetAsUtc - offsetAt(guess);
  }
  return guess;
}

function zonedTodayParts(fromMs: number, zone: string): { y: number; mo: number; d: number } {
  const fmt = new Intl.DateTimeFormat('en-CA', { timeZone: zone, year: 'numeric', month: '2-digit', day: '2-digit' });
  const parts = fmt.formatToParts(new Date(fromMs));
  const get = (t: string) => Number(parts.find(p => p.type === t)?.value || 0);
  return { y: get('year'), mo: get('month'), d: get('day') };
}

/** Next UTC epoch at/after fromMs matching one of the daily HH:MM wall
 *  times in `zone` (today's remainder wins, else tomorrow's earliest). */
export function nextDailyOccurrenceMs(times: string[], zone: string, fromMs: number): number | null {
  const valid = normalizeDailyTimes(times);
  if (valid.length === 0) return null;
  const z = safeTimeZone(zone);
  const t = zonedTodayParts(fromMs, z);
  for (let dayOffset = 0; dayOffset < 2; dayOffset++) {
    const base = new Date(Date.UTC(t.y, t.mo - 1, t.d) + dayOffset * 86400000);
    let best: number | null = null;
    for (const s of valid) {
      const [hh, mm] = s.split(':').map(Number);
      const occ = zonedWallToUtcMs(base.getUTCFullYear(), base.getUTCMonth() + 1, base.getUTCDate(), hh, mm, z);
      if (occ >= fromMs + 30000 && (best === null || occ < best)) best = occ;
    }
    if (best !== null) return best;
  }
  return null;
}

/** Single source of truth for a watch's next firing (always persisted to
 *  next_run_at, so it survives restarts/redeploys): exact daily times win
 *  when ≥1 is set, otherwise the classic every-N-hours rolling timer. */
export function computeWatchNextRunAt(intervalHours: number, dailyTimes: string[], dailyTz: string, fromMs = Date.now()): string {
  const times = normalizeDailyTimes(dailyTimes);
  if (times.length > 0) {
    const occ = nextDailyOccurrenceMs(times, dailyTz || 'UTC', fromMs);
    if (occ !== null) return new Date(occ).toISOString();
  }
  const h = Number(intervalHours) || 24;
  return new Date(fromMs + h * 3600000).toISOString();
}

export interface IgPostRow {
  id: string;
  watch_id: string;
  user_id: string;
  shortcode: string;
  insta_url: string | null;
  caption: string | null;
  yt_title: string | null;
  filename: string | null;
  yt_video_id: string | null;
  yt_url: string | null;
  status: string;
  error: string | null;
  created_at: string;
  preview_url?: string | null;
  /** Winner-content metrics (0 = unscored, e.g. rows from anonymous listing). */
  play_count?: number | null;
  like_count?: number | null;
  comment_count?: number | null;
  winner_score?: number | null;
}

function mapIgWatch(r: any): IgWatchRow {
  return {
    id: r.id,
    user_id: r.user_id,
    profile_url: r.profile_url,
    username: r.username,
    enabled: Number(r.enabled ?? 1),
    interval_hours: Number(r.interval_hours ?? 24),
    auto_publish: Number(r.auto_publish ?? 1),
    privacy_status: r.privacy_status || 'public',
    daily_times: parseDailyTimesCell(r.daily_times),
    daily_tz: r.daily_tz || 'UTC',
    hashtags: normalizeHashtags(parseStringArrayCell(r.hashtags)),
    last_check_at: r.last_check_at || null,
    next_run_at: r.next_run_at || null,
    last_shortcode: r.last_shortcode || null,
    last_error: r.last_error || null,
    live_enabled: Number(r.live_enabled ?? 0),
    live_shortcode: r.live_shortcode || null,
    live_started_at: r.live_started_at || null,
    created_at: r.created_at,
    updated_at: r.updated_at || null
  };
}

export async function listIgWatches(userId: string): Promise<IgWatchRow[]> {
  if (!mysqlPool) return [];
  try {
    const [rows] = await mysqlPool.query('SELECT * FROM tl_ig_watch WHERE user_id = ? ORDER BY created_at DESC', [userId]);
    return (rows as any[]).map(mapIgWatch);
  } catch {
    return [];
  }
}

export async function getIgWatch(id: string, userId: string): Promise<IgWatchRow | null> {
  if (!mysqlPool) return null;
  try {
    const [rows] = await mysqlPool.query('SELECT * FROM tl_ig_watch WHERE id = ? AND user_id = ? LIMIT 1', [id, userId]);
    const r = (rows as any[])[0];
    return r ? mapIgWatch(r) : null;
  } catch {
    return null;
  }
}

/** Owner-agnostic watch lookup (boot resume of the reel loop runs with no
 *  request user — the persisted tl_live_stream row names the watch). */
export async function getIgWatchById(id: string): Promise<IgWatchRow | null> {
  if (!mysqlPool || !id) return null;
  try {
    const [rows] = await mysqlPool.query('SELECT * FROM tl_ig_watch WHERE id = ? LIMIT 1', [id]);
    const r = (rows as any[])[0];
    return r ? mapIgWatch(r) : null;
  } catch {
    return null;
  }
}

export async function createIgWatch(input: {
  id: string;
  userId: string;
  profileUrl: string;
  username: string;
  intervalHours: number;
  autoPublish: boolean;
  privacyStatus: string;
  dailyTimes?: string[];
  dailyTz?: string;
  hashtags?: unknown;
}): Promise<IgWatchRow | null> {
  if (!mysqlPool) throw new Error('DATABASE_UNAVAILABLE');
  const now = new Date().toISOString();
  const times = normalizeDailyTimes(input.dailyTimes ?? []);
  const tz = safeTimeZone(input.dailyTz ?? 'UTC');
  const tags = normalizeHashtags(input.hashtags);
  const next = computeWatchNextRunAt(input.intervalHours, times, tz);
  await mysqlPool.query(
    `INSERT INTO tl_ig_watch (id, user_id, profile_url, username, enabled, interval_hours, auto_publish, privacy_status, daily_times, daily_tz, hashtags, next_run_at, created_at, updated_at)
     VALUES (?, ?, ?, ?, 1, ?, ?, ?, ?, ?, ?, ?, ?, ?)`,
    [input.id, input.userId, input.profileUrl, input.username, input.intervalHours, input.autoPublish ? 1 : 0, input.privacyStatus,
     JSON.stringify(times), tz, JSON.stringify(tags), next, now, now]
  );
  return getIgWatch(input.id, input.userId);
}

export async function updateIgWatch(id: string, userId: string, patch: {
  enabled?: boolean;
  intervalHours?: number;
  autoPublish?: boolean;
  privacyStatus?: string;
  dailyTimes?: string[];
  dailyTz?: string;
  hashtags?: unknown;
  lastCheckAt?: string | null;
  nextRunAt?: string | null;
  lastShortcode?: string | null;
  lastError?: string | null;
  liveEnabled?: boolean;
  liveShortcode?: string | null;
  liveStartedAt?: string | null;
}): Promise<IgWatchRow | null> {
  if (!mysqlPool) throw new Error('DATABASE_UNAVAILABLE');
  const cur = await getIgWatch(id, userId);
  if (!cur) return null;
  const newTimes = patch.dailyTimes !== undefined ? normalizeDailyTimes(patch.dailyTimes) : cur.daily_times;
  const newTz = patch.dailyTz !== undefined ? safeTimeZone(patch.dailyTz) : cur.daily_tz;
  const newHashtags = patch.hashtags !== undefined ? normalizeHashtags(patch.hashtags) : cur.hashtags;
  const next = {
    enabled: patch.enabled !== undefined ? (patch.enabled ? 1 : 0) : cur.enabled,
    interval_hours: patch.intervalHours !== undefined ? patch.intervalHours : cur.interval_hours,
    auto_publish: patch.autoPublish !== undefined ? (patch.autoPublish ? 1 : 0) : cur.auto_publish,
    privacy_status: patch.privacyStatus !== undefined ? patch.privacyStatus : cur.privacy_status,
    daily_times: newTimes,
    daily_tz: newTz,
    hashtags: newHashtags,
    last_check_at: patch.lastCheckAt !== undefined ? patch.lastCheckAt : cur.last_check_at,
    next_run_at: patch.nextRunAt !== undefined ? patch.nextRunAt : cur.next_run_at,
    last_shortcode: patch.lastShortcode !== undefined ? patch.lastShortcode : cur.last_shortcode,
    last_error: patch.lastError !== undefined ? patch.lastError : cur.last_error,
    live_enabled: patch.liveEnabled !== undefined ? (patch.liveEnabled ? 1 : 0) : cur.live_enabled,
    live_shortcode: patch.liveShortcode !== undefined ? patch.liveShortcode : cur.live_shortcode,
    live_started_at: patch.liveStartedAt !== undefined ? patch.liveStartedAt : cur.live_started_at
  };
  // Re-arm the timer (persisted next_run_at — deploy-proof) when the schedule
  // changes in any way or the watch is (re-)enabled. Exact daily times win
  // over the rolling interval whenever ≥1 is set.
  if (patch.intervalHours !== undefined || patch.enabled === true || patch.dailyTimes !== undefined || patch.dailyTz !== undefined) {
    next.next_run_at = computeWatchNextRunAt(Number(next.interval_hours), newTimes, newTz);
  }
  if (patch.enabled === false) next.next_run_at = null;
  await mysqlPool.query(
    `UPDATE tl_ig_watch SET enabled = ?, interval_hours = ?, auto_publish = ?, privacy_status = ?,
      daily_times = ?, daily_tz = ?, hashtags = ?, last_check_at = ?, next_run_at = ?, last_shortcode = ?, last_error = ?,
      live_enabled = ?, live_shortcode = ?, live_started_at = ?, updated_at = ? WHERE id = ? AND user_id = ?`,
    [next.enabled, next.interval_hours, next.auto_publish, next.privacy_status, JSON.stringify(newTimes), newTz,
      JSON.stringify(newHashtags),
      next.last_check_at, next.next_run_at, next.last_shortcode, next.last_error,
      next.live_enabled, next.live_shortcode, next.live_started_at,
      new Date().toISOString(), id, userId]
  );
  return getIgWatch(id, userId);
}

export async function deleteIgWatch(id: string, userId: string): Promise<void> {
  if (!mysqlPool) return;
  try {
    await mysqlPool.query('DELETE FROM tl_ig_posts WHERE watch_id = ? AND user_id = ?', [id, userId]);
    await mysqlPool.query('DELETE FROM tl_ig_watch WHERE id = ? AND user_id = ?', [id, userId]);
  } catch { /* best effort */ }
}

/** Per-user media ownership: true when this user owns the file via tl_videos
 *  (rendered/AI shorts) or tl_ig_posts (downloaded IG reels pending publish).
 *  Used by the /videos gate so one user can never fetch another user's file
 *  by guessing its URL. */
export async function userOwnsMediaFile(userId: string, filename: string): Promise<boolean> {
  if (!mysqlPool || !userId || !filename) return false;
  const base = String(filename).split('/').pop() || '';
  if (!base || base.includes('..')) return false;
  try {
    const [v] = await mysqlPool.query('SELECT id FROM tl_videos WHERE user_id = ? AND filename = ? LIMIT 1', [userId, base]);
    if ((v as any[])[0]) return true;
    const [p] = await mysqlPool.query('SELECT id FROM tl_ig_posts WHERE user_id = ? AND filename = ? LIMIT 1', [userId, base]);
    if ((p as any[])[0]) return true;
  } catch {
    return false;
  }
  return false;
}

export async function listDueIgWatches(nowIso: string, limit = 10): Promise<IgWatchRow[]> {
  if (!mysqlPool) return [];
  try {
    const [rows] = await mysqlPool.query(
      'SELECT * FROM tl_ig_watch WHERE enabled = 1 AND next_run_at IS NOT NULL AND next_run_at <= ? ORDER BY next_run_at ASC LIMIT ?',
      [nowIso, limit]
    );
    return (rows as any[]).map(mapIgWatch);
  } catch {
    return [];
  }
}

/** Watches whose Instagram-to-Live loop is armed (enabled + live_enabled).
 *  The live-prefetch ticker sweeps these every couple of minutes so the next
 *  reel is discovered + downloaded while the current one keeps repeating —
 *  independent of the (slow) publish timer. */
export async function listLiveEnabledWatches(limit = 20): Promise<IgWatchRow[]> {
  if (!mysqlPool) return [];
  try {
    const [rows] = await mysqlPool.query(
      'SELECT * FROM tl_ig_watch WHERE enabled = 1 AND live_enabled = 1 ORDER BY updated_at DESC LIMIT ?',
      [limit]
    );
    return (rows as any[]).map(mapIgWatch);
  } catch {
    return [];
  }
}

export interface AutoScheduleRow {
  user_id: string;
  enabled: number;
  interval_hours: number;
  auto_publish: number;
  country: string;
  last_run_at: string | null;
  next_run_at: string | null;
  last_job_id: string | null;
  created_at?: string;
  updated_at?: string | null;
}

function mapAutoSchedule(r: any): AutoScheduleRow {
  return {
    user_id: r.user_id,
    enabled: Number(r.enabled ?? 0),
    interval_hours: Number(r.interval_hours ?? 2),
    auto_publish: Number(r.auto_publish ?? 0),
    country: r.country || 'US',
    last_run_at: r.last_run_at || null,
    next_run_at: r.next_run_at || null,
    last_job_id: r.last_job_id || null,
    created_at: r.created_at,
    updated_at: r.updated_at || null
  };
}

export async function getAutoSchedule(userId: string): Promise<AutoScheduleRow | null> {
  if (!mysqlPool || !userId) return null;
  try {
    const [rows] = await mysqlPool.query('SELECT * FROM tl_auto_schedule WHERE user_id = ? LIMIT 1', [userId]);
    const r = (rows as any[])[0];
    return r ? mapAutoSchedule(r) : null;
  } catch {
    return null;
  }
}

/** Create-or-update this user's Auto-Pilot timer. Re-arms next_run_at from
 *  NOW whenever the timer is (re-)enabled or the interval changes; disabling
 *  clears next_run_at. Never throws for missing rows — INSERTs them. */
export async function upsertAutoSchedule(userId: string, patch: {
  enabled?: boolean;
  intervalHours?: number;
  autoPublish?: boolean;
  country?: string;
  lastRunAt?: string | null;
  nextRunAt?: string | null;
  lastJobId?: string | null;
}): Promise<AutoScheduleRow | null> {
  if (!mysqlPool || !userId) throw new Error('DATABASE_UNAVAILABLE');
  const cur = await getAutoSchedule(userId);
  const now = new Date().toISOString();
  const next = {
    enabled: patch.enabled !== undefined ? (patch.enabled ? 1 : 0) : (cur?.enabled ?? 0),
    interval_hours: patch.intervalHours !== undefined ? patch.intervalHours : (cur?.interval_hours ?? 2),
    auto_publish: patch.autoPublish !== undefined ? (patch.autoPublish ? 1 : 0) : (cur?.auto_publish ?? 0),
    country: patch.country !== undefined ? patch.country : (cur?.country ?? 'US'),
    last_run_at: patch.lastRunAt !== undefined ? patch.lastRunAt : (cur?.last_run_at ?? null),
    next_run_at: patch.nextRunAt !== undefined ? patch.nextRunAt : (cur?.next_run_at ?? null),
    last_job_id: patch.lastJobId !== undefined ? patch.lastJobId : (cur?.last_job_id ?? null)
  };
  // (Re-)arming from the moment of the change — a user switching 24h -> 1h
  // while enabled must not wait out the old 24h window.
  if (patch.intervalHours !== undefined || patch.enabled === true) {
    next.next_run_at = new Date(Date.now() + Number(next.interval_hours) * 3600000).toISOString();
  }
  if (patch.enabled === false) next.next_run_at = null;
  await mysqlPool.query(
    `INSERT INTO tl_auto_schedule (user_id, enabled, interval_hours, auto_publish, country, last_run_at, next_run_at, last_job_id, created_at, updated_at)
     VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?)
     ON DUPLICATE KEY UPDATE enabled = VALUES(enabled), interval_hours = VALUES(interval_hours),
       auto_publish = VALUES(auto_publish), country = VALUES(country), last_run_at = VALUES(last_run_at),
       next_run_at = VALUES(next_run_at), last_job_id = VALUES(last_job_id), updated_at = VALUES(updated_at)`,
    [userId, next.enabled, next.interval_hours, next.auto_publish, next.country,
     next.last_run_at, next.next_run_at, next.last_job_id, cur?.created_at ?? now, now]
  );
  return getAutoSchedule(userId);
}

export interface LiveStreamRow {
  user_id: string;
  rtmp_url: string | null;
  stream_key: string | null;
  topic_keyword: string | null;
  orientation: string | null;
  /** What feeds the push: news story cards vs an Instagram reel loop. */
  mode: string | null;
  /** Owning IG watch while mode = reel. */
  reel_watch_id: string | null;
  reel_shortcode: string | null;
  started_at: string | null;
  updated_at: string | null;
}

/** The persisted live session (at most one row per user). Never leaves the
 *  backend — routes only ever expose masked status, never the key. */
export async function getLiveStream(userId: string): Promise<LiveStreamRow | null> {
  if (!mysqlPool || !userId) return null;
  try {
    const [rows] = await mysqlPool.query('SELECT * FROM tl_live_stream WHERE user_id = ? LIMIT 1', [userId]);
    return ((rows as any[])[0] as LiveStreamRow) || null;
  } catch {
    return null;
  }
}

/** Any persisted live session on this server (the engine runs one global
 *  broadcast at a time) — used for boot auto-resume. */
export async function getAnyLiveStream(): Promise<LiveStreamRow | null> {
  if (!mysqlPool) return null;
  try {
    const [rows] = await mysqlPool.query('SELECT * FROM tl_live_stream ORDER BY updated_at DESC LIMIT 1');
    return ((rows as any[])[0] as LiveStreamRow) || null;
  } catch {
    return null;
  }
}

export async function saveLiveStream(userId: string, input: {
  rtmpUrl: string;
  streamKey: string;
  topicKeyword: string | null;
  orientation?: string | null;
  mode?: 'news' | 'reel' | null;
  reelWatchId?: string | null;
  reelShortcode?: string | null;
}): Promise<void> {
  if (!mysqlPool || !userId) throw new Error('DATABASE_UNAVAILABLE');
  const now = new Date().toISOString();
  const orientation = input.orientation === 'horizontal' ? 'horizontal' : 'vertical';
  const mode = input.mode === 'reel' ? 'reel' : 'news';
  await mysqlPool.query(
    `INSERT INTO tl_live_stream (user_id, rtmp_url, stream_key, topic_keyword, orientation, mode, reel_watch_id, reel_shortcode, started_at, updated_at)
     VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?)
     ON DUPLICATE KEY UPDATE rtmp_url = VALUES(rtmp_url), stream_key = VALUES(stream_key),
       topic_keyword = VALUES(topic_keyword), orientation = VALUES(orientation),
       mode = VALUES(mode), reel_watch_id = VALUES(reel_watch_id), reel_shortcode = VALUES(reel_shortcode),
       started_at = VALUES(started_at), updated_at = VALUES(updated_at)`,
    [userId, input.rtmpUrl, input.streamKey, input.topicKeyword, orientation,
     mode, input.reelWatchId ?? null, input.reelShortcode ?? null, now, now]
  );
}

/** Refresh only the reel pointer of the persisted live row (timer swap of
 *  the looping shortcode — never touches key/topic, never restarts). */
export async function touchLiveReelShortcode(userId: string, shortcode: string): Promise<void> {
  if (!mysqlPool || !userId) return;
  try {
    await mysqlPool.query(
      'UPDATE tl_live_stream SET reel_shortcode = ?, updated_at = ? WHERE user_id = ?',
      [shortcode, new Date().toISOString(), userId]
    );
  } catch { /* best effort */ }
}

export async function clearLiveStream(userId: string): Promise<void> {
  if (!mysqlPool || !userId) return;
  try {
    await mysqlPool.query('DELETE FROM tl_live_stream WHERE user_id = ?', [userId]);
  } catch { /* best effort */ }
}

export interface StreamSettingsRow {
  user_id: string;
  stream_key: string | null;
  rtmp_url: string | null;
  orientation: string | null;
  updated_at: string | null;
}

/** Raw row (key included) — backend only, never sent to any client. */
export async function getStreamSettingsRow(userId: string): Promise<StreamSettingsRow | null> {
  if (!mysqlPool || !userId) return null;
  try {
    const [rows] = await mysqlPool.query('SELECT * FROM tl_stream_settings WHERE user_id = ? LIMIT 1', [userId]);
    return ((rows as any[])[0] as StreamSettingsRow) || null;
  } catch {
    return null;
  }
}

/** Client-safe shape: key presence + last-4 hint only, never the key. */
export async function getStreamSettingsPublic(userId: string): Promise<{
  hasKey: boolean; keyHint: string; rtmpUrl: string | null; orientation: string | null; updatedAt: string | null;
} | null> {
  const row = await getStreamSettingsRow(userId);
  if (!row) return null;
  const key = String(row.stream_key || '');
  return {
    hasKey: key.length >= 4,
    keyHint: key.length >= 4 ? `••••${key.slice(-4)}` : '',
    rtmpUrl: row.rtmp_url || null,
    orientation: row.orientation === 'horizontal' ? 'horizontal' : 'vertical',
    updatedAt: row.updated_at || null,
  };
}

export async function saveStreamSettings(userId: string, input: {
  streamKey?: string | null;
  rtmpUrl?: string | null;
  orientation?: string | null;
}): Promise<void> {
  if (!mysqlPool || !userId) throw new Error('DATABASE_UNAVAILABLE');
  const cur = await getStreamSettingsRow(userId);
  const now = new Date().toISOString();
  const key = input.streamKey !== undefined && input.streamKey !== null && String(input.streamKey).trim()
    ? String(input.streamKey).trim()
    : (cur?.stream_key || null);
  const rtmp = input.rtmpUrl !== undefined && input.rtmpUrl !== null && String(input.rtmpUrl).trim()
    ? String(input.rtmpUrl).trim()
    : (cur?.rtmp_url || null);
  const orientation = input.orientation === 'horizontal' || (input.orientation === undefined && cur?.orientation === 'horizontal')
    ? 'horizontal'
    : 'vertical';
  await mysqlPool.query(
    `INSERT INTO tl_stream_settings (user_id, stream_key, rtmp_url, orientation, updated_at)
     VALUES (?, ?, ?, ?, ?)
     ON DUPLICATE KEY UPDATE stream_key = VALUES(stream_key), rtmp_url = VALUES(rtmp_url),
       orientation = VALUES(orientation), updated_at = VALUES(updated_at)`,
    [userId, key, rtmp, orientation, now]
  );
}

export async function clearStreamSettings(userId: string): Promise<void> {
  if (!mysqlPool || !userId) return;
  try {
    await mysqlPool.query('DELETE FROM tl_stream_settings WHERE user_id = ?', [userId]);
  } catch { /* best effort */ }
}

/** All armed timers whose next firing is due — the ticker picks these up
 *  after ANY restart/redeploy, so no timer ever dies with a deploy. */
export async function listDueAutoSchedules(nowIso: string, limit = 10): Promise<AutoScheduleRow[]> {
  if (!mysqlPool) return [];
  try {
    const [rows] = await mysqlPool.query(
      'SELECT * FROM tl_auto_schedule WHERE enabled = 1 AND next_run_at IS NOT NULL AND next_run_at <= ? ORDER BY next_run_at ASC LIMIT ?',
      [nowIso, limit]
    );
    return (rows as any[]).map(mapAutoSchedule);
  } catch {
    return [];
  }
}

export async function hasIgPost(watchId: string, shortcode: string): Promise<boolean> {
  if (!mysqlPool) return false;
  try {
    const [rows] = await mysqlPool.query('SELECT id FROM tl_ig_posts WHERE watch_id = ? AND shortcode = ? LIMIT 1', [watchId, shortcode]);
    return !!(rows as any[])[0];
  } catch {
    return false;
  }
}

export async function addIgPost(input: {
  id: string;
  watchId: string;
  userId: string;
  shortcode: string;
  instaUrl: string;
  caption: string;
  ytTitle: string;
  filename: string;
  ytVideoId?: string | null;
  ytUrl?: string | null;
  status: string;
  error?: string | null;
  previewUrl?: string | null;
  playCount?: number | null;
  likeCount?: number | null;
  commentCount?: number | null;
  winnerScore?: number | null;
}): Promise<void> {
  if (!mysqlPool) return;
  try {
    await mysqlPool.query(
      // NEVER regress a terminal 'published' row back to 'discovered' — a
      // transient hasIgPost() read failure during discovery would otherwise
      // re-insert an already-uploaded shortcode and the publish lane would
      // upload it a SECOND time. Guard the status with IF(); only yt links /
      // preview / error / metrics may be refreshed on conflict.
      `INSERT INTO tl_ig_posts (id, watch_id, user_id, shortcode, insta_url, caption, yt_title, filename, yt_video_id, yt_url, status, error, preview_url, play_count, like_count, comment_count, winner_score, created_at)
       VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?)
       ON DUPLICATE KEY UPDATE status = IF(status = 'published', status, VALUES(status)), yt_video_id = VALUES(yt_video_id), yt_url = VALUES(yt_url), error = VALUES(error), preview_url = VALUES(preview_url),
         play_count = GREATEST(play_count, VALUES(play_count)), like_count = GREATEST(like_count, VALUES(like_count)),
         comment_count = GREATEST(comment_count, VALUES(comment_count)), winner_score = GREATEST(winner_score, VALUES(winner_score))`,
      [input.id, input.watchId, input.userId, input.shortcode, input.instaUrl, input.caption, input.ytTitle,
       input.filename, input.ytVideoId || null, input.ytUrl || null, input.status, input.error || null, input.previewUrl || null,
       Math.max(0, Math.floor(Number(input.playCount) || 0)), Math.max(0, Math.floor(Number(input.likeCount) || 0)),
       Math.max(0, Math.floor(Number(input.commentCount) || 0)), Math.max(0, Math.floor(Number(input.winnerScore) || 0)),
       new Date().toISOString()]
    );
  } catch (err) {
    console.warn('[DB] addIgPost failed:', (err as Error).message);
  }
}

/** Winner-metric refresh for ALREADY-known reels: view/like counts only grow,
 *  so GREATEST() keeps the peak without ever regressing. Free — the numbers
 *  ride in the same Userinfo response that discovered them (zero extra quota). */
export async function refreshIgPostMetrics(
  watchId: string, userId: string, shortcode: string,
  metrics: { playCount?: number | null; likeCount?: number | null; commentCount?: number | null; winnerScore?: number | null }
): Promise<void> {
  if (!mysqlPool) return;
  try {
    await mysqlPool.query(
      `UPDATE tl_ig_posts
       SET play_count = GREATEST(COALESCE(play_count, 0), ?),
           like_count = GREATEST(COALESCE(like_count, 0), ?),
           comment_count = GREATEST(COALESCE(comment_count, 0), ?),
           winner_score = GREATEST(COALESCE(winner_score, 0), ?)
       WHERE watch_id = ? AND user_id = ? AND shortcode = ?`,
      [Math.max(0, Math.floor(Number(metrics.playCount) || 0)), Math.max(0, Math.floor(Number(metrics.likeCount) || 0)),
       Math.max(0, Math.floor(Number(metrics.commentCount) || 0)), Math.max(0, Math.floor(Number(metrics.winnerScore) || 0)),
       watchId, userId, shortcode]
    );
  } catch (err) {
    console.warn('[DB] refreshIgPostMetrics failed:', (err as Error).message);
  }
}

export async function listIgPosts(watchId: string, userId: string, limit = 30): Promise<IgPostRow[]> {
  if (!mysqlPool) return [];
  try {
    const [rows] = await mysqlPool.query(
      'SELECT * FROM tl_ig_posts WHERE watch_id = ? AND user_id = ? ORDER BY created_at DESC LIMIT ?',
      [watchId, userId, limit]
    );
    return rows as IgPostRow[];
  } catch {
    return [];
  }
}

export async function listPublishableIgPosts(watchId: string, userId: string, shortcode: string | null, limit = 1): Promise<IgPostRow[]> {
  if (!mysqlPool) return [];
  try {
    if (shortcode) {
      const [rows] = await mysqlPool.query(
        `SELECT * FROM tl_ig_posts WHERE watch_id = ? AND user_id = ? AND shortcode = ?
         AND status IN ('discovered', 'downloaded', 'failed') LIMIT 1`,
        [watchId, userId, shortcode]
      );
      return rows as IgPostRow[];
    }
    const lim = Math.min(10, Math.max(1, Number(limit) || 1));
    // Winner-first: the unpublished reel with the highest winner_score
    // (views primary, engagement tiebreak) publishes before newer but weaker
    // reels. Unscored rows (anonymous listing, all 0) keep newest-first order
    // via the created_at tiebreak — no behavior change for them.
    const [rows] = await mysqlPool.query(
      `SELECT * FROM tl_ig_posts WHERE watch_id = ? AND user_id = ? AND status IN ('discovered', 'downloaded', 'failed')
       ORDER BY COALESCE(winner_score, 0) DESC, COALESCE(play_count, 0) DESC, created_at DESC LIMIT ${lim}`,
      [watchId, userId]
    );
    return rows as IgPostRow[];
  } catch {
    return [];
  }
}

export async function updateIgPost(
  watchId: string,
  userId: string,
  shortcode: string,
  patch: Partial<{ caption: string; ytTitle: string; filename: string; ytVideoId: string | null; ytUrl: string | null; status: string; error: string | null }>
): Promise<void> {
  if (!mysqlPool) return;
  try {
    const map: Record<string, string> = {
      caption: 'caption', ytTitle: 'yt_title', filename: 'filename',
      ytVideoId: 'yt_video_id', ytUrl: 'yt_url', status: 'status', error: 'error'
    };
    const sets: string[] = [];
    const vals: any[] = [];
    for (const [k, col] of Object.entries(map)) {
      const v = (patch as any)[k];
      if (v !== undefined) {
        sets.push(`${col} = ?`);
        vals.push(v);
      }
    }
    if (sets.length === 0 && (patch as any).status !== 'published') return;
    // Centralized publish stamp: every path that marks a reel published
    // records the exact moment (created_at is discovery time, not this).
    if ((patch as any).status === 'published') {
      sets.push('published_at = ?');
      vals.push(new Date().toISOString());
    }
    if (sets.length === 0) return;
    vals.push(watchId, userId, shortcode);
    await mysqlPool.query(
      `UPDATE tl_ig_posts SET ${sets.join(', ')} WHERE watch_id = ? AND user_id = ? AND shortcode = ?`,
      vals
    );
  } catch (err) {
    console.warn('[DB] updateIgPost failed:', (err as Error).message);
  }
}

export async function listUsers(): Promise<DbUser[]> {
  if (!mysqlPool) return [];
  try {
    const [rows] = await mysqlPool.query('SELECT id, email, name, role, status, created_at FROM tl_users ORDER BY created_at DESC');
    return (rows as any[]).map(mapUser);
  } catch {
    return [];
  }
}

export async function setUserStatus(userId: string, status: 'active' | 'disabled'): Promise<void> {
  if (!mysqlPool) return;
  try {
    await mysqlPool.query('UPDATE tl_users SET status = ?, updated_at = ? WHERE id = ?', [status, new Date().toISOString(), userId]);
    if (status === 'disabled') {
      await mysqlPool.query('DELETE FROM tl_sessions WHERE user_id = ?', [userId]);
    }
  } catch { /* best effort */ }
}

export async function deleteVideoRecord(userId: string, filename: string): Promise<void> {
  if (!mysqlPool) return;
  try {
    await mysqlPool.query('DELETE FROM tl_videos WHERE user_id = ? AND filename = ?', [userId, filename]);
  } catch { /* best effort */ }
}

export async function getUploadQuota(userId: string): Promise<{ quota_bytes: number; used_bytes: number; subscription_expires_at: string | null }> {
  if (!mysqlPool) return { quota_bytes: 0, used_bytes: 0, subscription_expires_at: null };
  try {
    const [rows] = await mysqlPool.query('SELECT quota_bytes, used_bytes, subscription_expires_at FROM tl_upload_quota WHERE user_id = ? LIMIT 1', [userId]);
    const r = (rows as any[])[0];
    if (r) return { quota_bytes: Number(r.quota_bytes || 0), used_bytes: Number(r.used_bytes || 0), subscription_expires_at: r.subscription_expires_at || null };
    await mysqlPool.query('INSERT INTO tl_upload_quota (user_id, quota_bytes, used_bytes, updated_at) VALUES (?,0,0,?)', [userId, new Date().toISOString()]);
    return { quota_bytes: 0, used_bytes: 0, subscription_expires_at: null };
  } catch {
    return { quota_bytes: 0, used_bytes: 0, subscription_expires_at: null };
  }
}

export async function addUploadQuota(userId: string, bytes: number): Promise<void> {
  if (!mysqlPool) return;
  try {
    await mysqlPool.query(
      `INSERT INTO tl_upload_quota (user_id, quota_bytes, used_bytes, updated_at) VALUES (?,?,0,?)
       ON DUPLICATE KEY UPDATE quota_bytes = quota_bytes + VALUES(quota_bytes), updated_at = VALUES(updated_at)`,
      [userId, bytes, new Date().toISOString()]
    );
  } catch { /* best effort */ }
}

  export async function listExpiredSubscriptionQuotas(nowIso: string): Promise<{ user_id: string; subscription_expires_at: string; expiry_notified_at: string | null }[]> {
    if (!mysqlPool) return [];
    try {
      const [rows] = await mysqlPool.query(
        `SELECT user_id, subscription_expires_at, expiry_notified_at FROM tl_upload_quota
         WHERE subscription_expires_at IS NOT NULL AND subscription_expires_at < ?
           AND (expiry_notified_at IS NULL OR expiry_notified_at < subscription_expires_at)`,
        [nowIso]
      );
      return (rows as any[]).map(r => ({
        user_id: String(r.user_id),
        subscription_expires_at: String(r.subscription_expires_at),
        expiry_notified_at: r.expiry_notified_at ? String(r.expiry_notified_at) : null
      }));
    } catch { return []; }
  }

  export async function markSubscriptionExpiryNotified(userId: string, iso: string): Promise<void> {
    if (!mysqlPool) return;
    try {
      await mysqlPool.query('UPDATE tl_upload_quota SET expiry_notified_at = ?, updated_at = ? WHERE user_id = ?', [iso, iso, userId]);
    } catch { /* best effort */ }
  }

  export async function refreshUploadUsedBytes(userId: string): Promise<number> {
  if (!mysqlPool) return 0;
  try {
    const [rows] = await mysqlPool.query('SELECT COALESCE(SUM(size_bytes),0) AS s FROM tl_upload_files WHERE user_id = ?', [userId]);
    const used = Number((rows as any[])[0]?.s || 0);
    await mysqlPool.query('UPDATE tl_upload_quota SET used_bytes = ?, updated_at = ? WHERE user_id = ?', [used, new Date().toISOString(), userId]);
    return used;
  } catch {
    return 0;
  }
}

export interface UploadFileRow {
  id: string;
  user_id: string;
  filename: string;
  original_name: string | null;
  size_bytes: number;
  mime: string | null;
  youtube_scheduled_at: string | null;
  youtube_status: string;
  youtube_video_id: string | null;
  youtube_url: string | null;
  youtube_error: string | null;
  created_at: string;
}

export async function listUploadFiles(userId: string): Promise<UploadFileRow[]> {
  if (!mysqlPool) return [];
  try {
    const [rows] = await mysqlPool.query('SELECT * FROM tl_upload_files WHERE user_id = ? ORDER BY created_at DESC', [userId]);
    return (rows as any[]).map(r => ({ ...r, size_bytes: Number(r.size_bytes || 0) })) as UploadFileRow[];
  } catch {
    return [];
  }
}

export async function addUploadFile(input: {
  id: string; userId: string; filename: string; originalName?: string; sizeBytes: number; mime?: string;
}): Promise<void> {
  if (!mysqlPool) return;
  try {
    await mysqlPool.query(
      `INSERT INTO tl_upload_files (id, user_id, filename, original_name, size_bytes, mime, youtube_status, created_at)
       VALUES (?, ?, ?, ?, ?, ?, 'none', ?)`,
      [input.id, input.userId, input.filename, input.originalName || null, input.sizeBytes, input.mime || null, new Date().toISOString()]
    );
    await refreshUploadUsedBytes(input.userId);
  } catch (err) {
    console.warn('[DB] addUploadFile failed:', (err as Error).message);
  }
}

export async function getUploadFile(userId: string, id: string): Promise<UploadFileRow | null> {
  if (!mysqlPool) return null;
  try {
    const [rows] = await mysqlPool.query('SELECT * FROM tl_upload_files WHERE id = ? AND user_id = ? LIMIT 1', [id, userId]);
    const r = (rows as any[])[0];
    return r ? ({ ...r, size_bytes: Number(r.size_bytes || 0) } as UploadFileRow) : null;
  } catch {
    return null;
  }
}

export async function deleteUploadFile(userId: string, id: string): Promise<string | null> {
  if (!mysqlPool) return null;
  try {
    const [rows] = await mysqlPool.query('SELECT filename FROM tl_upload_files WHERE id = ? AND user_id = ? LIMIT 1', [id, userId]);
    const fn = (rows as any[])[0]?.filename;
    if (!fn) return null;
    await mysqlPool.query('DELETE FROM tl_upload_files WHERE id = ? AND user_id = ?', [id, userId]);
    await refreshUploadUsedBytes(userId);
    return String(fn);
  } catch {
    return null;
  }
}

export async function updateUploadFileYoutube(id: string, patch: Partial<{
  scheduledAt: string | null; status: string; videoId: string | null; url: string | null; error: string | null;
}>): Promise<void> {
  if (!mysqlPool) return;
  try {
    const sets: string[] = [];
    const vals: any[] = [];
    if (patch.scheduledAt !== undefined) { sets.push('youtube_scheduled_at = ?'); vals.push(patch.scheduledAt); }
    if (patch.status !== undefined) { sets.push('youtube_status = ?'); vals.push(patch.status); }
    if (patch.videoId !== undefined) { sets.push('youtube_video_id = ?'); vals.push(patch.videoId); }
    if (patch.url !== undefined) { sets.push('youtube_url = ?'); vals.push(patch.url); }
    if (patch.error !== undefined) { sets.push('youtube_error = ?'); vals.push(patch.error); }
    if (sets.length === 0) return;
    vals.push(id);
    await mysqlPool.query(`UPDATE tl_upload_files SET ${sets.join(', ')} WHERE id = ?`, vals);
  } catch { /* best effort */ }
}

export async function listDueUploadYoutubeJobs(nowIso: string, limit = 5): Promise<UploadFileRow[]> {
  if (!mysqlPool) return [];
  try {
    const [rows] = await mysqlPool.query(
      `SELECT * FROM tl_upload_files WHERE youtube_status = 'scheduled' AND youtube_scheduled_at IS NOT NULL AND youtube_scheduled_at <= ? ORDER BY youtube_scheduled_at ASC LIMIT ?`,
      [nowIso, limit]
    );
    return (rows as any[]).map(r => ({ ...r, size_bytes: Number(r.size_bytes || 0) })) as UploadFileRow[];
  } catch {
    return [];
  }
}

export interface StoragePurchaseRow {
  id: string;
  user_id: string;
  user_name?: string;
  user_email?: string;
  bytes_requested: number;
  crypto_network: string | null;
  tx_hash: string | null;
  proof: string | null;
  status: string;
  admin_user_id: string | null;
  admin_note: string | null;
  created_at: string;
  decided_at: string | null;
}

export async function createStoragePurchase(input: {
  id: string; userId: string; bytesRequested: number; monthsRequested?: number; cryptoNetwork?: string; txHash?: string; proof?: string;
}): Promise<void> {
  if (!mysqlPool) return;
  try {
    await mysqlPool.query(
      `INSERT INTO tl_storage_purchases (id, user_id, bytes_requested, months_requested, crypto_network, tx_hash, proof, status, created_at)
       VALUES (?, ?, ?, ?, ?, ?, ?, 'pending', ?)`,
      [input.id, input.userId, input.bytesRequested, input.monthsRequested || 0, input.cryptoNetwork || null, input.txHash || null, input.proof || null, new Date().toISOString()]
    );
  } catch (err) {
    console.warn('[DB] createStoragePurchase failed:', (err as Error).message);
  }
}

export async function listStoragePurchases(status?: string): Promise<StoragePurchaseRow[]> {
  if (!mysqlPool) return [];
  try {
    const sql = status
      ? `SELECT p.*, u.name AS user_name, u.email AS user_email FROM tl_storage_purchases p LEFT JOIN tl_users u ON u.id = p.user_id WHERE p.status = ? ORDER BY p.created_at DESC`
      : `SELECT p.*, u.name AS user_name, u.email AS user_email FROM tl_storage_purchases p LEFT JOIN tl_users u ON u.id = p.user_id ORDER BY p.created_at DESC`;
    const [rows] = status ? await mysqlPool.query(sql, [status]) : await mysqlPool.query(sql);
    return (rows as any[]).map(r => ({ ...r, bytes_requested: Number(r.bytes_requested || 0) })) as StoragePurchaseRow[];
  } catch {
    return [];
  }
}

export async function decideStoragePurchase(id: string, status: 'approved' | 'rejected', adminUserId: string, note?: string, bytesGranted?: number): Promise<StoragePurchaseRow | null> {
  if (!mysqlPool) return null;
  try {
    const [rows] = await mysqlPool.query('SELECT * FROM tl_storage_purchases WHERE id = ? LIMIT 1', [id]);
    const p = (rows as any[])[0];
    if (!p) return null;
    await mysqlPool.query(
      `UPDATE tl_storage_purchases SET status = ?, admin_user_id = ?, admin_note = ?, decided_at = ? WHERE id = ?`,
      [status, adminUserId, note || null, new Date().toISOString(), id]
    );
    if (status === 'approved') {
      const bytes = bytesGranted && bytesGranted > 0 ? bytesGranted : Number(p.bytes_requested || 0);
      await addUploadQuota(String(p.user_id), bytes);
      const months = Number(p.months_requested || 0);
      if (months > 0) {
        try {
          const q = await getUploadQuota(String(p.user_id));
          const base = q.subscription_expires_at && new Date(q.subscription_expires_at) > new Date() ? new Date(q.subscription_expires_at) : new Date();
          const next = new Date(base);
          next.setMonth(next.getMonth() + months);
          await mysqlPool.query('UPDATE tl_upload_quota SET subscription_expires_at = ?, updated_at = ? WHERE user_id = ?', [next.toISOString(), new Date().toISOString(), String(p.user_id)]);
        } catch { /* ignore */ }
      }
    }
    return { ...p, status, bytes_requested: Number(p.bytes_requested || 0) } as StoragePurchaseRow;
  } catch {
    return null;
  }
}

// user upload file ownership check (for static serving)
export async function userOwnsUploadFile(userId: string, filename: string): Promise<boolean> {
  if (!mysqlPool || !userId || !filename) return false;
  const rel = String(filename).replace(/^\/+/, '');
  if (!rel || rel.includes('..') || rel.includes('\\')) return false;
  try {
    const [rows] = await mysqlPool.query('SELECT id FROM tl_upload_files WHERE user_id = ? AND filename = ? LIMIT 1', [userId, rel]);
    return !!(rows as any[])[0];
  } catch {
    return false;
  }
}

export async function getUploadFileById(id: string): Promise<UploadFileRow | null> {
  if (!mysqlPool) return null;
  try {
    const [rows] = await mysqlPool.query('SELECT * FROM tl_upload_files WHERE id = ? LIMIT 1', [id]);
    const r = (rows as any[])[0];
    return r ? ({ ...r, size_bytes: Number(r.size_bytes || 0) } as UploadFileRow) : null;
  } catch {
    return null;
  }
}

export async function getUploadFileByFilename(filename: string): Promise<UploadFileRow | null> {
  if (!mysqlPool) return null;
  try {
    const [rows] = await mysqlPool.query('SELECT * FROM tl_upload_files WHERE filename = ? LIMIT 1', [filename]);
    const r = (rows as any[])[0];
    return r ? ({ ...r, size_bytes: Number(r.size_bytes || 0) } as UploadFileRow) : null;
  } catch {
    return null;
  }
}

// ---------------------------------------------------------------------------
// Relax Shorts schedule (one durable timer per user) + publish log.
// ---------------------------------------------------------------------------



export interface RelaxScheduleRow {
  user_id: string;
  enabled: number;
  interval_hours: number;
  privacy_status: string;
  daily_times: string[];
  daily_tz: string;
  last_run_at: string | null;
  next_run_at: string | null;
  last_relax_post_id: string | null;
  last_yt_video_id: string | null;
  last_error: string | null;
  ig_profile_url: string | null;
  ig_last_shortcodes: string[];
  created_at: string;
  updated_at: string | null;
}

function mapRelaxSchedule(r: any): RelaxScheduleRow {
  return {
    user_id: r.user_id,
    enabled: Number(r.enabled ?? 0),
    interval_hours: Number(r.interval_hours ?? 24),
    privacy_status: r.privacy_status || 'public',
    daily_times: parseDailyTimesCell(r.daily_times),
    daily_tz: r.daily_tz || 'UTC',
    last_run_at: r.last_run_at || null,
    next_run_at: r.next_run_at || null,
    last_relax_post_id: r.last_relax_post_id || null,
    last_yt_video_id: r.last_yt_video_id || null,
    last_error: r.last_error || null,
    ig_profile_url: r.ig_profile_url || null,
    ig_last_shortcodes: parseStringArrayCell(r.ig_last_shortcodes),
    created_at: r.created_at,
    updated_at: r.updated_at || null
  };
}

export async function getRelaxSchedule(userId: string): Promise<RelaxScheduleRow | null> {
  if (!mysqlPool || !userId) return null;
  try {
    const [rows] = await mysqlPool.query('SELECT * FROM tl_relax_schedule WHERE user_id = ? LIMIT 1', [userId]);
    const r = (rows as any[])[0];
    return r ? mapRelaxSchedule(r) : null;
  } catch {
    return null;
  }
}

export async function upsertRelaxSchedule(userId: string, patch: {
  enabled?: boolean;
  intervalHours?: number;
  privacyStatus?: string;
  dailyTimes?: string[];
  dailyTz?: string;
  lastRunAt?: string | null;
  nextRunAt?: string | null;
  lastRelaxPostId?: string | null;
  lastYtVideoId?: string | null;
  lastError?: string | null;
  igProfileUrl?: string | null;
  igLastShortcodes?: string[];
}): Promise<RelaxScheduleRow | null> {
  if (!mysqlPool || !userId) throw new Error('DATABASE_UNAVAILABLE');
  const cur = await getRelaxSchedule(userId);
  const now = new Date().toISOString();
  const newTimes = patch.dailyTimes !== undefined ? normalizeDailyTimes(patch.dailyTimes) : (cur?.daily_times ?? []);
  const newTz = patch.dailyTz !== undefined ? safeTimeZone(patch.dailyTz) : (cur?.daily_tz ?? 'UTC');
  const newShortcodes = patch.igLastShortcodes !== undefined
    ? patch.igLastShortcodes.map(s => String(s)).filter(Boolean).slice(0, 24)
    : (cur?.ig_last_shortcodes ?? []);
  const next = {
    enabled: patch.enabled !== undefined ? (patch.enabled ? 1 : 0) : (cur?.enabled ?? 0),
    interval_hours: patch.intervalHours !== undefined ? patch.intervalHours : (cur?.interval_hours ?? 24),
    privacy_status: patch.privacyStatus !== undefined ? patch.privacyStatus : (cur?.privacy_status ?? 'public'),
    daily_times: newTimes,
    daily_tz: newTz,
    last_run_at: patch.lastRunAt !== undefined ? patch.lastRunAt : (cur?.last_run_at ?? null),
    next_run_at: patch.nextRunAt !== undefined ? patch.nextRunAt : (cur?.next_run_at ?? null),
    last_relax_post_id: patch.lastRelaxPostId !== undefined ? patch.lastRelaxPostId : (cur?.last_relax_post_id ?? null),
    last_yt_video_id: patch.lastYtVideoId !== undefined ? patch.lastYtVideoId : (cur?.last_yt_video_id ?? null),
    last_error: patch.lastError !== undefined ? patch.lastError : (cur?.last_error ?? null),
    ig_profile_url: patch.igProfileUrl !== undefined ? patch.igProfileUrl : (cur?.ig_profile_url ?? null),
    ig_last_shortcodes: newShortcodes
  };
  // (Re-)arming recomputes next_run_at from NOW (daily times win when set).
  if (patch.intervalHours !== undefined || patch.enabled === true || patch.dailyTimes !== undefined || patch.dailyTz !== undefined) {
    next.next_run_at = computeWatchNextRunAt(Number(next.interval_hours), newTimes, newTz);
  }
  if (patch.enabled === false) next.next_run_at = null;
  await mysqlPool.query(
    `INSERT INTO tl_relax_schedule (user_id, enabled, interval_hours, privacy_status, daily_times, daily_tz,
      last_run_at, next_run_at, last_relax_post_id, last_yt_video_id, last_error, ig_profile_url, ig_last_shortcodes,
      created_at, updated_at)
     VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?)
     ON DUPLICATE KEY UPDATE enabled = VALUES(enabled), interval_hours = VALUES(interval_hours),
       privacy_status = VALUES(privacy_status), daily_times = VALUES(daily_times), daily_tz = VALUES(daily_tz),
       last_run_at = VALUES(last_run_at), next_run_at = VALUES(next_run_at),
       last_relax_post_id = VALUES(last_relax_post_id), last_yt_video_id = VALUES(last_yt_video_id),
       last_error = VALUES(last_error), ig_profile_url = VALUES(ig_profile_url),
       ig_last_shortcodes = VALUES(ig_last_shortcodes), updated_at = VALUES(updated_at)`,
    [userId, next.enabled, next.interval_hours, next.privacy_status, JSON.stringify(newTimes), newTz,
     next.last_run_at, next.next_run_at, next.last_relax_post_id, next.last_yt_video_id, next.last_error,
     next.ig_profile_url, JSON.stringify(newShortcodes),
     cur?.created_at ?? now, now]
  );
  return getRelaxSchedule(userId);
}

export async function listDueRelaxSchedules(nowIso: string, limit = 10): Promise<RelaxScheduleRow[]> {
  if (!mysqlPool) return [];
  try {
    const [rows] = await mysqlPool.query(
      'SELECT * FROM tl_relax_schedule WHERE enabled = 1 AND next_run_at IS NOT NULL AND next_run_at <= ? ORDER BY next_run_at ASC LIMIT ?',
      [nowIso, limit]
    );
    return (rows as any[]).map(mapRelaxSchedule);
  } catch {
    return [];
  }
}

export interface RelaxPostRow {
  id: string;
  user_id: string;
  relax_post_id: string;
  relax_title: string | null;
  filename: string | null;
  yt_video_id: string | null;
  yt_url: string | null;
  status: string;
  error: string | null;
  created_at: string;
}

export async function hasRelaxPost(userId: string, relaxPostId: string): Promise<boolean> {
  if (!mysqlPool) return false;
  try {
    const [rows] = await mysqlPool.query(
      'SELECT id FROM tl_relax_posts WHERE user_id = ? AND relax_post_id = ? LIMIT 1',
      [userId, relaxPostId]
    );
    return !!(rows as any[])[0];
  } catch {
    return false;
  }
}

export async function listRelaxPostIds(userId: string, limit = 100): Promise<string[]> {
  if (!mysqlPool) return [];
  try {
    const [rows] = await mysqlPool.query(
      'SELECT relax_post_id FROM tl_relax_posts WHERE user_id = ? ORDER BY created_at DESC LIMIT ?',
      [userId, limit]
    );
    return (rows as any[]).map((r: any) => String(r.relax_post_id));
  } catch {
    return [];
  }
}

export async function addRelaxPost(input: {
  id: string;
  userId: string;
  relaxPostId: string;
  relaxTitle: string;
  filename: string;
  ytVideoId?: string | null;
  ytUrl?: string | null;
  status: string;
  error?: string | null;
}): Promise<void> {
  if (!mysqlPool) return;
  try {
    await mysqlPool.query(
      `INSERT INTO tl_relax_posts (id, user_id, relax_post_id, relax_title, filename, yt_video_id, yt_url, status, error, created_at)
       VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?)
       ON DUPLICATE KEY UPDATE status = VALUES(status), yt_video_id = VALUES(yt_video_id), yt_url = VALUES(yt_url), error = VALUES(error)`,
      [input.id, input.userId, input.relaxPostId, input.relaxTitle, input.filename,
       input.ytVideoId || null, input.ytUrl || null, input.status, input.error || null, new Date().toISOString()]
    );
  } catch (err) {
    console.warn('[DB] addRelaxPost failed:', (err as Error).message);
  }
}

export async function listRelaxPosts(userId: string, limit = 30): Promise<RelaxPostRow[]> {
  if (!mysqlPool) return [];
  try {
    const [rows] = await mysqlPool.query(
      'SELECT * FROM tl_relax_posts WHERE user_id = ? ORDER BY created_at DESC LIMIT ?',
      [userId, limit]
    );
    return rows as RelaxPostRow[];
  } catch {
    return [];
  }
}

// ---------------------------------------------------------------------------
// Admin Panel: cross-user watch health, publish stats, audit trail.
// (Tokens and emails never leave these rows — routes project them out.)
// ---------------------------------------------------------------------------

export interface AdminWatchRow {
  id: string;
  userId: string;
  userName: string;
  profileUrl: string;
  username: string;
  enabled: number;
  intervalHours: number;
  autoPublish: number;
  dailyTimes: string[];
  dailyTz: string;
  lastCheckAt: string | null;
  nextRunAt: string | null;
  lastShortcode: string | null;
  lastError: string | null;
  liveEnabled: number;
}

/** Every IG watch on the box with its owner (manager eyes only). */
export async function listAllWatchesForAdmin(limit = 200): Promise<AdminWatchRow[]> {
  if (!mysqlPool) return [];
  const n = Math.min(500, Math.max(1, Math.floor(Number(limit) || 200)));
  try {
    const [rows] = await mysqlPool.query(
      `SELECT w.*, u.name AS owner_name FROM tl_ig_watch w
         INNER JOIN tl_users u ON u.id = w.user_id
        ORDER BY w.updated_at DESC LIMIT ${n}`
    );
    return (rows as any[]).map((r: any) => ({
      id: String(r.id || ''),
      userId: String(r.user_id || ''),
      userName: String(r.owner_name || ''),
      profileUrl: String(r.profile_url || ''),
      username: String(r.username || ''),
      enabled: Number(r.enabled ?? 1),
      intervalHours: Number(r.interval_hours ?? 24),
      autoPublish: Number(r.auto_publish ?? 1),
      dailyTimes: parseDailyTimesCell(r.daily_times),
      dailyTz: r.daily_tz || 'UTC',
      lastCheckAt: r.last_check_at || null,
      nextRunAt: r.next_run_at || null,
      lastShortcode: r.last_shortcode || null,
      lastError: r.last_error || null,
      liveEnabled: Number(r.live_enabled ?? 0)
    }));
  } catch {
    return [];
  }
}

export interface PublishStats {
  ig24h: number;
  ig7d: number;
  relax24h: number;
  relax7d: number;
}

/** Published-video counts from the durable logs (pipeline/auto renders are
 *  in-memory jobs and are NOT part of history — IG + Relax only). */
export async function getPublishStats(): Promise<PublishStats> {
  const zero: PublishStats = { ig24h: 0, ig7d: 0, relax24h: 0, relax7d: 0 };
  if (!mysqlPool) return zero;
  try {
    const day = new Date(Date.now() - 24 * 3600 * 1000).toISOString();
    const week = new Date(Date.now() - 7 * 24 * 3600 * 1000).toISOString();
    const count = async (sql: string, param: string): Promise<number> => {
      const [rows] = await mysqlPool!.query(sql, [param]);
      return Number(((rows as any[])[0] || {}).c || 0);
    };
    const [ig24h, ig7d, relax24h, relax7d] = await Promise.all([
      count(`SELECT COUNT(*) AS c FROM tl_ig_posts WHERE status = 'published' AND published_at >= ?`, day),
      count(`SELECT COUNT(*) AS c FROM tl_ig_posts WHERE status = 'published' AND published_at >= ?`, week),
      count(`SELECT COUNT(*) AS c FROM tl_relax_posts WHERE status = 'published' AND created_at >= ?`, day),
      count(`SELECT COUNT(*) AS c FROM tl_relax_posts WHERE status = 'published' AND created_at >= ?`, week)
    ]);
    return { ig24h, ig7d, relax24h, relax7d };
  } catch {
    return zero;
  }
}

export interface AdminAuditRow {
  id: string;
  adminUserId: string;
  adminName: string;
  action: string;
  detail: string | null;
  createdAt: string;
}

/** Fire-and-forget audit write — never throws, never slows the panel. */
export async function logAdminAction(
  adminUserId: string,
  adminName: string,
  action: string,
  detail?: string | null
): Promise<void> {
  if (!mysqlPool) return;
  try {
    await mysqlPool.query(
      'INSERT INTO tl_admin_audit (id, admin_user_id, admin_name, action, detail, created_at) VALUES (?, ?, ?, ?, ?, ?)',
      [uuid(), adminUserId, String(adminName || '').slice(0, 128), String(action || '').slice(0, 64),
       String(detail || '').slice(0, 512) || null, new Date().toISOString()]
    );
  } catch (err) {
    console.warn('[DB] logAdminAction failed:', (err as Error).message);
  }
}

export async function listAdminAudit(limit = 15): Promise<AdminAuditRow[]> {  if (!mysqlPool) return [];
  const n = Math.min(100, Math.max(1, Math.floor(Number(limit) || 15)));
  try {
    const [rows] = await mysqlPool.query(
      `SELECT * FROM tl_admin_audit ORDER BY created_at DESC LIMIT ${n}`
    );
    return (rows as any[]).map((r: any) => ({
      id: String(r.id || ''),
      adminUserId: String(r.admin_user_id || ''),
      adminName: String(r.admin_name || ''),
      action: String(r.action || ''),
      detail: r.detail || null,
      createdAt: String(r.created_at || '')
    }));
  } catch {
    return [];
  }
}

/** All ENABLED Auto-Pilot timers (for the velocity trigger sweep). */
export async function listEnabledAutoSchedules(limit = 20): Promise<AutoScheduleRow[]> {
  if (!mysqlPool) return [];
  const n = Math.min(50, Math.max(1, Math.floor(Number(limit) || 20)));
  try {
    const [rows] = await mysqlPool.query(
      `SELECT * FROM tl_auto_schedule WHERE enabled = 1 ORDER BY next_run_at ASC LIMIT ${n}`
    );
    return (rows as any[]).map(mapAutoSchedule);
  } catch {
    return [];
  }
}

// ---------------------------------------------------------------------------
// Virality engine: title-rotation log (one rotation per video, ever).
// ---------------------------------------------------------------------------

export interface TitleRotationRow {
  video_id: string;
  user_id: string;
  old_title: string | null;
  new_title: string | null;
  views_at_rotation: number | null;
  created_at: string;
}

export async function hasTitleRotation(videoId: string): Promise<boolean> {
  if (!mysqlPool || !videoId) return false;
  try {
    const [rows] = await mysqlPool.query('SELECT video_id FROM tl_title_rotations WHERE video_id = ? LIMIT 1', [videoId]);
    return !!(rows as any[])[0];
  } catch {
    return false;
  }
}

export async function recordTitleRotation(input: {
  videoId: string;
  userId: string;
  oldTitle: string;
  newTitle: string;
  viewsAtRotation: number | null;
}): Promise<void> {
  if (!mysqlPool) return;
  try {
    await mysqlPool.query(
      `INSERT INTO tl_title_rotations (video_id, user_id, old_title, new_title, views_at_rotation, created_at)
       VALUES (?, ?, ?, ?, ?, ?)
       ON DUPLICATE KEY UPDATE new_title = VALUES(new_title), views_at_rotation = VALUES(views_at_rotation)`,
      [input.videoId, input.userId, input.oldTitle.slice(0, 255), input.newTitle.slice(0, 255),
       input.viewsAtRotation, new Date().toISOString()]
    );
  } catch (err) {
    console.warn('[DB] recordTitleRotation failed:', (err as Error).message);
  }
}

export async function listTitleRotations(limit = 10): Promise<TitleRotationRow[]> {
  if (!mysqlPool) return [];
  const n = Math.min(50, Math.max(1, Math.floor(Number(limit) || 10)));
  try {
    const [rows] = await mysqlPool.query(
      `SELECT * FROM tl_title_rotations ORDER BY created_at DESC LIMIT ${n}`
    );
    return (rows as any[]).map((r: any) => ({
      video_id: String(r.video_id || ''),
      user_id: String(r.user_id || ''),
      old_title: r.old_title || null,
      new_title: r.new_title || null,
      views_at_rotation: r.views_at_rotation === null ? null : Number(r.views_at_rotation),
      created_at: String(r.created_at || '')
    }));
  } catch {
    return [];
  }
}

// ---------------------------------------------------------------------------
// Trend publish ledger: durable duplicate-upload guard. The same normalized
// topic must never be uploaded twice to the same channel (or by the same
// user) inside the horizon — across restarts, timers, velocity triggers and
// manual double-clicks. Match is by channel when known (two app users can
// share one YouTube channel), else by user.
// ---------------------------------------------------------------------------

/** Same normalization as the Auto-Pilot in-memory dup guard (kept in sync). */
export function normalizeTrendKeyword(s: unknown): string {
  return String(s || '').toLowerCase().replace(/[^a-z0-9\u0600-\u06FF]+/gi, ' ').trim();
}

export interface TrendPublishRow {
  id: string;
  user_id: string;
  channel_id: string | null;
  norm_keyword: string;
  keyword: string | null;
  title: string | null;
  yt_video_id: string | null;
  job_id: string | null;
  published_at: string;
}

export async function hasRecentTrendPublish(
  userId: string,
  channelId: string | null,
  keyword: unknown,
  horizonHours = 48
): Promise<TrendPublishRow | null> {
  if (!mysqlPool) return null;
  const norm = normalizeTrendKeyword(keyword);
  if (!norm || !userId) return null;
  const h = Math.min(720, Math.max(1, Number(horizonHours) || 48));
  try {
    const ch = String(channelId || '');
    const [rows] = await mysqlPool.query(
      `SELECT * FROM tl_trend_publishes
        WHERE norm_keyword = ? AND (user_id = ? OR (? != '' AND channel_id = ?))
        ORDER BY published_at DESC LIMIT 1`,
      [norm, userId, ch, ch]
    );
    const r = (rows as any[])[0];
    if (!r) return null;
    const t = Date.parse(String(r.published_at || ''));
    if (!Number.isFinite(t) || Date.now() - t > h * 3600 * 1000) return null;
    return {
      id: String(r.id || ''),
      user_id: String(r.user_id || ''),
      channel_id: r.channel_id || null,
      norm_keyword: String(r.norm_keyword || ''),
      keyword: r.keyword || null,
      title: r.title || null,
      yt_video_id: r.yt_video_id || null,
      job_id: r.job_id || null,
      published_at: String(r.published_at || '')
    };
  } catch {
    return null;
  }
}

export async function recordTrendPublish(input: {
  userId: string;
  channelId?: string | null;
  keyword: unknown;
  title?: string | null;
  ytVideoId?: string | null;
  jobId?: string | null;
}): Promise<void> {
  if (!mysqlPool) return;
  const norm = normalizeTrendKeyword(input.keyword);
  if (!norm || !input.userId) return;
  try {
    await mysqlPool.query(
      `INSERT INTO tl_trend_publishes (id, user_id, channel_id, norm_keyword, keyword, title, yt_video_id, job_id, published_at)
       VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?)`,
      [uuid(), input.userId, String(input.channelId || '') || null, norm,
       String(input.keyword || '').slice(0, 255), String(input.title || '').slice(0, 255),
       input.ytVideoId || null, input.jobId || null, new Date().toISOString()]
    );
  } catch (err) {
    console.warn('[DB] recordTrendPublish failed:', (err as Error).message);
  }
}