# RESULT

## Pixel-art restyle (2026-11-04)

Restyled `client/` to a blocky, voxel-inspired pixel-art look using original CSS/SVG art only (no Minecraft logos, textures, or trademarked names). `server/`, `verify/`, `toss-app/`, and `protocol.ts` were not touched; the WebSocket protocol is unchanged.

### Avatars (`client/src/avatars.ts`, `client/src/components/AvatarIcon.tsx`)
- Replaced the old shape+color (`circle-blue`, `star-yellow`, ...) model with a blocky pixel character built from SVG `<rect>`/`<polygon>` blocks: head, body/shirt, two legs, shoes.
- Players choose a skin tone (4 options), a shirt/body color (8 options), and a hat (`none`, `cap`, `crown`, `helmet`, `flower`, `visor`).
- The server only stores `avatar` as an opaque string (`server/src/state.js`), so the three choices are encoded into that existing field as `s{skin}b{body}h{hat}` (e.g. `s1b3h2`) via `encodeAvatar`/`decodeAvatar`. Unknown/legacy strings (e.g. `circle-blue`, the server's hardcoded default) safely decode to the default avatar instead of crashing.

### Player join UI (`client/src/pages/PlayerRoom.tsx`)
- The nickname + avatar picker screen now shows a live avatar preview plus three pickers: skin-tone swatches, shirt-color swatches, and a 2x3 hat grid (each hat button renders a mini preview of the character wearing it).

### Host big screen (`client/src/pages/HostRoom.tsx`, `index.css`)
- `.map-area` is a top-down tile grid built from layered CSS gradients: a green grass base, a diagonal brown "dirt patch" pattern, and thin grid lines — no image assets.
- O/X zones are rendered as big beveled block signs (`.map-zone-sign`, green `O` / red `X`) instead of faint watermark text.
- Avatars on the map move between positions in discrete `steps(6)` transitions (blocky stepwise movement) and continuously bob with a `steps(2)` hop keyframe animation (`.map-avatar-sprite`), both pure CSS.

### Pixel font & rendering (`client/src/index.css`)
- Loads Galmuri via `@import url('https://cdn.jsdelivr.net/npm/galmuri/dist/galmuri.css')`; `font-family: 'Galmuri11', 'DungGeunMo', monospace` set globally (works well since all UI copy is Korean).
- `image-rendering: pixelated` (with `crisp-edges` fallback) applied globally; all `AvatarIcon` SVGs use `shapeRendering="crispEdges"`.

### Chunky UI (`client/src/index.css`)
- Buttons, inputs, cards, and the scoreboard use squared corners (`border-radius: 0`), thick dark borders, and inset box-shadow bevels (light top-left / dark bottom-right, inverted on `:active`) for a beveled-block look.
- Cards/panels use a diagonal two-tone CSS gradient to read as stone blocks; the host screen background uses a similar gradient in brown tones to read as wood.
- Phone player O/X buttons (`.ox-button`) are large, high-contrast, beveled green/red blocks, unchanged in behavior.

### Verification
- `npm run build` — passes (`tsc && vite build` for `client/`).
- `npm run verify` — passes (full host+3-player OX quiz simulation against the untouched server/protocol).
- Manually drove the app with a headless Chromium + Playwright script: player join screen, host room creation, host lobby/question map view (grass+dirt tiles, O/X signs), avatar picker (skin/shirt/hat selection with live preview), and the phone player question/reveal screens all render correctly with good contrast and no console errors beyond an unrelated favicon 404.

### Known limitations
- Only one grass/dirt tile pattern is used for all three map themes (`sanctuary`/`playground`/`forest`); only the base grass tint differs per theme. Distinct per-theme tile art was out of scope for this pass.
- Hat colors are fixed per hat type (not separately customizable) to keep the picker UI simple for kids.
