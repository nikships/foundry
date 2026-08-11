'use strict';
/**
 * electron-ghostty engine host — the utilityProcess entry point.
 *
 * Runs the entire terminal engine (ghostty: PTY + shell, VT parsing,
 * input encoding, fonts, Metal rendering) OUTSIDE the Electron main
 * process, so a busy or crashing terminal can't stall window
 * management. The main process stays a thin presenter: it receives
 * each presented frame as a mach send-right and imports it into
 * sharedTexture — still zero-copy, frames never leave the GPU.
 *
 * Frame handoff: per frame, the IOSurface crosses the process
 * boundary as a mach send-right (IOSurfaceCreateMachPort) over a
 * bootstrap-registered channel — an unguessable capability, unlike
 * the deprecated global-IOSurface IDs. The mach message is sent
 * FIRST, then a 'frame' JS message with the metadata; the parent
 * receives the (already queued) port on handling the JS message.
 *
 * Frame flow control: one frame in flight — we don't post the next
 * frame until the parent acks the previous one, so a slow presenter
 * degrades to skipped frames instead of a queue of stale messages.
 * The in-flight frame's port holds +1 on the surface's global use
 * count, so it can't be recycled mid-transfer.
 *
 * Protocol (parentPort messages, all {type, ...}):
 *   in : create {opts} | frame-ack | op {method, args} (see
 *        protocol.js) | read-pixels {id} | size {id} | destroy
 *   out: created | frame {seq,width,height,scale} | exit |
 *        reply {id, result} | error {message}
 *
 * The mach channel name arrives in ELECTRON_GHOSTTY_MACH_CHANNEL
 * (set by the parent before fork).
 */
const { load } = require('./addon');
const { checkOp } = require('./protocol');

const PRESENT_INTERVAL_MS = 8; // ~120Hz poll of ghostty's swap chain

const addon = load();
addon.init();

const sender = addon.machSenderOpen(
  process.env.ELECTRON_GHOSTTY_MACH_CHANNEL, 5000);

let session = null;
let presentTimer = null;
let lastFramePtr = null;
let awaitingAck = false;
let exited = false;
let frameSeq = 0;

function post(msg) {
  process.parentPort.postMessage(msg);
}

function presentTick() {
  if (!session) return;
  // Ghostty's render thread presents via dispatch_async to the main
  // queue; plain Node has no run loop, so pump it or frames never land.
  addon.pumpMainQueue();
  addon.tick(session);
  // Ghostty-side events (title/pwd/bell/open-url/mouse-shape/clipboard)
  // queued by the runtime callbacks since the last tick.
  for (const event of addon.drainEvents(session))
    post({ type: 'event', event });
  if (addon.processExited(session)) {
    if (!exited) {
      exited = true;
      post({ type: 'exit' });
    }
    return;
  }
  if (awaitingAck) return;
  const frame = addon.frame(session);
  if (!frame) return;
  const ptr = frame.handle.toString('hex');
  if (ptr === lastFramePtr) return;
  lastFramePtr = ptr;
  // Mach message first (the port right travels out-of-band), then the
  // JS metadata message. If the mach send fails (parent gone, queue
  // full) skip this frame — the swap chain will produce another.
  const seq = ++frameSeq;
  if (!addon.machSendSurface(sender, frame.handle, seq)) return;
  awaitingAck = true;
  post({
    type: 'frame',
    seq,
    width: frame.width,
    height: frame.height,
    scale: frame.scale,
  });
}

const handlers = {
  create({ opts }) {
    // One session per host process — module state (session, ack flow,
    // frame dedup) is a singleton. A second create would leak the
    // running shell; refuse loudly until multi-session lands.
    if (session) throw new Error('host already has a session (one per process)');
    session = addon.create(opts);
    presentTimer = setInterval(presentTick, PRESENT_INTERVAL_MS);
    post({ type: 'created' });
  },
  'frame-ack'() {
    awaitingAck = false;
  },
  // All fire-and-forget session calls arrive as one message shape and
  // dispatch through the shared op table (protocol.js) — a new op is
  // defined once, not hand-synced between driver and host.
  op({ method, args }) {
    checkOp(method, args);
    // Structured clone turns Buffers into Uint8Arrays; the clipboard
    // state token must return to the addon as a Buffer.
    if (method === 'completeClipboard') args[0] = Buffer.from(args[0]);
    addon[method](session, ...args);
  },
  'read-pixels'({ id }) {
    addon.tick(session);
    addon.draw(session);
    post({ type: 'reply', id, result: addon.readPixels(session) });
  },
  size({ id }) {
    post({ type: 'reply', id, result: addon.size(session) });
  },
  destroy() {
    teardown();
    process.exit(0);
  },
};

function teardown() {
  if (presentTimer) clearInterval(presentTimer);
  presentTimer = null;
  if (session) {
    try { addon.destroy(session); } catch {}
    session = null;
  }
}

process.parentPort.on('message', (e) => {
  const msg = e.data;
  const handler = handlers[msg?.type];
  try {
    if (!handler) throw new Error(`unknown message type '${msg?.type}'`);
    handler(msg);
  } catch (err) {
    post({ type: 'error', message: `${msg?.type}: ${err.message}` });
  }
});

// If the main process dies, don't leave an orphaned shell behind.
process.parentPort.on('close', () => {
  teardown();
  process.exit(0);
});
