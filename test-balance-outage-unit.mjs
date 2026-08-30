/**
 * test-balance-outage-unit.mjs — offline proof that a wallet-api outage is never
 * mistaken for a zero balance, and never blamed on the min-balance floor.
 *
 * `payments.assets()` resolves with an EMPTY ARRAY when the wallet-api cannot be
 * reached. It does not throw. So at the call site an outage and a genuinely empty
 * wallet are indistinguishable — and this agent had two places that read the
 * silence as a balance of zero:
 *
 *   1. `_send()` — the floor check saw `0 - amount < floor` and returned
 *      `{skipped: 'min-balance floor'}`. Under the refund-truth contract that is
 *      reported honestly to the payer ("could not return it — still owed to
 *      you"), so no money was ever misreported. But the *reason* was a fiction:
 *      the wallet held 100 UCT, and the agent said it was too poor to refund.
 *      An operator reading that log would go looking for the wrong problem.
 *   2. `bootstrapMintIfNeeded()` — saw 0 < floor and would mint a *second*
 *      bootstrap onto an already-funded wallet.
 *
 * This was observed live on 2026-08-27/28 across the fleet: balances read 0 while
 * the wallets actually held funds.
 *
 * The fix is `_coinRow()`, which reports whether a row came back at all, so
 * silence can be handled as silence. `_send` still fails closed — it just says
 * why truthfully, and `refundOutcome` passes any skip reason through unchanged.
 *
 * Offline: the SphereClient constructor takes an injected `sphere`, so no network,
 * no wallet and no funds are involved.
 *
 * Gitignored by default (test-*.mjs) and negated explicitly. Run:
 *   node test-balance-outage-unit.mjs
 */

import { mkdtempSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';

const tmp = mkdtempSync(join(tmpdir(), 'market-digest-outage-'));
process.env.ENV_FILE = join(tmp, 'no-such.env'); // config falls back to defaults
process.env.WALLET_DIR = tmp;
process.env.LOG_LEVEL = 'error';
process.env.SELF_MINT_ENABLED = 'true'; // so the bootstrap path is reachable at all
process.env.MIN_BALANCE = '1';

const { SphereClient } = await import('./src/sphere-client.js');
const { default: config } = await import('./src/config.js');

const DEC = 18n;
const D = 10n ** DEC;
const base = (whole) => (BigInt(Math.round(Number(whole) * 1000)) * D) / 1000n;
const COIN = { coinId: 'uct-coin-id', symbol: 'UCT', decimals: Number(DEC) };
const PAYER = '02' + 'c'.repeat(64);

let passed = 0, failed = 0;
const ok = (cond, msg, got) => {
  if (cond) { passed++; console.log(`  ✅ ${msg}`); }
  else { failed++; console.log(`  ❌ ${msg}${got !== undefined ? ` — got ${JSON.stringify(got)}` : ''}`); }
};

/**
 * `_send` returns the bare string 'min-balance floor' when — and only when — it
 * has a real balance in hand and that balance is too low. So the discriminator is
 * exact equality, not a substring match: the truthful outage message *mentions*
 * the floor ("could not confirm the min-balance floor") precisely to say it never
 * got far enough to check it.
 */
const FLOOR_VERDICT = 'min-balance floor';
const claimsFloorBreach = (r) => String(r?.skipped ?? '') === FLOOR_VERDICT;

/**
 * `OUTAGE` is the real shape the SDK produces when the wallet-api is unreachable:
 * not an error, not a row of zeros — an empty array.
 */
const OUTAGE = [];
const funded = (whole) => [{
  coinId: COIN.coinId,
  confirmedAmount: base(whole).toString(),
  totalAmount: base(whole).toString(),
}];
const OTHER_COIN_ONLY = [{ coinId: 'some-other-coin', confirmedAmount: base(999).toString() }];

const makeClient = (assetRows) => {
  const sphere = {
    payments: {
      rows: assetRows,
      sends: [],
      mints: 0,
      async assets() { return this.rows; },
      async send(args) { this.sends.push(args); return { status: 'ok' }; },
      async mint() { this.mints += 1; return { success: true, tokenId: 'deadbeef' }; },
    },
    identity: { chainPubkey: '02' + 'a'.repeat(64) },
  };
  return { client: new SphereClient(sphere, COIN, 'device-test', false), sphere };
};

console.log('════════ balance-outage unit proof (offline) ════════');

console.log('\n[0] the harness is sound: a funded wallet refunds normally');
{
  const { client, sphere } = makeClient(funded(100));
  ok((await client.spendableBase()) === base(100), 'a present row reads 100 UCT');
  const r = await client.refund(PAYER, base(4), 'overpayment');
  ok(sphere.payments.sends.length === 1, 'the refund really went out');
  ok(!r?.skipped && !r?.error, 'and reported no skip or error', r);
}

console.log('\n[1] AN OUTAGE IS NEVER BLAMED ON THE MIN-BALANCE FLOOR');
{
  const { client, sphere } = makeClient(OUTAGE);
  const r = await client.refund(PAYER, base(4), 'overpayment');
  ok(sphere.payments.sends.length === 0, 'the send is still withheld — it fails closed');
  ok(!!r?.skipped, 'and is reported as skipped, not as success', r);

  // These are the assertions that fail without the fix.
  ok(!claimsFloorBreach(r),
    'the reason is NOT a floor-breach verdict — we never learned our balance', r?.skipped);
  ok(/^balance unavailable/.test(String(r?.skipped ?? '')),
    'the reason leads with the balance being unavailable', r?.skipped);
}

console.log('\n[2] the skip is still a truthful refund outcome for the caller');
{
  // Mirrors `refundOutcome` in src/services/commands.js:65 — it is module-private,
  // so we restate the one branch that matters here rather than export it just for a
  // test. Any `skipped` string becomes {ok:false, why}, so the payer is told the
  // money is still owed. That was already correct before this fix; what changes is
  // that `why` is now a fact instead of a guess.
  const classify = (r) => {
    if (!r) return { ok: false, why: 'no result from the send' };
    if (r.unconfirmed) return { ok: false, unconfirmed: true, why: 'certification unconfirmed' };
    if (r.error) return { ok: false, why: String(r.error) };
    if (r.skipped) return { ok: false, why: String(r.skipped) };
    return { ok: true };
  };
  const { client } = makeClient(OUTAGE);
  const skipped = (await client.refund(PAYER, base(4), 'overpayment'))?.skipped;
  const classified = classify({ skipped });
  ok(classified.ok === false, 'classified as NOT ok, so nothing is claimed as refunded');
  ok(classified.why !== FLOOR_VERDICT,
    'and the reason handed to the payer does not invent a floor breach', classified.why);
}

console.log('\n[3] a real row saying 0 IS a floor breach — the fix is not a mask');
{
  const { client, sphere } = makeClient(funded(0));
  const r = await client.refund(PAYER, base(4), 'overpayment');
  ok(sphere.payments.sends.length === 0, 'still withheld');
  ok(claimsFloorBreach(r),
    'and NOW the floor is the honest verdict, because the backend answered', r?.skipped);
}

console.log('\n[4] a row for a DIFFERENT coin is treated as silence, not as zero');
{
  const { client } = makeClient(OTHER_COIN_ONLY);
  const r = await client.refund(PAYER, base(4), 'overpayment');
  ok(!claimsFloorBreach(r),
    'someone else\'s coin row does not become our balance', r?.skipped);
}

console.log('\n[5] a genuine floor breach on a funded wallet is still caught');
{
  const { client, sphere } = makeClient(funded(2));
  const floor = config.safety.minBalanceWhole;
  const r = await client.refund(PAYER, base(2), 'overpayment');
  ok(sphere.payments.sends.length === 0, `sending all 2 UCT would breach the ${floor} UCT floor`);
  ok(claimsFloorBreach(r), 'and is reported as exactly that', r?.skipped);
}

console.log('\n[6] BOOTSTRAP MINT never fires on an unanswered balance');
{
  const { client, sphere } = makeClient(OUTAGE);
  await client.bootstrapMintIfNeeded();
  ok(sphere.payments.mints === 0, 'no mint was attempted during an outage', sphere.payments.mints);
}

console.log('\n[7] but a real, genuinely empty wallet still bootstraps');
{
  const { client, sphere } = makeClient(funded(0));
  await client.bootstrapMintIfNeeded();
  ok(sphere.payments.mints === 1, 'the bootstrap still works when the backend answers 0', sphere.payments.mints);
}

console.log('\n[8] and a funded wallet is never re-minted');
{
  const { client, sphere } = makeClient(funded(100));
  await client.bootstrapMintIfNeeded();
  ok(sphere.payments.mints === 0, 'above the floor ⇒ no mint', sphere.payments.mints);
}

console.log(`\n  ${passed} passed, ${failed} failed`);
console.log(failed === 0
  ? '  ✅ ALL PASS — silence from the wallet-api is never read as a zero balance.'
  : '  ❌ FAILURES — an outage can still be mistaken for an empty wallet.');
process.exit(failed === 0 ? 0 : 1);
