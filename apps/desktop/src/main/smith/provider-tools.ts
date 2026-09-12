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
  'linear_state',
  'linear_test',
  'linear_set_api_key',
  'linear_clear_api_key',
  'tavily_state',
  'tavily_install',
  'tavily_remove',
  'tavily_set_api_key',
  'tavily_clear_api_key',
  'gemini_live_state',
  'gemini_live_set_api_key',
  'gemini_live_clear_api_key',
] as const;

type ProviderOperation = (typeof SMITH_PROVIDER_OPERATIONS)[number];
type LinearProviderOperation = Extract<ProviderOperation, `linear_${string}`>;
type TavilyProviderOperation = Extract<ProviderOperation, `tavily_${string}`>;
type GeminiLiveProviderOperation = Extract<ProviderOperation, `gemini_live_${string}`>;
type ProviderActionOperation = Exclude<
  ProviderOperation,
  | 'state'
  | 'stored_keys'
  | LinearProviderOperation
  | TavilyProviderOperation
  | GeminiLiveProviderOperation
>;

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
      'Inspect and configure model providers plus Linear, Tavily, and Live Voice: state, stored_keys, connect/disconnect/cancel_login(provider), set_api_key/clear_api_key(providerId), linear_state/linear_test/linear_set_api_key/linear_clear_api_key, tavily_state/tavily_install/tavily_remove/tavily_set_api_key/tavily_clear_api_key, gemini_live_state/gemini_live_set_api_key/gemini_live_clear_api_key. API key values are entered only in the masked approval card, never spoken aloud over voice.',
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
      if (isLinearProviderOperation(op)) return linearProviderOperation(deps, op);
      if (isTavilyProviderOperation(op)) return tavilyProviderOperation(deps, op);
      if (isGeminiLiveProviderOperation(op)) return geminiLiveProviderOperation(deps, op);

      const nameField = isKeyOperation(op) ? 'providerId' : 'provider';
      const name = stringField(params, nameField);
      if (!name) return json({ ok: false, error: `${nameField} is required` });
      const channel = ACTION_CHANNELS[op];
      const label = op.replaceAll('_', ' ');
      return proposeAction(deps, {
        operation: op,
        title: `${label} provider`,
        summary: `${label} ${name}.`,
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

function isLinearProviderOperation(op: ProviderOperation): op is LinearProviderOperation {
  return op.startsWith('linear_');
}

function linearProviderOperation(
  deps: SmithActionToolDeps,
  op: LinearProviderOperation,
): ReturnType<typeof immediate> {
  if (op === 'linear_state') return immediate(deps, IPC.linearState);
  const channel = {
    linear_test: IPC.linearTest,
    linear_set_api_key: IPC.linearSetApiKey,
    linear_clear_api_key: IPC.linearClearApiKey,
  }[op];
  const label = op.replaceAll('_', ' ');
  return proposeAction(deps, {
    operation: op,
    title: label,
    summary: `${label}.`,
    args: {},
    risk: op === 'linear_test' ? 'external' : 'credential',
    ...(op === 'linear_set_api_key'
      ? {
          secretRequest: {
            kind: 'api-key' as const,
            label: 'Linear personal API key',
            placeholder: 'Enter Linear API key',
          },
        }
      : {}),
    execute: (secret) =>
      op === 'linear_set_api_key' ? deps.invoke(channel, secret) : deps.invoke(channel),
  });
}

function isGeminiLiveProviderOperation(op: ProviderOperation): op is GeminiLiveProviderOperation {
  return op.startsWith('gemini_live_');
}

/**
 * The voice layer's own credential seam. State reads immediately; setting or
 * clearing the key is a credential approval whose value arrives only via the
 * masked card — voice can approve the card but never speaks the secret.
 * Token minting stays renderer-only and is deliberately not exposed here.
 */
function geminiLiveProviderOperation(
  deps: SmithActionToolDeps,
  op: GeminiLiveProviderOperation,
): ReturnType<typeof immediate> {
  if (op === 'gemini_live_state') return immediate(deps, IPC.geminiLiveState);
  const channel =
    op === 'gemini_live_set_api_key' ? IPC.geminiLiveSetApiKey : IPC.geminiLiveClearApiKey;
  const label = op.replaceAll('_', ' ');
  return proposeAction(deps, {
    operation: op,
    title: label,
    summary: `${label}.`,
    args: {},
    risk: 'credential',
    ...(op === 'gemini_live_set_api_key'
      ? {
          secretRequest: {
            kind: 'api-key' as const,
            label: 'Gemini API key for Live Voice',
            placeholder: 'Enter Gemini API key',
          },
        }
      : {}),
    execute: (secret) =>
      op === 'gemini_live_set_api_key' ? deps.invoke(channel, secret) : deps.invoke(channel),
  });
}

function isTavilyProviderOperation(op: ProviderOperation): op is TavilyProviderOperation {
  return op.startsWith('tavily_');
}

function tavilyProviderOperation(
  deps: SmithActionToolDeps,
  op: TavilyProviderOperation,
): ReturnType<typeof immediate> {
  if (op === 'tavily_state') return immediate(deps, IPC.tavilyState);
  const channel = {
    tavily_install: IPC.tavilyInstall,
    tavily_remove: IPC.tavilyRemove,
    tavily_set_api_key: IPC.tavilySetApiKey,
    tavily_clear_api_key: IPC.tavilyClearApiKey,
  }[op];
  const label = op.replaceAll('_', ' ');
  return proposeAction(deps, {
    operation: op,
    title: label,
    summary:
      op === 'tavily_install'
        ? 'Download the pinned Tavily web-search extension package for run agents.'
        : `${label}.`,
    args: {},
    // Enabling downloads code an agent will run; removal only deletes that
    // download; the key operations touch a stored credential.
    risk: op === 'tavily_install' ? 'external' : op === 'tavily_remove' ? 'write' : 'credential',
    ...(op === 'tavily_set_api_key'
      ? {
          secretRequest: {
            kind: 'api-key' as const,
            label: 'Tavily API key',
            placeholder: 'Enter Tavily API key',
          },
        }
      : {}),
    execute: (secret) =>
      op === 'tavily_set_api_key' ? deps.invoke(channel, secret) : deps.invoke(channel),
  });
}
