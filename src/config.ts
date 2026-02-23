// ---------------------------------------------------------------
// FILE: src/config.ts
// Canary — Ollama Cloud Status Monitor
// All tunable values live here. Add models to MONITORED_MODELS.
// ---------------------------------------------------------------

export const MONITORED_MODELS = [
  "kimi-k2:1t-cloud",
  "kimi-k2.5:cloud",
  "qwen3-coder-next:cloud",
  "qwen3.5:cloud",
  "qwen3-vl:235b-cloud",
  "deepseek-v3.2:cloud",
  "glm-5:cloud",
  "mistral-large-3:675b-cloud",
  // Add new models here ↑ and they'll appear in the embed automatically
];

// Ollama Cloud endpoint
export const OLLAMA_BASE_URL = "https://ollama.com";

// Timing (ms)
export const POLL_INTERVAL_HEALTHY = 60 * 60 * 1000;   // 1 hour when green
export const POLL_INTERVAL_DEGRADED = 20 * 60 * 1000;  // 20 min when yellow
export const POLL_INTERVAL_DOWN = 15 * 60 * 1000;      // 15 min when red

// Thresholds
export const DEGRADED_THRESHOLD_MS = 10_000; // >10s response = yellow
export const REQUEST_TIMEOUT_MS = 30_000;    // 30s hard timeout per model ping

// Status codes that mean OUR account has a problem, not Ollama Cloud
// These are ignored for outage detection
export const IGNORED_ERROR_CODES = [429];

// Discord
export const DISCORD_PING_ON_RED = true; // @here when status goes red
