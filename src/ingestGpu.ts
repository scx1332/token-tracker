// Ingest pass for the vast.ai GPU rental market.
//
// Runs alongside the OpenRouter pass but stays deliberately separate: a vast.ai
// outage must not fail a token-price pass, and vice versa. One pass enumerates
// each tracked accelerator's offer book, collapses it to a price band, and
// writes one row per GPU stamped with a single shared capture time so a pass is
// one clean vertical slice of the market.

import { VastAiClient } from "./vastai";
import { summarizeOffers } from "./gpu";
import { ACCELERATORS } from "./accelerators";
import { mapPool } from "./concurrency";
import type { Storage, GpuPriceSnapshotInsert } from "./storage";

export interface GpuIngestResult {
  gpusTracked: number;
  gpusWithOffers: number;
  rowsWritten: number;
  errors: string[];
  durationMs: number;
}

export interface GpuIngestDeps {
  storage: Storage;
  client: VastAiClient;
  concurrency?: number;
  requestDelayMs?: number;
  signal?: AbortSignal;
  log?: (msg: string) => void;
}

export async function runGpuIngestion(deps: GpuIngestDeps): Promise<GpuIngestResult> {
  const { storage, client, signal } = deps;
  const log = deps.log ?? (() => {});
  const startedMs = Date.now();
  const errors: string[] = [];

  // One timestamp for the whole pass: the offer books are read seconds apart but
  // represent the same market moment, and a shared key makes cross-GPU
  // comparison at a given instant a plain WHERE captured_at = ... .
  const capturedAt = new Date();

  const snapshots = await mapPool(
    ACCELERATORS,
    Math.max(1, deps.concurrency ?? 4),
    async (accelerator): Promise<GpuPriceSnapshotInsert | null> => {
      try {
        const offers = await client.listOffers(accelerator.name, signal);
        return summarizeOffers(accelerator.name, offers);
      } catch (error) {
        const message = error instanceof Error ? error.message : String(error);
        errors.push(`${accelerator.name}: ${message}`);
        return null;
      }
    },
    { ...(deps.requestDelayMs ? { delayMs: deps.requestDelayMs } : {}), ...(signal ? { signal } : {}) },
  );

  // A GPU with zero offers is a real observation — supply dried up — so it is
  // stored as a zero-depth row rather than dropped. Only fetch failures (null)
  // are skipped, because those say nothing about the market.
  const rows = snapshots.filter((snap): snap is GpuPriceSnapshotInsert => snap !== null);
  const withOffers = rows.filter((row) => row.offers > 0).length;

  const rowsWritten = await storage.insertGpuPriceSnapshots(capturedAt, rows);
  log(`vast.ai: ${withOffers}/${ACCELERATORS.length} GPUs with live offers, ${rowsWritten} rows`);

  return {
    gpusTracked: ACCELERATORS.length,
    gpusWithOffers: withOffers,
    rowsWritten,
    errors,
    durationMs: Date.now() - startedMs,
  };
}
