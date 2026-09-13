import { IPC } from '@shared/ipc-contract.js';
import { defineTool, type ToolDefinition } from '../pi/tool-definition.js';
import {
  immediate,
  json,
  objectField,
  parseOperation,
  proposeAction,
  type SmithActionToolDeps,
} from './tool-helpers.js';

export const SMITH_SETTINGS_OPERATIONS = [
  'get',
  'patch',
  'catalog_gates',
  'catalog_template_variables',
  'catalog_models',
] as const;

const READS = {
  get: IPC.settingsGet,
  catalog_gates: IPC.catalogGates,
  catalog_template_variables: IPC.catalogTemplateVariables,
  catalog_models: IPC.catalogAgentModels,
} as const;

export function smithSettingsTool(deps: SmithActionToolDeps): ToolDefinition {
  return defineTool({
    name: 'smith_settings',
    label: 'Smith settings',
    description:
      'Read settings and catalogs without approval: get, catalog_gates, catalog_template_variables, catalog_models. Use these catalogs for valid gate names, prompt variables, model IDs, and supported reasoning levels. patch(patch) requires approval. Read get first; send only changed settings, not the full object. Use smith_providers for credentials.',
    parameters: {
      type: 'object',
      properties: {
        operation: { type: 'string', enum: [...SMITH_SETTINGS_OPERATIONS] },
        patch: {
          type: 'object',
          description: 'For patch only: changed fields from get. Do not include credentials.',
        },
      },
      required: ['operation'],
      additionalProperties: false,
    },
    execute: async (_id, params) => {
      const op = parseOperation(params, SMITH_SETTINGS_OPERATIONS);
      if (!op) return json({ ok: false, error: 'unknown operation' });
      if (op !== 'patch') return immediate(deps, READS[op]);
      const patch = objectField(params, 'patch');
      if (!patch) return json({ ok: false, error: 'patch must be an object' });
      return proposeAction(deps, {
        operation: op,
        title: 'Change settings',
        summary: 'Apply the shown settings patch.',
        args: { patch },
        risk: 'write',
        execute: () => deps.invoke(IPC.settingsPatch, patch),
      });
    },
  });
}
