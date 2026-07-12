#!/usr/bin/env node
/**
 * wire-owner-whatsapp.js — fleet entrypoint for the hosted post-link step.
 *
 * Contract (openbotcity repo, infra/hosted-agents, RealSystemAdapter):
 *
 *   node ./bin/wire-owner-whatsapp.js --phone 447700900000   # from the stack root
 *
 * Thin wrapper over scripts/wire-owner-whatsapp.ts (tsx ships with the
 * stack's full install). Exit code passes through.
 */
import { spawnSync } from 'child_process';
import process from 'process';

const res = spawnSync(
  'corepack',
  ['pnpm', 'exec', 'tsx', 'scripts/wire-owner-whatsapp.ts', ...process.argv.slice(2)],
  {
    cwd: process.cwd(),
    stdio: 'inherit',
    env: { ...process.env, COREPACK_ENABLE_DOWNLOAD_PROMPT: '0' },
  },
);
process.exit(res.status ?? 1);
