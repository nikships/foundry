import { useEffect, useState } from 'react';
import { api } from '../api.js';
import { useApp } from '../stores/app.js';

/**
 * Resolves an asset path through main's brand-aware `assetUrl`, re-resolving
 * whenever the brand flips so in-app visuals swap without a restart.
 */
export function useBrandedAsset(relPath: string | null): string {
  const { settings } = useApp();
  const brand = settings?.brand;
  const [src, setSrc] = useState('');

  useEffect(() => {
    if (!relPath) {
      setSrc('');
      return;
    }
    let cancelled = false;
    void api.app.assetUrl(relPath).then((url) => {
      if (!cancelled) setSrc(url);
    });
    return () => {
      cancelled = true;
    };
  }, [relPath, brand]);

  return src;
}
