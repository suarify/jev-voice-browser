# Suarify Voice Browser — Chrome extension

Speak to control **the tab you're already in**. This is the extension port of the Node server
app in the repo root. Same Jev (TypeSafe System One) decision engine, same policy gates — but
instead of a server driving a separate Playwright Chromium, a **manifest-v3 extension** controls
your current tab directly.

UI: white background, teal brand text, navy secondary, with a subtle gradient — plus a
🌙 dark-mode toggle (persisted per install).

Borrowed from the two reference projects you pointed me at:

- **chrome-voice-actions** — the microphone lives in the extension popup via the Web Speech API;
  it only listens while the popup is open (privacy-friendly).
- **click-by-voice** — numbered hint badges over clickable elements; say a bare number to click.
  Used for both disambiguation (`which one?`) and an optional "show hints on every page" mode.

The one thing the repo app has that the extension can't: driving a *second* browser window.
Everything else (intents, sites, search templates, corrections, destructive confirm, context)
is shared verbatim — `extension/lib/*` are ports of `src/constants.js`, `src/spans.js`,
`src/snapshot.js`, `src/policy.js` and `src/jev.js`.

## Architecture

```
 popup (mic, Web Speech API)   ──transcript──▶  service worker (holds key + config)
                                                    │ debounce → build state+questions
                                                    │ fetch POST {baseUrl}/v1/systemone
                                                    │ policy (thresholds in lib/constants.js)
 content.js (current tab)      ◀──act / toast──     │ element actions (click/type/scroll)
 chrome.tabs API               ◀──navigate───       │ tab actions (open/close/switch/back)
                                                    └──▶ push live state back to the popup
```

The decision endpoint is **configurable** in the options page:

- Default `https://api.typesafe.ai` (real Jev, needs a TypeSafe API key — `https://console.typesafe.ai/keys`)
- Or **your own endpoint**, in either form:
  - a base URL (`http://localhost:8787`) → `/v1/systemone` is appended automatically
  - a full URL (`http://localhost:8787/decide`) → used verbatim — plug in the repo's own
    `src/server.js`, a self-hosted decision server, or any compatible reimplementation.

The service worker speaks the same wire protocol as the Node SDK: `POST {endpoint}`
with `Authorization: Bearer <key>` and body `{state, questions, model}` — so any endpoint that
accepts that works.

## Load it (development)

1. `git clone` this repo and `cd` into it.
2. Open `chrome://extensions`, enable **Developer mode**.
3. **Load unpacked** → point at the `extension/` folder.
4. Click the extension icon → **⚙** → paste your API key (keep the default base URL, or point at
   a local proxy) → **Save**.
5. Open a normal web page, open the extension popup, click **Start mic**, allow the microphone,
   and speak.

**Keep the popup open while speaking** — it hosts the microphone. No mic? Type a command in the
popup's text box.

## What you can say

Same command set as the repo README — navigate/search/click/type/scroll/history/tabs plus
corrections ("no, not that one", "the other one") and destructive-confirm ("click buy now" →
say "confirm"). Numbered overlays appear when the target is ambiguous — say the number. With
**Show hints on page** on, every clickable element is numbered (click-by-voice style) and a bare
number clicks it directly, no model call.

## How a decision is made

Every transcript update produces exactly one Jev request (see `lib/jev.js`). The state carries
the transcript, a compact element snapshot, and the conversation context (previous page + last
few actions). The `lib/policy.js` gates are identical to the server app and the popup renders
the same `is_command / intent / complete / target / destructive` reason table live.

## Tests

```bash
npm run test:ext     # 42 unit tests: spans, snapshot, policy, context, endpoint — no network
```

## Limitations

- Web Speech API needs Chrome/Edge; the popup must stay open (and only listens while open).
- MV3 service workers can go idle between messages; the debounce timers run while the popup is
  actively streaming transcripts, which keeps the worker warm during a session.
- Content scripts don't run on `chrome://` pages, the Chrome Web Store, or the new-tab page —
  on those, navigation/search still work via `chrome.tabs`, but element clicks/types can't.
- Element snapshots cap at 100 items, viewport-first; deep pages need a scroll first.
- The API key is stored in `chrome.storage.local` (never synced) and only ever sent in the
  Authorization header of requests to your configured base URL.