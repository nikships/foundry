import { useState } from 'react';
import type { BrandId } from '@shared/types.js';

/**
 * The brand is fixed for the lifetime of a window: main reads it from settings
 * before `BrowserWindow` exists and passes it as `?brand=`, so the query string
 * is the only source that is trustworthy before the first paint.
 */
export function resolveBrand(): BrandId {
  const match = /[?&]brand=(prism|murmur)\b/.exec(location.search);
  return match?.[1] === 'murmur' ? 'murmur' : 'prism';
}

/** Reads the window's brand. Switching brands requires a relaunch, so this never changes. */
export function useBrand(): BrandId {
  const [brand] = useState<BrandId>(resolveBrand);
  return brand;
}
