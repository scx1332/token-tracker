import { test, expect, describe } from "bun:test";
import type { PriceHistoryRow } from "./api";
import {
  metricPerMtok,
  minEnvelope,
  providerOrderBook,
  seriesForEndpoint,
  envelopeChange,
  endpointLabel,
  providerOfLabel,
} from "./price";

// Build a price-point row; only the fields the pure math reads need to be set.
// `provider` doubles as the endpoint tag unless one is given — a provider with
// a single base endpoint, which is the ordinary case.
function row(
  provider: string,
  observedAt: string,
  promptUsd: number | null,
  completionUsd: number | null,
  isFree = false,
  endpointTag?: string,
): PriceHistoryRow {
  return {
    provider,
    endpointTag: endpointTag ?? provider,
    observedAt,
    promptUsd,
    completionUsd,
    requestUsd: null,
    imageUsd: null,
    webSearchUsd: null,
    internalReasoningUsd: null,
    cacheReadUsd: null,
    cacheWriteUsd: null,
    contextLength: null,
    quantization: null,
    isFree,
  };
}

describe("metricPerMtok", () => {
  test("converts USD/token to USD/Mtok per metric", () => {
    const r = row("A", "t0", 0.0000005, 0.000002); // $0.50 / $2.00 per M
    expect(metricPerMtok(r, "input")).toBeCloseTo(0.5, 9);
    expect(metricPerMtok(r, "output")).toBeCloseTo(2.0, 9);
    expect(metricPerMtok(r, "blended")).toBeCloseTo(0.65, 9); // 0.5×0.9 + 2.0×0.1
  });

  test("free is always zero; missing side falls back to the other", () => {
    expect(metricPerMtok(row("A", "t0", null, null, true), "blended")).toBe(0);
    expect(metricPerMtok(row("A", "t0", 0.000001, null), "blended")).toBeCloseTo(1.0, 9);
    expect(metricPerMtok(row("A", "t0", null, null), "input")).toBeNull();
  });
});

describe("minEnvelope", () => {
  test("tracks the cheapest provider and full spread as prices change over time", () => {
    const points = [
      row("A", "2026-01-01T00:00:00Z", 0.000002, 0.000002), // A = $2/M
      row("B", "2026-01-01T00:00:00Z", 0.000003, 0.000003), // B = $3/M
      row("A", "2026-02-01T00:00:00Z", 0.000004, 0.000004), // A rises to $4/M → B now cheapest
    ];
    const env = minEnvelope(points, "blended");
    expect(env).toHaveLength(2);

    expect(env[0]!.min).toBeCloseTo(2, 9);
    expect(env[0]!.max).toBeCloseTo(3, 9);
    expect(env[0]!.cheapest).toBe("A");
    expect(env[0]!.count).toBe(2);

    // After A reprices upward, B ($3) becomes the floor and A ($4) the ceiling.
    expect(env[1]!.min).toBeCloseTo(3, 9);
    expect(env[1]!.max).toBeCloseTo(4, 9);
    expect(env[1]!.cheapest).toBe("B");
  });

  test("a provider only counts once it has appeared", () => {
    const points = [
      row("A", "2026-01-01T00:00:00Z", 0.000005, 0.000005),
      row("B", "2026-03-01T00:00:00Z", 0.000001, 0.000001), // cheaper, but only from March
    ];
    const env = minEnvelope(points, "blended");
    expect(env[0]!.count).toBe(1);
    expect(env[0]!.cheapest).toBe("A");
    expect(env[1]!.cheapest).toBe("B");
    expect(env[1]!.min).toBeCloseTo(1, 9);
  });
});

describe("providerOrderBook", () => {
  test("returns the latest quote per provider, cheapest first", () => {
    const points = [
      row("A", "2026-01-01T00:00:00Z", 0.000009, 0.000009), // stale A
      row("A", "2026-02-01T00:00:00Z", 0.000002, 0.000002), // latest A = $2/M
      row("B", "2026-02-01T00:00:00Z", 0.000001, 0.000001), // B = $1/M
    ];
    const book = providerOrderBook(points, "blended");
    expect(book.map((q) => q.provider)).toEqual(["B", "A"]);
    expect(book[0]!.value).toBeCloseTo(1, 9);
    expect(book[1]!.value).toBeCloseTo(2, 9); // latest, not the $9 stale row
  });
});

describe("seriesForEndpoint + envelopeChange", () => {
  test("filters to one endpoint in time order", () => {
    const points = [
      row("B", "2026-01-02T00:00:00Z", 0.000002, 0.000002),
      row("A", "2026-01-01T00:00:00Z", 0.000001, 0.000001),
      row("A", "2026-01-03T00:00:00Z", 0.000003, 0.000003),
    ];
    const s = seriesForEndpoint(points, "A");
    expect(s.map((r) => r.observedAt)).toEqual(["2026-01-01T00:00:00Z", "2026-01-03T00:00:00Z"]);
  });

  test("envelopeChange is the first→last percent move of the minimum", () => {
    const env = minEnvelope(
      [
        row("A", "2026-01-01T00:00:00Z", 0.000002, 0.000002),
        row("A", "2026-02-01T00:00:00Z", 0.0000015, 0.0000015), // $2 → $1.5 = -25%
      ],
      "blended",
    );
    expect(envelopeChange(env, "min")).toBeCloseTo(-0.25, 6);
  });
});

// The bug this whole split exists for: OpenAI sells one model as `openai`,
// `openai/flex` and `openai/priority` at three prices at the same instant.
// Keyed by provider name those three took turns overwriting each other and
// the chart showed an hourly sawtooth that never happened.
describe("one provider, several endpoints", () => {
  const points = [
    row("OpenAI", "2026-08-18T00:00:00Z", 0.0000025, 0.000015, false, "openai"),
    row("OpenAI", "2026-08-18T00:00:00Z", 0.00000125, 0.0000075, false, "openai/flex"),
    row("OpenAI", "2026-08-18T00:00:00Z", 0.000005, 0.00003, false, "openai/priority"),
  ];

  test("labels keep the provider name for its base endpoint and suffix the tiers", () => {
    expect(points.map(endpointLabel)).toEqual(["OpenAI", "OpenAI · flex", "OpenAI · priority"]);
    expect(providerOfLabel("OpenAI · flex")).toBe("OpenAI");
    expect(providerOfLabel("OpenAI")).toBe("OpenAI");
  });

  test("the order book quotes each tier separately, cheapest first", () => {
    const book = providerOrderBook(points, "input");
    expect(book.map((q) => q.label)).toEqual(["OpenAI · flex", "OpenAI", "OpenAI · priority"]);
    expect(book.every((q) => q.provider === "OpenAI")).toBe(true);
    expect(book[0]!.value).toBeCloseTo(1.25, 9);
  });

  test("each tier holds its own price instead of overwriting the others", () => {
    expect(seriesForEndpoint(points, "OpenAI · flex").map((r) => r.promptUsd)).toEqual([0.00000125]);
    // Three quotes at one instant = one event with a $1.25–$5.00 spread, not
    // three price changes.
    const env = minEnvelope(points, "input");
    expect(env).toHaveLength(1);
    expect(env[0]!.count).toBe(3);
    expect(env[0]!.min).toBeCloseTo(1.25, 9);
    expect(env[0]!.max).toBeCloseTo(5, 9);
    expect(env[0]!.cheapest).toBe("OpenAI · flex");
  });

  test("rows with no tag (pre-split history) fall back to the provider name", () => {
    expect(endpointLabel({ provider: "Azure" })).toBe("Azure");
  });
});
