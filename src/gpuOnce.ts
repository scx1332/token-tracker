// Run a single vast.ai GPU sweep and exit. Operational tool: lets you add an
// intraday data point (or verify a fence change against the live market) from
// inside the ingest container without waiting for the loop's next tick:
//
//   docker compose exec ingest bun run gpu-once
//
// Prints the per-GPU band it wrote, so the output doubles as a sanity check
// against what vast.ai's own search UI shows.

import { parseIngestConfig, HelpRequested } from "./config";
import { Storage } from "./storage";
import { VastAiClient } from "./vastai";
import { runGpuIngestion } from "./ingestGpu";

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
  try {
    const client = new VastAiClient(config.vastBaseUrl, config.vastApiKey);
    const result = await runGpuIngestion({
      storage,
      client,
      concurrency: Math.min(4, config.concurrency),
      requestDelayMs: config.requestDelayMs,
      log: (msg) => console.log(msg),
    });
    if (result.errors.length) console.log(`warnings: ${result.errors.join("; ")}`);

    const latest = await storage.getGpuLatest();
    const f = (v: number | null) => (v === null ? "   --  " : `$${v.toFixed(3)}`);
    for (const row of latest) {
      console.log(
        `${row.gpuName.padEnd(16)} min ${f(row.minUsd)}  med ${f(row.medianUsd)}  ` +
          `p75 ${f(row.p75Usd)}  bid ${f(row.minBidUsd)}  ` +
          `offers ${String(row.offers).padStart(4)}  gpus ${String(row.gpusAvailable).padStart(5)}  ` +
          `fenced ${row.excludedOffers}`,
      );
    }
  } finally {
    await storage.close();
  }
}

await main();
