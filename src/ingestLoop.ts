import { parseIngestConfig, HelpRequested } from "./config";
import { OpenRouterClient } from "./openrouter";
import { Storage } from "./storage";
import { runIngestion } from "./ingest";
import { runBackfill } from "./backfill";
import { runGpuIngestion } from "./ingestGpu";
import { VastAiClient } from "./vastai";
import { sleep } from "./concurrency";

async function main(): Promise<void> {
  let config;
  try {
    config = parseIngestConfig(process.argv.slice(2));
  } catch (error) {
    if (error instanceof HelpRequested) {
      console.log(error.message);
      return;
    }
    throw error;
  }

  const storage = await Storage.open(config.databaseUrl);
  const client = new OpenRouterClient(config.baseUrl, config.apiKey);
  const vastClient = new VastAiClient(config.vastBaseUrl, config.vastApiKey);
  const controller = new AbortController();
  let stopping = false;

  const shutdown = async () => {
    stopping = true;
    controller.abort();
    try {
      await storage.close();
    } catch {
      // ignore
    }
    process.exit(0);
  };
  process.on("SIGINT", shutdown);
  process.on("SIGTERM", shutdown);

  const log = (msg: string) => console.log(`[ingest ${new Date().toISOString()}] ${msg}`);
  log(`starting (interval ${Math.round(config.intervalMs / 1000)}s, endpoints=${config.fetchEndpoints}, usage=${config.fetchUsage}, key=${config.apiKey ? "yes" : "no"})`);

  let backfilled = (await storage.getState("backfill_done")) !== null;

  do {
    const started = Date.now();
    let passOk = false;
    try {
      const result = await runIngestion({ storage, client, config, signal: controller.signal, log });
      passOk = true;
      log(`pass ok: models=${result.modelsSeen} priceChanges=${result.priceChanges} usageRows=${result.usageRows} deactivated=${result.deactivated} in ${result.durationMs}ms`);
      if (result.errors.length) log(`warnings: ${result.errors.join("; ")}`);
    } catch (error) {
      log(`pass FAILED: ${error instanceof Error ? error.message : String(error)}`);
    }

    // GPU rental prices are an independent data source: a vast.ai failure must
    // not mark the OpenRouter pass bad, so it runs in its own try even when the
    // pass above threw.
    if (config.fetchGpu && !stopping) {
      try {
        const g = await runGpuIngestion({
          storage,
          client: vastClient,
          concurrency: Math.min(4, config.concurrency),
          requestDelayMs: config.requestDelayMs,
          signal: controller.signal,
          log,
        });
        if (g.errors.length) log(`vast.ai warnings: ${g.errors.join("; ")}`);
      } catch (error) {
        log(`vast.ai pass FAILED: ${error instanceof Error ? error.message : String(error)}`);
      }
    }

    // One-time deep history backfill after the catalog first populates.
    if (passOk && !backfilled && config.fetchUsage && !stopping) {
      try {
        log("running one-time historical backfill (provider-token-chart)...");
        const b = await runBackfill({ storage, client, config, signal: controller.signal, log });
        await storage.setState("backfill_done", new Date().toISOString());
        backfilled = true;
        log(`backfill complete: ${b.rows} rows across ${b.models} models`);
      } catch (error) {
        log(`backfill failed (will retry next pass): ${error instanceof Error ? error.message : String(error)}`);
      }
    }

    if (config.once || stopping) break;
    const wait = Math.max(0, config.intervalMs - (Date.now() - started));
    log(`next pass in ${Math.round(wait / 1000)}s`);
    await sleep(wait);
  } while (!stopping);

  if (config.once) await storage.close();
}

await main();
