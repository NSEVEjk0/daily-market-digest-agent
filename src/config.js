/**
 * Daily Market Digest — central configuration
 * ────────────────────────────────────────────────────────────
 * Owner / Creator: Itachi
 * Made by CRYPTFRANI
 *
 * All runtime settings live here. Values come from environment variables
 * (optionally loaded from a local .env file), each with a safe default.
 * The exported object is frozen so nothing mutates config at runtime.
 */

import { createLogger } from './logger.js';

const log = createLogger('config');

// Load .env if present (Node >=20.12). Never fatal if the file is missing.
try {
  process.loadEnvFile(process.env.ENV_FILE || '.env');
} catch {
  // No .env file — rely on real environment variables and defaults.
}

// ── small typed env helpers ────────────────────────────────────────────────
const str = (key, def) => {
  const v = process.env[key];
  return v === undefined || v === '' ? def : v;
};
const int = (key, def) => {
  const v = process.env[key];
  if (v === undefined || v === '') return def;
  const n = Number.parseInt(v, 10);
  if (!Number.isFinite(n)) {
    log.warn(`Invalid integer for ${key}="${v}", using default ${def}`);
    return def;
  }
  return n;
};
const num = (key, def) => {
  const v = process.env[key];
  if (v === undefined || v === '') return def;
  const n = Number.parseFloat(v);
  if (!Number.isFinite(n)) {
    log.warn(`Invalid number for ${key}="${v}", using default ${def}`);
    return def;
  }
  return n;
};
const bool = (key, def) => {
  const v = process.env[key];
  if (v === undefined || v === '') return def;
  return /^(1|true|yes|on)$/i.test(v.trim());
};
const list = (key, def) => {
  const v = process.env[key];
  if (v === undefined || v === '') return def;
  const parts = v
    .split(',')
    .map((s) => s.trim())
    .filter(Boolean);
  return parts.length ? parts : def;
};

/** Parse "HH:MM,HH:MM" into sorted unique minutes-of-day. Invalid entries are dropped. */
function parseTimes(raw, def) {
  const source = raw === undefined || raw === '' ? def : raw;
  const mins = String(source)
    .split(',')
    .map((s) => s.trim())
    .filter(Boolean)
    .map((hhmm) => {
      const m = /^(\d{1,2}):(\d{2})$/.exec(hhmm);
      if (!m) return null;
      const h = Number.parseInt(m[1], 10);
      const min = Number.parseInt(m[2], 10);
      if (h < 0 || h > 23 || min < 0 || min > 59) return null;
      return h * 60 + min;
    })
    .filter((x) => x != null);
  const uniqueSorted = [...new Set(mins)].sort((a, b) => a - b);
  return uniqueSorted.length ? uniqueSorted : parseTimes(def, def);
}

// Nametag: strip a leading '@' and lowercase, since the SDK expects the bare form.
// AGENT_NAME is the documented alias for NAMETAG (AGENT_NAME wins if both are set).
const rawNametag = str('AGENT_NAME', str('NAMETAG', 'market-digest'))
  .replace(/^@/, '')
  .trim()
  .toLowerCase();

const config = Object.freeze({
  // ── Identity / branding ──────────────────────────────────────────────────
  nametag: rawNametag,
  owner: 'Itachi',
  brand: 'CRYPTFRANI',

  // ── Storage ────────────────────────────────────────────────────────────
  walletDir: str('WALLET_DIR', './wallet-data'),
  walletFileName: str('WALLET_FILE', 'wallet.json'),
  password: str('WALLET_PASSWORD', undefined), // undefined => plaintext on disk

  // ── Network (testnet2) ───────────────────────────────────────────────────
  network: str('UNICITY_NETWORK', str('NETWORK', 'testnet2')), // UNICITY_NETWORK is the documented alias
  oracleApiKey: str('ORACLE_API_KEY', 'sk_ddc3cfcc001e4a28ac3fad7407f99590'),
  walletApiUrl: str('WALLET_API_URL', 'https://wallet-api.unicity.network'),
  coinSymbol: str('COIN_SYMBOL', 'UCT'),

  // ── Schedule — when the digest is generated & published ──────────────────
  schedule: Object.freeze({
    // Local-time HH:MM slots, comma-separated. Default: twice daily (08:00, 20:00).
    times: parseTimes(process.env.DIGEST_TIMES, '08:00,20:00'),
    // How often the scheduler wakes to check whether a slot is due (ms).
    tickMs: int('SCHEDULE_TICK_MS', 60_000),
    // On boot, if the most recent slot was missed by <= this many minutes, run it
    // once to catch up (crash/restart resilience). 0 disables catch-up.
    catchUpGraceMin: int('CATCHUP_GRACE_MIN', 90),
    // Cadence for the DM-command / payment safety-net receive() poll (ms).
    receivePollMs: int('RECEIVE_POLL_MS', 45_000),
  }),

  // ── Market scan — how the digest is built ────────────────────────────────
  scan: Object.freeze({
    // Broad semantic seeds used to surface *contactable* featured intents.
    // A wide spread across categories: generic supply/demand plus the specific
    // service verticals that are actually active on-chain (escrow, swaps, data,
    // compute). Each seed is a single search call, so breadth is cheap.
    seedQueries: Object.freeze(
      list('DIGEST_TOPICS', [
        'services',
        'for sale',
        'looking for',
        'hiring',
        'wanted',
        'trade',
        'escrow',
        'swap',
        'data',
        'compute',
      ]),
    ),
    // Per-seed search width and how many featured items make the full digest.
    // Pulled deliberately wide: the search index carries many high-scoring but
    // expired test listings, so a shallow pull buries the genuinely-live ones.
    // Width costs nothing extra (one call per seed) — we just filter deeper.
    perSeedLimit: int('SCAN_PER_SEED_LIMIT', 40),
    featuredFull: int('DIGEST_FEATURED_FULL', 8), // items in the paid full digest
    featuredFree: int('DIGEST_FEATURED_FREE', 3), // items in the free teaser
    // Minimum semantic score for a featured item to be considered relevant.
    // Testnet relevance scores cluster ~0.28–0.55, so this floor is deliberately
    // modest; ranking + de-duplication do the quality work above it.
    minScore: num('DIGEST_MIN_SCORE', 0.25),
    // Ignore listings older than this many days when rating "freshness".
    freshWithinDays: int('DIGEST_FRESH_DAYS', 3),
  }),

  // ── Economic safety rails ────────────────────────────────────────────────
  safety: Object.freeze({
    dryRun: bool('DRY_RUN', false),
    // Whole-UCT floor the agent will never spend below.
    minBalanceWhole: num('MIN_BALANCE', 1),
    selfMintEnabled: bool('SELF_MINT_ENABLED', true),
    selfMintAmountWhole: num('SELF_MINT_AMOUNT', 100),
    // Earn-only policy: the ONLY autonomous outbound payment is refunding overpayment.
    autoRefundOverpayment: bool('AUTO_REFUND_OVERPAYMENT', true),
    // Politeness / anti-spam limits.
    maxDmsPerHour: int('MAX_DMS_PER_HOUR', 40),
    maxActionsPerHour: int('MAX_ACTIONS_PER_HOUR', 80),
    // Upper bound on subscriber fan-out DMs per digest run (protects the relay).
    maxFanoutPerRun: int('MAX_FANOUT_PER_RUN', 30),
  }),

  // ── Pricing (paid full digest) ───────────────────────────────────────────
  pricing: Object.freeze({
    // One-time price for the full digest delivered now.
    oneTimeWhole: num('DIGEST_PRICE_UCT', num('TASK_PRICE', 5)),
    // Per-day price for a subscription (full digest auto-DM'd every run).
    perDayWhole: num('SUBSCRIBE_PRICE_PER_DAY_UCT', 3),
    // Clamp on subscription length so a fat-fingered "subscribe 9999" can't run away.
    maxSubDays: int('MAX_SUB_DAYS', 60),
  }),

  // ── Public advert / broadcast (the free tier) ────────────────────────────
  publish: Object.freeze({
    // Emit a public teaser to the broadcast channel each run.
    broadcastEnabled: bool('BROADCAST_ENABLED', true),
    // Tags attached to the broadcast so subscribers can filter for it.
    broadcastTags: Object.freeze(list('BROADCAST_TAGS', ['digest', 'market', 'unicity'])),
    // Keep a standing `service` intent advertising the digest on the market board.
    serviceIntentEnabled: bool('SERVICE_INTENT_ENABLED', true),
    intentExpiresInDays: int('INTENT_EXPIRES_DAYS', 7),
    serviceDescription: str(
      'SERVICE_DESCRIPTION',
      'Daily Market Digest: a twice-daily ranked digest of the most interesting live intents ' +
        'on the Unicity market. DM @market-digest `preview` for a free sample, or `digest` for ' +
        'the full detailed report. Run by CRYPTFRANI.',
    ),
  }),

  logLevel: str('LOG_LEVEL', 'info'),
});

export default config;
