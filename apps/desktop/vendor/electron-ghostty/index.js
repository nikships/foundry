'use strict';
/**
 * electron-ghostty — ghostty embedded headlessly in an Electron app.
 *
 * Ghostty owns EVERYTHING (PTY + shell, VT parsing, key/mouse encoding,
 * selection, fonts/shaping, Metal rendering, IOSurface presentation);
 * this package is the Electron glue: it ticks ghostty's app loop,
 * routes input from the renderer, and ships presented IOSurfaces
 * zero-copy into a sandboxed <canvas> via the sharedTexture module.
 *
 * Main process:
 *   const { GhosttyTerminal } = require('electron-ghostty');
 *   const term = new GhosttyTerminal({ scale, fontSize: 13 });
 *   term.attach(win.webContents);
 *   term.on('exit', () => app.quit());
 *
 * Renderer: sandboxed page with a <canvas data-ghostty> and this
 * package's preload (see preload.js). The canvas is the source of
 * truth for sizing — a ResizeObserver reports CSS size changes and
 * ghostty reflows the grid + resizes the PTY (SIGWINCH) internally.
 *
 * Engine placement — opts.engine:
 *   'utility' (default)  the whole engine runs in an Electron
 *       utilityProcess (host.js); each presented frame arrives in the
 *       main process as a mach send-right (IOSurfaceCreateMachPort)
 *       and is imported into sharedTexture. A busy or crashed
 *       terminal can't stall window management, and the path stays
 *       zero-copy — frames never leave the GPU.
 *   'main'  the engine runs in this process (the original mode; also
 *       what tests use to assert on pixels synchronously).
 */
const { EventEmitter } = require('events');
const path = require('path');
const crypto = require('crypto');
const { clipboard, ipcMain, sharedTexture, utilityProcess } = require('electron');
const { load, available } = require('./addon');
const { checkOp } = require('./protocol');

const CH = (name) => `electron-ghostty:${name}`;

/* ghostty_action_mouse_shape_e (ghostty.h order) -> CSS cursor name. */
const MOUSE_SHAPE_CSS = [
  'default', 'context-menu', 'help', 'pointer', 'progress', 'wait',
  'cell', 'crosshair', 'text', 'vertical-text', 'alias', 'copy', 'move',
  'no-drop', 'not-allowed', 'grab', 'grabbing', 'all-scroll',
  'col-resize', 'row-resize', 'n-resize', 'e-resize', 's-resize',
  'w-resize', 'ne-resize', 'nw-resize', 'se-resize', 'sw-resize',
  'ew-resize', 'ns-resize', 'nesw-resize', 'nwse-resize', 'zoom-in',
  'zoom-out',
];
const PRESENT_INTERVAL_MS = 8; // ~120Hz poll of ghostty's swap chain
const RESIZE_DEBOUNCE_MS = 80;

let addonInited = false;
let ipcWired = false;
// "<webContentsId>\u0000<slot>" -> GhosttyTerminal. The slot is the
// value of the canvas's data-ghostty attribute ('' for the single-
// terminal default), so N terminals can share one page.
const bySlot = new Map();
const slotKey = (wcId, slot) => `${wcId}\u0000${slot ?? ''}`;

/* One ipcMain wiring for all terminals; events route by sender+slot. */
function wireIpc() {
  if (ipcWired) return;
  ipcWired = true;
  const route = (name, fn) =>
    ipcMain.on(CH(name), (event, arg) => {
      const term = bySlot.get(slotKey(event.sender.id, arg?.slot));
      if (term && !term._destroyed) fn(term, arg);
    });
  route('ready', (t) => t._onRendererReady());
  route('resize', (t, { cssWidth, cssHeight }) =>
    t._onCanvasResize(cssWidth, cssHeight));
  route('key', (t, { event }) => t.key(event));
  route('text', (t, { text }) => t.text(text));
  route('focus', (t, { focused }) => t.setFocus(focused));
  route('mouse-button', (t, { action, button, mods }) =>
    t.mouseButton(action, button, mods));
  // CSS (unscaled) coordinates pass through untouched: ghostty's
  // cursorPosCallback scales by content-scale itself
  // (cursorPosToPixels). Multiplying here double-scales — clicks land
  // on the cell at 2x the intended position (caught by
  // test/input-translation.main.js).
  route('mouse-pos', (t, { x, y, mods }) => t.mousePos(x, y, mods));
  route('mouse-scroll', (t, { x, y, dx, dy }) =>
    t.mouseScroll(x, y, dx, dy));
}

/* ── engine drivers ─────────────────────────────────────────────────
 * Same contract, two placements. The terminal talks to a driver;
 * frames flow driver -> terminal._presentFrame(textureInfoHandle). */

/** Engine in this process: the addon drives ghostty directly. */
class LocalEngine {
  constructor(term, opts) {
    this._term = term;
    this._addon = load();
    if (!addonInited) {
      this._addon.init();
      addonInited = true;
    }
    this._handle = this._addon.create(opts);
    this._timer = null;
    this._lastFramePtr = null;
    this._exited = false;
  }

  start() {
    this._addon.draw(this._handle);
    if (!this._timer) {
      this._timer = setInterval(() => this._tick(), PRESENT_INTERVAL_MS);
    }
  }

  _tick() {
    // Always tick ghostty (drain its mailbox) — only frame PRESENTATION
    // waits for the in-flight send. Gating the whole tick on _sending
    // would starve the engine exactly when the presenter is busy, and
    // diverges from the utility host, which ticks unconditionally.
    this._addon.tick(this._handle);
    for (const event of this._addon.drainEvents(this._handle))
      this._term._onEngineEvent(event);
    if (this._addon.processExited(this._handle)) {
      if (!this._exited) {
        this._exited = true;
        this.stop();
        this._term._onExit();
      }
      return;
    }
    if (this._term._sending) return; // present later; don't advance dedup
    const frame = this._addon.frame(this._handle);
    if (!frame) return;
    // The swap chain rotates surfaces, so a new frame = a new pointer.
    const ptr = frame.handle.toString('hex');
    if (ptr === this._lastFramePtr) return;
    this._lastFramePtr = ptr;
    this._term._presentFrame(
      { ioSurface: frame.handle }, frame.width, frame.height);
  }

  stop() {
    if (this._timer) clearInterval(this._timer);
    this._timer = null;
  }

  send(method, ...args) {
    checkOp(method, args);
    this._addon[method](this._handle, ...args);
  }
  size() { return this._addon.size(this._handle); }
  processExited() { return this._addon.processExited(this._handle); }
  tick() { this._addon.tick(this._handle); }
  draw() { this._addon.draw(this._handle); }
  readPixels() { return this._addon.readPixels(this._handle); }

  destroy() {
    this.stop();
    this._addon.destroy(this._handle);
  }
}

let machChannelSeq = 0;

/**
 * Engine in an Electron utilityProcess (host.js). Frames cross the
 * process boundary as mach send-rights (IOSurfaceCreateMachPort over
 * a bootstrap channel — Electron's parentPort can't carry mach
 * rights); each 'frame' JS message means exactly one mach message is
 * already queued, so the receive here is immediate. State queries
 * (size/readPixels) become async — the sync accessors serve the last
 * known size, tests use the async variants.
 */
class UtilityEngine {
  constructor(term, opts) {
    this._term = term;
    this._addon = load(); // mach channel + surfaceRelease
    this._exited = false;
    this._lastSize = null;
    this._replies = new Map(); // id -> resolve
    this._replySeq = 0;
    // Bootstrap rendezvous name. It lives in the shared per-user
    // bootstrap namespace, so a same-user process that KNEW the name
    // could look up the send right and squat/intercept frames. The
    // name is therefore randomized (not the old guessable pid+counter)
    // — but note the real trust boundary here is same-user: a process
    // running as you can already screenshot or ptrace this app. The
    // mach *port* is an unguessable capability; the name is not
    // relied on as a secret. See SECURITY.md / README threat model.
    const channelName =
      `electron-ghostty.${crypto.randomBytes(16).toString('hex')}.${++machChannelSeq}`;
    this._machChannel = this._addon.machChannelCreate(channelName);
    this._child = utilityProcess.fork(
      path.join(__dirname, 'host.js'),
      [],
      {
        serviceName: 'electron-ghostty engine',
        env: { ...process.env, ELECTRON_GHOSTTY_MACH_CHANNEL: channelName },
      },
    );
    this._child.on('message', (msg) => this._onMessage(msg));
    this._child.on('exit', () => {
      // Engine gone (crash or destroy): flush pending requests so no
      // sizeAsync/readPixelsAsync caller hangs, then surface it like a
      // shell exit.
      for (const resolve of this._replies.values()) resolve(null);
      this._replies.clear();
      if (!this._exited) {
        this._exited = true;
        this._term._onExit();
      }
    });
    this._child.postMessage({ type: 'create', opts });
    this.size(); // prime _lastSize
  }

  start() {
    this.send('draw');
  }

  _onMessage(msg) {
    switch (msg.type) {
      case 'frame': {
        // One-frame-in-flight: this JS message means exactly one mach
        // message is queued on our channel. Drain any stale frames
        // (shouldn't happen; belt-and-suspenders) and keep the newest.
        let recv = this._addon.machChannelReceiveSurface(this._machChannel, 250);
        while (recv && recv.seq < msg.seq) {
          this._addon.surfaceRelease(recv.handle);
          recv = this._addon.machChannelReceiveSurface(this._machChannel, 250);
        }
        if (recv) {
          const surf = recv.handle;
          const ok = this._term._presentFrame(
            { ioSurface: surf }, msg.width, msg.height);
          const release = () => this._addon.surfaceRelease(surf);
          if (ok && typeof ok.then === 'function') ok.then(release, release);
          else release();
        }
        // Ack regardless — a missed receive must not wedge the flow.
        this._child.postMessage({ type: 'frame-ack' });
        break;
      }
      case 'event':
        this._term._onEngineEvent(msg.event);
        break;
      case 'exit':
        if (!this._exited) {
          this._exited = true;
          this._term._onExit();
        }
        break;
      case 'reply': {
        const resolve = this._replies.get(msg.id);
        if (resolve) {
          this._replies.delete(msg.id);
          resolve(msg.result);
        }
        break;
      }
      case 'error':
        this._term.emit('present-error', new Error(msg.message));
        break;
    }
  }

  _request(type) {
    if (this._exited) return Promise.resolve(null);
    const id = ++this._replySeq;
    return new Promise((resolve) => {
      this._replies.set(id, resolve);
      try {
        this._child.postMessage({ type, id });
      } catch {
        this._replies.delete(id);
        resolve(null);
      }
    });
  }

  stop() {}

  send(method, ...args) {
    // One message shape for every session op; the shared table
    // (protocol.js) validates on BOTH sides, so a typo'd or
    // wrong-arity op throws here rather than silently no-oping.
    checkOp(method, args);
    if (this._exited) return;
    try {
      this._child.postMessage({ type: 'op', method, args });
    } catch (err) {
      this._term.emit('present-error', err);
    }
  }

  /** Sync contract: serves the last reply and refreshes in background. */
  size() {
    this._request('size').then((s) => { this._lastSize = s; });
    return this._lastSize;
  }
  sizeAsync() {
    return this._request('size').then((s) => { this._lastSize = s; return s; });
  }
  processExited() { return this._exited; }
  tick() {}
  draw() { this.send('draw'); }
  readPixels() {
    throw new Error(
      "readPixels is async with engine: 'utility' — use readPixelsAsync()");
  }
  readPixelsAsync() {
    return this._request('read-pixels').then((px) => px && {
      ...px, data: Buffer.from(px.data),
    });
  }

  destroy() {
    this._exited = true; // suppress the exit event from our own kill
    this._child.postMessage({ type: 'destroy' });
    // destroy tears down synchronously in the host then exits; kill is
    // the backstop if the host is already wedged.
    setTimeout(() => { try { this._child.kill(); } catch {} }, 1000).unref?.();
  }
}

class GhosttyTerminal extends EventEmitter {
  /**
   * opts: {
   *   scale        devicePixelRatio of the target display (default 2)
   *   fontSize?    pt
   *   command?     spawn this instead of the user's shell. Note:
   *                ghostty execs it directly (login-shell exec), so
   *                compound commands need an explicit `sh -c '…'`.
   *   cwd?         working directory for the shell
   *   config?      ghostty config-file syntax, e.g.
   *                "background = #282c34\nscrollback-limit = 10000000"
   *                — any ghostty option; applied before defaults
   *                finalize.
   *   widthPx?, heightPx?  initial surface size; the attached canvas
   *                takes over sizing as soon as the renderer reports.
   *   engine?      'utility' (default) | 'main' — where ghostty runs.
   * }
   */
  constructor(opts = {}) {
    super();
    this.scale = opts.scale ?? 2;
    this._destroyed = false;
    this._target = null;
    this._resizeTimer = null;
    this._sending = false;
    const engineOpts = {
      widthPx: Math.round(opts.widthPx ?? 960 * this.scale),
      heightPx: Math.round(opts.heightPx ?? 560 * this.scale),
      scale: this.scale,
      ...(opts.fontSize ? { fontSize: opts.fontSize } : {}),
      ...(opts.command ? { command: opts.command } : {}),
      ...(opts.cwd ? { cwd: opts.cwd } : {}),
      ...(opts.config ? { config: opts.config } : {}),
    };
    this.engine = opts.engine ?? 'utility';
    this._engine = this.engine === 'main'
      ? new LocalEngine(this, engineOpts)
      : new UtilityEngine(this, engineOpts);
  }

  /**
   * Bind this terminal to a BrowserWindow's webContents. The present
   * loop starts when the renderer preload reports ready; input and
   * canvas resizes route back here automatically.
   *
   * opts.slot: which `<canvas data-ghostty="...">` this terminal
   * paints into ('' — the bare attribute — by default). One terminal
   * per (webContents, slot).
   */
  attach(webContents, { slot = '' } = {}) {
    wireIpc();
    this._target = webContents;
    this._slot = slot;
    const key = slotKey(webContents.id, slot);
    if (bySlot.has(key))
      throw new Error(`electron-ghostty: slot '${slot}' already attached`);
    bySlot.set(key, this);
    webContents.once('destroyed', () => {
      // Full teardown, not just stop(): the utility engine's stop() is
      // a no-op, so stopping here would leak the engine process + its
      // shell every time a window closes. destroy() kills the child.
      this.destroy();
    });
    return this;
  }

  _onRendererReady() {
    this._engine.start();
    this.emit('ready');
  }

  _onExit() {
    this.emit('exit');
  }

  /**
   * Events from ghostty's runtime callbacks (either engine). Clipboard
   * is handled here — copy lands in Electron's clipboard, paste
   * requests are answered from it — so it works out of the box;
   * everything else is emitted for the embedder:
   *   'title' (string), 'pwd' (string), 'bell', 'open-url' (string),
   *   'mouse-shape' (CSS cursor name), 'clipboard-write' (string).
   */
  _onEngineEvent(event) {
    switch (event.type) {
      case 'title': this.emit('title', event.str ?? ''); break;
      case 'pwd': this.emit('pwd', event.str ?? ''); break;
      case 'bell': this.emit('bell'); break;
      case 'open-url': this.emit('open-url', event.str ?? ''); break;
      case 'mouse-shape':
        this.emit('mouse-shape', MOUSE_SHAPE_CSS[event.num] ?? 'default');
        break;
      case 'clipboard-write':
        clipboard.writeText(event.str ?? '');
        this.emit('clipboard-write', event.str ?? '');
        break;
      case 'clipboard-read':
        // Ghostty wants a paste: answer with Electron's clipboard.
        // ghostty brackets/encodes the paste itself.
        this._engine.send('completeClipboard', event.state,
                          clipboard.readText());
        break;
    }
  }

  _onCanvasResize(cssWidth, cssHeight) {
    clearTimeout(this._resizeTimer);
    this._resizeTimer = setTimeout(() => {
      if (this._destroyed) return;
      this.resize(
        Math.max(200, Math.round(cssWidth * this.scale)),
        Math.max(100, Math.round(cssHeight * this.scale)));
    }, RESIZE_DEBOUNCE_MS);
  }

  /**
   * Import a presented IOSurface and send it to the attached renderer.
   * `handle` is a sharedTexture handle object ({ ioSurface: Buffer }).
   * Returns the send promise (the caller may need to defer a release
   * until the transfer completes), or undefined if skipped.
   */
  _presentFrame(handle, width, height) {
    if (this._sending || this._destroyed) return;
    const target = this._target;
    if (!target || target.isDestroyed()) return;
    this._sending = true;
    let sent;
    try {
      const imported = sharedTexture.importSharedTexture({
        textureInfo: {
          codedSize: { width, height },
          pixelFormat: 'bgra',
          handle,
        },
      });
      this.emit('frame', { width, height });
      // Varargs after options ride along to the renderer's receiver
      // callback; the slot tells the preload which canvas to paint.
      sent = sharedTexture.sendSharedTexture(
        { frame: target.mainFrame, importedSharedTexture: imported },
        this._slot ?? '')
        .then(() => imported.release())
        .catch((err) => {
          imported.release();
          this.emit('present-error', err);
        })
        .finally(() => { this._sending = false; });
    } catch (err) {
      this._sending = false;
      this.emit('present-error', err);
      return;
    }
    return sent;
  }

  /* ── input (surface pixels; ghostty's own encoders) ─────────────── */

  /** Raw key event: {action, keycode, mods, text?, unshiftedCodepoint?} */
  key(k) { this._engine.send('key', k); }
  /** Cooked text input (typing, paste). */
  text(s) { this._engine.send('text', s); }
  mouseButton(action, button, mods) {
    this._engine.send('mouseButton', action, button, mods);
  }
  mousePos(x, y, mods) { this._engine.send('mousePos', x, y, mods); }
  mouseScroll(x, y, dx, dy) {
    this._engine.send('mouseScroll', x, y, dx, dy);
  }
  /** Window focus/blur — ghostty handles DECSET 1004 reporting. */
  setFocus(focused) { this._engine.send('setFocus', !!focused); }

  /* ── state ──────────────────────────────────────────────────────── */

  /** Pixel size; ghostty reflows the grid and resizes the PTY. */
  resize(widthPx, heightPx) { this._engine.send('resize', widthPx, heightPx); }
  /**
   * {cols, rows, widthPx, heightPx, cellWidth, cellHeight}.
   * With engine 'utility' this returns the last known size (may be
   * null before the first reply); use sizeAsync() for a fresh answer.
   */
  size() { return this._engine.size(); }
  sizeAsync() {
    return this._engine.sizeAsync
      ? this._engine.sizeAsync()
      : Promise.resolve(this._engine.size());
  }
  processExited() { return this._engine.processExited(); }

  /* ── advanced / testing ─────────────────────────────────────────── */

  /** Drain ghostty's app loop now (no-op with engine 'utility'). */
  tick() { this._engine.tick(); }
  /** Force a synchronous render of current state. */
  draw() { this._engine.draw(); }
  /** BGRA copy of the presented frame. Sync only with engine 'main'. */
  readPixels() { return this._engine.readPixels(); }
  /** BGRA copy of the presented frame, any engine. */
  readPixelsAsync() {
    return this._engine.readPixelsAsync
      ? this._engine.readPixelsAsync()
      : Promise.resolve(this._engine.readPixels());
  }

  /** Synchronous teardown: ghostty kills + reaps the shell. */
  destroy() {
    if (this._destroyed) return;
    this._destroyed = true;
    clearTimeout(this._resizeTimer);
    // Always drop the slot-routing entry, even when the webContents is
    // already gone (the 'destroyed' path) — otherwise the map leaks.
    if (this._target) {
      const key = slotKey(this._target.id, this._slot);
      if (bySlot.get(key) === this) bySlot.delete(key);
    }
    this._target = null;
    this._engine.destroy();
  }
}

module.exports = { GhosttyTerminal, available };
