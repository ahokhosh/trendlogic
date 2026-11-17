import React, { useEffect, useState } from 'react';
import { proxiedImg } from './img';

/**
 * Resilient trend photo: tries the same-origin proxy first (fixes hotlink
 * guards / TLS quirks / geo blocks that break direct browser loads), falls
 * back to the direct origin URL once (covers the reverse case — a proxy the
 * server can't reach but the browser can), and only then disappears.
 * Whichever side has a working route, the viewer sees the photo.
 */
export const SmartImg: React.FC<{
  src?: string | null;
  alt?: string;
  className?: string;
  loading?: 'lazy' | 'eager';
  onHide?: () => void;
}> = ({ src, alt, className, loading = 'lazy', onHide }) => {
  const raw = String(src || '').trim();
  const [phase, setPhase] = useState(0); // 0 = proxy, 1 = direct, 2 = hidden
  const [hidden, setHidden] = useState(false);

  useEffect(() => {
    setPhase(0);
    setHidden(false);
  }, [raw]);

  useEffect(() => {
    if (hidden) onHide?.();
  }, [hidden, onHide]);

  if (!raw || hidden) return null;
  const proxied = proxiedImg(raw);
  // Local data/blob URLs pass through untouched — a "proxy" miss on those
  // means the asset itself is gone, so skip straight to hiding.
  if (phase === 0 && proxied === raw) {
    return (
      <img
        src={raw}
        alt={alt}
        className={className}
        loading={loading}
        onError={() => setHidden(true)}
      />
    );
  }
  if (phase > 1) return null;
  return (
    <img
      src={phase === 0 ? proxied : raw}
      alt={alt}
      className={className}
      loading={loading}
      onError={() => {
        if (phase === 0) setPhase(1);
        else setHidden(true);
      }}
    />
  );
};
