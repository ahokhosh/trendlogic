export type SearchIntentType =
  | 'why_trending'
  | 'what_happened'
  | 'who_won'
  | 'why_important'
  | 'what_changed'
  | 'behind_controversy';

export interface TrendSource {
  title: string;
  name: string;
  url: string;
  publishedAt: string;
  snippet: string;
  credibilityScore: number;
  /** News-item photo from Google Trends RSS (multi-shot template cut). */
  picture?: string;
}

export interface NormalizedTrend {
  id: string;
  country: string;
  language: string;
  keyword: string;
  rank: number;
  trend_score: number;
  velocity: number;
  search_volume: number;
  detected_at: string;
  category: 'sports' | 'technology' | 'entertainment' | 'business' | 'world' | 'science';
  description: string;
  image_url: string;
  sources: TrendSource[];
  // Differentiating Intent & Question fields
  detectedIntent?: SearchIntentType;
  primaryQuestion?: string;
  candidateQuestions?: string[];
  dedupClusterId?: string;
  isDuplicate?: boolean;
  isLiveGoogleTrend?: boolean;
  rawGoogleTraffic?: string;
  /** Trending Now (batchexecute feed) extras — used for video + IG-clip QC. */
  breakdownKeywords?: string[];
  /** Google's OWN photos for this exact trend item (RSS item picture, news
   *  pictures, article og:image) — most representative first. The renderer
   *  fills the 4-shot cut from these before any Wikimedia/AI visual. */
  storyImageUrls?: string[];
  percentGrowth?: number;
  startedAt?: string;
  endedAt?: string | null;
  isActive?: boolean;
}

export interface VerifiedFact {
  id: string;
  claim: string;
  sourceName: string;
  sourceUrl: string;
  confidence: number;
  corroboratedByCount: number;
  status: 'verified' | 'disputed' | 'unverified';
}

export interface ContentAngle {
  id: string;
  angleType: 'the_sudden_twist' | 'behind_the_scoreline' | 'breaking_revelation' | 'context_and_impact' | 'myth_vs_reality';
  title: string;
  hookPremise: string;
  editorialTone: 'urgent_explainer' | 'investigative' | 'analytical' | 'conversational_fast';
  whyThisWorks: string;
}

export interface ScriptScene {
  id: string;
  sceneNumber: number;
  timestampStart: number;
  timestampEnd: number;
  narratorText: string;
  visualPrompt: string;
  shotType: 'macro_zoom' | 'kinetic_split' | 'headline_pop' | 'photo_evidence' | 'infographic_stat' | 'dramatic_close';
  graphicOverlay: string;
  assetUrl?: string;
  audioEmphasisWords?: string[];
}

export interface ScriptPackage {
  id: string;
  trendKeyword: string;
  headlineQuestion: string;
  searchIntent: SearchIntentType;
  angle: ContentAngle;
  fullScript: string;
  estimatedDurationSec: number;
  wordCount: number;
  scenes: ScriptScene[];
  targetAudience: string;
}

export interface QualityCheckItem {
  id: string;
  name: string;
  category: 'accuracy' | 'intent' | 'pacing' | 'compliance' | 'production';
  status: 'pass' | 'warn' | 'fail';
  score: number;
  detail: string;
}

export interface QualityControlReport {
  overallScore: number;
  passed: boolean;
  factTraceabilityScore: number;
  intentRelevanceScore: number;
  pacingScore: number;
  safetyStatus: 'green' | 'yellow' | 'flagged';
  checks: QualityCheckItem[];
  auditedAt: string;
}

export interface SEOPackage {
  title: string;
  description: string;
  hashtags: string[];
  tags: string[];
  pinnedComment: string;
  thumbnailHook: string;
  soundtrackRecommendation: string;
}

export interface PlatformPublishStatus {
  platform: 'youtube_shorts' | 'tiktok' | 'instagram_reels' | 'x' | 'website';
  enabled: boolean;
  status: 'draft' | 'scheduled' | 'published' | 'failed';
  publishedUrl?: string;
  scheduledTime?: string;
}

export interface PipelineLog {
  id: string;
  timestamp: string;
  step: string;
  message: string;
  type: 'info' | 'success' | 'warn' | 'error';
}

export type PipelineStepStatus =
  | 'idle'
  | 'discovery'
  | 'normalization'
  | 'deduplication'
  | 'scoring'
  | 'intent'
  | 'question'
  | 'research'
  | 'verification'
  | 'angle'
  | 'scripting'
  | 'storyboard'
  | 'assets'
  | 'voice'
  | 'subtitles'
  | 'rendering'
  | 'seo'
  | 'qc'
  | 'approval'
  | 'publishing'
  | 'completed'
  | 'failed';

export interface PipelineJob {
  id: string;
  /** Owner account — jobs are private; list/detail only return the caller's own. */
  ownerUserId?: string | null;
  trendId: string;
  trendKeyword: string;
  category: string;
  status: 'queued' | 'running' | 'completed' | 'failed' | 'needs_approval';
  currentStep: PipelineStepStatus;
  progressPercent: number;
  startedAt: string;
  completedAt?: string;
  error?: string;
  logs: PipelineLog[];
  trend: NormalizedTrend;
  facts?: VerifiedFact[];
  script?: ScriptPackage;
  qc?: QualityControlReport;
  seo?: SEOPackage;
  publishing?: PlatformPublishStatus[];
  videoUrl?: string;
  audioUrl?: string;
  renderedMp4Size?: number;
  voiceId?: string;
}

export interface YouTubeChannelConfig {
  clientId?: string;
  clientSecret?: string;
  apiKey?: string;
  accessToken?: string;
  refreshToken?: string;
  channelId?: string;
  channelTitle?: string;
  channelCustomUrl?: string;
  channelThumbnail?: string;
  subscriberCount?: string;
  privacyStatus: 'public' | 'unlisted' | 'private';
  connected: boolean;
  lastPublishDate?: string;
  lastVideoId?: string;
}

/** Public TikTok account shape (tokens never reach the browser). */
export interface TikTokAccountConfig {
  openId?: string | null;
  displayName?: string;
  avatarUrl?: string;
  privacyLevel: 'PUBLIC_TO_EVERYONE' | 'SELF_ONLY';
  connected: boolean;
  lastPublishDate?: string;
  lastPublishId?: string;
}

export interface TrendProviderConfig {
  id: string;
  name: string;
  providerType: 'google_trends' | 'news_feed' | 'youtube_trending' | 'social_stream' | 'internal_crawler';
  active: boolean;
  country: string;
  category: string;
  refreshIntervalMin: number;
  lastSync: string;
  itemsDiscoveredCount: number;
}

export interface PipelineSettings {
  autoPublish: boolean;
  minQcScoreForAutoPublish: number;
  minFactConfidence: number;
  targetVideoLengthSec: number;
  voiceModel: 'Kore' | 'Puck' | 'Zephyr' | 'Fenrir';
  activePlatforms: string[];
}

export interface RenderedVideoItem {
  filename: string;
  url: string;
  sizeBytes: number;
  sizeFormatted: string;
  modifiedAt: string;
  isAiVideo: boolean;
  thumbnailUrl: string;
  keyword: string;
  jobId: string;
  durationSec: number;
}

export interface IgWatch {
  id: string;
  user_id: string;
  profile_url: string;
  username: string;
  enabled: number;
  interval_hours: number;
  auto_publish: number;
  privacy_status: 'public' | 'unlisted' | 'private';
  /** Exact daily firing times ("HH:MM" wall clock in daily_tz). Non-empty = exact mode (interval ignored). */
  daily_times: string[];
  daily_tz: string;
  hashtags: string[];
  last_check_at: string | null;
  next_run_at: string | null;
  last_shortcode: string | null;
  last_error: string | null;
  /** IG-to-Live loop: 1 = this profile's timer keeps its newest reel on air. */
  live_enabled: number;
  live_shortcode: string | null;
  live_started_at: string | null;
  created_at: string;
}

export interface IgPost {
  id: string;
  watch_id: string;
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
  /** Winner-content metrics (0/undefined = unscored, e.g. anonymous listing). */
  play_count?: number | null;
  like_count?: number | null;
  comment_count?: number | null;
  winner_score?: number | null;
}
