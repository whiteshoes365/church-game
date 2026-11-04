# RESULT

## Free-roam movement for OX quiz players (2026-11-04)

Players can now freely drive their avatar around the map from their phone (joystick + jump/run/crawl),
the server simulates movement authoritatively, and O/X answers are decided by which zone the avatar is
physically standing in when the question resolves. `toss-app/` was not touched.

## Protocol additions

All additions are backward compatible — existing message types and `RoomSnapshot` fields are unchanged,
only new optional fields/messages were added.

- **`createRoom` request**: optional `questionSeconds` (number). Sets `room.questionDurationMs` for that
  room's questions (default stays 15000ms / `QUESTION_DURATION_MS`). Used by `verify.mjs` to keep tests fast.
- **`RoomSnapshot`** (sent in `roomCreated`/`roomState`/`joined`) gains two constant fields so the client
  never has to hardcode geometry:
  - `bounds: {xmin,xmax,zmin,zmax}` — the walkable map rectangle.
  - `zones: { O: {xmin,xmax,zmin,zmax}, X: {...} }` — the two answer zones, positioned under the O/X
    letter structures in the 3D scene.
  - `questionDurationMs: number`.
- **Client → server `move`**: `{ roomId, dir: {x, z}, run?: boolean, crawl?: boolean }`. `dir` is a
  joystick vector (each axis roughly -1..1, un-normalized is fine — server clamps/normalizes). Intended
  to be sent by the phone at ~12 Hz while the joystick/d-pad is touched. Any non-trivial `dir` cancels an
  in-progress auto-walk (see `answer` below).
- **Client → server `jump`**: `{ roomId }`. One-shot; server applies a short cooldown (600ms) and ignores
  repeat requests while already airborne.
- **`answer` (existing message, now also a movement trigger)**: still records `side` immediately for
  backward-compatible UI feedback and still only accepts one answer per question. *New*: it also sets an
  auto-walk target at the center of the chosen O/X zone, so the O/X quick buttons now make the avatar walk
  itself there (at a brisk fixed speed) instead of just flipping a flag. Manual joystick/d-pad input
  cancels this auto-walk.
- **Server → host `positions`** (new, ~12.5 Hz / 80ms): `{ roomId, players: [{ id, x, z, y, state }] }`
  where `state` is `'idle' | 'walk' | 'run' | 'crawl' | 'jump'`. Sent only to `room.hostSocket`, and only
  while `room.status` is `'question'` or `'reveal'` (i.e. the room is "in play") — not during lobby/finished,
  to avoid pointless bandwidth. Not sent to players (phones don't render the 3D scene).

## Answer resolution rule (authoritative, documented in `server/src/state.js`)

> Whichever O/X zone the avatar is physically standing in when the question is revealed (by host action or
> timeout) is authoritative — `player.side` is overwritten with that zone (`'O'`, `'X'`, or `null`) at
> reveal time, regardless of any earlier explicit `answer` message. Standing in neither zone counts as no
> answer / wrong.

This means a host who reveals immediately after players press O/X (with zero travel time) will score based
on wherever players physically are, not what they clicked — same as a real teacher watching kids run to a
side of the room. The default 15s question timer (or a host-configured `questionSeconds`) is expected to
give enough time to walk/auto-walk there.

## Server simulation (`server/src/state.js`)

- Fixed-tick physics loop at `PHYSICS_TICK_MS = 50` (20 Hz), one global `setInterval` in `index.js` ticking
  every room (not one timer per room).
- Speeds: walk `2.2`, run `4.2`, crawl `1.0` units/sec; O/X-button auto-walk uses `4.2` (same as run) so it
  arrives briskly. Jump: initial velocity `4.5`, gravity `-12`, ~600ms cooldown, arc height tracked as `y`.
- Position is clamped to `MAP_BOUNDS` every tick.
- Simple O(n²) pairwise separation (push-apart below `0.6` units) so avatars don't stack heavily — fine at
  the player counts this game supports.
- `MAP_BOUNDS`/`ZONES`/`WALK_SPEED`/`RUN_SPEED`/`CRAWL_SPEED`/etc. are exported from `state.js` so
  `verify.mjs` can import the same constants instead of duplicating magic numbers.

## Client changes

- **`client/src/pages/PlayerRoom.tsx`**: new `Joystick` (pointer events, touch-action: none, works for
  touch and mouse) and `MovementControls` (큰 액션 버튼: 점프/달리기(홀드)/기어가기(토글)) rendered inside the
  existing question card, above the still-present O/X buttons (now documented in-UI as "자동으로 걸어가요").
  Movement is sent on a fixed ~83ms (`~12Hz`) interval reading the latest joystick vector + run/crawl flags.
- **`client/src/three/HostScene3D.tsx`**: rewritten to position every `VoxelCharacter` from the live
  `positions` feed (`x`, `y`, `z`, `state`) instead of the old static per-side grid layout; O/X letter
  structures are positioned from the server-sent `zones` so visuals and hit-testing can't drift apart.
  Reveal pose (`correct`/`wrong`) is now driven uniformly by `player.side === correctAnswer` (so a
  zone-less player at reveal falls over like a wrong answer, matching the resolution rule).
- **`client/src/three/VoxelCharacter.tsx`**: new optional `moveState` prop drives distinct poses — walk
  (moderate swing/hop), run (faster swing + forward lean), crawl (low crouch, slow swing), jump (tucked
  limbs, no bob — actual height comes from the server `y` already being lerped into position). Falls back
  to the old distance-based walk/idle heuristic when `moveState` is omitted (used by `AvatarPreview3D`, so
  the avatar builder preview is unaffected). Idle still faces the camera; moving still faces the direction
  of travel — unchanged from before.
- **`client/src/pages/HostRoom.tsx`**: subscribes to `positions` broadcasts into a `{id: PlayerPosition}`
  map, passed to `HostCanvas3D`/`HostScene3D` along with `room.zones`.

## Verify coverage (`verify/verify.mjs`)

Added a second room/scenario (uses `questionSeconds: 12` to stay fast) on top of the existing
church/room/join/score-3-rounds flow, covering:
- Moving two players into the O and X zones via raw `move` input, leaving a third player outside both —
  then confirming `reveal` scores/`side` match the zone each player is actually standing in (not what they
  clicked), including the "outside both zones = null/wrong" case.
- Run speed > walk speed > crawl speed, measured end-to-end through real `move` messages → physics tick →
  `positions` broadcast (not just reading server constants), with a 1.3x margin to absorb timing jitter.
- Jump: after a `jump` message, a `positions` sample with `y > 0.05` and `state === 'jump'` is observed.
- Auto-walk via the legacy `answer` message (O/X quick button): confirms `side` updates immediately
  (backward compat) and that the avatar actually arrives in that zone before reveal, then scores correctly.
- The pre-existing 3-round score test was updated: since `answer` no longer scores instantly, it now waits
  for each player's auto-walk to land in their chosen zone (via a `waitUntilInZone` poll, run concurrently
  across players) before calling `reveal`, instead of revealing immediately.

## Verification performed

- `npm run build` — passes (`tsc` clean, `vite build` succeeds).
- `npm run verify` — passes, run 3 times consecutively, no flakes (~14–15s each run).
- Manual browser check (headless Chrome via CDP, screenshots): phone joystick/buttons render correctly
  (big, kid-friendly, Korean labels); host 3D scene renders the avatar at its live server position; dragging
  the phone joystick visibly moved the avatar in the host's 3D view end-to-end (phone input → WS → server
  physics → `positions` broadcast → host render). Did not script a full drag-and-release visual check of
  every pose (run/crawl/jump animations) in a real browser — those are covered by the VoxelCharacter pose
  logic and the protocol-level verify assertions (y>0 during jump, speed ordering) rather than a pixel-level
  visual diff.

## Caveats

- Positions are only broadcast to the host, not to other players (phones don't render the 3D map, so this
  keeps bandwidth down — flagged as optional ("if useful") in the task).
- The pairwise separation physics is O(n²) per tick; fine for the player counts this game targets, would
  need spatial partitioning if rooms ever grew into the hundreds.
- `answer`'s auto-walk speed is fixed (same as run) regardless of map distance, so a player on the far
  side of the map takes a few seconds to visually arrive — the default 15s (or host-configured
  `questionSeconds`) question timer is expected to comfortably cover this; a host revealing within ~1s of
  the question starting could catch slower-spawned players still en route.
