import { test, expect, describe } from "bun:test";
import { parseIngestConfig, parseServerConfig, HelpRequested } from "./config";

const DB = "postgres://u:p@localhost:5432/db";

describe("parseIngestConfig", () => {
  test("requires a database url", () => {
    expect(() => parseIngestConfig([], {})).toThrow(/DATABASE_URL/);
  });
  test("applies defaults", () => {
    const c = parseIngestConfig([], { DATABASE_URL: DB });
    expect(c.intervalMs).toBe(3_600_000);
    expect(c.concurrency).toBe(6);
    expect(c.fetchEndpoints).toBe(true);
    expect(c.fetchUsage).toBe(true);
    expect(c.once).toBe(false);
    expect(c.baseUrl).toBe("https://openrouter.ai");
    expect(c.apiKey).toBeNull();
  });
  test("reads env overrides and strips base-url slash", () => {
    const c = parseIngestConfig([], {
      DATABASE_URL: DB,
      OPENROUTER_API_KEY: "sk-or-test",
      OPENROUTER_BASE_URL: "https://example.com/",
      INGEST_INTERVAL_MS: "1000",
      INGEST_FETCH_ENDPOINTS: "false",
    });
    expect(c.apiKey).toBe("sk-or-test");
    expect(c.baseUrl).toBe("https://example.com");
    expect(c.intervalMs).toBe(1000);
    expect(c.fetchEndpoints).toBe(false);
  });
  test("--once flag and CLI overrides win over env", () => {
    const c = parseIngestConfig(["--once", "--interval-ms", "500"], { DATABASE_URL: DB, INGEST_INTERVAL_MS: "9999" });
    expect(c.once).toBe(true);
    expect(c.intervalMs).toBe(500);
  });
  test("--help throws HelpRequested", () => {
    expect(() => parseIngestConfig(["--help"], { DATABASE_URL: DB })).toThrow(HelpRequested);
  });
});

describe("parseServerConfig", () => {
  test("defaults port to 3000", () => {
    const c = parseServerConfig([], { DATABASE_URL: DB });
    expect(c.port).toBe(3000);
  });
  test("parses port + host from env and args", () => {
    const c = parseServerConfig(["--port", "8080"], { DATABASE_URL: DB, SERVER_HOSTNAME: "0.0.0.0" });
    expect(c.port).toBe(8080);
    expect(c.hostname).toBe("0.0.0.0");
  });
  test("rejects out-of-range ports", () => {
    expect(() => parseServerConfig(["--port", "70000"], { DATABASE_URL: DB })).toThrow();
  });
});
