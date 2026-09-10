# Contributing

Follow the [README quickstart](README.md#run-locally) using the pinned Node version. Run commands from the repository root.

```sh
npm ci
npm run dev
npm run check
```

`check` runs formatting, TypeScript, and the production build without an API key or model calls. Use `npm run format` to apply formatting. To check production startup, run `npm run build` followed by `npm start`; use Ctrl+C and wait for active-session cleanup before restarting.

## Code layout

- `client/session.ts` owns browser connections and audio resources.
- `client/App.tsx`, `client/state.ts`, and `client/styles.css` implement the UI.
- `server/session.ts` manages delegation, tools, limits, and cleanup.
- `server/catalog.ts` contains fictional products and read-only tools.
- `server/protocol.ts` constructs bounded protocol messages.
- `server/openai.ts` wraps the SDK and sideband connection.
- `server/http.ts` enforces local request security and ownership.
- `shared/types.ts` defines normalized browser events.

Keep credentials server-side, tools read-only, and the server bound to loopback. Do not add arbitrary shell execution, public hosting, automatic reconnects, or hidden billable retries.

## Manual verification

Real API checks are opt-in and incur charges. Use your own authorized API project, a short duration limit, headphones, and only the fictional catalog prompts. For each delegation mode:

1. Start a conversation and confirm microphone permission and successful connection.
2. Ask the README's weekend-backpack question. Check the input transcript, tool arguments/result, and spoken response.
3. Ask a follow-up about the product to check conversation context.
4. Exercise microphone/speaker mute, volume, supported device selection, and playback recovery.
5. End during normal conversation, startup, and backend work. Verify audio resources close and missing final usage is labeled incomplete.
6. Check permission denial, network loss, time-limit expiry, tab closure, and server shutdown.

Keep the application on `gpt-live-1`. State the exact browser/device, commands, and outcomes exercised; do not equate a build or metadata check with working audio.

## Issues and pull requests

Provide a minimal reproduction, expected and actual behavior, runtime/browser versions, delegation mode, and a sanitized error code. Explain the change and validation gaps. Keep changes focused and update documentation when behavior changes.

Do not include credentials, recordings, private transcripts, upstream payloads, or internal documents. Send security reports through [SECURITY.md](SECURITY.md), not public issues. This sample has no guaranteed response time or feature-support commitment. Keep discussions respectful and focused on the work.
