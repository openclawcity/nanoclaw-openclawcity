/**
 * Wire the subscriber's WhatsApp DM to this stack's agent — the hosted-fleet
 * post-link step (openbotcity repo, infra/hosted-agents).
 *
 * fleetd invokes this (via bin/wire-owner-whatsapp.js) the moment it observes
 * a completed Baileys link, so the owner's chat routes to the agent without
 * any manual /manage-channels step. It is the non-interactive, idempotent
 * subset of scripts/init-first-agent.ts for channel=whatsapp:
 *
 *   - user `whatsapp:<phone>` with a global owner grant + membership
 *   - DM messaging group for `<phone>@s.whatsapp.net`
 *   - wiring to the stack's PRIMARY agent group (hosted citizen stacks have
 *     exactly one; created as `main` if none exists yet), engage pattern '.'
 *     — the owner's own chat is the deliberate always-on conversation
 *
 * No welcome is sent here (no dependency on the CLI socket, so this cannot
 * race a unit restart); fleetd nudges the agent to greet separately.
 *
 * Usage: pnpm exec tsx scripts/wire-owner-whatsapp.ts --phone 447700900000 \
 *          [--agent-name Clawdine]
 */
import fs from 'fs';
import path from 'path';

import { DATA_DIR, GROUPS_DIR, ASSISTANT_NAME } from '../src/config.js';
import { createAgentGroup, getAgentGroupByFolder, getAllAgentGroups } from '../src/db/agent-groups.js';
import { initDb } from '../src/db/connection.js';
import {
  createMessagingGroup,
  createMessagingGroupAgent,
  getMessagingGroupAgentByPair,
  getMessagingGroupByPlatform,
} from '../src/db/messaging-groups.js';
import { runMigrations } from '../src/db/migrations/index.js';
import { ensureContainerConfig, updateContainerConfigScalars } from '../src/db/container-configs.js';
import { addMember } from '../src/modules/permissions/db/agent-group-members.js';
import { getUserRoles, grantRole } from '../src/modules/permissions/db/user-roles.js';
import { upsertUser } from '../src/modules/permissions/db/users.js';
import { namespacedPlatformId } from '../src/platform-id.js';
import type { AgentGroup } from '../src/types.js';

function generateId(prefix: string): string {
  return `${prefix}-${Date.now()}-${Math.random().toString(36).slice(2, 8)}`;
}

function parseArgs(argv: string[]): { phone: string; agentName: string } {
  let phone = '';
  let agentName = '';
  for (let i = 0; i < argv.length; i++) {
    if (argv[i] === '--phone') phone = (argv[++i] ?? '').replace(/[^\d]/g, '');
    else if (argv[i] === '--agent-name') agentName = argv[++i] ?? '';
  }
  if (!phone || phone.length < 7) {
    console.error('usage: wire-owner-whatsapp.ts --phone <digits, country code first> [--agent-name <name>]');
    process.exit(2);
  }
  return { phone, agentName: agentName.trim() || ASSISTANT_NAME || 'Agent' };
}

async function main(): Promise<void> {
  const { phone, agentName } = parseArgs(process.argv.slice(2));

  const db = initDb(path.join(DATA_DIR, 'v2.db'));
  runMigrations(db); // idempotent

  const now = new Date().toISOString();
  const userId = `whatsapp:${phone}`;
  const platformId = namespacedPlatformId('whatsapp', `${phone}@s.whatsapp.net`);

  // 1. The stack's primary agent group: hosted citizen stacks have exactly
  //    one (created by the city channel's first inbound or a prior wiring).
  //    A stack that has never spoken yet gets `main`.
  let ag: AgentGroup | undefined = getAllAgentGroups()[0];
  if (!ag) {
    createAgentGroup({
      id: generateId('ag'),
      name: agentName,
      folder: 'main',
      agent_provider: null,
      created_at: now,
    });
    ag = getAgentGroupByFolder('main')!;
    fs.mkdirSync(path.resolve(GROUPS_DIR, 'main'), { recursive: true });
    console.log(`Created agent group: ${ag.id} (main)`);
  } else {
    console.log(`Using primary agent group: ${ag.id} (${ag.folder})`);
  }
  ensureContainerConfig(ag.id);

  // 2. Owner user + grant + membership (idempotent, mirrors init-first-agent).
  upsertUser({ id: userId, kind: 'whatsapp', display_name: 'Owner', created_at: now });
  const roles = getUserRoles(userId);
  if (!roles.some((r) => r.role === 'owner' && r.agent_group_id === null)) {
    grantRole({ user_id: userId, role: 'owner', agent_group_id: null, granted_by: null, granted_at: now });
  }
  updateContainerConfigScalars(ag.id, { cli_scope: 'global' });
  addMember({ user_id: userId, agent_group_id: ag.id, added_by: null, added_at: now });

  // 3. DM messaging group + wiring. The owner's chat is the deliberate
  //    always-on conversation, so engage on everything (pattern '.').
  let mg = getMessagingGroupByPlatform('whatsapp', platformId);
  if (!mg) {
    createMessagingGroup({
      id: generateId('mg'),
      channel_type: 'whatsapp',
      platform_id: platformId,
      name: 'Owner',
      is_group: 0,
      unknown_sender_policy: 'strict',
      created_at: now,
    });
    mg = getMessagingGroupByPlatform('whatsapp', platformId)!;
    console.log(`Created messaging group: ${mg.id} (${platformId})`);
  } else {
    console.log(`Reusing messaging group: ${mg.id} (${platformId})`);
  }

  const existing = getMessagingGroupAgentByPair(mg.id, ag.id);
  if (existing) {
    console.log(`Wiring already exists: ${existing.id}`);
  } else {
    createMessagingGroupAgent({
      id: generateId('mga'),
      messaging_group_id: mg.id,
      agent_group_id: ag.id,
      engage_mode: 'pattern',
      engage_pattern: '.',
      sender_scope: 'all',
      ignored_message_policy: 'drop',
      session_mode: 'shared',
      priority: 0,
      created_at: now,
    });
    console.log(`Wired: ${mg.id} -> ${ag.id}`);
  }

  console.log(`WIRE-OWNER-WHATSAPP-OK user=${userId} agent=${ag.id}`);
}

main().catch((err) => {
  console.error('wire-owner-whatsapp failed:', err);
  process.exit(1);
});
