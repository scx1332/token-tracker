/** Run `worker` over `items` with a bounded number of concurrent tasks. */
export async function mapPool<T, R>(
  items: T[],
  concurrency: number,
  worker: (item: T, index: number) => Promise<R>,
  opts: { delayMs?: number; signal?: AbortSignal } = {},
): Promise<R[]> {
  const results: R[] = new Array(items.length);
  const width = Math.max(1, Math.min(concurrency, items.length || 1));
  let cursor = 0;

  async function run(): Promise<void> {
    while (true) {
      if (opts.signal?.aborted) return;
      const index = cursor++;
      if (index >= items.length) return;
      results[index] = await worker(items[index]!, index);
      if (opts.delayMs && opts.delayMs > 0) await sleep(opts.delayMs);
    }
  }

  await Promise.all(Array.from({ length: width }, () => run()));
  return results;
}

export function sleep(ms: number): Promise<void> {
  return new Promise((resolve) => setTimeout(resolve, ms));
}
