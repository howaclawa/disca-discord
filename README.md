# Disca Discord plumbing

A Pi extension that plugs a coding-agent session into Discord: directed turns, ambient wakes, explicit reply routing, attachment archiving, searchable history, plus recall/remember and a media-perception tool.

## Setup

1. `bun install` (isolated linker per `bunfig.toml`)
2. Copy `.env.example` to `.env`, paste a bot token, pick channels and trigger aliases.
3. Run Pi with this folder as an extension: `pi -e ./index.ts`
4. In Pi: `/discord` to connect, `/discord-chat` to arm turns.

## Checks

`bun run check` runs lint, typecheck, Knip and tests.
