import React, { useEffect, useState } from 'react';
import {
  Cpu,
  CheckCircle2,
  AlertTriangle,
  Clock,
  Play,
  RotateCcw,
  Layers,
  ArrowRight,
  ExternalLink
} from 'lucide-react';
import { PipelineJob } from '../types';

interface JobQueueViewProps {
  jobs: PipelineJob[];
  activeJobId?: string;
  onSelectJob: (job: PipelineJob) => void;
  onInspectPipeline: () => void;
  onViewStudio: () => void;
}

interface QueueStats {
  pipeline: { pending: number; active: number; concurrency: number };
  io: { pending: number; active: number; concurrency: number };
}

export const JobQueueView: React.FC<JobQueueViewProps> = ({
  jobs,
  activeJobId,
  onSelectJob,
  onInspectPipeline,
  onViewStudio
}) => {
  const [queue, setQueue] = useState<QueueStats | null>(null);
  useEffect(() => {
    let cancelled = false;
    const load = async () => {
      try {
        const r = await fetch('/api/queue/status');
        if (r.ok) {
          const d = await r.json();
          if (!cancelled && d?.queue) setQueue(d.queue);
        }
      } catch { /* badge stays hidden */ }
    };
    load();
    const t = setInterval(load, 5000);
    return () => { cancelled = true; clearInterval(t); };
  }, []);
  const queuedJobs = jobs.filter(j => j.status === 'queued');
  const runningJobs = jobs.filter(j => j.status === 'running');
  return (
    <div className="space-y-6 max-w-5xl mx-auto">
      {/* Header */}
      <div className="bg-slate-900 border border-slate-800 rounded-3xl p-6 flex items-center justify-between">
        <div className="flex items-center gap-3">
          <div className="p-2.5 rounded-2xl bg-red-600/10 border border-red-500/20 text-red-400">
            <Cpu className="w-6 h-6" />
          </div>
          <div>
            <h2 className="text-lg font-black text-white font-mono uppercase">
              Pipeline Job Queue & Worker Status
            </h2>
            <p className="text-xs text-slate-400 mt-0.5">
              Multi-stage asynchronous content production workers for vertical short-form videos.
            </p>
          </div>
        </div>

        <div className="text-right font-mono text-xs text-slate-400 space-y-1">
          <div>
            <span>Active Workers: </span>
            <span className="text-emerald-400 font-bold">
              {runningJobs.length} running
            </span>
            {queuedJobs.length > 0 && (
              <span className="text-sky-300 font-bold"> • {queuedJobs.length} queued</span>
            )}
          </div>
          {queue && (
            <div className="text-[10px] text-slate-500" dir="ltr">
              queue: video {queue.pipeline.active}/{queue.pipeline.concurrency} active, {queue.pipeline.pending} waiting
              {' • '}net {queue.io.active}/{queue.io.concurrency} active, {queue.io.pending} waiting
            </div>
          )}
        </div>
      </div>

      {/* Jobs List */}
      <div className="space-y-3">
        {jobs.length === 0 ? (
          <div className="bg-slate-900 border border-slate-800 rounded-2xl p-10 text-center text-slate-500 text-xs">
            No pipeline jobs currently in queue.
          </div>
        ) : (
          jobs.map(job => {
            const isSelected = activeJobId === job.id;
            const isCompleted = job.status === 'completed';
            const isFailed = job.status === 'failed';
            const isRunning = job.status === 'running';
            const isQueued = job.status === 'queued';
            const queuePos = isQueued ? queuedJobs.findIndex(j => j.id === job.id) + 1 : 0;

            return (
              <div
                key={job.id}
                onClick={() => onSelectJob(job)}
                className={`p-5 rounded-2xl border cursor-pointer transition-all ${
                  isSelected
                    ? 'bg-slate-900 border-red-500 shadow-lg shadow-red-950/20 ring-1 ring-red-500/50'
                    : 'bg-slate-900/70 border-slate-800 hover:border-slate-700'
                }`}
              >
                <div className="flex flex-col sm:flex-row sm:items-center justify-between gap-3">
                  <div>
                    <div className="flex items-center gap-2 mb-1">
                      <span className={`w-2.5 h-2.5 rounded-full ${isCompleted ? 'bg-emerald-400' : isFailed ? 'bg-red-400' : isQueued ? 'bg-sky-400 animate-pulse' : 'bg-amber-400 animate-pulse'}`} />
                      <span className="font-mono text-xs text-slate-400 uppercase">
                        {job.id}
                      </span>
                      {isQueued && (
                        <span className="px-2 py-0.5 rounded text-[10px] font-mono font-bold bg-sky-600/20 text-sky-300 uppercase">
                          Queued #{queuePos} — waiting for turn
                        </span>
                      )}
                      <span className="px-2 py-0.5 rounded text-[10px] font-mono bg-slate-800 text-slate-300 uppercase">
                        {job.category}
                      </span>
                      <span className="text-[11px] font-mono text-slate-500">
                        {new Date(job.startedAt).toLocaleTimeString()}
                      </span>
                    </div>

                    <h3 className="text-base font-bold text-white flex items-center gap-2">
                      <span>{job.trendKeyword}</span>
                      <span className="text-xs text-slate-400 font-normal">
                        ({job.trend.primaryQuestion})
                      </span>
                    </h3>
                  </div>

                  {/* Status & Progress */}
                  <div className="flex items-center gap-3">
                    <div className="text-right">
                      <span className="text-[10px] font-mono uppercase text-slate-400 block">
                        Step: {job.currentStep}
                      </span>
                      <span className="text-xs font-mono font-bold text-white">
                        {job.progressPercent}% Complete
                      </span>
                    </div>

                    <div className="w-20 h-2 bg-slate-800 rounded-full overflow-hidden">
                      <div
                        className={`h-full ${
                          isCompleted ? 'bg-emerald-500' : isFailed ? 'bg-red-500' : isQueued ? 'bg-sky-500' : 'bg-amber-500'
                        }`}
                        style={{ width: `${job.progressPercent}%` }}
                      />
                    </div>

                    <div className="flex items-center gap-1.5 ml-2">
                      <button
                        onClick={e => {
                          e.stopPropagation();
                          onSelectJob(job);
                          onInspectPipeline();
                        }}
                        className="px-2.5 py-1.5 rounded-lg bg-slate-800 hover:bg-slate-700 text-slate-200 text-xs font-semibold flex items-center gap-1"
                        title="View pipeline progression"
                      >
                        <Layers className="w-3.5 h-3.5" />
                        <span className="hidden sm:inline">Trace</span>
                      </button>

                      {isCompleted && (
                        <button
                          onClick={e => {
                            e.stopPropagation();
                            onSelectJob(job);
                            onViewStudio();
                          }}
                          className="px-2.5 py-1.5 rounded-lg bg-red-600 hover:bg-red-500 text-white text-xs font-semibold flex items-center gap-1"
                          title="Watch rendered video"
                        >
                          <Play className="w-3.5 h-3.5 fill-current" />
                          <span>Watch</span>
                        </button>
                      )}
                    </div>
                  </div>
                </div>
              </div>
            );
          })
        )}
      </div>
    </div>
  );
};
