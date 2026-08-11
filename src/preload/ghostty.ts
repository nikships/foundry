/**
 * Renderer glue for the embedded Ghostty terminal (Smith). Adapted from
 * vendor/electron-ghostty/preload.js (MIT) with one structural change: canvases
 * are discovered dynamically via MutationObserver rather than once at
 * DOMContentLoaded, because Smith's canvas mounts inside a React modal long
 * after page load and unmounts when the modal hides.
 *
 * Everything here talks the vendored package's own `electron-ghostty:*` IPC
 * protocol — frames arrive via `sharedTexture.setSharedTextureReceiver` tagged
 * with a slot (the canvas's `data-ghostty` attribute), and input flows back as
 * ghostty-native key/mouse events. Ghostty owns the PTY, VT parsing, and input
 * encoding; none of this passes through the FoundryApi contract.
 *
 * Registering a canvas sends `ready` for its slot, which nudges the main-side
 * engine to draw — that is what repaints scrollback when the modal reopens.
 */

import * as electron from 'electron';
import { ipcRenderer } from 'electron';

// `sharedTexture` (Electron >= 41) is not in the electron TS surface this app
// compiles against everywhere; the runtime object is what matters.
interface ImportedSharedTexture {
  getVideoFrame(): VideoFrame;
  release(): void;
}
interface SharedTextureModule {
  setSharedTextureReceiver(
    receiver: (data: { importedSharedTexture: ImportedSharedTexture }, slot?: string) => void,
  ): void;
}

const CH = (name: string): string => `electron-ghostty:${name}`;

/* DOM KeyboardEvent.code -> macOS virtual keycode. Ghostty's embedded API takes
 * native keycodes and maps them to physical keys itself (apprt/embedded.zig).
 * Same table as the vendored preload. */
const MAC_KEYCODE: Record<string, number> = {
  KeyA: 0,
  KeyS: 1,
  KeyD: 2,
  KeyF: 3,
  KeyH: 4,
  KeyG: 5,
  KeyZ: 6,
  KeyX: 7,
  KeyC: 8,
  KeyV: 9,
  KeyB: 11,
  KeyQ: 12,
  KeyW: 13,
  KeyE: 14,
  KeyR: 15,
  KeyY: 16,
  KeyT: 17,
  Digit1: 18,
  Digit2: 19,
  Digit3: 20,
  Digit4: 21,
  Digit6: 22,
  Digit5: 23,
  Equal: 24,
  Digit9: 25,
  Digit7: 26,
  Minus: 27,
  Digit8: 28,
  Digit0: 29,
  BracketRight: 30,
  KeyO: 31,
  KeyU: 32,
  BracketLeft: 33,
  KeyI: 34,
  KeyP: 35,
  Enter: 36,
  KeyL: 37,
  KeyJ: 38,
  Quote: 39,
  KeyK: 40,
  Semicolon: 41,
  Backslash: 42,
  Comma: 43,
  Slash: 44,
  KeyN: 45,
  KeyM: 46,
  Period: 47,
  Tab: 48,
  Space: 49,
  Backquote: 50,
  Backspace: 51,
  Escape: 53,
  F5: 96,
  F6: 97,
  F7: 98,
  F3: 99,
  F8: 100,
  F9: 101,
  F11: 103,
  F10: 109,
  F12: 111,
  Home: 115,
  PageUp: 116,
  Delete: 117,
  F4: 118,
  End: 119,
  F2: 120,
  PageDown: 121,
  F1: 122,
  ArrowLeft: 123,
  ArrowRight: 124,
  ArrowDown: 125,
  ArrowUp: 126,
};

/* DOM button -> ghostty_input_mouse_button_e (1=left 3=right 2=middle). */
const GHOSTTY_BUTTON = [1, 3, 2, 4, 5];

function domMods(e: KeyboardEvent | MouseEvent): number {
  // ghostty_input_mods_e bitmask
  return (e.shiftKey ? 1 : 0) | (e.ctrlKey ? 2 : 0) | (e.altKey ? 4 : 0) | (e.metaKey ? 8 : 0);
}

function send(name: string, slot: string, payload: Record<string, unknown>): void {
  ipcRenderer.send(CH(name), { slot, ...payload });
}

export function wireGhosttyRenderer(): void {
  // Non-darwin dev and the web preview have no engine; frames simply never
  // arrive. Read `sharedTexture` defensively so an Electron without the module
  // cannot throw during preload evaluation and take the whole bridge down.
  const sharedTexture =
    (electron as unknown as { sharedTexture?: SharedTextureModule }).sharedTexture ?? null;
  if (!sharedTexture) return;

  const canvases = new Map<string, HTMLCanvasElement>(); // slot -> canvas
  const observers = new Map<string, ResizeObserver>();
  const teardowns = new Map<string, () => void>();

  const slotOf = (canvas: Element): string => canvas.getAttribute('data-ghostty') ?? '';

  /** The slot input should go to: the focused canvas, else the only one. */
  function focusedSlot(): string | null {
    const active = document.activeElement;
    if (active && canvases.get(slotOf(active)) === active) return slotOf(active);
    if (canvases.size === 1) {
      const first = canvases.keys().next();
      return first.done ? null : first.value;
    }
    return null;
  }

  sharedTexture.setSharedTextureReceiver((data, slot) => {
    const { importedSharedTexture: imported } = data;
    let frame: VideoFrame | null = null;
    try {
      frame = imported.getVideoFrame();
      const canvas = canvases.get(slot ?? '');
      if (canvas) {
        if (canvas.width !== frame.displayWidth || canvas.height !== frame.displayHeight) {
          canvas.width = frame.displayWidth;
          canvas.height = frame.displayHeight;
        }
        canvas.getContext('2d')?.drawImage(frame, 0, 0);
      }
    } finally {
      if (frame) frame.close();
      imported.release();
    }
  });

  /* ── window-level input, routed to the focused canvas's slot ─────────── */

  window.addEventListener('keydown', (e) => {
    if (e.metaKey) return; // Cmd shortcuts stay with the app (⌘6, ⌘W, …)
    // IME composition (CJK, dead keys): composed text arrives via
    // 'compositionend' below; raw keydowns mid-composition would type garbage.
    if (e.isComposing || e.keyCode === 229) return;
    const slot = focusedSlot();
    if (slot === null) return;
    const keycode = MAC_KEYCODE[e.code];
    if (keycode === undefined && e.key.length !== 1) return;
    e.preventDefault();
    send('key', slot, {
      event: {
        action: 1, // press
        keycode: keycode ?? 0,
        mods: domMods(e),
        // Printable text: ghostty's encoder uses it for the byte stream.
        text: e.key.length === 1 && !e.ctrlKey ? e.key : undefined,
        unshiftedCodepoint: e.key.length === 1 ? e.key.toLowerCase().codePointAt(0) : 0,
      },
    });
  });

  window.addEventListener('keyup', (e) => {
    if (e.isComposing || e.keyCode === 229) return;
    const slot = focusedSlot();
    if (slot === null) return;
    const keycode = MAC_KEYCODE[e.code];
    if (keycode === undefined) return;
    send('key', slot, { event: { action: 0, keycode, mods: domMods(e) } });
  });

  window.addEventListener('paste', (e) => {
    const slot = focusedSlot();
    if (slot === null) return;
    const text = e.clipboardData?.getData('text');
    if (text) send('text', slot, { text });
  });

  // IME: composed text (CJK commit, dead-key accents, emoji picker) goes
  // through the cooked-text path — the same one paste uses.
  window.addEventListener('compositionend', (e) => {
    const slot = focusedSlot();
    if (slot === null) return;
    if (e.data) send('text', slot, { text: e.data });
  });

  // Window focus/blur -> ghostty focus reporting (DECSET 1004) and
  // unfocused-cursor rendering.
  window.addEventListener('focus', () => {
    const slot = focusedSlot();
    if (slot !== null) send('focus', slot, { focused: true });
  });
  window.addEventListener('blur', () => {
    const slot = focusedSlot();
    if (slot !== null) send('focus', slot, { focused: false });
  });

  /* ── per-canvas wiring (mouse, resize, ready) ────────────────────────── */

  function register(canvas: HTMLCanvasElement): void {
    const slot = slotOf(canvas);
    if (canvases.get(slot) === canvas) return;
    canvases.set(slot, canvas);
    if (!canvas.hasAttribute('tabindex')) canvas.setAttribute('tabindex', '0');

    const rel = (e: MouseEvent): { x: number; y: number } => {
      const r = canvas.getBoundingClientRect();
      // CSS (unscaled) coordinates pass through untouched: ghostty's
      // cursorPosCallback scales by content-scale itself. Multiplying here
      // double-scales and clicks land on the wrong cell.
      return { x: e.clientX - r.left, y: e.clientY - r.top };
    };

    const onWheel = (e: WheelEvent): void => {
      e.preventDefault();
      const p = rel(e);
      // Ghostty treats non-precision scroll deltas as wheel TICKS (one tick =
      // one line, multiplied by cell height internally), but DOM wheel events
      // on macOS trackpads/high-res mice report PIXELS (deltaMode 0). Sending
      // raw pixels scrolls dozens of lines per gesture, so normalize pixel
      // deltas to lines first. Fractional ticks are fine — ghostty accumulates
      // sub-line remainders.
      const LINE_PX = 17; // ≈ cell height in CSS px at the engine's 13pt font
      const lines = (d: number): number => {
        switch (e.deltaMode) {
          case WheelEvent.DOM_DELTA_LINE:
            return d;
          case WheelEvent.DOM_DELTA_PAGE:
            return d * 24;
          default:
            return d / LINE_PX;
        }
      };
      // Ghostty expects scroll deltas with up = positive.
      send('mouse-scroll', slot, { ...p, dx: -lines(e.deltaX), dy: -lines(e.deltaY) });
    };
    const onMouseDown = (e: MouseEvent): void => {
      canvas.focus();
      send('mouse-button', slot, {
        action: 1,
        button: GHOSTTY_BUTTON[e.button] ?? 0,
        mods: domMods(e),
      });
    };
    const onMouseUp = (e: MouseEvent): void => {
      send('mouse-button', slot, {
        action: 0,
        button: GHOSTTY_BUTTON[e.button] ?? 0,
        mods: domMods(e),
      });
    };
    const onMouseMove = (e: MouseEvent): void => {
      send('mouse-pos', slot, { ...rel(e), mods: domMods(e) });
    };

    canvas.addEventListener('wheel', onWheel, { passive: false });
    canvas.addEventListener('mousedown', onMouseDown);
    canvas.addEventListener('mouseup', onMouseUp);
    canvas.addEventListener('mousemove', onMouseMove);
    teardowns.set(slot, () => {
      canvas.removeEventListener('wheel', onWheel);
      canvas.removeEventListener('mousedown', onMouseDown);
      canvas.removeEventListener('mouseup', onMouseUp);
      canvas.removeEventListener('mousemove', onMouseMove);
    });

    // The canvas element drives the surface size: CSS size changes reflow the
    // grid and resize the PTY (SIGWINCH). Bitmap size is set by the frame
    // receiver above.
    const reportSize = (): void => {
      const r = canvas.getBoundingClientRect();
      if (r.width > 0 && r.height > 0) {
        send('resize', slot, { cssWidth: r.width, cssHeight: r.height });
      }
    };
    const observer = new ResizeObserver(reportSize);
    observer.observe(canvas);
    observers.set(slot, observer);

    // Two frames so layout settles before the first size report; `ready` kicks
    // the engine to draw, which repaints a reopened modal from live state.
    requestAnimationFrame(() =>
      requestAnimationFrame(() => {
        if (canvases.get(slot) !== canvas) return;
        reportSize();
        send('ready', slot, {});
        canvas.focus();
      }),
    );
  }

  function unregister(canvas: HTMLCanvasElement): void {
    const slot = slotOf(canvas);
    if (canvases.get(slot) !== canvas) return;
    canvases.delete(slot);
    observers.get(slot)?.disconnect();
    observers.delete(slot);
    teardowns.get(slot)?.();
    teardowns.delete(slot);
  }

  function scan(root: ParentNode): void {
    for (const canvas of root.querySelectorAll('canvas[data-ghostty]')) {
      register(canvas as HTMLCanvasElement);
    }
  }

  window.addEventListener('DOMContentLoaded', () => {
    scan(document);
    const observer = new MutationObserver((mutations) => {
      for (const mutation of mutations) {
        for (const node of mutation.addedNodes) {
          if (!(node instanceof Element)) continue;
          if (node instanceof HTMLCanvasElement && node.hasAttribute('data-ghostty')) {
            register(node);
          } else {
            scan(node);
          }
        }
        for (const node of mutation.removedNodes) {
          if (!(node instanceof Element)) continue;
          if (node instanceof HTMLCanvasElement && node.hasAttribute('data-ghostty')) {
            unregister(node);
          } else {
            for (const canvas of node.querySelectorAll('canvas[data-ghostty]')) {
              unregister(canvas as HTMLCanvasElement);
            }
          }
        }
      }
    });
    observer.observe(document.documentElement, { childList: true, subtree: true });
  });
}
