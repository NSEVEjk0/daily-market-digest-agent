/**
 * Daily Market Digest — lightweight persisted state
 * ────────────────────────────────────────────────────────────
 * Owner / Creator: Itachi
 * Made by CRYPTFRANI
 *
 * A tiny JSON-backed store in wallet-data/state.json. It keeps just enough
 * across restarts to behave correctly and idempotently:
 *   • seenDmIds / seenTransferIds — dedup rings (relays replay; events double-fire)
 *   • pendingPurchases            — paid orders awaiting payment, keyed by requester
 *   • subscribers                 — active subscriptions (expiry + topic prefs)
 *   • deliveredSlots              — digest slots already published (never double-run)
 *   • serviceIntentId             — the standing market advert we published
 *   • lastDigest                  — summary of the most recent run (for `status`)
 *
 * Everything is capped so the file (and memory) stay small on a shared VPS.
 * Writes are atomic (temp file + rename) so a crash mid-write can't corrupt it.
 */

import { existsSync, readFileSync, writeFileSync, renameSync } from 'node:fs';
import { join, resolve } from 'node:path';

import config from './config.js';
import { createLogger } from './logger.js';

const log = createLogger('state');

const RING_CAP = 500; // max ids kept per dedup ring
const SLOT_CAP = 30; // remembered digest slots (~15 days at 2/day)
const STATE_VERSION = 1;

/** Normalize a pubkey to x-only lowercase hex so 02.../03… and bare forms collide. */
export function normalizeKey(key) {
  if (typeof key !== 'string') return String(key ?? '');
  const k = key.trim().toLowerCase();
  if (k.length === 66 && (k.startsWith('02') || k.startsWith('03'))) return k.slice(2);
  return k;
}

function statePath() {
  return join(resolve(config.walletDir), 'state.json');
}

function freshState() {
  return {
    version: STATE_VERSION,
    serviceIntentId: null,
    seenDmIds: [],
    seenTransferIds: [],
    deliveredSlots: [],
    pendingPurchases: {}, // { [normalizedPubkey]: Purchase[] }
    subscribers: {}, // { [normalizedPubkey]: Subscriber }
    lastDigest: null, // { slot, generatedAt, hash, featured, live }
  };
}

/** Push onto a capped ring; returns true if the id was NEW (not already present). */
function ringAdd(arr, id, cap = RING_CAP) {
  if (!id) return false;
  if (arr.includes(id)) return false;
  arr.push(id);
  if (arr.length > cap) arr.splice(0, arr.length - cap);
  return true;
}

export class State {
  constructor(data) {
    this.data = data;
    this._dirty = false;
  }

  static load() {
    const path = statePath();
    if (!existsSync(path)) return new State(freshState());
    try {
      const raw = JSON.parse(readFileSync(path, 'utf8'));
      const data = { ...freshState(), ...raw };
      for (const k of ['seenDmIds', 'seenTransferIds', 'deliveredSlots']) {
        if (!Array.isArray(data[k])) data[k] = [];
      }
      if (typeof data.pendingPurchases !== 'object' || data.pendingPurchases === null) data.pendingPurchases = {};
      if (typeof data.subscribers !== 'object' || data.subscribers === null) data.subscribers = {};
      return new State(data);
    } catch (err) {
      log.warn(`state.json unreadable (${err?.message ?? err}); starting fresh.`);
      return new State(freshState());
    }
  }

  save() {
    const path = statePath();
    const tmp = `${path}.tmp`;
    try {
      writeFileSync(tmp, JSON.stringify(this.data, null, 2), { mode: 0o600 });
      renameSync(tmp, path); // atomic swap
      this._dirty = false;
    } catch (err) {
      log.warn(`Could not persist state: ${err?.message ?? err}`);
    }
  }

  // ── dedup rings ─────────────────────────────────────────────────────────────
  /** @returns true if this DM id is new (should be processed). */
  markDmSeen(id) {
    const isNew = ringAdd(this.data.seenDmIds, id);
    if (isNew) this._dirty = true;
    return isNew;
  }

  /** @returns true if this transfer id is new (should be processed). */
  markTransferSeen(id) {
    const isNew = ringAdd(this.data.seenTransferIds, id);
    if (isNew) this._dirty = true;
    return isNew;
  }

  // ── digest slots (idempotent scheduling) ────────────────────────────────────
  hasDeliveredSlot(slot) {
    return this.data.deliveredSlots.includes(slot);
  }
  markSlotDelivered(slot) {
    const isNew = ringAdd(this.data.deliveredSlots, slot, SLOT_CAP);
    if (isNew) this._dirty = true;
    return isNew;
  }

  // ── service advert intent ────────────────────────────────────────────────────
  get serviceIntentId() {
    return this.data.serviceIntentId;
  }
  setServiceIntentId(id) {
    this.data.serviceIntentId = id;
    this._dirty = true;
  }

  // ── last-digest summary (for `status`) ───────────────────────────────────────
  get lastDigest() {
    return this.data.lastDigest;
  }
  setLastDigest(summary) {
    this.data.lastDigest = summary;
    this._dirty = true;
  }

  // ── pending paid orders (keyed by requester pubkey) ──────────────────────────
  addPendingPurchase(pubkey, purchase) {
    const key = normalizeKey(pubkey);
    (this.data.pendingPurchases[key] ??= []).push(purchase);
    this._dirty = true;
  }

  pendingFor(pubkey) {
    return this.data.pendingPurchases[normalizeKey(pubkey)] ?? [];
  }

  /** Remove and return the OLDEST pending order for a requester (FIFO), or null. */
  takeOldestPurchase(pubkey) {
    const key = normalizeKey(pubkey);
    const q = this.data.pendingPurchases[key];
    if (!q || q.length === 0) return null;
    const purchase = q.shift();
    if (q.length === 0) delete this.data.pendingPurchases[key];
    this._dirty = true;
    return purchase;
  }

  totalPendingPurchases() {
    return Object.values(this.data.pendingPurchases).reduce((n, q) => n + q.length, 0);
  }

  // ── subscriptions ────────────────────────────────────────────────────────────
  getSubscriber(pubkey) {
    return this.data.subscribers[normalizeKey(pubkey)] ?? null;
  }

  /**
   * Create or extend a subscription. Adds `addDays` on top of whatever time is
   * left (renewals stack), and updates the display nametag if we learned one.
   * @returns the resulting subscriber record.
   */
  upsertSubscriber(pubkey, { nametag, addDays = 0, topics, now = Date.now() } = {}) {
    const key = normalizeKey(pubkey);
    const existing = this.data.subscribers[key];
    const base = existing && existing.expiresAt > now ? existing.expiresAt : now;
    const sub = {
      pubkey: existing?.pubkey ?? pubkey,
      nametag: nametag ?? existing?.nametag ?? null,
      topics: topics !== undefined ? topics : existing?.topics ?? [],
      since: existing?.since ?? now,
      expiresAt: base + addDays * 86_400_000,
      lastDeliveredSlot: existing?.lastDeliveredSlot ?? null,
    };
    this.data.subscribers[key] = sub;
    this._dirty = true;
    return sub;
  }

  /** Update just the topic preferences for a (possibly not-yet-)subscriber. */
  setSubscriberTopics(pubkey, topics, nametag) {
    const key = normalizeKey(pubkey);
    const existing = this.data.subscribers[key];
    if (existing) {
      existing.topics = topics;
      if (nametag) existing.nametag = nametag;
    } else {
      // Remember the preference even if they haven't paid yet; expiry in the past = inactive.
      this.data.subscribers[key] = {
        pubkey,
        nametag: nametag ?? null,
        topics,
        since: Date.now(),
        expiresAt: 0,
        lastDeliveredSlot: null,
      };
    }
    this._dirty = true;
    return this.data.subscribers[key];
  }

  cancelSubscription(pubkey, now = Date.now()) {
    const key = normalizeKey(pubkey);
    const sub = this.data.subscribers[key];
    if (!sub || sub.expiresAt <= now) return false;
    sub.expiresAt = now; // expire immediately; keep the record (topics) until pruned
    this._dirty = true;
    return true;
  }

  activeSubscribers(now = Date.now()) {
    return Object.values(this.data.subscribers).filter((s) => s.expiresAt > now);
  }

  markSubscriberDelivered(pubkey, slot) {
    const sub = this.data.subscribers[normalizeKey(pubkey)];
    if (sub) {
      sub.lastDeliveredSlot = slot;
      this._dirty = true;
    }
  }

  /** Drop subscriber records whose subscription expired more than `graceDays` ago. */
  pruneSubscribers(graceDays = 14, now = Date.now()) {
    const cutoff = now - graceDays * 86_400_000;
    let removed = 0;
    for (const [key, sub] of Object.entries(this.data.subscribers)) {
      if (sub.expiresAt > 0 && sub.expiresAt < cutoff) {
        delete this.data.subscribers[key];
        removed++;
      }
    }
    if (removed) this._dirty = true;
    return removed;
  }
}

export default State;
