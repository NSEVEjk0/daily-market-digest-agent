/**
 * Daily Market Digest — market scanning & ranking
 * ────────────────────────────────────────────────────────────
 * Owner / Creator: Itachi
 * Made by CRYPTFRANI
 *
 * Two complementary reads of the Unicity market are fused here:
 *
 *   1. market.getRecentListings()  — a cheap public feed of the newest intents
 *      (title, type, author, timestamp). Great for a "market pulse": how busy
 *      is the board, what kinds of intents are flowing, what's freshest.
 *
 *   2. market.search(query)        — semantic search that returns *contactable*
 *      results (nametag/pubkey, price, contact handle, relevance score). This
 *      is what fills the ranked "featured" list people actually act on.
 *
 * We run a handful of broad seed queries, normalize + dedupe + score-filter the
 * hits, drop our own advert, and return a single ranked pool the digest slices.
 */

import { createLogger } from './logger.js';

const log = createLogger('market');

const DAY_MS = 86_400_000;

/** Normalize one semantic-search hit to the shape the digest speaks. */
function normalizeSearchHit(r) {
  return {
    id: r.id,
    score: typeof r.score === 'number' ? r.score : 0,
    nametag: (r.agentNametag || '').replace(/^@/, '') || null,
    pubkey: r.agentPublicKey || null,
    description: (r.description || '').trim(),
    type: r.intentType || 'intent',
    category: r.category || null,
    price: r.price ?? null,
    currency: r.currency || null,
    location: r.location || null,
    contact: r.contactHandle || r.contactMethod || null,
    createdAt: r.createdAt || null,
    expiresAt: r.expiresAt || null,
  };
}

function isExpired(intent, now) {
  if (!intent.expiresAt) return false;
  const t = Date.parse(intent.expiresAt);
  return Number.isFinite(t) && t <= now;
}

function ageDays(iso, now) {
  const t = Date.parse(iso);
  if (!Number.isFinite(t)) return Infinity;
  return (now - t) / DAY_MS;
}

/** Collapse near-identical listings (same text posted by many agents / bots). */
function normDesc(text) {
  return String(text || '').toLowerCase().replace(/\s+/g, ' ').trim().slice(0, 80);
}

/**
 * Given id-unique hits, collapse those with effectively the same description
 * into one representative (highest score wins), tagging how many similar copies
 * were folded in via `similarCount`. This is what stops the featured list from
 * being eight copies of the same bot listing — and the count is itself a signal.
 */
function collapseByDescription(hits) {
  const byText = new Map();
  for (const hit of hits) {
    const key = normDesc(hit.description);
    const prev = byText.get(key);
    if (!prev) {
      byText.set(key, { hit, count: 1 });
    } else {
      prev.count += 1;
      if (hit.score > prev.hit.score) prev.hit = hit;
    }
  }
  return [...byText.values()].map(({ hit, count }) => ({ ...hit, similarCount: count - 1 }));
}

/**
 * Run one semantic query and return normalized, self-excluded, score-filtered hits.
 * Mirrors the agent's proven supply-search shape: search → filter → dedupe → sort.
 */
export async function searchSupply(client, query, { limit = 8, minScore = 0, excludeKeys = new Set() } = {}) {
  let res;
  try {
    res = await client.sphere.market.search(query, { limit });
  } catch (err) {
    log.warn(`search("${query}") failed: ${err?.message ?? err}`);
    return [];
  }
  const now = Date.now();
  const self = client.selfPubkeys();
  const seen = new Set();
  const out = [];
  for (const raw of res?.intents ?? []) {
    const intent = normalizeSearchHit(raw);
    if (!intent.id || seen.has(intent.id)) continue;
    if (intent.score < minScore) continue;
    if (intent.pubkey && self.has(intent.pubkey)) continue; // our own listing
    if (intent.nametag && client.nametag && intent.nametag === client.nametag) continue;
    if (intent.pubkey && excludeKeys.has(intent.pubkey)) continue;
    if (isExpired(intent, now)) continue;
    seen.add(intent.id);
    out.push(intent);
  }
  out.sort((a, b) => b.score - a.score);
  return out;
}

/**
 * The public "pulse" from the recent-listings feed: totals, a per-type breakdown,
 * a freshness count, and the newest few headlines. Never throws — a market with
 * no public feed just yields zeros.
 */
export async function marketPulse(client, { freshWithinDays = 3 } = {}) {
  let listings = [];
  try {
    listings = (await client.sphere.market.getRecentListings()) ?? [];
  } catch (err) {
    log.warn(`getRecentListings failed: ${err?.message ?? err}`);
  }
  const now = Date.now();
  const self = client.selfPubkeys();
  const byType = {};
  let fresh = 0;
  const others = [];
  for (const l of listings) {
    // Best-effort self-exclusion (the feed exposes agentId, not a pubkey).
    if (client.nametag && l.agentName && l.agentName.replace(/^@/, '') === client.nametag) continue;
    if (l.agentId && self.has(l.agentId)) continue;
    byType[l.type] = (byType[l.type] || 0) + 1;
    if (ageDays(l.createdAt, now) <= freshWithinDays) fresh++;
    others.push(l);
  }
  others.sort((a, b) => (Date.parse(b.createdAt) || 0) - (Date.parse(a.createdAt) || 0));
  const newest = others.slice(0, 5).map((l) => ({
    title: (l.title || '').trim() || '(untitled)',
    type: l.type,
    agentName: (l.agentName || '').replace(/^@/, '') || null,
    ageHours: Math.max(0, Math.round(((now - (Date.parse(l.createdAt) || now)) / 3_600_000) * 10) / 10),
  }));
  return { total: others.length, byType, fresh, freshWithinDays, newest };
}

/**
 * Full market scan for a digest run. Fuses the pulse with a ranked, deduped,
 * cross-seed featured pool. Returns everything the digest builder needs.
 *
 * @param {object} client
 * @param {object} opts
 * @param {string[]} opts.seeds         broad seed queries to sweep
 * @param {number}   opts.perSeedLimit  results requested per seed
 * @param {number}   opts.minScore      relevance floor for featured items
 * @param {number}   opts.freshWithinDays
 * @param {number}   [opts.poolCap]     hard cap on the featured pool size
 */
export async function scanMarket(client, { seeds, perSeedLimit, minScore, freshWithinDays, poolCap = 24 }) {
  const pulse = await marketPulse(client, { freshWithinDays });

  // Sweep every seed, then merge on intent id keeping the highest score seen.
  const merged = new Map();
  for (const seed of seeds) {
    const hits = await searchSupply(client, seed, { limit: perSeedLimit, minScore });
    for (const hit of hits) {
      const prev = merged.get(hit.id);
      if (!prev || hit.score > prev.score) merged.set(hit.id, { ...hit, seed });
    }
  }

  const featured = collapseByDescription([...merged.values()])
    .sort((a, b) => b.score - a.score || (Date.parse(b.createdAt) || 0) - (Date.parse(a.createdAt) || 0))
    .slice(0, poolCap);

  log.info(
    `Scan complete: ${pulse.total} live listings, ${featured.length} ranked featured ` +
      `(from ${seeds.length} seeds, minScore ${minScore}).`,
  );

  return { pulse, featured, scannedAt: new Date().toISOString(), seeds: [...seeds] };
}

/**
 * Personalized featured pool for a subscriber's chosen topics. Sweeps the
 * subscriber's own topic queries; falls back to the shared featured pool when a
 * niche topic surfaces too little to be worth a bespoke section.
 */
export async function scanForTopics(client, topics, { perSeedLimit, minScore, fallback = [] }) {
  if (!Array.isArray(topics) || topics.length === 0) return fallback;
  const merged = new Map();
  for (const topic of topics) {
    const hits = await searchSupply(client, topic, { limit: perSeedLimit, minScore });
    for (const hit of hits) {
      const prev = merged.get(hit.id);
      if (!prev || hit.score > prev.score) merged.set(hit.id, hit);
    }
  }
  const personalized = collapseByDescription([...merged.values()]).sort((a, b) => b.score - a.score);
  return personalized.length ? personalized : fallback;
}

export default { scanMarket, marketPulse, searchSupply, scanForTopics };
