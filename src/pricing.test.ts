import { test, expect, describe } from "bun:test";
import {
  parseUsd,
  normalizePricing,
  pricingChanged,
  isFreePricing,
  estimateSpendUsd,
  blendedPricePerMtok,
} from "./pricing";

describe("parseUsd", () => {
  test("parses numeric strings, including zero", () => {
    expect(parseUsd("0.0000005")).toBe(0.0000005);
    expect(parseUsd("0")).toBe(0);
  });
  test("returns null for missing / invalid / negative", () => {
    expect(parseUsd(undefined)).toBeNull();
    expect(parseUsd("")).toBeNull();
    expect(parseUsd("abc")).toBeNull();
    expect(parseUsd("-1")).toBeNull();
  });
});

describe("normalizePricing", () => {
  test("maps OpenRouter keys to normalized fields", () => {
    const n = normalizePricing({ prompt: "0.0000005", completion: "0.0000025", web_search: "0.01" });
    expect(n.promptUsd).toBe(0.0000005);
    expect(n.completionUsd).toBe(0.0000025);
    expect(n.webSearchUsd).toBe(0.01);
    expect(n.imageUsd).toBeNull();
  });
  test("empty pricing yields all nulls", () => {
    const n = normalizePricing(undefined);
    expect(n.promptUsd).toBeNull();
    expect(n.completionUsd).toBeNull();
  });
});

describe("pricingChanged", () => {
  const base = normalizePricing({ prompt: "0.000001", completion: "0.000002" });
  test("null previous is always a change (first observation)", () => {
    expect(pricingChanged(null, base)).toBe(true);
  });
  test("identical pricing is not a change", () => {
    expect(pricingChanged(base, normalizePricing({ prompt: "0.000001", completion: "0.000002" }))).toBe(false);
  });
  test("a changed field is a change", () => {
    expect(pricingChanged(base, normalizePricing({ prompt: "0.0000009", completion: "0.000002" }))).toBe(true);
  });
  test("null vs value is a change", () => {
    expect(pricingChanged(base, normalizePricing({ completion: "0.000002" }))).toBe(true);
  });
  test("tiny float noise is not a change", () => {
    const a = normalizePricing({ prompt: "0.0000005" });
    const b = { ...a, promptUsd: 0.0000005 + 1e-20 };
    expect(pricingChanged(a, b)).toBe(false);
  });
});

describe("isFreePricing", () => {
  test("true only when prompt and completion are both zero", () => {
    expect(isFreePricing(normalizePricing({ prompt: "0", completion: "0" }))).toBe(true);
    expect(isFreePricing(normalizePricing({ prompt: "0", completion: "0.001" }))).toBe(false);
    expect(isFreePricing(normalizePricing({}))).toBe(true); // both null -> treated as 0
  });
});

describe("estimateSpendUsd", () => {
  test("prices prompt and completion tokens separately when both known", () => {
    const spend = estimateSpendUsd({
      totalTokens: 3000,
      promptTokens: 1000,
      completionTokens: 2000,
      promptUsd: 0.000001,
      completionUsd: 0.000002,
    });
    expect(spend).toBeCloseTo(1000 * 1e-6 + 2000 * 2e-6, 10);
  });
  test("blends by promptShare when only total is known", () => {
    const spend = estimateSpendUsd({ totalTokens: 1000, promptUsd: 0.000001, completionUsd: 0.000003, promptShare: 0.5 });
    expect(spend).toBeCloseTo(500 * 1e-6 + 500 * 3e-6, 10);
  });
  test("returns null when no price is available", () => {
    expect(estimateSpendUsd({ totalTokens: 1000, promptUsd: null, completionUsd: null })).toBeNull();
  });
  test("free model yields zero spend", () => {
    expect(estimateSpendUsd({ totalTokens: 1000, promptUsd: 0, completionUsd: 0 })).toBe(0);
  });
});

describe("blendedPricePerMtok", () => {
  test("converts USD/token to USD/Mtok blended 90/10 by default", () => {
    const v = blendedPricePerMtok(normalizePricing({ prompt: "0.000001", completion: "0.000003" }));
    expect(v).toBeCloseTo((1e-6 * 0.9 + 3e-6 * 0.1) * 1e6, 8);
  });
  test("null when unpriced", () => {
    expect(blendedPricePerMtok(normalizePricing({}))).toBeNull();
  });
});
