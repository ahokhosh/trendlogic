import React, { useState } from 'react';
import { PlusCircle, HelpCircle, Globe, Sparkles } from 'lucide-react';

interface CreateTrendModalProps {
  isOpen: boolean;
  onClose: () => void;
  onCreate: (trendData: {
    keyword: string;
    category: 'sports' | 'technology' | 'science' | 'world' | 'entertainment' | 'business';
    description: string;
    search_volume: number;
    velocity: number;
    country: string;
  }) => void;
}

export const CreateTrendModal: React.FC<CreateTrendModalProps> = ({
  isOpen,
  onClose,
  onCreate
}) => {
  const [keyword, setKeyword] = useState('');
  const [category, setCategory] = useState<'sports' | 'technology' | 'science' | 'world' | 'entertainment' | 'business'>('technology');
  const [description, setDescription] = useState('');
  const [velocity, setVelocity] = useState(88);
  const [searchVolume, setSearchVolume] = useState(85);
  const [country, setCountry] = useState('US');

  if (!isOpen) return null;

  const handleSubmit = (e: React.FormEvent) => {
    e.preventDefault();
    if (!keyword.trim()) return;

    onCreate({
      keyword: keyword.trim(),
      category,
      description: description.trim() || `Sudden surge in search query volume for "${keyword}".`,
      velocity,
      search_volume: searchVolume,
      country
    });

    setKeyword('');
    setDescription('');
    onClose();
  };

  return (
    <div className="fixed inset-0 z-50 bg-black/80 backdrop-blur-sm flex items-center justify-center p-4">
      <div className="bg-slate-900 border border-slate-800 rounded-3xl max-w-lg w-full p-6 space-y-5 shadow-2xl">
        <div className="flex items-center justify-between border-b border-slate-800 pb-3">
          <div className="flex items-center gap-2">
            <PlusCircle className="w-5 h-5 text-red-500" />
            <h2 className="text-base font-bold text-white uppercase font-mono">
              Inject Custom Trend Topic
            </h2>
          </div>
          <button onClick={onClose} className="text-slate-400 hover:text-white">
            ✕
          </button>
        </div>

        <form onSubmit={handleSubmit} className="space-y-4 text-xs">
          <div>
            <label className="text-slate-300 font-bold block mb-1">
              Trending Keyword / Topic Name *
            </label>
            <input
              type="text"
              required
              placeholder="e.g. Real Madrid vs Barcelona, OpenAI Sora 2.0, NASA Artemis III"
              value={keyword}
              onChange={e => setKeyword(e.target.value)}
              className="w-full bg-slate-950 border border-slate-800 rounded-xl px-3.5 py-2 text-white placeholder-slate-500 focus:outline-none focus:ring-2 focus:ring-red-500/50 text-xs"
            />
            <p className="text-[11px] text-slate-500 mt-1">
              The Question Engine will automatically determine: "Why is [Keyword] trending today?"
            </p>
          </div>

          <div className="grid grid-cols-2 gap-3">
            <div>
              <label className="text-slate-300 font-bold block mb-1">Category</label>
              <select
                value={category}
                onChange={e => setCategory(e.target.value as any)}
                className="w-full bg-slate-950 border border-slate-800 rounded-xl px-3 py-2 text-slate-200 text-xs focus:outline-none"
              >
                <option value="sports">Sports</option>
                <option value="technology">Technology</option>
                <option value="science">Science</option>
                <option value="world">World News</option>
                <option value="entertainment">Entertainment</option>
                <option value="business">Business</option>
              </select>
            </div>

            <div>
              <label className="text-slate-300 font-bold block mb-1">Country / Locale</label>
              <input
                type="text"
                value={country}
                onChange={e => setCountry(e.target.value)}
                className="w-full bg-slate-950 border border-slate-800 rounded-xl px-3 py-2 text-slate-200 text-xs"
              />
            </div>
          </div>

          <div>
            <label className="text-slate-300 font-bold block mb-1">
              Background Context / What happened?
            </label>
            <textarea
              rows={3}
              placeholder="Brief verified factual context or wire summary..."
              value={description}
              onChange={e => setDescription(e.target.value)}
              className="w-full bg-slate-950 border border-slate-800 rounded-xl px-3.5 py-2 text-white placeholder-slate-500 focus:outline-none focus:ring-2 focus:ring-red-500/50 text-xs resize-none"
            />
          </div>

          <div className="grid grid-cols-2 gap-3">
            <div>
              <label className="text-slate-300 font-bold block mb-1">
                Velocity Score ({velocity}/100)
              </label>
              <input
                type="range"
                min="50"
                max="100"
                value={velocity}
                onChange={e => setVelocity(parseInt(e.target.value))}
                className="w-full accent-red-500"
              />
            </div>

            <div>
              <label className="text-slate-300 font-bold block mb-1">
                Search Volume Index ({searchVolume}k)
              </label>
              <input
                type="range"
                min="30"
                max="100"
                value={searchVolume}
                onChange={e => setSearchVolume(parseInt(e.target.value))}
                className="w-full accent-red-500"
              />
            </div>
          </div>

          <div className="flex items-center justify-end gap-2 pt-3 border-t border-slate-800">
            <button
              type="button"
              onClick={onClose}
              className="px-4 py-2 rounded-xl bg-slate-800 hover:bg-slate-700 text-white font-semibold"
            >
              Cancel
            </button>
            <button
              type="submit"
              className="px-5 py-2 rounded-xl bg-gradient-to-r from-red-600 to-amber-600 text-white font-bold flex items-center gap-1.5 shadow-lg shadow-red-600/30"
            >
              <Sparkles className="w-4 h-4" />
              <span>Ingest & Normalize</span>
            </button>
          </div>
        </form>
      </div>
    </div>
  );
};
