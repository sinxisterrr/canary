// ---------------------------------------------------------------
// FILE: src/categorize.ts
// Buckets ping results into Fastest / Average / Slowest / Rate Limited / Down.
// Pure function — no state, no hardcoded model names.
// ---------------------------------------------------------------
import { DISPLAY_FASTEST, DISPLAY_AVERAGE, DISPLAY_SLOWEST, } from "./config.js";
/**
 * Split results into five buckets. A model appears in exactly one bucket.
 *
 * - Down: hard failures (HTTP 500, timeouts, etc.)
 * - Rate Limited: 429s — responded fast but not with a real speed read,
 *   kept out of the speed buckets so they don't pollute rankings.
 * - Fastest / Average / Slowest: drawn from the remaining responding pool.
 */
export function categorize(results) {
    const down = results.filter((r) => r.status === "down");
    const rateLimited = results.filter((r) => r.rateLimited);
    // Only models that gave a real, successful latency measurement feed the speed buckets.
    // Any result with an error field set (HTTP 403/500/etc., rate-limit, timeout) is excluded —
    // its latency isn't a meaningful speed signal.
    const responding = results
        .filter((r) => !r.rateLimited && !r.error && r.status !== "down" && r.responseMs !== null)
        .sort((a, b) => (a.responseMs ?? 0) - (b.responseMs ?? 0));
    const pool = [...responding];
    const fastest = pool.splice(0, DISPLAY_FASTEST);
    const slowest = pool.splice(-DISPLAY_SLOWEST).reverse();
    const average = [];
    if (pool.length > 0) {
        const median = pool[Math.floor(pool.length / 2)].responseMs ?? 0;
        const byProximity = [...pool].sort((a, b) => {
            const da = Math.abs((a.responseMs ?? 0) - median);
            const db = Math.abs((b.responseMs ?? 0) - median);
            return da - db;
        });
        average.push(...byProximity.slice(0, DISPLAY_AVERAGE));
        average.sort((a, b) => (a.responseMs ?? 0) - (b.responseMs ?? 0));
    }
    return { fastest, average, slowest, rateLimited, down };
}
