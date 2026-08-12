import { fetchJson, fetchText, type FetchOptions } from "./scraper";
import type { OpenRouterEndpoint, OpenRouterModel } from "./types";

export interface ModelsResponse {
  data: (OpenRouterModel & { links?: { details?: string } })[];
}

export interface EndpointsResponse {
  data: {
    id?: string;
    name?: string;
    slug?: string;
    endpoints?: OpenRouterEndpoint[];
  };
}

export interface KeyInfo {
  data?: {
    label?: string;
    usage?: number;
    limit?: number | null;
    is_free_tier?: boolean;
    rate_limit?: { requests?: number; interval?: string };
  };
}

export class OpenRouterClient {
  constructor(
    private readonly baseUrl: string,
    private readonly apiKey: string | null,
    private readonly defaults: FetchOptions = {},
  ) {}

  private opts(extra: FetchOptions = {}): FetchOptions {
    return { apiKey: this.apiKey, ...this.defaults, ...extra };
  }

  /** All models with top-level pricing. Public endpoint. */
  async getModels(signal?: AbortSignal): Promise<ModelsResponse> {
    return fetchJson<ModelsResponse>(`${this.baseUrl}/api/v1/models`, this.opts(signal ? { signal } : {}));
  }

  /**
   * Per-provider endpoints (with per-provider pricing, uptime, quantization) for
   * a single model. `modelRef` may be a full model id, a canonical slug, or the
   * `links.details` path from getModels().
   */
  async getModelEndpoints(modelRef: string, signal?: AbortSignal): Promise<EndpointsResponse> {
    const path = modelRef.startsWith("/")
      ? modelRef
      : `/api/v1/models/${endpointsSlug(modelRef)}/endpoints`;
    return fetchJson<EndpointsResponse>(`${this.baseUrl}${path}`, this.opts(signal ? { signal } : {}));
  }

  /** Authenticated: info about the API key (usage, limits, rate limits). */
  async getKeyInfo(signal?: AbortSignal): Promise<KeyInfo | null> {
    if (!this.apiKey) return null;
    try {
      return await fetchJson<KeyInfo>(`${this.baseUrl}/api/v1/key`, this.opts(signal ? { signal } : {}));
    } catch {
      return null;
    }
  }

  /** Fetch an arbitrary /api/frontend/* JSON endpoint (usage/rankings analytics). */
  async getFrontendJson<T = unknown>(path: string, signal?: AbortSignal): Promise<T> {
    const clean = path.startsWith("/") ? path : `/${path}`;
    return fetchJson<T>(`${this.baseUrl}${clean}`, this.opts(signal ? { signal } : {}));
  }

  /**
   * Discover the Next.js build id, needed for `/_next/data/<buildId>/...json`
   * endpoints that back some rendered pages.
   */
  async discoverBuildId(signal?: AbortSignal): Promise<string | null> {
    try {
      const html = await fetchText(`${this.baseUrl}/`, this.opts(signal ? { signal } : {}));
      const m = html.match(/"buildId":"([^"]+)"/);
      return m?.[1] ?? null;
    } catch {
      return null;
    }
  }
}

/** Convert a model id/slug into the `author/slug` path used by the endpoints API. */
export function endpointsSlug(modelRef: string): string {
  // Strip a leading "~" alias marker and any ":variant" suffix (e.g. ":free", ":batch").
  return modelRef.replace(/^~/, "").split(":")[0]!;
}

/** Derive the author (provider org) from a model id, e.g. "z-ai/glm-5.2" -> "z-ai". */
export function modelAuthor(modelId: string): string {
  const cleaned = modelId.replace(/^~/, "");
  const slash = cleaned.indexOf("/");
  return slash === -1 ? cleaned : cleaned.slice(0, slash);
}

/** The variant suffix after ":" if present (e.g. "batch", "free"), else null. */
export function modelVariant(modelId: string): string | null {
  const colon = modelId.indexOf(":");
  return colon === -1 ? null : modelId.slice(colon + 1);
}
