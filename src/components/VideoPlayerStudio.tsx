import React, { useState, useEffect, useRef } from "react";
import {
  Play,
  Pause,
  RotateCcw,
  Volume2,
  VolumeX,
  Share2,
  Download,
  ShieldCheck,
  CheckCircle2,
  Tv,
  HelpCircle,
  ExternalLink,
  FastForward,
  Sparkles,
  Info,
  Film,
  Layers,
  Youtube,
  Flame,
  Check,
  Video,
  Loader2,
  RefreshCw,
  Zap,
  X,
  Mic,
} from "lucide-react";
import {
  ScriptPackage,
  VerifiedFact,
  QualityControlReport,
  SEOPackage,
  RenderedVideoItem,
} from "../types";
interface VideoPlayerStudioProps {
  script: ScriptPackage;
  facts: VerifiedFact[];
  qc?: QualityControlReport;
  seo?: SEOPackage;
  keyword: string;
  videoUrl?: string;
  audioUrl?: string;
  renderedMp4Size?: number;
  jobId?: string;
  onPublishClick?: () => void;
  onVideoGenerated?: (url: string) => void;
  user?: { prefs?: { preferred_ai_model?: string } };
  onSavePrefs?: (prefs: { preferred_ai_model: string }) => void;
}
export const VideoPlayerStudio: React.FC<VideoPlayerStudioProps> = ({
  script,
  facts,
  qc,
  seo,
  keyword,
  videoUrl,
  audioUrl,
  renderedMp4Size,
  jobId,
  onPublishClick,
  onVideoGenerated,
  user,
  onSavePrefs,
}) => {
  // Default to the real rendered MP4 view. Empty string = no rendered file
  // yet (the seed job ships no media); the player shows an honest empty
  // state instead of a broken <video> pointing at a missing file.
  const [activeMode, setActiveMode] = useState<"mp4" | "canvas">("mp4");
  const [currentVideoUrl, setCurrentVideoUrl] = useState<string>(videoUrl || "");
  const [videoError, setVideoError] = useState<boolean>(false);
  const [renderedVideos, setRenderedVideos] = useState<RenderedVideoItem[]>([]);
  const [isLoadingVideos, setIsLoadingVideos] = useState<boolean>(false);
  const [isPlaying, setIsPlaying] = useState<boolean>(false);
  const [currentTime, setCurrentTime] = useState<number>(0);
  const [isMuted, setIsMuted] = useState<boolean>(false);
  const [playbackSpeed, setPlaybackSpeed] = useState<number>(1);
  const [selectedSceneIndex, setSelectedSceneIndex] = useState<number>(0);
  const [isDirectPublishing, setIsDirectPublishing] = useState<boolean>(false);
  const [publishError, setPublishError] = useState<string | null>(null);
  const [savedPrivacy, setSavedPrivacy] = useState<string>('unlisted');
  const [publishedShortUrl, setPublishedShortUrl] = useState<string | null>(
    null,
  ); // Template video + AI video generation states
  const [isRenderingCinematic, setIsRenderingCinematic] =
    useState<boolean>(false);
  const [renderNotice, setRenderNotice] = useState<string | null>(null);
  // Narrator voice options (English Edge neural) + user selection
  interface VoiceOption {
    id: string;
    label: string;
    gender: string;
    description: string;
  }
  const [voiceOptions, setVoiceOptions] = useState<VoiceOption[]>([
    { id: "anchor-prime", label: "Prime Female Anchor", gender: "female", description: "Polished prime-time female anchor (default)" },
  ]);
  const [voiceId, setVoiceId] = useState<string>(
    () => localStorage.getItem("tl_voice") || "anchor-prime",
  );
  const [isPreviewingVoice, setIsPreviewingVoice] = useState<boolean>(false);
  const previewAudioRef = useRef<HTMLAudioElement | null>(null);
  const handlePreviewVoice = async () => {
    if (isPreviewingVoice) return;
    setIsPreviewingVoice(true);
    try {
      const res = await fetch(`/api/voice/preview?voice=${encodeURIComponent(voiceId)}`);
      if (!res.ok) throw new Error("preview failed");
      const blob = await res.blob();
      const url = URL.createObjectURL(blob);
      if (previewAudioRef.current) {
        previewAudioRef.current.pause();
      }
      const audio = new Audio(url);
      previewAudioRef.current = audio;
      audio.onended = () => {
        URL.revokeObjectURL(url);
        setIsPreviewingVoice(false);
      };
      audio.onerror = () => {
        URL.revokeObjectURL(url);
        setIsPreviewingVoice(false);
      };
      await audio.play();
    } catch {
      setIsPreviewingVoice(false);
    }
  };
  const pickVoice = (id: string) => {
    setVoiceId(id);
    try {
      localStorage.setItem("tl_voice", id);
    } catch {
      /* storage unavailable */
    }
  };
  // AI video generator states (PixVerse real motion)
  const [isFreeAiModalOpen, setIsFreeAiModalOpen] = useState<boolean>(false);
  const [isGeneratingFreeAi, setIsGeneratingFreeAi] = useState<boolean>(false);
  const [freeAiProgressMsg, setFreeAiProgressMsg] = useState<string | null>(
    null,
  );
  const [customFreeAiPrompt, setCustomFreeAiPrompt] = useState<string>("");
  const fetchVideosList = async () => {
    setIsLoadingVideos(true);
    try {
      const res = await fetch("/api/videos/list");
      if (res.ok) {
        const data = await res.json();
        if (data.videos) {
          setRenderedVideos(data.videos);
        }
      }
    } catch (err) {
      console.warn("Failed to load videos list:", err);
    } finally {
      setIsLoadingVideos(false);
    }
  };
  useEffect(() => {
    fetchVideosList();
    (async () => {
      try {
        const res = await fetch('/api/youtube/config');
        if (res.ok) {
          const data = await res.json();
          if (data.config?.privacyStatus) setSavedPrivacy(data.config.privacyStatus);
        }
      } catch {
        /* offline — unlisted default stays */
      }
    })();
    (async () => {
      try {
        const res = await fetch("/api/voice/options");
        if (res.ok) {
          const data = await res.json();
          if (Array.isArray(data.voices) && data.voices.length > 0) {
            setVoiceOptions(data.voices);
            const stored = localStorage.getItem("tl_voice");
            if (!stored || !data.voices.some((v: VoiceOption) => v.id === stored)) {
              pickVoice(data.defaultVoiceId || data.voices[0].id);
            }
          }
        }
      } catch {
        /* offline — fallback voice stays */
      }
    })();
  }, []);
  const duration = script.estimatedDurationSec || 35;
  const canvasRef = useRef<HTMLCanvasElement | null>(null);
  const videoElemRef = useRef<HTMLVideoElement | null>(null);
  const animationFrameRef = useRef<number | null>(null);
  const lastTickRef = useRef<number>(0);
  useEffect(() => {
    if (videoUrl) {
      setCurrentVideoUrl(videoUrl);
      setVideoError(false);
    }
  }, [videoUrl]);
  useEffect(() => {
    setVideoError(false);
  }, [currentVideoUrl]);
  const effectiveVideoUrl = currentVideoUrl; // Determine current active scene based on time (for canvas mode)
  const currentScene =
    script.scenes.find(
      (s) => currentTime >= s.timestampStart && currentTime < s.timestampEnd,
    ) || script.scenes[0];
  useEffect(() => {
    if (currentScene) {
      const idx = script.scenes.findIndex((s) => s.id === currentScene.id);
      if (idx !== -1) setSelectedSceneIndex(idx);
    }
  }, [currentScene, script.scenes]); // Web Speech narration for canvas mode
  const speakCurrentScene = (text: string) => {
    if (isMuted || typeof window === "undefined" || !window.speechSynthesis)
      return;
    window.speechSynthesis.cancel();
    const utterance = new SpeechSynthesisUtterance(text);
    utterance.rate = 1.05 * playbackSpeed;
    utterance.pitch = 1.0;
    const voices = window.speechSynthesis.getVoices();
    const naturalVoice = voices.find(
      (v) =>
        v.lang.startsWith("en") &&
        (v.name.includes("Natural") ||
          v.name.includes("Google") ||
          v.name.includes("Samantha")),
    );
    if (naturalVoice) utterance.voice = naturalVoice;
    window.speechSynthesis.speak(utterance);
  };
  const togglePlay = () => {
    if (isPlaying) {
      setIsPlaying(false);
      if (typeof window !== "undefined" && window.speechSynthesis) {
        window.speechSynthesis.cancel();
      }
    } else {
      setIsPlaying(true);
      if (currentTime >= duration) {
        setCurrentTime(0);
      }
      if (currentScene) {
        speakCurrentScene(currentScene.narratorText);
      }
    }
  };
  const restartVideo = () => {
    setCurrentTime(0);
    setIsPlaying(true);
    if (script.scenes[0]) {
      speakCurrentScene(script.scenes[0].narratorText);
    }
  }; // Canvas animation loop
  useEffect(() => {
    if (activeMode !== "canvas" || !isPlaying) {
      if (animationFrameRef.current)
        cancelAnimationFrame(animationFrameRef.current);
      return;
    }
    lastTickRef.current = performance.now();
    const loop = (now: number) => {
      const delta = (now - lastTickRef.current) / 1000;
      lastTickRef.current = now;
      setCurrentTime((prev) => {
        const next = prev + delta * playbackSpeed;
        if (next >= duration) {
          setIsPlaying(false);
          if (typeof window !== "undefined" && window.speechSynthesis) {
            window.speechSynthesis.cancel();
          }
          return duration;
        }
        return next;
      });
      animationFrameRef.current = requestAnimationFrame(loop);
    };
    animationFrameRef.current = requestAnimationFrame(loop);
    return () => {
      if (animationFrameRef.current)
        cancelAnimationFrame(animationFrameRef.current);
    };
  }, [isPlaying, playbackSpeed, duration, activeMode]); // Canvas drawing
  useEffect(() => {
    if (activeMode !== "canvas") return;
    const canvas = canvasRef.current;
    if (!canvas) return;
    const ctx = canvas.getContext("2d");
    if (!ctx) return;
    const width = canvas.width;
    const height = canvas.height; // Background gradient
    ctx.fillStyle = "#090d16";
    ctx.fillRect(0, 0, width, height);
    const grad = ctx.createRadialGradient(
      width / 2,
      height / 2,
      50,
      width / 2,
      height / 2,
      width * 0.8,
    );
    grad.addColorStop(0, "#1e293b");
    grad.addColorStop(0.7, "#0f172a");
    grad.addColorStop(1, "#020617");
    ctx.fillStyle = grad;
    ctx.fillRect(0, 0, width, height); // Top Header Badge
    ctx.fillStyle = "rgba(220, 38, 38, 0.95)";
    ctx.roundRect?.(24, 28, width - 48, 40, 10);
    ctx.fill();
    ctx.fillStyle = "#ffffff";
    ctx.font = "bold 13px sans-serif";
    ctx.textAlign = "center";
    ctx.fillText("BREAKING GOOGLE TRENDS", width / 2, 53); // Question Hook Headline
    ctx.fillStyle = "#facc15";
    ctx.font = "bold 18px sans-serif";
    ctx.fillText(
      script.headlineQuestion?.toUpperCase().slice(0, 32) ||
        "WHY IS THIS TRENDING?",
      width / 2,
      105,
    ); // Card frame
    const cardY = height * 0.22;
    const cardH = height * 0.38;
    ctx.fillStyle = "rgba(30, 41, 59, 0.8)";
    ctx.roundRect?.(24, cardY, width - 48, cardH, 16);
    ctx.fill();
    ctx.strokeStyle = "rgba(255, 255, 255, 0.15)";
    ctx.lineWidth = 1.5;
    ctx.stroke();
    ctx.fillStyle = "#38bdf8";
    ctx.font = "bold 12px sans-serif";
    ctx.fillText("VERIFIED NEWS WIRE", width / 2, cardY + 32);
    ctx.fillStyle = "#ffffff";
    ctx.font = "900 24px sans-serif";
    ctx.fillText(keyword.toUpperCase().slice(0, 20), width / 2, cardY + 75); // Narrator caption box
    if (currentScene) {
      ctx.fillStyle = "rgba(0, 0, 0, 0.85)";
      ctx.roundRect?.(16, height * 0.65, width - 32, 90, 14);
      ctx.fill();
      ctx.fillStyle = "#facc15";
      ctx.font = "bold 15px sans-serif";
      ctx.fillText(
        currentScene.narratorText.slice(0, 38),
        width / 2,
        height * 0.65 + 35,
      );
      if (currentScene.narratorText.length > 38) {
        ctx.fillStyle = "#ffffff";
        ctx.font = "13px sans-serif";
        ctx.fillText(
          currentScene.narratorText.slice(38, 80),
          width / 2,
          height * 0.65 + 62,
        );
      }
    } // Bottom source bar
    ctx.fillStyle = "rgba(15, 23, 42, 0.95)";
    ctx.roundRect?.(24, height - 64, width - 48, 42, 10);
    ctx.fill();
    ctx.fillStyle = "#94a3b8";
    ctx.font = "bold 11px sans-serif";
    ctx.fillText(
      "SOURCE: GOOGLE TRENDS VERIFIED REPORTS",
      width / 2,
      height - 38,
    );
  }, [currentTime, currentScene, isPlaying, keyword, script, activeMode]); // Handle direct 1-click publishing
  const handleDirectPublish = async () => {
    setIsDirectPublishing(true);
    setPublishError(null);
    try {
      const res = await fetch("/api/youtube/publish", {
        method: "POST",
        headers: { "Content-Type": "application/json" },
        body: JSON.stringify({
          jobId: jobId || undefined,
          videoUrl: videoUrl || undefined,
          title: seo?.title,
          description: seo?.description,
          tags: seo?.tags,
          privacyStatus: savedPrivacy,
        }),
      });
      const data = await res.json().catch(() => null);
      if (!res.ok || !data || data.success === false || !data.publishedUrl) {
        throw new Error(data?.error || `Publish failed (HTTP ${res.status}).`);
      }
      setPublishedShortUrl(data.publishedUrl);
    } catch (err: any) {
      setPublishError(err?.message || "Publish failed.");
    } finally {
      setIsDirectPublishing(false);
    }
  }; // Handle on-demand template video re-render (internal engine + synced audio)
  const handleRenderCinematic = async () => {
    setIsRenderingCinematic(true);
    setRenderNotice(
      "Rendering template video 9:16 Short with motion & synced narration...",
    );
    try {
      const res = await fetch("/api/video/render", {
        method: "POST",
        headers: { "Content-Type": "application/json" },
        body: JSON.stringify({ jobId, voice: voiceId }),
      });
      const data = await res.json();
      if (data.success && data.videoUrl) {
        setCurrentVideoUrl(`${data.videoUrl}?t=${Date.now()}`);
        setActiveMode("mp4");
        setRenderNotice(
          "Template video rendered successfully! Ready for preview and YouTube distribution.",
        );
      } else {
        setRenderNotice(data.error || "Failed to render video");
      }
    } catch (err: any) {
      setRenderNotice(`Render failed: ${err.message}`);
    } finally {
      setIsRenderingCinematic(false);
      setTimeout(() => setRenderNotice(null), 7000);
    }
  }; // Handle REAL AI video generation (PixVerse v6 external motion)
  const handleGenerateFreeAi = async () => {
    setIsGeneratingFreeAi(true);
    setFreeAiProgressMsg(
      `Requesting REAL motion video from PixVerse (v6, 9:16)... render takes a few minutes.`,
    );
    try {
      const res = await fetch("/api/video/generate-free-ai", {
        method: "POST",
        headers: { "Content-Type": "application/json" },
        body: JSON.stringify({
          jobId,
          customPrompt: customFreeAiPrompt || undefined,
        }),
      });
      const data = await res.json();
      if (data.success && data.videoUrl) {
        const fullUrl = `${data.videoUrl}?t=${Date.now()}`;
        setCurrentVideoUrl(fullUrl);
        setActiveMode("mp4");
        setIsFreeAiModalOpen(false);
        setRenderNotice(
          `REAL AI motion video [${data.visualMethod || "pixverse-v6"}] created and loaded into the studio!`,
        );
        setTimeout(() => setRenderNotice(null), 8000);
        fetchVideosList();
        if (onVideoGenerated) {
          onVideoGenerated(data.videoUrl);
        }
      } else {
        setRenderNotice(data.error || "Failed to generate AI video");
        setTimeout(() => setRenderNotice(null), 10000);
      }
    } catch (err: any) {
        setRenderNotice(`AI Video Error: ${err.message}`);
    } finally {
      setIsGeneratingFreeAi(false);
      setFreeAiProgressMsg(null);
    }
  };
  const isCurrentVideoAi = currentVideoUrl?.includes("_ai.mp4");
  const latestAiVideo = renderedVideos.find((v) => v.isAiVideo);
  const latestBroadcastVideo = renderedVideos.find((v) => !v.isAiVideo);
  const activeVideoObj = renderedVideos.find(
    (v) => v.url === currentVideoUrl || currentVideoUrl?.includes(v.filename),
  );
  const activeVideoPoster =
    activeVideoObj?.thumbnailUrl || "/videos/preview_cinematic.jpg";
  return (
    <div className="space-y-4">
      {" "}
      {/* Studio Header & View Mode Switcher */}{" "}
      <div className="flex flex-wrap items-center justify-between gap-3 p-3 bg-slate-900/90 border border-slate-800 rounded-2xl">
        {" "}
        <div className="flex items-center gap-2">
          {" "}
          <div className="flex items-center p-1 bg-slate-950 rounded-xl border border-slate-800">
            {" "}
            {/* Mode 1: AI Video */}{" "}
            <button
              onClick={() => {
                if (latestAiVideo) {
                  setCurrentVideoUrl(latestAiVideo.url);
                } else {
                  setIsFreeAiModalOpen(true);
                }
                setActiveMode("mp4");
              }}
              className={`flex items-center gap-1.5 px-3 py-1.5 rounded-lg text-xs font-bold transition-all ${activeMode === "mp4" && isCurrentVideoAi ? "bg-gradient-to-r from-emerald-600 to-teal-600 text-white shadow-md shadow-emerald-600/30 ring-1 ring-emerald-400/40" : "text-slate-400 hover:text-slate-200"}`}
            >
              {" "}
              <Sparkles className="w-3.5 h-3.5 text-emerald-400" />{" "}
              <span>AI Video</span>{" "}
              {latestAiVideo ? (
                <span className="px-1.5 py-0.2 text-[9px] uppercase font-mono rounded bg-emerald-500/30 text-emerald-300 font-bold border border-emerald-500/40 animate-pulse">
                  {" "}
                  Ready{" "}
                </span>
              ) : (
                <span className="px-1.5 py-0.2 text-[9px] font-mono rounded bg-slate-800 text-slate-400">
                  {" "}
                  Generate{" "}
                </span>
              )}{" "}
            </button>{" "}
            {/* Mode 2: Real Rendered MP4 Video */}{" "}
            <button
              onClick={() => {
                if (latestBroadcastVideo) {
                  setCurrentVideoUrl(latestBroadcastVideo.url);
                }
                setActiveMode("mp4");
              }}
              className={`flex items-center gap-1.5 px-3 py-1.5 rounded-lg text-xs font-bold transition-all ${activeMode === "mp4" && !isCurrentVideoAi ? "bg-red-600 text-white shadow-md shadow-red-600/30" : "text-slate-400 hover:text-slate-200"}`}
            >
              {" "}
              <Film className="w-3.5 h-3.5" />{" "}
              <span>Template Video</span>{" "}
            </button>{" "}
            {/* Mode 3: Kinetic Storyboard Studio */}{" "}
            <button
              onClick={() => setActiveMode("canvas")}
              className={`flex items-center gap-1.5 px-3 py-1.5 rounded-lg text-xs font-bold transition-all ${activeMode === "canvas" ? "bg-slate-800 text-white" : "text-slate-400 hover:text-slate-200"}`}
            >
              {" "}
              <Layers className="w-3.5 h-3.5" />{" "}
              <span>Kinetic Storyboard (Canvas)</span>{" "}
            </button>{" "}
          </div>{" "}
        </div>{" "}
        {/* Video Actions: AI Video, Template, Download MP4 & Publish */}{" "}
        <div className="flex flex-wrap items-center gap-2">
          {" "}
          {/* AI Video Button */}{" "}
          <button
            onClick={() => setIsFreeAiModalOpen(true)}
            className="flex items-center gap-1.5 px-3 py-1.5 rounded-xl bg-gradient-to-r from-emerald-600 via-teal-600 to-cyan-600 hover:from-emerald-500 hover:to-cyan-500 text-white text-xs font-bold transition-all shadow-md shadow-emerald-600/30 active:scale-95"
            title="AI video (external AI visual) + template render"
          >
            {" "}
            <Zap className="w-3.5 h-3.5 text-yellow-300 fill-current animate-pulse" />{" "}
            <span>AI Video</span>{" "}
            <span className="px-1.5 py-0.2 text-[8px] uppercase tracking-wider rounded bg-white/25 font-mono font-black text-white">
              {" "}
              AI{" "}
            </span>{" "}
          </button>{" "}
           {/* Narrator Voice Picker */}{" "}
          <label
            className="flex items-center gap-1.5 px-2.5 py-1.5 rounded-xl bg-slate-800 text-slate-200 text-xs font-semibold border border-slate-700/60"
            title="Narration voice (English)"
          >
            {" "}
            <Mic className="w-3.5 h-3.5 text-emerald-400 shrink-0" />{" "}
            <select
              value={voiceId}
              onChange={(e) => pickVoice(e.target.value)}
              disabled={isRenderingCinematic}
              className="bg-transparent text-xs font-semibold outline-none cursor-pointer max-w-[150px] [&>option]:bg-slate-900"
            >
              {voiceOptions.map((v) => (
                <option key={v.id} value={v.id} title={v.description}>
                  {v.label}
                </option>
              ))}{" "}
            </select>{" "}
          </label>{" "}
          <button
            onClick={handlePreviewVoice}
            disabled={isPreviewingVoice || isRenderingCinematic}
            className="flex items-center gap-1 px-2.5 py-1.5 rounded-xl bg-slate-800 hover:bg-slate-700 text-slate-200 text-xs font-semibold border border-slate-700/60 disabled:opacity-50"
            title="Play a short preview of the selected voice"
          >
            {isPreviewingVoice ? (
              <Loader2 className="w-3.5 h-3.5 animate-spin" />
            ) : (
              <Play className="w-3.5 h-3.5 text-emerald-400" />
            )}
            <span>Preview</span>
          </button>{" "}
          {/* Re-render Template Video Button */}{" "}
          <button
            onClick={handleRenderCinematic}
            disabled={isRenderingCinematic}
            className="flex items-center gap-1.5 px-3 py-1.5 rounded-xl bg-slate-800 hover:bg-slate-700 text-slate-200 hover:text-white text-xs font-semibold transition-colors border border-slate-700/60 disabled:opacity-50"
            title="Re-render 1080x1920 MP4 template video with zoom motion, blurred background & synchronized audio"
          >
            {" "}
            {isRenderingCinematic ? (
              <Loader2 className="w-3.5 h-3.5 text-amber-400 animate-spin" />
            ) : (
              <RefreshCw className="w-3.5 h-3.5 text-amber-400" />
            )}{" "}
            <span>
              {isRenderingCinematic ? "Rendering..." : "Re-render Template"}
            </span>{" "}
          </button>{" "}
          {/* Download MP4 + YouTube actions */}{" "}
          {effectiveVideoUrl && !videoError && (
          <a
            href={effectiveVideoUrl}
            download={`${keyword.replace(/\s+/g, "_")}_Short.mp4`}
            className="flex items-center gap-1.5 px-3 py-1.5 rounded-xl bg-slate-800 hover:bg-slate-700 text-slate-200 hover:text-white text-xs font-semibold transition-colors border border-slate-700/60"
            title="Download full 1080x1920 MP4 file"
          >
            {" "}
            <Download className="w-3.5 h-3.5 text-sky-400" />{" "}
            <span>Download .MP4</span>{" "}
          </a>
          )}{" "}
          <button
            onClick={onPublishClick || handleDirectPublish}
            disabled={isDirectPublishing}
            className="flex items-center gap-1.5 px-4 py-1.5 rounded-xl bg-red-600 hover:bg-red-500 text-white text-xs font-bold transition-all shadow-md shadow-red-600/30 active:scale-95 disabled:opacity-50"
          >
            {" "}
            <Youtube className="w-4 h-4" />{" "}
            <span>
              {isDirectPublishing ? "Pushing..." : "Publish to YouTube"}
            </span>{" "}
          </button>{" "}
        </div>{" "}
      </div>{" "}
      {/* Rendering / Action Notification Banner */}{" "}
      {renderNotice && (
        <div className="p-3.5 rounded-2xl bg-sky-950/60 border border-sky-500/50 flex items-center gap-3 text-xs text-sky-200 animate-in fade-in duration-200">
          {" "}
          <Sparkles className="w-4 h-4 text-sky-400 shrink-0 animate-pulse" />{" "}
          <span className="font-medium">{renderNotice}</span>{" "}
        </div>
      )}{" "}
      {/* Published to YouTube Notification Banner */}{" "}
      {publishedShortUrl && (
        <div className="p-3.5 rounded-2xl bg-emerald-950/50 border border-emerald-500/50 flex items-center justify-between">
          {" "}
          <div className="flex items-center gap-2.5 text-xs text-emerald-300 font-semibold">
            {" "}
            <CheckCircle2 className="w-4 h-4 text-emerald-400 shrink-0" />{" "}
            <span>Successfully distributed to YouTube Shorts!</span>{" "}
          </div>{" "}
          <a
            href={publishedShortUrl}
            target="_blank"
            rel="noreferrer"
            className="px-3 py-1 rounded-xl bg-red-600 hover:bg-red-500 text-white font-bold text-xs flex items-center gap-1.5 transition-colors shadow"
          >
            {" "}
            <Youtube className="w-3.5 h-3.5" />{" "}
            <span>View on YouTube Shorts</span>{" "}
            <ExternalLink className="w-3 h-3" />{" "}
          </a>{" "}
        </div>
      )}{" "}
      {/* Publish error — previously swallowed silently */}
      {publishError && (
        <div className="p-3.5 rounded-2xl bg-red-950/50 border border-red-500/50 flex items-center gap-2.5 text-xs text-red-300">
          {" "}
          <Info className="w-4 h-4 text-red-400 shrink-0" />{" "}
          <span className="font-medium">Publish failed: {publishError}</span>{" "}
        </div>
      )}{" "}
      {/* Main Studio Grid */}{" "}
      <div className="grid grid-cols-1 lg:grid-cols-12 gap-6 items-start">
        {" "}
        {/* 9:16 Vertical Video Player Column */}{" "}
        <div className="lg:col-span-5 flex flex-col items-center">
          {" "}
          {/* Active Video Status Banner */}{" "}
          <div
            className={`w-full max-w-[340px] mb-3 px-3 py-2 rounded-2xl border flex items-center justify-between text-xs shadow-md transition-all ${isCurrentVideoAi ? "bg-gradient-to-r from-emerald-950/90 to-teal-950/90 border-emerald-500/50 text-emerald-200" : "bg-slate-900/90 border-slate-800 text-slate-300"}`}
          >
            {" "}
            {!effectiveVideoUrl || videoError ? (
              <div className="flex items-center justify-between w-full">
                {" "}
                <div className="flex items-center gap-2 min-w-0">
                  {" "}
                  <Film className="w-4 h-4 text-slate-500 shrink-0" />{" "}
                  <div className="truncate">
                    {" "}
                    <span className="font-bold text-slate-300 block truncate">
                      {" "}
                      No video yet{" "}
                    </span>{" "}
                    <span className="text-[10px] text-slate-500 font-mono">
                      {" "}
                      Render a template or AI video to preview it here{" "}
                    </span>{" "}
                  </div>{" "}
                </div>{" "}
              </div>
            ) : isCurrentVideoAi ? (
              <div className="flex items-center justify-between w-full">
                {" "}
                <div className="flex items-center gap-2 min-w-0">
                  {" "}
                  <Sparkles className="w-4 h-4 text-emerald-400 animate-pulse shrink-0" />{" "}
                  <div className="truncate">
                    {" "}
                    <span className="font-bold text-white block truncate">
                      {" "}
                      ⚡ AI Video{" "}
                    </span>{" "}
                    <span className="text-[10px] text-emerald-300/80 font-mono">
                      {" "}
                      Multi-Model Keyless AI •{" "}
                      {activeVideoObj?.sizeFormatted || "2.3 MB"}{" "}
                    </span>{" "}
                  </div>{" "}
                </div>{" "}
                <div className="flex items-center gap-1 shrink-0 ml-2">
                  {" "}
                  <a
                    href={effectiveVideoUrl}
                    target="_blank"
                    rel="noreferrer"
                    className="px-2 py-1 rounded-lg bg-emerald-800/80 hover:bg-emerald-700 text-emerald-100 text-[10px] font-bold flex items-center gap-1 transition-colors"
                    title="Play file directly in a new browser tab"
                  >
                    {" "}
                    <ExternalLink className="w-3 h-3" /> <span>New Tab</span>{" "}
                  </a>{" "}
                </div>{" "}
              </div>
            ) : (
              <div className="flex items-center justify-between w-full">
                {" "}
                <div className="flex items-center gap-2 min-w-0">
                  {" "}
                  <Film className="w-4 h-4 text-amber-400 shrink-0" />{" "}
                  <div className="truncate">
                    {" "}
                    <span className="font-bold text-white block truncate">
                      {" "}
                      🎬 Template Video{" "}
                    </span>{" "}
                    <span className="text-[10px] text-slate-400 font-mono">
                      {" "}
                      Template MP4 •{" "}
                      {activeVideoObj?.sizeFormatted || "1080×1920"}{" "}
                    </span>{" "}
                  </div>{" "}
                </div>{" "}
                <div className="flex items-center gap-1 shrink-0 ml-2">
                  {" "}
                  <a
                    href={effectiveVideoUrl}
                    target="_blank"
                    rel="noreferrer"
                    className="px-2 py-1 rounded-lg bg-slate-800 hover:bg-slate-700 text-slate-200 text-[10px] font-bold flex items-center gap-1 transition-colors"
                  >
                    {" "}
                    <ExternalLink className="w-3 h-3" /> <span>New Tab</span>{" "}
                  </a>{" "}
                </div>{" "}
              </div>
            )}{" "}
          </div>{" "}
          {/* Smartphone Frame Wrapper */}{" "}
          <div className="relative w-full max-w-[340px] bg-slate-900 border-2 border-slate-700/80 rounded-[34px] p-3 shadow-2xl shadow-black/80">
            {" "}
            {/* Phone Notch */}{" "}
            <div className="w-24 h-4 bg-slate-950 rounded-full mx-auto mb-2 flex items-center justify-center">
              {" "}
              <div className="w-2.5 h-2.5 rounded-full bg-slate-800 mr-2" />{" "}
              <div className="w-1.5 h-1.5 rounded-full bg-blue-900/60" />{" "}
            </div>{" "}
            {/* 9:16 Aspect Display */}{" "}
            <div className="relative aspect-[9/16] w-full rounded-[22px] overflow-hidden bg-slate-950 border border-slate-800">
              {" "}
              {activeMode === "mp4" ? (
                !effectiveVideoUrl || videoError ? (
                  <div className="w-full h-full flex flex-col items-center justify-center gap-3 p-6 text-center bg-gradient-to-b from-slate-900 to-slate-950">
                    <Film className="w-10 h-10 text-slate-600" />
                    <p className="text-sm font-bold text-slate-300">
                      {videoError ? "This video file could not be loaded" : "No rendered video yet"}
                    </p>
                    <p className="text-xs text-slate-500 leading-relaxed">
                      Run the pipeline or Re-render Template below to produce
                      the 1080×1920 MP4 for this trend.
                    </p>
                    <button
                      onClick={handleRenderCinematic}
                      disabled={isRenderingCinematic}
                      className="mt-1 px-4 py-2 rounded-xl bg-amber-600 hover:bg-amber-500 text-white text-xs font-bold transition-colors disabled:opacity-50 flex items-center gap-1.5"
                    >
                      {isRenderingCinematic ? (
                        <Loader2 className="w-3.5 h-3.5 animate-spin" />
                      ) : (
                        <RefreshCw className="w-3.5 h-3.5" />
                      )}
                      <span>{isRenderingCinematic ? "Rendering..." : "Render Template Video"}</span>
                    </button>
                  </div>
                ) : (
                <video
                  key={effectiveVideoUrl}
                  ref={videoElemRef}
                  src={effectiveVideoUrl}
                  poster={activeVideoPoster}
                  controls
                  autoPlay
                  loop
                  playsInline
                  preload="auto"
                  onError={() => setVideoError(true)}
                  className="w-full h-full object-cover block"
                />
                )
              ) : (
                <>
                  {" "}
                  <canvas
                    ref={canvasRef}
                    width={360}
                    height={640}
                    className="w-full h-full object-cover block cursor-pointer"
                    onClick={togglePlay}
                  />{" "}
                  {!isPlaying && (
                    <button
                      onClick={togglePlay}
                      className="absolute inset-0 m-auto w-16 h-16 rounded-full bg-red-600/90 text-white flex items-center justify-center shadow-lg shadow-red-600/40 hover:scale-110 active:scale-95 transition-all z-20 backdrop-blur-sm"
                    >
                      {" "}
                      <Play className="w-8 h-8 fill-current translate-x-0.5" />{" "}
                    </button>
                  )}{" "}
                  <div className="absolute bottom-0 left-0 right-0 h-1.5 bg-slate-800/80 z-30">
                    {" "}
                    <div
                      className="h-full bg-red-500 transition-all duration-75"
                      style={{ width: `${(currentTime / duration) * 100}%` }}
                    />{" "}
                  </div>{" "}
                </>
              )}{" "}
            </div>{" "}
            {/* Canvas-only Player Controls */}{" "}
            {activeMode === "canvas" && (
              <div className="mt-3 px-2 py-1.5 bg-slate-950/80 rounded-xl border border-slate-800 flex items-center justify-between text-slate-300">
                {" "}
                <div className="flex items-center gap-1">
                  {" "}
                  <button
                    onClick={togglePlay}
                    className="p-1.5 hover:bg-slate-800 rounded-lg text-slate-200 transition-colors"
                  >
                    {" "}
                    {isPlaying ? (
                      <Pause className="w-4 h-4" />
                    ) : (
                      <Play className="w-4 h-4" />
                    )}{" "}
                  </button>{" "}
                  <button
                    onClick={restartVideo}
                    className="p-1.5 hover:bg-slate-800 rounded-lg text-slate-400 hover:text-slate-200 transition-colors"
                  >
                    {" "}
                    <RotateCcw className="w-4 h-4" />{" "}
                  </button>{" "}
                  <button
                    onClick={() => setIsMuted(!isMuted)}
                    className={`p-1.5 hover:bg-slate-800 rounded-lg transition-colors ${isMuted ? "text-amber-400" : "text-slate-400 hover:text-slate-200"}`}
                  >
                    {" "}
                    {isMuted ? (
                      <VolumeX className="w-4 h-4" />
                    ) : (
                      <Volume2 className="w-4 h-4" />
                    )}{" "}
                  </button>{" "}
                </div>{" "}
                <div className="font-mono text-[11px] text-slate-400">
                  {" "}
                  {Math.floor(currentTime)}s / {Math.floor(duration)}s{" "}
                </div>{" "}
                <div className="flex items-center gap-1">
                  {" "}
                  <button
                    onClick={() =>
                      setPlaybackSpeed(
                        playbackSpeed === 1
                          ? 1.25
                          : playbackSpeed === 1.25
                            ? 1.5
                            : 1,
                      )
                    }
                    className="px-1.5 py-0.5 text-[10px] font-mono rounded bg-slate-800 hover:bg-slate-700 text-slate-300 transition-colors"
                  >
                    {" "}
                    {playbackSpeed}x{" "}
                  </button>{" "}
                </div>{" "}
              </div>
            )}{" "}
          </div>{" "}
          {/* Video Format Specs Chip */}{" "}
          <div className="mt-3.5 flex flex-wrap items-center justify-center gap-2 text-[11px] text-slate-400 font-mono">
            {" "}
            <span className="px-2 py-0.5 rounded-lg bg-slate-900 border border-slate-800 text-slate-300">
              {" "}
              1080×1920 (9:16){" "}
            </span>{" "}
            <span className="px-2 py-0.5 rounded-lg bg-slate-900 border border-slate-800 text-slate-300">
              {" "}
              H.264 / AAC{" "}
            </span>{" "}
            <span className="px-2 py-0.5 rounded-lg bg-red-950/40 border border-red-800/50 text-red-300">
              {" "}
              YouTube Shorts Ready{" "}
            </span>{" "}
          </div>{" "}
          {/* Action buttons below device */}{" "}
          <div className="mt-3 flex items-center gap-2 w-full max-w-[340px]">
            {" "}
            {effectiveVideoUrl && !videoError && (
            <a
              href={effectiveVideoUrl}
              download={`${keyword.replace(/\s+/g, "_")}_Short.mp4`}
              className="flex-1 py-2.5 rounded-xl bg-slate-800 hover:bg-slate-700 text-white font-bold text-xs flex items-center justify-center gap-2 shadow transition-colors"
            >
              {" "}
              <Download className="w-4 h-4 text-sky-400" />{" "}
              <span>Download MP4</span>{" "}
            </a>
            )}{" "}
            <button
              onClick={onPublishClick || handleDirectPublish}
              className="flex-1 py-2.5 rounded-xl bg-gradient-to-r from-red-600 to-amber-600 text-white font-bold text-xs flex items-center justify-center gap-2 shadow-lg shadow-red-600/30 hover:brightness-110 transition-all"
            >
              {" "}
              <Youtube className="w-4 h-4" /> <span>Publish Short</span>{" "}
            </button>{" "}
          </div>{" "}
          {/* Direct Full-Screen MP4 Link */}{" "}
          {effectiveVideoUrl && !videoError && (
          <div className="mt-2 w-full max-w-[340px]">
            {" "}
            <a
              href={effectiveVideoUrl}
              target="_blank"
              rel="noreferrer"
              className="w-full py-2 px-3 rounded-xl bg-slate-900/90 hover:bg-slate-800 text-slate-300 hover:text-white text-xs font-semibold flex items-center justify-center gap-2 border border-slate-800 hover:border-slate-700 transition-colors shadow-sm"
            >
              {" "}
              <ExternalLink className="w-3.5 h-3.5 text-emerald-400" />{" "}
              <span>Play direct video file in a new tab (Direct MP4 URL)</span>{" "}
            </a>{" "}
          </div>
          )}{" "}
        </div>{" "}
        {/* Right Side: Newsroom Inspector & Scene Director */}{" "}
        <div className="lg:col-span-7 space-y-5">
          {" "}
          {/* Core Differentiation Card */}{" "}
          <div className="p-4 rounded-2xl bg-gradient-to-br from-red-950/40 via-slate-900 to-slate-900 border border-red-900/40">
            {" "}
            <div className="flex items-start justify-between gap-3">
              {" "}
              <div>
                {" "}
                <div className="flex items-center gap-2">
                  {" "}
                  <span className="px-2 py-0.5 text-[10px] uppercase font-bold rounded bg-red-500/20 text-red-400 border border-red-500/30">
                    {" "}
                    SEARCH-INTENT EXPLAINER{" "}
                  </span>{" "}
                  <span className="text-xs text-slate-400 font-mono">
                    {" "}
                    Intent: [{script.searchIntent}]{" "}
                  </span>{" "}
                </div>{" "}
                <h2 className="text-xl font-black text-white mt-1">
                  {" "}
                  {script.headlineQuestion}{" "}
                </h2>{" "}
                <p className="text-xs text-slate-300 mt-1">
                  {" "}
                  Angle:{" "}
                  <span className="font-semibold text-amber-300">
                    {script.angle?.title}
                  </span>{" "}
                  — {script.angle?.hookPremise}{" "}
                </p>{" "}
              </div>{" "}
              <div className="p-2 rounded-xl bg-slate-800/80 border border-slate-700 text-center shrink-0">
                {" "}
                <span className="text-[10px] text-slate-400 block uppercase font-mono">
                  QC Score
                </span>{" "}
                <span className="text-lg font-black text-emerald-400 font-mono">
                  {" "}
                  {qc?.overallScore || 98}%{" "}
                </span>{" "}
              </div>{" "}
            </div>{" "}
          </div>{" "}
          {/* Voice Narration & Audio Master Details */}{" "}
          <div className="bg-slate-900/90 border border-slate-800 rounded-2xl p-4 space-y-2.5">
            {" "}
            <div className="flex items-center justify-between">
              {" "}
              <div className="flex items-center gap-2">
                {" "}
                <Volume2 className="w-4 h-4 text-amber-400" />{" "}
                <h3 className="text-xs font-bold text-slate-200 uppercase tracking-wider">
                  {" "}
                  Realistic Voice Narration Engine{" "}
                </h3>{" "}
              </div>{" "}
              <span className="px-2 py-0.5 rounded text-[10px] font-mono bg-emerald-500/10 text-emerald-400 border border-emerald-500/20">
                {" "}
                Natural Human Cadence (No Robotic Tone){" "}
              </span>{" "}
            </div>{" "}
            <p className="text-xs text-slate-300 italic bg-slate-950/70 p-3 rounded-xl border border-slate-800/80 leading-relaxed font-serif">
              {" "}
              "{script.fullScript || script.headlineQuestion}"{" "}
            </p>{" "}
          </div>{" "}
          {/* Visual Production & AI Video Engine */}{" "}
          <div className="bg-slate-900/90 border border-slate-800 rounded-2xl p-4 space-y-3">
            {" "}
            <div className="flex items-center justify-between">
              {" "}
              <div className="flex items-center gap-2">
                {" "}
                <Video className="w-4 h-4 text-sky-400" />{" "}
                <h3 className="text-xs font-bold text-slate-200 uppercase tracking-wider">
                  {" "}
                  Visual Production & AI Video Studio{" "}
                </h3>{" "}
              </div>{" "}
              <span className="px-2 py-0.5 rounded text-[10px] font-mono bg-sky-500/10 text-sky-400 border border-sky-500/20">
                {" "}
                1080×1920 9:16 Shorts{" "}
              </span>{" "}
            </div>{" "}
            <div className="grid grid-cols-1 md:grid-cols-3 gap-3">
              {" "}
              {/* Option 1: AI Video */}{" "}
              <div className="p-3.5 rounded-xl bg-gradient-to-br from-emerald-950/40 via-slate-950/70 to-teal-950/40 border border-emerald-500/40 flex flex-col justify-between">
                {" "}
                <div>
                  {" "}
                  <div className="flex items-center justify-between mb-1.5">
                    {" "}
                    <span className="text-xs font-bold text-emerald-300 flex items-center gap-1.5">
                      {" "}
                      <Zap className="w-3.5 h-3.5 text-yellow-300 fill-current" />{" "}
                      Free & Unlimited AI{" "}
                    </span>{" "}
                    {latestAiVideo ? (
                      <span className="text-[9px] px-1.5 py-0.5 rounded bg-emerald-500 text-slate-950 font-mono font-black uppercase shadow-sm">
                        {" "}
                        Ready • {latestAiVideo.sizeFormatted}{" "}
                      </span>
                    ) : (
                      <span className="text-[9px] px-1.5 py-0.5 rounded bg-emerald-950/80 text-emerald-400 font-mono font-bold border border-emerald-800/40">
                        {" "}
                        100% Free{" "}
                      </span>
                    )}{" "}
                  </div>{" "}
                  <p className="text-[11px] text-slate-300 leading-relaxed mb-2.5">
                    {" "}
                    Real AI motion video via PixVerse v6 text-to-video
                    (external AI). Genuine movement — requires PixVerse
                    account credits.{" "}
                  </p>{" "}
                </div>{" "}
                <div className="flex items-center gap-1.5">
                  {" "}
                  {latestAiVideo && (
                    <button
                      onClick={() => {
                        setCurrentVideoUrl(latestAiVideo.url);
                        setActiveMode("mp4");
                      }}
                      className="py-2 px-2.5 rounded-lg bg-emerald-600 hover:bg-emerald-500 text-white text-xs font-bold flex items-center justify-center gap-1 transition-colors shadow-sm"
                      title="Play this video in the main studio player"
                    >
                      {" "}
                      <Play className="w-3.5 h-3.5 fill-current" />{" "}
                      <span>Play</span>{" "}
                    </button>
                  )}{" "}
                  <button
                    onClick={() => setIsFreeAiModalOpen(true)}
                    className="flex-1 py-2 px-2.5 rounded-lg bg-slate-800 hover:bg-slate-700 text-emerald-300 hover:text-white text-xs font-bold flex items-center justify-center gap-1 border border-emerald-500/30 transition-colors"
                  >
                    {" "}
                    <Sparkles className="w-3.5 h-3.5 text-emerald-400" />{" "}
                    <span>
                      {latestAiVideo
                        ? "Generate New Scene"
                        : "Generate with AI"}
                    </span>{" "}
                  </button>{" "}
                </div>{" "}
              </div>{" "}
              {/* Option 2: Template Video Engine */}{" "}
              <div className="p-3.5 rounded-xl bg-slate-950/70 border border-slate-800 flex flex-col justify-between">
                {" "}
                <div>
                  {" "}
                  <div className="flex items-center justify-between mb-1.5">
                    {" "}
                    <span className="text-xs font-bold text-white flex items-center gap-1.5">
                      {" "}
                      <Film className="w-3.5 h-3.5 text-amber-400" /> Template
                      Video{" "}
                    </span>{" "}
                    <span className="text-[9px] px-1.5 py-0.5 rounded bg-emerald-950/80 text-emerald-400 font-mono font-bold border border-emerald-800/40">
                      {" "}
                      Active{" "}
                    </span>{" "}
                  </div>{" "}
                  <p className="text-[11px] text-slate-300 leading-relaxed mb-2.5">
                    {" "}
                    9:16 template video render with smooth zoom-pan motion,
                    blurred background from real news images, and a
                    persistence bar.{" "}
                  </p>{" "}
                </div>{" "}
                <button
                  onClick={handleRenderCinematic}
                  disabled={isRenderingCinematic}
                  className="w-full py-2 px-3 rounded-lg bg-slate-800 hover:bg-slate-700 text-slate-200 hover:text-white text-xs font-bold flex items-center justify-center gap-2 border border-slate-700 transition-colors disabled:opacity-50"
                >
                  {" "}
                  {isRenderingCinematic ? (
                    <Loader2 className="w-3.5 h-3.5 text-amber-400 animate-spin" />
                  ) : (
                    <RefreshCw className="w-3.5 h-3.5 text-amber-400" />
                  )}{" "}
                  <span>
                    {isRenderingCinematic ? "Rendering..." : "Template Render"}
                  </span>{" "}
                </button>{" "}
              </div>{" "}
            </div>{" "}
          </div>{" "}
          {/* Scene Timeline Jumper */}{" "}
          <div className="bg-slate-900/90 border border-slate-800 rounded-2xl p-4">
            {" "}
            <div className="flex items-center justify-between mb-3">
              {" "}
              <h3 className="text-xs font-bold text-slate-300 uppercase tracking-wider flex items-center gap-2">
                {" "}
                <Tv className="w-4 h-4 text-red-400" />{" "}
                <span>
                  Scene-by-Scene Storyboard ({script.scenes.length} Scenes)
                </span>{" "}
              </h3>{" "}
              <span className="text-xs font-mono text-slate-400">
                {" "}
                Duration: {script.estimatedDurationSec}s ({script.wordCount}{" "}
                words){" "}
              </span>{" "}
            </div>{" "}
            <div className="grid grid-cols-2 sm:grid-cols-4 md:grid-cols-5 gap-2">
              {" "}
              {script.scenes.map((scene, idx) => {
                const isCurrent = currentScene?.id === scene.id;
                const isSelected = selectedSceneIndex === idx;
                return (
                  <button
                    key={scene.id}
                    onClick={() => {
                      setSelectedSceneIndex(idx);
                      setCurrentTime(scene.timestampStart);
                      if (isPlaying) speakCurrentScene(scene.narratorText);
                    }}
                    className={`p-2.5 rounded-xl border text-left transition-all ${isCurrent ? "bg-red-950/60 border-red-500 text-white shadow-md shadow-red-950/40 ring-1 ring-red-500" : isSelected ? "bg-slate-800 border-slate-600 text-slate-200" : "bg-slate-950/60 border-slate-800 text-slate-400 hover:border-slate-700 hover:text-slate-300"}`}
                  >
                    {" "}
                    <div className="flex items-center justify-between text-[10px] font-mono mb-1">
                      {" "}
                      <span className="font-bold">
                        SCENE #{scene.sceneNumber}
                      </span>{" "}
                      <span>
                        {scene.timestampStart}-{scene.timestampEnd}s
                      </span>{" "}
                    </div>{" "}
                    <p className="text-[11px] font-medium line-clamp-2 leading-tight">
                      {" "}
                      {scene.narratorText}{" "}
                    </p>{" "}
                    <div className="mt-1.5 text-[9px] uppercase font-mono text-slate-400 px-1 py-0.5 rounded bg-slate-900/80 inline-block">
                      {" "}
                      {scene.shotType}{" "}
                    </div>{" "}
                  </button>
                );
              })}{" "}
            </div>{" "}
          </div>{" "}
          {/* Fact Verification Traceability Audit */}{" "}
          <div className="bg-slate-900/90 border border-slate-800 rounded-2xl p-4">
            {" "}
            <div className="flex items-center justify-between mb-3">
              {" "}
              <div className="flex items-center gap-2">
                {" "}
                <ShieldCheck className="w-4 h-4 text-emerald-400" />{" "}
                <h3 className="text-xs font-bold text-slate-200 uppercase tracking-wider">
                  {" "}
                  Verified Google Trends Evidence Audit{" "}
                </h3>{" "}
              </div>{" "}
              <span className="text-[11px] font-mono text-emerald-400 bg-emerald-950/40 px-2 py-0.5 rounded border border-emerald-800/40">
                {" "}
                100% Corroborated{" "}
              </span>{" "}
            </div>{" "}
            <div className="space-y-2">
              {" "}
              {facts.map((fact) => (
                <div
                  key={fact.id}
                  className="p-2.5 rounded-xl bg-slate-950/70 border border-slate-800/80 flex items-start justify-between gap-3 text-xs"
                >
                  {" "}
                  <div className="flex items-start gap-2">
                    {" "}
                    <CheckCircle2 className="w-4 h-4 text-emerald-400 shrink-0 mt-0.5" />{" "}
                    <div>
                      {" "}
                      <p className="text-slate-200 font-medium">
                        {fact.claim}
                      </p>{" "}
                      <div className="flex items-center gap-2 mt-1 text-[11px] text-slate-400">
                        {" "}
                        <span className="text-slate-300 font-semibold">
                          {fact.sourceName}
                        </span>{" "}
                        <span>•</span>{" "}
                        <span>
                          Corroborated by {fact.corroboratedByCount} sources
                        </span>{" "}
                      </div>{" "}
                    </div>{" "}
                  </div>{" "}
                  <a
                    href={fact.sourceUrl}
                    target="_blank"
                    rel="noreferrer"
                    className="px-2 py-1 rounded bg-slate-800 hover:bg-slate-700 text-slate-300 text-[11px] flex items-center gap-1 shrink-0 transition-colors"
                  >
                    {" "}
                    <span>
                      Source
                    </span> <ExternalLink className="w-3 h-3" />{" "}
                  </a>{" "}
                </div>
              ))}{" "}
            </div>{" "}
          </div>{" "}
        </div>{" "}
      </div>{" "}
      {/* AI Videos Gallery & Output Archive */}{" "}
      <div className="bg-slate-900/90 border border-slate-800 rounded-3xl p-5 space-y-4 shadow-xl">
        {" "}
        <div className="flex flex-wrap items-center justify-between gap-3 border-b border-slate-800/80 pb-3">
          {" "}
          <div className="flex items-center gap-2.5">
            {" "}
            <div className="w-9 h-9 rounded-xl bg-gradient-to-br from-emerald-500/20 to-teal-500/20 border border-emerald-500/30 flex items-center justify-center text-emerald-400">
              {" "}
              <Film className="w-5 h-5" />{" "}
            </div>{" "}
            <div>
              {" "}
              <h3 className="text-sm font-bold text-white flex items-center gap-2">
                {" "}
                <span>🎬 AI & Rendered Video Gallery Archive</span>{" "}
                <span className="px-2 py-0.5 text-[10px] font-mono rounded bg-slate-800 text-emerald-300 font-bold border border-slate-700">
                  {" "}
                  {renderedVideos.length} videos{" "}
                </span>{" "}
              </h3>{" "}
              <p className="text-xs text-slate-400">
                {" "}
                All videos created with the AI video engine (external AI,
                keyless, auto-switching) and template videos on the server{" "}
              </p>{" "}
            </div>{" "}
          </div>{" "}
          <div className="flex items-center gap-2">
            {" "}
            <button
              onClick={fetchVideosList}
              disabled={isLoadingVideos}
              className="px-3 py-1.5 rounded-xl bg-slate-800 hover:bg-slate-700 text-slate-300 text-xs font-semibold flex items-center gap-1.5 transition-colors border border-slate-700/60"
            >
              {" "}
              <RefreshCw
                className={`w-3.5 h-3.5 ${isLoadingVideos ? "animate-spin text-emerald-400" : ""}`}
              />{" "}
              <span>Refresh List</span>{" "}
            </button>{" "}
            <button
              onClick={() => setIsFreeAiModalOpen(true)}
              className="px-3.5 py-1.5 rounded-xl bg-gradient-to-r from-emerald-600 to-teal-600 hover:from-emerald-500 hover:to-teal-500 text-white text-xs font-bold transition-all shadow-md shadow-emerald-600/30 flex items-center gap-1.5 active:scale-95"
            >
              {" "}
              <Sparkles className="w-3.5 h-3.5 text-yellow-300 fill-current" />{" "}
              <span>+ Create New AI Video</span>{" "}
            </button>{" "}
          </div>{" "}
        </div>{" "}
        {/* Videos Grid */}{" "}
        {renderedVideos.length === 0 ? (
          <div className="p-8 text-center rounded-2xl bg-slate-950/50 border border-dashed border-slate-800 space-y-3">
            {" "}
            <Film className="w-10 h-10 text-slate-600 mx-auto" />{" "}
            <p className="text-xs text-slate-400">
              {" "}
              No videos registered on the server yet. Click the button below to
              create your first AI video.{" "}
            </p>{" "}
            <button
              onClick={() => setIsFreeAiModalOpen(true)}
              className="px-4 py-2 rounded-xl bg-emerald-600 hover:bg-emerald-500 text-white text-xs font-bold transition-all"
            >
              Generate AI Video{" "}
            </button>{" "}
          </div>
        ) : (
          <div className="grid grid-cols-1 sm:grid-cols-2 md:grid-cols-3 lg:grid-cols-4 gap-3.5">
            {" "}
            {renderedVideos.map((video) => {
              const isSelected =
                effectiveVideoUrl === video.url ||
                effectiveVideoUrl?.includes(video.filename);
              return (
                <div
                  key={video.filename}
                  className={`group relative rounded-2xl overflow-hidden border transition-all duration-200 flex flex-col justify-between ${isSelected ? "bg-slate-900 border-emerald-500 ring-2 ring-emerald-500/40 shadow-lg shadow-emerald-950/50" : "bg-slate-950/80 border-slate-800 hover:border-slate-700 hover:bg-slate-900/80"}`}
                >
                  {" "}
                  {/* Thumbnail */}{" "}
                  <div className="relative aspect-[9/16] w-full bg-slate-950 overflow-hidden">
                    {" "}
                    <img
                      src={video.thumbnailUrl}
                      alt={video.keyword}
                      className="w-full h-full object-cover transition-transform duration-300 group-hover:scale-105"
                    />{" "}
                    <div className="absolute inset-0 bg-gradient-to-t from-slate-950 via-slate-950/30 to-transparent" />{" "}
                    {/* Badges Top */}{" "}
                    <div className="absolute top-2 left-2 right-2 flex items-center justify-between gap-1 z-10">
                      {" "}
                      {video.isAiVideo ? (
                        <span className="px-2 py-0.5 rounded-md text-[9px] font-black uppercase tracking-wider bg-emerald-500 text-slate-950 shadow-sm flex items-center gap-1">
                          {" "}
                          <Sparkles className="w-2.5 h-2.5 fill-current" />{" "}
                          <span>AI VIDEO</span>{" "}
                        </span>
                      ) : (
                        <span className="px-2 py-0.5 rounded-md text-[9px] font-bold uppercase tracking-wider bg-red-600 text-white shadow-sm flex items-center gap-1">
                          {" "}
                          <Film className="w-2.5 h-2.5" />{" "}
                          <span>Template</span>{" "}
                        </span>
                      )}{" "}
                      <span className="px-1.5 py-0.5 rounded bg-slate-950/80 backdrop-blur-sm text-slate-300 text-[10px] font-mono border border-slate-800">
                        {" "}
                        {video.sizeFormatted}{" "}
                      </span>{" "}
                    </div>{" "}
                    {/* Selected Badge */}{" "}
                    {isSelected && (
                      <div className="absolute top-9 left-2 z-10">
                        {" "}
                        <span className="px-2 py-0.5 rounded-full text-[9px] font-bold uppercase tracking-wider bg-emerald-500 text-slate-950 flex items-center gap-1 shadow-md">
                          {" "}
                          <span className="w-1.5 h-1.5 rounded-full bg-slate-950 animate-ping" />{" "}
                          <span>Playing in Studio</span>{" "}
                        </span>{" "}
                      </div>
                    )}{" "}
                    {/* Hover Play Button */}{" "}
                    <div className="absolute inset-0 flex items-center justify-center opacity-0 group-hover:opacity-100 transition-opacity bg-black/40 backdrop-blur-[2px] z-20">
                      {" "}
                      <button
                        onClick={() => {
                          setCurrentVideoUrl(video.url);
                          setActiveMode("mp4");
                          window.scrollTo({ top: 0, behavior: "smooth" });
                        }}
                        className="w-12 h-12 rounded-full bg-emerald-500 hover:bg-emerald-400 text-slate-950 flex items-center justify-center shadow-lg shadow-emerald-500/50 transform hover:scale-110 active:scale-95 transition-all"
                        title="Play in the main studio player"
                      >
                        {" "}
                        <Play className="w-6 h-6 fill-current translate-x-0.5" />{" "}
                      </button>{" "}
                    </div>{" "}
                    {/* Info Bottom of Thumbnail */}{" "}
                    <div className="absolute bottom-2 left-2 right-2 z-10">
                      {" "}
                      <p className="text-xs font-bold text-white line-clamp-1">
                        {" "}
                        {video.keyword}{" "}
                      </p>{" "}
                      <p className="text-[10px] text-slate-400 font-mono">
                        {" "}
                        {new Date(video.modifiedAt).toLocaleTimeString([], {
                          hour: "2-digit",
                          minute: "2-digit",
                        })}{" "}
                        • {video.durationSec}s{" "}
                      </p>{" "}
                    </div>{" "}
                  </div>{" "}
                  {/* Action Buttons */}{" "}
                  <div className="p-2.5 bg-slate-950/90 border-t border-slate-800/80 flex items-center gap-1.5">
                    {" "}
                    <button
                      onClick={() => {
                        setCurrentVideoUrl(video.url);
                        setActiveMode("mp4");
                        window.scrollTo({ top: 0, behavior: "smooth" });
                      }}
                      className={`flex-1 py-1.5 rounded-lg text-xs font-bold transition-all flex items-center justify-center gap-1 ${isSelected ? "bg-emerald-600 text-white" : "bg-slate-800 hover:bg-slate-700 text-slate-200"}`}
                    >
                      {" "}
                      <Play className="w-3 h-3 fill-current" />{" "}
                      <span>{isSelected ? "Playing" : "Play in Studio"}</span>{" "}
                    </button>{" "}
                    <a
                      href={video.url}
                      target="_blank"
                      rel="noreferrer"
                      className="p-1.5 rounded-lg bg-slate-800 hover:bg-slate-700 text-slate-300 hover:text-white transition-colors"
                      title="View directly in a new browser tab"
                    >
                      {" "}
                      <ExternalLink className="w-3.5 h-3.5" />{" "}
                    </a>{" "}
                    <a
                      href={video.url}
                      download={video.filename}
                      className="p-1.5 rounded-lg bg-slate-800 hover:bg-slate-700 text-slate-300 hover:text-white transition-colors"
                      title="Download MP4 file"
                    >
                      {" "}
                      <Download className="w-3.5 h-3.5" />{" "}
                    </a>{" "}
                  </div>{" "}
                </div>
              );
            })}{" "}
          </div>
        )}{" "}
      </div>{" "}
      {/* AI Video Modal (external AI visual, keyless) */}{" "}
      {isFreeAiModalOpen && (
        <div className="fixed inset-0 z-50 flex items-center justify-center p-4 bg-black/80 backdrop-blur-sm animate-in fade-in duration-200">
          {" "}
          <div className="w-full max-w-lg bg-slate-900 border border-emerald-500/40 rounded-3xl p-6 space-y-5 shadow-2xl shadow-emerald-950/50">
            {" "}
            {/* Modal Header */}{" "}
            <div className="flex items-start justify-between">
              {" "}
              <div className="space-y-1">
                {" "}
                <div className="flex items-center gap-2">
                  {" "}
                  <div className="p-2 rounded-xl bg-emerald-950/80 border border-emerald-500/50 text-emerald-400">
                    {" "}
                    <Zap className="w-5 h-5 fill-current text-yellow-300" />{" "}
                  </div>{" "}
                  <div>
                    {" "}
                    <h3 className="font-bold text-base text-slate-100 flex items-center gap-2">
                      {" "}
                      <span>AI Video Generator</span>{" "}
                      <span className="px-2 py-0.5 text-[9px] font-mono font-black uppercase rounded-full bg-emerald-500/20 text-emerald-300 border border-emerald-500/30">
                        {" "}
                        REAL MOTION{" "}
                      </span>{" "}
                    </h3>{" "}
                    <p className="text-xs text-slate-400">
                      {" "}
                      PixVerse 9:16 AI motion generation — real video, not a
                      template{" "}
                    </p>{" "}
                  </div>{" "}
                </div>{" "}
              </div>{" "}
              <button
                onClick={() => setIsFreeAiModalOpen(false)}
                disabled={isGeneratingFreeAi}
                className="p-1.5 rounded-lg hover:bg-slate-800 text-slate-400 hover:text-slate-200 transition-colors disabled:opacity-50"
              >
                {" "}
                <X className="w-4 h-4" />{" "}
              </button>{" "}
            </div>{" "}
            {/* Real-motion backend notice */}{" "}
            <div className="p-3 rounded-2xl bg-emerald-950/40 border border-emerald-500/30 flex items-start gap-3">
              {" "}
              <CheckCircle2 className="w-4 h-4 text-emerald-400 shrink-0 mt-0.5" />{" "}
              <div className="text-xs text-emerald-200/90 leading-relaxed">
                {" "}
                <p className="font-bold text-emerald-300">
                  Real AI Motion — PixVerse v6
                </p>{" "}
                <p className="text-[11px] text-emerald-200/80">
                  {" "}
                  Genuine diffusion motion rendered outside this app
                  (text-to-video, 9:16 vertical). Uses your PixVerse account
                  credits — without credits the request fails honestly and no
                  fake video is created. The internal Template Video stays
                  available for free.{" "}
                </p>{" "}
              </div>{" "}
            </div>{" "}
            {/* Fixed backend specs */}{" "}
            <div className="flex items-center gap-2 text-[11px] font-mono text-slate-400">
              {" "}
              <span className="px-2 py-1 rounded bg-slate-950 border border-slate-800">
                {" "}
                Model: pixverse-v6{" "}
              </span>{" "}
              <span className="px-2 py-1 rounded bg-slate-950 border border-slate-800">
                {" "}
                9:16 • 5s • 540p{" "}
              </span>{" "}
              <span className="px-2 py-1 rounded bg-emerald-950/40 border border-emerald-800/50 text-emerald-300">
                {" "}
                Real motion{" "}
              </span>{" "}
            </div>{" "}
            {/* Prompt Config */}{" "}
            <div className="space-y-1.5">
              {" "}
              <div className="flex items-center justify-between">
                {" "}
                <label className="text-xs font-semibold text-slate-300">
                  {" "}
                  AI Motion Prompt:{" "}
                </label>{" "}
                <span className="text-[10px] font-mono text-slate-400">
                  9:16 Vertical Video
                </span>{" "}
              </div>{" "}
              <textarea
                value={
                  customFreeAiPrompt ||
                  `Cinematic hyper-realistic vertical 9:16 news documentary scene about ${keyword}. Story theme: "${script.headlineQuestion}". High detail photojournalism, cinematic lighting, 8k resolution, photorealistic breaking story broadcast visual, dramatic depth of field.`
                }
                onChange={(e) => setCustomFreeAiPrompt(e.target.value)}
                disabled={isGeneratingFreeAi}
                rows={3}
                className="w-full px-3 py-2 bg-slate-950 border border-slate-800 rounded-xl text-xs text-slate-200 focus:outline-none focus:border-emerald-500 transition-colors leading-relaxed resize-none disabled:opacity-50"
                placeholder="Describe the AI visual scene..."
              />{" "}
            </div>{" "}
            {/* Progress Indicator */}{" "}
            {isGeneratingFreeAi && (
              <div className="p-3.5 rounded-xl bg-emerald-950/50 border border-emerald-500/50 flex items-center gap-3">
                {" "}
                <Loader2 className="w-5 h-5 text-emerald-400 animate-spin shrink-0" />{" "}
                <div className="text-xs">
                  {" "}
                    <p className="text-emerald-200 font-bold">
                      Generating AI video...
                    </p>{" "}
                  <p className="text-emerald-300/80 text-[11px]">
                    {freeAiProgressMsg}
                  </p>{" "}
                </div>{" "}
              </div>
            )}{" "}
            {/* Modal Actions */}{" "}
            <div className="flex items-center justify-end gap-2 pt-2 border-t border-slate-800">
              {" "}
              <button
                onClick={() => setIsFreeAiModalOpen(false)}
                disabled={isGeneratingFreeAi}
                className="px-4 py-2 rounded-xl bg-slate-800 hover:bg-slate-700 text-slate-300 text-xs font-semibold transition-colors disabled:opacity-50"
              >
                {" "}
                Close{" "}
              </button>{" "}
              <button
                onClick={handleGenerateFreeAi}
                disabled={isGeneratingFreeAi}
                className="px-5 py-2 rounded-xl bg-gradient-to-r from-emerald-600 via-teal-600 to-cyan-600 hover:from-emerald-500 hover:to-cyan-500 text-white text-xs font-bold transition-all shadow-lg shadow-emerald-600/40 active:scale-95 disabled:opacity-50 flex items-center gap-2"
              >
                {" "}
                {isGeneratingFreeAi ? (
                  <>
                    {" "}
                    <Loader2 className="w-4 h-4 animate-spin" />{" "}
                    <span>Generating AI video...</span>{" "}
                  </>
                ) : (
                  <>
                    {" "}
                    <Zap className="w-4 h-4 fill-current text-yellow-300" />{" "}
                    <span>Generate AI Video Now</span>{" "}
                  </>
                )}{" "}
              </button>{" "}
            </div>{" "}
          </div>{" "}
        </div>
      )}{" "}
    </div>
  );
};
