/**
 * Reschedule the recurring OpenClawCity heartbeat to a new cadence — the
 * hosted-fleet cost-cap enforcement step (openbotcity repo, infra/hosted-agents).
 *
 * When a subscriber hits their monthly LLM cap, the fleet stretches the
 * heartbeat cadence to reduce spend. Updating the hosted_agents row alone does
 * nothing to the LIVE agent: its heartbeat is a NanoClaw recurring task whose
 * cron lives in the session DB. fleetd invokes this (via
 * bin/reschedule-heartbeat.js) to rewrite that cron so the running agent
 * actually slows down.
 *
 * NanoClaw keeps exactly one pending row per series carrying `recurrence`
 * (recurrence.ts: on fire it clones the next occurrence and clears the cron on
 * the original). We update that row's cron across every session DB, and rewrite
 * config/heartbeat.json so a re-stamp keeps the stretched value.
 *
 * Usage: pnpm exec tsx scripts/reschedule-heartbeat.ts --cadence 60
 */
import fs from 'fs';
import path from 'path';
import Database from 'better-sqlite3';

function parseArgs(argv: string[]): { cadence: number } {
  let cadence = 0;
  for (let i = 0; i < argv.length; i++) {
    if (argv[i] === '--cadence') cadence = parseInt(argv[++i] ?? '', 10);
  }
  if (!Number.isFinite(cadence) || cadence < 1 || cadence > 1440) {
    console.error('usage: reschedule-heartbeat.ts --cadence <minutes 1..1440>');
    process.exit(2);
  }
  return { cadence };
}

function sessionDbs(root: string): string[] {
  const base = path.join(root, 'data', 'v2-sessions');
  const out: string[] = [];
  let groups: string[];
  try {
    groups = fs.readdirSync(base);
  } catch {
    return out;
  }
  for (const g of groups) {
    let sessions: string[];
    try {
      sessions = fs.readdirSync(path.join(base, g));
    } catch {
      continue;
    }
    for (const s of sessions) {
      const db = path.join(base, g, s, 'inbound.db');
      if (fs.existsSync(db)) out.push(db);
    }
  }
  return out;
}

function main(): void {
  const { cadence } = parseArgs(process.argv.slice(2));
  const root = process.cwd();
  const cron = `*/${cadence} * * * *`;

  let updated = 0;
  for (const dbPath of sessionDbs(root)) {
    try {
      const db = new Database(dbPath);
      // The single pending row per heartbeat series carries the cron. Match the
      // heartbeat task by its prompt so a user's own recurring tasks are left
      // alone. content is JSON text holding the prompt.
      const res = db
        .prepare(
          `UPDATE messages_in SET recurrence = ?
             WHERE recurrence IS NOT NULL
               AND lower(content) LIKE '%openclawcity heartbeat%'`,
        )
        .run(cron);
      updated += res.changes;
      db.close();
    } catch (err) {
      console.error(`reschedule-heartbeat: ${dbPath}: ${err instanceof Error ? err.message : String(err)}`);
    }
  }

  // Keep config/heartbeat.json in step so a re-stamp preserves the cadence.
  try {
    const cfgPath = path.join(root, 'config', 'heartbeat.json');
    const cfg = JSON.parse(fs.readFileSync(cfgPath, 'utf-8')) as Record<string, unknown>;
    cfg.recurrence = cron;
    fs.writeFileSync(cfgPath, JSON.stringify(cfg, null, 2));
  } catch {
    // config is best-effort; the DB update is what changes live behaviour
  }

  console.log(`RESCHEDULE-HEARTBEAT-OK cadence=${cadence} rows=${updated}`);
}

main();
