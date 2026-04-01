# Caltrix

Caltrix is a Notion-powered schedule publisher for Discord.
It reads events from a Notion database and updates a single pinned-like embed message inside threads.

## Features
- Multi-server support (per-server config stored in `guild-config.json`)
- Admin-only commands (Manage Server)
- Per-server Notion database configuration (admins paste DB link)
- Updates the same message (no spam)

##🧩 Supported Event Types

Caltrix uses the Type property in your Notion database to determine how events are displayed in Discord.

Supported values:

* Birthday
* Comeback
* Debut
* Concert
* Event
* Award
* Release

Each type is rendered with an icon:

- 🎂 Birthday
- ⚠️ Comeback
- ✨ Debut
- 🎤 Concert
- 🎪 Event
- 🏆 Award
- 💿 Release

##📅 Event Format in Discord

Each Notion entry is displayed as:

[DATE] [ICON] Title — Artist • Member • Location
↳ Link (optional)

Example:

[MAR 17] 🎤 NMIXX World Tour — NMIXX • Madrid
↳ 🔗 View Details

##⚠️ Important
The Type field must match one of the supported values
The Date field is required
Unsupported types will display without an icon
The Link field is optional
Artist and Member fields can be text or relations

##🧠 Recommended Notion Structure

Minimum required:

Title (Name)
Date (Date)
Type (Select)

Optional:

Artist
Member
Location
Link

## Setup (per server)
1) Run `/caltrix setup` to set staff channel + thread IDs
2) Run `/caltrix notion` with a Notion database link
3) In Notion, open DB → Share → invite the integration name shown in env (`NOTION_INTEGRATION_NAME`)
4) Run `/caltrix sync`

## Local Run
```bash
npm install
cp .env.example .env
# fill in DISCORD_TOKEN + NOTION_TOKEN
npm start

