import React, { useCallback, useEffect, useRef, useState } from 'react';
import { QRCodeSVG } from 'qrcode.react';
import { YouTubeSettingsModal } from './YouTubeSettingsModal';
import { Upload, Trash2, CalendarClock, X, HardDrive, Coins, CheckCircle2, Clock, AlertCircle, Copy, Check } from 'lucide-react';

interface Quota { quota_bytes: number; used_bytes: number; file_count?: number; subscription_expires_at?: string | null }
interface UFile {
  id: string; filename: string; original_name: string | null; size_bytes: number;
  size_formatted: string; url: string; created_at: string;
  youtube_scheduled_at: string | null; youtube_status: string;
  youtube_video_id: string | null; youtube_url: string | null; youtube_error: string | null;
}
interface Purchase { id: string; bytes_requested: number; crypto_network: string | null; tx_hash: string | null; status: string; created_at: string; admin_note: string | null }

function fmtBytes(b: number) { if (b >= 1024**3) return `${(b/1024**3).toFixed(2)} GB`; if (b >= 1024**2) return `${(b/1024**2).toFixed(1)} MB`; return `${(b/1024).toFixed(0)} KB`; }

type CryptoEntry = { currency: string; address: string; network: string; label: string };
function parseCryptoEntries(raw: string | undefined, fallback: string, currency: string): CryptoEntry[] {
  const src = (raw && String(raw).trim()) ? String(raw).trim() : fallback;
  return src.split(',').map(part => {
    const i = part.indexOf(':');
    if (i < 0) return { currency, address: part.trim(), network: part.trim(), label: `${currency} - ${part.trim()}` };
    const address = part.slice(0, i).trim();
    const network = part.slice(i + 1).trim();
    return { currency, address, network, label: `${currency} - ${network}` };
  }).filter(e => e.address);
}
const CRYPTO_ENTRIES: CryptoEntry[] = [
  ...parseCryptoEntries((import.meta as any).env?.VITE_CRYPTO_USDT_ADDRESS, '0x175eb925cBf116187aA43080891C4A464B59Af17:BSC(USDT)', 'USDT'),
  ...parseCryptoEntries((import.meta as any).env?.VITE_CRYPTO_BTC_ADDRESS, '0x69F40B4bAB0A03b9646E3a904DE3D8329e7439d1:BEP20(BSC),bc1qp8255v23k6wjkvae9cdd4ldzh9kkt0vufemd92:BTC SEGWIT', 'BTC'),
  ...parseCryptoEntries((import.meta as any).env?.VITE_CRYPTO_ETH_ADDRESS, '0x69F40B4bAB0A03b9646E3a904DE3D8329e7439d1:BEP20(BSC)', 'ETH'),
  ...parseCryptoEntries((import.meta as any).env?.VITE_CRYPTO_SOL_ADDRESS, 'GiwmjBDAPmCE7de11pAfmQLsjbBeRZXXp6itn3xDbHst:SOLANA', 'SOL'),
  ...parseCryptoEntries((import.meta as any).env?.VITE_CRYPTO_USDD_ADDRESS, 'TQPsMQcnu4MDFZzNC1JpxtSzZwjJ7ojs2f:TRC20', 'USDD'),
];

export const UploaderView: React.FC<{ openPurchase?: boolean; onPurchaseOpened?: () => void }> = ({ openPurchase, onPurchaseOpened }) => {
  const [quota, setQuota] = useState<Quota>({ quota_bytes: 0, used_bytes: 0 });
  const [files, setFiles] = useState<UFile[]>([]);
  const [publishFile, setPublishFile] = useState<UFile | null>(null);
  const [ytConfig, setYtConfig] = useState<any>(null);
  const [ytModalOpen, setYtModalOpen] = useState(false);
  const [pubTitle, setPubTitle] = useState('');
  const [pubDesc, setPubDesc] = useState('');
  const [pubPrivacy, setPubPrivacy] = useState('public');
  const [pubWhen, setPubWhen] = useState('');
  const [publishing, setPublishing] = useState(false);
  const [publishMsg, setPublishMsg] = useState<string | null>(null);
  const [purchases, setPurchases] = useState<Purchase[]>([]);
  const [purchaseModalOpen, setPurchaseModalOpen] = useState(false);
  const [loading, setLoading] = useState(true);
  const [uploading, setUploading] = useState(false);
  const [progress, setProgress] = useState(0);
  const [error, setError] = useState<string | null>(null);
  const fileInput = useRef<HTMLInputElement>(null);

  const [gb, setGb] = useState(1);
  const [months, setMonths] = useState(1);
  const [network, setNetwork] = useState(CRYPTO_ENTRIES[0]?.label || '');
  const [txHash, setTxHash] = useState('');
  const [proof, setProof] = useState('');
  const [buying, setBuying] = useState(false);
  const [copied, setCopied] = useState(false);
  const [successMsg, setSuccessMsg] = useState<string | null>(null);

  const selectedEntry = CRYPTO_ENTRIES.find(e => e.label === network) || CRYPTO_ENTRIES[0];
  const depositAddress = selectedEntry?.address || '';
  const priceUsd = gb * months * 4;
  const hasPending = purchases.some(p => p.status === 'pending');
  const copyAddress = async () => {
    try {
      await navigator.clipboard.writeText(depositAddress);
      setCopied(true);
      setTimeout(() => setCopied(false), 1500);
    } catch { /* ignore */ }
  };

  const load = useCallback(async () => {
    setLoading(true); setError(null);
    try {
      const [qRes, fRes, pRes] = await Promise.all([
        fetch('/api/uploads/quota').then(r => r.json()),
        fetch('/api/uploads/files').then(r => r.json()),
        fetch('/api/uploads/purchases').then(r => r.json())
      ]);
      if (qRes?.success) setQuota(qRes);
      if (fRes?.success) setFiles(fRes.files || []);
      if (pRes?.success) setPurchases(pRes.purchases || []);
    } catch (e: any) { setError(e?.message || 'Load failed'); }
    finally { setLoading(false); }
  }, []);

  useEffect(() => { load(); }, [load]);
  useEffect(() => {
    if (openPurchase) {
      setPurchaseModalOpen(true);
      onPurchaseOpened?.();
    }
  }, [openPurchase, onPurchaseOpened]);

  useEffect(() => {
    if (!publishFile) return;
    setPubTitle(publishFile.original_name || publishFile.filename);
    setPubDesc('');
    setPubPrivacy('public');
    setPubWhen('');
    setPublishMsg(null);
    fetch('/api/youtube/config').then(r => r.ok ? r.json() : null).then(d => { if (d?.config) setYtConfig(d.config); }).catch(() => {});
  }, [publishFile]);

  const onUpload = async (e: React.ChangeEvent<HTMLInputElement>) => {
    const f = e.target.files?.[0];
    if (!f) return;
    setUploading(true); setProgress(0); setError(null);
    try {
      const fd = new FormData();
      fd.append('file', f);
      const xhr = new XMLHttpRequest();
      await new Promise<void>((resolve, reject) => {
        xhr.open('POST', '/api/uploads');
        xhr.upload.onprogress = ev => { if (ev.lengthComputable) setProgress(Math.round(ev.loaded/ev.total*100)); };
        xhr.onload = () => { if (xhr.status >= 200 && xhr.status < 300) resolve(); else reject(new Error(JSON.parse(xhr.responseText || '{}').error || 'Upload failed')); };
        xhr.onerror = () => reject(new Error('Network error'));
        xhr.send(fd);
      });
      await load();
    } catch (err: any) { setError(err?.message || 'Upload failed'); }
    finally { setUploading(false); setProgress(0); if (fileInput.current) fileInput.current.value = ''; }
  };

  const onDelete = async (id: string) => {
    if (!confirm('Delete this file?')) return;
    try { await fetch(`/api/uploads/${id}`, { method: 'DELETE' }); await load(); }
    catch (e: any) { setError(e?.message || 'Delete failed'); }
  };

  const scheduleYt = async (id: string, when: string) => {
    try { await fetch(`/api/uploads/${id}/youtube-schedule`, { method: 'POST', headers: { 'Content-Type': 'application/json' }, body: JSON.stringify({ scheduledAt: when }) }); await load(); }
    catch (e: any) { setError(e?.message || 'Schedule failed'); }
  };
  const cancelYt = async (id: string) => {
    try { await fetch(`/api/uploads/${id}/youtube-schedule`, { method: 'DELETE' }); await load(); }
    catch (e: any) { setError(e?.message || 'Cancel failed'); }
  };

  const buy = async () => {
    setBuying(true); setError(null);
    try {
      const res = await fetch('/api/uploads/purchase', { method: 'POST', headers: { 'Content-Type': 'application/json' }, body: JSON.stringify({ gb: Number(gb), months: Number(months), cryptoNetwork: network, txHash, proof }) });
      const data = await res.json();
      if (!res.ok || !data?.success) throw new Error(data?.error || 'Purchase request failed');
      setTxHash(''); setProof('');
      setSuccessMsg('Request submitted. Pending admin review.');
      await load();
    } catch (e: any) { setError(e?.message || 'Purchase failed'); }
    finally { setBuying(false); }
  };

  const usedPct = quota.quota_bytes > 0 ? Math.min(100, Math.round(quota.used_bytes / quota.quota_bytes * 100)) : 0;

  return (
    <div className="space-y-6">

      {error && (
        <div className="p-3 rounded-2xl bg-red-950/40 border border-red-800 text-red-300 text-sm flex items-center gap-2">
          <AlertCircle className="w-4 h-4 shrink-0" /> {error}
        </div>
      )}

      {/* Quota */}
      <div className="p-4 rounded-2xl bg-slate-900 border border-slate-800 space-y-2">
        <div className="flex items-center justify-between text-xs font-mono">
          <span className="text-slate-400">Storage</span>
          <span className="text-white">{fmtBytes(quota.used_bytes)} / {fmtBytes(quota.quota_bytes)}</span>
        </div>
        <div className="h-2 rounded-full bg-slate-800 overflow-hidden">
          <div className="h-full bg-gradient-to-r from-violet-500 to-fuchsia-500" style={{ width: `${usedPct}%` }} />
        </div>
        <div className="text-[11px] text-slate-500">{files.length} files</div>
      </div>

      {/* Upload */}
      <div className="p-4 rounded-2xl bg-slate-900 border border-slate-800 space-y-3">
        <div className="flex items-center gap-2">
          <Upload className="w-4 h-4 text-violet-400" />
          <h2 className="text-sm font-black text-white uppercase font-mono">Upload file</h2>
        </div>
        <label className={`flex items-center justify-center gap-2 w-full px-4 py-3 rounded-xl border-2 border-dashed border-violet-500/40 bg-slate-950 text-slate-200 text-sm font-semibold cursor-pointer hover:border-violet-400 hover:bg-slate-900 transition-colors ${uploading || quota.quota_bytes <= 0 ? 'opacity-50 cursor-not-allowed' : ''}`}>
          <Upload className="w-5 h-5 text-violet-400" />
          <span>{uploading ? 'Uploading…' : 'Click to select a video file'}</span>
          <input ref={fileInput} type="file" accept="video/*" onChange={onUpload} disabled={uploading || quota.quota_bytes <= 0} className="hidden" />
        </label>
        {uploading && (
          <div className="space-y-1">
            <div className="h-2 rounded-full bg-slate-800 overflow-hidden">
              <div className="h-full bg-violet-500" style={{ width: `${progress}%` }} />
            </div>
            <div className="text-[11px] font-mono text-slate-400">{progress}%</div>
          </div>
        )}
        {quota.quota_bytes <= 0 && <p className="text-xs text-amber-400">No storage quota. Purchase below.</p>}
      </div>

      {/* Files list */}
      <div className="space-y-2">
        <h2 className="text-sm font-black text-white uppercase font-mono">Your files</h2>
        {loading && <p className="text-xs text-slate-500">Loading…</p>}
        {!loading && files.length === 0 && <p className="text-xs text-slate-500">No files yet.</p>}
        {files.map(f => (
          <div key={f.id} className="p-3 rounded-2xl bg-slate-900 border border-slate-800 space-y-3">
            <div className="flex flex-col sm:flex-row gap-3">
              <video src={f.url} className="w-full sm:w-40 h-24 rounded-lg bg-black object-cover shrink-0" muted preload="metadata" playsInline />
              <div className="min-w-0 flex-1 space-y-1">
                <p className="text-sm font-bold text-white truncate">{f.original_name || f.filename}</p>
                <p className="text-[11px] font-mono text-slate-400">{f.size_formatted} • {new Date(f.created_at).toLocaleString()}</p>
              </div>
            </div>
            <div className="flex flex-wrap items-center gap-2">
              <a href={f.url} target="_blank" rel="noreferrer" className="px-3 py-1.5 rounded-lg bg-slate-800 hover:bg-slate-700 text-slate-200 text-xs font-semibold">View</a>
              <button onClick={() => { if (quota.quota_bytes <= 0) { setError('Buy credit to publish videos.'); return; } setPublishFile(f); }} className="px-3 py-1.5 rounded-lg bg-red-600 hover:bg-red-500 text-white text-xs font-semibold">Publish</button>
              <button onClick={() => onDelete(f.id)} className="px-3 py-1.5 rounded-lg bg-slate-800 hover:bg-red-900/40 text-slate-300 hover:text-red-300 text-xs font-semibold flex items-center gap-1"><Trash2 className="w-3.5 h-3.5" /> Delete</button>
            </div>
            {/* YouTube timer */}
            <div className="flex flex-wrap items-center gap-2 pt-1 border-t border-slate-800">
              <CalendarClock className="w-4 h-4 text-amber-400" />
              {f.youtube_status === 'scheduled' ? (
                <>
                  <span className="text-[11px] font-mono text-amber-300">Scheduled: {f.youtube_scheduled_at ? new Date(f.youtube_scheduled_at).toLocaleString() : '—'}</span>
                  <button onClick={() => cancelYt(f.id)} className="ml-auto px-2.5 py-1 rounded-lg bg-slate-800 hover:bg-slate-700 text-slate-200 text-xs font-semibold flex items-center gap-1"><X className="w-3 h-3" /> Cancel</button>
                </>
              ) : f.youtube_status === 'uploaded' ? (
                 <>
                   <span className="text-[11px] font-mono text-emerald-300 flex items-center gap-1"><CheckCircle2 className="w-3.5 h-3.5" /> Uploaded</span>
                   {f.youtube_url && (
                     <a href={f.youtube_url} target="_blank" rel="noreferrer" className="ml-2 px-2.5 py-1 rounded-lg bg-red-600 hover:bg-red-500 text-white text-[10px] font-bold">Open on YouTube</a>
                   )}
                 </>
              ) : f.youtube_status === 'uploading' ? (
                <span className="text-[11px] font-mono text-sky-300 flex items-center gap-1"><Clock className="w-3.5 h-3.5 animate-spin" /> Uploading…</span>
              ) : f.youtube_status === 'failed' ? (
                <span className="text-[11px] font-mono text-red-300" title={f.youtube_error || ''}>Failed: {f.youtube_error || 'error'}</span>
              ) : (
                <span className="text-[11px] font-mono text-slate-500">No YouTube timer</span>
              )}
              {f.youtube_status !== 'scheduled' && f.youtube_status !== 'uploading' && (
                <input type="datetime-local" className="ml-auto px-2 py-1 rounded-lg bg-slate-950 border border-slate-800 text-xs text-slate-200" onChange={e => { if (e.target.value) scheduleYt(f.id, e.target.value); }} />
              )}
            </div>
          </div>
        ))}
      </div>

      {/* Buy credit button (opens modal) */}
      <div className="flex items-center gap-3">
          <button onClick={() => setPurchaseModalOpen(true)} className="px-4 py-2 rounded-xl bg-amber-600 hover:bg-amber-500 text-white text-xs font-bold">
            Buy credit
          </button>
        <span className="text-[11px] text-slate-500">{quota.subscription_expires_at && new Date(quota.subscription_expires_at) > new Date() ? `Subscription active until ${new Date(quota.subscription_expires_at).toLocaleDateString()}` : 'No active subscription'}</span>
      </div>

      {/* Purchase modal */}
      {purchaseModalOpen && (
        <div className="fixed inset-0 z-50 flex items-center justify-center bg-black/70 p-4">
          <div className="w-full max-w-2xl rounded-3xl bg-slate-900 border border-slate-800 p-5 space-y-4 max-h-[90vh] overflow-y-auto">
            <div className="flex items-center justify-between">
              <h3 className="text-sm font-black text-white uppercase font-mono">Buy credit (Storage)</h3>
              <button onClick={() => setPurchaseModalOpen(false)} className="p-2 rounded-lg bg-slate-800 hover:bg-slate-700 text-slate-300"><X className="w-4 h-4" /></button>
            </div>
            {successMsg && (
              <div className="p-3 rounded-xl bg-emerald-950/40 border border-emerald-800 text-emerald-300 text-xs flex items-center gap-2">
                <CheckCircle2 className="w-4 h-4" /> {successMsg} Status: pending review.
              </div>
            )}
            {hasPending && (
              <div className="p-3 rounded-xl bg-amber-950/40 border border-amber-800 text-amber-300 text-xs">
                You have a pending request. New purchase disabled until it is approved or rejected.
              </div>
            )}
            <div className="space-y-2">
              <div className="flex items-center justify-between text-lg font-mono font-black">
                <span className="text-slate-200">Size: {gb} GB</span>
                <span className="text-amber-300">{priceUsd} USDT</span>
              </div>
              <input type="range" min={1} max={100} value={gb} onChange={e => setGb(Number(e.target.value))} disabled={hasPending} className="w-full accent-violet-500 disabled:opacity-50" />
            </div>
            <div className="space-y-2">
              <div className="flex items-center justify-between text-sm font-mono font-bold">
                <span className="text-slate-200">Months: {months}</span>
              </div>
              <input type="range" min={1} max={12} value={months} onChange={e => setMonths(Number(e.target.value))} disabled={hasPending} className="w-full accent-violet-500 disabled:opacity-50" />
            </div>
            <div className="grid grid-cols-1 sm:grid-cols-2 gap-3">
              <label className="text-xs text-slate-400">Network
                <select value={network} onChange={e => setNetwork(e.target.value)} className="mt-1 w-full px-3 py-2 rounded-xl bg-slate-950 border border-slate-800 text-white text-xs">
                  {CRYPTO_ENTRIES.map((e, i) => (
                    <option key={i} value={e.label}>{e.label}</option>
                  ))}
                </select>
              </label>
              <div className="text-xs text-slate-400">
                Deposit address
                <div className="mt-1 flex items-center gap-3 p-2 rounded-xl bg-slate-950 border border-slate-800">
                  <QRCodeSVG value={depositAddress} size={128} />
                  <div className="flex-1 min-w-0 space-y-2">
                    <span className="font-mono text-[10px] text-slate-300 break-all block">{depositAddress}</span>
                    <button onClick={copyAddress} className="flex items-center gap-1.5 px-3 py-1.5 rounded-lg bg-slate-800 hover:bg-slate-700 text-slate-200 text-xs font-semibold">
                      {copied ? <Check className="w-3.5 h-3.5 text-emerald-400" /> : <Copy className="w-3.5 h-3.5" />}
                      {copied ? 'Copied' : 'Copy address'}
                    </button>
                  </div>
                </div>
              </div>
              <label className="text-xs text-slate-400 sm:col-span-2">Tx hash
                <input value={txHash} onChange={e => setTxHash(e.target.value)} className="mt-1 w-full px-3 py-2 rounded-xl bg-slate-950 border border-slate-800 text-white text-xs" />
              </label>
              <label className="text-xs text-slate-400 sm:col-span-2">Proof / note
                <textarea value={proof} onChange={e => setProof(e.target.value)} rows={2} className="mt-1 w-full px-3 py-2 rounded-xl bg-slate-950 border border-slate-800 text-white text-xs" />
              </label>
            </div>
            <button onClick={buy} disabled={buying || hasPending} className="px-4 py-2 rounded-xl bg-amber-600 hover:bg-amber-500 text-white text-xs font-bold disabled:opacity-50">
              {buying ? 'Submitting…' : `Submit purchase request (${priceUsd} USDT)`}
            </button>
            <p className="text-[11px] text-slate-500">Send {priceUsd} USDT to the address above, then submit tx hash. Admin will verify and activate storage.</p>

            {/* Purchase history */}
            {purchases.length > 0 && (
              <div className="space-y-2">
                <h2 className="text-sm font-black text-white uppercase font-mono">Purchase history</h2>
                {purchases.map(p => (
                  <div key={p.id} className="p-3 rounded-2xl bg-slate-900 border border-slate-800 flex items-center justify-between gap-3">
                    <div className="min-w-0">
                      <p className="text-xs font-bold text-white">{fmtBytes(p.bytes_requested)} • {p.crypto_network}</p>
                      <p className="text-[11px] font-mono text-slate-400">{new Date(p.created_at).toLocaleString()}</p>
                      {p.admin_note && <p className="text-[11px] text-slate-500">{p.admin_note}</p>}
                    </div>
                    <span className={`px-2 py-0.5 rounded-full text-[10px] font-mono border ${
                      p.status === 'approved' ? 'bg-emerald-500/10 border-emerald-500/40 text-emerald-300' :
                      p.status === 'rejected' ? 'bg-red-500/10 border-red-500/40 text-red-300' :
                      'bg-amber-500/10 border-amber-500/40 text-amber-300'
                    }`}>{p.status}</span>
                  </div>
                ))}
              </div>
            )}
          </div>
        </div>
      )}

      {/* Publish modal */}
      {publishFile && (
        <div className="fixed inset-0 z-50 flex items-center justify-center bg-black/70 p-4">
          <div className="w-full max-w-none w-full rounded-3xl bg-slate-900 border border-slate-800 p-5 space-y-4">
            <div className="flex items-center justify-between">
              <h3 className="text-sm font-black text-white uppercase font-mono">Publish to YouTube</h3>
              <button onClick={() => setPublishFile(null)} className="p-2 rounded-lg bg-slate-800 hover:bg-slate-700 text-slate-300"><X className="w-4 h-4" /></button>
            </div>
            <div className="flex items-center gap-2 text-xs">
              <span className={ytConfig?.connected ? 'text-emerald-300' : 'text-red-300'}>
                {ytConfig?.connected ? `Connected: ${ytConfig.channelTitle}` : 'YouTube not connected'}
              </span>
              {!ytConfig?.connected && (
                <button onClick={() => setYtModalOpen(true)} className="ml-auto px-2.5 py-1 rounded-lg bg-red-600 hover:bg-red-500 text-white text-xs font-semibold">Connect channel</button>
              )}
            </div>
            <label className="text-xs text-slate-400 block">Title
              <input value={pubTitle} onChange={e => setPubTitle(e.target.value)} className="mt-1 w-full px-3 py-2 rounded-xl bg-slate-950 border border-slate-800 text-white text-xs" />
            </label>
            <label className="text-xs text-slate-400 block">Description
              <textarea value={pubDesc} onChange={e => setPubDesc(e.target.value)} rows={3} className="mt-1 w-full px-3 py-2 rounded-xl bg-slate-950 border border-slate-800 text-white text-xs" />
            </label>
            <div className="grid grid-cols-2 gap-3">
              <label className="text-xs text-slate-400">Privacy
                <select value={pubPrivacy} onChange={e => setPubPrivacy(e.target.value)} className="mt-1 w-full px-3 py-2 rounded-xl bg-slate-950 border border-slate-800 text-white text-xs">
                  <option value="public">Public</option>
                  <option value="unlisted">Unlisted</option>
                  <option value="private">Private</option>
                </select>
              </label>
              <label className="text-xs text-slate-400">Schedule (optional)
                <input type="datetime-local" value={pubWhen} onChange={e => setPubWhen(e.target.value)} className="mt-1 w-full px-3 py-2 rounded-xl bg-slate-950 border border-slate-800 text-white text-xs" />
              </label>
            </div>
            {publishMsg && <p className="text-xs text-slate-300">{publishMsg}</p>}
            <div className="flex items-center gap-2">
              <button
                disabled={publishing || !ytConfig?.connected}
                onClick={async () => {
                  if (!publishFile) return;
                  setPublishing(true); setPublishMsg(null);
                  try {
                    if (pubWhen) {
                      await fetch(`/api/uploads/${publishFile.id}/youtube-schedule`, { method: 'POST', headers: { 'Content-Type': 'application/json' }, body: JSON.stringify({ scheduledAt: pubWhen }) });
                      setPublishMsg('Scheduled for YouTube upload.');
                    } else {
                      const res = await fetch(`/api/uploads/${publishFile.id}/youtube-publish`, { method: 'POST', headers: { 'Content-Type': 'application/json' }, body: JSON.stringify({ title: pubTitle, description: pubDesc, privacyStatus: pubPrivacy }) });
                       const data = await res.json();
                       if (!res.ok || !data?.success) throw new Error(data?.error || 'Publish failed');
                       setPublishMsg('Published to YouTube.');
                       setTimeout(() => setPublishFile(null), 800);
                    }
                    await load();
                  } catch (e: any) { setPublishMsg(e?.message || 'Failed'); }
                  finally { setPublishing(false); }
                }}
                className="px-4 py-2 rounded-xl bg-red-600 hover:bg-red-500 text-white text-xs font-bold disabled:opacity-50"
              >
                {publishing ? 'Working…' : (pubWhen ? 'Schedule' : 'Publish now')}
              </button>
              <button onClick={() => setPublishFile(null)} className="px-4 py-2 rounded-xl bg-slate-800 hover:bg-slate-700 text-slate-200 text-xs font-bold">Close</button>
            </div>
          </div>
        </div>
      )}

      <YouTubeSettingsModal isOpen={ytModalOpen} onClose={() => { setYtModalOpen(false); fetch('/api/youtube/config').then(r => r.ok ? r.json() : null).then(d => { if (d?.config) setYtConfig(d.config); }).catch(() => {}); }} />
    </div>
  );
};

export default UploaderView;
