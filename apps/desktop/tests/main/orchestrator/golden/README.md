# Orchestrator golden-plan evals

Frozen `PlanPromptInputs` plus a recorded `submit_result` payload. The suite is
model-free: it never calls a provider. Run it with:

```bash
npx vitest run -t orchestrator-golden
```

## Recording a new golden

1. Plan a real request in Foundry (Grok 4.6 is fine) until the card shows a plan.
2. Copy the Orchestrator’s `submit_result` JSON from the planning panel’s raw
   reply. That object is the `reply` field.
3. Copy the request, repository summary, commands, roster names, and the cast
   pool ids that were shown — not the live catalog dump with prices.
4. Add an entry to `golden-plans.test.ts` (or a sibling JSON file loaded there).
5. Redact secrets before saving:
   - Strip API keys, tokens, `.env` values, and private URLs.
   - Replace a real repository summary with a synthetic paragraph that still
     carries any canary constraint strings you want `refinedRequest` to keep
     (`CHANGES.md`, a function name, a test command).
   - Do not paste provider billing, cookies, or machine paths that identify
     credentials.
6. Set `expect` to `pass` when the recorded plan should survive rails, or
   `reject` when it is an illegal shape you want the rails to catch.
7. Re-run `npx vitest run -t orchestrator-golden`. Do not commit a golden that
   only passes against a live model.

Adversarial goldens belong in the same list: put the injection in `request` or
`contextSummary`, and keep a legal `reply` that did **not** follow it (named
models, proof command, no `inherit`, no engineer phases).
