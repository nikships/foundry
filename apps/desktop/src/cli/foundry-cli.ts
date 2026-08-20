#!/usr/bin/env node
/**
 * foundry-cli — the helper binary an agent invokes to drive Foundry's entity
 * stores from a Smith session.
 *
 * Standalone, dependency-free stdlib Node. It ships inside the app bundle and is
 * run by whatever agent loaded the `foundry-smith` skill, in the user's own
 * terminal — never installed globally. It talks to the running app over the unix
 * domain socket at `$FOUNDRY_SMITH_SOCKET`, or the app's default support-dir
 * path when that is unset, newline-delimited JSON (protocol in
 * `../main/smith/protocol.ts`). If the socket is absent the app is not running:
 * exit 2 with a plain-English line.
 *
 * Usage:
 *   foundry-cli <agent|pipeline|envelope> list
 *   foundry-cli <agent|pipeline|envelope> show <name>
 *   foundry-cli <agent|pipeline|envelope> create --file <spec.json>
 *   foundry-cli <agent|pipeline|envelope> edit <name> --file <spec.json>
 *   foundry-cli project list
 *
 * Any command takes a global `--project <id>` to scope it, overriding
 * `$FOUNDRY_SMITH_PROJECT`.
 *
 * Prints one JSON object to stdout. Exit 0 on success; 1 on validation failure,
 * rejection, or an error from the app; 2 when the app is not running; 3 on
 * usage error. Type imports only, so nothing from the app is bundled in.
 */

import { readFileSync } from 'node:fs';
import { connect } from 'node:net';
import type { CliRequest, CliResponse } from '../main/smith/protocol.js';
import { EXIT, parseArgs, resolveSocketPath } from './args.js';

function fail(message: string, code: number): never {
  process.stdout.write(`${JSON.stringify({ ok: false, error: message })}\n`);
  process.exit(code);
}

/** Builds the request, reading the `--file` spec for a write. */
function requestFrom(argv: string[]): CliRequest {
  const parsed = parseArgs(argv);
  if (!parsed.ok) fail(parsed.message, parsed.code);
  if (!parsed.specFile) return parsed.request;
  try {
    return { ...parsed.request, spec: JSON.parse(readFileSync(parsed.specFile, 'utf8')) };
  } catch (e) {
    return fail(`could not read spec file: ${(e as Error).message}`, EXIT.usage);
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
  return response.ok ? EXIT.ok : EXIT.failed;
}

async function main(): Promise<void> {
  const socketPath = resolveSocketPath();
  const request = requestFrom(process.argv.slice(2));

  let response: CliResponse;
  try {
    response = await send(socketPath, request);
  } catch (err) {
    const code = (err as NodeJS.ErrnoException).code;
    if (code === 'ENOENT' || code === 'ECONNREFUSED')
      fail('Foundry is not running', EXIT.notRunning);
    return fail(`transport error: ${(err as Error).message}`, EXIT.notRunning);
  }

  process.stdout.write(`${JSON.stringify(response)}\n`);
  process.exit(exitCodeFor(response));
}

void main();
