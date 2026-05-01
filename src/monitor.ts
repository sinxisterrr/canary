// ---------------------------------------------------------------
// FILE: src/monitor.ts
// Pings each cloud model and returns structured status results.
// Features: concurrency throttle + exponential backoff on errors.
// ---------------------------------------------------------------

import fetch from "node-fetch";
import {
  OLLAMA_BASE_URL,
  DEGRADED_THRESHOLD_MS,
  REQUEST_TIMEOUT_MS,
  IGNORED_ERROR_CODES,
  PING_CONCURRENCY,
  BACKOFF_BASE_CYCLES,
  BACKOFF_MAX_CYCLES,
} from "./config.js";

export type ModelStatus = "up" | "degraded" | "down";

export interface ModelResult {
  model: string;
  status: ModelStatus;
  responseMs: number | null;
  error?: string;
  skipped?: boolean;     // true if we reused a cached result instead of pinging
  rateLimited?: boolean; // true if the API returned 429 — latency isn't a real speed read
  downSince?: Date | null; // set while the model has been continuously down
}

export interface PollResult {
  overall: ModelStatus;
  models: ModelResult[];
  checkedAt: Date;
  downSince: Date | null;
  totalCount: number;  // how many cloud models exist in total
  pingedCount: number; // how many were actually pinged this cycle (rest were backed-off)
}

// Per-model backoff + last-result cache. Keyed by full model tag.
interface BackoffState {
  consecutiveFailures: number;
  skipCyclesRemaining: number;
  lastResult: ModelResult | null;
  downSince: Date | null; // timestamp of the first "down" observation in the current streak
}
const backoff = new Map<string, BackoffState>();

// Wipe all per-model backoff state. Use after a long outage so stale "down since
// 23h ago" entries don't survive into the next poll — every model gets re-pinged
// from scratch and its downSince/failure counters reset.
export function resetBackoffState(): void {
  backoff.clear();
}

function getState(model: string): BackoffState {
  let s = backoff.get(model);
  if (!s) {
    s = {
      consecutiveFailures: 0,
      skipCyclesRemaining: 0,
      lastResult: null,
      downSince: null,
    };
    backoff.set(model, s);
  }
  return s;
}

// Minimal valid chat payload — no system prompt, no tools, 1-token ask
function buildPingPayload(model: string) {
  return {
    model,
    messages: [{ role: "user", content: "hi" }],
    stream: false,
    options: { num_predict: 1 },
  };
}

async function pingModel(model: string, apiKey: string): Promise<ModelResult> {
  const url = `${OLLAMA_BASE_URL}/api/chat`;
  const start = Date.now();

  const controller = new AbortController();
  const timeout = setTimeout(() => controller.abort(), REQUEST_TIMEOUT_MS);

  try {
    const res = await fetch(url, {
      method: "POST",
      headers: {
        "Content-Type": "application/json",
        Authorization: `Bearer ${apiKey}`,
      },
      body: JSON.stringify(buildPingPayload(model)),
      signal: controller.signal,
    });

    clearTimeout(timeout);
    const responseMs = Date.now() - start;

    if (IGNORED_ERROR_CODES.includes(res.status)) {
      return {
        model,
        status: "degraded",
        responseMs,
        rateLimited: true,
        error: `${res.status} (rate limited — account issue, not outage)`,
      };
    }

    if (!res.ok) {
      return { model, status: "down", responseMs, error: `HTTP ${res.status}` };
    }

    const status: ModelStatus =
      responseMs > DEGRADED_THRESHOLD_MS ? "degraded" : "up";
    return { model, status, responseMs };
  } catch (err: any) {
    clearTimeout(timeout);
    const isTimeout = err.name === "AbortError";
    return {
      model,
      status: "down",
      responseMs: null,
      error: isTimeout ? "timeout" : String(err.message),
    };
  }
}

// Run an async worker over `items` with at most `concurrency` in flight at once.
async function runWithConcurrency<T, R>(
  items: T[],
  concurrency: number,
  worker: (item: T) => Promise<R>
): Promise<R[]> {
  const results: R[] = new Array(items.length);
  let cursor = 0;

  async function next(): Promise<void> {
    while (true) {
      const i = cursor++;
      if (i >= items.length) return;
      results[i] = await worker(items[i]);
    }
  }

  const runners = Array.from({ length: Math.min(concurrency, items.length) }, () => next());
  await Promise.all(runners);
  return results;
}

function overallStatus(models: ModelResult[]): ModelStatus {
  if (models.some((m) => m.status === "down")) return "down";
  if (models.some((m) => m.status === "degraded")) return "degraded";
  return "up";
}

// Called once per poll for every cloud model. Handles backoff/skip and caches results.
async function checkModel(model: string, apiKey: string): Promise<ModelResult> {
  const state = getState(model);

  // Currently in backoff? Reuse last result and decrement the counter.
  if (state.skipCyclesRemaining > 0 && state.lastResult) {
    state.skipCyclesRemaining -= 1;
    return { ...state.lastResult, skipped: true, downSince: state.downSince };
  }

  const result = await pingModel(model, apiKey);

  if (result.status === "up") {
    state.consecutiveFailures = 0;
    state.skipCyclesRemaining = 0;
  } else {
    // Any non-up result (down OR degraded-due-to-429) contributes to backoff
    state.consecutiveFailures += 1;
    const cycles = Math.min(
      BACKOFF_BASE_CYCLES * Math.pow(2, state.consecutiveFailures - 1),
      BACKOFF_MAX_CYCLES
    );
    state.skipCyclesRemaining = cycles;
  }

  // Track per-model downSince — set on first "down" observation, cleared when it recovers
  if (result.status === "down") {
    if (!state.downSince) state.downSince = new Date();
  } else {
    state.downSince = null;
  }

  state.lastResult = result;
  return { ...result, downSince: state.downSince };
}

export async function pollAllModels(
  models: string[],
  apiKey: string,
  previousDownSince: Date | null
): Promise<PollResult> {
  const results = await runWithConcurrency(models, PING_CONCURRENCY, (m) =>
    checkModel(m, apiKey)
  );

  const overall = overallStatus(results);
  const pingedCount = results.filter((r) => !r.skipped).length;

  let downSince = previousDownSince;
  if (overall === "down" && !downSince) downSince = new Date();
  else if (overall !== "down") downSince = null;

  return {
    overall,
    models: results,
    checkedAt: new Date(),
    downSince,
    totalCount: models.length,
    pingedCount,
  };
}
