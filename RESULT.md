# RESULT

## Four fixes (2026-11-04)

`server/`, `toss-app/`, and the WebSocket protocol were not touched.

### 1. Characters faced away from camera (`client/src/three/`)
`HostScene3D.tsx` was passing `facing={Math.PI}` to O/X-side `VoxelCharacter`s, which pointed their visual front (the `+z` side, where the hat visor/face sits) away from the camera and toward the letter structures — their backs were toward the audience. Camera sits at larger `z` than every player, so facing the camera means facing `+z`, i.e. `facing={0}`. Changed all three groups (O, X, neutral) to `facing={0}`. `VoxelCharacter.tsx`'s existing animation logic is unchanged: while `dist > 0.03` and `reveal === 'idle'` it still smoothly rotates to face the walk direction (`Math.atan2(dx, dz)`, lerped); once stopped/arrived it smoothly lerps back to `facing` (now camera-facing) via the same `THREE.MathUtils.lerp(..., delta * 6)` — no snapping.

### 2. Nickname labels too small (`client/src/three/VoxelCharacter.tsx`, `client/src/index.css`)
`.voxel-name-tag` font-size went from fixed `12px` to `clamp(20px, 2.1vw, 32px)` (bold `800`), with a near-opaque dark background (`rgba(10,14,24,0.88)`), white text, and a white border for strong contrast against grass/stone/sky backgrounds. Raised the `<Html distanceFactor>` from `8` to `11` so the drei billboard scale roughly matches 1:1 at the typical host-camera distance to players (~11–16 world units) instead of shrinking labels to ~half size. Kept `white-space: nowrap` and compact padding to limit overlap in dense grids.

### 3. HUD covered the O/X structures (`client/src/pages/HostRoom.tsx`, `client/src/three/HostScene3D.tsx`, `client/src/index.css`)
- The question/timer card was `position: absolute` inside `.map-area-3d`, floating over the top ~25–30% of the canvas. Verified by frustum math (camera `(0,10.5,15)`, `fov 48`, `lookAt(0,1.8,1)`): the top row of the `O`/`X` letter structures (world `y≈4.5`, `z≈-0.7`) projects to NDC `y≈0.43` — squarely inside the band the old ~150px-tall absolute HUD covered (NDC `y` from `0.34` to `1.0` for a 480px-tall canvas).
- Fix: restructured the JSX so `.host-hud` is a sibling **above** `.map-area-3d` inside a new flex column (`.map-column`), not an overlay — it now occupies its own document-flow space, so it can never cover the canvas regardless of content height. Condensed the question card into a single-row `.question-strip` (badge + 2-line-clamped question text + fixed-width timer bar) with a fixed `min-height: 76px` on `.host-hud` so canvas size doesn't jump between lobby/question/reveal states.
- Also found (same frustum math) that the closest row of the `NEUTRAL_BOX` waiting area (`z` up to `9`) clipped below the bottom edge of the frustum (NDC `y≈-1.21`, outside `[-1,1]`) — players' feet were cut off. The max safe `z` for full visibility under this camera is ≈7.88. Shrank `NEUTRAL_BOX` from `{zmin:7.5, zmax:9}` to `{zmin:6.8, zmax:7.6}`, which re-checks to NDC `y≈-0.78` (safely inside frame) without touching the camera or O/X player boxes (already safe at `zmax 6.5` → NDC `y≈-0.78`).

### 4. `verify/verify.mjs` waitFor race (timing flake)
`Client.waitFor` only registered a predicate/resolve waiter *after* being called; any message that arrived between a `send()` and the matching `waitFor()` call (e.g. a `roomState` broadcast triggered by another client's `joinRoom`) was dropped on the floor, occasionally producing `timed out waiting for "roomState"`. Fixed by giving each `Client` a `buffer` array: every incoming message is first matched against pending waiters (consumed if found) and otherwise pushed to the buffer. `waitFor` now checks the buffer first (splicing out and resolving immediately with the first matching buffered message) before falling back to registering a timed waiter for a future message. `VERIFY_WS_URL` support is unchanged; added `DEFAULT_WAIT_TIMEOUT_MS` (4000ms local / 10000ms when `VERIFY_WS_URL` is set) as the default `waitFor` timeout to give extra headroom over a remote connection.

### Verification performed
- `npm run build` — passes (`tsc` clean, `vite build` succeeds).
- `npm run verify` — passes, run 6 times consecutively with no flakes (previously intermittent on the `roomState`-after-joins wait).
