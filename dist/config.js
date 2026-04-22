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
export const POLL_INTERVAL_HEALTHY = 5 * 60 * 1000; // 5 min when green
export const POLL_INTERVAL_DEGRADED = 5 * 60 * 1000; // 5 min when yellow
export const POLL_INTERVAL_DOWN = 2 * 60 * 1000; // 2 min when red
// Thresholds
export const DEGRADED_THRESHOLD_MS = 10_000; // >10s response = yellow
export const REQUEST_TIMEOUT_MS = 30_000; // 30s hard timeout per model ping
// Concurrency — max simultaneous pings in flight.
// Ollama caps concurrent model access (paid = 3 simultaneous, free is likely lower).
// Staying under the cap is important: exceeding it puts requests into Ollama's queue,
// which inflates response times and pollutes the "fastest" ranking with queue wait.
export const PING_CONCURRENCY = 2;
// Backoff — after N consecutive errors, skip a model for a number of poll cycles.
// Capped low (4) so a recovering model is picked up within ~20 min at most — a
// higher cap (e.g. 16 = ~80 min) meant models that bounced back stayed "down"
// on the embed for too long.
export const BACKOFF_BASE_CYCLES = 1;
export const BACKOFF_MAX_CYCLES = 4;
// Status codes that mean OUR account has a problem, not Ollama Cloud
// These are ignored for outage detection but still count toward backoff
export const IGNORED_ERROR_CODES = [429];
// Display — how many models per category in the embed
export const DISPLAY_FASTEST = 4;
export const DISPLAY_AVERAGE = 4;
export const DISPLAY_SLOWEST = 4;
// Supplemental cloud tags that the scraper misses.
// Ollama's /search?c=cloud page only shows ~20 "featured" models, but older
// cloud tags (kimi-k2, mistral-large-3, qwen3-vl) are still valid endpoints.
// Any tag listed here is unioned with the discovered list on every scrape.
export const EXTRA_CLOUD_TAGS = [
    "kimi-k2:1t-cloud",
    "kimi-k2-thinking:cloud",
    "mistral-large-3:675b-cloud",
    "qwen3-vl:235b-cloud",
    "qwen3-vl:235b-instruct-cloud",
    "qwen3-coder:480b-cloud",
    "deepseek-v3.1:671b-cloud",
    "gemma3:4b-cloud",
    "gemma3:12b-cloud",
    "gemma3:27b-cloud",
    "glm-4.6:cloud",
    "gpt-oss:20b-cloud",
    "gpt-oss:120b-cloud",
    "minimax-m2:cloud",
    "minimax-m2.1:cloud",
];
// Discord
export const DISCORD_PING_ON_RED = false; // @here when status goes red
