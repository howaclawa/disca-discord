# Disca Discord plumbing

A Pi extension that turns a coding-agent session into a Discord roommate: directed replies, ambient chatter, explicit reply routing, attachment archiving, searchable history, long-term memory, and ears and eyes for voice notes and clips.

This repo doubles as a **template for your own sassy humanlike bot**. The code is the plumbing; the personality is three markdown files.

## Quickstart

1. `bun install` (isolated linker per `bunfig.toml`)
2. Copy `.env.example` to `.env` and fill it in: bot token, channel policy, trigger aliases, wake ranges.
3. Put your spine in place:
   - Copy `AGENTS.template.md` to your project root as `AGENTS.md` and make it yours: name, human, taste, jokes that stuck.
   - Copy `APPEND_SYSTEM.template.md` to `.pi/APPEND_SYSTEM.md`, replacing every TODO (bot name, human name, Discord user ID).
   - Read `discord-plumbing/AGENTS.md` for the development ground rules.
4. Run Pi with this folder as an extension: `pi -e ./index.ts`
5. In Pi: `/discord` to connect the gateway, `/discord-chat` to arm turns.

## Making it yours

- **Triggers**: `TRIGGER_ALIASES` in `.env` is what wakes the bot. Pick names the room will actually use.
- **Policy**: `CHANNEL_POLICY` is `mentions`, `channels` or `all`. Mentions plus replies is the polite default.
- **Personality**: lives in `AGENTS.md` and `vault/`, not in code. Curate it as you go: opinions earned, corrections that become habit, people you know.
- **Memory**: `remember` for raw facts, `vault/` for shaped understanding, one owner per truth.
- **Status**: `DISCORD_STATUS_TEXT` and `DISCORD_STATUS_TYPE` in `.env`, picked up on restart.
- **Ears**: `disca_perceive` sends local audio or video to the same model with the voice brief in `perceive.md`. Needs a Meta key in the agent auth file and `ffmpeg` for non-mp3 audio.

## Checks and layout

- `bun run check` runs lint, typecheck, Knip and tests. Keep it green.
- `src/discord/` is the gateway, `src/bridge/` turns and routing, `src/extension/` Pi wiring, `src/memory.ts` and `src/recall.ts` are long-term memory.
- House rule: every test must name a wrong implementation it rejects. No inventories, no tours.
