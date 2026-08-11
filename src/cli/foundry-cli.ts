#!/usr/bin/env node
/**
 * foundry-cli — the helper binary droid invokes as `$FOUNDRY_CLI` to drive
 * Foundry's entity stores from inside a Smith session.
 *
 * Standalone, dependency-free stdlib Node. It ships inside the app bundle and is
 * spawned by droid, never installed globally. It talks to the running app over
 * the unix domain socket at `$FOUNDRY_SMITH_SOCKET`, newline-delimited JSON
 * (protocol in `../main/smith/protocol.ts`). If the socket is absent the app is
 * not running: exit 2 with a plain-English line.
 *
 * Usage:
 *   foundry-cli <agent|pipeline|envelope> list
 *   foundry-cli <agent|pipeline|envelope> show <name>
 *   foundry-cli <agent|pipeline|envelope> create --file <spec.json>
 *   foundry-cli <agent|pipeline|envelope> edit <name> --file <spec.json>
 *
 * Prints one JSON object to stdout. Exit 0 on success; 1 on validation failure,
 * rejection, or an error from the app; 2 when the app is not running; 3 on
 * usage error. Type imports only, so nothing from the app is bundled in.
 */

import { readFileSync } from 'node:fs';
import { connect } from 'node:net';
import type { CliRequest, CliResponse } from '../main/smith/protocol.js';

type Kind = 'agent' | 'pipeline' | 'envelope';
const KINDS: Kind[] = ['agent', 'pipeline', 'envelope'];

function fail(message: string, code: number): never {
  process.stdout.write(`${JSON.stringify({ ok: false, error: message })}\n`);
  process.exit(code);
}

/** Pulls `--file <path>` out of the args and returns the parsed JSON spec. */
function readSpec(args: string[]): unknown {
  const at = args.indexOf('--file');
  if (at < 0 || !args[at + 1]) fail('create/edit needs --file <spec.json>', 3);
  try {
    return JSON.parse(readFileSync(args[at + 1]!, 'utf8'));
  } catch (e) {
    return fail(`could not read spec file: ${(e as Error).message}`, 3);
  }
}

function parse(argv: string[]): CliRequest {
  const [kind, op, ...rest] = argv;
  if (!kind || !KINDS.includes(kind as Kind)) {
    fail(`first argument must be one of ${KINDS.join(', ')}`, 3);
  }
  const projectId = process.env.FOUNDRY_SMITH_PROJECT || undefined;
  const base = { kind: kind as Kind, projectId };

  switch (op) {
    case 'list':
      return { op: 'list', ...base };
    case 'show': {
      const name = rest[0];
      if (!name) fail('show needs a name', 3);
      return { op: 'show', name, ...base };
    }
    case 'create':
      return { op: 'create', spec: readSpec(rest), ...base };
    case 'edit': {
      const name = rest[0];
      if (!name || name.startsWith('--')) fail('edit needs a name before --file', 3);
      return { op: 'edit', name, spec: readSpec(rest.slice(1)), ...base };
    }
    default:
      return fail(`unknown command "${op ?? ''}" — use list, show, create, or edit`, 3);
  }
}

/** Sends one request and resolves with the one response line. */
function send(socketPath: string, request: CliRequest): Promise<CliResponse> {
  return new Promise<CliResponse>((resolve, reject) => {
    const socket = connect(socketPath);
    let buffer = '';
    socket.setEncoding('utf8');
    socket.on('connect', () => socket.write(`${JSON.stringify(request)}\n`));
    socket.on('data', (chunk: string) => {
      buffer += chunk;
      const newline = buffer.indexOf('\n');
      if (newline < 0) return;
      socket.end();
      try {
        resolve(JSON.parse(buffer.slice(0, newline)) as CliResponse);
      } catch (e) {
        reject(e as Error);
      }
    });
    socket.on('error', (err) => reject(err));
    socket.on('close', () => {
      if (!buffer.includes('\n')) reject(new Error('connection closed before a reply'));
    });
  });
}

/** Success is `ok:true`; every documented failure maps to exit 1. */
function exitCodeFor(response: CliResponse): number {
  return response.ok ? 0 : 1;
}

async function main(): Promise<void> {
  const socketPath = process.env.FOUNDRY_SMITH_SOCKET;
  if (!socketPath) fail('Foundry is not running', 2);

  const request = parse(process.argv.slice(2));

  let response: CliResponse;
  try {
    response = await send(socketPath, request);
  } catch (err) {
    const code = (err as NodeJS.ErrnoException).code;
    if (code === 'ENOENT' || code === 'ECONNREFUSED') fail('Foundry is not running', 2);
    return fail(`transport error: ${(err as Error).message}`, 2);
  }

  process.stdout.write(`${JSON.stringify(response)}\n`);
  process.exit(exitCodeFor(response));
}

void main();
