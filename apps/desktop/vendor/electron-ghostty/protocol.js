'use strict';
/**
 * Single source of truth for the engine ops that flow from
 * GhosttyTerminal to the engine (both placements). Each entry maps the
 * addon method name to its arity; the utility transport sends
 * { type: 'op', method, args } and the host dispatches
 * addon[method](session, ...args) — so a new op is added HERE once,
 * not hand-synced across GhosttyTerminal, two engine drivers, and the
 * host's handler table (the drift that used to be possible).
 *
 * Ops are fire-and-forget session calls. Request/reply messages
 * (read-pixels, size) and lifecycle (create, frame-ack, destroy) stay
 * named messages in host.js.
 */
const OPS = {
  key: 1,               // (event)
  text: 1,              // (string)
  mouseButton: 3,       // (action, button, mods)
  mousePos: 3,          // (x, y, mods)
  mouseScroll: 4,       // (x, y, dx, dy)
  resize: 2,            // (widthPx, heightPx)
  draw: 0,              // ()
  setFocus: 1,          // (bool)
  // Answers a clipboard-read event. The state Buffer is an opaque
  // 8-byte token: only meaningful in the engine's process, but it
  // structured-clones through postMessage untouched.
  completeClipboard: 2, // (state, text)
};

function checkOp(method, args) {
  const arity = OPS[method];
  if (arity === undefined)
    throw new Error(`electron-ghostty: unknown engine op '${method}'`);
  if (!Array.isArray(args) || args.length !== arity)
    throw new Error(
      `electron-ghostty: op '${method}' expects ${arity} args, got ${args?.length}`);
}

module.exports = { OPS, checkOp };
