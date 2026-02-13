require("dotenv").config();
const fs = require("fs");
const path = require("path");

const {
  Client: DiscordClient,
  GatewayIntentBits,
  REST,
  Routes,
  SlashCommandBuilder,
  EmbedBuilder,
  PermissionFlagsBits,
} = require("discord.js");

console.log("RUNNING FILE:", __filename, "VERSION: 2026-02-13-a");

// ======================================================
// CONFIG STORAGE (per guild)
// ======================================================
const DATA_DIR = process.env.DATA_DIR || path.join(process.cwd(), "data");

// Railway volume mount
if (!fs.existsSync(DATA_DIR)) fs.mkdirSync(DATA_DIR, { recursive: true });

const GUILD_CFG_FILE = path.join(DATA_DIR, "guild-config.json");
const META_FILE = path.join(DATA_DIR, "meta.json");

function loadJson(file, fallback) {
  try {
    return JSON.parse(fs.readFileSync(file, "utf8"));
  } catch {
    return fallback;
  }
}
function saveJson(file, data) {
  fs.writeFileSync(file, JSON.stringify(data, null, 2), "utf8");
}

function loadGuildConfigAll() {
  return loadJson(GUILD_CFG_FILE, {});
}
function saveGuildConfigAll(cfg) {
  saveJson(GUILD_CFG_FILE, cfg);
}
function getGuildCfg(guildId) {
  const all = loadGuildConfigAll();
  return all[guildId] || null;
}
function setGuildCfg(guildId, patch) {
  const all = loadGuildConfigAll();
  const existing = all[guildId] || {};
  all[guildId] = {
    ...existing,
    ...patch,
    threads: {
      ...(existing.threads || {}),
      ...(patch.threads || {}),
    },
    notion: {
      ...(existing.notion || {}),
      ...(patch.notion || {}),
    },
  };
  saveGuildConfigAll(all);
  return all[guildId];
}
function requireGuildCfg(guildId) {
  const cfg = getGuildCfg(guildId);
  if (!cfg?.staffChannelId || !cfg?.threads?.thisMonth) {
    throw new Error("This server is not configured. Run /caltrix setup first.");
  }
  if (!cfg?.notion?.databaseId) {
    throw new Error("Notion DB not configured. Run /caltrix notion set <database_link> first.");
  }
  return cfg;
}

// ======================================================
// NOTION REST (single global integration token)
// ======================================================
const NOTION_VERSION = "2022-06-28";

async function notionRequest(url, options = {}) {
  const res = await fetch(url, {
    ...options,
    headers: {
      Authorization: `Bearer ${process.env.NOTION_TOKEN}`,
      "Notion-Version": NOTION_VERSION,
      "Content-Type": "application/json",
      ...(options.headers || {}),
    },
  });

  const data = await res.json().catch(() => ({}));
  if (!res.ok) {
    throw new Error(`Notion API ${res.status}: ${data?.message || JSON.stringify(data)}`);
  }
  return data;
}

async function notionDbQuery(databaseId, body) {
  return notionRequest(`https://api.notion.com/v1/databases/${databaseId}/query`, {
    method: "POST",
    body: JSON.stringify(body),
  });
}

async function notionGetPage(pageId) {
  return notionRequest(`https://api.notion.com/v1/pages/${pageId}`, { method: "GET" });
}

// Extract Notion DB ID from a Notion database URL
function extractNotionDbIdFromUrl(url) {
  // Typical: https://www.notion.so/workspace/2e9fa1e7c6198005a614f28220675577?v=...
  // We want the 32-char hex-ish id (can contain letters+numbers).
  const m = String(url).match(/([0-9a-fA-F]{32})/);
  return m ? m[1] : null;
}

// ======================================================
// DATE HELPERS
// ======================================================
function monthKeyFromDate(d) {
  const y = d.getFullYear();
  const m = String(d.getMonth() + 1).padStart(2, "0");
  return `${y}-${m}`;
}
function monthStartEnd(monthKey) {
  const [Y, M] = monthKey.split("-").map(Number);
  const start = new Date(Y, M - 1, 1, 0, 0, 0, 0);
  const end = new Date(Y, M, 1, 0, 0, 0, 0);
  return { start, end };
}
function fmtMonthTitle(monthKey) {
  const [Y, M] = monthKey.split("-").map(Number);
  const name = new Date(Y, M - 1, 1).toLocaleString("en-US", { month: "long" });
  return `${name} ${Y}`;
}

// ======================================================
// NOTION PROPS — must match DB column names
// ======================================================
const NOTION_PROPS = {
  title: "Title",
  date: "Date",
  time: "Time",          // rich_text optional
  type: "Type",          // select
  artist: "Artist",      // relation
  member: "Member",      // relation
  location: "Location",  // select
  status: "Status",      // select: Upcoming/Done etc
  link: "Link",          // url
};

// ======================================================
// NOTION PARSING
// ======================================================
function rtPlain(arr) {
  if (!Array.isArray(arr)) return "";
  return arr.map((x) => x.plain_text).join("");
}
function titlePlain(prop) {
  if (!prop || prop.type !== "title") return "";
  return rtPlain(prop.title);
}
function richTextPlain(prop) {
  if (!prop || prop.type !== "rich_text") return "";
  return rtPlain(prop.rich_text);
}
function selectPlain(prop) {
  if (!prop || prop.type !== "select") return "";
  return prop.select?.name || "";
}
function urlPlain(prop) {
  if (!prop || prop.type !== "url") return "";
  return prop.url || "";
}
function dateStart(prop) {
  if (!prop || prop.type !== "date") return null;
  return prop.date?.start || null;
}
function relationIds(prop) {
  if (!prop || prop.type !== "relation") return [];
  return (prop.relation || []).map((r) => r.id);
}

// ======================================================
// RELATION RESOLUTION (cached)
// ======================================================
const pageTitleCache = new Map();

function firstTitleFromPage(page) {
  const props = page?.properties || {};
  const titleKey = Object.keys(props).find((k) => props[k]?.type === "title");
  if (!titleKey) return "";
  return rtPlain(props[titleKey].title);
}

async function getPageTitleCached(pageId) {
  if (pageTitleCache.has(pageId)) return pageTitleCache.get(pageId);
  const page = await notionGetPage(pageId);
  const title = firstTitleFromPage(page) || "";
  pageTitleCache.set(pageId, title);
  return title;
}

async function resolveRelationNames(prop, max = 2) {
  const ids = relationIds(prop);
  if (!ids.length) return [];

  const sliced = ids.slice(0, max);
  const names = [];
  for (const id of sliced) {
    const t = await getPageTitleCached(id);
    if (t) names.push(t);
  }
  if (ids.length > max) names.push(`+${ids.length - max}`);
  return names;
}

// ======================================================
// QUERY NOTION (month)
// ======================================================
async function queryNotionForMonth(databaseId, monthKey) {
  const { start, end } = monthStartEnd(monthKey);

  // Clear per sync so updates reflect quickly
  pageTitleCache.clear();

  const res = await notionDbQuery(databaseId, {
    filter: {
      and: [
        { property: NOTION_PROPS.status, select: { equals: "Upcoming" } },
        { property: NOTION_PROPS.date, date: { on_or_after: start.toISOString() } },
        { property: NOTION_PROPS.date, date: { before: end.toISOString() } },
      ],
    },
    sorts: [{ property: NOTION_PROPS.date, direction: "ascending" }],
    page_size: 100,
  });

  const items = [];
  for (const page of res.results || []) {
    const p = page.properties || {};

    const title = titlePlain(p[NOTION_PROPS.title]) || "(Untitled)";
    const type = selectPlain(p[NOTION_PROPS.type]);

    const ds = dateStart(p[NOTION_PROPS.date]);
    if (!ds) continue;
    const dateObj = new Date(ds);

    // optional time text (rich text)
    let timeText = "";
    const timeProp = p[NOTION_PROPS.time];
    if (timeProp?.type === "rich_text") timeText = richTextPlain(timeProp);

    const location = selectPlain(p[NOTION_PROPS.location]);
    const link = urlPlain(p[NOTION_PROPS.link]);

    const artistNames = await resolveRelationNames(p[NOTION_PROPS.artist], 2);
    const memberNames = await resolveRelationNames(p[NOTION_PROPS.member], 2);

    items.push({
      title,
      type,
      dateObj,
      timeText: (timeText || "").trim(),
      location: (location || "").trim(),
      link: (link || "").trim(),
      artistText: artistNames.join(", "),
      memberText: memberNames.join(", "),
    });
  }

  items.sort((a, b) => a.dateObj - b.dateObj);
  return items;
}

// ======================================================
// DISCORD FORMATTING
// ======================================================
function fmtLine(evt) {
  const d = evt.dateObj;
  const mon = d.toLocaleString("en-US", { month: "short" }).toUpperCase();
  const day = String(d.getDate()).padStart(2, "0");

  const timePart = evt.timeText ? ` | ${evt.timeText}` : "";

  const emoji =
    evt.type === "Birthday" ? "🎂 " :
    evt.type === "Comeback" ? "🔔 " :
    evt.type === "Release" ? "💿 " :
    evt.type === "Event" ? "📍 " :
    "";

  // Clean metadata: Artist • Members • Location
  const metaParts = [];
  if (evt.artistText) metaParts.push(evt.artistText);
  if (evt.memberText) metaParts.push(evt.memberText);
  if (evt.location) metaParts.push(evt.location);

  const meta = metaParts.length ? ` — ${metaParts.join(" • ")}` : "";
  const link = evt.link ? ` · ${evt.link}` : "";

  return `[${mon} ${day}${timePart}] ${emoji}${evt.title}${meta}${link}`.trim();
}

function buildEmbed(monthKey, events, tzLabel = "KST") {
  const title = `Schedule — ${fmtMonthTitle(monthKey)}`;
  const body = events.length ? events.map(fmtLine).join("\n") : "_No upcoming entries._";

  return new EmbedBuilder()
    .setTitle(title)
    .setDescription(body)
    .setFooter({ text: `Synced from Notion • ${tzLabel}` });
}

// ======================================================
// PERSISTENT MESSAGE PER THREAD (per guild + per scope)
// ======================================================
function loadMetaAll() {
  return loadJson(META_FILE, {});
}
function saveMetaAll(meta) {
  saveJson(META_FILE, meta);
}

async function ensureScheduleMessage(channelOrThread, metaKey) {
  const meta = loadMetaAll();
  const msgId = meta[metaKey]?.messageId;

  if (msgId) {
    try {
      return await channelOrThread.messages.fetch(msgId);
    } catch {
      // recreate
    }
  }

  const created = await channelOrThread.send("Initializing schedule…");
  meta[metaKey] = { messageId: created.id };
  saveMetaAll(meta);
  return created;
}

async function publishSchedule(discord, threadId, databaseId, monthKey, metaKey, tzLabel) {
  if (!threadId) return 0;

  const events = await queryNotionForMonth(databaseId, monthKey);

  const thread = await discord.channels.fetch(threadId);
  if (!thread) throw new Error(`Thread not found or no access: ${threadId}`);

  const msg = await ensureScheduleMessage(thread, metaKey);
  const embed = buildEmbed(monthKey, events, tzLabel);

  await msg.edit({ content: "", embeds: [embed] });
  return events.length;
}

// ======================================================
// SLASH COMMANDS (ADMIN ONLY)
// ======================================================
const CaltrixCommand = new SlashCommandBuilder()
  .setName("caltrix")
  .setDescription("Caltrix schedule bot (admin only)")
  .setDefaultMemberPermissions(PermissionFlagsBits.ManageGuild)

  .addSubcommand((sc) =>
    sc
      .setName("setup")
      .setDescription("Configure this server (staff channel + threads)")
      .addChannelOption((o) =>
        o
          .setName("staff_channel")
          .setDescription("Channel where /caltrix commands are allowed")
          .setRequired(true)
      )
      .addStringOption((o) =>
        o
          .setName("thread_this")
          .setDescription("Thread ID for THIS month schedule")
          .setRequired(true)
      )
      .addStringOption((o) =>
        o
          .setName("thread_last")
          .setDescription("Thread ID for LAST month schedule")
          .setRequired(false)
      )
      .addStringOption((o) =>
        o
          .setName("thread_next")
          .setDescription("Thread ID for NEXT month schedule")
          .setRequired(false)
      )
      .addStringOption((o) =>
        o
          .setName("thread_archive")
          .setDescription("Thread ID for ARCHIVE (optional)")
          .setRequired(false)
      )
  )

  .addSubcommand((sc) =>
    sc
      .setName("notion")
      .setDescription("Configure Notion database for this server")
      .addStringOption((o) =>
        o
          .setName("database_link")
          .setDescription("Paste a Notion database link (the bot extracts the DB id)")
          .setRequired(true)
      )
  )

  .addSubcommand((sc) =>
    sc.setName("config").setDescription("Show config for this server")
  )

  .addSubcommand((sc) =>
    sc
      .setName("sync")
      .setDescription("Sync from Notion and update schedule message")
      .addStringOption((o) =>
        o
          .setName("scope")
          .setDescription("this | last | next | all")
          .setRequired(false)
      )
      .addStringOption((o) =>
        o
          .setName("tz")
          .setDescription("Footer label (e.g. KST)")
          .setRequired(false)
      )
  );

const commands = [caltrixCommand.toJSON()];

// ======================================================
// DISCORD CLIENT
// ======================================================
if (!process.env.DISCORD_TOKEN) throw new Error("Missing DISCORD_TOKEN in env");
if (!process.env.NOTION_TOKEN) throw new Error("Missing NOTION_TOKEN in env");
if (!process.env.NOTION_INTEGRATION_NAME) {
  console.warn("NOTION_INTEGRATION_NAME not set (optional, but recommended).");
}

console.log("DEBUG env:", {
  DISCORD_TOKEN: process.env.DISCORD_TOKEN ? "set" : "missing",
  NOTION_TOKEN: process.env.NOTION_TOKEN ? "set" : "missing",
});

const discord = new DiscordClient({ intents: [GatewayIntentBits.Guilds] });

discord.once("ready", async () => {
  const rest = new REST({ version: "10" }).setToken(process.env.DISCORD_TOKEN);

  // Global commands for multi-server bot
  await rest.put(Routes.applicationCommands(discord.user.id), { body: commands });

  console.log(`Logged in as ${discord.user.tag} and registered global commands.`);
});

discord.on("interactionCreate", async (interaction) => {
  try {
    if (!interaction.isChatInputCommand()) return;
    if (interaction.commandName !== "caltrix") return;

    const guildId = interaction.guildId;
    if (!guildId) {
      await interaction.reply({ content: "Use this command in a server.", ephemeral: true });
      return;
    }

    const sub = interaction.options.getSubcommand();

    // -------------------- SETUP --------------------
    if (sub === "setup") {
      const staffChannel = interaction.options.getChannel("staff_channel", true);
      const threadThis = interaction.options.getString("thread_this", true);
      const threadLast = interaction.options.getString("thread_last") || null;
      const threadNext = interaction.options.getString("thread_next") || null;
      const threadArchive = interaction.options.getString("thread_archive") || null;

      const cfg = setGuildCfg(guildId, {
        staffChannelId: staffChannel.id,
        threads: {
          thisMonth: threadThis,
          lastMonth: threadLast,
          nextMonth: threadNext,
          archive: threadArchive,
        },
      });

      await interaction.reply({
        content:
          "Saved config for this server:\n```json\n" +
          JSON.stringify(cfg, null, 2) +
          "\n```",
        ephemeral: true,
      });
      return;
    }

    // -------------------- NOTION SET --------------------
    if (sub === "notion") {
      const link = interaction.options.getString("database_link", true);
      const dbId = extractNotionDbIdFromUrl(link);

      if (!dbId) {
        await interaction.reply({
          content:
            "I couldn't find a Notion database ID in that link. Please paste the database link (it contains a 32-char id).",
          ephemeral: true,
        });
        return;
      }

      const cfg = setGuildCfg(guildId, {
        notion: { databaseId: dbId },
      });

      const integrationName = process.env.NOTION_INTEGRATION_NAME || "Caltrix";
      await interaction.reply({
        content:
          `Saved Notion DB for this server.\n\n` +
          `**Next step (required):** Open that Notion database → **Share** → invite the integration **${integrationName}**.\n\n` +
          `Then run: **/caltrix sync**\n\n` +
          `Stored DB ID: \`${dbId}\``,
        ephemeral: true,
      });
      return;
    }

    // -------------------- CONFIG --------------------
    if (sub === "config") {
      const cfg = getGuildCfg(guildId);
      await interaction.reply({
        content: "```json\n" + JSON.stringify(cfg || {}, null, 2) + "\n```",
        ephemeral: true,
      });
      return;
    }

    // -------------------- SYNC --------------------
    if (sub === "sync") {
      const cfg = requireGuildCfg(guildId);

      // Only allow usage in configured staff channel
      if (interaction.channelId !== cfg.staffChannelId) {
        await interaction.reply({
          content: "Use this command in the configured staff channel.",
          ephemeral: true,
        });
        return;
      }

      const scope = (interaction.options.getString("scope") || "this").toLowerCase();
      const tzLabel = interaction.options.getString("tz") || "KST";

      const now = new Date();
      const thisMonth = monthKeyFromDate(now);
      const lastMonth = monthKeyFromDate(new Date(now.getFullYear(), now.getMonth() - 1, 1));
      const nextMonth = monthKeyFromDate(new Date(now.getFullYear(), now.getMonth() + 1, 1));

      const t = cfg.threads || {};
      const databaseId = cfg.notion.databaseId;

      await interaction.deferReply({ ephemeral: true });

      const doThis = async () =>
        publishSchedule(discord, t.thisMonth, databaseId, thisMonth, `${guildId}:thisMonth`, tzLabel);

      const doLast = async () =>
        t.lastMonth
          ? publishSchedule(discord, t.lastMonth, databaseId, lastMonth, `${guildId}:lastMonth`, tzLabel)
          : 0;

      const doNext = async () =>
        t.nextMonth
          ? publishSchedule(discord, t.nextMonth, databaseId, nextMonth, `${guildId}:nextMonth`, tzLabel)
          : 0;

      if (scope === "all") {
        const nLast = await doLast();
        const nThis = await doThis();
        const nNext = await doNext();
        await interaction.editReply(`Synced. Last: ${nLast}. This: ${nThis}. Next: ${nNext}.`);
        return;
      }

      if (scope === "last") {
        const n = await doLast();
        await interaction.editReply(`Synced last month (${lastMonth}): ${n}.`);
        return;
      }

      if (scope === "next") {
        const n = await doNext();
        await interaction.editReply(`Synced next month (${nextMonth}): ${n}.`);
        return;
      }

      const n = await doThis();
      await interaction.editReply(`Synced this month (${thisMonth}): ${n}.`);
      return;
    }
  } catch (err) {
    console.error(err);

    // Friendlier Notion sharing error
    const raw = String(err?.message || "unknown");
    let msg = `Error: ${raw}`;

    if (raw.includes("Notion API 404") || raw.toLowerCase().includes("could not find database")) {
      const integrationName = process.env.NOTION_INTEGRATION_NAME || "Caltrix";
      msg =
        "Error: I cannot access that Notion database.\n" +
        `Make sure you opened the database in Notion → **Share** → invited the integration **${integrationName}**.\n` +
        "Then try /caltrix sync again.";
    }

    if (interaction.deferred || interaction.replied) {
      await interaction.editReply(msg);
    } else {
      await interaction.reply({ content: msg, ephemeral: true });
    }
  }
});

discord.login(process.env.DISCORD_TOKEN);


