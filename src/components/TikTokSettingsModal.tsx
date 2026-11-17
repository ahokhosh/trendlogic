import React, { useState, useEffect } from 'react';
import {
  Music2,
  ShieldCheck,
  CheckCircle2,
  AlertCircle,
  ExternalLink,
  Lock,
  Globe,
  RefreshCw,
  Sparkles,
  Copy,
  Check,
  Link,
  Unlink
} from 'lucide-react';
import { TikTokAccountConfig } from '../types';

interface TikTokSettingsModalProps {
  isOpen: boolean;
  onClose: () => void;
  onConfigSaved?: (config: TikTokAccountConfig) => void;
}

// One login, saved forever: the TikTok tokens live per-user in the backend
// database (never in the browser). Connecting once is enough — publishing
// afterwards is one click, even after restarts.
export const TikTokSettingsModal: React.FC<TikTokSettingsModalProps> = ({
  isOpen,
  onClose,
  onConfigSaved
}) => {
  const [config, setConfig] = useState<TikTokAccountConfig>({
    displayName: 'Not connected',
    avatarUrl: '',
    privacyLevel: 'PUBLIC_TO_EVERYONE',
    connected: false
  });

  const [isLoading, setIsLoading] = useState<boolean>(false);
  const [isConnectingOAuth, setIsConnectingOAuth] = useState<boolean>(false);
  const [isTesting, setIsTesting] = useState<boolean>(false);
  const [testResult, setTestResult] = useState<{ success: boolean; message: string } | null>(null);
  const [saveSuccess, setSaveSuccess] = useState<boolean>(false);
  const [copiedUri, setCopiedUri] = useState<string | null>(null);
  // Real callback URI as the server builds it (TIKTOK_REDIRECT_URI wins, else
  // APP_URL-aware). Register EXACTLY this string in the TikTok app dashboard.
  const [serverCallbackUrl, setServerCallbackUrl] = useState<string | null>(null);
  const [serverConfigured, setServerConfigured] = useState<boolean>(true);

  const devCallbackUrl = typeof window !== 'undefined'
    ? `${window.location.origin}/tiktok/callback`
    : 'https://bidbes.com/trendlogic/tiktok/callback';

  useEffect(() => {
    if (isOpen) {
      fetchConfig();
      fetch(`/api/tiktok/oauth/url?origin=${encodeURIComponent(window.location.origin)}`)
        .then((r) => (r.ok ? r.json() : null))
        .then((d) => {
          if (d?.redirectUri) setServerCallbackUrl(d.redirectUri);
        })
        .catch(() => {
          /* devCallbackUrl fallback stays */
        });
    }
  }, [isOpen]);

  // Listen for OAuth completion message from the popup
  useEffect(() => {
    const handleMessage = (event: MessageEvent) => {
      if (event.data?.type === 'TIKTOK_AUTH_SUCCESS') {
        setIsConnectingOAuth(false);
        fetchConfig();
        setTestResult({
          success: true,
          message: `TikTok account "${event.data.profile?.displayName || 'Your Account'}" connected and saved — no need to log in again!`
        });
      }
    };

    window.addEventListener('message', handleMessage);
    return () => window.removeEventListener('message', handleMessage);
  }, []);

  const applyConfig = (cfg: Partial<TikTokAccountConfig>) => {
    setConfig(prev => {
      const merged = { ...prev, ...cfg };
      if (onConfigSaved) {
        onConfigSaved(merged);
      }
      return merged;
    });
  };

  const fetchConfig = async () => {
    setIsLoading(true);
    try {
      const res = await fetch('/api/tiktok/config');
      if (res.ok) {
        const data = await res.json();
        if (data.config) {
          applyConfig(data.config);
        }
        if (data.configured === false) setServerConfigured(false);
      }
    } catch (err) {
      console.warn('Failed to fetch TikTok config', err);
    } finally {
      setIsLoading(false);
    }
  };

  const handleConnectOAuth = async () => {
    setIsConnectingOAuth(true);
    setTestResult(null);

    try {
      const res = await fetch(`/api/tiktok/oauth/url?origin=${encodeURIComponent(window.location.origin)}`);
      const data = await res.json();

      if (!data.url) {
        throw new Error(data.error || 'Failed to generate OAuth URL');
      }

      const authWindow = window.open(
        data.url,
        'tiktok_oauth_popup',
        'width=600,height=720,status=no,toolbar=no,menubar=no'
      );

      if (!authWindow) {
        alert('Please enable popups in your browser to authorize your TikTok account.');
        setIsConnectingOAuth(false);
      }
    } catch (err: any) {
      setTestResult({
        success: false,
        message: `Failed to initiate OAuth: ${err.message}`
      });
      setIsConnectingOAuth(false);
    }
  };

  const handleDisconnect = async () => {
    try {
      const res = await fetch('/api/tiktok/disconnect', { method: 'POST' });
      if (res.ok) {
        const data = await res.json();
        if (data.config) {
          applyConfig(data.config);
        }
      }
    } catch {
      /* best effort */
    }
    setTestResult({
      success: true,
      message: 'TikTok account disconnected.'
    });
  };

  const handleTestConnection = async () => {
    setIsTesting(true);
    setTestResult(null);
    try {
      const res = await fetch('/api/tiktok/test', { method: 'POST' });
      const data = await res.json();
      setTestResult({
        success: data.success,
        message: data.message || (data.success ? 'TikTok connection verified!' : 'Connection failed')
      });
      if (data.profile) {
        applyConfig({
          connected: true,
          displayName: data.profile.displayName || config.displayName
        });
      }
    } catch (err: any) {
      setTestResult({
        success: false,
        message: `Error testing connection: ${err.message}`
      });
    } finally {
      setIsTesting(false);
    }
  };

  const handleSave = async () => {
    try {
      const res = await fetch('/api/tiktok/config', {
        method: 'POST',
        headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify({ privacyLevel: config.privacyLevel })
      });
      if (res.ok) {
        const data = await res.json();
        if (data.config) {
          applyConfig(data.config);
        }
        setSaveSuccess(true);
        setTimeout(() => {
          setSaveSuccess(false);
          onClose();
        }, 1200);
      }
    } catch (err) {
      console.error('Save error', err);
    }
  };

  const copyToClipboard = (text: string, key: string) => {
    navigator.clipboard.writeText(text);
    setCopiedUri(key);
    setTimeout(() => setCopiedUri(null), 2000);
  };

  if (!isOpen) return null;

  return (
    <div className="fixed inset-0 z-50 bg-black/80 backdrop-blur-sm flex items-center justify-center p-4">
      <div className="bg-slate-900 border border-slate-800 rounded-3xl max-w-xl w-full p-6 space-y-6 shadow-2xl overflow-hidden max-h-[92vh] overflow-y-auto">
        {/* Header */}
        <div className="flex items-start justify-between border-b border-slate-800 pb-4">
          <div className="flex items-center gap-3">
            <div className="w-10 h-10 rounded-2xl bg-cyan-600/20 border border-cyan-500/30 flex items-center justify-center text-cyan-400">
              <Music2 className="w-6 h-6" />
            </div>
            <div>
              <h2 className="text-base font-black text-white uppercase font-mono tracking-wide">
                TikTok Account
              </h2>
              <p className="text-xs text-slate-400 mt-0.5">
                Log in once — your account stays saved for one-click publishing.
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

        {!serverConfigured && (
          <div className="p-3 rounded-xl border bg-amber-950/40 border-amber-800 text-amber-300 flex items-start gap-2.5 text-xs">
            <AlertCircle className="w-4 h-4 text-amber-400 mt-0.5 shrink-0" />
            <span>Server keys missing (TIKTOK_CLIENT_KEY / TIKTOK_CLIENT_SECRET) — ask the admin to set them, then connect.</span>
          </div>
        )}

        {/* Account Status Box */}
        <div className="p-4 rounded-2xl bg-slate-950/90 border border-slate-800 flex items-center justify-between">
          <div className="flex items-center gap-3">
            <div className={`w-3.5 h-3.5 rounded-full ${config.connected ? 'bg-emerald-400 animate-pulse' : 'bg-amber-400'}`} />
            <div>
              <span className="text-xs font-bold text-white block">
                {config.connected ? (config.displayName || 'TikTok Account') : 'No account linked'}
              </span>
              <span className="text-[11px] text-slate-400 font-mono">
                {config.connected
                  ? 'Saved • ready to publish'
                  : 'Log in once, publish forever'}
              </span>
            </div>
          </div>

          {config.connected ? (
            <button
              type="button"
              onClick={handleDisconnect}
              className="px-2.5 py-1 rounded-lg bg-slate-800 hover:bg-slate-700 text-slate-400 hover:text-rose-400 text-[11px] font-semibold flex items-center gap-1 transition-colors"
            >
              <Unlink className="w-3 h-3" />
              <span>Disconnect</span>
            </button>
          ) : (
            <span className="px-2.5 py-1 rounded-full bg-amber-500/10 border border-amber-500/30 text-amber-400 text-[11px] font-bold font-mono">
              NOT LINKED
            </span>
          )}
        </div>

        {/* Primary OAuth Action Button */}
        <div className="p-4 rounded-2xl bg-gradient-to-br from-cyan-950/40 via-slate-900 to-slate-900 border border-cyan-900/40 space-y-3">
          <div className="flex items-center justify-between">
            <span className="text-xs font-bold text-white uppercase font-mono flex items-center gap-1.5">
              <Sparkles className="w-4 h-4 text-cyan-400" />
              <span>{config.connected ? 'Account linked & saved' : '1-Click TikTok Login'}</span>
            </span>
            <span className="text-[10px] text-slate-400 font-mono flex items-center gap-1">
              <ShieldCheck className="w-3 h-3 text-emerald-400" />
              Saved per account
            </span>
          </div>

          <p className="text-xs text-slate-300 leading-relaxed">
            {config.connected
              ? 'Your login is saved in your account. Publishing works with one click — even after restarts.'
              : 'Authorize with TikTok once. Your account is saved, so every later publish is one click.'}
          </p>

          <button
            type="button"
            onClick={handleConnectOAuth}
            disabled={isConnectingOAuth || isLoading}
            className="w-full py-3 rounded-xl bg-gradient-to-r from-cyan-600 via-sky-600 to-fuchsia-600 hover:brightness-110 text-white font-black text-xs uppercase tracking-wider flex items-center justify-center gap-2.5 shadow-lg shadow-cyan-600/30 transition-all active:scale-95 disabled:opacity-50"
          >
            <Music2 className="w-4 h-4" />
            <span>
              {isConnectingOAuth
                ? 'Authorizing in popup...'
                : config.connected
                  ? 'Reconnect / Switch Account'
                  : 'Connect TikTok Account'}
            </span>
            <ExternalLink className="w-3.5 h-3.5" />
          </button>
        </div>

        {/* Redirect URI (setup help, no secrets) */}
        <div className="p-3.5 rounded-2xl bg-slate-950 border border-slate-800 space-y-2.5">
          <div className="flex items-center justify-between">
            <span className="text-[11px] font-bold uppercase font-mono text-slate-300 flex items-center gap-1">
              <Link className="w-3.5 h-3.5 text-sky-400" />
              <span>Redirect URI (TikTok App Dashboard)</span>
            </span>
          </div>

          <div className="flex items-center justify-between p-2 rounded-lg bg-slate-900 border border-slate-800 font-mono text-[11px]">
            <span className="text-slate-300 truncate mr-2">{serverCallbackUrl || devCallbackUrl}</span>
            <button
              type="button"
              onClick={() => copyToClipboard(serverCallbackUrl || devCallbackUrl, 'dev')}
              className="px-2 py-0.5 rounded bg-slate-800 hover:bg-slate-700 text-slate-200 text-[10px] flex items-center gap-1 shrink-0"
            >
              {copiedUri === 'dev' ? <Check className="w-3 h-3 text-emerald-400" /> : <Copy className="w-3 h-3" />}
              <span>{copiedUri === 'dev' ? 'Copied' : 'Copy'}</span>
            </button>
          </div>
          <p className="text-[10px] text-slate-500 leading-tight">
            Add this URL to "Redirect URI" in developers.tiktok.com &gt; your app &gt; Login Kit. While the app is unaudited, also add your TikTok account as a test user and use Private (SELF_ONLY) posts.
          </p>
        </div>

        {/* Privacy Default (TikTok has no Unlisted — Public or Private) */}
        <div>
          <label className="text-xs font-bold uppercase font-mono text-slate-300 block mb-2">
            Default TikTok Privacy
          </label>
          <div className="grid grid-cols-2 gap-2">
            {[
              { id: 'PUBLIC_TO_EVERYONE', label: 'Public', desc: 'Live on your profile', icon: Globe },
              { id: 'SELF_ONLY', label: 'Private', desc: 'Only you (works before audit)', icon: Lock }
            ].map(opt => {
              const Icon = opt.icon;
              const isSelected = config.privacyLevel === opt.id;
              return (
                <button
                  key={opt.id}
                  type="button"
                  onClick={() => setConfig(prev => ({ ...prev, privacyLevel: opt.id as any }))}
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
                  <span className="text-[10px] text-slate-500 block mt-1 leading-tight">
                    {opt.desc}
                  </span>
                </button>
              );
            })}
          </div>
        </div>

        {/* Test Status feedback */}
        {testResult && (
          <div
            className={`p-3 rounded-xl border flex items-start gap-2.5 text-xs ${
              testResult.success
                ? 'bg-emerald-950/40 border-emerald-800 text-emerald-300'
                : 'bg-amber-950/40 border-amber-800 text-amber-300'
            }`}
          >
            {testResult.success ? (
              <CheckCircle2 className="w-4 h-4 text-emerald-400 mt-0.5 shrink-0" />
            ) : (
              <AlertCircle className="w-4 h-4 text-amber-400 mt-0.5 shrink-0" />
            )}
            <span>{testResult.message}</span>
          </div>
        )}

        {/* Footer Actions */}
        <div className="flex items-center justify-between pt-4 border-t border-slate-800">
          <button
            type="button"
            onClick={handleTestConnection}
            disabled={isTesting}
            className="px-3.5 py-2 rounded-xl bg-slate-800 hover:bg-slate-700 text-xs font-semibold text-slate-300 flex items-center gap-1.5 transition-colors"
          >
            <RefreshCw className={`w-3.5 h-3.5 ${isTesting ? 'animate-spin' : ''}`} />
            <span>{isTesting ? 'Checking...' : 'Test Connection'}</span>
          </button>

          <div className="flex items-center gap-2">
            <button
              type="button"
              onClick={onClose}
              className="px-4 py-2 rounded-xl bg-slate-800 hover:bg-slate-700 text-white text-xs font-semibold transition-colors"
            >
              Close
            </button>

            <button
              type="button"
              onClick={handleSave}
              className="px-5 py-2 rounded-xl bg-cyan-600 hover:bg-cyan-500 text-white text-xs font-bold flex items-center gap-2 shadow-lg shadow-cyan-600/30 transition-all"
            >
              {saveSuccess ? (
                <>
                  <CheckCircle2 className="w-4 h-4" />
                  <span>Saved!</span>
                </>
              ) : (
                <>
                  <Music2 className="w-4 h-4" />
                  <span>Save</span>
                </>
              )}
            </button>
          </div>
        </div>
      </div>
    </div>
  );
};
