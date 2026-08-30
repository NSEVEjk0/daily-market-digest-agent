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
 *
 * Three states, not two. A round is QUIET when the board answered and had nothing
 * hot on it; it is BLIND when the board did not answer at all; and it is PARTIAL
 * when some sweeps answered and others did not. Only the first is a fact about the
 * market. A blind round is rendered as what it is -- an admission -- and carries no
 * proof-of-time, because the signature would be a timestamped assertion that the
 * board was empty at a moment when this agent could not see the board.
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
  const reach = scan.reach ?? null;
  const blind = reach?.blind === true;
  // Quiet is a claim, so it is only available when something actually answered.
  const quiet = !blind && featured.length === 0 && pulse.total === 0;
  const incomplete = !blind && reach?.partial === true;
  const caveat = incomplete
    ? `Note: ${reach.seedsFailed} of ${reach.seedsTried} sweep(s)` +
      `${reach.pulseOk ? '' : ' and the recent-listings feed'} did not answer this round, ` +
      `so the ranking below is incomplete rather than the whole board.`
    : null;

  const stats = {
    total: pulse.total,
    fresh: pulse.fresh,
    featuredCount: blind ? 0 : Math.min(featured.length, featuredFull),
    byType: pulse.byType,
  };

  // ── shared header ──
  const title = `📊 Unicity Market Digest — ${label}`;

  // ── FREE public teaser (broadcast) ──
  const teaserLines = [title];
  if (blind) {
    teaserLines.push(`I could not read the market this round — the board did not answer.`);
    teaserLines.push(`No digest is being published for this slot. This is not a quiet market; it is`);
    teaserLines.push(`an unread one, and I will not sign a report about intents I never saw.`);
  } else if (quiet) {
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
  if (caveat) teaserLines.push(caveat);
  teaserLines.push(`— by CRYPTFRANI`);
  const teaser = teaserLines.join('\n');

  // ── FREE DM preview (a fuller taste; contacts/prices withheld) ──
  const previewLines = [title, ''];
  if (blind) {
    previewLines.push(`I could not read the market just now — neither the recent-listings feed nor any`);
    previewLines.push(`semantic sweep answered, so I have nothing to tell you about the board.`);
    previewLines.push('');
    previewLines.push(`That is different from a quiet market, and I would rather say so than hand you`);
    previewLines.push(`an empty page that reads like one. Try \`preview\` again shortly.`);
  } else if (quiet) {
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
  if (caveat) previewLines.push('', caveat);
  previewLines.push('', `— Daily Market Digest · by CRYPTFRANI`);
  const preview = previewLines.join('\n');

  // ── PAID full report core (proof block appended later by renderFull) ──
  const fullLines = [title];
  if (audience) fullLines.push(audience);
  fullLines.push('═'.repeat(60), '');
  if (blind) {
    fullLines.push(`NO REPORT THIS ROUND — THE MARKET COULD NOT BE READ`);
    fullLines.push('');
    fullLines.push(`  The recent-listings feed did not answer, and neither did any semantic sweep.`);
    fullLines.push(`  I therefore know nothing about the state of the board at ${scan.scannedAt ?? 'this time'},`);
    fullLines.push(`  and a report saying "the market is quiet" would be a claim I cannot support.`);
    fullLines.push('');
    fullLines.push(`  This page carries NO proof-of-time, on purpose. The signature is what makes a`);
    fullLines.push(`  digest evidence, and there is nothing here to be evidence of.`);
  } else if (quiet) {
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
  if (caveat) fullLines.push('', `  ${caveat}`);
  fullLines.push('', '─'.repeat(60));
  if (!blind) fullLines.push(`How to reach a lister: DM their @handle on Unicity, or use the key shown.`);
  fullLines.push(`Thanks for supporting the digest. — Daily Market Digest · Owner Itachi · by CRYPTFRANI`);
  const fullCore = fullLines.join('\n');

  const hash = createHash('sha256').update(fullCore, 'utf8').digest('hex');

  return {
    label,
    quiet,
    blind,
    incomplete,
    // `signable` is the gate every caller checks before selling, publishing or
    // signing this. A blind round is renderable (people are owed the admission)
    // but never signable.
    signable: !blind,
    reach,
    stats,
    teaser,
    preview,
    fullCore,
    hash,
    generatedAt: scan.scannedAt,
  };
}

/**
 * Sign a digest's content hash to produce a portable proof-of-time.
 * The signed message is `market-digest\n<iso>\n<sha256(body)>`; anyone can
 * verify it with verifySignedMessage(message, signature, signerPubkey).
 */
export function signDigest(client, hash, generatedAt, { signable = true } = {}) {
  const signedAt = generatedAt || new Date().toISOString();
  const message = `${PROOF_PREFIX}\n${signedAt}\n${hash}`;
  let signature = null;
  let unsignedBecause = null;
  if (!signable) {
    // Not an error path. The caller has told us the round is blind, and the one
    // thing a signature must never do is certify a claim nobody could check.
    unsignedBecause = 'the market could not be read this round';
  } else {
    try {
      signature = client.signMessage(message);
    } catch (err) {
      signature = null; // proof is a bonus, never block delivery on it
      unsignedBecause = `the signer did not answer (${err?.message ?? err})`;
    }
  }
  return {
    signedAt,
    hash,
    message,
    signature,
    unsignedBecause,
    signerPubkey: client.identity?.chainPubkey || null,
    signerNametag: client.nametag || null,
  };
}

/** Append a verifiable proof-of-time block to the paid report body. */
export function renderFull(digest, proof) {
  if (!proof?.signature) {
    // The body already explains a blind round. Any OTHER reason a proof is missing
    // has to be said out loud: `help`, `about` and the market advert all promise a
    // signed proof-of-time, and a report that quietly arrives without one looks
    // exactly like a report that was never signed at all.
    if (digest.blind) return digest.fullCore;
    const why = proof?.unsignedBecause ?? 'the signer did not answer';
    return [
      digest.fullCore,
      '',
      '🔏 PROOF OF TIME — UNAVAILABLE',
      `  This report is NOT signed: ${why}.`,
      `  The market data above stands; the portable proof does not exist. Ask again`,
      `  next round, or DM \`status\` — a report without its signature is not evidence.`,
    ].join('\n');
  }
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
