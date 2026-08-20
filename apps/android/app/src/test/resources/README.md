# Recorded host payloads

These are real responses from the desktop's companion host, not hand-written
JSON. Each was captured over a loopback HTTP round trip against
`GET /v1/projects/:projectId/runs/:runId`, which serialises
`src/main/engine/operations.ts:runDetail()` verbatim.

| File                            | What it is                                                                 |
| ------------------------------- | -------------------------------------------------------------------------- |
| `host-run-detail.json`          | A settled run: two agent phases with envelopes and gates, one failed code phase. |
| `host-run-detail-live.json`     | The same pipeline mid-run: one phase open (`endedAt: null`), one still queued.   |
| `host-run-detail-missing.json`  | `emptyRunDetail` — what the host answers **200** with when the run is unknown.   |

`RunDetailMapperTest` decodes them through the production
`HostRunDetail` + `RunDetailMapper`, so a change to the desktop's wire shape
fails in CI rather than on a phone. Fake-repository fixtures cannot catch that:
they are already in the phone's own shape.

To re-record after a desktop change, drive `tests/companion.test.ts`'s harness
(a real `Tracer`, the production `Executor`, and `tests/scripted-transport.ts`)
against the host and write the response bodies here.
