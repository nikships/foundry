import { useEffect, useState } from 'react';

const QUERY = '(prefers-reduced-motion: reduce)';

function matches(): boolean {
  try {
    return window.matchMedia(QUERY).matches;
  } catch {
    return false;
  }
}

/**
 * Tracks the OS reduced-motion preference live. Both animated brand surfaces
 * (the Prism field and the Murmur flock) unmount rather than throttle, so the
 * hook has to re-render when the preference flips mid-session.
 */
export function useReducedMotion(): boolean {
  const [reduced, setReduced] = useState(matches);
  useEffect(() => {
    const list = window.matchMedia(QUERY);
    const onChange = (): void => setReduced(list.matches);
    list.addEventListener('change', onChange);
    return () => list.removeEventListener('change', onChange);
  }, []);
  return reduced;
}
