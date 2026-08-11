/**
 * `localStorage` that cannot throw.
 *
 * Access is a SecurityError, not a null, in a sandboxed iframe or a browser
 * with site data blocked — and these reads happen during the first render, so
 * an unguarded one takes the whole renderer down before it paints. Losing a
 * remembered selection is an acceptable outcome; a blank window is not.
 */
export function readLocal(key: string): string {
  try {
    return localStorage.getItem(key) ?? '';
  } catch {
    return '';
  }
}

export function writeLocal(key: string, value: string): void {
  try {
    localStorage.setItem(key, value);
  } catch {
    // Storage is unavailable; the selection just won't survive a reload.
  }
}
