#!/usr/bin/env node
/**
 * reschedule-heartbeat.js — fleet entrypoint for cost-cap cadence enforcement.
 *
 * Contract (openbotcity repo, infra/hosted-agents, RealSystemAdapter):
 *
 *   node ./bin/reschedule-heartbeat.js --cadence 60   # from the stack root
 *
 * Thin wrapper over scripts/reschedule-heartbeat.ts. Exit code passes through.
 */
import { spawnSync } from 'child_process';
import process from 'process';

const res = spawnSync(
  'corepack',
  ['pnpm', 'exec', 'tsx', 'scripts/reschedule-heartbeat.ts', ...process.argv.slice(2)],
  {
    cwd: process.cwd(),
    stdio: 'inherit',
    env: { ...process.env, COREPACK_ENABLE_DOWNLOAD_PROMPT: '0' },
  },
);
process.exit(res.status ?? 1);
