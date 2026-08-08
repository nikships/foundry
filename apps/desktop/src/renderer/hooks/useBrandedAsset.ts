import { useEffect, useState } from 'react';
import { api } from '../api.js';

/**
 * Resolves an asset path through main's `assetUrl`. The returned URL is a
 * `file://` (packaged) or `/assets/...` (web preview) string; empty until the
 * async resolve lands.
 */
export function useBrandedAsset(relPath: string | null): string {
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
  }, [relPath]);

  return src;
}
