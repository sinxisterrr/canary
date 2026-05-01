// ---------------------------------------------------------------
// FILE: src/embed.ts
// Builds the Discord embed from poll results.
// Layout: Fastest / Average / Slowest / Rate Limited / Down.
// Each section has its own indicator color (orange/purple/green/yellow/red).
// ---------------------------------------------------------------

import { EmbedBuilder } from "discord.js";
import { PollResult, ModelResult } from "./monitor.js";
import { categorize } from "./categorize.js";

// Sidebar color: sky blue by default. With 37+ models there's usually something
// down, so red would be permanent — the Down section count already conveys that.
// Yellow only when a real response was slow (>10s), i.e. actual cloud latency.
const COLOR_HEALTHY = 0x87ceeb;
const COLOR_SLOW = 0xfee75c;

function pickSidebarColor(models: ModelResult[]): number {
  const anySlow = models.some((m) => m.status === "degraded" && !m.rateLimited);
  return anySlow ? COLOR_SLOW : COLOR_HEALTHY;
}


function columnWidth(models: ModelResult[]): number {
  return Math.max(0, ...models.map((m) => m.model.length));
}

function formatErrorLabel(error?: string): string {
  if (!error) return "down";
  if (error.includes("500")) return "500 Internal Server Error";
  if (error.includes("502")) return "502 Bad Gateway";
  if (error.includes("503")) return "503 Service Unavailable";
  if (error.includes("403")) return "403 Forbidden";
  if (error.includes("404")) return "404 Not Found";
  if (error.includes("400")) return "400 Bad Request";
  if (error.includes("429")) return "429 Rate Limited";
  if (error.includes("timeout")) return "⏱️ timeout";
  return error;
}

// "426ms (0.4s)" — always show both so users can read either unit at a glance.
function formatResponseTime(ms: number | null, error?: string): string {
  if (ms === null) return error ?? "timeout";
  const seconds = (ms / 1000).toFixed(1);
  const slow = ms > 10_000 ? " ⚠️" : "";
  return `${ms}ms (${seconds}s)${slow}`;
}

// "· 7m ago" — shown next to each down model so you know when it went red
function formatDownDuration(downSince: Date | null | undefined, now: Date): string {
  if (!downSince) return "";
  const diffMs = now.getTime() - downSince.getTime();
  const diffMin = Math.floor(diffMs / 60_000);
  if (diffMin < 1) return " · just now";
  const diffHr = Math.floor(diffMin / 60);
  const remaining = diffMin % 60;
  const duration = diffHr > 0 ? `${diffHr}h ${remaining}m` : `${diffMin}m`;
  return ` · ${duration}`;
}

function renderModelLine(m: ModelResult, pad: number, dot: string, now: Date): string {
  let time: string;
  if (m.unreachable) {
    time = m.error ?? "unreachable";
  } else if (m.status === "down") {
    time = formatErrorLabel(m.error) + formatDownDuration(m.downSince, now);
  } else if (m.rateLimited) {
    time = "429 rate limited";
  } else {
    time = formatResponseTime(m.responseMs, m.error);
  }
  return `${dot} \`${m.model.padEnd(pad)}\` ${time}`;
}

function renderSection(
  title: string,
  models: ModelResult[],
  pad: number,
  dot: string,
  now: Date
): string {
  if (models.length === 0) return "";
  const lines = models.map((m) => renderModelLine(m, pad, dot, now)).join("\n");
  return `**${title}**\n${lines}`;
}

export function buildEmbed(result: PollResult): EmbedBuilder {
  const { models, checkedAt, totalCount, pingedCount } = result;
  const { fastest, average, slowest, rateLimited, unreachable, down } = categorize(models);

  const pad = columnWidth([...fastest, ...average, ...slowest, ...rateLimited, ...unreachable, ...down]);

  const sections = [
    renderSection("⚡ Fastest", fastest, pad, "🟠", checkedAt),
    renderSection("🪻 Average", average, pad, "🟣", checkedAt),
    renderSection("🐢 Slowest", slowest, pad, "🟢", checkedAt),
    renderSection(`🟡 Rate Limited (${rateLimited.length})`, rateLimited, pad, "🟡", checkedAt),
    renderSection(`🌐 Unreachable (${unreachable.length})`, unreachable, pad, "🔵", checkedAt),
    renderSection(`🚩 Down (${down.length})`, down, pad, "🔴", checkedAt),
  ].filter(Boolean);

  const skipped = totalCount - pingedCount;
  const footerText =
    skipped > 0
      ? `Monitoring ${totalCount} cloud models • ${pingedCount} pinged, ${skipped} in backoff • Last checked`
      : `Monitoring ${totalCount} cloud models • Last checked`;

  return new EmbedBuilder()
    .setTitle(`☁️ Ollama Cloud Status`)
    .setDescription(sections.join("\n\n"))
    .setColor(pickSidebarColor(models))
    .setFooter({ text: footerText })
    .setTimestamp(checkedAt);
}
