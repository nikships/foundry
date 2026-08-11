# electron-ghostty

**Experimental — pure research, not published, expect breakage.**

This package exists to prove one thing: you can reuse essentially all
of [ghostty](https://github.com/ghostty-org/ghostty) — PTY + shell, VT
parsing, key/mouse encoding, selection, fonts/shaping, Metal (GPU)
rendering — inside an Electron app, and use Electron purely as the
window/compositor. No forked Chromium, no pixels copied over IPC:
ghostty presents into an IOSurface and Electron's
[`sharedTexture`](https://electronjs.org/docs/latest/api/shared-texture)
module imports it **zero-copy** into a sandboxed `<canvas>` as a W3C
`VideoFrame` (the same path `<video>` frames take).

What's left for this package is only the glue: tick ghostty's app
loop, forward input, ship each presented frame.

By default the engine doesn't even run in the Electron main process:
`host.js` runs the whole terminal in an Electron **utilityProcess**, so
a busy or crashed terminal can't stall window management. Frames cross
the process boundary as **mach send-rights**
(`IOSurfaceCreateMachPort` → bootstrap channel →
`IOSurfaceLookupFromMachPort`) — an unguessable capability, per
Apple's recommended mechanism for passing surfaces between tasks; the
main process imports each received surface into `sharedTexture` —
still zero-copy, the pixels never leave the GPU. Set `engine: 'main'`
to run the engine in-process (the original mode; tests use it for
synchronous pixel assertions).

macOS-only for now (Metal + IOSurface). Linux needs an EGL/GBM
presenter (probe experiments in `native/renderer-poc/`); Windows has
no presentation path in this architecture — the earlier CPU-rasterizer
iteration had a working D3D11/DirectWrite producer, last at repo
commit `1a4357c`. See
[`docs/ghostty-renderer-reuse.md`](../../docs/ghostty-renderer-reuse.md)
at the repo root.


## Usage

Main process:

```js
const { app, BrowserWindow, screen } = require('electron');
const { GhosttyTerminal } = require('electron-ghostty');

app.whenReady().then(() => {
  const term = new GhosttyTerminal({
    scale: screen.getPrimaryDisplay().scaleFactor,
    fontSize: 13,
    // command: 'htop',  // default: the user's shell, like a real window
  });

  const win = new BrowserWindow({
    webPreferences: {
      sandbox: true,               // stays fully sandboxed — frames are
      backgroundThrottling: false, // GPU surfaces, not pixels over IPC
      preload: require.resolve('electron-ghostty/preload'),
    },
  });

  term.attach(win.webContents);
  term.on('exit', () => app.quit());
  win.on('closed', () => term.destroy());
  win.loadFile('index.html');
});
```

Renderer: any sandboxed page with a canvas marked for ghostty. The
canvas element's CSS size drives the terminal size — resize it (flexbox,
ResizeObserver-visible changes, anything) and ghostty reflows the grid
and resizes the PTY (SIGWINCH) automatically:

```html
<canvas data-ghostty tabindex="0" style="width: 100%; height: 100%"></canvas>
```

That's all: the preload paints frames into that canvas and forwards
keyboard/mouse/paste events to ghostty's own encoders (kitty keyboard
protocol, mouse tracking modes, scrollback routing).

## API

`new GhosttyTerminal(opts)` — spawns the shell immediately.

| option | |
|---|---|
| `scale` | devicePixelRatio of the target display (default 2) |
| `fontSize?` | pt |
| `command?` | run this instead of the user's shell. Ghostty execs it directly (login-shell exec), so compound commands need `sh -c '…'` |
| `cwd?` | working directory for the shell |
| `config?` | ghostty config-file syntax, e.g. `"background = #282c34\nscrollback-limit = 10000000"` — any ghostty option |
| `widthPx?`, `heightPx?` | initial surface size; the attached canvas takes over as soon as the renderer reports |
| `engine?` | `'utility'` (default): ghostty runs in a utilityProcess. `'main'`: ghostty runs in the main process |

Methods/events on the instance:

- `attach(webContents, { slot } = {})` — bind to a window; the present
  loop starts when the preload signals ready. `slot` selects a
  `<canvas data-ghostty="name">` for multi-terminal pages.
- `resize(widthPx, heightPx)`, `sizeAsync()` → `{cols, rows, widthPx,
  heightPx, cellWidth, cellHeight}` (ghostty derives the grid). `size()`
  is sync but with the utility engine serves the last known value.
- `text(str)`, `key(event)`, `mouseButton/mousePos/mouseScroll(…)`,
  `setFocus(bool)` — programmatic input, same encoders as the preload
  path.
- `readPixelsAsync()` — BGRA copy of the presented frame (testing);
  `readPixels()` is the sync variant, `engine: 'main'` only.
- `destroy()` — teardown; ghostty kills + reaps the shell.
- events:
  - `ready`, `exit` (shell exited, or the engine process died),
    `present-error`
  - `title` (OSC 0/2), `pwd` (OSC 7), `bell`, `open-url`,
    `mouse-shape` (CSS cursor name)
  - `clipboard-write` — text ghostty copied (selection copy, OSC 52);
    already written to Electron's clipboard when emitted. Paste
    requests are answered from Electron's clipboard automatically.

Clipboard works out of the box: copy (including OSC 52 with
`config: 'clipboard-write = allow'`) lands in the system clipboard;
ghostty's paste binding (Cmd+V) reads from it, with bracketed-paste
encoding handled by ghostty. IME composition (CJK, dead keys) commits
through the cooked-text path; composing keystrokes are not
double-sent.

Low-level: `require('electron-ghostty/addon')` exposes the raw N-API
binding (`load()`, `available()`) for tests and embedders that run the
tick/present loop themselves — see `src/addon.c` for that surface.

## Building

The addon links a **patched** libghostty (`patches/0002` at the repo
root adds the headless apprt platform + `ghostty_surface_headless_frame()`;
`patches/0001` only installs the static library + header on macOS):

```bash
npm run setup:ghostty   # repo root: clone ghostty, apply patch, zig build
npm run build:native    # node-gyp rebuild of this package
```
