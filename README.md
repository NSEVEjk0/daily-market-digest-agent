# Daily Market Digest 📊

**An autonomous market-intelligence agent for the [Unicity](https://unicity.network) testnet2 network.**

**Track:** Autonomous agents — market intelligence and subscriptions
**Agentic:** Yes — it scans, ranks, publishes and bills on a schedule of its own, with no human in the loop
**Runs on AstridOS:** No — a Node.js daemon under `systemd` on Linux
**Status:** Live on testnet2 as `@market-digest`, holding 100 UCT. Verified end-to-end on-network: 12 digest slots published on schedule, and a paid subscription taken and served for real UCT. The overpayment-refund path is pinned by an offline suite of 49 assertions rather than claimed on-network.
**SDK:** `@unicitylabs/sphere-sdk` ^0.15.0 (`state-transition-sdk` 3.x)

Built on the official [`@unicitylabs/sphere-sdk`](https://www.npmjs.com/package/@unicitylabs/sphere-sdk). `Daily Market Digest` claims the nametag **`@market-digest`**, lives on the network continuously as a background daemon, and — twice a day, on its own — scans the live market, ranks the most interesting intents, and publishes a digest: a free public teaser for everyone, and a full ranked report with contacts and prices for paying subscribers.

> **Owner / Creator:** Itachi &nbsp;·&nbsp; **Made by CRYPTFRANI**
>
> **Live agent address:** `DIRECT://0000f71f5f1c770100482e06cac3fa6c672b6995ad7556fca965346db25b7b5b120734b48b8b`

---

## What it does

`Daily Market Digest` is a good citizen of the Unicity **market** (a signed, semantic intent bulletin board). On a fixed schedule it fuses two reads of the market into one report, then delivers that report across a free and a paid tier.

### 1. The scan (twice daily, automatic)
- **Market pulse** — a cheap public read (`market.getRecentListings`) of the newest intents: how busy the board is, what kinds of intents are flowing, what's freshest.
- **Featured intents** — broad semantic sweeps (`market.search`) across a spread of seed queries surface *contactable* results: nametag, price, relevance score. These are ranked, de-duplicated (near-identical bot listings collapse into one, flagged with a bulk-supply count), self-excluded, and expiry-filtered into a single ranked pool.

### 2. Delivery — a free tier and a paid tier

| Tier | Channel | What you get |
|---|---|---|
| **Public teaser** | Broadcast channel, every run | Market pulse + a taste of the top listings — free for everyone |
| **Free preview** | DM `preview` | A fuller free sample: pulse, newest headlines, top matches (contacts/prices withheld) |
| **Full report** | DM `digest` — **5 UCT** | The complete ranked report: every featured intent with **contact handles, prices, categories, relevance**, plus a signed **proof-of-time** |
| **Subscription** | DM `subscribe <days>` — **3 UCT/day** | The full report auto-delivered every run until your subscription expires |

**Free DM commands:** `help` · `about` · `status` · `preview` · `topics <a,b,c>` (personalize a subscription) · `cancel`.

**Paid flow:** send `digest` or `subscribe <days>` → the agent replies with a **payment request** → you pay it → your report returns automatically over DM. Overpayment is **auto-refunded**; underpayment is refunded in full with an invitation to retry. The agent never holds your funds.

### 3. Proof-of-time (verifiable)
Every full report carries a secp256k1 signature over `market-digest\n<iso-time>\n<sha256(report)>`. Anyone can verify — with `verifySignedMessage()` from the SDK — that this exact digest existed at that time and was issued by `@market-digest`. The report is portable, tamper-evident evidence, not just text.

### 4. Conservative by design
- **Earn-only money policy** — the agent only *requests* and *receives* UCT. The single autonomous outbound payment it will ever make is **refunding an overpayment**. Its balance can only grow.
- Hard **rate limits** (DMs/hour, actions/hour, fan-out/run), a **minimum-balance floor**, and a global **`DRY_RUN`** kill-switch.
- **Idempotent & crash-safe** — atomic on-disk state with per-slot delivery keys and dedup rings; a restart never double-charges, double-delivers, or re-runs a slot it already served.
- **Light footprint** — event-driven where possible, gentle polling, minimal CPU/RAM. Safe to run beside other nodes on a modest VPS.

---

## Install & run (testnet2)

> Requires **Node.js ≥ 22** (native `WebSocket` + `fetch`, used by the SDK's live market feed).

```bash
git clone https://github.com/NSEVEjk0/daily-market-digest-agent.git
cd daily-market-digest-agent
npm install

# Configure (all values have safe defaults)
cp .env.example .env        # optional; edit if you want to override anything

# Inspect identity + balance without starting the loop
npm run whoami

# Preview all three renderings (teaser / preview / full) without publishing
npm run preview

# Start the autonomous agent
npm start
```

First launch generates a brand-new identity, registers `@market-digest`, and (unless disabled) performs a **one-time capped self-mint** of test UCT — testnet2 has no faucet.

### Commands
| Command | What it does |
|---|---|
| `npm start` | Run the autonomous agent loop |
| `npm run whoami` | Print identity, address, nametag and balance, then exit |
| `npm run doctor` | Connectivity / config self-check, then exit |
| `npm run mint` | Manually trigger a capped self-mint, then exit |
| `npm run preview` | Build & print a digest (all three renderings), then exit |
| `npm run run-now` | Generate + publish a digest immediately (out of schedule), then exit |

---

## Configuration

All settings are environment variables resolved in [`src/config.js`](src/config.js); every one has a safe default. See [`.env.example`](.env.example) for the full annotated list. The most common:

| Variable | Default | Meaning |
|---|---|---|
| `AGENT_NAME` | `market-digest` | Nametag to claim (alias: `NAMETAG`) |
| `UNICITY_NETWORK` | `testnet2` | Network to run against (alias: `NETWORK`) |
| `DIGEST_TIMES` | `08:00,20:00` | Local-time slots when the digest runs |
| `DIGEST_PRICE_UCT` | `5` | One-time price for the full report |
| `SUBSCRIBE_PRICE_PER_DAY_UCT` | `3` | Subscription price per day |

---

## Deployment — systemd (background daemon)

`Daily Market Digest` is designed to run as a persistent, auto-restarting service.

**`/etc/systemd/system/market-digest-agent.service`**

| Setting | Value |
|---|---|
| `WorkingDirectory` | `/root/market-digest-agent` |
| `ExecStart` | `/usr/bin/node --max-old-space-size=500 src/index.js` |
| `Restart` / `RestartSec` | `always` / `5s` |
| `Environment` | `NODE_ENV=production`, `NODE_OPTIONS=--max-old-space-size=500` |
| V8 heap cap | ~500 MB (`--max-old-space-size=500`) |
| `MemorySwapMax` | `5G` — physical RAM left uncapped so the kernel pages to swap under load instead of OOM-killing the process |
| `KillSignal` | `SIGINT` → triggers graceful shutdown (persist state → close connection) |
| Logs | journald → `journalctl -u market-digest-agent -f` |

```bash
sudo systemctl daemon-reload
sudo systemctl enable --now market-digest-agent
systemctl status market-digest-agent
journalctl -u market-digest-agent -f       # live logs
```

> Tip: for a running service, inspect it with `journalctl` / `systemctl status`. Run `npm run whoami` / `doctor` / `preview` only while the service is **stopped**, or they open a second connection as `@market-digest`.

---

## Identity & the mnemonic — read this

On first run the agent creates a wallet and prints a **BIP39 recovery phrase (mnemonic)** once, then writes it to `wallet-data/`.

- **`wallet-data/` is gitignored and must stay secret.** It contains the mnemonic and derived keys — anyone with it controls `@market-digest` and its funds.
- Set **`WALLET_PASSWORD`** in `.env` to encrypt the mnemonic at rest (PBKDF2). Without it, the phrase is stored in plaintext (fine for a throwaway testnet identity, risky on a shared box).
- **Back up the phrase** shown on first run somewhere safe and offline. It is the only way to recover the identity if `wallet-data/` is lost.
- To start over with a fresh identity, stop the agent and delete `wallet-data/`.

---

## Rewards & ownership → Itachi / CRYPTFRANI

`@market-digest` is a service run **by Itachi under the CRYPTFRANI banner**. Its identity metadata, its advertised market intent, and every public-facing message it sends attribute it to CRYPTFRANI, and every unit of UCT it earns (report sales, subscriptions, tips) accrues to **this single wallet — owned and controlled by Itachi**. There is no separate treasury or split: the agent *is* the CRYPTFRANI-owned wallet, so rewards flow directly and verifiably back to its owner.

---

## Project structure

```
daily-market-digest-agent/
├── package.json
├── .env.example          # annotated settings
├── .gitignore
├── README.md
└── src/
    ├── index.js          # entrypoint: boot, modes (--whoami/--doctor/--mint/--preview/--run-now), graceful shutdown
    ├── config.js         # env-based settings + safety rails
    ├── logger.js         # lightweight leveled logger
    ├── state.js          # persisted state (dedup rings, pending purchases, subscribers)
    ├── ratelimit.js      # sliding-window rate limiter (polite, no timers)
    ├── scheduler.js      # pure slot math: due/next slot, catch-up, pretty stamps
    ├── sphere-client.js  # identity/wallet setup, providers, balance, mint, refunds
    ├── market.js         # market scan: pulse + semantic sweep, rank, de-dupe
    ├── digest.js         # report builder: teaser / preview / full + proof-of-time
    ├── agent.js          # the autonomous loop + event wiring
    └── services/
        ├── delivery.js   # scan → build → sign → broadcast → fan-out to subscribers
        └── commands.js   # DM commands + purchase / subscription fulfilment & refunds
```

---

## Tests

```bash
npm test
```

Two offline suites, 66 assertions, no network, wallet or funds:

`test-refund-truth-unit.mjs` — 49 assertions, 23 of which fail without the fix. It pins the
rule that the agent **never claims a refund that did not go out**, and never returns money
silently: `help` and `about` both promise in writing that overpayment comes back, so an
unannounced *successful* refund is an unexplained transfer, and an unannounced *failed* one
is the difference quietly kept. An unconfirmed certification is its own third answer — never
retried, never claimed.

`test-balance-outage-unit.mjs` — 17 assertions, 5 of which fail without the fix. It pins the
rule that a wallet-api outage is **never read as a zero balance**. `payments.assets()`
resolves with an empty array when the backend is unreachable rather than throwing, so at the
call site an outage and an empty wallet look identical. Two things went wrong on that: a
withheld refund blamed the min-balance floor when the wallet in fact held funds, and the
one-time bootstrap would have fired a *second* self-mint onto an already-funded wallet. The
send still fails closed — it just says why truthfully now.

The suites that move real UCT are deliberately **not** published: they embed an oracle
API key and read a wallet mnemonic. `.gitignore` keeps `test-*.mjs` ignored by default and
negates only the offline ones, so a new live test stays private unless someone opts it in.

---

## Disclaimer

Runs on **testnet2** with test-only UCT. Not financial software; provided as-is for experimentation on the Unicity network.

---

## License

MIT © Itachi (CRYPTFRANI) — see [LICENSE](LICENSE).

---

<div align="center">

**Made by CRYPTFRANI** · Agent owner/creator: **Itachi**

</div>
