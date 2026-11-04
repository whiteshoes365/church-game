# RESULT

## Stack
- Server: Node.js + `ws`, in-memory state (`server/`), ESM, no DB.
- Client (mobile web player + desktop host): Vite + React + TypeScript + react-router (`client/`).
- Toss mini-app (`toss-app/`): same player flow, standalone package using `@apps-in-toss/web-framework`, styled per capture-quiz conventions (no header, single accent `#3182F6`, no emoji/gradients, no ads).
- Default content: 30 Korean kid-friendly Bible OX questions (`server/src/questions.js`).

## Run commands
- `npm install` (root installs server+client via npm workspaces)
- `npm run dev:server` / `npm run dev:client` — local dev (ws on :8787, vite on :5173)
- `npm run build` — builds client (`tsc && vite build`)
- `npm run verify` — spawns server, simulates 1 host + 3 players through a full OX quiz round, asserts scores
- `toss-app/`: `cd toss-app && npm install && npm run build` (separate package, not part of root workspaces)

## What works
- Church search-or-create by name, room list (map/title/capacity 4/8/unlimited).
- Player: nickname + avatar (shape+color, no photos/emoji) only; device id in localStorage with a `TODO(Toss 연동)` hook comment for `getUserKeyForGame`.
- Host big-screen: create/open room, live map with avatars sliding to O/X as players answer, timer, reveal, scoring, next question, final leaderboard.
- `BannerAdSlot` placeholder rendered only on the host page, clearly marked, not wired to any ad SDK.
- Toss app reuses the same WS protocol with its own minimal UI (no router, no ads, no header chrome).

## Verification output (summary)
```
npm run verify
[verify] server is up / all sockets connected
[verify] church created, room created, 3 players joined
[verify] round 1/2/3 scores ok: {...}
[verify] quiz finished. final scores: {...}
[verify] ALL CHECKS PASSED ✅   (exit code 0)
```
`npm run build` → tsc + vite build succeed for both `client/` and `toss-app/`.

## Open issues
- **Deployment**: server not deployed; needs a host (Render/Fly/Railway) with `PORT` env + persistent process. Client needs `VITE_WS_URL` pointed at that host's `wss://` URL before building for production.
- **Toss packaging**: did not run `ait build`/publish — that requires a Toss developer account/login, which was intentionally skipped (no accounts created). Only `tsc && vite build` was verified.
- **Ads**: host page only has an unwired placeholder slot; no ad network chosen yet (candidates: Toss AFA/TossAds for the mini-app surface, or a generic web banner network for the plain desktop host page — decision deferred).
- **Reconnects**: players reconnecting mid-game keep their score (keyed by deviceId) but there's no reconnect UX/toast; host losing connection doesn't pause the game.
- **Timer**: question auto-reveals server-side after 15s even if host is gone; no persistence across server restarts (in-memory only, by design for MVP).
