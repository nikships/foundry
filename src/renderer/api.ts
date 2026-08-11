import type { FoundryApi } from '@shared/ipc-contract.js';
import { installMockFoundryIfNeeded } from './mockFoundry.js';

declare global {
  interface Window {
    foundry: FoundryApi;
    foundryMenu: { on(handler: (command: string) => void): () => void };
    __foundryWebMockInstalled?: boolean;
  }
}

// In a plain browser (vite web) there is no Electron preload, so provide a
// mocked FoundryApi that lets the UI render and navigate.
if (typeof window !== 'undefined' && !window.foundry && !window.__foundryWebMockInstalled) {
  installMockFoundryIfNeeded();
}

/**
 * Everything crossing `ipcRenderer.invoke` is structured-cloned, and that
 * algorithm rejects anything the renderer may have wrapped: a Proxy, a class
 * instance, an accessor. The throw lands in a rejected promise a click handler
 * never awaits, so the only symptom is a Save button that appears to do
 * nothing.
 *
 * A JSON round trip flattens the payload to the plain data this bridge is
 * declared to carry, so a draft can never fail to serialise.
 */
export function plain<T>(value: T): T {
  if (value === null || typeof value !== 'object') return value;
  return JSON.parse(JSON.stringify(value)) as T;
}

/** Applies `plain` to every argument, so no call site has to remember to. */
function guard<T extends object>(target: T): T {
  const out: Record<string, unknown> = {};
  for (const [key, value] of Object.entries(target)) {
    if (typeof value === 'function') {
      const fn = value as (...args: unknown[]) => unknown;
      out[key] = (...args: unknown[]) => fn(...args.map(plain));
    } else if (value && typeof value === 'object') {
      out[key] = guard(value);
    } else {
      out[key] = value;
    }
  }
  return out as T;
}

const guarded = guard(window.foundry);

export const api: FoundryApi = {
  ...guarded,
  runs: {
    ...guarded.runs,
    contextBreakdown: (projectId, runId, agent) =>
      window.foundry.runs.contextBreakdown(projectId, runId, agent),
  },
};
export const menu = window.foundryMenu;
