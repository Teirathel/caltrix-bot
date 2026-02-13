# Caltrix

Caltrix is a Notion-powered schedule publisher for Discord.
It reads events from a Notion database and updates a single pinned-like embed message inside threads.

## Features
- Multi-server support (per-server config stored in `guild-config.json`)
- Admin-only commands (Manage Server)
- Per-server Notion database configuration (admins paste DB link)
- Updates the same message (no spam)

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

