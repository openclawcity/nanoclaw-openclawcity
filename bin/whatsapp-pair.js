#!/usr/bin/env node
/**
 * whatsapp-pair.js — headless WhatsApp pairing for fleet hosts.
 *
 * Contract (infra/hosted-agents in the openbotcity repo,
 * RealSystemAdapter.requestWhatsAppPairing):
 *
 *   node ./bin/whatsapp-pair.js --phone 447700900123      # from the stack root
 *
 * Prints `PAIRING_CODE: <8-char code>` to stdout and exits 0 well inside the
 * caller's 120s window. A detached worker (this same script re-invoked with
 * --wait) keeps the Baileys socket open so the link completes when the owner
 * enters the code on their phone; credentials land in store/auth/creds.json,
 * which is what the fleet's stackState checks for whatsapp_status=linked.
 *
 * The Baileys flow mirrors setup/whatsapp-auth.ts (the interactive setup
 * step); this entrypoint exists because fleet hosts are headless and prod
 * stacks are installed without devDependencies, so `tsx setup/index.ts` is
 * not available.
 */
import fs from 'fs';
import path from 'path';
import process from 'process';
import { spawn } from 'child_process';
import { fileURLToPath } from 'url';

const STACK_ROOT = process.cwd();
const AUTH_DIR = path.join(STACK_ROOT, 'store', 'auth');
const PAIRING_CODE_FILE = path.join(STACK_ROOT, 'store', 'pairing-code.txt');
const LOG_FILE = path.join(STACK_ROOT, 'store', 'whatsapp-pair.log');
const SELF = fileURLToPath(import.meta.url);

// Wait budget: parent polls up to 60s for the code; the detached worker
// holds the socket up to 10 minutes (the fleet's pairing-code TTL).
const PARENT_POLL_MS = 60_000;
const WORKER_TIMEOUT_MS = 10 * 60_000;

function parseArgs(argv) {
  let phone;
  let wait = false;
  for (let i = 2; i < argv.length; i++) {
    if (argv[i] === '--phone') phone = argv[++i];
    else if (argv[i] === '--wait') wait = true;
  }
  return { phone, wait };
}

function logLine(msg) {
  fs.appendFileSync(LOG_FILE, `${new Date().toISOString()} ${msg}\n`);
}

const { phone, wait } = parseArgs(process.argv);
if (!phone || !/^\d{7,15}$/.test(phone)) {
  console.error('usage: whatsapp-pair.js --phone <digits, country code first>');
  process.exit(1);
}

if (!wait) {
  // ── Parent: spawn the detached worker, poll for the code, print, exit ──
  if (fs.existsSync(path.join(AUTH_DIR, 'creds.json'))) {
    console.error('whatsapp-pair: already linked (store/auth/creds.json exists)');
    process.exit(2);
  }
  fs.mkdirSync(path.dirname(PAIRING_CODE_FILE), { recursive: true });
  try {
    fs.unlinkSync(PAIRING_CODE_FILE);
  } catch {
    // stale-file cleanup is best-effort
  }

  const worker = spawn(process.execPath, [SELF, '--phone', phone, '--wait'], {
    cwd: STACK_ROOT,
    detached: true,
    stdio: 'ignore',
  });
  worker.unref();

  const deadline = Date.now() + PARENT_POLL_MS;
  const poll = setInterval(() => {
    if (fs.existsSync(PAIRING_CODE_FILE)) {
      clearInterval(poll);
      const code = fs.readFileSync(PAIRING_CODE_FILE, 'utf-8').trim().replace(/-/g, '');
      console.log(`PAIRING_CODE: ${code}`);
      process.exit(0);
    }
    if (Date.now() > deadline) {
      clearInterval(poll);
      console.error('whatsapp-pair: no pairing code within 60s (see store/whatsapp-pair.log)');
      process.exit(1);
    }
  }, 500);
} else {
  // ── Worker: drive Baileys until the owner completes the link ──
  const { pino } = await import('pino');
  const {
    makeWASocket,
    Browsers,
    DisconnectReason,
    fetchLatestWaWebVersion,
    makeCacheableSignalKeyStore,
    useMultiFileAuthState,
  } = await import('@whiskeysockets/baileys');

  const baileysLogger = pino({ level: 'silent' });

  // Current WA Web version — wppconnect tracker, then Baileys fallback
  // (mirrors setup/whatsapp-auth.ts resolveWaWebVersion).
  async function resolveWaWebVersion() {
    try {
      const res = await fetch('https://wppconnect.io/whatsapp-versions/', {
        signal: AbortSignal.timeout(5000),
      });
      if (res.ok) {
        const html = await res.text();
        const match = html.match(/2\.3000\.(\d+)/);
        if (match) return [2, 3000, Number(match[1])];
      }
    } catch {
      // fall through to the Baileys resolver
    }
    const { version } = await fetchLatestWaWebVersion({});
    return version;
  }

  fs.mkdirSync(AUTH_DIR, { recursive: true });
  logLine(`worker start phone=${phone}`);

  const timeout = setTimeout(() => {
    logLine('worker timeout: owner did not complete the link');
    process.exit(1);
  }, WORKER_TIMEOUT_MS);

  async function connectSocket(isReconnect = false) {
    const { state, saveCreds } = await useMultiFileAuthState(AUTH_DIR);
    const version = await resolveWaWebVersion();

    const sock = makeWASocket({
      version,
      auth: {
        creds: state.creds,
        keys: makeCacheableSignalKeyStore(state.keys, baileysLogger),
      },
      printQRInTerminal: false,
      logger: baileysLogger,
      browser: Browsers.macOS('Chrome'),
    });

    if (!isReconnect && !state.creds.registered) {
      setTimeout(async () => {
        try {
          const code = await sock.requestPairingCode(phone);
          fs.writeFileSync(PAIRING_CODE_FILE, code, 'utf-8');
          logLine(`pairing code issued: ${code}`);
        } catch (err) {
          logLine(`pairing code request failed: ${err instanceof Error ? err.message : String(err)}`);
          process.exit(1);
        }
      }, 3000);
    }

    sock.ev.on('connection.update', (update) => {
      const { connection, lastDisconnect } = update;

      if (connection === 'open') {
        clearTimeout(timeout);
        logLine('linked: connection open, creds saved');
        try {
          fs.unlinkSync(PAIRING_CODE_FILE);
        } catch {
          // best-effort cleanup
        }
        sock.end(undefined);
        // Give creds a moment to flush before exiting.
        setTimeout(() => process.exit(0), 1000);
      }

      if (connection === 'close') {
        const reason = lastDisconnect?.error?.output?.statusCode;
        if (reason === DisconnectReason.loggedOut) {
          logLine('failed: logged_out');
          process.exit(1);
        } else if (reason === 515) {
          // 515 = stream error after pairing succeeds but before registration
          // completes. Reconnect to finish the handshake.
          logLine('reconnecting after 515 to finish registration');
          connectSocket(true);
        } else {
          logLine(`connection closed (status ${reason ?? 'unknown'})`);
        }
      }
    });

    sock.ev.on('creds.update', saveCreds);
  }

  connectSocket();
}
