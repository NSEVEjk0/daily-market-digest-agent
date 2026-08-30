/**
 * test-refund-truth-unit.mjs — offline proof that @market-digest never claims a refund
 * that did not actually happen, and never returns money silently.
 *
 * `client.refund` resolves rather than throws for every failure mode it has:
 *   {skipped:'refunds disabled'} · {skipped:'min-balance floor'}
 *   {skipped:'non-positive amount'} · {error:…} · {unconfirmed:true} · {dryRun:true}
 *
 * settlePayment ignored that return in all three of its refund paths. Two consequences:
 *
 *   1. the underpaid and fulfilment-error branches said "I've refunded it" BEFORE
 *      knowing whether it went out — so a min-balance floor or a disabled-refunds
 *      switch turned into a false statement about somebody's money;
 *   2. the overpayment refund was neither checked NOR announced — correct, it was an
 *      unexplained transfer landing after the report; failed, it was the difference
 *      quietly kept, against a promise `help` and `about` both make in writing.
 *
 * Same defect and same code lineage as @frani-agent (f3589d7). Both descend from the
 * silent terminal transitions fixed in @frani-agora (c5ea1a6), @frani-bounty (63efd6b)
 * and @frani-treasury (f8e8174) — but this is the sharper variant: not silence about
 * money, a false claim about it.
 *
 * Offline: no network, no wallet, no funds.
 *
 * Gitignored (test-*.mjs). Run: node test-refund-truth-unit.mjs
 */

import { mkdtempSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { randomUUID } from 'node:crypto';

const tmp = mkdtempSync(join(tmpdir(), 'market-digest-refund-'));
process.env.ENV_FILE = join(tmp, 'no-such.env'); // config falls back to defaults
process.env.WALLET_DIR = tmp; // state.json lives here
process.env.LOG_LEVEL = 'error';

const { State } = await import('./src/state.js');
const { settlePayment } = await import('./src/services/commands.js');
const { RateLimiter } = await import('./src/ratelimit.js');
const { default: config } = await import('./src/config.js');

const DEC = 18n;
const D = 10n ** DEC;
const base = (whole) => (BigInt(Math.round(Number(whole) * 1000)) * D) / 1000n;
const toWhole = (b) => {
  b = BigInt(b);
  const f = (b % D).toString().padStart(Number(DEC), '0').replace(/0+$/, '');
  return f ? `${b / D}.${f}` : `${b / D}`;
};

let passed = 0, failed = 0;
const ok = (cond, msg) => { if (cond) { passed++; console.log(`  ✅ ${msg}`); } else { failed++; console.log(`  ❌ ${msg}`); } };

const COIN = { coinId: 'uct-coin-id', symbol: 'UCT', decimals: Number(DEC) };
const SENDER = '02' + 'c'.repeat(64);
const PRICE = config.pricing.oneTimeWhole; // 5 UCT by default

/**
 * A fake client whose refund returns exactly what we tell it to. The market reads are
 * stubbed empty so a one-time digest actually builds — that is what makes the
 * overpayment path reachable instead of being swallowed by the error branch.
 */
const makeClient = (refundResult = { status: 'ok' }) => ({
  refundResult,
  refunds: [],
  dms: [],
  coin: COIN,
  toWhole,
  toBase: base,
  nametag: 'market-digest',
  identity: { chainPubkey: '02' + 'd'.repeat(64) },
  selfPubkeys() { return new Set([this.identity.chainPubkey]); },
  signMessage: (msg) => `sig-${msg.length}`,
  sphere: {
    market: {
      async search() { return { intents: [] }; },
      async getRecentListings() { return []; },
    },
  },
  async refund(recipient, b, memo) {
    this.refunds.push({ recipient, base: BigInt(b).toString(), memo });
    return this.refundResult;
  },
  async sendDM(recipient, content) { this.dms.push({ recipient, content }); return { id: `dm-${this.dms.length}` }; },
});

/**
 * Same client, but fulfilment blows up. `nametag` is read by buildReport outside any
 * try/catch, so a throwing getter is a deterministic fault injector for the catch
 * branch. (A market OUTAGE also lands there now, deliberately — see
 * test-blind-digest-unit.mjs. This suite is about the refund itself, so it injects a
 * plain fault and leaves the blind-round refusal to that file.)
 */
const makeBrokenClient = (refundResult) => {
  const c = makeClient(refundResult);
  Object.defineProperty(c, 'nametag', {
    get() { throw new Error('digest builder unavailable'); },
  });
  return c;
};

const freshState = () => {
  const s = State.load();
  s.data.pendingPurchases = {};
  s.data.subscribers = {};
  return s;
};

const withPurchase = (state, kind = 'one-time', priceWhole = PRICE) => {
  const purchase = {
    id: randomUUID(),
    kind,
    days: kind === 'subscribe' ? 7 : 0,
    priceBase: base(priceWhole).toString(),
    createdAt: Date.now(),
    requesterNametag: 'payer-demo',
  };
  state.addPendingPurchase(SENDER, purchase);
  return purchase;
};

const transfer = (whole) => ({
  senderPubkey: SENDER,
  senderNametag: 'payer-demo',
  tokens: [{ coinId: COIN.coinId, amount: base(whole).toString() }],
});

const said = (client) => client.dms.map((m) => m.content).join('\n');

console.log('════════ market-digest · refund-truth unit proof (offline) ════════');

console.log('\n[0] the harness itself is sound (otherwise nothing below proves anything)');
{
  const client = makeClient();
  const state = freshState();
  withPurchase(state, 'one-time');
  await settlePayment(client, { transfer: transfer(PRICE), state, rateLimit: new RateLimiter() });
  ok(client.dms.length >= 1, 'an exact payment produces a delivery, so fulfilment really works offline');
  ok(client.refunds.length === 0, 'and needs no refund');
}

// Every failure mode client.refund can actually return, and what each one means.
const FAILURES = [
  { label: 'refunds disabled by config', result: { skipped: 'refunds disabled' } },
  { label: 'min-balance floor would be breached', result: { skipped: 'min-balance floor' } },
  { label: 'the send errored', result: { error: 'aggregator rejected the transfer' } },
  { label: 'no result at all', result: null },
];

console.log('\n[1] UNDERPAID: a refund that did not go out is never reported as done');
for (const f of FAILURES) {
  const client = makeClient(f.result);
  const state = freshState();
  withPurchase(state, 'one-time');
  await settlePayment(client, { transfer: transfer(1), state, rateLimit: new RateLimiter() });
  const text = said(client);
  ok(client.refunds.length === 1, `${f.label} — the refund was attempted`);
  ok(!/I've refunded it|have refunded/i.test(text), `${f.label} — never claims "refunded"`);
  ok(/could not send|could not return/i.test(text), `${f.label} — says plainly it could not send`);
  ok(/owed to you/i.test(text), `${f.label} — records the debt to the payer`);
}

console.log('\n[2] UNDERPAID: an unconfirmed certification is its own answer, never a retry');
{
  const client = makeClient({ unconfirmed: true });
  const state = freshState();
  withPurchase(state, 'one-time');
  await settlePayment(client, { transfer: transfer(1), state, rateLimit: new RateLimiter() });
  const text = said(client);
  ok(client.refunds.length === 1, 'attempted exactly once');
  ok(/may or may not have gone through/i.test(text), 'the ambiguity is stated, not guessed at');
  ok(/will not resend/i.test(text), 'and the double-pay guard is explained');
  ok(!/I've refunded it/i.test(text), 'never claims it completed');
}

console.log('\n[3] UNDERPAID: a refund that DID go out is reported, as before');
{
  const client = makeClient({ status: 'ok' });
  const state = freshState();
  withPurchase(state, 'one-time');
  await settlePayment(client, { transfer: transfer(1), state, rateLimit: new RateLimiter() });
  const text = said(client);
  ok(/refunded it/i.test(text), 'says it refunded');
  ok(/send the full amount to retry/i.test(text), 'and invites the retry');
  ok(!/owed to you/i.test(text), 'no phantom debt recorded');
  ok(/full digest costs/i.test(text), 'and names what the order actually costs');
}

console.log('\n[4] FULFILMENT ERROR: same rule on the error path');
{
  const client = makeBrokenClient({ skipped: 'min-balance floor' });
  const state = freshState();
  withPurchase(state, 'one-time');
  await settlePayment(client, { transfer: transfer(PRICE), state, rateLimit: new RateLimiter() });
  const text = said(client);
  ok(client.refunds.length === 1, 'the refund was attempted');
  ok(BigInt(client.refunds[0]?.base ?? 0) === base(PRICE), 'the WHOLE payment is refunded, not a part of it');
  ok(/hit an error fulfilling/i.test(text), 'the fulfilment failure is owned');
  ok(!/have refunded/i.test(text), 'but no refund is claimed');
  ok(/could not return/i.test(text) && /owed to you/i.test(text), 'the money is stated as still owed');
}

console.log('\n[5] OVERPAYMENT: the difference coming back is announced');
{
  const client = makeClient({ status: 'ok' });
  const state = freshState();
  withPurchase(state, 'one-time');
  await settlePayment(client, { transfer: transfer(Number(PRICE) + 2), state, rateLimit: new RateLimiter() });
  const text = said(client);
  ok(client.refunds.length === 1, 'the overpayment refund was attempted');
  ok(BigInt(client.refunds[0]?.base ?? 0) === base(2), 'only the 2 UCT difference is returned');
  ok(/2 UCT more than the full digest costs/.test(text), 'the payer is told the amount and what it was for');
  ok(/on its way back/i.test(text), 'and that it is on its way');
  ok(!/owed to you/i.test(text), 'no phantom debt');
}

console.log('\n[6] OVERPAYMENT: a FAILED difference refund is never kept quietly');
{
  const client = makeClient({ skipped: 'min-balance floor' });
  const state = freshState();
  withPurchase(state, 'one-time');
  await settlePayment(client, { transfer: transfer(Number(PRICE) + 2), state, rateLimit: new RateLimiter() });
  const text = said(client);
  ok(client.dms.length === 2, 'the paid report still went out first — they paid for it');
  ok(client.refunds.length === 1, 'attempted');
  ok(BigInt(client.refunds[0]?.base ?? 0) === base(2), 'for the 2 UCT difference');
  ok(/could not return the difference/i.test(text), 'the failure is stated');
  ok(/owed to you/i.test(text), 'and the difference is recorded as owed, not kept');
  ok(!/on its way back/i.test(text), 'and never claimed to be on its way');
}

console.log('\n[7] a SUBSCRIPTION overpayment names the subscription, not the digest');
{
  const client = makeClient({ status: 'ok' });
  const state = freshState();
  const perDay = config.pricing.perDayWhole;
  withPurchase(state, 'subscribe', Number(perDay) * 7);
  await settlePayment(client, { transfer: transfer(Number(perDay) * 7 + 2), state, rateLimit: new RateLimiter() });
  const text = said(client);
  ok(/Subscription active/i.test(text), 'the subscription was activated');
  ok(BigInt(client.refunds[0]?.base ?? 0) === base(2), 'the 2 UCT difference is returned');
  ok(/7-day subscription costs/i.test(text), 'and the notice names the 7-day subscription');
}

console.log('\n[8] EXACT payment: no refund, no refund talk');
{
  const client = makeClient({ status: 'ok' });
  const state = freshState();
  withPurchase(state, 'one-time');
  await settlePayment(client, { transfer: transfer(PRICE), state, rateLimit: new RateLimiter() });
  ok(client.refunds.length === 0, 'nothing was refunded');
  ok(!/owed to you|on its way back|I've refunded/i.test(said(client)), 'and nothing about refunds was said');
}

console.log('\n[9] a payment with no pending order is still a tip, unchanged');
{
  const client = makeClient({ status: 'ok' });
  const state = freshState();
  await settlePayment(client, { transfer: transfer(3), state, rateLimit: new RateLimiter() });
  ok(client.refunds.length === 0, 'no refund attempted');
  ok(/tip/i.test(said(client)), 'thanked as a tip');
}

console.log(`\n  ${passed} passed, ${failed} failed`);
console.log(failed === 0
  ? '  ✅ ALL PASS — the agent only claims refunds it actually made.'
  : '  ❌ FAILURES — the agent can still misreport somebody\'s money.');
process.exit(failed === 0 ? 0 : 1);
