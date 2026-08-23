import { IPC } from '@shared/ipc-contract.js';
import type { SmithActionRisk } from '@shared/types.js';
import { defineTool, type ToolDefinition } from '../pi/tool-definition.js';
import {
  immediate,
  json,
  parseOperation,
  proposeAction,
  stringField,
  type SmithActionToolDeps,
} from './tool-helpers.js';

export const SMITH_SYSTEM_OPERATIONS = [
  'doctor',
  'orphans',
  'remove_orphan',
  'apply_retention',
  'compact',
  'version',
  'open_external',
  'quit',
  'relaunch',
  'update_status',
  'update_check',
  'update_download',
  'update_install',
] as const;

type SystemOperation = (typeof SMITH_SYSTEM_OPERATIONS)[number];
type SystemReadOperation = 'doctor' | 'orphans' | 'version' | 'update_status';
type SystemActionOperation = Exclude<SystemOperation, SystemReadOperation>;

const READS: Record<SystemReadOperation, string> = {
  doctor: IPC.doctorRun,
  orphans: IPC.maintenanceOrphans,
  version: IPC.appVersion,
  update_status: IPC.updaterGetStatus,
};

const ACTION_CHANNELS: Record<SystemActionOperation, string> = {
  remove_orphan: IPC.maintenanceRemoveWorktree,
  apply_retention: IPC.maintenanceRetention,
  compact: IPC.maintenanceCompact,
  open_external: IPC.appOpenExternal,
  quit: IPC.appQuit,
  relaunch: IPC.appRelaunch,
  update_check: IPC.updaterCheck,
  update_download: IPC.updaterDownload,
  update_install: IPC.updaterQuitAndInstall,
};

const RISKS: Record<SystemActionOperation, SmithActionRisk> = {
  remove_orphan: 'destructive',
  apply_retention: 'destructive',
  compact: 'maintenance',
  open_external: 'external',
  quit: 'lifecycle',
  relaunch: 'lifecycle',
  update_install: 'lifecycle',
  update_check: 'network',
  update_download: 'network',
};

export function smithSystemTool(deps: SmithActionToolDeps): ToolDefinition {
  return defineTool({
    name: 'smith_system',
    label: 'Smith system',
    description:
      'Run diagnostics, maintenance, lifecycle, and updates. Operations: doctor, orphans, remove_orphan(projectId,path), apply_retention, compact, version, open_external(url), quit, relaunch, update_status, update_check, update_download, update_install.',
    parameters: {
      type: 'object',
      properties: {
        operation: { type: 'string', enum: [...SMITH_SYSTEM_OPERATIONS] },
        projectId: { type: 'string' },
        path: { type: 'string' },
        url: { type: 'string' },
      },
      required: ['operation'],
      additionalProperties: false,
    },
    execute: async (_id, params) => {
      const op = parseOperation(params, SMITH_SYSTEM_OPERATIONS);
      if (!op) return json({ ok: false, error: 'unknown operation' });
      if (op in READS) return immediate(deps, READS[op as SystemReadOperation]);

      const action = op as SystemActionOperation;
      let args: unknown[] = [];
      let shownArgs: Record<string, unknown> = {};
      if (action === 'remove_orphan') {
        const projectId = stringField(params, 'projectId');
        const path = stringField(params, 'path');
        if (!projectId || !path) {
          return json({ ok: false, error: 'projectId and path are required' });
        }
        args = [projectId, path];
        shownArgs = { projectId, path };
      } else if (action === 'open_external') {
        const url = stringField(params, 'url');
        if (!url) return json({ ok: false, error: 'url is required' });
        args = [url];
        shownArgs = { url };
      }

      return proposeAction(deps, {
        operation: action,
        title: action.replaceAll('_', ' '),
        summary: `Run ${action.replaceAll('_', ' ')}.`,
        args: shownArgs,
        risk: RISKS[action],
        execute: () => deps.invoke(ACTION_CHANNELS[action], ...args),
      });
    },
  });
}
