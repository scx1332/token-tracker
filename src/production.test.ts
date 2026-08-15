import { describe, expect, it, test } from "bun:test";
import type { Check, MonitorFacts } from "./monitor";

// Tests against the running deployment, from outside it.
//
//   bun run prod-check                                  # the live site
//   PROD_BASE_URL=https://staging.example bun run prod-check
//   PROD_API_URL=http://127.0.0.1:28470 bun test src/production.test.ts
//
// Two halves, and they fail for different reasons:
//
//   - one test per `/status` check, so a scraper that quietly stopped names
//     itself instead of hiding inside one red "production" test. The judgement
//     lives in `src/monitor.ts` and runs on the server, next to the database;
//     this only carries the verdict out.
//   - the black-box half, which `/status` cannot see at all: nginx routing,
//     the frontend and its assets, the certificate, and the actual JSON the
//     pages consume. A backend that answers perfectly is still an outage if
//     the site in front of it does not.
//
// Self-skipping without PROD_BASE_URL, so `bun test` stays hermetic (AGENTS.md).

const BASE = (process.env.PROD_BASE_URL ?? "").replace(/\/+$/, "");
const API = (process.env.PROD_API_URL ?? (BASE ? `${BASE}/api` : "")).replace(/\/+$/, "");

/** Generous: these run against the internet, and a slow answer is not a wrong one. */
const TIMEOUT_MS = 30_000;

/** Certbot renews at 30 days left, so 21 is already a renewal that did not happen. */
const CERT_WARN_DAYS = 21;
const CERT_FAIL_DAYS = 14;

interface StatusBody {
  ok: boolean;
  status: string;
  checkedAt: string;
  checks: Check[];
  facts: MonitorFacts;
}

async function get(url: string, init: RequestInit = {}): Promise<Response> {
  return fetch(url, {
    ...init,
    signal: AbortSignal.timeout(TIMEOUT_MS),
    headers: { "user-agent": "token-tracker-production-check", ...(init.headers ?? {}) },
  });
}

async function getJson<T>(path: string): Promise<T> {
  const url = `${API}${path}`;
  const res = await get(url);
  if (!res.ok) throw new Error(`GET ${url} answered ${res.status} ${res.statusText}`);
  return (await res.json()) as T;
}

/** Days until the TLS certificate expires, or null for a plain-http target. */
async function certificateDaysLeft(base: string): Promise<number | null> {
  const url = new URL(base);
  if (url.protocol !== "https:") return null;
  const { connect } = await import("node:tls");
  return new Promise<number | null>((resolve, reject) => {
    const socket = connect(
      { host: url.hostname, port: Number(url.port || 443), servername: url.hostname, timeout: TIMEOUT_MS },
      () => {
        const cert = socket.getPeerCertificate();
        socket.end();
        const expires = Date.parse(cert?.valid_to ?? "");
        if (!Number.isFinite(expires)) return reject(new Error("the server presented no readable certificate"));
        resolve((expires - Date.now()) / 86_400_000);
      },
    );
    socket.on("timeout", () => socket.destroy(new Error("TLS handshake timed out")));
    socket.on("error", reject);
  });
}

if (!API) {
  test.skip("production checks — set PROD_BASE_URL (or PROD_API_URL) to run them", () => {});
} else {
  // Fetched once, up front: /status is the whole pipeline verdict, and turning
  // each of its checks into a test is what makes a failure say "gpu.sweep" in
  // the CI log rather than "production".
  const statusUrl = `${API}/status`;
  let status: StatusBody | null = null;
  let statusError: string | null = null;
  let statusCode = 0;
  try {
    const res = await get(statusUrl);
    statusCode = res.status;
    // 503 is how a failing verdict is served — the body is the point, not the code.
    if (res.status !== 200 && res.status !== 503) throw new Error(`answered ${res.status} ${res.statusText}`);
    status = (await res.json()) as StatusBody;
  } catch (error) {
    statusError = error instanceof Error ? error.message : String(error);
  }

  describe("the data pipeline", () => {
    if (!status) {
      it("answers /status", () => {
        throw new Error(`GET ${statusUrl} failed: ${statusError}`);
      });
    } else {
      const body = status;

      it("reports on every source", () => {
        expect(body.checks.length).toBeGreaterThan(10);
        expect(body.checkedAt).toMatch(/^\d{4}-\d{2}-\d{2}T/);
        // A 503 must mean something failed, and a 200 must mean nothing did.
        expect(statusCode === 503).toBe(body.status === "fail");
      });

      for (const check of body.checks) {
        it(check.name, () => {
          if (check.status === "warn") console.warn(`   warn  ${check.name}: ${check.detail}`);
          // The detail line carries the numbers, so it is also the failure message.
          expect(`${check.status} — ${check.detail}`).not.toStartWith("fail");
        });
      }
    }
  });

  describe("the API the pages read", () => {
    it("serves a market series with money in it", async () => {
      const market = await getJson<{
        series: { bucketDate: string; totalTokens: number | null; totalSpendUsd: number | null }[];
        topModels: unknown[];
        priceIndex: unknown[];
        ratesByPermaslug: Record<string, unknown>;
      }>("/market");

      expect(market.series.length).toBeGreaterThan(30);
      const recent = market.series.slice(-8, -1);
      expect(recent).not.toHaveLength(0);
      for (const day of recent) {
        expect(day.totalTokens ?? 0).toBeGreaterThan(0);
        expect(day.totalSpendUsd ?? 0).toBeGreaterThan(0);
      }
      expect(market.topModels.length).toBeGreaterThan(0);
      expect(market.priceIndex.length).toBeGreaterThan(0);
      // Spend is the site's primary metric and it is priced from this map.
      expect(Object.keys(market.ratesByPermaslug).length).toBeGreaterThan(50);
    });

    it("serves the catalog", async () => {
      const models = await getJson<{ count: number; models: { modelId: string; latestTokens: number | null }[] }>("/models");
      expect(models.count).toBeGreaterThan(300);
      expect(models.models.some((m) => (m.latestTokens ?? 0) > 0)).toBe(true);
    });

    it("serves per-provider revenue", async () => {
      const providers = await getJson<{ series: unknown[]; models: unknown[] }>("/providers/market");
      expect(providers.series.length).toBeGreaterThan(0);
      expect(providers.models.length).toBeGreaterThan(0);
    });

    it("serves a fresh GPU price band for most accelerators", async () => {
      const gpu = await getJson<{
        accelerators: { name: string; latest: { capturedAt: string; offers: number; medianUsd: number | null } | null }[];
      }>("/gpu");
      expect(gpu.accelerators.length).toBeGreaterThan(10);

      const priced = gpu.accelerators.filter((a) => a.latest && a.latest.offers > 0 && a.latest.medianUsd !== null);
      expect(priced.length).toBeGreaterThan(gpu.accelerators.length / 2);
      const newest = Math.max(...priced.map((a) => Date.parse(a.latest!.capturedAt)));
      expect((Date.now() - newest) / 3_600_000).toBeLessThan(2);
    });

    it("serves the price explorer's feed for the busiest model", async () => {
      const market = await getJson<{ topModels: { modelId: string }[] }>("/market");
      const top = market.topModels[0]?.modelId;
      expect(top).toBeTruthy();
      const prices = await getJson<{ providers: string[]; points: unknown[] }>(
        `/model/provider-prices?id=${encodeURIComponent(top!)}`,
      );
      expect(prices.providers.length).toBeGreaterThan(0);
      expect(prices.points.length).toBeGreaterThan(0);
    });
  });

  describe("the site in front of it", () => {
    it("answers /health with a build stamp", async () => {
      const health = await getJson<{ ok: boolean; build: { commit: string } }>("/health");
      expect(health.ok).toBe(true);
      expect(health.build.commit).not.toBe("unknown");
    });

    // Skipped when only PROD_API_URL is given: there is no site to ask for.
    const site = BASE ? it : it.skip;

    site("serves the frontend, assets and all", async () => {
      const res = await get(`${BASE}/`);
      expect(res.status).toBe(200);
      const html = await res.text();
      expect(html).toContain('id="root"');

      // A built SPA whose bundle 404s renders a blank page and answers 200.
      const asset = /<script[^>]+src="([^"]+\.js)"/.exec(html)?.[1];
      expect(asset).toBeTruthy();
      const assetRes = await get(new URL(asset!, `${BASE}/`).toString());
      expect(assetRes.status).toBe(200);
      expect((await assetRes.text()).length).toBeGreaterThan(1000);
    });

    site("has a certificate that is not about to expire", async () => {
      const days = await certificateDaysLeft(BASE);
      if (days === null) return; // plain http, nothing to check
      if (days < CERT_WARN_DAYS) console.warn(`   warn  TLS certificate expires in ${days.toFixed(1)} days`);
      expect(days).toBeGreaterThan(CERT_FAIL_DAYS);
    });
  });
}
