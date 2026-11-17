import React, { useState, useEffect } from 'react';
import {
  Youtube,
  ShieldCheck,
  CheckCircle2,
  AlertCircle,
  ExternalLink,
  Lock,
  Globe,
  EyeOff,
  RefreshCw,
  Sparkles,
  Copy,
  Check,
  Link,
  Unlink
} from 'lucide-react';
import { YouTubeChannelConfig } from '../types';

interface YouTubeSettingsModalProps {
  isOpen: boolean;
  onClose: () => void;
  onConfigSaved?: (config: YouTubeChannelConfig) => void;
}

// One login, saved forever: the channel tokens live per-user in the backend
// database (never in the browser). Connecting once is enough — publishing
// afterwards is one click, even after restarts.
export const YouTubeSettingsModal: React.FC<YouTubeSettingsModalProps> = ({
  isOpen,
  onClose,
  onConfigSaved
}) => {
  const [config, setConfig] = useState<YouTubeChannelConfig>({
    channelId: '',
    channelTitle: 'Not connected',
    channelThumbnail: '',
    subscriberCount: '',
    privacyStatus: 'unlisted',
    connected: false
  });

  const [isLoading, setIsLoading] = useState<boolean>(false);
  const [isConnectingOAuth, setIsConnectingOAuth] = useState<boolean>(false);
  const [isTesting, setIsTesting] = useState<boolean>(false);
  const [testResult, setTestResult] = useState<{ success: boolean; message: string } | null>(null);
  const [saveSuccess, setSaveSuccess] = useState<boolean>(false);
  const [copiedUri, setCopiedUri] = useState<string | null>(null);
  // Real callback URI as the server builds it (APP_URL-aware, incl. the
  // /trendlogic prefix behind the portal). Shown/copied instead of the
  // client-side origin guess so Google never sees a mismatch.
  const [serverCallbackUrl, setServerCallbackUrl] = useState<string | null>(null);

  const devCallbackUrl = typeof window !== 'undefined'
    ? `${window.location.origin}/auth/callback`
    : 'https://bidbes.com/trendlogic/auth/callback';

  useEffect(() => {
    if (isOpen) {
      fetchConfig();
      fetch(`/api/youtube/oauth/url?origin=${encodeURIComponent(window.location.origin)}`)
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
      if (event.data?.type === 'OAUTH_AUTH_SUCCESS') {
        setIsConnectingOAuth(false);
        fetchConfig();
        setTestResult({
          success: true,
          message: `YouTube channel "${event.data.channel?.title || 'Your Channel'}" connected and saved — no need to log in again!`
        });
      }
    };

    window.addEventListener('message', handleMessage);
    return () => window.removeEventListener('message', handleMessage);
  }, []);

  const applyConfig = (cfg: Partial<YouTubeChannelConfig>) => {
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
      const res = await fetch('/api/youtube/config');
      if (res.ok) {
        const data = await res.json();
        if (data.config) {
          applyConfig(data.config);
        }
      }
    } catch (err) {
      console.warn('Failed to fetch YouTube config', err);
    } finally {
      setIsLoading(false);
    }
  };

  const handleConnectOAuth = async () => {
    setIsConnectingOAuth(true);
    setTestResult(null);

    try {
      const res = await fetch(`/api/youtube/oauth/url?origin=${encodeURIComponent(window.location.origin)}`);
      const data = await res.json();

      if (!data.url) {
        throw new Error('Failed to generate OAuth URL');
      }

      // Open Google OAuth popup directly
      const authWindow = window.open(
        data.url,
        'youtube_oauth_popup',
        'width=600,height=720,status=no,toolbar=no,menubar=no'
      );

      if (!authWindow) {
        alert('Please enable popups in your browser to authorize your YouTube account.');
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
      const res = await fetch('/api/youtube/disconnect', { method: 'POST' });
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
      message: 'Channel disconnected from your account.'
    });
  };

  const handleTestConnection = async () => {
    setIsTesting(true);
    setTestResult(null);
    try {
      const res = await fetch('/api/youtube/test', { method: 'POST' });
      const data = await res.json();
      setTestResult({
        success: data.success,
        message: data.message || (data.success ? 'YouTube connection verified!' : 'Connection failed')
      });
      if (data.channel) {
        applyConfig({
          connected: true,
          channelTitle: data.channel.title || config.channelTitle,
          channelId: data.channel.id || config.channelId,
          subscriberCount: data.channel.subscribers || config.subscriberCount
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
      const res = await fetch('/api/youtube/config', {
        method: 'POST',
        headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify({ privacyStatus: config.privacyStatus })
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
            <div className="w-10 h-10 rounded-2xl bg-red-600/20 border border-red-500/30 flex items-center justify-center text-red-400">
              <Youtube className="w-6 h-6" />
            </div>
            <div>
              <h2 className="text-base font-black text-white uppercase font-mono tracking-wide">
                YouTube Channel
              </h2>
              <p className="text-xs text-slate-400 mt-0.5">
                Log in once — your channel stays saved for one-click publishing.
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

        {/* Live Channel Status Box */}
        <div className="p-4 rounded-2xl bg-slate-950/90 border border-slate-800 flex items-center justify-between">
          <div className="flex items-center gap-3">
            <div className={`w-3.5 h-3.5 rounded-full ${config.connected ? 'bg-emerald-400 animate-pulse' : 'bg-amber-400'}`} />
            <div>
              <span className="text-xs font-bold text-white block">
                {config.connected ? (config.channelTitle || 'YouTube Channel') : 'No channel linked'}
              </span>
              <span className="text-[11px] text-slate-400 font-mono">
                {config.connected
                  ? `Saved • ${config.subscriberCount ? `${config.subscriberCount} Subscribers • ` : ''}ready to publish`
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
        <div className="p-4 rounded-2xl bg-gradient-to-br from-red-950/40 via-slate-900 to-slate-900 border border-red-900/40 space-y-3">
          <div className="flex items-center justify-between">
            <span className="text-xs font-bold text-white uppercase font-mono flex items-center gap-1.5">
              <Sparkles className="w-4 h-4 text-amber-400" />
              <span>{config.connected ? 'Channel linked & saved' : '1-Click Google Login'}</span>
            </span>
            <span className="text-[10px] text-slate-400 font-mono flex items-center gap-1">
              <ShieldCheck className="w-3 h-3 text-emerald-400" />
              Saved per account
            </span>
          </div>

          <p className="text-xs text-slate-300 leading-relaxed">
            {config.connected
              ? 'Your login is saved in your account. Publishing works with one click — even after restarts. Reconnect only if you change channels.'
              : 'Sign in with Google once. Your channel is saved to your account, so every later publish is one click — no repeated logins.'}
          </p>

          <button
            type="button"
            onClick={handleConnectOAuth}
            disabled={isConnectingOAuth || isLoading}
            className="w-full py-3 rounded-xl bg-gradient-to-r from-red-600 via-rose-600 to-amber-600 hover:brightness-110 text-white font-black text-xs uppercase tracking-wider flex items-center justify-center gap-2.5 shadow-lg shadow-red-600/30 transition-all active:scale-95 disabled:opacity-50"
          >
            <Youtube className="w-4 h-4" />
            <span>
              {isConnectingOAuth
                ? 'Authorizing in popup...'
                : config.connected
                  ? 'Reconnect / Switch Channel'
                  : 'Connect YouTube Account (Google Login)'}
            </span>
            <ExternalLink className="w-3.5 h-3.5" />
          </button>
        </div>

        {/* Authorized Redirect URI (setup help, no secrets) */}
        <div className="p-3.5 rounded-2xl bg-slate-950 border border-slate-800 space-y-2.5">
          <div className="flex items-center justify-between">
            <span className="text-[11px] font-bold uppercase font-mono text-slate-300 flex items-center gap-1">
              <Link className="w-3.5 h-3.5 text-sky-400" />
              <span>Authorized Redirect URI (Google Cloud Console)</span>
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
            Add this URL to "Authorized redirect URIs" in Google Cloud Console &gt; Credentials &gt; OAuth 2.0 Client IDs.
          </p>
        </div>

        {/* Privacy Default */}
        <div>
          <label className="text-xs font-bold uppercase font-mono text-slate-300 block mb-2">
            Default Upload Privacy Status
          </label>
          <div className="grid grid-cols-3 gap-2">
            {[
              { id: 'unlisted', label: 'Unlisted', desc: 'Direct link only (Recommended)', icon: EyeOff },
              { id: 'public', label: 'Public', desc: 'Live immediately to subscribers', icon: Globe },
              { id: 'private', label: 'Private', desc: 'Only visible to your channel', icon: Lock }
            ].map(opt => {
              const Icon = opt.icon;
              const isSelected = config.privacyStatus === opt.id;
              return (
                <button
                  key={opt.id}
                  type="button"
                  onClick={() => setConfig(prev => ({ ...prev, privacyStatus: opt.id as any }))}
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
              className="px-5 py-2 rounded-xl bg-red-600 hover:bg-red-500 text-white text-xs font-bold flex items-center gap-2 shadow-lg shadow-red-600/30 transition-all"
            >
              {saveSuccess ? (
                <>
                  <CheckCircle2 className="w-4 h-4" />
                  <span>Saved!</span>
                </>
              ) : (
                <>
                  <Youtube className="w-4 h-4" />
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
