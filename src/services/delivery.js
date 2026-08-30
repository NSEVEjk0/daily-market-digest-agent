/**
 * Daily Market Digest — publishing & delivery
 * ────────────────────────────────────────────────────────────
 * Owner / Creator: Itachi
 * Made by CRYPTFRANI
 *
 * Everything that turns a scan into something the world receives:
 *   • ensureServiceIntent — keep a standing `service` advert on the market board
 *   • buildReport         — scan → build a digest (optionally topic-personalized)
 *   • finalizeFull        — sign the digest & render the paid report body
 *   • runScheduledDigest  — a full run: broadcast the free teaser, then fan the
 *                           full report out to every active subscriber, once per slot
 *
 * Fan-out is bounded (per-run cap + shared rate limiter) and idempotent per slot,
 * so a restart mid-run never double-delivers and never floods the relay.
 *
 * The slot key does double duty and the asymmetry is deliberate: it stops a served
 * slot being served twice, AND it keeps an unserved slot owed. So a run that could
 * not read the market publishes nothing and leaves the slot unmarked, while a run
 * that published marks it before anything else can retry.
 */

import config from '../config.js';
import { createLogger } from '../logger.js';
import { scanMarket, marketPulse, scanForTopics, reachOf } from '../market.js';
import { buildDigest, signDigest, renderFull } from '../digest.js';

const log = createLogger('delivery');

function recipientOfSub(sub) {
  return sub.nametag ? `@${sub.nametag}` : sub.pubkey;
}

/**
 * Publish (or re-publish) the standing `service` intent that advertises the
 * digest on the market board. Reconciles against the server: re-posts only if
 * the previously stored intent is gone.
 */
export async function ensureServiceIntent(client, state) {
  if (!config.publish.serviceIntentEnabled) return;
  if (config.safety.dryRun) {
    log.warn(`[DRY_RUN] Would publish the @${config.nametag} service intent.`);
    return;
  }
  try {
    if (state.serviceIntentId) {
      const mine = await client.sphere.market.getMyIntents();
      const alive = mine.some((m) => m.id === state.serviceIntentId && m.status === 'active');
      if (alive) {
        log.info(`Service intent already live (${state.serviceIntentId.slice(0, 10)}…).`);
        return;
      }
    }
    const result = await client.sphere.market.postIntent({
      description: config.publish.serviceDescription,
      intentType: 'service',
      category: 'data',
      currency: config.coinSymbol,
      contactHandle: client.nametag ? `@${client.nametag}` : undefined,
      expiresInDays: config.publish.intentExpiresInDays,
    });
    state.setServiceIntentId(result.intentId);
    state.save();
    log.info(`Published service intent ${result.intentId.slice(0, 10)}… (expires ${result.expiresAt}).`);
  } catch (err) {
    log.warn(`Could not publish service intent (non-fatal): ${err?.message ?? err}`);
  }
}

/**
 * Scan the market and build a digest. With `topics`, the featured list is
 * personalized to those queries (falling back to `fallbackFeatured` if a niche
 * topic is too quiet); otherwise the configured broad seeds are swept.
 *
 * @returns {Promise<{scan:object, digest:object}>}
 */
export async function buildReport(client, { label, topics = null, fallbackFeatured = [], pulse = null } = {}) {
  let scan;
  if (topics && topics.length) {
    const p = pulse ?? (await marketPulse(client, { freshWithinDays: config.scan.freshWithinDays }));
    const { featured, seedsTried, seedsFailed } = await scanForTopics(client, topics, {
      perSeedLimit: config.scan.perSeedLimit,
      minScore: config.scan.minScore,
      fallback: fallbackFeatured,
    });
    // A personalized report is held to the same standard as the shared one: if the
    // subscriber's own topics went unanswered AND the pulse went unanswered, this
    // round is blind for them too, whatever the shared scan managed to see.
    scan = {
      pulse: p,
      featured,
      scannedAt: new Date().toISOString(),
      seeds: topics,
      reach: reachOf({ pulseOk: p.ok !== false, seedsTried, seedsFailed }),
    };
  } else {
    scan = await scanMarket(client, {
      seeds: config.scan.seedQueries,
      perSeedLimit: config.scan.perSeedLimit,
      minScore: config.scan.minScore,
      freshWithinDays: config.scan.freshWithinDays,
    });
  }

  const digest = buildDigest(scan, {
    label,
    featuredFull: config.scan.featuredFull,
    featuredFree: config.scan.featuredFree,
    coinSymbol: config.coinSymbol,
    nametag: client.nametag ?? config.nametag,
    oneTimeWhole: config.pricing.oneTimeWhole,
    perDayWhole: config.pricing.perDayWhole,
    audience: topics && topics.length ? `(personalized for: ${topics.join(', ')})` : null,
  });
  return { scan, digest };
}

/**
 * Sign a built digest and render the full paid body (with proof-of-time).
 *
 * `digest.signable` is false for a blind round, and it is passed through rather
 * than re-derived here: the decision of what may be signed belongs to the code
 * that knows what was observed, not to the code that formats the output.
 */
export function finalizeFull(client, digest) {
  const proof = signDigest(client, digest.hash, digest.generatedAt, { signable: digest.signable !== false });
  const fullText = renderFull(digest, proof);
  return { proof, fullText, signed: !!proof.signature };
}

/**
 * Fan the full report out to every active subscriber that hasn't received this
 * slot yet. Subscribers with custom topics get a personalized report (built once
 * per unique topic set and cached for the run). Bounded by maxFanoutPerRun.
 */
async function fanOutToSubscribers(client, state, rateLimit, { slot, sharedScan, sharedDigest, sharedProof, sharedFull, label }) {
  const subs = state.activeSubscribers().filter((s) => s.lastDeliveredSlot !== slot);
  if (subs.length === 0) {
    log.info('No active subscribers awaiting this slot.');
    return 0;
  }

  const cap = config.safety.maxFanoutPerRun;
  const personalizedCache = new Map(); // topicsKey -> fullText
  let delivered = 0;

  for (const sub of subs) {
    if (delivered >= cap) {
      log.warn(`Fan-out cap (${cap}) reached — remaining subscribers will get the next slot.`);
      break;
    }

    let body = sharedFull;
    const topics = Array.isArray(sub.topics) ? sub.topics.filter(Boolean) : [];
    if (topics.length) {
      const key = [...topics].map((t) => t.toLowerCase()).sort().join('|');
      if (personalizedCache.has(key)) {
        body = personalizedCache.get(key);
      } else {
        try {
          const { digest } = await buildReport(client, {
            label,
            topics,
            fallbackFeatured: sharedScan.featured,
            pulse: sharedScan.pulse,
          });
          body = finalizeFull(client, digest).fullText;
        } catch (err) {
          log.warn(`Personalized build failed for ${recipientOfSub(sub)} (using shared report): ${err?.message ?? err}`);
          body = sharedFull;
        }
        personalizedCache.set(key, body);
      }
    }

    // Subscribers have paid — deliver and record (don't gate on the hourly DM cap).
    rateLimit.record('dm');
    rateLimit.record('action');
    await client.sendDM(recipientOfSub(sub), body);
    state.markSubscriberDelivered(sub.pubkey, slot);
    delivered++;
  }

  state.save();
  log.info(`Fan-out complete: delivered to ${delivered}/${subs.length} active subscriber(s).`);
  return delivered;
}

/**
 * One full digest run for a given slot:
 *   scan → build → sign → broadcast teaser → fan out to subscribers → persist.
 * Idempotent: a slot already marked delivered is skipped unless `force` is set.
 *
 * @returns {Promise<object>} run summary
 */
export async function runScheduledDigest(client, state, rateLimit, { slot, label, force = false } = {}) {
  if (slot && !force && state.hasDeliveredSlot(slot)) {
    log.info(`Slot ${slot} already delivered — skipping.`);
    return { skipped: true, slot };
  }

  log.info(`Generating digest for ${label}${slot ? ` (slot ${slot})` : ''}…`);
  const { scan, digest } = await buildReport(client, { label });

  // A blind round publishes NOTHING and, critically, does not consume the slot.
  //
  // Marking it delivered would be the expensive mistake: the slot key is the only
  // record that this scheduled digest still owes the world a report, and once it is
  // in `deliveredSlots` it never runs again. So an outage lasting one minute would
  // cost a whole slot, silently, and `status` would show a digest that was never
  // published. Left unmarked, the next tick inside the catch-up grace window
  // retries, and the slot fires exactly once when the board answers.
  if (digest.blind) {
    log.error(
      `Slot ${slot ?? label}: the market could not be read (recent-listings feed silent, ` +
        `${scan.reach.seedsFailed}/${scan.reach.seedsTried} sweeps silent). Publishing nothing, ` +
        `signing nothing, and leaving the slot OPEN so a later tick can serve it.`,
    );
    state.setLastDigest({
      slot: slot ?? null,
      label,
      generatedAt: digest.generatedAt,
      hash: null,
      live: null,
      featured: 0,
      quiet: false,
      blind: true,
      subscribersDelivered: 0,
    });
    state.save();
    return { skipped: true, reason: 'market-unreadable', slot, blind: true };
  }

  const { proof, fullText } = finalizeFull(client, digest);

  // 1) Free public teaser on the broadcast channel.
  if (config.publish.broadcastEnabled) {
    if (rateLimit.allow('action', config.safety.maxActionsPerHour)) {
      await client.broadcast(digest.teaser);
    } else {
      log.warn('Action cap reached — skipping public broadcast this run.');
    }
  }

  // 2) Full report to every active subscriber (personalized where requested).
  const fanned = await fanOutToSubscribers(client, state, rateLimit, {
    slot: slot ?? digest.generatedAt,
    sharedScan: scan,
    sharedDigest: digest,
    sharedProof: proof,
    sharedFull: fullText,
    label,
  });

  // 3) Record run summary + mark the slot done (idempotency), then persist.
  state.setLastDigest({
    slot: slot ?? null,
    label,
    generatedAt: digest.generatedAt,
    hash: digest.hash,
    live: digest.stats.total,
    featured: digest.stats.featuredCount,
    quiet: digest.quiet,
    blind: false,
    incomplete: digest.incomplete,
    signed: !!proof.signature,
    subscribersDelivered: fanned,
  });
  if (slot) state.markSlotDelivered(slot);
  state.pruneSubscribers();
  state.save();

  log.info(
    `Digest ${label} published: ${digest.stats.total} live, ${digest.stats.featuredCount} featured, ` +
      `${fanned} subscriber(s) served${digest.quiet ? ' (quiet market)' : ''}` +
      `${digest.incomplete ? ' (incomplete sweep — said so in the report)' : ''}.`,
  );
  return {
    skipped: false,
    slot,
    fanned,
    quiet: digest.quiet,
    incomplete: digest.incomplete,
    signed: !!proof.signature,
    hash: digest.hash,
  };
}

export default { ensureServiceIntent, buildReport, finalizeFull, runScheduledDigest };
