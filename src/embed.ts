// ---------------------------------------------------------------
// FILE: src/embed.ts
// Builds the Discord embed from poll results
// ---------------------------------------------------------------

import { EmbedBuilder } from "discord.js";
import { PollResult, ModelStatus } from "./monitor.js";

const STATUS_EMOJI: Record<ModelStatus, string> = {
  up: "🟢",
  degraded: "🟡",
  down: "🔴",
};

const STATUS_LABEL: Record<ModelStatus, string> = {
  up: "Operational",
  degraded: "Degraded",
  down: "Outage",
};

const EMBED_COLOR: Record<ModelStatus, number> = {
  up: 0x57f287,      // green
  degraded: 0xfee75c, // yellow
  down: 0xed4245,    // red
};

function formatErrorLabel(error?: string): string {
  if (!error) return "🔴 down";
  if (error.includes("500")) return "500 Internal Server Error";
  if (error.includes("502")) return "502 Bad Gateway";
  if (error.includes("404")) return "404 Not Found";
  if (error.includes("400")) return "400 Bad Request";
  if (error.includes("429")) return "429 Rate Limited";
  if (error.includes("timeout")) return "⏱️ timeout";
  return error;
}

function formatResponseTime(ms: number | null, error?: string): string {
  if (ms === null) return error ?? "timeout";
  if (ms > 10_000) return `${(ms / 1000).toFixed(1)}s ⚠️`;
  return `${ms}ms`;
}

function formatDownSince(downSince: Date | null, checkedAt: Date): string {
  if (!downSince) return "";
  const diffMs = checkedAt.getTime() - downSince.getTime();
  const diffMin = Math.floor(diffMs / 60_000);
  const diffHr = Math.floor(diffMin / 60);
  const remaining = diffMin % 60;

  const duration =
    diffHr > 0
      ? `${diffHr}h ${remaining}m`
      : `${diffMin}m`;

  return `🔴 Down since: <t:${Math.floor(downSince.getTime() / 1000)}:t> (${duration})`;
}

export function buildEmbed(result: PollResult): EmbedBuilder {
  const { overall, models, checkedAt, downSince } = result;

  const modelLines = models
    .map((m) => {
      const emoji = STATUS_EMOJI[m.status];
      const time = m.status === "down"
        ? formatErrorLabel(m.error)
        : formatResponseTime(m.responseMs, m.error);
      // Pad model name for alignment
      return `${emoji} \`${m.model.padEnd(30)}\` ${time}`;
    })
    .join("\n");

  const downSinceText = formatDownSince(downSince, checkedAt);

  const description = [
    modelLines,
    downSinceText ? `\n${downSinceText}` : "",
  ]
    .filter(Boolean)
    .join("\n");

  return new EmbedBuilder()
    .setTitle(`${STATUS_EMOJI[overall]} Ollama Cloud Status — ${STATUS_LABEL[overall]}`)
    .setDescription(description)
    .setColor(EMBED_COLOR[overall])
    .setFooter({ text: `Last checked` })
    .setTimestamp(checkedAt);
}
