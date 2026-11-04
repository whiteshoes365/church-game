# RESULT

## True 3D voxel upgrade (2026-11-04)

Upgraded `client/` from the 2D CSS/SVG pixel-art map to a real three.js (react-three-fiber + drei) voxel scene, keeping the blocky art style. All art is original (boxes/cones/spheres built in code with flat colors) — no Minecraft/other trademarked assets, textures, or names. `server/`, `verify/`, `toss-app/`, and the WebSocket protocol were **not** touched. The avatar encoding (`s{skin}b{body}h{hat}`) and the 2D `AvatarIcon` fallback are unchanged and still used whenever WebGL is unavailable.

### Deps (`client/package.json`)
Added `three` (^0.187), `@react-three/fiber` (^8.18, React-18-compatible — v9 requires React 19 and this app is pinned to React 18.3.1), `@react-three/drei` (^9.122, same React-18 constraint), and `@types/three` as a dev dependency (the installed `three` version ships no bundled `.d.ts`). All resolved cleanly against the existing React 18 tree with no `--legacy-peer-deps` needed. Root `npm run build` (`npm install --include=dev && npm run build -w client`) installs and builds these from a clean checkout.

### New files (`client/src/three/`)
- `webgl.ts` — synchronous `isWebGLAvailable()` check (no three.js import) used by both pages to decide whether to even lazy-load the 3D chunk.
- `shared.ts` — one shared `BoxGeometry`/`ConeGeometry`/`SphereGeometry` plus a color→`MeshStandardMaterial` cache, reused by every voxel block/limb instead of allocating per-instance.
- `VoxelCharacter.tsx` — a character built from head/body/2 arms/2 legs boxes (+ a hat built from boxes/cones/spheres per hat type, mirroring the 2D `AvatarIcon` shapes) colored from the decoded avatar string. Lerps to a target position (walk-to-side), swings limbs + hops while moving, idle-bobs otherwise, and reacts to a `reveal` state: tips over and sinks on the wrong side, bounces in place on the correct side. Nickname shown via drei `<Html>` (DOM overlay, not in-canvas text — avoids pulling in `troika-three-text`/font loading, keeps the pixel-font look consistent, cheap for 30+ labels).
- `Terrain.tsx` — 17×11 grass/dirt floor as a single `InstancedMesh` with per-instance vertex colors (one draw call for the whole floor).
- `LetterStructure.tsx` — green `O` ring / red `X` cross, each a single `InstancedMesh` of ~2-voxel-thick cubes. `reveal` states: idle, correct (emissive glow + bounce), wrong (emissive flash then sinks through the floor).
- `Clouds.tsx` — small instanced blocky cloud clusters drifting and wrapping across the sky.
- `HostScene3D.tsx` — composes terrain/structures/clouds/lighting/camera sway and lays out players into non-overlapping grid slots inside O-zone / X-zone / neutral-zone bounding boxes (stable per-zone ordering by player id).
- `HostCanvas3D.tsx` — the `<Canvas>` wrapper (shadows on, dpr clamped `[1, 1.75]`), default-exported for `React.lazy`.
- `AvatarPreview3D.tsx` — small canvas with one auto-rotating `VoxelCharacter`, default-exported for `React.lazy`.

### Host big screen (`client/src/pages/HostRoom.tsx`, `index.css`)
- WebGL-available: lazy-loads `HostCanvas3D` inside a new `.map-area-3d` container; the question/timer card and reveal banner now render as an absolutely-positioned `.host-hud` layer **on top of** the canvas (matches the "2D overlay on top of the 3D canvas" ask). Scoreboard/side panel unchanged.
- WebGL-unavailable: falls back to the original 2D CSS map + `AvatarIcon` sprites inside the same container.
- One directional shadow-casting light (1024×1024 shadow map, tuned ortho frustum) + ambient fill; camera is a fixed isometric-ish rig that gently sways (sin-wave position/look-at drift), not user-controlled.

### Player phone (`client/src/pages/PlayerRoom.tsx`, `index.css`)
- Avatar builder's preview is now a small lazy-loaded rotating 3D canvas (`.avatar-preview-3d`, low dpr) showing the live skin/shirt/hat combo; falls back to the existing 2D `AvatarIcon` if `isWebGLAvailable()` is false, and while the chunk is loading (`Suspense` fallback). Hat-picker thumbnails stay 2D icons (cheap, no need for 30 live canvases). Big O/X answer buttons untouched.

### Bug found & fixed during manual verification
Setting `material.vertexColors = true` on the terrain's `InstancedMesh` material made the shader also expect a per-vertex `color` *geometry* attribute (`USE_COLOR`), which the shared `BoxGeometry` doesn't have — defaulting to `(0,0,0)` and zeroing out the per-instance color, rendering the entire floor pure black. Per-instance color (`USE_INSTANCING_COLOR`) is applied automatically whenever `mesh.instanceColor` exists, independent of `material.vertexColors` — removing that flag fixed it. Confirmed via headless-Chrome screenshots before/after.

### Verification performed
- `npm run build` (root) — passes: `tsc` clean, `vite build` succeeds.
- `npm run verify` (root) — passes: full host + 3-player OX quiz simulation against the untouched server/protocol.
- Manual visual QA: ran the real server + built client under headless Chrome (software WebGL via SwiftShader) and screenshotted — lobby (idle O/X structures, drifting clouds, grass/dirt floor, 16 players with varied hats/colors and shadows), question/reveal state (X was wrong: red structure visibly flashes and tumbles/sinks, players who chose X are tipped over on the ground; O was correct: green ring intact/glowing, its players upright), and the phone avatar picker's rotating 3D preview with hat/color changes reflected live.

### Bundle sizes (`npm run build -w client`, production, gzip in parens)
| File | Size |
|---|---|
| `index-*.js` (app shell: React, router, pages, 2D fallback) | 182.04 kB (59.04 kB) |
| `VoxelCharacter-*.js` (three.js + fiber + drei + all scene code, shared chunk) | 901.20 kB (241.48 kB) |
| `HostCanvas3D-*.js` (host canvas entry point) | 5.33 kB (2.20 kB) |
| `AvatarPreview3D-*.js` (avatar preview entry point) | 0.49 kB (0.34 kB) |
| `index-*.css` | 8.73 kB (2.40 kB) |

The three.js/r3f/drei chunk (~241 kB gzip) only downloads when a device actually has WebGL and reaches a host room or the avatar picker — it is never in the initial app-shell request, so cold load / the church search & room-list flows stay light. Vite's default 500 kB chunk-size warning fires on this shared chunk, which is expected for a three.js-containing bundle and does not affect correctness.

### Caveats
- 60fps with 30+ players was validated functionally (instancing for terrain/structures/clouds, shared geometries/materials, no per-frame allocations in hot loops, dpr clamp) but not measured with a real GPU + many concurrent WS clients in this sandbox (only SwiftShader software rendering was available here).
- Camera is fixed/swaying, not orbit-controllable, by design (big-screen presentation, not an interactive 3D viewer).
- `@react-three/fiber`/`drei` are pinned to the v8/v9 lines (not latest v9/v10) to stay compatible with this project's React 18; upgrading React to 19 later would allow moving to the newer fiber/drei majors.
