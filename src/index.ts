// ---------------------------------------------------------------
// FILE: src/index.ts
// Canary — Ollama Cloud Status Monitor
// ---------------------------------------------------------------

import {
  Client,
  GatewayIntentBits,
  Partials,
  TextChannel,
  Message,
} from "discord.js";
import { pollAllModels, PollResult } from "./monitor.js";
import { buildEmbed } from "./embed.js";
import { getCloudModels } from "./discovery.js";
import {
  POLL_INTERVAL_HEALTHY,
  POLL_INTERVAL_DEGRADED,
  POLL_INTERVAL_DOWN,
  DISCORD_PING_ON_RED,
  DISCOVERY_REFRESH_MS,
} from "./config.js";

// ── Env ────────────────────────────────────────────────────────
const DISCORD_TOKEN = process.env.DISCORD_TOKEN!;
const DISCORD_CHANNEL_ID = process.env.DISCORD_CHANNEL_ID!;
const OLLAMA_API_KEY = process.env.OLLAMA_API_KEY!;

let statusMessageId: string | null = process.env.STATUS_MESSAGE_ID ?? null;

if (!DISCORD_TOKEN || !DISCORD_CHANNEL_ID || !OLLAMA_API_KEY) {
  throw new Error(
    "Missing required env vars: DISCORD_TOKEN, DISCORD_CHANNEL_ID, OLLAMA_API_KEY"
  );
}

// ── State ──────────────────────────────────────────────────────
let lastResult: PollResult | null = null;
let pollTimer: ReturnType<typeof setTimeout> | null = null;
let pingMessageId: string | null = null;
let modelList: string[] = [];
let lastDiscoveryAt = 0;

// ── Discord Client ─────────────────────────────────────────────
const client = new Client({
  intents: [
    GatewayIntentBits.Guilds,
    GatewayIntentBits.GuildMessages,
    GatewayIntentBits.MessageContent,
  ],
  partials: [Partials.Message],
});

client.once("ready", async () => {
  console.log(`🐤 Canary is online as ${client.user?.tag}`);
  await refreshModelList();
  await runPoll();
});

async function refreshModelList(force = false): Promise<void> {
  try {
    modelList = await getCloudModels(force);
    lastDiscoveryAt = Date.now();
    console.log(`📋 Model list: ${modelList.length} tags`);
  } catch (err) {
    console.error("Discovery failed:", err);
    if (modelList.length === 0) throw err; // no fallback on first boot
  }
}

// ── Poll Loop ──────────────────────────────────────────────────
async function runPoll() {
  try {
    // Refresh the catalog if the cache has aged out
    if (Date.now() - lastDiscoveryAt > DISCOVERY_REFRESH_MS) {
      await refreshModelList();
    }

    const channel = await client.channels.fetch(DISCORD_CHANNEL_ID) as TextChannel;
    if (!channel) throw new Error("Channel not found");

    const previousDownSince = lastResult?.downSince ?? null;
    const previousOverall = lastResult?.overall ?? null;

    const result = await pollAllModels(modelList, OLLAMA_API_KEY, previousDownSince);
    lastResult = result;

    const embed = buildEmbed(result);
    const wentDown = previousOverall !== null && previousOverall !== "down" && result.overall === "down";
    const wentClear = previousOverall === "down" && result.overall !== "down";

    if (statusMessageId) {
      try {
        const existing = await channel.messages.fetch(statusMessageId);
        await existing.edit({ embeds: [embed], ...(wentClear ? { content: "" } : {}) });
      } catch {
        statusMessageId = null;
      }
    }

    if (wentClear && pingMessageId) {
      try {
        const pingMsg = await channel.messages.fetch(pingMessageId);
        await pingMsg.delete();
      } catch { /* already deleted, ignore */ }
      pingMessageId = null;
    }

    if (!statusMessageId) {
      const content = wentDown && DISCORD_PING_ON_RED ? "@here" : undefined;
      const posted = await channel.send({ content, embeds: [embed] }) as Message;
      statusMessageId = posted.id;
      console.log(`📌 Status message ID: ${statusMessageId} — set STATUS_MESSAGE_ID in Railway env to persist across restarts`);
    } else if (wentDown && DISCORD_PING_ON_RED) {
      const pingMsg = await channel.send("@here Ollama Cloud is down! 🔴") as Message;
      pingMessageId = pingMsg.id;
    }

    console.log(`✅ Polled at ${result.checkedAt.toISOString()} — overall: ${result.overall} (${result.pingedCount}/${result.totalCount} pinged)`);
  } catch (err) {
    console.error("Poll failed:", err);
  }

  const interval =
    lastResult?.overall === "down"
      ? POLL_INTERVAL_DOWN
      : lastResult?.overall === "degraded"
      ? POLL_INTERVAL_DEGRADED
      : POLL_INTERVAL_HEALTHY;

  pollTimer = setTimeout(runPoll, interval);
  console.log(`⏰ Next poll in ${interval / 60_000} min`);
}

// ── On-demand commands: @canary test | @canary refresh ─────────
client.on("messageCreate", async (message) => {
  if (message.author.bot) return;
  if (!client.user || !message.mentions.has(client.user)) return;

  const content = message.content.toLowerCase();

  if (content.includes("refresh")) {
    await message.reply("🔎 Re-scraping the Ollama cloud catalog...");
    try {
      await refreshModelList(true);
      await message.reply(`📋 Model list refreshed — ${modelList.length} tags`);
    } catch (err) {
      await message.reply("❌ Refresh failed: " + (err instanceof Error ? err.message : String(err)));
    }
    return;
  }

  if (content.includes("test")) {
    await message.reply("🔍 Running a fresh check on all models...");
    try {
      const result = await pollAllModels(modelList, OLLAMA_API_KEY, lastResult?.downSince ?? null);
      lastResult = result;
      const embed = buildEmbed(result);
      await message.reply({ embeds: [embed] });
    } catch (err) {
      await message.reply("❌ Check failed: " + (err instanceof Error ? err.message : String(err)));
    }
  }
});

// ── Boot ───────────────────────────────────────────────────────
client.login(DISCORD_TOKEN);
