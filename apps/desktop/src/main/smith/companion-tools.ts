import { IPC } from '@shared/ipc-contract.js';
import type { SmithPrivateDisplay } from '@shared/types.js';
import { defineTool, type ToolDefinition } from '../pi/tool-definition.js';
import {
  booleanField,
  immediate,
  json,
  parseOperation,
  proposeAction,
  stringField,
  type SmithActionToolDeps,
} from './tool-helpers.js';

export const SMITH_COMPANION_OPERATIONS = ['state', 'start', 'stop', 'pairing', 'unpair'] as const;

export function smithCompanionTool(deps: SmithActionToolDeps): ToolDefinition {
  return defineTool({
    name: 'smith_companion',
    label: 'Smith Companion',
    description:
      'Operate Companion: state, start, stop, pairing(refresh?), unpair(deviceId). Pairing secrets are shown privately to the operator and never returned to Smith.',
    parameters: {
      type: 'object',
      properties: {
        operation: { type: 'string', enum: [...SMITH_COMPANION_OPERATIONS] },
        refresh: { type: 'boolean' },
        deviceId: { type: 'string' },
      },
      required: ['operation'],
      additionalProperties: false,
    },
    execute: async (_id, params) => {
      const op = parseOperation(params, SMITH_COMPANION_OPERATIONS);
      if (!op) return json({ ok: false, error: 'unknown operation' });
      if (op === 'state') return immediate(deps, IPC.companionState);

      if (op === 'unpair') {
        const deviceId = stringField(params, 'deviceId');
        if (!deviceId) return json({ ok: false, error: 'deviceId is required' });
        return proposeAction(deps, {
          operation: op,
          title: 'Unpair Companion device',
          summary: `Unpair device ${deviceId}.`,
          args: { deviceId },
          risk: 'credential',
          execute: () => deps.invoke(IPC.companionUnpair, deviceId),
        });
      }

      if (op === 'pairing') {
        const refresh = booleanField(params, 'refresh') ?? false;
        return proposeAction(deps, {
          operation: op,
          title: 'pairing Companion',
          summary: 'pairing Companion services.',
          args: { refresh },
          risk: 'network',
          // The payload is a renderer-only display; Smith learns only that
          // one exists.
          execute: async () => {
            const payload = (await deps.invoke(IPC.companionPairingPayload, {
              refresh,
            })) as SmithPrivateDisplay['payload'] | null;
            return {
              modelResult: { ok: true, available: payload != null },
              ...(payload
                ? { privateDisplay: { kind: 'companion-pairing' as const, payload } }
                : {}),
            };
          },
        });
      }

      const channel = op === 'start' ? IPC.companionStart : IPC.companionStop;
      return proposeAction(deps, {
        operation: op,
        title: `${op} Companion`,
        summary: `${op} Companion services.`,
        args: {},
        risk: 'network',
        execute: () => deps.invoke(channel),
      });
    },
  });
}
