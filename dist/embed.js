// ---------------------------------------------------------------
// FILE: src/embed.ts
// Builds the Discord embed from poll results.
// Layout: Fastest / Average / Slowest / Rate Limited / Down.
// Each section has its own indicator color (orange/purple/green/yellow/red).
// ---------------------------------------------------------------
import { EmbedBuilder } from "discord.js";
import { categorize } from "./categorize.js";
const EMBED_COLOR = {
    up: 0x57f287,
    degraded: 0xfee75c,
    down: 0xed4245,
};
function columnWidth(models) {
    return Math.max(0, ...models.map((m) => m.model.length));
}
function formatErrorLabel(error) {
    if (!error)
        return "down";
    if (error.includes("500"))
        return "500 Internal Server Error";
    if (error.includes("502"))
        return "502 Bad Gateway";
    if (error.includes("503"))
        return "503 Service Unavailable";
    if (error.includes("403"))
        return "403 Forbidden";
    if (error.includes("404"))
        return "404 Not Found";
    if (error.includes("400"))
        return "400 Bad Request";
    if (error.includes("429"))
        return "429 Rate Limited";
    if (error.includes("timeout"))
        return "⏱️ timeout";
    return error;
}
// "426ms (0.4s)" — always show both so users can read either unit at a glance.
function formatResponseTime(ms, error) {
    if (ms === null)
        return error ?? "timeout";
    const seconds = (ms / 1000).toFixed(1);
    const slow = ms > 10_000 ? " ⚠️" : "";
    return `${ms}ms (${seconds}s)${slow}`;
}
function renderModelLine(m, pad, dot) {
    let time;
    if (m.status === "down") {
        time = formatErrorLabel(m.error);
    }
    else if (m.rateLimited) {
        time = "429 rate limited";
    }
    else {
        time = formatResponseTime(m.responseMs, m.error);
    }
    return `${dot} \`${m.model.padEnd(pad)}\` ${time}`;
}
function renderSection(title, models, pad, dot) {
    if (models.length === 0)
        return "";
    const lines = models.map((m) => renderModelLine(m, pad, dot)).join("\n");
    return `**${title}**\n${lines}`;
}
function formatDownSince(downSince, checkedAt) {
    if (!downSince)
        return "";
    const diffMs = checkedAt.getTime() - downSince.getTime();
    const diffMin = Math.floor(diffMs / 60_000);
    const diffHr = Math.floor(diffMin / 60);
    const remaining = diffMin % 60;
    const duration = diffHr > 0 ? `${diffHr}h ${remaining}m` : `${diffMin}m`;
    return `🔴 Down since: <t:${Math.floor(downSince.getTime() / 1000)}:t> (${duration})`;
}
export function buildEmbed(result) {
    const { overall, models, checkedAt, downSince, totalCount, pingedCount } = result;
    const { fastest, average, slowest, rateLimited, down } = categorize(models);
    const pad = columnWidth([...fastest, ...average, ...slowest, ...rateLimited, ...down]);
    const sections = [
        renderSection("⚡ Fastest", fastest, pad, "🟠"),
        renderSection("🪻 Average", average, pad, "🟣"),
        renderSection("🐢 Slowest", slowest, pad, "🟢"),
        renderSection(`🟡 Rate Limited (${rateLimited.length})`, rateLimited, pad, "🟡"),
        renderSection(`🚩 Down (${down.length})`, down, pad, "🔴"),
    ].filter(Boolean);
    const downSinceText = formatDownSince(downSince, checkedAt);
    if (downSinceText)
        sections.push(downSinceText);
    const skipped = totalCount - pingedCount;
    const footerText = skipped > 0
        ? `Monitoring ${totalCount} cloud models • ${pingedCount} pinged, ${skipped} in backoff • Last checked`
        : `Monitoring ${totalCount} cloud models • Last checked`;
    return new EmbedBuilder()
        .setTitle(`☁️ Ollama Cloud Status`)
        .setDescription(sections.join("\n\n"))
        .setColor(EMBED_COLOR[overall])
        .setFooter({ text: footerText })
        .setTimestamp(checkedAt);
}
