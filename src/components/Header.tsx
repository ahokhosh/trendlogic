import React, { useState } from 'react';
import {
  Radio,
  Play,
  Layers,
  Instagram,
  Video,
  Sparkles,
  User,
  RefreshCw,
  Zap,
  Upload,
  LayoutGrid
} from 'lucide-react';

export type AppTab =
  | 'dashboard'
  | 'settings'
  | 'repost'
  | 'stream'
  | 'relax'
  | 'uploader'
  | 'services'
  | 'admin'; // manager-only panel, entered from Profile — not shown in the tab bar

interface HeaderProps {
  activeTab: AppTab;
  setActiveTab: (tab: AppTab) => void;
  onDiscover: () => void;
  isDiscovering: boolean;
  selectedCountry?: string;
  onSelectCountry?: (country: string) => void;
  hasAiVideo?: boolean;
  userName?: string;
}

const TABS: { id: AppTab; label: string; Icon: typeof Radio; active: string }[] = [
  { id: 'services', label: 'Services', Icon: LayoutGrid, active: 'bg-slate-700 text-white shadow-sm shadow-slate-500/30' },
  { id: 'uploader', label: 'Uploder', Icon: Upload, active: 'bg-violet-600 text-white shadow-sm shadow-violet-600/30' },
  { id: 'settings', label: 'Profile', Icon: User, active: 'bg-red-600 text-white shadow-sm shadow-red-600/30' }
];

const SERVICES: { id: AppTab; label: string; Icon: typeof Radio; active: string }[] = [
  { id: 'repost', label: 'IG Repost', Icon: Instagram, active: 'bg-pink-600 text-white shadow-sm shadow-pink-600/30' },
  { id: 'dashboard', label: 'Newsroom', Icon: Radio, active: 'bg-red-600 text-white shadow-sm shadow-red-600/30' },
  { id: 'relax', label: 'Relax', Icon: Sparkles, active: 'bg-teal-600 text-white shadow-sm shadow-teal-600/30' }
];

export const Header: React.FC<HeaderProps> = ({
  activeTab,
  setActiveTab,
  onDiscover,
  isDiscovering,
  selectedCountry = 'US',
  onSelectCountry,
  hasAiVideo,
  userName
}) => {
  const [servicesOpen, setServicesOpen] = useState(false);
  const countries = [
    { code: 'US', label: 'United States' },
    { code: 'GB', label: 'United Kingdom' },
    { code: 'CA', label: 'Canada' },
    { code: 'DE', label: 'Germany' },
    { code: 'FR', label: 'France' },
    { code: 'JP', label: 'Japan' }
  ];

  const tabBtn = (t: (typeof TABS)[number], opts?: { iconOnly?: boolean }) => {
    const isActive = activeTab === t.id;
    const Icon = t.Icon;
    return (
      <button
        key={t.id}
        onClick={() => setActiveTab(t.id)}
        title={t.label}
        aria-label={t.label}
        aria-current={isActive ? 'page' : undefined}
        className={`relative flex items-center gap-1.5 rounded-lg text-xs font-semibold transition-all ${
          opts?.iconOnly ? 'p-2.5' : 'px-2.5 sm:px-3 py-1.5'
        } ${
          isActive
            ? t.active
            : 'text-slate-400 hover:text-slate-100 hover:bg-slate-800/60'
        }`}
      >
        <Icon className="w-4 h-4 shrink-0" />
        {!opts?.iconOnly && <span className="hidden lg:inline">{t.label}</span>}

      </button>
    );
  };

  return (
    <>
      <header className="border-b border-slate-800/80 bg-slate-900/90 backdrop-blur sticky top-0 z-40">
        <div className="max-w-7xl mx-auto px-4 sm:px-6 lg:px-8">
          {/* Row 1: brand + actions */}
          <div className="flex items-center justify-between h-14 gap-2">
            <div className="flex items-center gap-2 min-w-0">
              <div className="w-8 h-8 rounded-xl bg-gradient-to-br from-red-500 via-rose-500 to-amber-500 flex items-center justify-center shadow-md shadow-red-500/30 shrink-0">
                <Zap className="w-4 h-4 text-white fill-current" />
              </div>
              <div className="min-w-0">
                <div className="text-sm font-black text-white tracking-tight leading-none">
                  YouTube Uploader
                </div>
                <div className="text-[10px] font-mono text-slate-500 uppercase tracking-widest hidden sm:block">
                  Upload & Publish
                </div>
              </div>
            </div>

            <div className="flex items-center gap-2">
              {activeTab === 'dashboard' && (
                <button
                  onClick={onDiscover}
                  disabled={isDiscovering}
                  className="p-2 sm:px-3 sm:py-1.5 rounded-lg bg-slate-800/80 border border-slate-700 text-slate-300 hover:bg-slate-700 text-xs font-semibold flex items-center gap-1.5 transition-all disabled:opacity-50"
                  title="Sync live Google Trends RSS feed"
                  aria-label="Sync live Google Trends RSS feed"
                >
                  <RefreshCw className={`w-4 h-4 text-amber-400 ${isDiscovering ? 'animate-spin' : ''}`} />
                  <span className="hidden sm:inline">Sync RSS</span>
                </button>
              )}

              {userName && (
                <button
                  onClick={() => setActiveTab('settings')}
                  className={`flex items-center gap-1.5 pl-2 pr-2.5 py-1.5 text-xs font-semibold rounded-lg border transition-all ${
                    activeTab === 'settings'
                      ? 'bg-red-600 border-red-600 text-white shadow-sm shadow-red-600/30'
                      : 'bg-slate-950/70 border-slate-800 text-slate-300 hover:border-slate-600'
                  }`}
                  title="Profile"
                >
                  <span className="w-6 h-6 rounded-full bg-gradient-to-br from-red-500 to-amber-500 flex items-center justify-center text-[10px] font-black text-white shrink-0">
                    {userName[0]?.toUpperCase()}
                  </span>
                  <span className="font-bold max-w-[6rem] truncate hidden xs:inline sm:inline">{userName}</span>
                </button>
              )}
            </div>
          </div>

            {/* Row 2: desktop tabs */}
            <nav className="hidden md:flex items-center gap-1 pb-2" aria-label="Primary">
              {TABS.map(t => tabBtn(t))}
            </nav>
        </div>
      </header>

      {/* Mobile bottom navigation: icons only, all tabs */}
      <nav
        className="md:hidden fixed bottom-0 inset-x-0 z-50 bg-slate-900/95 backdrop-blur border-t border-slate-800"
        aria-label="Primary mobile"
      >
        <div className="grid grid-cols-3 gap-0.5 px-1 pt-1 pb-[calc(0.25rem+env(safe-area-inset-bottom))]">
          {TABS.map(t => {
            const isActive = activeTab === t.id;
            const Icon = t.Icon;
            return (
              <button
                key={t.id}
                onClick={() => setActiveTab(t.id)}
                title={t.label}
                aria-label={t.label}
                aria-current={isActive ? 'page' : undefined}
                className={`relative flex items-center justify-center py-2.5 rounded-xl transition-all ${
                  isActive ? 'text-white bg-slate-800' : 'text-slate-500 active:text-slate-200'
                }`}
              >
                {isActive && (
                  <span className="absolute -top-1 left-1/2 -translate-x-1/2 w-8 h-1 rounded-full bg-gradient-to-r from-red-500 to-amber-500" />
                )}
                <Icon className={`w-5 h-5 ${isActive ? 'scale-110' : ''} transition-transform`} />

              </button>
            );
          })}
        </div>
      </nav>
    </>
  );
};
