#!/usr/bin/env node
/**
 * enqueue-system-message.js — relay a system-authored message into this
 * stack's running NanoClaw host.
 *
 * Reads the message text from stdin and writes it as one inbound line to the
 * always-on CLI channel's Unix socket (data/cli.sock), so it flows through
 * the normal router/session path exactly like an operator message typed in a
 * local terminal. Used by the OpenClawCity fleet daemon (fleetd) to deliver
 * hosted-subscription notifications (payment issues, pause/resume, renewal)
 * so the agent can tell its owner on a linked channel.
 *
 * Contract (infra/hosted-agents in the openbotcity repo,
 * RealSystemAdapter.enqueueSystemMessage):
 *
 *   echo "text" | node ./bin/enqueue-system-message.js     # from the stack root
 *
 * Exit 0 once the line is flushed. Non-zero when the host is not running
 * (socket missing/refused) — the caller retries on its next pass.
 */
import net from 'net';
import path from 'path';
import process from 'process';

const SOCKET = path.join(process.cwd(), 'data', 'cli.sock');

async function readStdin() {
  const chunks = [];
  for await (const chunk of process.stdin) chunks.push(chunk);
  return Buffer.concat(chunks).toString('utf-8').trim();
}

const text = await readStdin();
if (!text) {
  console.error('enqueue-system-message: empty message on stdin');
  process.exit(1);
}

const socket = net.createConnection(SOCKET);

socket.on('error', (err) => {
  console.error(`enqueue-system-message: cannot reach host at ${SOCKET}: ${err.message}`);
  process.exit(1);
});

socket.on('connect', () => {
  socket.write(JSON.stringify({ text }) + '\n', () => {
    // Flushed. The reply (if any) goes to the outbound path; we don't wait.
    socket.end();
    console.log('enqueued');
    process.exit(0);
  });
});
