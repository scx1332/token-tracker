// Typed client for the vast.ai GPU rental marketplace.
//
// Only the public `/api/v0/bundles/` search endpoint is used: it needs no
// credentials and returns the live on-demand offer book. The documented
// market-metrics endpoints (`/api/v0/metrics/gpu/history/`) would give real
// historical series, but they require an API key carrying the `machine_read`
// permission group, which host accounts get and client accounts do not — see
// `fetchGpuHistory` below, wired up but inert without such a key.
//
// Two quirks drive the shape of this module:
//
//  1. The search is a GET with the whole query as a JSON blob in `?q=`. A `PUT`
//     (as some older docs show) 404s.
//  2. The server caps every response at 64 offers regardless of `limit`, and
//     ignores `offset` — passing it yields an empty list. So paging is keyset
//     style: re-query with `dph_total >= last_seen_max`, deduplicating by offer
//     id. `RTX 4090` alone needs four rounds to enumerate ~250 offers.

import { fetchJson, type FetchOptions } from "./scraper";

/** One machine offer from the bundles search. Only fields we consume are typed. */
export interface VastOffer {
  id: number;
  /** Physical host machine. One machine spawns several chunk offers (1×/2×/4×/8×). */
  machine_id?: number | null;
  gpu_name?: string | null;
  num_gpus?: number | null;
  /** Total on-demand price for the whole machine, USD/hour. */
  dph_total?: number | null;
  /** Host's base ask before vast.ai's margin, USD/hour for the machine. */
  dph_base?: number | null;
  /** Floor price for interruptible (spot) rental, USD/hour for the machine. */
  min_bid?: number | null;
  /** "verified" | "unverified" | "deverified". */
  verification?: string | null;
  rentable?: boolean | null;
  rented?: boolean | null;
  gpu_ram?: number | null;
  cuda_max_good?: number | null;
  dlperf?: number | null;
  geolocation?: string | null;
  [key: string]: unknown;
}

interface BundlesResponse {
  offers?: VastOffer[] | null;
}

/** Server-side cap on offers per response, regardless of the `limit` we send. */
const PAGE_CAP = 64;
/** Safety stop for keyset paging; 64 * 40 offers is far beyond any real GPU. */
const MAX_ROUNDS = 40;

export class VastAiClient {
  constructor(
    private readonly baseUrl: string,
    private readonly apiKey: string | null = null,
    private readonly defaults: FetchOptions = {},
  ) {}

  private opts(extra: FetchOptions = {}): FetchOptions {
    // The bundles endpoint is public; sending a key is harmless but pointless.
    // Cloudflare does not challenge console.vast.ai, so no browser fallback.
    return { allowBrowserFallback: false, ...this.defaults, ...extra };
  }

  private async searchPage(query: Record<string, unknown>, signal?: AbortSignal): Promise<VastOffer[]> {
    const url = `${this.baseUrl}/api/v0/bundles/?q=${encodeURIComponent(JSON.stringify(query))}`;
    const body = await fetchJson<BundlesResponse>(url, this.opts(signal ? { signal } : {}));
    return body.offers ?? [];
  }

  /**
   * Every rentable on-demand offer for one GPU model, paged past the 64-offer
   * response cap. Offers are returned in ascending machine price.
   */
  async listOffers(gpuName: string, signal?: AbortSignal): Promise<VastOffer[]> {
    const byId = new Map<number, VastOffer>();
    let cursor = 0;

    for (let round = 0; round < MAX_ROUNDS; round += 1) {
      const page = await this.searchPage(
        {
          gpu_name: { eq: gpuName },
          type: "on-demand",
          rentable: { eq: true },
          dph_total: { gte: cursor },
          order: [["dph_total", "asc"]],
          limit: PAGE_CAP,
        },
        signal,
      );
      if (page.length === 0) break;

      for (const offer of page) byId.set(offer.id, offer);
      if (page.length < PAGE_CAP) break;

      const maxDph = page.reduce((m, o) => Math.max(m, numeric(o.dph_total) ?? 0), 0);
      // A full page whose prices are all <= the cursor means more than PAGE_CAP
      // offers are tied at exactly this price. Nudge past it: those extra ties
      // are unreachable through this API, and skipping them beats looping.
      cursor = maxDph > cursor ? maxDph : cursor + 1e-6;
    }

    return [...byId.values()];
  }

  /**
   * Historical market metrics for one GPU. Requires an API key with the
   * `machine_read` permission group (host accounts only) — without one the
   * endpoint answers 401 and this returns null, so callers can treat real
   * history as an optional enrichment on top of the live snapshots.
   */
  async fetchGpuHistory(
    gpuName: string,
    startSec: number,
    endSec: number,
    stepSec: number,
    signal?: AbortSignal,
  ): Promise<unknown | null> {
    if (!this.apiKey) return null;
    const params = new URLSearchParams({
      gpu_name: gpuName,
      verified: "all",
      start: String(Math.floor(startSec)),
      end: String(Math.floor(endSec)),
      step: String(Math.floor(stepSec)),
    });
    try {
      return await fetchJson<unknown>(
        `${this.baseUrl}/api/v0/metrics/gpu/history/?${params.toString()}`,
        this.opts({ apiKey: this.apiKey, retries: 1, ...(signal ? { signal } : {}) }),
      );
    } catch {
      return null;
    }
  }
}

/** Coerce a possibly-null/string numeric field to a finite number, else null. */
export function numeric(value: unknown): number | null {
  if (value === null || value === undefined) return null;
  const n = typeof value === "number" ? value : Number(value);
  return Number.isFinite(n) ? n : null;
}
