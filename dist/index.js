// ---------------------------------------------------------------
// FILE: src/index.ts
// Canary — Ollama Cloud Status Monitor
// ---------------------------------------------------------------
import { Client, GatewayIntentBits, Partials, } from "discord.js";
import { pollAllModels } from "./monitor.js";
import { buildEmbed } from "./embed.js";
import { POLL_INTERVAL_HEALTHY, POLL_INTERVAL_DEGRADED, POLL_INTERVAL_DOWN, DISCORD_PING_ON_RED, } from "./config.js";
// ── Env ────────────────────────────────────────────────────────
const DISCORD_TOKEN = process.env.DISCORD_TOKEN;
const DISCORD_CHANNEL_ID = process.env.DISCORD_CHANNEL_ID;
const OLLAMA_API_KEY = process.env.OLLAMA_API_KEY;
// Optional: persist message ID across restarts via env
// On Railway: set STATUS_MESSAGE_ID after first run
let statusMessageId = process.env.STATUS_MESSAGE_ID ?? null;
if (!DISCORD_TOKEN || !DISCORD_CHANNEL_ID || !OLLAMA_API_KEY) {
    throw new Error("Missing required env vars: DISCORD_TOKEN, DISCORD_CHANNEL_ID, OLLAMA_API_KEY");
}
// ── State ──────────────────────────────────────────────────────
let lastResult = null;
let pollTimer = null;
let pingMessageId = null; // tracks standalone @here ping messages
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
    await runPoll();
});
// ── Poll Loop ──────────────────────────────────────────────────
async function runPoll() {
    try {
        const channel = await client.channels.fetch(DISCORD_CHANNEL_ID);
        if (!channel)
            throw new Error("Channel not found");
        const previousDownSince = lastResult?.downSince ?? null;
        const previousOverall = lastResult?.overall ?? null;
        const result = await pollAllModels(OLLAMA_API_KEY, previousDownSince);
        lastResult = result;
        const embed = buildEmbed(result);
        // Only trigger @here if we KNOW it was previously up — not on first boot (null)
        const wentDown = previousOverall !== null && previousOverall !== "down" && result.overall === "down";
        const wentClear = previousOverall === "down" && result.overall !== "down";
        // Edit existing message or post new one
        if (statusMessageId) {
            try {
                const existing = await channel.messages.fetch(statusMessageId);
                // Strip @here from content when the outage clears
                await existing.edit({ embeds: [embed], ...(wentClear ? { content: "" } : {}) });
            }
            catch {
                // Message was deleted — post fresh
                statusMessageId = null;
            }
        }
        // Delete standalone @here ping message when outage clears
        if (wentClear && pingMessageId) {
            try {
                const pingMsg = await channel.messages.fetch(pingMessageId);
                await pingMsg.delete();
            }
            catch { /* already deleted, ignore */ }
            pingMessageId = null;
        }
        if (!statusMessageId) {
            const content = wentDown && DISCORD_PING_ON_RED ? "@here" : undefined;
            const posted = await channel.send({
                content,
                embeds: [embed],
            });
            statusMessageId = posted.id;
            console.log(`📌 Status message ID: ${statusMessageId} — set STATUS_MESSAGE_ID in Railway env to persist across restarts`);
        }
        else if (wentDown && DISCORD_PING_ON_RED) {
            // Message already existed, send a separate @here ping and track it for cleanup
            const pingMsg = await channel.send("@here Ollama Cloud is down! 🔴");
            pingMessageId = pingMsg.id;
        }
        console.log(`✅ Polled at ${result.checkedAt.toISOString()} — overall: ${result.overall}`);
    }
    catch (err) {
        console.error("Poll failed:", err);
    }
    // Schedule next poll based on current status
    const interval = lastResult?.overall === "down"
        ? POLL_INTERVAL_DOWN
        : lastResult?.overall === "degraded"
            ? POLL_INTERVAL_DEGRADED
            : POLL_INTERVAL_HEALTHY;
    pollTimer = setTimeout(runPoll, interval);
    console.log(`⏰ Next poll in ${interval / 60_000} min`);
}
// ── On-demand test command: @canary test ───────────────────────
client.on("messageCreate", async (message) => {
    if (message.author.bot)
        return;
    if (!client.user || !message.mentions.has(client.user))
        return;
    if (!message.content.toLowerCase().includes("test"))
        return;
    await message.reply("🔍 Running a fresh check on all models...");
    try {
        const result = await pollAllModels(OLLAMA_API_KEY, lastResult?.downSince ?? null);
        lastResult = result;
        const embed = buildEmbed(result);
        await message.reply({ embeds: [embed] });
    }
    catch (err) {
        await message.reply("❌ Check failed: " + (err instanceof Error ? err.message : String(err)));
    }
});
// ── Boot ───────────────────────────────────────────────────────
client.login(DISCORD_TOKEN);
