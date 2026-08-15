import { test, expect, describe } from "bun:test";
import {
  offerPricePerGpu,
  offerBidPerGpu,
  isVerified,
  percentile,
  fenceOffers,
  collapseMachines,
  summarizeOffers,
  usdPerMtokFloor,
  FENCE_FACTOR,
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

describe("fenceOffers", () => {
  test("drops listings priced beyond FENCE_FACTOR× the median, both sides", () => {
    // Median of [1, 1.1, 1.2, 1.3, 40] is 1.2 → fence [0.4, 3.6].
    const { kept, excluded } = fenceOffers([
      offer({ id: 1, dph_total: 1 }),
      offer({ id: 2, dph_total: 1.1 }),
      offer({ id: 3, dph_total: 1.2 }),
      offer({ id: 4, dph_total: 1.3 }),
      offer({ id: 5, dph_total: 40 }), // the $53 RTX 5090 of this book
    ]);
    expect(kept.map((r) => r.offer.id)).toEqual([1, 2, 3, 4]);
    expect(excluded).toBe(1);
  });

  test("drops absurdly cheap listings too", () => {
    // Median 1.2 → floor 0.4; $0.05 is a data error, not a rentable price.
    const { kept, excluded } = fenceOffers([
      offer({ id: 1, dph_total: 0.05 }),
      offer({ id: 2, dph_total: 1.1 }),
      offer({ id: 3, dph_total: 1.2 }),
      offer({ id: 4, dph_total: 1.3 }),
    ]);
    expect(kept.map((r) => r.offer.id)).toEqual([2, 3, 4]);
    expect(excluded).toBe(1);
  });

  test("keeps the legitimate 2-3× spread of a real rental market", () => {
    // A cheap community rig at 0.3 and a verified DC box at 1.4 around a
    // median of ~0.5 are all real — none may be fenced.
    const { kept, excluded } = fenceOffers([
      offer({ id: 1, dph_total: 0.3 }),
      offer({ id: 2, dph_total: 0.45 }),
      offer({ id: 3, dph_total: 0.5 }),
      offer({ id: 4, dph_total: 0.7 }),
      offer({ id: 5, dph_total: 1.4 }),
    ]);
    expect(kept).toHaveLength(5);
    expect(excluded).toBe(0);
  });

  test("excludes deverified hosts before the median is computed", () => {
    // Two junk deverified listings at 9 must not drag the median upward and
    // shield each other from the fence.
    const { kept, excluded } = fenceOffers([
      offer({ id: 1, dph_total: 1 }),
      offer({ id: 2, dph_total: 1.2 }),
      offer({ id: 3, dph_total: 9, verification: "deverified" }),
      offer({ id: 4, dph_total: 9, verification: "deverified" }),
    ]);
    expect(kept.map((r) => r.offer.id)).toEqual([1, 2]);
    expect(excluded).toBe(2);
  });

  test("fence bounds are inclusive", () => {
    // Median 1 → bounds exactly [1/3, 3].
    const { kept } = fenceOffers([
      offer({ id: 1, dph_total: 1 / FENCE_FACTOR }),
      offer({ id: 2, dph_total: 1 }),
      offer({ id: 3, dph_total: FENCE_FACTOR }),
    ]);
    expect(kept).toHaveLength(3);
  });

  test("unpriceable offers are ignored, not counted as excluded", () => {
    const { kept, excluded } = fenceOffers([
      offer({ id: 1, dph_total: 1 }),
      offer({ id: 2, dph_total: null }),
      offer({ id: 3, dph_total: 0 }),
    ]);
    expect(kept).toHaveLength(1);
    expect(excluded).toBe(0);
  });

  test("an empty or all-junk book fences to empty without dividing by zero", () => {
    expect(fenceOffers([])).toEqual({ kept: [], excluded: 0 });
    const { kept, excluded } = fenceOffers([offer({ id: 1, dph_total: 5, verification: "deverified" })]);
    expect(kept).toHaveLength(0);
    expect(excluded).toBe(1);
  });
});

describe("collapseMachines", () => {
  test("keeps only the largest chunk of a machine's 1×/2×/4×/8× ladder", () => {
    const chunks = [
      offer({ id: 1, machine_id: 50, num_gpus: 1, dph_total: 0.38 }),
      offer({ id: 2, machine_id: 50, num_gpus: 2, dph_total: 0.76 }),
      offer({ id: 3, machine_id: 50, num_gpus: 4, dph_total: 1.53 }),
      offer({ id: 4, machine_id: 50, num_gpus: 8, dph_total: 3.05 }),
    ];
    const collapsed = collapseMachines(chunks);
    expect(collapsed).toHaveLength(1);
    expect(collapsed[0]!.id).toBe(4);
  });

  test("equal-size chunks resolve to the cheaper machine price", () => {
    const collapsed = collapseMachines([
      offer({ id: 1, machine_id: 50, num_gpus: 2, dph_total: 1.0 }),
      offer({ id: 2, machine_id: 50, num_gpus: 2, dph_total: 0.9 }),
    ]);
    expect(collapsed).toHaveLength(1);
    expect(collapsed[0]!.id).toBe(2);
  });

  test("offers without a machine_id pass through ungrouped", () => {
    const collapsed = collapseMachines([
      offer({ id: 1, num_gpus: 1 }),
      offer({ id: 2, num_gpus: 1 }),
      offer({ id: 3, machine_id: 7, num_gpus: 4 }),
    ]);
    expect(collapsed).toHaveLength(3);
  });

  test("summarize counts each machine's GPUs once, not per chunk", () => {
    const book = [
      offer({ id: 1, machine_id: 50, num_gpus: 1, dph_total: 0.4 }),
      offer({ id: 2, machine_id: 50, num_gpus: 8, dph_total: 3.04 }), // $0.38/gpu
      offer({ id: 3, machine_id: 51, num_gpus: 4, dph_total: 1.6 }), // $0.40/gpu
    ];
    const s = summarizeOffers("RTX 5090", book);
    expect(s.offers).toBe(2);
    expect(s.gpusAvailable).toBe(12); // not 13
    expect(s.minUsd).toBeCloseTo(0.38, 9);
  });
});

describe("summarizeOffers", () => {
  const offers: VastOffer[] = [
    offer({ id: 1, dph_total: 8, num_gpus: 8, min_bid: 4, verification: "verified" }), // $1.00/gpu
    offer({ id: 2, dph_total: 4, num_gpus: 2, min_bid: 2, verification: "unverified" }), // $2.00/gpu
    offer({ id: 3, dph_total: 3, num_gpus: 1, verification: "verified" }), // $3.00/gpu
    offer({ id: 4, dph_total: 4, num_gpus: 1, verification: "unverified" }), // $4.00/gpu
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

  test("a fenced-out listing contributes nothing: no depth, no bid, no max", () => {
    // Per-GPU prices [1,2,3,4,90], median 3 → fence [1, 9] → the 90 goes.
    const junk = offer({ id: 9, dph_total: 90, num_gpus: 1, min_bid: 0.01, verification: "verified" });
    const s = summarizeOffers("B200", [...offers, junk]);
    expect(s.offers).toBe(4);
    expect(s.excludedOffers).toBe(1);
    expect(s.maxUsd).toBe(4); // not 90
    expect(s.gpusAvailable).toBe(12); // not 13
    expect(s.minBidUsd).toBe(0.5); // junk's 0.01 bid is dead with its listing
    expect(s.verifiedOffers).toBe(2); // junk was "verified" but fenced
  });

  test("clean books report zero excluded", () => {
    expect(summarizeOffers("B200", offers).excludedOffers).toBe(0);
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
