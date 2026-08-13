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

import type { VastOffer } from "./vastai";
import { numeric } from "./vastai";

export interface GpuPriceSnapshot {
  gpuName: string;
  /** Number of distinct rentable on-demand offers seen. */
  offers: number;
  /** Sum of GPUs across those offers — market depth, not machine count. */
  gpusAvailable: number;
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

/** Collapse one GPU's offer book into a single price-band snapshot. */
export function summarizeOffers(gpuName: string, offers: VastOffer[]): GpuPriceSnapshot {
  const priced = offers
    .map((offer) => ({ offer, price: offerPricePerGpu(offer) }))
    .filter((row): row is { offer: VastOffer; price: number } => row.price !== null);

  const prices = priced.map((row) => row.price).sort((a, b) => a - b);
  const gpusAvailable = priced.reduce((sum, row) => sum + (numeric(row.offer.num_gpus) ?? 0), 0);

  const weightedTotal = priced.reduce(
    (sum, row) => sum + row.price * (numeric(row.offer.num_gpus) ?? 0),
    0,
  );

  const bids = offers
    .map(offerBidPerGpu)
    .filter((bid): bid is number => bid !== null)
    .sort((a, b) => a - b);

  const verified = priced.filter((row) => isVerified(row.offer));
  const verifiedPrices = verified.map((row) => row.price).sort((a, b) => a - b);

  return {
    gpuName,
    offers: priced.length,
    gpusAvailable,
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
