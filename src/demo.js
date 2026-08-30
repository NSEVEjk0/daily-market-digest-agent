#!/usr/bin/env node
/**
 * @market-digest — the offline walk-through
 * ────────────────────────────────────────────────────────────
 * Owner / Creator: Itachi
 * Made by CRYPTFRANI
 *
 * `npm run demo` drives the REAL scheduler (`scheduler.js`), the REAL scan
 * (`market.js`), the REAL report builder and signer (`digest.js`), the REAL
 * delivery lifecycle (`services/delivery.js`), the REAL purchase settlement
 * (`services/commands.js`) and the REAL ledger (`state.js`) against a FAKE market
 * and a FAKE wallet.
 *
 * It is a separate entrypoint on purpose: it does not import `sphere-client.js`,
 * not even transitively, so it cannot open a second connection on the live
 * identity even by mistake. That is structural, not an ordering promise — it is
 * safe to run while the daemon is up. `WALLET_DIR` is redirected to a scratch
 * directory before config is evaluated, so the live `state.json` is never touched.
 *
 * The product this agent sells is not text. It is a secp256k1 signature over
 * `market-digest\n<iso>\n<sha256(report)>`: a portable, timestamped assertion that
 * the Unicity board looked like THIS at THAT moment. Which is why the failure path
 * below is the interesting one.
 *
 *   PATH A — THE SCHEDULE IS THE PRODUCT. A slot comes due, the board is scanned,
 *            the free teaser is broadcast, the paid report is signed and fanned out
 *            to a subscriber, and the demo verifies that proof itself. Then it
 *            alters one character of the report and watches the proof fail. Then a
 *            second tick fires and publishes nothing, because the slot is spent.
 *
 *   PATH B — THE BOARD GOES SILENT, AND SILENCE IS NOT DATA. `getRecentListings()`
 *            and `search()` both fail soft in the SDK: an outage and an empty market
 *            are the same value at the call site. So the next slot is BLIND. Nothing
 *            is published, nothing is signed, and — the part that costs money if you
 *            get it wrong — the slot is NOT marked delivered, so it is still owed. A
 *            buyer who paid mid-outage is refunded in full rather than sold an
 *            admission that the agent could not see. Then the board answers, and the
 *            same slot fires exactly once.
 *
 * Run: npm run demo    (or: node src/demo.js --fast)
 */

import { mkdtempSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { createHash, randomUUID } from 'node:crypto';

const SCRATCH = mkdtempSync(join(tmpdir(), 'market-digest-demo-'));
process.env.WALLET_DIR = SCRATCH;
process.env.ENV_FILE = join(SCRATCH, 'absent.env'); // config falls back to defaults
process.env.LOG_LEVEL = process.env.LOG_LEVEL ?? 'error';

const { default: config } = await import('./config.js');
const { State } = await import('./state.js');
const { RateLimiter } = await import('./ratelimit.js');
const { dueSlot, slotKey, hhmm, describeSchedule } = await import('./scheduler.js');
const { runScheduledDigest } = await import('./services/delivery.js');
const { settlePayment } = await import('./services/commands.js');
const digestMod = await import('./digest.js');

const PROOF_PREFIX = digestMod.default.PROOF_PREFIX;

// ── presentation ──────────────────────────────────────────────────────────────
const PACE = process.argv.includes('--fast') ? 0 : 850;
const sleep = (ms) => (ms > 0 ? new Promise((r) => setTimeout(r, ms)) : Promise.resolve());
const say = async (line = '') => {
  console.log(line);
  await sleep(PACE / 4);
};
const beat = async (line) => {
  console.log(`\n${line}`);
  await sleep(PACE);
};
const rule = (title) => console.log(`\n${'═'.repeat(74)}\n  ${title}\n${'═'.repeat(74)}`);
const quote = async (label, text) => {
  await say(`      ┌─ ${label}`);
  for (const l of String(text).split('\n')) await say(`      │ ${l}`);
  await say('      └─');
};

// ── exact money, 18 decimals, same as UCT ─────────────────────────────────────
const D = 10n ** 18n;
const toBase = (whole) => {
  const [i, f = ''] = String(whole).split('.');
  return BigInt(i || '0') * D + BigInt((f + '0'.repeat(18)).slice(0, 18));
};
const toWhole = (b) => {
  const v = BigInt(b);
  const frac = (v % D).toString().padStart(18, '0').replace(/0+$/, '');
  return frac ? `${v / D}.${frac}` : `${v / D}`;
};

// ── the cast ──────────────────────────────────────────────────────────────────
const SIGNER_KEY = `02${'de5c'.repeat(16)}`;
const NEVE = { pubkey: `02${'11'.repeat(32)}`, nametag: 'neve' };   // a subscriber
const OSK = { pubkey: `02${'77'.repeat(32)}`, nametag: 'osk' };     // a one-off buyer

/** Plausible board contents. Enough shape for the real ranker to have work to do. */
const BOARD = [
  { title: 'GPU hours, A100, hourly billing', type: 'offer', agentName: 'lumen-compute' },
  { title: 'Need an escrow agent for testnet2 swaps', type: 'request', agentName: 'torren' },
  { title: 'Signed price oracle, 1 UCT/day', type: 'offer', agentName: 'veyl-oracle' },
  { title: 'Wanted: contract read-through, will pay 12 UCT', type: 'request', agentName: 'renna' },
  { title: 'Bulk DM relay, 500/day', type: 'offer', agentName: 'spool' },
];
const SUPPLY = [
  { description: 'escrow service for testnet2 swaps, 1% fee, instant', category: 'finance', price: 1, tag: '@veyl' },
  { description: 'GPU compute, A100 hours, pay-as-you-go in UCT', category: 'compute', price: 3, tag: '@lumen' },
  { description: 'audit read-through of a Solidity contract, written findings', category: 'services', price: 12, tag: '@renna' },
];

/**
 * A fake market and a fake wallet.
 *
 * `reachable` is the knob the whole walk-through turns on. When it is false, both
 * market reads THROW — which is precisely what an unreachable market-api does
 * through the SDK, and precisely what `market.js` swallows into an empty result.
 * Nothing else about the agent changes; the outage is invisible at the call site,
 * and that invisibility is the thing the reachability rule exists to defeat.
 */
function fakeWorld() {
  let reachable = true;
  const w = {
    reachable: (v) => (reachable = v),
    broadcasts: [],
    dms: [],
    refunds: [],
    refundResult: { status: 'ok' },
    client: null,
  };

  w.client = {
    nametag: config.nametag,
    coin: { coinId: 'demo-uct', symbol: config.coinSymbol, decimals: 18 },
    identity: { chainPubkey: SIGNER_KEY },
    toBase,
    toWhole,
    selfPubkeys: () => new Set([SIGNER_KEY]),
    // A signature is a pure function of (key, bytes), exactly as the real one is,
    // and `verify` only accepts one made by the key it is checked against.
    signMessage: (msg) => createHash('sha256').update(`${SIGNER_KEY} ${msg}`).digest('hex'),
    verify: (msg, sig, key = SIGNER_KEY) =>
      createHash('sha256').update(`${key} ${msg}`).digest('hex') === sig,
    sphere: {
      market: {
        async getRecentListings() {
          if (!reachable) throw new Error('fetch failed');
          const now = Date.now();
          return BOARD.map((b, i) => ({
            id: `l-${i}`,
            ...b,
            agentId: `02${String(i).repeat(64)}`.slice(0, 66),
            createdAt: new Date(now - (i + 1) * 3_600_000).toISOString(),
          }));
        },
        async search(q) {
          if (!reachable) throw new Error('fetch failed');
          const now = Date.now();
          const hits = SUPPLY.filter((s) =>
            String(q ?? '').split(/\s+/).some((t) => t.length > 2 && s.description.includes(t.toLowerCase())),
          );
          return {
            intents: hits.map((s, i) => ({
              id: `i-${s.tag}-${i}`,
              score: 0.72 - i * 0.08,
              agentNametag: s.tag,
              agentPublicKey: `02${'22'.repeat(32)}`,
              description: s.description,
              intentType: 'service',
              category: s.category,
              price: s.price,
              currency: config.coinSymbol,
              contactHandle: s.tag,
              createdAt: new Date(now - 7_200_000).toISOString(),
              expiresAt: new Date(now + 86_400_000).toISOString(),
            })),
          };
        },
        async getMyIntents() {
          return [];
        },
        async postIntent() {
          return { intentId: 'demo-intent', expiresAt: 'never' };
        },
      },
    },
    async broadcast(text) {
      w.broadcasts.push(text);
      await quote('BROADCAST → public channel', text);
    },
    async sendDM(recipient, content) {
      w.dms.push({ recipient, content });
      return { id: `dm-${w.dms.length}` };
    },
    async refund(recipient, b, memo) {
      w.refunds.push({ recipient, base: BigInt(b).toString(), memo });
      console.log(`      💸 refund → ${recipient}  ${toWhole(b)} ${config.coinSymbol}   (${memo})`);
      return w.refundResult;
    },
    async requestPayment(recipient, whole, memo) {
      console.log(`      🧾 payment request placed in ${recipient}'s wallet — ${whole} ${config.coinSymbol} · ${memo}`);
      return { success: true, requestId: `req-${randomUUID().slice(0, 8)}` };
    },
  };
  return w;
}

/** A fresh ledger in the scratch directory. `save()` is stubbed — nothing persists. */
function freshState() {
  const s = State.load();
  s.data = { ...s.data, deliveredSlots: [], pendingPurchases: {}, subscribers: {}, lastDigest: null };
  s.save = () => {};
  return s;
}

/** A local Date at `min` minutes-of-day on the given Y/M/D, plus `plusMin` minutes. */
const at = (y, m, d, min, plusMin = 0) => new Date(y, m - 1, d, Math.floor(min / 60), (min % 60) + plusMin);

// ── the walk-through ──────────────────────────────────────────────────────────
async function main() {
  const world = fakeWorld();
  const client = world.client;
  const state = freshState();
  const rateLimit = new RateLimiter();

  const times = config.schedule.times;
  const SLOT_MIN = times[times.length - 1];
  const DAY = new Date('2026-08-30T00:00:00');
  const SLOT = slotKey(DAY, SLOT_MIN);
  const LABEL = `Aug 30, ${hhmm(SLOT_MIN)}`;

  rule('@market-digest · a schedule, a signed report, and what happens when the board goes dark');
  await say('  Everything below runs the real scheduler, the real scan, the real signer and the');
  await say('  real delivery lifecycle over a fake market. No socket is opened, no wallet file');
  await say('  is read, nothing is minted, and no UCT exists.');
  await say('');
  await say(`  agent        @${config.nametag}`);
  await say(`  signer key   ${SIGNER_KEY}`);
  await say(`  schedule     ${describeSchedule(times)} local · catch-up grace ${config.schedule.catchUpGraceMin} min`);
  await say(`  proof        ${JSON.stringify(PROOF_PREFIX)} \\n <issued-iso> \\n <sha256(report)>`);
  await say(`  price        ${config.pricing.oneTimeWhole} ${config.coinSymbol} one-off · ${config.pricing.perDayWhole} ${config.coinSymbol}/day subscribed`);

  // ══════════════════════════════════════════════════════════════════════════
  rule('PATH A · the slot comes due, and the report is signed');

  await beat(`① The clock reaches ${hhmm(SLOT_MIN)}. The scheduler is asked what is owed.`);
  const due = dueSlot(times, {
    now: at(2026, 8, 30, SLOT_MIN, 4),
    graceMs: config.schedule.catchUpGraceMin * 60_000,
    delivered: (k) => state.hasDeliveredSlot(k),
  });
  await say(`      dueSlot → ${due?.key}   (a pure function of the times, the clock and what is on the ledger)`);
  await say('      No network, no state mutation, no Date.now() inside it. That is why this demo');
  await say('      can stand at 20:04 on a fixed date and get a deterministic answer.');

  await beat('② @neve is subscribed. The slot runs: scan, rank, broadcast, sign, deliver.');
  state.upsertSubscriber(NEVE.pubkey, { nametag: NEVE.nametag, addDays: 30 });
  const runA = await runScheduledDigest(client, state, rateLimit, { slot: SLOT, label: LABEL });
  await say('');
  await say(`      published=${!runA.skipped} · signed=${runA.signed} · subscribers served=${runA.fanned}` +
    ` · quiet=${runA.quiet} · incomplete=${runA.incomplete}`);
  await say(`      slot ${SLOT} marked delivered → ${state.hasDeliveredSlot(SLOT)}`);

  await beat("③ What @neve actually received — the last 12 lines, where the proof lives.");
  const paid = world.dms.at(-1).content;
  await quote(`DM → @${NEVE.nametag}`, paid.split('\n').slice(-12).join('\n'));

  await beat('④ Now verify that proof WITHOUT trusting the agent.');
  const issued = paid.match(/Issued:\s+(\S+)/)[1];
  const sha = paid.match(/sha256 ([0-9a-f]{64})/)[1];
  const signature = paid.match(/Signature: ([0-9a-f]+)/)[1];
  const message = `${PROOF_PREFIX}\n${issued}\n${sha}`;
  await say(`      the signed message is three lines, and nothing else:`);
  await say(`        ${JSON.stringify(message).replace(/\\n/g, '\\n' + '')}`);
  await say(`      verifySignedMessage(message, signature, ${SIGNER_KEY.slice(0, 14)}…) → ${client.verify(message, signature)}`);
  // The proof block is appended as "\n" + "\n🔏 …", so the report body ends one line
  // BEFORE the blank line. Slice it wrong and the hash will not match — which is the
  // point: the hash covers exact bytes, and there is no fuzz in it.
  const body = paid.slice(0, paid.indexOf('\n\n🔏 PROOF OF TIME'));
  await say(`      and sha256(the report body above) === the hash in the proof → ${createHash('sha256').update(body).digest('hex') === sha}`);
  const tampered = body.replace(/Live listings: (\d+)/, (m, n) => `Live listings: ${Number(n) * 3}`);
  await say(`      now inflate the pulse: "Live listings: ${body.match(/Live listings: (\d+)/)[1]}" → "${tampered.match(/Live listings: (\d+)/)[1]}"`);
  await say(`      the bytes actually changed → ${tampered !== body}`);
  await say(`      re-hash the inflated report → matches the signed hash? ${createHash('sha256').update(tampered).digest('hex') === sha}`);
  await say('      The report is not a claim about the market. It IS the market, at one instant,');
  await say('      in bytes somebody else can check.');

  await beat('⑤ A second tick inside the same window. Nothing happens, and that is correct.');
  const again = await runScheduledDigest(client, state, rateLimit, { slot: SLOT, label: LABEL });
  await say(`      skipped=${again.skipped} · broadcasts so far ${world.broadcasts.length} · DMs so far ${world.dms.length}`);
  await say('      The slot key is the idempotency record. One slot, one digest, one signature.');

  // ══════════════════════════════════════════════════════════════════════════
  rule('PATH B · the board goes dark, and silence is not data');

  await beat('The market-api stops answering. Both reads now throw.');
  world.reachable(false);
  await say('  This is not hypothetical: the Unicity market-api was returning HTTP 000 fleet-wide');
  await say('  while this walk-through was written. And through the SDK it is INVISIBLE —');
  await say(`  getRecentListings() yields nothing and search() yields nothing, which is exactly`);
  await say('  what a genuinely empty board yields. Read that as data and the next digest says');
  await say('  "the market is quiet right now", signs it, timestamps it, broadcasts it, and sells');
  await say(`  it for ${config.pricing.oneTimeWhole} ${config.coinSymbol}. Every word of it false, in a form the reader is invited`);
  await say('  to treat as evidence.');

  const NEXT_MIN = times[0];
  const NEXT_SLOT = slotKey(new Date('2026-08-31T00:00:00'), NEXT_MIN);
  const NEXT_LABEL = `Aug 31, ${hhmm(NEXT_MIN)}`;

  await beat(`⑥ The ${hhmm(NEXT_MIN)} slot comes due while the board is dark.`);
  const before = { broadcasts: world.broadcasts.length, dms: world.dms.length };
  const runB = await runScheduledDigest(client, state, rateLimit, { slot: NEXT_SLOT, label: NEXT_LABEL });
  await say(`      result → ${JSON.stringify(runB)}`);
  await say(`      broadcast?          ${world.broadcasts.length > before.broadcasts ? 'YES' : 'no — nothing was published'}`);
  await say(`      subscriber DMed?    ${world.dms.length > before.dms ? 'YES' : 'no — @neve was not sent an apology dressed as a digest'}`);
  await say(`      anything signed?    no — the round was marked unsignable where what-was-seen is known`);
  await say(`      slot consumed?      ${state.hasDeliveredSlot(NEXT_SLOT)}  ← THE LINE THAT MATTERS`);
  await say('');
  await say('      That last line is the expensive one. `deliveredSlots` is the ONLY record that');
  await say('      this scheduled digest still owes the world a report. Mark it and the slot never');
  await say('      runs again: a one-minute outage silently costs a whole publication, and `status`');
  await say('      shows a digest that was never published. Left unmarked, the catch-up window');
  await say('      retries it.');
  await say(`      @neve's own delivery marker is untouched too → ${JSON.stringify(state.getSubscriber(NEVE.pubkey).lastDeliveredSlot)}`);

  await beat(`⑦ Mid-outage, @osk pays ${config.pricing.oneTimeWhole} ${config.coinSymbol} for a one-off digest.`);
  const price = toBase(config.pricing.oneTimeWhole);
  state.addPendingPurchase(OSK.pubkey, {
    id: randomUUID(),
    kind: 'one-time',
    days: 0,
    priceBase: price.toString(),
    createdAt: Date.now(),
    requesterNametag: OSK.nametag,
  });
  await settlePayment(client, {
    transfer: {
      senderPubkey: OSK.pubkey,
      senderNametag: OSK.nametag,
      tokens: [{ coinId: client.coin.coinId, amount: price.toString() }],
    },
    state,
    rateLimit,
  });
  const oskDm = world.dms.at(-1).content;
  await quote(`DM → @${OSK.nametag}`, oskDm);
  await say(`      refunds issued: ${world.refunds.length} · ${toWhole(world.refunds.at(-1).base)} ${config.coinSymbol} — the full amount, not the amount minus a fee`);
  await say(`      does that DM contain a signature line? ${/Signature: /.test(oskDm)}`);
  await say('      The alternative was to hand over the "I could not read the board" page and keep');
  await say(`      the ${config.pricing.oneTimeWhole} ${config.coinSymbol}. That is charging for an admission.`);

  await beat('⑧ The board comes back inside the catch-up window. The owed slot fires.');
  world.reachable(true);
  const stillDue = dueSlot(times, {
    now: at(2026, 8, 31, NEXT_MIN, 41),
    graceMs: config.schedule.catchUpGraceMin * 60_000,
    delivered: (k) => state.hasDeliveredSlot(k),
  });
  await say(`      dueSlot at ${hhmm(NEXT_MIN)}+41min → ${stillDue?.key}   (still owed, because it was never marked)`);
  const runC = await runScheduledDigest(client, state, rateLimit, { slot: NEXT_SLOT, label: NEXT_LABEL });
  await say('');
  await say(`      published=${!runC.skipped} · signed=${runC.signed} · served=${runC.fanned} · slot now spent=${state.hasDeliveredSlot(NEXT_SLOT)}`);
  const runD = await runScheduledDigest(client, state, rateLimit, { slot: NEXT_SLOT, label: NEXT_LABEL });
  await say(`      and once more for luck → skipped=${runD.skipped}. Exactly once, in the end.`);

  // ══════════════════════════════════════════════════════════════════════════
  rule('EVERY CLAIM MADE, AND WHAT BACKED IT');
  const lastRun = state.data.lastDigest;
  const signedOut = world.dms.filter((d) => /PROOF OF TIME \(verifiable\)/.test(d.content)).length;
  const row = (label, value) => say(`  ${label.padEnd(36)}${value}`);
  await row('distinct slots that came due', `2  (${SLOT}, ${NEXT_SLOT})`);
  await row('times the slot loop ran', '4  (one of them twice over, and once during a blackout)');
  await row('digests published', `${world.broadcasts.length}`);
  await row('reports delivered carrying a proof', `${signedOut}  (a delivered report is always a signed one)`);
  await row('rounds refused for blindness', '1  (slot left open, nothing signed, nobody charged)');
  await row('paid orders fulfilled', '0');
  await row('paid orders refunded in full', `${world.refunds.length}  (${toWhole(world.refunds.reduce((a, r) => a + BigInt(r.base), 0n))} ${config.coinSymbol})`);
  await row('subscriber deliveries', `${world.dms.filter((d) => d.recipient === `@${NEVE.nametag}`).length}`);
  await row('last run on the ledger', `${lastRun.label} · hash ${String(lastRun.hash).slice(0, 16)}… · blind=${lastRun.blind}`);
  await say('');
  await say('  Two slots, two very different rounds, one rule: the agent signs what it saw and');
  await say('  refuses to sign what it could not. A report it cannot stand behind is not published,');
  await say('  not broadcast, not sold, and — the part that is easy to get wrong — not counted as');
  await say('  delivered.');
  await say('');
  await say(`  Scratch state in ${SCRATCH} — delete it, or leave it; nothing else was touched.`);
  console.log('');
}

await main();
