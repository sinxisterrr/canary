// ---------------------------------------------------------------
// FILE: src/embed.ts
// Builds the Discord embed from poll results.
// Layout: Fastest 3 / Average 3 / Slowest 3 / Down (conditional).
// ---------------------------------------------------------------
import { EmbedBuilder } from "discord.js";
import { categorize } from "./categorize.js";
const STATUS_EMOJI = {
    up: "🟢",
    degraded: "🟡",
    down: "🔴",
};
const STATUS_LABEL = {
    up: "Operational",
    degraded: "Degraded",
    down: "Outage",
};
const EMBED_COLOR = {
    up: 0x57f287,
    degraded: 0xfee75c,
    down: 0xed4245,
};
// Longest model tag name across all shown models — used to align the time column.
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
function formatResponseTime(ms, error) {
    if (ms === null)
        return error ?? "timeout";
    if (ms > 10_000)
        return `${(ms / 1000).toFixed(1)}s ⚠️`;
    return `${ms}ms`;
}
function renderModelLine(m, pad) {
    const emoji = STATUS_EMOJI[m.status];
    const time = m.status === "down"
        ? formatErrorLabel(m.error)
        : formatResponseTime(m.responseMs, m.error);
    return `${emoji} \`${m.model.padEnd(pad)}\` ${time}`;
}
function renderSection(title, models, pad) {
    if (models.length === 0)
        return "";
    const lines = models.map((m) => renderModelLine(m, pad)).join("\n");
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
    const { fastest, average, slowest, down } = categorize(models);
    // Global pad width so every section's model names align with each other
    const pad = columnWidth([...fastest, ...average, ...slowest, ...down]);
    const sections = [
        renderSection("⚡ Fastest", fastest, pad),
        renderSection("〰️  Average", average, pad),
        renderSection("🐢 Slowest", slowest, pad),
        renderSection(`🔴 Down (${down.length})`, down, pad),
    ].filter(Boolean);
    const downSinceText = formatDownSince(downSince, checkedAt);
    if (downSinceText)
        sections.push(downSinceText);
    const skipped = totalCount - pingedCount;
    const footerText = skipped > 0
        ? `Monitoring ${totalCount} cloud models • ${pingedCount} pinged, ${skipped} in backoff • Last checked`
        : `Monitoring ${totalCount} cloud models • Last checked`;
    return new EmbedBuilder()
        .setTitle(`${STATUS_EMOJI[overall]} Ollama Cloud Status — ${STATUS_LABEL[overall]}`)
        .setDescription(sections.join("\n\n"))
        .setColor(EMBED_COLOR[overall])
        .setFooter({ text: footerText })
        .setTimestamp(checkedAt);
}
