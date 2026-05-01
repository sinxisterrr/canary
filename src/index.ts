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
  SlashCommandBuilder,
  ChatInputCommandInteraction,
  GuildMember,
} from "discord.js";
import {
  pollAllModels,
  PollResult,
  resetBackoffState,
  loadPersistedState,
} from "./monitor.js";
import { buildEmbed } from "./embed.js";
import { getCloudModels, refreshFullLibrary } from "./discovery.js";
import {
  POLL_INTERVAL_HEALTHY,
  POLL_INTERVAL_DEGRADED,
  POLL_INTERVAL_DOWN,
  DISCORD_PING_ON_RED,
  DISCOVERY_REFRESH_MS,
  REFRESH_ROLE_IDS,
  FULL_LIBRARY_SCAN_MS,
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
  await refreshModelList();
  await registerSlashCommands();
  scheduleDailyRefresh();
  scheduleWeeklyFullScan();
  await runPoll();
});

// Register /refresh as a guild slash command (instant propagation, unlike global
// commands which can take ~1h). We pull the guild from DISCORD_CHANNEL_ID rather
// than registering globally so it's available immediately on every restart.
async function registerSlashCommands(): Promise<void> {
  try {
    const channel = await client.channels.fetch(DISCORD_CHANNEL_ID);
    if (!channel || !("guild" in channel)) {
      console.warn("⚠️  Could not resolve guild from DISCORD_CHANNEL_ID — slash commands not registered");
      return;
    }
    const guild = (channel as TextChannel).guild;
    const refresh = new SlashCommandBuilder()
      .setName("refresh")
      .setDescription("Re-scrape the cloud catalog, wipe stuck backoff, and re-ping all models");
    await guild.commands.set([refresh.toJSON()]);
    console.log(`📡 Registered /refresh in guild ${guild.name} (${guild.id})`);
  } catch (err) {
    console.error("Slash command registration failed:", err);
  }
}

// Auto-refresh once per day at local midnight: re-scrape the catalog and wipe
// per-model backoff so any "stuck down" ghosts get re-evaluated.
function scheduleDailyRefresh(): void {
  const now = new Date();
  const next = new Date(now);
  next.setHours(0, 0, 0, 0);
  if (next <= now) next.setDate(next.getDate() + 1);
  const ms = next.getTime() - now.getTime();
  console.log(`🌙 Next daily refresh in ${(ms / 3_600_000).toFixed(1)}h (${next.toString()})`);
  setTimeout(async () => {
    console.log("🌙 Daily refresh — re-scraping catalog and clearing backoff");
    try {
      await refreshModelList(true);
      resetBackoffState();
    } catch (err) {
      console.error("Daily refresh failed:", err);
    } finally {
      scheduleDailyRefresh();
    }
  }, ms);
}

// Weekly full-library walk (~223 model pages). Catches every cloud-tagged model
// without having to maintain EXTRA_CLOUD_TAGS by hand. Runs ~weekly via setTimeout
// re-arming. First run happens FULL_LIBRARY_SCAN_MS after boot, not immediately.
function scheduleWeeklyFullScan(): void {
  setTimeout(async () => {
    console.log("📚 Weekly full library scan starting");
    try {
      const tags = await refreshFullLibrary();
      modelList = tags;
      lastFullScanAt = Date.now();
      console.log(`📚 Full scan done: ${tags.length} cloud tags`);
    } catch (err) {
      console.error("Full library scan failed:", err);
    } finally {
      scheduleWeeklyFullScan();
    }
  }, FULL_LIBRARY_SCAN_MS);
}

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

// Shared refresh routine called by both the @mention command and /refresh slash
async function performFullRefresh(): Promise<PollResult> {
  await refreshModelList(true);
  resetBackoffState();
  const result = await pollAllModels(modelList, OLLAMA_API_KEY, null);
  lastResult = result;
  return result;
}

// ── Poll Loop ──────────────────────────────────────────────────
async function runPoll() {
  try {
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
      console.log(`📌 Status message ID: ${statusMessageId} — set STATUS_MESSAGE_ID env to persist across restarts`);
    } else if (wentDown && DISCORD_PING_ON_RED) {
      const pingMsg = await channel.send("@here Ollama Cloud is down! 🔴") as Message;
      pingMessageId = pingMsg.id;
    }

    console.log(`✅ Polled at ${result.checkedAt.toISOString()} — overall: ${result.overall} (${result.pingedCount}/${result.totalCount} pinged, ${result.unreachableCount} unreachable)`);
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

// ── Slash command handler ──────────────────────────────────────
client.on("interactionCreate", async (interaction) => {
  if (!interaction.isChatInputCommand()) return;
  if (interaction.commandName !== "refresh") return;
  await handleRefreshSlash(interaction);
});

async function handleRefreshSlash(interaction: ChatInputCommandInteraction): Promise<void> {
  const member = interaction.member;
  // Permission check: must be a full GuildMember (not partial) and hold one of the allowed roles
  const allowed =
    member instanceof GuildMember &&
    REFRESH_ROLE_IDS.some((id) => member.roles.cache.has(id));

  if (!allowed) {
    await interaction.reply({
      content: "❌ You don't have permission to use /refresh.",
      ephemeral: true,
    });
    return;
  }

  await interaction.deferReply();
  try {
    const result = await performFullRefresh();
    await interaction.editReply({
      content: `📋 Refreshed — ${modelList.length} tags, backoff cleared.`,
      embeds: [buildEmbed(result)],
    });
  } catch (err) {
    await interaction.editReply(
      "❌ Refresh failed: " + (err instanceof Error ? err.message : String(err))
    );
  }
}

// ── Mention commands: @canary test | @canary refresh ───────────
client.on("messageCreate", async (message) => {
  if (message.author.bot) return;
  if (!client.user || !message.mentions.has(client.user)) return;

  const content = message.content.toLowerCase();

  if (content.includes("refresh")) {
    await message.reply("🔄 Refreshing — re-scraping catalog, clearing backoff, re-pinging...");
    try {
      const result = await performFullRefresh();
      await message.reply({
        content: `📋 Refreshed — ${modelList.length} tags, backoff cleared.`,
        embeds: [buildEmbed(result)],
      });
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
      await message.reply({ embeds: [buildEmbed(result)] });
    } catch (err) {
      await message.reply("❌ Check failed: " + (err instanceof Error ? err.message : String(err)));
    }
  }
});

// ── Boot ───────────────────────────────────────────────────────
client.login(DISCORD_TOKEN);
