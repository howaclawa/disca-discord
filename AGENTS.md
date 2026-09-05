# Discord plumbing

This folder owns Disca's Pi extension. Keep development mechanics here; root `AGENTS.md` owns her editable personality and `.pi/APPEND_SYSTEM.md` owns fixed resident boundaries.

## Product invariants

- Keep all intelligence and agency in Disca's visible Pi session.
- Keep Discord input, Pi streaming, tool calls, and failures observable in the TUI.
- State the task-level need naturally in injected wake and control prompts, keeping transport mechanics in the extension.
- Keep lifecycle controls together in one compact action tool.
- Complete channel, user, trigger, and wake selection at the gateway boundary. Give Pi a settled directed turn or deliberate ambient wake whose first decision concerns the substance.
- Keep every agent tool on one implementation across structured and Code/Notebook modes. Project it through `pi-codex-conversion` and preserve useful structured results for composition.
- Discord output is explicit and ordered: session handles reply to exact messages, the current-channel route posts unattached, and unmarked final text never leaves Pi.
- Keep accepted Discord messages continuous in Pi context. Inject unseen ambient context once, preserve explicit reply chains, and deduplicate internally by Discord message ID.
- Wake Disca on a configurable per-channel message-count jitter. Present each ambient batch once and leave her free to join in, follow a curiosity, tend the home, or stay quiet.
- Monitoring and durable history stay live while chat intake is paused. Searchable gateway history is memory, not disposable transport state.
- `.pi/disca/archive-pending.json` retains history writes until SQLite accepts them. Preserve its ordering and replay it before clearing archive-failed health; it is not disposable cache.
- Represent attachments through inspectable local paths and links through durable indexes, loading their contents when they matter.

## Live-in environment

- Mutable bot config, including the token, triggers, policies, and limits, lives in the tracked root `.env`. Disca may edit it; commit its resident state.
- Track and commit `.pi` skills, prompt files, memory databases, Discord history, and owned assets as resident state.
- Build for this private home. Every document, compatibility layer, and piece of ceremony should answer a concrete resident need.
- Resolve dependencies through the isolated Bun linker and global store defined in `bunfig.toml`.
- Keep TypeScript 7 strict. Reuse existing owners and contracts before adding another abstraction.
- Pi 0.85.0 imports `pi-server` without declaring it. The matching local dev dependency and Knip exception keep SDK imports working; remove them when upstream declares it.

## Lifecycle (reload vs restart)

- `disca_control reload` schedules `/reload-extensions` at the end of the response, then resumes with `Continue.`. Use it for extension-shell changes. Do not hand reloads to Igor; do them.
- `disca_control restart` recycles the Discord gateway runtime in place (kills typing timers, reconnects). Use it when the change lives in `src/discord/*`, `src/bridge/*`, or `src/session.ts`, or when typing or connection state sticks after a reload.
- `disca_control disconnect` stops the gateway but keeps the extension loaded.
- The session auto-restarts on settle when `.env` changed.

## Notebook tools

- `tools` is a Proxy: `Object.keys(tools)` and `ALL_TOOLS` underreport. Check `typeof tools.<name> === 'function'` and just call it; read the error text.
- Disca code-mode tools: `disca_control`, `discord_send`, `recall`, `remember`. Platform web: `web__run` for search, `browser` for interactive pages.

## Validation

- `bun run check` is the umbrella gate for Biome, TypeScript, Knip, and tests.
- Tests protect batching, exact output routing, trigger policy, context continuity, transport limits, tracked config authority, memory, and durable history.
- Test deterministic boundaries directly; reserve Discord itself for deliberate live checks.
- Keep a contract spine, not a feature museum: every test must name a credible wrong implementation it rejects at a boundary this folder owns (routing, parsing, persistence and replay, ordering, cancellation, lifecycle). Delete inventories, tours, mock choreography, and duplicate static guarantees.
- Run focused checks while iterating, review the complete diff, then run the umbrella gate once.
