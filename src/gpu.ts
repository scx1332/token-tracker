// Pure aggregation of a vast.ai offer book into one price-band snapshot per GPU.
//
// Everything here is normalized to **USD per GPU-hour**: vast.ai quotes
// `dph_total` (and `min_bid`) for the whole machine, so an 8×B200 box at
// $85/hr is $10.63/GPU-hr. Comparing machine prices across GPUs would be
// meaningless, and comparing against token prices doubly so.
//
// A band rather than a single number, because the rental market is thin and
// bimodal: one $3.85 B200 listing sitting below a $5.31 median is a real,
// rentable price but not "the" market price. min tells you the floor you can
// actually hit; the p25-p75 body is what supply looks like in aggregate.
//
// The band describes the PRACTICAL rentable market, not the raw listing feed.
// The raw feed contains zombie listings (an RTX 5090 asked at $53/GPU-hr while
// the median sits at $0.49, a T4 at $12 vs a $0.15 median) that nobody ever
// rents but that wreck max, mean and any supply weighting. `fenceOffers`
// removes them before any statistic is computed — see its comment for the rule.

import type { VastOffer } from "./vastai";
import { numeric } from "./vastai";

export interface GpuPriceSnapshot {
  gpuName: string;
  /** Rentable machines inside the practical-price fence (one per machine_id). */
  offers: number;
  /** Sum of GPUs across those machines — market depth. */
  gpusAvailable: number;
  /** Priced listings excluded as junk: deverified hosts + fence outliers. */
  excludedOffers: number;
  // On-demand price band, USD per GPU-hour.
  minUsd: number | null;
  p25Usd: number | null;
  medianUsd: number | null;
  p75Usd: number | null;
  maxUsd: number | null;
  meanUsd: number | null;
  /** Mean weighted by GPUs per offer — what the aggregate supply costs. */
  supplyWeightedUsd: number | null;
  /** Cheapest interruptible (spot) floor across offers, USD per GPU-hour. */
  minBidUsd: number | null;
  // The "verified" subset: hosts vast.ai has validated. Most production
  // renters filter to these, so their floor is the practical price.
  verifiedOffers: number;
  verifiedGpusAvailable: number;
  verifiedMinUsd: number | null;
  verifiedMedianUsd: number | null;
}

/** On-demand price of one offer in USD per GPU-hour, or null if unusable. */
export function offerPricePerGpu(offer: VastOffer): number | null {
  const total = numeric(offer.dph_total);
  const gpus = numeric(offer.num_gpus);
  if (total === null || total <= 0) return null;
  if (gpus === null || gpus < 1) return null;
  return total / gpus;
}

/** Interruptible floor of one offer in USD per GPU-hour, or null. */
export function offerBidPerGpu(offer: VastOffer): number | null {
  const bid = numeric(offer.min_bid);
  const gpus = numeric(offer.num_gpus);
  if (bid === null || bid <= 0) return null;
  if (gpus === null || gpus < 1) return null;
  return bid / gpus;
}

export function isVerified(offer: VastOffer): boolean {
  return (offer.verification ?? "").toLowerCase() === "verified";
}

/** How far from the sweep median a listing may sit and still count as market. */
export const FENCE_FACTOR = 3;

/**
 * Collapse the chunk-offer book to one offer per physical machine.
 *
 * vast.ai's search lists every rentable *allocation* of a machine as its own
 * offer: an idle 8×5090 box shows up four times, as 1×, 2×, 4× and 8× chunks of
 * the same silicon. Summing `num_gpus` over that book double-counts massively
 * (a live RTX 5090 sweep: 372 offers / 1099 "GPUs" collapsing to 273 machines /
 * 897 real GPUs), and the near-identical per-GPU prices of a machine's chunks
 * overweight split-friendly hosts in every percentile.
 *
 * The representative offer is the machine's largest chunk: it is the whole
 * rentable inventory of that machine, and its per-GPU price is the marginal
 * price of that inventory (chunk prices per GPU differ only by the fixed
 * machine components being spread thinner). Ties break toward the cheaper
 * machine price. Offers without a machine_id can't be grouped and pass through
 * as themselves.
 */
export function collapseMachines(offers: VastOffer[]): VastOffer[] {
  const byMachine = new Map<string, VastOffer>();
  for (const offer of offers) {
    const machine = numeric(offer.machine_id);
    const key = machine === null ? `offer:${offer.id}` : `machine:${machine}`;
    const seen = byMachine.get(key);
    if (!seen) {
      byMachine.set(key, offer);
      continue;
    }
    const seenGpus = numeric(seen.num_gpus) ?? 0;
    const gpus = numeric(offer.num_gpus) ?? 0;
    if (
      gpus > seenGpus ||
      (gpus === seenGpus && (numeric(offer.dph_total) ?? Infinity) < (numeric(seen.dph_total) ?? Infinity))
    ) {
      byMachine.set(key, offer);
    }
  }
  return [...byMachine.values()];
}

/**
 * Split an offer book into the practical rentable market and the junk around it.
 *
 * Two exclusion rules, applied to offers that have a usable per-GPU price:
 *
 *  1. `deverified` hosts are out unconditionally — vast.ai itself has revoked
 *     their verification, and their listings linger in search results.
 *  2. A multiplicative fence around the median: listings priced above
 *     `median × FENCE_FACTOR` or below `median / FENCE_FACTOR` are out.
 *
 * Why a multiplicative fence rather than IQR/stddev: same-SKU rental prices
 * legitimately spread ~2-3× (a home rig vs a datacenter 8× box with bundled
 * NVMe/CPU), so additive fences misfire on thin books where the IQR collapses
 * to ~0 (nine B300 listings, six of them at the same price). A listing 3× above
 * the sweep median is not a price anyone pays — it is a parked ask — and one
 * 3× below is either a data error or an offer that will be gone in minutes.
 * The median itself is robust to the junk it is fencing out, so one pass is
 * enough. Both bounds are inclusive.
 *
 * The interruptible `min_bid` floor is deliberately NOT fenced on its own
 * distribution: hosts set near-zero floors on purpose (any revenue beats idle),
 * so a $0.01 spot floor is a real, rentable price. A junk listing's bid dies
 * with its listing, which is the only bid filtering that is defensible.
 */
export function fenceOffers(offers: VastOffer[]): {
  kept: { offer: VastOffer; price: number }[];
  excluded: number;
} {
  const priced = offers
    .map((offer) => ({ offer, price: offerPricePerGpu(offer) }))
    .filter((row): row is { offer: VastOffer; price: number } => row.price !== null);

  const eligible = priced.filter(
    (row) => (row.offer.verification ?? "").toLowerCase() !== "deverified",
  );

  const prices = eligible.map((row) => row.price).sort((a, b) => a - b);
  const med = percentile(prices, 0.5);
  const kept =
    med === null || med <= 0
      ? eligible
      : eligible.filter((row) => row.price >= med / FENCE_FACTOR && row.price <= med * FENCE_FACTOR);

  return { kept, excluded: priced.length - kept.length };
}

/**
 * Linear-interpolated percentile over an ascending-sorted array.
 * `q` is a fraction in [0, 1]. Returns null for an empty input.
 */
export function percentile(sorted: number[], q: number): number | null {
  if (sorted.length === 0) return null;
  if (sorted.length === 1) return sorted[0]!;
  const clamped = Math.min(1, Math.max(0, q));
  const pos = clamped * (sorted.length - 1);
  const lo = Math.floor(pos);
  const hi = Math.ceil(pos);
  if (lo === hi) return sorted[lo]!;
  return sorted[lo]! + (sorted[hi]! - sorted[lo]!) * (pos - lo);
}

/**
 * Collapse one GPU's offer book into a single price-band snapshot.
 * The chunk book is first collapsed to one offer per physical machine (see
 * `collapseMachines`), then fenced; every statistic — including bids, depth and
 * the verified subset — is computed over the fenced machine-level set only:
 * a junk listing contributes nothing, not even depth.
 */
export function summarizeOffers(gpuName: string, offers: VastOffer[]): GpuPriceSnapshot {
  const { kept, excluded } = fenceOffers(collapseMachines(offers));

  const prices = kept.map((row) => row.price).sort((a, b) => a - b);
  const gpusAvailable = kept.reduce((sum, row) => sum + (numeric(row.offer.num_gpus) ?? 0), 0);

  const weightedTotal = kept.reduce(
    (sum, row) => sum + row.price * (numeric(row.offer.num_gpus) ?? 0),
    0,
  );

  const bids = kept
    .map((row) => offerBidPerGpu(row.offer))
    .filter((bid): bid is number => bid !== null)
    .sort((a, b) => a - b);

  const verified = kept.filter((row) => isVerified(row.offer));
  const verifiedPrices = verified.map((row) => row.price).sort((a, b) => a - b);

  return {
    gpuName,
    offers: kept.length,
    gpusAvailable,
    excludedOffers: excluded,
    minUsd: prices.length ? prices[0]! : null,
    p25Usd: percentile(prices, 0.25),
    medianUsd: percentile(prices, 0.5),
    p75Usd: percentile(prices, 0.75),
    maxUsd: prices.length ? prices[prices.length - 1]! : null,
    meanUsd: prices.length ? prices.reduce((a, b) => a + b, 0) / prices.length : null,
    supplyWeightedUsd: gpusAvailable > 0 ? weightedTotal / gpusAvailable : null,
    minBidUsd: bids.length ? bids[0]! : null,
    verifiedOffers: verified.length,
    verifiedGpusAvailable: verified.reduce((sum, row) => sum + (numeric(row.offer.num_gpus) ?? 0), 0),
    verifiedMinUsd: verifiedPrices.length ? verifiedPrices[0]! : null,
    verifiedMedianUsd: percentile(verifiedPrices, 0.5),
  };
}

/**
 * Cost of one million tokens implied by a GPU rental price, for putting raw
 * compute on the same axis as OpenRouter token prices.
 *
 * This is deliberately a *floor*, not a forecast: it assumes the whole GPU-hour
 * converts to output tokens at `tokensPerSecond`, ignoring batching efficiency
 * below saturation, prefill cost, idle time, replication for availability, and
 * every operational cost above the rental itself. Real serving costs land well
 * above this line — which is exactly what makes it useful as a lower bound.
 */
export function usdPerMtokFloor(usdPerGpuHour: number, tokensPerSecond: number): number | null {
  if (!Number.isFinite(usdPerGpuHour) || usdPerGpuHour < 0) return null;
  if (!Number.isFinite(tokensPerSecond) || tokensPerSecond <= 0) return null;
  const tokensPerHour = tokensPerSecond * 3600;
  return (usdPerGpuHour / tokensPerHour) * 1_000_000;
}
