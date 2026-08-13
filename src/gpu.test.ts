import { test, expect, describe } from "bun:test";
import {
  offerPricePerGpu,
  offerBidPerGpu,
  isVerified,
  percentile,
  summarizeOffers,
  usdPerMtokFloor,
} from "./gpu";
import type { VastOffer } from "./vastai";

function offer(partial: Partial<VastOffer> & { id: number }): VastOffer {
  return {
    gpu_name: "B200",
    num_gpus: 1,
    dph_total: 1,
    verification: "verified",
    ...partial,
  };
}

describe("offerPricePerGpu", () => {
  test("divides machine price by GPU count", () => {
    expect(offerPricePerGpu(offer({ id: 1, dph_total: 85, num_gpus: 8 }))).toBeCloseTo(10.625, 6);
  });

  test("rejects unusable rows rather than inventing a price", () => {
    expect(offerPricePerGpu(offer({ id: 1, dph_total: null, num_gpus: 8 }))).toBeNull();
    expect(offerPricePerGpu(offer({ id: 2, dph_total: 0, num_gpus: 8 }))).toBeNull();
    expect(offerPricePerGpu(offer({ id: 3, dph_total: 10, num_gpus: 0 }))).toBeNull();
    expect(offerPricePerGpu(offer({ id: 4, dph_total: 10, num_gpus: null }))).toBeNull();
  });

  test("accepts numeric strings, as pg/JSON sometimes deliver them", () => {
    expect(offerPricePerGpu(offer({ id: 1, dph_total: "20" as never, num_gpus: "4" as never }))).toBe(5);
  });
});

describe("offerBidPerGpu", () => {
  test("normalizes the interruptible floor per GPU", () => {
    expect(offerBidPerGpu(offer({ id: 1, min_bid: 40, num_gpus: 8 }))).toBe(5);
  });

  test("is null when the host publishes no bid floor", () => {
    expect(offerBidPerGpu(offer({ id: 1, num_gpus: 8 }))).toBeNull();
  });
});

describe("isVerified", () => {
  test("only 'verified' counts — 'deverified' must not slip through", () => {
    expect(isVerified(offer({ id: 1, verification: "verified" }))).toBe(true);
    expect(isVerified(offer({ id: 2, verification: "deverified" }))).toBe(false);
    expect(isVerified(offer({ id: 3, verification: "unverified" }))).toBe(false);
    expect(isVerified(offer({ id: 4, verification: null }))).toBe(false);
  });
});

describe("percentile", () => {
  test("interpolates between neighbours", () => {
    expect(percentile([1, 2, 3, 4], 0.5)).toBe(2.5);
    expect(percentile([1, 2, 3, 4], 0.25)).toBeCloseTo(1.75, 9);
    expect(percentile([1, 2, 3, 4], 0.75)).toBeCloseTo(3.25, 9);
  });

  test("hits exact endpoints", () => {
    expect(percentile([5, 10, 20], 0)).toBe(5);
    expect(percentile([5, 10, 20], 1)).toBe(20);
    expect(percentile([5, 10, 20], 0.5)).toBe(10);
  });

  test("degenerate inputs", () => {
    expect(percentile([], 0.5)).toBeNull();
    expect(percentile([7], 0.9)).toBe(7);
  });
});

describe("summarizeOffers", () => {
  const offers: VastOffer[] = [
    offer({ id: 1, dph_total: 8, num_gpus: 8, min_bid: 4, verification: "verified" }), // $1.00/gpu
    offer({ id: 2, dph_total: 4, num_gpus: 2, min_bid: 2, verification: "unverified" }), // $2.00/gpu
    offer({ id: 3, dph_total: 3, num_gpus: 1, verification: "verified" }), // $3.00/gpu
    offer({ id: 4, dph_total: 4, num_gpus: 1, verification: "deverified" }), // $4.00/gpu
  ];

  test("builds the full band in USD per GPU-hour", () => {
    const s = summarizeOffers("B200", offers);
    expect(s.gpuName).toBe("B200");
    expect(s.offers).toBe(4);
    expect(s.minUsd).toBe(1);
    expect(s.p25Usd).toBeCloseTo(1.75, 9);
    expect(s.medianUsd).toBe(2.5);
    expect(s.p75Usd).toBeCloseTo(3.25, 9);
    expect(s.maxUsd).toBe(4);
    expect(s.meanUsd).toBe(2.5);
  });

  test("depth counts GPUs, not machines", () => {
    expect(summarizeOffers("B200", offers).gpusAvailable).toBe(12);
  });

  test("supply weighting follows the GPUs, so the 8-GPU box dominates", () => {
    // (1*8 + 2*2 + 3*1 + 4*1) / 12
    expect(summarizeOffers("B200", offers).supplyWeightedUsd).toBeCloseTo(19 / 12, 9);
  });

  test("interruptible floor is the cheapest bid per GPU", () => {
    // offer 1: 4/8 = 0.5, offer 2: 2/2 = 1.0
    expect(summarizeOffers("B200", offers).minBidUsd).toBe(0.5);
  });

  test("verified subset excludes deverified and unverified", () => {
    const s = summarizeOffers("B200", offers);
    expect(s.verifiedOffers).toBe(2);
    expect(s.verifiedGpusAvailable).toBe(9);
    expect(s.verifiedMinUsd).toBe(1);
    expect(s.verifiedMedianUsd).toBe(2);
  });

  test("unusable offers are dropped from the count, not counted as zero", () => {
    const s = summarizeOffers("B200", [...offers, offer({ id: 5, dph_total: null, num_gpus: 4 })]);
    expect(s.offers).toBe(4);
    expect(s.gpusAvailable).toBe(12);
    expect(s.minUsd).toBe(1);
  });

  test("an empty book yields nulls, never NaN", () => {
    const s = summarizeOffers("B300", []);
    expect(s.offers).toBe(0);
    expect(s.gpusAvailable).toBe(0);
    expect(s.minUsd).toBeNull();
    expect(s.medianUsd).toBeNull();
    expect(s.meanUsd).toBeNull();
    expect(s.supplyWeightedUsd).toBeNull();
    expect(s.minBidUsd).toBeNull();
    expect(s.verifiedMedianUsd).toBeNull();
  });
});

describe("usdPerMtokFloor", () => {
  test("converts a GPU-hour price into a per-million-token floor", () => {
    // $10/hr at 1000 tok/s => 3.6M tokens/hr => $2.777.../Mtok
    expect(usdPerMtokFloor(10, 1000)).toBeCloseTo(10 / 3.6, 9);
  });

  test("throughput and price move it the way physics says", () => {
    expect(usdPerMtokFloor(20, 1000)).toBeCloseTo(2 * usdPerMtokFloor(10, 1000)!, 9);
    expect(usdPerMtokFloor(10, 2000)).toBeCloseTo(usdPerMtokFloor(10, 1000)! / 2, 9);
  });

  test("guards divide-by-zero and nonsense inputs", () => {
    expect(usdPerMtokFloor(10, 0)).toBeNull();
    expect(usdPerMtokFloor(10, -5)).toBeNull();
    expect(usdPerMtokFloor(-1, 1000)).toBeNull();
    expect(usdPerMtokFloor(Number.NaN, 1000)).toBeNull();
  });
});
