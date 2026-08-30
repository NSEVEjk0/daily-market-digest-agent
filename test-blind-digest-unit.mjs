/**
 * test-blind-digest-unit.mjs -- offline proof that this agent never signs a claim
 * about a market it could not see, and never spends a scheduled slot on one.
 *
 * The product here is not text. It is a secp256k1 signature over
 * `market-digest\n<iso>\n<sha256(report)>`: a portable, timestamped assertion that
 * the Unicity board looked like THIS at THAT moment. Which makes one SDK behaviour
 * load-bearing in a way it is not for any sibling agent:
 *
 *   `market.getRecentListings()` and `market.search()` both fail SOFT. An empty
 *   answer and no answer at all are the same value at the call site.
 *
 * Read the silence as data and the agent publishes "The market is quiet right now
 * -- no live intents surfaced this round", signs it, timestamps it, broadcasts it
 * publicly, and sells it for 5 UCT. Every word of that is false while the market-api
 * is down, and unlike an ordinary bug it is false in a form the recipient is
 * invited to treat as evidence. This was not hypothetical: the market-api was
 * returning HTTP 000 fleet-wide while this suite was written.
 *
 * The fix is one rule, in `market.reachOf()`: every read reports whether it was
 * ANSWERED separately from what it FOUND, and three states come out of that --
 *
 *   QUIET    the board answered and had nothing on it        -> publish, sign, sell
 *   PARTIAL  some sweeps answered, some did not              -> publish, but say so
 *   BLIND    nothing answered                                -> publish nothing
 *
 * Sections:
 *   [1]  the rule itself: what makes a round blind, and what does not
 *   [2]  an unreachable listings feed is not an empty board
 *   [3]  an unreachable sweep is not a sweep that found nothing
 *   [4]  scanMarket's verdict over the two reads
 *   [5]  a blind round is never rendered as "quiet" -- and a quiet one still is
 *   [6]  the proof-of-time format is frozen, and a blind round is refused a signature
 *   [7]  a missing proof is stated, never silently omitted
 *   [8]  THE SLOT IS NOT SPENT: a blind run publishes nothing and stays owed
 *   [9]  a subscriber's slot is not spent either, and never double-served
 *   [10] a buyer is refunded in full rather than sold an admission
 *   [11] the schedule is pure: stable keys, a bounded catch-up window, no clock
 *
 * Everything below is offline. The market is a stub, the wallet is a stub, no
 * socket is opened and no UCT exists.
 *
 * Run: node test-blind-digest-unit.mjs
 */

import { mkdtempSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { createHash, randomUUID } from 'node:crypto';

const tmp = mkdtempSync(join(tmpdir(), 'market-digest-blind-'));
process.env.ENV_FILE = join(tmp, 'no-such.env'); // config falls back to defaults
process.env.WALLET_DIR = tmp;                    // state.json lives here
process.env.LOG_LEVEL = 'error';

const market = await import('./src/market.js');
const digestMod = await import('./src/digest.js');
const { buildDigest, signDigest, renderFull } = digestMod;
const PROOF_PREFIX = digestMod.default.PROOF_PREFIX;
const delivery = await import('./src/services/delivery.js');
const { settlePayment } = await import('./src/services/commands.js');
const { dueSlot, slotKey, nextSlot } = await import('./src/scheduler.js');
const { State } = await import('./src/state.js');
const { RateLimiter } = await import('./src/ratelimit.js');
const { default: config } = await import('./src/config.js');

const D = 10n ** 18n;
const base = (whole) => (BigInt(Math.round(Number(whole) * 1000)) * D) / 1000n;
const toWhole = (b) => {
  const v = BigInt(b);
  const f = (v % D).toString().padStart(18, '0').replace(/0+$/, '');
  return f ? `${v / D}.${f}` : `${v / D}`;
};

let passed = 0;
let failed = 0;
const ok = (cond, msg, got) => {
  if (cond) {
    passed++;
    console.log(`  PASS  ${msg}`);
  } else {
    failed++;
    console.log(`  FAIL  ${msg}${got !== undefined ? ` -- got ${got}` : ''}`);
  }
};

const DESK_KEY = `02${'de5c'.repeat(16)}`;
const BUYER = `02${'bb'.repeat(32)}`;
const SUBSCRIBER = `02${'55'.repeat(32)}`;

/** One plausible live listing, and one contactable search hit. */
const listing = (over = {}) => ({
  id: `l-${Math.random().toString(16).slice(2, 8)}`,
  title: 'GPU hours, hourly billing',
  type: 'offer',
  agentName: 'someone-else',
  agentId: `02${'11'.repeat(32)}`,
  createdAt: new Date(Date.now() - 3_600_000).toISOString(),
  ...over,
});
const hit = (over = {}) => ({
  id: `i-${Math.random().toString(16).slice(2, 8)}`,
  score: 0.61,
  agentNametag: '@vendor',
  agentPublicKey: `02${'22'.repeat(32)}`,
  description: 'escrow service for testnet2 swaps, 1% fee',
  intentType: 'service',
  category: 'finance',
  price: 1,
  currency: 'UCT',
  contactHandle: '@vendor',
  createdAt: new Date(Date.now() - 7_200_000).toISOString(),
  expiresAt: new Date(Date.now() + 86_400_000).toISOString(),
  ...over,
});

/**
 * A fake client over a market whose reachability is a knob.
 *
 *   feed: 'ok' | 'down' | 'garbage'   what getRecentListings() does
 *   sweeps: 'ok' | 'down'             what search() does
 *
 * 'down' THROWS -- which is what an unreachable market-api actually does through
 * the SDK -- and market.js swallows it, which is exactly the behaviour under test.
 */
function fakeClient({ feed = 'ok', sweeps = 'ok', listings = 3, hits = 2 } = {}) {
  const c = {
    nametag: 'market-digest',
    coin: { coinId: 'uct-coin-id', symbol: 'UCT', decimals: 18 },
    identity: { chainPubkey: DESK_KEY },
    toBase: base,
    toWhole,
    broadcasts: [],
    dms: [],
    refunds: [],
    refundResult: { status: 'ok' },
    selfPubkeys() {
      return new Set([DESK_KEY]);
    },
    signMessage: (msg) => createHash('sha256').update(`${DESK_KEY} ${msg}`).digest('hex'),
    verify: (msg, sig) => createHash('sha256').update(`${DESK_KEY} ${msg}`).digest('hex') === sig,
    sphere: {
      market: {
        async getRecentListings() {
          if (feed === 'down') throw new Error('fetch failed');
          if (feed === 'garbage') return { oops: true }; // not an array
          return Array.from({ length: listings }, () => listing());
        },
        async search() {
          if (sweeps === 'down') throw new Error('fetch failed');
          return { intents: Array.from({ length: hits }, () => hit()) };
        },
        async getMyIntents() {
          return [];
        },
        async postIntent() {
          return { intentId: 'intent-1', expiresAt: 'never' };
        },
      },
    },
    async broadcast(text) {
      this.broadcasts.push(text);
    },
    async sendDM(recipient, content) {
      this.dms.push({ recipient, content });
      return { id: `dm-${this.dms.length}` };
    },
    async refund(recipient, b, memo) {
      this.refunds.push({ recipient, base: BigInt(b).toString(), memo });
      return this.refundResult;
    },
    async requestPayment() {
      return { success: true, requestId: 'req-1' };
    },
    reach: { setFeed: (v) => (feed = v), setSweeps: (v) => (sweeps = v) },
  };
  return c;
}

const freshState = () => {
  const s = State.load();
  s.data = { ...s.data, deliveredSlots: [], pendingPurchases: {}, subscribers: {}, lastDigest: null };
  s.save = () => {};
  return s;
};

console.log('======== @market-digest | blind-scan unit proof (offline) ========');

// [1] the rule: blind means NOTHING answered, not "nothing was found"
console.log('\n[1] reachOf -- what makes a round blind, and what does not');
{
  const { reachOf } = market;
  const allDown = reachOf({ pulseOk: false, seedsTried: 10, seedsFailed: 10 });
  ok(allDown.blind === true, 'feed silent and every sweep silent -> BLIND');
  ok(allDown.partial === false, 'a blind round is not merely partial -- there is nothing to be partial about');
  ok(allDown.seedsOk === 0, 'and no sweep is counted as having answered');

  const oneSweep = reachOf({ pulseOk: false, seedsTried: 10, seedsFailed: 9 });
  ok(oneSweep.blind === false, 'ONE sweep answering is enough to have seen the market');
  ok(oneSweep.partial === true, 'but the round is flagged partial, so the report can say so');

  const feedOnly = reachOf({ pulseOk: true, seedsTried: 10, seedsFailed: 10 });
  ok(feedOnly.blind === false, 'the listings feed answering is likewise enough');
  ok(feedOnly.partial === true, 'and is likewise flagged');

  const clean = reachOf({ pulseOk: true, seedsTried: 10, seedsFailed: 0 });
  ok(clean.blind === false && clean.partial === false, 'everything answered -> neither blind nor partial');

  // The case that matters most, and the one a naive implementation gets wrong:
  // a REACHABLE market with nothing listed on it. There is nothing in the return
  // value about how much was found, because "how much" is not a reachability fact.
  const empty = reachOf({ pulseOk: true, seedsTried: 10, seedsFailed: 0 });
  ok(empty.blind === false, 'an empty but reachable board is NOT blind -- quiet is a real observation');
  ok(
    !('total' in empty) && !('hits' in empty),
    'reachability is computed from who answered, never from how much they returned',
  );

  // No sweeps configured at all: the feed is then the only witness.
  ok(reachOf({ pulseOk: true, seedsTried: 0, seedsFailed: 0 }).blind === false, 'no seeds + live feed -> sighted');
  ok(reachOf({ pulseOk: false, seedsTried: 0, seedsFailed: 0 }).blind === true, 'no seeds + dead feed -> blind');
}

// [2] the listings feed reports whether it answered
console.log('\n[2] marketPulse separates "answered" from "found something"');
{
  const live = await market.marketPulse(fakeClient({ listings: 4 }), { freshWithinDays: 3 });
  ok(live.ok === true, 'a reachable feed reports ok:true');
  ok(live.total === 4, 'with the count it actually saw', live.total);

  const down = await market.marketPulse(fakeClient({ feed: 'down' }), { freshWithinDays: 3 });
  ok(down.ok === false, 'a THROWING feed reports ok:false rather than propagating');
  ok(down.total === 0, 'its total is 0 -- which is exactly why ok is needed to tell them apart');

  const garbage = await market.marketPulse(fakeClient({ feed: 'garbage' }), { freshWithinDays: 3 });
  ok(garbage.ok === false, 'a feed returning a non-array is treated as not having answered');

  const emptyBoard = await market.marketPulse(fakeClient({ listings: 0 }), { freshWithinDays: 3 });
  ok(emptyBoard.ok === true && emptyBoard.total === 0, 'a reachable EMPTY board: ok:true, total 0');
  ok(
    down.total === emptyBoard.total && down.ok !== emptyBoard.ok,
    'the outage and the empty board are indistinguishable by total, and distinguishable ONLY by ok',
  );
}

// [3] a sweep reports the same way
console.log('\n[3] searchSupply separates a failed sweep from a fruitless one');
{
  const found = await market.searchSupply(fakeClient({ hits: 2 }), 'escrow', { limit: 40 });
  ok(found.ok === true && found.hits.length === 2, 'a sweep that answered with hits');

  const fruitless = await market.searchSupply(fakeClient({ hits: 0 }), 'escrow', { limit: 40 });
  ok(fruitless.ok === true && fruitless.hits.length === 0, 'a sweep that answered with nothing is still an answer');

  const dead = await market.searchSupply(fakeClient({ sweeps: 'down' }), 'escrow', { limit: 40 });
  ok(dead.ok === false, 'a sweep that threw did not answer');
  ok(Array.isArray(dead.hits) && dead.hits.length === 0, 'and yields an empty array, so callers never crash');
}

// [4] the scan carries the verdict
console.log('\n[4] scanMarket attaches the reachability verdict to the round');
{
  const opts = { seeds: ['escrow', 'gpu'], perSeedLimit: 40, minScore: 0.25, freshWithinDays: 3 };
  const sighted = await market.scanMarket(fakeClient(), opts);
  ok(sighted.reach.blind === false, 'a healthy scan is not blind');
  ok(sighted.reach.seedsTried === 2 && sighted.reach.seedsFailed === 0, 'and counts its sweeps');

  const halfDown = await market.scanMarket(fakeClient({ feed: 'down' }), opts);
  ok(halfDown.reach.blind === false, 'feed down but sweeps alive -> still sighted');
  ok(halfDown.reach.partial === true, 'flagged partial');

  const blackout = await market.scanMarket(fakeClient({ feed: 'down', sweeps: 'down' }), opts);
  ok(blackout.reach.blind === true, 'total blackout -> blind');
  ok(blackout.pulse.total === 0 && blackout.featured.length === 0, 'and it looks EXACTLY like a quiet market by the numbers');
  ok(
    blackout.reach.seedsFailed === blackout.reach.seedsTried,
    'every sweep is accounted for as failed, not silently dropped',
  );

  const quietBoard = await market.scanMarket(fakeClient({ listings: 0, hits: 0 }), opts);
  ok(quietBoard.reach.blind === false, 'a genuinely quiet market is sighted');
  ok(
    quietBoard.pulse.total === blackout.pulse.total && quietBoard.reach.blind !== blackout.reach.blind,
    'the two rounds carry identical figures and opposite verdicts -- the whole point of the rule',
  );
}

/** Build a full report through the real delivery path, so config wiring is exercised. */
const report = (client, label = 'Aug 30, 20:00') => delivery.buildReport(client, { label });

// [5] the rendered report never calls an unread market a quiet one
console.log('\n[5] a blind round is rendered as unread; a quiet one is still rendered as quiet');
{
  const { digest: blind } = await report(fakeClient({ feed: 'down', sweeps: 'down' }));
  ok(blind.blind === true, 'the blind flag reaches the digest');
  ok(blind.quiet === false, 'and it is NOT marked quiet -- this is the assertion the bug failed');
  ok(blind.signable === false, 'the round is marked unsignable at the point where what-was-seen is known');
  ok(blind.hash && blind.hash.length === 64, 'a content hash still exists (the page is real text)', blind.hash?.length);

  for (const [where, text] of [['teaser', blind.teaser], ['preview', blind.preview], ['body', blind.fullCore]]) {
    ok(/could not (be )?read|did not answer/i.test(text), `the ${where} says the market could not be read`);
    ok(
      !/market is quiet right now/i.test(text),
      `the ${where} never makes the claim "the market is quiet right now"`,
    );
    ok(!/no live intents surfaced/i.test(text), `the ${where} does not report zero intents as a finding`);
  }
  // The word does appear in the blind body -- inside the sentence that REFUSES the
  // claim. That is the difference between reporting quiet and declining to.
  ok(
    /would be a claim I cannot support/.test(blind.fullCore),
    'the body names the claim it is refusing to make, rather than just omitting it',
  );
  ok(/NO PROOF|NO proof-of-time/i.test(blind.fullCore), 'the body states there is no proof-of-time, on purpose');
  ok(blind.stats.featuredCount === 0, 'nothing is featured out of a round that saw nothing');

  const { digest: quiet } = await report(fakeClient({ listings: 0, hits: 0 }));
  ok(quiet.blind === false, 'a reachable empty board is not blind');
  ok(quiet.quiet === true, 'it IS quiet -- the honest version of the same numbers');
  ok(quiet.signable !== false, 'and it is signable: "the board was empty" is an observation worth certifying');
  ok(/quiet/i.test(quiet.teaser), 'and it says quiet, which is what a subscriber is owed');

  const { digest: partial } = await report(fakeClient({ feed: 'down' }));
  ok(partial.blind === false && partial.incomplete === true, 'one dead read of two -> published, flagged incomplete');
  ok(partial.signable !== false, 'a partial round is still signable -- it is signing what it saw');
  ok(/incomplete/i.test(partial.fullCore), 'and the body admits the ranking is not the whole board');

  const { digest: live } = await report(fakeClient());
  ok(live.blind === false && live.quiet === false && live.incomplete === false, 'a healthy round is none of the three');
}

// [6] the proof-of-time format is frozen, and a blind round cannot get one
console.log('\n[6] the signed message is exactly market-digest\\n<iso>\\n<sha256>');
{
  const client = fakeClient();
  const { digest } = await report(client);
  const proof = signDigest(client, digest.hash, digest.generatedAt);
  ok(proof.message === `market-digest\n${digest.generatedAt}\n${digest.hash}`, 'the format is pinned -- reorder it and every proof in the wild dies');
  ok(proof.message.split('\n').length === 3, 'three lines, no more');
  ok(proof.signature && client.verify(proof.message, proof.signature), 'and it verifies against the signer key');
  ok(proof.signerPubkey === DESK_KEY, 'the proof names the key to check it against');
  ok(digest.hash === createHash('sha256').update(digest.fullCore).digest('hex'), 'the hash covers the exact paid body');
  ok(
    !client.verify(`market-digest\n${digest.generatedAt}\n${'0'.repeat(64)}`, proof.signature),
    'swap the hash and the signature stops verifying -- the proof binds the report',
  );

  const refused = signDigest(client, digest.hash, digest.generatedAt, { signable: false });
  ok(refused.signature === null, 'an unsignable round gets NO signature');
  ok(/could not be read/i.test(refused.unsignedBecause ?? ''), 'and a stated reason', refused.unsignedBecause);

  const brokenSigner = { ...client, signMessage: () => { throw new Error('wallet locked'); } };
  const failed = signDigest(brokenSigner, digest.hash, digest.generatedAt);
  ok(failed.signature === null, 'a signer that throws does not take the report down with it');
  ok(/signer did not answer/i.test(failed.unsignedBecause ?? ''), 'and that reason is distinct from the blind one');
}

// [7] a missing proof is announced, never silently omitted
console.log('\n[7] renderFull never lets a report look signed when it is not');
{
  const client = fakeClient();
  const { digest } = await report(client);
  const signed = renderFull(digest, signDigest(client, digest.hash, digest.generatedAt));
  ok(/PROOF OF TIME \(verifiable\)/.test(signed), 'a signed report carries the proof block');
  ok(/verifySignedMessage/.test(signed), 'and the exact call that checks it');

  const unsigned = renderFull(digest, signDigest({ ...client, signMessage: () => { throw new Error('x'); } }, digest.hash, digest.generatedAt));
  ok(/PROOF OF TIME — UNAVAILABLE/.test(unsigned), 'an unsigned SIGHTED report says the proof is unavailable');
  ok(/not evidence/i.test(unsigned), 'and warns that an unsigned report is not evidence');
  ok(!/Signature: /.test(unsigned), 'and carries no signature line');

  const { digest: b } = await report(fakeClient({ feed: 'down', sweeps: 'down' }));
  const blindText = renderFull(b, signDigest(client, b.hash, b.generatedAt, { signable: false }));
  ok(!/PROOF OF TIME — UNAVAILABLE/.test(blindText), 'a blind page does not need the notice -- its body is already the notice');
  ok(!/Signature: /.test(blindText), 'and it certainly carries no signature');
  ok(blindText === b.fullCore, 'the blind body is delivered exactly as built');
}

// [8] the slot survives the outage
console.log('\n[8] a blind run publishes nothing and does NOT spend the slot');
{
  const client = fakeClient({ feed: 'down', sweeps: 'down' });
  const state = freshState();
  const rl = new RateLimiter();
  const slot = '2026-08-30@20:00';

  const out = await delivery.runScheduledDigest(client, state, rl, { slot, label: 'Aug 30, 20:00' });
  ok(out.skipped === true, 'the run reports itself skipped');
  ok(out.reason === 'market-unreadable', 'with the reason named, not swallowed', out.reason);
  ok(out.blind === true, 'and flagged blind for the caller');
  ok(client.broadcasts.length === 0, 'NOTHING was broadcast to the public channel');
  ok(client.dms.length === 0, 'and no subscriber was DMed');
  ok(
    state.hasDeliveredSlot(slot) === false,
    'THE SLOT IS STILL OWED -- marking it delivered would silently cost the whole slot',
  );
  ok(state.data.lastDigest?.blind === true, 'the run is recorded as blind, so `status` can say so');
  ok(state.data.lastDigest?.hash === null, 'with no hash, because nothing was signed');

  // The board comes back inside the catch-up window. The same slot must now fire.
  client.reach.setFeed('ok');
  client.reach.setSweeps('ok');
  const retry = await delivery.runScheduledDigest(client, state, rl, { slot, label: 'Aug 30, 20:00' });
  ok(retry.skipped === false, 'the retry publishes');
  ok(retry.signed === true, 'and signs, now that there is something real to sign');
  ok(client.broadcasts.length === 1, 'exactly one teaser went out', client.broadcasts.length);
  ok(state.hasDeliveredSlot(slot) === true, 'and NOW the slot is spent');

  // Exactly once. Not twice.
  const third = await delivery.runScheduledDigest(client, state, rl, { slot, label: 'Aug 30, 20:00' });
  ok(third.skipped === true && third.reason === undefined, 'a third tick is skipped as already-delivered');
  ok(client.broadcasts.length === 1, 'and publishes nothing further -- the slot fires exactly once');
}

// [9] a subscriber is not charged a slot for an outage either
console.log('\n[9] a blind run does not consume a subscriber\'s delivery slot');
{
  const client = fakeClient({ feed: 'down', sweeps: 'down' });
  const state = freshState();
  const rl = new RateLimiter();
  const slot = '2026-08-30@08:00';
  state.upsertSubscriber(SUBSCRIBER, { nametag: 'reader', addDays: 30 });

  await delivery.runScheduledDigest(client, state, rl, { slot, label: 'Aug 30, 08:00' });
  ok(state.getSubscriber(SUBSCRIBER).lastDeliveredSlot !== slot, 'the subscriber has not been marked served');
  ok(client.dms.length === 0, 'because nothing was sent to them');

  client.reach.setFeed('ok');
  client.reach.setSweeps('ok');
  const served = await delivery.runScheduledDigest(client, state, rl, { slot, label: 'Aug 30, 08:00' });
  ok(served.fanned === 1, 'once the board answers they are served', served.fanned);
  ok(client.dms.length === 1, 'exactly one DM', client.dms.length);
  ok(/PROOF OF TIME \(verifiable\)/.test(client.dms[0].content), 'and it carries a real proof-of-time');
  ok(state.getSubscriber(SUBSCRIBER).lastDeliveredSlot === slot, 'and only now is their slot marked');
}

// [10] a buyer is refunded, not sold an admission of blindness
console.log('\n[10] money paid during an outage comes back in full');
{
  // (a) a one-time purchase.
  const client = fakeClient({ feed: 'down', sweeps: 'down' });
  const state = freshState();
  const rl = new RateLimiter();
  const priceBase = base(config.pricing.oneTimeWhole);
  state.addPendingPurchase(BUYER, {
    id: randomUUID(), kind: 'one-time', days: 0, priceBase: priceBase.toString(),
    createdAt: Date.now(), requesterNametag: 'buyer',
  });
  await settlePayment(client, {
    transfer: { senderPubkey: BUYER, senderNametag: 'buyer', tokens: [{ coinId: client.coin.coinId, amount: priceBase.toString() }] },
    state, rateLimit: rl,
  });
  ok(client.refunds.length === 1, 'the payment was refunded', client.refunds.length);
  ok(client.refunds[0]?.base === priceBase.toString(), 'in full, to the last base unit');
  ok(/market unreadable/.test(client.refunds[0]?.memo ?? ''), 'with a memo naming why', client.refunds[0]?.memo);
  const dm = client.dms.at(-1)?.content ?? '';
  ok(/could not read the market/i.test(dm), 'the buyer is told the market could not be read');
  ok(/will not sign one/i.test(dm), 'and that no report will be signed on that basis');
  ok(/refunded/i.test(dm) && /nothing was charged/i.test(dm), 'and that the money came back');
  ok(!/PROOF OF TIME/.test(dm), 'no proof block was delivered');
  ok(!/Signature: /.test(dm), 'and no signature line');
  ok(!/Unicity Market Digest —/.test(dm), 'and not the blind page dressed up as the product they paid for');

  // (b) a subscription. The bug worth pinning is subtler: the subscription must not
  // survive the refund, or an outage hands out free subscriptions.
  const c2 = fakeClient({ feed: 'down', sweeps: 'down' });
  const s2 = freshState();
  const subPrice = base(config.pricing.perDayWhole * 7);
  s2.addPendingPurchase(BUYER, {
    id: randomUUID(), kind: 'subscribe', days: 7, priceBase: subPrice.toString(),
    createdAt: Date.now(), requesterNametag: 'buyer',
  });
  await settlePayment(c2, {
    transfer: { senderPubkey: BUYER, senderNametag: 'buyer', tokens: [{ coinId: c2.coin.coinId, amount: subPrice.toString() }] },
    state: s2, rateLimit: new RateLimiter(),
  });
  ok(c2.refunds.length === 1 && c2.refunds[0]?.base === subPrice.toString(), 'the subscription fee is refunded in full');
  ok(
    s2.getSubscriber(BUYER) === null || s2.getSubscriber(BUYER) === undefined,
    'and NO subscription was created -- a refunded payment must not leave one behind',
  );
  ok(s2.activeSubscribers().length === 0, 'so the fan-out has nobody to serve for free', s2.activeSubscribers().length);

  // (c) and a refund that itself fails is not reported as a refund.
  const c3 = fakeClient({ feed: 'down', sweeps: 'down' });
  c3.refundResult = { error: 'wallet-api unreachable' };
  const s3 = freshState();
  s3.addPendingPurchase(BUYER, {
    id: randomUUID(), kind: 'one-time', days: 0, priceBase: priceBase.toString(),
    createdAt: Date.now(), requesterNametag: 'buyer',
  });
  await settlePayment(c3, {
    transfer: { senderPubkey: BUYER, senderNametag: 'buyer', tokens: [{ coinId: c3.coin.coinId, amount: priceBase.toString() }] },
    state: s3, rateLimit: new RateLimiter(),
  });
  const dm3 = c3.dms.at(-1)?.content ?? '';
  ok(/could not (return|send)/i.test(dm3), 'a refund that did not go out is not announced as one');
  ok(/owed to you/i.test(dm3), 'the debt is stated as owed');
  ok(!/nothing was charged/i.test(dm3), 'and the reassuring line is withheld, because it would be false');
}

// [11] the schedule that decides when any of this happens is pure
console.log('\n[11] the scheduler is pure: stable keys, a bounded catch-up window');
{
  const at = (iso) => new Date(iso);
  const times = [8 * 60, 20 * 60]; // 08:00, 20:00 in minutes-of-day

  ok(slotKey(at('2026-08-30T20:00:00Z'), 20 * 60) === slotKey(at('2026-08-30T23:59:00Z'), 20 * 60),
     'a slot key is a function of the DAY and the slot, not of the moment it is computed');
  ok(slotKey(at('2026-08-30T20:00:00Z'), 20 * 60).endsWith('@20:00'), 'and it reads as the wall-clock slot');

  const never = () => false;
  const due = dueSlot(times, { now: at('2026-08-30T20:05:00'), graceMs: 90 * 60_000, delivered: never });
  ok(due !== null, 'five minutes after a slot, it is due');
  ok(due.key.endsWith('@20:00'), 'and it is the 20:00 slot, not the next one', due?.key);

  const late = dueSlot(times, { now: at('2026-08-30T23:00:00'), graceMs: 90 * 60_000, delivered: never });
  ok(late === null, 'three hours later the window has closed -- a stale digest is not published as news');

  const served = dueSlot(times, {
    now: at('2026-08-30T20:05:00'), graceMs: 90 * 60_000,
    delivered: (k) => k.endsWith('@20:00'),
  });
  ok(served === null, 'a slot already delivered is never due again');

  const owed = dueSlot(times, {
    now: at('2026-08-30T20:05:00'), graceMs: 90 * 60_000,
    delivered: (k) => k.endsWith('@08:00'),
  });
  ok(owed?.key.endsWith('@20:00'), 'and delivering an earlier slot does not consume a later one');

  const nxt = nextSlot(times, at('2026-08-30T09:00:00'));
  ok(nxt?.min === 20 * 60, 'nextSlot looks forward, never back', nxt?.min);
  ok(nxt?.scheduledTs > at('2026-08-30T09:00:00').getTime(), 'and its timestamp is strictly in the future');

  // The whole file is decidable from its arguments -- there is no clock inside it.
  const src = await import('node:fs').then((fs) => fs.readFileSync('./src/scheduler.js', 'utf8'));
  const body = src.replace(/\/\*[\s\S]*?\*\//g, '').replace(/^\s*\/\/.*$/gm, '');
  ok(!/\bawait\b/.test(body), 'scheduler.js contains no await -- it cannot touch the network');
  ok(!/\bimport\b/.test(body), 'and imports nothing at all -- no config, no state, no SDK');
  ok(
    (body.match(/Date\.now\(\)/g) ?? []).length === 0,
    'and it never reads the clock itself: `now` is always passed in, which is why [8] can test a blackout at 20:05',
  );
}

console.log(`\n  ${passed} passed, ${failed} failed`);
console.log(
  failed === 0
    ? '  ALL PASS -- an unread market is never published, signed, sold, or counted as served.'
    : '  FAILURES -- the agent may be signing claims about a board it could not see.',
);
process.exit(failed === 0 ? 0 : 1);
