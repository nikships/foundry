/**
 * Hardened access to `localStorage`.
 *
 * Reading `window.localStorage` throws a SecurityError in sandboxed contexts
 * or when storage access is restricted by policy. Using these helpers avoids
 * an uncaught top-level error during first render.
 */

export function safeGetItem(key: string): string | null {
  try {
    return localStorage.getItem(key);
  } catch {
    return null;
  }
}

export function safeSetItem(key: string, value: string): void {
  try {
    localStorage.setItem(key, value);
  } catch {
    // Storage quota exceeded or disabled.
  }
}
