#!/usr/bin/env node
/**
 * Daily Market Digest — entrypoint
 * ────────────────────────────────────────────────────────────
 * Owner / Creator: Itachi
 * Made by CRYPTFRANI
 *
 * Modes:
 *   node src/index.js             start the autonomous agent (default)
 *   node src/index.js --whoami    print identity + balance, then exit
 *   node src/index.js --doctor    connectivity / config self-check, then exit
 *   node src/index.js --mint      capped self-mint, then exit
 *   node src/index.js --preview   build & print a digest preview, then exit
 *   node src/index.js --run-now   generate + publish a digest immediately, then exit
 */

import config from './config.js';
import { createLogger } from './logger.js';
import { SphereClient } from './sphere-client.js';
import { describeSchedule, nextSlot, prettyStamp } from './scheduler.js';

const log = createLogger('main');

function banner() {
  log.info('──────────────────────────────────────────────');
  log.info(' Daily Market Digest · autonomous Unicity testnet2 agent');
  log.info(` owner: ${config.owner}   ·   made by ${config.brand}`);
  log.info(` network: ${config.network}   dry-run: ${config.safety.dryRun}`);
  log.info(` schedule: ${describeSchedule(config.schedule.times)} (local)`);
  log.info('──────────────────────────────────────────────');
}

async function reportStatus(client) {
  const balance = await client.spendableWhole();
  const next = nextSlot(config.schedule.times);
  log.info(`Identity : ${client.describe()}`);
  log.info(`Coin     : ${client.coin.symbol} (${client.coin.decimals} decimals)`);
  log.info(`Balance  : ${balance} ${client.coin.symbol} (spendable)`);
  log.info(`Wallet   : ${config.walletDir}  (device ${client.deviceId})`);
  log.info(`Next run : ${next ? prettyStamp(next.scheduledAt) : 'n/a'}`);
}

async function main() {
  const args = new Set(process.argv.slice(2));
  banner();

  const client = await SphereClient.boot();

  // ── one-shot inspection / maintenance modes ───────────────────────────────
  if (args.has('--doctor')) {
    await client.ensureNametag();
    await reportStatus(client);
    log.info(`Connection: ${client.sphere.payments.connectionStatus?.() ?? 'n/a'}`);
    log.info('Doctor check complete. ✅');
    await client.destroy();
    process.exit(0); // one-shot modes: force exit (open sockets otherwise keep the loop alive)
  }

  if (args.has('--whoami')) {
    await reportStatus(client);
    await client.destroy();
    process.exit(0);
  }

  if (args.has('--mint')) {
    await client.ensureNametag();
    await client.mint(config.safety.selfMintAmountWhole);
    await reportStatus(client);
    await client.destroy();
    process.exit(0);
  }

  if (args.has('--preview')) {
    const { buildReport } = await import('./services/delivery.js');
    const { digest } = await buildReport(client, { label: `${prettyStamp()} · preview` });
    // Print all three renderings so the sample is easy to inspect from the CLI.
    log.info('\n───── PUBLIC TEASER ─────\n' + digest.teaser);
    log.info('\n───── FREE PREVIEW ─────\n' + digest.preview);
    const { finalizeFull } = await import('./services/delivery.js');
    const { fullText } = finalizeFull(client, digest);
    log.info('\n───── FULL (PAID) REPORT ─────\n' + fullText);
    await client.destroy();
    process.exit(0);
  }

  if (args.has('--run-now')) {
    await client.ensureNametag();
    const { State } = await import('./state.js');
    const { RateLimiter } = await import('./ratelimit.js');
    const { runScheduledDigest } = await import('./services/delivery.js');
    const state = State.load();
    const rateLimit = new RateLimiter();
    log.info('Forcing an immediate digest run (out of schedule)…');
    const summary = await runScheduledDigest(client, state, rateLimit, {
      label: `${prettyStamp()} · manual`,
      force: true,
    });
    log.info(`Manual run complete: ${JSON.stringify(summary)}`);
    await client.destroy();
    process.exit(0);
  }

  // ── default: run the autonomous agent ──────────────────────────────────────
  await client.ensureNametag();
  await client.bootstrapMintIfNeeded();
  await reportStatus(client);

  const { startAgent } = await import('./agent.js');
  const controller = new AbortController();

  let shuttingDown = false;
  const shutdown = async (signal) => {
    if (shuttingDown) return;
    shuttingDown = true;
    log.info(`Received ${signal} — shutting down gracefully…`);
    controller.abort();
    // Give the loop a moment to unwind, then close the connection.
    setTimeout(async () => {
      await client.destroy();
      process.exit(0);
    }, 500);
  };
  process.on('SIGINT', () => shutdown('SIGINT'));
  process.on('SIGTERM', () => shutdown('SIGTERM'));

  await startAgent(client, controller.signal);
  await client.destroy();
}

main().catch((err) => {
  log.error('Fatal:', err?.stack ?? err?.message ?? err);
  process.exit(1);
});
