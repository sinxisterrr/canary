// ---------------------------------------------------------------
// FILE: src/monitor.ts
// Pings each model and returns structured status results
// ---------------------------------------------------------------
import fetch from "node-fetch";
import { MONITORED_MODELS, OLLAMA_BASE_URL, DEGRADED_THRESHOLD_MS, REQUEST_TIMEOUT_MS, IGNORED_ERROR_CODES, } from "./config.js";
// Minimal valid chat payload — no system prompt, no tools, tiny token ask
function buildPingPayload(model) {
    return {
        model,
        messages: [{ role: "user", content: "hi" }],
        stream: false,
        options: { num_predict: 1 }, // ask for 1 token — we just want a 200 back
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
        // Codes we ignore — these are account-level issues, not outages
        if (IGNORED_ERROR_CODES.includes(res.status)) {
            return {
                model,
                status: "degraded",
                responseMs,
                error: `${res.status} (rate limited — account issue, not outage)`,
            };
        }
        if (!res.ok) {
            return {
                model,
                status: "down",
                responseMs,
                error: `HTTP ${res.status}`,
            };
        }
        // Successful response — check if it was slow
        const status = responseMs > DEGRADED_THRESHOLD_MS ? "degraded" : "up";
        return { model, status, responseMs };
    }
    catch (err) {
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
// Determine worst overall status from model results
function overallStatus(models) {
    if (models.some((m) => m.status === "down"))
        return "down";
    if (models.some((m) => m.status === "degraded"))
        return "degraded";
    return "up";
}
export async function pollAllModels(apiKey, previousDownSince) {
    // Ping all models concurrently
    const results = await Promise.all(MONITORED_MODELS.map((model) => pingModel(model, apiKey)));
    const overall = overallStatus(results);
    // Track when we first went down
    let downSince = previousDownSince;
    if (overall === "down" && !downSince) {
        downSince = new Date();
    }
    else if (overall !== "down") {
        downSince = null;
    }
    return {
        overall,
        models: results,
        checkedAt: new Date(),
        downSince,
    };
}
