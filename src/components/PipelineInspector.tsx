import React from 'react';
import {
  CheckCircle2,
  Clock,
  AlertTriangle,
  Play,
  RotateCcw,
  Layers,
  Search,
  FileText,
  Sliders,
  Sparkles,
  ShieldCheck,
  Video,
  Share2,
  BarChart3,
  Cpu
} from 'lucide-react';
import { PipelineJob, PipelineStepStatus } from '../types';

interface PipelineInspectorProps {
  activeJob: PipelineJob | null;
  onRetry?: () => void;
  onViewStudio?: () => void;
}

interface StepMeta {
  key: PipelineStepStatus;
  label: string;
  category: 'discovery' | 'intelligence' | 'production' | 'distribution';
  description: string;
}

const PIPELINE_STEPS: StepMeta[] = [
  { key: 'discovery', label: '1. Trend Discovery', category: 'discovery', description: 'Provider abstraction ingestion (Google Trends, AP/Reuters wire, YouTube, Social)' },
  { key: 'normalization', label: '2. Normalization', category: 'discovery', description: 'Standardized ISO schema, language parsing, initial metadata extraction' },
  { key: 'deduplication', label: '3. Deduplication', category: 'discovery', description: 'Cosine semantic clustering of related search spikes and variants' },
  { key: 'scoring', label: '4. Trend Scoring', category: 'discovery', description: 'Velocity, acceleration curve, search volume composite weighting' },
  { key: 'intent', label: '5. Intent Detection', category: 'intelligence', description: 'Identifies why people search (Informational, Event/Result, Breaking, Why)' },
  { key: 'question', label: '6. Question Generation', category: 'intelligence', description: 'Answers the question behind the search: "Why is X trending today?"' },
  { key: 'research', label: '7. Research Engine', category: 'intelligence', description: 'Deep grounding across wire services, authoritative match centers, official statements' },
  { key: 'verification', label: '8. Fact Verification', category: 'intelligence', description: 'Claim extraction, multi-source corroboration, zero-hallucination audit' },
  { key: 'angle', label: '9. Content Angle', category: 'intelligence', description: 'Hook framing, dramatic contrast, urgent explainer editorial tone' },
  { key: 'scripting', label: '10. Script Generation', category: 'production', description: '30-40s retention-optimized narrative (Hook 0-3s, Question 3-7s, Evidence 7-28s, CTA)' },
  { key: 'storyboard', label: '11. Storyboard Engine', category: 'production', description: '9:16 vertical scene layout, visual cues, shot pacing, graphic overlay badges' },
  { key: 'assets', label: '12. Asset Engine', category: 'production', description: 'Visual asset synthesis, photo curation, attribution licensing audit' },
  { key: 'voice', label: '13. Voice Generation', category: 'production', description: 'AI voiceover synthesis, emphasis word tags, prosody & cadence tuning' },
  { key: 'subtitles', label: '14. Subtitle Engine', category: 'production', description: 'Kinetic word-by-word highlighted captions in modern viral Shorts style' },
  { key: 'rendering', label: '15. Video Rendering', category: 'production', description: 'HTML5 60fps canvas compositor, motion graphics, audio sync' },
  { key: 'seo', label: '16. SEO Metadata', category: 'distribution', description: 'YouTube Shorts title, verified source description, tags, pinned comment' },
  { key: 'qc', label: '17. Quality Control', category: 'distribution', description: '10-point fact traceability, safe zone compliance, pacing, policy approval' }
];

export const PipelineInspector: React.FC<PipelineInspectorProps> = ({
  activeJob,
  onRetry,
  onViewStudio
}) => {
  if (!activeJob) {
    return (
      <div className="bg-slate-900 border border-slate-800 rounded-2xl p-12 text-center">
        <Layers className="w-12 h-12 text-slate-600 mx-auto mb-3" />
        <h3 className="text-base font-bold text-white">No Active Pipeline Job</h3>
        <p className="text-xs text-slate-400 mt-1 max-w-sm mx-auto">
          Select a trending spike from the Newsroom tab or click "Generate Video" to execute the full 17-step end-to-end pipeline.
        </p>
      </div>
    );
  }

  const currentStepIndex = PIPELINE_STEPS.findIndex(s => s.key === activeJob.currentStep);
  const isCompleted = activeJob.status === 'completed';
  const isFailed = activeJob.status === 'failed';

  return (
    <div className="space-y-6">
      {/* Job Header Summary */}
      <div className="bg-slate-900 border border-slate-800 rounded-2xl p-5 flex flex-col md:flex-row md:items-center justify-between gap-4">
        <div>
          <div className="flex items-center gap-2">
            <span className={`w-2.5 h-2.5 rounded-full ${isCompleted ? 'bg-emerald-400' : isFailed ? 'bg-red-400' : 'bg-amber-400 animate-pulse'}`} />
            <span className="font-mono text-xs text-slate-400 uppercase">
              Job ID: {activeJob.id}
            </span>
            <span className="px-2 py-0.5 rounded text-[10px] font-mono uppercase bg-slate-800 text-slate-300">
              {activeJob.category}
            </span>
          </div>

          <h2 className="text-xl font-black text-white mt-1 flex items-center gap-2">
            <span>{activeJob.trendKeyword}</span>
            <span className="text-slate-400 font-normal text-sm">
              → "{activeJob.trend.primaryQuestion}"
            </span>
          </h2>
        </div>

        {/* Progress Bar & Actions */}
        <div className="flex items-center gap-4">
          <div className="text-right">
            <span className="text-xs font-mono text-slate-400 block">Progress</span>
            <span className="text-xl font-black font-mono text-white">
              {activeJob.progressPercent}%
            </span>
          </div>

          <div className="w-32 h-2.5 bg-slate-800 rounded-full overflow-hidden">
            <div
              className={`h-full transition-all duration-300 ${
                isCompleted ? 'bg-emerald-500' : isFailed ? 'bg-red-500' : 'bg-gradient-to-r from-red-500 to-amber-500'
              }`}
              style={{ width: `${activeJob.progressPercent}%` }}
            />
          </div>

          {isCompleted && (
            <button
              onClick={onViewStudio}
              className="px-4 py-2 rounded-xl bg-red-600 hover:bg-red-500 text-white font-bold text-xs flex items-center gap-1.5 shadow-lg shadow-red-600/30 transition-all"
            >
              <Video className="w-4 h-4" />
              <span>Watch Short</span>
            </button>
          )}

          {isFailed && (
            <button
              onClick={onRetry}
              className="px-4 py-2 rounded-xl bg-amber-600 hover:bg-amber-500 text-white font-bold text-xs flex items-center gap-1.5 transition-all"
            >
              <RotateCcw className="w-4 h-4" />
              <span>Retry Pipeline</span>
            </button>
          )}
        </div>
      </div>

      {/* Grid: 17 Steps Progression Column & Live Event Logs */}
      <div className="grid grid-cols-1 lg:grid-cols-12 gap-6">
        {/* Steps Column */}
        <div className="lg:col-span-7 bg-slate-900 border border-slate-800 rounded-2xl p-5 space-y-2">
          <div className="flex items-center justify-between pb-3 border-b border-slate-800">
            <h3 className="text-xs font-bold uppercase tracking-wider text-slate-300 flex items-center gap-2">
              <Layers className="w-4 h-4 text-red-400" />
              <span>End-to-End Pipeline Progression (17 Stages)</span>
            </h3>
            <span className="text-[11px] font-mono text-slate-400">
              Philosophy: Answer The Question Behind Search
            </span>
          </div>

          <div className="space-y-1.5 max-h-[600px] overflow-y-auto pr-1">
            {PIPELINE_STEPS.map((step, idx) => {
              const stepDone = isCompleted || idx < currentStepIndex;
              const stepActive = !isCompleted && !isFailed && idx === currentStepIndex;
              const stepFailed = isFailed && idx === currentStepIndex;

              return (
                <div
                  key={step.key}
                  className={`p-3 rounded-xl border transition-all flex items-start justify-between gap-3 ${
                    stepActive
                      ? 'bg-amber-950/30 border-amber-500/50 shadow-md shadow-amber-950/20'
                      : stepDone
                      ? 'bg-slate-950/60 border-slate-800 text-slate-300'
                      : 'bg-slate-950/30 border-slate-800/40 text-slate-500 opacity-60'
                  }`}
                >
                  <div className="flex items-start gap-3">
                    <div className="mt-0.5">
                      {stepDone ? (
                        <CheckCircle2 className="w-4 h-4 text-emerald-400" />
                      ) : stepActive ? (
                        <span className="w-4 h-4 rounded-full border-2 border-amber-400 border-t-transparent animate-spin block" />
                      ) : stepFailed ? (
                        <AlertTriangle className="w-4 h-4 text-red-400" />
                      ) : (
                        <Clock className="w-4 h-4 text-slate-600" />
                      )}
                    </div>

                    <div>
                      <div className="flex items-center gap-2">
                        <span className={`text-xs font-bold ${stepActive ? 'text-amber-300 font-mono' : stepDone ? 'text-white' : 'text-slate-400'}`}>
                          {step.label}
                        </span>
                        <span className="text-[9px] uppercase font-mono px-1.5 py-0.2 rounded bg-slate-800 text-slate-400">
                          {step.category}
                        </span>
                      </div>
                      <p className="text-[11px] text-slate-400 mt-0.5 leading-snug">
                        {step.description}
                      </p>
                    </div>
                  </div>

                  <span className="text-[10px] font-mono shrink-0 text-slate-400">
                    {stepDone ? 'DONE' : stepActive ? 'PROCESSING' : 'PENDING'}
                  </span>
                </div>
              );
            })}
          </div>
        </div>

        {/* Live Event Logs Column */}
        <div className="lg:col-span-5 bg-slate-900 border border-slate-800 rounded-2xl p-5 flex flex-col justify-between">
          <div>
            <div className="flex items-center justify-between pb-3 border-b border-slate-800 mb-3">
              <h3 className="text-xs font-bold uppercase tracking-wider text-slate-300 flex items-center gap-2">
                <Cpu className="w-4 h-4 text-amber-400" />
                <span>Execution Trace & Verification Log</span>
              </h3>
              <span className="text-[10px] font-mono text-emerald-400 bg-emerald-950/60 px-2 py-0.5 rounded border border-emerald-800/40">
                ZERO HALLUCINATION GATE
              </span>
            </div>

            <div className="space-y-2 max-h-[520px] overflow-y-auto pr-1 font-mono text-[11px]">
              {activeJob.logs.map(log => (
                <div
                  key={log.id}
                  className={`p-2 rounded-lg border ${
                    log.type === 'success'
                      ? 'bg-emerald-950/20 border-emerald-800/40 text-emerald-300'
                      : log.type === 'error'
                      ? 'bg-red-950/30 border-red-800 text-red-300'
                      : log.type === 'warn'
                      ? 'bg-amber-950/20 border-amber-800 text-amber-300'
                      : 'bg-slate-950 border-slate-800/80 text-slate-300'
                  }`}
                >
                  <div className="flex items-center justify-between text-[10px] text-slate-500 mb-0.5">
                    <span className="font-bold uppercase tracking-wider text-slate-400">[{log.step}]</span>
                    <span>{log.timestamp}</span>
                  </div>
                  <p className="leading-relaxed">{log.message}</p>
                </div>
              ))}
            </div>
          </div>

          <div className="mt-4 pt-3 border-t border-slate-800 text-xs text-slate-400 flex items-center justify-between">
            <span>Started: {new Date(activeJob.startedAt).toLocaleTimeString()}</span>
            {activeJob.completedAt && (
              <span className="text-emerald-400 font-bold">
                Completed in {Math.round((new Date(activeJob.completedAt).getTime() - new Date(activeJob.startedAt).getTime()) / 1000)}s
              </span>
            )}
          </div>
        </div>
      </div>
    </div>
  );
};
