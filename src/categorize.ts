// ---------------------------------------------------------------
// FILE: src/categorize.ts
// Buckets ping results into Fastest / Average / Slowest / Down.
// Pure function — no state, no hardcoded model names.
// ---------------------------------------------------------------

import { ModelResult } from "./monitor.js";
import {
  DISPLAY_FASTEST,
  DISPLAY_AVERAGE,
  DISPLAY_SLOWEST,
} from "./config.js";

export interface Buckets {
  fastest: ModelResult[];
  average: ModelResult[];
  slowest: ModelResult[];
  down: ModelResult[];
}

/**
 * Split results into four buckets. A model appears in exactly one bucket.
 * Selection order: down → fastest → slowest → average (from the responding pool).
 * This guarantees no dedup logic is needed — once picked, a model is removed
 * from the candidate pool.
 */
export function categorize(results: ModelResult[]): Buckets {
  // Down is always shown when present — includes hard failures AND ignored-code 429s
  const down = results.filter((r) => r.status === "down");

  // Only models that actually responded are eligible for speed buckets
  const responding = results
    .filter((r) => r.responseMs !== null)
    .sort((a, b) => (a.responseMs ?? 0) - (b.responseMs ?? 0));

  const pool = [...responding];

  const fastest = pool.splice(0, DISPLAY_FASTEST);
  const slowest = pool.splice(-DISPLAY_SLOWEST).reverse(); // slowest first

  // "Average" = models closest to the median of the remaining pool
  const average: ModelResult[] = [];
  if (pool.length > 0) {
    const median = pool[Math.floor(pool.length / 2)].responseMs ?? 0;
    const byProximity = [...pool].sort((a, b) => {
      const da = Math.abs((a.responseMs ?? 0) - median);
      const db = Math.abs((b.responseMs ?? 0) - median);
      return da - db;
    });
    average.push(...byProximity.slice(0, DISPLAY_AVERAGE));
    // Present average-bucket in actual latency order, low → high
    average.sort((a, b) => (a.responseMs ?? 0) - (b.responseMs ?? 0));
  }

  return { fastest, average, slowest, down };
}
