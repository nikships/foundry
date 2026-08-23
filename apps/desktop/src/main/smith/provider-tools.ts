import { IPC } from '@shared/ipc-contract.js';
import type { SmithActionRisk } from '@shared/types.js';
import { defineTool, type ToolDefinition } from '../pi/tool-definition.js';
import {
  immediate,
  json,
  parseOperation,
  proposeAction,
  rejectSecretFields,
  stringField,
  type SmithActionToolDeps,
} from './tool-helpers.js';

export const SMITH_PROVIDER_OPERATIONS = [
  'state',
  'stored_keys',
  'connect',
  'disconnect',
  'cancel_login',
  'set_api_key',
  'clear_api_key',
] as const;

type ProviderOperation = (typeof SMITH_PROVIDER_OPERATIONS)[number];
type ProviderActionOperation = Exclude<ProviderOperation, 'state' | 'stored_keys'>;

const ACTION_CHANNELS: Record<ProviderActionOperation, string> = {
  connect: IPC.bridgeConnect,
  disconnect: IPC.bridgeDisconnect,
  cancel_login: IPC.bridgeCancelLogin,
  set_api_key: IPC.bridgeSetApiKey,
  clear_api_key: IPC.bridgeClearApiKey,
};

const RISKS: Record<ProviderActionOperation, SmithActionRisk> = {
  connect: 'external',
  disconnect: 'credential',
  cancel_login: 'write',
  set_api_key: 'credential',
  clear_api_key: 'credential',
};

/** Key operations name a provider by id; OAuth operations name it by slug. */
const isKeyOperation = (op: ProviderActionOperation): boolean => op.endsWith('_api_key');

export function smithProvidersTool(deps: SmithActionToolDeps): ToolDefinition {
  return defineTool({
    name: 'smith_providers',
    label: 'Smith providers',
    description:
      'Inspect and configure providers: state, stored_keys, connect/disconnect/cancel_login(provider), set_api_key/clear_api_key(providerId). API key values are entered only in the masked approval card.',
    parameters: {
      type: 'object',
      properties: {
        operation: { type: 'string', enum: [...SMITH_PROVIDER_OPERATIONS] },
        provider: { type: 'string' },
        providerId: { type: 'string' },
      },
      required: ['operation'],
      additionalProperties: false,
    },
    execute: async (_id, params) => {
      const secretError = rejectSecretFields(params);
      if (secretError) return json({ ok: false, error: secretError });
      const op = parseOperation(params, SMITH_PROVIDER_OPERATIONS);
      if (!op) return json({ ok: false, error: 'unknown operation' });
      if (op === 'state') return immediate(deps, IPC.bridgeState);
      if (op === 'stored_keys') return immediate(deps, IPC.bridgeStoredKeys);

      const nameField = isKeyOperation(op) ? 'providerId' : 'provider';
      const name = stringField(params, nameField);
      if (!name) return json({ ok: false, error: `${nameField} is required` });
      const channel = ACTION_CHANNELS[op];
      return proposeAction(deps, {
        operation: op,
        title: `${op.replaceAll('_', ' ')} provider`,
        summary: `${op.replaceAll('_', ' ')} ${name}.`,
        args: { [nameField]: name },
        risk: RISKS[op],
        ...(op === 'set_api_key'
          ? {
              secretRequest: {
                kind: 'api-key' as const,
                label: `API key for ${name}`,
                placeholder: 'Enter API key',
              },
            }
          : {}),
        // The key reaches the handler straight from the card and is never an
        // argument the model could have supplied.
        execute: (secret) =>
          op === 'set_api_key' ? deps.invoke(channel, name, secret) : deps.invoke(channel, name),
      });
    },
  });
}
