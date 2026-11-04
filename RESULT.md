# RESULT

## 4 difficulty levels for the OX Bible quiz (2026-11-04)

Added four selectable difficulty levels — 초등(elementary), 중등(middle), 고등(high), 청년(youth) — each
with its own ~30-question OX bank, wired end to end (server question selection, protocol, room
create/list/host UI, verify coverage). `toss-app/` was not touched.

## Question content (`server/src/questions.js`)

- `LEVELS = ['elementary', 'middle', 'high', 'youth']`, `LEVEL_LABELS` (Korean), `DEFAULT_LEVEL = 'elementary'`.
- `QUESTIONS_BY_LEVEL[level]` — 30 questions per level, 120 total. Every question has `{ id, text, answer, explanation }`;
  `explanation` is a short Korean sentence citing book/chapter:verse, shown on reveal.
- `normalizeLevel(level)` / `questionsForLevel(level)` fall back to `DEFAULT_LEVEL` for any unrecognized value.
- The original 30-question set was kept as the basis of the elementary level (same simple wording/well-known
  stories); ~9 of the weaker-fit/duplicative true statements were swapped for new false (X) statements on
  other well-known stories so O/X stays balanced, rather than keeping a skewed 24 O/6 X split.
- **Every question text is globally unique across all 120 questions** (verified by script), since `verify.mjs`
  looks up a question's answer by text alone, independent of which level it belongs to.
- Every answer was checked against the Bible text (no quotes used beyond common, uncontroversial renderings).
  Youth-level authorship/theology questions stick to what the Bible states about itself (e.g. Exodus 24:4 for
  Mosaic authorship, epistle openings that name their sender, Hebrews' known anonymity) or hedge with
  "전통적으로"(traditionally) for early-church-tradition attributions, and avoid denomination-specific or
  scholarly-disputed claims (no higher-criticism authorship disputes, no eschatology-position questions, etc.).

**Counts per level** (verified by script, each level O/X-balanced):

| Level | Label | Count | O | X |
|---|---|---|---|---|
| elementary | 초등 | 30 | 15 | 15 |
| middle | 중등 | 30 | 15 | 15 |
| high | 고등 | 30 | 15 | 15 |
| youth | 청년 | 30 | 15 | 15 |
| **Total** | | **120** | **60** | **60** |

**Sample questions (2 per level):**

- 초등: "노아는 큰 홍수를 피하려고 커다란 배(방주)를 만들었어요." → **O** (창세기 6:14) · "엘리야는 걸어서 세상을 떠났어요." → **X** (실제로는 불병거를 타고 하늘로 올라감, 열왕기하 2:11)
- 중등: "야곱은 얍복강에서 하나님(천사)과 씨름한 후 이름이 이스라엘로 바뀌었어요." → **O** (창세기 32:24-28) · "기드온은 3만 2천 명의 큰 군대로 미디안을 물리쳤어요." → **X** (실제로는 300명, 사사기 7:7)
- 고등: "북이스라엘은 앗시리아 제국에 의해 멸망했어요." → **O** (열왕기하 17장) · "히브리서는 구약성경에 포함된 책이에요." → **X** (신약성경 27권 중 하나)
- 청년: "에베소서는 사람이 자신의 선한 행위로 구원을 얻는다고 가르쳐요." → **X** (실제로는 은혜로 구원받는다고 가르침, 에베소서 2:8-9) · "로마서는 사람이 행위가 아니라 하나님의 은혜와 믿음으로 의롭다 하심을 받는다는 가르침을 중심으로 다뤄요." → **O** (로마서 3:23-24, 5:1)

## Protocol / server changes

- `createRoom` accepts optional `level` (`msg.level` in `index.js` → `createRoom({ ..., level })` in `state.js`);
  invalid/missing values fall back to `'elementary'` via `normalizeLevel`.
- `room.level` is stored on the room and included in both `serializeRoom` (snapshot) and `serializeRoomSummary`
  (room list). `startQuiz`/`currentQuestion` now draw from `QUESTIONS_BY_LEVEL[room.level]` instead of a single
  global array.
- `revealAnswer` now sets `lastResult.explanation` from the current question's `explanation` field. Backward
  compatible: `LastResult.explanation` is optional in the client type, and old clients ignore the extra field.

## Client changes

- **`client/src/protocol.ts`**: new `Level` type; `RoomSnapshot`/`RoomSummary` gain `level: Level`; `LastResult`
  gains optional `explanation?: string | null`.
- **`client/src/levels.ts`** (new): shared `LEVEL_OPTIONS`/`LEVEL_LABELS`/`LEVEL_CLASS` used by all screens below.
- **`client/src/pages/HostRooms.tsx`**: new 2×2 "난이도를 골라주세요" block picker (`.level-picker`/`.level-block`,
  big colored buttons — green/blue/orange/purple for 초등/중등/고등/청년), defaulting to 초등; selected level is
  sent with `createRoom`. Room list items now show a `badge-level` badge alongside the lobby/진행중 status badge.
- **`client/src/pages/HostRoom.tsx`**: header shows the room's level badge next to the player count; the reveal
  banner now also renders `lastResult.explanation` (new `.explanation-text` style) when present.
- **`client/src/pages/PlayerRooms.tsx`**: room list items show the same level badge as the host's list.
- **`client/src/pages/PlayerRoom.tsx`**: reveal card shows the explanation text under the O/X result banner when present.
- **`client/src/index.css`**: added `--level-*` color vars, `.badge-level`, `.level-picker`/`.level-block`
  (kid-friendly big buttons, matching the existing chunky-block visual style), `.explanation-text`.

## Verify coverage (`verify/verify.mjs`)

Kept `VERIFY_WS_URL` support, the buffered `waitFor`, and all existing church/room/score/movement tests
unchanged. Added a new "difficulty level tests" section (uses a fresh church/host/player so it doesn't disturb
the earlier scenarios) covering:
- Default level: `createRoom` without `level` returns `room.level === 'elementary'` in both the `roomCreated`
  snapshot and `listRooms` summary.
- Invalid level (`'not-a-real-level'`) falls back to `'elementary'` without erroring.
- Each of the 4 levels: creating a room with that `level` returns the same value in the snapshot and in the
  room list summary.
- Quiz question sourcing: starts a 3-question quiz for `middle` and separately for `youth`, and for every
  question revealed, asserts its text is a member of that level's question set and *not* a member of any other
  level's set (cross-checked against `QUESTIONS_BY_LEVEL` imported from `server/src/questions.js`).

Question lookup in the pre-existing helpers (`answerFor`) was switched from the old single `QUESTIONS` array to
a flattened `ALL_QUESTIONS` built from `QUESTIONS_BY_LEVEL`, since questions are now level-scoped but text is
still globally unique.

## Verification performed

- `npm run build` — passes (`tsc` clean, `vite build` succeeds).
- `npm run verify` — passes, run 3 times consecutively, no flakes.
- Content script check: all 120 questions have unique text, unique ids, valid `O`/`X` answers, and a non-empty
  `explanation`; O/X counts are exactly 15/15 per level (60/60 overall).
- Manual browser check (Playwright + Chromium against the built client served by the server): host "방 만들기"
  screen shows the 2×2 level picker defaulting to 초등 selected; picking 중등 and creating a room shows a
  "중등" badge on the host room screen header and in both the host's and player's room lists.

## Caveats

- Youth-level theology questions intentionally stay within material broadly shared across Protestant churches
  (e.g. justification by faith in Romans/Galatians/Ephesians, the Trinity not being a literal Bible word) and
  avoid denomination-specific or scholarly-disputed claims (e.g. no higher-criticism authorship disputes for
  Isaiah/Pentateuch, no eschatology-position questions).
- `QUESTIONS` is still exported from `questions.js` (aliased to the elementary set) since nothing imports it
  directly anymore, but keeping it avoids an unnecessary breaking removal for any external tooling.
