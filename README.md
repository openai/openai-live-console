# OpenAI Live Console

A local voice console with a visible backend. Talk about a small fictional backpack catalog, see delegation and read-only tool activity, and follow the answer back to speech.

The application targets `gpt-live-1` and requires an API project with access to Live WebRTC, sideband attachment, and the configured Responses model. Model metadata access alone does not establish transport access. End-to-end compatibility with `gpt-live-1` still needs verification; this repository is not a public-release approval.

## Run locally

Use Node **24.15.0** and npm. API usage is billed separately from ChatGPT.

```sh
nvm install
nvm use
npm ci
cp .env.example .env
```

Set `OPENAI_API_KEY` in `.env` using your editor. Keep it on the server; never put it in frontend code or a `VITE_` variable.

```sh
npm run doctor
npm run dev
```

Open **http://127.0.0.1:3000**. The exact host matters: the server rejects alternate hosts and cross-origin requests. Click **Start conversation**, allow the microphone, and try:

> Find me a backpack for a weekend trip under 120 dollars.

The expected catalog result is the fictional **Sample Backpack B**, priced at **$95**. All catalog names are generic sample placeholders, not backpack brands or model names. Headphones help avoid acoustic feedback. Use **End conversation** when finished and wait for a confirmed close. Muting the microphone or speaker does not stop billing.

`npm run doctor` only reads model metadata. It does not make a model inference call or test audio. The app does not silently select a different Live model when access fails.

## Delegation modes

| Mode            | Live owns                                            | This application owns                                                               |
| --------------- | ---------------------------------------------------- | ----------------------------------------------------------------------------------- |
| Managed by Live | Supplies context to the configured Responses backend | Validates and executes read-only tool calls, then submits results                   |
| Managed by app  | Requests a backend handoff                           | Builds context, calls Responses, runs the bounded tool loop, and returns the result |

Both modes use the same three-product catalog and permission checks. Application-owned delegation demonstrates where you could add retrieval or orchestration. Neither mode can execute shell commands, place orders, or access customer accounts.

The browser handles microphone/speaker audio over WebRTC and displays normalized events from the local server. The server owns credentials, model configuration, tool permissions, and cleanup.

## Configuration and costs

| Setting                | Default        | Scope                                                 |
| ---------------------- | -------------- | ----------------------------------------------------- |
| `OPENAI_API_KEY`       | Empty          | Server environment only                               |
| `OPENAI_BACKEND_MODEL` | `gpt-5.4-mini` | Responses-compatible backend enabled for your project |
| `MAX_SESSION_SECONDS`  | `180`          | Integer from 30 to 600                                |
| `PORT`                 | `3000`         | Loopback port; host is always `127.0.0.1`             |

Live audio duration and backend tokens are separate costs. The UI reports usage, not a dollar estimate. Consult [API pricing](https://openai.com/api/pricing/) and your project billing settings.

The session duration guard includes additional bounded startup and finalization time; it is not a hard dollar cap. The sample permits one active session, six starts per minute, eight delegations, three tool rounds per delegation, and 24 unique tool calls. There is no automatic reconnect because it could create another billable session.

HTTP(S) proxies and `NO_PROXY` are supported. Keep loopback traffic out of your proxy and never disable TLS verification. SOCKS/PAC proxies are not supported.

## Development

```sh
npm run check       # Formatting, TypeScript, production build; no API calls
npm run dev
npm run build
npm start           # Serve the built frontend, still local only
```

Dependencies are pinned in `package.json` and the lockfile. The application uses the official OpenAI Node SDK **7.9.0** for HTTP and Responses calls, with an application-owned WebSocket adapter for Live sideband events.

See [CONTRIBUTING.md](CONTRIBUTING.md) for the code layout and verification checklist. Use a current desktop browser with WebRTC and microphone support. Speaker-device selection varies by browser; use the playback-resume control if playback is blocked.

## Privacy and safety

Keys stay on the server. The server enforces loopback binding, exact Host/Origin checks, a local session cookie, CSRF verification, ownership, and input limits. The browser cannot request arbitrary backend commands. These are sample safeguards, not multi-user authentication. **Do not expose the server through a tunnel or public reverse proxy.**

The app does not save audio or transcripts to disk. Transcripts and bounded event history remain in memory until cleared or expired. Copying a transcript is an explicit user action. OpenAI requests follow your project's data controls. The application-owned backend requests `store: false`; this is not a promise of zero retention.

The transcript display retains at most 100 groups and 20,000 text characters. When a continuous group exceeds that limit, its latest text remains visible and the display indicates that older text was clipped.

Missing final usage is labeled incomplete. A disconnected socket alone does not prove the upstream session ended. Check API usage if finalization cannot be confirmed.

This is an educational sample provided as-is, not a supported production service. Use repository issues for reproducible sample bugs and the [OpenAI Help Center](https://help.openai.com/) for account or billing questions. Report security issues privately using [SECURITY.md](SECURITY.md).

Licensed under the [MIT License](LICENSE). Third-party dependencies retain their [own licenses and notices](THIRD_PARTY_NOTICES.md).
