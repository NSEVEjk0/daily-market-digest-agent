# market-digest

### It signs what it saw. When it cannot see, it publishes nothing and says so.

```
Slot 2026-08-31@08:00: the market could not be read (recent-listings feed silent,
10/10 sweeps silent). Publishing nothing, signing nothing, and leaving the slot OPEN
so a later tick can serve it.
```

That is the whole product, stated as a refusal. `@market-digest` scans the Unicity
testnet2 market twice a day and publishes a ranked digest of live intents, free to
everyone and in full to subscribers. Attached to every full report is a secp256k1
signature over `market-digest\n<issued-iso>\n<sha256(report)>` — a portable,
timestamped assertion that the board looked like *this* at *that* moment, checkable
by anyone with the SDK's `verifySignedMessage()` and no trust in the agent.

Which makes one SDK behaviour load-bearing here in a way it is not anywhere else in
the fleet: **`market.getRecentListings()` and `market.search()` fail soft.** An
unreachable market-api and an empty market are the *same value* at the call site.
Read the silence as data and the next digest reads "The market is quiet right now —
no live intents surfaced this round", gets signed, gets timestamped, gets broadcast
publicly, and gets sold for 5 UCT. Every word of it false, in a form the reader is
invited to treat as evidence.

This was not hypothetical. The market-api was returning HTTP 000 fleet-wide while
this was written.

| | |
|---|---|
| **Submission track** | **Autonomous agents** — scheduled market intelligence |
| **Agentic** | Yes. It decides when to run, what to scan, what to rank, what to publish, what to sign, what to charge, and — the interesting one — when to refuse. No human is in any of those loops. |
| **Runs on AstridOS** | No — a Node.js daemon under `systemd` on Linux |
| **Live on** | Unicity **testnet2** as `@market-digest`, corpus 100 UCT |
| **Address** | `DIRECT://0000f71f5f1c770100482e06cac3fa6c672b6995ad7556fca965346db25b7b5b120734b48b8b` |
| **Chain pubkey** | `02fb1491e118aed2dfa96f8602ba2f17c3df67b5ee614d095684b85876d01cdd13` |
| **SDK** | `@unicitylabs/sphere-sdk` ^0.15.0 (`state-transition-sdk` 3.x) |
| **Verified on-network** | 12 scheduled slots published and signed for real, one inbound UCT payment settled, one subscriber on the book — the schedule → scan → rank → sign → publish → fan-out lifecycle end to end |
| **Owner / Creator** | Itachi · Made by **CRYPTFRANI** |

---

## Three states, not two

Most agents that read a feed have two outcomes: it worked, or it threw. This one has
three, because a signature makes the difference expensive.

| State | What actually happened | What the agent does |
|---|---|---|
| **QUIET** | The board answered, and had nothing on it | Publish it, sign it, sell it. "Empty" is a real observation and worth certifying. |
| **PARTIAL** | Some sweeps answered, some did not | Publish and sign — with a caveat in the body naming how many reads failed, so the ranking is not passed off as the whole board |
| **BLIND** | Nothing answered at all | Publish nothing. Sign nothing. Sell nothing. **Leave the slot open.** |

The rule that separates them is eight lines and takes no arguments from the world:

```js
// src/market.js
export function reachOf({ pulseOk, seedsTried, seedsFailed }) {
  const seedsOk = Math.max(0, seedsTried - seedsFailed);
  const blind = !pulseOk && (seedsTried === 0 || seedsOk === 0);
  return { pulseOk: !!pulseOk, seedsTried, seedsFailed, seedsOk, blind,
           partial: !blind && (!pulseOk || seedsFailed > 0) };
}
```

Note what is *not* in that return value: any count of what was found. Reachability
is computed from **who answered**, never from how much they returned — which is the
entire distinction the fail-soft SDK erases. Every read in `market.js` now reports
`ok` alongside its data, so `{ok: true, total: 0}` (a quiet board) and
`{ok: false, total: 0}` (an outage) are different values again.

---

## The slot is the only thing that remembers a report is owed

`deliveredSlots` is a set of keys like `2026-08-31@08:00`. It is the sole record that
a scheduled digest has been served, and the sole thing standing between one slot and
two digests.

So a blind round has to be careful in a way that is easy to get backwards. The
tempting shape is "we tried, mark it done, move on". That silently converts a
one-minute outage into a permanently lost publication — and `status` then reports a
digest that was never published. Instead:

- nothing is broadcast, nothing is DMed, nothing is signed;
- `lastDigest` records `blind: true, hash: null`, so `status` says the slot is still owed;
- the slot key is **not** written;
- the next tick inside the catch-up grace window (90 min by default) retries it, and
  it fires exactly once when the board answers.

Subscribers' own `lastDeliveredSlot` markers are left alone for the same reason. A
blind round costs nobody a delivery.

The scheduler that decides all of this (`src/scheduler.js`) imports **nothing** —
not config, not state, not the SDK — contains no `await` and never reads the clock
itself: `now` is always passed in. That is what makes the blackout in the demo
testable at a fixed instant on a fixed date.

---

## What it costs, and what happens when it cannot be built

| Tier | Channel | What arrives |
|---|---|---|
| **Public teaser** | Broadcast, every run | Market pulse and a taste of the top listings — free |
| **Free preview** | DM `preview` | A fuller sample: pulse, newest headlines, top matches with contacts withheld |
| **Full report** | DM `digest` — **5 UCT** | Every ranked intent with handles, prices, categories, relevance scores, plus the proof-of-time |
| **Subscription** | DM `subscribe <days>` — **3 UCT/day** | The full report every run until it lapses; `topics a,b,c` personalizes the sweeps |

The agent never pulls funds. It replies with a **payment request** that sits in your
wallet until you approve it. Its only autonomous outbound payment is giving money
back.

**And it gives money back when it cannot deliver.** A `digest` paid for during an
outage is refunded in full, and the reply says why:

> I could not read the market just now — neither the listings feed nor any sweep
> answered — so there is no honest full digest to send you, and I will not sign one.
> I've refunded your 5 UCT in full — nothing was charged.

Not "here is a page explaining that I am blind, that will be 5 UCT". A blind
subscription purchase is refunded too — and creates **no subscription**, because a
refunded payment that leaves an activated subscription behind is a free subscription
manufactured by an error path. That ordering is a fix, not an accident: the report is
built *before* the subscriber row is written.

A refund that itself fails is never reported as a refund. It is named, booked as
owed, and logged loudly for a human — the same contract as the overpayment path,
pinned by its own suite.

---

## See it refuse, in one command

```bash
npm install
npm run demo
```

The walk-through drives the real scheduler, the real scan, the real ranker, the real
signer, the real delivery lifecycle and the real ledger against a **fake market and
a fake wallet**. It does not import `sphere-client.js`, not even transitively, so it
cannot open a second connection on the live identity even by mistake — safe to run
while the daemon is up, unlike `whoami`.

- **Happy path** — a slot comes due, the board is scanned, the teaser is broadcast,
  the paid report is signed and delivered to a subscriber. The demo then verifies
  that proof itself, re-derives the sha256 from the delivered bytes, inflates one
  figure in the report, and watches the hash stop matching. A second tick publishes
  nothing, because the slot is spent.
- **Failure path** — the market-api goes dark. The next slot is blind: nothing
  published, nothing signed, nobody charged, **and the slot not consumed**. A buyer
  who paid mid-outage is refunded in full. Then the board answers and the same slot
  fires exactly once.

It closes by counting every claim it made and what backed each one.

---

## The DM surface

```
help · about · status          what it is, and whether the last slot actually published
preview                        a free sample of the current round
digest                         the full ranked report (5 UCT)
subscribe <days>               every run, delivered (3 UCT/day)
topics a, b, c                 personalize the sweeps behind your report
cancel                         stop a subscription
```

`status` is worth reading after an outage: it distinguishes *published*, *published
but flagged incomplete*, *published unsigned because the signer did not answer*, and
*not published — the market did not answer, so the slot is still owed*.

---

## Running it

```bash
npm install
cp .env.example .env      # optional — every value has a safe default

npm run doctor            # connectivity + config self-check
npm run whoami            # identity, address, balance
npm run preview           # build all three renderings, publish nothing
npm run run-now           # publish immediately, out of schedule
npm run demo              # the offline walk-through (safe while running)
npm start                 # the autonomous daemon

npm test                  # two offline suites, 170 assertions
```

Node ≥ 22 (the SDK's live market feed needs native `WebSocket`/`fetch`). First launch
generates a BIP39 identity, claims the nametag, and performs a **one-time capped
self-mint** — testnet2 has no faucet. The phrase prints once and lands in
`wallet-data/` (gitignored, 0600): back it up offline, set `WALLET_PASSWORD` to
encrypt it at rest, delete the directory to start over.

> Do not run `whoami`/`doctor`/`preview` while the service is up — each boots a
> second Sphere instance on the same wallet. Use `journalctl -u market-digest-agent`
> or the DM `status`. `npm run demo` is the exception: it never opens a connection.

### As a service

```ini
# /etc/systemd/system/market-digest-agent.service
[Service]
WorkingDirectory=/root/market-digest-agent
ExecStart=/usr/bin/node --max-old-space-size=500 src/index.js
Restart=always
RestartSec=5
KillSignal=SIGINT        # graceful: stop timers → persist state → close socket
MemoryAccounting=yes
MemorySwapMax=5G         # RAM uncapped so the kernel never cgroup-OOMs it; swap bounded
```

```bash
sudo systemctl daemon-reload && sudo systemctl enable --now market-digest-agent
journalctl -u market-digest-agent -f
```

### Configuration

Every knob has a conservative default, so an absent `.env` still runs a valid agent.
Full annotated list in [`.env.example`](.env.example); the ones that change what it
publishes:

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

---

## Files

```
src/
  scheduler.js      PURE: slot keys, what is due, the catch-up window. No clock, no imports.
  market.js         the two market reads — each reporting whether it ANSWERED, plus reachOf()
  digest.js         the three renderings (teaser / preview / paid) + the proof-of-time signer
  state.js          crash-safe ledger: delivered slots, subscribers, pending orders, dedup rings
  services/
    delivery.js     scan → build → sign → broadcast → fan out; the blind-round refusal
    commands.js     the DM router, purchase settlement, and refuseBlind()
  sphere-client.js  SDK wiring, the wallet reads, the one outbound refund rail
  agent.js          the 1-minute tick: due slot? events? subscriptions to prune?
  demo.js           the offline walk-through (real engine, fake market)
  config.js  logger.js  ratelimit.js  index.js
wallet-data/        mnemonic + state.json — GITIGNORED, 0700/0600
```

State is written temp-file-plus-rename, so a crash mid-write cannot truncate the
ledger. Inbound DM ids and transfer ids are de-duplicated and persisted *before*
they are acted on, so a relay replay cannot double-charge or double-deliver.

## Proof it holds

```bash
npm test
```

**170 assertions across two offline suites** — no network, no market, no wallet, no
funds.

| Suite | What it pins |
|---|---|
| `test-blind-digest-unit.mjs` | 121 assertions, **42 of which fail** if the blind-scan gate is reverted. An unreachable market is never rendered as a quiet one, never signed, never broadcast, never sold, and never counted as a delivered slot; a genuinely empty board still *is* published and signed, because "the board was empty" is a real observation. Also pins the proof-of-time format byte for byte, and asserts `scheduler.js`'s purity structurally — no imports, no `await`, no `Date.now()`. |
| `test-refund-truth-unit.mjs` | 49 assertions. Money is only ever *described* as returned when it actually went out: underpayment, overpayment and fulfilment failure each get the truthful reply, and a refund the wallet-api could not confirm is neither retried nor claimed. |

The suites that move real UCT are deliberately **not** published — they embed an
oracle API key and read a mnemonic. `.gitignore` ignores `test-*.mjs` by default and
negates only the two offline files, so a new live test stays private unless somebody
opts it in.

---

## Sibling agents (CRYPTFRANI fleet, testnet2)

This is the fleet's **publisher**: the only one whose output is a signed claim about
the outside world rather than about its own dealings. That is why it is the only one
that has to reason about what it could not see.

| Agent | Primitive |
|---|---|
| **@market-digest** | a schedule and a signed report — this one |
| **@frani-treasury** | grants, loans, repayment reputation |
| **@frani-agent** | market discovery and standing watches (no send path exists at all) |
| **@frani-agora** | signed quote → invoice → settlement certificate |
| **@frani-bounty** | bounty escrow, poster vs worker |

---

Runs on **testnet2** with test-only UCT. Not financial software; provided as-is.

MIT © Itachi (CRYPTFRANI) — see [LICENSE](LICENSE).
