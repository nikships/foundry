import { IPC } from '@shared/ipc-contract.js';
import type { SmithActionRisk } from '@shared/types.js';
import { defineTool, type ToolDefinition } from '../pi/tool-definition.js';
import {
  errorMessage,
  field,
  immediate,
  json,
  objectField,
  parseOperation,
  proposeAction,
  stringArrayField,
  stringField,
  type SmithActionToolDeps,
} from './tool-helpers.js';

export const SMITH_PROJECT_OPERATIONS = [
  'list',
  'show',
  'add',
  'github_account',
  'choose_parent',
  'create_github',
  'save',
  'remove',
  'export',
  'try_command',
  'sniff_commands',
  'ask_commands',
  'cancel_detection',
  'detection',
  'setup_get',
  'setup_save',
  'setup_sniff',
  'setup_try',
  'setup_ask',
  'setup_progress',
  'setup_cancel',
  'check',
  'reveal',
  'scope_copies',
  'base_inspect',
  'base_sync',
] as const;

type ProjectOperation = (typeof SMITH_PROJECT_OPERATIONS)[number];

/**
 * One declared argument of an operation. `kind` decides both how the value is
 * read out of the tool params and what a missing value reports; `script` is a
 * string that may legitimately be empty (clearing a project's setup script).
 */
interface ArgSpec {
  name: string;
  kind: 'string' | 'script' | 'object' | 'stringArray';
}

interface ActionSpec {
  channel: string;
  risk: SmithActionRisk;
  args?: readonly ArgSpec[];
}

/** Immediate reads: one string argument each, forwarded unchanged. */
const READS: Partial<Record<ProjectOperation, readonly [channel: string, field: string]>> = {
  detection: [IPC.projectsDetection, 'detectionId'],
  setup_get: [IPC.projectsSetupScriptGet, 'projectId'],
  setup_sniff: [IPC.projectsSetupScriptSniff, 'projectId'],
  setup_progress: [IPC.projectsSetupProgress, 'setupId'],
  check: [IPC.projectsCheck, 'projectId'],
  scope_copies: [IPC.projectsScopeCopies, 'projectId'],
  base_inspect: [IPC.projectsBaseSyncInspect, 'projectId'],
};

const PROJECT_ID = [{ name: 'projectId', kind: 'string' }] as const satisfies readonly ArgSpec[];

/** Every gated operation: its handler, its risk badge, and its arguments. */
const ACTIONS: Partial<Record<ProjectOperation, ActionSpec>> = {
  add: { channel: IPC.projectsAdd, risk: 'write' },
  choose_parent: { channel: IPC.projectsChooseParentDir, risk: 'write' },
  create_github: {
    channel: IPC.projectsCreateGithub,
    risk: 'external',
    args: [{ name: 'input', kind: 'object' }],
  },
  save: {
    channel: IPC.projectsSave,
    risk: 'write',
    args: [{ name: 'project', kind: 'object' }],
  },
  remove: { channel: IPC.projectsRemove, risk: 'destructive', args: PROJECT_ID },
  export: { channel: IPC.projectsExport, risk: 'write', args: PROJECT_ID },
  try_command: {
    channel: IPC.projectsTryCommand,
    risk: 'shell',
    args: [
      { name: 'projectId', kind: 'string' },
      { name: 'argv', kind: 'stringArray' },
    ],
  },
  sniff_commands: { channel: IPC.projectsSniffCommands, risk: 'shell', args: PROJECT_ID },
  ask_commands: { channel: IPC.projectsAskAgentCommands, risk: 'write', args: PROJECT_ID },
  cancel_detection: {
    channel: IPC.projectsCancelDetection,
    risk: 'write',
    args: [{ name: 'detectionId', kind: 'string' }],
  },
  setup_save: {
    channel: IPC.projectsSetupScriptSave,
    risk: 'write',
    args: [
      { name: 'projectId', kind: 'string' },
      { name: 'script', kind: 'script' },
    ],
  },
  setup_try: {
    channel: IPC.projectsSetupScriptTry,
    risk: 'shell',
    args: [
      { name: 'projectId', kind: 'string' },
      { name: 'script', kind: 'script' },
    ],
  },
  setup_ask: { channel: IPC.projectsSetupScriptAskAgent, risk: 'write', args: PROJECT_ID },
  setup_cancel: {
    channel: IPC.projectsSetupCancel,
    risk: 'write',
    args: [{ name: 'setupId', kind: 'string' }],
  },
  reveal: {
    channel: IPC.projectsReveal,
    risk: 'external',
    args: [{ name: 'path', kind: 'string' }],
  },
  base_sync: { channel: IPC.projectsBaseSync, risk: 'git', args: PROJECT_ID },
};

function readArg(params: unknown, arg: ArgSpec): unknown {
  if (arg.kind === 'object') return objectField(params, arg.name);
  if (arg.kind === 'stringArray') return stringArrayField(params, arg.name);
  if (arg.kind === 'script') {
    const value = field(params, arg.name);
    return typeof value === 'string' ? value : null;
  }
  return stringField(params, arg.name);
}

function missingArgsError(args: readonly ArgSpec[]): string {
  const names = args.map((arg) => arg.name).join(' and ');
  return `${names} ${args.length > 1 ? 'are' : 'is'} required`;
}

export function smithProjectsTool(deps: SmithActionToolDeps): ToolDefinition {
  return defineTool({
    name: 'smith_projects',
    label: 'Smith projects',
    description:
      'Inspect and manage Foundry projects. Operations: list, show(projectId), add, github_account, choose_parent, create_github(input), save(project), remove/export(projectId), try_command(projectId,argv), sniff_commands/ask_commands(projectId), cancel_detection/detection(detectionId), setup_get/save/sniff/try/ask(projectId,script?), setup_progress/setup_cancel(setupId), check/scope_copies/base_inspect/base_sync(projectId), reveal(path).',
    parameters: {
      type: 'object',
      properties: {
        operation: { type: 'string', enum: [...SMITH_PROJECT_OPERATIONS] },
        projectId: { type: 'string' },
        input: { type: 'object' },
        project: { type: 'object' },
        argv: { type: 'array', items: { type: 'string' } },
        detectionId: { type: 'string' },
        setupId: { type: 'string' },
        script: { type: 'string' },
        path: { type: 'string' },
      },
      required: ['operation'],
      additionalProperties: false,
    },
    execute: async (_id, params) => {
      const op = parseOperation(params, SMITH_PROJECT_OPERATIONS);
      if (!op) return json({ ok: false, error: 'unknown operation' });
      if (op === 'list') return immediate(deps, IPC.projectsList);
      if (op === 'github_account') return immediate(deps, IPC.projectsGithubAccount);
      if (op === 'show') return showProject(deps, stringField(params, 'projectId'));

      const read = READS[op];
      if (read) {
        const [channel, name] = read;
        const value = stringField(params, name);
        return value
          ? immediate(deps, channel, value)
          : json({ ok: false, error: `${name} is required` });
      }

      const action = ACTIONS[op];
      if (!action) return json({ ok: false, error: 'unknown operation' });
      const specs = action.args ?? [];
      const values = specs.map((arg) => readArg(params, arg));
      if (values.some((value) => value === null)) {
        return json({ ok: false, error: missingArgsError(specs) });
      }
      const label = op.replaceAll('_', ' ');
      return proposeAction(deps, {
        operation: op,
        title: `${label} project`,
        summary: `Perform ${label}.`,
        args: Object.fromEntries(specs.map((arg, index) => [arg.name, values[index]])),
        risk: action.risk,
        execute: () => deps.invoke(action.channel, ...values),
      });
    },
  });
}

/** `show` is a projection over the project list, not a handler of its own. */
async function showProject(
  deps: Pick<SmithActionToolDeps, 'invoke'>,
  projectId: string | null,
): Promise<ReturnType<typeof json>> {
  if (!projectId) return json({ ok: false, error: 'projectId is required' });
  try {
    const projects = await deps.invoke<unknown[]>(IPC.projectsList);
    const match = projects.find(
      (project) =>
        typeof project === 'object' &&
        project !== null &&
        (project as { id?: string }).id === projectId,
    );
    return json({ ok: true, result: match ?? null });
  } catch (error) {
    return json({ ok: false, error: errorMessage(error) });
  }
}
