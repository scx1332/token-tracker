import { test, expect, describe } from "bun:test";
import { encodeModelId, safeDecode } from "./routes";

describe("encodeModelId", () => {
  test("keeps the id readable: slash, colon and tilde stay literal", () => {
    expect(encodeModelId("z-ai/glm-5.2")).toBe("z-ai/glm-5.2");
    expect(encodeModelId("poolside/laguna-s-2.1:free")).toBe("poolside/laguna-s-2.1:free");
    expect(encodeModelId("~anthropic/claude-opus-latest")).toBe("~anthropic/claude-opus-latest");
  });

  test("still escapes characters that would break routing", () => {
    expect(encodeModelId("weird id/with?query")).toBe("weird%20id/with%3Fquery");
    expect(encodeModelId("100%/model")).toBe("100%25/model");
    expect(encodeModelId("a#b/c")).toBe("a%23b/c");
  });

  test("round-trips through safeDecode", () => {
    for (const id of ["z-ai/glm-5.2", "a b/c?d", "100%/x", "~openai/gpt-latest:free"]) {
      expect(safeDecode(encodeModelId(id))).toBe(id);
    }
  });
});

describe("safeDecode", () => {
  test("decodes legacy %2F links", () => {
    expect(safeDecode("z-ai%2Fglm-5.2")).toBe("z-ai/glm-5.2");
  });

  test("malformed escapes fall back to the raw string instead of throwing", () => {
    expect(safeDecode("100%")).toBe("100%");
    expect(safeDecode("%E0%A4%A")).toBe("%E0%A4%A");
  });
});
