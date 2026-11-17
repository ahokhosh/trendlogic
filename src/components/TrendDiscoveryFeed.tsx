import React, { useState, useEffect } from 'react';
import {
  Flame,
  Search,
  Filter,
  TrendingUp,
  HelpCircle,
  Play,
  ArrowRight,
  ShieldCheck,
  Globe,
  Radio,
  Clock,
  Sparkles,
  ExternalLink,
  ChevronDown,
  CheckCircle,
  FileCode2
} from 'lucide-react';
import { NormalizedTrend, SearchIntentType } from '../types';
import { SmartImg } from '../lib/SmartImg';

interface TrendDiscoveryFeedProps {
  trends: NormalizedTrend[];
  onSelectTrend: (trend: NormalizedTrend) => void;
  onRunPipeline: (trend: NormalizedTrend, question?: string) => void;
  selectedTrendId?: string;
  isProcessing?: boolean;
  onAutoTopVideo?: () => void;
  selectedCountry?: string;
  onSelectCountry?: (country: string) => void;
  hasCredit?: boolean;
  onBuyCredit?: () => void;
}

export const TrendDiscoveryFeed: React.FC<TrendDiscoveryFeedProps> = ({
  trends,
  onSelectTrend,
  onRunPipeline,
  selectedTrendId,
  isProcessing,
  onAutoTopVideo,
  selectedCountry = 'US',
  onSelectCountry,
  hasCredit = true,
  onBuyCredit
}) => {
  const [searchQuery, setSearchQuery] = useState('');
  const [selectedCategory, setSelectedCategory] = useState<string>('all');
  const [inspectingJsonTrend, setInspectingJsonTrend] = useState<NormalizedTrend | null>(null);
  const [cooldownMsg, setCooldownMsg] = useState<string | null>(null);
  useEffect(() => { checkCooldown(); const t = setInterval(checkCooldown, 60000); return () => clearInterval(t); }, []);
  const COOLDOWN_MS = 4 * 60 * 60 * 1000;
  const checkCooldown = () => {
    const last = Number(localStorage.getItem('tl_last_generate_at') || 0);
    const remaining = COOLDOWN_MS - (Date.now() - last);
    if (remaining > 0) {
      const mins = Math.ceil(remaining / 60000);
      const h = Math.floor(mins / 60);
      const m = mins % 60;
      setCooldownMsg(`One video every 4 hours. Try again in ${h}h ${m}m.`);
      return true;
    }
    setCooldownMsg(null);
    return false;
  };

  const categories = [
    { id: 'all', label: 'All Topics' },
    { id: 'sports', label: 'Sports' },
    { id: 'science', label: 'Science' },
    { id: 'technology', label: 'Technology' },
    { id: 'world', label: 'World News' },
    { id: 'entertainment', label: 'Entertainment' },
    { id: 'business', label: 'Business' }
  ];

  const filteredTrends = trends.filter(trend => {
    const matchesCategory = selectedCategory === 'all' || trend.category === selectedCategory;
    const matchesSearch =
      trend.keyword.toLowerCase().includes(searchQuery.toLowerCase()) ||
      trend.description.toLowerCase().includes(searchQuery.toLowerCase()) ||
      (trend.primaryQuestion && trend.primaryQuestion.toLowerCase().includes(searchQuery.toLowerCase()));
    return matchesCategory && matchesSearch;
  });

  const topTrend = trends[0];

  return (
    <div className="space-y-6">

      {/* Top Filter Bar */}
      <div className="flex flex-col gap-3 bg-slate-900/80 border border-slate-800 p-4 rounded-2xl">
        {/* Country + Search */}
        <div className="flex flex-col sm:flex-row items-stretch sm:items-center gap-2">
          <select
            value={selectedCountry}
            onChange={e => onSelectCountry && onSelectCountry(e.target.value)}
            className="bg-slate-950 border border-slate-800 rounded-xl px-3 py-2 text-xs text-amber-300 font-bold focus:outline-none cursor-pointer w-full sm:w-auto"
            aria-label="Region"
          >
            {[
              { code: 'US', label: 'United States' }, { code: 'GB', label: 'United Kingdom' },
              { code: 'CA', label: 'Canada' }, { code: 'AU', label: 'Australia' },
              { code: 'DE', label: 'Germany' }, { code: 'FR', label: 'France' },
              { code: 'JP', label: 'Japan' }, { code: 'IT', label: 'Italy' },
              { code: 'ES', label: 'Spain' }, { code: 'BR', label: 'Brazil' },
              { code: 'IN', label: 'India' }, { code: 'TR', label: 'Turkey' },
              { code: 'SA', label: 'Saudi Arabia' }, { code: 'AE', label: 'UAE' },
              { code: 'NL', label: 'Netherlands' }, { code: 'KR', label: 'South Korea' },
              { code: 'IR', label: 'Iran' }, { code: 'RU', label: 'Russia' },
              { code: 'CN', label: 'China' }, { code: 'MX', label: 'Mexico' },
              { code: 'AR', label: 'Argentina' }, { code: 'CL', label: 'Chile' },
              { code: 'CO', label: 'Colombia' }, { code: 'PE', label: 'Peru' },
              { code: 'VE', label: 'Venezuela' }, { code: 'ZA', label: 'South Africa' },
              { code: 'EG', label: 'Egypt' }, { code: 'NG', label: 'Nigeria' },
              { code: 'KE', label: 'Kenya' }, { code: 'MA', label: 'Morocco' },
              { code: 'DZ', label: 'Algeria' }, { code: 'TN', label: 'Tunisia' },
              { code: 'IL', label: 'Israel' }, { code: 'PK', label: 'Pakistan' },
              { code: 'BD', label: 'Bangladesh' }, { code: 'ID', label: 'Indonesia' },
              { code: 'MY', label: 'Malaysia' }, { code: 'SG', label: 'Singapore' },
              { code: 'TH', label: 'Thailand' }, { code: 'VN', label: 'Vietnam' },
              { code: 'PH', label: 'Philippines' }, { code: 'TW', label: 'Taiwan' },
              { code: 'HK', label: 'Hong Kong' }, { code: 'NZ', label: 'New Zealand' },
              { code: 'IE', label: 'Ireland' }, { code: 'SE', label: 'Sweden' },
              { code: 'NO', label: 'Norway' }, { code: 'DK', label: 'Denmark' },
              { code: 'FI', label: 'Finland' }, { code: 'PL', label: 'Poland' },
              { code: 'CZ', label: 'Czechia' }, { code: 'HU', label: 'Hungary' },
              { code: 'RO', label: 'Romania' }, { code: 'BG', label: 'Bulgaria' },
              { code: 'GR', label: 'Greece' }, { code: 'PT', label: 'Portugal' },
              { code: 'CH', label: 'Switzerland' }, { code: 'AT', label: 'Austria' },
              { code: 'BE', label: 'Belgium' }, { code: 'UA', label: 'Ukraine' },
              { code: 'PL', label: 'Poland' }
            ].map(c => (
              <option key={c.code} value={c.code} className="bg-slate-900 text-white">
                {c.code} — {c.label}
              </option>
            ))}
          </select>
          <div className="relative flex-1">
            <Search className="absolute left-3.5 top-1/2 -translate-y-1/2 w-4 h-4 text-slate-400" />
            <input
              type="text"
              placeholder="Search trend keywords, topics, questions..."
              value={searchQuery}
              onChange={e => setSearchQuery(e.target.value)}
              className="w-full bg-slate-950 border border-slate-800 rounded-xl pl-10 pr-4 py-2 text-xs text-slate-200 placeholder-slate-500 focus:outline-none focus:ring-2 focus:ring-red-500/50"
            />
          </div>
        </div>

        {/* Categories */}
        <div className="flex flex-wrap items-center gap-1.5">
          {categories.map(cat => (
            <button
              key={cat.id}
              onClick={() => setSelectedCategory(cat.id)}
              className={`px-3 py-1.5 rounded-lg text-xs font-medium whitespace-nowrap transition-all ${
                selectedCategory === cat.id
                  ? 'bg-red-600 text-white shadow-sm'
                  : 'bg-slate-950/60 border border-slate-800 text-slate-400 hover:text-slate-200 hover:bg-slate-800'
              }`}
            >
              {cat.label}
            </button>
          ))}
        </div>
      </div>

      {/* Grid of Trending Spikes */}
      <div className="grid grid-cols-1 md:grid-cols-2 gap-4">
        {filteredTrends.map(trend => {
          const isSelected = selectedTrendId === trend.id;

          return (
            <div
              key={trend.id}
              className={`p-5 rounded-2xl border transition-all relative overflow-hidden flex flex-col justify-between ${
                isSelected
                  ? 'bg-slate-900 border-red-500 shadow-xl shadow-red-950/30 ring-1 ring-red-500/50'
                  : 'bg-slate-900/70 border-slate-800/80 hover:border-slate-700 hover:bg-slate-900/90'
              }`}
            >
              <div>
                {/* Header info */}
                <div className="flex items-start justify-between gap-3 mb-2">
                  <div className="flex items-center gap-2 flex-wrap">
                    <span className="w-6 h-6 rounded-lg bg-red-600/20 text-red-400 font-mono font-bold text-xs flex items-center justify-center border border-red-500/30">
                      #{trend.rank}
                    </span>
                    <span className="text-[10px] uppercase font-bold font-mono tracking-wider px-2 py-0.5 rounded bg-slate-800 text-slate-300">
                      {trend.category}
                    </span>
                    {trend.isLiveGoogleTrend && (
                      <span className="text-[10px] font-mono px-2 py-0.5 rounded bg-emerald-950/70 text-emerald-300 border border-emerald-800/40 flex items-center gap-1 font-bold">
                        <span className="w-1.5 h-1.5 rounded-full bg-emerald-400 animate-pulse" />
                        GOOGLE TRENDS
                      </span>
                    )}
                    <span className="text-[10px] font-mono text-slate-400 flex items-center gap-1">
                      <Globe className="w-3 h-3 text-slate-500" />
                      {trend.country}
                    </span>
                  </div>

                  {/* Traffic / Velocity badge */}
                  <div className="flex items-center gap-1.5 px-2 py-1 rounded-lg bg-amber-500/10 border border-amber-500/20 text-amber-300 text-xs font-mono font-bold shrink-0">
                    <TrendingUp className="w-3.5 h-3.5 text-amber-400" />
                    <span>{trend.rawGoogleTraffic || `Velocity: ${trend.velocity}/100`}</span>
                  </div>
                </div>

                {/* Keyword & Core Question — with the trend's own Google photo (shot 0) */}
                <div className="mt-1 flex items-center gap-3">
                  {trend.image_url && (
                    <SmartImg
                      src={trend.image_url}
                      alt={trend.keyword}
                      loading="lazy"
                      className="w-20 h-20 rounded-xl object-cover border border-slate-700/60 shrink-0"
                    />
                  )}
                  <h3 className="text-lg font-black text-white tracking-tight">
                    {trend.keyword}
                  </h3>
                </div>

                <p className="text-xs text-slate-300 mt-2 line-clamp-2 leading-relaxed">
                  {trend.description}
                </p>
              </div>

               {/* Footer with Metrics & Action Buttons */}
               <div className="mt-3 pt-2 border-t border-slate-800/80 flex items-center justify-between gap-2">
                 {cooldownMsg && <span className="text-[10px] text-amber-300 font-mono">{cooldownMsg}</span>}
                <button
                  onClick={() => {
                    if (!hasCredit) { onBuyCredit?.(); return; }
                    if (checkCooldown()) return;
                    localStorage.setItem('tl_last_generate_at', String(Date.now()));
                    checkCooldown();
                    onRunPipeline(trend);
                  }}
                  disabled={isProcessing || !!cooldownMsg}
                  className="px-3.5 py-1.5 rounded-lg bg-gradient-to-r from-red-600 to-amber-600 hover:brightness-110 text-white text-xs font-bold flex items-center gap-1.5 shadow-md shadow-red-600/20 active:scale-95 transition-all disabled:opacity-50"
                >
                  <Play className="w-3.5 h-3.5 fill-current" />
                  <span>Generate Video</span>
                </button>
              </div>
            </div>
          );
        })}
      </div>

      {/* Normalized Schema Modal */}
      {inspectingJsonTrend && (
        <div className="fixed inset-0 z-50 bg-black/80 backdrop-blur-sm flex items-center justify-center p-4">
          <div className="bg-slate-900 border border-slate-800 rounded-2xl max-w-2xl w-full p-6 space-y-4 shadow-2xl">
            <div className="flex items-center justify-between border-b border-slate-800 pb-3">
              <div className="flex items-center gap-2">
                <FileCode2 className="w-5 h-5 text-red-400" />
                <h3 className="font-bold text-white text-sm font-mono">
                  Normalized Trend Object Specification
                </h3>
              </div>
              <button
                onClick={() => setInspectingJsonTrend(null)}
                className="text-slate-400 hover:text-white text-sm"
              >
                ✕
              </button>
            </div>

            <p className="text-xs text-slate-400">
              Corresponds directly to Section 8 of the Product Specification: Provider normalization into standard schema.
            </p>

            <pre className="p-4 rounded-xl bg-slate-950 border border-slate-800/80 font-mono text-xs text-amber-300/90 overflow-x-auto max-h-[380px]">
              {JSON.stringify(inspectingJsonTrend, null, 2)}
            </pre>

            <div className="flex justify-end">
              <button
                onClick={() => setInspectingJsonTrend(null)}
                className="px-4 py-2 rounded-xl bg-slate-800 hover:bg-slate-700 text-white text-xs font-semibold"
              >
                Close
              </button>
            </div>
          </div>
        </div>
      )}
    </div>
  );
};
