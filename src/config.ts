// ---------------------------------------------------------------
// FILE: src/config.ts
// Canary — Ollama Cloud Status Monitor
// All tunable values live here. Model list is discovered automatically.
// ---------------------------------------------------------------

// Ollama Cloud endpoint
export const OLLAMA_BASE_URL = "https://ollama.com";

// Where to scrape the cloud model catalog from
export const OLLAMA_CLOUD_SEARCH_URL = "https://ollama.com/search?c=cloud";

// Local JSON cache of discovered models
export const MODEL_CACHE_PATH = "cache/models.json";

// How often to re-scrape the cloud catalog for newly-added models
export const DISCOVERY_REFRESH_MS = 6 * 60 * 60 * 1000; // 6 hours

// Timing (ms)
export const POLL_INTERVAL_HEALTHY = 5 * 60 * 1000;   // 5 min when green
export const POLL_INTERVAL_DEGRADED = 5 * 60 * 1000;  // 5 min when yellow
export const POLL_INTERVAL_DOWN = 2 * 60 * 1000;      // 2 min when red

// Thresholds
export const DEGRADED_THRESHOLD_MS = 10_000; // >10s response = yellow
export const REQUEST_TIMEOUT_MS = 30_000;    // 30s hard timeout per model ping

// Concurrency — max simultaneous pings in flight.
// Ollama caps concurrent model access (paid = 3 simultaneous, free is likely lower).
// Staying under the cap is important: exceeding it puts requests into Ollama's queue,
// which inflates response times and pollutes the "fastest" ranking with queue wait.
export const PING_CONCURRENCY = 2;

// Backoff — after N consecutive errors, skip a model for a number of poll cycles
export const BACKOFF_BASE_CYCLES = 1;   // first failure: skip 1 cycle
export const BACKOFF_MAX_CYCLES = 16;   // cap exponential growth

// Status codes that mean OUR account has a problem, not Ollama Cloud
// These are ignored for outage detection but still count toward backoff
export const IGNORED_ERROR_CODES = [429];

// Display — how many models per category in the embed
export const DISPLAY_FASTEST = 3;
export const DISPLAY_AVERAGE = 3;
export const DISPLAY_SLOWEST = 3;

// Discord
export const DISCORD_PING_ON_RED = false; // @here when status goes red
