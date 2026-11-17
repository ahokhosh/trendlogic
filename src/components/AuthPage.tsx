import React, { useState } from 'react';
import { Tv, Mail, Lock, User as UserIcon, Sparkles, LogIn, UserPlus, Video, ChevronDown, KeyRound, Eye, EyeOff } from 'lucide-react';

export interface AuthUser {
  id: string;
  email: string;
  name: string;
  role: string;
}

export interface AuthPrefs {
  preferred_ai_model: string;
  brand_color: string;
}

interface AuthPageProps {
  onAuth: (user: AuthUser, prefs: AuthPrefs) => void;
}

type Mode = 'login' | 'signup' | 'reset';

export const AuthPage: React.FC<AuthPageProps> = ({ onAuth }) => {
  const [mode, setMode] = useState<Mode>('login');
  const [email, setEmail] = useState('');
  const [password, setPassword] = useState('');
  const [name, setName] = useState('');
  const [code, setCode] = useState('');
  const [newPassword, setNewPassword] = useState('');
  const [error, setError] = useState<string | null>(null);
  const [info, setInfo] = useState<string | null>(null);
  const [showPassword, setShowPassword] = useState(false);
  const [loading, setLoading] = useState<boolean>(false);
  const [sendingCode, setSendingCode] = useState<boolean>(false);
  const [codeSent, setCodeSent] = useState<boolean>(false);

  const sendCode = async (purpose: 'register' | 'reset') => {
    setError(null); setInfo(null);
    if (!email.trim()) { setError('Please enter your email address.'); return; }
    setSendingCode(true);
    try {
      const res = await fetch('/api/auth/send-code', {
        method: 'POST',
        headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify({ email: email.trim(), purpose })
      });
      const data = await res.json().catch(() => ({}));
      if (!res.ok) setError(data?.error || 'Could not send code.');
      else { setCodeSent(true); setInfo('Verification code sent to your email.'); }
    } catch {
      setError('Network error. Please check your connection and try again.');
    } finally {
      setSendingCode(false);
    }
  };

  const submit = async (e: React.FormEvent) => {
    e.preventDefault();
    setError(null); setInfo(null);
    setLoading(true);
    try {
      if (mode === 'login') {
        if (!email.trim() || !password) { setError('Please enter your email and password.'); setLoading(false); return; }
        const res = await fetch('/api/auth/login', {
          method: 'POST',
          headers: { 'Content-Type': 'application/json' },
          body: JSON.stringify({ email: email.trim(), password })
        });
        const data = await res.json().catch(() => ({}));
        if (!res.ok) setError(data?.error || 'Something went wrong. Please try again.');
        else if (data?.user) onAuth(data.user, data.prefs || { preferred_ai_model: 'flux', brand_color: '#dc2626' });
        else setError('Unexpected server response.');
      } else if (mode === 'signup') {
        if (!email.trim() || !password || !code.trim()) { setError('Please fill all fields and enter the verification code.'); setLoading(false); return; }
        const res = await fetch('/api/auth/register', {
          method: 'POST',
          headers: { 'Content-Type': 'application/json' },
          body: JSON.stringify({ email: email.trim(), password, name: name.trim(), code: code.trim() })
        });
        const data = await res.json().catch(() => ({}));
        if (!res.ok) setError(data?.error || 'Something went wrong. Please try again.');
        else if (data?.user) onAuth(data.user, data.prefs || { preferred_ai_model: 'flux', brand_color: '#dc2626' });
        else setError('Unexpected server response.');
      } else if (mode === 'reset') {
        if (!email.trim() || !code.trim() || !newPassword) { setError('Please fill all fields.'); setLoading(false); return; }
        const res = await fetch('/api/auth/reset-password', {
          method: 'POST',
          headers: { 'Content-Type': 'application/json' },
          body: JSON.stringify({ email: email.trim(), code: code.trim(), newPassword })
        });
        const data = await res.json().catch(() => ({}));
        if (!res.ok) setError(data?.error || 'Something went wrong. Please try again.');
        else { setInfo('Password reset successful. You can now sign in.'); setMode('login'); setCode(''); setNewPassword(''); }
      }
    } catch (err) {
      setError('Network error. Please check your connection and try again.');
    } finally {
      setLoading(false);
    }
  };

  const inputClass =
    'w-full pl-10 pr-3 py-2.5 rounded-xl bg-slate-950/80 border border-slate-700 text-sm text-white placeholder-slate-500 focus:outline-none focus:ring-2 focus:ring-red-500/60 focus:border-red-500/50 transition-all';

  return (
    <div className="min-h-screen bg-slate-950 text-slate-100 flex items-center justify-center font-sans selection:bg-red-500 selection:text-white relative overflow-hidden">
      {/* Ambient background glows */}
      <div className="pointer-events-none absolute -top-32 -left-32 w-96 h-96 rounded-full bg-red-600/20 blur-3xl" />
      <div className="pointer-events-none absolute -bottom-40 -right-24 w-[28rem] h-[28rem] rounded-full bg-amber-500/10 blur-3xl" />
      <div className="pointer-events-none absolute top-1/3 right-1/4 w-72 h-72 rounded-full bg-teal-500/10 blur-3xl" />

      <div className="relative w-full max-w-4xl px-4 sm:px-6">
        <div className="flex flex-col lg:flex-row items-center gap-8 lg:gap-12">
          {/* Left: Brand panel */}
          <div className="flex-1 text-center lg:text-left lg:pr-4">
            <div className="inline-flex items-center gap-3 mb-4">
              <div className="w-12 h-12 rounded-2xl bg-gradient-to-br from-red-500 via-orange-500 to-amber-500 flex items-center justify-center shadow-xl shadow-red-500/30">
                <Tv className="w-6 h-6 text-white" />
              </div>
               <span className="font-black tracking-tight uppercase font-mono text-lg text-white">
                 YOUTUBE UPLOADER
               </span>
            </div>

            <h1 className="text-2xl sm:text-3xl font-black text-white leading-tight">
              YouTube Uploader
              <span className="text-transparent bg-clip-text bg-gradient-to-r from-red-400 via-orange-400 to-amber-400"> Studio</span>
            </h1>
            <p className="text-sm text-slate-400 mt-3 max-w-md mx-auto lg:mx-0">
              Sign in to manage and publish your videos to YouTube.
            </p>
          </div>

          {/* Right: Auth card */}
          <div className="w-full max-w-md">
            <div className="rounded-3xl bg-slate-900/90 border border-slate-800 shadow-2xl shadow-black/50 backdrop-blur p-6 sm:p-8">
              {mode !== 'reset' && (
              <div className="flex items-center gap-1 bg-slate-950/80 p-1 rounded-xl border border-slate-800 mb-6">
                <button
                  onClick={() => { setMode('login'); setError(null); }}
                  className={`flex-1 px-3 py-2 text-xs font-bold rounded-lg transition-all flex items-center justify-center gap-1.5 ${
                    mode === 'login' ? 'bg-red-600 text-white shadow-sm' : 'text-slate-400 hover:text-slate-200'
                  }`}
                >
                  <LogIn className="w-3.5 h-3.5" />
                  Sign In
                </button>
                <button
                  onClick={() => { setMode('signup'); setError(null); }}
                  className={`flex-1 px-3 py-2 text-xs font-bold rounded-lg transition-all flex items-center justify-center gap-1.5 ${
                    mode === 'signup' ? 'bg-red-600 text-white shadow-sm' : 'text-slate-400 hover:text-slate-200'
                  }`}
                >
                  <UserPlus className="w-3.5 h-3.5" />
                  Create Account
                </button>
              </div>
              )}

              {mode === 'reset' && (
                <div className="mb-6 text-center">
                  <h2 className="text-lg font-bold text-white">Reset Password</h2>
                  <p className="text-xs text-slate-400 mt-1">Enter your email, request a code, then set a new password.</p>
                </div>
              )}

              <form onSubmit={submit} className="space-y-4">
                {/* Mode switcher */}
                {/* email */}
                <div className="relative">
                  <Mail className="absolute left-3 top-1/2 -translate-y-1/2 w-4 h-4 text-slate-500" />
                  <input
                    type="email"
                    value={email}
                    onChange={e => setEmail(e.target.value)}
                    placeholder="Email address"
                    className={inputClass}
                    autoComplete="email"
                  />
                </div>

                {mode === 'signup' && (
                  <div className="relative">
                    <UserIcon className="absolute left-3 top-1/2 -translate-y-1/2 w-4 h-4 text-slate-500" />
                    <input
                      type="text"
                      value={name}
                      onChange={e => setName(e.target.value)}
                      placeholder="Display name (optional)"
                      className={inputClass}
                      autoComplete="name"
                    />
                  </div>
                )}

                {mode !== 'reset' && (
                  <div className="relative">
                    <Lock className="absolute left-3 top-1/2 -translate-y-1/2 w-4 h-4 text-slate-500" />
                    <input
                      type={showPassword ? 'text' : 'password'}
                      value={password}
                      onChange={e => setPassword(e.target.value)}
                      placeholder={mode === 'signup' ? 'Password (min 6 characters)' : 'Password'}
                      className={inputClass}
                      autoComplete={mode === 'signup' ? 'new-password' : 'current-password'}
                    />
                    <button
                      type="button"
                      onClick={() => setShowPassword(v => !v)}
                      className="absolute right-3 top-1/2 -translate-y-1/2 text-slate-500 hover:text-slate-300"
                      tabIndex={-1}
                    >
                      {showPassword ? <EyeOff className="w-4 h-4" /> : <Eye className="w-4 h-4" />}
                    </button>
                  </div>
                )}

                {mode === 'reset' && (
                  <div className="relative">
                    <Lock className="absolute left-3 top-1/2 -translate-y-1/2 w-4 h-4 text-slate-500" />
                    <input
                      type={showPassword ? 'text' : 'password'}
                      value={newPassword}
                      onChange={e => setNewPassword(e.target.value)}
                      placeholder="New password (min 6 characters)"
                      className={inputClass}
                      autoComplete="new-password"
                    />
                  </div>
                )}

                {(mode === 'signup' || mode === 'reset') && (
                  <div className="flex gap-2">
                    <div className="relative flex-1">
                      <KeyRound className="absolute left-3 top-1/2 -translate-y-1/2 w-4 h-4 text-slate-500" />
                      <input
                        type="text"
                        value={code}
                        onChange={e => setCode(e.target.value)}
                        placeholder="Verification code"
                        className={inputClass}
                      />
                    </div>
                    <button
                      type="button"
                      onClick={() => sendCode(mode === 'signup' ? 'register' : 'reset')}
                      disabled={sendingCode}
                      className="px-3 py-2.5 rounded-xl bg-slate-800 hover:bg-slate-700 disabled:opacity-60 text-xs font-bold text-white whitespace-nowrap"
                    >
                      {sendingCode ? 'Sending...' : (codeSent ? 'Resend' : 'Send code')}
                    </button>
                  </div>
                )}

                {mode === 'login' && (
                  <div className="text-right">
                    <button type="button" onClick={() => { setMode('reset'); setError(null); setInfo(null); setCodeSent(false); }} className="text-xs text-slate-400 hover:text-red-400">
                      Forgot password?
                    </button>
                  </div>
                )}

                {info && (
                  <div className="px-3 py-2 rounded-lg bg-emerald-950/60 border border-emerald-800/60 text-xs text-emerald-300">
                    {info}
                  </div>
                )}
                {error && (
                  <div className="px-3 py-2 rounded-lg bg-red-950/60 border border-red-800/60 text-xs text-red-300">
                    {error}
                  </div>
                )}

                <button
                  type="submit"
                  disabled={loading}
                  className="w-full px-4 py-3 rounded-xl bg-red-600 hover:bg-red-700 active:scale-[0.99] disabled:opacity-60 text-white font-black text-sm shadow-lg shadow-red-600/30 transition-all flex items-center justify-center gap-2"
                >
                  <span>{loading ? 'Please wait...' : mode === 'login' ? 'Sign In' : mode === 'signup' ? 'Create Account' : 'Reset Password'}</span>
                </button>
              </form>

              {mode === 'reset' && (
                <p className="text-center mt-4 text-xs text-slate-500">
                  <button type="button" onClick={() => { setMode('login'); setError(null); setInfo(null); }} className="text-slate-400 hover:text-red-400">Back to sign in</button>
                </p>
              )}

              <p className="text-[11px] text-slate-500 text-center mt-5 leading-relaxed">
                Your videos and trends are private to your account.
                <br />
                Renders are stored per-user and only reachable by you.
              </p>
            </div>
          </div>
        </div>
      </div>
    </div>
  );
};