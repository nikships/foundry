# Third-party notices

This repository (MIT, see `LICENSE`) builds on and benchmarks several
third-party projects. Each retains its own license and copyright.

## ghostty — vendored and patched

`scripts/setup-ghostty.sh` clones [ghostty](https://github.com/ghostty-org/ghostty)
at a pinned commit into `vendor/ghostty/` (gitignored, not redistributed
here). The patches under `patches/` are **modifications of MIT-licensed
ghostty source** (`src/apprt/embedded.zig`, `src/renderer/Metal.zig`,
`include/ghostty.h`, `build.zig`) and are therefore derivative works of
ghostty. They are provided under the same MIT terms.

ghostty is:

```
MIT License

Copyright (c) 2024 Mitchell Hashimoto

Permission is hereby granted, free of charge, to any person obtaining a copy
of this software and associated documentation files (the "Software"), to deal
in the Software without restriction, including without limitation the rights
to use, copy, modify, merge, publish, distribute, sublicense, and/or sell
copies of the Software, and to permit persons to whom the Software is
furnished to do so, subject to the following conditions:

The above copyright notice and this permission notice shall be included in all
copies or substantial portions of the Software.

THE SOFTWARE IS PROVIDED "AS IS", WITHOUT WARRANTY OF ANY KIND, EXPRESS OR
IMPLIED, INCLUDING BUT NOT LIMITED TO THE WARRANTIES OF MERCHANTABILITY,
FITNESS FOR A PARTICULAR PURPOSE AND NONINFRINGEMENT. IN NO EVENT SHALL THE
AUTHORS OR COPYRIGHT HOLDERS BE LIABLE FOR ANY CLAIM, DAMAGES OR OTHER
LIABILITY, WHETHER IN AN ACTION OF CONTRACT, TORT OR OTHERWISE, ARISING FROM,
OUT OF OR IN CONNECTION WITH THE SOFTWARE OR THE USE OR OTHER DEALINGS IN THE
SOFTWARE.
```

(Verify the exact upstream notice at the pinned commit in
`scripts/setup-ghostty.sh`; ghostty's canonical license lives at
`LICENSE` in that repository.)

## Benchmarked / dev dependencies

These are pulled in as npm dependencies for the benchmarks and demo; they
are not redistributed in this repo's source:

- [@xterm/xterm](https://github.com/xtermjs/xterm.js) and its addons — MIT,
  © The xterm.js authors.
- [ghostty-web](https://github.com/coder/ghostty-web) — MIT, © Coder
  Technologies; ghostty's VT engine compiled to WebAssembly.
- [node-pty](https://github.com/microsoft/node-pty) — MIT, © Microsoft.
- [Electron](https://github.com/electron/electron) — MIT, © Electron
  contributors / OpenJS Foundation.

Run `npm ls --all` for the full resolved dependency tree and their licenses.
