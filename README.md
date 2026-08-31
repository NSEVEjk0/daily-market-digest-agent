# market-digest

A scheduled market-intelligence agent on Unicity **testnet2**. Twice a day it scans
the market, ranks the live intents it found, publishes a free teaser and sells the full
report. Attached to every full report is a secp256k1 signature over
`market-digest\n<issued-iso>\n<sha256(report)>` — a portable, timestamped assertion
that the board looked like *this* at *that* moment, checkable by anyone with the SDK's
`verifySignedMessage()` and no trust in the agent.

Which is why it also knows how to refuse:

```
Slot 2026-08-31@08:00: the market could not be read (recent-listings feed silent,
10/10 sweeps silent). Publishing nothing, signing nothing, and leaving the slot OPEN
so a later tick can serve it.
```

**Live as `@market-digest`**, corpus 100 UCT, slots 08:00 and 20:00.
Address: `DIRECT://0000f71f5f1c770100482e06cac3fa6c672b6995ad7556fca965346db25b7b5b120734b48b8b`
Chain pubkey: `02fb1491e118aed2dfa96f8602ba2f17c3df67b5ee614d095684b85876d01cdd13`

---

## Track

**Autonomous agents** — scheduled market intelligence

## Is it Agentic?

**Yes.** It decides when to run, what to scan, what to rank, what to publish, what to
sign, what to charge and — the interesting one — when to refuse. No human is in any of
those loops.

## Runs on AstridOS?

**No** — a Node.js daemon under `systemd` on Linux.

## SDK features used

| Sphere SDK feature | How it's used here |
|---|---|
| `market.getRecentListings` | the pulse read: what is newly on the board |
| `market.search` | ten semantic sweeps behind the ranking, 40 results wide each |
| `signMessage` / `verifySignedMessage` | the proof-of-time on every full report |
| `payments.requests` | how a report is sold — a request in the buyer's wallet, never a pull |
| `payments.send` | one rail only: refunding a buyer the agent could not serve |
| Broadcast + Direct Messages | the free teaser to the market, the paid report to a subscriber |
| Nametags | `@market-digest` |

---

## What makes it different

**`market.getRecentListings()` and `market.search()` fail soft.** An unreachable
market-api and an empty market are the *same value* at the call site. Read the silence
as data and the next digest reads "The market is quiet right now — no live intents
surfaced this round", gets signed, gets timestamped, gets broadcast publicly, and gets
sold for 5 UCT. Every word of it false, in a form the reader is invited to treat as
evidence. This was not hypothetical: the market-api was returning HTTP 000 fleet-wide
while this was written.

So this agent has **three states, not two**:

| State | What actually happened | What it does |
|---|---|---|
| **QUIET** | The board answered, and had nothing on it | Publish, sign, sell. "Empty" is a real observation and worth certifying. |
| **PARTIAL** | Some sweeps answered, some did not | Publish and sign — with a caveat naming how many reads failed, so the ranking is not passed off as the whole board |
| **BLIND** | Nothing answered at all | Publish nothing. Sign nothing. Sell nothing. **Leave the slot open.** |

The rule that separates them takes no arguments from the world:

```js
// src/market.js
export function reachOf({ pulseOk, seedsTried, seedsFailed }) {
  const seedsOk = Math.max(0, seedsTried - seedsFailed);
  const blind = !pulseOk && (seedsTried === 0 || seedsOk === 0);
  return { pulseOk: !!pulseOk, seedsTried, seedsFailed, seedsOk, blind,
           partial: !blind && (!pulseOk || seedsFailed > 0) };
}
```

Note what is *not* in that return value: any count of what was found. Reachability is
computed from **who answered**, never from how much they returned — the exact
distinction the fail-soft SDK erases. Every read reports `ok` alongside its data, so
`{ok: true, total: 0}` (a quiet board) and `{ok: false, total: 0}` (an outage) are
different values again.

**A blind round must not consume the slot.** `deliveredSlots` (keys like
`2026-08-31@08:00`) is the sole record that a scheduled digest has been served. The
tempting shape is "we tried, mark it done, move on" — which silently converts a
one-minute outage into a permanently lost publication, and makes `status` report a
digest that was never published. Instead: nothing is signed or sent, `lastDigest`
records `blind: true, hash: null` so `status` says the slot is still owed, the slot key
is **not** written, subscribers' own delivery markers are left alone, and the next tick
inside the 90-minute catch-up window retries it — firing exactly once when the board
answers.

`src/scheduler.js`, which decides all of this, imports **nothing**, contains no `await`
and never reads the clock: `now` is always passed in. That is what makes an outage
testable at a fixed instant.

**It gives money back when it cannot deliver.** A `digest` paid for during an outage is
refunded in full, and the reply says why:

> I could not read the market just now — neither the listings feed nor any sweep
> answered — so there is no honest full digest to send you, and I will not sign one.
> I've refunded your 5 UCT in full — nothing was charged.

A blind *subscription* purchase is refunded too, and creates **no subscription** — a
refunded payment that leaves an activated subscription behind is a free subscription
manufactured by an error path. The report is built *before* the subscriber row is
written. And a refund that itself fails is never reported as a refund: it is named,
booked as owed, and logged loudly for a human.

---

## What it costs

| Tier | Channel | What arrives |
|---|---|---|
| **Public teaser** | Broadcast, every run | Market pulse and a taste of the top listings — free |
| **Free preview** | DM `preview` | A fuller sample, with contacts withheld |
| **Full report** | DM `digest` — **5 UCT** | Every ranked intent with handles, prices, scores, plus the proof-of-time |
| **Subscription** | DM `subscribe <days>` — **3 UCT/day** | The full report every run until it lapses |

The agent never pulls funds; it replies with a payment request that sits in your wallet
until you approve it. Its only autonomous outbound payment is giving money back.

---

## Try it without a wallet

```bash
npm install && npm run demo
```

Drives the real scheduler, scan, ranker, signer, delivery lifecycle and ledger against
a **fake market and a fake wallet**. It does not import `sphere-client.js`, not even
transitively, so it cannot open a second connection on the live identity — safe to run
while the daemon is up.

- **Happy path** — a slot comes due, the board is scanned, the teaser is broadcast, the
  paid report is signed and delivered to a subscriber. The demo then verifies that proof
  itself, re-derives the sha256 from the delivered bytes, inflates one figure, and
  watches the hash stop matching. A second tick publishes nothing: the slot is spent.
- **Failure path** — the market-api goes dark. The next slot is blind: nothing
  published, nothing signed, nobody charged, **and the slot not consumed**. A buyer who
  paid mid-outage is refunded in full. Then the board answers and the same slot fires
  exactly once.

---

## Commands

DM `@market-digest`.

```
help · about · status          what it is, and whether the last slot actually published
preview                        a free sample of the current round
digest                         the full ranked report (5 UCT)
subscribe <days>               every run, delivered (3 UCT/day)
topics a, b, c                 personalize the sweeps behind your report
cancel                         stop a subscription
```

`status` is worth reading after an outage: it distinguishes *published*, *published but
flagged incomplete*, *published unsigned because the signer did not answer*, and *not
published — the market did not answer, so the slot is still owed*.

## Run it

```bash
npm install
cp .env.example .env      # optional — every value has a safe default

npm run doctor            # connectivity + config self-check
npm run preview           # render the current digest without publishing it
npm run run-now           # force one slot immediately
npm run demo              # offline walk-through (safe while running)
npm start                 # the autonomous daemon
npm test                  # 170 assertions, two offline suites
```

Node ≥ 22. First launch generates a BIP39 identity and claims the nametag; the phrase
prints once and lands in `wallet-data/` (gitignored, 0700/0600). There is no faucet on
testnet2 — `npm run mint` performs the one-time capped self-mint.

> Don't run `whoami`/`doctor` while the service is up — each opens a second connection
> on the same wallet. Use `journalctl -u market-digest-agent` or the DM `status`.
> `npm run demo` is the exception.

## Configuration

Every knob has a safe default. Full list in [`.env.example`](.env.example).

| Variable | Default | Meaning |
|---|---|---|
| `DIGEST_TIMES` | `08:00,20:00` | local-time slots the digest runs |
| `CATCHUP_GRACE_MIN` | `90` | how long an owed slot stays servable after its time |
| `DIGEST_TOPICS` | 10 seeds | the semantic sweeps behind the ranking |
| `SCAN_PER_SEED_LIMIT` | `40` | search width per sweep — wide, to get past stale index entries |
| `DIGEST_FEATURED_FULL` / `_FREE` | `8` / `3` | items in the paid report vs the free teaser |
| `DIGEST_MIN_SCORE` | `0.25` | relevance floor an intent must clear to be featured |
| `DIGEST_PRICE_UCT` | `5` | one-off price for the full report |
| `SUBSCRIBE_PRICE_PER_DAY_UCT` | `3` | subscription price per day |
| `BROADCAST_ENABLED` | `true` | `false` = build and sell, publish no public teaser |
| `DRY_RUN` | `false` | log every intended action, touch nothing |

## Structure

```
src/
  scheduler.js      PURE: slot keys, what is due, the catch-up window. No clock, no imports.
  market.js         the two market reads — each reporting whether it ANSWERED — plus reachOf()
  digest.js         the three renderings (teaser / preview / paid) + the proof-of-time signer
  state.js          crash-safe ledger: delivered slots, subscribers, pending orders, dedup rings
  services/
    delivery.js     scan → build → sign → broadcast → fan out; the blind-round refusal
    commands.js     the DM router, purchase settlement, and refuseBlind()
  sphere-client.js  SDK wiring, the wallet reads, the one outbound refund rail
  agent.js          the 1-minute tick: due slot? events? subscriptions to prune?
  demo.js           the offline walk-through
```

State is written temp-file-plus-rename. Inbound DM ids and transfer ids are
de-duplicated and persisted *before* they are acted on, so a relay replay cannot
double-charge or double-deliver.

## Tests

```bash
npm test   # 170 assertions across two offline suites — no network, no market, no wallet
```

| Suite | What it pins |
|---|---|
| `test-blind-digest-unit.mjs` | 121 assertions, **42 fail** if the blind-scan gate is reverted. An unreachable market is never rendered as a quiet one, never signed, never broadcast, never sold, and never counted as a delivered slot; a genuinely empty board still *is* published and signed. Also pins the proof-of-time format byte for byte, and asserts `scheduler.js`'s purity structurally — no imports, no `await`, no `Date.now()`. |
| `test-refund-truth-unit.mjs` | 49 assertions. Money is only ever *described* as returned when it actually went out: underpayment, overpayment and fulfilment failure each get the truthful reply, and a refund the wallet-api could not confirm is neither retried nor claimed. |

Suites that move real UCT are deliberately not published — they read a mnemonic.

## Verified on-network

12 scheduled slots published and signed for real, and one inbound UCT payment settled
— the schedule → scan → rank → sign → publish lifecycle, twelve times over, unattended.
The blind gate also fired in production: during a real market-api outage the 20:00 slot
was left open for the full 90-minute grace window rather than signing a false "quiet
market" report.

---

Owner / Creator: **Itachi** · Made by **CRYPTFRANI**
Runs on testnet2 with test-only UCT. Not financial software; provided as-is.
MIT — see [LICENSE](LICENSE).
