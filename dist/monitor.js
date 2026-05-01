// ---------------------------------------------------------------
// FILE: src/monitor.ts
// Pings each cloud model and returns structured status results.
// Features: concurrency throttle + exponential backoff on errors.
// ---------------------------------------------------------------
import fetch from "node-fetch";
import { promises as fs } from "node:fs";
import path from "node:path";
import { OLLAMA_BASE_URL, DEGRADED_THRESHOLD_MS, REQUEST_TIMEOUT_MS, IGNORED_ERROR_CODES, PING_CONCURRENCY, BACKOFF_BASE_CYCLES, BACKOFF_MAX_CYCLES, NETWORK_ERROR_PATTERNS, STATE_PATH, } from "./config.js";
const backoff = new Map();
// Wipe all per-model backoff state. Use after a long outage so stale "down since
// 23h ago" entries don't survive into the next poll — every model gets re-pinged
// from scratch and its downSince/failure counters reset.
export function resetBackoffState() {
    backoff.clear();
}
// Persist & rehydrate the backoff Map across restarts so a redeploy doesn't
// wipe every model's downSince and reset to "just now".
export async function loadPersistedState() {
    try {
        const raw = await fs.readFile(STATE_PATH, "utf8");
        const data = JSON.parse(raw);
        let restored = 0;
        for (const [model, s] of Object.entries(data)) {
            backoff.set(model, {
                consecutiveFailures: s.consecutiveFailures ?? 0,
                skipCyclesRemaining: 0, // don't carry skip cycles across restarts — re-evaluate
                lastResult: s.lastResult ?? null,
                downSince: s.downSince ? new Date(s.downSince) : null,
            });
            restored += 1;
        }
        console.log(`💾 Restored backoff state for ${restored} models`);
    }
    catch {
        // No state file yet, or unreadable — fine, start fresh
    }
}
export async function savePersistedState() {
    const obj = {};
    for (const [model, s] of backoff.entries()) {
        obj[model] = {
            consecutiveFailures: s.consecutiveFailures,
            skipCyclesRemaining: s.skipCyclesRemaining,
            lastResult: s.lastResult,
            downSince: s.downSince ? s.downSince.toISOString() : null,
        };
    }
    try {
        await fs.mkdir(path.dirname(STATE_PATH), { recursive: true });
        await fs.writeFile(STATE_PATH, JSON.stringify(obj), "utf8");
    }
    catch (err) {
        console.warn("⚠️  Failed to persist state:", err instanceof Error ? err.message : err);
    }
}
function getState(model) {
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
function isNetworkError(err) {
    const msg = err instanceof Error ? `${err.message} ${err.code ?? ""}` : String(err);
    return NETWORK_ERROR_PATTERNS.some((p) => msg.includes(p));
}
// Minimal valid chat payload — no system prompt, no tools, 1-token ask
function buildPingPayload(model) {
    return {
        model,
        messages: [{ role: "user", content: "hi" }],
        stream: false,
        options: { num_predict: 1 },
    };
}
async function pingModel(model, apiKey) {
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
        const status = responseMs > DEGRADED_THRESHOLD_MS ? "degraded" : "up";
        return { model, status, responseMs };
    }
    catch (err) {
        clearTimeout(timeout);
        const isTimeout = err.name === "AbortError";
        // Network error from our side (DNS lookup failed, connection refused, etc.)
        // — Ollama might be perfectly fine; flag separately so we don't blame the model.
        if (isNetworkError(err)) {
            return {
                model,
                status: "down",
                responseMs: null,
                unreachable: true,
                error: `network: ${err.code ?? err.message}`,
            };
        }
        return {
            model,
            status: "down",
            responseMs: null,
            error: isTimeout ? "timeout" : String(err.message),
        };
    }
}
// Run an async worker over `items` with at most `concurrency` in flight at once.
async function runWithConcurrency(items, concurrency, worker) {
    const results = new Array(items.length);
    let cursor = 0;
    async function next() {
        while (true) {
            const i = cursor++;
            if (i >= items.length)
                return;
            results[i] = await worker(items[i]);
        }
    }
    const runners = Array.from({ length: Math.min(concurrency, items.length) }, () => next());
    await Promise.all(runners);
    return results;
}
// Overall status excludes unreachable results — those are *our* network problem,
// not Ollama's, so they shouldn't drag the overall status to "down".
function overallStatus(models) {
    const real = models.filter((m) => !m.unreachable);
    if (real.some((m) => m.status === "down"))
        return "down";
    if (real.some((m) => m.status === "degraded"))
        return "degraded";
    return "up";
}
// Called once per poll for every cloud model. Handles backoff/skip and caches results.
async function checkModel(model, apiKey) {
    const state = getState(model);
    // Currently in backoff? Reuse last result and decrement the counter.
    if (state.skipCyclesRemaining > 0 && state.lastResult) {
        state.skipCyclesRemaining -= 1;
        return { ...state.lastResult, skipped: true, downSince: state.downSince };
    }
    const result = await pingModel(model, apiKey);
    // Network errors don't burn backoff — they're our problem and we want to keep
    // probing so we notice as soon as connectivity comes back. Also don't change
    // downSince, so a model that was "up" 5 min ago doesn't suddenly look "down".
    if (result.unreachable) {
        state.lastResult = result;
        return { ...result, downSince: state.downSince };
    }
    if (result.status === "up") {
        state.consecutiveFailures = 0;
        state.skipCyclesRemaining = 0;
    }
    else {
        // Any non-up, non-network result contributes to backoff
        state.consecutiveFailures += 1;
        const cycles = Math.min(BACKOFF_BASE_CYCLES * Math.pow(2, state.consecutiveFailures - 1), BACKOFF_MAX_CYCLES);
        state.skipCyclesRemaining = cycles;
    }
    if (result.status === "down") {
        if (!state.downSince)
            state.downSince = new Date();
    }
    else {
        state.downSince = null;
    }
    state.lastResult = result;
    return { ...result, downSince: state.downSince };
}
export async function pollAllModels(models, apiKey, previousDownSince) {
    const results = await runWithConcurrency(models, PING_CONCURRENCY, (m) => checkModel(m, apiKey));
    const overall = overallStatus(results);
    const pingedCount = results.filter((r) => !r.skipped).length;
    const unreachableCount = results.filter((r) => r.unreachable).length;
    let downSince = previousDownSince;
    if (overall === "down" && !downSince)
        downSince = new Date();
    else if (overall !== "down")
        downSince = null;
    // Fire-and-forget persist (don't block the poll on disk IO)
    savePersistedState().catch(() => { });
    return {
        overall,
        models: results,
        checkedAt: new Date(),
        downSince,
        totalCount: models.length,
        pingedCount,
        unreachableCount,
    };
}
