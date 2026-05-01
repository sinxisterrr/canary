// ---------------------------------------------------------------
// FILE: src/index.ts
// Canary — Ollama Cloud Status Monitor
// ---------------------------------------------------------------
import { Client, GatewayIntentBits, Partials, SlashCommandBuilder, GuildMember, } from "discord.js";
import { promises as fs } from "node:fs";
import path from "node:path";
import { pollAllModels, resetBackoffState, loadPersistedState, } from "./monitor.js";
import { buildEmbed } from "./embed.js";
import { getCloudModels, refreshFullLibrary, readWeeklyDelta } from "./discovery.js";
import { POLL_INTERVAL_HEALTHY, POLL_INTERVAL_DEGRADED, POLL_INTERVAL_DOWN, DISCORD_PING_ON_RED, DISCOVERY_REFRESH_MS, REFRESH_ROLE_IDS, WEEKLY_SCAN_DAY_OF_WEEK, REFRESH_TIMEZONE, } from "./config.js";
// ── Env ────────────────────────────────────────────────────────
const DISCORD_TOKEN = process.env.DISCORD_TOKEN;
const DISCORD_CHANNEL_ID = process.env.DISCORD_CHANNEL_ID;
const OLLAMA_API_KEY = process.env.OLLAMA_API_KEY;
// Where we persist the current status message ID. Survives restarts so we
// don't post a new embed every redeploy and end up with Feb / Apr / today
// duplicates floating in the channel.
const STATUS_MSG_PATH = "cache/status_message.txt";
let statusMessageId = process.env.STATUS_MESSAGE_ID ?? null;
if (!DISCORD_TOKEN || !DISCORD_CHANNEL_ID || !OLLAMA_API_KEY) {
    throw new Error("Missing required env vars: DISCORD_TOKEN, DISCORD_CHANNEL_ID, OLLAMA_API_KEY");
}
// ── State ──────────────────────────────────────────────────────
let lastResult = null;
let pollTimer = null;
let pingMessageId = null;
let modelList = [];
let lastDiscoveryAt = 0;
let lastFullScanAt = 0;
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
    await loadPersistedState();
    await loadStatusMessageId();
    await refreshModelList();
    await registerSlashCommands();
    await reconcileStatusMessages();
    scheduleDailyRefresh();
    scheduleWeeklyFullScan();
    await runPoll();
});
// Persisted statusMessageId survives restarts. File takes precedence over
// the env var — env is just bootstrap for the very first boot.
async function loadStatusMessageId() {
    try {
        const raw = (await fs.readFile(STATUS_MSG_PATH, "utf8")).trim();
        if (raw) {
            statusMessageId = raw;
            console.log(`💾 Loaded status message ID from disk: ${raw}`);
        }
    }
    catch { /* no file yet — fine */ }
}
async function saveStatusMessageId() {
    if (!statusMessageId)
        return;
    try {
        await fs.mkdir(path.dirname(STATUS_MSG_PATH), { recursive: true });
        await fs.writeFile(STATUS_MSG_PATH, statusMessageId, "utf8");
    }
    catch (err) {
        console.warn("⚠️  Failed to persist status message ID:", err);
    }
}
// One-time cleanup: scan recent channel history for OUR own "Ollama Cloud Status"
// embeds, keep the newest as the canonical statusMessageId, delete the rest.
// Solves the "Feb 23 / Apr 29 / today all sitting in channel" problem caused
// by past redeploys losing the env-var-tracked ID.
async function reconcileStatusMessages() {
    try {
        const channel = await client.channels.fetch(DISCORD_CHANNEL_ID);
        if (!channel || !client.user)
            return;
        const messages = await channel.messages.fetch({ limit: 100 });
        const ours = messages.filter((m) => m.author.id === client.user.id && m.embeds.some((e) => e.title === "☁️ Ollama Cloud Status"));
        if (ours.size <= 1)
            return;
        // Newest first by createdTimestamp
        const sorted = [...ours.values()].sort((a, b) => b.createdTimestamp - a.createdTimestamp);
        const keep = sorted[0];
        const toDelete = sorted.slice(1);
        statusMessageId = keep.id;
        await saveStatusMessageId();
        for (const m of toDelete) {
            try {
                await m.delete();
            }
            catch { /* ignore */ }
        }
        console.log(`🧹 Reconciled status messages: kept ${keep.id}, deleted ${toDelete.length} stale duplicates`);
    }
    catch (err) {
        console.warn("Status reconciliation failed:", err);
    }
}
// Register /refresh as a guild slash command (instant, vs ~1h for global).
async function registerSlashCommands() {
    try {
        const channel = await client.channels.fetch(DISCORD_CHANNEL_ID);
        if (!channel || !("guild" in channel)) {
            console.warn("⚠️  Could not resolve guild from DISCORD_CHANNEL_ID — slash commands not registered");
            return;
        }
        const guild = channel.guild;
        const refresh = new SlashCommandBuilder()
            .setName("refresh")
            .setDescription("Re-scrape the cloud catalog, wipe stuck backoff, and re-ping all models");
        await guild.commands.set([refresh.toJSON()]);
        console.log(`📡 Registered /refresh in guild ${guild.name} (${guild.id})`);
    }
    catch (err) {
        console.error("Slash command registration failed:", err);
    }
}
// ── Daily auto-refresh at midnight Mountain Time ──────────────
// Hardcoded to America/Denver (handles DST automatically) so the schedule is
// independent of whatever timezone the host machine uses.
function msUntilNextMidnight(tz) {
    const now = new Date();
    const fmt = new Intl.DateTimeFormat("en-US", {
        timeZone: tz,
        hour: "2-digit", minute: "2-digit", second: "2-digit",
        hour12: false,
    });
    const parts = fmt.formatToParts(now);
    const part = (t) => parseInt(parts.find((p) => p.type === t).value, 10);
    const h = part("hour") % 24;
    const m = part("minute");
    const s = part("second");
    const elapsedToday = h * 3600 + m * 60 + s;
    const remaining = 86400 - elapsedToday;
    return remaining * 1000;
}
function scheduleDailyRefresh() {
    const ms = msUntilNextMidnight(REFRESH_TIMEZONE);
    console.log(`🌙 Next daily refresh in ${(ms / 3_600_000).toFixed(1)}h (midnight ${REFRESH_TIMEZONE})`);
    setTimeout(async () => {
        console.log("🌙 Daily refresh — re-scraping catalog and clearing backoff");
        try {
            await refreshModelList(true);
            resetBackoffState();
        }
        catch (err) {
            console.error("Daily refresh failed:", err);
        }
        finally {
            scheduleDailyRefresh();
        }
    }, ms);
}
// Pinned to Sunday midnight Mountain Time (configurable via WEEKLY_SCAN_DAY_OF_WEEK)
// to coincide with Ollama's weekly usage reset. Catches new cloud-tagged models
// without us having to hand-maintain EXTRA_CLOUD_TAGS.
function msUntilNextWeeklyScan(tz, targetDow) {
    const now = new Date();
    const fmt = new Intl.DateTimeFormat("en-US", {
        timeZone: tz,
        weekday: "short",
        hour: "2-digit", minute: "2-digit", second: "2-digit",
        hour12: false,
    });
    const parts = fmt.formatToParts(now);
    const part = (t) => parts.find((p) => p.type === t).value;
    const dayMap = { Sun: 0, Mon: 1, Tue: 2, Wed: 3, Thu: 4, Fri: 5, Sat: 6 };
    const dow = dayMap[part("weekday")];
    const h = parseInt(part("hour"), 10) % 24;
    const m = parseInt(part("minute"), 10);
    const s = parseInt(part("second"), 10);
    let daysUntilTarget = (7 + targetDow - dow) % 7;
    const elapsedToday = h * 3600 + m * 60 + s;
    // If today IS the target day but midnight already passed, wait a full week
    if (daysUntilTarget === 0 && elapsedToday > 0)
        daysUntilTarget = 7;
    return (daysUntilTarget * 86400 - elapsedToday) * 1000;
}
function scheduleWeeklyFullScan() {
    const ms = msUntilNextWeeklyScan(REFRESH_TIMEZONE, WEEKLY_SCAN_DAY_OF_WEEK);
    console.log(`📚 Next full-library scan in ${(ms / 3_600_000).toFixed(1)}h (Sunday midnight ${REFRESH_TIMEZONE})`);
    setTimeout(async () => {
        console.log("📚 Sunday-midnight full library scan starting");
        try {
            const { tags, newTags } = await refreshFullLibrary();
            modelList = tags;
            lastFullScanAt = Date.now();
            console.log(`📚 Full scan done: ${tags.length} cloud tags (${newTags.length} new)`);
        }
        catch (err) {
            console.error("Full library scan failed:", err);
        }
        finally {
            scheduleWeeklyFullScan();
        }
    }, ms);
}
// Load the most recent Sunday-scan delta so the embed can surface "Added this
// week" all week long. Returns [] if no scan has run yet or the file is missing.
async function loadNewThisWeek() {
    const delta = await readWeeklyDelta();
    return delta?.newTags ?? [];
}
async function refreshModelList(force = false) {
    try {
        modelList = await getCloudModels(force);
        lastDiscoveryAt = Date.now();
        console.log(`📋 Model list: ${modelList.length} tags`);
    }
    catch (err) {
        console.error("Discovery failed:", err);
        if (modelList.length === 0)
            throw err;
    }
}
// Edit the pinned status message in place. Posts a new one only if the old
// one is missing (deleted, or first run). Used by both runPoll and refresh.
async function postOrEditStatus(channel, embed, opts = {}) {
    if (statusMessageId) {
        try {
            const existing = await channel.messages.fetch(statusMessageId);
            await existing.edit({ embeds: [embed], ...(opts.clearContent ? { content: "" } : {}) });
            return;
        }
        catch {
            statusMessageId = null;
        }
    }
    const posted = await channel.send({ content: opts.content, embeds: [embed] });
    statusMessageId = posted.id;
    await saveStatusMessageId();
    console.log(`📌 Status message ID: ${statusMessageId} (persisted to ${STATUS_MSG_PATH})`);
}
// Shared refresh routine — reused by /refresh, @canary refresh, and daily auto.
// Fetches a fresh poll AND edits the pinned status message in place so callers
// don't post extra embeds.
async function performFullRefresh(channel) {
    await refreshModelList(true);
    resetBackoffState();
    const result = await pollAllModels(modelList, OLLAMA_API_KEY, null);
    lastResult = result;
    const newThisWeek = await loadNewThisWeek();
    await postOrEditStatus(channel, buildEmbed(result, { newThisWeek }));
    return result;
}
// ── Poll Loop ──────────────────────────────────────────────────
async function runPoll() {
    try {
        if (Date.now() - lastDiscoveryAt > DISCOVERY_REFRESH_MS) {
            await refreshModelList();
        }
        const channel = await client.channels.fetch(DISCORD_CHANNEL_ID);
        if (!channel)
            throw new Error("Channel not found");
        const previousDownSince = lastResult?.downSince ?? null;
        const previousOverall = lastResult?.overall ?? null;
        const result = await pollAllModels(modelList, OLLAMA_API_KEY, previousDownSince);
        lastResult = result;
        const wentDown = previousOverall !== null && previousOverall !== "down" && result.overall === "down";
        const wentClear = previousOverall === "down" && result.overall !== "down";
        const newThisWeek = await loadNewThisWeek();
        await postOrEditStatus(channel, buildEmbed(result, { newThisWeek }), { clearContent: wentClear });
        if (wentClear && pingMessageId) {
            try {
                const pingMsg = await channel.messages.fetch(pingMessageId);
                await pingMsg.delete();
            }
            catch { /* already deleted, ignore */ }
            pingMessageId = null;
        }
        if (wentDown && DISCORD_PING_ON_RED) {
            const pingMsg = await channel.send("@here Ollama Cloud is down! 🔴");
            pingMessageId = pingMsg.id;
        }
        console.log(`✅ Polled at ${result.checkedAt.toISOString()} — overall: ${result.overall} (${result.pingedCount}/${result.totalCount} pinged, ${result.unreachableCount} unreachable)`);
    }
    catch (err) {
        console.error("Poll failed:", err);
    }
    const interval = lastResult?.overall === "down"
        ? POLL_INTERVAL_DOWN
        : lastResult?.overall === "degraded"
            ? POLL_INTERVAL_DEGRADED
            : POLL_INTERVAL_HEALTHY;
    pollTimer = setTimeout(runPoll, interval);
    console.log(`⏰ Next poll in ${interval / 60_000} min`);
}
// ── Slash command handler ──────────────────────────────────────
client.on("interactionCreate", async (interaction) => {
    if (!interaction.isChatInputCommand())
        return;
    if (interaction.commandName !== "refresh")
        return;
    await handleRefreshSlash(interaction);
});
async function handleRefreshSlash(interaction) {
    const member = interaction.member;
    const allowed = member instanceof GuildMember &&
        REFRESH_ROLE_IDS.some((id) => member.roles.cache.has(id));
    if (!allowed) {
        await interaction.reply({
            content: "❌ You don't have permission to use /refresh.",
            ephemeral: true,
        });
        return;
    }
    // Ephemeral defer — only the user who ran the command sees the confirmation,
    // which keeps the channel clean. The pinned status message updates for everyone.
    await interaction.deferReply({ ephemeral: true });
    try {
        const channel = await client.channels.fetch(DISCORD_CHANNEL_ID);
        await performFullRefresh(channel);
        await interaction.editReply(`✅ Refreshed — ${modelList.length} tags, backoff cleared. Updated the status message above.`);
    }
    catch (err) {
        await interaction.editReply("❌ Refresh failed: " + (err instanceof Error ? err.message : String(err)));
    }
}
// ── Mention commands: @canary test | @canary refresh ───────────
client.on("messageCreate", async (message) => {
    if (message.author.bot)
        return;
    if (!client.user || !message.mentions.has(client.user))
        return;
    const content = message.content.toLowerCase();
    if (content.includes("refresh")) {
        try {
            const channel = await client.channels.fetch(DISCORD_CHANNEL_ID);
            await performFullRefresh(channel);
            await message.reply(`✅ Refreshed — ${modelList.length} tags, backoff cleared. Updated the status message.`);
        }
        catch (err) {
            await message.reply("❌ Refresh failed: " + (err instanceof Error ? err.message : String(err)));
        }
        return;
    }
    if (content.includes("test")) {
        await message.reply("🔍 Running a fresh check on all models...");
        try {
            const result = await pollAllModels(modelList, OLLAMA_API_KEY, lastResult?.downSince ?? null);
            lastResult = result;
            const newThisWeek = await loadNewThisWeek();
            await message.reply({ embeds: [buildEmbed(result, { newThisWeek })] });
        }
        catch (err) {
            await message.reply("❌ Check failed: " + (err instanceof Error ? err.message : String(err)));
        }
    }
});
// ── Boot ───────────────────────────────────────────────────────
client.login(DISCORD_TOKEN);
