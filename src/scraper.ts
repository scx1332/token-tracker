// Resilient HTTP layer for scraping OpenRouter.
//
// OpenRouter's documented endpoints under /api/v1/* are plain JSON APIs, but the
// internal /api/frontend/* and Next.js data endpoints sit behind Cloudflare and
// occasionally serve a bot challenge. This module fetches with realistic browser
// headers, retries transient failures with exponential backoff, honors
// Retry-After, and detects Cloudflare challenges so a browser-based fallback can
// be plugged in (see `setBrowserFallback`). Keeping the fallback pluggable means
// the default image needs no headless browser; a captcha-solving path can be
// added later without touching call sites.

export class HttpError extends Error {
  constructor(
    public readonly status: number,
    public readonly url: string,
    public readonly bodySnippet: string,
  ) {
    super(`HTTP ${status} for ${url}: ${bodySnippet.slice(0, 200)}`);
    this.name = "HttpError";
  }
}

export class CloudflareChallengeError extends Error {
  constructor(public readonly url: string) {
    super(`Cloudflare challenge encountered for ${url}`);
    this.name = "CloudflareChallengeError";
  }
}

export interface FetchOptions {
  apiKey?: string | null;
  headers?: Record<string, string>;
  timeoutMs?: number;
  retries?: number;
  /** When true, a Cloudflare challenge tries the browser fallback (if configured). */
  allowBrowserFallback?: boolean;
  signal?: AbortSignal;
}

const USER_AGENTS = [
  "Mozilla/5.0 (Windows NT 10.0; Win64; x64) AppleWebKit/537.36 (KHTML, like Gecko) Chrome/131.0.0.0 Safari/537.36",
  "Mozilla/5.0 (Macintosh; Intel Mac OS X 10_15_7) AppleWebKit/537.36 (KHTML, like Gecko) Chrome/131.0.0.0 Safari/537.36",
  "Mozilla/5.0 (X11; Linux x86_64) AppleWebKit/537.36 (KHTML, like Gecko) Chrome/130.0.0.0 Safari/537.36",
];

let uaCursor = 0;
function nextUserAgent(): string {
  const ua = USER_AGENTS[uaCursor % USER_AGENTS.length]!;
  uaCursor += 1;
  return ua;
}

export type BrowserFallback = (url: string, headers: Record<string, string>) => Promise<string>;

let browserFallback: BrowserFallback | null = null;

/**
 * Register a browser-based fetch used when a Cloudflare challenge is detected.
 * Intended for a Playwright/Puppeteer implementation added out-of-band; left
 * unset by default so the standard deployment stays dependency-light.
 */
export function setBrowserFallback(fallback: BrowserFallback | null): void {
  browserFallback = fallback;
}

export function hasBrowserFallback(): boolean {
  return browserFallback !== null;
}

function browserHeaders(url: string, apiKey?: string | null): Record<string, string> {
  const origin = new URL(url).origin;
  const headers: Record<string, string> = {
    "User-Agent": nextUserAgent(),
    Accept: "application/json, text/plain, */*",
    "Accept-Language": "en-US,en;q=0.9",
    "Accept-Encoding": "gzip, deflate, br",
    Referer: `${origin}/`,
    Origin: origin,
    "sec-ch-ua": '"Chromium";v="131", "Not_A Brand";v="24"',
    "sec-ch-ua-mobile": "?0",
    "sec-ch-ua-platform": '"Windows"',
    "Sec-Fetch-Dest": "empty",
    "Sec-Fetch-Mode": "cors",
    "Sec-Fetch-Site": "same-origin",
  };
  if (apiKey) {
    headers.Authorization = `Bearer ${apiKey}`;
    // OpenRouter attribution headers (optional but polite).
    headers["HTTP-Referer"] = "https://token-tracker.arkiv-global.net";
    headers["X-Title"] = "token-tracker";
  }
  return headers;
}

function looksLikeCloudflareChallenge(status: number, headers: Headers, body: string): boolean {
  if (headers.get("cf-mitigated") === "challenge") return true;
  if (status === 403 || status === 503) {
    const lower = body.toLowerCase();
    if (
      lower.includes("just a moment") ||
      lower.includes("cf-challenge") ||
      lower.includes("challenge-platform") ||
      lower.includes("attention required")
    ) {
      return true;
    }
  }
  return false;
}

const sleep = (ms: number, signal?: AbortSignal) =>
  new Promise<void>((resolve, reject) => {
    if (signal?.aborted) return reject(new Error("aborted"));
    const timer = setTimeout(resolve, ms);
    signal?.addEventListener("abort", () => {
      clearTimeout(timer);
      reject(new Error("aborted"));
    }, { once: true });
  });

function backoffMs(attempt: number, retryAfterHeader: string | null): number {
  if (retryAfterHeader) {
    const seconds = Number(retryAfterHeader);
    if (Number.isFinite(seconds) && seconds > 0) return Math.min(seconds * 1000, 60_000);
  }
  const base = Math.min(1000 * 2 ** attempt, 30_000);
  return base + Math.floor(Math.random() * 500);
}

/** Fetch a URL and return the raw response body as text, with retries. */
export async function fetchText(url: string, opts: FetchOptions = {}): Promise<string> {
  const {
    apiKey = null,
    headers: extraHeaders = {},
    timeoutMs = 30_000,
    retries = 4,
    allowBrowserFallback = true,
    signal,
  } = opts;

  let lastError: unknown;

  for (let attempt = 0; attempt <= retries; attempt += 1) {
    const controller = new AbortController();
    const onAbort = () => controller.abort();
    signal?.addEventListener("abort", onAbort, { once: true });
    const timer = setTimeout(() => controller.abort(), timeoutMs);

    try {
      const response = await fetch(url, {
        headers: { ...browserHeaders(url, apiKey), ...extraHeaders },
        signal: controller.signal,
        redirect: "follow",
      });

      const body = await response.text();

      if (looksLikeCloudflareChallenge(response.status, response.headers, body)) {
        if (allowBrowserFallback && browserFallback) {
          return await browserFallback(url, browserHeaders(url, apiKey));
        }
        throw new CloudflareChallengeError(url);
      }

      if (response.status === 429 || response.status >= 500) {
        lastError = new HttpError(response.status, url, body);
        if (attempt < retries) {
          await sleep(backoffMs(attempt, response.headers.get("retry-after")), signal);
          continue;
        }
        throw lastError;
      }

      if (!response.ok) {
        throw new HttpError(response.status, url, body);
      }

      return body;
    } catch (error) {
      // Non-retryable errors bubble up immediately.
      if (error instanceof HttpError && error.status < 500 && error.status !== 429) throw error;
      if (error instanceof CloudflareChallengeError) throw error;
      lastError = error;
      if (attempt < retries) {
        await sleep(backoffMs(attempt, null), signal);
        continue;
      }
      throw error;
    } finally {
      clearTimeout(timer);
      signal?.removeEventListener("abort", onAbort);
    }
  }

  throw lastError ?? new Error(`Failed to fetch ${url}`);
}

/** Fetch a URL and parse the body as JSON. */
export async function fetchJson<T = unknown>(url: string, opts: FetchOptions = {}): Promise<T> {
  const text = await fetchText(url, opts);
  try {
    return JSON.parse(text) as T;
  } catch {
    throw new Error(`Invalid JSON from ${url}: ${text.slice(0, 200)}`);
  }
}
