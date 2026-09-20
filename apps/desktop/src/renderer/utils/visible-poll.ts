/**
 * Visual data needs no refresh while Electron's window is hidden/minimized.
 * Resume immediately, keep at most one read in flight, and coalesce refreshes
 * received during a read so a pushed change cannot be lost. Notification and
 * engine work deliberately do not use this lifecycle.
 */
export function pollWhileVisible(
  read: (signal: AbortSignal) => void | Promise<void>,
  cadence: () => number | null,
): { refresh: () => Promise<void>; stop: () => void } {
  const controller = new AbortController();
  let timer: number | undefined;
  let running: Promise<void> | undefined;
  let queued = false;
  const clearTimer = (): void => {
    window.clearTimeout(timer);
    timer = undefined;
  };
  const visible = (): boolean => !controller.signal.aborted && !document.hidden;

  // Callers handle read failures (including displaying errors) themselves.
  const refresh = (): Promise<void> => {
    clearTimer();
    if (!visible()) return Promise.resolve();
    if (running) {
      queued = true;
      return running;
    }
    running = (async () => {
      do {
        queued = false;
        await read(controller.signal);
      } while (queued && visible());
    })().finally(() => {
      running = undefined;
      const ms = cadence();
      if (visible() && ms !== null) {
        timer = window.setTimeout(() => void refresh(), ms);
      }
    });
    return running;
  };

  const onVisibility = (): void => {
    clearTimer();
    if (visible()) void refresh();
    else queued = false;
  };
  document.addEventListener('visibilitychange', onVisibility);
  void refresh();
  return {
    refresh,
    stop: () => {
      controller.abort();
      clearTimer();
      document.removeEventListener('visibilitychange', onVisibility);
    },
  };
}
