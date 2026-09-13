# AGENTS.md — Desktop app

For every desktop UI change, run `pnpm run build`, launch the built Electron app, and validate the change with the repository's `.factory/skills/foundry-ui` skill.

Never validate the desktop renderer by opening it in a web browser. Do not substitute browser preview, computer-use, or a throwaway Playwright spec for the real Electron app and the `foundry-ui` workflow.

When a PR includes a desktop UI change, attach visual evidence to the PR body, captured from the built Electron app via the `foundry-ui` workflow: screenshots when the change can be evaluated statically, and a video when it involves animation or a multi-screen click flow.
