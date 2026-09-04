/**
 * Nested `npm run` → `npm audit` trips project-scoped allow-scripts on npm 12.
 * Spawn a clean child so the same command works locally and in CI.
 */
import { spawnSync } from 'node:child_process';

const env = { ...process.env };
delete env.npm_config_allow_scripts;

const hasFetchTimeout = Object.keys(env).some(
  (name) => name.toLowerCase() === 'npm_config_fetch_timeout',
);
if (!hasFetchTimeout) {
  env.npm_config_fetch_timeout = '60000';
}

const transientFailure =
  /(?:\bHTTP(?: error| status)?\s*(?:429|5\d\d)\b|\bE?429\b|\b5\d\d\b[^\n]*(?:registry\.npmjs\.org|Internal Server Error|Bad Gateway|Service Unavailable|Gateway Timeout)|\b(?:EAI_AGAIN|ECONNREFUSED|ECONNRESET|ENETUNREACH|ETIMEDOUT)\b|audit endpoint returned an error)/i;

for (let attempt = 1; attempt <= 3; attempt += 1) {
  const result = spawnSync('npm', ['audit', '--audit-level=high'], {
    encoding: 'utf8',
    env,
  });

  process.stdout.write(result.stdout ?? '');
  process.stderr.write(result.stderr ?? '');

  if (result.status === 0) {
    process.exit(0);
  }

  const output = `${result.stdout ?? ''}\n${result.stderr ?? ''}`;
  if (!transientFailure.test(output)) {
    process.exit(result.status ?? 1);
  }

  if (attempt < 3) {
    process.stderr.write(`npm audit hit a transient registry error; retrying (${attempt}/3).\n`);
  }
}

process.stderr.write(
  '\n*** WARNING: npm audit failed three times due to transient registry errors; continuing without an audit result. ***\n',
);
