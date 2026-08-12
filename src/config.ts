// Environment / CLI configuration for the ingest worker and the HTTP server.

export interface IngestConfig {
  databaseUrl: string;
  apiKey: string | null;
  baseUrl: string;
  intervalMs: number;
  concurrency: number;
  requestDelayMs: number;
  fetchEndpoints: boolean;
  fetchUsage: boolean;
  backfillDays: number;
  once: boolean;
}

export interface ServerConfig {
  databaseUrl: string;
  port: number;
  hostname?: string;
}

const DEFAULT_BASE_URL = "https://openrouter.ai";
const DEFAULT_INTERVAL_MS = 3_600_000; // 1 hour
const DEFAULT_CONCURRENCY = 6;
const DEFAULT_REQUEST_DELAY_MS = 120;
const DEFAULT_BACKFILL_DAYS = 120;
const DEFAULT_PORT = 3000;

export class HelpRequested extends Error {}

export function parseIngestConfig(
  args: string[] = [],
  env: NodeJS.ProcessEnv = process.env,
): IngestConfig {
  const parsed = parseArgs(args);
  if (parsed.help) throw new HelpRequested(ingestUsage());

  const databaseUrl = parsed.values["database-url"] ?? env.DATABASE_URL;
  if (!databaseUrl) throw new Error("DATABASE_URL (or --database-url) is required");

  return {
    databaseUrl,
    apiKey: nonEmpty(parsed.values["api-key"] ?? env.OPENROUTER_API_KEY),
    baseUrl: stripTrailingSlash(parsed.values["base-url"] ?? env.OPENROUTER_BASE_URL ?? DEFAULT_BASE_URL),
    intervalMs: parseNumber("--interval-ms", parsed.values["interval-ms"] ?? env.INGEST_INTERVAL_MS ?? String(DEFAULT_INTERVAL_MS)),
    concurrency: Math.max(1, parseNumber("--concurrency", parsed.values.concurrency ?? env.INGEST_CONCURRENCY ?? String(DEFAULT_CONCURRENCY))),
    requestDelayMs: parseNumber("--request-delay-ms", parsed.values["request-delay-ms"] ?? env.INGEST_REQUEST_DELAY_MS ?? String(DEFAULT_REQUEST_DELAY_MS)),
    fetchEndpoints: parseBoolean(parsed.values["fetch-endpoints"] ?? env.INGEST_FETCH_ENDPOINTS ?? "true"),
    fetchUsage: parseBoolean(parsed.values["fetch-usage"] ?? env.INGEST_FETCH_USAGE ?? "true"),
    backfillDays: parseNumber("--backfill-days", parsed.values["backfill-days"] ?? env.BACKFILL_DAYS ?? String(DEFAULT_BACKFILL_DAYS)),
    once: parsed.flags.has("once"),
  };
}

export function parseServerConfig(
  args: string[] = [],
  env: NodeJS.ProcessEnv = process.env,
): ServerConfig {
  const parsed = parseArgs(args);
  if (parsed.help) throw new HelpRequested(serverUsage());

  const databaseUrl = parsed.values["database-url"] ?? env.DATABASE_URL;
  if (!databaseUrl) throw new Error("DATABASE_URL (or --database-url) is required");

  const port = parsePort("--port", parsed.values.port ?? env.SERVER_PORT ?? String(DEFAULT_PORT));
  const hostname = parsed.values.host ?? env.SERVER_HOSTNAME;

  return {
    databaseUrl,
    port,
    ...(hostname ? { hostname } : {}),
  };
}

interface ParsedArgs {
  help: boolean;
  values: Record<string, string>;
  flags: Set<string>;
}

// Supports `--key value`, `--key=value`, and boolean `--flag` (no value).
function parseArgs(args: string[]): ParsedArgs {
  const result: ParsedArgs = { help: false, values: {}, flags: new Set() };
  const booleanFlags = new Set(["once", "help"]);

  for (let index = 0; index < args.length; index += 1) {
    const arg = args[index];
    if (!arg?.startsWith("--")) throw new Error(`Unexpected argument: ${arg}`);

    const [rawKey, inlineValue] = arg.slice(2).split("=", 2);
    if (!rawKey) throw new Error(`Invalid argument: ${arg}`);

    if (rawKey === "help") {
      result.help = true;
      continue;
    }

    if (booleanFlags.has(rawKey) && inlineValue === undefined) {
      const next = args[index + 1];
      if (next === undefined || next.startsWith("--")) {
        result.flags.add(rawKey);
        continue;
      }
    }

    const value = inlineValue ?? args[index + 1];
    if (value === undefined || value.startsWith("--")) throw new Error(`Missing value for --${rawKey}`);
    result.values[rawKey] = value;
    if (inlineValue === undefined) index += 1;
  }

  return result;
}

function parseNumber(name: string, value: string): number {
  const n = Number(value);
  if (!Number.isFinite(n) || n < 0) throw new Error(`${name} must be a non-negative number`);
  return n;
}

function parsePort(name: string, value: string): number {
  if (!/^\d+$/.test(value)) throw new Error(`${name} must be an integer`);
  const n = Number(value);
  if (!Number.isSafeInteger(n) || n < 0 || n > 65_535) throw new Error(`${name} must be 0-65535`);
  return n;
}

function parseBoolean(value: string): boolean {
  const v = value.toLowerCase();
  if (["true", "1", "yes", "on"].includes(v)) return true;
  if (["false", "0", "no", "off"].includes(v)) return false;
  throw new Error(`Expected a boolean, got "${value}"`);
}

function nonEmpty(value: string | undefined): string | null {
  const trimmed = value?.trim();
  return trimmed ? trimmed : null;
}

function stripTrailingSlash(url: string): string {
  return url.replace(/\/+$/, "");
}

function ingestUsage(): string {
  return `Usage:
  DATABASE_URL=postgres://user:pass@host:5432/db OPENROUTER_API_KEY=sk-or-... bun run ingest

Options:
  --database-url <url>        PostgreSQL connection string (or DATABASE_URL).
  --api-key <key>             OpenRouter API key (or OPENROUTER_API_KEY).
  --base-url <url>            OpenRouter base URL. Default https://openrouter.ai
  --interval-ms <n>           Loop interval. Default 3600000 (1h).
  --concurrency <n>           Parallel provider-endpoint fetches. Default 6.
  --request-delay-ms <n>      Delay between endpoint requests. Default 120.
  --fetch-endpoints <bool>    Fetch per-provider pricing. Default true.
  --fetch-usage <bool>        Fetch usage/ranking analytics. Default true.
  --once                      Run a single pass and exit.
  --help                      Show this message.`;
}

function serverUsage(): string {
  return `Usage:
  DATABASE_URL=postgres://user:pass@host:5432/db bun run serve

Options:
  --database-url <url>  PostgreSQL connection string (or DATABASE_URL).
  --port <port>         TCP port. Default 3000 (or SERVER_PORT). 0 = any free port.
  --host <host>         Interface to bind. Default all interfaces.
  --help                Show this message.`;
}
