// ---------------------------------------------------------------
// FILE: src/discovery.ts
// Scrapes ollama.com for the current cloud model catalog.
// Caches the result to disk so we don't re-scrape on every boot.
// ---------------------------------------------------------------

import fetch from "node-fetch";
import { promises as fs } from "node:fs";
import path from "node:path";
import {
  OLLAMA_BASE_URL,
  OLLAMA_CLOUD_SEARCH_URL,
  MODEL_CACHE_PATH,
  DISCOVERY_REFRESH_MS,
  EXTRA_CLOUD_TAGS,
  WEEKLY_DELTA_PATH,
} from "./config.js";

export interface WeeklyDelta {
  scanDate: string; // ISO timestamp
  newTags: string[];
}

interface ModelCache {
  scrapedAt: string; // ISO timestamp
  tags: string[];    // e.g. ["kimi-k2:1t-cloud", "deepseek-v3.2:cloud", ...]
}

// Extract /library/<name> hrefs from the cloud search page
function extractModelNames(html: string): string[] {
  const names = new Set<string>();
  const re = /href="\/library\/([a-z0-9][a-z0-9._-]*)"/gi;
  let match: RegExpExecArray | null;
  while ((match = re.exec(html)) !== null) {
    names.add(match[1]);
  }
  return [...names];
}

// From a model's /library/<name>/tags page, pull out every `<name>:<variant>` that contains "cloud"
function extractCloudTags(name: string, html: string): string[] {
  const tags = new Set<string>();
  // Capture any variant (alphanumeric start, letters/digits/dots/dashes), then filter for ones containing "cloud".
  // This covers bare :cloud as well as :1t-cloud, :235b-cloud, etc.
  const escaped = name.replace(/[.*+?^${}()|[\]\\]/g, "\\$&");
  const re = new RegExp(`${escaped}:([a-z0-9][a-z0-9.-]*)`, "gi");
  let match: RegExpExecArray | null;
  while ((match = re.exec(html)) !== null) {
    const variant = match[1];
    if (variant.includes("cloud")) tags.add(`${name}:${variant}`);
  }
  return [...tags];
}

async function fetchText(url: string): Promise<string> {
  const res = await fetch(url, {
    headers: { "User-Agent": "canary-status-bot/1.0" },
  });
  if (!res.ok) throw new Error(`GET ${url} → HTTP ${res.status}`);
  return res.text();
}

async function discover(): Promise<string[]> {
  const searchHtml = await fetchText(OLLAMA_CLOUD_SEARCH_URL);
  const names = extractModelNames(searchHtml);
  console.log(`🔎 Discovered ${names.length} cloud model names from catalog`);

  const tagLists = await Promise.all(
    names.map(async (name) => {
      try {
        const html = await fetchText(`${OLLAMA_BASE_URL}/library/${name}/tags`);
        return extractCloudTags(name, html);
      } catch (err) {
        console.warn(`⚠️  Failed to fetch tags for ${name}: ${err instanceof Error ? err.message : err}`);
        return [];
      }
    })
  );

  // Union with the supplemental list of older cloud tags that Ollama doesn't feature
  const allTags = [...new Set([...tagLists.flat(), ...EXTRA_CLOUD_TAGS])].sort();
  const extraCount = EXTRA_CLOUD_TAGS.filter((t) => !tagLists.flat().includes(t)).length;
  console.log(
    `🔎 Resolved ${allTags.length} cloud tags total` +
      (extraCount > 0 ? ` (${extraCount} from supplement list)` : "")
  );
  return allTags;
}

// Walk Ollama's full model library (not just /search?c=cloud) and pull every
// cloud-tagged variant. Slower (~223 model pages) so it runs weekly, not hourly,
// but catches every cloud tag without us having to maintain EXTRA_CLOUD_TAGS by
// hand. Result is unioned with the regular discovery + supplement list.
export async function discoverFullLibrary(): Promise<string[]> {
  const libHtml = await fetchText(`${OLLAMA_BASE_URL}/library`);
  const names = extractModelNames(libHtml);
  console.log(`📚 Full library scan: ${names.length} model names`);

  // Throttle to keep ollama.com happy — process in chunks of 8 in parallel.
  const tagLists: string[][] = [];
  const CHUNK = 8;
  for (let i = 0; i < names.length; i += CHUNK) {
    const chunk = names.slice(i, i + CHUNK);
    const results = await Promise.all(
      chunk.map(async (name) => {
        try {
          const html = await fetchText(`${OLLAMA_BASE_URL}/library/${name}/tags`);
          return extractCloudTags(name, html);
        } catch {
          return [];
        }
      })
    );
    tagLists.push(...results);
  }

  const tags = [...new Set(tagLists.flat())].sort();
  console.log(`📚 Full library scan found ${tags.length} cloud-tagged variants`);
  return tags;
}

// Same as getCloudModels but uses the full library scan as its source. Result
// is cached normally — overwrites the same models.json the regular discovery uses.
// Also computes the delta vs the previous cached list and persists "what's new
// this week" so the embed can surface newly-discovered cloud models.
export async function refreshFullLibrary(): Promise<{ tags: string[]; newTags: string[] }> {
  const previousCache = await readCache();
  const previousTags = new Set(previousCache?.tags ?? []);

  const fullTags = await discoverFullLibrary();
  const allTags = [...new Set([...fullTags, ...EXTRA_CLOUD_TAGS])].sort();
  await writeCache(allTags);

  const newTags = allTags.filter((t) => !previousTags.has(t));
  await writeWeeklyDelta({ scanDate: new Date().toISOString(), newTags });

  console.log(`📚 Full-library refresh wrote ${allTags.length} tags to cache (${newTags.length} new this week)`);
  return { tags: allTags, newTags };
}

export async function readWeeklyDelta(): Promise<WeeklyDelta | null> {
  try {
    const raw = await fs.readFile(WEEKLY_DELTA_PATH, "utf8");
    return JSON.parse(raw) as WeeklyDelta;
  } catch {
    return null;
  }
}

async function writeWeeklyDelta(delta: WeeklyDelta): Promise<void> {
  try {
    await fs.mkdir(path.dirname(WEEKLY_DELTA_PATH), { recursive: true });
    await fs.writeFile(WEEKLY_DELTA_PATH, JSON.stringify(delta, null, 2), "utf8");
  } catch (err) {
    console.warn("⚠️  Failed to persist weekly delta:", err instanceof Error ? err.message : err);
  }
}

async function readCache(): Promise<ModelCache | null> {
  try {
    const raw = await fs.readFile(MODEL_CACHE_PATH, "utf8");
    return JSON.parse(raw) as ModelCache;
  } catch {
    return null;
  }
}

async function writeCache(tags: string[]): Promise<void> {
  const cache: ModelCache = { scrapedAt: new Date().toISOString(), tags };
  await fs.mkdir(path.dirname(MODEL_CACHE_PATH), { recursive: true });
  await fs.writeFile(MODEL_CACHE_PATH, JSON.stringify(cache, null, 2), "utf8");
}

/**
 * Returns the current cloud model tag list.
 * Uses the on-disk cache if it's fresh; otherwise re-scrapes and updates it.
 * Falls back to the cached list (even if stale) if the scrape fails.
 */
export async function getCloudModels(force = false): Promise<string[]> {
  const cache = await readCache();
  const fresh =
    cache &&
    Date.now() - new Date(cache.scrapedAt).getTime() < DISCOVERY_REFRESH_MS;

  if (cache && fresh && !force) {
    console.log(`📂 Using cached model list (${cache.tags.length} tags, scraped ${cache.scrapedAt})`);
    return cache.tags;
  }

  try {
    const tags = await discover();
    if (tags.length === 0) throw new Error("scrape returned 0 tags");
    await writeCache(tags);
    return tags;
  } catch (err) {
    console.error(`❌ Discovery failed: ${err instanceof Error ? err.message : err}`);
    if (cache) {
      console.warn(`↩️  Falling back to stale cache (${cache.tags.length} tags)`);
      return cache.tags;
    }
    throw new Error("discovery failed and no cache available");
  }
}
