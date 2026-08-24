/**
 * Daily Market Digest — DM commands + payment settlement
 * ────────────────────────────────────────────────────────────
 * Owner / Creator: Itachi
 * Made by CRYPTFRANI
 *
 * DM command grammar (case-insensitive first word):
 *   FREE : help | about | status | preview | topics [<list>|clear] | cancel
 *   PAID : digest              → full ranked report delivered now (one-off)
 *          subscribe <days>    → full report auto-DM'd every run until expiry
 *
 * Paid flow (earn-only, never trust a memo round-trip):
 *   1. request → persist a pending purchase + send a payment request.
 *   2. settle  → on an incoming UCT transfer, fulfil the requester's OLDEST
 *      pending purchase (deliver report / activate subscription), refund any
 *      overpayment. Underpayment or a fulfilment error refunds the full amount.
 */

import { randomUUID } from 'node:crypto';

import { coinIdsMatch } from '@unicitylabs/sphere-sdk';

import config from '../config.js';
import { createLogger } from '../logger.js';
import { nextSlot, describeSchedule, prettyStamp } from '../scheduler.js';
import { buildReport, finalizeFull } from './delivery.js';

const log = createLogger('commands');

const sym = () => config.coinSymbol;
const truncate = (s, n) => {
  const str = String(s ?? '').replace(/\s+/g, ' ').trim();
  return str.length > n ? `${str.slice(0, n - 1)}…` : str;
};

// Markers our own outbound messages start with — so we never react to machine
// output (our banners echoed back, or another agent's) and loop.
const OUR_MARKERS = ['🤖', '✅', '📊', '🔎', '👋', '🔏', '🔓', '🗓️', '⭐'];

function recipientOf(dm) {
  return dm.senderNametag ? `@${dm.senderNametag}` : dm.senderPubkey;
}

function underCaps(rateLimit) {
  return (
    rateLimit.peek('dm', config.safety.maxDmsPerHour) &&
    rateLimit.peek('action', config.safety.maxActionsPerHour)
  );
}
function noteSend(rateLimit) {
  rateLimit.record('dm');
  rateLimit.record('action');
}

async function replyFree(client, dm, rateLimit, body) {
  if (!underCaps(rateLimit)) {
    log.warn(`Rate cap reached — dropping free reply to ${recipientOf(dm)}.`);
    return;
  }
  noteSend(rateLimit);
  await client.sendDM(recipientOf(dm), body);
}

// ── static copy ──────────────────────────────────────────────────────────────
function helpText(client) {
  const tag = client.nametag ?? config.nametag;
  const { oneTimeWhole, perDayWhole } = config.pricing;
  return [
    `🤖 @${tag} — the Daily Market Digest (by ${config.brand}, owner ${config.owner})`,
    ``,
    `I scan the Unicity market ${config.schedule.times.length}× a day and publish a ranked digest`,
    `of the most interesting live intents. A free teaser is broadcast publicly each run.`,
    ``,
    `FREE commands:`,
    `  help              this message`,
    `  about             who I am & how I work`,
    `  status            schedule, last digest & your subscription`,
    `  preview           a free sample of the current market`,
    `  topics <list>     set your personalized topics (e.g. \`topics rust, design\`)`,
    `  topics clear      remove your personalized topics`,
    `  cancel            cancel your subscription`,
    ``,
    `PAID commands (settled in ${sym()}):`,
    `  digest            the full ranked report, delivered now — ${oneTimeWhole} ${sym()}`,
    `  subscribe <days>  full report every run until expiry — ${perDayWhole} ${sym()}/day`,
    ``,
    `How paying works: I reply with a payment request — pay it and your report`,
    `returns automatically. Overpayment is auto-refunded. I never send funds except refunds.`,
    `— ${config.brand}`,
  ].join('\n');
}

function aboutText(client) {
  const tag = client.nametag ?? config.nametag;
  return [
    `🤖 @${tag} is an autonomous market-intelligence agent on Unicity testnet2.`,
    `Owner / creator: ${config.owner}. Made by ${config.brand}.`,
    ``,
    `Every run I fuse the public listings feed (market pulse) with ranked semantic`,
    `search (contactable intents) into one clear digest. A free teaser goes out on`,
    `the public broadcast channel; the full report — contacts, prices, relevance,`,
    `plus a signed proof-of-time — goes to buyers and subscribers.`,
    ``,
    `Policy: EARN-ONLY. I only ever request/receive ${sym()}; the sole outbound`,
    `payment I make is refunding an overpayment. Every unit earned accrues to this`,
    `single wallet, owned by ${config.owner} under the ${config.brand} banner.`,
    ``,
    `Schedule: ${describeSchedule(config.schedule.times)} (local). Reply \`help\` for commands. — ${config.brand}`,
  ].join('\n');
}

function statusText(client, state, dm) {
  const tag = client.nametag ?? config.nametag;
  const last = state.lastDigest;
  const next = nextSlot(config.schedule.times);
  const sub = state.getSubscriber(dm.senderPubkey);
  const now = Date.now();

  const lines = [
    `📊 @${tag} status — by ${config.brand}`,
    `Schedule : ${describeSchedule(config.schedule.times)} (local)`,
    `Next run : ${next ? prettyStamp(next.scheduledAt) : 'n/a'}`,
  ];
  if (last) {
    lines.push(
      `Last run : ${last.label} — ${last.live} live listings, ${last.featured} featured${last.quiet ? ' (quiet market)' : ''}`,
    );
  } else {
    lines.push(`Last run : none yet this session`);
  }
  lines.push(``);
  if (sub && sub.expiresAt > now) {
    const daysLeft = Math.max(0, Math.ceil((sub.expiresAt - now) / 86_400_000));
    lines.push(`Your subscription: ACTIVE — ~${daysLeft} day(s) left (until ${new Date(sub.expiresAt).toISOString().slice(0, 10)}).`);
  } else {
    lines.push(`Your subscription: none active. \`subscribe <days>\` at ${config.pricing.perDayWhole} ${sym()}/day.`);
  }
  const topics = sub?.topics ?? [];
  lines.push(`Your topics: ${topics.length ? topics.join(', ') : '(none — you get the general digest)'}`);
  lines.push(`— ${config.brand}`);
  return lines.join('\n');
}

// ── topics management (free) ─────────────────────────────────────────────────
async function handleTopics(client, dm, state, rateLimit, arg) {
  const tag = recipientOf(dm);
  if (!arg) {
    const sub = state.getSubscriber(dm.senderPubkey);
    const topics = sub?.topics ?? [];
    return replyFree(
      client,
      dm,
      rateLimit,
      topics.length
        ? `⭐ Your topics: ${topics.join(', ')}.\nChange with \`topics a, b, c\` or remove with \`topics clear\`. — ${config.brand}`
        : `⭐ You have no personalized topics set. Set them with \`topics rust, design, gpu\` — your digests will focus there. — ${config.brand}`,
    );
  }
  if (/^(clear|none|off|reset)$/i.test(arg.trim())) {
    state.setSubscriberTopics(dm.senderPubkey, [], dm.senderNametag ?? undefined);
    state.save();
    return replyFree(client, dm, rateLimit, `⭐ Topics cleared — you'll get the general digest. — ${config.brand}`);
  }
  const topics = arg
    .split(',')
    .map((s) => s.trim())
    .filter(Boolean)
    .slice(0, 8);
  if (topics.length === 0) {
    return replyFree(client, dm, rateLimit, `Usage: \`topics rust, design, gpu\` (up to 8). — ${config.brand}`);
  }
  state.setSubscriberTopics(dm.senderPubkey, topics, dm.senderNametag ?? undefined);
  state.save();
  log.info(`${tag} set topics: ${topics.join(', ')}`);
  return replyFree(
    client,
    dm,
    rateLimit,
    `⭐ Topics set: ${topics.join(', ')}.\nYour \`digest\`/subscription reports will focus on these. — ${config.brand}`,
  );
}

async function handleCancel(client, dm, state, rateLimit) {
  const cancelled = state.cancelSubscription(dm.senderPubkey);
  state.save();
  return replyFree(
    client,
    dm,
    rateLimit,
    cancelled
      ? `✅ Your subscription is cancelled. You can \`subscribe <days>\` again any time. — ${config.brand}`
      : `You have no active subscription. — ${config.brand}`,
  );
}

// ── preview (free sample) ─────────────────────────────────────────────────────
async function handlePreview(client, dm, state, rateLimit) {
  if (!underCaps(rateLimit)) {
    log.warn(`Rate cap reached — dropping preview to ${recipientOf(dm)}.`);
    return;
  }
  const sub = state.getSubscriber(dm.senderPubkey);
  const topics = sub?.topics ?? null;
  try {
    const { digest } = await buildReport(client, { label: `${prettyStamp()} · preview`, topics });
    noteSend(rateLimit);
    await client.sendDM(recipientOf(dm), digest.preview);
  } catch (err) {
    log.warn(`preview build failed for ${recipientOf(dm)}: ${err?.message ?? err}`);
    await replyFree(client, dm, rateLimit, `Couldn't build a preview just now — please try again shortly. — ${config.brand}`);
  }
}

// ── paid purchase creation ────────────────────────────────────────────────────
async function createPurchase(client, dm, state, rateLimit, { kind, days }) {
  const recipient = recipientOf(dm);
  const priceWhole = kind === 'subscribe' ? config.pricing.perDayWhole * days : config.pricing.oneTimeWhole;

  if (config.safety.dryRun) {
    await replyFree(client, dm, rateLimit, `[DRY_RUN] Would request ${priceWhole} ${sym()} for \`${kind}\`. — ${config.brand}`);
    return;
  }
  if (!rateLimit.allow('action', config.safety.maxActionsPerHour)) {
    log.warn(`Action cap reached — not creating a ${kind} purchase for ${recipient} right now.`);
    return;
  }

  const id = randomUUID();
  const purchase = {
    id,
    kind, // 'one-time' | 'subscribe'
    days: kind === 'subscribe' ? days : 0,
    priceBase: client.toBase(priceWhole).toString(),
    createdAt: Date.now(),
    requesterNametag: dm.senderNametag ?? null,
  };
  state.addPendingPurchase(dm.senderPubkey, purchase);
  state.save();

  const memo = kind === 'subscribe' ? `digest:sub${days}:${id.slice(0, 6)}` : `digest:one:${id.slice(0, 6)}`;
  await client.requestPayment(recipient, priceWhole, memo);

  const detail =
    kind === 'subscribe'
      ? `a ${days}-day subscription (${config.pricing.perDayWhole} ${sym()}/day = ${priceWhole} ${sym()})`
      : `the full digest now (${priceWhole} ${sym()})`;
  noteSend(rateLimit);
  await client.sendDM(
    recipient,
    [
      `🤖 Got it — ${detail}.`,
      `I've sent you a payment request (check your wallet). Pay it and your report`,
      `returns here automatically. Overpayment is refunded; I never hold your funds.`,
      `— ${config.brand}`,
    ].join('\n'),
  );
  log.info(`Created ${kind} purchase ${id.slice(0, 8)} for ${recipient} (${priceWhole} ${sym()}); payment requested.`);
}

// ── settlement ─────────────────────────────────────────────────────────────────
/** Sum the UCT value (base units) of an incoming transfer. */
function uctAmount(client, transfer) {
  return (transfer.tokens ?? [])
    .filter((t) => coinIdsMatch(t.coinId, client.coin.coinId))
    .reduce((acc, t) => acc + BigInt(t.amount ?? '0'), 0n);
}

async function fulfillOneTime(client, state, sender, senderNametag) {
  const sub = state.getSubscriber(sender);
  const topics = sub?.topics ?? null;
  const { digest } = await buildReport(client, { label: `${prettyStamp()} · on-demand`, topics });
  return finalizeFull(client, digest).fullText;
}

async function fulfillSubscribe(client, state, sender, senderNametag, days) {
  const rec = state.upsertSubscriber(sender, { nametag: senderNametag ?? undefined, addDays: days });
  const daysLeft = Math.max(0, Math.ceil((rec.expiresAt - Date.now()) / 86_400_000));
  // Bonus: deliver the current report immediately on activation.
  const topics = rec.topics?.length ? rec.topics : null;
  const { digest } = await buildReport(client, { label: `${prettyStamp()} · subscription start`, topics });
  const body = finalizeFull(client, digest).fullText;
  const header =
    `✅ Subscription active — ~${daysLeft} day(s), full report every run (${describeSchedule(config.schedule.times)} local).\n` +
    `Here's your first report now:\n\n`;
  return header + body;
}

/**
 * Settle an incoming transfer against the sender's pending purchases.
 * Fulfils the OLDEST purchase if paid in full; refunds under/overpayment.
 */
export async function settlePayment(client, { transfer, state, rateLimit }) {
  const amountBase = uctAmount(client, transfer);
  if (amountBase <= 0n) return;

  const sender = transfer.senderPubkey;
  const recipient = transfer.senderNametag ? `@${transfer.senderNametag}` : sender;
  const purchase = state.takeOldestPurchase(sender);

  // No pending purchase → unsolicited payment. Earn-only: keep it, thank politely.
  if (!purchase) {
    log.info(`Received ${client.toWhole(amountBase)} ${sym()} from ${recipient} with no pending order — treating as a tip.`);
    noteSend(rateLimit);
    await client.sendDM(
      recipient,
      `Thanks for the ${client.toWhole(amountBase)} ${sym()}! No order was pending, so I'm keeping it as a tip to ${config.brand}. Reply \`help\` to put me to work. — ${config.brand}`,
    );
    return;
  }

  const priceBase = BigInt(purchase.priceBase);
  const kindLabel = purchase.kind === 'subscribe' ? `${purchase.days}-day subscription` : 'full digest';

  // Underpaid → refund everything, invite a retry.
  if (amountBase < priceBase) {
    log.warn(`Underpaid ${purchase.kind} from ${recipient}: ${client.toWhole(amountBase)} < ${client.toWhole(priceBase)} ${sym()}. Refunding.`);
    await client.refund(sender, amountBase, `${config.nametag} refund — insufficient for ${purchase.kind}`);
    noteSend(rateLimit);
    await client.sendDM(
      recipient,
      `That was ${client.toWhole(amountBase)} ${sym()}, but the ${kindLabel} costs ${client.toWhole(priceBase)} ${sym()}. I've refunded it — send the full amount to retry. — ${config.brand}`,
    );
    return;
  }

  // Paid in full → fulfil.
  let resultBody;
  try {
    resultBody =
      purchase.kind === 'subscribe'
        ? await fulfillSubscribe(client, state, sender, transfer.senderNametag, purchase.days)
        : await fulfillOneTime(client, state, sender, transfer.senderNametag);
  } catch (err) {
    log.error(`Fulfilment of ${purchase.kind} failed: ${err?.message ?? err}. Refunding.`);
    await client.refund(sender, amountBase, `${config.nametag} refund — fulfilment failed`);
    noteSend(rateLimit);
    await client.sendDM(
      recipient,
      `Sorry — I hit an error fulfilling your ${kindLabel} and have refunded ${client.toWhole(amountBase)} ${sym()}. Please try again. — ${config.brand}`,
    );
    return;
  }

  // Deliver the paid result (bypasses the hourly DM cap — the requester paid).
  noteSend(rateLimit);
  await client.sendDM(recipient, resultBody);
  state.save();
  log.info(`Fulfilled ${purchase.kind} (${purchase.id.slice(0, 8)}) for ${recipient}.`);

  // Refund any overpayment (the one autonomous outbound payment we allow).
  const over = amountBase - priceBase;
  if (over > 0n) {
    await client.refund(sender, over, `${config.nametag} overpayment refund`);
  }
}

// ── DM dispatch ──────────────────────────────────────────────────────────────
/**
 * Parse and act on one incoming DM. Callers must already have de-duplicated the
 * message id and confirmed it is not from ourselves.
 */
export async function handleDm(client, { dm, state, rateLimit }) {
  const raw = String(dm.content ?? '').trim();
  if (!raw) return;

  if (OUR_MARKERS.some((m) => raw.startsWith(m))) {
    log.debug(`Ignoring machine-formatted DM from ${recipientOf(dm)}.`);
    return;
  }

  const [cmdRaw] = raw.split(/\s+/, 1);
  const cmd = cmdRaw.toLowerCase();
  const arg = raw.slice(cmdRaw.length).trim();

  log.info(`DM from ${recipientOf(dm)}: ${truncate(raw, 60)}`);

  switch (cmd) {
    case 'help':
    case 'commands':
    case 'menu':
    case '?':
      return replyFree(client, dm, rateLimit, helpText(client));

    case 'about':
    case 'who':
    case 'info':
      return replyFree(client, dm, rateLimit, aboutText(client));

    case 'status':
    case 'stat':
      return replyFree(client, dm, rateLimit, statusText(client, state, dm));

    case 'preview':
    case 'sample':
    case 'teaser':
      return handlePreview(client, dm, state, rateLimit);

    case 'topics':
    case 'topic':
      return handleTopics(client, dm, state, rateLimit, arg);

    case 'cancel':
    case 'unsubscribe':
    case 'stop':
      return handleCancel(client, dm, state, rateLimit);

    case 'digest':
    case 'buy':
    case 'full':
      return createPurchase(client, dm, state, rateLimit, { kind: 'one-time' });

    case 'subscribe':
    case 'sub': {
      const days = Number.parseInt(arg, 10);
      if (!Number.isFinite(days) || days < 1) {
        return replyFree(
          client,
          dm,
          rateLimit,
          `Usage: \`subscribe <days>\` — e.g. \`subscribe 7\` for a week at ${config.pricing.perDayWhole} ${sym()}/day. — ${config.brand}`,
        );
      }
      const clamped = Math.min(days, config.pricing.maxSubDays);
      if (clamped !== days) {
        await replyFree(client, dm, rateLimit, `Max subscription is ${config.pricing.maxSubDays} days — I'll set up ${clamped}. — ${config.brand}`);
      }
      return createPurchase(client, dm, state, rateLimit, { kind: 'subscribe', days: clamped });
    }

    default:
      return replyFree(
        client,
        dm,
        rateLimit,
        `Not sure what "${truncate(cmd, 20)}" means. Reply \`help\` for what I can do. — ${config.brand}`,
      );
  }
}

export default { handleDm, settlePayment };
