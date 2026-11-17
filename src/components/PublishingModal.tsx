import React, { useState, useEffect } from 'react';
import {
  Share2,
  CheckCircle2,
  Clock,
  Youtube,
  Music2,
  Send,
  ExternalLink,
  Copy,
  Sparkles,
  ShieldCheck,
  Hash,
  Settings,
  EyeOff,
  Globe,
  Lock,
  Download,
  AlertCircle
} from 'lucide-react';
import { SEOPackage, PlatformPublishStatus, QualityControlReport, YouTubeChannelConfig, TikTokAccountConfig } from '../types';
import { YouTubeSettingsModal } from './YouTubeSettingsModal';
import { TikTokSettingsModal } from './TikTokSettingsModal';

interface PublishingModalProps {
  isOpen: boolean;
  onClose: () => void;
  jobId?: string;
  videoUrl?: string;
  seo?: SEOPackage;
  qc?: QualityControlReport;
  keyword: string;
  publishingStatus?: PlatformPublishStatus[];
  onConfirmPublish: (platforms: string[]) => void;
}

export const PublishingModal: React.FC<PublishingModalProps> = ({
  isOpen,
  onClose,
  jobId,
  videoUrl,
  seo,
  qc,
  keyword,
  publishingStatus,
  onConfirmPublish
}) => {
  const [selectedPlatforms, setSelectedPlatforms] = useState<string[]>([
    'youtube_shorts',
    'tiktok'
  ]);
  const [privacyStatus, setPrivacyStatus] = useState<'public' | 'unlisted' | 'private'>('unlisted');
  const [tiktokPrivacy, setTiktokPrivacy] = useState<'PUBLIC_TO_EVERYONE' | 'SELF_ONLY'>('PUBLIC_TO_EVERYONE');
  const [isCopied, setIsCopied] = useState<boolean>(false);
  const [isPublishing, setIsPublishing] = useState<boolean>(false);
  const [publishedUrl, setPublishedUrl] = useState<string | null>(null);
  const [publishedVideoId, setPublishedVideoId] = useState<string | null>(null);
  const [publishMessage, setPublishMessage] = useState<string | null>(null);
  const [publishError, setPublishError] = useState<string | null>(null);
  const [tiktokMessage, setTiktokMessage] = useState<string | null>(null);
  const [tiktokError, setTiktokError] = useState<string | null>(null);
  const [isSettingsOpen, setIsSettingsOpen] = useState<boolean>(false);
  const [isTikTokSettingsOpen, setIsTikTokSettingsOpen] = useState<boolean>(false);
  const [ytConfig, setYtConfig] = useState<YouTubeChannelConfig | null>(null);
  const [ttConfig, setTtConfig] = useState<TikTokAccountConfig | null>(null);

  useEffect(() => {
    if (isOpen) {
      setPublishError(null);
      setTiktokError(null);
      fetch('/api/youtube/config')
        .then(r => r.json())
        .then(d => {
          if (d.config) {
            setYtConfig(d.config);
            if (d.config.privacyStatus) setPrivacyStatus(d.config.privacyStatus);
          }
        })
        .catch(() => {});
      fetch('/api/tiktok/config')
        .then(r => r.json())
        .then(d => {
          if (d.config) {
            setTtConfig(d.config);
            if (d.config.privacyLevel) setTiktokPrivacy(d.config.privacyLevel);
          }
        })
        .catch(() => {});
    }
  }, [isOpen]);

  if (!isOpen) return null;

  const platforms = [
    { id: 'youtube_shorts', name: 'YouTube Shorts (Live Channel)', icon: '▶', desc: 'Direct YouTube Data API v3 upload • 9:16 vertical • Verified tags' },
    { id: 'tiktok', name: 'TikTok Feed', icon: '🎵', desc: 'Direct TikTok Content Posting API upload • same 9:16 MP4, simultaneous' },
    { id: 'instagram_reels', name: 'Instagram Reels', icon: '📸', desc: 'Explainer reels with high-retention thumbnail hook' },
    { id: 'x', name: 'X / Twitter Video', icon: '𝕏', desc: 'Threaded fact breakdown with video attachment' }
  ];

  const handleCopyDescription = () => {
    if (seo?.description) {
      navigator.clipboard.writeText(seo.description);
      setIsCopied(true);
      setTimeout(() => setIsCopied(false), 2000);
    }
  };

  const handlePublish = async () => {
    setIsPublishing(true);
    setPublishedUrl(null);
    setPublishedVideoId(null);
    setPublishMessage(null);
    setPublishError(null);
    setTiktokMessage(null);
    setTiktokError(null);

    try {
      if (selectedPlatforms.includes('youtube_shorts')) {
        const res = await fetch('/api/youtube/publish', {
          method: 'POST',
          headers: { 'Content-Type': 'application/json' },
          body: JSON.stringify({
            jobId: jobId || undefined,
            videoUrl: videoUrl || undefined,
            privacyStatus,
            title: seo?.title,
            description: seo?.description,
            tags: seo?.tags
          })
        });

        const data = await res.json();
        if (!res.ok || data.success === false) {
          throw new Error(data.error || 'Failed to upload video to YouTube.');
        }

        if (data.publishedUrl) {
          setPublishedUrl(data.publishedUrl);
        }
        if (data.videoId) {
          setPublishedVideoId(data.videoId);
        }
        if (data.message) {
          setPublishMessage(data.message);
        }
      }

      // Simultaneous TikTok: the SAME rendered MP4 goes to TikTok right
      // after YouTube. Independent result banner — a TikTok failure never
      // hides a YouTube success (and vice versa).
      if (selectedPlatforms.includes('tiktok')) {
        try {
          const res = await fetch('/api/tiktok/publish', {
            method: 'POST',
            headers: { 'Content-Type': 'application/json' },
            body: JSON.stringify({
              jobId: jobId || undefined,
              videoUrl: videoUrl || undefined,
              privacyLevel: tiktokPrivacy,
              title: seo?.title
                ? `${seo.title} ${(seo.tags || []).slice(0, 4).join(' ')}`.trim()
                : keyword
            })
          });

          const data = await res.json();
          if (!res.ok || data.success === false) {
            throw new Error(data.error || 'Failed to upload video to TikTok.');
          }
          setTiktokMessage(data.message || 'Video uploaded to TikTok.');
        } catch (ttErr: any) {
          setTiktokError(ttErr.message || 'TikTok upload error occurred.');
        }
      }

      onConfirmPublish(selectedPlatforms);
    } catch (err: any) {
      console.error('Publish error:', err);
      setPublishError(err.message || 'Upload error occurred.');
    } finally {
      setIsPublishing(false);
    }
  };

  const togglePlatform = (id: string) => {
    setSelectedPlatforms(prev =>
      prev.includes(id) ? prev.filter(p => p !== id) : [...prev, id]
    );
  };

  return (
    <>
      <div className="fixed inset-0 z-50 bg-black/80 backdrop-blur-sm flex items-center justify-center p-4">
        <div className="bg-slate-900 border border-slate-800 rounded-3xl max-w-2xl w-full p-6 space-y-6 shadow-2xl overflow-hidden max-h-[90vh] overflow-y-auto">
          {/* Header */}
          <div className="flex items-start justify-between border-b border-slate-800 pb-4">
            <div className="flex items-center gap-3">
              <div className="w-10 h-10 rounded-2xl bg-red-600/20 border border-red-500/30 flex items-center justify-center text-red-400">
                <Youtube className="w-6 h-6" />
              </div>
              <div>
                <h2 className="text-base font-black text-white uppercase font-mono tracking-wide">
                  YouTube Shorts & Multi-Platform Publisher
                </h2>
                <p className="text-xs text-slate-400 mt-0.5">
                  Publish your generated vertical MP4 explainer video directly to your YouTube channel.
                </p>
              </div>
            </div>

            <button
              onClick={onClose}
              className="text-slate-400 hover:text-white p-1 rounded-lg text-sm"
            >
              ✕
            </button>
          </div>

          {/* YouTube Channel Status & Settings trigger */}
          <div className="p-3.5 rounded-2xl bg-slate-950/80 border border-slate-800 flex items-center justify-between">
            <div className="flex items-center gap-3">
              <div className={`w-3 h-3 rounded-full ${ytConfig?.connected ? 'bg-emerald-400 animate-pulse' : 'bg-amber-400'}`} />
              <div>
                <span className="text-xs font-bold text-white block">
                  Channel: {ytConfig?.channelTitle || (ytConfig?.connected ? 'Connected Account' : 'Not Connected')}
                </span>
                <span className="text-[11px] text-slate-400 font-mono">
                  {ytConfig?.subscriberCount ? `${ytConfig.subscriberCount} subscribers • ` : ''}Default: {privacyStatus.toUpperCase()}
                </span>
              </div>
            </div>

            <button
              type="button"
              onClick={() => setIsSettingsOpen(true)}
              className="px-3 py-1.5 rounded-xl bg-slate-800 hover:bg-slate-700 text-slate-300 text-xs font-semibold flex items-center gap-1.5 transition-colors"
            >
              <Settings className="w-3.5 h-3.5 text-red-400" />
              <span>{ytConfig?.connected ? 'API Settings' : 'Connect YouTube'}</span>
            </button>
          </div>

          {/* TikTok Account Status & Settings trigger */}
          <div className="p-3.5 rounded-2xl bg-slate-950/80 border border-slate-800 flex items-center justify-between">
            <div className="flex items-center gap-3">
              <div className={`w-3 h-3 rounded-full ${ttConfig?.connected ? 'bg-emerald-400 animate-pulse' : 'bg-amber-400'}`} />
              <div>
                <span className="text-xs font-bold text-white block">
                  TikTok: {ttConfig?.displayName || (ttConfig?.connected ? 'Connected Account' : 'Not Connected')}
                </span>
                <span className="text-[11px] text-slate-400 font-mono">
                  Default: {tiktokPrivacy === 'PUBLIC_TO_EVERYONE' ? 'PUBLIC' : 'PRIVATE'}
                </span>
              </div>
            </div>

            <button
              type="button"
              onClick={() => setIsTikTokSettingsOpen(true)}
              className="px-3 py-1.5 rounded-xl bg-slate-800 hover:bg-slate-700 text-slate-300 text-xs font-semibold flex items-center gap-1.5 transition-colors"
            >
              <Music2 className="w-3.5 h-3.5 text-cyan-400" />
              <span>{ttConfig?.connected ? 'TikTok Settings' : 'Connect TikTok'}</span>
            </button>
          </div>

          {/* Error Banner if YouTube publish failed */}
          {publishError && (
            <div className="p-4 rounded-2xl bg-red-950/50 border border-red-500/50 space-y-2">
              <div className="flex items-center gap-2 text-red-300 font-bold text-xs">
                <AlertCircle className="w-5 h-5 text-red-400 shrink-0" />
                <span>Upload Failed:</span>
              </div>
              <p className="text-xs text-red-200 font-mono">
                {publishError}
              </p>
              <div className="flex items-center gap-2 pt-1">
                <button
                  type="button"
                  onClick={() => setIsSettingsOpen(true)}
                  className="px-3 py-1.5 rounded-lg bg-red-800 hover:bg-red-700 text-white text-xs font-semibold"
                >
                  Verify YouTube API Connection
                </button>
                <button
                  type="button"
                  onClick={handlePublish}
                  className="px-3 py-1.5 rounded-lg bg-slate-800 hover:bg-slate-700 text-white text-xs font-semibold"
                >
                  Retry Upload
                </button>
              </div>
            </div>
          )}

          {/* Success Result Banner if Published */}
          {publishedUrl && (
            <div className="p-4 rounded-2xl bg-emerald-950/50 border border-emerald-500/50 space-y-2">
              <div className="flex items-center gap-2 text-emerald-300 font-bold text-xs">
                <CheckCircle2 className="w-5 h-5 text-emerald-400 shrink-0" />
                <span>Video Successfully Distributed to YouTube Shorts!</span>
              </div>
              <p className="text-xs text-slate-300">
                {publishMessage || 'Your Short is now live and processing on YouTube.'}
              </p>
              <div className="flex items-center gap-3 pt-1 flex-wrap">
                <a
                  href={publishedUrl}
                  target="_blank"
                  rel="noreferrer"
                  className="px-4 py-2 rounded-xl bg-red-600 hover:bg-red-500 text-white font-bold text-xs flex items-center gap-2 transition-all shadow-lg shadow-red-600/30"
                >
                  <Youtube className="w-4 h-4" />
                  <span>Open on YouTube Shorts</span>
                  <ExternalLink className="w-3.5 h-3.5" />
                </a>

                {publishedVideoId && (
                  <a
                    href={`https://studio.youtube.com/video/${publishedVideoId}/edit`}
                    target="_blank"
                    rel="noreferrer"
                    className="px-3 py-2 rounded-xl bg-slate-800 hover:bg-slate-700 text-slate-200 font-semibold text-xs flex items-center gap-1.5 transition-colors"
                  >
                    <span>Edit in YouTube Studio</span>
                    <ExternalLink className="w-3.5 h-3.5" />
                  </a>
                )}

                {videoUrl && (
                  <a
                    href={videoUrl}
                    download={`${keyword.replace(/\s+/g, '_')}_Short.mp4`}
                    className="px-3 py-2 rounded-xl bg-slate-800 hover:bg-slate-700 text-slate-200 font-semibold text-xs flex items-center gap-1.5 transition-colors"
                  >
                    <Download className="w-3.5 h-3.5 text-sky-400" />
                    <span>Download MP4</span>
                  </a>
                )}
              </div>
            </div>
          )}

          {/* TikTok result banners */}
          {tiktokError && (
            <div className="p-4 rounded-2xl bg-red-950/50 border border-red-500/50 space-y-2">
              <div className="flex items-center gap-2 text-red-300 font-bold text-xs">
                <AlertCircle className="w-5 h-5 text-red-400 shrink-0" />
                <span>TikTok Upload Failed:</span>
              </div>
              <p className="text-xs text-red-200 font-mono">
                {tiktokError}
              </p>
              <div className="flex items-center gap-2 pt-1">
                <button
                  type="button"
                  onClick={() => setIsTikTokSettingsOpen(true)}
                  className="px-3 py-1.5 rounded-lg bg-red-800 hover:bg-red-700 text-white text-xs font-semibold"
                >
                  Verify TikTok Connection
                </button>
                <button
                  type="button"
                  onClick={handlePublish}
                  className="px-3 py-1.5 rounded-lg bg-slate-800 hover:bg-slate-700 text-white text-xs font-semibold"
                >
                  Retry Upload
                </button>
              </div>
            </div>
          )}

          {tiktokMessage && (
            <div className="p-4 rounded-2xl bg-cyan-950/50 border border-cyan-500/50 space-y-2">
              <div className="flex items-center gap-2 text-cyan-300 font-bold text-xs">
                <CheckCircle2 className="w-5 h-5 text-cyan-400 shrink-0" />
                <span>Video Distributed to TikTok!</span>
              </div>
              <p className="text-xs text-slate-300">
                {tiktokMessage}
              </p>
            </div>
          )}

          {/* Privacy Selector for YouTube */}
          <div>
            <label className="text-xs font-bold uppercase font-mono text-slate-300 block mb-1.5">
              YouTube Shorts Privacy Status
            </label>
            <div className="grid grid-cols-3 gap-2">
              {[
                { id: 'unlisted', label: 'Unlisted', desc: 'Direct link only', icon: EyeOff },
                { id: 'public', label: 'Public', desc: 'Live on feed', icon: Globe },
                { id: 'private', label: 'Private', desc: 'Owner only', icon: Lock }
              ].map(opt => {
                const Icon = opt.icon;
                const isSelected = privacyStatus === opt.id;
                return (
                  <button
                    key={opt.id}
                    type="button"
                    onClick={() => setPrivacyStatus(opt.id as any)}
                    className={`p-2.5 rounded-xl border text-left transition-all ${
                      isSelected
                        ? 'bg-red-950/40 border-red-500 text-white'
                        : 'bg-slate-950/40 border-slate-800 text-slate-400 hover:border-slate-700'
                    }`}
                  >
                    <div className="flex items-center gap-1.5">
                      <Icon className="w-3.5 h-3.5 text-red-400" />
                      <span className="text-xs font-bold">{opt.label}</span>
                    </div>
                    <span className="text-[10px] text-slate-500 block mt-0.5">
                      {opt.desc}
                    </span>
                  </button>
                );
              })}
            </div>
          </div>

          {/* Privacy Selector for TikTok (shown when TikTok is selected) */}
          {selectedPlatforms.includes('tiktok') && (
            <div>
              <label className="text-xs font-bold uppercase font-mono text-slate-300 block mb-1.5">
                TikTok Privacy (no Unlisted on TikTok)
              </label>
              <div className="grid grid-cols-2 gap-2">
                {[
                  { id: 'PUBLIC_TO_EVERYONE', label: 'Public', desc: 'Live on your profile', icon: Globe },
                  { id: 'SELF_ONLY', label: 'Private', desc: 'Only you — works before app audit', icon: Lock }
                ].map(opt => {
                  const Icon = opt.icon;
                  const isSelected = tiktokPrivacy === opt.id;
                  return (
                    <button
                      key={opt.id}
                      type="button"
                      onClick={() => setTiktokPrivacy(opt.id as any)}
                      className={`p-2.5 rounded-xl border text-left transition-all ${
                        isSelected
                          ? 'bg-cyan-950/40 border-cyan-500 text-white'
                          : 'bg-slate-950/40 border-slate-800 text-slate-400 hover:border-slate-700'
                      }`}
                    >
                      <div className="flex items-center gap-1.5">
                        <Icon className="w-3.5 h-3.5 text-cyan-400" />
                        <span className="text-xs font-bold">{opt.label}</span>
                      </div>
                      <span className="text-[10px] text-slate-500 block mt-0.5">
                        {opt.desc}
                      </span>
                    </button>
                  );
                })}
              </div>
            </div>
          )}

          {/* SEO Metadata Package */}
          {seo && (
            <div className="space-y-3 bg-slate-950/70 p-4 rounded-2xl border border-slate-800">
              <div className="flex items-center justify-between">
                <span className="text-xs font-bold uppercase font-mono text-amber-400 flex items-center gap-1.5">
                  <Sparkles className="w-3.5 h-3.5" />
                  <span>Verified SEO Metadata (YouTube Shorts)</span>
                </span>
                <button
                  type="button"
                  onClick={handleCopyDescription}
                  className="text-[11px] text-slate-400 hover:text-slate-200 flex items-center gap-1"
                >
                  <Copy className="w-3 h-3" />
                  <span>{isCopied ? 'Copied!' : 'Copy Info'}</span>
                </button>
              </div>

              <div>
                <label className="text-[10px] font-mono uppercase text-slate-400 block mb-1">
                  Video Title (Question-Focused)
                </label>
                <div className="p-2.5 rounded-xl bg-slate-900 border border-slate-800 text-xs font-semibold text-white">
                  {seo.title}
                </div>
              </div>

              <div>
                <label className="text-[10px] font-mono uppercase text-slate-400 block mb-1">
                  Description with Google Trends Sources
                </label>
                <div className="p-2.5 rounded-xl bg-slate-900 border border-slate-800 text-xs text-slate-300 whitespace-pre-wrap font-mono max-h-20 overflow-y-auto">
                  {seo.description}
                </div>
              </div>
            </div>
          )}

          {/* Channel Selection */}
          <div>
            <label className="text-xs font-bold uppercase font-mono text-slate-300 block mb-2">
              Select Publishing Channels
            </label>
            <div className="grid grid-cols-1 sm:grid-cols-2 gap-2.5">
              {platforms.map(p => {
                const isSelected = selectedPlatforms.includes(p.id);
                return (
                  <div
                    key={p.id}
                    onClick={() => togglePlatform(p.id)}
                    className={`p-3 rounded-xl border cursor-pointer transition-all flex items-start gap-3 ${
                      isSelected
                        ? 'bg-red-950/40 border-red-500/80 text-white'
                        : 'bg-slate-950/40 border-slate-800 text-slate-400 hover:border-slate-700'
                    }`}
                  >
                    <input
                      type="checkbox"
                      checked={isSelected}
                      onChange={() => {}}
                      className="mt-0.5 rounded accent-red-600"
                    />
                    <div>
                      <span className="text-xs font-bold block">{p.name}</span>
                      <span className="text-[10px] text-slate-400 leading-tight block mt-0.5">
                        {p.desc}
                      </span>
                    </div>
                  </div>
                );
              })}
            </div>
          </div>

          {/* Footer actions */}
          <div className="flex items-center justify-between pt-4 border-t border-slate-800">
            <span className="text-xs text-slate-400 font-mono">
              {selectedPlatforms.length} destinations selected
            </span>

            <div className="flex items-center gap-2">
              <button
                type="button"
                onClick={onClose}
                className="px-4 py-2 rounded-xl bg-slate-800 hover:bg-slate-700 text-white text-xs font-semibold transition-colors"
              >
                Close
              </button>

              {!ytConfig?.connected && !ttConfig?.connected && selectedPlatforms.includes('youtube_shorts') && selectedPlatforms.includes('tiktok') ? (
                <button
                  type="button"
                  onClick={() => setIsSettingsOpen(true)}
                  className="px-5 py-2 rounded-xl bg-gradient-to-r from-amber-600 to-red-600 hover:brightness-110 text-white text-xs font-bold flex items-center gap-2 shadow-lg shadow-amber-600/30 transition-all"
                >
                  <Youtube className="w-4 h-4" />
                  <span>Connect an Account First</span>
                </button>
              ) : selectedPlatforms.includes('youtube_shorts') && !ytConfig?.connected ? (
                <button
                  type="button"
                  onClick={() => setIsSettingsOpen(true)}
                  className="px-5 py-2 rounded-xl bg-gradient-to-r from-amber-600 to-red-600 hover:brightness-110 text-white text-xs font-bold flex items-center gap-2 shadow-lg shadow-amber-600/30 transition-all"
                >
                  <Youtube className="w-4 h-4" />
                  <span>Connect YouTube Channel First</span>
                </button>
              ) : selectedPlatforms.includes('tiktok') && !ttConfig?.connected ? (
                <button
                  type="button"
                  onClick={() => setIsTikTokSettingsOpen(true)}
                  className="px-5 py-2 rounded-xl bg-gradient-to-r from-cyan-600 to-fuchsia-600 hover:brightness-110 text-white text-xs font-bold flex items-center gap-2 shadow-lg shadow-cyan-600/30 transition-all"
                >
                  <Music2 className="w-4 h-4" />
                  <span>Connect TikTok Account First</span>
                </button>
              ) : (
                <button
                  type="button"
                  onClick={handlePublish}
                  disabled={isPublishing || selectedPlatforms.length === 0}
                  className="px-5 py-2 rounded-xl bg-gradient-to-r from-red-600 to-amber-600 hover:brightness-110 text-white text-xs font-bold flex items-center gap-2 shadow-lg shadow-red-600/30 disabled:opacity-50 transition-all"
                >
                  {isPublishing ? (
                    <>
                      <span className="w-4 h-4 rounded-full border-2 border-white border-t-transparent animate-spin" />
                      <span>Uploading...</span>
                    </>
                  ) : (
                    <>
                      <Send className="w-4 h-4" />
                      <span>
                        {selectedPlatforms.includes('youtube_shorts') && selectedPlatforms.includes('tiktok')
                          ? 'Publish to YouTube + TikTok'
                          : selectedPlatforms.includes('tiktok')
                            ? 'Publish Video to TikTok'
                            : 'Publish Video to YouTube'}
                      </span>
                    </>
                  )}
                </button>
              )}
            </div>
          </div>
        </div>
      </div>

      <YouTubeSettingsModal
        isOpen={isSettingsOpen}
        onClose={() => setIsSettingsOpen(false)}
        onConfigSaved={cfg => {
          setYtConfig(cfg);
          if (cfg.privacyStatus) setPrivacyStatus(cfg.privacyStatus);
        }}
      />

      <TikTokSettingsModal
        isOpen={isTikTokSettingsOpen}
        onClose={() => setIsTikTokSettingsOpen(false)}
        onConfigSaved={cfg => {
          setTtConfig(cfg);
          if (cfg.privacyLevel) setTiktokPrivacy(cfg.privacyLevel);
        }}
      />
    </>
  );
};
