'use strict';
/**
 * electron-ghostty renderer side, sandbox-compatible. Use directly as
 * a BrowserWindow preload, or require it from your own preload.
 *
 * Supports MULTIPLE terminals per page: every `<canvas data-ghostty>`
 * is a terminal slot, identified by the attribute's value (empty
 * string is a valid slot name — the default for a single terminal).
 * The main process attaches a GhosttyTerminal to a slot with
 * `term.attach(webContents, { slot })`; frames arrive tagged with the
 * slot and are painted into that slot's canvas.
 *
 * Input routing: mouse events carry the slot of the canvas they hit;
 * keyboard/paste go to the slot of the focused canvas (canvases get
 * tabindex focus), falling back to the single slot when there is only
 * one. CSS size changes are reported per canvas (ResizeObserver) so
 * ghostty reflows the grid + resizes the PTY (SIGWINCH).
 */
const { sharedTexture, ipcRenderer } = require('electron');

const CH = (name) => `electron-ghostty:${name}`;

const canvases = new Map(); // slot -> canvas

function slotOf(canvas) {
  return canvas.getAttribute('data-ghostty') ?? '';
}

/** The slot input should go to: the focused canvas, else the only one. */
function focusedSlot() {
  const active = document.activeElement;
  if (active && canvases.get(slotOf(active)) === active) return slotOf(active);
  if (canvases.size === 1) return canvases.keys().next().value;
  return null;
}

sharedTexture.setSharedTextureReceiver(async (data, slot) => {
  const { importedSharedTexture: imported } = data;
  let frame = null;
  try {
    frame = imported.getVideoFrame();
    const canvas = canvases.get(slot ?? '');
    if (canvas) {
      if (canvas.width !== frame.displayWidth || canvas.height !== frame.displayHeight) {
        canvas.width = frame.displayWidth;
        canvas.height = frame.displayHeight;
      }
      canvas.getContext('2d').drawImage(frame, 0, 0);
    }
  } finally {
    if (frame) frame.close();
    imported.release();
  }
});

/* DOM KeyboardEvent.code -> macOS virtual keycode. Ghostty's embedded
 * API takes native keycodes and maps them to physical keys itself
 * (apprt/embedded.zig keycode table). Covers the practical set. */
const MAC_KEYCODE = {
  KeyA: 0, KeyS: 1, KeyD: 2, KeyF: 3, KeyH: 4, KeyG: 5, KeyZ: 6, KeyX: 7,
  KeyC: 8, KeyV: 9, KeyB: 11, KeyQ: 12, KeyW: 13, KeyE: 14, KeyR: 15,
  KeyY: 16, KeyT: 17, Digit1: 18, Digit2: 19, Digit3: 20, Digit4: 21,
  Digit6: 22, Digit5: 23, Equal: 24, Digit9: 25, Digit7: 26, Minus: 27,
  Digit8: 28, Digit0: 29, BracketRight: 30, KeyO: 31, KeyU: 32,
  BracketLeft: 33, KeyI: 34, KeyP: 35, Enter: 36, KeyL: 37, KeyJ: 38,
  Quote: 39, KeyK: 40, Semicolon: 41, Backslash: 42, Comma: 43, Slash: 44,
  KeyN: 45, KeyM: 46, Period: 47, Tab: 48, Space: 49, Backquote: 50,
  Backspace: 51, Escape: 53, F5: 96, F6: 97, F7: 98, F3: 99, F8: 100,
  F9: 101, F11: 103, F10: 109, F12: 111, Home: 115, PageUp: 116,
  Delete: 117, F4: 118, End: 119, F2: 120, PageDown: 121, F1: 122,
  ArrowLeft: 123, ArrowRight: 124, ArrowDown: 125, ArrowUp: 126,
};

function domMods(e) {
  // ghostty_input_mods_e bitmask
  return (e.shiftKey ? 1 : 0) | (e.ctrlKey ? 2 : 0) | (e.altKey ? 4 : 0) |
         (e.metaKey ? 8 : 0);
}

function send(name, slot, payload) {
  ipcRenderer.send(CH(name), { slot, ...payload });
}

window.addEventListener('DOMContentLoaded', () => {
  for (const canvas of document.querySelectorAll('canvas[data-ghostty]'))
    canvases.set(slotOf(canvas), canvas);
  // Back-compat: a bare first <canvas> with no data-ghostty attribute.
  if (canvases.size === 0) {
    const canvas = document.querySelector('canvas');
    if (canvas) canvases.set('', canvas);
  }
  if (canvases.size === 0) return;
  canvases.values().next().value.focus();

  window.addEventListener('keydown', (e) => {
    if (e.metaKey) return; // Cmd shortcuts stay with the app
    // IME composition (CJK, dead keys, emoji picker): the DOM fires
    // keydowns with isComposing while the IME assembles text; sending
    // those through the key encoder would type garbage. The composed
    // result arrives via the 'compositionend'/'input' path below.
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
        unshiftedCodepoint:
          e.key.length === 1 ? e.key.toLowerCase().codePointAt(0) : 0,
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
    const text = e.clipboardData.getData('text');
    if (text) send('text', slot, { text });
  });

  // IME: composed text (CJK conversion commit, dead-key accents,
  // emoji picker) goes through the cooked-text path — the same one
  // paste uses — once composition finishes.
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

  for (const [slot, canvas] of canvases) {
    if (!canvas.hasAttribute('tabindex')) canvas.setAttribute('tabindex', '0');

    const rel = (e) => {
      const r = canvas.getBoundingClientRect();
      return { x: e.clientX - r.left, y: e.clientY - r.top };
    };

    canvas.addEventListener('wheel', (e) => {
      e.preventDefault();
      const p = rel(e);
      // Ghostty expects scroll deltas with up = positive.
      send('mouse-scroll', slot, { ...p, dx: -e.deltaX, dy: -e.deltaY });
    }, { passive: false });

    // DOM button -> ghostty_input_mouse_button_e (1=left 2=right 3=middle)
    const GHOSTTY_BUTTON = [1, 3, 2, 4, 5];
    canvas.addEventListener('mousedown', (e) => {
      canvas.focus();
      send('mouse-button', slot, {
        action: 1, button: GHOSTTY_BUTTON[e.button] ?? 0, mods: domMods(e),
      });
    });
    canvas.addEventListener('mouseup', (e) => {
      send('mouse-button', slot, {
        action: 0, button: GHOSTTY_BUTTON[e.button] ?? 0, mods: domMods(e),
      });
    });
    canvas.addEventListener('mousemove', (e) => {
      send('mouse-pos', slot, { ...rel(e), mods: domMods(e) });
    });

    // The canvas element drives the surface size: report CSS size
    // changes and ghostty reflows the grid + resizes the PTY. The
    // bitmap size is set by the receiver above from presented frames.
    const reportSize = () => {
      const r = canvas.getBoundingClientRect();
      if (r.width > 0 && r.height > 0)
        send('resize', slot, { cssWidth: r.width, cssHeight: r.height });
    };
    new ResizeObserver(reportSize).observe(canvas);

    requestAnimationFrame(() => requestAnimationFrame(() => {
      reportSize();
      send('ready', slot, {});
    }));
  }
});
