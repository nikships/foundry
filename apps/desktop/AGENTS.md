# AGENTS.md — Desktop app

For every desktop UI change, run `npm run build`, launch the built Electron app, and validate the change with the repository's `.factory/skills/foundry-ui` skill.

Never validate the desktop renderer by opening it in a web browser. Do not substitute browser preview, computer-use, or a throwaway Playwright spec for the real Electron app and the `foundry-ui` workflow.
