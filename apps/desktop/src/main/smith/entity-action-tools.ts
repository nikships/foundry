import { readFile } from 'node:fs/promises';
import { extname } from 'node:path';
import { IPC } from '@shared/ipc-contract.js';
import { defineTool, type ToolDefinition } from '../pi/tool-definition.js';
import {
  field,
  immediate,
  json,
  objectField,
  parseOperation,
  proposeAction,
  requireProjectId,
  resolveProjectId,
  stringField,
  type SmithActionToolDeps,
} from './tool-helpers.js';

export const SMITH_ENTITY_OPERATIONS = [
  'agent_stale',
  'agent_validate',
  'agent_preview',
  'agent_rename',
  'agent_remove',
  'agent_duplicate',
  'agent_reset',
  'agent_upload_mark',
  'agent_remove_mark',
  'envelope_usage',
  'envelope_validate',
  'envelope_preview',
  'envelope_remove',
  'envelope_duplicate',
  'pipeline_stale',
  'pipeline_validate',
  'pipeline_dry_run',
  'pipeline_remove',
  'pipeline_duplicate',
  'pipeline_reset',
] as const;

type EntityOperation = (typeof SMITH_ENTITY_OPERATIONS)[number];

const MIMES: Record<string, string> = {
  '.png': 'image/png',
  '.jpg': 'image/jpeg',
  '.jpeg': 'image/jpeg',
  '.webp': 'image/webp',
  '.gif': 'image/gif',
  '.svg': 'image/svg+xml',
};

/** Immediate reads that forward one object argument. */
const OBJECT_READS: Partial<Record<EntityOperation, readonly [channel: string, field: string]>> = {
  agent_validate: [IPC.rosterValidate, 'agent'],
  agent_preview: [IPC.rosterPreview, 'agent'],
  envelope_validate: [IPC.envelopesValidate, 'definition'],
  pipeline_validate: [IPC.pipelinesValidate, 'pipeline'],
};

/** Immediate reads that forward one string argument. */
const STRING_READS: Partial<Record<EntityOperation, readonly [channel: string, field: string]>> = {
  envelope_usage: [IPC.envelopesUsage, 'name'],
  envelope_preview: [IPC.envelopesPreview, 'name'],
};

/** Gated actions that take one named argument, optionally scoped to a project. */
const SINGLE_FIELD_ACTIONS: Partial<
  Record<EntityOperation, { channel: string; field: string; scoped: boolean }>
> = {
  agent_remove: { channel: IPC.rosterRemove, field: 'name', scoped: true },
  agent_duplicate: { channel: IPC.rosterDuplicate, field: 'name', scoped: true },
  agent_reset: { channel: IPC.rosterReset, field: 'name', scoped: true },
  agent_remove_mark: { channel: IPC.rosterRemoveMark, field: 'emblem', scoped: false },
  envelope_remove: { channel: IPC.envelopesRemove, field: 'name', scoped: false },
  envelope_duplicate: { channel: IPC.envelopesDuplicate, field: 'name', scoped: false },
  pipeline_remove: { channel: IPC.pipelinesRemove, field: 'id', scoped: true },
  pipeline_duplicate: { channel: IPC.pipelinesDuplicate, field: 'id', scoped: true },
  pipeline_reset: { channel: IPC.pipelinesReset, field: 'id', scoped: true },
};

const DESTRUCTIVE: ReadonlySet<EntityOperation> = new Set([
  'agent_remove',
  'agent_reset',
  'agent_remove_mark',
  'envelope_remove',
  'pipeline_remove',
  'pipeline_reset',
]);

const label = (op: EntityOperation): string => op.replaceAll('_', ' ');

export function smithEntitiesTool(deps: SmithActionToolDeps): ToolDefinition {
  const proposeChannelCall = (
    op: EntityOperation,
    channel: string,
    args: unknown[],
    shownArgs: Record<string, unknown>,
  ) =>
    proposeAction(deps, {
      operation: op,
      title: label(op),
      summary: `Perform ${label(op)}.`,
      args: shownArgs,
      risk: DESTRUCTIVE.has(op) ? 'destructive' : 'write',
      execute: () => deps.invoke(channel, ...args),
    });

  return defineTool({
    name: 'smith_entities',
    label: 'Smith entities',
    description:
      'Inspect and manage agents, envelopes, and pipelines. Operations: agent_stale(projectId?), agent_validate(agent), agent_preview(agent), agent_rename(from,to,projectId?), agent_remove/duplicate/reset(name,projectId?), agent_upload_mark(filePath), agent_remove_mark(emblem), envelope_usage/preview/remove/duplicate(name), envelope_validate(definition), pipeline_stale(projectId?), pipeline_validate(pipeline,projectId?), pipeline_dry_run(pipelineId,projectId,request), pipeline_remove/duplicate/reset(id,projectId?).',
    parameters: {
      type: 'object',
      properties: {
        operation: { type: 'string', enum: [...SMITH_ENTITY_OPERATIONS] },
        projectId: { type: 'string' },
        agent: { type: 'object' },
        pipeline: { type: 'object' },
        definition: { type: 'object' },
        from: { type: 'string' },
        to: { type: 'string' },
        name: { type: 'string' },
        id: { type: 'string' },
        filePath: { type: 'string' },
        emblem: { type: 'string' },
        pipelineId: { type: 'string' },
        request: { type: 'string' },
      },
      required: ['operation'],
      additionalProperties: false,
    },
    execute: async (_id, params) => {
      const op = parseOperation(params, SMITH_ENTITY_OPERATIONS);
      if (!op) return json({ ok: false, error: 'unknown operation' });
      const explicitProject = field(params, 'projectId');
      const scope =
        op === 'pipeline_dry_run'
          ? requireProjectId(explicitProject, deps.projectId())
          : resolveProjectId(explicitProject, deps.projectId());
      if (!scope.ok) return json(scope);
      const projectId = scope.projectId;

      if (op === 'agent_stale') return immediate(deps, IPC.rosterStaleBuiltins, projectId);
      if (op === 'pipeline_stale') return immediate(deps, IPC.pipelinesStaleBuiltins, projectId);

      const objectRead = OBJECT_READS[op];
      if (objectRead) {
        const [channel, name] = objectRead;
        const value = objectField(params, name);
        if (!value) return json({ ok: false, error: `${name} is required` });
        return immediate(deps, channel, value, ...(op === 'pipeline_validate' ? [projectId] : []));
      }

      const stringRead = STRING_READS[op];
      if (stringRead) {
        const [channel, name] = stringRead;
        const value = stringField(params, name);
        return value
          ? immediate(deps, channel, value)
          : json({ ok: false, error: `${name} is required` });
      }

      if (op === 'pipeline_dry_run') {
        const pipelineId = stringField(params, 'pipelineId');
        const request = stringField(params, 'request');
        if (!pipelineId || !request || !projectId) {
          return json({ ok: false, error: 'pipelineId, projectId, and request are required' });
        }
        return immediate(deps, IPC.pipelinesDryRun, pipelineId, projectId, request);
      }

      if (op === 'agent_upload_mark') {
        const filePath = stringField(params, 'filePath');
        if (!filePath) return json({ ok: false, error: 'filePath is required' });
        const mime = MIMES[extname(filePath).toLowerCase()];
        if (!mime) {
          return json({
            ok: false,
            error: 'unsupported mark type; use PNG, JPEG, WebP, GIF, or SVG',
          });
        }
        return proposeAction(deps, {
          operation: op,
          title: 'Upload agent mark',
          summary: `Read and upload ${filePath}.`,
          args: { filePath, mime },
          risk: 'write',
          // The bytes are read after approval, so a rejected card never reads
          // the file and the proposal never carries its contents.
          execute: async () =>
            deps.invoke(IPC.rosterUploadMark, (await readFile(filePath)).toString('base64'), mime),
        });
      }

      if (op === 'agent_rename') {
        const from = stringField(params, 'from');
        const to = stringField(params, 'to');
        if (!from || !to) return json({ ok: false, error: 'from and to are required' });
        return proposeChannelCall(op, IPC.rosterRename, [from, to, projectId], {
          from,
          to,
          ...(projectId ? { projectId } : {}),
        });
      }

      const action = SINGLE_FIELD_ACTIONS[op];
      if (!action) return json({ ok: false, error: 'unknown operation' });
      const value = stringField(params, action.field);
      if (!value) return json({ ok: false, error: `${action.field} is required` });
      return proposeChannelCall(op, action.channel, action.scoped ? [value, projectId] : [value], {
        [action.field]: value,
        ...(action.scoped && projectId ? { projectId } : {}),
      });
    },
  });
}
