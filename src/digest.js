/**
 * Daily Market Digest — report builder
 * ────────────────────────────────────────────────────────────
 * Owner / Creator: Itachi
 * Made by CRYPTFRANI
 *
 * Turns a market scan into three renderings:
 *   • teaser  — a short public hook for the broadcast channel (free tier)
 *   • preview — a fuller free DM sample (pulse + headlines, contacts withheld)
 *   • full    — the paid report: ranked featured intents with contacts, prices,
 *               relevance, plus a signed proof-of-time block anyone can verify
 *
 * The paid value is the contact handles, prices and full ranking; the free
 * renderings deliberately withhold those while still being genuinely useful.
 * Everything degrades gracefully: a quiet market yields a calm "nothing hot
 * right now" note rather than an empty page.
 */

import { createHash } from 'node:crypto';

/** Signature-block prefix; also the domain separator for proof-of-time. */
const PROOF_PREFIX = 'market-digest';

// ── small text helpers ───────────────────────────────────────────────────────
function headline(text, max = 72) {
  const oneLine = String(text || '').replace(/\s+/g, ' ').trim();
  if (!oneLine) return '(no description)';
  return oneLine.length > max ? `${oneLine.slice(0, max - 1).trimEnd()}…` : oneLine;
}

function shortKey(pubkey) {
  if (!pubkey) return null;
  return pubkey.length > 16 ? `${pubkey.slice(0, 10)}…${pubkey.slice(-4)}` : pubkey;
}

function priceLabel(item, coinSymbol) {
  if (item.price == null || item.price === '') return 'price on request';
  const cur = item.currency || coinSymbol;
  return `${item.price} ${cur}`;
}

function typeBreakdown(byType) {
  const parts = Object.entries(byType).sort((a, b) => b[1] - a[1]).map(([t, n]) => `${n} ${t}`);
  return parts.length ? parts.join(' · ') : 'no categorized listings';
}

function contactLabel(item) {
  if (item.nametag) return `@${item.nametag}`;
  if (item.contact) return item.contact;
  if (item.pubkey) return shortKey(item.pubkey);
  return '(contact via market)';
}

// ── featured item rendering ────────────────────────────────────────────────
function renderFeaturedFull(item, index, coinSymbol) {
  const lines = [];
  const type = String(item.type || 'intent').toUpperCase();
  lines.push(`${index}. ${type} — ${contactLabel(item)}   (relevance ${item.score.toFixed(2)})`);
  lines.push(`   ${headline(item.description, 120)}`);
  const meta = [`Price: ${priceLabel(item, coinSymbol)}`];
  if (item.category) meta.push(`Category: ${item.category}`);
  if (item.location) meta.push(`Location: ${item.location}`);
  lines.push(`   ${meta.join(' · ')}`);
  const reach = [];
  if (item.nametag) reach.push(`DM @${item.nametag}`);
  if (item.pubkey) reach.push(`key ${shortKey(item.pubkey)}`);
  if (reach.length) lines.push(`   Reach: ${reach.join(' · ')}`);
  if (item.similarCount > 0) lines.push(`   ↳ ${item.similarCount} similar listing(s) also live (possible bulk/bot supply)`);
  return lines.join('\n');
}

function renderFeaturedTeaser(item, index) {
  return `${index}. [${item.type}] ${headline(item.description, 56)}`;
}

// ── main builder ───────────────────────────────────────────────────────────
/**
 * @param {object} scan   result of scanMarket()
 * @param {object} opts
 * @param {string} opts.label        human slot label, e.g. "Aug 24, 20:00"
 * @param {number} opts.featuredFull items in the paid report
 * @param {number} opts.featuredFree items shown in the free preview/teaser
 * @param {string} opts.coinSymbol
 * @param {string} opts.nametag      the agent's @handle (for buy instructions)
 * @param {number} opts.oneTimeWhole one-time price
 * @param {number} opts.perDayWhole  subscription per-day price
 * @param {string} [opts.audience]   optional note (e.g. "Personalized for your topics")
 */
export function buildDigest(scan, opts) {
  const { label, featuredFull, featuredFree, coinSymbol, nametag, oneTimeWhole, perDayWhole, audience } = opts;
  const featured = scan.featured ?? [];
  const pulse = scan.pulse ?? { total: 0, byType: {}, fresh: 0, freshWithinDays: 3, newest: [] };
  const quiet = featured.length === 0 && pulse.total === 0;

  const stats = {
    total: pulse.total,
    fresh: pulse.fresh,
    featuredCount: Math.min(featured.length, featuredFull),
    byType: pulse.byType,
  };

  // ── shared header ──
  const title = `📊 Unicity Market Digest — ${label}`;

  // ── FREE public teaser (broadcast) ──
  const teaserLines = [title];
  if (quiet) {
    teaserLines.push(`The market is quiet right now — no live intents surfaced this round.`);
    teaserLines.push(`Next digest will catch the next wave. DM @${nametag} \`preview\` any time.`);
  } else {
    teaserLines.push(
      `${pulse.total} live listings · ${pulse.fresh} fresh in ${pulse.freshWithinDays}d · ${typeBreakdown(pulse.byType)}.`,
    );
    const top = featured.slice(0, featuredFree);
    if (top.length) {
      teaserLines.push(`Top right now:`);
      top.forEach((it, i) => teaserLines.push(`  ${renderFeaturedTeaser(it, i + 1)}`));
    }
    teaserLines.push(
      `Full ranked report — contacts, prices, relevance → DM @${nametag} \`digest\` (${oneTimeWhole} ${coinSymbol}).`,
    );
    teaserLines.push(`Free sample → DM \`preview\`.`);
  }
  teaserLines.push(`— by CRYPTFRANI`);
  const teaser = teaserLines.join('\n');

  // ── FREE DM preview (a fuller taste; contacts/prices withheld) ──
  const previewLines = [title, ''];
  if (quiet) {
    previewLines.push(`The market is quiet right now — nothing notable is live this round.`);
    previewLines.push(`Check back after the next scheduled digest, or DM \`digest\` to be alerted.`);
  } else {
    previewLines.push(`Market pulse: ${pulse.total} live listings, ${pulse.fresh} fresh in the last ${pulse.freshWithinDays} days.`);
    previewLines.push(`Mix: ${typeBreakdown(pulse.byType)}.`);
    if (pulse.newest?.length) {
      previewLines.push('', 'Newest on the board:');
      pulse.newest.slice(0, 4).forEach((n, i) =>
        previewLines.push(`  ${i + 1}. [${n.type}] ${headline(n.title, 60)}${n.ageHours != null ? `  (${n.ageHours}h ago)` : ''}`),
      );
    }
    const top = featured.slice(0, featuredFree);
    if (top.length) {
      previewLines.push('', `Top matches this round (${featured.length} ranked in the full report):`);
      top.forEach((it, i) => previewLines.push(`  ${renderFeaturedTeaser(it, i + 1)}  · relevance ${it.score.toFixed(2)}`));
    }
    previewLines.push('', `🔓 The full report adds every ranked intent with contact handles, prices and categories.`);
    previewLines.push(`   • One-off now:  DM \`digest\`  (${oneTimeWhole} ${coinSymbol})`);
    previewLines.push(`   • Every run:    DM \`subscribe <days>\`  (${perDayWhole} ${coinSymbol}/day)`);
  }
  previewLines.push('', `— Daily Market Digest · by CRYPTFRANI`);
  const preview = previewLines.join('\n');

  // ── PAID full report core (proof block appended later by renderFull) ──
  const fullLines = [title];
  if (audience) fullLines.push(audience);
  fullLines.push('═'.repeat(60), '');
  if (quiet) {
    fullLines.push(`The market is quiet right now — no live intents cleared the relevance bar this round.`);
    fullLines.push(`This can happen off-peak. Your access still stands for the next scheduled digest.`);
  } else {
    fullLines.push(`MARKET PULSE`);
    fullLines.push(`  Live listings: ${pulse.total}   Fresh (≤${pulse.freshWithinDays}d): ${pulse.fresh}`);
    fullLines.push(`  Mix: ${typeBreakdown(pulse.byType)}`);
    if (pulse.newest?.length) {
      fullLines.push('', `  Newest on the board:`);
      pulse.newest.forEach((n, i) =>
        fullLines.push(`    ${i + 1}. [${n.type}] ${headline(n.title, 64)}${n.agentName ? ` — @${n.agentName}` : ''}`),
      );
    }
    const list = featured.slice(0, featuredFull);
    fullLines.push('', `FEATURED INTENTS — ranked by relevance (${list.length} of ${featured.length})`, '');
    list.forEach((it, i) => {
      fullLines.push(renderFeaturedFull(it, i + 1, coinSymbol));
      fullLines.push('');
    });
  }
  fullLines.push('─'.repeat(60));
  fullLines.push(`How to reach a lister: DM their @handle on Unicity, or use the key shown.`);
  fullLines.push(`Thanks for supporting the digest. — Daily Market Digest · Owner Itachi · by CRYPTFRANI`);
  const fullCore = fullLines.join('\n');

  const hash = createHash('sha256').update(fullCore, 'utf8').digest('hex');

  return { label, quiet, stats, teaser, preview, fullCore, hash, generatedAt: scan.scannedAt };
}

/**
 * Sign a digest's content hash to produce a portable proof-of-time.
 * The signed message is `market-digest\n<iso>\n<sha256(body)>`; anyone can
 * verify it with verifySignedMessage(message, signature, signerPubkey).
 */
export function signDigest(client, hash, generatedAt) {
  const signedAt = generatedAt || new Date().toISOString();
  const message = `${PROOF_PREFIX}\n${signedAt}\n${hash}`;
  let signature = null;
  try {
    signature = client.signMessage(message);
  } catch {
    signature = null; // proof is a bonus, never block delivery on it
  }
  return {
    signedAt,
    hash,
    message,
    signature,
    signerPubkey: client.identity?.chainPubkey || null,
    signerNametag: client.nametag || null,
  };
}

/** Append a verifiable proof-of-time block to the paid report body. */
export function renderFull(digest, proof) {
  if (!proof?.signature) return digest.fullCore;
  const block = [
    '',
    '🔏 PROOF OF TIME (verifiable)',
    `  Issued:    ${proof.signedAt}`,
    `  Digest:    sha256 ${proof.hash}`,
    `  Signer:    @${proof.signerNametag ?? '?'} · ${proof.signerPubkey ?? '?'}`,
    `  Signature: ${proof.signature}`,
    `  Verify:    verifySignedMessage("${PROOF_PREFIX}\\n<issued>\\n<sha256>", signature, signerKey)`,
  ].join('\n');
  return `${digest.fullCore}\n${block}`;
}

export default { buildDigest, signDigest, renderFull, PROOF_PREFIX };
