import { createElement } from 'react';
import { renderToStaticMarkup } from 'react-dom/server';
import { describe, expect, it } from 'vitest';
import type { EventRow } from '@shared/types.js';
import {
  inferToolKind,
  toolPayloadFromEvent,
} from '@renderer/components/inspector/tool-payload.js';
import ToolPayloadView from '@renderer/components/inspector/ToolPayloadView.js';
import { isEditToolEvent } from '@renderer/components/inspector/edit-diff.js';

function event(over: Partial<EventRow> & { payload?: Record<string, unknown> }): EventRow {
  return {
    rowid: 1,
    changeId: 1,
    eventId: 'evt_1',
    runId: 'run_1',
    phaseId: 'ph_1',
    parentId: null,
    type: 'tool_call',
    name: 'bash: ls',
    tokens: 0,
    startedAt: '2026-08-10T12:34:56.000Z',
    endedAt: '2026-08-10T12:34:56.000Z',
    payload: {},
    ...over,
  };
}

describe('toolPayloadFromEvent', () => {
  it('labels a bash command and keeps the result for preview', () => {
    const model = toolPayloadFromEvent(
      event({
        name: 'bash: pnpm test',
        payload: {
          kind: 'command',
          args: { command: 'pnpm test' },
          result: 'ok\n',
        },
      }),
    );
    expect(model.kind).toBe('command');
    expect(model.fields).toEqual([{ label: 'command', value: 'pnpm test' }]);
    expect(model.result).toBe('ok\n');
  });

  it('labels read path and line range without dumping args as JSON', () => {
    const model = toolPayloadFromEvent(
      event({
        name: 'read: src/a.ts',
        payload: {
          kind: 'read',
          args: { path: 'src/a.ts', offset: 10, limit: 20 },
          result: 'line\n',
        },
      }),
    );
    expect(model.kind).toBe('read');
    expect(model.fields.map((f) => f.label)).toEqual(['path', 'offset', 'limit']);
    expect(model.fields[0]?.value).toBe('src/a.ts');
  });

  it('labels grep pattern, path, and glob', () => {
    const model = toolPayloadFromEvent(
      event({
        name: 'grep: fetchWithRetry',
        payload: {
          kind: 'search',
          args: { pattern: 'fetchWithRetry', path: 'src', glob: '*.ts' },
          result: 'src/a.ts:1\n',
        },
      }),
    );
    expect(model.kind).toBe('search');
    expect(model.fields).toEqual([
      { label: 'pattern', value: 'fetchWithRetry' },
      { label: 'path', value: 'src' },
      { label: 'glob', value: '*.ts' },
    ]);
  });

  it('classifies write_file as an edit kind for shared renderers', () => {
    expect(inferToolKind(event({ name: 'write_file: src/new.ts', payload: {} }))).toBe('edit');
    expect(
      isEditToolEvent(
        event({
          name: 'write_file: src/new.ts',
          payload: { args: { path: 'src/new.ts', content: 'x\n' } },
        }),
      ),
    ).toBe(true);
  });
});

describe('ToolPayloadView', () => {
  it('renders labeled fields and hides raw JSON until expanded', () => {
    const html = renderToStaticMarkup(
      createElement(ToolPayloadView, {
        event: event({
          name: 'bash: pnpm test',
          payload: {
            kind: 'command',
            args: { command: 'pnpm test' },
            result: 'passed\n',
          },
        }),
      }),
    );
    expect(html).toContain('tool-payload');
    expect(html).toContain('pnpm test');
    expect(html).toContain('passed');
    expect(html).toContain('Show raw JSON');
    expect(html).not.toContain('tool-payload-raw');
    // Default view must not dump the structured payload as a JSON blob.
    expect(html).not.toContain('"kind": "command"');
  });
});
