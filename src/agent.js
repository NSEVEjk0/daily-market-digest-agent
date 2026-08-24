/**
 * Daily Market Digest — the autonomous loop
 * ────────────────────────────────────────────────────────────
 * Owner / Creator: Itachi
 * Made by CRYPTFRANI
 *
 * Ties the pieces together and keeps the agent alive:
 *   • publishes the standing market `service` advert
 *   • drains transfers that arrived while offline, then settles them
 *   • reacts to events (message:dm, transfer:incoming, payment_request:incoming)
 *   • wakes once a minute to check the schedule and, when a slot is due,
 *     generates + broadcasts the digest and fans it out to subscribers
 *
 * Everything is event-driven or slow-polled (45–90s) with awaited,
 * non-overlapping passes — no busy loops, tiny CPU/RAM footprint. The whole
 * loop unwinds cleanly when the AbortSignal fires.
 */

import config from './config.js';
import { createLogger } from './logger.js';
import { State, normalizeKey } from './state.js';
import { RateLimiter } from './ratelimit.js';
import { dueSlot, nextSlot, describeSchedule, prettyStamp } from './scheduler.js';
import { ensureServiceIntent, runScheduledDigest } from './services/delivery.js';
import { settlePayment, handleDm } from './services/commands.js';

const log = createLogger('agent');

/**
 * Run `fn` every `ms`, non-overlapping (awaits each run before scheduling the
 * next), stopping cleanly on abort. Timers are NOT unref'd — they are what keep
 * the process alive for the lifetime of the loop.
 */
function every(ms, fn, signal, label) {
  let timer = null;
  let stopped = false;
  const stop = () => {
    stopped = true;
    if (timer) clearTimeout(timer);
    timer = null;
  };
  const tick = async () => {
    if (stopped || signal.aborted) return;
    try {
      await fn();
    } catch (err) {
      log.error(`[${label}] pass error: ${err?.stack ?? err?.message ?? err}`);
    }
    if (stopped || signal.aborted) return;
    timer = setTimeout(tick, ms);
  };
  timer = setTimeout(tick, ms);
  signal.addEventListener('abort', stop, { once: true });
  return stop;
}

export async function startAgent(client, signal) {
  const state = State.load();
  const rateLimit = new RateLimiter();
  const sym = client.coin.symbol;
  const selfNorm = new Set([...client.selfPubkeys()].map(normalizeKey));

  // Effective "a slot is still owed" window: the configured catch-up grace, but
  // never tighter than a couple of ticks so normal firing is reliable.
  const graceMs = Math.max(config.schedule.catchUpGraceMin * 60_000, config.schedule.tickMs * 2);

  const next = nextSlot(config.schedule.times);
  log.info('──────────────────────────────────────────────');
  log.info(' Daily Market Digest — services starting');
  log.info(`   schedule    : ${describeSchedule(config.schedule.times)} local  (tick ${Math.round(config.schedule.tickMs / 1000)}s)`);
  log.info(`   next run    : ${next ? prettyStamp(next.scheduledAt) : 'n/a'}`);
  log.info(`   receive net : every ${Math.round(config.schedule.receivePollMs / 1000)}s (payment safety-net)`);
  log.info(`   pricing     : one-off ${config.pricing.oneTimeWhole} ${sym} · sub ${config.pricing.perDayWhole} ${sym}/day`);
  log.info(`   subscribers : ${state.activeSubscribers().length} active · pending orders: ${state.totalPendingPurchases()}`);
  log.info(`   dry-run     : ${config.safety.dryRun}`);
  log.info('──────────────────────────────────────────────');

  // ── event handlers (closures over loop state) ───────────────────────────────
  async function onTransfer(transfer) {
    if (signal.aborted || !transfer?.id) return;
    if (!state.markTransferSeen(transfer.id)) return; // relay/receive() double-delivery
    state.save();
    try {
      await settlePayment(client, { transfer, state, rateLimit });
    } catch (err) {
      log.error(`transfer handler error: ${err?.stack ?? err?.message ?? err}`);
    }
  }

  async function onDm(dm) {
    if (signal.aborted || !dm?.id) return;
    if (selfNorm.has(normalizeKey(dm.senderPubkey))) return; // never talk to ourselves
    if (!state.markDmSeen(dm.id)) return; // dedup replays
    state.save();
    try {
      await handleDm(client, { dm, state, rateLimit });
    } catch (err) {
      log.error(`dm handler error: ${err?.stack ?? err?.message ?? err}`);
    }
  }

  async function onPaymentRequest(pr) {
    if (signal.aborted || !pr?.id) return;
    const who = pr.senderNametag ? `@${pr.senderNametag}` : pr.senderPubkey;
    let amt = '?';
    try {
      amt = client.toWhole(BigInt(pr.amount ?? '0'));
    } catch {
      /* leave as ? */
    }
    log.info(`Incoming payment request from ${who} for ${amt} ${sym} — declining (earn-only policy).`);
    if (config.safety.dryRun) return;
    try {
      await client.sphere.payments.requests.decline(pr.id);
    } catch (err) {
      log.warn(`Could not decline payment request ${pr.id}: ${err?.message ?? err}`);
    }
  }

  async function drainIncoming(why) {
    try {
      const { transfers } = await client.sphere.payments.receive();
      if (transfers?.length) log.info(`receive() surfaced ${transfers.length} transfer(s) [${why}].`);
      for (const t of transfers ?? []) await onTransfer(t);
    } catch (err) {
      log.warn(`receive() failed [${why}]: ${err?.message ?? err}`);
    }
  }

  // ── schedule check (idempotent; the heart of the digest) ─────────────────────
  let digestRunning = false;
  async function checkSchedule(why) {
    if (digestRunning || signal.aborted) return;
    const slot = dueSlot(config.schedule.times, {
      graceMs,
      delivered: (key) => state.hasDeliveredSlot(key),
    });
    if (!slot) return;
    digestRunning = true;
    try {
      log.info(`Slot ${slot.key} is due [${why}] — running digest.`);
      await runScheduledDigest(client, state, rateLimit, { slot: slot.key, label: prettyStamp(slot.scheduledAt) });
    } catch (err) {
      log.error(`digest run error [${why}]: ${err?.stack ?? err?.message ?? err}`);
    } finally {
      digestRunning = false;
    }
  }

  // ── 1) publish our advert ────────────────────────────────────────────────────
  await ensureServiceIntent(client, state);

  // ── 2) settle anything that landed while we were offline ─────────────────────
  await drainIncoming('startup');

  // ── 3) subscribe to events ───────────────────────────────────────────────────
  const unsubs = [];
  try {
    unsubs.push(client.sphere.on('transfer:incoming', (t) => void onTransfer(t)));
    unsubs.push(client.sphere.on('message:dm', (dm) => void onDm(dm)));
    unsubs.push(client.sphere.on('payment_request:incoming', (pr) => void onPaymentRequest(pr)));
    log.info('Subscribed to transfer / DM / payment-request events.');
  } catch (err) {
    log.warn(`Event subscription issue: ${err?.message ?? err}`);
  }

  // ── 4) periodic passes: schedule tick + receive safety-net ───────────────────
  const stopSchedule = every(config.schedule.tickMs, () => checkSchedule('tick'), signal, 'schedule');
  const stopReceive = every(config.schedule.receivePollMs, () => drainIncoming('poll'), signal, 'receive');

  // First schedule check shortly after boot (handles a just-missed slot on restart).
  const bootCheck = setTimeout(() => void checkSchedule('startup'), 3000);

  log.info('Daily Market Digest is live. Ctrl-C to stop.');

  // ── stay alive until aborted, then unwind ────────────────────────────────────
  await new Promise((resolve) => {
    if (signal.aborted) return resolve();
    signal.addEventListener('abort', () => resolve(), { once: true });
  });

  log.info('Stopping services…');
  clearTimeout(bootCheck);
  stopSchedule();
  stopReceive();
  for (const u of unsubs) {
    try {
      u?.();
    } catch {
      /* ignore */
    }
  }
  state.save();
  log.info('Services stopped; state persisted.');
}

export default startAgent;
