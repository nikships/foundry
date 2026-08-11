/**
 * Nested `npm run` → `npm audit` trips project-scoped allow-scripts on npm 12.
 * Spawn a clean child so the same command works locally and in CI.
 */
import { spawnSync } from 'node:child_process';

const env = { ...process.env };
delete env.npm_config_allow_scripts;

const result = spawnSync('npm', ['audit', '--audit-level=high'], {
  stdio: 'inherit',
  env,
});

process.exit(result.status ?? 1);
