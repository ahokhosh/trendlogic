import React, { useState, useEffect } from 'react';
import {
  Radio,
  ShieldCheck,
  Youtube,
  User,
  Pencil,
  X,
  Mail,
  LogOut,
  CheckCircle2,
  AlertCircle,
  RefreshCw,
  ExternalLink,
  Sparkles,
  Copy,
  Check,
  Link,
  Unlink,
  Lock,
  Globe,
  EyeOff
} from 'lucide-react';
import { TrendProviderConfig, PipelineSettings, YouTubeChannelConfig } from '../types';
import type { AuthUser } from './AuthPage';

interface ProvidersSettingsViewProps {
  providers: TrendProviderConfig[];
  onToggleProvider: (id: string, active: boolean) => void;
  settings: PipelineSettings;
  onUpdateSettings: (newSettings: Partial<PipelineSettings>) => void;
  userName?: string;
  userEmail?: string;
  onLogout?: () => void;
  onProfileUpdate?: (user: AuthUser) => void;
  /** Manager-only entry into the Admin Panel — the button below renders
   *  only when this is true, so ordinary users never see it. */
  isAdmin?: boolean;
  onOpenAdmin?: () => void;
}

/** Full YouTube channel connection — moved here from the Studio toolbar so
 *  the Profile tab owns channel setup end-to-end (connect, test, privacy,
 *  redirect URI). Publishing elsewhere reuses this saved connection. */
const YouTubeConnectionCard: React.FC<{
  onConfigChange?: (config: YouTubeChannelConfig) => void;
}> = ({ onConfigChange }) => {
  const [config, setConfig] = useState<YouTubeChannelConfig>({
    channelId: '',
    channelTitle: 'Not connected',
    channelThumbnail: '',
    subscriberCount: '',
    privacyStatus: 'public',
    connected: false
  });
  const [isLoading, setIsLoading] = useState(true);
  const [isConnectingOAuth, setIsConnectingOAuth] = useState(false);
  const [isTesting, setIsTesting] = useState(false);
  const [isSaving, setIsSaving] = useState(false);
  const [testResult, setTestResult] = useState<{ success: boolean; message: string } | null>(null);
  const [saveSuccess, setSaveSuccess] = useState(false);
  const [copied, setCopied] = useState(false);
  const [serverCallbackUrl, setServerCallbackUrl] = useState<string | null>(null);

  const devCallbackUrl = typeof window !== 'undefined'
    ? `${window.location.origin}/auth/callback`
    : 'https://bidbes.com/trendlogic/auth/callback';

  const applyConfig = (cfg: Partial<YouTubeChannelConfig>) => {
    setConfig(prev => {
      const merged = { ...prev, ...cfg };
      onConfigChange?.(merged);
      return merged;
    });
  };

  const fetchConfig = async () => {
    setIsLoading(true);
    try {
      const res = await fetch('/api/youtube/config');
      if (res.ok) {
        const data = await res.json();
        if (data.config) applyConfig(data.config);
      }
    } catch {
      /* stays disconnected */
    } finally {
      setIsLoading(false);
    }
  };

  useEffect(() => {
    fetchConfig();
    fetch(`/api/youtube/oauth/url?origin=${encodeURIComponent(window.location.origin)}`)
      .then(r => (r.ok ? r.json() : null))
      .then(d => {
        if (d?.redirectUri) setServerCallbackUrl(d.redirectUri);
      })
      .catch(() => {});
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, []);

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
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, []);

  const handleConnectOAuth = async () => {
    setIsConnectingOAuth(true);
    setTestResult(null);
    try {
      const res = await fetch(`/api/youtube/oauth/url?origin=${encodeURIComponent(window.location.origin)}`);
      const data = await res.json();
      if (!data.url) throw new Error('Failed to generate OAuth URL');
      const authWindow = window.open(data.url, 'youtube_oauth_popup', 'width=600,height=720,status=no,toolbar=no,menubar=no');
      if (!authWindow) {
        alert('Please enable popups in your browser to authorize your YouTube account.');
        setIsConnectingOAuth(false);
      }
    } catch (err: any) {
      setTestResult({ success: false, message: `Failed to initiate OAuth: ${err.message}` });
      setIsConnectingOAuth(false);
    }
  };

  const handleDisconnect = async () => {
    try {
      const res = await fetch('/api/youtube/disconnect', { method: 'POST' });
      if (res.ok) {
        const data = await res.json();
        if (data.config) applyConfig(data.config);
      }
    } catch {
      /* best effort */
    }
    setTestResult({ success: true, message: 'Channel disconnected from your account.' });
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
      setTestResult({ success: false, message: `Error testing connection: ${err.message}` });
    } finally {
      setIsTesting(false);
    }
  };

  const handleSave = async () => {
    setIsSaving(true);
    try {
      const res = await fetch('/api/youtube/config', {
        method: 'POST',
        headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify({ privacyStatus: config.privacyStatus })
      });
      if (res.ok) {
        const data = await res.json();
        if (data.config) applyConfig(data.config);
        setSaveSuccess(true);
        setTimeout(() => setSaveSuccess(false), 2000);
      }
    } catch {
      /* silent */
    } finally {
      setIsSaving(false);
    }
  };

  const copyUri = () => {
    navigator.clipboard.writeText(serverCallbackUrl || devCallbackUrl);
    setCopied(true);
    setTimeout(() => setCopied(false), 2000);
  };

  return (
    <div className="bg-slate-900 border border-slate-800 rounded-3xl p-5 sm:p-6 space-y-4">
      <div className="flex flex-wrap items-center justify-between gap-3">
        <div className="flex items-center gap-2.5">
          <div className="w-10 h-10 rounded-2xl bg-red-600/15 border border-red-500/30 flex items-center justify-center text-red-400 shrink-0">
            <Youtube className="w-5 h-5" />
          </div>
          <div>
            <h3 className="text-sm font-black text-white uppercase font-mono">YouTube Channel</h3>
            <p className="text-[11px] text-slate-400">Connect once — every publish afterwards is one click.</p>
          </div>
        </div>
        <span className={`px-2.5 py-1 rounded-full text-[11px] font-bold font-mono border ${
          config.connected
            ? 'bg-emerald-500/10 border-emerald-500/30 text-emerald-300'
            : 'bg-amber-500/10 border-amber-500/30 text-amber-300'
        }`}>
          {isLoading ? 'CHECKING…' : config.connected ? '● CONNECTED' : '○ NOT LINKED'}
        </span>
      </div>

      {/* Connect / status */}
      <div className="p-4 rounded-2xl bg-gradient-to-br from-red-950/40 via-slate-900 to-slate-900 border border-red-900/40 space-y-3">
        {config.connected ? (
          <div className="flex flex-wrap items-center justify-between gap-3">
            <div className="flex items-center gap-3 min-w-0">
              {config.channelThumbnail ? (
                <img src={config.channelThumbnail} alt="" loading="lazy" referrerPolicy="no-referrer"
                  onError={e => { (e.target as HTMLImageElement).style.display = 'none'; }}
                  className="w-11 h-11 rounded-full object-cover border border-red-500/40 shrink-0" />
              ) : (
                <div className="w-11 h-11 rounded-full bg-gradient-to-br from-red-500 to-amber-500 flex items-center justify-center text-white font-black shrink-0">
                  {(config.channelTitle || 'Y')[0]?.toUpperCase()}
                </div>
              )}
              <div className="min-w-0">
                <div className="text-sm font-black text-white truncate" dir="auto">{config.channelTitle}</div>
                <div className="text-[11px] text-slate-400 font-mono">
                  {config.subscriberCount ? `${config.subscriberCount} subscribers • ` : ''}saved — ready to publish
                </div>
              </div>
            </div>
            <button
              type="button"
              onClick={handleDisconnect}
              className="px-3 py-1.5 rounded-lg bg-slate-800 hover:bg-slate-700 text-slate-400 hover:text-rose-400 text-[11px] font-semibold flex items-center gap-1 transition-colors"
            >
              <Unlink className="w-3.5 h-3.5" />
              <span>Disconnect</span>
            </button>
          </div>
        ) : (
          <p className="text-xs text-slate-300 leading-relaxed">
            Sign in with Google once. Your channel is saved to your account, so every later publish is one click — no repeated logins.
          </p>
        )}
        <button
          type="button"
          onClick={handleConnectOAuth}
          disabled={isConnectingOAuth || isLoading}
          className="w-full py-3 rounded-xl bg-red-600 hover:bg-red-700 text-white font-black text-xs uppercase tracking-wider flex items-center justify-center gap-2.5 shadow-lg shadow-red-600/30 transition-all active:scale-[0.99] disabled:opacity-50"
        >
          <Youtube className="w-4 h-4" />
          <span>
            {isConnectingOAuth
              ? 'Authorizing…'
              : config.connected
                ? 'Reconnect YouTube'
                : 'Connect YouTube'}
          </span>
        </button>
      </div>

      {/* Privacy default */}
      <div>
        <label className="text-[11px] font-bold uppercase font-mono text-slate-300 block mb-2">
          Default Upload Privacy
        </label>
        <div className="grid grid-cols-3 gap-2">
           {[
             { id: 'public', label: 'Public', desc: 'Live to subs', icon: Globe },
             { id: 'unlisted', label: 'Unlisted', desc: 'Link only', icon: EyeOff },
             { id: 'private', label: 'Private', desc: 'Only you', icon: Lock }
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
                <span className="text-[10px] text-slate-500 block mt-1 leading-tight">{opt.desc}</span>
              </button>
            );
          })}
        </div>
      </div>


      {testResult && (
        <div className={`p-3 rounded-xl border flex items-start gap-2.5 text-xs ${
          testResult.success
            ? 'bg-emerald-950/40 border-emerald-800 text-emerald-300'
            : 'bg-amber-950/40 border-amber-800 text-amber-300'
        }`}>
          {testResult.success
            ? <CheckCircle2 className="w-4 h-4 text-emerald-400 mt-0.5 shrink-0" />
            : <AlertCircle className="w-4 h-4 text-amber-400 mt-0.5 shrink-0" />}
          <span>{testResult.message}</span>
        </div>
      )}

      <div className="flex items-center justify-between gap-2 pt-1">
        <button
          type="button"
          onClick={handleTestConnection}
          disabled={isTesting}
          className="px-3.5 py-2 rounded-xl bg-slate-800 hover:bg-slate-700 text-xs font-semibold text-slate-300 flex items-center gap-1.5 transition-colors disabled:opacity-50"
        >
          <RefreshCw className={`w-3.5 h-3.5 ${isTesting ? 'animate-spin' : ''}`} />
          <span>{isTesting ? 'Checking…' : 'Test Connection'}</span>
        </button>
        <button
          type="button"
          onClick={handleSave}
          disabled={isSaving}
          className="px-5 py-2 rounded-xl bg-red-600 hover:bg-red-500 text-white text-xs font-bold flex items-center gap-2 shadow-lg shadow-red-600/30 transition-all disabled:opacity-50"
        >
          {saveSuccess ? (
            <>
              <CheckCircle2 className="w-4 h-4" />
              <span>Saved!</span>
            </>
          ) : (
            <>
              <Youtube className="w-4 h-4" />
              <span>{isSaving ? 'Saving…' : 'Save'}</span>
            </>
          )}
        </button>
      </div>
    </div>
  );
};

/** Self-service profile editor — opened only from the "Edit profile" button
 *  in the Profile hero (never rendered inline). Edits the display name and
 *  the sign-in email together, plus an optional password change. The session
 *  decides WHO changes — a user can only ever edit their own account. */
const EditProfileModal: React.FC<{
  isOpen: boolean;
  onClose: () => void;
  currentName?: string;
  userEmail?: string;
  onProfileUpdate?: (user: AuthUser) => void;
}> = ({ isOpen, onClose, currentName, userEmail, onProfileUpdate }) => {
  const [name, setName] = useState(currentName || '');
  const [email, setEmail] = useState(userEmail || '');
  const [profileSaving, setProfileSaving] = useState(false);
  const [profileMsg, setProfileMsg] = useState<{ ok: boolean; text: string } | null>(null);
  const [cur, setCur] = useState('');
  const [next, setNext] = useState('');
  const [confirm, setConfirm] = useState('');
  const [pwSaving, setPwSaving] = useState(false);
  const [pwMsg, setPwMsg] = useState<{ ok: boolean; text: string } | null>(null);

  useEffect(() => {
    if (isOpen) {
      setName(currentName || '');
      setEmail(userEmail || '');
      setProfileMsg(null);
      setPwMsg(null);
      setCur('');
      setNext('');
      setConfirm('');
    }
  }, [isOpen, currentName, userEmail]);

  useEffect(() => {
    if (!isOpen) return;
    const onKey = (e: KeyboardEvent) => {
      if (e.key === 'Escape') onClose();
    };
    window.addEventListener('keydown', onKey);
    return () => window.removeEventListener('keydown', onKey);
  }, [isOpen, onClose]);

  if (!isOpen) return null;

  const saveProfile = async () => {
    const cleanName = name.trim();
    const cleanEmail = email.trim().toLowerCase();
    if (!cleanName) {
      setProfileMsg({ ok: false, text: 'Please enter a display name.' });
      return;
    }
    if (!/^[^\s@]+@[^\s@]+\.[^\s@]+$/.test(cleanEmail)) {
      setProfileMsg({ ok: false, text: 'Please enter a valid email address.' });
      return;
    }
    if (cleanName === (currentName || '') && cleanEmail === (userEmail || '')) {
      setProfileMsg({ ok: false, text: 'No changes to save.' });
      return;
    }
    setProfileSaving(true);
    setProfileMsg(null);
    try {
      const res = await fetch('/api/auth/profile', {
        method: 'PUT',
        headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify({ name: cleanName, email: cleanEmail })
      });
      const data = await res.json().catch(() => null);
      if (!res.ok) throw new Error(data?.error || 'Could not save the profile.');
      if (data?.user) onProfileUpdate?.(data.user);
      setProfileMsg({ ok: true, text: 'Profile updated.' });
    } catch (err: any) {
      setProfileMsg({ ok: false, text: err?.message || 'Could not save the profile.' });
    } finally {
      setProfileSaving(false);
    }
  };

  const savePassword = async () => {
    if (!cur) {
      setPwMsg({ ok: false, text: 'Enter your current password.' });
      return;
    }
    if (next.length < 6) {
      setPwMsg({ ok: false, text: 'New password must be at least 6 characters.' });
      return;
    }
    if (next !== confirm) {
      setPwMsg({ ok: false, text: 'New passwords do not match.' });
      return;
    }
    setPwSaving(true);
    setPwMsg(null);
    try {
      const res = await fetch('/api/auth/password', {
        method: 'PUT',
        headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify({ currentPassword: cur, newPassword: next })
      });
      const data = await res.json().catch(() => null);
      if (!res.ok) throw new Error(data?.error || 'Could not change the password.');
      setCur('');
      setNext('');
      setConfirm('');
      setPwMsg({ ok: true, text: 'Password changed.' });
    } catch (err: any) {
      setPwMsg({ ok: false, text: err?.message || 'Could not change the password.' });
    } finally {
      setPwSaving(false);
    }
  };

  const renderMsg = (m: { ok: boolean; text: string } | null) =>
    m && (
      <p className={`text-[11px] font-semibold flex items-center gap-1.5 ${m.ok ? 'text-emerald-400' : 'text-red-400'}`}>
        {m.ok ? <CheckCircle2 className="w-3.5 h-3.5 shrink-0" /> : <AlertCircle className="w-3.5 h-3.5 shrink-0" />}
        <span>{m.text}</span>
      </p>
    );

  const inputClass =
    'w-full px-3 py-2 rounded-xl bg-slate-950 border border-slate-800 text-sm text-white placeholder-slate-500 focus:outline-none focus:ring-2 focus:ring-red-500/60 focus:border-red-500/50';

  return (
    <div
      className="fixed inset-0 z-50 bg-black/80 backdrop-blur-sm flex items-center justify-center p-4"
      onClick={e => {
        if (e.target === e.currentTarget) onClose();
      }}
    >
      <div className="bg-slate-900 border border-slate-800 rounded-3xl max-w-lg w-full p-5 sm:p-6 space-y-5 shadow-2xl max-h-[90vh] overflow-y-auto">
        <div className="flex items-center justify-between border-b border-slate-800 pb-3">
          <div className="flex items-center gap-2">
            <User className="w-5 h-5 text-sky-400" />
            <h3 className="text-sm font-bold text-white uppercase font-mono">
              Edit profile
            </h3>
          </div>
          <button
            type="button"
            onClick={onClose}
            title="Close"
            className="p-1.5 rounded-lg text-slate-400 hover:text-white hover:bg-slate-800 transition-colors"
          >
            <X className="w-4 h-4" />
          </button>
        </div>

        {/* Display name + email */}
        <div className="space-y-2">
          <label className="text-xs font-bold text-slate-300 block">
            Display name
          </label>
          <input
            type="text"
            value={name}
            onChange={e => setName(e.target.value)}
            placeholder="Your display name"
            maxLength={128}
            dir="auto"
            className={inputClass}
          />
          <label className="text-xs font-bold text-slate-300 block pt-1">
            Email
          </label>
          <input
            type="email"
            value={email}
            onChange={e => setEmail(e.target.value)}
            onKeyDown={e => {
              if (e.key === 'Enter') saveProfile();
            }}
            placeholder="you@example.com"
            maxLength={254}
            dir="ltr"
            autoComplete="email"
            className={inputClass}
          />
          <p className="text-[11px] text-slate-500">
            This email is used for sign-in.
          </p>
          {renderMsg(profileMsg)}
          <div>
            <button
              type="button"
              onClick={saveProfile}
              disabled={profileSaving}
              className="px-5 py-2 rounded-xl bg-red-600 hover:bg-red-500 text-white text-xs font-bold shadow-lg shadow-red-600/30 transition-all disabled:opacity-50"
            >
              {profileSaving ? 'Saving…' : 'Save changes'}
            </button>
          </div>
        </div>

        <div className="border-t border-slate-800" />

        {/* Password */}
        <div className="space-y-2">
          <label className="text-xs font-bold text-slate-300 flex items-center gap-1.5">
            <Lock className="w-3.5 h-3.5 text-slate-500" />
            <span>Change password</span>
          </label>
          <div className="grid grid-cols-1 gap-2">
            <input
              type="password"
              value={cur}
              onChange={e => setCur(e.target.value)}
              placeholder="Current password"
              autoComplete="current-password"
              className={inputClass}
            />
            <input
              type="password"
              value={next}
              onChange={e => setNext(e.target.value)}
              placeholder="New password (6+ chars)"
              autoComplete="new-password"
              className={inputClass}
            />
            <input
              type="password"
              value={confirm}
              onChange={e => setConfirm(e.target.value)}
              onKeyDown={e => {
                if (e.key === 'Enter') savePassword();
              }}
              placeholder="Repeat new password"
              autoComplete="new-password"
              className={inputClass}
            />
          </div>
          <div>
            <button
              type="button"
              onClick={savePassword}
              disabled={pwSaving}
              className="px-5 py-2 rounded-xl bg-slate-800 hover:bg-slate-700 border border-slate-700 text-slate-200 text-xs font-bold transition-colors disabled:opacity-50"
            >
              {pwSaving ? 'Changing…' : 'Change password'}
            </button>
          </div>
          {renderMsg(pwMsg)}
        </div>
      </div>
    </div>
  );
};

interface TemplateVoice {
  id: string;
  label: string;
  gender: string;
  description: string;
}

/** Real narrator voice picker: same catalog + same `tl_voice` key the Studio
 *  uses, so the choice applies to pipeline runs, auto-pilot and re-renders. */
const NarratorVoicePicker: React.FC = () => {
  const [voices, setVoices] = useState<TemplateVoice[]>([]);
  const [voiceId, setVoiceIdState] = useState<string>(() => {
    try {
      return localStorage.getItem('tl_voice') || '';
    } catch {
      return '';
    }
  });

  useEffect(() => {
    (async () => {
      try {
        const res = await fetch('/api/voice/options');
        if (!res.ok) return;
        const data = await res.json();
        if (Array.isArray(data.voices) && data.voices.length > 0) {
          setVoices(data.voices);
          const stored = (() => {
            try {
              return localStorage.getItem('tl_voice') || '';
            } catch {
              return '';
            }
          })();
          const valid = data.voices.some((v: TemplateVoice) => v.id === stored);
          const next = valid ? stored : (data.defaultVoiceId || data.voices[0].id);
          setVoiceIdState(next);
          try {
            localStorage.setItem('tl_voice', next);
          } catch {
            /* storage unavailable */
          }
        }
      } catch {
        /* offline — picker stays hidden */
      }
    })();
  }, []);

  if (voices.length === 0) return null;

  return (
    <select
      value={voiceId}
      onChange={e => {
        setVoiceIdState(e.target.value);
        try {
          localStorage.setItem('tl_voice', e.target.value);
        } catch {
          /* storage unavailable */
        }
      }}
      className="w-full bg-slate-950 border border-slate-800 rounded-xl px-3 py-2 text-white text-xs focus:outline-none"
    >
      {voices.map(v => (
        <option key={v.id} value={v.id} title={v.description}>
          {v.label} — {v.description}
        </option>
      ))}
    </select>
  );
};

export const ProvidersSettingsView: React.FC<ProvidersSettingsViewProps> = ({
  providers,
  onToggleProvider,
  settings,
  onUpdateSettings,
  userName,
  userEmail,
  onLogout,
  onProfileUpdate,
  isAdmin,
  onOpenAdmin
}) => {
  const [ytConfig, setYtConfig] = useState<YouTubeChannelConfig | null>(null);
  const [profileOpen, setProfileOpen] = useState(false);

  return (
    <div className="space-y-5 max-w-5xl mx-auto">
      {/* Hero: account + connected YouTube channel, big and on top */}
      <div className="relative overflow-hidden rounded-3xl border border-slate-700/60 bg-gradient-to-br from-slate-900 via-slate-900 to-red-950/40 p-5 sm:p-7">
        <div className="absolute -top-16 -right-16 w-56 h-56 rounded-full bg-red-600/15 blur-3xl pointer-events-none" />
        <div className="absolute -bottom-20 -left-10 w-56 h-56 rounded-full bg-amber-500/10 blur-3xl pointer-events-none" />
        <div className="relative flex flex-wrap items-center gap-4 justify-between">
          <div className="flex items-center gap-4 min-w-0">
            <div className="w-14 h-14 sm:w-16 sm:h-16 rounded-2xl bg-gradient-to-br from-red-500 via-rose-500 to-amber-500 flex items-center justify-center text-2xl sm:text-3xl font-black text-white shadow-lg shadow-red-500/30 shrink-0">
              {userName?.[0]?.toUpperCase() || <User className="w-7 h-7" />}
            </div>
            <div className="min-w-0">
              <div className="text-[10px] font-mono uppercase tracking-widest text-slate-400">Account</div>
              <h1 className="text-xl sm:text-2xl font-black text-white truncate" dir="ltr">
                {userName || 'Profile'}
              </h1>
              {userEmail && (
                <div className="mt-0.5 flex items-center gap-1.5 text-[11px] font-mono text-slate-400 truncate" dir="ltr">
                  <Mail className="w-3.5 h-3.5 text-slate-500 shrink-0" />
                  <span className="truncate">{userEmail}</span>
                </div>
              )}
              {/* Connected YouTube account — big, standalone */}
              <div className="mt-1.5 flex items-center gap-2 min-w-0">
                <Youtube className={`w-5 h-5 shrink-0 ${ytConfig?.connected ? 'text-red-400' : 'text-slate-600'}`} />
                {ytConfig?.connected ? (
                  <span className="text-base sm:text-lg font-black text-white truncate" dir="auto">
                    {ytConfig.channelTitle}
                  </span>
                ) : (
                  <span className="text-sm font-semibold text-slate-500">No YouTube channel linked yet</span>
                )}
                {ytConfig?.connected && ytConfig.subscriberCount && (
                  <span className="text-[11px] font-mono text-slate-400 shrink-0" dir="ltr">
                    {ytConfig.subscriberCount} subs
                  </span>
                )}
              </div>
            </div>
          </div>
          <div className="flex items-center gap-2 flex-wrap">
            <button
              type="button"
              onClick={() => setProfileOpen(true)}
              title="Edit profile"
              className="flex items-center gap-1.5 px-4 py-2 rounded-xl bg-slate-800/80 hover:bg-slate-700 border border-slate-700 text-slate-200 hover:text-white text-xs font-bold transition-colors"
            >
              <Pencil className="w-4 h-4" />
              <span>Edit profile</span>
            </button>
            {isAdmin && onOpenAdmin && (
              <button
                onClick={onOpenAdmin}
                title="Admin Panel"
                className="flex items-center gap-1.5 px-4 py-2 rounded-xl bg-gradient-to-r from-amber-600 to-orange-600 hover:brightness-110 border border-amber-500/50 text-white text-xs font-bold shadow-lg shadow-amber-600/20 transition-all"
              >
                <ShieldCheck className="w-4 h-4" />
                <span>Admin Panel</span>
              </button>
            )}
            {onLogout && (
              <button
                onClick={onLogout}
                title="Sign out"
                className="flex items-center gap-1.5 px-4 py-2 rounded-xl bg-slate-800/80 hover:bg-red-600 border border-slate-700 hover:border-red-500 text-slate-300 hover:text-white text-xs font-bold transition-colors"
              >
                <LogOut className="w-4 h-4" />
                <span>Sign out</span>
              </button>
            )}
          </div>
        </div>
      </div>

      {/* Profile editor lives in a modal — opened via "Edit profile" above */}
      <EditProfileModal
        isOpen={profileOpen}
        onClose={() => setProfileOpen(false)}
        currentName={userName}
        userEmail={userEmail}
        onProfileUpdate={onProfileUpdate}
      />

      {/* YouTube API — now lives in the Profile tab */}
      <YouTubeConnectionCard onConfigChange={setYtConfig} />



    </div>
  );
};
