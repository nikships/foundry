'use strict';
/**
 * Loads the raw N-API binding (see src/addon.c for the full surface).
 * Most consumers want index.js (GhosttyTerminal); this low-level entry
 * exists for tests and embedders that manage the loop themselves.
 * Loading is lazy so requiring the package on an unsupported platform
 * doesn't throw until the addon is actually needed.
 */
const path = require('path');

const ADDON_PATH = path.join(
  __dirname, 'build', 'Release', 'ghostty_renderer.node');

let addon = null;

function load() {
  if (!addon) {
    if (process.platform !== 'darwin') {
      throw new Error(
        'electron-ghostty: headless rendering is macOS-only for now ' +
        '(Metal + IOSurface); Linux needs the EGL/GBM presenter');
    }
    addon = require(ADDON_PATH);
  }
  return addon;
}

function available() {
  return process.platform === 'darwin' && require('fs').existsSync(ADDON_PATH);
}

module.exports = { load, available, ADDON_PATH };
