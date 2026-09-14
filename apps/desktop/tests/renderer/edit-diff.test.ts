import { describe, expect, it } from 'vitest';
import type { EventRow } from '@shared/types.js';
import { editDiffFromEvent, isEditToolEvent } from '@renderer/components/inspector/edit-diff.js';

function event(over: Partial<EventRow> & { payload?: Record<string, unknown> }): EventRow {
  return {
    rowid: 1,
    changeId: 1,
    eventId: 'evt_1',
    runId: 'run_1',
    phaseId: 'ph_1',
    parentId: null,
    type: 'tool_call',
    name: 'edit: src/retry.ts',
    tokens: 0,
    startedAt: '2026-08-10T12:34:56.000Z',
    endedAt: '2026-08-10T12:34:56.000Z',
    payload: {},
    ...over,
  };
}

describe('editDiffFromEvent', () => {
  it('pairs oldText and newText from a pi edits[] call', () => {
    const model = editDiffFromEvent(
      event({
        payload: {
          kind: 'edit',
          args: {
            path: 'src/retry.ts',
            edits: [{ oldText: 'const a = 1', newText: 'const a = 2' }],
          },
        },
      }),
    );
    expect(model).toEqual({
      kind: 'pair',
      path: 'src/retry.ts',
      oldFile: { name: 'src/retry.ts', contents: 'const a = 1' },
      newFile: { name: 'src/retry.ts', contents: 'const a = 2' },
    });
  });

  it('treats a write with content as a create', () => {
    const model = editDiffFromEvent(
      event({
        name: 'write: src/new.ts',
        payload: {
          kind: 'edit',
          args: { path: 'src/new.ts', content: 'export const ok = true;\n' },
        },
      }),
    );
    expect(model.kind).toBe('pair');
    if (model.kind !== 'pair') return;
    expect(model.oldFile).toBeNull();
    expect(model.newFile?.contents).toContain('export const ok');
  });

  it('falls back to a unified patch in the tool result', () => {
    const patch = '--- a/src/a.ts\n+++ b/src/a.ts\n@@ -1 +1 @@\n-old\n+new\n';
    const model = editDiffFromEvent(
      event({
        payload: { kind: 'edit', args: { path: 'src/a.ts' }, result: patch },
      }),
    );
    expect(model).toEqual({ kind: 'patch', path: 'src/a.ts', patch });
  });

  it('treats write_file with content as a create', () => {
    const model = editDiffFromEvent(
      event({
        name: 'write_file: src/brand-new.ts',
        payload: {
          args: { path: 'src/brand-new.ts', content: 'export const n = 1;\n' },
        },
      }),
    );
    expect(model.kind).toBe('pair');
    if (model.kind !== 'pair') return;
    expect(model.oldFile).toBeNull();
    expect(model.newFile?.contents).toContain('export const n');
  });

  it('recognizes write_file tool calls as edit events', () => {
    expect(isEditToolEvent(event({ name: 'write_file: src/a.ts', payload: {} }))).toBe(true);
    expect(isEditToolEvent(event({ name: 'write: src/a.ts', payload: { kind: 'write' } }))).toBe(
      true,
    );
  });

  it('recognizes edit tool calls from kind or name', () => {
    expect(isEditToolEvent(event({ payload: { kind: 'edit' } }))).toBe(true);
    expect(isEditToolEvent(event({ name: 'write: src/a.ts', payload: {} }))).toBe(true);
    expect(isEditToolEvent(event({ name: 'bash: ls', payload: { kind: 'command' } }))).toBe(false);
  });
});
