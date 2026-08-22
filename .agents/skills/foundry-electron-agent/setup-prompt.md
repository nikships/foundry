You are preparing a reusable Linux sandbox for ongoing work on the Foundry Electron desktop app.

The repository is already cloned at /workspace/foundry (github.com/nikships/foundry, branch main).

Do the following, in order, and do not modify any tracked file in the repo:

1. Read /workspace/foundry/AGENTS.md and /workspace/foundry/.agents/setup so you understand the project's own setup contract.
2. Verify node --version is v22.x and npm is available. If Node 22 is not present, install it.
3. Install the OS build prerequisites needed by better-sqlite3 native builds (g++, make, python3) if they are missing.
4. Run: cd /workspace/foundry && npm ci --no-audit --no-fund
5. Make sure the Electron binary itself is downloaded: if node_modules/electron/dist/electron does not exist, run node node_modules/electron/install.js
6. Warm the toolchain by running, from the repo root: npm run typecheck, then npm run lint, then npm test. Record the exact result of each (pass/fail plus any failing test names). Do NOT try to fix failing tests, just record them.
7. Do not run npm run test:e2e or npm run package (they need a macOS GUI session).
8. Confirm the working tree is clean: git -C /workspace/foundry status --porcelain should print nothing. If it is not clean, restore the tracked files.
9. Write a file /workspace/ENVIRONMENT.md that records: node/npm versions, what you installed, the pass/fail result and wall-clock duration of typecheck/lint/test, the location of the Electron app source (apps/desktop/src/{main,preload,renderer,shared}) and the root-level electron.vite.config.ts / electron-builder.yml, and any gotcha a future agent should know before editing this codebase.

Finish with a short summary of the state of the sandbox.
