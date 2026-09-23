import { expect, it } from "bun:test";
import { FRONTIER_PATTERNS, isFrontier } from "./frontier";
import { isFrontier as frontendIsFrontier } from "../frontend/src/frontier";

it("surfaces the current frontier models consistently in the API and UI", () => {
  for (const id of [
    ...FRONTIER_PATTERNS,
    "openai/gpt-6-astra-pro:batch",
    "openai/gpt-6-sol-pro:batch",
    "openai/gpt-6-luna:batch",
    "anthropic/claude-opus-5.5:batch",
    "anthropic/claude-fable-5.1",
    "x-ai/grok-4.7",
  ]) {
    expect(isFrontier(id)).toBe(true);
    expect(frontendIsFrontier(id.toUpperCase())).toBe(true);
  }
  expect(isFrontier("unknown/new-model")).toBe(false);
  expect(frontendIsFrontier("unknown/new-model")).toBe(false);
});
